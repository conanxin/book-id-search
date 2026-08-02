import { describe, expect, it } from "vitest";
import {
  ANNUAL_ACTIVITY_LABELS,
  ANNUAL_MONTH_NAMES,
  ANNUAL_QUARTER_LABELS,
  buildAnnualOverviewView,
  buildAnnualRecordCards,
  buildAnnualRhythmSummary,
  buildAnnualTimelineModel,
  buildAnnualTypeDistribution,
  buildQuarterReviewModel,
  classifyAnnualMonthActivity,
  formatAnnualReviewDate,
  formatAnnualReviewMonth,
  formatAnnualReviewOverview,
  formatAnnualReviewYear,
  hasAnnualReviewData,
  truncateAnnualBookTitle,
} from "./wereadAnnualReviewModel";
import type { WereadAnnualReviewResponse } from "../wereadPrivate";

// ---------- fixtures ----------

function makeMonth(month: string, total: number, opts: Partial<{ highlights: number; thoughts: number; reviews: number; unknown: number; matched: number; bookCount: number }> = {}) {
  return {
    month,
    total,
    highlights: opts.highlights ?? 0,
    thoughts: opts.thoughts ?? 0,
    reviews: opts.reviews ?? 0,
    unknown: opts.unknown ?? 0,
    matched: opts.matched ?? 0,
    bookCount: opts.bookCount ?? 0,
  };
}

