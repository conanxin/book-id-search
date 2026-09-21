// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listEvidenceCandidates, previewEvidenceManifest, ProjectApiError } from "./api";

const p = "11111111-1111-4111-8111-111111111111";
const i = "22222222-2222-4222-8222-222222222222";
const c = "33333333-3333-4333-8333-333333333333";
const src = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const sa = "77777777-7777-4777-8777-777777777777";
const nr = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const sourceCandidate = {
  targetType: "SOURCE", targetId: src, materialBindingId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  materialTitle: "北京古道志", sourceType: "DATABASE_RECORD", sourceLifecycleState: "ACTIVE", observedAt: "2026-09-21T00:00:00.000Z",
};
const assetCandidate = {
  targetType: "SOURCE_ASSET", targetId: sa, materialBindingId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  materialTitle: "北京古道志", sourceId: src, assetType: "DOCUMENT", assetRole: "ORIGINAL", storageMode: "LOCAL", createdAt: "2026-09-21T00:00:00.000Z",
};
const noteCandidate = {
  targetType: "NOTE_REVISION", targetId: nr, materialBindingId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  materialTitle: "北京古道志", noteId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", revisionNo: 2, contentFormat: "MARKDOWN", createdAt: "2026-09-21T00:00:00.000Z",
};
const claimCtx = { id: c, statement: "刘祥店可能在1960年代整体迁出。", lifecycleState: "ACTIVE" as const };
const draft = {
  schemaVersion: 1 as const, purpose: "CLAIM_ASSESSMENT" as const, manifestSha256: "a".repeat(64),
  items: [{ ordinal: 1, role: "SUPPORTING" as const, targetType: "SOURCE" as const, targetId: src, locatorType: null, locator: null, excerpt: null, note: null }],
};

const fetchMock = vi.fn();
beforeEach(() => { vi.stubGlobal("fetch", fetchMock); fetchMock.mockReset(); });
afterEach(() => vi.unstubAllGlobals());

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as Response;
}
function err(status: number, body: unknown) {
  return { ok: false, status, json: async () => body } as Response;
}

describe("paths and request shape", () => {
  it("candidates GET hits the exact encoded path with Bearer token", async () => {
    fetchMock.mockResolvedValueOnce(ok({ claim: claimCtx, candidates: [sourceCandidate, assetCandidate, noteCandidate] }));
    const result = await listEvidenceCandidates("t0k", p, i, c);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`/api/private/s32/projects/${p}/issues/${i}/claims/${c}/evidence-candidates`);
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer t0k");
    expect(result.candidates).toHaveLength(3);
  });

  it("preview POST sends normalized items and never an Idempotency-Key", async () => {
    fetchMock.mockResolvedValueOnce(ok({ claim: { id: c, statement: claimCtx.statement }, draft, persisted: false }));
    await previewEvidenceManifest("t0k", p, i, c, [{ role: "SUPPORTING", targetType: "SOURCE", targetId: src, note: null }]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`/api/private/s32/projects/${p}/issues/${i}/claims/${c}/evidence-manifest-preview`);
    expect(init.method).toBe("POST");
    expect(init.headers).not.toHaveProperty("Idempotency-Key");
    expect(JSON.parse(init.body)).toEqual({ items: [{ role: "SUPPORTING", targetType: "SOURCE", targetId: src, note: null }] });
  });

  it("aborts propagate via signal", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(listEvidenceCandidates("t", p, i, c, controller.signal)).rejects.toThrow();
  });
});

