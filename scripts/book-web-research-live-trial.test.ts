import { describe, expect, it, vi } from "vitest";
import { captureBookWebResearchTrial, parseBookWebResearchTrialArgs } from "./book-web-research-live-trial.js";
import type { chatCompletion } from "../apps/api/src/ai/minimax.js";
import type { searchMiniMaxWeb } from "../apps/api/src/ai/minimax-web-search.js";
import { BookWebSourceError, type BookWebSourceFetcher } from "../apps/api/src/ai/book-web-source.js";

const valid = ["--book-id", "10118949_000001131331", "--query", "中国古代旅行之研究", "--question", " 查找本书相关研究 "];
describe("live web-research trial input before external IO", () => {
  it("requires an exact book identity, public query and explicit question", () => {
    expect(parseBookWebResearchTrialArgs(valid)).toEqual({ bookId: valid[1], query: valid[3], question: "查找本书相关研究", outDir: "progress/book-web-research-live" });
  });
  it.each([[], valid.slice(0, 4), [...valid, "--question", "second"], [...valid, "--api-key", "not-an-accepted-argument"], [...valid, "--out"]].map(args => ({ args })))("rejects incomplete, repeated or credential-bearing options", ({ args }) => {
    expect(() => parseBookWebResearchTrialArgs(args)).toThrow("BOOK_RESEARCH_TRIAL_INVALID_ARGUMENTS");
  });
  it("rejects oversized questions and invalid catalog identities", () => {
    expect(() => parseBookWebResearchTrialArgs([...valid.slice(0, -1), "x".repeat(1001)])).toThrow();
    expect(() => parseBookWebResearchTrialArgs(["--book-id", "not-a-catalog-id", ...valid.slice(2)])).toThrow();
  });
  it("allows an explicit strict scope and bounded opt-in reads", () => {
    expect(parseBookWebResearchTrialArgs([...valid, "--scope", "direct_book_review", "--read-first", "1"]))
      .toMatchObject({ scope: "direct_book_review", readFirst: 1 });
    expect(parseBookWebResearchTrialArgs([...valid, "--read-first", "0"])).toMatchObject({ readFirst: 0 });
  });
  it.each([["--scope", "general"], ["--read-first", "4"], ["--read-first", "-1"], ["--read-first", "1.5"],
    ["--read-first", "01"], ["--scope", "direct_book_review", "--scope", "direct_book_review"]])("rejects invalid options %j", (...extra) => {
    expect(() => parseBookWebResearchTrialArgs([...valid, ...extra])).toThrow();
  });
});

