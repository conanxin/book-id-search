import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createProjectItemRouter } from "./project-item-routes.js";
import { createProjectRouter } from "./project-routes.js";
import { createProjectItemsService, ProjectBindingStoreUnavailableError, EditionNotAvailableError } from "../application/project-items.js";
import { ProjectStoreUnavailableError } from "../application/projects.js";
import { ProjectItemHasNoteError } from "../application/project-item-notes.js";
import { CatalogBookNotFoundError, CatalogReadUnavailableError, IdentityConflictError, CanonicalStoreUnavailableError } from "../application/promote-catalog-book.js";
import { InvalidCatalogBookError } from "../domain/catalog-promotion.js";
import type { S32Config } from "../config.js";
const id = "11111111-1111-4111-8111-111111111111", bid = "55555555-5555-4555-8555-555555555555";
const project = { id, name: "项目", description: null, lifecycleState: "ACTIVE" as const, createdAt: "2026-09-20T00:00:00Z", updatedAt: "2026-09-20T00:00:00Z" };
const item = { bindingId: bid, projectId: id, workId: id, editionId: id, sourceId: id, catalogBookId: "book", title: "标题", publisher: null, publicationDate: null, publicationDatePrecision: "YEAR" as const, isbn: null, addedAt: project.createdAt };
const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(s => new Promise<void>(r => s.close(() => r())))); });
async function setup(overrides: Partial<S32Config> = {}, missingService = false) {
  const projects = { get: vi.fn().mockResolvedValue(project), list: vi.fn().mockResolvedValue([project]), create: vi.fn() };
  const promotionCommand = { execute: vi.fn().mockResolvedValue({ status: "created", ...item }) };
  const bindings = { addEdition: vi.fn().mockResolvedValue({ status: "created", item }), listEditionItems: vi.fn().mockResolvedValue([item]), removeEdition: vi.fn().mockResolvedValue(true) };
  const cfg = { enabled: true, privateToken: "test-token", databaseUrl: "postgresql://local/test", ...overrides };
  const app = express(); app.use(express.json());
  app.use("/projects", createProjectItemRouter(cfg, missingService ? null : createProjectItemsService({ projects, promotionCommand, bindings })));
  app.use("/projects", createProjectRouter(cfg, projects));
  const server = await new Promise<Server>(r => { const s = app.listen(0, "127.0.0.1", () => r(s)); }); servers.push(server);
  async function request(method = "GET", path = `/${id}/items`, body?: unknown, token = "test-token") {
    return fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/projects${path}`, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  return { request, projects, promotionCommand, bindings };
}
describe("M1-C private HTTP", () => {
  for (const [label, cfg, token, status] of [
    ["disabled", { enabled: false }, "", 404], ["unconfigured token", { privateToken: null }, "", 503],
    ["missing token", {}, "", 401], ["wrong token", {}, "wrong", 403], ["unconfigured DB", { databaseUrl: null }, "test-token", 503],
  ] as const) it(`${label} blocks every endpoint without side effects`, async () => {
    const s = await setup(cfg);
    for (const [method, path, body] of [["POST", `/${id}/catalog-books`, { bookId: "book" }], ["GET", `/${id}/items`, undefined], ["DELETE", `/${id}/items/${bid}`, undefined]] as const) {
      const res = await s.request(method, path, body, token); expect(res.status).toBe(status); expect(res.headers.get("cache-control")).toBe("no-store");
    }
    [...Object.values(s.projects), ...Object.values(s.promotionCommand), ...Object.values(s.bindings)].forEach(fn => expect(fn).not.toHaveBeenCalled());
  });
  it("fails closed without service", async () => { expect((await (await setup({}, true)).request()).status).toBe(503); });
  it("returns created/existing from binding status, then empty 204", async () => {
    const s = await setup();
    const res = await s.request("POST", `/${id}/catalog-books`, { bookId: "book" }); expect(res.status).toBe(201); expect(await res.json()).toMatchObject({ bindingStatus: "created", item });
    s.bindings.addEdition.mockResolvedValue({ status: "existing", item });
    expect((await s.request("POST", `/${id}/catalog-books`, { bookId: "book" })).status).toBe(200);
    const removed = await s.request("DELETE", `/${id}/items/${bid}`); expect(removed.status).toBe(204); expect(await removed.text()).toBe("");
  });
  it("keeps items, project detail, and project list independently reachable", async () => {
    const s = await setup(); expect(await (await s.request()).json()).toEqual({ items: [item] });
    expect(await (await s.request("GET", `/${id}`)).json()).toEqual({ project });
    expect(await (await s.request("GET", "")).json()).toEqual({ projects: [project] });
  });
  it("rejects invalid IDs/book before lookup", async () => {
    const s = await setup();
    for (const [method, path, body] of [["POST", `/${id}/catalog-books`, { bookId: " " }], ["GET", "/bad/items", undefined], ["DELETE", `/${id}/items/bad`, undefined]] as const) expect((await s.request(method, path, body)).status).toBe(400);
    expect(s.projects.get).not.toHaveBeenCalled();
  });
  it("maps archived Project add/remove to dedicated PROJECT_READ_ONLY conflict", async () => {
    const s = await setup();
    s.projects.get.mockResolvedValue({ ...project, lifecycleState: "ARCHIVED" });
    for (const [method, path, body] of [
      ["POST", `/${id}/catalog-books`, { bookId: "book" }],
      ["DELETE", `/${id}/items/${bid}`, undefined],
    ] as const) {
      const res = await s.request(method, path, body);
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: { code: "PROJECT_READ_ONLY", message: "项目已归档，只能查看研究资料和笔记。" } });
    }
    expect(s.promotionCommand.execute).not.toHaveBeenCalled();
    expect(s.bindings.removeEdition).not.toHaveBeenCalled();
  });

  it.each([null, { ...project, lifecycleState: "ARCHIVED" }])("rejects missing/inactive project %j", async p => {
    const s = await setup(); s.projects.get.mockResolvedValue(p);
    expect((await s.request("POST", `/${id}/catalog-books`, { bookId: "book" })).status).toBe(p ? 409 : 404);
    expect(s.promotionCommand.execute).not.toHaveBeenCalled();
  });
  it.each([[CatalogBookNotFoundError,404], [InvalidCatalogBookError,422], [IdentityConflictError,409], [CatalogReadUnavailableError,503], [CanonicalStoreUnavailableError,503]] as const)("maps promotion error %s to %s safely", async (ErrorType, status) => {
    const s = await setup(); s.promotionCommand.execute.mockRejectedValue(new ErrorType("postgresql://SECRET"));
    const res = await s.request("POST", `/${id}/catalog-books`, { bookId: "book" }); expect(res.status).toBe(status); expect(await res.text()).not.toContain("SECRET");
  });
  it.each([[ProjectBindingStoreUnavailableError,503], [EditionNotAvailableError,409], [Error,500]] as const)("maps binding error %s to %s safely", async (ErrorType, status) => {
    const s = await setup(); s.bindings.addEdition.mockRejectedValue(new ErrorType("postgresql://SECRET"));
    const res = await s.request("POST", `/${id}/catalog-books`, { bookId: "book" }); expect(res.status).toBe(status); expect(await res.text()).not.toContain("SECRET");
  });
  it("maps project DB failure to 503, never a successful empty list", async () => {
    const s = await setup(); s.projects.get.mockRejectedValue(new ProjectStoreUnavailableError("SECRET"));
    const res = await s.request(); expect(res.status).toBe(503); expect(await res.text()).not.toMatch(/SECRET|items/);
  });
  it("returns 404 for missing/unowned binding", async () => {
    const s = await setup(); s.bindings.removeEdition.mockResolvedValue(false);
    expect((await s.request("DELETE", `/${id}/items/${bid}`)).status).toBe(404);
  });
  it("returns dedicated safe 409 when the material already has a Note", async () => {
    const s = await setup(); s.bindings.removeEdition.mockRejectedValue(new ProjectItemHasNoteError("SECRET"));
    const res = await s.request("DELETE", `/${id}/items/${bid}`);
    expect(res.status).toBe(409); expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: { code: "PROJECT_ITEM_HAS_NOTE", message: "这项资料已有研究笔记，暂不能直接移出项目。" } });
  });
});
