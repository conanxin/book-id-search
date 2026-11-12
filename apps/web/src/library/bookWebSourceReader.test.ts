import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetWebAuthStoreForTests, __setWebAuthSnapshotForTests } from "../auth/session";
import type { BookWebResearchSource } from "./bookWebResearch";
import { assertBookWebSourceReadResponse, bookWebSourceContent, readBookWebSource, type BookWebSourceReadResponse } from "./bookWebSourceReader";

vi.mock("../auth/session", async original => ({ ...await original<typeof import("../auth/session")>(), ensureAuthSessionLoaded: vi.fn(async () => {}) }));

const A = "14000000_000000000001", B = "14000001_000000000002";
const source: BookWebResearchSource = {
  id: "W1", kind: "web", title: "馆藏目录", url: "https://catalog.example.test/books/1", excerpt: "搜索时节选", pageAge: null,
  truncated: false, readToken: "A".repeat(32),
};
const fetchMock = vi.fn<typeof fetch>();
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const result = (): BookWebSourceReadResponse => ({
  bookId: A, sourceId: "W1", requestedUrl: source.url, finalUrl: "https://catalog.example.test/edition/1", title: "目录正文",
  text: "第一段可读文字。\n\n第二段保留换行。", contentType: "text/html", extraction: "html_readable_text",
  truncated: false, fetchedAt: "2026-11-12T12:00:00.000Z",
});
function login(csrfToken: string | null = "synthetic-current-csrf") {
  __setWebAuthSnapshotForTests({ status: "authenticated", user: { email: "owner@example.test", name: "合成账号" }, csrfToken, error: null });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>(done => { resolve = done; }), resolve };
}

beforeEach(() => { __resetWebAuthStoreForTests(); login(); fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); __resetWebAuthStoreForTests(); });

