import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGoogleOwnerRequestAuthorizer } from "../auth/google-owner-request.js";
import { readGoogleSessionAuthConfig } from "../auth/config.js";
import { issueWebSession } from "../auth/web-session.js";
import { createBookWebResearchRouter } from "./book-web-research-routes.js";
import { createBookWebSourceReader, type BookWebSourceFetcher } from "./book-web-source.js";
import { createBookWebSourceEvidenceService, BookWebSourceEvidenceError } from "./book-web-source-evidence.js";
import type { chatCompletion } from "./minimax.js";

const SECRET = "disposable-book-source-evidence-secret-48-characters";
const ORIGIN = "https://books.example.test", BOOK = "10000001_000000000001", OTHER = "10000002_000000000002";
const path = "/api/ai/books/" + BOOK + "/research", sourceUrl = "https://example.org/source";
const config = readGoogleSessionAuthConfig({ NODE_ENV: "production", GOOGLE_AUTH_ENABLED: "true",
  GOOGLE_CLIENT_ID: "test.apps.googleusercontent.com", BOOK_ID_SEARCH_OWNER_GOOGLE_SUB: "test-owner",
  BOOK_ID_SEARCH_SESSION_SECRET: SECRET, BOOK_ID_SEARCH_PUBLIC_ORIGIN: ORIGIN });
let server: Server | undefined, base: string, readToken: string;
let reader: ReturnType<typeof createBookWebSourceReader>, evidence: ReturnType<typeof createBookWebSourceEvidenceService>;
let fetchPage: ReturnType<typeof vi.fn<BookWebSourceFetcher>>, provider: ReturnType<typeof vi.fn<typeof chatCompletion>>;
const research = { research: vi.fn() };
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
    service: research, sourceReader: reader, ...(withService ? { sourceEvidence: evidence } : {}),
    requestAuthorizer: createGoogleOwnerRequestAuthorizer(config),
  }));
  app.use(express.json({ limit: "256kb" }));
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server!.once("listening", resolve));
  base = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
}
async function readSnapshot() {
  const response = await fetch(base + path + "/source", { method: "POST", headers: headers(),
    body: JSON.stringify({ sourceToken: readToken }) });
  expect(response.status).toBe(200);
  return response.json();
}
beforeEach(() => {
  fetchPage = vi.fn<BookWebSourceFetcher>().mockResolvedValue({ finalUrl: sourceUrl, contentType: "text/plain",
    body: Buffer.from("来源记载1935年；另一段资料记载1937年，二者关系未交代。") });
  reader = createBookWebSourceReader({ fetchPage });
  readToken = reader.issueToken(BOOK, { id: "W1", title: "合成来源", url: sourceUrl })!;
  provider = vi.fn<typeof chatCompletion>().mockResolvedValue({ ok: true, model: "fixture",
    content: JSON.stringify({ passageIds: ["P1"], insufficientEvidence: false }) });
  evidence = createBookWebSourceEvidenceService({ getSnapshot: reader.getSnapshot, provider, isEnabled: () => true });
  research.research.mockReset();
});
afterEach(async () => {
  if (server) await new Promise<void>(resolve => { server!.closeAllConnections(); server!.close(() => resolve()); });
  server = undefined;
});

