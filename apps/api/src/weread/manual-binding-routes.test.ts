import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readGoogleSessionAuthConfig } from "../auth/config.js";
import { createGoogleOwnerRequestAuthorizer } from "../auth/google-owner-request.js";
import { issueWebSession } from "../auth/web-session.js";
import { createWereadBindingsRouter } from "./manual-binding-routes.js";
import { WereadBindingError, type WereadBindingsService } from "./manual-bindings.js";

const SECRET = "disposable-weread-binding-test-secret-48-characters";
const ORIGIN = "https://books.example.test";
const config = readGoogleSessionAuthConfig({
  NODE_ENV: "production", GOOGLE_AUTH_ENABLED: "true", GOOGLE_CLIENT_ID: "test.apps.googleusercontent.com",
  BOOK_ID_SEARCH_OWNER_GOOGLE_SUB: "test-owner", BOOK_ID_SEARCH_SESSION_SECRET: SECRET,
  BOOK_ID_SEARCH_PUBLIC_ORIGIN: ORIGIN,
});
const path = "/api/private/weread/bindings";
const sourceKey = "a".repeat(64);
const item = { sourceKey, title: "合成来源", author: "合成作者", isbn: null, notesCount: 2,
  effectiveCatalog: null, importedCatalogId: null, origin: "unlinked" as const, revision: 3, updatedAt: "2026-10-11T00:00:00Z" };
