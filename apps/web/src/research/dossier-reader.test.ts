import { describe, expect, it } from "vitest";
import type { DossierRequest, DossierResponses, DossierScope } from "./dossier-model";
import { createDossierReader, type DossierFetcher } from "./dossier-reader";
import { ProjectApiError } from "./api";

const P = "11111111-1111-4111-8111-111111111111";
const I = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const U = "44444444-4444-4444-8444-444444444444";
const OTHER = "55555555-5555-4555-8555-555555555555";
const M = "66666666-6666-4666-8666-666666666666";
const T = "2026-10-09T01:02:03.123Z";
const SCOPE: DossierScope = { projectId: P, issueId: I, authGeneration: 1 };

function question(issueId = I): DossierResponses["question"] {
  return {
    project: { id: P, name: "田野研究", lifecycleState: "ACTIVE", readOnly: false },
    issue: { id: issueId, projectId: P, title: "研究问题", question: "何时修建？", lifecycleState: "OPEN", createdAt: T, updatedAt: T },
  };
}
function runs(cursor: string | null = null): DossierResponses["runs"] {
  return {
    runs: [{
      runId: U, issueId: I, status: "RUNNING", replayOf: null, startedAtMicros: "1791507723123456",
      startedAt: T, completedAt: null,
      evidenceManifest: { id: M, manifestSha256: "a".repeat(64), itemCount: 1, available: true },
    }],
    nextCursor: cursor,
  };
}
function resolutions(cursor: string | null = null): DossierResponses["resolutions"] {
  return { issue: { id: I, lifecycleState: "OPEN", currentResolutionId: null, updatedAt: T },
    currentResolution: null, resolutions: [], nextCursor: cursor };
}
type Payload = DossierResponses[keyof DossierResponses];
interface Call {
  scope: DossierScope;
  request: DossierRequest;
  signal: AbortSignal;
  resolve(value: Payload): void;
  reject(error: Error): void;
}
function harness(concurrency = 4) {
  const calls: Call[] = [];
  const fetcher: DossierFetcher = (scope, request, signal) =>
    new Promise((resolve, reject) => { calls.push({ scope, request, signal, resolve, reject }); });
  const reader = createDossierReader(SCOPE, fetcher, concurrency);
  return { reader, calls };
}
async function flush() {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}
async function scopeReady(reader: ReturnType<typeof createDossierReader>, calls: Call[]) {
  reader.start();
  expect(calls.map(call => call.request.kind)).toEqual(["question"]);
  calls[0].resolve(question());
  await flush();
  expect(calls.map(call => call.request.kind)).toEqual(["question", "claims", "resolutions", "runs"]);
}
function finishInitial(calls: Call[]) {
  calls.find(call => call.request.kind === "claims")!.resolve({ claims: [] });
  calls.find(call => call.request.kind === "resolutions")!.resolve(resolutions());
  calls.find(call => call.request.kind === "runs")!.resolve(runs());
}

