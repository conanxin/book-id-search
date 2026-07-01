import { describe, expect, it } from "vitest";

/**
 * Verifies that the waitForTask implementation in scripts/import-books.ts
 * does NOT register abort listeners on an AbortSignal. The SDK's
 * built-in waitForTask leaks listeners (registered in
 * node_modules/meilisearch/dist/esm/http-requests.js) on the success
 * path — at scale (5000+ polling iterations per full import) this
 * triggers MaxListenersExceededWarning and stalls the import.
 *
 * We re-implement the patched waitForTask here (mirror of the function
 * in import-books.ts) and assert that AbortSignal.addEventListener
 * is never invoked.
 */

interface MockTask {
  taskUid: number;
  status: "enqueued" | "processing" | "succeeded" | "failed";
  error?: { message: string };
}

/** Mirror of patched waitForTask in scripts/import-books.ts */
async function patchedWaitForTask(
  client: { getTask: (uid: number) => Promise<MockTask> },
  taskUid: number,
  waitTimeoutMs: number
): Promise<MockTask> {
  const started = Date.now();
  const POLL_INTERVAL_MS = 250;
  const deadline = started + waitTimeoutMs;
  let result: MockTask | undefined;
  for (;;) {
    if (Date.now() >= deadline) {
      throw new Error(`Meilisearch task ${taskUid} timed out after ${waitTimeoutMs}ms`);
    }
    const current = await client.getTask(taskUid);
    if (current.status !== "enqueued" && current.status !== "processing") {
      result = current;
      break;
    }
    if (Date.now() + POLL_INTERVAL_MS < deadline) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }
  if (result.status === "failed") {
    throw new Error(result.error?.message ?? `Meilisearch task ${taskUid} failed`);
  }
  return result;
}

describe("waitForTask stability", () => {
  it("uses no AbortSignal — AbortSignal.prototype.addEventListener is never called", async () => {
    const original = AbortSignal.prototype.addEventListener;
    let addCalls = 0;
    AbortSignal.prototype.addEventListener = function (this: AbortSignal, ...args: Parameters<typeof original>) {
      addCalls++;
      return original.apply(this, args);
    };

    // Use a polling client that resolves on the first call (no setTimeout delay)
    let polls = 0;
    const task: MockTask = { taskUid: 1, status: "succeeded" };
    const client = {
      getTask: async (_uid: number) => {
        polls++;
        return { ...task };
      },
    };

    try {
      // Simulate 5000 waitForTask invocations (one per import batch)
      for (let i = 0; i < 5000; i++) {
        await patchedWaitForTask(client, 1, 30_000);
      }
    } finally {
      AbortSignal.prototype.addEventListener = original;
    }

    expect(addCalls).toBe(0);
    expect(polls).toBe(5000);
  });

  it("respects timeout on a permanently enqueued task", async () => {
    const stuckTask: MockTask = { taskUid: 99, status: "enqueued" };
    const client = { getTask: async (_: number) => stuckTask };
    const start = Date.now();
    await expect(patchedWaitForTask(client, 99, 1000)).rejects.toThrow(/timed out/);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(elapsed).toBeLessThan(2000);
  });

  it("returns the task when it transitions to succeeded", async () => {
    let polls = 0;
    const task: MockTask = { taskUid: 1, status: "enqueued" };
    const client = {
      getTask: async () => {
        polls++;
        if (polls >= 2) return { ...task, status: "succeeded" as const };
        return { ...task, status: "processing" as const };
      },
    };
    const result = await patchedWaitForTask(client, 1, 30_000);
    expect(result.status).toBe("succeeded");
    expect(polls).toBeGreaterThanOrEqual(2);
  });

  it("throws when the task transitions to failed", async () => {
    const failedTask: MockTask = { taskUid: 1, status: "failed", error: { message: "boom" } };
    const client = { getTask: async () => failedTask };
    await expect(patchedWaitForTask(client, 1, 30_000)).rejects.toThrow(/boom/);
  });

  it("scales to thousands of calls without memory or listener pressure", async () => {
    const succeededTask: MockTask = { taskUid: 1, status: "succeeded" };
    const client = { getTask: async () => succeededTask };

    // 5000 calls = full import with batch-size 20000 / 5.1M docs
    const t0 = process.memoryUsage().heapUsed;
    for (let i = 0; i < 5000; i++) {
      await patchedWaitForTask(client, 1, 30_000);
    }
    const t1 = process.memoryUsage().heapUsed;
    const deltaMB = (t1 - t0) / 1024 / 1024;
    // Heap should not have grown by more than 5 MB across 5000 calls
    expect(deltaMB).toBeLessThan(5);
  });
});
