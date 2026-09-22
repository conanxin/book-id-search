import express from "express";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createResearchRouter } from "./register.js";

let server: ReturnType<express.Express["listen"]> | null = null;
let baseUrl = "";

beforeAll(async () => {
  const app = express();
  app.use(express.json({ limit: "64kb" }));
  app.use("/api/research/v0", createResearchRouter());
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server!.once("listening", resolve));
  const address = server!.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server?.close(() => resolve()));
});

async function get(path: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`);
}

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("research router", () => {
  it("GET /health returns ok", async () => {
    const res = await get("/api/research/v0/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", runtime: "research", version: "v0.1" });
  });

  it("GET /sources/:id returns the synthetic source with four axes", async () => {
    const res = await get("/api/research/v0/sources/src:test:public-book");
    expect(res.status).toBe(200);
    const body = await res.json();
    const source = body.source;
    expect(source.identity.id).toBe("src:test:public-book");
    expect(source.technicalCapabilities.actions).toContain("read_text");
    expect(source.policyRef.policyId).toBe("pol:test:public-domain-book");
    expect(source.researchProfile.authorityTiers.length).toBeGreaterThan(0);
  });

  it("GET /sources/:id unknown returns typed SOURCE_NOT_FOUND", async () => {
    const res = await get("/api/research/v0/sources/src:nope");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("SOURCE_NOT_FOUND");
  });

  it("GET /skills lists the provenance skill", async () => {
    const res = await get("/api/research/v0/skills");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.skills.map((s: { id: string }) => s.id)).toContain("skill:source-provenance-investigation");
  });

  it("GET /skills/:id unknown returns typed SKILL_NOT_FOUND", async () => {
    const res = await get("/api/research/v0/skills/skill:nope");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("SKILL_NOT_FOUND");
  });

  it("POST /capabilities/resolve allows the public book happy path", async () => {
    const res = await post("/api/research/v0/capabilities/resolve", {
      sourceId: "src:test:public-book",
      action: "read_text",
      surface: "api",
      purpose: "provenance_investigation",
      at: "2026-01-01",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.resolution.allowed).toBe(true);
  });

  it("POST resolve denies with typed TECHNICAL_CAPABILITY_MISSING", async () => {
    const res = await post("/api/research/v0/capabilities/resolve", {
      sourceId: "src:test:public-book",
      action: "synthesize_speech",
      surface: "api",
      purpose: "provenance_investigation",
      at: "2026-01-01",
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.resolution.allowed).toBe(false);
    expect(body.resolution.reason).toBe("TECHNICAL_CAPABILITY_MISSING");
  });

  it("POST resolve denies expired entitlement with typed reason", async () => {
    const res = await post("/api/research/v0/capabilities/resolve", {
      sourceId: "src:test:expired-license",
      action: "read_text",
      surface: "api",
      purpose: "provenance_investigation",
      at: "2026-01-01",
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.resolution.reason).toBe("ENTITLEMENT_EXPIRED");
  });

  it("POST resolve denies policy-denied (technical-only) with typed reason", async () => {
    const res = await post("/api/research/v0/capabilities/resolve", {
      sourceId: "src:test:technical-only",
      action: "read_text",
      surface: "api",
      purpose: "provenance_investigation",
      at: "2026-01-01",
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.resolution.reason).toBe("POLICY_DENIED");
  });

  it("POST resolve denies surface/purpose mismatch with typed reasons", async () => {
    const surfaceRes = await post("/api/research/v0/capabilities/resolve", {
      sourceId: "src:test:public-book",
      action: "read_text",
      surface: "batch_export",
      purpose: "provenance_investigation",
      at: "2026-01-01",
    });
    expect((await surfaceRes.json()).resolution.reason).toBe("SURFACE_NOT_ALLOWED");

    const purposeRes = await post("/api/research/v0/capabilities/resolve", {
      sourceId: "src:test:public-book",
      action: "read_text",
      surface: "api",
      purpose: "mass_scraping",
      at: "2026-01-01",
    });
    expect((await purposeRes.json()).resolution.reason).toBe("PURPOSE_NOT_ALLOWED");
  });

  it("POST resolve rejects malformed bodies with 400 before lookup", async () => {
    const res = await post("/api/research/v0/capabilities/resolve", { sourceId: "" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_REQUEST");
  });

  it("unknown sub-paths get a typed ROUTE_NOT_FOUND, distinct from SOURCE_NOT_FOUND", async () => {
    const res = await get("/api/research/v0/evidence");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("ROUTE_NOT_FOUND");
  });

  it("prefix does not collide with existing s32/search routes", async () => {
    // The router only owns /api/research/v0/*; an s32-shaped path under this
    // app instance must not be intercepted by the research router.
    const res = await get("/api/research/v0/private/s32/projects");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("ROUTE_NOT_FOUND");
  });
});
