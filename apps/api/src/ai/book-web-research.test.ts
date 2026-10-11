import { describe, expect, it, vi } from "vitest";
import { createBookWebResearchService, type BookWebResearchSource } from "./book-web-research.js";
import type { chatCompletion, ChatMessage } from "./minimax.js";
import type { searchMiniMaxWeb, MiniMaxWebSearchResponse } from "./minimax-web-search.js";

const A = "10000001_000000000001", B = "10000002_000000000002";
const date = "2026-10-11T12:00:00.000Z";
const question = "这本书的研究背景和相关资料是什么？";
const catalog = { id: A, title: "运河田野调查", author: "合成作者", publisher: "测试出版社", year: 2020, pages: 300, isbn: "test-isbn",
  rawInfo: "RAW_INFO_EXCLUDED", introduction: "PERSONAL_INTRODUCTION_EXCLUDED", notes: ["PERSONAL_NOTE_EXCLUDED"],
  resources: [{ url: "https://private-resource.example.test/book.pdf" }], privateMetadata: "PRIVATE_METADATA_EXCLUDED" };
function searchResult(): Extract<MiniMaxWebSearchResponse, { ok: true }> {
  return { ok: true, queries: ["运河田野调查 合成作者"], searchCalls: 1, results: [
    { title: "出版社介绍", url: "https://publisher.example.test/book#overview", excerpt: "出版社说明本书讨论河道、渡口及地方交通调查。", pageAge: "2026-09-01" },
    { title: "图书馆目录", url: "https://library.example.test/catalog", excerpt: "馆藏目录记录该书的版本与目录信息。", pageAge: null },
  ] };
}
const selectionObject = (sourceIds = ["W1", "W2"]) => ({ sourceIds, insufficientEvidence: false });
function setup(enabled = true) {
  const getCatalogDocument = vi.fn().mockResolvedValue(structuredClone(catalog));
  const search = vi.fn<typeof searchMiniMaxWeb>().mockResolvedValue(searchResult());
  const provider = vi.fn<typeof chatCompletion>().mockResolvedValue({ ok: true, model: "fixture", content: JSON.stringify(selectionObject()) });
  const service = createBookWebResearchService({ getCatalogDocument, search, provider, isEnabled: () => enabled, now: () => new Date(date) });
  return { getCatalogDocument, search, provider, service };
}
function userPayload(messages: ChatMessage[]) { return JSON.parse(messages.find(message => message.role === "user")!.content); }

