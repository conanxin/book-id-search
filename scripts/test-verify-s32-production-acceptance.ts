import { afterEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import {
  formatAcceptanceResult,
  runProductionAcceptance,
} from "./verify-s32-production-acceptance";

const UUID = {
  project: "11111111-1111-4111-8111-111111111111",
  binding: "21111111-1111-4111-8111-111111111111",
  note: "31111111-1111-4111-8111-111111111111",
  revision: "41111111-1111-4111-8111-111111111111",
  issue: "51111111-1111-4111-8111-111111111111",
  claim: "61111111-1111-4111-8111-111111111111",
  source: "71111111-1111-4111-8111-111111111111",
  assessment: "81111111-1111-4111-8111-111111111111",
  manifest: "91111111-1111-4111-8111-111111111111",
};

type State = {
  projects: number;
  issues: number;
  claims: number;
  assessments: number;
  droppedAssessmentResponses: number;
};

const servers: Array<ReturnType<typeof createServer>> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function body(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
}

function send(res: ServerResponse, status: number, value: unknown) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(value));
}

async function fixtureServer(token: string, fingerprint: string) {
  const short = fingerprint.slice(0, 12);
  const name = `[S32 Production Acceptance] ${short}`;
  const issueTitle = `[Acceptance] ${short}`;
  const claimStatement = `Production acceptance claim ${short}.`;
  const reasoning = `Production acceptance assessment ${short}.`;
  const state: State = { projects: 0, issues: 0, claims: 0, assessments: 0, droppedAssessmentResponses: 0 };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.pathname.startsWith("/api/private/s32")) {
      if (req.headers.authorization !== `Bearer ${token}`) return send(res, 403, { error: { message: "bad token" } });
    }

    if (url.pathname === "/api/health") return send(res, 200, { ok: true });
    if (url.pathname === "/api/stats") return send(res, 200, { numberOfDocuments: 5115734, isIndexing: false });
    if (url.pathname === "/api/search") return send(res, 200, { items: [{ id: "catalog-book-1", title: "Acceptance Book" }] });

    if (url.pathname === "/api/private/s32/projects" && req.method === "GET") {
      return send(res, 200, { projects: state.projects ? [{ id: UUID.project, name, description: "acceptance", lifecycleState: "ACTIVE", createdAt: "2026-09-22T00:00:00Z", updatedAt: "2026-09-22T00:00:00Z" }] : [] });
    }
    if (url.pathname === "/api/private/s32/projects" && req.method === "POST") {
      state.projects += 1;
      return send(res, 201, { project: { id: UUID.project, name, description: "acceptance", lifecycleState: "ACTIVE", createdAt: "2026-09-22T00:00:00Z", updatedAt: "2026-09-22T00:00:00Z" } });
    }
    if (url.pathname === `/api/private/s32/projects/${UUID.project}/catalog-books` && req.method === "POST") {
      return send(res, 200, {
        promotionStatus: "existing",
        bindingStatus: "existing",
        item: { bindingId: UUID.binding, projectId: UUID.project, workId: "aaaaaaaa-1111-4111-8111-111111111111", editionId: "bbbbbbbb-1111-4111-8111-111111111111", sourceId: UUID.source, catalogBookId: "catalog-book-1", title: "Acceptance Book", publisher: null, publicationDate: null, publicationDatePrecision: "YEAR", isbn: null, addedAt: "2026-09-22T00:00:00Z" },
      });
    }
    if (url.pathname === `/api/private/s32/projects/${UUID.project}/items/${UUID.binding}/note` && req.method === "GET") {
      return send(res, 200, { note: state.projects > 1 ? { noteId: UUID.note } : null });
    }
    if (url.pathname === `/api/private/s32/projects/${UUID.project}/items/${UUID.binding}/note` && req.method === "POST") {
      return send(res, 201, { note: { noteId: UUID.note, currentRevision: { revisionId: UUID.revision } } });
    }
    if (url.pathname === `/api/private/s32/projects/${UUID.project}/issues` && req.method === "GET") {
      return send(res, 200, { project: { id: UUID.project }, issues: state.issues ? [{ id: UUID.issue, projectId: UUID.project, title: issueTitle, questionExcerpt: "Acceptance?", lifecycleState: "OPEN", createdAt: "2026-09-22T00:00:00Z", updatedAt: "2026-09-22T00:00:00Z" }] : [] });
    }
    if (url.pathname === `/api/private/s32/projects/${UUID.project}/issues` && req.method === "POST") {
      state.issues += 1;
      return send(res, 201, { project: { id: UUID.project }, issue: { id: UUID.issue, projectId: UUID.project, title: issueTitle, question: "Acceptance?", lifecycleState: "OPEN", createdAt: "2026-09-22T00:00:00Z", updatedAt: "2026-09-22T00:00:00Z" } });
    }
    if (url.pathname === `/api/private/s32/projects/${UUID.project}/issues/${UUID.issue}/claims` && req.method === "GET") {
      return send(res, 200, { claims: state.claims ? [{ id: UUID.claim, statement: claimStatement, lifecycleState: "ACTIVE", createdAt: "2026-09-22T00:00:00Z", updatedAt: "2026-09-22T00:00:00Z" }] : [] });
    }
    if (url.pathname === `/api/private/s32/projects/${UUID.project}/issues/${UUID.issue}/claims` && req.method === "POST") {
      state.claims += 1;
      return send(res, 201, { claim: { id: UUID.claim, statement: claimStatement, lifecycleState: "ACTIVE", createdAt: "2026-09-22T00:00:00Z", updatedAt: "2026-09-22T00:00:00Z" } });
    }
    if (url.pathname.endsWith("/evidence-candidates") && req.method === "GET") {
      return send(res, 200, { claim: { id: UUID.claim, statement: claimStatement, lifecycleState: "ACTIVE" }, candidates: [{ targetType: "SOURCE", targetId: UUID.source, materialBindingId: UUID.binding, materialTitle: "Acceptance Book", sourceType: "DATABASE_RECORD", sourceLifecycleState: "ACTIVE", observedAt: "2026-09-22T00:00:00Z" }] });
    }
    if (url.pathname.endsWith("/evidence-manifest-preview") && req.method === "POST") {
      return send(res, 200, { claim: { id: UUID.claim, statement: claimStatement }, persisted: false, draft: { schemaVersion: 1, purpose: "CLAIM_ASSESSMENT", manifestSha256: "a".repeat(64), items: [{ ordinal: 1, role: "SUPPORTING", targetType: "SOURCE", targetId: UUID.source, locatorType: null, locator: null, excerpt: null, note: null }] } });
    }
    if (url.pathname.endsWith("/assessments") && req.method === "GET") {
      return send(res, 200, { claim: { id: UUID.claim, statement: claimStatement, lifecycleState: "ACTIVE" }, assessments: state.assessments ? [{ id: UUID.assessment, stance: "SUPPORTS", confidenceLevel: "HIGH", actorId: null, numericScore: null, scoreKind: null, reasoningExcerpt: reasoning, createdAt: "2026-09-22T00:00:00Z", evidenceManifest: { id: UUID.manifest, schemaVersion: 1, purpose: "CLAIM_ASSESSMENT", manifestSha256: "a".repeat(64), itemCount: 1 } }] : [], nextCursor: null });
    }
    if (url.pathname.endsWith("/assessments") && req.method === "POST") {
      await body(req);
      state.assessments = 1;
      const response = { status: state.droppedAssessmentResponses ? "replayed" : "created", visible: true, assessment: { id: UUID.assessment, claimId: UUID.claim, stance: "SUPPORTS", confidenceLevel: "HIGH", actorId: null, numericScore: null, scoreKind: null, reasoning, createdAt: "2026-09-22T00:00:00Z" }, evidenceManifest: { id: UUID.manifest, schemaVersion: 1, purpose: "CLAIM_ASSESSMENT", manifestSha256: "a".repeat(64), itemCount: 1 } };
      if (!state.droppedAssessmentResponses) state.droppedAssessmentResponses += 1;
      return send(res, state.droppedAssessmentResponses > 1 ? 200 : 201, response);
    }
    if (url.pathname.endsWith(`/assessments/${UUID.assessment}`) && req.method === "GET") {
      return send(res, 200, { claim: { id: UUID.claim, statement: claimStatement, lifecycleState: "ACTIVE" }, assessment: { id: UUID.assessment, claimId: UUID.claim, stance: "SUPPORTS", confidenceLevel: "HIGH", actorId: null, numericScore: null, scoreKind: null, reasoning, createdAt: "2026-09-22T00:00:00Z" }, evidenceManifest: { id: UUID.manifest, schemaVersion: 1, purpose: "CLAIM_ASSESSMENT", manifestSha256: "a".repeat(64), createdAt: "2026-09-22T00:00:00Z", items: [{ ordinal: 1, role: "SUPPORTING", targetType: "SOURCE", targetId: UUID.source, locatorType: null, locator: null, excerpt: null, note: null }] } });
    }

    send(res, 404, { error: { message: url.pathname } });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture address unavailable");
  return { base: `http://127.0.0.1:${address.port}`, state };
}

