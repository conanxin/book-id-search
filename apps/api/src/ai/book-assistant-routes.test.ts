import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGoogleOwnerRequestAuthorizer } from "../auth/google-owner-request.js";
import { readGoogleSessionAuthConfig } from "../auth/config.js";
import { issueWebSession } from "../auth/web-session.js";
import { BookAssistantError, type BookAssistantResponse, type BookAssistantService } from "./book-assistant.js";
import { createBookAssistantRouter } from "./book-assistant-routes.js";

const SECRET = "disposable-book-assistant-test-secret-48-characters";
const ORIGIN = "https://books.example.test";
const config = readGoogleSessionAuthConfig({ NODE_ENV: "production", GOOGLE_AUTH_ENABLED: "true",
  GOOGLE_CLIENT_ID: "test.apps.googleusercontent.com", BOOK_ID_SEARCH_OWNER_GOOGLE_SUB: "test-owner",
  BOOK_ID_SEARCH_SESSION_SECRET: SECRET, BOOK_ID_SEARCH_PUBLIC_ORIGIN: ORIGIN });
const A = "10000001_000000000001", root = "/api/ai/books", path = `${root}/${A}/assistant`;
const result: BookAssistantResponse = {
  bookId: A, action: "notes_summary", question: null, draft: { title: "还需要更多资料", content: "请先添加笔记。" },
  sources: [], citedSourceIds: [], source: "insufficient_context", generatedAt: "2026-10-11T04:00:00.000Z",
  context: { workspaceVersion: 0, introductionIncluded: false, notesAvailable: 0, notesIncluded: 0,
    wereadAvailable: 0, wereadIncluded: 0, wereadEnabled: false, truncated: false, sourceChars: 0 },
};
let service: BookAssistantService;
let server: Server | undefined;
let base: string;
function session(sub = "test-owner", expired = false) {
  const issued = issueWebSession({ sub, email: "owner@example.test", name: "Test Owner" }, { secret: SECRET,
    ...(expired ? { nowSeconds: Math.floor(Date.now() / 1000) - 3600, ttlSeconds: 60 } : {}) });
  return { cookie: `${config.cookieName}=${issued.token}`, csrf: issued.payload.csrf };
}
function ownerHeaders() {
  const owner = session();
  return { cookie: owner.cookie, origin: ORIGIN, "x-csrf-token": owner.csrf, "content-type": "application/json" };
}
async function start(noAuthorizer = false) {
  const app = express();
  app.use(root, createBookAssistantRouter({ service, requestAuthorizer: noAuthorizer ? undefined : createGoogleOwnerRequestAuthorizer(config) }));
  app.use(express.json({ limit: "256kb" }));
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server!.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
beforeEach(() => { service = { generate: vi.fn().mockResolvedValue(result) }; });
afterEach(async () => {
  if (server) await new Promise<void>(resolve => { server!.closeAllConnections(); server!.close(() => resolve()); });
  server = undefined;
});

describe("book assistant Google owner HTTP boundary", () => {
  it("rejects anonymous, legacy, broken, expired and non-owner credentials before parsing or generation", async () => {
    await start();
    for (const headers of [{}, { authorization: "Bearer legacy-test-token" }, { "x-private-token": "legacy-test-token" },
      { cookie: "broken=session" }, { cookie: session("different-owner").cookie }, { cookie: session("test-owner", true).cookie }]) {
      const response = await fetch(base + path, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: "{private malformed" });
      expect(response.status).toBe(401);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("vary")).toContain("Cookie");
      expect(await response.json()).toMatchObject({ error: { code: "BOOK_AI_AUTH_REQUIRED" } });
    }
    expect(service.generate).not.toHaveBeenCalled();
  });

  it("requires matching Origin and CSRF for the signed Google owner even though generation does not save", async () => {
    await start();
    const owner = session(), headers = { cookie: owner.cookie, "content-type": "application/json" };
    for (const extra of [{}, { origin: ORIGIN }, { "x-csrf-token": owner.csrf },
      { origin: "https://other.example.test", "x-csrf-token": owner.csrf }, { origin: ORIGIN, "x-csrf-token": "wrong" }]) {
      const response = await fetch(base + path, { method: "POST", headers: { ...headers, ...extra }, body: "{private malformed" });
      expect(response.status).toBe(403);
    }
    expect(service.generate).not.toHaveBeenCalled();
    const response = await fetch(base + path, { method: "POST", headers: ownerHeaders(), body: JSON.stringify({ action: "notes_summary" }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(result);
    expect(service.generate).toHaveBeenCalledExactlyOnceWith(A, { action: "notes_summary" });
  });

  it("returns a small fixed error for authenticated malformed or oversized JSON", async () => {
    await start();
    for (const body of ["{PRIVATE_MALFORMED", JSON.stringify({ question: "PRIVATE_BODY_".repeat(1500) })]) {
      const response = await fetch(base + path, { method: "POST", headers: ownerHeaders(), body });
      expect(response.status).toBe(400);
      const output = await response.text();
      expect(output).toContain("BOOK_AI_INVALID_INPUT");
      expect(output).not.toMatch(/PRIVATE_MALFORMED|PRIVATE_BODY/);
    }
    expect(service.generate).not.toHaveBeenCalled();
  });

  it("requires an injected Google authorizer instead of accepting legacy credentials", async () => {
    await start(true);
    const response = await fetch(base + path, { method: "POST", headers: { ...ownerHeaders(), authorization: "Bearer legacy-test-token" }, body: "{}" });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "BOOK_AI_AUTH_UNAVAILABLE" } });
    expect(service.generate).not.toHaveBeenCalled();
  });

  it.each([
    ["BOOK_AI_INVALID_INPUT", 400], ["BOOK_AI_BOOK_NOT_FOUND", 404], ["BOOK_AI_DISABLED", 503],
    ["BOOK_AI_UNAVAILABLE", 503], ["BOOK_AI_PROVIDER_FAILED", 502], ["BOOK_AI_INVALID_RESPONSE", 502],
  ] as const)("maps %s to %s with no-store", async (code, status) => {
    await start();
    vi.mocked(service.generate).mockRejectedValueOnce(new BookAssistantError(code));
    const response = await fetch(base + path, { method: "POST", headers: ownerHeaders(), body: "{}" });
    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ error: { code } });
  });

  it("never echoes SQL, prompts, credentials or provider body details on unexpected errors", async () => {
    await start();
    vi.mocked(service.generate).mockRejectedValueOnce(new Error("SELECT * secret-private-note MINIMAX_API_KEY=private-key"));
    const response = await fetch(base + path, { method: "POST", headers: ownerHeaders(), body: "{}" });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { code: "BOOK_AI_UNAVAILABLE", message: "书籍资料暂时无法读取，请稍后重试。" } });
  });

  it("does not generate via GET", async () => {
    await start();
    const response = await fetch(base + path, { headers: { cookie: session().cookie } });
    expect(response.status).toBe(404);
    expect(service.generate).not.toHaveBeenCalled();
  });
});
