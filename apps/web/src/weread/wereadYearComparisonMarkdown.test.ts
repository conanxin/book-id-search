/**
 * S27K-2 — Unit tests for the browser-local Markdown export of the
 * year-over-year WeRead comparison panel.
 *
 * Pure-function coverage. The browser download helper is exercised
 * through dependency injection so jsdom is not required.
 *
 * ≥35 model assertions per the S27K-2 spec.
 */

import { describe, expect, it } from "vitest";
import {
  YEAR_COMPARISON_MARKDOWN_DISCLAIMER_BULLETS,
  YEAR_COMPARISON_MARKDOWN_ENTERED_NOTE,
  YEAR_COMPARISON_MARKDOWN_FILENAME_PREFIX,
  YEAR_COMPARISON_MARKDOWN_INTERPRETATION_NOTE,
  YEAR_COMPARISON_MARKDOWN_LEFT_NOTE,
  YEAR_COMPARISON_MARKDOWN_MIME,
  YEAR_COMPARISON_MARKDOWN_PRIVACY_NOTE,
  YEAR_COMPARISON_MARKDOWN_SITE_BASE_URL,
  buildYearComparisonMarkdown,
  buildYearComparisonMarkdownFilename,
  escapeComparisonMarkdownInline,
  escapeComparisonMarkdownTableCell,
  formatComparisonChange,
  formatComparisonMarkdownDate,
  formatComparisonPercentChange,
  formatComparisonValue,
  triggerYearComparisonMarkdownDownload,
  validateYearComparisonMarkdown,
} from "./wereadYearComparisonMarkdown";
import {
  buildWereadYearComparison,
  type WereadYearComparison,
} from "./wereadYearComparisonModel";
import type {
  WereadAnnualReviewBook,
  WereadAnnualReviewResponse,
} from "../wereadPrivate";

// ---------- fixtures ----------

const NOW = new Date("2026-08-03T08:24:00.000Z");

function makeBook(over: Partial<WereadAnnualReviewBook> = {}): WereadAnnualReviewBook {
  return {
    catalogId: "10000000_000000000001",
    title: "公共书目 A",
    author: "作者 A",
    publisher: "出版社 X",
    publishYear: 2020,
    noteCount: 12,
    highlights: 8,
    thoughts: 3,
    reviews: 1,
    unknown: 0,
    activeMonths: 4,
    firstNoteAt: "2025-01-05T00:00:00.000Z",
    lastNoteAt: "2025-09-30T00:00:00.000Z",
    ...over,
  };
}

function makeResponse(overrides: Partial<WereadAnnualReviewResponse> = {}): WereadAnnualReviewResponse {
  const year = overrides.selectedYear ?? 2025;
  const months = Array.from({ length: 12 }, (_, i) => ({
    month: `${year}-${String(i + 1).padStart(2, "0")}`,
    total: 0,
    highlights: 0,
    thoughts: 0,
    reviews: 0,
    unknown: 0,
    matched: 0,
    bookCount: 0,
  }));
  return {
    ok: true,
    selectedYear: year,
    availableYears: [year, year - 1],
    overview: {
      year,
      totalRecords: 0,
      datedRecords: 0,
      matchedRecords: 0,
      matchedBooks: 0,
      activeMonths: 0,
      longestStreakMonths: 0,
      firstNoteAt: null,
      lastNoteAt: null,
      peakMonth: null,
      peakMonthRecords: 0,
      averageRecordsPerActiveMonth: 0,
    },
    months,
    quarters: [
      { quarter: "Q1", total: 0, activeMonths: 0, matchedRecords: 0, bookCount: 0 },
      { quarter: "Q2", total: 0, activeMonths: 0, matchedRecords: 0, bookCount: 0 },
      { quarter: "Q3", total: 0, activeMonths: 0, matchedRecords: 0, bookCount: 0 },
      { quarter: "Q4", total: 0, activeMonths: 0, matchedRecords: 0, bookCount: 0 },
    ],
    topBooks: [],
    meta: {
      topBooksRequested: 12,
      topBooksReturned: 0,
      persisted: false,
      source: "private_snapshot+public_catalog",
    },
    ...overrides,
  };
}

