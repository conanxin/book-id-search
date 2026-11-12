import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGoogleOwnerRequestAuthorizer } from "../auth/google-owner-request.js";
import { readGoogleSessionAuthConfig } from "../auth/config.js";
import { issueWebSession } from "../auth/web-session.js";
import { createBookAssistantRouter } from "./book-assistant-routes.js";
import { createBookWebResearchRouter } from "./book-web-research-routes.js";
import { createBookWebResearchService } from "./book-web-research.js";
import { BookWebSourceError, createBookWebSourceReader, type BookWebSourceFetcher } from "./book-web-source.js";

const SECRET = "disposable-book-web-source-secret-48-characters";
const ORIGIN = "https://books.example.test", BOOK = "10000001_000000000001";
const path = `/api/ai/books/${BOOK}/research`, sourceUrl = "https://example.org/book";
const config = readGoogleSessionAuthConfig({ NODE_ENV: "production", GOOGLE_AUTH_ENABLED: "true",
  GOOGLE_CLIENT_ID: "test.apps.googleusercontent.com", BOOK_ID_SEARCH_OWNER_GOOGLE_SUB: "test-owner",
  BOOK_ID_SEARCH_SESSION_SECRET: SECRET, BOOK_ID_SEARCH_PUBLIC_ORIGIN: ORIGIN });
