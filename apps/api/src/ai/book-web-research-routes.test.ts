import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGoogleOwnerRequestAuthorizer } from "../auth/google-owner-request.js";
import { readGoogleSessionAuthConfig } from "../auth/config.js";
import { issueWebSession } from "../auth/web-session.js";
import { createBookAssistantRouter } from "./book-assistant-routes.js";
import { BookWebResearchError, type BookWebResearchResponse, type BookWebResearchService } from "./book-web-research.js";
import { createBookWebResearchRouter } from "./book-web-research-routes.js";

const SECRET = "disposable-book-web-research-secret-48-characters";
const ORIGIN = "https://books.example.test";
const config = readGoogleSessionAuthConfig({ NODE_ENV: "production", GOOGLE_AUTH_ENABLED: "true",
  GOOGLE_CLIENT_ID: "test.apps.googleusercontent.com", BOOK_ID_SEARCH_OWNER_GOOGLE_SUB: "test-owner",
  BOOK_ID_SEARCH_SESSION_SECRET: SECRET, BOOK_ID_SEARCH_PUBLIC_ORIGIN: ORIGIN });
const A = "10000001_000000000001", path = `/api/ai/books/${A}/research`;
const result: BookWebResearchResponse = { bookId: A, question: "研究背景是什么？", source: "insufficient_sources",
  draft: { title: "资料不足", content: "本次搜索结果不足以支持回答。" }, sources: [], citedSourceIds: [],
  search: { performed: true, queries: ["运河田野调查"], calls: 1 }, generatedAt: "2026-10-11T12:00:00.000Z" };
let service: BookWebResearchService;
let server: Server | undefined;
let base: string;
const assistant = { generate: vi.fn() };
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
  const app = express(), authorizer = createGoogleOwnerRequestAuthorizer(config);
  app.use("/api/ai/books/:bookId/research", createBookWebResearchRouter({ service, requestAuthorizer: noAuthorizer ? undefined : authorizer }));
  app.use("/api/ai/books", createBookAssistantRouter({ service: assistant, requestAuthorizer: authorizer }));
  app.use(express.json({ limit: "256kb" }));
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server!.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
beforeEach(() => { service = { research: vi.fn().mockResolvedValue(result) }; assistant.generate.mockReset(); });
afterEach(async () => {
  if (server) await new Promise<void>(resolve => { server!.closeAllConnections(); server!.close(() => resolve()); });
  server = undefined;
});

