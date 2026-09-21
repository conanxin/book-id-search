import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { createEvidenceSelectionRouter } from "./evidence-selection-routes";
import type { S32Config } from "../config";
import {
  EvidenceSelectionScopeNotFoundError,
  EvidenceTargetNotAvailableError,
  EvidenceSelectionIntegrityError,
  EvidenceSelectionStoreUnavailableError,
} from "../application/evidence-selection";
import { InvalidEvidenceDraftError } from "../domain/evidence-selection";

const p = "11111111-1111-4111-8111-111111111111";
const i = "22222222-2222-4222-8222-222222222222";
const c = "33333333-3333-4333-8333-333333333333";
const src = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const claimCtx = { id: c, statement: "刘祥店可能在1960年代整体迁出。", lifecycleState: "ACTIVE" as const };
const draft = {
  schemaVersion: 1 as const,
  purpose: "CLAIM_ASSESSMENT" as const,
  manifestSha256: "a".repeat(64),
  items: [{ ordinal: 1, role: "SUPPORTING" as const, targetType: "SOURCE" as const, targetId: src, locatorType: null, locator: null, excerpt: null, note: null }],
};

function baseConfig(o: Partial<S32Config> = {}): S32Config {
  return {
    enabled: true,
    databaseUrl: "postgresql://x",
    privateToken: "t0k",
    ...o,
  } as S32Config;
}

function makeService() {
  return {
    candidates: vi.fn(async () => ({ claim: claimCtx, candidates: [] })),
    preview: vi.fn(async () => ({ claim: { id: claimCtx.id, statement: claimCtx.statement }, draft, persisted: false as const })),
  };
}

function startApp(config: S32Config, service: ReturnType<typeof makeService> | null) {
  const app = express();
  app.use(express.json());
  app.use("/projects", createEvidenceSelectionRouter(config, service as never));
  return new Promise<Server>((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
}

let server: Server | null = null;
let baseUrl = "";
beforeEach(async () => {
  const srv = await startApp(baseConfig(), makeService());
  server = srv;
  baseUrl = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
});
afterEach(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

const auth = { Authorization: "Bearer t0k" };

describe("auth and config gates", () => {
  it("feature disabled -> 404 and no service call", async () => {
    const service = makeService();
    const srv = await startApp(baseConfig({ enabled: false }), service);
    const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
    const getCandidates = await fetch(`${url}/projects/${p}/issues/${i}/claims/${c}/evidence-candidates`, { headers: auth });
    expect(getCandidates.status).toBe(404);
    expect(service.candidates).not.toHaveBeenCalled();
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  });

  it("missing token -> 401; wrong token -> 403; token unconfigured -> 503", async () => {
    const noToken = await fetch(`${baseUrl}/projects/${p}/issues/${i}/claims/${c}/evidence-candidates`);
    expect(noToken.status).toBe(401);
    const wrong = await fetch(`${baseUrl}/projects/${p}/issues/${i}/claims/${c}/evidence-candidates`, { headers: { Authorization: "Bearer bad" } });
    expect(wrong.status).toBe(403);
    const srv = await startApp(baseConfig({ privateToken: "" }), makeService());
    const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
    const unconfigured = await fetch(`${url}/projects/${p}/issues/${i}/claims/${c}/evidence-candidates`, { headers: auth });
    expect(unconfigured.status).toBe(503);
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  });

  it("service unconfigured -> 503", async () => {
    const srv = await startApp(baseConfig(), null);
    const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
    const res = await fetch(`${url}/projects/${p}/issues/${i}/claims/${c}/evidence-candidates`, { headers: auth });
    expect(res.status).toBe(503);
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  });

  it("every response carries Cache-Control no-store", async () => {
    const ok = await fetch(`${baseUrl}/projects/${p}/issues/${i}/claims/${c}/evidence-candidates`, { headers: auth });
    expect(ok.headers.get("cache-control")).toBe("no-store");
    const notFound = await fetch(`${baseUrl}/projects/${p}/issues/${i}/claims/${c}/evidence-candidates`, { headers: { Authorization: "Bearer bad" } });
    expect(notFound.headers.get("cache-control")).toBe("no-store");
  });
});

describe("success shapes", () => {
  it("candidates returns 200 with claim and candidates", async () => {
    const res = await fetch(`${baseUrl}/projects/${p}/issues/${i}/claims/${c}/evidence-candidates`, { headers: auth });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ claim: claimCtx, candidates: [] });
  });

  it("preview returns 200 with draft and persisted:false, no idempotency required", async () => {
    const res = await fetch(`${baseUrl}/projects/${p}/issues/${i}/claims/${c}/evidence-manifest-preview`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ items: [{ role: "SUPPORTING", targetType: "SOURCE", targetId: src, note: null }] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ claim: { id: claimCtx.id, statement: claimCtx.statement }, draft, persisted: false });
    expect(body.draft.items[0].ordinal).toBe(1);
  });
});

describe("safe error mapping", () => {
  it("invalid draft -> 400 EVIDENCE_DRAFT_INVALID", async () => {
    const srv = await startApp(baseConfig(), { candidates: vi.fn(), preview: vi.fn(async () => { throw new InvalidEvidenceDraftError("bad role"); }) } as never);
    const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
    const res = await fetch(`${url}/projects/${p}/issues/${i}/claims/${c}/evidence-manifest-preview`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ items: [{ role: "PRIMARY", targetType: "SOURCE", targetId: src }] }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("EVIDENCE_DRAFT_INVALID");
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  });

  it("scope not found -> 404 PROJECT_ISSUE_OR_CLAIM_NOT_FOUND", async () => {
    const srv = await startApp(baseConfig(), { candidates: vi.fn(), preview: vi.fn(async () => { throw new EvidenceSelectionScopeNotFoundError("x"); }) } as never);
    const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
    const res = await fetch(`${url}/projects/${p}/issues/${i}/claims/${c}/evidence-manifest-preview`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ items: [{ role: "SUPPORTING", targetType: "SOURCE", targetId: src, note: null }] }),
    });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("PROJECT_ISSUE_OR_CLAIM_NOT_FOUND");
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  });

  it("target not available -> 404 EVIDENCE_TARGET_NOT_AVAILABLE without existence detail", async () => {
    const srv = await startApp(baseConfig(), { candidates: vi.fn(), preview: vi.fn(async () => { throw new EvidenceTargetNotAvailableError("SECRET-uuid"); }) } as never);
    const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
    const res = await fetch(`${url}/projects/${p}/issues/${i}/claims/${c}/evidence-manifest-preview`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ items: [{ role: "SUPPORTING", targetType: "SOURCE", targetId: src, note: null }] }),
    });
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text).toContain("EVIDENCE_TARGET_NOT_AVAILABLE");
    expect(text).not.toContain("SECRET-uuid");
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  });

  it("integrity error -> 500 generic safe message; store unavailable -> 503; unknown -> 500", async () => {
    for (const [error, status] of [
      [new EvidenceSelectionIntegrityError("SQL DETAIL"), 500],
      [new EvidenceSelectionStoreUnavailableError("x"), 503],
      [new Error("unknown"), 500],
    ] as const) {
      const srv = await startApp(baseConfig(), { candidates: vi.fn(), preview: vi.fn(async () => { throw error; }) } as never);
      const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
      const res = await fetch(`${url}/projects/${p}/issues/${i}/claims/${c}/evidence-manifest-preview`, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ items: [{ role: "SUPPORTING", targetType: "SOURCE", targetId: src, note: null }] }),
      });
      expect(res.status).toBe(status);
      const text = await res.text();
      expect(text).not.toContain("SQL DETAIL");
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
  });
});