describe("S32 production acceptance harness", () => {
  it("creates one release-scoped canary, exercises the full chain, and reuses it on rerun", async () => {
    const token = "TOP_SECRET_SENTINEL";
    const fingerprint = "f".repeat(64);
    const fixture = await fixtureServer(token, fingerprint);
    const first = await runProductionAcceptance({ apiBaseUrl: fixture.base, publicUrl: fixture.base, token, releaseFingerprint: fingerprint });
    const second = await runProductionAcceptance({ apiBaseUrl: fixture.base, publicUrl: fixture.base, token, releaseFingerprint: fingerprint });
    expect(first.projectName).toBe("[S32 Production Acceptance] ffffffffffff");
    expect(second.projectId).toBe(first.projectId);
    expect(fixture.state.projects).toBe(1);
    expect(fixture.state.issues).toBe(1);
    expect(fixture.state.claims).toBe(1);
    expect(fixture.state.assessments).toBe(1);
    expect(first.legacySearchRegression).toBe("PASS");
    expect(first.assessmentReplay).toBe("PASS");
  });

  it("never renders the bearer token in its machine-readable result", async () => {
    const token = "TOP_SECRET_SENTINEL";
    const fingerprint = "e".repeat(64);
    const fixture = await fixtureServer(token, fingerprint);
    const result = await runProductionAcceptance({ apiBaseUrl: fixture.base, publicUrl: fixture.base, token, releaseFingerprint: fingerprint, backendOnly: true });
    expect(formatAcceptanceResult(result)).not.toContain(token);
  });
});