describe("book web research Google-owner HTTP boundary", () => {
  it("rejects anonymous, legacy, expired and non-owner sessions before parsing or starting search", async () => {
    await start();
    for (const headers of [{}, { authorization: "Bearer legacy-test-token" }, { "x-private-token": "legacy-test-token" },
      { cookie: "broken=session" }, { cookie: session("different-owner").cookie }, { cookie: session("test-owner", true).cookie }]) {
      const response = await fetch(base + path, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: "{private malformed" });
      expect(response.status).toBe(401);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("vary")).toContain("Cookie");
      expect(await response.json()).toMatchObject({ error: { code: "BOOK_RESEARCH_AUTH_REQUIRED" } });
    }
    expect(service.research).not.toHaveBeenCalled(); expect(assistant.generate).not.toHaveBeenCalled();
  });

  it("requires matching Origin and CSRF even though research has no library writes", async () => {
    await start();
    const owner = session(), headers = { cookie: owner.cookie, "content-type": "application/json" };
    for (const extra of [{}, { origin: ORIGIN }, { "x-csrf-token": owner.csrf },
      { origin: "https://other.example.test", "x-csrf-token": owner.csrf }, { origin: ORIGIN, "x-csrf-token": "wrong" }]) {
      const response = await fetch(base + path, { method: "POST", headers: { ...headers, ...extra }, body: "{private malformed" });
      expect(response.status).toBe(403);
    }
    expect(service.research).not.toHaveBeenCalled();
    const response = await fetch(base + path, { method: "POST", headers: ownerHeaders(), body: JSON.stringify({ question: result.question }) });
    expect(response.status).toBe(200); expect(await response.json()).toEqual(result);
    expect(service.research).toHaveBeenCalledExactlyOnceWith(A, { question: result.question }, { signal: expect.any(AbortSignal) });
    const passedSignal = vi.mocked(service.research).mock.calls[0][2]?.signal;
    expect(passedSignal?.aborted).toBe(false);
  });

  it("consumes research before the older assistant parser while leaving the assistant endpoint unchanged", async () => {
    await start();
    const response = await fetch(base + path, { method: "POST", headers: ownerHeaders(), body: JSON.stringify({ question: result.question }) });
    expect(response.status).toBe(200); expect(assistant.generate).not.toHaveBeenCalled();
    assistant.generate.mockResolvedValueOnce({ source: "existing-assistant-fixture" });
    const existing = await fetch(`${base}/api/ai/books/${A}/assistant`, { method: "POST", headers: ownerHeaders(), body: JSON.stringify({ action: "introduction" }) });
    expect(existing.status).toBe(200); expect(await existing.json()).toEqual({ source: "existing-assistant-fixture" });
    expect(assistant.generate).toHaveBeenCalledExactlyOnceWith(A, { action: "introduction" });
    expect(service.research).toHaveBeenCalledOnce();
  });

  it("returns a small fixed error for authenticated malformed or oversized JSON", async () => {
    await start();
    for (const body of ["{PRIVATE_MALFORMED", JSON.stringify({ question: "PRIVATE_BODY_".repeat(1500) })]) {
      const response = await fetch(base + path, { method: "POST", headers: ownerHeaders(), body });
      expect(response.status).toBe(400);
      const output = await response.text();
      expect(output).toContain("BOOK_RESEARCH_INVALID_INPUT"); expect(output).not.toMatch(/PRIVATE_MALFORMED|PRIVATE_BODY/);
    }
    expect(service.research).not.toHaveBeenCalled();
  });

  it("requires the Google authorizer, never accepts legacy authentication as fallback", async () => {
    await start(true);
    const response = await fetch(base + path, { method: "POST", headers: { ...ownerHeaders(), authorization: "Bearer legacy" }, body: "{}" });
    expect(response.status).toBe(503); expect(await response.json()).toMatchObject({ error: { code: "BOOK_RESEARCH_AUTH_UNAVAILABLE" } });
    expect(service.research).not.toHaveBeenCalled();
  });

  it.each([
    ["BOOK_RESEARCH_INVALID_INPUT", 400], ["BOOK_RESEARCH_BOOK_NOT_FOUND", 404], ["BOOK_RESEARCH_UNAVAILABLE", 503],
    ["BOOK_RESEARCH_SEARCH_FAILED", 502], ["BOOK_RESEARCH_INVALID_RESPONSE", 502],
  ] as const)("maps %s to %s without caching", async (code, status) => {
    await start(); vi.mocked(service.research).mockRejectedValueOnce(new BookWebResearchError(code));
    const response = await fetch(base + path, { method: "POST", headers: ownerHeaders(), body: "{}" });
    expect(response.status).toBe(status); expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ error: { code } });
  });

  it("does not expose unexpected provider, SQL, prompt or credential errors", async () => {
    await start(); vi.mocked(service.research).mockRejectedValueOnce(new Error("SELECT private-note MINIMAX_API_KEY=secret-key private-prompt"));
    const response = await fetch(base + path, { method: "POST", headers: ownerHeaders(), body: "{}" });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { code: "BOOK_RESEARCH_UNAVAILABLE", message: "联网研究暂不可用，请稍后重试。" } });
  });

  it("cancels the active provider chain when the browser closes the response", async () => {
    await start();
    let notifyStarted!: () => void, notifyCancelled!: () => void;
    const started = new Promise<void>(resolve => { notifyStarted = resolve; });
    const cancelled = new Promise<void>(resolve => { notifyCancelled = resolve; });
    vi.mocked(service.research).mockImplementationOnce(async (_id, _body, options) => {
      notifyStarted();
      await new Promise<void>(resolve => options!.signal!.addEventListener("abort", () => { notifyCancelled(); resolve(); }, { once: true }));
      // A non-cooperative upstream may resolve after disconnect. The router
      // must discard this result rather than writing to the closed response.
      return result;
    });
    const controller = new AbortController();
    const request = fetch(base + path, { method: "POST", headers: ownerHeaders(), body: JSON.stringify({ question: result.question }), signal: controller.signal });
    const observed = request.catch(error => error as Error);
    await started; controller.abort(); await cancelled;
    expect(await observed).toMatchObject({ name: "AbortError" });
    expect(vi.mocked(service.research).mock.calls[0][2]?.signal?.aborted).toBe(true);
    expect(assistant.generate).not.toHaveBeenCalled();
  });

  it("does not start research via GET", async () => {
    await start();
    const response = await fetch(base + path, { headers: { cookie: session().cookie } });
    expect(response.status).toBe(404); expect(service.research).not.toHaveBeenCalled();
  });
});