describe("book internet research evidence and read-only scope", () => {
  it("searches the selected public book once, selects real source IDs, and returns fixed copy plus unchanged source snapshots", async () => {
    const s = setup();
    s.search.mockResolvedValueOnce({ ...searchResult(), content: "UNTRUSTED_SEARCH_STAGE_PROSE" } as MiniMaxWebSearchResponse);
    const result = await s.service.research(A, { question: `  ${question}  ` });
    expect(result).toMatchObject({ bookId: A, question, mode: "source_excerpts", source: "web_research", generatedAt: date,
      search: { performed: true, queries: ["运河田野调查 合成作者"], calls: 1 }, citedSourceIds: ["W1", "W2"] });
    expect(result.draft).toEqual({ title: "查到的相关资料",
      content: "已根据本次问题选出相关网页，以下保留搜索工具返回的来源节选。节选不等于网页或原书全文；来源之间可能有不同说法。\n\n建议先查看：[W1] [W2]" });
    expect(result.sources.map(source => source.id)).toEqual(["W1", "W2"]);
    expect(result.sources[0]).toEqual({ id: "W1", kind: "web", title: "出版社介绍", url: "https://publisher.example.test/book",
      excerpt: searchResult().results[0].excerpt, pageAge: "2026-09-01", truncated: false });
    expect(s.getCatalogDocument).toHaveBeenCalledExactlyOnceWith(A);
    expect(s.search).toHaveBeenCalledOnce(); expect(s.provider).toHaveBeenCalledOnce();
    expect(userPayload(s.search.mock.calls[0][0])).toEqual({ book: { title: catalog.title, author: catalog.author,
      publisher: catalog.publisher, year: 2020, pages: 300, isbn: "test-isbn" }, question });
    const sent = userPayload(s.provider.mock.calls[0][0]);
    expect(sent.sources).toEqual(result.sources.map(({ id, title, url, excerpt, pageAge, truncated }) =>
      ({ id, title, site: new URL(url).hostname, excerpt, pageAge, truncated })));
    expect(JSON.stringify([s.search.mock.calls, s.provider.mock.calls, result])).not.toMatch(/RAW_INFO|PERSONAL_|PRIVATE_METADATA|private-resource|UNTRUSTED_SEARCH_STAGE_PROSE/);
    expect(s.provider.mock.calls[0][0][0].content).toContain("没有读取网页全文或整本书");
    expect(s.provider.mock.calls[0][1]).toMatchObject({ temperature: 0.2, maxTokens: 1024, timeoutMs: 60_000, requireCompleted: true });
    // The service has only a catalog reader and model calls: it has no
    // workspace, note, resource, WeRead, persistence or page-fetch adapter.
  });

  it("preserves actual repeated search queries instead of implying one query per webpage", async () => {
    const s = setup();
    s.search.mockResolvedValueOnce({ ...searchResult(), queries: ["运河田野调查", "运河田野调查"], searchCalls: 2 });
    const result = await s.service.research(A, { question });
    expect(result.search).toEqual({ performed: true, queries: ["运河田野调查", "运河田野调查"], calls: 2 });
    expect(s.search).toHaveBeenCalledOnce();
  });

  it("returns honest insufficiency after a completed empty search and does not spend a selection call", async () => {
    const s = setup();
    s.search.mockResolvedValueOnce({ ...searchResult(), results: [] });
    const result = await s.service.research(A, { question });
    expect(result).toMatchObject({ mode: "source_excerpts", source: "insufficient_sources", sources: [], citedSourceIds: [], search: { performed: true, calls: 1 } });
    expect(result.draft.content).toContain("已执行联网搜索");
    expect(s.provider).not.toHaveBeenCalled();
  });

  it("retains the searched sources and trace when the provider cannot select sufficiently relevant sources", async () => {
    const s = setup();
    s.provider.mockResolvedValueOnce({ ok: true, model: "fixture", content: JSON.stringify({ sourceIds: [], insufficientEvidence: true }) });
    const result = await s.service.research(A, { question });
    expect(result).toMatchObject({ mode: "source_excerpts", source: "insufficient_sources", citedSourceIds: [], search: { performed: true, calls: 1 } });
    expect(result.sources).toHaveLength(2);
    expect(result.draft).toEqual({ title: "查到的相关资料",
      content: "本次已执行联网搜索，但没有选出与问题充分相关的资料。下方如有搜索结果，可以打开原链接核对，或调整问题后再查。" });
  });

  it("limits source snapshots exactly as sent to selection and records truncation without splitting Unicode", async () => {
    const s = setup();
    s.search.mockResolvedValueOnce({ ...searchResult(), results: Array.from({ length: 20 }, (_, i) => ({
      title: "资料标题😀".repeat(100), url: `https://library.example.test/${i}`, excerpt: `RESULT_${i}_` + "资料😀".repeat(2000), pageAge: "日期".repeat(100),
    })) });
    const result = await s.service.research(A, { question });
    expect(result.sources.length).toBeLessThanOrEqual(12);
    expect(result.sources.reduce((sum, source) => sum + source.excerpt.length, 0)).toBeLessThanOrEqual(24_000);
    expect(result.sources.every(source => source.title.length <= 300 && source.excerpt.length <= 3000 && (source.pageAge?.length ?? 0) <= 100 && source.truncated)).toBe(true);
    expect(result.sources.map(source => source.id)).toEqual(result.sources.map((_, i) => `W${i + 1}`));
    for (const source of result.sources) expect(source.excerpt + source.title).not.toMatch(/[\ud800-\udbff]$/);
    const sent = userPayload(s.provider.mock.calls[0][0]).sources as BookWebResearchSource[];
    expect(sent.map(source => source.excerpt)).toEqual(result.sources.map(source => source.excerpt));
    expect(JSON.stringify(sent)).not.toContain("RESULT_19_");
  });

  it("removes unsafe or duplicate source URLs and does not invent excerpts for unusable search results", async () => {
    const s = setup();
    const valid = searchResult().results[0];
    s.search.mockResolvedValueOnce({ ...searchResult(), results: [valid, { ...valid, url: valid.url.replace("overview", "other") },
      ...["javascript:alert(1)", "data:text/html,source", "https://owner:password@example.test/", "https://example.test/has space", "https:\\example.test/x", "https:example.test", "/relative"].map(url => ({ ...valid, url })),
      { ...valid, url: "https://empty.example.test/", excerpt: "  " },
    ] });
    s.provider.mockResolvedValueOnce({ ok: true, model: "fixture", content: JSON.stringify(selectionObject(["W1"])) });
    const result = await s.service.research(A, { question });
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0].url).toBe("https://publisher.example.test/book");
  });

  it("keeps conflicting years attached to their original sources and never invents a reprint chronology", async () => {
    const s = setup();
    const results = [
      { title: "甲馆藏记录", url: "https://library-a.example.test/book", excerpt: "这本书于1935年初版。", pageAge: null },
      { title: "乙书评记录", url: "https://review-b.example.test/book", excerpt: "此书最早于1937年出版，1989年影印。", pageAge: null },
      { title: "作者其他作品", url: "https://author.example.test/other", excerpt: "另一部作品采用亲友咨询的方法。", pageAge: null },
    ];
    s.search.mockResolvedValueOnce({ ...searchResult(), results });
    s.provider.mockResolvedValueOnce({ ok: true, model: "fixture", content: JSON.stringify(selectionObject(["W2", "W1"])) });
    const result = await s.service.research(A, { question: "这本书最早哪一年出版？" });
    expect(result.citedSourceIds).toEqual(["W2", "W1"]);
    expect(result.draft.content).toContain("[W2] [W1]");
    expect(result.draft.content).not.toMatch(/1935|1937|1989|亲友咨询/);
    expect(result.sources.map(source => source.excerpt)).toEqual(results.map(source => source.excerpt));
    expect(result.sources.map(source => source.title)).toEqual(results.map(source => source.title));
    expect(result.sources).toHaveLength(3); // unselected evidence is still inspectable
    const sent = userPayload(s.provider.mock.calls[0][0]).sources;
    expect(sent.map((source: BookWebResearchSource) => source.excerpt)).toEqual(results.map(source => source.excerpt));
    expect(JSON.stringify(result)).not.toContain("1937年再版");
  });

  it("retains all twelve snapshots while accepting only four selected sources in provider order", async () => {
    const s = setup();
    const results = Array.from({ length: 12 }, (_, i) => ({ title: `原始资料 ${i + 1}`, url: `https://library.example.test/${i + 1}`,
      excerpt: `来源 ${i + 1} 的完整节选，原句保持。`, pageAge: null }));
    s.search.mockResolvedValueOnce({ ...searchResult(), results });
    s.provider.mockResolvedValueOnce({ ok: true, model: "fixture", content: JSON.stringify(selectionObject(["W7", "W10", "W1", "W12"])) });
    const result = await s.service.research(A, { question });
    expect(result.sources).toHaveLength(12);
    expect(result.citedSourceIds).toEqual(["W7", "W10", "W1", "W12"]);
    expect(result.sources.map(source => source.excerpt)).toEqual(results.map(source => source.excerpt));
    expect(result.draft.content.match(/\[W\d+\]/g)).toEqual(["[W7]", "[W10]", "[W1]", "[W12]"]);
    s.search.mockResolvedValueOnce({ ...searchResult(), results });
    s.provider.mockResolvedValueOnce({ ok: true, model: "fixture", content: JSON.stringify(selectionObject(["W1", "W2", "W3", "W4", "W5"])) });
    await expect(s.service.research(A, { question })).rejects.toMatchObject({ code: "BOOK_RESEARCH_INVALID_RESPONSE", status: 502 });
  });
});

