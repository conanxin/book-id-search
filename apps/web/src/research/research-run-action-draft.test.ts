// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RESEARCH_RUN_ACTION_PENDING_KEY,
  RESEARCH_RUN_ACTIONS,
  PendingResearchRunActionIntentConflictError,
  clearPendingResearchRunActionReceipt,
  getOrCreateResearchRunActionReceipt,
  hashResearchRunActionIntent,
  isReplayResearchRunCommand,
  isResearchRunCompleteOutput,
  loadPendingResearchRunActionReceipt,
  parseResearchRunCompleteOutput,
  resetPendingResearchRunActionReceiptMemoryForTest,
} from "./research-run-action-draft";

const P = "11111111-1111-4111-8111-111111111111";
const I = "22222222-2222-4222-8222-222222222222";
const RUN = "33333333-3333-4333-8333-333333333333";
const OTHER_RUN = "44444444-4444-4444-8444-444444444444";
const M = "77777777-7777-4777-8777-777777777777";

const outputForm = (over: Record<string, unknown> = {}) => ({
  summary: "完成核对",
  produced: { claimIds: "11111111-1111-4111-8111-111111111111", assessmentIds: "", resolutionIds: "", noteRevisionIds: "" },
  gaps: [],
  ...over,
});

const outputV1 = {
  version: 1 as const,
  summary: "完成核对",
  produced: { claimIds: ["11111111-1111-4111-8111-111111111111"], assessmentIds: [], resolutionIds: [], noteRevisionIds: [] },
  gaps: [],
};

const replayCommand = (over: Record<string, unknown> = {}) => ({
  procedure: { version: 1, objective: "核对", method: "比对", steps: [{ kind: "COMPARE", description: "比对正文" }] },
  executionContract: { version: 1, mode: "HUMAN_AI", reproducibilityLevel: "PROCEDURE", tools: [] },
  environment: {},
  evidenceManifestId: M,
  ...over,
});

