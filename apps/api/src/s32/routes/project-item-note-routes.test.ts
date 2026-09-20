import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createProjectItemNoteBodyParser, createProjectItemNoteRouter } from "./project-item-note-routes.js";
import { createProjectItemNotesService, ProjectItemInactiveError, ProjectItemNotFoundError, ProjectItemNoteAlreadyExistsError, ProjectItemNoteNotFoundError, ProjectItemNoteRevisionNotFoundError, ProjectItemNoteStoreUnavailableError, StaleNoteRevisionError, type ProjectItemNoteStore } from "../application/project-item-notes.js";
import { InvalidNoteInputError, sha256NoteContent } from "../domain/note.js";
import type { S32Config } from "../config.js";
import { createS32Router } from "../register.js";
import * as noteStoreModule from "../postgres/project-item-note-store.js";
import * as bindingStoreModule from "../postgres/project-binding-store.js";
import * as projectStoreModule from "../postgres/project-store.js";
import * as promotionStoreModule from "../postgres/catalog-promotion-store.js";

const pid = "11111111-1111-4111-8111-111111111111", bid = "22222222-2222-4222-8222-222222222222", rid = "33333333-3333-4333-8333-333333333333";
const root = "/api/private/s32/projects";
const path = `/${pid}/items/${bid}/note`;
const revision = { revisionId: rid, revisionNo: 1, contentFormat: "MARKDOWN" as const, content: "saved", contentSha256: sha256NoteContent("saved"), createdAt: "2026-09-20T00:00:00Z" };
const note = { noteId: rid, projectId: pid, subjectBindingId: bid, subjectId: rid, createdAt: revision.createdAt, updatedAt: revision.createdAt, currentRevision: revision, revisions: [{ revisionId: rid, revisionNo: 1, createdAt: revision.createdAt }] };
const endpoints = [["GET", path, undefined], ["POST", path, { content: "first" }], ["POST", `${path}/revisions`, { baseRevisionId: rid, content: "next" }], ["GET", `${path}/revisions/${rid}`, undefined]] as const;
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(s => new Promise<void>(resolve => { s.closeAllConnections(); s.close(() => resolve()); })));
  vi.restoreAllMocks();
});
function fakeStore() {
  return { get: vi.fn<ProjectItemNoteStore["get"]>().mockResolvedValue(note), create: vi.fn<ProjectItemNoteStore["create"]>().mockResolvedValue(note), appendRevision: vi.fn<ProjectItemNoteStore["appendRevision"]>().mockResolvedValue(note), getRevision: vi.fn<ProjectItemNoteStore["getRevision"]>().mockResolvedValue(revision) };
}
async function start(app: express.Express) {
  const server = await new Promise<Server>(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); }); servers.push(server);
  return async (method = "GET", suffix = path, body?: unknown, token = "test-token", raw?: string) => fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${root}${suffix}`, {
    method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined && raw === undefined ? {} : { body: raw ?? JSON.stringify(body) }),
  });
}
async function setup(overrides: Partial<S32Config> = {}, missingService = false) {
  const store = fakeStore();
  const config = { enabled: true, privateToken: "test-token", databaseUrl: "postgresql://local/test", ...overrides };
  const app = express();
  app.use(`${root}/:projectId/items/:bindingId/note`, createProjectItemNoteBodyParser(config));
  app.use(express.json({ limit: "256kb" }));
  app.use(root, createProjectItemNoteRouter(config, missingService ? null : createProjectItemNotesService(store)));
  return { store, request: await start(app) };
}

describe("M1-D private Note HTTP", () => {
  for (const [label, overrides, token, expected] of [
    ["disabled", { enabled: false }, "", 404], ["unconfigured token", { privateToken: null }, "", 503],
    ["missing token", {}, "", 401], ["wrong token", {}, "wrong", 403], ["unconfigured DB", { databaseUrl: null }, "test-token", 503],
  ] as const) it(`${label} blocks all endpoints before store with no-store`, async () => {
    const s = await setup(overrides);
    for (const [method, suffix, body] of endpoints) {
      const response = await s.request(method, suffix, body, token);
      expect(response.status).toBe(expected); expect(response.headers.get("cache-control")).toBe("no-store");
    }
    Object.values(s.store).forEach(fn => expect(fn).not.toHaveBeenCalled());
  });
  it("missing service fails closed for every endpoint", async () => {
    const s = await setup({}, true);
    for (const [method, suffix, body] of endpoints) expect((await s.request(method, suffix, body)).status).toBe(503);
    Object.values(s.store).forEach(fn => expect(fn).not.toHaveBeenCalled());
  });
  it("returns nullable Note, created Note/revision and historical revision with exact statuses", async () => {
    const s = await setup();
    for (const [i, [method, suffix, body]] of endpoints.entries()) {
      const res = await s.request(method, suffix, body);
      expect(res.status).toBe(i === 1 || i === 2 ? 201 : 200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toEqual(i === 3 ? { revision } : { note });
    }
    s.store.get.mockResolvedValue(null);
    const empty = await s.request(); expect(empty.status).toBe(200); expect(await empty.json()).toEqual({ note: null });
  });
  it.each([
    ["GET", `/forged/items/${bid}/note`, undefined], ["GET", `/${pid}/items/forged/note`, undefined],
    ["GET", `${path}/revisions/forged`, undefined], ["POST", path, null], ["POST", path, []], ["POST", path, {}],
    ["POST", path, { content: " \r\n " }], ["POST", path, { content: "汉".repeat(21846) }],
    ["POST", `${path}/revisions`, { baseRevisionId: "forged", content: "draft" }],
    ["POST", `${path}/revisions`, { baseRevisionId: rid, content: "" }],
  ])("rejects invalid input before store: %s %s", async (method, suffix, body) => {
    const s = await setup(); expect((await s.request(method as string, suffix as string, body)).status).toBe(400);
    Object.values(s.store).forEach(fn => expect(fn).not.toHaveBeenCalled());
  });
  it.each([
    [path, '{"content":"text\\u0000more"}'],
    [`${path}/revisions`, `{"baseRevisionId":"${rid}","content":"text\\u0000more"}`],
  ])("rejects escaped NUL as safe400 before store: POST %s", async (suffix, raw) => {
    const s = await setup();
    const res = await s.request("POST", suffix, undefined, "test-token", raw);
    expect.soft(res.status).toBe(400);
    expect.soft(await res.json()).toMatchObject({ error: { code: "NOTE_INVALID_INPUT" } });
    expect.soft(s.store.create).not.toHaveBeenCalled();
    expect.soft(s.store.appendRevision).not.toHaveBeenCalled();
  });
  it("accepts legal normalized 64KiB content even when escaped JSON exceeds the old 256KiB parser", async () => {
    const s = await setup(); const content = "\u0001".repeat(65536);
    expect(Buffer.byteLength(JSON.stringify({ content }))).toBeGreaterThan(256 * 1024);
    const res = await s.request("POST", path, { content }); expect(res.status).toBe(201);
    expect(s.store.create).toHaveBeenCalledWith({ projectId: pid, bindingId: bid, content, contentSha256: sha256NoteContent(content) });
  });
  it.each(['{"content":"PRIVATE NOTE"', JSON.stringify({ content: "a".repeat(600000) })])("malformed/oversized JSON is safe400 without content leakage", async raw => {
    const s = await setup(); const res = await s.request("POST", path, undefined, "test-token", raw);
    expect(res.status).toBe(400); expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: { code: "NOTE_INVALID_INPUT", message: "笔记输入不正确，正文不能为空且不能超过 65536 UTF-8 字节。" } });
    Object.values(s.store).forEach(fn => expect(fn).not.toHaveBeenCalled());
  });
  it.each([
    [InvalidNoteInputError, 400], [ProjectItemNotFoundError, 404], [ProjectItemNoteNotFoundError, 404], [ProjectItemNoteRevisionNotFoundError, 404],
    [ProjectItemInactiveError, 409], [ProjectItemNoteAlreadyExistsError, 409], [StaleNoteRevisionError, 409], [ProjectItemNoteStoreUnavailableError, 503], [Error, 500],
  ] as const)("maps %s to safe %s across all operations", async (ErrorType, status) => {
    const s = await setup(); const privateError = new ErrorType("SQL postgresql://DBPASSWORD token=S32SECRET PRIVATE NOTE CONTENT");
    Object.values(s.store).forEach(fn => fn.mockRejectedValue(privateError));
    for (const [method, suffix, body] of endpoints) {
      const res = await s.request(method, suffix, body); expect(res.status).toBe(status);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const error = await res.json() as { error: { code?: string; message: string } };
      expect(JSON.stringify(error)).not.toMatch(/SQL|postgresql|DBPASSWORD|S32SECRET|PRIVATE NOTE CONTENT/);
      if (ErrorType === StaleNoteRevisionError) expect(error.error).toEqual({ code: "STALE_NOTE_REVISION", message: "笔记已经发生变化。请重新加载最新版本后，再决定如何处理当前草稿。" });
    }
  });
  it("wires Note and all existing stores to the identical shared Pool and reaches Note routes", async () => {
    const store = fakeStore();
    const noteFactory = vi.spyOn(noteStoreModule, "createPostgresProjectItemNoteStore").mockReturnValue(store);
    const bindingFactory = vi.spyOn(bindingStoreModule, "createPostgresProjectBindingStore");
    const projectFactory = vi.spyOn(projectStoreModule, "createPostgresProjectStore");
    const promotionFactory = vi.spyOn(promotionStoreModule, "createPostgresCatalogPromotionStore");
    const app = express(); app.use(express.json());
    app.use("/api/private/s32", createS32Router({ env: { S32_FEATURES_ENABLED: "true", S32_PRIVATE_API_TOKEN: "test-token", S32_DATABASE_URL: "postgresql://local/test" }, getCatalogDocument: vi.fn() }));
    expect(noteFactory).toHaveBeenCalledOnce();
    const pool = noteFactory.mock.calls[0][0];
    try {
      for (const factory of [bindingFactory, projectFactory, promotionFactory]) { expect(factory).toHaveBeenCalledOnce(); expect(factory.mock.calls[0][0]).toBe(pool); }
      const request = await start(app); expect(await (await request()).json()).toEqual({ note });
    } finally { await pool.end(); }
  });
});
