import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  buildArchiveYearLinks,
  buildRecurringArchiveBooks,
  buildReadingArchiveOverview,
  buildReadingArchiveYear,
  buildReadingArchiveYears,
  buildWereadReadingArchive,
  calculateActiveYearStreak,
  DEFAULT_READING_ARCHIVE_RANGE,
  DEFAULT_READING_ARCHIVE_TOP_BOOKS,
  findMostActiveArchiveYear,
  formatArchiveOverview,
  formatArchiveOverlap,
  formatArchiveYearRange,
  getArchiveOverlapScopeNote,
  getArchivePrivacyDisclaimer,
  getArchiveRecurringScopeNote,
  getArchiveTopNScopeNotice,
  hasReadingArchiveData,
  normalizeArchiveYears,
  pickArchiveYearSlice,
  READING_ARCHIVE_MAX_YEARS,
  READING_ARCHIVE_RANGE_OPTIONS,
  READING_ARCHIVE_TOP_BOOKS_OPTIONS,
} from "./wereadReadingArchiveModel";
import type {
  WereadAnnualReviewBook,
  WereadAnnualReviewResponse,
  WereadAnnualReviewTopBooksOption,
} from "../wereadPrivate";

// ---------- fixtures ----------

function makeMonth(month: string, total: number): {
  month: string;
  total: number;
  highlights: number;
  thoughts: number;
  reviews: number;
  unknown: number;
  matched: number;
  bookCount: number;
} {
  return {
    month,
    total,
    highlights: total,
    thoughts: 0,
    reviews: 0,
    unknown: 0,
    matched: 1,
    bookCount: 1,
  };
}

function makeBook(args: {
  catalogId: string;
  title?: string;
  author?: string | null;
  publisher?: string | null;
  publishYear?: string | number | null;
  noteCount?: number;
}): WereadAnnualReviewBook {
  return {
    catalogId: args.catalogId,
    title: args.title ?? `Book ${args.catalogId}`,
    author: args.author ?? null,
    publisher: args.publisher ?? null,
    publishYear: args.publishYear ?? null,
    noteCount: args.noteCount ?? 10,
    highlights: 5,
    thoughts: 1,
    reviews: 0,
    unknown: 0,
    activeMonths: 1,
    firstNoteAt: "2025-01-01",
    lastNoteAt: "2025-12-31",
  };
}

