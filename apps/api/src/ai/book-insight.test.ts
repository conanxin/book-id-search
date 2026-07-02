import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  runBookInsight,
  _clearInsightCache,
  deriveBibliographicGaps,
  type BookInsightResponse,
  type BookInsightBasis,
} from "./book-insight.js";
import { SimpleCache } from "./cache.js";
import type { ChatCompletionResponse } from "./minimax.js";

// ---------- helpers ----------

const FULL_BOOK = {
  id: "13000000_000008232537",
  title: "时尚秋冬披肩、吊带",
  author: "（日）日本靓丽社著；陈瑶译",
  publisher: "长春：吉林科学技术出版社",
  year: 2011,
  pages: 83,
  isbn: "9787538455250",
  ssid: "13000000",
  dxid: "000008232537",
  parseStatus: "ok",
  parseWarnings: [],
  rawInfo: "raw data...",
};

const WEAK_BOOK = {
  ...FULL_BOOK,
  id: "w_1",
  title: "弱解析样例",
  author: "未知",
  publisher: "未知",
  year: 0,
  isbn: "",
  parseStatus: "weak",
  parseWarnings: ["缺 ISBN"],
};

function okInsight(content: string): ChatCompletionResponse {
  return { ok: true, content, model: "test" };
}
function errInsight(status = 502, error = "down"): ChatCompletionResponse {
  return { ok: false, status, error };
}

const VALID_INSIGHT_JSON = JSON.stringify({
  shortSummary: "这可能是一本面向大众读者的手工编织/服饰制作类实用书。",
  subjectTags: ["手工编织", "披肩", "吊带", "服饰制作", "日本", "编织"],
  likelyAudience: "手工爱好者、服饰制作学习者",
  bibliographicSignals: [
    "书名包含披肩、吊带",
    "出版社为吉林科学技术出版社",
    "页数较少，更像实用手册",
  ],
  searchSuggestions: ["披肩 吊带", "日本 手工编织", "服饰制作"],
  trustAssessment: { level: "high", reasons: ["ISBN 完整", "parseStatus=ok"] },
  caveats: [
    "没有图书全文或目录",
    "分析仅基于标题、作者、出版社、年份、页数和 ISBN",
  ],
});

function makeBookLookup(book: unknown = FULL_BOOK) {
  return vi.fn().mockResolvedValue(book);
}

// ---------- tests ----------

describe("runBookInsight — basic flow", () => {
  beforeEach(() => {
    _clearInsightCache();
  });
  afterEach(() => {
    _clearInsightCache();
  });

  it("AI disabled returns 503", async () => {
    await expect(
      runBookInsight("x_1", {
        isEnabled: () => false,
        bookLookup: makeBookLookup(),
        chat: vi.fn(),
      }),
    ).rejects.toMatchObject({ status: 503 });
  });

  it("book not found → throws BookNotFoundError", async () => {
    await expect(
      runBookInsight("nope", {
        isEnabled: () => true,
        bookLookup: vi.fn().mockResolvedValue(null),
        chat: vi.fn(),
      }),
    ).rejects.toBeInstanceOf(Error);
    try {
      await runBookInsight("nope", {
        isEnabled: () => true,
        bookLookup: vi.fn().mockResolvedValue(null),
        chat: vi.fn(),
      });
    } catch (e: any) {
      expect(e.status).toBe(404);
    }
  });

  it("happy path: returns structured insight from AI JSON", async () => {
    const chat = vi.fn().mockResolvedValue(okInsight(VALID_INSIGHT_JSON));
    const bookLookup = makeBookLookup();
    const r = await runBookInsight(FULL_BOOK.id, {
      isEnabled: () => true,
      bookLookup,
      chat,
    });
    expect(r.bookId).toBe(FULL_BOOK.id);
    expect(r.basis.title).toBe(FULL_BOOK.title);
    expect(r.basis.isbn).toBe(FULL_BOOK.isbn);
    expect(r.insight.shortSummary).toContain("手工编织");
    expect(r.insight.scopeNote).toContain("仅基于书目信息");
    expect(r.insight.subjectTags).toContain("披肩");
    expect(r.insight.bibliographicSignals.length).toBeGreaterThan(0);
    expect(r.insight.trustAssessment.level).toBe("high");
    expect(r.insight.caveats.length).toBeGreaterThan(0);
    expect(r.source).toBe("ai");
    expect(r.cache?.hit).toBe(false);
  });

  it("AI JSON parse failure → rule-based fallback", async () => {
    const chat = vi.fn().mockResolvedValue(okInsight("not json at all"));
    const r = await runBookInsight(FULL_BOOK.id, {
      isEnabled: () => true,
      bookLookup: makeBookLookup(),
      chat,
    });
    expect(r.source).toBe("rule_based_fallback");
    expect(r.insight.shortSummary).toContain("AI 返回解析失败");
    expect(r.insight.trustAssessment.level).toBeDefined();
    expect(r.insight.caveats.some((c) => /仅基于书目信息/.test(c))).toBe(true);
  });

  it("AI chat error → rule-based fallback (no throw)", async () => {
    const chat = vi.fn().mockResolvedValue(errInsight(502, "down"));
    const r = await runBookInsight(FULL_BOOK.id, {
      isEnabled: () => true,
      bookLookup: makeBookLookup(),
      chat,
    });
    expect(r.source).toBe("rule_based_fallback");
  });

  it("rawInfo is truncated to char limit and flagged", async () => {
    const longRawBook = { ...FULL_BOOK, rawInfo: "x".repeat(2000) };
    const chat = vi.fn().mockResolvedValue(okInsight(VALID_INSIGHT_JSON));
    const r = await runBookInsight(FULL_BOOK.id, {
      isEnabled: () => true,
      bookLookup: makeBookLookup(longRawBook),
      chat,
      rawInfoCharLimit: 100,
    });
    expect(r.basis.rawInfoExcerpt.length).toBe(100);
    expect(r.basis.rawInfoTruncated).toBe(true);
  });
});