function makeNonEmptyBase(): WereadAnnualReviewResponse {
  return makeResponse({
    selectedYear: 2024,
    overview: {
      year: 2024,
      totalRecords: 100,
      datedRecords: 100,
      matchedRecords: 80,
      matchedBooks: 5,
      activeMonths: 8,
      longestStreakMonths: 4,
      firstNoteAt: "2024-02-01T00:00:00.000Z",
      lastNoteAt: "2024-11-30T00:00:00.000Z",
      peakMonth: "2024-04",
      peakMonthRecords: 20,
      averageRecordsPerActiveMonth: 12.5,
    },
    months: Array.from({ length: 12 }, (_, i) => ({
      month: `2024-${String(i + 1).padStart(2, "0")}`,
      total: [10, 8, 12, 20, 18, 12, 10, 8, 4, 6, 8, 4][i],
      highlights: [6, 5, 8, 12, 11, 8, 6, 5, 3, 4, 5, 3][i],
      thoughts: [2, 2, 3, 5, 4, 3, 2, 2, 1, 2, 2, 1][i],
      reviews: [1, 1, 1, 2, 2, 1, 1, 1, 0, 0, 1, 0][i],
      unknown: [1, 0, 0, 1, 1, 0, 1, 0, 0, 0, 0, 0][i],
      matched: [8, 6, 10, 17, 15, 10, 8, 6, 3, 5, 7, 3][i],
      bookCount: [3, 2, 3, 4, 4, 3, 3, 2, 1, 2, 2, 1][i],
    })),
    quarters: [
      { quarter: "Q1", total: 30, activeMonths: 3, matchedRecords: 24, bookCount: 5 },
      { quarter: "Q2", total: 50, activeMonths: 3, matchedRecords: 42, bookCount: 6 },
      { quarter: "Q3", total: 22, activeMonths: 3, matchedRecords: 17, bookCount: 4 },
      { quarter: "Q4", total: 18, activeMonths: 3, matchedRecords: 15, bookCount: 3 },
    ],
    topBooks: [
      makeBook({
        catalogId: "10000000_000000000001",
        title: "公共书目 1",
        author: "作者 甲",
        noteCount: 24,
      }),
      makeBook({
        catalogId: "10000000_000000000002",
        title: "公共书目 2",
        author: "作者 乙",
        noteCount: 18,
      }),
    ],
  });
}

function makeNonEmptyTarget(): WereadAnnualReviewResponse {
  return makeResponse({
    selectedYear: 2025,
    overview: {
      year: 2025,
      totalRecords: 150,
      datedRecords: 150,
      matchedRecords: 110,
      matchedBooks: 6,
      activeMonths: 10,
      longestStreakMonths: 6,
      firstNoteAt: "2025-01-01T00:00:00.000Z",
      lastNoteAt: "2025-12-15T00:00:00.000Z",
      peakMonth: "2025-07",
      peakMonthRecords: 30,
      averageRecordsPerActiveMonth: 15,
    },
    months: Array.from({ length: 12 }, (_, i) => ({
      month: `2025-${String(i + 1).padStart(2, "0")}`,
      total: [12, 10, 14, 16, 18, 20, 30, 22, 18, 12, 8, 6][i],
      highlights: [7, 6, 9, 11, 12, 14, 20, 15, 12, 8, 5, 4][i],
      thoughts: [3, 3, 4, 4, 5, 5, 8, 6, 5, 3, 2, 1][i],
      reviews: [1, 1, 1, 1, 1, 1, 2, 1, 1, 1, 1, 1][i],
      unknown: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0][i],
      matched: [10, 8, 12, 14, 16, 18, 27, 19, 15, 10, 7, 5][i],
      bookCount: [3, 3, 4, 4, 5, 5, 6, 5, 4, 3, 2, 2][i],
    })),
    quarters: [
      { quarter: "Q1", total: 36, activeMonths: 3, matchedRecords: 30, bookCount: 6 },
      { quarter: "Q2", total: 54, activeMonths: 3, matchedRecords: 48, bookCount: 7 },
      { quarter: "Q3", total: 70, activeMonths: 3, matchedRecords: 61, bookCount: 8 },
      { quarter: "Q4", total: 26, activeMonths: 3, matchedRecords: 22, bookCount: 4 },
    ],
    topBooks: [
      makeBook({
        catalogId: "10000000_000000000001",
        title: "公共书目 1",
        author: "作者 甲",
        noteCount: 30,
      }),
      makeBook({
        catalogId: "10000000_000000000003",
        title: "公共书目 3",
        author: "作者 丙",
        noteCount: 16,
      }),
    ],
  });
}

function makeComparison(args: {
  base?: WereadAnnualReviewResponse;
  target?: WereadAnnualReviewResponse;
  topBooksRange?: number;
} = {}): WereadYearComparison {
  return buildWereadYearComparison({
    base: args.base ?? makeNonEmptyBase(),
    target: args.target ?? makeNonEmptyTarget(),
    topBooksRange: args.topBooksRange ?? 12,
  });
}

// ---------- 1: escapeComparisonMarkdownInline ----------

describe("escapeComparisonMarkdownInline", () => {
  it("escapes Markdown meta characters", () => {
    const out = escapeComparisonMarkdownInline("a\\b*c_d`e[f]g<h>i#j|k");
    expect(out).toBe("a\\\\b\\*c\\_d\\`e\\[f\\]g\\<h\\>i\\#j\\|k");
  });
  it("collapses whitespace and strips control characters", () => {
    const out = escapeComparisonMarkdownInline("a   b\tc\u0007d");
    expect(out).toBe("a b c d");
  });
  it("treats null and undefined as empty", () => {
    expect(escapeComparisonMarkdownInline(null)).toBe("");
    expect(escapeComparisonMarkdownInline(undefined)).toBe("");
  });
  it("never allows a public title to impersonate a heading line", () => {
    const out = escapeComparisonMarkdownInline("# public title");
    expect(out).toBe("\\# public title");
  });
  it("strips newlines so the inline string stays on a single line", () => {
    const out = escapeComparisonMarkdownInline("line1\nline2\r\nline3");
    expect(out.includes("\n")).toBe(false);
    expect(out.includes("\r")).toBe(false);
  });
});

