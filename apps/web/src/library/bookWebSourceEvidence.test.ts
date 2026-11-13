import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetWebAuthStoreForTests, __setWebAuthSnapshotForTests, ensureAuthSessionLoaded } from "../auth/session";
import type { BookWebResearchSource } from "./bookWebResearch";
import type { BookWebSourceReadResponse } from "./bookWebSourceReader";
import {
  assertBookWebSourceEvidenceResponse, bookWebSourceEvidenceContent, findBookWebSourceEvidence,
  type BookWebSourceEvidenceResponse,
} from "./bookWebSourceEvidence";

vi.mock("../auth/session", async original => ({ ...await original<typeof import("../auth/session")>(), ensureAuthSessionLoaded: vi.fn(async () => {}) }));

const A = "14000000_000000000001", B = "14000001_000000000002", QUESTION = "这段网页如何描述旅行？";
const source: BookWebResearchSource = {
  id: "W1", kind: "web", title: "馆藏目录", url: "https://catalog.example.test/books/1", excerpt: "搜索时节选",
  pageAge: null, truncated: false, readToken: "A".repeat(32),
};
const snapshot = (): BookWebSourceReadResponse => ({
  bookId: A, sourceId: source.id, requestedUrl: source.url, finalUrl: source.url + "/readable", title: "目录正文",
  text: "前文。😀旅行的原句。\n\n<script>文字不是脚本</script>\n\n结束。",
  contentType: "text/html", extraction: "html_readable_text", truncated: true,
  fetchedAt: "2026-11-13T12:00:00.000Z", snapshotToken: "S".repeat(32),
});
function result(): BookWebSourceEvidenceResponse {
  const read = snapshot(), start = read.text.indexOf("😀"), end = read.text.indexOf("\n\n");
  return {
    bookId: A, sourceId: source.id, snapshotToken: read.snapshotToken!, question: QUESTION,
    mode: "source_passages", status: "selected", requestedUrl: read.requestedUrl, finalUrl: read.finalUrl,
    title: read.title, fetchedAt: read.fetchedAt, sourceTruncated: read.truncated,
    passages: [{ id: "P2", start, end, text: read.text.slice(start, end) }], generatedAt: "2026-11-13T12:01:00.000Z",
  };
}
const fetchMock = vi.fn<typeof fetch>();
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
function login(csrfToken: string | null = "synthetic-current-csrf") {
  __setWebAuthSnapshotForTests({ status: "authenticated", user: { email: "owner@example.test", name: "合成账号" }, csrfToken, error: null });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>(done => { resolve = done; }), resolve };
}
beforeEach(() => {
  vi.clearAllMocks(); __resetWebAuthStoreForTests(); login(); fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); __resetWebAuthStoreForTests(); });