function setup() {
  const book = { id: valid[1], ssid: "10118949", dxid: "000001131331", title: "中国古代旅行之研究",
    author: "张三", publisher: "测试出版社", year: 2010, pages: 120, isbn: "9787532756728",
    rawInfo: "PRIVATE_CATALOG_UNUSED" };
  const results = [
    { title: "《中国古代旅行之研究》书评", url: "https://example.org/review", excerpt: "张三。书评：讨论本书的论证与材料。", pageAge: null },
    { title: "中国古代旅行之研究 正版图书 书评", url: "https://example.org/store", excerpt: "张三 ISBN 9787532756728 加入购物车", pageAge: null },
    { title: "其他书目", url: "https://example.org/catalog", excerpt: "目录。", pageAge: null },
  ];
  const searchResult = { ok: true as const, queries: ["中国古代旅行之研究 张三 书评"], searchCalls: 1, results };
  const search = vi.fn<typeof searchMiniMaxWeb>().mockResolvedValue(searchResult);
  const provider = vi.fn<typeof chatCompletion>().mockResolvedValue({
    ok: true, model: "fixture", content: JSON.stringify({ sourceIds: ["W1"], insufficientEvidence: false }),
  });
  const fetchPage = vi.fn<BookWebSourceFetcher>().mockImplementation(async url => ({
    finalUrl: url, contentType: "text/html",
    body: Buffer.from("<html><title>网页标题</title><article><p>网页里的原始评论文字。</p></article></html>"),
  }));
  const getCatalogDocument = vi.fn().mockResolvedValue(book);
  const args = parseBookWebResearchTrialArgs([...valid, "--scope", "direct_book_review"]);
  return { book, results, searchResult, search, provider, fetchPage, getCatalogDocument, args };
}
describe("actual research and reader stage capture", () => {
  it.each([99, Infinity, -1, NaN, 1.5])("rejects exported-call read budget %s before IO", async readFirst => {
    const s = setup();
    await expect(captureBookWebResearchTrial({ ...s.args, readFirst }, s)).rejects.toThrow("BOOK_RESEARCH_TRIAL_INVALID_ARGUMENTS");
    expect(s.getCatalogDocument).not.toHaveBeenCalled();
    expect(s.search).not.toHaveBeenCalled();
    expect(s.provider).not.toHaveBeenCalled();
    expect(s.fetchPage).not.toHaveBeenCalled();
  });
  it("preserves the client return and exact selector input separately from final filtered IDs", async () => {
    const s = setup();
    s.results[0].excerpt += "补充".repeat(2000);
    s.provider.mockResolvedValueOnce({ ok: true, model: "fixture", content: '{"sourceIds":["W2"],"insufficientEvidence":false}' });
    const r = await captureBookWebResearchTrial(s.args, s);
    expect(r.status).toBe("INSUFFICIENT_SOURCES");
    expect(r.trace.search_client_result).toEqual(s.searchResult);
    expect(r.trace.selector_input).toEqual(JSON.parse(s.provider.mock.calls[0][0][1].content));
    expect((r.trace.selector_input as any).sources[0].excerpt).toHaveLength(3000);
    expect(r.trace.selector_result).toMatchObject({ ok: true, content: '{"sourceIds":["W2"],"insufficientEvidence":false}' });
    expect(r.response?.citedSourceIds).toEqual([]);
    expect(r.response?.sources).toHaveLength(3);
    expect(r.counts).toMatchObject({ public_catalog: 1, search_requests: 1, selection_requests: 1, page_read_attempts: 0, page_fetch_calls: 0 });
    expect(s.fetchPage).not.toHaveBeenCalled();
    expect(JSON.stringify(r)).not.toContain("PRIVATE_CATALOG_UNUSED");
    expect(s.search.mock.calls[0][0][0].content).toContain("严格查找");
  });
  it("leaves general research behavior intact and performs no read by default", async () => {
    const s = setup();
    s.provider.mockResolvedValueOnce({ ok: true, model: "fixture", content: '{"sourceIds":["W2"],"insufficientEvidence":false}' });
    const r = await captureBookWebResearchTrial(parseBookWebResearchTrialArgs(valid), s);
    expect(r.research_scope).toBe("general");
    expect(r.response?.scope).toBeUndefined();
    expect(r.response?.citedSourceIds).toEqual(["W2"]);
    expect(s.fetchPage).not.toHaveBeenCalled();
  });
  it("reads the fixed returned prefix even when not recommended and removes bearer tokens", async () => {
    const s = setup();
    s.provider.mockResolvedValueOnce({ ok: true, model: "fixture", content: '{"sourceIds":[],"insufficientEvidence":true}' });
    const r = await captureBookWebResearchTrial({ ...s.args, readFirst: 1 }, s);
    expect(r.response?.citedSourceIds).toEqual([]);
    expect(s.fetchPage).toHaveBeenCalledOnce();
    expect(s.fetchPage.mock.calls[0][0]).toBe(s.results[0].url);
    expect(r.reads).toMatchObject([{ sourceId: "W1", status: "READ", response: {
      text: "网页里的原始评论文字。", requestedUrl: s.results[0].url, finalUrl: s.results[0].url,
    } }]);
    expect(JSON.stringify(r)).not.toMatch(/readToken|snapshotToken/);
  });
  it("retains a failed first read without trying the next result or losing the search", async () => {
    const s = setup();
    s.fetchPage.mockRejectedValueOnce(new BookWebSourceError("BOOK_SOURCE_TIMEOUT"));
    const r = await captureBookWebResearchTrial({ ...s.args, readFirst: 1 }, s);
    expect(r.reads).toEqual([{ sourceId: "W1", status: "FAILED", error_code: "BOOK_SOURCE_TIMEOUT" }]);
    expect(s.fetchPage).toHaveBeenCalledOnce();
    expect(r.read_summary).toEqual({ requested_limit: 1, attempted: 1, succeeded: 0, failed: 1 });
    expect(r.response?.sources).toHaveLength(3);
    expect(r.response?.citedSourceIds).toEqual(["W1"]);
  });
  it("records a blocked fixed-prefix URL instead of substituting another source", async () => {
    const s = setup(); s.results[0].url = "http://127.0.0.1/denied";
    const r = await captureBookWebResearchTrial({ ...s.args, readFirst: 1 }, s);
    expect(r.reads).toEqual([{ sourceId: "W1", status: "FAILED", error_code: "BOOK_SOURCE_BLOCKED" }]);
    expect(r.counts.page_read_attempts).toBe(1);
    expect(s.fetchPage).not.toHaveBeenCalled();
  });
  it("captures provider failures without private error text, retries or invented sources", async () => {
    const s = setup();
    s.search.mockResolvedValueOnce({ ok: false, status: 503, error: "PRIVATE_PROVIDER_TOKEN" });
    const r = await captureBookWebResearchTrial({ ...s.args, readFirst: 1 }, s);
    expect(r.status).toBe("FAILED");
    expect(r.error_code).toBe("BOOK_RESEARCH_UNAVAILABLE");
    expect(r.trace.search_client_result).toEqual({ ok: false, status: 503 });
    expect(r.response).toBeNull();
    expect(s.search).toHaveBeenCalledOnce();
    expect(s.provider).not.toHaveBeenCalled();
    expect(s.fetchPage).not.toHaveBeenCalled();
    expect(JSON.stringify(r)).not.toContain("PRIVATE_PROVIDER_TOKEN");
  });
  it.each(["returned", "thrown"])("retains search snapshots when selection has a %s failure", async how => {
    const s = setup();
    if (how === "returned") s.provider.mockResolvedValueOnce({ ok: false, status: 502, error: "PRIVATE_SELECTION_TOKEN" });
    else s.provider.mockRejectedValueOnce(new Error("PRIVATE_SELECTION_TOKEN"));
    const r = await captureBookWebResearchTrial(s.args, s);
    expect(r.status).toBe("SOURCES_AVAILABLE_SELECTION_UNFINISHED");
    expect(r.response?.sources).toHaveLength(3);
    expect(r.trace.selector_input).not.toBeNull();
    expect(r.trace.selector_result).toEqual(how === "returned" ? { ok: false, status: 502 } : { ok: false, threw: true });
    expect(s.provider).toHaveBeenCalledOnce();
    expect(JSON.stringify(r)).not.toContain("PRIVATE_SELECTION_TOKEN");
  });
  it("records an invalid selector reply verbatim without claiming it was a valid selection", async () => {
    const s = setup(); s.provider.mockResolvedValueOnce({ ok: true, model: "fixture", content: '{"sourceIds":["W99"],"insufficientEvidence":false}' });
    const r = await captureBookWebResearchTrial(s.args, s);
    expect(r.status).toBe("SOURCES_AVAILABLE_SELECTION_UNFINISHED");
    expect(r.trace.selector_result).toMatchObject({ content: '{"sourceIds":["W99"],"insufficientEvidence":false}' });
    expect(r.response?.citedSourceIds).toEqual([]);
  });
  it("makes no provider request if the catalog is missing, and no selector request for zero sources", async () => {
    const missing = setup(); missing.getCatalogDocument.mockRejectedValueOnce({ code: "document_not_found" });
    const a = await captureBookWebResearchTrial(missing.args, missing);
    expect(a.error_code).toBe("BOOK_RESEARCH_BOOK_NOT_FOUND");
    expect(missing.search).not.toHaveBeenCalled();
    const empty = setup(); empty.search.mockResolvedValueOnce({ ...empty.searchResult, results: [] });
    const b = await captureBookWebResearchTrial(empty.args, empty);
    expect(b.status).toBe("INSUFFICIENT_SOURCES");
    expect(b.response?.sources).toEqual([]);
    expect(empty.provider).not.toHaveBeenCalled();
  });
});