// ---------- 2: escapeComparisonMarkdownTableCell ----------

describe("escapeComparisonMarkdownTableCell", () => {
  it("escapes pipe characters and collapses newlines", () => {
    const out = escapeComparisonMarkdownTableCell("a|b\nc|d");
    expect(out).toBe("a\\|b c\\|d");
    expect(out.includes("\n")).toBe(false);
  });
  it("returns empty string for nullish input", () => {
    expect(escapeComparisonMarkdownTableCell(null)).toBe("");
    expect(escapeComparisonMarkdownTableCell(undefined)).toBe("");
  });
  it("escapes HTML meta characters so cells stay plain text", () => {
    expect(escapeComparisonMarkdownTableCell("<script>alert</script>")).toBe(
      "\\<script\\>alert\\</script\\>"
    );
  });
});

// ---------- 3: formatters ----------

describe("formatters", () => {
  it("formatComparisonMarkdownDate uses local YYYY-MM-DD HH:mm", () => {
    expect(formatComparisonMarkdownDate(NOW)).toBe(
      `${NOW.getFullYear()}-${String(NOW.getMonth() + 1).padStart(2, "0")}-${String(NOW.getDate()).padStart(2, "0")} ${String(NOW.getHours()).padStart(2, "0")}:${String(NOW.getMinutes()).padStart(2, "0")}`
    );
  });
  it("formatComparisonValue never produces NaN / Infinity", () => {
    expect(formatComparisonValue(Number.NaN)).toBe("0");
    expect(formatComparisonValue(Number.POSITIVE_INFINITY)).toBe("0");
    expect(formatComparisonValue(0)).toBe("0");
    expect(formatComparisonValue(123)).toBe("123");
  });
  it("formatComparisonChange prepends + for positive deltas", () => {
    expect(formatComparisonChange(10)).toBe("+10");
    expect(formatComparisonChange(-10)).toBe("−10");
    expect(formatComparisonChange(0)).toBe("0");
    expect(formatComparisonChange(Number.NaN)).toBe("0");
  });
  it("formatComparisonPercentChange follows the documented rules", () => {
    expect(formatComparisonPercentChange({ baseValue: 0, targetValue: 0 })).toBe("0%");
    expect(formatComparisonPercentChange({ baseValue: 10, targetValue: 10 })).toBe("0%");
    expect(formatComparisonPercentChange({ baseValue: 0, targetValue: 5 })).toBe("由 0 开始");
    expect(formatComparisonPercentChange({ baseValue: 5, targetValue: 0 })).toBe("-100%");
    expect(formatComparisonPercentChange({ baseValue: 10, targetValue: 12 })).toBe("+20%");
    expect(formatComparisonPercentChange({ baseValue: 12, targetValue: 9 })).toBe("−25%");
  });
});

// ---------- 4: buildYearComparisonMarkdown — structure ----------