describe("runBookInsight — sanitization", () => {
  beforeEach(() => _clearInsightCache());
  afterEach(() => _clearInsightCache());

  it("subjectTags capped at 8 and deduped", async () => {
    const longJson = JSON.stringify({
      shortSummary: "x",
      subjectTags: ["a", "b", "a", "c", "d", "e", "f", "g", "h", "i", "j"],
      bibliographicSignals: [],
      searchSuggestions: [],
      trustAssessment: { level: "high", reasons: [] },
      caveats: [],
    });
    const chat = vi.fn().mockResolvedValue(okInsight(longJson));
    const r = await runBookInsight(FULL_BOOK.id, {
      isEnabled: () => true,
      bookLookup: makeBookLookup(),
      chat,
    });
    expect(r.insight.subjectTags.length).toBeLessThanOrEqual(8);
    expect(new Set(r.insight.subjectTags).size).toBe(r.insight.subjectTags.length);
  });

  it("searchSuggestions capped at 6", async () => {
    const longJson = JSON.stringify({
      shortSummary: "x",
      subjectTags: [],
      bibliographicSignals: [],
      searchSuggestions: ["a", "b", "c", "d", "e", "f", "g", "h"],
      trustAssessment: { level: "high", reasons: [] },
      caveats: [],
    });
    const chat = vi.fn().mockResolvedValue(okInsight(longJson));
    const r = await runBookInsight(FULL_BOOK.id, {
      isEnabled: () => true,
      bookLookup: makeBookLookup(),
      chat,
    });
    expect(r.insight.searchSuggestions.length).toBeLessThanOrEqual(6);
  });

  it("bibliographicSignals capped at 6", async () => {
    const longJson = JSON.stringify({
      shortSummary: "x",
      subjectTags: [],
      bibliographicSignals: ["a", "b", "c", "d", "e", "f", "g", "h"],
      searchSuggestions: [],
      trustAssessment: { level: "high", reasons: [] },
      caveats: [],
    });
    const chat = vi.fn().mockResolvedValue(okInsight(longJson));
    const r = await runBookInsight(FULL_BOOK.id, {
      isEnabled: () => true,
      bookLookup: makeBookLookup(),
      chat,
    });
    expect(r.insight.bibliographicSignals.length).toBeLessThanOrEqual(6);
  });

  it("caveats capped at 5", async () => {
    const longJson = JSON.stringify({
      shortSummary: "x",
      subjectTags: [],
      bibliographicSignals: [],
      searchSuggestions: [],
      trustAssessment: { level: "high", reasons: [] },
      caveats: ["c1", "c2", "c3", "c4", "c5", "c6", "c7"],
    });
    const chat = vi.fn().mockResolvedValue(okInsight(longJson));
    const r = await runBookInsight(FULL_BOOK.id, {
      isEnabled: () => true,
      bookLookup: makeBookLookup(),
      chat,
    });
    expect(r.insight.caveats.length).toBeLessThanOrEqual(5);
  });

  it("shortSummary capped at 120 chars", async () => {
    const longJson = JSON.stringify({
      shortSummary: "一".repeat(300),
      subjectTags: [],
      bibliographicSignals: [],
      searchSuggestions: [],
      trustAssessment: { level: "high", reasons: [] },
      caveats: [],
    });
    const chat = vi.fn().mockResolvedValue(okInsight(longJson));
    const r = await runBookInsight(FULL_BOOK.id, {
      isEnabled: () => true,
      bookLookup: makeBookLookup(),
      chat,
    });
    expect(r.insight.shortSummary.length).toBeLessThanOrEqual(120);
  });

  it("AI-invented ISBN (different from basis.isbn) is dropped from subjectTags", async () => {
    const longJson = JSON.stringify({
      shortSummary: "x",
      subjectTags: ["1234567890123", "9787538455250", "手工"], // first is fake ISBN
      bibliographicSignals: [],
      searchSuggestions: [],
      trustAssessment: { level: "high", reasons: [] },
      caveats: [],
    });
    const chat = vi.fn().mockResolvedValue(okInsight(longJson));
    const r = await runBookInsight(FULL_BOOK.id, {
      isEnabled: () => true,
      bookLookup: makeBookLookup(),
      chat,
    });
    expect(r.insight.subjectTags).not.toContain("1234567890123");
    expect(r.insight.subjectTags).toContain("9787538455250");
  });

  it("scopeNote is always present and bilingual-friendly", async () => {
    const chat = vi.fn().mockResolvedValue(okInsight(VALID_INSIGHT_JSON));
    const r = await runBookInsight(FULL_BOOK.id, {
      isEnabled: () => true,
      bookLookup: makeBookLookup(),
      chat,
    });
    expect(r.insight.scopeNote).toContain("仅基于书目信息");
    expect(r.insight.scopeNote).toContain("不代表图书全文内容");
  });

  it("basis fields are always the real, fetched book fields", async () => {
    // AI tries to override isbn in its own JSON; basis.isbn must still be the real one
    const overrideJson = JSON.stringify({
      shortSummary: "x",
      subjectTags: ["9787000000000"], // wrong ISBN
      bibliographicSignals: ["is actually 9787000000000"],
      searchSuggestions: [],
      trustAssessment: { level: "high", reasons: [] },
      caveats: [],
    });
    const chat = vi.fn().mockResolvedValue(okInsight(overrideJson));
    const r = await runBookInsight(FULL_BOOK.id, {
      isEnabled: () => true,
      bookLookup: makeBookLookup(),
      chat,
    });
    expect(r.basis.isbn).toBe(FULL_BOOK.isbn);
    expect(r.basis.ssid).toBe(FULL_BOOK.ssid);
    expect(r.basis.dxid).toBe(FULL_BOOK.dxid);
  });
});

