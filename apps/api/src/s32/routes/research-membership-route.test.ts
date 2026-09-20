import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { S32Config } from "../config.js";
import {
  ResearchMembershipIntegrityError,
  ResearchMembershipStoreUnavailableError,
  createResearchMembershipService,
} from "../application/research-memberships.js";
import { createResearchMembershipRouter } from "./research-membership-route.js";

const membership = {
  projectId: "55555555-5555-4555-8555-555555555555",
  projectName: "北京古道研究",
  projectLifecycleState: "ACTIVE" as const,
  bindingId: "44444444-4444-4444-8444-444444444444",
  hasNote: true,
  noteUpdatedAt: "2026-09-20T08:00:00.000Z",
};

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function setup(
  overrides: Partial<S32Config> = {},
  error?: Error,
  missingService = false,
) {
  const lookup = vi.fn(async () => {
    if (error) throw error;
    return new Map([["book-a", [membership]]]);
  });
  const service = createResearchMembershipService({ lookup });
  const config: S32Config = {
    enabled: true,
    privateToken: "test-token",
    databaseUrl: "postgresql://local/test",
    ...overrides,
  };

  const app = express();
  app.use(express.json());
  app.use(
    "/api/private/s32/research-memberships",
    createResearchMembershipRouter(config, missingService ? null : service),
  );
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  servers.push(server);

  async function request(body: unknown, token = "test-token") {
    return fetch(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/private/s32/research-memberships/catalog-books`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      },
    );
  }

  return { request, lookup };
}

describe("research membership private route", () => {
  for (const [label, config, token, status] of [
    ["disabled", { enabled: false }, "", 404],
    ["token unconfigured", { privateToken: null }, "", 503],
    ["missing token", {}, "", 401],
    ["wrong token", {}, "wrong", 403],
    ["database unconfigured", { databaseUrl: null }, "test-token", 503],
  ] as const) {
    it(`${label} blocks before storage`, async () => {
      const { request, lookup } = await setup(config);
      const response = await request({ bookIds: ["book-a"] }, token);
      expect(response.status).toBe(status);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(lookup).not.toHaveBeenCalled();
    });
  }

  it("fails closed when the service is unavailable", async () => {
    const { request } = await setup({}, undefined, true);
    expect((await request({ bookIds: ["book-a"] })).status).toBe(503);
  });

  it.each([
    null,
    {},
    { bookIds: "book-a" },
    { bookIds: [""] },
    { bookIds: Array.from({ length: 101 }, (_, i) => `book-${i}`) },
  ])("returns 400 for malformed input %#", async (body) => {
    const { request, lookup } = await setup();
    const response = await request(body);
    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(lookup).not.toHaveBeenCalled();
  });

  it("returns an explicit membership object on success", async () => {
    const { request, lookup } = await setup();
    const response = await request({ bookIds: ["book-a", "book-b", "book-a"] });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      memberships: {
        "book-a": [membership],
        "book-b": [],
      },
    });
    expect(lookup).toHaveBeenCalledWith(["book-a", "book-b"]);
  });

  it.each([
    [new ResearchMembershipStoreUnavailableError("postgresql://SECRET"), 503],
    [new ResearchMembershipIntegrityError("SQL SECRET"), 500],
    [new Error("SQL SECRET"), 500],
  ] as const)("maps storage failure safely to %s", async (error, status) => {
    const { request } = await setup({}, error);
    const response = await request({ bookIds: ["book-a"] });
    expect(response.status).toBe(status);
    const body = await response.text();
    expect(body).not.toMatch(/SECRET|postgresql:\/\//i);
  });
});
