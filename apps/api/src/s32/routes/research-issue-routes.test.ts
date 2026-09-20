import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { S32Config } from "../config.js";
import {
  createResearchIssuesService,
  IdempotencyConflictError,
  ProjectReadOnlyError,
  ResearchIssueIntegrityError,
  ResearchIssueNotFoundError,
  ResearchIssueStoreUnavailableError,
  type ResearchIssueStore,
} from "../application/research-issues.js";
import { createResearchIssueRouter } from "./research-issue-routes.js";
import { createS32Router } from "../register.js";
import * as issueStoreModule from "../postgres/research-issue-store.js";
import * as projectStoreModule from "../postgres/project-store.js";

const projectId = "11111111-1111-4111-8111-111111111111";
const issueId = "22222222-2222-4222-8222-222222222222";
const key = "33333333-3333-4333-8333-333333333333";
const project = { id: projectId, name: "北京古道研究", lifecycleState: "ACTIVE" as const, readOnly: false };
const issue = { id: issueId, projectId, title: "刘祥店迁出时间", question: "问题", lifecycleState: "OPEN" as const, createdAt: "2026-09-20T00:00:00.000Z", updatedAt: "2026-09-20T00:00:00.000Z" };
const summary = { id: issueId, projectId, title: issue.title, questionExcerpt: issue.question, lifecycleState: issue.lifecycleState, createdAt: issue.createdAt, updatedAt: issue.updatedAt };

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); })));
  vi.restoreAllMocks();
});

function fakeStore(): ResearchIssueStore {
  return {
    create: vi.fn().mockResolvedValue({ status: "created", project, issue }),
    list: vi.fn().mockResolvedValue({ project, issues: [summary] }),
    get: vi.fn().mockResolvedValue({ project, issue }),
  };
}

