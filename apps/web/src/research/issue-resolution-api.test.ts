import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ProjectApiError,
  createAssessment,
  createCandidateClaim,
  createIssueResolution,
  getIssueResolution,
  listIssueResolutionEvidenceBases,
  listIssueResolutions,
} from "./api";

const P = "11111111-1111-4111-8111-111111111111";
const I = "22222222-2222-4222-8222-222222222222";
const R = "33333333-3333-4333-8333-333333333333";
const H = "44444444-4444-4444-8444-444444444444";
const C = "55555555-5555-4555-8555-555555555555";
const A = "66666666-6666-4666-8666-666666666666";
const M = "77777777-7777-4777-8777-777777777777";
const SOURCE = "88888888-8888-4888-8888-888888888888";
const KEY = "99999999-9999-4999-8999-999999999999";
const TIME = "2026-09-28T00:00:00.123Z";

const manifestSummary = {
  id: M,
  schemaVersion: 1,
  purpose: "CLAIM_ASSESSMENT" as const,
  manifestSha256: "a".repeat(64),
  itemCount: 1,
};
const manifestDetail = {
  id: M,
  schemaVersion: 1,
  purpose: "CLAIM_ASSESSMENT" as const,
  manifestSha256: "a".repeat(64),
  createdAt: TIME,
  items: [{
    ordinal: 1,
    role: "SUPPORTING" as const,
    targetType: "SOURCE" as const,
    targetId: SOURCE,
    locatorType: null,
    locator: null,
    excerpt: null,
    note: null,
  }],
};
const issue = {
  id: I,
  lifecycleState: "OPEN" as const,
  currentResolutionId: R,
  updatedAt: TIME,
};
const current = {
  id: R,
  issueId: I,
  resolutionType: "PREFERRED_CLAIM" as const,
  preferredClaimId: C,
  rationaleExcerpt: "当前理由",
  createdAt: "2026-09-27T00:00:00.123Z",
  isCurrent: true,
  evidenceBasisAvailable: true,
  evidenceManifest: manifestSummary,
};
const historical = {
  id: H,
  issueId: I,
  resolutionType: "INSUFFICIENT_EVIDENCE" as const,
  preferredClaimId: null,
  rationaleExcerpt: null,
  createdAt: TIME,
  isCurrent: false,
  evidenceBasisAvailable: false,
  evidenceManifest: null,
};
const history = {
  issue,
  currentResolution: current,
  resolutions: [historical],
  nextCursor: "opaque-next",
};
const detail = {
  issue,
  resolution: {
    id: R,
    issueId: I,
    resolutionType: "PREFERRED_CLAIM" as const,
    preferredClaimId: C,
    rationale: null,
    createdAt: current.createdAt,
    isCurrent: true,
  },
  evidenceBasisAvailable: true,
  evidenceManifest: manifestDetail,
};
const bases = {
  issueId: I,
  evidenceBases: [{
    assessmentId: A,
    claimId: C,
    claimStatementExcerpt: "可能答案",
    stance: "SUPPORTS" as const,
    confidenceLevel: null,
    manifestId: M,
    manifestSha256: "a".repeat(64),
    itemCount: 1,
    assessmentCreatedAt: TIME,
  }],
  nextCursor: null,
};
const input = {
  expectedCurrentResolutionId: R,
  resolutionType: "PREFERRED_CLAIM" as const,
  preferredClaimId: C,
  rationale: "继续采用该候选。",
  evidenceManifestId: M,
};

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("M2-E issue resolution client paths", () => {
  it.each([
    [201, "created"],
    [200, "replayed"],
  ] as const)("POST validates %s %s and forwards the supplied command unchanged", async (status, receiptStatus) => {
    fetchMock.mockResolvedValueOnce(response({ status: receiptStatus, resolutionId: R }, status));
    const signal = new AbortController().signal;
    const forged = { ...input, privateField: "SECRET" } as any;
    await expect(createIssueResolution("token", "p/a", "i/b", KEY, forged, signal))
      .resolves.toEqual({ status: receiptStatus, resolutionId: R });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/private/s32/projects/p%2Fa/issues/i%2Fb/resolutions");
    expect(init).toEqual(expect.objectContaining({
      method: "POST",
      cache: "no-store",
      signal,
      body: JSON.stringify(forged),
    }));
    expect(init.headers).toEqual({
      Authorization: "Bearer token",
      "Content-Type": "application/json",
      "Idempotency-Key": KEY,
    });
    expect(init.body).toContain("\"privateField\":\"SECRET\"");
  });

  it.each([
    [200, "created"],
    [201, "replayed"],
    [202, "created"],
    [202, "replayed"],
  ] as const)("rejects protocol-inconsistent create status %s / %s", async (status, receiptStatus) => {
    fetchMock.mockResolvedValueOnce(response({ status: receiptStatus, resolutionId: R }, status));
    await expect(createIssueResolution("t", P, I, KEY, input)).rejects.toMatchObject({
      status: 502,
      message: "工作结论服务响应异常，请稍后再试。",
    });
  });

  it("uses encoded history/detail/evidence-basis paths and opaque query values", async () => {
    fetchMock
      .mockResolvedValueOnce(response(history))
      .mockResolvedValueOnce(response(detail))
      .mockResolvedValueOnce(response(bases));

    await expect(listIssueResolutions("t", "p/a", "i/b", { limit: 20, cursor: "a+b/c==" }))
      .rejects.toMatchObject({ status: 502 });
    await expect(getIssueResolution("t", "p/a", "i/b", "r/c"))
      .rejects.toMatchObject({ status: 502 });
    await listIssueResolutionEvidenceBases("t", "p/a", "i/b", { limit: 7, cursor: "x+y/z==" });

    expect(fetchMock.mock.calls[0][0]).toBe(
      "/api/private/s32/projects/p%2Fa/issues/i%2Fb/resolutions?limit=20&cursor=a%2Bb%2Fc%3D%3D",
    );
    expect(fetchMock.mock.calls[1][0]).toBe(
      "/api/private/s32/projects/p%2Fa/issues/i%2Fb/resolutions/r%2Fc",
    );
    expect(fetchMock.mock.calls[2][0]).toBe(
      "/api/private/s32/projects/p%2Fa/issues/i%2Fb/resolution-evidence-bases?limit=7&cursor=x%2By%2Fz%3D%3D",
    );
  });
});

