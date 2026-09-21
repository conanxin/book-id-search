// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ProjectApiError,
  createAssessment,
  getAssessment,
  listAssessments,
} from "./api";

const P = "11111111-1111-4111-8111-111111111111";
const I = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const A = "44444444-4444-4444-8444-444444444444";
const M = "55555555-5555-4555-8555-555555555555";
const SOURCE = "66666666-6666-4666-8666-666666666666";
const KEY = "77777777-7777-4777-8777-777777777777";
const ACTOR = "88888888-8888-4888-8888-888888888888";

const manifestSummary = {
  id: M,
  schemaVersion: 1,
  purpose: "CLAIM_ASSESSMENT",
  manifestSha256: "a".repeat(64),
  itemCount: 1,
};
const record = {
  id: A,
  claimId: C,
  stance: "SUPPORTS",
  confidenceLevel: null,
  actorId: null,
  numericScore: null,
  scoreKind: null,
  reasoning: "because",
  createdAt: "2026-09-21T00:00:00.000Z",
};
const summary = {
  id: A,
  stance: "SUPPORTS",
  confidenceLevel: null,
  actorId: null,
  numericScore: null,
  scoreKind: null,
  reasoningExcerpt: "because",
  createdAt: record.createdAt,
  evidenceManifest: manifestSummary,
};
const claim = { id: C, statement: "Candidate", lifecycleState: "ACTIVE" };
const detail = {
  claim,
  assessment: record,
  evidenceManifest: {
    id: M,
    schemaVersion: 1,
    purpose: "CLAIM_ASSESSMENT",
    manifestSha256: "a".repeat(64),
    createdAt: record.createdAt,
    items: [{
      ordinal: 1,
      role: "SUPPORTING",
      targetType: "SOURCE",
      targetId: SOURCE,
      locatorType: null,
      locator: null,
      excerpt: null,
      note: null,
    }],
  },
};

const fetchMock = vi.fn();
beforeEach(() => { vi.stubGlobal("fetch", fetchMock); fetchMock.mockReset(); });
afterEach(() => vi.unstubAllGlobals());

