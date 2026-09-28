import express from "express";
import { existsSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { S32Config } from "../config.js";
import { InvalidProjectInputError } from "../domain/project.js";
import { InvalidIdempotencyKeyError, InvalidResearchIssueInputError } from "../domain/research-issue.js";
import {
  InvalidIssueResolutionCursorError,
  InvalidIssueResolutionInputError,
  type IssueResolutionHistoryResponse,
  type IssueResolutionDetailResponse,
} from "../domain/issue-resolution.js";
import {
  createIssueResolutionsService,
  IssueResolutionScopeNotFoundError,
  IssueResolutionNotFoundError,
  IssueResolutionInvalidPreferredClaimError,
  IssueResolutionEvidenceNotAvailableError,
  IssueResolutionStaleError,
  IssueResolutionIdempotencyConflictError,
  ProjectReadOnlyForResolutionError,
  ResearchIssueReadOnlyForResolutionError,
  IssueResolutionIntegrityError,
  IssueResolutionStoreUnavailableError,
  type IssueResolutionsService,
  type IssueResolutionEvidenceBasesResponse,
} from "../application/issue-resolutions.js";

// Missing implementation is an assertion RED, not a failed test-file import.
let createBodyParser: typeof import("./issue-resolution-routes.js").createIssueResolutionBodyParser | undefined;
let createRouter: typeof import("./issue-resolution-routes.js").createIssueResolutionRouter | undefined;
beforeAll(async () => {
  if (existsSync(new URL("./issue-resolution-routes.ts", import.meta.url))) {
    const modulePath = "./issue-resolution-routes.js";
    const module = await import(modulePath);
    createRouter = module.createIssueResolutionRouter;
    createBodyParser = module.createIssueResolutionBodyParser;
  }
});

const P = "aaaaaaaa-1111-4111-8111-111111111111";
const I = "bbbbbbbb-2222-4222-8222-222222222222";
const R = "cccccccc-3333-4333-8333-333333333333";
const NEWER = "dddddddd-4444-4444-8444-444444444444";
const KEY = "eeeeeeee-5555-4555-8555-555555555555";
const config: S32Config = { enabled: true, databaseUrl: "postgresql://local/test", privateToken: "test-token" };
const prefix = `/api/private/s32/projects/${P.toUpperCase()}/issues/${I.toUpperCase()}`;
const issue = { id: I, lifecycleState: "OPEN" as const, currentResolutionId: R, updatedAt: "2026-09-28T00:00:00.000Z" };
const current = {
  id: R, issueId: I, resolutionType: "INSUFFICIENT_EVIDENCE" as const,
  preferredClaimId: null, rationaleExcerpt: null, createdAt: "2026-09-27T00:00:00.000Z",
  isCurrent: true, evidenceBasisAvailable: false as const, evidenceManifest: null,
};
const history: IssueResolutionHistoryResponse = {
  issue, currentResolution: current,
  resolutions: [{ ...current, id: NEWER, isCurrent: false, createdAt: issue.updatedAt }],
  nextCursor: "opaque-next",
};
const detail: IssueResolutionDetailResponse = {
  issue, resolution: {
    id: R, issueId: I, resolutionType: "INSUFFICIENT_EVIDENCE", preferredClaimId: null,
    rationale: null, createdAt: current.createdAt, isCurrent: true,
  },
  evidenceBasisAvailable: false, evidenceManifest: null,
};
const bases: IssueResolutionEvidenceBasesResponse = {
  evidenceBases: [{ assessmentId: R, claimId: I, claimStatementExcerpt: "可能答案 🧭",
    stance: "SUPPORTS", confidenceLevel: null, manifestId: NEWER, manifestSha256: "a".repeat(64),
    itemCount: 1, assessmentCreatedAt: issue.updatedAt }], nextCursor: "opaque-basis-next",
};
const body = {
  expectedCurrentResolutionId: null, resolutionType: "INSUFFICIENT_EVIDENCE",
  preferredClaimId: null, rationale: "  理由\r\n待检验  ", evidenceManifestId: null,
};
const endpoints = [
  { name: "create", method: "POST", path: `${prefix}/resolutions` },
  { name: "list", method: "GET", path: `${prefix}/resolutions` },
  { name: "get", method: "GET", path: `${prefix}/resolutions/${R.toUpperCase()}` },
  { name: "listEvidenceBases", method: "GET", path: `${prefix}/resolution-evidence-bases` },
] as const;
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  })));
});
function service(): IssueResolutionsService {
  return {
    create: vi.fn(async () => ({ status: "created" as const, resolutionId: R })),
    list: vi.fn(async () => history), get: vi.fn(async () => detail),
    listEvidenceBases: vi.fn(async () => bases),
  };
}
async function start(s: IssueResolutionsService | null, options: S32Config = config) {
  expect(createRouter, "Issue Resolution router contract must exist").toBeTypeOf("function");
  const app = express();
  app.use(express.json());
  app.use("/api/private/s32/projects", createRouter!(options, s));
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>(resolve => server.once("listening", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
function request(base: string, endpoint: { method: "POST" | "GET"; path: string }, headers: Record<string, string> = { Authorization: "Bearer test-token" }, suffix = "") {
  return fetch(`${base}${endpoint.path}${suffix}`, {
    method: endpoint.method,
    headers: { "Content-Type": "application/json", "Idempotency-Key": KEY, ...headers },
    ...(endpoint.method === "POST" ? { body: JSON.stringify(body) } : {}),
  });
}
function expectNoCalls(s: IssueResolutionsService) {
  for (const method of Object.values(s)) expect(method).not.toHaveBeenCalled();
}

for (const endpoint of endpoints) {
  describe(`${endpoint.name} private middleware`, () => {
    const gates = [
      { name: "feature disabled", options: { ...config, enabled: false }, token: "test-token", status: 404 },
      { name: "token unconfigured", options: { ...config, privateToken: null }, token: "test-token", status: 503 },
      { name: "missing token", options: config, token: null, status: 401 },
      { name: "wrong token", options: config, token: "wrong", status: 403 },
      { name: "database unconfigured", options: { ...config, databaseUrl: null }, token: "test-token", status: 503 },
      { name: "service missing", options: config, token: "test-token", status: 503 },
    ];
    it.each(gates)("$name rejects before service access", async gate => {
      const s = service();
      const base = await start(gate.name === "service missing" ? null : s, gate.options);
      const res = await request(base, endpoint, gate.token ? { Authorization: `Bearer ${gate.token}` } : {});
      expect(res.status).toBe(gate.status);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const payload = await res.json();
      if (["database unconfigured", "service missing"].includes(gate.name)) {
        expect(payload.error.code).toBe("ISSUE_RESOLUTION_STORE_UNAVAILABLE");
        expect(payload.error.message).toMatch(/[\u3400-\u9fff]/u);
      }
      expectNoCalls(s);
    });
    it("accepts the existing x-private-token credential path", async () => {
      const s = service();
      const res = await request(await start(s), endpoint, { "x-private-token": "test-token" });
      expect(res.status).toBe(endpoint.method === "POST" ? 201 : 200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      await res.json();
      expect(s[endpoint.name]).toHaveBeenCalledOnce();
    });
  });
}

describe("exact delegation and response DTOs", () => {
  it.each(["created", "replayed"] as const)("POST %s retains canonical identity", async status => {
    const s = service();
    const value = { status, resolutionId: R };
    vi.mocked(s.create).mockResolvedValue(value);
    const res = await request(await start(s), endpoints[0]);
    expect(res.status).toBe(status === "created" ? 201 : 200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual(value);
    expect(s.create).toHaveBeenCalledExactlyOnceWith(P.toUpperCase(), I.toUpperCase(), KEY, body);
    expect(s.list).not.toHaveBeenCalled();
    expect(s.get).not.toHaveBeenCalled();
    expect(s.listEvidenceBases).not.toHaveBeenCalled();
  });
  it("history forwards raw query and does not infer current from newest history row", async () => {
    const s = service();
    const res = await request(await start(s), endpoints[1], undefined, "?limit=020&cursor=opaque&extra=unchanged");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual(history);
    expect(s.list).toHaveBeenCalledExactlyOnceWith(P.toUpperCase(), I.toUpperCase(), { limit: "020", cursor: "opaque", extra: "unchanged" });
  });
  it("history preserves null current with nonempty history", async () => {
    const s = service();
    const value = { ...history, issue: { ...issue, currentResolutionId: null }, currentResolution: null };
    vi.mocked(s.list).mockResolvedValue(value);
    const res = await request(await start(s), endpoints[1]);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual(value);
  });
  it("detail delegates exact scoped IDs and preserves hidden evidence and NULL rationale", async () => {
    const s = service();
    const res = await request(await start(s), endpoints[2]);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual(detail);
    expect(s.get).toHaveBeenCalledExactlyOnceWith(P.toUpperCase(), I.toUpperCase(), R.toUpperCase());
  });
  it("evidence bases forwards raw query and exact compact result", async () => {
    const s = service();
    const res = await request(await start(s), endpoints[3], undefined, "?limit=2&cursor=opaque-basis");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual(bases);
    expect(s.listEvidenceBases).toHaveBeenCalledExactlyOnceWith(P.toUpperCase(), I.toUpperCase(), { limit: "2", cursor: "opaque-basis" });
  });
  it.each([undefined, "malformed-key"])("missing/malformed key %s is rejected by the real application before store access", async key => {
    const command = { create: vi.fn() };
    const read = { list: vi.fn(), get: vi.fn(), listEvidenceBases: vi.fn() };
    const base = await start(createIssueResolutionsService(command, read));
    const res = await fetch(`${base}${endpoints[0].path}`, {
      method: "POST", headers: { Authorization: "Bearer test-token", "Content-Type": "application/json", ...(key ? { "Idempotency-Key": key } : {}) },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect((await res.json()).error.code).toBe("ISSUE_RESOLUTION_INVALID");
    expect(command.create).not.toHaveBeenCalled();
  });
  it("invalid body is rejected by the real application before store access", async () => {
    const command = { create: vi.fn() };
    const read = { list: vi.fn(), get: vi.fn(), listEvidenceBases: vi.fn() };
    const base = await start(createIssueResolutionsService(command, read));
    const res = await fetch(`${base}${endpoints[0].path}`, {
      method: "POST", headers: { Authorization: "Bearer test-token", "Content-Type": "application/json", "Idempotency-Key": KEY },
      body: JSON.stringify({ ...body, rationale: "" }),
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect((await res.json()).error.code).toBe("ISSUE_RESOLUTION_INVALID");
    expect(command.create).not.toHaveBeenCalled();
  });
});

const errorCases = [
  { ErrorType: InvalidProjectInputError, status: 400, code: "ISSUE_RESOLUTION_INVALID" },
  { ErrorType: InvalidResearchIssueInputError, status: 400, code: "ISSUE_RESOLUTION_INVALID" },
  { ErrorType: InvalidIdempotencyKeyError, status: 400, code: "ISSUE_RESOLUTION_INVALID" },
  { ErrorType: InvalidIssueResolutionInputError, status: 400, code: "ISSUE_RESOLUTION_INVALID" },
  { ErrorType: InvalidIssueResolutionCursorError, status: 400, code: "ISSUE_RESOLUTION_INVALID" },
  { ErrorType: IssueResolutionScopeNotFoundError, status: 404, code: "PROJECT_OR_ISSUE_NOT_FOUND" },
  { ErrorType: IssueResolutionNotFoundError, status: 404, code: "ISSUE_RESOLUTION_NOT_FOUND" },
  { ErrorType: IssueResolutionInvalidPreferredClaimError, status: 404, code: "PREFERRED_CLAIM_NOT_AVAILABLE" },
  { ErrorType: IssueResolutionEvidenceNotAvailableError, status: 404, code: "EVIDENCE_MANIFEST_NOT_AVAILABLE" },
  { ErrorType: ProjectReadOnlyForResolutionError, status: 409, code: "PROJECT_READ_ONLY" },
  { ErrorType: ResearchIssueReadOnlyForResolutionError, status: 409, code: "RESEARCH_ISSUE_READ_ONLY" },
  { ErrorType: IssueResolutionStaleError, status: 409, code: "ISSUE_RESOLUTION_STALE" },
  { ErrorType: IssueResolutionIdempotencyConflictError, status: 409, code: "IDEMPOTENCY_CONFLICT" },
  { ErrorType: IssueResolutionStoreUnavailableError, status: 503, code: "ISSUE_RESOLUTION_STORE_UNAVAILABLE" },
  { ErrorType: IssueResolutionIntegrityError, status: 500, code: undefined },
  { ErrorType: Error, status: 500, code: undefined },
];
for (const endpoint of endpoints) {
  describe(`${endpoint.name} safe error mapping`, () => {
    it.each(errorCases)("$ErrorType.name -> $status $code without internal detail", async ({ ErrorType, status, code }) => {
      const s = service();
      vi.mocked(s[endpoint.name]).mockRejectedValue(new ErrorType("SECRET postgresql://SECRET SQL DETAIL cross-issue-id private-host 08006"));
      const res = await request(await start(s), endpoint);
      expect(res.status).toBe(status);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const raw = await res.text();
      expect(raw).not.toMatch(/SECRET|postgresql:\/\/|SQL DETAIL|cross-issue-id|private-host|08006|stack/i);
      const value = JSON.parse(raw);
      expect(value).toEqual({ error: { ...(code ? { code } : {}), message: expect.any(String) } });
      expect(value.error.message).toMatch(/[\u3400-\u9fff]/u);
      expect(s[endpoint.name]).toHaveBeenCalledOnce();
    });
  });
}

describe("real registration with no database", () => {
  async function registered() {
    const { createS32Router } = await import("../register.js");
    const app = express();
    app.use(express.json());
    app.use("/api/private/s32", createS32Router({
      env: { S32_FEATURES_ENABLED: "true", S32_PRIVATE_API_TOKEN: "test-token" },
      getCatalogDocument: vi.fn(),
    }));
    const server = app.listen(0, "127.0.0.1");
    servers.push(server);
    await new Promise<void>(resolve => server.once("listening", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  it.each(endpoints)("$name retains its unavailable code through the complete router stack", async endpoint => {
    const res = await request(await registered(), endpoint);
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect((await res.json()).error.code).toBe("ISSUE_RESOLUTION_STORE_UNAVAILABLE");
  });
  it("does not intercept a sibling project endpoint's existing configuration failure", async () => {
    const res = await fetch(`${await registered()}/api/private/s32/projects/${P}/overview`, {
      headers: { Authorization: "Bearer test-token" },
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: { message: "项目研究概览数据库尚未配置。" } });
  });
});

for (const endpoint of endpoints) {
  describe(`${endpoint.name} malformed URL path protection`, () => {
    const paths = [
      { part: "project", path: endpoint.path.replace(P.toUpperCase(), "%ZZSECRET") },
      { part: "issue", path: endpoint.path.replace(I.toUpperCase(), "%ZZSECRET") },
      ...(endpoint.name === "get" ? [{ part: "resolution", path: endpoint.path.replace(R.toUpperCase(), "%ZZSECRET") }] : []),
    ];
    for (const path of paths) {
      it.each([
        { name: "disabled", enabled: false, token: "test-token", status: 404 },
        { name: "missing credential", enabled: true, token: null, status: 401 },
        { name: "wrong credential", enabled: true, token: "wrong", status: 403 },
        { name: "authorized invalid path", enabled: true, token: "test-token", status: 400 },
      ])(`${path.part}: $name keeps auth precedence and safe JSON`, async gate => {
        const s = service();
        const base = await start(s, { ...config, enabled: gate.enabled });
        const res = await request(base, { ...endpoint, path: path.path }, gate.token ? { Authorization: `Bearer ${gate.token}` } : {});
        expect(res.status).toBe(gate.status);
        expect(res.headers.get("cache-control")).toBe("no-store");
        expect(res.headers.get("content-type")).toContain("application/json");
        const raw = await res.text();
        expect(raw).not.toMatch(/SECRET|URIError|stack|node_modules|<html|Failed to decode/i);
        if (gate.status === 400) expect(JSON.parse(raw).error.code).toBe("ISSUE_RESOLUTION_INVALID");
        expectNoCalls(s);
      });
    }
  });
}

describe("Resolution POST body parsing before the global JSON parser", () => {
  async function transport(s: IssueResolutionsService, options: S32Config = config) {
    expect(createBodyParser, "scoped pre-global body parser contract must exist").toBeTypeOf("function");
    const app = express();
    app.use("/api/private/s32/projects", createBodyParser!(options));
    app.use(express.json({ limit: "256kb" }));
    app.post("/api/private/s32/projects/project-id/unrelated", (req, res) => { res.json(req.body); });
    app.use("/api/private/s32/projects", createRouter!(options, s));
    const server = app.listen(0, "127.0.0.1");
    servers.push(server);
    await new Promise<void>(resolve => server.once("listening", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  const invalidBodies = [
    { name: "malformed", raw: '{"rationale":"SECRET",' },
    { name: "oversized", raw: JSON.stringify({ rationale: "SECRET".repeat(50000) }) },
  ];
  for (const invalid of invalidBodies) {
    it.each([
      { name: "disabled", options: { ...config, enabled: false }, token: "test-token", status: 404 },
      { name: "token unconfigured", options: { ...config, privateToken: null }, token: "test-token", status: 503 },
      { name: "missing token", options: config, token: null, status: 401 },
      { name: "wrong token", options: config, token: "wrong", status: 403 },
      { name: "authorized invalid JSON", options: config, token: "test-token", status: 400 },
    ])(`${invalid.name}: $name is safe JSON with no-store before any service call`, async gate => {
      const s = service();
      const base = await transport(s, gate.options);
      const res = await fetch(`${base}${endpoints[0].path}`, {
        method: "POST", headers: { "Content-Type": "application/json", ...(gate.token ? { Authorization: `Bearer ${gate.token}` } : {}) },
        body: invalid.raw,
      });
      expect(res.status).toBe(gate.status);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("content-type")).toContain("application/json");
      const raw = await res.text();
      expect(raw).not.toMatch(/SECRET|SyntaxError|PayloadTooLargeError|stack|node_modules|<html/i);
      if (gate.status === 400) expect(JSON.parse(raw).error.code).toBe("ISSUE_RESOLUTION_INVALID");
      expectNoCalls(s);
    });
  }
  it("valid JSON is parsed once and delegated unchanged through the global parser", async () => {
    const s = service();
    const res = await request(await transport(s), endpoints[0]);
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ status: "created", resolutionId: R });
    expect(s.create).toHaveBeenCalledExactlyOnceWith(P.toUpperCase(), I.toUpperCase(), KEY, body);
  });
  it("preserves existing x-private-token authentication before parsing", async () => {
    const s = service();
    const res = await request(await transport(s), endpoints[0], { "x-private-token": "test-token" });
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    await res.json();
    expect(s.create).toHaveBeenCalledExactlyOnceWith(P.toUpperCase(), I.toUpperCase(), KEY, body);
  });
  it.each([
    { path: endpoints[0].path.toUpperCase() + "/?test=1" },
    { path: endpoints[0].path.replace(P.toUpperCase(), "%ZZSECRET") },
  ])("authenticates raw paths $path before path decoding and body parsing", async ({ path }) => {
    const s = service();
    const res = await fetch(`${await transport(s)}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"SECRET":' });
    expect(res.status).toBe(401);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const raw = await res.text();
    expect(raw).not.toMatch(/SECRET|URIError|SyntaxError|<html/i);
    expectNoCalls(s);
  });
  it("does not parse or authenticate sibling requests", async () => {
    const s = service();
    const base = await transport(s, { ...config, enabled: false });
    const res = await fetch(`${base}/api/private/s32/projects/project-id/unrelated`, { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"sibling":true}' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sibling: true });
    expect(res.headers.get("cache-control")).toBeNull();
    expectNoCalls(s);
  });
  it("mounts the scoped parser in the actual API entrypoint before global express.json", () => {
    const source = readFileSync(new URL("../../index.ts", import.meta.url), "utf8");
    expect(source).toContain('import { createIssueResolutionBodyParser } from "./s32/routes/issue-resolution-routes.js"');
    const scoped = source.indexOf('app.use("/api/private/s32/projects", createIssueResolutionBodyParser(readS32Config(process.env)))');
    const global = source.indexOf('app.use(express.json(');
    expect(scoped).toBeGreaterThanOrEqual(0);
    expect(global).toBeGreaterThan(scoped);
  });
});