async function setup(overrides: Partial<S32Config> = {}, missingService = false) {
  const store = fakeStore();
  const config: S32Config = { enabled: true, privateToken: "test-token", databaseUrl: "postgresql://local/test", ...overrides };
  const app = express();
  app.use(express.json());
  app.use("/api/private/s32/projects", createResearchIssueRouter(config, missingService ? null : createResearchIssuesService(store)));
  const server = await new Promise<Server>((resolve) => { const listening = app.listen(0, "127.0.0.1", () => resolve(listening)); });
  servers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/private/s32/projects`;
  const request = (method: string, path: string, options: { token?: string; body?: unknown; key?: string } = {}) => fetch(`${base}${path}`, {
    method,
    headers: {
      ...(options.token === "" ? {} : { Authorization: `Bearer ${options.token ?? "test-token"}` }),
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(options.key === undefined ? {} : { "Idempotency-Key": options.key }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  return { store, request };
}

describe("M2-A private research issue HTTP", () => {
  const endpoints = [
    ["GET", `/${projectId}/issues`, {}],
    ["GET", `/${projectId}/issues/${issueId}`, {}],
    ["POST", `/${projectId}/issues`, { body: { title: "标题", question: "问题" }, key }],
  ] as const;

  for (const [label, config, token, status] of [
    ["disabled", { enabled: false }, "", 404],
    ["token unconfigured", { privateToken: null }, "", 503],
    ["missing token", {}, "", 401],
    ["wrong token", {}, "wrong", 403],
    ["database unconfigured", { databaseUrl: null }, "test-token", 503],
  ] as const) {
    it(`${label} blocks every endpoint before storage with no-store`, async () => {
      const s = await setup(config);
      for (const [method, path, request] of endpoints) {
        const response = await s.request(method, path, { ...request, token });
        expect(response.status).toBe(status);
        expect(response.headers.get("cache-control")).toBe("no-store");
      }
      Object.values(s.store).forEach((fn) => expect(fn).not.toHaveBeenCalled());
    });
  }

  it("fails closed when the service is missing", async () => {
    const s = await setup({}, true);
    for (const [method, path, request] of endpoints) expect((await s.request(method, path, request)).status).toBe(503);
  });

  it("returns 201 for create and 200 for a completed replay", async () => {
    const s = await setup();
    let response = await s.request("POST", `/${projectId}/issues`, { key, body: { title: "标题", question: "问题" } });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ project, issue });
    vi.mocked(s.store.create).mockResolvedValue({ status: "replayed", project, issue });
    response = await s.request("POST", `/${projectId}/issues`, { key, body: { title: "标题", question: "问题" } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ project, issue });
  });

  it.each([
    [undefined, { title: "标题", question: "问题" }],
    ["bad", { title: "标题", question: "问题" }],
    [key, { title: "", question: "问题" }],
  ])("rejects invalid create input before store", async (idempotencyKey, body) => {
    const s = await setup();
    expect((await s.request("POST", `/${projectId}/issues`, { key: idempotencyKey, body })).status).toBe(400);
    expect(s.store.create).not.toHaveBeenCalled();
  });

  it("returns direct list/detail bodies including a confirmed empty list and archived read", async () => {
    const s = await setup();
    let response = await s.request("GET", `/${projectId}/issues`);
    expect(await response.json()).toEqual({ project, issues: [summary] });
    response = await s.request("GET", `/${projectId}/issues/${issueId}`);
    expect(await response.json()).toEqual({ project, issue });
    vi.mocked(s.store.list).mockResolvedValue({ project: { ...project, lifecycleState: "ARCHIVED", readOnly: true }, issues: [] });
    response = await s.request("GET", `/${projectId}/issues`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ project: { readOnly: true }, issues: [] });
  });

  it("returns scoped 404 for missing project or issue", async () => {
    const s = await setup();
    vi.mocked(s.store.list).mockResolvedValue(null);
    vi.mocked(s.store.get).mockResolvedValue(null);
    expect((await s.request("GET", `/${projectId}/issues`)).status).toBe(404);
    expect((await s.request("GET", `/${projectId}/issues/${issueId}`)).status).toBe(404);
  });

  it.each([
    [new ProjectReadOnlyError("SECRET"), 409, "PROJECT_READ_ONLY"],
    [new IdempotencyConflictError("SECRET"), 409, "IDEMPOTENCY_CONFLICT"],
    [new ResearchIssueNotFoundError("SECRET"), 404, undefined],
    [new ResearchIssueStoreUnavailableError("SQL postgresql://SECRET"), 503, undefined],
    [new ResearchIssueIntegrityError("SQL SECRET"), 500, undefined],
    [new Error("SQL SECRET"), 500, undefined],
  ])("maps create failure safely", async (error, status, code) => {
    const s = await setup();
    vi.mocked(s.store.create).mockRejectedValue(error);
    const response = await s.request("POST", `/${projectId}/issues`, { key, body: { title: "标题", question: "问题" } });
    expect(response.status).toBe(status);
    const body = await response.json() as { error: { code?: string } };
    expect(body.error.code).toBe(code);
    expect(JSON.stringify(body)).not.toMatch(/SECRET|postgresql|SQL/);
  });

  it("maps list/detail storage and integrity failures without private details", async () => {
    const s = await setup();
    vi.mocked(s.store.list).mockRejectedValue(new ResearchIssueStoreUnavailableError("postgresql://SECRET"));
    vi.mocked(s.store.get).mockRejectedValue(new ResearchIssueIntegrityError("SQL SECRET"));
    const list = await s.request("GET", `/${projectId}/issues`);
    const detail = await s.request("GET", `/${projectId}/issues/${issueId}`);
    expect(list.status).toBe(503);
    expect(detail.status).toBe(500);
    expect(`${await list.text()}${await detail.text()}`).not.toMatch(/SECRET|postgresql|SQL/);
  });

  it("registers the research issue store on the shared S32 Pool before generic project routes", () => {
    const store = fakeStore();
    const issueFactory = vi.spyOn(issueStoreModule, "createPostgresResearchIssueStore").mockReturnValue(store);
    const projectFactory = vi.spyOn(projectStoreModule, "createPostgresProjectStore");
    createS32Router({ env: { S32_FEATURES_ENABLED: "true", S32_PRIVATE_API_TOKEN: "test-token", S32_DATABASE_URL: "postgresql://local/test" }, getCatalogDocument: vi.fn() });
    expect(issueFactory).toHaveBeenCalledOnce();
    expect(projectFactory).toHaveBeenCalledOnce();
    expect(issueFactory.mock.calls[0][0]).toBe(projectFactory.mock.calls[0][0]);
    void issueFactory.mock.calls[0][0].end();
  });
});
