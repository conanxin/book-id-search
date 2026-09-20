import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { S32Config } from "../config.js";
import {
  createProjectOverviewService,
  ProjectOverviewIntegrityError,
  ProjectOverviewStoreUnavailableError,
} from "../application/project-overview.js";
import type { ProjectOverview } from "../domain/rediscover.js";
import { createProjectOverviewRouter } from "./project-overview-route.js";

const projectId = "11111111-1111-4111-8111-111111111111";
const overview: ProjectOverview = {
  project: {
    id: projectId,
    name: "北京古道研究",
    description: null,
    lifecycleState: "ACTIVE",
    readOnly: false,
    createdAt: "2026-09-19T00:00:00.000Z",
    updatedAt: "2026-09-20T00:00:00.000Z",
  },
  summary: { itemCount: 0, noteCount: 0, lastActivityAt: null },
  items: [],
};

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function setup(
  overrides: Partial<S32Config> = {},
  value: ProjectOverview | null = overview,
  error?: Error,
  missingService = false,
) {
  const get = vi.fn(async () => {
    if (error) throw error;
    return value;
  });
  const service = createProjectOverviewService({ get });
  const config: S32Config = {
    enabled: true,
    privateToken: "test-token",
    databaseUrl: "postgresql://local/test",
    ...overrides,
  };

  const app = express();
  app.use(
    "/api/private/s32/projects",
    createProjectOverviewRouter(config, missingService ? null : service),
  );
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  servers.push(server);

  async function request(path = `/${projectId}/overview`, token = "test-token") {
    return fetch(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/private/s32/projects${path}`,
      { headers: token ? { Authorization: `Bearer ${token}` } : {} },
    );
  }

  return { request, get };
}

describe("project overview private route", () => {
  for (const [label, config, token, status] of [
    ["disabled", { enabled: false }, "", 404],
    ["token unconfigured", { privateToken: null }, "", 503],
    ["missing token", {}, "", 401],
    ["wrong token", {}, "wrong", 403],
    ["database unconfigured", { databaseUrl: null }, "test-token", 503],
  ] as const) {
    it(`${label} blocks before storage`, async () => {
      const { request, get } = await setup(config);
      const response = await request(undefined, token);
      expect(response.status).toBe(status);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(get).not.toHaveBeenCalled();
    });
  }

  it("fails closed without a configured service", async () => {
    const { request } = await setup({}, overview, undefined, true);
    expect((await request()).status).toBe(503);
  });

  it("returns the direct project/summary/items object without an overview wrapper", async () => {
    const { request } = await setup();
    const response = await request();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(overview);
  });

  it("returns ARCHIVED overview as a readable 200 projection", async () => {
    const archived: ProjectOverview = {
      ...overview,
      project: { ...overview.project, lifecycleState: "ARCHIVED", readOnly: true },
    };
    const { request } = await setup({}, archived);
    const response = await request();
    expect(response.status).toBe(200);
    expect((await response.json()).project).toMatchObject({ lifecycleState: "ARCHIVED", readOnly: true });
  });

  it("rejects malformed project ids before storage", async () => {
    const { request, get } = await setup();
    const response = await request("/not-a-uuid/overview");
    expect(response.status).toBe(400);
    expect(get).not.toHaveBeenCalled();
  });

  it("returns 404 for a missing Project", async () => {
    const { request } = await setup({}, null);
    expect((await request()).status).toBe(404);
  });

  it.each([
    [new ProjectOverviewStoreUnavailableError("postgresql://SECRET"), 503],
    [new ProjectOverviewIntegrityError("SQL SECRET"), 500],
    [new Error("SQL SECRET"), 500],
  ] as const)("maps store failure safely to %s", async (error, status) => {
    const { request } = await setup({}, overview, error);
    const response = await request();
    expect(response.status).toBe(status);
    expect(await response.text()).not.toMatch(/SECRET|postgresql:\/\//i);
  });
});