describe("strict response validation", () => {
  it.each([
    ["malformed claim", { claim: { id: 5 }, candidates: [] }],
    ["unknown role in draft", { claim: { id: c, statement: claimCtx.statement }, draft: { ...draft, items: [{ ...draft.items[0], role: "PRIMARY" }] }, persisted: false }],
    ["persisted true", { claim: { id: c, statement: claimCtx.statement }, draft, persisted: true }],
    ["manifest id present", { claim: { id: c, statement: claimCtx.statement }, draft, persisted: false, manifestId: "x" }],
    ["schemaVersion 2", { claim: { id: c, statement: claimCtx.statement }, draft: { ...draft, schemaVersion: 2 }, persisted: false }],
    ["wrong purpose", { claim: { id: c, statement: claimCtx.statement }, draft: { ...draft, purpose: "OTHER" }, persisted: false }],
    ["non-sequential ordinals", { claim: { id: c, statement: claimCtx.statement }, draft: { ...draft, items: [{ ...draft.items[0], ordinal: 2 }] }, persisted: false }],
    ["non-null locator", { claim: { id: c, statement: claimCtx.statement }, draft: { ...draft, items: [{ ...draft.items[0], locator: "p3" }] }, persisted: false }],
    ["bad hash", { claim: { id: c, statement: claimCtx.statement }, draft: { ...draft, manifestSha256: "XYZ" }, persisted: false }],
    ["duplicate targets", { claim: { id: c, statement: claimCtx.statement }, draft: { ...draft, items: [draft.items[0], draft.items[0]] }, persisted: false }],
    ["unknown targetType in candidate", { claim: claimCtx, candidates: [{ ...sourceCandidate, targetType: "CLAIM" }] }],
    ["bad revisionNo", { claim: claimCtx, candidates: [{ ...noteCandidate, revisionNo: 0 }] }],
    ["bad asset enum", { claim: claimCtx, candidates: [{ ...assetCandidate, assetRole: "OTHER" }] }],
    ["bad lifecycle", { claim: claimCtx, candidates: [{ ...sourceCandidate, sourceLifecycleState: "DELETED" }] }],
    ["bad timestamp", { claim: claimCtx, candidates: [{ ...sourceCandidate, observedAt: "not-a-date" }] }],
    ["malformed note in draft", { claim: { id: c, statement: claimCtx.statement }, draft: { ...draft, items: [{ ...draft.items[0], note: 5 }] }, persisted: false }],
  ])("rejects %s", async (_name, body) => {
    fetchMock.mockResolvedValueOnce(ok(body));
    if ("candidates" in (body as Record<string, unknown>)) {
      await expect(listEvidenceCandidates("t", p, i, c)).rejects.toThrow(ProjectApiError);
    } else {
      await expect(previewEvidenceManifest("t", p, i, c, [{ role: "SUPPORTING", targetType: "SOURCE", targetId: src, note: null }])).rejects.toThrow(ProjectApiError);
    }
  });

  it("missing candidate fields are rejected", async () => {
    fetchMock.mockResolvedValueOnce(ok({ claim: claimCtx, candidates: [{ ...sourceCandidate, materialTitle: undefined }] }));
    await expect(listEvidenceCandidates("t", p, i, c)).rejects.toThrow(ProjectApiError);
  });
});

describe("safe error mapping", () => {
  it.each([
    [400, { error: { code: "EVIDENCE_DRAFT_INVALID", message: "server detail" } }, "证据草稿输入不正确。"],
    [404, { error: { code: "PROJECT_ISSUE_OR_CLAIM_NOT_FOUND", message: "server detail" } }, "研究问题或可能答案不存在。"],
    [404, { error: { code: "EVIDENCE_TARGET_NOT_AVAILABLE", message: "server detail" } }, "所选证据不可用于当前研究项目。"],
  ])("maps %i %s to frozen copy without leaking server detail", async (status, body, message) => {
    fetchMock.mockResolvedValue(err(status, body));
    const error = await previewEvidenceManifest("t", p, i, c, [{ role: "SUPPORTING", targetType: "SOURCE", targetId: src, note: null }]).catch(e => e);
    expect(error).toBeInstanceOf(ProjectApiError);
    expect(error.message).toBe(message);
    expect(error.message).not.toContain("server detail");
  });
});
