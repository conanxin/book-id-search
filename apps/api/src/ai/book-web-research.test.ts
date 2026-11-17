import { describe, expect, it, vi } from "vitest";
import { createBookWebResearchService, type BookWebResearchSource } from "./book-web-research.js";
import type { chatCompletion, ChatMessage } from "./minimax.js";
import type { searchMiniMaxWeb, MiniMaxWebSearchResponse } from "./minimax-web-search.js";

const A = "10000001_000000000001", B = "10000002_000000000002";
const date = "2026-10-11T12:00:00.000Z";
const unavailableClues = { isbn: "unavailable", text: [] };
const question = "这本书的研究背景和相关资料是什么？";
const unselectedDraft = { title: "待核对的网页资料",
  content: "已完成网页搜索，但本次自动挑选未完成。下方保留搜索返回的资料，可以打开原链接核对或读取网页正文。" };
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
interface ProviderSource { evidence: Array<{ id: string; field: "title" | "excerpt"; text: string }> }
const visibleText = (source: ProviderSource, field: "title" | "excerpt") => source.evidence
  .filter(item => item.field === field).map(item => item.text).join("");

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
      excerpt: searchResult().results[0].excerpt, pageAge: "2026-09-01", truncated: false, bookClues: unavailableClues });
    expect(s.getCatalogDocument).toHaveBeenCalledExactlyOnceWith(A);
    expect(s.search).toHaveBeenCalledOnce(); expect(s.provider).toHaveBeenCalledOnce();
    expect(userPayload(s.search.mock.calls[0][0])).toEqual({ book: { title: catalog.title, author: catalog.author,
      publisher: catalog.publisher, year: 2020, pages: 300, isbn: "test-isbn" }, question });
    const sent = userPayload(s.provider.mock.calls[0][0]);
    expect(sent.sources).toEqual(result.sources.map(({ id, title, url, excerpt, pageAge, truncated, bookClues }) =>
      ({ id, site: new URL(url).hostname, pageAge, truncated, bookClues, evidence: [
        { id: id + ":T", field: "title", text: title }, { id: id + ":E1", field: "excerpt", text: excerpt },
      ] })));
    expect(result).not.toHaveProperty("assessments"); // legacy selector remains usable and unclassified
    expect(JSON.stringify([s.search.mock.calls, s.provider.mock.calls, result])).not.toMatch(/RAW_INFO|PERSONAL_|PRIVATE_METADATA|private-resource|UNTRUSTED_SEARCH_STAGE_PROSE/);
    expect(s.provider.mock.calls[0][0][0].content).toContain("没有读取网页全文或整本书");
    expect(s.search.mock.calls[0][0][0].content).toContain("ISBN 配合书名、作者");
    expect(s.provider.mock.calls[0][0][0].content).toContain("人物姓名出现不能确认本书");
    expect(s.provider.mock.calls[0][0][0].content).toContain("商品页只有 ISBN 也不能冒充研究文章或书评");
    expect(s.search.mock.calls[0][1]).toMatchObject({ timeoutMs: 90_000 });
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

  it.each([true, false, undefined])("preserves completed search counts and only exposes limited when true: %s", async limited => {
    const s = setup(), queries = ["completed query", "completed query"];
    s.search.mockResolvedValueOnce({ ...searchResult(), queries, searchCalls: 2, limited });
    const result = await s.service.research(A, { question });
    expect(result.search).toEqual({ performed: true, queries, calls: 2, ...(limited === true ? { limited: true } : {}) });
    expect(result.source).toBe("web_research");
    expect(result.sources).toHaveLength(2);
    expect(s.search).toHaveBeenCalledOnce(); expect(s.provider).toHaveBeenCalledOnce();
  });

  it("keeps the limited notice for a completed empty search without spending a selection call", async () => {
    const s = setup();
    s.search.mockResolvedValueOnce({ ...searchResult(), results: [], limited: true });
    const result = await s.service.research(A, { question });
    expect(result).toMatchObject({ source: "insufficient_sources", sources: [], citedSourceIds: [],
      search: { performed: true, calls: 1, limited: true } });
    expect(s.search).toHaveBeenCalledOnce(); expect(s.provider).not.toHaveBeenCalled();
  });

  it("keeps the limited notice when completed sources do not support a selection", async () => {
    const s = setup();
    s.search.mockResolvedValueOnce({ ...searchResult(), limited: true });
    s.provider.mockResolvedValueOnce({ ok: true, model: "fixture", content: JSON.stringify({ sourceIds: [], insufficientEvidence: true }) });
    const result = await s.service.research(A, { question });
    expect(result).toMatchObject({ source: "insufficient_sources", citedSourceIds: [],
      search: { performed: true, calls: 1, limited: true } });
    expect(result.sources).toHaveLength(2);
    expect(s.search).toHaveBeenCalledOnce(); expect(s.provider).toHaveBeenCalledOnce();
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

  it("retains all original sources, read tokens and search evidence when valid IDs contradict insufficientEvidence", async () => {
    const s = setup();
    const results = Array.from({ length: 6 }, (_, index) => ({
      title: `原始资料 ${index + 1}`, url: `https://library.example.test/${index + 1}`,
      excerpt: `来源 ${index + 1} 的搜索原文。`, pageAge: null,
    }));
    s.search.mockResolvedValueOnce({ ...searchResult(), results, limited: true });
    s.provider.mockResolvedValueOnce({ ok: true, model: "fixture",
      content: JSON.stringify({ sourceIds: ["W3", "W6"], insufficientEvidence: true }) });
    const issueSourceReadToken = vi.fn((_bookId: string, source: Pick<BookWebResearchSource, "id" | "title" | "url">) => `read-token-${source.id}`);
    const service = createBookWebResearchService({ getCatalogDocument: s.getCatalogDocument, search: s.search,
      provider: s.provider, isEnabled: () => true, now: () => new Date(date), issueSourceReadToken });
    const result = await service.research(A, { question });
    expect(result).toEqual({
      bookId: A, question, mode: "source_excerpts", source: "unselected_sources", draft: unselectedDraft,
      citedSourceIds: [], generatedAt: date,
      search: { performed: true, queries: searchResult().queries, calls: 1, limited: true },
      sources: results.map((source, index) => ({ ...source, id: `W${index + 1}`, kind: "web",
        truncated: false, readToken: `read-token-W${index + 1}`, bookClues: unavailableClues })),
    });
    expect(issueSourceReadToken).toHaveBeenCalledTimes(6);
    expect(s.search).toHaveBeenCalledOnce(); expect(s.provider).toHaveBeenCalledOnce();
    expect(JSON.stringify(s.provider.mock.calls)).not.toContain("read-token-");
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
    const sent = userPayload(s.provider.mock.calls[0][0]).sources as ProviderSource[];
    expect(sent.map(source => visibleText(source, "excerpt"))).toEqual(result.sources.map(source => source.excerpt));
    expect(sent.map(source => visibleText(source, "title"))).toEqual(result.sources.map(source => source.title));
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
    expect(sent.map((source: ProviderSource) => visibleText(source, "excerpt"))).toEqual(results.map(source => source.excerpt));
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
    const unselected = await s.service.research(A, { question });
    expect(unselected).toMatchObject({ source: "unselected_sources", citedSourceIds: [], draft: unselectedDraft });
    expect(unselected.sources).toEqual(result.sources);
    expect(unselected.search).toEqual(result.search);
  });
  it("computes clues only from cleaned, retained title/excerpt after truncation", async () => {
    const s = setup(), isbn = "9787112124534";
    s.getCatalogDocument.mockResolvedValueOnce({ ...catalog, isbn });
    const results = [
      { title: "题".repeat(300) + catalog.title, url: `https://example.test/${isbn}`,
        excerpt: "文".repeat(3000) + ` ISBN ${isbn} ${catalog.author}`, pageAge: `ISBN ${isbn} ${catalog.title}` },
      { title: `  ${catalog.title}  `, url: "https://example.test/visible",
        excerpt: `ISBN 9787112\u0000124534\r\n${catalog.author}`, pageAge: null },
      { title: catalog.title, url: "javascript:invalid", excerpt: `ISBN ${isbn}`, pageAge: null },
    ];
    s.search.mockResolvedValueOnce({ ...searchResult(), results });
    const result = await s.service.research(A, { question });
    expect(result.sources).toHaveLength(2);
    expect(result.sources[0]).toMatchObject({ title: "题".repeat(300), excerpt: "文".repeat(3000), truncated: true,
      bookClues: { isbn: "not_seen", text: [] } });
    expect(result.sources[1]).toMatchObject({ title: catalog.title, excerpt: `ISBN ${isbn}\n${catalog.author}`,
      bookClues: { isbn: "matched", text: ["title", "author"] } });
    expect(userPayload(s.provider.mock.calls[0][0]).sources.map((source: BookWebResearchSource) => source.bookClues))
      .toEqual(result.sources.map(source => source.bookClues));
    expect(s.search).toHaveBeenCalledOnce(); expect(s.provider).toHaveBeenCalledOnce();
  });

  it("uses complete catalog identity for clues without widening provider field limits", async () => {
    const s = setup(), isbn = "9787112124534";
    const longBook = { ...catalog, title: "题".repeat(300) + "完整题名", author: "作".repeat(300) + "完整作者",
      isbn: isbn + " ".repeat(100) + "9787515318561" };
    s.getCatalogDocument.mockResolvedValueOnce(longBook);
    s.search.mockResolvedValueOnce({ ...searchResult(), results: [
      { title: "题".repeat(300), url: "https://example.test/partial-identity",
        excerpt: `ISBN ${isbn}；${"作".repeat(300)}`, pageAge: null },
    ] });
    s.provider.mockResolvedValueOnce({ ok: true, model: "fixture", content: JSON.stringify(selectionObject(["W1"])) });
    const result = await s.service.research(A, { question });
    expect(result.sources[0].bookClues).toEqual({ isbn: "unavailable", text: [] });
    const sent = userPayload(s.search.mock.calls[0][0]).book;
    expect(sent.title).toHaveLength(300); expect(sent.author).toHaveLength(300); expect(sent.isbn).toHaveLength(100);
    expect(JSON.stringify(sent)).not.toMatch(/完整题名|完整作者|9787515318561/);
  });

  it("does not turn missing ISBN into insufficiency when the selected source has literal title/author text", async () => {
    const s = setup();
    s.getCatalogDocument.mockResolvedValueOnce({ ...catalog, isbn: "" });
    s.search.mockResolvedValueOnce({ ...searchResult(), results: [
      { title: `${catalog.title} 研究讨论`, url: "https://example.test/discussion", excerpt: `${catalog.author}：相关主题研究。`, pageAge: null },
    ] });
    s.provider.mockResolvedValueOnce({ ok: true, model: "fixture", content: JSON.stringify(selectionObject(["W1"])) });
    const result = await s.service.research(A, { question });
    expect(result).toMatchObject({ source: "web_research", citedSourceIds: ["W1"] });
    expect(result.sources[0].bookClues).toEqual({ isbn: "unavailable", text: ["title", "author"] });
  });

  it.each([
    ["web_research", { sourceIds: ["W2", "W1"], insufficientEvidence: false }],
    ["insufficient_sources", { sourceIds: [], insufficientEvidence: true }],
    ["unselected_sources", { sourceIds: ["W1"], insufficientEvidence: true }],
  ] as const)("preserves derived clues, original sources and read tokens for %s", async (outcome, selection) => {
    const s = setup(), isbn = "9787112124534", other = "9787515318561";
    s.getCatalogDocument.mockResolvedValueOnce({ ...catalog, title: "梁思成", author: "林洙著；杨永生主编", isbn });
    const results = [
      { title: "梁思成", url: "https://example.test/catalog", excerpt: `ISBN ${isbn}；ISBN ${other}`, pageAge: null },
      { title: "《大拙至美》书评", url: "https://example.test/other", excerpt: `梁思成相关著作，ISBN ${other}`, pageAge: null },
      { title: "背景讨论", url: "https://example.test/background", excerpt: "建筑思想讨论，没有书目线索。", pageAge: null },
    ];
    s.search.mockResolvedValueOnce({ ...searchResult(), results, limited: true });
    s.provider.mockResolvedValueOnce({ ok: true, model: "fixture", content: JSON.stringify(selection) });
    const issueSourceReadToken = vi.fn((_bookId: string, source: Pick<BookWebResearchSource, "id" | "title" | "url">) => `read-token-${source.id}`);
    const service = createBookWebResearchService({ getCatalogDocument: s.getCatalogDocument, search: s.search,
      provider: s.provider, isEnabled: () => true, now: () => new Date(date), issueSourceReadToken });
    const result = await service.research(A, { question });
    expect(result.source).toBe(outcome);
    expect(result.citedSourceIds).toEqual(outcome === "web_research" ? ["W2", "W1"] : []);
    expect(result.sources.map(source => source.bookClues)).toEqual([
      { isbn: "mixed", text: ["title"] }, { isbn: "other_only", text: ["title"] }, { isbn: "not_seen", text: [] },
    ]);
    expect(result.sources.map(({ title, url, excerpt, pageAge }) => ({ title, url, excerpt, pageAge }))).toEqual(results);
    expect(result.sources.map(({ id, readToken }) => ({ id, readToken }))).toEqual([
      { id: "W1", readToken: "read-token-W1" }, { id: "W2", readToken: "read-token-W2" }, { id: "W3", readToken: "read-token-W3" },
    ]);
    expect(result.search).toEqual({ performed: true, queries: searchResult().queries, calls: 1, limited: true });
    expect(issueSourceReadToken).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(s.provider.mock.calls)).not.toMatch(/read-token-|RAW_INFO|PERSONAL_|PRIVATE_METADATA|private-resource/);
    expect(s.search).toHaveBeenCalledOnce(); expect(s.provider).toHaveBeenCalledOnce();
  });

  it.each(["title", "excerpt"] as const)("does not turn a longer identifier cut at the %s limit into a target ISBN", async field => {
    const s = setup(), isbn = "9787112124534", limit = field === "title" ? 300 : 3000;
    s.getCatalogDocument.mockResolvedValueOnce({ ...catalog, isbn });
    const value = "a".repeat(limit - isbn.length - 1) + " " + isbn;
    s.search.mockResolvedValueOnce({ ...searchResult(), results: [
      { title: "ordinary title", excerpt: "ordinary excerpt", url: "https://example.test/cut-number", pageAge: null, [field]: value + "1" },
      { title: "ordinary title", excerpt: `ISBN ${isbn}`, url: "https://example.test/cut-age", pageAge: "d".repeat(101) },
    ] });
    const result = await s.service.research(A, { question });
    expect(result.sources[0][field]).toBe(value);
    expect(result.sources[0]).toMatchObject({ truncated: true, bookClues: { isbn: "not_seen", text: [] } });
    expect(result.sources[1]).toMatchObject({ truncated: true, bookClues: { isbn: "matched", text: [] } });
    expect(userPayload(s.provider.mock.calls[0][0]).sources.map((source: BookWebResearchSource) => source.bookClues))
      .toEqual(result.sources.map(source => source.bookClues));
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

  it.each([null, 0, 1, "true", "false", [], {}])("rejects a non-boolean limited flag before selecting sources: %j", async limited => {
    const s = setup();
    s.search.mockResolvedValueOnce({ ...searchResult(), limited } as unknown as MiniMaxWebSearchResponse);
    await expect(s.service.research(A, { question })).rejects.toMatchObject({ code: "BOOK_RESEARCH_SEARCH_FAILED", status: 502 });
    expect(s.search).toHaveBeenCalledOnce(); expect(s.provider).not.toHaveBeenCalled();
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
  ])("retains unselected sources without accepting arbitrary prose, unknown/duplicate IDs, false insufficiency or malformed selection %#", async content => {
    const s = setup(); s.provider.mockResolvedValueOnce({ ok: true, model: "fixture", content });
    const result = await s.service.research(A, { question });
    expect(result).toMatchObject({ source: "unselected_sources", citedSourceIds: [], draft: unselectedDraft,
      search: { performed: true, calls: 1 } });
    expect(result.sources.map(source => source.id)).toEqual(["W1", "W2"]);
    expect(result.sources.map(source => source.excerpt)).toEqual(searchResult().results.map(source => source.excerpt));
    expect(JSON.stringify(result)).not.toMatch(/W999|fabricated\.example|自由解释|版本事实|1937年再版/);
    expect(s.search).toHaveBeenCalledOnce(); expect(s.provider).toHaveBeenCalledOnce();
  });

  it.each([
    [503, "UNAVAILABLE", 503], [401, "FAILED", 502], [403, "FAILED", 502],
    [429, "RATE_LIMITED", 429], [502, "FAILED", 502], [504, "TIMEOUT", 504],
  ] as const)("maps search upstream %s to %s / HTTP %s without retries or user-auth errors", async (upstreamStatus, reason, status) => {
    const s = setup();
    s.search.mockResolvedValueOnce({ ok: false, status: upstreamStatus, error: "PRIVATE_PROVIDER_BODY secret / request prompt" });
    const code = reason === "UNAVAILABLE" ? "BOOK_RESEARCH_UNAVAILABLE" : `BOOK_RESEARCH_SEARCH_${reason}`;
    const error = await s.service.research(A, { question }).catch((value: unknown) => value);
    expect(error).toMatchObject({ code, status });
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toMatch(/PRIVATE_PROVIDER_BODY|secret|request prompt|AUTH/);
    expect(s.search).toHaveBeenCalledOnce(); expect(s.provider).not.toHaveBeenCalled();
  });

  it.each([401, 403, 429, 502, 503, 504])("retains searched sources after selection HTTP %s without retries or leaking provider errors", async status => {
    const s = setup();
    s.search.mockResolvedValueOnce({ ...searchResult(), limited: true });
    s.provider.mockResolvedValueOnce({ ok: false, status, error: "PRIVATE_PROVIDER_BODY secret / request prompt" });
    const result = await s.service.research(A, { question });
    expect(result).toMatchObject({ source: "unselected_sources", citedSourceIds: [], draft: unselectedDraft,
      search: { performed: true, queries: searchResult().queries, calls: 1, limited: true } });
    expect(result.sources.map(source => source.excerpt)).toEqual(searchResult().results.map(source => source.excerpt));
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_PROVIDER_BODY|secret|request prompt|AUTH/);
    expect(s.search).toHaveBeenCalledOnce(); expect(s.provider).toHaveBeenCalledOnce();
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
    s.provider.mockRejectedValueOnce(new Error("private provider body and credentials"));
    const result = await s.service.research(A, { question });
    expect(result).toMatchObject({ source: "unselected_sources", citedSourceIds: [], draft: unselectedDraft });
    expect(result.sources.map(source => source.excerpt)).toEqual(searchResult().results.map(source => source.excerpt));
    expect(JSON.stringify(result)).not.toMatch(/private provider|credentials/);
    expect(s.search).toHaveBeenCalledTimes(2); expect(s.provider).toHaveBeenCalledOnce();
  });

  it.each(["throw", "failure", "invalid response"] as const)("never returns a fallback after a cancelled selection %s", async outcome => {
    const s = setup(), controller = new AbortController();
    s.provider.mockImplementationOnce(async (_messages, options) => {
      expect(options?.signal).toBe(controller.signal);
      controller.abort();
      if (outcome === "throw") throw new Error("private provider error after cancellation");
      if (outcome === "failure") return { ok: false, status: 504, error: "private late timeout" };
      return { ok: true, model: "fixture", content: JSON.stringify({ sourceIds: ["W1"], insufficientEvidence: true }) };
    });
    await expect(s.service.research(A, { question }, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(s.search).toHaveBeenCalledOnce(); expect(s.provider).toHaveBeenCalledOnce();
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
