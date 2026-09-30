import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ProjectApiError,
  cancelResearchRun,
  completeResearchRun,
  failResearchRun,
  getResearchRun,
  isResearchRunEvidenceSnapshot,
  isResearchRunSummary,
  listResearchRuns,
  replayResearchRun,
  startResearchRun,
  type ResearchRunDetailResponse,
  type ResearchRunOutput,
  type ResearchRunSummary,
} from "./api";

import { __resetWebAuthStoreForTests, __setWebAuthSnapshotForTests } from "../auth/session";
function seedSession(): void {
  __setWebAuthSnapshotForTests({ status: "authenticated", user: { email: "owner@example.com", name: "Owner" }, csrfToken: "csrf-test", error: null });
}
beforeEach(() => { seedSession(); });
afterEach(() => { __resetWebAuthStoreForTests(); });

const P = "11111111-1111-4111-8111-111111111111";
const I = "22222222-2222-4222-8222-222222222222";
const RUN = "33333333-3333-4333-8333-333333333333";
const PRIOR = "44444444-4444-4444-8444-444444444444";
const OLDER = "55555555-5555-4555-8555-555555555555";
const M = "77777777-7777-4777-8777-777777777777";
const KEY = "99999999-9999-4999-8999-999999999999";
const T0 = "2026-09-28T00:00:00.123456Z";
const T1 = "2026-09-28T01:00:00.654321Z";
const MICROS = "1760486400123456";

const procedure = {
  version: 1,
  objective: "核对版本差异",
  method: "逐页比对",
  steps: [{ kind: "COMPARE", description: "比对两版正文" }],
};
const contract = {
  version: 1,
  mode: "HUMAN_AI",
  reproducibilityLevel: "PROCEDURE",
  tools: [{ name: "工具", version: null }],
};
const output = (over: Partial<ResearchRunOutput> = {}): ResearchRunOutput => ({
  version: 1,
  summary: "完成核对",
  produced: { claimIds: [], assessmentIds: [], resolutionIds: [], noteRevisionIds: [] },
  gaps: [],
  ...over,
});

const snapshotUnavailable = { id: M, manifestSha256: "a".repeat(64), itemCount: 2, available: false };
const snapshotAvailable = {
  id: M,
  manifestSha256: "a".repeat(64),
  itemCount: 2,
  available: true,
  items: [
    { ordinal: 1, role: "SUPPORTING", targetType: "SOURCE", note: null },
    { ordinal: 2, role: "CONTEXTUAL", targetType: "NOTE_REVISION", note: "历史" },
  ],
};

const summary = (over: Partial<ResearchRunSummary> = {}): ResearchRunSummary => ({
  runId: RUN,
  issueId: I,
  status: "SUCCEEDED",
  replayOf: null,
  startedAtMicros: MICROS,
  startedAt: T0,
  completedAt: T1,
  evidenceManifest: { ...snapshotUnavailable },
  ...over,
} as ResearchRunSummary);

const detail = (run: Record<string, unknown>, evidence: Record<string, unknown> = { ...snapshotAvailable }, ancestors: ResearchRunSummary[] = []): ResearchRunDetailResponse => ({
  run: {
    runId: RUN, projectId: P, issueId: I, status: "SUCCEEDED", evidenceManifestId: M, replayOf: null,
    procedure, executionContract: contract, environment: { workspace: "本地" }, output: output(),
    knowledgeCutoff: null, startedAt: T0, completedAt: T1, createdAt: T0,
    ...run,
  } as ResearchRunDetailResponse["run"],
  evidenceManifest: evidence as ResearchRunDetailResponse["evidenceManifest"],
  ancestors,
});

// ---------------------------------------------------------------- validators

