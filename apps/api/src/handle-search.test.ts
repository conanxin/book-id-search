import { describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { handleSearch } from "./index.js";
import { normalizeQuery, fullWidthToAsciiDigits } from "./search/normalize.js";
import { classifyHit, isExactMatchType } from "./search/match.js";
import { rerank } from "./search/rerank.js";

// ---------------------------------------------------------------------------
// Test fixtures and helpers
// ---------------------------------------------------------------------------

function mockReq(q: string): Request {
  return { query: { q } } as unknown as Request;
}

function mockRes() {
  const res: {
    statusCode: number;
    body: unknown;
    status: (s: number) => typeof res;
    json: (b: unknown) => typeof res;
  } = {
    statusCode: 200,
    body: null,
    status(s: number) {
      this.statusCode = s;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
  };
  return res as unknown as Response;
}

function mockMeili() {
  // Simulate an index with NO sortable attributes configured (the S16B
  // --sortable-profile minimal configuration). Any call to search with
  // sort:["year:desc"] would throw a Meilisearch 500.
  const search = vi.fn(async () => {
    throw new Error("Attribute `year` is not sortable. This index does not have configured sortable attributes.");
  });
  return { search };
}

const isExactLikeImpl = (q: string) => /^[0-9X]{7,20}$/.test(q);
const exactSearchImpl = vi.fn(async () => [] as any[]);

// ---------------------------------------------------------------------------
// normalizeQuery — S19-3
// ---------------------------------------------------------------------------

describe("normalizeQuery", () => {
  it("trims outer whitespace but preserves inner content", () => {
    const r = normalizeQuery("   时尚秋冬披肩   ");
    expect(r.original).toBe("   时尚秋冬披肩   ");
    expect(r.normalized).toBe("时尚秋冬披肩");
    expect(r.detectedType).toBe("text");
  });

  it("collapses internal whitespace runs", () => {
    const r = normalizeQuery("时尚  秋冬   披肩");
    expect(r.normalized).toBe("时尚 秋冬 披肩");
    expect(r.detectedType).toBe("text");
  });

  it("strips ISBN hyphens (978-7-5384-5525-0 -> 9787538455250)", () => {
    const r = normalizeQuery("978-7-5384-5525-0");
    expect(r.normalized).toBe("9787538455250");
    expect(r.detectedType).toBe("isbn");
  });

  it("strips ISBN spaces", () => {
    const r = normalizeQuery("978 7538 4552 50");
    expect(r.normalized).toBe("9787538455250");
    expect(r.detectedType).toBe("isbn");
  });

  it("converts full-width digits to half-width", () => {
    expect(fullWidthToAsciiDigits("１３００００００")).toBe("13000000");
    const r = normalizeQuery("１３００００００");
    expect(r.normalized).toBe("13000000");
    expect(r.detectedType).toBe("ssid");
  });

  it("preserves DXID leading zeros (000008232537 -> 000008232537)", () => {
    const r = normalizeQuery("000008232537");
    expect(r.normalized).toBe("000008232537");
    expect(r.detectedType).toBe("dxid");
    // Sanity: not coerced to number; still a string with leading zeros.
    expect(typeof r.normalized).toBe("string");
    expect(r.normalized.length).toBe(12);
    expect(r.normalized.startsWith("0")).toBe(true);
  });

  it("detects SSID (13000000) and DXID (000008232537) independently", () => {
    expect(normalizeQuery("13000000").detectedType).toBe("ssid");
    expect(normalizeQuery("000008232537").detectedType).toBe("dxid");
  });

  it("returns empty type for empty input", () => {
    expect(normalizeQuery("").detectedType).toBe("empty");
    expect(normalizeQuery("   ").detectedType).toBe("empty");
  });

  it("treats CJK queries as text type", () => {
    expect(normalizeQuery("时尚秋冬披肩").detectedType).toBe("text");
    expect(normalizeQuery("陈瑶译").detectedType).toBe("text");
  });
});

// ---------------------------------------------------------------------------
// classifyHit (matchReason) — S19-2
// ---------------------------------------------------------------------------

describe("classifyHit", () => {
  it("detects exact ISBN match (ISBN-13)", () => {
    const info = classifyHit(
      { isbn: "9787538455250", ssid: "13000000", dxid: "000008232537", title: "时尚秋冬披肩" },
      "9787538455250",
      "9787538455250",
      "isbn"
    );
    expect(info.type).toBe("exact_isbn");
    expect(info.label).toBe("ISBN 精确匹配");
    expect(info.score).toBe(1);
    expect(info.fields).toEqual(["isbn"]);
    expect(isExactMatchType(info)).toBe(true);
  });

  it("detects exact ISBN match even with hyphenated query", () => {
    const info = classifyHit(
      { isbn: "9787538455250", ssid: "13000000", dxid: "000008232537", title: "时尚秋冬披肩" },
      "978-7-5384-5525-0",
      "9787538455250",
      "isbn"
    );
    expect(info.type).toBe("exact_isbn");
    expect(info.label).toBe("ISBN 精确匹配");
  });

  it("detects exact SSID match (8 digits)", () => {
    const info = classifyHit(
      { isbn: "9787538455250", ssid: "13000000", dxid: "000008232537", title: "时尚秋冬披肩" },
      "13000000",
      "13000000",
      "ssid"
    );
    expect(info.type).toBe("exact_ssid");
    expect(info.label).toBe("SSID 精确匹配");
    expect(info.score).toBe(1);
    expect(info.fields).toEqual(["ssid"]);
    expect(isExactMatchType(info)).toBe(true);
  });

  it("detects exact DXID match (12 digits with leading zeros)", () => {
    const info = classifyHit(
      { isbn: "9787538455250", ssid: "13000000", dxid: "000008232537", title: "时尚秋冬披肩" },
      "000008232537",
      "000008232537",
      "dxid"
    );
    expect(info.type).toBe("exact_dxid");
    expect(info.label).toBe("DXID 精确匹配");
    expect(info.score).toBe(1);
    expect(info.fields).toEqual(["dxid"]);
    expect(isExactMatchType(info)).toBe(true);
  });

  it("detects exact title match", () => {
    const info = classifyHit(
      { title: "时尚秋冬披肩、吊带", author: "陈瑶译" },
      "时尚秋冬披肩、吊带",
      "时尚秋冬披肩、吊带",
      "text"
    );
    expect(info.type).toBe("exact_title");
    expect(info.label).toBe("书名完全匹配");
    expect(isExactMatchType(info)).toBe(true);
  });

  it("detects partial title hit", () => {
    const info = classifyHit(
      { title: "时尚秋冬毛衣编织  精选款", author: "张蕾编" },
      "时尚秋冬",
      "时尚秋冬",
      "text"
    );
    expect(info.type).toBe("title");
    expect(info.label).toBe("书名命中");
    expect(info.fields).toEqual(["title"]);
  });

  it("detects author-only hit", () => {
    const info = classifyHit(
      { title: "Some title", author: "陈瑶译", publisher: "出版社" },
      "陈瑶译",
      "陈瑶译",
      "text"
    );
    expect(info.type).toBe("author");
    expect(info.label).toBe("作者命中");
    expect(info.fields).toEqual(["author"]);
  });

  it("detects publisher-only hit", () => {
    const info = classifyHit(
      { title: "Some title", author: "Some author", publisher: "吉林科学技术出版社" },
      "吉林科学技术出版社",
      "吉林科学技术出版社",
      "text"
    );
    expect(info.type).toBe("publisher");
    expect(info.label).toBe("出版社命中");
    expect(info.fields).toEqual(["publisher"]);
  });

  it("returns mixed when multiple fields match", () => {
    // Query "陈瑶" is a substring of BOTH the book title and the author.
    // The classifier should detect both, surface "mixed", and list both
    // contributing fields.
    const info = classifyHit(
      { title: "陈瑶翻译作品集", author: "陈瑶译", publisher: "出版社" },
      "陈瑶",
      "陈瑶",
      "text"
    );
    expect(info.type).toBe("mixed");
    expect(info.label).toBe("综合匹配");
    expect(info.fields.sort()).toEqual(["author", "title"]);
  });

  it("does not over-match when only the title contains the query (author differs)", () => {
    // Sanity: a query that hits only one field should NOT be reported as mixed.
    const info = classifyHit(
      { title: "时尚秋冬毛衣", author: "完全无关", publisher: "出版社" },
      "时尚秋冬",
      "时尚秋冬",
      "text"
    );
    expect(info.type).toBe("title");
    expect(info.fields).toEqual(["title"]);
  });

  it("returns unknown for an identifier query with no exact match", () => {
    const info = classifyHit(
      { isbn: "1111111111111", ssid: "13000001", dxid: "000008232538" },
      "9999999999999",
      "9999999999999",
      "isbn"
    );
    expect(info.type).toBe("unknown");
    expect(info.label).toBe("未知匹配");
    expect(isExactMatchType(info)).toBe(false);
  });

  it("does not leak internal config (no keys/secrets in fields)", () => {
    const info = classifyHit(
      { isbn: "9787538455250" },
      "9787538455250",
      "9787538455250",
      "isbn"
    );
    const json = JSON.stringify(info);
    expect(json).not.toMatch(/meili/i);
    expect(json).not.toMatch(/key/i);
    expect(json).not.toMatch(/secret/i);
    expect(json).not.toMatch(/host/i);
  });
});

// ---------------------------------------------------------------------------
// rerank — S19-4
// ---------------------------------------------------------------------------

describe("rerank", () => {
  // Loose fixture helper: tests describe intent, not literal MatchType values.
  const hit = (overrides: { id: string; matchType: string; score?: number; parseStatus?: string; rankingScore?: number }) => ({
    id: overrides.id,
    match: { type: overrides.matchType, label: overrides.matchType, score: overrides.score ?? 0.8, fields: [overrides.matchType] },
    parseStatus: overrides.parseStatus ?? "ok",
    ...(overrides.rankingScore !== undefined ? { _rankingScore: overrides.rankingScore } : {}),
  });

  it("puts exact ISBN/SSID/DXID before fuzzy title hits", () => {
    const hits = [
      hit({ id: "a", matchType: "title" }),
      hit({ id: "b", matchType: "exact_isbn" }),
      hit({ id: "c", matchType: "author" }),
    ];
    rerank(hits as any);
    expect(hits[0].id).toBe("b");
  });

  it("orders title > author > publisher for partial hits", () => {
    const hits = [
      hit({ id: "p", matchType: "publisher", score: 0.5 }),
      hit({ id: "a", matchType: "author", score: 0.7 }),
      hit({ id: "t", matchType: "title", score: 0.8 }),
    ];
    rerank(hits as any);
    expect(hits.map((h) => h.id)).toEqual(["t", "a", "p"]);
  });

  it("ranks ok > weak > failed when scores are close", () => {
    const hits = [
      hit({ id: "w", matchType: "title", parseStatus: "weak" }),
      hit({ id: "f", matchType: "title", parseStatus: "failed" }),
      hit({ id: "o", matchType: "title", parseStatus: "ok" }),
    ];
    rerank(hits as any);
    expect(hits.map((h) => h.id)).toEqual(["o", "w", "f"]);
  });

  it("keeps Meili order as tiebreaker when local scores match", () => {
    const hits = [
      hit({ id: "first", matchType: "title", rankingScore: 0.9 }),
      hit({ id: "second", matchType: "title", rankingScore: 0.85 }),
      hit({ id: "third", matchType: "title", rankingScore: 0.8 }),
    ];
    rerank(hits as any);
    expect(hits.map((h) => h.id)).toEqual(["first", "second", "third"]);
  });

  it("does not mutate the original array's identity (returns same ref)", () => {
    const hits = [hit({ id: "a", matchType: "title" })];
    const out = rerank(hits as any);
    expect(out).toBe(hits);
  });

  it("handles empty input without throwing", () => {
    const out = rerank([]);
    expect(out).toEqual([]);
  });

  it("tolerates missing match (no throw, sorts to bottom)", () => {
    const hits = [
      { id: "ok", match: { type: "title", label: "书名命中", score: 0.8, fields: ["title"] }, parseStatus: "ok" },
      { id: "broken", match: null, parseStatus: "ok" },
    ];
    rerank(hits as any);
    expect(hits[0].id).toBe("ok");
    expect(hits[1].id).toBe("broken");
  });
});

// ---------------------------------------------------------------------------
// handleSearch — empty query
// ---------------------------------------------------------------------------

describe("handleSearch — empty query", () => {
  it("returns 200 with empty payload, never calls meili.search", async () => {
    const meili = mockMeili();
    const req = mockReq("");
    const res = mockRes();
    await handleSearch(req, res, meili, exactSearchImpl, isExactLikeImpl);
    expect(res.statusCode).toBe(200);
    expect(meili.search).not.toHaveBeenCalled();
    expect(res.body).toEqual({
      query: "",
      queryInfo: { original: "", normalized: "", detectedType: "empty" },
      page: 1,
      limit: 20,
      total: 0,
      items: []
    });
  });

  it("trims whitespace before treating as empty", async () => {
    const meili = mockMeili();
    const req = mockReq("   ");
    const res = mockRes();
    await handleSearch(req, res, meili, exactSearchImpl, isExactLikeImpl);
    expect(meili.search).not.toHaveBeenCalled();
    expect((res.body as any).total).toBe(0);
    expect((res.body as any).queryInfo.detectedType).toBe("empty");
  });
});

// ---------------------------------------------------------------------------
// handleSearch — non-empty query
// ---------------------------------------------------------------------------

describe("handleSearch — non-empty query", () => {
  it("ISBN search delegates to meili.search with over-fetched limit and returns hits", async () => {
    const meili = {
      search: vi.fn(async () => ({
        estimatedTotalHits: 1,
        hits: [{ id: "13000000_000008232537", title: "时尚秋冬披肩、吊带", isbn: "9787538455250", parseStatus: "ok" }],
      })),
    };
    const req = mockReq("9787538455250");
    const res = mockRes();
    await handleSearch(req, res, meili, exactSearchImpl, isExactLikeImpl);
    // The S19-4 over-fetch uses limit * 3 (capped at 100) — for default limit=20 that's 60.
    expect(meili.search).toHaveBeenCalledWith("9787538455250", { limit: 60, offset: 0 });
    expect((res.body as any).total).toBe(1);
    expect((res.body as any).items[0].title).toBe("时尚秋冬披肩、吊带");
    expect((res.body as any).queryInfo.detectedType).toBe("isbn");
    expect((res.body as any).items[0].match.type).toBe("exact_isbn");
    expect((res.body as any).items[0].match.label).toBe("ISBN 精确匹配");
  });

  it("hyphenated ISBN query resolves to canonical ISBN exact match", async () => {
    const meili = {
      search: vi.fn(async () => ({
        estimatedTotalHits: 1,
        hits: [{ id: "x", title: "时尚秋冬披肩", isbn: "9787538455250", parseStatus: "ok" }],
      })),
    };
    const req = mockReq("978-7-5384-5525-0");
    const res = mockRes();
    await handleSearch(req, res, meili, exactSearchImpl, isExactLikeImpl);
    expect((res.body as any).queryInfo.normalized).toBe("9787538455250");
    expect((res.body as any).queryInfo.detectedType).toBe("isbn");
    expect((res.body as any).items[0].match.type).toBe("exact_isbn");
    expect((res.body as any).items[0].match.label).toBe("ISBN 精确匹配");
  });

  it("title search returns correct total and items, plus match labels", async () => {
    const meili = {
      search: vi.fn(async () => ({
        estimatedTotalHits: 2955,
        hits: [
          { id: "x1", title: "时尚秋冬毛衣编织  精选款", parseStatus: "ok" },
          { id: "x2", title: "时尚秋冬女装", parseStatus: "ok" },
        ],
      })),
    };
    const req = mockReq("时尚秋冬");
    const res = mockRes();
    await handleSearch(req, res, meili, exactSearchImpl, isExactLikeImpl);
    expect(meili.search).toHaveBeenCalledWith("时尚秋冬", { limit: 60, offset: 0 });
    expect((res.body as any).total).toBe(2955);
    expect((res.body as any).items).toHaveLength(2);
    expect((res.body as any).items[0].match.label).toBe("书名命中");
    expect((res.body as any).items[0].match.type).toBe("title");
    expect((res.body as any).queryInfo.detectedType).toBe("text");
  });

  it("author-only hit gets 作者命中 label", async () => {
    const meili = {
      search: vi.fn(async () => ({
        estimatedTotalHits: 5,
        hits: [{ id: "x", title: "时尚秋冬毛衣", author: "陈瑶译", parseStatus: "ok" }],
      })),
    };
    const req = mockReq("陈瑶译");
    const res = mockRes();
    await handleSearch(req, res, meili, exactSearchImpl, isExactLikeImpl);
    expect((res.body as any).items[0].match.label).toBe("作者命中");
  });

  it("does NOT depend on year being sortable", async () => {
    const meili = {
      search: vi.fn(async () => ({ estimatedTotalHits: 0, hits: [] })),
    };
    const req = mockReq("时尚秋冬");
    const res = mockRes();
    await handleSearch(req, res, meili, exactSearchImpl, isExactLikeImpl);
    const callArgs = meili.search.mock.calls[0][1];
    expect(callArgs).not.toHaveProperty("sort");
  });

  it("returns 500 with friendly message on meili error", async () => {
    const meili = mockMeili();
    const req = mockReq("hello");
    const res = mockRes();
    await handleSearch(req, res, meili, exactSearchImpl, isExactLikeImpl);
    expect(res.statusCode).toBe(500);
    expect((res.body as any).error.message).toMatch(/搜索失败/);
  });

  it("page/limit works with the rerank path", async () => {
    const meili = {
      search: vi.fn(async (q: string, opts: any) => ({
        estimatedTotalHits: 100,
        hits: Array.from({ length: opts.limit }, (_, i) => ({
          id: `book-${i}`,
          title: `时尚秋冬${i}`,
          author: "x",
          publisher: "y",
          parseStatus: "ok",
        })),
      })),
    };
    const req = { query: { q: "时尚秋冬", page: "2", limit: "5" } } as unknown as Request;
    const res = mockRes();
    await handleSearch(req, res, meili, exactSearchImpl, isExactLikeImpl);
    // fetchSize = limit*3 capped at 100 → 15 here; offset = (2-1)*5 = 5
    expect(meili.search).toHaveBeenCalledWith("时尚秋冬", { limit: 15, offset: 5 });
    expect((res.body as any).page).toBe(2);
    expect((res.body as any).limit).toBe(5);
    expect((res.body as any).items.length).toBeLessThanOrEqual(5);
  });
});

// ---------------------------------------------------------------------------
// handleSearch — exact-identifier branch
// ---------------------------------------------------------------------------

describe("handleSearch — exact-identifier path", () => {
  it("uses exactSearchImpl when isExactLikeImpl accepts the normalized query", async () => {
    const meili = {
      search: vi.fn(async () => ({ estimatedTotalHits: 0, hits: [] })),
    };
    const exactImpl = vi.fn(async () => [
      { id: "13000000_000008232537", title: "时尚秋冬披肩", isbn: "9787538455250", parseStatus: "ok" },
    ]);
    const req = mockReq("9787538455250");
    const res = mockRes();
    await handleSearch(req, res, meili, exactImpl, isExactLikeImpl);
    expect(exactImpl).toHaveBeenCalled();
    expect(meili.search).not.toHaveBeenCalled();
    expect((res.body as any).items[0].match.type).toBe("exact_isbn");
    expect((res.body as any).items[0].match.label).toBe("ISBN 精确匹配");
  });
});