describe("book webpage source reader client", () => {
  it("submits only the bound source token with current session and CSRF", async () => {
    const controller = new AbortController(); fetchMock.mockResolvedValue(json(result()));
    expect(await readBookWebSource(A, source, controller.signal)).toEqual(result());
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe(`/api/ai/books/${A}/research/source`);
    expect(options).toMatchObject({ method: "POST", credentials: "same-origin", cache: "no-store", signal: controller.signal });
    expect(JSON.parse(String(options?.body))).toEqual({ sourceToken: source.readToken });
    expect(new Headers(options?.headers).get("x-csrf-token")).toBe("synthetic-current-csrf");
    expect(String(options?.body)).not.toContain(source.url);
  });

  it("requires a current Google session and CSRF before reading", async () => {
    __setWebAuthSnapshotForTests({ status: "unauthenticated", user: null, csrfToken: null, error: null });
    await expect(readBookWebSource(A, source)).rejects.toMatchObject({ status: 401 });
    login(null); await expect(readBookWebSource(A, source)).rejects.toMatchObject({ status: 403 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([undefined, "", "A".repeat(31), "A".repeat(33), "+".repeat(32)])("rejects a missing or malformed source token %s", async readToken => {
    await expect(readBookWebSource(A, { ...source, readToken })).rejects.toMatchObject({ status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects invalid book and source identities before fetching", async () => {
    await expect(readBookWebSource(`${A}/other`, source)).rejects.toMatchObject({ status: 400 });
    await expect(readBookWebSource(A, { ...source, id: "W99" })).rejects.toMatchObject({ status: 400 });
    await expect(readBookWebSource(A, { ...source, url: "javascript:alert(1)" })).rejects.toMatchObject({ status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["other book", { bookId: B }], ["other source", { sourceId: "W2" }],
    ["different requested URL", { requestedUrl: "https://other.example.test/1" }],
    ["unsafe final URL", { finalUrl: "javascript:alert(1)" }],
    ["credentials in final URL", { finalUrl: "https://user:pass@example.test/1" }],
    ["empty text", { text: " " }], ["oversized text", { text: "字".repeat(30001) }],
    ["invalid Unicode", { text: "bad\ud800" }], ["NUL text", { text: "bad\0" }],
    ["oversized title", { title: "字".repeat(301) }], ["invalid time", { fetchedAt: "yesterday" }],
    ["PDF", { contentType: "application/pdf" }], ["mismatched extraction", { extraction: "plain_text" }],
    ["missing truncation state", { truncated: undefined }],
  ])("rejects %s before exposing retrieved text", async (_name, changes) => {
    fetchMock.mockResolvedValue(json({ ...result(), ...changes }));
    await expect(readBookWebSource(A, source)).rejects.toMatchObject({ status: 502 });
  });

  it.each([
    ["text/html", "html_readable_text"], ["application/xhtml+xml", "html_readable_text"], ["text/plain", "plain_text"],
  ])("accepts the declared %s extraction and exact text bound", (contentType, extraction) => {
    const value = { ...result(), contentType, extraction, text: "字".repeat(30000) };
    expect(() => assertBookWebSourceReadResponse(value, A, source)).not.toThrow();
  });

  it.each([
    [400, "BOOK_SOURCE_BLOCKED", "这个地址不支持直接读取"],
    [410, "BOOK_SOURCE_EXPIRED", "请重新联网查资料"],
    [413, "BOOK_SOURCE_TOO_LARGE", "内容过大"],
    [415, "BOOK_SOURCE_UNSUPPORTED", "不支持读取这类链接"],
    [422, "BOOK_SOURCE_UNREADABLE", "没有可提取的文字"],
    [502, "BOOK_SOURCE_UNAVAILABLE", "暂时无法读取"],
    [504, "BOOK_SOURCE_TIMEOUT", "读取超时"],
  ])("maps %s %s to a bounded message", async (status, code, message) => {
    fetchMock.mockResolvedValue(json({ error: { code, message: "private upstream diagnostic" } }, status));
    await expect(readBookWebSource(A, source)).rejects.toMatchObject({ status, code, message: expect.stringContaining(message) });
  });

  it("does not expose unknown provider errors or network details", async () => {
    fetchMock.mockResolvedValueOnce(json({ error: { code: "PRIVATE_STACK", message: "private diagnostic" } }, 502));
    await expect(readBookWebSource(A, source)).rejects.toMatchObject({ status: 502, code: undefined, message: "暂时无法读取这个网页，可重试或打开原网页。" });
    fetchMock.mockRejectedValueOnce(new Error("private socket information"));
    await expect(readBookWebSource(A, source)).rejects.toMatchObject({ message: "暂时无法读取这个网页，可重试或打开原网页。" });
  });

  it("copies extracted text with source identity, redirect and read time, but no token or search excerpt", () => {
    const value = { ...result(), truncated: true, text: "<script>来源中的文字</script>\n**保留原符号**" };
    const copied = bookWebSourceContent(value, source);
    for (const expected of [value.text, "[W1]", value.requestedUrl, value.finalUrl, value.fetchedAt, "本次提取已截短", "网页可读文字（自动提取）"]) expect(copied).toContain(expected);
    expect(copied).not.toContain(source.readToken); expect(copied).not.toContain(source.excerpt);
    expect(() => bookWebSourceContent({ ...value, sourceId: "W2" }, source)).toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not fetch a cancelled request", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(readBookWebSource(A, source, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("discards late text even when transport ignores cancellation", async () => {
    const pending = deferred<Response>(), controller = new AbortController(); fetchMock.mockReturnValue(pending.promise);
    const request = readBookWebSource(A, source, controller.signal);
    const rejected = expect(request).rejects.toMatchObject({ name: "AbortError" });
    controller.abort(); pending.resolve(json(result())); await rejected;
  });

  it("discards decoded content when the session changes", async () => {
    const pending = deferred<unknown>(), decoding = deferred<void>();
    fetchMock.mockResolvedValue({ ok: true, json: () => { decoding.resolve(); return pending.promise; } } as Response);
    const request = readBookWebSource(A, source), rejected = expect(request).rejects.toMatchObject({ name: "AbortError" });
    await decoding.promise; login("replacement-csrf"); pending.resolve(result()); await rejected;
  });
});