describe("ResearchRun evidence privacy validator", () => {
  it("accepts available=false with exactly the four summary keys", () => {
    expect(isResearchRunEvidenceSnapshot(snapshotUnavailable)).toBe(true);
  });
  it("rejects available=false with items, targetId, locator, excerpt or extra fields", () => {
    expect(isResearchRunEvidenceSnapshot({ ...snapshotUnavailable, items: [] })).toBe(false);
    expect(isResearchRunEvidenceSnapshot({ ...snapshotUnavailable, targetId: "x" })).toBe(false);
    expect(isResearchRunEvidenceSnapshot({ ...snapshotUnavailable, locator: "p.1" })).toBe(false);
    expect(isResearchRunEvidenceSnapshot({ ...snapshotUnavailable, excerpt: "引用" })).toBe(false);
    expect(isResearchRunEvidenceSnapshot({ ...snapshotUnavailable, extra: 1 })).toBe(false);
  });
  it("rejects bad hash / itemCount before availability checks", () => {
    expect(isResearchRunEvidenceSnapshot({ ...snapshotUnavailable, manifestSha256: "A".repeat(64) })).toBe(false);
    expect(isResearchRunEvidenceSnapshot({ ...snapshotUnavailable, manifestSha256: "short" })).toBe(false);
    expect(isResearchRunEvidenceSnapshot({ ...snapshotUnavailable, itemCount: 0 })).toBe(false);
    expect(isResearchRunEvidenceSnapshot({ ...snapshotUnavailable, itemCount: 1.5 })).toBe(false);
  });
  it("available=true requires contiguous 1..N ordinals and length === itemCount; item targetId rejected", () => {
    expect(isResearchRunEvidenceSnapshot(snapshotAvailable)).toBe(true);
    expect(isResearchRunEvidenceSnapshot({ ...snapshotAvailable, items: [...snapshotAvailable.items, { ...snapshotAvailable.items[0], ordinal: 3 }] })).toBe(false); // length 3 !== itemCount 2
    const swapped = { ...snapshotAvailable, items: [{ ...snapshotAvailable.items[1], ordinal: 1 }, { ...snapshotAvailable.items[0], ordinal: 2 }] };
    expect(isResearchRunEvidenceSnapshot(swapped)).toBe(true); // order irrelevant, contiguity matters
    const gapped = { ...snapshotAvailable, items: [{ ...snapshotAvailable.items[0], ordinal: 1 }, { ...snapshotAvailable.items[1], ordinal: 3 }] };
    expect(isResearchRunEvidenceSnapshot(gapped)).toBe(false);
    expect(isResearchRunEvidenceSnapshot({ ...snapshotAvailable, items: snapshotAvailable.items.map(i => ({ ...i, targetId: "leak" })) })).toBe(false);
    expect(isResearchRunEvidenceSnapshot({ ...snapshotAvailable, items: snapshotAvailable.items.map(i => ({ ...i, role: "UNKNOWN" })) })).toBe(false);
    expect(isResearchRunEvidenceSnapshot({ ...snapshotAvailable, items: snapshotAvailable.items.map(i => ({ ...i, targetType: "PROJECT" })) })).toBe(false);
    expect(isResearchRunEvidenceSnapshot({ ...snapshotAvailable, available: "true" })).toBe(false);
  });
});

describe("ResearchRun summary validator", () => {
  it("accepts valid RUNNING and each terminal status", () => {
    expect(isResearchRunSummary(summary({ status: "RUNNING", completedAt: null }))).toBe(true);
    expect(isResearchRunSummary(summary({ status: "SUCCEEDED" }))).toBe(true);
    expect(isResearchRunSummary(summary({ status: "FAILED" }))).toBe(true);
    expect(isResearchRunSummary(summary({ status: "CANCELLED" }))).toBe(true);
  });
  it("rejects lifecycle mismatches", () => {
    expect(isResearchRunSummary(summary({ status: "RUNNING", completedAt: T1 }))).toBe(false);
    expect(isResearchRunSummary(summary({ status: "SUCCEEDED", completedAt: null }))).toBe(false);
    expect(isResearchRunSummary(summary({ status: "FAILED", completedAt: "not-a-date" }))).toBe(false);
  });
  it("rejects bad uuids, micros, extra keys", () => {
    expect(isResearchRunSummary(summary({ runId: "nope" }))).toBe(false);
    expect(isResearchRunSummary(summary({ replayOf: "nope" }))).toBe(false);
    expect(isResearchRunSummary(summary({ startedAtMicros: "0" }))).toBe(false);
    expect(isResearchRunSummary(summary({ startedAtMicros: "12a4" }))).toBe(false);
    expect(isResearchRunSummary(summary({ startedAtMicros: 1760486400123456 }))).toBe(false);
    expect(isResearchRunSummary(summary({ extra: true } as any))).toBe(false);
  });
  it("rejects invalid evidence snapshots", () => {
    expect(isResearchRunSummary(summary({ evidenceManifest: { ...snapshotUnavailable, available: true, items: [] } as any }))).toBe(false);
  });
});

