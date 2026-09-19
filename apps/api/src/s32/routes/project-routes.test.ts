import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createProjectsService, ProjectStoreUnavailableError } from "../application/projects.js";
import { createProjectRouter } from "./project-routes.js";
import type { S32Config } from "../config.js";

const id = "01234567-1234-4123-8123-123456789abc";
const project = { id, name: "项目", description: null, lifecycleState: "ACTIVE" as const, createdAt: "2026-09-19T00:00:00.000Z", updatedAt: "2026-09-19T00:00:00.000Z" };
const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve, reject) => s.close((e) => e ? reject(e) : resolve())))); });
async function setup(overrides: Partial<S32Config> = {}) {
  const store = { create: vi.fn().mockResolvedValue(project), list: vi.fn().mockResolvedValue([project]), get: vi.fn().mockResolvedValue(project) };
  const cfg = { enabled: true, privateToken: "test-only", databaseUrl: "postgresql://local/test", ...overrides };
  const app = express(); app.use(express.json());
  app.use("/api/private/s32/projects", createProjectRouter(cfg, createProjectsService(store)));
  const server = await new Promise<Server>((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  servers.push(server);
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/private/s32/projects`;
  async function request(method = "GET", path = "", body?: unknown, token = "test-only") {
    return fetch(url + path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  return { store, request };
}
describe("private project HTTP API", () => {
  for (const [label, config, token, status] of [
    ["disabled", { enabled: false }, "", 404],
    ["token not configured", { privateToken: null }, "", 503],
    ["missing token", {}, "", 401], ["wrong token", {}, "wrong", 403],
    ["missing DB", { databaseUrl: null }, "test-only", 503],
  ] as const) {
    it(`${label}: protects all three endpoints before store access`, async () => {
      const { store, request } = await setup(config);
      for (const [method, path, body] of [["GET", "", undefined], ["GET", `/${id}`, undefined], ["POST", "", { name: "项目" }]] as const) {
        const res = await request(method, path, body, token);
        expect(res.status).toBe(status); expect(res.headers.get("cache-control")).toBe("no-store");
      }
      Object.values(store).forEach((spy) => expect(spy).not.toHaveBeenCalled());
    });
  }
  it("creates with generated UUID and only whitelisted input, lists and reads", async () => {
    const { store, request } = await setup();
    const created = await request("POST", "", { name: " 项目 ", description: null, id: "forged", metadata: { x: 1 } });
    expect(created.status).toBe(201); expect(await created.json()).toEqual({ project });
    expect(store.create).toHaveBeenCalledWith(expect.stringMatching(/^[\da-f-]{36}$/), { name: "项目", description: null });
    expect(store.create.mock.calls[0][0]).not.toBe("forged");
    expect(await (await request()).json()).toEqual({ projects: [project] });
    expect(await (await request("GET", `/${id}`)).json()).toEqual({ project });
  });
  it("returns 400 for invalid input/id without querying the store", async () => {
    const { store, request } = await setup();
    expect((await request("POST", "", { name: " " })).status).toBe(400);
    expect((await request("GET", "/not-a-uuid")).status).toBe(400);
    expect(store.create).not.toHaveBeenCalled(); expect(store.get).not.toHaveBeenCalled();
  });
  it("distinguishes not found and an actual empty list", async () => {
    const { store, request } = await setup();
    store.get.mockResolvedValue(null); store.list.mockResolvedValue([]);
    expect((await request("GET", `/${id}`)).status).toBe(404);
    const res = await request(); expect(res.status).toBe(200); expect(await res.json()).toEqual({ projects: [] });
  });
  it.each(["create", "list", "get"] as const)("%s fails closed on storage unavailability and hides unexpected errors", async (operation) => {
    const { store, request } = await setup();
    const invoke = () => request(operation === "create" ? "POST" : "GET", operation === "get" ? `/${id}` : "", operation === "create" ? { name: "项目" } : undefined);
    store[operation].mockRejectedValue(new ProjectStoreUnavailableError("项目数据库暂不可用。"));
    let res = await invoke(); expect(res.status).toBe(503); expect(await res.json()).not.toHaveProperty("projects");
    store[operation].mockRejectedValue(new Error("postgresql://secret@host/db SQL SECRET"));
    res = await invoke(); expect(res.status).toBe(500); expect(await res.text()).not.toMatch(/secret|SQL/i);
  });
});
