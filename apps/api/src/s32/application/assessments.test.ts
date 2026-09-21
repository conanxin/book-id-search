import { describe, expect, it, vi } from "vitest";
import {
  AssessmentNotFoundError,
  AssessmentScopeNotFoundError,
  createAssessmentsService,
  type AssessmentCommandStore,
  type AssessmentReadStore,
} from "./assessments.js";
import { encodeAssessmentCursor } from "../domain/assessment.js";

const P = "11111111-1111-4111-8111-111111111111";
const I = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const A = "44444444-4444-4444-8444-444444444444";
const M = "55555555-5555-4555-8555-555555555555";
const SOURCE = "66666666-6666-4666-8666-666666666666";
const KEY = "77777777-7777-4777-8777-777777777777";

const BODY = {
  stance: "SUPPORTS",
  confidenceLevel: null,
  reasoning: "当前证据支持。",
  expectedManifestSha256: "a".repeat(64),
  items: [{
    role: "SUPPORTING",
    targetType: "SOURCE",
    targetId: SOURCE,
    note: null,
  }],
};

const RECORD = {
  id: A,
  claimId: C,
  stance: "SUPPORTS" as const,
  confidenceLevel: null,
  actorId: null,
  numericScore: null,
  scoreKind: null,
  reasoning: "当前证据支持。",
  createdAt: "2026-09-21T00:00:00.000Z",
};

const MANIFEST_SUMMARY = {
  id: M,
  schemaVersion: 1 as const,
  purpose: "CLAIM_ASSESSMENT" as const,
  manifestSha256: "a".repeat(64),
  itemCount: 1,
};

const DETAIL = {
  claim: { id: C, statement: "Candidate", lifecycleState: "ACTIVE" as const },
  assessment: RECORD,
  evidenceManifest: {
    id: M,
    schemaVersion: 1 as const,
    purpose: "CLAIM_ASSESSMENT" as const,
    manifestSha256: "a".repeat(64),
    createdAt: "2026-09-21T00:00:00.000Z",
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
  },
};

const HISTORY = {
  claim: DETAIL.claim,
  assessments: [{
    id: A,
    stance: "SUPPORTS" as const,
    confidenceLevel: null,
    actorId: null,
    numericScore: null,
    scoreKind: null,
    reasoningExcerpt: "当前证据支持。",
    createdAt: RECORD.createdAt,
    evidenceManifest: MANIFEST_SUMMARY,
  }],
  nextCursor: null,
};

function stores(commandResult: Awaited<ReturnType<AssessmentCommandStore["create"]>>, detailLookup: Awaited<ReturnType<AssessmentReadStore["get"]>> = { kind: "ok", value: DETAIL }) {
  const commandStore: AssessmentCommandStore = { create: vi.fn(async () => commandResult) };
  const readStore: AssessmentReadStore = {
    list: vi.fn(async () => ({ kind: "ok", value: HISTORY })),
    get: vi.fn(async () => detailLookup),
  };
  return { commandStore, readStore };
}

describe("assessment application create", () => {
  it("generates all IDs once, normalizes command, and passes request hash to the store", async () => {
    const { commandStore, readStore } = stores({
      status: "created",
      assessment: RECORD,
      evidenceManifest: MANIFEST_SUMMARY,
    });
    const service = createAssessmentsService(commandStore, readStore);
    await service.create(P.toUpperCase(), I.toUpperCase(), C.toUpperCase(), KEY, BODY);
    const sent = vi.mocked(commandStore.create).mock.calls[0][0];
    expect(sent.projectId).toBe(P);
    expect(sent.issueId).toBe(I);
    expect(sent.claimId).toBe(C);
    expect(sent.idempotencyKey).toBe(KEY);
    expect(sent.assessmentId).toMatch(/^[0-9a-f-]{36}$/);
    expect(sent.manifestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(sent.manifestItemIds).toHaveLength(1);
    expect(sent.requestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set([sent.assessmentId, sent.manifestId, ...sent.manifestItemIds]).size).toBe(3);
  });

  it("returns a created resource without invoking the read store", async () => {
    const { commandStore, readStore } = stores({
      status: "created",
      assessment: RECORD,
      evidenceManifest: MANIFEST_SUMMARY,
    });
    const result = await createAssessmentsService(commandStore, readStore).create(P, I, C, KEY, BODY);
    expect(result).toEqual({
      status: "created",
      visible: true,
      assessment: RECORD,
      evidenceManifest: MANIFEST_SUMMARY,
    });
    expect(readStore.get).not.toHaveBeenCalled();
  });

  it("maps completed replay visibility through the read store", async () => {
    const hidden = stores({ status: "replayed", assessmentId: A }, { kind: "not-visible" });
    await expect(createAssessmentsService(hidden.commandStore, hidden.readStore).create(P, I, C, KEY, BODY))
      .resolves.toEqual({ status: "replayed", visible: false, assessmentId: A });

    const visible = stores({ status: "replayed", assessmentId: A });
    await expect(createAssessmentsService(visible.commandStore, visible.readStore).create(P, I, C, KEY, BODY))
      .resolves.toEqual({
        status: "replayed",
        visible: true,
        assessment: RECORD,
        evidenceManifest: MANIFEST_SUMMARY,
      });
  });
});

describe("assessment application reads", () => {
  it("delegates history/detail with normalized IDs and parsed cursor/limit", async () => {
    const { commandStore, readStore } = stores({
      status: "created",
      assessment: RECORD,
      evidenceManifest: MANIFEST_SUMMARY,
    });
    const service = createAssessmentsService(commandStore, readStore);
    const cursor = encodeAssessmentCursor({ createdAt: RECORD.createdAt, id: A });
    await service.list(P.toUpperCase(), I.toUpperCase(), C.toUpperCase(), { limit: "20", cursor });
    expect(readStore.list).toHaveBeenCalledWith({
      projectId: P,
      issueId: I,
      claimId: C,
      limit: 20,
      cursor: { createdAt: RECORD.createdAt, id: A },
    });
    await service.get(P.toUpperCase(), I.toUpperCase(), C.toUpperCase(), A.toUpperCase());
    expect(readStore.get).toHaveBeenCalledWith({
      projectId: P,
      issueId: I,
      claimId: C,
      assessmentId: A,
    });
  });

  it("maps scope-missing and not-visible tagged lookups to distinct safe application errors", async () => {
    const base = stores({
      status: "created",
      assessment: RECORD,
      evidenceManifest: MANIFEST_SUMMARY,
    });
    base.readStore.list = vi.fn(async () => ({ kind: "scope-missing" }));
    await expect(createAssessmentsService(base.commandStore, base.readStore).list(P, I, C, {}))
      .rejects.toBeInstanceOf(AssessmentScopeNotFoundError);

    base.readStore.get = vi.fn(async () => ({ kind: "not-visible" }));
    await expect(createAssessmentsService(base.commandStore, base.readStore).get(P, I, C, A))
      .rejects.toBeInstanceOf(AssessmentNotFoundError);
  });
});
