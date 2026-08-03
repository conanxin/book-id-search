/**
 * S27K — Tests for the year-over-year comparison model.
 *
 * Mirrors the structure of `wereadAnnualReviewModel.test.ts`:
 *   - All fixtures are synthetic annual-review responses.
 *   - Forbidden content is asserted (no note text, no private ids,
 *     no AI summary fields, no token leakage).
 *   - Pure-function coverage: deltas, percent change, zero baseline,
 *     monthly alignment, quarter order, book rank changes, metadata
 *     fallback, empty years.
 */

import { describe, expect, it } from "vitest";
import {
  buildWereadYearComparison,
  buildYearComparisonBookChanges,
  buildYearComparisonMetrics,
  buildYearComparisonMonths,
  buildYearComparisonQuarters,
  buildYearComparisonSummaries,
  calculateComparisonDelta,
  calculatePercentChange,
  formatComparisonDelta,
  formatComparisonPercent,
  getComparisonDirection,
  hasYearComparisonData,
} from "./wereadYearComparisonModel";
import type { WereadAnnualReviewResponse } from "../wereadPrivate";

// ---------- fixtures ----------

function makeMonth(
  year: number,
  monthNumber: number,
  total: number,
  bookCount: number
): { month: string; total: number; highlights: number; thoughts: number; reviews: number; unknown: number; matched: number; bookCount: number } {
  const mm = String(monthNumber).padStart(2, "0");
  return {
    month: `${year}-${mm}`,
    total,
    highlights: Math.max(0, total - 2),
    thoughts: 1,
    reviews: 1,
    unknown: 0,
    matched: total > 0 ? Math.min(total, 3) : 0,
    bookCount,
  };
}

function makeResponse(overrides: Partial<WereadAnnualReviewResponse> = {}): WereadAnnualReviewResponse {
  const year = overrides.selectedYear ?? 2025;
  const months = Array.from({ length: 12 }, (_, i) =>
    makeMonth(year, i + 1, i === 0 ? 10 : 0, i === 0 ? 1 : 0)
  );
  const quarters = [
    { quarter: "Q1" as const, total: 10, activeMonths: 1, matchedRecords: 3, bookCount: 1 },
    { quarter: "Q2" as const, total: 0, activeMonths: 0, matchedRecords: 0, bookCount: 0 },
    { quarter: "Q3" as const, total: 0, activeMonths: 0, matchedRecords: 0, bookCount: 0 },
    { quarter: "Q4" as const, total: 0, activeMonths: 0, matchedRecords: 0, bookCount: 0 },
  ];
  const topBooks = [
    {
      catalogId: "BOOK-A",
      title: "公共书目 A",
      author: "作者甲",
      publisher: "出版社甲",
      publishYear: 2020,
      noteCount: 10,
      highlights: 8,
      thoughts: 1,
      reviews: 1,
      unknown: 0,
      activeMonths: 1,
      firstNoteAt: `${year}-01-10T00:00:00.000Z`,
      lastNoteAt: `${year}-01-15T00:00:00.000Z`,
    },
  ];
  return {
    ok: true,
    selectedYear: year,
    availableYears: [year, year - 1, year - 2],
    overview: {
      year,
      totalRecords: 10,
      datedRecords: 10,
      matchedRecords: 3,
      matchedBooks: 1,
      activeMonths: 1,
      longestStreakMonths: 1,
      firstNoteAt: `${year}-01-10T00:00:00.000Z`,
      lastNoteAt: `${year}-01-15T00:00:00.000Z`,
      peakMonth: `${year}-01`,
      peakMonthRecords: 10,
      averageRecordsPerActiveMonth: 10,
    },
    months,
    quarters,
    topBooks,
    meta: {
      topBooksRequested: 12,
      topBooksReturned: topBooks.length,
      persisted: false,
      source: "private_snapshot+public_catalog",
    },
    ...overrides,
  };
}