function makeResponse(overrides: Partial<WereadAnnualReviewResponse> = {}): WereadAnnualReviewResponse {
  const months = Array.from({ length: 12 }, (_, i) =>
    makeMonth(`2025-${String(i + 1).padStart(2, "0")}`, 0)
  );
  return {
    ok: true,
    selectedYear: 2025,
    availableYears: [2025, 2024],
    overview: {
      year: 2025,
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

const FORBIDDEN_WORDS = [
  "懒惰",
  "焦虑",
  "专注力",
  "人格",
  "性格",
  "阅读力",
  "阅读能力",
  "情绪",
  "心理",
];

function allModelSourceText(): string {
  // Static source string from the model — verifies the descriptive
  // vocabulary stays clear of psychological interpretation terms.
  const fs = require("node:fs");
  const path = require("node:path");
  return fs.readFileSync(path.join(__dirname, "./wereadAnnualReviewModel.ts"), "utf8");
}

// ---------- 1: format helpers ----------

describe("format helpers", () => {
  it("formatAnnualReviewYear formats a 4-digit year", () => {
    expect(formatAnnualReviewYear(2025)).toBe("2025 年");
    expect(formatAnnualReviewYear(NaN)).toBe("");
  });

  it("formatAnnualReviewMonth turns YYYY-MM into '2025年3月'", () => {
    expect(formatAnnualReviewMonth("2025-01")).toBe(`2025年${ANNUAL_MONTH_NAMES[0]}`);
    expect(formatAnnualReviewMonth("2025-12")).toBe(`2025年${ANNUAL_MONTH_NAMES[11]}`);
    expect(formatAnnualReviewMonth("garbage")).toBe("garbage");
  });

  it("formatAnnualReviewDate strips time from an ISO timestamp", () => {
    expect(formatAnnualReviewDate("2025-03-08T12:34:56.000Z")).toBe("2025-03-08");
    expect(formatAnnualReviewDate(null)).toBe("—");
    expect(formatAnnualReviewDate("")).toBe("—");
  });

  it("formatAnnualReviewOverview returns '—' for nullish values", () => {
    expect(formatAnnualReviewOverview(null)).toBe("—");
    expect(formatAnnualReviewOverview(undefined)).toBe("—");
    expect(formatAnnualReviewOverview(NaN)).toBe("—");
    expect(formatAnnualReviewOverview(7)).toBe("7");
  });

  it("truncateAnnualBookTitle shortens long titles and preserves short ones", () => {
    expect(truncateAnnualBookTitle("短标题", 8)).toBe("短标题");
    expect(truncateAnnualBookTitle("这是一段相当长的中文标题用来测试截断逻辑", 12)).toMatch(/…$/);
    expect(truncateAnnualBookTitle("")).toBe("");
  });
});

// ---------- 2: buildAnnualTimelineModel ----------

describe("buildAnnualTimelineModel", () => {
  it("returns exactly 12 entries, one per month", () => {
    const months = buildAnnualTimelineModel({
      months: [],
      year: 2025,
      averagePerActiveMonth: 0,
    });
    expect(months).toHaveLength(12);
    expect(months[0].month).toBe("2025-01");
    expect(months[11].month).toBe("2025-12");
    expect(months.every((m) => Number.isFinite(m.heightPct))).toBe(true);
    expect(months.every((m) => !Number.isNaN(m.heightPct))).toBe(true);
  });

  it("zero months get activity='none' and heightPct=0", () => {
    const months = buildAnnualTimelineModel({
      months: [],
      year: 2025,
      averagePerActiveMonth: 0,
    });
    expect(months.every((m) => m.activity === "none")).toBe(true);
    expect(months.every((m) => m.heightPct === 0)).toBe(true);
  });

  it("classifies months around the year-wide average", () => {
    const months = buildAnnualTimelineModel({
      months: [
        makeMonth("2025-01", 10, { highlights: 10, matched: 10, bookCount: 1 }),
        makeMonth("2025-02", 4, { highlights: 4, matched: 4, bookCount: 1 }),
        makeMonth("2025-03", 2, { highlights: 2, matched: 2, bookCount: 1 }),
      ],
      year: 2025,
      averagePerActiveMonth: 4,
    });
    const jan = months.find((m) => m.month === "2025-01")!;
    const feb = months.find((m) => m.month === "2025-02")!;
    const mar = months.find((m) => m.month === "2025-03")!;
    expect(jan.activity).toBe("high");
    expect(feb.activity).toBe("steady");
    expect(mar.activity).toBe("light");
  });
});

// ---------- 3: classifyAnnualMonthActivity ----------

describe("classifyAnnualMonthActivity", () => {
  it("returns 'none' when average is 0", () => {
    expect(classifyAnnualMonthActivity({ total: 5, averagePerActiveMonth: 0 })).toBe("none");
  });
  it("returns 'none' when total is 0", () => {
    expect(classifyAnnualMonthActivity({ total: 0, averagePerActiveMonth: 4 })).toBe("none");
  });
  it("returns 'high' at >= average*1.5", () => {
    expect(classifyAnnualMonthActivity({ total: 6, averagePerActiveMonth: 4 })).toBe("high");
    expect(classifyAnnualMonthActivity({ total: 60, averagePerActiveMonth: 4 })).toBe("high");
  });
  it("returns 'light' at <= average*0.5", () => {
    expect(classifyAnnualMonthActivity({ total: 2, averagePerActiveMonth: 4 })).toBe("light");
    expect(classifyAnnualMonthActivity({ total: 1, averagePerActiveMonth: 4 })).toBe("light");
  });
  it("returns 'steady' between the two thresholds", () => {
    expect(classifyAnnualMonthActivity({ total: 3, averagePerActiveMonth: 4 })).toBe("steady");
    expect(classifyAnnualMonthActivity({ total: 5, averagePerActiveMonth: 4 })).toBe("steady");
  });
});

// ---------- 4: buildAnnualTypeDistribution ----------

describe("buildAnnualTypeDistribution", () => {
  it("sums types across months and exposes ratios", () => {
    const dist = buildAnnualTypeDistribution({
      months: [
        makeMonth("2025-01", 6, { highlights: 4, thoughts: 2 }),
        makeMonth("2025-02", 4, { reviews: 4 }),
        makeMonth("2025-03", 1, { unknown: 1 }),
      ],
    });
    expect(dist.highlights).toBe(4);
    expect(dist.thoughts).toBe(2);
    expect(dist.reviews).toBe(4);
    expect(dist.unknown).toBe(1);
    expect(dist.total).toBe(11);
    expect(dist.ratio.highlights).toBeCloseTo(4 / 11, 4);
    expect(dist.ratio.reviews).toBeCloseTo(4 / 11, 4);
  });

  it("returns zeros when the months are empty", () => {
    const dist = buildAnnualTypeDistribution({ months: [] });
    expect(dist.total).toBe(0);
    expect(dist.ratio.highlights).toBe(0);
  });
});

// ---------- 5: buildQuarterReviewModel ----------

describe("buildQuarterReviewModel", () => {
  it("builds 4 quarter entries in Q1..Q4 order", () => {
    const quarters = buildQuarterReviewModel({
      quarters: [
        { quarter: "Q1", total: 5, activeMonths: 2, matchedRecords: 4, bookCount: 2 },
        { quarter: "Q2", total: 3, activeMonths: 1, matchedRecords: 2, bookCount: 1 },
        { quarter: "Q3", total: 0, activeMonths: 0, matchedRecords: 0, bookCount: 0 },
        { quarter: "Q4", total: 2, activeMonths: 1, matchedRecords: 1, bookCount: 1 },
      ],
      months: Array.from({ length: 12 }, (_, i) => makeMonth(`2025-${String(i + 1).padStart(2, "0")}`, i + 1)),
      averagePerActiveMonth: 1,
    });
    expect(quarters.map((q) => q.quarter)).toEqual(["Q1", "Q2", "Q3", "Q4"]);
    expect(quarters[0].shareOfYear).toBeCloseTo(5 / 10, 4);
    expect(quarters[3].shareOfYear).toBeCloseTo(2 / 10, 4);
    // Each quarter carries the descriptive label.
    expect(quarters[0].label).toBe(ANNUAL_QUARTER_LABELS.Q1);
    expect(quarters[3].label).toBe(ANNUAL_QUARTER_LABELS.Q4);
  });

  it("shareOfYear is 0 when the year has no data", () => {
    const quarters = buildQuarterReviewModel({
      quarters: [
        { quarter: "Q1", total: 0, activeMonths: 0, matchedRecords: 0, bookCount: 0 },
        { quarter: "Q2", total: 0, activeMonths: 0, matchedRecords: 0, bookCount: 0 },
        { quarter: "Q3", total: 0, activeMonths: 0, matchedRecords: 0, bookCount: 0 },
        { quarter: "Q4", total: 0, activeMonths: 0, matchedRecords: 0, bookCount: 0 },
      ],
      months: [],
      averagePerActiveMonth: 0,
    });
    expect(quarters.every((q) => q.shareOfYear === 0)).toBe(true);
  });
});

// ---------- 6: buildAnnualRhythmSummary ----------

describe("buildAnnualRhythmSummary", () => {
  it("passes the overview counters through verbatim", () => {
    const summary = buildAnnualRhythmSummary({
      response: makeResponse({
        selectedYear: 2024,
        overview: {
          year: 2024,
          totalRecords: 50,
          datedRecords: 50,
          matchedRecords: 40,
          matchedBooks: 10,
          activeMonths: 8,
          longestStreakMonths: 6,
          firstNoteAt: "2024-01-05T00:00:00.000Z",
          lastNoteAt: "2024-12-12T00:00:00.000Z",
          peakMonth: "2024-06",
          peakMonthRecords: 12,
          averageRecordsPerActiveMonth: 6.25,
        },
      }),
    });
    expect(summary.year).toBe(2024);
    expect(summary.totalRecords).toBe(50);
    expect(summary.activeMonths).toBe(8);
    expect(summary.peakMonth).toBe("2024-06");
    expect(summary.peakMonthRecords).toBe(12);
    expect(summary.matchedBooks).toBe(10);
  });
});

// ---------- 7: buildAnnualOverviewView / buildAnnualRecordCards ----------

describe("buildAnnualOverviewView + record cards", () => {
  it("returns six record cards with descriptive text", () => {
    const view = buildAnnualOverviewView({
      response: makeResponse({
        overview: {
          year: 2025,
          totalRecords: 120,
          datedRecords: 120,
          matchedRecords: 90,
          matchedBooks: 7,
          activeMonths: 9,
          longestStreakMonths: 5,
          firstNoteAt: "2025-01-05T00:00:00.000Z",
          lastNoteAt: "2025-09-30T00:00:00.000Z",
          peakMonth: "2025-03",
          peakMonthRecords: 25,
          averageRecordsPerActiveMonth: 13.333,
        },
        topBooks: [
          {
            catalogId: "10000000_000000000001",
            title: "公共书目 A",
            author: "作者 A",
            publisher: null,
            publishYear: 2024,
            noteCount: 30,
            highlights: 18,
            thoughts: 8,
            reviews: 4,
            unknown: 0,
            activeMonths: 5,
            firstNoteAt: "2025-01-05T00:00:00.000Z",
            lastNoteAt: "2025-09-30T00:00:00.000Z",
          },
        ],
      }),
      topBookCount: 1,
    });
    expect(view.cards).toHaveLength(6);
    expect(view.cards[0].value).toContain("120");
    expect(view.cards[4].value).toContain("7");
    expect(view.cards[5].value).toContain("30");
  });

  it("renders an empty-state peak card when peakMonth is null", () => {
    const cards = buildAnnualRecordCards({
      response: makeResponse(),
    });
    const peak = cards.find((c) => c.key === "peak");
    expect(peak?.value).toContain("暂无");
  });
});

// ---------- 8: hasAnnualReviewData ----------

describe("hasAnnualReviewData", () => {
  it("returns true when totalRecords > 0", () => {
    expect(hasAnnualReviewData(makeResponse({ overview: { ...makeResponse().overview, totalRecords: 1 } }))).toBe(true);
  });
  it("returns true when topBooks is non-empty", () => {
    expect(
      hasAnnualReviewData(
        makeResponse({
          topBooks: [
            {
              catalogId: "10000000_000000000001",
              title: "t",
              author: null,
              publisher: null,
              publishYear: null,
              noteCount: 1,
              highlights: 1,
              thoughts: 0,
              reviews: 0,
              unknown: 0,
              activeMonths: 1,
              firstNoteAt: "2025-01-01T00:00:00.000Z",
              lastNoteAt: "2025-01-01T00:00:00.000Z",
            },
          ],
        })
      )
    ).toBe(true);
  });
  it("returns false for an empty response", () => {
    expect(hasAnnualReviewData(makeResponse())).toBe(false);
    expect(hasAnnualReviewData(null)).toBe(false);
  });
});

// ---------- 9: invariants ----------

describe("annual review model invariants", () => {
  it("contains no NaN / Infinity in any numeric field", () => {
    const resp = makeResponse({
      overview: {
        year: 2025,
        totalRecords: 50,
        datedRecords: 50,
        matchedRecords: 40,
        matchedBooks: 7,
        activeMonths: 8,
        longestStreakMonths: 5,
        firstNoteAt: "2025-01-05T00:00:00.000Z",
        lastNoteAt: "2025-09-30T00:00:00.000Z",
        peakMonth: "2025-03",
        peakMonthRecords: 12,
        averageRecordsPerActiveMonth: 6.25,
      },
    });
    const tl = buildAnnualTimelineModel({
      months: resp.months,
      year: resp.selectedYear,
      averagePerActiveMonth: resp.overview.averageRecordsPerActiveMonth,
    });
    const dist = buildAnnualTypeDistribution({ months: resp.months });
    const quarters = buildQuarterReviewModel({
      quarters: resp.quarters,
      months: resp.months,
      averagePerActiveMonth: resp.overview.averageRecordsPerActiveMonth,
    });
    expect(dist.total).toBeGreaterThanOrEqual(0);
    expect(quarters).toHaveLength(4);
    expect(tl.every((m) => Number.isFinite(m.total))).toBe(true);
    expect(tl.every((m) => Number.isFinite(m.heightPct))).toBe(true);
  });

  it("does not generate HTML strings (no template strings containing markup)", () => {
    const view = buildAnnualOverviewView({ response: makeResponse(), topBookCount: 0 });
    for (const card of view.cards) {
      expect(card.value.includes("<")).toBe(false);
      expect(card.value.includes(">")).toBe(false);
    }
  });

  it("never produces psychological-inference vocabulary", () => {
    const source = allModelSourceText();
    for (const word of FORBIDDEN_WORDS) {
      expect(source.includes(word)).toBe(false);
    }
    // Generated output must not contain these words either.
    const view = buildAnnualOverviewView({ response: makeResponse(), topBookCount: 0 });
    for (const card of view.cards) {
      for (const word of FORBIDDEN_WORDS) {
        expect(card.value.includes(word)).toBe(false);
      }
    }
  });

  it("empty-year data is recognised as empty", () => {
    const resp = makeResponse();
    expect(hasAnnualReviewData(resp)).toBe(false);
    expect(buildAnnualTimelineModel({ months: resp.months, year: resp.selectedYear, averagePerActiveMonth: 0 }).every((m) => m.total === 0)).toBe(true);
    expect(ANNUAL_ACTIVITY_LABELS.none).toBe("无记录");
  });
});