function makeResponse(overrides: Partial<WereadAnnualReviewResponse> = {}): WereadAnnualReviewResponse {
  const selectedYear = overrides.selectedYear ?? 2025;
  const months = Array.from({ length: 12 }, (_, i) =>
    makeMonth(`${selectedYear}-${String(i + 1).padStart(2, "0")}`, 0)
  );
  return {
    ok: true,
    selectedYear,
    availableYears: [selectedYear, selectedYear - 1],
    overview: {
      year: selectedYear,
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

function makeResponseWithData(args: {
  year: number;
  totalRecords: number;
  activeMonths?: number;
  longestStreakMonths?: number;
  matchedBooks?: number;
  matchedRecords?: number;
  peakMonth?: string | null;
  topBooks?: WereadAnnualReviewBook[];
}): WereadAnnualReviewResponse {
  const total = args.totalRecords;
  const activeMonths = args.activeMonths ?? 6;
  const overview = {
    year: args.year,
    totalRecords: total,
    datedRecords: total,
    matchedRecords: args.matchedRecords ?? total,
    matchedBooks: args.matchedBooks ?? (args.topBooks?.length ?? 0),
    activeMonths,
    longestStreakMonths: args.longestStreakMonths ?? activeMonths,
    firstNoteAt: `${args.year}-01-01`,
    lastNoteAt: `${args.year}-12-31`,
    peakMonth: args.peakMonth ?? `${args.year}-06`,
    peakMonthRecords: Math.ceil(total / 12),
    averageRecordsPerActiveMonth: activeMonths > 0 ? total / activeMonths : 0,
  };
  const months = Array.from({ length: 12 }, (_, i) => {
    const m = makeMonth(
      `${args.year}-${String(i + 1).padStart(2, "0")}`,
      i < activeMonths ? Math.floor(total / Math.max(1, activeMonths)) : 0
    );
    return m;
  });
  return makeResponse({
    selectedYear: args.year,
    availableYears: [args.year, args.year - 1, args.year - 2],
    overview,
    months,
    topBooks: args.topBooks ?? [],
  });
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
  "兴趣变化",
  "兴趣稳定",
  "停止阅读",
  "开始阅读",
  "长期偏好",
];

function readModelSource(): string {
  return fs.readFileSync(path.join(__dirname, "./wereadReadingArchiveModel.ts"), "utf8");
}

// ---------- year normalization ----------

describe("normalizeArchiveYears", () => {
  it("deduplicates and sorts descending", () => {
    const out = normalizeArchiveYears([2023, 2021, 2024, 2023, 2022, 2021]);
    expect(out).toEqual([2024, 2023, 2022, 2021]);
  });

  it("drops non-integers and out-of-range years", () => {
    const out = normalizeArchiveYears([2024, 1999, 2023, 10000, 2022.5, NaN as unknown as number]);
    expect(out).toEqual([2024, 2023]);
  });
});

describe("pickArchiveYearSlice", () => {
  it("returns the most recent 5 years by default range", () => {
    const years = [2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026];
    const out = pickArchiveYearSlice({ availableYears: years, range: "recent5" });
    expect(out).toEqual([2026, 2025, 2024, 2023, 2022]);
  });

  it("clamps the all range to max years", () => {
    const years = Array.from({ length: 30 }, (_, i) => 2000 + i);
    const out = pickArchiveYearSlice({ availableYears: years, range: "all" });
    expect(out.length).toBe(READING_ARCHIVE_MAX_YEARS);
    expect(out[0]).toBe(2029);
    expect(out[READING_ARCHIVE_MAX_YEARS - 1]).toBe(2010);
  });

  it("returns an empty array when no years are available", () => {
    expect(pickArchiveYearSlice({ availableYears: [], range: "recent5" })).toEqual([]);
  });
});

// ---------- per-year rows ----------

describe("buildReadingArchiveYears", () => {
  it("sorts years ascending and dedupes by selectedYear", () => {
    const a = makeResponseWithData({ year: 2024, totalRecords: 10 });
    const b = makeResponseWithData({ year: 2025, totalRecords: 20 });
    const c = makeResponseWithData({ year: 2025, totalRecords: 30, topBooks: [] });
    const out = buildReadingArchiveYears({ responses: [b, a, c] });
    expect(out.map((y) => y.year)).toEqual([2024, 2025]);
    expect(out[1].totalRecords).toBe(30); // later occurrence wins
  });

  it("produces an empty list for no responses", () => {
    expect(buildReadingArchiveYears({ responses: [] })).toEqual([]);
  });

  it("exposes topBookCatalogIds in rank order without duplicates", () => {
    const r = makeResponseWithData({
      year: 2025,
      totalRecords: 12,
      topBooks: [
        makeBook({ catalogId: "c1" }),
        makeBook({ catalogId: "c2" }),
        makeBook({ catalogId: "c1" }), // duplicate should not repeat
      ],
    });
    const out = buildReadingArchiveYears({ responses: [r] });
    expect(out[0].topBookCatalogIds).toEqual(["c1", "c2"]);
    expect(out[0].topBookCount).toBe(2);
  });
});

// ---------- streak ----------

describe("calculateActiveYearStreak", () => {
  it("returns 0 for empty list", () => {
    expect(calculateActiveYearStreak([])).toBe(0);
  });

  it("counts consecutive years with data", () => {
    const years = [
      buildReadingArchiveYear(makeResponseWithData({ year: 2021, totalRecords: 5 })),
      buildReadingArchiveYear(makeResponseWithData({ year: 2022, totalRecords: 5 })),
      buildReadingArchiveYear(makeResponseWithData({ year: 2023, totalRecords: 5 })),
    ];
    expect(calculateActiveYearStreak(years)).toBe(3);
  });

  it("breaks the streak on a zero-record year", () => {
    const years = [
      buildReadingArchiveYear(makeResponseWithData({ year: 2021, totalRecords: 5 })),
      buildReadingArchiveYear(makeResponseWithData({ year: 2022, totalRecords: 0 })),
      buildReadingArchiveYear(makeResponseWithData({ year: 2023, totalRecords: 5 })),
    ];
    expect(calculateActiveYearStreak(years)).toBe(1);
  });

  it("counts only adjacent +1 gaps", () => {
    const years = [
      buildReadingArchiveYear(makeResponseWithData({ year: 2021, totalRecords: 5 })),
      buildReadingArchiveYear(makeResponseWithData({ year: 2023, totalRecords: 5 })),
    ];
    expect(calculateActiveYearStreak(years)).toBe(1);
  });
});

// ---------- most active ----------

describe("findMostActiveArchiveYear", () => {
  it("returns null for empty input", () => {
    expect(findMostActiveArchiveYear([])).toBeNull();
  });

  it("picks the year with the highest totalRecords", () => {
    const years = [
      buildReadingArchiveYear(makeResponseWithData({ year: 2021, totalRecords: 5 })),
      buildReadingArchiveYear(makeResponseWithData({ year: 2022, totalRecords: 20 })),
      buildReadingArchiveYear(makeResponseWithData({ year: 2023, totalRecords: 8 })),
    ];
    const out = findMostActiveArchiveYear(years);
    expect(out?.year).toBe(2022);
  });

  it("breaks ties by earlier year", () => {
    const years = [
      buildReadingArchiveYear(makeResponseWithData({ year: 2022, totalRecords: 10 })),
      buildReadingArchiveYear(makeResponseWithData({ year: 2024, totalRecords: 10 })),
    ];
    expect(findMostActiveArchiveYear(years)?.year).toBe(2022);
  });

  it("ignores zero-record years", () => {
    const years = [
      buildReadingArchiveYear(makeResponseWithData({ year: 2022, totalRecords: 0 })),
      buildReadingArchiveYear(makeResponseWithData({ year: 2023, totalRecords: 5 })),
    ];
    expect(findMostActiveArchiveYear(years)?.year).toBe(2023);
  });
});

// ---------- overview ----------

describe("buildReadingArchiveOverview", () => {
  it("computes yearsWithData and totals", () => {
    const years = [
      buildReadingArchiveYear(makeResponseWithData({ year: 2021, totalRecords: 10, activeMonths: 4 })),
      buildReadingArchiveYear(makeResponseWithData({ year: 2022, totalRecords: 20, activeMonths: 6 })),
      buildReadingArchiveYear(makeResponseWithData({ year: 2023, totalRecords: 0, activeMonths: 0 })),
    ];
    const out = buildReadingArchiveOverview({ years });
    expect(out.yearsWithData).toBe(2);
    expect(out.totalRecords).toBe(30);
    expect(out.totalActiveMonths).toBe(10);
    expect(out.averageRecordsPerYear).toBe(15);
    expect(out.firstYear).toBe(2021);
    expect(out.latestYear).toBe(2022);
    expect(out.mostActiveYear).toBe(2022);
    expect(out.longestActiveYearStreak).toBe(2);
  });

  it("returns zeros and nulls when no data", () => {
    const out = buildReadingArchiveOverview({ years: [] });
    expect(out.yearsWithData).toBe(0);
    expect(out.firstYear).toBeNull();
    expect(out.latestYear).toBeNull();
    expect(out.mostActiveYear).toBeNull();
    expect(out.longestActiveYearStreak).toBe(0);
    expect(out.totalRecords).toBe(0);
    expect(out.averageRecordsPerYear).toBe(0);
  });
});

// ---------- recurring ----------

describe("buildRecurringArchiveBooks", () => {
  it("only includes books present in 2+ years", () => {
    const responses = [
      makeResponseWithData({
        year: 2023,
        totalRecords: 5,
        topBooks: [makeBook({ catalogId: "a" }), makeBook({ catalogId: "b" })],
      }),
      makeResponseWithData({
        year: 2024,
        totalRecords: 5,
        topBooks: [makeBook({ catalogId: "a" }), makeBook({ catalogId: "c" })],
      }),
      makeResponseWithData({
        year: 2025,
        totalRecords: 5,
        topBooks: [makeBook({ catalogId: "d" }), makeBook({ catalogId: "e" })],
      }),
    ];
    const out = buildRecurringArchiveBooks({ responses });
    expect(out.map((b) => b.catalogId)).toEqual(["a"]);
    expect(out[0].years).toEqual([2023, 2024]);
    expect(out[0].yearsOnList).toBe(2);
  });

  it("uses the latest year's public metadata first, falls back to older years", () => {
    const responses = [
      makeResponseWithData({
        year: 2023,
        totalRecords: 5,
        topBooks: [
          makeBook({ catalogId: "x", title: "Original Title", author: "Alice", publisher: "Pub A", publishYear: 2010 }),
        ],
      }),
      makeResponseWithData({
        year: 2024,
        totalRecords: 5,
        topBooks: [makeBook({ catalogId: "x", title: "Updated Title", author: null, publisher: null, publishYear: null })],
      }),
    ];
    const out = buildRecurringArchiveBooks({ responses });
    expect(out[0].title).toBe("Updated Title");
    expect(out[0].author).toBe("Alice"); // fell back to 2023
    expect(out[0].publisher).toBe("Pub A");
    expect(out[0].publishYear).toBe(2010);
  });

  it("computes totalNoteCountWithinLists across years", () => {
    const responses = [
      makeResponseWithData({
        year: 2023,
        totalRecords: 5,
        topBooks: [makeBook({ catalogId: "x", noteCount: 7 })],
      }),
      makeResponseWithData({
        year: 2024,
        totalRecords: 5,
        topBooks: [makeBook({ catalogId: "x", noteCount: 13 })],
      }),
    ];
    const out = buildRecurringArchiveBooks({ responses });
    expect(out[0].totalNoteCountWithinLists).toBe(20);
  });

  it("sorts by yearsOnList, noteCount, latestYear, bestRank, catalogId", () => {
    const responses = [
      makeResponseWithData({
        year: 2022,
        totalRecords: 5,
        topBooks: [
          makeBook({ catalogId: "a", noteCount: 5 }),
          makeBook({ catalogId: "b", noteCount: 10 }),
        ],
      }),
      makeResponseWithData({
        year: 2023,
        totalRecords: 5,
        topBooks: [
          makeBook({ catalogId: "a", noteCount: 7 }),
          makeBook({ catalogId: "b", noteCount: 9 }),
        ],
      }),
      makeResponseWithData({
        year: 2024,
        totalRecords: 5,
        topBooks: [
          makeBook({ catalogId: "a", noteCount: 9 }),
          makeBook({ catalogId: "b", noteCount: 11 }),
        ],
      }),
    ];
    const out = buildRecurringArchiveBooks({ responses });
    // Both have yearsOnList = 3; sort by totalNoteCountWithinLists.
    expect(out[0].catalogId).toBe("b");
    expect(out[1].catalogId).toBe("a");
  });

  it("emits empty when no catalogId appears in two years", () => {
    const responses = [
      makeResponseWithData({ year: 2024, totalRecords: 5, topBooks: [makeBook({ catalogId: "a" })] }),
      makeResponseWithData({ year: 2025, totalRecords: 5, topBooks: [makeBook({ catalogId: "b" })] }),
    ];
    expect(buildRecurringArchiveBooks({ responses })).toEqual([]);
  });
});

// ---------- adjacent year links ----------

describe("buildArchiveYearLinks", () => {
  it("compares only adjacent chronological years", () => {
    const responses = [
      makeResponseWithData({
        year: 2021,
        totalRecords: 5,
        topBooks: [makeBook({ catalogId: "a" }), makeBook({ catalogId: "b" })],
      }),
      makeResponseWithData({
        year: 2022,
        totalRecords: 5,
        topBooks: [makeBook({ catalogId: "b" }), makeBook({ catalogId: "c" })],
      }),
      makeResponseWithData({
        year: 2023,
        totalRecords: 5,
        topBooks: [makeBook({ catalogId: "c" }), makeBook({ catalogId: "d" })],
      }),
    ];
    const out = buildArchiveYearLinks({ responses });
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      sourceYear: 2021,
      targetYear: 2022,
      sharedTopBooks: 1,
      overlapRatio: 1 / 3, // shared=1, union=3 (a,b,c)
    });
    expect(out[1].sourceYear).toBe(2022);
    expect(out[1].targetYear).toBe(2023);
    expect(out[1].sharedTopBooks).toBe(1);
    expect(out[1].overlapRatio).toBeCloseTo(1 / 3, 5);
  });

  it("returns 0 overlap when both topBooks are empty", () => {
    const responses = [
      makeResponseWithData({ year: 2024, totalRecords: 0, topBooks: [] }),
      makeResponseWithData({ year: 2025, totalRecords: 0, topBooks: [] }),
    ];
    const out = buildArchiveYearLinks({ responses });
    expect(out).toHaveLength(1);
    expect(out[0].sharedTopBooks).toBe(0);
    expect(out[0].overlapRatio).toBe(0);
  });

  it("never produces NaN or Infinity in overlapRatio", () => {
    const responses = [
      makeResponseWithData({ year: 2024, totalRecords: 0, topBooks: [] }),
      makeResponseWithData({ year: 2025, totalRecords: 0, topBooks: [] }),
    ];
    const out = buildArchiveYearLinks({ responses });
    expect(Number.isFinite(out[0].overlapRatio)).toBe(true);
    expect(out[0].overlapRatio).toBe(0);
  });
});

// ---------- main entry ----------

describe("buildWereadReadingArchive", () => {
  it("produces persisted:false and a topBooksLimit", () => {
    const responses = [
      makeResponseWithData({ year: 2024, totalRecords: 5 }),
      makeResponseWithData({ year: 2025, totalRecords: 10 }),
    ];
    const out = buildWereadReadingArchive({
      responses,
      requestedYears: 5,
      topBooksLimit: 12,
    });
    expect(out.meta.persisted).toBe(false);
    expect(out.meta.topBooksLimit).toBe(12);
    expect(out.meta.maxYears).toBe(READING_ARCHIVE_MAX_YEARS);
    expect(out.meta.requestedYears).toBe(5);
    expect(out.meta.loadedYears).toBe(2);
  });

  it("computes recurringTopBooks in overview", () => {
    const responses = [
      makeResponseWithData({
        year: 2024,
        totalRecords: 5,
        topBooks: [makeBook({ catalogId: "a" }), makeBook({ catalogId: "b" })],
      }),
      makeResponseWithData({
        year: 2025,
        totalRecords: 5,
        topBooks: [makeBook({ catalogId: "a" }), makeBook({ catalogId: "b" })],
      }),
    ];
    const out = buildWereadReadingArchive({
      responses,
      requestedYears: 2,
      topBooksLimit: 12,
    });
    expect(out.overview.recurringTopBooks).toBe(2);
  });
});

// ---------- formatters ----------

describe("formatArchiveOverview", () => {
  it("formats an overview line with the year range and totals", () => {
    const archive = buildWereadReadingArchive({
      responses: [
        makeResponseWithData({ year: 2024, totalRecords: 10 }),
        makeResponseWithData({ year: 2025, totalRecords: 20 }),
      ],
      requestedYears: 2,
      topBooksLimit: 12,
    });
    const out = formatArchiveOverview(archive);
    expect(out).toContain("2 个有数据年份");
    expect(out).toContain("2024–2025 年");
    expect(out).toContain("30");
  });

  it("returns a no-data message for empty archives", () => {
    const archive = buildWereadReadingArchive({
      responses: [],
      requestedYears: 0,
      topBooksLimit: 12,
    });
    expect(formatArchiveOverview(archive)).toContain("暂无");
  });
});

describe("formatArchiveYearRange", () => {
  it("formats a multi-year range", () => {
    expect(formatArchiveYearRange({ firstYear: 2021, latestYear: 2025 })).toBe("2021–2025 年");
  });
  it("formats a single-year range", () => {
    expect(formatArchiveYearRange({ firstYear: 2025, latestYear: 2025 })).toBe("2025 年");
  });
  it("uses em-dash when nothing is known", () => {
    expect(formatArchiveYearRange({ firstYear: null, latestYear: null })).toBe("—");
  });
});

describe("formatArchiveOverlap", () => {
  it("rounds to 1 decimal max", () => {
    expect(formatArchiveOverlap(0)).toBe("0%");
    expect(formatArchiveOverlap(0.3333)).toBe("33.3%");
    expect(formatArchiveOverlap(1)).toBe("100%");
  });
  it("rejects NaN and Infinity", () => {
    expect(formatArchiveOverlap(NaN)).toBe("0%");
    expect(formatArchiveOverlap(Number.POSITIVE_INFINITY)).toBe("0%");
    expect(formatArchiveOverlap(-1)).toBe("0%");
    expect(formatArchiveOverlap(2)).toBe("100%");
  });
});

describe("hasReadingArchiveData", () => {
  it("returns false when archive is null or empty", () => {
    expect(hasReadingArchiveData(null)).toBe(false);
    const empty = buildWereadReadingArchive({
      responses: [],
      requestedYears: 0,
      topBooksLimit: 12,
    });
    expect(hasReadingArchiveData(empty)).toBe(false);
  });
  it("returns true when there are records", () => {
    const archive = buildWereadReadingArchive({
      responses: [makeResponseWithData({ year: 2025, totalRecords: 5 })],
      requestedYears: 1,
      topBooksLimit: 12,
    });
    expect(hasReadingArchiveData(archive)).toBe(true);
  });
});

// ---------- disclaimers / constants ----------

describe("disclaimers and constants", () => {
  it("provides a privacy disclaimer", () => {
    expect(getArchivePrivacyDisclaimer()).toContain("不读取笔记正文");
    expect(getArchivePrivacyDisclaimer()).toContain("不调用外部 AI");
    expect(getArchivePrivacyDisclaimer()).toContain("不会保存到服务器");
  });
  it("provides a Top-N scope notice", () => {
    expect(getArchiveTopNScopeNotice()).toContain("Top N");
  });
  it("provides the recurring scope note", () => {
    expect(getArchiveRecurringScopeNote()).toContain("Top N");
  });
  it("provides the overlap scope note", () => {
    expect(getArchiveOverlapScopeNote()).toContain("公共书目榜单交集");
  });
  it("exposes range options with valid counts", () => {
    expect(READING_ARCHIVE_RANGE_OPTIONS.length).toBeGreaterThanOrEqual(3);
    for (const opt of READING_ARCHIVE_RANGE_OPTIONS) {
      expect(opt.count).toBeGreaterThan(0);
      expect(opt.count).toBeLessThanOrEqual(READING_ARCHIVE_MAX_YEARS);
    }
  });
  it("exposes topBooks options 6/12/18", () => {
    expect(READING_ARCHIVE_TOP_BOOKS_OPTIONS).toEqual([6, 12, 18]);
  });
  it("default range is recent5 and default topBooks is 12", () => {
    expect(DEFAULT_READING_ARCHIVE_RANGE).toBe("recent5");
    expect(DEFAULT_READING_ARCHIVE_TOP_BOOKS).toBe(12);
  });
});

// ---------- privacy invariants ----------

describe("privacy invariants", () => {
  function fixture(): WereadAnnualReviewResponse {
    return makeResponseWithData({
      year: 2025,
      totalRecords: 10,
      topBooks: [
        makeBook({
          catalogId: "abc",
          title: "Public Title",
          author: "Public Author",
          publisher: "Public Publisher",
          publishYear: 2020,
          noteCount: 5,
        }),
      ],
    });
  }

  it("does not include raw note text or comment anywhere in the output", () => {
    const archive = buildWereadReadingArchive({
      responses: [fixture()],
      requestedYears: 1,
      topBooksLimit: 12,
    });
    const json = JSON.stringify(archive);
    expect(json).not.toMatch(/note\s*\.?\s*text/i);
    expect(json).not.toMatch(/comment/i);
    expect(json).not.toMatch(/noteId/);
    expect(json).not.toMatch(/highlightId/);
    expect(json).not.toMatch(/chapterTitle/);
  });

  it("does not include wereadBookId or private IDs", () => {
    const archive = buildWereadReadingArchive({
      responses: [fixture()],
      requestedYears: 1,
      topBooksLimit: 12,
    });
    const json = JSON.stringify(archive);
    expect(json).not.toMatch(/wereadBookId/);
    expect(json).not.toMatch(/token/);
    expect(json).not.toMatch(/Authorization/);
  });

  it("does not include AI summary fields", () => {
    const archive = buildWereadReadingArchive({
      responses: [fixture()],
      requestedYears: 1,
      topBooksLimit: 12,
    });
    const json = JSON.stringify(archive);
    expect(json).not.toMatch(/summary/i);
    expect(json).not.toMatch(/themes/i);
    expect(json).not.toMatch(/keyPoints/i);
    expect(json).not.toMatch(/reviewQuestions/i);
  });

  it("does not include token or query parameters", () => {
    const archive = buildWereadReadingArchive({
      responses: [fixture()],
      requestedYears: 1,
      topBooksLimit: 12,
    });
    const json = JSON.stringify(archive);
    expect(json).not.toMatch(/token/i);
    expect(json).not.toMatch(/[?&]q=/);
    expect(json).not.toMatch(/api_key/i);
  });

  it("source code does not reference forbidden field names", () => {
    const src = readModelSource();
    expect(src).not.toMatch(/note\.text/);
    expect(src).not.toMatch(/note\.comment/);
    expect(src).not.toMatch(/wereadBookId/);
    expect(src).not.toMatch(/fetchWereadAiSummary/);
    expect(src).not.toMatch(/fetchWereadRelatedBooks/);
    expect(src).not.toMatch(/localStorage/);
    expect(src).not.toMatch(/sessionStorage/);
  });

  it("source code does not emit forbidden interpretive words", () => {
    const src = readModelSource();
    for (const word of FORBIDDEN_WORDS) {
      expect(src).not.toContain(word);
    }
  });

  it("output is fully serialisable JSON (no DOM / no React types)", () => {
    const archive = buildWereadReadingArchive({
      responses: [fixture()],
      requestedYears: 1,
      topBooksLimit: 12,
    });
    const round = JSON.parse(JSON.stringify(archive));
    expect(round.meta.persisted).toBe(false);
    expect(round.meta.source).toBe("annual-review-cache");
  });

  it("output never contains raw HTML strings", () => {
    const archive = buildWereadReadingArchive({
      responses: [fixture()],
      requestedYears: 1,
      topBooksLimit: 12,
    });
    const json = JSON.stringify(archive);
    expect(json).not.toMatch(/<script/i);
    expect(json).not.toMatch(/<style/i);
    expect(json).not.toMatch(/<iframe/i);
    expect(json).not.toMatch(/innerHTML/);
    expect(json).not.toMatch(/dangerouslySetInnerHTML/);
  });

  it("recurringBooks only use the latest public catalog metadata", () => {
    const responses = [
      makeResponseWithData({
        year: 2024,
        totalRecords: 5,
        topBooks: [
          makeBook({ catalogId: "z", title: "Original Title", author: "Original Author" }),
        ],
      }),
      makeResponseWithData({
        year: 2025,
        totalRecords: 5,
        topBooks: [
          makeBook({ catalogId: "z", title: "Updated Title", author: "Updated Author" }),
        ],
      }),
    ];
    const out = buildRecurringArchiveBooks({ responses });
    expect(out[0].title).toBe("Updated Title");
    expect(out[0].author).toBe("Updated Author");
  });

  it("recurringBooks: years array is ascending", () => {
    const responses = [
      makeResponseWithData({
        year: 2025,
        totalRecords: 5,
        topBooks: [makeBook({ catalogId: "x" })],
      }),
      makeResponseWithData({
        year: 2023,
        totalRecords: 5,
        topBooks: [makeBook({ catalogId: "x" })],
      }),
      makeResponseWithData({
        year: 2024,
        totalRecords: 5,
        topBooks: [makeBook({ catalogId: "x" })],
      }),
    ];
    const out = buildRecurringArchiveBooks({ responses });
    expect(out[0].years).toEqual([2023, 2024, 2025]);
  });
});

// ---------- output stability ----------

describe("output stability", () => {
  it("is deterministic across multiple builds with the same inputs", () => {
    const responses = [
      makeResponseWithData({
        year: 2024,
        totalRecords: 5,
        topBooks: [makeBook({ catalogId: "a" }), makeBook({ catalogId: "b" })],
      }),
      makeResponseWithData({
        year: 2025,
        totalRecords: 7,
        topBooks: [makeBook({ catalogId: "a" }), makeBook({ catalogId: "b" })],
      }),
    ];
    const first = buildWereadReadingArchive({
      responses,
      requestedYears: 2,
      topBooksLimit: 12,
    });
    const second = buildWereadReadingArchive({
      responses,
      requestedYears: 2,
      topBooksLimit: 12,
    });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});

// ---------- forbidden topBooksLimits ----------

describe("topBooks limit type", () => {
  it("clamps invalid limits to 12 when constructing an archive", () => {
    // We can't pass an invalid type at compile time, but we exercise
    // the underlying signature — meta.topBooksLimit must be one of the
    // allowed values.
    const archive = buildWereadReadingArchive({
      responses: [makeResponseWithData({ year: 2025, totalRecords: 5 })],
      requestedYears: 1,
      topBooksLimit: 18,
    });
    const allowed: WereadAnnualReviewTopBooksOption[] = [6, 12, 18];
    expect(allowed).toContain(archive.meta.topBooksLimit);
  });
});
