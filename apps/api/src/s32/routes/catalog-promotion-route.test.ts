import { describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import {
  CanonicalStoreUnavailableError,
  CatalogBookNotFoundError,
  CatalogReadUnavailableError,
  IdentityConflictError,
  type PromotionResult,
} from "../application/promote-catalog-book.js";
import type { S32Config } from "../config.js";
import { InvalidCatalogBookError } from "../domain/catalog-promotion.js";
import { createCatalogPromotionHandler } from "./catalog-promotion-route.js";

function config(overrides: Partial<S32Config> = {}): S32Config {
  return {
    enabled: true,
    databaseUrl: "postgresql://example/s32",
    privateToken: "secret",
    ...overrides,
  };
}

function request(body: unknown, token = "secret"): Request {
  return {
    body,
    headers: {
      authorization: token ? `Bearer ${token}` : undefined,
    },
  } as unknown as Request;
}

function responseHarness() {
  const state: { status: number; body: unknown } = { status: 200, body: undefined };
  const res = {
    status(code: number) {
      state.status = code;
      return res;
    },
    json(value: unknown) {
      state.body = value;
      return res;
    },
  } as unknown as Response;
  return { res, state };
}

async function invoke(args: {
  cfg?: S32Config;
  body?: unknown;
  token?: string;
  command?: { execute: ReturnType<typeof vi.fn> };
}) {
  const command = args.command ?? { execute: vi.fn() };
  const handler = createCatalogPromotionHandler({
    config: args.cfg ?? config(),
    command,
  });
  const { res, state } = responseHarness();
  const body = Object.prototype.hasOwnProperty.call(args, "body")
    ? args.body
    : { bookId: "book-1" };
  await handler(request(body, args.token ?? "secret"), res);
  return { command, state };
}

const created: PromotionResult = {
  status: "created",
  workId: "work-1",
  editionId: "edition-1",
  sourceId: "source-1",
  catalogBookId: "book-1",
};
const existing: PromotionResult = { ...created, status: "existing" };

describe("catalog promotion private route", () => {
  it("returns 404 while S32 is disabled before command execution", async () => {
    const out = await invoke({ cfg: config({ enabled: false }), token: "" });
    expect(out.state.status).toBe(404);
    expect(out.command.execute).not.toHaveBeenCalled();
  });

  it("returns 503 when the S32 token is not configured", async () => {
    const out = await invoke({ cfg: config({ privateToken: null }), token: "" });
    expect(out.state.status).toBe(503);
    expect(out.command.execute).not.toHaveBeenCalled();
  });

  it("returns 401 for a missing token", async () => {
    const out = await invoke({ token: "" });
    expect(out.state.status).toBe(401);
    expect(out.command.execute).not.toHaveBeenCalled();
  });

  it("returns 403 for a bad token", async () => {
    const out = await invoke({ token: "wrong" });
    expect(out.state.status).toBe(403);
    expect(out.command.execute).not.toHaveBeenCalled();
  });

  it("returns 503 when authenticated but database is unconfigured", async () => {
    const out = await invoke({ cfg: config({ databaseUrl: null }) });
    expect(out.state.status).toBe(503);
    expect(out.command.execute).not.toHaveBeenCalled();
  });

  it("returns 400 for missing or blank bookId", async () => {
    for (const body of [{}, { bookId: "   " }, null]) {
      const out = await invoke({ body });
      expect(out.state.status).toBe(400);
      expect(out.command.execute).not.toHaveBeenCalled();
    }
  });

  it("returns 201 for created and passes only bookId to the command", async () => {
    const command = { execute: vi.fn().mockResolvedValue(created) };
    const out = await invoke({
      command,
      body: {
        bookId: " book-1 ",
        title: "attacker title",
        publisher: "attacker publisher",
      },
    });
    expect(out.state.status).toBe(201);
    expect(out.state.body).toEqual(created);
    expect(command.execute).toHaveBeenCalledWith({ bookId: "book-1" });
  });

  it("returns 200 for an existing promotion", async () => {
    const command = { execute: vi.fn().mockResolvedValue(existing) };
    const out = await invoke({ command });
    expect(out.state.status).toBe(200);
    expect(out.state.body).toEqual(existing);
  });

  it.each([
    [new CatalogBookNotFoundError("CATALOG_BOOK_NOT_FOUND"), 404],
    [new InvalidCatalogBookError("CATALOG_TITLE_MISSING"), 422],
    [new IdentityConflictError("SECONDARY_IDENTITY_CONFLICT:SSID"), 409],
    [new CatalogReadUnavailableError("CATALOG_READ_UNAVAILABLE"), 503],
    [new CanonicalStoreUnavailableError("CANONICAL_STORE_UNAVAILABLE"), 503],
  ])("maps known domain/application errors without leaking detail: %s", async (error, status) => {
    const command = { execute: vi.fn().mockRejectedValue(error) };
    const out = await invoke({ command });
    expect(out.state.status).toBe(status);
    expect(JSON.stringify(out.state.body)).not.toContain(error.message);
  });

  it("maps unexpected failures to a generic 500 response", async () => {
    const command = { execute: vi.fn().mockRejectedValue(new Error("postgresql://secret@db/raw")) };
    const out = await invoke({ command });
    expect(out.state.status).toBe(500);
    expect(JSON.stringify(out.state.body)).not.toContain("postgresql://");
    expect(JSON.stringify(out.state.body)).not.toContain("secret");
  });
});
