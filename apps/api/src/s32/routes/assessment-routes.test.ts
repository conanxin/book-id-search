import express from "express";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { S32Config } from "../config.js";
import { InvalidAssessmentCursorError, InvalidAssessmentInputError } from "../domain/assessment.js";
import { InvalidEvidenceDraftError } from "../domain/evidence-selection.js";
import {
  AssessmentEvidenceTargetNotAvailableError,
  AssessmentIdempotencyConflictError,
  AssessmentIntegrityError,
  AssessmentNotFoundError,
  AssessmentScopeNotFoundError,
  AssessmentStoreUnavailableError,
  EvidencePreviewStaleError,
  ProjectReadOnlyForAssessmentError,
  ResearchIssueReadOnlyForAssessmentError,
  type AssessmentsService,
} from "../application/assessments.js";
import { createAssessmentRouter } from "./assessment-routes.js";

const P = "11111111-1111-4111-8111-111111111111";
const I = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const A = "44444444-4444-4444-8444-444444444444";
const M = "55555555-5555-4555-8555-555555555555";
const SOURCE = "66666666-6666-4666-8666-666666666666";
const KEY = "77777777-7777-4777-8777-777777777777";

const config: S32Config = {
  enabled: true,
  databaseUrl: "postgresql://local/test",
  privateToken: "t",
};

const assessment = {
  id: A,
  claimId: C,
  stance: "SUPPORTS" as const,
  confidenceLevel: null,
  actorId: null,
  numericScore: null,
  scoreKind: null,
  reasoning: "because",
  createdAt: "2026-09-21T00:00:00.000Z",
};
const manifestSummary = {
  id: M,
  schemaVersion: 1 as const,
  purpose: "CLAIM_ASSESSMENT" as const,
  manifestSha256: "a".repeat(64),
  itemCount: 1,
};
const history = {
  claim: { id: C, statement: "Candidate", lifecycleState: "ACTIVE" as const },
  assessments: [{
    id: A,
    stance: "SUPPORTS" as const,
    confidenceLevel: null,
    actorId: null,
    numericScore: null,
    scoreKind: null,
    reasoningExcerpt: "because",
    createdAt: assessment.createdAt,
    evidenceManifest: manifestSummary,
  }],
  nextCursor: null,
};
const detail = {
  claim: history.claim,
  assessment,
  evidenceManifest: {
    id: M,
    schemaVersion: 1 as const,
    purpose: "CLAIM_ASSESSMENT" as const,
    manifestSha256: "a".repeat(64),
    createdAt: assessment.createdAt,
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
const body = {
  stance: "SUPPORTS",
  confidenceLevel: null,
  reasoning: "because",
  expectedManifestSha256: "a".repeat(64),
  items: [{ role: "SUPPORTING", targetType: "SOURCE", targetId: SOURCE, note: null }],
};

const servers: import("http").Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

async function start(service: AssessmentsService) {
  const app = express();
  app.use(express.json());
  app.use("/projects", createAssessmentRouter(config, service));
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>(resolve => server.once("listening", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return `http://127.0.0.1:${port}`;
}

function service(overrides: Partial<AssessmentsService> = {}): AssessmentsService {
  return {
    create: vi.fn(async () => ({
      status: "created" as const,
      visible: true as const,
      assessment,
      evidenceManifest: manifestSummary,
    })),
    list: vi.fn(async () => history),
    get: vi.fn(async () => detail),
    ...overrides,
  } as AssessmentsService;
}

async function post(base: string, extraHeaders: Record<string, string> = {}) {
  return fetch(`${base}/projects/${P}/issues/${I}/claims/${C}/assessments`, {
    method: "POST",
    headers: {
      Authorization: "Bearer t",
      "Content-Type": "application/json",
      "Idempotency-Key": KEY,
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
}

describe("assessment POST", () => {
  it("returns 201 for a newly created Assessment and no-store", async () => {
    const s = service();
    const base = await start(s);
    const res = await post(base);
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      status: "created",
      visible: true,
      assessment,
      evidenceManifest: manifestSummary,
    });
    expect(s.create).toHaveBeenCalledWith(P, I, C, KEY, body);
  });

  it("returns 200 for replay acknowledgement and never leaks protected fields when visible=false", async () => {
    const s = service({
      create: vi.fn(async () => ({ status: "replayed" as const, visible: false as const, assessmentId: A })),
    });
    const base = await start(s);
    const res = await post(base);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "replayed", visible: false, assessmentId: A });
    expect(await res.text()).toBe("");
  });
});

describe("assessment GET", () => {
  it("passes limit/cursor query to history service and returns no-store", async () => {
    const s = service();
    const base = await start(s);
    const res = await fetch(
      `${base}/projects/${P}/issues/${I}/claims/${C}/assessments?limit=20&cursor=opaque`,
      { headers: { Authorization: "Bearer t" } },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(s.list).toHaveBeenCalledWith(P, I, C, { limit: "20", cursor: "opaque" });
    expect(await res.json()).toEqual(history);
  });

  it("returns detail from the exact scoped route", async () => {
    const s = service();
    const base = await start(s);
    const res = await fetch(
      `${base}/projects/${P}/issues/${I}/claims/${C}/assessments/${A}`,
      { headers: { Authorization: "Bearer t" } },
    );
    expect(res.status).toBe(200);
    expect(s.get).toHaveBeenCalledWith(P, I, C, A);
    expect(await res.json()).toEqual(detail);
  });
});

describe("safe error mapping", () => {
  const cases: Array<[Error, number, string]> = [
    [new InvalidAssessmentInputError("secret"), 400, "ASSESSMENT_INVALID"],
    [new InvalidAssessmentCursorError("secret"), 400, "ASSESSMENT_CURSOR_INVALID"],
    [new InvalidEvidenceDraftError("secret"), 400, "EVIDENCE_DRAFT_INVALID"],
    [new AssessmentScopeNotFoundError("secret"), 404, "PROJECT_ISSUE_OR_CLAIM_NOT_FOUND"],
    [new AssessmentEvidenceTargetNotAvailableError("secret"), 404, "EVIDENCE_TARGET_NOT_AVAILABLE"],
    [new AssessmentNotFoundError("secret"), 404, "ASSESSMENT_NOT_FOUND"],
    [new ProjectReadOnlyForAssessmentError("secret"), 409, "PROJECT_READ_ONLY"],
    [new ResearchIssueReadOnlyForAssessmentError("secret"), 409, "RESEARCH_ISSUE_READ_ONLY"],
    [new EvidencePreviewStaleError("secret"), 409, "EVIDENCE_PREVIEW_STALE"],
    [new AssessmentIdempotencyConflictError("secret"), 409, "IDEMPOTENCY_CONFLICT"],
    [new AssessmentStoreUnavailableError("secret"), 503, "ASSESSMENT_STORE_UNAVAILABLE"],
  ];

  it.each(cases)("%s -> %s %s", async (error, status, code) => {
    const s = service({ create: vi.fn(async () => { throw error; }) });
    const base = await start(s);
    const res = await post(base);
    expect(res.status).toBe(status);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const text = await res.text();
    expect(text).toContain(code);
    expect(text).not.toContain("secret");
  });

  it("maps integrity/unknown failures to a generic 500 without internal details", async () => {
    for (const error of [new AssessmentIntegrityError("SQL DETAIL"), new Error("STACK DETAIL")]) {
      const s = service({ create: vi.fn(async () => { throw error; }) });
      const base = await start(s);
      const res = await post(base);
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(text).not.toMatch(/SQL DETAIL|STACK DETAIL/);
    }
  });
});
