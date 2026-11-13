import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGoogleOwnerRequestAuthorizer } from "../auth/google-owner-request.js";
import { readGoogleSessionAuthConfig } from "../auth/config.js";
import { issueWebSession } from "../auth/web-session.js";
import { createBookWebResearchRouter } from "./book-web-research-routes.js";
import { createBookWebSourceReader, type BookWebSourceFetcher } from "./book-web-source.js";
import { createBookWebSourceComparisonService, BookWebSourceComparisonError } from "./book-web-source-comparison.js";
import type { chatCompletion } from "./minimax.js";

const SECRET = "disposable-book-source-comparison-secret-48-characters";
const ORIGIN = "https://books.example.test", BOOK = "10000001_000000000001", OTHER = "10000002_000000000002";
const path = "/api/ai/books/" + BOOK + "/research";
const urls = ["https://example.org/source-a", "https://example.org/source-b"];
const config = readGoogleSessionAuthConfig({ NODE_ENV: "production", GOOGLE_AUTH_ENABLED: "true",
  GOOGLE_CLIENT_ID: "test.apps.googleusercontent.com", BOOK_ID_SEARCH_OWNER_GOOGLE_SUB: "test-owner",
  BOOK_ID_SEARCH_SESSION_SECRET: SECRET, BOOK_ID_SEARCH_PUBLIC_ORIGIN: ORIGIN });
let server: Server | undefined, base: string, readTokens: string[];
let reader: ReturnType<typeof createBookWebSourceReader>, comparison: ReturnType<typeof createBookWebSourceComparisonService>;
let fetchPage: ReturnType<typeof vi.fn<BookWebSourceFetcher>>, provider: ReturnType<typeof vi.fn<typeof chatCompletion>>;
const research = { research: vi.fn() };
const selection = () => ({ sources: [
  { sourceKey: "S2", passageIds: ["P1"], insufficientEvidence: false },
  { sourceKey: "S1", passageIds: ["P1"], insufficientEvidence: false },
] });
function session(sub = "test-owner", expired = false) {
  const issued = issueWebSession({ sub, email: "owner@example.test", name: "Test Owner" }, { secret: SECRET,
    ...(expired ? { nowSeconds: Math.floor(Date.now() / 1000) - 3600, ttlSeconds: 60 } : {}) });
  return { cookie: config.cookieName + "=" + issued.token, csrf: issued.payload.csrf };
}
function headers() {
  const owner = session();
  return { cookie: owner.cookie, origin: ORIGIN, "x-csrf-token": owner.csrf, "content-type": "application/json" };
}
async function start(withService = true) {
  const app = express();
  app.use("/api/ai/books/:bookId/research", createBookWebResearchRouter({
    service: research, sourceReader: reader, ...(withService ? { sourceComparison: comparison } : {}),
    requestAuthorizer: createGoogleOwnerRequestAuthorizer(config),
  }));
  app.use(express.json({ limit: "256kb" }));
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server!.once("listening", resolve));
  base = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
}
async function readSnapshots() {
  const reads = [];
  for (const token of readTokens) {
    const response = await fetch(base + path + "/source", { method: "POST", headers: headers(),
      body: JSON.stringify({ sourceToken: token }) });
    expect(response.status).toBe(200);
    reads.push(await response.json());
  }
  return reads;
}
beforeEach(() => {
  fetchPage = vi.fn<BookWebSourceFetcher>().mockImplementation(async url => ({
    finalUrl: url, contentType: "text/plain",
    body: Buffer.from(url === urls[0] ? "来源甲记载1935年。其与另一年份的关系没有交代。" : "来源乙记载1937年。没有说明初版或再版关系。"),
  }));
  reader = createBookWebSourceReader({ fetchPage });
  readTokens = urls.map((url, index) => reader.issueToken(BOOK, { id: "W" + (index + 1), title: "合成来源" + (index + 1), url })!);
  provider = vi.fn<typeof chatCompletion>().mockResolvedValue({ ok: true, model: "fixture", content: JSON.stringify(selection()) });
  comparison = createBookWebSourceComparisonService({ getSnapshot: reader.getSnapshot, provider, isEnabled: () => true });
  research.research.mockReset();
});
afterEach(async () => {
  if (server) await new Promise<void>(resolve => { server!.closeAllConnections(); server!.close(() => resolve()); });
  server = undefined;
});