const FORBIDDEN_WORDS = [
  "FORBIDDEN_NOTE_TEXT",
  "FORBIDDEN_NOTE_COMMENT",
  "FORBIDDEN_OVERVIEW",
  "FORBIDDEN_KEYPOINT",
  "FORBIDDEN_QUESTION",
  "FORBIDDEN_THEME_BODY",
  "smoke-token-12345",
  "lazy",
  "懒惰",
  "焦虑",
  "专注力",
  "阅读兴趣发生转移",
  "更喜欢",
  "停止阅读",
  "今年新读",
];

// ---------- pure helpers ----------

describe("calculateComparisonDelta", () => {
  it("1. returns positive delta for increase", () => {
    expect(calculateComparisonDelta(10, 25)).toBe(15);
  });
  it("2. returns negative delta for decrease", () => {
    expect(calculateComparisonDelta(25, 10)).toBe(-15);
  });
  it("3. returns zero when both values are equal", () => {
    expect(calculateComparisonDelta(7, 7)).toBe(0);
  });
});

describe("calculatePercentChange + getComparisonDirection", () => {
  it("4. computes percentChange when base > 0", () => {
    expect(calculatePercentChange(10, 25)).toBe(150);
    expect(getComparisonDirection(10, 25)).toBe("increase");
  });
  it("5. detects decrease", () => {
    expect(calculatePercentChange(20, 10)).toBe(-50);
    expect(getComparisonDirection(20, 10)).toBe("decrease");
  });
  it("6. returns null and from_zero when base is 0 and target > 0", () => {
    expect(calculatePercentChange(0, 10)).toBeNull();
    expect(getComparisonDirection(0, 10)).toBe("from_zero");
  });
  it("7. returns -100 and to_zero when base > 0 and target is 0", () => {
    expect(calculatePercentChange(10, 0)).toBe(-100);
    expect(getComparisonDirection(10, 0)).toBe("to_zero");
  });
  it("8. returns 0 and same when both zero", () => {
    expect(calculatePercentChange(0, 0)).toBe(0);
    expect(getComparisonDirection(0, 0)).toBe("same");
  });
  it("9. never produces NaN / Infinity", () => {
    expect(Number.isFinite(calculatePercentChange(0.0001, 0.0002) || 0)).toBe(true);
    const pc = calculatePercentChange(0, 0);
    expect(pc).toBe(0);
  });
});

// ---------- metrics ----------

describe("buildYearComparisonMetrics", () => {
  it("10. emits six metric rows with correct labels", () => {
    const base = makeResponse();
    const target = makeResponse({
      selectedYear: 2024,
      overview: {
        year: 2024,
        totalRecords: 30,
        datedRecords: 30,
        matchedRecords: 9,
        matchedBooks: 3,
        activeMonths: 3,
        longestStreakMonths: 3,
        firstNoteAt: "2024-02-01T00:00:00.000Z",
        lastNoteAt: "2024-12-01T00:00:00.000Z",
        peakMonth: "2024-05",
        peakMonthRecords: 15,
        averageRecordsPerActiveMonth: 10,
      },
    });
    const metrics = buildYearComparisonMetrics({ base, target });
    expect(metrics).toHaveLength(6);
    expect(metrics.map((m) => m.key)).toEqual([
      "totalRecords",
      "activeMonths",
      "matchedRecords",
      "matchedBooks",
      "longestStreakMonths",
      "averageRecordsPerActiveMonth",
    ]);
    const total = metrics.find((m) => m.key === "totalRecords");
    expect(total?.baseValue).toBe(10);
    expect(total?.targetValue).toBe(30);
    expect(total?.delta).toBe(20);
    expect(total?.direction).toBe("increase");
  });
});

// ---------- monthly + quarterly ----------