function response(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function generatedUuid(n: number): string {
  return n.toString(16).padStart(8, "0")
    + "-0000-4000-8000-"
    + n.toString(16).padStart(12, "0");
}

describe("assessment client paths", () => {
  it("POST sends exact command and Idempotency-Key", async () => {
    fetchMock.mockResolvedValueOnce(response({
      status: "created",
      visible: true,
      assessment: record,
      evidenceManifest: manifestSummary,
    }, 201));
    await createAssessment("token", P, I, C, KEY, {
      stance: "SUPPORTS",
      confidenceLevel: null,
      reasoning: "because",
      expectedManifestSha256: "a".repeat(64),
      items: [{ role: "SUPPORTING", targetType: "SOURCE", targetId: SOURCE, note: null }],
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/private/s32/projects/" + P + "/issues/" + I + "/claims/" + C + "/assessments");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Idempotency-Key"]).toBe(KEY);
    expect(JSON.parse(init.body)).toEqual({
      stance: "SUPPORTS",
      confidenceLevel: null,
      reasoning: "because",
      expectedManifestSha256: "a".repeat(64),
      items: [{ role: "SUPPORTING", targetType: "SOURCE", targetId: SOURCE, note: null }],
    });
  });

  it("history uses encoded cursor/limit query and detail uses exact assessment path", async () => {
    fetchMock.mockResolvedValueOnce(response({ claim, assessments: [summary], nextCursor: null }));
    await listAssessments("t", P, I, C, { limit: 20, cursor: "opaque" });
    expect(fetchMock.mock.calls[0][0]).toBe(
      "/api/private/s32/projects/" + P + "/issues/" + I + "/claims/" + C + "/assessments?limit=20&cursor=opaque",
    );

    fetchMock.mockResolvedValueOnce(response(detail));
    await getAssessment("t", P, I, C, A);
    expect(fetchMock.mock.calls[1][0]).toBe(
      "/api/private/s32/projects/" + P + "/issues/" + I + "/claims/" + C + "/assessments/" + A,
    );
  });
});

describe("strict assessment response validation", () => {
  it("accepts future-compatible Actor/score/null reasoning", async () => {
    fetchMock.mockResolvedValueOnce(response({
      claim,
      assessments: [{
        ...summary,
        actorId: ACTOR,
        numericScore: 0.82,
        scoreKind: "CALIBRATED_PROBABILITY",
        reasoningExcerpt: null,
      }],
      nextCursor: null,
    }));
    const result = await listAssessments("t", P, I, C);
    expect(result.assessments[0]).toMatchObject({
      actorId: ACTOR,
      numericScore: 0.82,
      scoreKind: "CALIBRATED_PROBABILITY",
      reasoningExcerpt: null,
    });

    fetchMock.mockResolvedValueOnce(response({
      ...detail,
      assessment: {
        ...record,
        actorId: ACTOR,
        numericScore: 0.82,
        scoreKind: "CALIBRATED_PROBABILITY",
        reasoning: null,
      },
    }));
    expect((await getAssessment("t", P, I, C, A)).assessment.reasoning).toBeNull();
  });

  it("rejects malformed score pairing and malformed Manifest summary", async () => {
    fetchMock.mockResolvedValueOnce(response({
      claim,
      assessments: [{ ...summary, numericScore: 0.5, scoreKind: null }],
      nextCursor: null,
    }));
    await expect(listAssessments("t", P, I, C)).rejects.toMatchObject({ status: 502 });

    fetchMock.mockResolvedValueOnce(response({
      claim,
      assessments: [{ ...summary, evidenceManifest: { ...manifestSummary, purpose: "OTHER" } }],
      nextCursor: null,
    }));
    await expect(listAssessments("t", P, I, C)).rejects.toMatchObject({ status: 502 });
  });

  it("accepts minimal replay visible=false and rejects protected extra fields", async () => {
    const input = {
      stance: "SUPPORTS" as const,
      confidenceLevel: null,
      reasoning: "because",
      expectedManifestSha256: "a".repeat(64),
      items: [{ role: "SUPPORTING" as const, targetType: "SOURCE" as const, targetId: SOURCE, note: null }],
    };
    fetchMock.mockResolvedValueOnce(response({ status: "replayed", visible: false, assessmentId: A }));
    expect(await createAssessment("t", P, I, C, KEY, input))
      .toEqual({ status: "replayed", visible: false, assessmentId: A });

    fetchMock.mockResolvedValueOnce(response({
      status: "replayed",
      visible: false,
      assessmentId: A,
      reasoning: "leak",
    }));
    await expect(createAssessment("t", P, I, C, KEY, input)).rejects.toMatchObject({ status: 502 });
  });

  it("rejects noncontiguous detail ordinals and more than 100 items", async () => {
    fetchMock.mockResolvedValueOnce(response({
      ...detail,
      evidenceManifest: {
        ...detail.evidenceManifest,
        items: [{ ...detail.evidenceManifest.items[0], ordinal: 2 }],
      },
    }));
    await expect(getAssessment("t", P, I, C, A)).rejects.toMatchObject({ status: 502 });

    fetchMock.mockResolvedValueOnce(response({
      ...detail,
      evidenceManifest: {
        ...detail.evidenceManifest,
        items: Array.from({ length: 101 }, (_, n) => ({
          ...detail.evidenceManifest.items[0],
          ordinal: n + 1,
          targetId: generatedUuid(n + 1),
        })),
      },
    }));
    await expect(getAssessment("t", P, I, C, A)).rejects.toMatchObject({ status: 502 });
  });
});

describe("safe assessment errors", () => {
  it.each([
    [409, "EVIDENCE_PREVIEW_STALE", "证据集自上次预览后已发生变化，请重新预览。"],
    [404, "ASSESSMENT_NOT_FOUND", "该评价当前不可用。"],
    [503, "ASSESSMENT_STORE_UNAVAILABLE", "评价服务暂不可用。"],
  ])("maps %s %s to stable copy", async (status, code, message) => {
    fetchMock.mockResolvedValueOnce(response({ error: { code, message: "server secret" } }, status));
    const error = await getAssessment("t", P, I, C, A).catch(e => e);
    expect(error).toBeInstanceOf(ProjectApiError);
    expect(error.message).toBe(message);
    expect(error.message).not.toContain("server secret");
  });
});