describe("book internet research request, response and failure boundaries", () => {
  it.each([
    ["bad-id", { question }], [A, null], [A, []], [A, {}], [A, { question: " " }],
    [A, { question: "q".repeat(1001) }], [A, { question: "a\u0000b" }], [A, { question: "a\ud800b" }],
    [A, { question, notes: "CLIENT_NOTES" }], [A, { question, sources: [] }],
  ])("rejects invalid input before catalog access or model calls %#", async (id, body) => {
    const s = setup();
    await expect(s.service.research(id, body)).rejects.toMatchObject({ code: "BOOK_RESEARCH_INVALID_INPUT", status: 400 });
    expect(s.getCatalogDocument).not.toHaveBeenCalled(); expect(s.search).not.toHaveBeenCalled(); expect(s.provider).not.toHaveBeenCalled();
  });

  it("requires enabled AI but does not require a personal database", async () => {
    const s = setup(false);
    await expect(s.service.research(A, { question })).rejects.toMatchObject({ code: "BOOK_RESEARCH_UNAVAILABLE", status: 503 });
    expect(s.getCatalogDocument).not.toHaveBeenCalled(); expect(s.search).not.toHaveBeenCalled();
    const enabled = setup();
    await expect(enabled.service.research(A, { question: ` ${"问".repeat(1000)} ` })).resolves.toMatchObject({ question: "问".repeat(1000) });
  });

  it("distinguishes absent book from a failed/mismatched catalog without calling the model", async () => {
    const s = setup();
    s.getCatalogDocument.mockRejectedValueOnce({ cause: { code: "document_not_found" } });
    await expect(s.service.research(A, { question })).rejects.toMatchObject({ code: "BOOK_RESEARCH_BOOK_NOT_FOUND", status: 404 });
    for (const value of [{ ...catalog, id: B }, {}, null]) {
      s.getCatalogDocument.mockResolvedValueOnce(value);
      await expect(s.service.research(A, { question })).rejects.toMatchObject({ code: "BOOK_RESEARCH_UNAVAILABLE", status: 503 });
    }
    s.getCatalogDocument.mockRejectedValueOnce(new Error("secret key and raw catalog error"));
    await expect(s.service.research(A, { question })).rejects.toMatchObject({ message: "联网研究暂不可用，请稍后重试。" });
    expect(s.search).not.toHaveBeenCalled(); expect(s.provider).not.toHaveBeenCalled();
  });

  it.each([
    { queries: [], searchCalls: 0 }, { queries: ["query"], searchCalls: 2 },
    { queries: [" "], searchCalls: 1 }, { queries: ["q".repeat(1001)], searchCalls: 1 },
  ])("does not claim performed search without a valid provider trace %#", async trace => {
    const s = setup(); s.search.mockResolvedValueOnce({ ...searchResult(), ...trace });
    await expect(s.service.research(A, { question })).rejects.toMatchObject({ code: "BOOK_RESEARCH_SEARCH_FAILED", status: 502 });
    expect(s.provider).not.toHaveBeenCalled();
  });

  it.each([
    "not json", "```json\n{}\n```", JSON.stringify({}),
    JSON.stringify({ ...selectionObject(), conclusion: "1935年初版，1937年再版。" }),
    JSON.stringify({ ...selectionObject(), title: "合并后得到的版本事实" }),
    JSON.stringify({ ...selectionObject(), quote: "1937年再版" }),
    JSON.stringify({ ...selectionObject(), paragraphs: [{ text: "无法溯源的综合断言", sourceIds: ["W1"] }] }),
    JSON.stringify({ ...selectionObject(), url: "https://fabricated.example.test" }),
    JSON.stringify(selectionObject([])), JSON.stringify(selectionObject(["W1", "W1"])),
    JSON.stringify(selectionObject(["W999"])), JSON.stringify(selectionObject(["[W1]"])),
    JSON.stringify({ sourceIds: "W1", insufficientEvidence: false }),
    JSON.stringify({ sourceIds: [1], insufficientEvidence: false }),
    JSON.stringify({ ...selectionObject(), insufficientEvidence: true }),
    JSON.stringify({ sourceIds: [], insufficientEvidence: true, explanation: "自由解释不得进入响应" }),
    JSON.stringify({ sourceIds: ["W".repeat(2100)], insufficientEvidence: false }),
  ])("rejects arbitrary prose, unknown/duplicate IDs, false insufficiency or malformed selection %#", async content => {
    const s = setup(); s.provider.mockResolvedValueOnce({ ok: true, model: "fixture", content });
    await expect(s.service.research(A, { question })).rejects.toMatchObject({ code: "BOOK_RESEARCH_INVALID_RESPONSE", status: 502 });
    expect(s.search).toHaveBeenCalledOnce(); expect(s.provider).toHaveBeenCalledOnce();
  });

  it.each([503, 401, 429, 502, 504])("maps provider status %s to a fixed safe error and never retries", async status => {
    const s = setup();
    s.search.mockResolvedValueOnce({ ok: false, status, error: "provider body secret / request prompt" });
    await expect(s.service.research(A, { question })).rejects.toMatchObject({
      code: status === 503 ? "BOOK_RESEARCH_UNAVAILABLE" : "BOOK_RESEARCH_SEARCH_FAILED",
      message: status === 503 ? "联网研究暂不可用，请稍后重试。" : "联网研究暂未完成，请稍后重试。",
    });
    expect(s.search).toHaveBeenCalledOnce(); expect(s.provider).not.toHaveBeenCalled();
  });

  it("stops before a first request when cancelled, and never selects sources after a cancelled search even if its provider resolves late", async () => {
    const s = setup(), already = new AbortController(); already.abort();
    await expect(s.service.research(A, { question }, { signal: already.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(s.getCatalogDocument).not.toHaveBeenCalled();
    const controller = new AbortController();
    s.search.mockImplementationOnce(async (_messages, options) => {
      expect(options?.signal).toBe(controller.signal); controller.abort(); return searchResult();
    });
    await expect(s.service.research(A, { question }, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(s.provider).not.toHaveBeenCalled();
  });

  it("redacts thrown upstream errors and stops after a failed selection without retries", async () => {
    const s = setup();
    s.search.mockRejectedValueOnce(new Error("private upstream body and credentials"));
    await expect(s.service.research(A, { question })).rejects.toMatchObject({ code: "BOOK_RESEARCH_SEARCH_FAILED", message: "联网研究暂未完成，请稍后重试。" });
    expect(s.provider).not.toHaveBeenCalled();
    s.provider.mockResolvedValueOnce({ ok: false, status: 504, error: "private provider response" });
    await expect(s.service.research(A, { question })).rejects.toMatchObject({ code: "BOOK_RESEARCH_SEARCH_FAILED", status: 502 });
    expect(s.search).toHaveBeenCalledTimes(2); expect(s.provider).toHaveBeenCalledOnce();
  });

  it("propagates cancellation to selection and does not return a late result", async () => {
    const s = setup(), controller = new AbortController();
    s.provider.mockImplementationOnce(async (_messages, options) => {
      expect(options?.signal).toBe(controller.signal); controller.abort();
      return { ok: true, model: "fixture", content: JSON.stringify(selectionObject()) };
    });
    await expect(s.service.research(A, { question }, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(s.search).toHaveBeenCalledOnce(); expect(s.provider).toHaveBeenCalledOnce();
  });
});