describe("multiple source evidence authenticated HTTP boundary", () => {
  it("requires Owner, Origin and CSRF before parsing a body or performing source/provider work", async () => {
    await start();
    for (const extra of [{}, { authorization: "Bearer legacy" }, { cookie: session("different-owner").cookie },
      { cookie: session("test-owner", true).cookie }]) {
      const response = await fetch(base + path + "/sources/evidence", { method: "POST",
        headers: { ...extra, "content-type": "application/json" }, body: "{PRIVATE_MALFORMED" });
      expect(response.status).toBe(401);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("vary")).toContain("Cookie");
    }
    const owner = session();
    for (const extra of [{}, { origin: ORIGIN }, { "x-csrf-token": owner.csrf },
      { origin: "https://wrong.example.test", "x-csrf-token": owner.csrf }]) {
      const response = await fetch(base + path + "/sources/evidence", { method: "POST",
        headers: { cookie: owner.cookie, "content-type": "application/json", ...extra }, body: "{}" });
      expect(response.status).toBe(403);
    }
    expect(provider).not.toHaveBeenCalled();
    expect(fetchPage).not.toHaveBeenCalled();
    expect(research.research).not.toHaveBeenCalled();
  });

  it("returns both actual read snapshots in request order with exact source text and a single provider call", async () => {
    await start();
    const reads = await readSnapshots();
    expect(provider).not.toHaveBeenCalled();
    const response = await fetch(base + path + "/sources/evidence", { method: "POST", headers: headers(),
      body: JSON.stringify({ snapshotTokens: reads.map(read => read.snapshotToken), question: "  年份是什么？  " }) });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("vary")).toContain("Cookie");
    const result = await response.json();
    expect(result).toMatchObject({ bookId: BOOK, question: "年份是什么？", mode: "source_comparison" });
    expect(result.sources).toHaveLength(2);
    for (let index = 0; index < reads.length; index++) {
      const read = reads[index];
      expect(result.sources[index]).toEqual({ bookId: BOOK, question: "年份是什么？", mode: "source_passages",
        sourceId: read.sourceId, snapshotToken: read.snapshotToken, requestedUrl: read.requestedUrl,
        finalUrl: read.finalUrl, title: read.title, fetchedAt: read.fetchedAt, sourceTruncated: false,
        status: "selected", passages: [{ id: "P1", start: 0, end: read.text.length, text: read.text }],
        generatedAt: result.generatedAt });
    }
    expect(result.sources[0].passages[0].text).toContain("1935");
    expect(result.sources[1].passages[0].text).toContain("1937");
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(provider).toHaveBeenCalledOnce();
    expect(research.research).not.toHaveBeenCalled();
  });

  it("preserves an insufficient source as a complete provenance group", async () => {
    await start();
    const reads = await readSnapshots();
    provider.mockResolvedValueOnce({ ok: true, model: "fixture", content: JSON.stringify({ sources: [
      { sourceKey: "S1", passageIds: [], insufficientEvidence: true }, selection().sources[0],
    ] }) });
    const response = await fetch(base + path + "/sources/evidence", { method: "POST", headers: headers(),
      body: JSON.stringify({ snapshotTokens: reads.map(read => read.snapshotToken), question: "问题" }) });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.sources.map((source: { sourceId: string }) => source.sourceId)).toEqual(["W1", "W2"]);
    expect(result.sources[0]).toMatchObject({ status: "insufficient_evidence", passages: [],
      title: reads[0].title, finalUrl: reads[0].finalUrl, fetchedAt: reads[0].fetchedAt });
    expect(result.sources[1].status).toBe("selected");
    expect(provider).toHaveBeenCalledOnce();
  });

  it("rejects malformed/oversized JSON and client material before a model call", async () => {
    await start();
    for (const body of ["{PRIVATE_MALFORMED", JSON.stringify({ question: "x".repeat(20_000) }),
      JSON.stringify({ snapshotTokens: ["a".repeat(32), "b".repeat(32)], question: "问题", text: "CLIENT_TEXT" }),
      JSON.stringify({ snapshotTokens: ["a".repeat(32), "b".repeat(32)], question: "问题", url: urls[0] })]) {
      const response = await fetch(base + path + "/sources/evidence", { method: "POST", headers: headers(), body });
      expect(response.status).toBe(400);
      const output = await response.text();
      expect(output).toContain("BOOK_COMPARISON_INVALID_INPUT");
      expect(output).not.toMatch(/PRIVATE_MALFORMED|CLIENT_TEXT/);
    }
    expect(provider).not.toHaveBeenCalled();
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it("rejects duplicate, cross-book and lost snapshots; GET never runs selection", async () => {
    await start();
    const reads = await readSnapshots();
    const tokens = reads.map(read => read.snapshotToken);
    for (const [requestPath, snapshotTokens, status, code] of [
      [path, [tokens[0], tokens[0]], 400, "BOOK_COMPARISON_INVALID_INPUT"],
      [path, [tokens[0], "a".repeat(32)], 410, "BOOK_COMPARISON_EXPIRED"],
      [path.replace(BOOK, OTHER), tokens, 400, "BOOK_COMPARISON_INVALID_INPUT"],
    ] as const) {
      const response = await fetch(base + requestPath + "/sources/evidence", { method: "POST", headers: headers(),
        body: JSON.stringify({ snapshotTokens, question: "问题" }) });
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ error: { code } });
    }
    expect((await fetch(base + path + "/sources/evidence", { headers: headers() })).status).toBe(404);
    expect(provider).not.toHaveBeenCalled();
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["BOOK_COMPARISON_TEXT_LIMIT", 400], ["BOOK_COMPARISON_INVALID_OUTPUT", 502],
    ["BOOK_COMPARISON_UNAVAILABLE", 503], ["BOOK_COMPARISON_TIMEOUT", 504],
  ] as const)("returns canonical %s as %i", async (code, status) => {
    await start();
    vi.spyOn(comparison, "compare").mockRejectedValueOnce(new BookWebSourceComparisonError(code));
    const response = await fetch(base + path + "/sources/evidence", { method: "POST", headers: headers(), body: "{}" });
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: { code, message: new BookWebSourceComparisonError(code).message } });
  });

  it("returns a bounded unavailable error when the service is absent", async () => {
    await start(false);
    const response = await fetch(base + path + "/sources/evidence", { method: "POST", headers: headers(), body: "{}" });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "BOOK_COMPARISON_UNAVAILABLE" } });
    expect(provider).not.toHaveBeenCalled();
  });

  it("does not disclose unexpected prompt, provider or database errors", async () => {
    await start();
    vi.spyOn(comparison, "compare").mockRejectedValueOnce(new Error("PRIVATE_PROMPT SELECT database API_KEY=secret"));
    const response = await fetch(base + path + "/sources/evidence", { method: "POST", headers: headers(), body: "{}" });
    expect(response.status).toBe(503);
    const output = await response.text();
    expect(output).toContain("BOOK_COMPARISON_UNAVAILABLE");
    expect(output).not.toMatch(/PRIVATE|SELECT|database|API_KEY|secret/);
  });

  it("cancels one provider operation on disconnect and discards its late successful result", async () => {
    await start();
    const reads = await readSnapshots();
    let began!: () => void, cancelled!: () => void;
    const started = new Promise<void>(resolve => { began = resolve; });
    const stopped = new Promise<void>(resolve => { cancelled = resolve; });
    provider.mockImplementationOnce((_messages, options) => new Promise(resolve => {
      options?.signal?.addEventListener("abort", () => {
        cancelled();
        resolve({ ok: true, model: "late-fixture", content: JSON.stringify(selection()) });
      }, { once: true });
      began();
    }));
    const controller = new AbortController();
    const pending = fetch(base + path + "/sources/evidence", { method: "POST", headers: headers(), signal: controller.signal,
      body: JSON.stringify({ snapshotTokens: reads.map(read => read.snapshotToken), question: "问题" }) });
    await started;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await stopped;
    expect(provider).toHaveBeenCalledOnce();
    expect(provider.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });
});