describe("source evidence authenticated HTTP boundary", () => {
  it("requires the owner session, Origin and CSRF before body parsing or model use", async () => {
    await start();
    for (const extra of [{}, { authorization: "Bearer legacy" }, { cookie: session("different-owner").cookie },
      { cookie: session("test-owner", true).cookie }]) {
      const response = await fetch(base + path + "/source/evidence", { method: "POST",
        headers: { ...extra, "content-type": "application/json" }, body: "{PRIVATE_MALFORMED" });
      expect(response.status).toBe(401);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("vary")).toContain("Cookie");
    }
    const owner = session();
    for (const extra of [{}, { origin: ORIGIN }, { "x-csrf-token": owner.csrf },
      { origin: "https://wrong.example.test", "x-csrf-token": owner.csrf }]) {
      const response = await fetch(base + path + "/source/evidence", { method: "POST",
        headers: { cookie: owner.cookie, "content-type": "application/json", ...extra }, body: "{}" });
      expect(response.status).toBe(403);
    }
    expect(provider).not.toHaveBeenCalled();
    expect(fetchPage).not.toHaveBeenCalled();
    expect(research.research).not.toHaveBeenCalled();
  });

  it("uses the actual read snapshot once and returns only exact original slices with provenance", async () => {
    await start();
    const read = await readSnapshot();
    expect(read.snapshotToken).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(provider).not.toHaveBeenCalled();
    const response = await fetch(base + path + "/source/evidence", { method: "POST", headers: headers(),
      body: JSON.stringify({ snapshotToken: read.snapshotToken, question: "  年份是什么？  " }) });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const result = await response.json();
    expect(result).toMatchObject({ bookId: BOOK, sourceId: "W1", snapshotToken: read.snapshotToken,
      mode: "source_passages", status: "selected", question: "年份是什么？", requestedUrl: sourceUrl,
      finalUrl: read.finalUrl, fetchedAt: read.fetchedAt, sourceTruncated: false });
    expect(result.passages).toEqual([{ id: "P1", start: 0, end: read.text.length, text: read.text }]);
    expect(fetchPage).toHaveBeenCalledOnce();
    expect(provider).toHaveBeenCalledOnce();
    expect(research.research).not.toHaveBeenCalled();
  });

  it("rejects malformed/oversized JSON and client material before model use", async () => {
    await start();
    for (const body of ["{PRIVATE_MALFORMED", JSON.stringify({ snapshotToken: "x".repeat(20_000) }),
      JSON.stringify({ snapshotToken: "x".repeat(32), question: "问题", text: "CLIENT_TEXT" }),
      JSON.stringify({ snapshotToken: "x".repeat(32), question: "问题", url: sourceUrl })]) {
      const response = await fetch(base + path + "/source/evidence", { method: "POST", headers: headers(), body });
      expect(response.status).toBe(400);
      const output = await response.text();
      expect(output).toContain("BOOK_EVIDENCE_INVALID_INPUT");
      expect(output).not.toMatch(/PRIVATE_MALFORMED|CLIENT_TEXT/);
    }
    expect(fetchPage).not.toHaveBeenCalled();
    expect(provider).not.toHaveBeenCalled();
  });

  it("rejects a lost snapshot and a snapshot belonging to another book; GET never selects", async () => {
    await start();
    const read = await readSnapshot();
    for (const [requestPath, snapshotToken, status, code] of [
      [path, "a".repeat(32), 410, "BOOK_EVIDENCE_EXPIRED"],
      [path.replace(BOOK, OTHER), read.snapshotToken, 400, "BOOK_EVIDENCE_INVALID_INPUT"],
    ] as const) {
      const response = await fetch(base + requestPath + "/source/evidence", { method: "POST", headers: headers(),
        body: JSON.stringify({ snapshotToken, question: "问题" }) });
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ error: { code } });
    }
    expect((await fetch(base + path + "/source/evidence", { headers: headers() })).status).toBe(404);
    expect(provider).not.toHaveBeenCalled();
    expect(fetchPage).toHaveBeenCalledOnce();
  });

  it.each([
    ["BOOK_EVIDENCE_INVALID_OUTPUT", 502], ["BOOK_EVIDENCE_UNAVAILABLE", 503], ["BOOK_EVIDENCE_TIMEOUT", 504],
  ] as const)("returns the canonical %s error as %i", async (code, status) => {
    await start();
    vi.spyOn(evidence, "find").mockRejectedValueOnce(new BookWebSourceEvidenceError(code));
    const response = await fetch(base + path + "/source/evidence", { method: "POST", headers: headers(),
      body: JSON.stringify({ snapshotToken: "a".repeat(32), question: "问题" }) });
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: { code, message: new BookWebSourceEvidenceError(code).message } });
  });

  it("keeps unexpected errors and missing service details out of the response", async () => {
    await start(false);
    const response = await fetch(base + path + "/source/evidence", { method: "POST", headers: headers(), body: "{}" });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "BOOK_EVIDENCE_UNAVAILABLE" } });
    expect(provider).not.toHaveBeenCalled();
  });

  it("does not disclose unexpected provider/prompt/database errors", async () => {
    await start();
    vi.spyOn(evidence, "find").mockRejectedValueOnce(new Error("PRIVATE_PROMPT SELECT database API_KEY=secret"));
    const response = await fetch(base + path + "/source/evidence", { method: "POST", headers: headers(), body: "{}" });
    expect(response.status).toBe(503);
    const output = await response.text();
    expect(output).toContain("BOOK_EVIDENCE_UNAVAILABLE");
    expect(output).not.toMatch(/PRIVATE|SELECT|database|API_KEY|secret/);
  });

  it("cancels provider work on disconnect and discards a late successful provider result", async () => {
    await start();
    const read = await readSnapshot();
    let began!: () => void, cancelled!: () => void;
    const started = new Promise<void>(resolve => { began = resolve; });
    const stopped = new Promise<void>(resolve => { cancelled = resolve; });
    provider.mockImplementationOnce((_messages, options) => new Promise(resolve => {
      options?.signal?.addEventListener("abort", () => {
        cancelled();
        resolve({ ok: true, model: "late-fixture", content: JSON.stringify({ passageIds: ["P1"], insufficientEvidence: false }) });
      }, { once: true });
      began();
    }));
    const controller = new AbortController();
    const pending = fetch(base + path + "/source/evidence", { method: "POST", headers: headers(), signal: controller.signal,
      body: JSON.stringify({ snapshotToken: read.snapshotToken, question: "问题" }) });
    await started;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await stopped;
    expect(provider).toHaveBeenCalledOnce();
    expect(provider.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(fetchPage).toHaveBeenCalledOnce();
  });
});