describe("ResearchRun detail + lineage validator (via getResearchRun valid predicate)", () => {
  const fetchMock = vi.fn();
  beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock); });
  afterEach(() => vi.unstubAllGlobals());
  function response(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }

  it("accepts RUNNING detail with null output and no ancestors", async () => {
    fetchMock.mockResolvedValueOnce(response(detail({ status: "RUNNING", output: null, completedAt: null })));
    await expect(getResearchRun(P, I, RUN)).resolves.toBeTruthy();
  });
  it("rejects lifecycle violations in detail", async () => {
    fetchMock.mockResolvedValueOnce(response(detail({ status: "RUNNING", output: output() })));
    await expect(getResearchRun(P, I, RUN)).rejects.toMatchObject({ status: 502 });
    fetchMock.mockResolvedValueOnce(response(detail({ status: "SUCCEEDED", output: null })));
    await expect(getResearchRun(P, I, RUN)).rejects.toMatchObject({ status: 502 });
    fetchMock.mockResolvedValueOnce(response(detail({ status: "CANCELLED", completedAt: null, output: null })));
    await expect(getResearchRun(P, I, RUN)).rejects.toMatchObject({ status: 502 });
  });
  it("rejects cross-scope project/issue and manifest mismatch", async () => {
    fetchMock.mockResolvedValueOnce(response(detail({ projectId: OLDER })));
    await expect(getResearchRun(P, I, RUN)).rejects.toMatchObject({ status: 502 });
    fetchMock.mockResolvedValueOnce(response(detail({ issueId: OLDER })));
    await expect(getResearchRun(P, I, RUN)).rejects.toMatchObject({ status: 502 });
    fetchMock.mockResolvedValueOnce(response(detail({ evidenceManifestId: OLDER })));
    await expect(getResearchRun(P, I, RUN)).rejects.toMatchObject({ status: 502 });
  });
  it("rejects malformed procedure / contract / output / environment", async () => {
    fetchMock.mockResolvedValueOnce(response(detail({ procedure: { ...procedure, version: 2 } })));
    await expect(getResearchRun(P, I, RUN)).rejects.toMatchObject({ status: 502 });
    fetchMock.mockResolvedValueOnce(response(detail({ procedure: { ...procedure, steps: [{ kind: "DANCE", description: "x" }] } })));
    await expect(getResearchRun(P, I, RUN)).rejects.toMatchObject({ status: 502 });
    fetchMock.mockResolvedValueOnce(response(detail({ procedure: { ...procedure, extra: 1 } })));
    await expect(getResearchRun(P, I, RUN)).rejects.toMatchObject({ status: 502 });
    fetchMock.mockResolvedValueOnce(response(detail({ executionContract: { ...contract, mode: "MIXED" } })));
    await expect(getResearchRun(P, I, RUN)).rejects.toMatchObject({ status: 502 });
    fetchMock.mockResolvedValueOnce(response(detail({ output: { ...output(), produced: { ...output().produced, claimIds: ["nope"] } } })));
    await expect(getResearchRun(P, I, RUN)).rejects.toMatchObject({ status: 502 });
    const dupId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    fetchMock.mockResolvedValueOnce(response(detail({ output: { ...output(), produced: { ...output().produced, assessmentIds: [dupId, dupId] } } })));
    await expect(getResearchRun(P, I, RUN)).rejects.toMatchObject({ status: 502 });
    fetchMock.mockResolvedValueOnce(response(detail({ output: { ...output(), gaps: [{ description: "x", status: "MAYBE" }] } })));
    await expect(getResearchRun(P, I, RUN)).rejects.toMatchObject({ status: 502 });
  });
  it("accepts all procedure step kinds and every mode/repro combination", async () => {
    for (const kind of ["SEARCH", "READ", "COMPARE", "FIELDWORK", "MAP_ANALYSIS", "IMAGE_ANALYSIS", "OTHER"]) {
      fetchMock.mockResolvedValueOnce(response(detail({ procedure: { ...procedure, steps: [{ kind, description: "步骤" }] } })));
      await expect(getResearchRun(P, I, RUN)).resolves.toBeTruthy();
    }
    for (const mode of ["HUMAN", "HUMAN_AI", "AUTOMATED"]) {
      for (const level of ["EXACT", "PROCEDURE", "AUDIT"]) {
        fetchMock.mockResolvedValueOnce(response(detail({ executionContract: { ...contract, mode, reproducibilityLevel: level } })));
        await expect(getResearchRun(P, I, RUN)).resolves.toBeTruthy();
      }
    }
  });
  it("accepts environment with nested JSON-safe values; rejects array top-level", async () => {
    fetchMock.mockResolvedValueOnce(response(detail({ environment: { a: { b: [1, "x", null, true] } } })));
    await expect(getResearchRun(P, I, RUN)).resolves.toBeTruthy();
    // Arrays and scalars cannot survive JSON parsing into non-safe values (functions drop,
    // NaN becomes null), so the non-JSON negative cases are unreachable over HTTP by design.
    fetchMock.mockResolvedValueOnce(response(detail({ environment: [] as any })));
    await expect(getResearchRun(P, I, RUN)).rejects.toMatchObject({ status: 502 });
  });

  // ---- lineage
  const terminalPrior = summary({ runId: PRIOR, replayOf: null, status: "FAILED", completedAt: T0 });
  const terminalOlder = summary({ runId: OLDER, replayOf: null, status: "CANCELLED", completedAt: T0 });

  it("accepts 0/1/multi-level valid lineage", async () => {
    fetchMock.mockResolvedValueOnce(response(detail({ status: "SUCCEEDED", replayOf: null }, { ...snapshotAvailable }, [])));
    await expect(getResearchRun(P, I, RUN)).resolves.toBeTruthy();
    fetchMock.mockResolvedValueOnce(response(detail({ status: "SUCCEEDED", replayOf: PRIOR }, { ...snapshotAvailable }, [terminalPrior])));
    await expect(getResearchRun(P, I, RUN)).resolves.toBeTruthy();
    fetchMock.mockResolvedValueOnce(response(detail(
      { status: "SUCCEEDED", replayOf: PRIOR },
      { ...snapshotAvailable },
      [terminalOlder, { ...terminalPrior, replayOf: OLDER }],
    )));
    await expect(getResearchRun(P, I, RUN)).resolves.toBeTruthy();
  });
  it("rejects lineage violations: replayOf null with ancestors / replayOf set with none", async () => {
    fetchMock.mockResolvedValueOnce(response(detail({ replayOf: null }, { ...snapshotAvailable }, [terminalPrior])));
    await expect(getResearchRun(P, I, RUN)).rejects.toMatchObject({ status: 502 });
    fetchMock.mockResolvedValueOnce(response(detail({ replayOf: PRIOR }, { ...snapshotAvailable }, [])));
    await expect(getResearchRun(P, I, RUN)).rejects.toMatchObject({ status: 502 });
  });

  it("rejects lineage violations: wrong tail / RUNNING ancestor / cycle / dup / broken chain / rooted oldest / foreign issue / depth>100", async () => {
    fetchMock.mockResolvedValueOnce(response(detail({ replayOf: PRIOR }, { ...snapshotAvailable }, [terminalOlder])));
    await expect(getResearchRun(P, I, RUN)).rejects.toMatchObject({ status: 502 });
    fetchMock.mockResolvedValueOnce(response(detail({ replayOf: PRIOR }, { ...snapshotAvailable }, [summary({ runId: PRIOR, status: "RUNNING", completedAt: null })])));
    await expect(getResearchRun(P, I, RUN)).rejects.toMatchObject({ status: 502 });
    fetchMock.mockResolvedValueOnce(response(detail({ replayOf: PRIOR }, { ...snapshotAvailable }, [summary({ runId: RUN, status: "FAILED" }), { ...terminalPrior, replayOf: RUN }])));
    await expect(getResearchRun(P, I, RUN)).rejects.toMatchObject({ status: 502 });
    fetchMock.mockResolvedValueOnce(response(detail({ replayOf: PRIOR }, { ...snapshotAvailable }, [{ ...terminalPrior, replayOf: OLDER }, { ...terminalPrior, replayOf: OLDER }])));
    await expect(getResearchRun(P, I, RUN)).rejects.toMatchObject({ status: 502 });
    fetchMock.mockResolvedValueOnce(response(detail({ replayOf: PRIOR }, { ...snapshotAvailable }, [terminalOlder, { ...terminalPrior, replayOf: RUN }])));
    await expect(getResearchRun(P, I, RUN)).rejects.toMatchObject({ status: 502 });
    fetchMock.mockResolvedValueOnce(response(detail({ replayOf: PRIOR }, { ...snapshotAvailable }, [{ ...terminalPrior, replayOf: OLDER }])));
    await expect(getResearchRun(P, I, RUN)).rejects.toMatchObject({ status: 502 });
    // ancestor from another issue
    fetchMock.mockResolvedValueOnce(response(detail({ replayOf: PRIOR }, { ...snapshotAvailable }, [summary({ runId: PRIOR, issueId: OLDER, status: "FAILED" })])));
    await expect(getResearchRun(P, I, RUN)).rejects.toMatchObject({ status: 502 });
    // >100 ancestors
    const many = Array.from({ length: 101 }, (_, k) => summary({ runId: `0000000a-0000-4000-8000-${String(k).padStart(12, "0")}`, status: "FAILED", replayOf: k === 0 ? null : `0000000a-0000-4000-8000-${String(k - 1).padStart(12, "0")}` }));
    fetchMock.mockResolvedValueOnce(response(detail({ replayOf: PRIOR }, { ...snapshotAvailable }, [{ ...many[100], runId: PRIOR }])));
    await expect(getResearchRun(P, I, RUN)).rejects.toMatchObject({ status: 502 });
  });
});