describe("strict authoritative Resolution validation", () => {
  it("accepts current outside the requested history page", async () => {
    fetchMock.mockResolvedValueOnce(response(history));
    const result = await listIssueResolutions("t", P, I);
    expect(result.issue.currentResolutionId).toBe(R);
    expect(result.currentResolution?.id).toBe(R);
    expect(result.resolutions.map(item => item.id)).toEqual([H]);
  });

  it("accepts null authoritative pointer with nonempty historical rows", async () => {
    fetchMock.mockResolvedValueOnce(response({
      ...history,
      issue: { ...issue, currentResolutionId: null },
      currentResolution: null,
    }));
    await expect(listIssueResolutions("t", P, I)).resolves.toMatchObject({
      issue: { currentResolutionId: null },
      currentResolution: null,
      resolutions: [{ id: H, isCurrent: false }],
    });
  });

  it("accepts legacy nullable rationale and hidden evidence in detail", async () => {
    fetchMock.mockResolvedValueOnce(response({
      ...detail,
      resolution: { ...detail.resolution, rationale: null },
      evidenceBasisAvailable: false,
      evidenceManifest: null,
    }));
    const result = await getIssueResolution("t", P, I, R);
    expect(result.resolution.rationale).toBeNull();
    expect(result.evidenceBasisAvailable).toBe(false);
    expect(result.evidenceManifest).toBeNull();
  });

  it.each([
    {
      name: "issue updatedAt year-only",
      call: () => listIssueResolutions("t", P, I),
      body: { ...history, issue: { ...issue, updatedAt: "2026" } },
    },
    {
      name: "summary createdAt impossible date",
      call: () => listIssueResolutions("t", P, I),
      body: { ...history, currentResolution: { ...current, createdAt: "2026-02-30T00:00:00.000Z" } },
    },
    {
      name: "detail record createdAt noncanonical",
      call: () => getIssueResolution("t", P, I, R),
      body: { ...detail, resolution: { ...detail.resolution, createdAt: "2026-09-28T00:00:00Z" } },
    },
    {
      name: "detail manifest createdAt numeric-like",
      call: () => getIssueResolution("t", P, I, R),
      body: { ...detail, evidenceManifest: { ...manifestDetail, createdAt: "0" } },
    },
    {
      name: "evidence basis assessmentCreatedAt noncanonical",
      call: () => listIssueResolutionEvidenceBases("t", P, I),
      body: { ...bases, evidenceBases: [{ ...bases.evidenceBases[0], assessmentCreatedAt: "2026" }] },
    },
  ])("rejects noncanonical Resolution timestamp: $name", async ({ call, body }) => {
    fetchMock.mockResolvedValueOnce(response(body));
    await expect(call()).rejects.toMatchObject({
      status: 502,
      message: "工作结论服务响应异常，请稍后再试。",
    });
  });

  it.each([
    {
      name: "requested Issue mismatch with internally consistent history",
      body: {
        ...history,
        issue: { ...issue, id: P },
        currentResolution: { ...current, issueId: P },
        resolutions: [{ ...historical, issueId: P }],
      },
    },
    {
      name: "pointer object mismatch",
      body: { ...history, currentResolution: { ...current, id: H } },
    },
    {
      name: "missing current object for non-null pointer",
      body: { ...history, currentResolution: null },
    },
    {
      name: "history row lies about current",
      body: { ...history, resolutions: [{ ...historical, isCurrent: true }] },
    },
    {
      name: "preferred/type mismatch",
      body: { ...history, currentResolution: { ...current, preferredClaimId: null } },
    },
    {
      name: "available evidence has null manifest",
      body: { ...history, currentResolution: { ...current, evidenceManifest: null } },
    },
    {
      name: "hidden evidence leaks manifest",
      body: { ...history, resolutions: [{ ...historical, evidenceManifest: manifestSummary }] },
    },
    {
      name: "protected extra field",
      body: { ...history, currentResolution: { ...current, evidenceManifestId: M } },
    },
  ])("rejects malformed history: $name", async ({ body }) => {
    fetchMock.mockResolvedValueOnce(response(body));
    await expect(listIssueResolutions("t", P, I)).rejects.toMatchObject({
      status: 502,
      message: "工作结论服务响应异常，请稍后再试。",
    });
  });

  it.each([
    {
      name: "requested Resolution mismatch with internally consistent historical row",
      body: { ...detail, resolution: { ...detail.resolution, id: H, isCurrent: false } },
    },
    {
      name: "requested Issue mismatch with internally consistent response",
      body: {
        ...detail,
        issue: { ...issue, id: P },
        resolution: { ...detail.resolution, issueId: P },
      },
    },
    {
      name: "detail scope mismatch",
      body: { ...detail, resolution: { ...detail.resolution, issueId: P } },
    },
    {
      name: "detail current flag mismatch",
      body: { ...detail, resolution: { ...detail.resolution, isCurrent: false } },
    },
    {
      name: "detail evidence pairing mismatch",
      body: { ...detail, evidenceBasisAvailable: false },
    },
    {
      name: "detail noncontiguous evidence ordinal",
      body: {
        ...detail,
        evidenceManifest: {
          ...manifestDetail,
          items: [{ ...manifestDetail.items[0], ordinal: 2 }],
        },
      },
    },
  ])("rejects malformed detail: $name", async ({ body }) => {
    fetchMock.mockResolvedValueOnce(response(body));
    await expect(getIssueResolution("t", P, I, R)).rejects.toMatchObject({ status: 502 });
  });

  it("rejects an internally valid evidence-basis page from another Issue", async () => {
    fetchMock.mockResolvedValueOnce(response({ ...bases, issueId: P }));
    await expect(listIssueResolutionEvidenceBases("t", P, I)).rejects.toMatchObject({
      status: 502,
      message: "工作结论服务响应异常，请稍后再试。",
    });
  });

  it.each([
    { assessmentId: "bad" },
    { claimStatementExcerpt: null },
    { stance: "UNKNOWN" },
    { confidenceLevel: "CERTAIN" },
    { manifestSha256: "A".repeat(64) },
    { itemCount: 0 },
    { assessmentCreatedAt: "bad" },
    { privateTargets: [SOURCE] },
  ])("rejects malformed evidence-basis row %#", async patch => {
    fetchMock.mockResolvedValueOnce(response({
      ...bases,
      evidenceBases: [{ ...bases.evidenceBases[0], ...patch }],
    }));
    await expect(listIssueResolutionEvidenceBases("t", P, I)).rejects.toMatchObject({ status: 502 });
  });

  it.each([
    { status: "created", resolutionId: "bad" },
    { status: "unknown", resolutionId: R },
    { status: "created", resolutionId: R, detail: "SECRET" },
  ])("rejects malformed create receipt %#", async body => {
    fetchMock.mockResolvedValueOnce(response(body, 201));
    await expect(createIssueResolution("t", P, I, KEY, input)).rejects.toMatchObject({ status: 502 });
  });
});