let server: Server | undefined, base: string;
let sourceReader: ReturnType<typeof createBookWebSourceReader>, fetchPage: ReturnType<typeof vi.fn<BookWebSourceFetcher>>;
const search = vi.fn(), provider = vi.fn(), assistant = { generate: vi.fn() };
function session(sub = "test-owner", expired = false) {
  const issued = issueWebSession({ sub, email: "owner@example.test", name: "Test Owner" }, { secret: SECRET,
    ...(expired ? { nowSeconds: Math.floor(Date.now() / 1000) - 3600, ttlSeconds: 60 } : {}) });
  return { cookie: `${config.cookieName}=${issued.token}`, csrf: issued.payload.csrf };
}
function headers() {
  const owner = session();
  return { cookie: owner.cookie, origin: ORIGIN, "x-csrf-token": owner.csrf, "content-type": "application/json" };
}
async function start() {
  const app = express(), authorizer = createGoogleOwnerRequestAuthorizer(config);
  const service = createBookWebResearchService({ getCatalogDocument: async () => ({ id: BOOK, title: "合成书籍", author: "合成作者",
    publisher: "合成出版社", year: 2020, isbn: "test-isbn", pages: 100 }), search, provider, isEnabled: () => true,
    issueSourceReadToken: sourceReader.issueToken });
  app.use("/api/ai/books/:bookId/research", createBookWebResearchRouter({ service, sourceReader, requestAuthorizer: authorizer }));
  app.use("/api/ai/books", createBookAssistantRouter({ service: assistant, requestAuthorizer: authorizer }));
  app.use(express.json({ limit: "256kb" }));
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server!.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
beforeEach(() => {
  search.mockReset().mockResolvedValue({ ok: true, queries: ["合成书籍资料"], searchCalls: 1,
    results: [{ title: "合成来源标题", url: sourceUrl, excerpt: "搜索节选保持原样", pageAge: null }] });
  provider.mockReset().mockResolvedValue({ ok: true, model: "fixture", content: JSON.stringify({ sourceIds: ["W1"], insufficientEvidence: false }) });
  assistant.generate.mockReset();
  fetchPage = vi.fn<BookWebSourceFetcher>().mockResolvedValue({ finalUrl: sourceUrl, contentType: "text/html",
    body: Buffer.from("<title>合成正文标题</title><main><p>显式读取的网页正文。</p></main>") });
  sourceReader = createBookWebSourceReader({ fetchPage });
});
afterEach(async () => {
  if (server) await new Promise<void>(resolve => { server!.closeAllConnections(); server!.close(() => resolve()); });
  server = undefined;
});

describe("source reader owner-only HTTP boundary", () => {
  it("requires actual owner session, Origin and CSRF before parsing or fetching", async () => {
    await start();
    for (const extra of [{}, { authorization: "Bearer legacy" }, { cookie: session("different-owner").cookie },
      { cookie: session("test-owner", true).cookie }]) {
      const response = await fetch(base + path + "/source", { method: "POST", headers: { ...extra, "content-type": "application/json" }, body: "{PRIVATE_MALFORMED" });
      expect(response.status).toBe(401); expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("vary")).toContain("Cookie");
    }
    const owner = session();
    for (const extra of [{}, { origin: ORIGIN }, { "x-csrf-token": owner.csrf },
      { origin: "https://wrong.example.test", "x-csrf-token": owner.csrf }]) {
      const response = await fetch(base + path + "/source", { method: "POST", headers: { cookie: owner.cookie, "content-type": "application/json", ...extra }, body: "{}" });
      expect(response.status).toBe(403);
    }
    expect(fetchPage).not.toHaveBeenCalled(); expect(search).not.toHaveBeenCalled(); expect(provider).not.toHaveBeenCalled();
  });

  it("issues a search-source token, reads only on explicit POST, preserves the excerpt and never calls a model for reading", async () => {
    await start();
    const response = await fetch(base + path, { method: "POST", headers: headers(), body: JSON.stringify({ question: "这本书的资料？" }) });
    expect(response.status).toBe(200);
    const research = await response.json();
    expect(research.sources[0]).toMatchObject({ id: "W1", url: sourceUrl, excerpt: "搜索节选保持原样", readToken: expect.stringMatching(/^[A-Za-z0-9_-]{32}$/) });
    expect(fetchPage).not.toHaveBeenCalled();
    expect(JSON.stringify(provider.mock.calls)).not.toContain(research.sources[0].readToken);
    const read = await fetch(base + path + "/source", { method: "POST", headers: headers(), body: JSON.stringify({ sourceToken: research.sources[0].readToken }) });
    expect(read.status).toBe(200); expect(read.headers.get("cache-control")).toBe("no-store");
    expect(await read.json()).toMatchObject({ bookId: BOOK, sourceId: "W1", requestedUrl: sourceUrl, finalUrl: sourceUrl,
      title: "合成正文标题", text: "显式读取的网页正文。", contentType: "text/html", extraction: "html_readable_text", truncated: false });
    expect(fetchPage).toHaveBeenCalledExactlyOnceWith(sourceUrl, { signal: expect.any(AbortSignal) });
    expect(search).toHaveBeenCalledOnce(); expect(provider).toHaveBeenCalledOnce(); expect(assistant.generate).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON, oversized JSON, arbitrary URLs and wrong-book tokens with no fetch", async () => {
    await start();
    const token = sourceReader.issueToken("10000002_000000000002", { id: "W1", title: "other", url: sourceUrl });
    for (const body of ["{PRIVATE_MALFORMED", JSON.stringify({ sourceToken: "x".repeat(20_000) }),
      JSON.stringify({ url: sourceUrl }), JSON.stringify({ sourceToken: token })]) {
      const response = await fetch(base + path + "/source", { method: "POST", headers: headers(), body });
      expect(response.status).toBe(400); const output = await response.text();
      expect(output).toContain("BOOK_SOURCE_INVALID_INPUT"); expect(output).not.toContain("PRIVATE_MALFORMED");
    }
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it.each([
    ["BOOK_SOURCE_BLOCKED", 400], ["BOOK_SOURCE_UNSUPPORTED", 415], ["BOOK_SOURCE_TOO_LARGE", 413],
    ["BOOK_SOURCE_UNREADABLE", 422], ["BOOK_SOURCE_UNAVAILABLE", 502], ["BOOK_SOURCE_TIMEOUT", 504],
  ] as const)("maps %s to %s without exposing URL/credential details", async (code, status) => {
    await start();
    fetchPage.mockRejectedValueOnce(new BookWebSourceError(code));
    const token = sourceReader.issueToken(BOOK, { id: "W1", title: "source", url: sourceUrl });
    const response = await fetch(base + path + "/source", { method: "POST", headers: headers(), body: JSON.stringify({ sourceToken: token }) });
    expect(response.status).toBe(status); expect(await response.json()).toEqual({ error: { code, message: new BookWebSourceError(code).message } });
  });

  it("returns 410 for a lost grant, 502 for unexpected upstream errors and never reads on GET", async () => {
    await start();
    const expired = await fetch(base + path + "/source", { method: "POST", headers: headers(), body: JSON.stringify({ sourceToken: "a".repeat(32) }) });
    expect(expired.status).toBe(410);
    fetchPage.mockRejectedValueOnce(new Error("PRIVATE_PROXY_CREDENTIAL SQL"));
    const token = sourceReader.issueToken(BOOK, { id: "W1", title: "source", url: sourceUrl });
    const failed = await fetch(base + path + "/source", { method: "POST", headers: headers(), body: JSON.stringify({ sourceToken: token }) });
    expect(failed.status).toBe(502); expect(await failed.json()).toEqual({ error: { code: "BOOK_SOURCE_UNAVAILABLE", message: new BookWebSourceError("BOOK_SOURCE_UNAVAILABLE").message } });
    const get = await fetch(base + path + "/source", { headers: headers() });
    expect(get.status).toBe(404); expect(fetchPage).toHaveBeenCalledOnce();
  });

  it("cancels the fetch on browser disconnect and drops a non-cooperative late result", async () => {
    await start();
    let started!: () => void, cancelled!: () => void;
    const beginning = new Promise<void>(resolve => { started = resolve; });
    const cancelling = new Promise<void>(resolve => { cancelled = resolve; });
    fetchPage.mockImplementationOnce(async (_url, options) => {
      started();
      await new Promise<void>(resolve => options.signal!.addEventListener("abort", () => { cancelled(); resolve(); }, { once: true }));
      return { finalUrl: sourceUrl, contentType: "text/plain", body: Buffer.from("late") };
    });
    const token = sourceReader.issueToken(BOOK, { id: "W1", title: "source", url: sourceUrl });
    const controller = new AbortController();
    const request = fetch(base + path + "/source", { method: "POST", headers: headers(), body: JSON.stringify({ sourceToken: token }), signal: controller.signal });
    const observed = request.catch(error => error as Error);
    await beginning; controller.abort(); await cancelling;
    expect(await observed).toMatchObject({ name: "AbortError" });
    expect(fetchPage.mock.calls[0][1].signal?.aborted).toBe(true);
    expect(search).not.toHaveBeenCalled(); expect(provider).not.toHaveBeenCalled();
  });
});