describe("buildYearComparisonMonths", () => {
  it("11. always returns 12 entries in month-number order", () => {
    const base = makeResponse();
    const target = makeResponse({ selectedYear: 2024 });
    const months = buildYearComparisonMonths({ base, target });
    expect(months.map((m) => m.monthNumber)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(months[0]?.label).toBe("1月");
    expect(months[11]?.label).toBe("12月");
  });
  it("12. treats a missing month in either year as 0", () => {
    const base = makeResponse();
    const target = makeResponse({
      selectedYear: 2024,
      months: Array.from({ length: 12 }, (_, i) => makeMonth(2024, i + 1, 0, 0)),
    });
    const months = buildYearComparisonMonths({ base, target });
    expect(months[0]?.baseTotal).toBe(10);
    expect(months[0]?.targetTotal).toBe(0);
    expect(months[0]?.delta).toBe(-10);
    expect(months[11]?.baseTotal).toBe(0);
    expect(months[11]?.targetTotal).toBe(0);
    expect(months[11]?.delta).toBe(0);
  });
  it("13. ignores malformed month keys silently", () => {
    const base = makeResponse({
      months: [
        ...Array.from({ length: 12 }, (_, i) => makeMonth(2025, i + 1, 0, 0)),
        { month: "broken", total: 99, highlights: 0, thoughts: 0, reviews: 0, unknown: 0, matched: 0, bookCount: 99 },
      ] as never,
    });
    const target = makeResponse({ selectedYear: 2024 });
    const months = buildYearComparisonMonths({ base, target });
    expect(months).toHaveLength(12);
  });
});

describe("buildYearComparisonQuarters", () => {
  it("14. emits Q1→Q4 in fixed order with deltas", () => {
    const base = makeResponse();
    const target = makeResponse({
      selectedYear: 2024,
      quarters: [
        { quarter: "Q1" as const, total: 5, activeMonths: 2, matchedRecords: 1, bookCount: 1 },
        { quarter: "Q2" as const, total: 8, activeMonths: 2, matchedRecords: 2, bookCount: 2 },
        { quarter: "Q3" as const, total: 12, activeMonths: 3, matchedRecords: 4, bookCount: 3 },
        { quarter: "Q4" as const, total: 0, activeMonths: 0, matchedRecords: 0, bookCount: 0 },
      ],
    });
    const quarters = buildYearComparisonQuarters({ base, target });
    expect(quarters.map((q) => q.quarter)).toEqual(["Q1", "Q2", "Q3", "Q4"]);
    expect(quarters[0]?.baseTotal).toBe(10);
    expect(quarters[0]?.targetTotal).toBe(5);
    expect(quarters[0]?.delta).toBe(-5);
  });
});

// ---------- book ranking changes ----------

describe("buildYearComparisonBookChanges", () => {
  it("15. classifies continuing / entered / left", () => {
    const base = makeResponse({
      topBooks: [
        {
          catalogId: "X",
          title: "基准 X",
          author: "作者 X",
          publisher: null,
          publishYear: null,
          noteCount: 8,
          highlights: 5,
          thoughts: 1,
          reviews: 1,
          unknown: 1,
          activeMonths: 1,
          firstNoteAt: null,
          lastNoteAt: null,
        },
        {
          catalogId: "Y",
          title: "基准 Y",
          author: "作者 Y",
          publisher: null,
          publishYear: null,
          noteCount: 5,
          highlights: 4,
          thoughts: 1,
          reviews: 0,
          unknown: 0,
          activeMonths: 1,
          firstNoteAt: null,
          lastNoteAt: null,
        },
      ],
    });
    const target = makeResponse({
      selectedYear: 2024,
      topBooks: [
        {
          catalogId: "X",
          title: "目标 X",
          author: "作者 X",
          publisher: null,
          publishYear: null,
          noteCount: 12,
          highlights: 9,
          thoughts: 1,
          reviews: 1,
          unknown: 1,
          activeMonths: 2,
          firstNoteAt: null,
          lastNoteAt: null,
        },
        {
          catalogId: "Z",
          title: "目标 Z",
          author: "作者 Z",
          publisher: null,
          publishYear: null,
          noteCount: 4,
          highlights: 3,
          thoughts: 1,
          reviews: 0,
          unknown: 0,
          activeMonths: 1,
          firstNoteAt: null,
          lastNoteAt: null,
        },
      ],
    });
    const changes = buildYearComparisonBookChanges({ base, target });
    expect(changes.continuing.map((b) => b.catalogId)).toEqual(["X"]);
    expect(changes.entered.map((b) => b.catalogId)).toEqual(["Z"]);
    expect(changes.left.map((b) => b.catalogId)).toEqual(["Y"]);
  });

  it("16. merges metadata: target wins over base when both present", () => {
    const base = makeResponse({
      topBooks: [
        {
          catalogId: "X",
          title: "基准 X",
          author: "作者 基准",
          publisher: "基准出版社",
          publishYear: 2010,
          noteCount: 8,
          highlights: 5,
          thoughts: 1,
          reviews: 1,
          unknown: 1,
          activeMonths: 1,
          firstNoteAt: null,
          lastNoteAt: null,
        },
      ],
    });
    const target = makeResponse({
      selectedYear: 2024,
      topBooks: [
        {
          catalogId: "X",
          title: "目标 X",
          author: "作者 目标",
          publisher: "目标出版社",
          publishYear: 2024,
          noteCount: 12,
          highlights: 9,
          thoughts: 1,
          reviews: 1,
          unknown: 1,
          activeMonths: 2,
          firstNoteAt: null,
          lastNoteAt: null,
        },
      ],
    });
    const changes = buildYearComparisonBookChanges({ base, target });
    expect(changes.continuing[0]?.title).toBe("目标 X");
    expect(changes.continuing[0]?.author).toBe("作者 目标");
    expect(changes.continuing[0]?.publisher).toBe("目标出版社");
    expect(changes.continuing[0]?.publishYear).toBe(2024);
  });

  it("17. rankChange is positive when rank improved (smaller = better)", () => {
    const base = makeResponse({
      topBooks: [
        {
          catalogId: "A",
          title: "A",
          author: null,
          publisher: null,
          publishYear: null,
          noteCount: 5,
          highlights: 5,
          thoughts: 0,
          reviews: 0,
          unknown: 0,
          activeMonths: 1,
          firstNoteAt: null,
          lastNoteAt: null,
        },
        {
          catalogId: "B",
          title: "B",
          author: null,
          publisher: null,
          publishYear: null,
          noteCount: 8,
          highlights: 8,
          thoughts: 0,
          reviews: 0,
          unknown: 0,
          activeMonths: 1,
          firstNoteAt: null,
          lastNoteAt: null,
        },
      ],
    });
    const target = makeResponse({
      selectedYear: 2024,
      topBooks: [
        {
          catalogId: "B",
          title: "B",
          author: null,
          publisher: null,
          publishYear: null,
          noteCount: 10,
          highlights: 10,
          thoughts: 0,
          reviews: 0,
          unknown: 0,
          activeMonths: 1,
          firstNoteAt: null,
          lastNoteAt: null,
        },
        {
          catalogId: "A",
          title: "A",
          author: null,
          publisher: null,
          publishYear: null,
          noteCount: 7,
          highlights: 7,
          thoughts: 0,
          reviews: 0,
          unknown: 0,
          activeMonths: 1,
          firstNoteAt: null,
          lastNoteAt: null,
        },
      ],
    });
    const changes = buildYearComparisonBookChanges({ base, target });
    const a = changes.continuing.find((b) => b.catalogId === "A");
    expect(a?.baseRank).toBe(1);
    expect(a?.targetRank).toBe(2);
    expect(a?.rankChange).toBe(-1); // dropped one slot
    const b = changes.continuing.find((bb) => bb.catalogId === "B");
    expect(b?.baseRank).toBe(2);
    expect(b?.targetRank).toBe(1);
    expect(b?.rankChange).toBe(1); // improved one slot
  });

  it("18. continues with empty topBooks without crashing", () => {
    const base = makeResponse({ topBooks: [] });
    const target = makeResponse({ selectedYear: 2024, topBooks: [] });
    const changes = buildYearComparisonBookChanges({ base, target });
    expect(changes.continuing).toEqual([]);
    expect(changes.entered).toEqual([]);
    expect(changes.left).toEqual([]);
  });
});

// ---------- summaries ----------

describe("buildYearComparisonSummaries", () => {
  it("19. emits descriptive summaries only (no psychological inference)", () => {
    const base = makeResponse();
    const target = makeResponse({
      selectedYear: 2024,
      overview: {
        year: 2024,
        totalRecords: 30,
        datedRecords: 30,
        matchedRecords: 9,
        matchedBooks: 3,
        activeMonths: 3,
        longestStreakMonths: 3,
        firstNoteAt: null,
        lastNoteAt: null,
        peakMonth: "2024-03",
        peakMonthRecords: 12,
        averageRecordsPerActiveMonth: 10,
      },
    });
    const comparison = buildWereadYearComparison({ base, target, topBooksRange: 12 });
    expect(comparison.summaries.length).toBeGreaterThan(0);
    for (const s of comparison.summaries) {
      for (const w of FORBIDDEN_WORDS) {
        expect(s).not.toContain(w);
      }
    }
  });

  it("20. handles empty base + non-empty target (from_zero branch)", () => {
    const base = makeResponse({
      overview: {
        year: 2024,
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
      months: Array.from({ length: 12 }, (_, i) => makeMonth(2024, i + 1, 0, 0)),
      quarters: [
        { quarter: "Q1" as const, total: 0, activeMonths: 0, matchedRecords: 0, bookCount: 0 },
        { quarter: "Q2" as const, total: 0, activeMonths: 0, matchedRecords: 0, bookCount: 0 },
        { quarter: "Q3" as const, total: 0, activeMonths: 0, matchedRecords: 0, bookCount: 0 },
        { quarter: "Q4" as const, total: 0, activeMonths: 0, matchedRecords: 0, bookCount: 0 },
      ],
      topBooks: [],
    });
    const target = makeResponse();
    const comparison = buildWereadYearComparison({ base, target, topBooksRange: 12 });
    expect(comparison.summaries.some((s) => s.includes("从基准年度的 0 条阅读记录增加"))).toBe(true);
    const totalMetric = comparison.metrics.find((m) => m.key === "totalRecords");
    expect(totalMetric?.direction).toBe("from_zero");
    expect(totalMetric?.percentChange).toBeNull();
  });

  it("21. handles non-empty base + empty target (to_zero branch)", () => {
    const base = makeResponse();
    const target = makeResponse({
      selectedYear: 2024,
      overview: {
        year: 2024,
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
      months: Array.from({ length: 12 }, (_, i) => makeMonth(2024, i + 1, 0, 0)),
      quarters: [
        { quarter: "Q1" as const, total: 0, activeMonths: 0, matchedRecords: 0, bookCount: 0 },
        { quarter: "Q2" as const, total: 0, activeMonths: 0, matchedRecords: 0, bookCount: 0 },
        { quarter: "Q3" as const, total: 0, activeMonths: 0, matchedRecords: 0, bookCount: 0 },
        { quarter: "Q4" as const, total: 0, activeMonths: 0, matchedRecords: 0, bookCount: 0 },
      ],
      topBooks: [],
    });
    const comparison = buildWereadYearComparison({ base, target, topBooksRange: 12 });
    const totalMetric = comparison.metrics.find((m) => m.key === "totalRecords");
    expect(totalMetric?.direction).toBe("to_zero");
    expect(totalMetric?.percentChange).toBe(-100);
    expect(comparison.summaries.some((s) => s.includes("降为 0 条"))).toBe(true);
  });

  it("22. handles both years empty (same branch)", () => {
    const empty = makeResponse({
      overview: {
        year: 2024,
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
      months: Array.from({ length: 12 }, (_, i) => makeMonth(2024, i + 1, 0, 0)),
      quarters: [
        { quarter: "Q1" as const, total: 0, activeMonths: 0, matchedRecords: 0, bookCount: 0 },
        { quarter: "Q2" as const, total: 0, activeMonths: 0, matchedRecords: 0, bookCount: 0 },
        { quarter: "Q3" as const, total: 0, activeMonths: 0, matchedRecords: 0, bookCount: 0 },
        { quarter: "Q4" as const, total: 0, activeMonths: 0, matchedRecords: 0, bookCount: 0 },
      ],
      topBooks: [],
    });
    const comparison = buildWereadYearComparison({ base: empty, target: empty, topBooksRange: 12 });
    expect(hasYearComparisonData(comparison)).toBe(false);
    expect(comparison.meta.baseHasData).toBe(false);
    expect(comparison.meta.targetHasData).toBe(false);
  });
});

// ---------- main entry + formatters ----------

describe("buildWereadYearComparison", () => {
  it("23. persists flag is always false", () => {
    const base = makeResponse();
    const target = makeResponse({ selectedYear: 2024 });
    const comparison = buildWereadYearComparison({ base, target, topBooksRange: 12 });
    expect(comparison.meta.persisted).toBe(false);
  });

  it("24. output does not include forbidden content", () => {
    const base = makeResponse();
    const target = makeResponse({ selectedYear: 2024 });
    const comparison = buildWereadYearComparison({ base, target, topBooksRange: 12 });
    const serialised = JSON.stringify(comparison);
    for (const w of FORBIDDEN_WORDS) {
      expect(serialised).not.toContain(w);
    }
  });

  it("25. output is deterministic (same input → same output)", () => {
    const base = makeResponse();
    const target = makeResponse({ selectedYear: 2024 });
    const a = buildWereadYearComparison({ base, target, topBooksRange: 12 });
    const b = buildWereadYearComparison({ base, target, topBooksRange: 12 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("formatComparisonDelta / formatComparisonPercent", () => {
  it("26. delta formatter uses +N / −N / 0", () => {
    expect(formatComparisonDelta(15)).toBe("+15");
    expect(formatComparisonDelta(-7)).toBe("−7");
    expect(formatComparisonDelta(0)).toBe("0");
  });

  it("27. percent formatter rounds to one decimal and handles null", () => {
    expect(formatComparisonPercent(150)).toBe("+150%");
    expect(formatComparisonPercent(-33.34)).toBe("−33.3%");
    expect(formatComparisonPercent(0)).toBe("0%");
    expect(formatComparisonPercent(null)).toBe("—");
  });

  it("28. formatters never return NaN / Infinity strings", () => {
    expect(formatComparisonDelta(Number.NaN)).toBe("0");
    expect(formatComparisonDelta(Number.POSITIVE_INFINITY)).toBe("0");
    expect(formatComparisonPercent(Number.NaN)).toBe("—");
    expect(formatComparisonPercent(Number.POSITIVE_INFINITY)).toBe("—");
  });
});

describe("hasYearComparisonData", () => {
  it("29. returns false for null", () => {
    expect(hasYearComparisonData(null)).toBe(false);
    expect(hasYearComparisonData(undefined)).toBe(false);
  });
  it("30. returns true when either year has data", () => {
    const base = makeResponse();
    const empty = makeResponse({
      selectedYear: 2024,
      overview: {
        year: 2024,
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
      months: Array.from({ length: 12 }, (_, i) => makeMonth(2024, i + 1, 0, 0)),
      quarters: [
        { quarter: "Q1" as const, total: 0, activeMonths: 0, matchedRecords: 0, bookCount: 0 },
        { quarter: "Q2" as const, total: 0, activeMonths: 0, matchedRecords: 0, bookCount: 0 },
        { quarter: "Q3" as const, total: 0, activeMonths: 0, matchedRecords: 0, bookCount: 0 },
        { quarter: "Q4" as const, total: 0, activeMonths: 0, matchedRecords: 0, bookCount: 0 },
      ],
      topBooks: [],
    });
    const comparison = buildWereadYearComparison({ base, target: empty, topBooksRange: 12 });
    expect(hasYearComparisonData(comparison)).toBe(true);
  });
});