describe("Dossier GET-only reader: lifecycle, scope and bounded work", () => {
  it("loads Issue first and then only three independent readers", async () => {
    const { reader, calls } = harness();
    await scopeReady(reader, calls);
    finishInitial(calls);
    await flush();
    expect(reader.view().question.data?.issue.question).toBe("何时修建？");
    expect(reader.view().claims.coverage).toMatchObject({ status: "ready", loadedCount: 0, exhausted: true });
    expect(reader.view().runs.rows).toHaveLength(1);
    expect(reader.view().readOnly).toBe(true);
    expect(reader.view().whatChanged.policy).toBe("D01-A");
    reader.dispose();
  });

  it("limits concurrent API reads and does not drain extra pages", async () => {
    const { reader, calls } = harness(2);
    reader.start();
    calls[0].resolve(question());
    await flush();
    expect(calls.map(call => call.request.kind)).toEqual(["question", "claims", "resolutions"]);
    calls[1].resolve({ claims: [] });
    await flush();
    expect(calls.map(call => call.request.kind)).toEqual(["question", "claims", "resolutions", "runs"]);
    calls[2].resolve(resolutions("next-resolution"));
    calls[3].resolve(runs("next-run"));
    await flush();
    expect(calls).toHaveLength(4);
    expect(reader.view().resolutions.coverage.nextCursor).toBe("next-resolution");
    expect(reader.view().runs.coverage.nextCursor).toBe("next-run");
    reader.dispose();
  });

  it("rejects dependent requests before Issue scope completes", async () => {
    const { reader, calls } = harness();
    expect(await reader.read({ kind: "runs", cursor: null })).toBe(false);
    expect(calls).toHaveLength(0);
    reader.dispose();
  });

  it("rejects a mismatching root Issue without starting child readers", async () => {
    const { reader, calls } = harness();
    reader.start();
    calls[0].resolve(question(OTHER));
    await flush();
    expect(reader.view().question).toMatchObject({ status: "error", error: { status: 502 } });
    expect(calls).toHaveLength(1);
    reader.dispose();
  });

  it("does not relabel a 404 root Issue as a successful empty Issue", async () => {
    const { reader, calls } = harness();
    reader.start();
    calls[0].reject(new ProjectApiError(404, "Not found"));
    await flush();
    expect(reader.view().question.status).toBe("unavailable");
    expect(calls).toHaveLength(1);
    reader.dispose();
  });

  it("stops stale work on scope changes and rejects old private data", async () => {
    const { reader, calls } = harness();
    reader.start();
    const oldCall = calls[0];
    reader.changeScope({ ...SCOPE, issueId: OTHER });
    expect(oldCall.signal.aborted).toBe(true);
    oldCall.resolve(question());
    await flush();
    expect(reader.view().question.data).toBeNull();
    expect(calls[1].scope.issueId).toBe(OTHER);
    reader.dispose();
  });

  it("cancels every in-flight section during refresh and resets all coverage", async () => {
    const { reader, calls } = harness();
    await scopeReady(reader, calls);
    calls[1].resolve({ claims: [] });
    calls[2].resolve(resolutions("opaque-cursor"));
    await flush();
    const previousRun = calls[3];
    reader.refresh();
    expect(previousRun.signal.aborted).toBe(true);
    expect(reader.view().resolutions.rows).toEqual([]);
    expect(reader.view().resolutions.coverage.nextCursor).toBeNull();
    expect(reader.view().question.data).toBeNull();
    expect(calls.at(-1)?.request.kind).toBe("question");
    previousRun.resolve(runs());
    await flush();
    expect(reader.view().runs.rows).toEqual([]);
    reader.dispose();
  });

  it("serializes one stream's pages and leaves opaque cursors unmodified", async () => {
    const { reader, calls } = harness();
    await scopeReady(reader, calls);
    finishInitial(calls);
    await flush();
    // A fresh first-page read advertises the exact cursor we subsequently use.
    const initial = reader.read({ kind: "runs", cursor: null });
    const page = calls.at(-1)!;
    page.resolve(runs("opaque_%2B/%3D"));
    expect(await initial).toBe(true);
    await flush();
    const first = reader.read({ kind: "runs", cursor: "opaque_%2B/%3D" });
    const second = reader.read({ kind: "runs", cursor: "opaque_%2B/%3D" });
    expect(await second).toBe(false);
    expect(calls.at(-1)?.request).toEqual({ kind: "runs", cursor: "opaque_%2B/%3D" });
    calls.at(-1)!.resolve(runs());
    expect(await first).toBe(true);
    reader.dispose();
  });

  it("reports a rejected page as failed even when older rows remain loaded", async () => {
    const { reader, calls } = harness();
    await scopeReady(reader, calls);
    finishInitial(calls);
    await flush();
    const requested = reader.read({ kind: "run", runId: U });
    const call = calls.at(-1)!;
    const bad = { run: { runId: OTHER, issueId: I, projectId: P }, evidenceManifest: {}, ancestors: [] };
    call.resolve(bad as unknown as Payload);
    expect(await requested).toBe(false);
    expect(reader.view().runDetails).toEqual([]);
    expect(reader.view().reads.some(x => x.kind === "run" && x.error?.status === 502)).toBe(true);
    reader.dispose();
  });

  it("does not convert network failures to successful empty pages", async () => {
    const { reader, calls } = harness();
    await scopeReady(reader, calls);
    calls[1].reject(new ProjectApiError(503, "down"));
    calls[2].resolve(resolutions());
    calls[3].resolve(runs());
    await flush();
    expect(reader.view().claims.coverage.status).toBe("error");
    expect(reader.view().resolutions.coverage.status).toBe("ready");
    expect(reader.view().claims.rows).toEqual([]);
    reader.dispose();
  });

  it("aborts peers when a private reader reports a lost session", async () => {
    const { reader, calls } = harness();
    await scopeReady(reader, calls);
    calls[1].reject(new ProjectApiError(401, "expired"));
    await flush();
    expect(calls[2].signal.aborted).toBe(true);
    expect(calls[3].signal.aborted).toBe(true);
    expect(reader.view().question.data).toBeNull();
    reader.dispose();
  });

  it("emits safe view projections and never raw source-ticket addresses", async () => {
    const { reader, calls } = harness();
    const views: unknown[] = [];
    const unsubscribe = reader.subscribe(view => views.push(view));
    await scopeReady(reader, calls);
    finishInitial(calls);
    await flush();
    expect(views.length).toBeGreaterThan(0);
    expect(Object.keys(reader.view())).not.toContain("sources");
    expect(Object.keys(reader.view())).not.toContain("invalidated");
    unsubscribe();
    const count = views.length;
    reader.refresh();
    expect(views).toHaveLength(count);
    reader.dispose();
  });

  it("disposes every outstanding request without later repopulation", async () => {
    const { reader, calls } = harness();
    await scopeReady(reader, calls);
    reader.dispose();
    expect(calls.slice(1).every(call => call.signal.aborted)).toBe(true);
    finishInitial(calls);
    await flush();
    expect(reader.view().runs.rows).toEqual([]);
    expect(await reader.read({ kind: "question" })).toBe(false);
  });

  it("never loads optional claims' Assessments eagerly", async () => {
    const { reader, calls } = harness();
    await scopeReady(reader, calls);
    calls[1].resolve({ claims: [{ id: C, statement: "候选", lifecycleState: "ACTIVE", createdAt: T, updatedAt: T }] });
    calls[2].resolve(resolutions());
    calls[3].resolve(runs());
    await flush();
    expect(calls.map(call => call.request.kind)).not.toContain("assessments");
    expect(calls.map(call => call.request.kind)).not.toContain("candidates");
    reader.dispose();
  });
});
