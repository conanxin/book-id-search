import { describe, expect, it, vi } from "vitest";
import { createBookWebSourceEvidence } from "./book-web-source-assessment.js";
import { createBookWebResearchService } from "./book-web-research.js";
import type { chatCompletion, ChatMessage } from "./minimax.js";
import type { searchMiniMaxWeb } from "./minimax-web-search.js";

const bookId = "13078447_000008311397";
const book = { id: bookId, title: "梁思成", author: "林洙著；杨永生主编",
  publisher: "北京：中国建筑工业出版社", year: 2012, pages: 127, isbn: "9787112124534",
  introduction: "PRIVATE_INTRODUCTION", notes: ["PRIVATE_NOTE"] };
const question = "查找与这本书主题有关的研究文章和书评资料。";
const results = [
  { title: "《大拙至美》读后感", url: "https://review.example.test/other",
    excerpt: "这篇读后感讨论《大拙至美》，由林洙整理梁思成的随笔、讲座和谈话。", pageAge: null },
  { title: "林洙作品出版讨论", url: "https://discussion.example.test/editions",
    excerpt: "论坛帖子列出2012年中国建筑工业出版社《梁思成》，又讨论其他著作的多个版本；版本关系尚未核实。", pageAge: null },
];
const row = (sourceId: string, relationship = "other_book", materialType = "review", evidenceIds = [sourceId + ":E1"]) =>
  ({ sourceId, relationship, materialType, evidenceIds });
function selected() {
  return { sourceIds: ["W1", "W2"], insufficientEvidence: false,
    assessments: [row("W1"), row("W2", "unclear", "discussion")] };
}
function setup(content: unknown = selected()) {
  const catalog = vi.fn().mockResolvedValue(structuredClone(book));
  const search = vi.fn<typeof searchMiniMaxWeb>().mockResolvedValue({
    ok: true, queries: ["梁思成 林洙 2012 书评"], searchCalls: 1, limited: true, results: structuredClone(results),
  });
  const provider = vi.fn<typeof chatCompletion>().mockResolvedValue({
    ok: true, model: "fixture", content: JSON.stringify(content),
  });
  const service = createBookWebResearchService({ getCatalogDocument: catalog, search, provider,
    isEnabled: () => true, now: () => new Date("2026-11-17T00:00:00.000Z"),
    issueSourceReadToken: (_bookId, source) => "READ_TOKEN_" + source.id });
  return { catalog, search, provider, service };
}
const payload = (messages: ChatMessage[]) => JSON.parse(messages.find(message => message.role === "user")!.content);

describe("search evidence slices", () => {
  it("keeps title whole and covers long excerpt text contiguously without splitting an emoji", () => {
    const source = { id: "W7", title: "标题😀", excerpt: "甲".repeat(399) + "😀" + "乙".repeat(2599) };
    const pieces = createBookWebSourceEvidence(source);
    expect(pieces[0]).toEqual({ id: "W7:T", field: "title", start: 0, end: source.title.length, text: source.title });
    const excerpts = pieces.slice(1);
    expect(excerpts[0].end).toBe(399);
    expect(excerpts[1].text.startsWith("😀")).toBe(true);
    expect(excerpts.map(item => item.text).join("")).toBe(source.excerpt);
    for (let index = 0; index < excerpts.length; index++) {
      const item = excerpts[index];
      expect(item.id).toBe("W7:E" + (index + 1));
      expect(item.field).toBe("excerpt");
      expect(item.start).toBe(index ? excerpts[index - 1].end : 0);
      expect(item.end - item.start).toBeGreaterThan(0);
      expect(item.end - item.start).toBeLessThanOrEqual(400);
      expect(item.text).toBe(source.excerpt.slice(item.start, item.end));
      expect(item.text).not.toMatch(/[\ud800-\udbff]$|^[\udc00-\udfff]/);
    }
    expect(excerpts.at(-1)!.end).toBe(source.excerpt.length);
  });

  it("prefers a paragraph boundary and keeps its whitespace plus the entire tail", () => {
    const first = "甲".repeat(100) + "\n\n";
    const source = { id: "W2", title: "讨论", excerpt: first + "乙".repeat(200) + "。" + "丙".repeat(250) + "  " };
    const pieces = createBookWebSourceEvidence(source).slice(1);
    expect(pieces[0].text).toBe(first);
    expect(pieces.map(item => item.text).join("")).toBe(source.excerpt);
    expect(pieces.at(-1)!.text.endsWith("  ")).toBe(true);
  });

  it("uses a sentence boundary when there is no paragraph break", () => {
    const first = "甲".repeat(180) + "。”";
    const source = { id: "W1", title: "题", excerpt: first + "乙".repeat(300) };
    const pieces = createBookWebSourceEvidence(source);
    expect(pieces[1].text).toBe(first);
    expect(pieces.slice(1).map(item => item.text).join("")).toBe(source.excerpt);
  });

  it.each([
    { id: "W1", title: "\ud800", excerpt: "\udc00" },
    { id: "W1", title: "题", excerpt: "\ud800" },
    { id: "W1", title: " ", excerpt: "正文" },
    { id: "W1", title: "题".repeat(301), excerpt: "正文" },
    { id: "W1", title: "题", excerpt: "文".repeat(3001) },
  ])("rejects material outside the visible-source contract %#", source => {
    expect(() => createBookWebSourceEvidence(source)).toThrow("Invalid visible source");
  });
});