let service: WereadBindingsService;
let server: Server | undefined;
let base: string;
function session(sub = "test-owner", expired = false) {
  // Actual signed session format; no OAuth exchange or real Google identity.
  const issued = issueWebSession({ sub, email: "owner@example.test", name: "Test Owner" }, {
    secret: SECRET,
    ...(expired ? { nowSeconds: Math.floor(Date.now() / 1000) - 3600, ttlSeconds: 60 } : {}),
  });
  return { cookie: `${config.cookieName}=${issued.token}`, csrf: issued.payload.csrf };
}
async function start(options: { noAuthorizer?: boolean; enabled?: boolean } = {}) {
  const app = express();
  app.use(path, createWereadBindingsRouter({ service,
    requestAuthorizer: options.noAuthorizer ? undefined : createGoogleOwnerRequestAuthorizer(config), enabled: options.enabled }));
  app.use(express.json({ limit: "256kb" }));
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server!.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
beforeEach(() => {
  service = { writable: true, loadOverlay: vi.fn(), loadNotes: vi.fn(),
    list: vi.fn(async () => ({ items: [item], pageInfo: { total: 1, offset: 0, limit: 20, hasMore: false }, writable: true })),
    get: vi.fn(async () => item), update: vi.fn(async () => item) };
});
afterEach(async () => { if (server) await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined; });

describe("WeRead binding management Google owner router", () => {
  it("requires an owner session even for GET and rejects legacy/expired/non-owner sessions before body parsing", async () => {
    await start();
    for (const headers of [{}, { authorization: "Bearer legacy-test-token" }, { "x-private-token": "legacy-test-token" },
      { cookie: session("other-owner").cookie }, { cookie: session("test-owner", true).cookie }, { cookie: "broken=session" }]) {
      expect((await fetch(base + path, { headers })).status).toBe(401);
      expect((await fetch(base + path + "/" + sourceKey, { method: "PUT", headers: { ...headers, "content-type": "application/json" }, body: "{invalid" })).status).toBe(401);
    }
    expect(service.list).not.toHaveBeenCalled(); expect(service.update).not.toHaveBeenCalled();
  });
  it("rejects missing/wrong origin or CSRF and allows the signed owner's matching pair", async () => {
    await start();
    const owner = session(), headers = { cookie: owner.cookie, "content-type": "application/json" };
    for (const extra of [{}, { origin: ORIGIN }, { "x-csrf-token": owner.csrf },
      { origin: "https://other.example.test", "x-csrf-token": owner.csrf }, { origin: ORIGIN, "x-csrf-token": "wrong" }]) {
      expect((await fetch(base + path + "/" + sourceKey, { method: "PUT", headers: { ...headers, ...extra }, body: "{}" })).status).toBe(403);
    }
    expect(service.update).not.toHaveBeenCalled();
    const body = { action: "unbind", expectedRevision: 2 };
    const response = await fetch(base + path + "/" + sourceKey, { method: "PUT", headers: { ...headers, origin: ORIGIN, "x-csrf-token": owner.csrf }, body: JSON.stringify(body) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, item, writable: true });
    expect(service.update).toHaveBeenCalledWith(sourceKey, body);
  });
  it("exposes list and independent single-item reads with no-store and Cookie vary", async () => {
    await start();
    const headers = { cookie: session().cookie };
    const list = await fetch(base + path + "?status=manual&limit=20", { headers });
    expect(list.status).toBe(200);
    expect(list.headers.get("cache-control")).toBe("no-store");
    expect(list.headers.get("vary")).toContain("Cookie");
    expect(await list.json()).toMatchObject({ ok: true, items: [item], writable: true });
    expect(service.list).toHaveBeenCalledWith({ status: "manual", limit: "20" });
    const single = await fetch(base + path + "/" + sourceKey, { headers });
    expect(await single.json()).toEqual({ ok: true, item, writable: true });
    expect(service.get).toHaveBeenCalledWith(sourceKey);
  });
  it("bounds authenticated JSON at 16 KiB and never echoes malformed private input", async () => {
    await start();
    const owner = session();
    const headers = { cookie: owner.cookie, origin: ORIGIN, "x-csrf-token": owner.csrf, "content-type": "application/json" };
    for (const body of ["{private-malformed", JSON.stringify({ private: "private-body".repeat(2000) })]) {
      const response = await fetch(base + path + "/" + sourceKey, { method: "PUT", headers, body });
      expect(response.status).toBe(400);
      const output = await response.text();
      expect(output).not.toMatch(/private-malformed|private-body/);
      expect(output).toContain("WEREAD_BINDING_INVALID_INPUT");
    }
    expect(service.update).not.toHaveBeenCalled();
  });
  it("returns safe conflict/not-found/unavailable errors without echoing database details", async () => {
    await start();
    const owner = session(), headers = { cookie: owner.cookie, origin: ORIGIN, "x-csrf-token": owner.csrf, "content-type": "application/json" };
    vi.mocked(service.update).mockRejectedValueOnce(new WereadBindingError("WEREAD_BINDING_CONFLICT"));
    const conflict = await fetch(base + path + "/" + sourceKey, { method: "PUT", headers, body: "{}" });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ ok: false, error: { code: "WEREAD_BINDING_CONFLICT" } });
    vi.mocked(service.get).mockRejectedValueOnce(new WereadBindingError("WEREAD_BINDING_SOURCE_NOT_FOUND"));
    expect((await fetch(base + path + "/" + sourceKey, { headers })).status).toBe(404);
    vi.mocked(service.list).mockRejectedValueOnce(new Error("SELECT secret WHERE password=private-db"));
    const unavailable = await fetch(base + path, { headers });
    expect(unavailable.status).toBe(503);
    expect(await unavailable.text()).not.toMatch(/SELECT|password|private-db/);
  });
  it("refuses a missing authorizer rather than using legacy credentials", async () => {
    await start({ noAuthorizer: true });
    const response = await fetch(base + path, { headers: { authorization: "Bearer legacy-test-token", cookie: session().cookie } });
    expect(response.status).toBe(503);
    expect(service.list).not.toHaveBeenCalled();
  });
  it("preserves the existing disabled overlay boundary", async () => {
    await start({ enabled: false });
    expect((await fetch(base + path, { headers: { cookie: session().cookie } })).status).toBe(404);
    expect(service.list).not.toHaveBeenCalled();
  });
});