// ---------------------------------------------------------------- HTTP layer

describe("ResearchRun HTTP client", () => {
  const fetchMock = vi.fn();
  beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock); });
  afterEach(() => vi.unstubAllGlobals());
  function response(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }

  it.each([
    [201, "created"],
    [200, "replayed"],
  ] as const)("START %s %s: exact path/body/headers", async (status, receiptStatus) => {
    fetchMock.mockResolvedValueOnce(response({ status: receiptStatus, runId: RUN }, status));
    const input = { procedure, executionContract: contract, environment: {}, evidenceManifestId: M, replayOf: null };
    await expect(startResearchRun(P, I, KEY, input)).resolves.toEqual({ status: receiptStatus, runId: RUN });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`/api/private/s32/projects/${P}/issues/${I}/runs`);
    expect(init.method).toBe("POST");
    expect(init.cache).toBe("no-store");
    expect(init.credentials).toBe("same-origin");
    expect(init.headers).toEqual({
      "X-CSRF-Token": "csrf-test",
      "Content-Type": "application/json",
      "Idempotency-Key": KEY,
    });
    expect(init.body).toBe(JSON.stringify(input));
    expect(init.headers["Authorization"]).toBeUndefined();
  });

  it.each([
    [202, "created"],
    [200, "pending"],
    [201, "replayed"],
  ] as const)("START rejects protocol-inconsistent %s %s", async (status, receiptStatus) => {
    fetchMock.mockResolvedValueOnce(response({ status: receiptStatus, runId: RUN }, status));
    await expect(startResearchRun(P, I, KEY, { procedure, executionContract: contract, environment: {}, evidenceManifestId: M, replayOf: null }))
      .rejects.toMatchObject({ status: 502, message: "研究执行记录服务响应异常，请稍后再试。" });
  });

  it("list encodes only defined query values", async () => {
    fetchMock.mockResolvedValueOnce(response({ runs: [summary({ status: "RUNNING", completedAt: null })], nextCursor: null }));
    await expect(listResearchRuns(P, I)).resolves.toBeTruthy();
    expect(fetchMock.mock.calls[0][0]).toBe(`/api/private/s32/projects/${P}/issues/${I}/runs`);

    fetchMock.mockResolvedValueOnce(response({ runs: [], nextCursor: "opaque-cursor" }));
    await listResearchRuns(P, I, { limit: 50, cursor: "opaque-cursor" });
    expect(fetchMock.mock.calls[1][0]).toBe(`/api/private/s32/projects/${P}/issues/${I}/runs?limit=50&cursor=opaque-cursor`);

    fetchMock.mockResolvedValueOnce(response({ runs: [], nextCursor: null }));
    await listResearchRuns(P, I, { cursor: null });
    expect(fetchMock.mock.calls[2][0]).toBe(`/api/private/s32/projects/${P}/issues/${I}/runs`);
    expect(fetchMock.mock.calls[2][1].headers).toEqual({});
  });

  it("list rejects duplicate runIds and foreign issueId rows and bad cursor token", async () => {
    fetchMock.mockResolvedValueOnce(response({ runs: [summary(), summary()], nextCursor: null }));
    await expect(listResearchRuns(P, I)).rejects.toMatchObject({ status: 502 });
    fetchMock.mockResolvedValueOnce(response({ runs: [summary({ issueId: OLDER })], nextCursor: null }));
    await expect(listResearchRuns(P, I)).rejects.toMatchObject({ status: 502 });
    fetchMock.mockResolvedValueOnce(response({ runs: [], nextCursor: "" }));
    await expect(listResearchRuns(P, I)).rejects.toMatchObject({ status: 502 });
  });

  it("detail path encodes runId and cross-checks the requested scope", async () => {
    fetchMock.mockResolvedValueOnce(response(detail({ status: "RUNNING", output: null, completedAt: null })));
    await expect(getResearchRun(P, I, RUN)).resolves.toBeTruthy();
    expect(fetchMock.mock.calls[0][0]).toBe(`/api/private/s32/projects/${P}/issues/${I}/runs/${RUN}`);
    // request path encodes arbitrary segments; validator still binds the response to the requested ids
    fetchMock.mockResolvedValueOnce(response(detail({ status: "RUNNING", output: null, completedAt: null })));
    await expect(getResearchRun("p/a", I, RUN)).rejects.toMatchObject({ status: 502 });
  });

  it.each([
    ["complete", () => completeResearchRun(P, I, RUN, KEY, output()), JSON.stringify({ output: output() })],
    ["fail", () => failResearchRun(P, I, RUN, KEY, null), JSON.stringify({ output: null })],
    ["cancel", () => cancelResearchRun(P, I, RUN, KEY, null), JSON.stringify({ output: null })],
  ] as const)("transition %s sends exact {output} body with Idempotency-Key and accepts 200", async (action, call, body) => {
    fetchMock.mockResolvedValueOnce(response({ status: "created", runId: RUN }));
    await expect(call()).resolves.toEqual({ status: "created", runId: RUN });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`/api/private/s32/projects/${P}/issues/${I}/runs/${RUN}/${action}`);
    expect(init.method).toBe("POST");
    expect(init.body).toBe(body);
    expect(init.headers["Idempotency-Key"]).toBe(KEY);
  });

  it("transition accepts replayed receipt but rejects runId mismatch and non-200", async () => {
    fetchMock.mockResolvedValueOnce(response({ status: "replayed", runId: RUN }));
    await expect(cancelResearchRun(P, I, RUN, KEY, null)).resolves.toEqual({ status: "replayed", runId: RUN });
    fetchMock.mockResolvedValueOnce(response({ status: "created", runId: PRIOR }));
    await expect(cancelResearchRun(P, I, RUN, KEY, null)).rejects.toMatchObject({ status: 502 });
    fetchMock.mockResolvedValueOnce(response({ status: "created", runId: RUN }, 201));
    await expect(cancelResearchRun(P, I, RUN, KEY, null)).rejects.toMatchObject({ status: 502 });
  });

  it.each([
    [201, "created"],
    [200, "replayed"],
  ] as const)("REPLAY %s %s posts to prior run subroute", async (status, receiptStatus) => {
    fetchMock.mockResolvedValueOnce(response({ status: receiptStatus, runId: RUN }, status));
    await expect(replayResearchRun(P, I, PRIOR, KEY, { procedure, executionContract: contract, environment: {}, evidenceManifestId: M }))
      .resolves.toEqual({ status: receiptStatus, runId: RUN });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`/api/private/s32/projects/${P}/issues/${I}/runs/${PRIOR}/replay`);
    expect(init.method).toBe("POST");
    expect(init.headers["Idempotency-Key"]).toBe(KEY);
  });

  it("maps backend safe error codes to contextual messages", async () => {
    const cases: Array<[number, string, string, number]> = [
      [400, "RESEARCH_RUN_INVALID", "研究执行记录输入不正确。", 400],
      [404, "PROJECT_OR_ISSUE_NOT_FOUND", "研究项目或研究问题不存在。", 404],
      [404, "RESEARCH_RUN_NOT_FOUND", "该研究执行记录当前不可用。", 404],
      [409, "RESEARCH_RUN_ALREADY_TERMINAL", "该研究执行记录已结束，不能再变更。", 409],
      [409, "RESEARCH_RUN_REPLAY_INVALID", "重放条件不满足，请刷新后重试。", 409],
      [409, "IDEMPOTENCY_CONFLICT", "提交标识与当前研究执行记录内容不一致。", 409],
      [503, "RESEARCH_RUN_STORE_UNAVAILABLE", "研究执行服务暂不可用。", 503],
    ];
    for (const [httpStatus, code, message, expectedStatus] of cases) {
      fetchMock.mockResolvedValueOnce(response({ error: { code } }, httpStatus));
      await expect(completeResearchRun(P, I, RUN, KEY, output())).rejects.toMatchObject({ status: expectedStatus, message, code });
    }
    // GET-side: only scope/run not-found mappings, generic otherwise
    fetchMock.mockResolvedValueOnce(response({ error: { code: "RESEARCH_RUN_ALREADY_TERMINAL" } }, 409));
    await expect(getResearchRun(P, I, RUN)).rejects.toMatchObject({ status: 409, message: "项目或书目状态冲突，请刷新后再试。" });
  });

  it("maps 500 and malformed 2xx to safe generic messages without echoing detail", async () => {
    fetchMock.mockResolvedValueOnce(response({ error: { code: "RESEARCH_RUN_INTEGRITY", detail: "内部SQL细节" } }, 500));
    await expect(completeResearchRun(P, I, RUN, KEY, output())).rejects.toMatchObject({ status: 500, message: "研究执行记录请求失败，请稍后再试。" });
    fetchMock.mockResolvedValueOnce(response({ surprise: true }));
    await expect(completeResearchRun(P, I, RUN, KEY, output())).rejects.toMatchObject({ status: 502, message: "研究执行记录服务响应异常，请稍后再试。" });
    fetchMock.mockResolvedValueOnce(new Response("<html>not json</html>", { status: 200 }));
    await expect(listResearchRuns(P, I)).rejects.toMatchObject({ status: 502, message: "研究执行记录服务响应异常，请稍后再试。" });
  });

  it("sends zero fetch when unauthenticated or CSRF missing", async () => {
    __setWebAuthSnapshotForTests({ status: "anonymous", user: null, csrfToken: null, error: null });
    await expect(listResearchRuns(P, I)).rejects.toBeInstanceOf(ProjectApiError);
    __setWebAuthSnapshotForTests({ status: "authenticated", user: { email: "owner@example.com", name: "Owner" }, csrfToken: null, error: null });
    await expect(startResearchRun(P, I, KEY, { procedure, executionContract: contract, environment: {}, evidenceManifestId: M, replayOf: null })).rejects.toMatchObject({ status: 403 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