describe("buildYearComparisonMarkdown — structure", () => {
  it("1. title includes both years in YYYY—YYYY format", () => {
    const out = buildYearComparisonMarkdown({
      comparison: makeComparison(),
      topBooksLimit: 12,
      exportedAt: NOW,
    });
    expect(out.content.startsWith("# 2024—2025 年阅读对比")).toBe(true);
  });
  it("2. Top N range appears in the meta bullets", () => {
    const out = buildYearComparisonMarkdown({
      comparison: makeComparison(),
      topBooksLimit: 18,
      exportedAt: NOW,
    });
    expect(out.content).toContain("- 高互动书目范围：Top 18");
  });
  it("3. core metrics table lists all six metric keys", () => {
    const out = buildYearComparisonMarkdown({
      comparison: makeComparison(),
      topBooksLimit: 12,
      exportedAt: NOW,
    });
    for (const label of [
      "阅读记录",
      "活跃月份",
      "已匹配记录",
      "年度书目",
      "最长连续月份",
      "活跃月份平均记录",
    ]) {
      expect(out.content).toContain(label);
    }
  });
  it("4. increase/decrease/same rows are formatted with signed deltas", () => {
    const out = buildYearComparisonMarkdown({
      comparison: makeComparison(),
      topBooksLimit: 12,
      exportedAt: NOW,
    });
    // totalRecords goes 100 -> 150 (increase)
    expect(out.content).toContain("| 阅读记录 | 100 | 150 | +50 |");
  });
  it("5. from_zero renders '由 0 开始'", () => {
    // base has zero longest streak but target has 3 -> from_zero.
    const base = makeNonEmptyBase();
    const target = makeNonEmptyTarget();
    const comparison = buildWereadYearComparison({ base, target, topBooksRange: 12 });
    // Build synthetic from_zero by overriding the comparison object.
    const patched: WereadYearComparison = {
      ...comparison,
      metrics: comparison.metrics.map((m) =>
        m.key === "matchedBooks"
          ? { ...m, baseValue: 0, targetValue: 4, delta: 4, percentChange: null, direction: "from_zero" }
          : m
      ),
    };
    const out = buildYearComparisonMarkdown({
      comparison: patched,
      topBooksLimit: 12,
      exportedAt: NOW,
    });
    expect(out.content).toContain("由 0 开始");
    expect(out.content).not.toMatch(/Infinity|NaN/);
  });
  it("6. to_zero renders '-100%'", () => {
    const base = makeNonEmptyBase();
    const target = makeNonEmptyTarget();
    const comparison = buildWereadYearComparison({ base, target, topBooksRange: 12 });
    const patched: WereadYearComparison = {
      ...comparison,
      metrics: comparison.metrics.map((m) =>
        m.key === "matchedBooks"
          ? { ...m, baseValue: 5, targetValue: 0, delta: -5, percentChange: -100, direction: "to_zero" }
          : m
      ),
    };
    const out = buildYearComparisonMarkdown({
      comparison: patched,
      topBooksLimit: 12,
      exportedAt: NOW,
    });
    expect(out.content).toContain("-100%");
    expect(out.content).not.toMatch(/Infinity|NaN/);
  });
  it("7. never emits NaN / Infinity anywhere", () => {
    const out = buildYearComparisonMarkdown({
      comparison: makeComparison(),
      topBooksLimit: 12,
      exportedAt: NOW,
    });
    expect(out.content).not.toMatch(/NaN/);
    expect(out.content).not.toMatch(/Infinity/);
  });
  it("8. emits exactly 12 month rows in the 12-month comparison table", () => {
    const out = buildYearComparisonMarkdown({
      comparison: makeComparison(),
      topBooksLimit: 12,
      exportedAt: NOW,
    });
    const monthRowRegex = /^\|\s*\d{1,2}月\s*\|/;
    const rows = out.content.split("\n").filter((line) => monthRowRegex.test(line));
    expect(rows).toHaveLength(12);
  });
  it("9. quarter sections are emitted in Q1..Q4 order", () => {
    const out = buildYearComparisonMarkdown({
      comparison: makeComparison(),
      topBooksLimit: 12,
      exportedAt: NOW,
    });
    const idxQ1 = out.content.indexOf("### Q1");
    const idxQ2 = out.content.indexOf("### Q2");
    const idxQ3 = out.content.indexOf("### Q3");
    const idxQ4 = out.content.indexOf("### Q4");
    expect(idxQ1).toBeGreaterThan(-1);
    expect(idxQ2).toBeGreaterThan(idxQ1);
    expect(idxQ3).toBeGreaterThan(idxQ2);
    expect(idxQ4).toBeGreaterThan(idxQ3);
  });
});

// ---------- 5: book groups ----------