describe("runBookInsight — cache", () => {
  beforeEach(() => _clearInsightCache());
  afterEach(() => _clearInsightCache());

  it("first call invokes chat; second call hits cache", async () => {
    const cache: SimpleCache<BookInsightResponse> = new SimpleCache({ ttlMs: 60000, maxEntries: 200 });
    const chat = vi.fn().mockResolvedValue(okInsight(VALID_INSIGHT_JSON));
    const bookLookup = makeBookLookup();
    const deps = { isEnabled: () => true, chat, bookLookup, cache, cacheVersion: "t1" };

    const r1 = await runBookInsight(FULL_BOOK.id, deps);
    expect(r1.cache?.hit).toBe(false);
    expect(chat).toHaveBeenCalledTimes(1);
    expect(bookLookup).toHaveBeenCalledTimes(1);

    const r2 = await runBookInsight(FULL_BOOK.id, deps);
    expect(r2.cache?.hit).toBe(true);
    expect(r2.cache?.ttlSeconds).toBe(600);
    expect(chat).toHaveBeenCalledTimes(1); // not called again
    expect(bookLookup).toHaveBeenCalledTimes(1);
  });

  it("expired cache calls chat again", async () => {
    let now = 0;
    const cache = new SimpleCache<BookInsightResponse>({
      ttlMs: 1000,
      maxEntries: 200,
      now: () => now,
    });
    const chat = vi
      .fn()
      .mockResolvedValueOnce(okInsight(VALID_INSIGHT_JSON))
      .mockResolvedValueOnce(okInsight(VALID_INSIGHT_JSON));
    const bookLookup = makeBookLookup();
    const deps = { isEnabled: () => true, chat, bookLookup, cache, cacheVersion: "t1" };

    await runBookInsight(FULL_BOOK.id, deps);
    now = 1500;
    await runBookInsight(FULL_BOOK.id, deps);
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it("different bookId not shared", async () => {
    const cache = new SimpleCache<BookInsightResponse>({ ttlMs: 60000, maxEntries: 200 });
    const chat = vi.fn().mockResolvedValue(okInsight(VALID_INSIGHT_JSON));
    const bookLookup = vi
      .fn()
      .mockResolvedValueOnce(FULL_BOOK)
      .mockResolvedValueOnce({ ...FULL_BOOK, id: "b_1", title: "另一本" });
    const deps = { isEnabled: () => true, chat, bookLookup, cache, cacheVersion: "t1" };

    await runBookInsight(FULL_BOOK.id, deps);
    await runBookInsight("b_1", deps);
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it("does NOT cache when AI fails AND book is essentially empty", async () => {
    const cache = new SimpleCache<BookInsightResponse>({ ttlMs: 60000, maxEntries: 200 });
    const chat = vi.fn().mockResolvedValue(errInsight(502, "down"));
    const bookLookup = makeBookLookup({ id: "e_1" }); // no title, no author
    await runBookInsight("e_1", {
      isEnabled: () => true,
      chat,
      bookLookup,
      cache,
    });
    // basis is too thin → not cached
    const stats = cache.stats();
    expect(stats.size).toBe(0);
  });
});

describe("runBookInsight — safety", () => {
  beforeEach(() => _clearInsightCache());
  afterEach(() => _clearInsightCache());

  it("does not include api key in fallback insight (when AI returns error)", async () => {
    const chat = vi.fn().mockResolvedValue(errInsight(401, "Bearer sk-abcdef0123456789 invalid"));
    const r = await runBookInsight(FULL_BOOK.id, {
      isEnabled: () => true,
      bookLookup: makeBookLookup(),
      chat,
    });
    const dump = JSON.stringify(r);
    expect(dump).not.toContain("sk-abcdef0123456789");
    expect(dump).not.toContain("Bearer");
  });

  it("raw provider error text does not leak to client when AI fails (falls back gracefully)", async () => {
    const chat = vi.fn().mockResolvedValue(errInsight(500, "Internal Server Error: sensitive detail"));
    const r = await runBookInsight(FULL_BOOK.id, {
      isEnabled: () => true,
      bookLookup: makeBookLookup(),
      chat,
    });
    const dump = JSON.stringify(r);
    expect(dump).not.toContain("sensitive detail");
    expect(dump).not.toContain("Internal Server Error");
  });
});

describe("runBookInsight — edge cases", () => {
  beforeEach(() => _clearInsightCache());
  afterEach(() => _clearInsightCache());

  it("weak parseStatus + missing ISBN: trust level downgraded to medium, basis includes warnings", async () => {
    const chat = vi.fn().mockResolvedValue(okInsight(VALID_INSIGHT_JSON));
    const r = await runBookInsight(WEAK_BOOK.id, {
      isEnabled: () => true,
      bookLookup: makeBookLookup(WEAK_BOOK),
      chat,
    });
    expect(r.basis.parseStatus).toBe("weak");
    expect(r.basis.parseWarnings).toContain("缺 ISBN");
    expect(r.quality.missingFields).toContain("isbn");
    expect(r.insight.trustAssessment.level).toBe("medium");
    expect(r.insight.caveats.some((c) => c.includes("ISBN") && c.includes("缺"))).toBe(true);
    expect(r.insight.caveats.some((c) => c.includes("弱解析"))).toBe(true);
  });

  it("AI returns trust level out of enum → falls back to basis-driven", async () => {
    const chat = vi.fn().mockResolvedValue(
      okInsight(JSON.stringify({
        shortSummary: "x",
        subjectTags: [],
        bibliographicSignals: [],
        searchSuggestions: [],
        trustAssessment: { level: "ultra", reasons: [] },
        caveats: [],
      })),
    );
    const r = await runBookInsight(FULL_BOOK.id, {
      isEnabled: () => true,
      bookLookup: makeBookLookup(),
      chat,
    });
    expect(["high", "medium", "low"]).toContain(r.insight.trustAssessment.level);
  });

  it("empty bookId throws", async () => {
    await expect(
      runBookInsight("", {
        isEnabled: () => true,
        bookLookup: makeBookLookup(),
        chat: vi.fn(),
      }),
    ).rejects.toBeInstanceOf(Error);
  });

  it("forbidden full-content phrases are stripped from all fields", async () => {
    const chat = vi.fn().mockResolvedValue(
      okInsight(JSON.stringify({
        shortSummary: "本书详细介绍了编织技法，本书讲述了钩针基础，销量很高。",
        subjectTags: ["手工编织"],
        bibliographicSignals: ["内容详尽的图解，读者评价很高", "影响力很大"],
        caveats: ["作者生平未知", "本书讲述了钩针基础。"],
      })),
    );
    const r = await runBookInsight(FULL_BOOK.id, {
      isEnabled: () => true,
      bookLookup: makeBookLookup(),
      chat,
    });
    // sentences with forbidden phrases are dropped entirely
    expect(r.insight.shortSummary).not.toContain("本书详细介绍");
    expect(r.insight.shortSummary).not.toContain("本书讲述了");
    expect(r.insight.shortSummary).not.toContain("销量");
    // bibliographicSignals: sentence-level drops
    expect(r.insight.bibliographicSignals.join("|")).not.toContain("内容详尽");
    expect(r.insight.bibliographicSignals.join("|")).not.toContain("读者评价");
    expect(r.insight.bibliographicSignals.join("|")).not.toContain("影响力");
    // caveats: both forbidden-bearing sentences dropped
    expect(r.insight.caveats.join("|")).not.toContain("作者生平");
    expect(r.insight.caveats.join("|")).not.toContain("本书讲述了");
    // dangling punctuation must not leak through
    expect(r.insight.caveats.join("|")).not.toMatch(/^、|，、|、，|，$/);
  });
});

describe("deriveBibliographicGaps — quality analysis", () => {
  const BASE_BASIS: BookInsightBasis = {
    id: "x",
    title: "Test",
    author: "Test",
    publisher: "Test",
    year: 2020,
    pages: 100,
    isbn: "9781234567890",
    ssid: "12345678",
    dxid: "000012345678",
    parseStatus: "ok",
    parseWarnings: [],
    rawInfoExcerpt: "raw data",
    rawInfoTruncated: false,
  };

  it("ok book with isbn: no missing fields, trust hints empty", () => {
    const q = deriveBibliographicGaps(BASE_BASIS);
    expect(q.missingFields).not.toContain("isbn");
    expect(q.trustHints).not.toContain("ISBN 缺失，无法用 ISBN 进行版本核对");
  });

  it("missing isbn: missingFields includes isbn, trustHint added", () => {
    const q = deriveBibliographicGaps({ ...BASE_BASIS, isbn: "" });
    expect(q.missingFields).toContain("isbn");
    expect(q.trustHints).toContain("ISBN 缺失，无法用 ISBN 进行版本核对");
  });

  it("weak parseStatus: trustHint includes weak parse warning", () => {
    const q = deriveBibliographicGaps({ ...BASE_BASIS, parseStatus: "weak" });
    expect(q.trustHints).toContain("记录为弱解析，应结合原始 TXT 记录核对");
  });

  it("no rawInfo: trustHint includes no rawInfo warning", () => {
    const q = deriveBibliographicGaps({ ...BASE_BASIS, rawInfoExcerpt: "" });
    expect(q.trustHints).toContain("当前索引未保存原始记录，无法核对字段");
  });

  it("year 0 or null: abnormalFields includes year", () => {
    const q0 = deriveBibliographicGaps({ ...BASE_BASIS, year: 0 });
    expect(q0.abnormalFields).toContain("year");
    const qNull = deriveBibliographicGaps({ ...BASE_BASIS, year: null });
    expect(qNull.abnormalFields).toContain("year");
  });

  it("pages 0 or null: abnormalFields includes pages", () => {
    const q0 = deriveBibliographicGaps({ ...BASE_BASIS, pages: 0 });
    expect(q0.abnormalFields).toContain("pages");
    const qNull = deriveBibliographicGaps({ ...BASE_BASIS, pages: null });
    expect(qNull.abnormalFields).toContain("pages");
  });

  it("warnings merges parseWarnings and derived warnings", () => {
    const q = deriveBibliographicGaps({ ...BASE_BASIS, isbn: "", parseWarnings: ["existing_warn"] });
    expect(q.warnings).toContain("existing_warn");
    expect(q.warnings).toContain("missing_isbn");
  });
});