beforeEach(() => {
  resetPendingResearchRunActionReceiptMemoryForTest();
  sessionStorage.clear();
});
afterEach(() => {
  resetPendingResearchRunActionReceiptMemoryForTest();
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe("parseResearchRunCompleteOutput", () => {
  it("parses a valid COMPLETE output with multiline UUID groups and gaps", () => {
    const parsed = parseResearchRunCompleteOutput(outputForm({
      produced: {
        claimIds: "11111111-1111-4111-8111-111111111111\n\n 22222222-2222-4222-8222-222222222222 ",
        assessmentIds: "",
        resolutionIds: "",
        noteRevisionIds: "",
      },
      gaps: [{ description: "缺一版", status: "OPEN" }, { description: "受阻", status: "BLOCKED" }],
    }));
    expect(parsed.version).toBe(1);
    expect(parsed.produced.claimIds).toHaveLength(2);
    expect(parsed.produced.claimIds[1]).toBe("22222222-2222-4222-8222-222222222222");
    expect(parsed.produced.assessmentIds).toEqual([]);
    expect(parsed.gaps.map(gap => gap.status)).toEqual(["OPEN", "BLOCKED"]);
  });

  it("canonicalizes uppercase UUIDs to lowercase", () => {
    const parsed = parseResearchRunCompleteOutput(outputForm({
      produced: { claimIds: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA", assessmentIds: "", resolutionIds: "", noteRevisionIds: "" },
    }));
    expect(parsed.produced.claimIds[0]).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  });

  it("rejects malformed and duplicate UUIDs", () => {
    expect(() => parseResearchRunCompleteOutput(outputForm({
      produced: { claimIds: "not-a-uuid", assessmentIds: "", resolutionIds: "", noteRevisionIds: "" },
    }))).toThrow();
    expect(() => parseResearchRunCompleteOutput(outputForm({
      produced: { claimIds: `${RUN}\n${RUN.toUpperCase()}`, assessmentIds: "", resolutionIds: "", noteRevisionIds: "" },
    }))).toThrow(/重复/);
  });

  it("rejects blank summary and bad gap status / unknown fields", () => {
    expect(() => parseResearchRunCompleteOutput(outputForm({ summary: "  " }))).toThrow();
    expect(() => parseResearchRunCompleteOutput(outputForm({ gaps: [{ description: "x", status: "DONE" }] }))).toThrow();
    expect(() => parseResearchRunCompleteOutput(outputForm({ extra: 1 }))).toThrow();
    expect(() => parseResearchRunCompleteOutput(null)).toThrow();
  });
});

describe("isResearchRunCompleteOutput (receipt restore strictness)", () => {
  it("round-trips a parsed output", () => {
    const parsed = parseResearchRunCompleteOutput(outputForm());
    expect(isResearchRunCompleteOutput(parsed)).toBe(true);
  });
  it("rejects unknown fields, non-lowercase ids, duplicates, zero-version", () => {
    expect(isResearchRunCompleteOutput({ ...outputV1, extra: 1 })).toBe(false);
    expect(isResearchRunCompleteOutput({ ...outputV1, version: 0 })).toBe(false);
    expect(isResearchRunCompleteOutput({
      ...outputV1,
      produced: { claimIds: ["AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"], assessmentIds: [], resolutionIds: [], noteRevisionIds: [] },
    })).toBe(false);
    expect(isResearchRunCompleteOutput({
      ...outputV1,
      produced: { claimIds: [RUN, RUN], assessmentIds: [], resolutionIds: [], noteRevisionIds: [] },
    })).toBe(false);
    expect(isResearchRunCompleteOutput(null)).toBe(false);
  });
});

describe("isReplayResearchRunCommand", () => {
  it("accepts a parent-copied canonical command", () => {
    expect(isReplayResearchRunCommand(replayCommand())).toBe(true);
  });
  it("accepts nested JSON environments", () => {
    expect(isReplayResearchRunCommand(replayCommand({ environment: { workspace: "本地", nested: { deep: [1, "a", null] } } }))).toBe(true);
  });
  it("rejects missing/extra keys, bad versions, empty steps, non-lowercase manifest", () => {
    expect(isReplayResearchRunCommand({ ...replayCommand(), extra: 1 })).toBe(false);
    expect(isReplayResearchRunCommand({ procedure: { version: 1, objective: "o", method: "m", steps: [] }, executionContract: replayCommand().executionContract, environment: {}, evidenceManifestId: M })).toBe(false);
    expect(isReplayResearchRunCommand(replayCommand({ evidenceManifestId: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" }))).toBe(false);
    expect(isReplayResearchRunCommand(replayCommand({ executionContract: { version: 2, mode: "HUMAN", reproducibilityLevel: "AUDIT", tools: [] } }))).toBe(false);
  });
});

describe("action intent hash", () => {
  it("binds scope, run, action and command; equivalent intent rehashes equal", async () => {
    const a = await hashResearchRunActionIntent({ projectId: P, issueId: I, runId: RUN }, "FAIL", { output: null });
    const b = await hashResearchRunActionIntent({ projectId: P.toUpperCase(), issueId: I, runId: RUN }, "FAIL", { output: null });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    const otherRun = await hashResearchRunActionIntent({ projectId: P, issueId: I, runId: OTHER_RUN }, "FAIL", { output: null });
    const otherAction = await hashResearchRunActionIntent({ projectId: P, issueId: I, runId: RUN }, "CANCEL", { output: null });
    const otherCommand = await hashResearchRunActionIntent({ projectId: P, issueId: I, runId: RUN }, "COMPLETE", { output: outputV1 });
    const otherScope = await hashResearchRunActionIntent({ projectId: OTHER_RUN, issueId: I, runId: RUN }, "FAIL", { output: null });
    for (const variant of [otherRun, otherAction, otherCommand, otherScope]) expect(variant).not.toBe(a);
  });
});

describe("pending action receipt lifecycle", () => {
  it("persists nothing before explicit submit", () => {
    expect(loadPendingResearchRunActionReceipt()).toBeNull();
    expect(sessionStorage.getItem(RESEARCH_RUN_ACTION_PENDING_KEY)).toBeNull();
  });

  it("stores and reloads exact command+key for FAIL", async () => {
    const receipt = await getOrCreateResearchRunActionReceipt({ projectId: P, issueId: I, runId: RUN }, "FAIL", { output: null });
    expect(receipt.action).toBe("FAIL");
    expect(receipt.command).toEqual({ output: null });
    resetPendingResearchRunActionReceiptMemoryForTest();
    const reloaded = loadPendingResearchRunActionReceipt();
    expect(reloaded?.idempotencyKey).toBe(receipt.idempotencyKey);
    expect(reloaded?.command).toEqual(receipt.command);
  });

  it("stores COMPLETE with normalized output", async () => {
    const receipt = await getOrCreateResearchRunActionReceipt({ projectId: P, issueId: I, runId: RUN }, "COMPLETE", { output: parseResearchRunCompleteOutput(outputForm()) });
    expect((receipt.command as { output: unknown }).output).toBeTruthy();
    expect(isResearchRunCompleteOutput((receipt.command as { output: ResearchRunOutputLike }).output)).toBe(true);
  });

  it("stores REPLAY with copied parent command", async () => {
    const receipt = await getOrCreateResearchRunActionReceipt({ projectId: P, issueId: I, runId: RUN }, "REPLAY", replayCommand());
    expect(isReplayResearchRunCommand(receipt.command)).toBe(true);
  });

  it("same intent reuses the exact key", async () => {
    const first = await getOrCreateResearchRunActionReceipt({ projectId: P, issueId: I, runId: RUN }, "CANCEL", { output: null });
    const second = await getOrCreateResearchRunActionReceipt({ projectId: P, issueId: I, runId: RUN }, "CANCEL", { output: null });
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
  });

  it("acting on another Run while pending conflicts (no silent overwrite)", async () => {
    await getOrCreateResearchRunActionReceipt({ projectId: P, issueId: I, runId: RUN }, "FAIL", { output: null });
    await expect(getOrCreateResearchRunActionReceipt({ projectId: P, issueId: I, runId: OTHER_RUN }, "FAIL", { output: null }))
      .rejects.toBeInstanceOf(PendingResearchRunActionIntentConflictError);
  });

  it("changed action or scope conflicts", async () => {
    await getOrCreateResearchRunActionReceipt({ projectId: P, issueId: I, runId: RUN }, "FAIL", { output: null });
    await expect(getOrCreateResearchRunActionReceipt({ projectId: P, issueId: I, runId: RUN }, "CANCEL", { output: null }))
      .rejects.toBeInstanceOf(PendingResearchRunActionIntentConflictError);
    await expect(getOrCreateResearchRunActionReceipt({ projectId: OTHER_RUN, issueId: I, runId: RUN }, "FAIL", { output: null }))
      .rejects.toBeInstanceOf(PendingResearchRunActionIntentConflictError);
  });

  it("rejects stored receipts with extra fields like token; tampered hash fails closed", async () => {
    const good = await getOrCreateResearchRunActionReceipt({ projectId: P, issueId: I, runId: RUN }, "FAIL", { output: null });
    sessionStorage.setItem(RESEARCH_RUN_ACTION_PENDING_KEY, JSON.stringify({ ...good, token: "SECRET" }));
    resetPendingResearchRunActionReceiptMemoryForTest();
    expect(loadPendingResearchRunActionReceipt()).toBeNull();

    sessionStorage.setItem(RESEARCH_RUN_ACTION_PENDING_KEY, JSON.stringify({ ...good, requestHash: "0".repeat(64) }));
    resetPendingResearchRunActionReceiptMemoryForTest();
    await expect(getOrCreateResearchRunActionReceipt({ projectId: P, issueId: I, runId: RUN }, "FAIL", { output: null }))
      .rejects.toBeInstanceOf(PendingResearchRunActionIntentConflictError);
  });

  it("storage-write failure keeps same-page key; clear tombstone survives removal failure", async () => {
    vi.spyOn(sessionStorage, "setItem").mockImplementation(() => { throw new Error("quota"); });
    const receipt = await getOrCreateResearchRunActionReceipt({ projectId: P, issueId: I, runId: RUN }, "FAIL", { output: null });
    const inMemory = loadPendingResearchRunActionReceipt();
    expect(inMemory?.idempotencyKey).toBe(receipt.idempotencyKey);
    vi.restoreAllMocks();

    await getOrCreateResearchRunActionReceipt({ projectId: P, issueId: I, runId: RUN }, "CANCEL", { output: null }).catch(() => {});
    vi.spyOn(sessionStorage, "removeItem").mockImplementation(() => { throw new Error("locked"); });
    clearPendingResearchRunActionReceipt();
    expect(loadPendingResearchRunActionReceipt()).toBeNull();
    sessionStorage.setItem(RESEARCH_RUN_ACTION_PENDING_KEY, JSON.stringify({ ...(await referenceReceipt()) }));
    expect(loadPendingResearchRunActionReceipt()).toBeNull(); // tombstone wins
  });
});

describe("RESEARCH_RUN_ACTIONS", () => {
  it("covers exactly the four actions", () => {
    expect([...RESEARCH_RUN_ACTIONS]).toEqual(["COMPLETE", "FAIL", "CANCEL", "REPLAY"]);
  });
});

// helper for tombstone test — build a structurally valid receipt payload
async function referenceReceipt() {
  return {
    projectId: P, issueId: I, runId: RUN, action: "FAIL",
    requestHash: "a".repeat(64),
    idempotencyKey: "99999999-9999-4999-8999-999999999999",
    createdAt: new Date().toISOString(),
    command: { output: null },
  };
}