describe("book webpage evidence client", () => {
  it("posts only the snapshot token and trimmed question with the current session, CSRF and no-store", async () => {
    fetchMock.mockResolvedValue(json(result()));
    const controller = new AbortController();
    expect(await findBookWebSourceEvidence(snapshot(), source, "  " + QUESTION + "\n", controller.signal)).toEqual(result());
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/ai/books/" + A + "/research/source/evidence");
    expect(options).toMatchObject({ method: "POST", credentials: "same-origin", cache: "no-store", signal: controller.signal });
    expect(new Headers(options?.headers).get("x-csrf-token")).toBe("synthetic-current-csrf");
    expect(JSON.parse(String(options?.body))).toEqual({ snapshotToken: snapshot().snapshotToken, question: QUESTION });
    expect(String(options?.body)).not.toContain(source.url);
    expect(String(options?.body)).not.toContain(snapshot().text);
  });

  it("requires authentication and CSRF before submitting", async () => {
    __setWebAuthSnapshotForTests({ status: "unauthenticated", user: null, csrfToken: null, error: null });
    await expect(findBookWebSourceEvidence(snapshot(), source, QUESTION)).rejects.toMatchObject({ status: 401 });
    login(null);
    await expect(findBookWebSourceEvidence(snapshot(), source, QUESTION)).rejects.toMatchObject({ status: 403 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["", " ", "字".repeat(1001), "bad\ud800", "bad\0"])("rejects malformed or out-of-bound questions before fetching (%#)", async question => {
    await expect(findBookWebSourceEvidence(snapshot(), source, question)).rejects.toMatchObject({ status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each([undefined, "", "S".repeat(31), "+".repeat(32)])("requires a valid snapshot token (%#)", async snapshotToken => {
    await expect(findBookWebSourceEvidence({ ...snapshot(), snapshotToken }, source, QUESTION)).rejects.toMatchObject({ status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("rejects a snapshot from another source before sending", async () => {
    await expect(findBookWebSourceEvidence({ ...snapshot(), sourceId: "W2" }, source, QUESTION)).rejects.toMatchObject({ status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["book", { bookId: B }], ["source", { sourceId: "W2" }], ["snapshot", { snapshotToken: "T".repeat(32) }],
    ["question", { question: "另一个问题" }], ["mode", { mode: "generated_answer" }],
    ["requested URL", { requestedUrl: "https://elsewhere.example.test/" }], ["final URL", { finalUrl: source.url }],
    ["title", { title: "另一网页" }], ["read time", { fetchedAt: "2026-11-13T12:00:01.000Z" }],
    ["truncation", { sourceTruncated: false }], ["selection time", { generatedAt: "yesterday" }],
    ["freeform answer", { answer: "未经原文支持的事实" }], ["selected without passage", { passages: [] }],
    ["insufficient with passage", { status: "insufficient_evidence" }], ["unknown status", { status: "partial" }],
  ])("binds the response %s to the current read and question", async (_name, change) => {
    fetchMock.mockResolvedValue(json({ ...result(), ...change }));
    await expect(findBookWebSourceEvidence(snapshot(), source, QUESTION)).rejects.toMatchObject({ status: 502, code: "BOOK_EVIDENCE_INVALID_OUTPUT" });
  });

  it.each([
    ["generated text", { text: "模型改写的句子" }], ["off by one", { end: result().passages[0].end + 1 }],
    ["negative start", { start: -1 }], ["floating start", { start: 0.5 }], ["out of range", { end: 30001 }],
    ["empty range", { end: result().passages[0].start }], ["missing text", { text: undefined }],
    ["unpaired Unicode", { text: "\ud800" }], ["zero ID", { id: "P0" }], ["excessive ID", { id: "P65" }],
    ["leading zero ID", { id: "P02" }], ["freeform annotation", { comment: "模型结论" }],
  ])("rejects a passage with %s", (_name, change) => {
    const value = { ...result(), passages: [{ ...result().passages[0], ...change }] };
    expect(() => assertBookWebSourceEvidenceResponse(value, snapshot(), source, QUESTION)).toThrow();
  });

  it("rejects split surrogate pairs, overlapping or out-of-order slices and more than four slices", () => {
    const read = snapshot(), base = result().passages[0];
    for (const passages of [
      [{ ...base, start: base.start + 1, text: read.text.slice(base.start + 1, base.end) }],
      [{ ...base, end: base.start + 1, text: read.text.slice(base.start, base.start + 1) }],
      [base, { ...base, id: "P3" }],
      [{ id: "P3", start: 0, end: 3, text: read.text.slice(0, 3) }, base],
      Array.from({ length: 5 }, (_, i) => ({ id: "P" + (i + 1), start: i, end: i + 1, text: read.text.slice(i, i + 1) })),
    ]) expect(() => assertBookWebSourceEvidenceResponse({ ...result(), passages }, read, source, QUESTION)).toThrow();
  });

  it("accepts four exact ordered slices, including a full Unicode pair, and enforces 1200 UTF-16 units", () => {
    const read = { ...snapshot(), text: "😀" + "字".repeat(4798) };
    const passages = Array.from({ length: 4 }, (_, i) => ({ id: "P" + (i + 1), start: i * 1200, end: (i + 1) * 1200, text: read.text.slice(i * 1200, (i + 1) * 1200) }));
    expect(() => assertBookWebSourceEvidenceResponse({ ...result(), passages }, read, source, QUESTION)).not.toThrow();
    expect(() => assertBookWebSourceEvidenceResponse({ ...result(), passages: [{ id: "P1", start: 0, end: 1201, text: read.text.slice(0, 1201) }] }, read, source, QUESTION)).toThrow();
  });

  it("accepts an explicit insufficient result without creating any conclusion", async () => {
    const value = { ...result(), status: "insufficient_evidence", passages: [] };
    fetchMock.mockResolvedValue(json(value));
    expect(await findBookWebSourceEvidence(snapshot(), source, QUESTION)).toEqual(value);
  });

  it("copies verbatim original passages and source metadata without capability tokens", () => {
    const content = bookWebSourceEvidenceContent(result(), snapshot(), source);
    expect(content).toContain(result().passages[0].text);
    expect(content).toContain("[W1 / P2]");
    expect(content).toContain(snapshot().finalUrl);
    expect(content).toContain(snapshot().fetchedAt);
    expect(content).toContain("已截短");
    expect(content).not.toContain(snapshot().snapshotToken);
    expect(content).not.toContain(source.readToken);
    expect(() => bookWebSourceEvidenceContent({ ...result(), passages: [{ ...result().passages[0], text: "改写" }] }, snapshot(), source)).toThrow();
  });

  it.each([
    [400, "BOOK_EVIDENCE_INVALID_INPUT", "请填写"], [410, "BOOK_EVIDENCE_EXPIRED", "重新读取网页正文"],
    [502, "BOOK_EVIDENCE_INVALID_OUTPUT", "片段与当前网页不一致"], [502, "BOOK_EVIDENCE_UNAVAILABLE", "已读网页文字仍保留"],
    [503, "BOOK_EVIDENCE_UNAVAILABLE", "已读网页文字仍保留"], [504, "BOOK_EVIDENCE_TIMEOUT", "超时"],
    [429, "UNKNOWN_CODE", "稍后重试"],
  ])("maps %s %s to a fixed user-facing message", async (status, code, message) => {
    fetchMock.mockResolvedValue(json({ error: { code, message: "private provider diagnostic" } }, status));
    await expect(findBookWebSourceEvidence(snapshot(), source, QUESTION)).rejects.toMatchObject({ status, message: expect.stringContaining(message) });
  });
  it("refreshes an expired auth session without exposing upstream diagnostics", async () => {
    fetchMock.mockResolvedValue(json({ error: { code: "AUTH", message: "private diagnostic" } }, 401));
    await expect(findBookWebSourceEvidence(snapshot(), source, QUESTION)).rejects.toMatchObject({ status: 401, message: expect.stringContaining("登录已失效") });
    expect(ensureAuthSessionLoaded).toHaveBeenCalledOnce();
  });

  it("honors pre-abort and discards cancellation or session changes during JSON decoding", async () => {
    const cancelled = new AbortController(); cancelled.abort();
    await expect(findBookWebSourceEvidence(snapshot(), source, QUESTION, cancelled.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).not.toHaveBeenCalled();
    for (const change of ["cancel", "session"]) {
      const decoded = deferred<unknown>(), controller = new AbortController();
      fetchMock.mockResolvedValue({ ok: true, status: 200, json: () => decoded.promise } as Response);
      const pending = findBookWebSourceEvidence(snapshot(), source, QUESTION, controller.signal);
      await Promise.resolve();
      if (change === "cancel") controller.abort(); else login("new-csrf");
      decoded.resolve(result());
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    }
  });
});
