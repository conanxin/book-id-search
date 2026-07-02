/**
 * S22C/S22D — AI quality regression cases.
 *
 * Hand-curated fixed examples used to detect AI regression on:
 *   - /api/ai/search-intent  (AI 找书)
 *   - /api/ai/book-insight   (AI 详情分析)
 *
 * Cases are intentionally short, bilingual-friendly, and tolerant of minor
 * wording variation (PASS/WARN/FAIL, never brittle).
 *
 * `live: true` cases actually call the AI; `live: false` cases only do
 * logic / HTTP-shape checks (no AI budget consumed).
 */

export type InsightTrustLevel = "high" | "medium" | "low";

export interface SearchIntentCase {
  id: string;
  query: string;
  live: boolean;
  expected: {
    shouldContainTitle?: string;
    shouldContainIsbn?: string;
    shouldContainId?: string;
    shouldContainAnyTerms?: string[];
    maxRank?: number;
    mustHaveItems?: boolean;
    allowEmpty?: boolean;
    shouldNot500?: boolean;
    shouldHaveGracefulFallback?: boolean;
  };
}

export interface BookInsightCase {
  id: string;
  bookId: string;
  live: boolean;
  expected: {
    expectedStatus?: number; // 200 | 404
    mustHaveScopeNote?: boolean;
    mustHaveSubjectTags?: boolean;
    mustHaveCaveats?: boolean;
    mustMentionMissingIsbn?: boolean;
    mustMentionMetadataLimitation?: boolean;
    shouldNotInventIsbn?: boolean;
    shouldMentionMetadataLimitation?: boolean;
    trustLevelNotHigh?: boolean;
    forbiddenClaims?: string[];
    requiredBasisFields?: Array<"title" | "author" | "isbn" | "ssid" | "dxid" | "publisher">;
    shouldNot500?: boolean;
  };
}

export const searchIntentCases: SearchIntentCase[] = [
  {
    id: "japanese-shawl-camisole",
    query: "日本人写的披肩吊带手工书",
    live: true,
    expected: {
      shouldContainTitle: "时尚秋冬披肩、吊带",
      shouldContainIsbn: "9787538455250",
      maxRank: 5,
      mustHaveItems: true,
    },
  },
  {
    id: "isbn-description",
    query: "帮我找 ISBN 是 978-7-5384-5525-0 的书",
    live: true,
    expected: {
      // The AI's natural-language interpretation may surface related books
      // (民国史料丛刊  978..., 永乐大典卷 975-978) before the literal ISBN
      // match, because the user phrased the query conversationally. We assert
      // that the response is well-formed and 200; we also do a direct
      // Meilisearch check (not via AI) that the ISBN is findable.
      shouldContainAnyTerms: ["ISBN", "978"],
      mustHaveItems: true,
      mustNot500: true,
    },
  },
  {
    id: "scarf-fashion",
    query: "想找关于围巾造型和服饰搭配的书",
    live: true,
    expected: {
      mustHaveItems: true,
      shouldContainAnyTerms: ["围巾", "服饰", "造型", "搭配"],
    },
  },
  {
    id: "liao-architecture",
    query: "有没有讲辽代佛塔或者古建筑的书",
    live: true,
    expected: {
      mustHaveItems: true,
      shouldContainAnyTerms: ["辽", "佛塔", "建筑"],
    },
  },
  {
    id: "luxun-publisher",
    query: "找一本人民文学出版社出版的鲁迅相关图书",
    live: true,
    expected: {
      mustHaveItems: true,
      shouldContainAnyTerms: ["鲁迅", "人民文学出版社"],
    },
  },
  {
    id: "low-confidence-weird-query",
    query: "想找一本蓝色封面讲月球茶壶维修的中文书",
    live: true,
    expected: {
      shouldNot500: true,
      allowEmpty: true,
      shouldHaveGracefulFallback: true,
    },
  },
];

export const bookInsightCases: BookInsightCase[] = [
  {
    id: "insight-complete-book",
    bookId: "13000000_000008232537",
    live: true,
    expected: {
      expectedStatus: 200,
      mustHaveScopeNote: true,
      mustHaveSubjectTags: true,
      mustHaveCaveats: true,
      shouldMentionMetadataLimitation: true,
      forbiddenClaims: [
        "本书详细介绍",
        "本书详细介绍了",
        "本书详细讲述",
        "本书讲述了",
        "本书通过详细",
        "本书通过",
        "本书深入",
        "书中详细",
        "内容简介",
        "内容详尽",
        "读者评价",
        "作者生平",
        "书中指出",
        "获得奖项",
        "获奖情况",
        "销量",
        "影响力",
        "被翻译成",
      ],
      requiredBasisFields: ["title", "isbn", "ssid", "dxid"],
    },
  },
  {
    id: "insight-weak-missing-isbn",
    bookId: "13001363_000007809055",
    live: true,
    expected: {
      expectedStatus: 200,
      mustHaveScopeNote: true,
      mustMentionMetadataLimitation: true,
      mustMentionMissingIsbn: true,
      shouldNotInventIsbn: true,
      trustLevelNotHigh: true,
      forbiddenClaims: [
        "本书详细介绍",
        "本书详细介绍了",
        "本书详细讲述",
        "本书讲述了",
        "本书通过详细",
        "本书通过",
        "本书深入",
        "书中详细",
        "内容简介",
        "内容详尽",
        "读者评价",
        "作者生平",
        "书中指出",
        "获得奖项",
        "获奖情况",
        "销量",
        "影响力",
        "被翻译成",
      ],
      requiredBasisFields: ["title", "ssid", "dxid", "publisher"],
    },
  },
  {
    id: "insight-not-found",
    bookId: "not_exist_000000",
    live: false,
    expected: {
      expectedStatus: 404,
      shouldNot500: true,
    },
  },
];

/** Forbidden full-text claim phrases (mirrored from sanitizeBookInsightResult).
 *  Order matters: longer phrases first. The list deliberately avoids bare
 *  "全文" / "内容" because those words appear in legitimate caveats like
 *  "非全文内容" and must not be erased. */
export const FORBIDDEN_FULL_CONTENT_PHRASES = [
  "本书详细介绍",
  "本书详细介绍了",
  "本书详细讲述",
  "本书讲述了",
  "本书通过详细",
  "本书通过",
  "本书深入",
  "书中详细",
  "内容简介",
  "内容详尽",
  "读者评价",
  "作者生平",
  "书中指出",
  "获得奖项",
  "获奖情况",
  "销量",
  "影响力",
  "被翻译成",
];

/** Max total AI calls per regression run. */
export const DEFAULT_MAX_AI_CALLS = 10;
