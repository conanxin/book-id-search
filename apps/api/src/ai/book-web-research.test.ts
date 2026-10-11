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
const answerObject = () => ({ title: "本书研究资料", paragraphs: [
  { text: "出版社介绍指出本书关注河道与渡口的田野调查。", sourceIds: ["W1"] },
  { text: "可结合馆藏目录核对版本信息。", sourceIds: ["W2", "W1", "W2"] },
], insufficientEvidence: false });
function setup(enabled = true) {
  const getCatalogDocument = vi.fn().mockResolvedValue(structuredClone(catalog));
  const search = vi.fn<typeof searchMiniMaxWeb>().mockResolvedValue(searchResult());
  const provider = vi.fn<typeof chatCompletion>().mockResolvedValue({ ok: true, model: "fixture", content: JSON.stringify(answerObject()) });
  const service = createBookWebResearchService({ getCatalogDocument, search, provider, isEnabled: () => enabled, now: () => new Date(date) });
  return { getCatalogDocument, search, provider, service };
}
function userPayload(messages: ChatMessage[]) { return JSON.parse(messages.find(message => message.role === "user")!.content); }

describe("book internet research evidence and read-only scope", () => {
  it("searches the selected public book once, synthesizes only real search excerpts, and assigns provenance on the server", async () => {
    const s = setup();
    s.search.mockResolvedValueOnce({ ...searchResult(), content: "UNTRUSTED_SEARCH_STAGE_PROSE" } as MiniMaxWebSearchResponse);
    const result = await s.service.research(A, { question: `  ${question}  ` });
    expect(result).toMatchObject({ bookId: A, question, source: "web_research", generatedAt: date,
      search: { performed: true, queries: ["运河田野调查 合成作者"], calls: 1 }, citedSourceIds: ["W1", "W2"] });
    expect(result.draft.content).toBe("出版社介绍指出本书关注河道与渡口的田野调查。 [W1]\n\n可结合馆藏目录核对版本信息。 [W2] [W1]");
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
    expect(s.provider.mock.calls[0][1]).toMatchObject({ temperature: 0.2, maxTokens: 4000, timeoutMs: 60_000 });
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

  it("returns honest insufficiency after a completed empty search and does not spend a synthesis call", async () => {
    const s = setup();
    s.search.mockResolvedValueOnce({ ...searchResult(), results: [] });
    const result = await s.service.research(A, { question });
    expect(result).toMatchObject({ source: "insufficient_sources", sources: [], citedSourceIds: [], search: { performed: true, calls: 1 } });
    expect(result.draft.content).toContain("已执行联网搜索");
    expect(s.provider).not.toHaveBeenCalled();
  });

  it("retains the searched sources and trace when the snippets cannot support an answer", async () => {
    const s = setup();
    s.provider.mockResolvedValueOnce({ ok: true, model: "fixture", content: JSON.stringify({ title: "资料不足", paragraphs: [], insufficientEvidence: true }) });
    const result = await s.service.research(A, { question });
    expect(result).toMatchObject({ source: "insufficient_sources", citedSourceIds: [], search: { performed: true, calls: 1 } });
    expect(result.sources).toHaveLength(2);
    expect(result.draft.content).toContain("节选不足以支持");
  });

  it("limits source snapshots exactly as sent to synthesis and records truncation without splitting Unicode", async () => {
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
    s.provider.mockResolvedValueOnce({ ok: true, model: "fixture", content: JSON.stringify({ ...answerObject(), paragraphs: [answerObject().paragraphs[0]] }) });
    const result = await s.service.research(A, { question });
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0].url).toBe("https://publisher.example.test/book");
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
    JSON.stringify({ ...answerObject(), extra: "untrusted" }),
    JSON.stringify({ ...answerObject(), title: "False source [W99]" }),
    JSON.stringify({ ...answerObject(), paragraphs: [] }),
    JSON.stringify({ ...answerObject(), paragraphs: [{ text: "没有引用的结论", sourceIds: [] }] }),
    JSON.stringify({ ...answerObject(), paragraphs: [{ text: "未知来源", sourceIds: ["W999"] }] }),
    JSON.stringify({ ...answerObject(), paragraphs: [{ text: "模型自填 [W1]", sourceIds: ["W1"] }] }),
    JSON.stringify({ ...answerObject(), paragraphs: [{ text: "看 https://fabricated.example.test", sourceIds: ["W1"] }] }),
    JSON.stringify({ ...answerObject(), paragraphs: [{ text: "看 [伪造来源](custom:source)", sourceIds: ["W1"] }] }),
    JSON.stringify({ ...answerObject(), insufficientEvidence: true }),
    JSON.stringify({ ...answerObject(), paragraphs: [{ text: "a\ud800b", sourceIds: ["W1"] }] }),
    JSON.stringify({ ...answerObject(), paragraphs: Array.from({ length: 4 }, () => ({ text: "长".repeat(3999), sourceIds: ["W1"] })) }),
  ])("rejects malformed, uncited, invented-link or oversized synthesis without returning model prose %#", async content => {
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

  it("stops before a first request when cancelled, and never synthesizes a cancelled search even if its provider resolves late", async () => {
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

  it("redacts thrown upstream errors and stops after a failed synthesis without retries", async () => {
    const s = setup();
    s.search.mockRejectedValueOnce(new Error("private upstream body and credentials"));
    await expect(s.service.research(A, { question })).rejects.toMatchObject({ code: "BOOK_RESEARCH_SEARCH_FAILED", message: "联网研究暂未完成，请稍后重试。" });
    expect(s.provider).not.toHaveBeenCalled();
    s.provider.mockResolvedValueOnce({ ok: false, status: 504, error: "private provider response" });
    await expect(s.service.research(A, { question })).rejects.toMatchObject({ code: "BOOK_RESEARCH_SEARCH_FAILED", status: 502 });
    expect(s.search).toHaveBeenCalledTimes(2); expect(s.provider).toHaveBeenCalledOnce();
  });

  it("propagates cancellation to synthesis and does not return a late answer", async () => {
    const s = setup(), controller = new AbortController();
    s.provider.mockImplementationOnce(async (_messages, options) => {
      expect(options?.signal).toBe(controller.signal); controller.abort();
      return { ok: true, model: "fixture", content: JSON.stringify(answerObject()) };
    });
    await expect(s.service.research(A, { question }, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(s.search).toHaveBeenCalledOnce(); expect(s.provider).toHaveBeenCalledOnce();
  });
});