describe("safe M2-E error copy and collision isolation", () => {
  it.each([
    [400, "ISSUE_RESOLUTION_INVALID", "工作结论输入不正确。"],
    [404, "PROJECT_OR_ISSUE_NOT_FOUND", "研究项目或研究问题不存在。"],
    [404, "PREFERRED_CLAIM_NOT_AVAILABLE", "所选可能答案当前不可用。"],
    [404, "EVIDENCE_MANIFEST_NOT_AVAILABLE", "所选证据依据当前不可用。"],
    [409, "PROJECT_READ_ONLY", "当前研究项目已归档，不能新增工作结论。"],
    [409, "RESEARCH_ISSUE_READ_ONLY", "当前研究问题已归档，不能新增工作结论。"],
    [409, "ISSUE_RESOLUTION_STALE", "当前工作结论已发生变化，请刷新后再提交。"],
    [409, "IDEMPOTENCY_CONFLICT", "提交标识与当前工作结论内容不一致。"],
    [503, "ISSUE_RESOLUTION_STORE_UNAVAILABLE", "工作结论服务暂不可用。"],
  ])("maps %s %s locally without reflecting server detail", async (status, code, message) => {
    fetchMock.mockResolvedValueOnce(response({ error: { code, message: "SECRET SQL private-host" } }, status));
    const error = await createIssueResolution("t", P, I, KEY, input).catch(value => value);
    expect(error).toBeInstanceOf(ProjectApiError);
    expect(error).toMatchObject({ status, code, message });
    expect(error.message).not.toMatch(/SECRET|SQL|private-host/);
  });

  it("maps detail not-found and uncoded server failure safely", async () => {
    fetchMock
      .mockResolvedValueOnce(response({ error: { code: "ISSUE_RESOLUTION_NOT_FOUND", message: "SECRET" } }, 404))
      .mockResolvedValueOnce(response({ error: { message: "SECRET stack" } }, 500));

    await expect(getIssueResolution("t", P, I, R)).rejects.toEqual(
      new ProjectApiError(404, "该工作结论当前不可用。", "ISSUE_RESOLUTION_NOT_FOUND"),
    );
    await expect(getIssueResolution("t", P, I, R)).rejects.toMatchObject({
      status: 500,
      message: "工作结论请求失败，请稍后再试。",
    });
  });

  it("keeps shared project/issue not-found handling Resolution-local", async () => {
    fetchMock
      .mockResolvedValueOnce(response({ error: { code: "PROJECT_OR_ISSUE_NOT_FOUND", message: "SECRET" } }, 404))
      .mockResolvedValueOnce(response({ error: { code: "PROJECT_OR_ISSUE_NOT_FOUND", message: "SECRET" } }, 404));

    await expect(createCandidateClaim("t", P, I, KEY, "候选答案")).rejects.toMatchObject({
      status: 404,
      code: undefined,
      message: "项目不存在，或研究项目功能尚未开启。",
    });
    await expect(getIssueResolution("t", P, I, R)).rejects.toMatchObject({
      status: 404,
      code: "PROJECT_OR_ISSUE_NOT_FOUND",
      message: "研究项目或研究问题不存在。",
    });
  });

  it("keeps sibling IDP conflict wording unchanged", async () => {
    fetchMock
      .mockResolvedValueOnce(response({ error: { code: "IDEMPOTENCY_CONFLICT", message: "SECRET" } }, 409))
      .mockResolvedValueOnce(response({ error: { code: "IDEMPOTENCY_CONFLICT", message: "SECRET" } }, 409));

    await expect(createCandidateClaim("t", P, I, KEY, "候选答案"))
      .rejects.toMatchObject({ message: "创建请求标识与当前可能答案内容不一致。" });

    await expect(createAssessment("t", P, I, C, KEY, {
      stance: "SUPPORTS",
      confidenceLevel: null,
      reasoning: "reason",
      expectedManifestSha256: "a".repeat(64),
      items: [{ role: "SUPPORTING", targetType: "SOURCE", targetId: SOURCE, note: null }],
    })).rejects.toMatchObject({ message: "提交标识与当前评价内容不一致。" });
  });
});