describe("book source assessment selection contract", () => {
  it("returns provisional enums and server evidence in source-text order without rewriting any source", async () => {
    const input = { sourceIds: ["W2", "W1"], insufficientEvidence: false,
      assessments: [row("W2", "unclear", "discussion", ["W2:E1", "W2:T"]), row("W1", "other_book", "review")] };
    const s = setup(input), result = await s.service.research(bookId, { question });
    expect(result.source).toBe("web_research");
    expect(result.citedSourceIds).toEqual(["W2", "W1"]);
    expect(result.sources.map(source => source.id)).toEqual(["W1", "W2"]);
    expect(result.sources.map(({ title, url, excerpt, pageAge }) => ({ title, url, excerpt, pageAge }))).toEqual(results);
    expect(result.assessments).toEqual([
      { sourceId: "W2", relationship: "unclear", materialType: "discussion", evidence: [
        { id: "W2:T", field: "title", start: 0, end: results[1].title.length, text: results[1].title },
        { id: "W2:E1", field: "excerpt", start: 0, end: results[1].excerpt.length, text: results[1].excerpt },
      ] },
      { sourceId: "W1", relationship: "other_book", materialType: "review", evidence: [
        { id: "W1:E1", field: "excerpt", start: 0, end: results[0].excerpt.length, text: results[0].excerpt },
      ] },
    ]);
    expect(result.draft.content).toContain("建议先查看：[W2] [W1]");
    expect(result.draft.content).not.toContain("版本关系");
    const sent = payload(s.provider.mock.calls[0][0]);
    for (let index = 0; index < sent.sources.length; index++) {
      const source = sent.sources[index];
      expect(Object.keys(source).sort()).toEqual(["bookClues", "evidence", "id", "pageAge", "site", "truncated"]);
      expect(source.evidence.filter((part: { field: string }) => part.field === "title").map((part: { text: string }) => part.text).join(""))
        .toBe(result.sources[index].title);
      expect(source.evidence.filter((part: { field: string }) => part.field === "excerpt").map((part: { text: string }) => part.text).join(""))
        .toBe(result.sources[index].excerpt);
      expect(source.evidence.every((part: object) => Object.keys(part).sort().join(",") === "field,id,text")).toBe(true);
    }
    expect(JSON.stringify(s.provider.mock.calls)).not.toMatch(/READ_TOKEN|PRIVATE_/);
    expect(s.search).toHaveBeenCalledOnce(); expect(s.provider).toHaveBeenCalledOnce();
    expect(s.search.mock.calls[0][1]).toMatchObject({ timeoutMs: 90_000 });
    expect(s.provider.mock.calls[0][1]).toMatchObject({ maxTokens: 1024, timeoutMs: 60_000, temperature: 0.2, requireCompleted: true });
  });

  it("covers the four relationship enums while retaining only model-selected evidence IDs", async () => {
    const rows = [
      row("W1", "book_candidate", "bibliographic"), row("W2", "other_book", "review"),
      row("W3", "related_background", "research"), row("W4", "unclear", "other"),
    ];
    const s = setup({ sourceIds: rows.map(item => item.sourceId), insufficientEvidence: false, assessments: rows });
    s.search.mockResolvedValueOnce({ ok: true, queries: ["query"], searchCalls: 1,
      results: rows.map((item, index) => ({ title: "资料 " + item.sourceId,
        url: "https://example.test/" + index, excerpt: "这是供合同校验使用的合成资料，不代表真实分类效果。", pageAge: null })) });
    const result = await s.service.research(bookId, { question });
    expect(result.assessments?.map(({ relationship, materialType }) => ({ relationship, materialType })))
      .toEqual(rows.map(({ relationship, materialType }) => ({ relationship, materialType })));
    expect(result.assessments).toHaveLength(4);
    expect(result.sources).toHaveLength(4);
  });

  it("does not turn missing ISBN into a forced classification or insufficiency", async () => {
    const s = setup({ sourceIds: ["W1"], insufficientEvidence: false,
      assessments: [row("W1", "book_candidate", "review")] });
    s.search.mockResolvedValueOnce({ ok: true, queries: ["query"], searchCalls: 1, results: [
      { title: "读林洙2012年《梁思成》", url: "https://example.test/review",
        excerpt: "这篇合成读后感明确讨论林洙2012年由中国建筑工业出版社出版的《梁思成》。", pageAge: null },
    ] });
    const result = await s.service.research(bookId, { question });
    expect(result.source).toBe("web_research");
    expect(result.sources[0].bookClues?.isbn).toBe("not_seen");
    expect(result.assessments?.[0].relationship).toBe("book_candidate");
  });

  it("keeps a complete empty assessment list only when the selector explicitly supplied it", async () => {
    const s = setup({ sourceIds: [], insufficientEvidence: true, assessments: [] });
    const result = await s.service.research(bookId, { question });
    expect(result).toMatchObject({ source: "insufficient_sources", assessments: [], citedSourceIds: [] });
    expect(result.sources).toHaveLength(2);
    s.provider.mockResolvedValueOnce({ ok: true, model: "legacy", content: '{"sourceIds":[],"insufficientEvidence":true}' });
    const legacy = await s.service.research(bookId, { question });
    expect(legacy.source).toBe("insufficient_sources");
    expect(legacy).not.toHaveProperty("assessments");
    s.provider.mockResolvedValueOnce({ ok: true, model: "legacy", content: '{"sourceIds":["W2"],"insufficientEvidence":false}' });
    const oldSelected = await s.service.research(bookId, { question });
    expect(oldSelected).toMatchObject({ source: "web_research", citedSourceIds: ["W2"] });
    expect(oldSelected).not.toHaveProperty("assessments");
  });

  it.each([
    null, {}, [], [row("W1")],
    [row("W2"), row("W1")],
    [row("W1"), row("W1")],
    [row("W1"), row("W999")],
    [row("W1", "verified"), row("W2")],
    [row("W1", "other_book", "trusted"), row("W2")],
    [{ ...row("W1"), conclusion: "UNTRUSTED_MODEL_FACT" }, row("W2")],
    [{ ...row("W1"), evidence: [{ text: "UNTRUSTED_MODEL_FACT", start: 0, end: 20 }] }, row("W2")],
    [row("W1", "other_book", "review", []), row("W2")],
    [row("W1", "other_book", "review", ["W1:T"]), row("W2")],
    [row("W1", "other_book", "review", ["W2:E1"]), row("W2")],
    [row("W1", "other_book", "review", ["W1:E99"]), row("W2")],
    [row("W1", "other_book", "review", ["W1:E1", "W1:E1"]), row("W2")],
    [row("W1", "other_book", "review", ["W1:E1", "W1:T", "W1:E2"]), row("W2")],
    [{ ...row("W1"), evidenceIds: "W1:E1" }, row("W2")],
    [{ ...row("W1"), evidenceIds: [1] }, row("W2")],
  ])("retains every original source after rejecting a malformed or partial new assessment %#", async assessments => {
    const s = setup({ sourceIds: ["W1", "W2"], insufficientEvidence: false, assessments });
    const result = await s.service.research(bookId, { question });
    expect(result).toMatchObject({ source: "unselected_sources", citedSourceIds: [], search: { limited: true } });
    expect(result).not.toHaveProperty("assessments");
    expect(result.sources.map(({ title, excerpt, readToken }) => ({ title, excerpt, readToken })))
      .toEqual(results.map(({ title, excerpt }, index) => ({ title, excerpt, readToken: "READ_TOKEN_W" + (index + 1) })));
    expect(JSON.stringify(result)).not.toContain("UNTRUSTED_MODEL_FACT");
    expect(s.search).toHaveBeenCalledOnce(); expect(s.provider).toHaveBeenCalledOnce();
  });

  it("does not publish even valid assessment text when insufficiency contradicts a nonempty list", async () => {
    const s = setup({ sourceIds: [], insufficientEvidence: true, assessments: [row("W1")] });
    const result = await s.service.research(bookId, { question });
    expect(result.source).toBe("unselected_sources");
    expect(result.sources).toHaveLength(2);
    expect(result).not.toHaveProperty("assessments");
  });

  it("never revives a cancelled response as a classified result", async () => {
    const s = setup(), controller = new AbortController();
    s.provider.mockImplementationOnce(async () => {
      controller.abort();
      return { ok: true, model: "fixture", content: JSON.stringify(selected()) };
    });
    await expect(s.service.research(bookId, { question }, { signal: controller.signal }))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(s.search).toHaveBeenCalledOnce(); expect(s.provider).toHaveBeenCalledOnce();
  });
});
