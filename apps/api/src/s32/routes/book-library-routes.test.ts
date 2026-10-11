import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBookLibraryBodyParser, createBookLibraryRouter } from "./book-library-routes.js";
import { createS32Router } from "../register.js";
import { emptyBookWorkspace, LibraryError } from "../domain/book-library.js";
import type { BookLibraryService } from "../application/book-library.js";
import type { S32Config } from "../config.js";
import type { S32RequestAuthorizer } from "./private-auth.js";

const root = "/api/private/s32/library";
const id = "11111111-1111-4111-8111-111111111111";
const config: S32Config = { enabled: true, databaseUrl: "postgresql://local/test", privateToken: "legacy-token" };
const owner: S32RequestAuthorizer = req => req.get("x-test-owner") === "yes"
  ? { ok: true } : { ok: false, status: 401, message: "请使用 Google 登录。" };
const workspace = emptyBookWorkspace("book");
const page = { items: [], total: 0, page: 1, limit: 24 };
const revision = { revisionId: id, revisionNo: 1, title: "title", content: "saved", createdAt: "2026-10-11T00:00:00.000Z" };
const endpoints = [
  ["GET", "", undefined], ["GET", "/books/book", undefined], ["PUT", "/books/book", {}],
  ["POST", "/books/book/notes", { title: "title", content: "saved" }],
  ["PUT", `/books/book/notes/${id}`, { title: "title", content: "saved", baseRevisionId: id }],
  ["DELETE", `/books/book/notes/${id}`, undefined],
  ["GET", `/books/book/notes/${id}/revisions/${id}`, undefined],
  ["POST", "/books/book/resources", { label: "PDF", url: "https://example.test/a.pdf" }],
  ["PUT", `/books/book/resources/${id}`, { label: "PDF", url: "https://example.test/b.pdf" }],
  ["DELETE", `/books/book/resources/${id}`, undefined],
] as const;
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); })));
  vi.restoreAllMocks();
});

function fakeService() {
  return {
    get: vi.fn().mockResolvedValue(workspace), list: vi.fn().mockResolvedValue(page),
    save: vi.fn().mockResolvedValue(workspace), createNote: vi.fn().mockResolvedValue(workspace),
    updateNote: vi.fn().mockResolvedValue(workspace), deleteNote: vi.fn().mockResolvedValue(workspace),
    getRevision: vi.fn().mockResolvedValue(revision), createResource: vi.fn().mockResolvedValue(workspace),
    updateResource: vi.fn().mockResolvedValue(workspace), deleteResource: vi.fn().mockResolvedValue(workspace),
  } satisfies BookLibraryService;
}

async function start(app: express.Express) {
  const server = await new Promise<Server>(resolve => { const candidate = app.listen(0, "127.0.0.1", () => resolve(candidate)); });
  servers.push(server);
  return async (method = "GET", suffix = "", body?: unknown, authenticated = true, raw?: string) => fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${root}${suffix}`, {
    method, headers: { "Content-Type": "application/json", Authorization: "Bearer legacy-token", ...(authenticated ? { "x-test-owner": "yes" } : {}) },
    ...(body === undefined && raw === undefined ? {} : { body: raw ?? JSON.stringify(body) }),
  });
}

async function setup(options: { config?: S32Config; authorizer?: S32RequestAuthorizer | null; missingService?: boolean } = {}) {
  const service = fakeService(), cfg = options.config ?? config, auth = options.authorizer === null ? undefined : options.authorizer ?? owner;
  const app = express();
  app.use(root, createBookLibraryBodyParser(cfg, auth));
  app.use(express.json({ limit: "256kb" }));
  app.use(root, createBookLibraryRouter(cfg, options.missingService ? null : service, auth));
  return { service, request: await start(app) };
}

describe("Book library Google-only HTTP boundary", () => {
  it.each([
    ["missing Google authorizer", { authorizer: null }, true, 503],
    ["legacy token alone", {}, false, 401],
    ["disabled", { config: { ...config, enabled: false } }, true, 404],
    ["missing database", { config: { ...config, databaseUrl: null } }, true, 503],
    ["missing service", { missingService: true }, true, 503],
  ] as const)("%s blocks every endpoint before service access", async (_label, options, authenticated, expected) => {
    const s = await setup(options);
    for (const [method, suffix, body] of endpoints) {
      const response = await s.request(method, suffix, body, authenticated);
      expect(response.status).toBe(expected);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    for (const fn of Object.values(s.service)) expect(fn).not.toHaveBeenCalled();
  });
  it("returns the fixed workspace/list/revision envelopes and creation statuses", async () => {
    const s = await setup();
    for (const [method, suffix, body] of endpoints) {
      const response = await s.request(method, suffix, body);
      expect(response.status).toBe(method === "POST" ? 201 : 200);
      expect(await response.json()).toEqual(suffix === "" ? page : suffix.includes("/revisions/") ? { item: revision } : { item: workspace });
    }
    expect(s.service.updateNote).toHaveBeenCalledWith("book", id, { title: "title", content: "saved", baseRevisionId: id });
    expect(s.service.getRevision).toHaveBeenCalledWith("book", id, id);
    expect(s.service.deleteResource).toHaveBeenCalledWith("book", id);
  });
  it("accepts legal escaped 50,000-character input before the global 256 KiB parser", async () => {
    const s = await setup(), body = { introduction: "\u0001".repeat(50_000), baseVersion: 0 };
    expect(Buffer.byteLength(JSON.stringify(body))).toBeGreaterThan(256 * 1024);
    const response = await s.request("PUT", "/books/book", body);
    expect(response.status).toBe(200);
    expect(s.service.save).toHaveBeenCalledWith("book", body);
  });
  it("authenticates before malformed JSON parsing and returns safe errors for authorized bad bodies", async () => {
    const s = await setup();
    expect((await s.request("PUT", "/books/book", undefined, false, '{"private":"truncated')).status).toBe(401);
    for (const raw of ['{"private":"truncated', JSON.stringify({ content: "x".repeat(600_000) })]) {
      const response = await s.request("PUT", "/books/book", undefined, true, raw);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "LIBRARY_INVALID_JSON" } });
    }
    expect(s.service.save).not.toHaveBeenCalled();
  });
  it.each([
    ["LIBRARY_STALE_VERSION", 409], ["LIBRARY_STALE_NOTE_REVISION", 409],
    ["LIBRARY_NOTE_NOT_FOUND", 404], ["LIBRARY_RESOURCE_NOT_FOUND", 404],
    ["LIBRARY_UNAVAILABLE", 503], ["LIBRARY_INVALID_INPUT", 400],
  ])("maps %s to %s without exposing internal errors", async (code, status) => {
    const s = await setup();
    s.service.save.mockRejectedValue(new LibraryError(code));
    const response = await s.request("PUT", "/books/book", {});
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error: { code } });
  });
  it("never returns a SQL/connection error from the service", async () => {
    const s = await setup();
    s.service.get.mockRejectedValue(new Error("SELECT * postgresql://password secret private note"));
    const response = await s.request("GET", "/books/book");
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: { code: "LIBRARY_REQUEST_FAILED", message: "书籍内容请求失败，请稍后再试。" } });
  });
  it("register rejects legacy-only wiring instead of inheriting the research authorizer", async () => {
    const app = express();
    app.use("/api/private/s32", createS32Router({ env: {}, config: { ...config, databaseUrl: null },
      getCatalogDocument: vi.fn(), requestAuthorizer: () => ({ ok: true }) }));
    expect((await (await start(app))()).status).toBe(503);
  });
});