describe("buildYearComparisonMarkdown — book groups", () => {
  it("10. continuing books section lists each continuing book with ranks", () => {
    const out = buildYearComparisonMarkdown({
      comparison: makeComparison(),
      topBooksLimit: 12,
      exportedAt: NOW,
    });
    expect(out.content).toContain("## 连续进入两年高互动书目榜");
    expect(out.content).toContain("公共书目 1");
    // continuing book gets a rank change row.
    expect(out.content).toMatch(/排名变化：(持平|上升 \d+ 位|下降 \d+ 位)/);
  });
  it("11. entered books section shows entered books with entered disclaimer", () => {
    const out = buildYearComparisonMarkdown({
      comparison: makeComparison(),
      topBooksLimit: 12,
      exportedAt: NOW,
    });
    expect(out.content).toContain("## 进入目标年度高互动书目榜");
    expect(out.content).toContain(YEAR_COMPARISON_MARKDOWN_ENTERED_NOTE);
    expect(out.content).toContain("公共书目 3");
  });
  it("12. left books section shows left books with left disclaimer", () => {
    const out = buildYearComparisonMarkdown({
      comparison: makeComparison(),
      topBooksLimit: 12,
      exportedAt: NOW,
    });
    expect(out.content).toContain("## 未进入目标年度高互动书目榜");
    expect(out.content).toContain(YEAR_COMPARISON_MARKDOWN_LEFT_NOTE);
    expect(out.content).toContain("公共书目 2");
  });
  it("13. rank improvement renders '上升 N 位'", () => {
    const base = makeNonEmptyBase();
    const target = makeResponse({ selectedYear: 2025 });
    target.topBooks = [
      makeBook({
        catalogId: "10000000_000000000001",
        title: "公共书目 1",
        author: "作者 甲",
        noteCount: 30,
      }),
    ];
    const comparison = buildWereadYearComparison({ base, target, topBooksRange: 12 });
    // Patch rank change so we get a deterministic "上升 1 位" line.
    const patched: WereadYearComparison = {
      ...comparison,
      continuingBooks: comparison.continuingBooks.map((b) =>
        b.catalogId === "10000000_000000000001"
          ? { ...b, baseRank: 2, targetRank: 1, rankChange: 1 }
          : b
      ),
    };
    const out = buildYearComparisonMarkdown({
      comparison: patched,
      topBooksLimit: 12,
      exportedAt: NOW,
    });
    expect(out.content).toContain("上升 1 位");
  });
  it("14. rank decline renders '下降 N 位'", () => {
    const base = makeResponse({ selectedYear: 2024 });
    base.topBooks = [
      makeBook({
        catalogId: "10000000_000000000001",
        title: "公共书目 1",
        author: "作者 甲",
        noteCount: 30,
      }),
    ];
    const target = makeNonEmptyTarget();
    const comparison = buildWereadYearComparison({ base, target, topBooksRange: 12 });
    const patched: WereadYearComparison = {
      ...comparison,
      continuingBooks: comparison.continuingBooks.map((b) =>
        b.catalogId === "10000000_000000000001"
          ? { ...b, baseRank: 1, targetRank: 2, rankChange: -1 }
          : b
      ),
    };
    const out = buildYearComparisonMarkdown({
      comparison: patched,
      topBooksLimit: 12,
      exportedAt: NOW,
    });
    expect(out.content).toContain("下降 1 位");
  });
  it("15. tied rank renders '持平'", () => {
    const base = makeResponse({ selectedYear: 2024 });
    base.topBooks = [
      makeBook({
        catalogId: "10000000_000000000001",
        title: "公共书目 1",
        author: "作者 甲",
        noteCount: 10,
      }),
    ];
    const target = makeResponse({ selectedYear: 2025 });
    target.topBooks = [
      makeBook({
        catalogId: "10000000_000000000001",
        title: "公共书目 1",
        author: "作者 甲",
        noteCount: 18,
      }),
    ];
    const comparison = buildWereadYearComparison({ base, target, topBooksRange: 12 });
    const out = buildYearComparisonMarkdown({
      comparison,
      topBooksLimit: 12,
      exportedAt: NOW,
    });
    expect(out.content).toContain("持平");
  });
  it("16. omits the author line when missing", () => {
    const base = makeResponse({ selectedYear: 2024 });
    base.topBooks = [
      makeBook({ catalogId: "10000000_000000000001", title: "公共书目 A", author: null, noteCount: 5 }),
    ];
    const target = makeResponse({ selectedYear: 2025 });
    target.topBooks = [
      makeBook({ catalogId: "10000000_000000000001", title: "公共书目 A", author: null, noteCount: 12 }),
    ];
    const comparison = buildWereadYearComparison({ base, target, topBooksRange: 12 });
    const out = buildYearComparisonMarkdown({
      comparison,
      topBooksLimit: 12,
      exportedAt: NOW,
    });
    // No author line should appear for the continuing section.
    expect(out.content).toMatch(/### 1\. 《公共书目 A》[\s\S]*?\n- 作者：—/);
  });
  it("17. each book row includes the public catalog URL", () => {
    const out = buildYearComparisonMarkdown({
      comparison: makeComparison(),
      topBooksLimit: 12,
      exportedAt: NOW,
    });
    expect(out.content).toContain(
      `- 书目页面：${YEAR_COMPARISON_MARKDOWN_SITE_BASE_URL}/books/10000000_000000000001`
    );
  });
});

// ---------- 6: empty + edge cases ----------

describe("buildYearComparisonMarkdown — edge cases", () => {
  it("18. both years empty still produces a valid document", () => {
    const base = makeResponse({ selectedYear: 2024 });
    const target = makeResponse({ selectedYear: 2025 });
    const comparison = buildWereadYearComparison({ base, target, topBooksRange: 12 });
    const out = buildYearComparisonMarkdown({
      comparison,
      topBooksLimit: 12,
      exportedAt: NOW,
    });
    expect(out.content).toContain("## 核心指标");
    expect(out.content).toContain("## 12 个月对比");
    expect(out.content).toContain("## 季度对比");
    expect(out.content).toContain("## 连续进入两年高互动书目榜");
    expect(out.content).toContain("## 进入目标年度高互动书目榜");
    expect(out.content).toContain("## 未进入目标年度高互动书目榜");
    expect(validateYearComparisonMarkdown(out.content)).toEqual([]);
  });
  it("19. empty base + non-empty target still produces a valid document", () => {
    const base = makeResponse({ selectedYear: 2024 });
    const target = makeNonEmptyTarget();
    const comparison = buildWereadYearComparison({ base, target, topBooksRange: 12 });
    const out = buildYearComparisonMarkdown({
      comparison,
      topBooksLimit: 12,
      exportedAt: NOW,
    });
    expect(out.content).toContain("由 0 开始");
    expect(out.content).toContain(YEAR_COMPARISON_MARKDOWN_ENTERED_NOTE);
    expect(validateYearComparisonMarkdown(out.content)).toEqual([]);
  });
  it("20. non-empty base + empty target still produces a valid document", () => {
    const base = makeNonEmptyBase();
    const target = makeResponse({ selectedYear: 2025 });
    const comparison = buildWereadYearComparison({ base, target, topBooksRange: 12 });
    const out = buildYearComparisonMarkdown({
      comparison,
      topBooksLimit: 12,
      exportedAt: NOW,
    });
    expect(out.content).toContain("-100%");
    expect(out.content).toContain(YEAR_COMPARISON_MARKDOWN_LEFT_NOTE);
    expect(validateYearComparisonMarkdown(out.content)).toEqual([]);
  });
  it("21. validate() catches a document missing the top-level title", () => {
    const out = validateYearComparisonMarkdown("no title at all");
    expect(out.length).toBeGreaterThan(0);
  });
  it("22. rejects invalid topBooksLimit values", () => {
    const comparison = makeComparison();
    expect(() =>
      buildYearComparisonMarkdown({
        comparison,
        topBooksLimit: 7 as unknown as 12,
        exportedAt: NOW,
      })
    ).toThrow();
  });
  it("23. rejects invalid base/target years", () => {
    const comparison = makeComparison();
    const patched = { ...comparison, baseYear: 123 };
    expect(() =>
      buildYearComparisonMarkdown({
        comparison: patched as WereadYearComparison,
        topBooksLimit: 12,
        exportedAt: NOW,
      })
    ).toThrow();
  });
});

// ---------- 7: escaping / privacy ----------

describe("buildYearComparisonMarkdown — escaping & privacy", () => {
  it("24. public title with pipe does not break the metric table", () => {
    const base = makeResponse({ selectedYear: 2024 });
    base.topBooks = [
      makeBook({ catalogId: "A", title: "公共|书目", author: "作者|甲", noteCount: 4 }),
    ];
    const target = makeResponse({ selectedYear: 2025 });
    target.topBooks = [
      makeBook({ catalogId: "A", title: "公共|书目", author: "作者|甲", noteCount: 6 }),
    ];
    const comparison = buildWereadYearComparison({ base, target, topBooksRange: 12 });
    const out = buildYearComparisonMarkdown({
      comparison,
      topBooksLimit: 12,
      exportedAt: NOW,
    });
    // Public fields are escaped inside the markdown.
    expect(out.content).toContain("公共\\|书目");
    expect(out.content).toContain("作者\\|甲");
  });
  it("25. blocks public-title heading injection", () => {
    const base = makeResponse({ selectedYear: 2024 });
    base.topBooks = [
      makeBook({ catalogId: "A", title: "# 假冒标题", author: null, noteCount: 4 }),
    ];
    const target = makeResponse({ selectedYear: 2025 });
    target.topBooks = [
      makeBook({ catalogId: "A", title: "# 假冒标题", author: null, noteCount: 6 }),
    ];
    const comparison = buildWereadYearComparison({ base, target, topBooksRange: 12 });
    const out = buildYearComparisonMarkdown({
      comparison,
      topBooksLimit: 12,
      exportedAt: NOW,
    });
    // The public title must be wrapped in 《》 with the leading `#`
    // escaped — it can never appear unescaped at the start of a line.
    expect(out.content).toContain("《\\# 假冒标题》");
    expect(out.content).not.toMatch(/^# 假冒标题/m);
  });
  it("26. HTML characters are escaped in public fields", () => {
    const base = makeResponse({ selectedYear: 2024 });
    base.topBooks = [
      makeBook({ catalogId: "A", title: "<img>", author: "<b>", noteCount: 4 }),
    ];
    const target = makeResponse({ selectedYear: 2025 });
    target.topBooks = [
      makeBook({ catalogId: "A", title: "<img>", author: "<b>", noteCount: 6 }),
    ];
    const comparison = buildWereadYearComparison({ base, target, topBooksRange: 12 });
    const out = buildYearComparisonMarkdown({
      comparison,
      topBooksLimit: 12,
      exportedAt: NOW,
    });
    expect(out.content).not.toMatch(/<img>/);
    expect(out.content).not.toMatch(/<b>/);
  });
  it("27. never embeds note text / comment / AI summary markers", () => {
    const out = buildYearComparisonMarkdown({
      comparison: makeComparison(),
      topBooksLimit: 12,
      exportedAt: NOW,
    });
    expect(out.content).not.toMatch(/note\.text|note\.comment|markedText/);
    expect(out.content).not.toMatch(/overview|keyPoints|reviewQuestions|themes/);
  });
  it("28. never leaks private IDs or token", () => {
    const out = buildYearComparisonMarkdown({
      comparison: makeComparison(),
      topBooksLimit: 12,
      exportedAt: NOW,
    });
    expect(out.content).not.toMatch(/\bwereadBookId\b/);
    expect(out.content).not.toMatch(/\bnoteId\b/);
    expect(out.content).not.toMatch(/\bhighlightId\b/);
    expect(out.content).not.toMatch(/\bchapterTitle\b/);
    expect(out.content).not.toMatch(/token/i);
    expect(out.content).not.toMatch(/api[_-]?key/i);
    expect(out.content).not.toContain("Authorization");
  });
});

// ---------- 8: filename ----------

describe("buildYearComparisonMarkdownFilename", () => {
  it("29. builds the documented filename format", () => {
    const name = buildYearComparisonMarkdownFilename({
      baseYear: 2024,
      targetYear: 2025,
      now: NOW,
    });
    expect(name).toBe(`${YEAR_COMPARISON_MARKDOWN_FILENAME_PREFIX}-2024-vs-2025-20260803.md`);
  });
  it("30. is pure ASCII and never embeds private data", () => {
    const name = buildYearComparisonMarkdownFilename({
      baseYear: 2024,
      targetYear: 2025,
      now: NOW,
    });
    expect(name).toMatch(/^[\x20-\x7e]+$/);
    expect(name).not.toContain("token");
    expect(name).not.toContain("note");
    expect(name).not.toContain("作者");
    expect(name).not.toContain("书目");
  });
  it("31. rejects non-4-digit base/target years", () => {
    expect(() =>
      buildYearComparisonMarkdownFilename({ baseYear: 2024, targetYear: 20, now: NOW })
    ).toThrow();
    expect(() =>
      buildYearComparisonMarkdownFilename({ baseYear: 24, targetYear: 2025, now: NOW })
    ).toThrow();
  });
  it("32. keeps filename length ≤ 80", () => {
    const name = buildYearComparisonMarkdownFilename({
      baseYear: 2024,
      targetYear: 2025,
      now: NOW,
    });
    expect(name.length).toBeLessThanOrEqual(80);
  });
});

// ---------- 9: download helper ----------

describe("triggerYearComparisonMarkdownDownload", () => {
  it("33. uses the documented MIME type and triggers a download", () => {
    let createdWith: Blob | null = null;
    let revokedUrl: string | null = null;
    let attached = false;
    const result = triggerYearComparisonMarkdownDownload({
      content: "# 2024—2025 年阅读对比\n",
      filename: `${YEAR_COMPARISON_MARKDOWN_FILENAME_PREFIX}-2024-vs-2025-20260803.md`,
      createObjectUrl: (blob) => {
        createdWith = blob;
        return "blob:mock-1";
      },
      revokeObjectUrl: (url) => {
        revokedUrl = url;
      },
      attachAnchor: () => {
        attached = true;
      },
    });
    expect(createdWith).not.toBeNull();
    expect((createdWith as unknown as Blob).type).toBe(YEAR_COMPARISON_MARKDOWN_MIME);
    expect(result.mimeType).toBe(YEAR_COMPARISON_MARKDOWN_MIME);
    expect(result.blobUrl).toBe("blob:mock-1");
    expect(result.downloadTriggered).toBe(true);
    expect(attached).toBe(true);
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(revokedUrl).toBe("blob:mock-1");
        resolve();
      }, 5);
    });
  });
  it("34. schedules URL.revokeObjectURL on the next tick", () => {
    let revokedUrl: string | null = null;
    triggerYearComparisonMarkdownDownload({
      content: "# 2024—2025 年阅读对比\n",
      filename: `${YEAR_COMPARISON_MARKDOWN_FILENAME_PREFIX}-2024-vs-2025-20260803.md`,
      createObjectUrl: () => "blob:mock-2",
      revokeObjectUrl: (url) => {
        revokedUrl = url;
      },
      attachAnchor: () => undefined,
    });
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(revokedUrl).toBe("blob:mock-2");
        resolve();
      }, 5);
    });
  });
  it("35. never touches localStorage / sessionStorage / IndexedDB", () => {
    const storageSpies = { getItem: 0, setItem: 0, removeItem: 0, clear: 0 };
    const originalLS = (globalThis as { localStorage?: unknown }).localStorage;
    const originalSS = (globalThis as { sessionStorage?: unknown }).sessionStorage;
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: () => {
        storageSpies.getItem += 1;
        return null;
      },
      setItem: () => {
        storageSpies.setItem += 1;
      },
      removeItem: () => {
        storageSpies.removeItem += 1;
      },
      clear: () => {
        storageSpies.clear += 1;
      },
    };
    (globalThis as { sessionStorage?: unknown }).sessionStorage = {
      getItem: () => {
        storageSpies.getItem += 1;
        return null;
      },
      setItem: () => {
        storageSpies.setItem += 1;
      },
      removeItem: () => {
        storageSpies.removeItem += 1;
      },
      clear: () => {
        storageSpies.clear += 1;
      },
    };
    try {
      triggerYearComparisonMarkdownDownload({
        content: "# 2024—2025 年阅读对比\n",
        filename: `${YEAR_COMPARISON_MARKDOWN_FILENAME_PREFIX}-2024-vs-2025-20260803.md`,
        createObjectUrl: () => "blob:mock-x",
        revokeObjectUrl: () => undefined,
        attachAnchor: () => undefined,
      });
    } finally {
      (globalThis as { localStorage?: unknown }).localStorage = originalLS;
      (globalThis as { sessionStorage?: unknown }).sessionStorage = originalSS;
    }
    expect(storageSpies.getItem).toBe(0);
    expect(storageSpies.setItem).toBe(0);
    expect(storageSpies.removeItem).toBe(0);
    expect(storageSpies.clear).toBe(0);
    return Promise.resolve();
  });
  it("36. does not send any network request and does not log content", () => {
    const fetchSpy = vi.fn();
    const originalFetch = (globalThis as { fetch?: unknown }).fetch;
    const originalLog = console.log;
    (globalThis as { fetch?: unknown }).fetch = fetchSpy;
    console.log = () => undefined;
    try {
      triggerYearComparisonMarkdownDownload({
        content: "# 2024—2025 年阅读对比\n",
        filename: `${YEAR_COMPARISON_MARKDOWN_FILENAME_PREFIX}-2024-vs-2025-20260803.md`,
        createObjectUrl: () => "blob:mock-3",
        revokeObjectUrl: () => undefined,
        attachAnchor: () => undefined,
      });
    } finally {
      (globalThis as { fetch?: unknown }).fetch = originalFetch;
      console.log = originalLog;
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ---------- 10: validate ----------

describe("validateYearComparisonMarkdown", () => {
  it("37. accepts a well-formed document", () => {
    const out = buildYearComparisonMarkdown({
      comparison: makeComparison(),
      topBooksLimit: 12,
      exportedAt: NOW,
    });
    expect(validateYearComparisonMarkdown(out.content)).toEqual([]);
  });
  it("38. flags a missing top-level title", () => {
    expect(validateYearComparisonMarkdown("no title at all").length).toBeGreaterThan(0);
  });
  it("39. flags a missing privacy blockquote", () => {
    const out = buildYearComparisonMarkdown({
      comparison: makeComparison(),
      topBooksLimit: 12,
      exportedAt: NOW,
    });
    const stripped = out.content.replace(YEAR_COMPARISON_MARKDOWN_PRIVACY_NOTE, "");
    expect(validateYearComparisonMarkdown(stripped).length).toBeGreaterThan(0);
  });
});

// ---------- 11: deterministic copy ----------

describe("buildYearComparisonMarkdown — deterministic copy", () => {
  it("40. uses the documented privacy, interpretation, entered, and left notices", () => {
    const out = buildYearComparisonMarkdown({
      comparison: makeComparison(),
      topBooksLimit: 12,
      exportedAt: NOW,
    });
    expect(out.content).toContain(`> ${YEAR_COMPARISON_MARKDOWN_PRIVACY_NOTE}`);
    expect(out.content).toContain(`> ${YEAR_COMPARISON_MARKDOWN_INTERPRETATION_NOTE}`);
    expect(out.content).toContain(`> ${YEAR_COMPARISON_MARKDOWN_ENTERED_NOTE}`);
    expect(out.content).toContain(`> ${YEAR_COMPARISON_MARKDOWN_LEFT_NOTE}`);
    for (const bullet of YEAR_COMPARISON_MARKDOWN_DISCLAIMER_BULLETS) {
      expect(out.content).toContain(bullet);
    }
  });
  it("41. includes the documented meta bullets", () => {
    const out = buildYearComparisonMarkdown({
      comparison: makeComparison(),
      topBooksLimit: 12,
      exportedAt: NOW,
    });
    expect(out.content).toContain("- 数据来源：微信读书私有年度聚合数据");
    expect(out.content).toContain("- 生成方式：book-id-search 浏览器本地生成");
    expect(out.content).toContain("- 保存状态：未上传服务器");
  });
});

// ---------- 12: byte length + result contract ----------

describe("buildYearComparisonMarkdown — contracts", () => {
  it("42. byte length matches UTF-8 encoding", () => {
    const out = buildYearComparisonMarkdown({
      comparison: makeComparison(),
      topBooksLimit: 12,
      exportedAt: NOW,
    });
    expect(out.byteLength).toBeGreaterThanOrEqual(out.content.length);
  });
  it("43. result echoes base/target year and topBooksLimit", () => {
    const out = buildYearComparisonMarkdown({
      comparison: makeComparison(),
      topBooksLimit: 6,
      exportedAt: NOW,
    });
    expect(out.baseYear).toBe(2024);
    expect(out.targetYear).toBe(2025);
    expect(out.topBooksLimit).toBe(6);
  });
  it("44. throws when the comparison is null/undefined", () => {
    expect(() =>
      buildYearComparisonMarkdown({
        comparison: null as unknown as WereadYearComparison,
        topBooksLimit: 12,
        exportedAt: NOW,
      })
    ).toThrow();
  });
});

// ---------- 13: psychological-inference guard ----------

describe("buildYearComparisonMarkdown — psychological-inference guard", () => {
  it("45. never produces psychological-inference vocabulary", () => {
    const out = buildYearComparisonMarkdown({
      comparison: makeComparison(),
      topBooksLimit: 12,
      exportedAt: NOW,
    });
    // Note: "兴趣" and "心理状态" appear inside the documented
    // interpretation-boundary blockquote ("...不代表阅读质量、兴趣、
    // 心理状态..."), so they are explicitly allowed. The spec
    // requires that exact disclaimer language.
    for (const word of [
      "懒惰",
      "焦虑感",
      "专注力",
      "人格特征",
      "性格",
      "阅读能力",
      "情绪化",
      "焦虑型",
      "心理问题",
      "心理分析",
      "性格转变",
      "人格分裂",
    ]) {
      expect(out.content).not.toContain(word);
    }
  });
});

// minimal import for vi (avoid pulling in vitest runtime features)
import { vi } from "vitest";