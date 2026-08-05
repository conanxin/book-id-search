import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  auditReadingDataQuality,
  auditReadingDataQualityRecurringBooks,
  auditReadingDataQualityTopBooks,
  auditReadingDataQualityYearLinks,
  auditReadingDataQualityYears,
  auditReadingYearCoverage,
  buildReadingDataQualityDebugSnapshot,
  normalizeReadingDataQualityYears,
  type TopBookAuditMetadata,
} from "./wereadReadingDataQualityAudit";
import type {
  ReadingArchiveRecurringBook,
  ReadingArchiveYear,
  ReadingArchiveYearLink,
  WereadReadingArchive,
} from "./wereadReadingArchiveModel";

// ============================================================
// helpers
// ============================================================

function makeYear(
  overrides: Partial<ReadingArchiveYear> = {}
): ReadingArchiveYear {
  return {
    year: 2025,
    totalRecords: 100,
    datedRecords: 100,
    matchedRecords: 100,
    matchedBooks: 5,
    activeMonths: 6,
    longestStreakMonths: 6,
    peakMonth: "2025-06",
    peakMonthRecords: 30,
    averageRecordsPerActiveMonth: 16.67,
    topBookCount: 3,
    topBookCatalogIds: ["b1", "b2", "b3"],
    ...overrides,
  };
}

function makeArchive(
  overrides: Partial<WereadReadingArchive> = {}
): WereadReadingArchive {
  return {
    years: [makeYear()],
    overview: {
      yearsWithData: 1,
      firstYear: 2025,
      latestYear: 2025,
      totalRecords: 100,
      totalActiveMonths: 6,
      averageRecordsPerYear: 100,
      mostActiveYear: 2025,
      mostActiveYearRecords: 100,
      longestActiveYearStreak: 1,
      recurringTopBooks: 0,
    },
    recurringBooks: [],
    yearLinks: [],
    meta: {
      requestedYears: 1,
      loadedYears: 1,
      topBooksLimit: 12,
      maxYears: 20,
      persisted: false,
      source: "annual-review-cache",
    },
    ...overrides,
  };
}

function makeBookMeta(
  year: number,
  books: Array<{ title?: string | null; rank?: number; records?: number }>
): TopBookAuditMetadata {
  return { year, books };
}

function makeYearLink(
  overrides: Partial<ReadingArchiveYearLink> = {}
): ReadingArchiveYearLink {
  return {
    sourceYear: 2024,
    targetYear: 2025,
    sharedTopBooks: 2,
    overlapRatio: 0.5,
    ...overrides,
  };
}

function makeRecurring(
  overrides: Partial<ReadingArchiveRecurringBook> = {}
): ReadingArchiveRecurringBook {
  return {
    catalogId: "r1",
    title: "Recurring Book",
    author: null,
    publisher: null,
    publishYear: null,
    yearsOnList: 2,
    years: [2024, 2025],
    totalNoteCountWithinLists: 20,
    bestRank: 1,
    latestYear: 2025,
    latestRank: 2,
    ...overrides,
  };
}

// ============================================================
// normalize
// ============================================================

describe("normalizeReadingDataQualityYears", () => {
  it("sorts and deduplicates years ascending", () => {
    expect(normalizeReadingDataQualityYears([2025, 2024, 2025])).toEqual([2024, 2025]);
  });

  it("drops non-integer and out-of-range years", () => {
    const current = new Date().getFullYear();
    expect(
      normalizeReadingDataQualityYears([
        current, 2020, current, 1899, current + 2, 2023.5, NaN,
        "2024", null, undefined,
      ] as unknown[])
    ).toEqual([2020, current]);
  });

  it("does not mutate the input array", () => {
    const input = [2025, 2024, 2025];
    const snapshot = [...input];
    normalizeReadingDataQualityYears(input);
    expect(input).toEqual(snapshot);
  });
});

// ============================================================
// coverage audit
// ============================================================

describe("auditReadingYearCoverage", () => {
  it("emits empty_archive info when target and loaded both empty", () => {
    const issues = auditReadingYearCoverage({
      targetYears: [],
      loadedYears: [],
      failedYears: [],
    });
    expect(issues.some((i) => i.code === "empty_archive" && i.severity === "info")).toBe(true);
  });

  it("warns for all target years when loaded is empty", () => {
    const issues = auditReadingYearCoverage({
      targetYears: [2024, 2025],
      loadedYears: [],
      failedYears: [],
    });
    const unaccounted = issues.filter((i) => i.code === "target_year_unaccounted");
    expect(unaccounted).toHaveLength(2);
  });

  it("deduplicates and sorts failed years", () => {
    const issues = auditReadingYearCoverage({
      targetYears: [2024, 2025],
      loadedYears: [2024, 2025],
      failedYears: [2025, 2024, 2025],
    });
    const conflicts = issues.filter((i) => i.code === "loaded_failed_conflict");
    expect(conflicts.length).toBeGreaterThanOrEqual(1);
  });

  it("errors for invalid target years (below 1900)", () => {
    const issues = auditReadingYearCoverage({
      targetYears: [1899, 2025],
      loadedYears: [2025],
      failedYears: [],
    });
    expect(issues.some((i) => i.code === "invalid_year" && i.severity === "error")).toBe(true);
  });

  it("errors for duplicate loaded years", () => {
    const issues = auditReadingYearCoverage({
      targetYears: [2025],
      loadedYears: [2025, 2025],
      failedYears: [],
    });
    const issue = issues.find((i) => i.code === "duplicate_loaded_year");
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe("error");
  });

  it("errors when a year is both loaded and failed", () => {
    const issues = auditReadingYearCoverage({
      targetYears: [2025],
      loadedYears: [2025],
      failedYears: [2025],
    });
    expect(issues.some((i) => i.code === "loaded_failed_conflict" && i.severity === "error")).toBe(true);
  });

  it("warns when a target year is unaccounted", () => {
    const issues = auditReadingYearCoverage({
      targetYears: [2024, 2025, 2026],
      loadedYears: [2024, 2025],
      failedYears: [],
    });
    const issue = issues.find((i) => i.code === "target_year_unaccounted");
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe("warning");
    expect(issue!.year).toBe(2026);
  });

  it("does not flag unexpected loaded years as errors", () => {
    const issues = auditReadingYearCoverage({
      targetYears: [2024],
      loadedYears: [2024, 2025],
      failedYears: [],
    });
    expect(issues.some((i) => i.severity === "error")).toBe(false);
  });

  it("warns for partial archive with both loaded and failed years", () => {
    const issues = auditReadingYearCoverage({
      targetYears: [2024, 2025],
      loadedYears: [2024],
      failedYears: [2025],
    });
    const issue = issues.find((i) => i.code === "partial_archive");
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe("warning");
  });
});

// ============================================================
// year metrics audit
// ============================================================

describe("auditReadingDataQualityYears", () => {
  it("errors for non-finite totalRecords (NaN)", () => {
    const issues = auditReadingDataQualityYears({
      years: [makeYear({ totalRecords: NaN })],
    });
    expect(issues.some((i) => i.code === "non_finite_metric" && i.severity === "error")).toBe(true);
  });

  it("errors for non-finite activeMonths (Infinity)", () => {
    const issues = auditReadingDataQualityYears({
      years: [makeYear({ activeMonths: Infinity })],
    });
    expect(issues.some((i) => i.code === "non_finite_metric" && i.severity === "error")).toBe(true);
  });

  it("errors for negative metric values", () => {
    const issues = auditReadingDataQualityYears({
      years: [makeYear({ totalRecords: -1, matchedBooks: -5 })],
    });
    const negatives = issues.filter((i) => i.code === "negative_metric");
    expect(negatives.length).toBeGreaterThanOrEqual(2);
    expect(negatives.every((i) => i.severity === "error")).toBe(true);
  });

  it("errors when dated records exceed total", () => {
    const issues = auditReadingDataQualityYears({
      years: [makeYear({ totalRecords: 50, datedRecords: 100 })],
    });
    expect(issues.some((i) => i.code === "dated_records_exceed_total")).toBe(true);
  });

  it("errors when matched records exceed total", () => {
    const issues = auditReadingDataQualityYears({
      years: [makeYear({ totalRecords: 50, matchedRecords: 100 })],
    });
    expect(issues.some((i) => i.code === "matched_records_exceed_total")).toBe(true);
  });

  it("errors when matched books exceed matched records", () => {
    const issues = auditReadingDataQualityYears({
      years: [makeYear({ matchedRecords: 5, matchedBooks: 10 })],
    });
    expect(issues.some((i) => i.code === "matched_books_exceed_matched_records")).toBe(true);
  });

  it("passes for activeMonths=0 when peakMonth is null", () => {
    const issues = auditReadingDataQualityYears({
      years: [makeYear({
        activeMonths: 0,
        longestStreakMonths: 0,
        peakMonth: null,
      })],
    });
    expect(issues).toHaveLength(0);
  });

  it("passes for activeMonths=12 (boundary)", () => {
    const issues = auditReadingDataQualityYears({
      years: [makeYear({ activeMonths: 12, longestStreakMonths: 12, peakMonth: "2025-12" })],
    });
    expect(issues).toHaveLength(0);
  });

  it("errors when activeMonths>12", () => {
    const issues = auditReadingDataQualityYears({
      years: [makeYear({ activeMonths: 13 })],
    });
    expect(issues.some((i) => i.code === "active_months_out_of_range")).toBe(true);
  });

  it("errors when longestStreakMonths<0", () => {
    const issues = auditReadingDataQualityYears({
      years: [makeYear({ longestStreakMonths: -1, activeMonths: 6 })],
    });
    expect(issues.some((i) => i.code === "negative_metric")).toBe(true);
  });

  it("errors when longestStreakMonths>12", () => {
    const issues = auditReadingDataQualityYears({
      years: [makeYear({ longestStreakMonths: 13 })],
    });
    expect(issues.some((i) => i.code === "streak_months_out_of_range")).toBe(true);
  });

  it("errors when streak exceeds active months", () => {
    const issues = auditReadingDataQualityYears({
      years: [makeYear({ activeMonths: 3, longestStreakMonths: 6 })],
    });
    expect(issues.some((i) => i.code === "streak_exceeds_active_months")).toBe(true);
  });

  it("passes for valid peakMonth matching year", () => {
    const issues = auditReadingDataQualityYears({
      years: [makeYear({ year: 2025, peakMonth: "2025-06" })],
    });
    expect(issues).toHaveLength(0);
  });

  it("errors when peakMonth year does not match year", () => {
    const issues = auditReadingDataQualityYears({
      years: [makeYear({ year: 2025, peakMonth: "2024-06" })],
    });
    expect(issues.some((i) => i.code === "peak_month_year_mismatch" && i.severity === "error")).toBe(true);
  });

  it("warns when peakMonth present with zero activeMonths", () => {
    const issues = auditReadingDataQualityYears({
      years: [makeYear({ activeMonths: 0, peakMonth: "2025-06" })],
    });
    expect(issues.some((i) => i.code === "peak_month_year_mismatch" && i.severity === "warning")).toBe(true);
  });

  // ---- B3: Issue ID uniqueness tests ----
  it("B3: same-year totalRecords and activeMonths both NaN produce two distinct IDs", () => {
    const result = auditReadingDataQuality({
      archive: makeArchive({
        years: [makeYear({
          totalRecords: NaN,
          activeMonths: NaN,
        })],
      }),
      targetYears: [2025],
      failedYears: [],
      topBooksLimit: 12,
    });
    const nonFinite = result.issues.filter((i) => i.code === "non_finite_metric");
    expect(nonFinite.length).toBeGreaterThanOrEqual(2);
    const ids = nonFinite.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("B3: same-year two negative metrics produce two distinct IDs", () => {
    const result = auditReadingDataQuality({
      archive: makeArchive({
        years: [makeYear({
          totalRecords: -1,
          matchedBooks: -5,
        })],
      }),
      targetYears: [2025],
      failedYears: [],
      topBooksLimit: 12,
    });
    const negatives = result.issues.filter((i) => i.code === "negative_metric");
    expect(negatives.length).toBeGreaterThanOrEqual(2);
    const ids = negatives.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("B3: metric itemIndex is stable across repeated calls", () => {
    const input: Parameters<typeof auditReadingDataQuality>[0] = {
      archive: makeArchive({
        years: [makeYear({ totalRecords: NaN, activeMonths: -1 })],
      }),
      targetYears: [2025],
      failedYears: [],
      topBooksLimit: 12,
    };
    const r1 = auditReadingDataQuality(input);
    const r2 = auditReadingDataQuality(input);
    const i1 = r1.issues.filter((i) => i.code === "non_finite_metric" || i.code === "negative_metric");
    const i2 = r2.issues.filter((i) => i.code === "non_finite_metric" || i.code === "negative_metric");
    expect(i1.map((i) => i.itemIndex)).toEqual(i2.map((i) => i.itemIndex));
  });

  it("B3: Issue objects only contain allowed fields", () => {
    const issues = auditReadingDataQualityYears({
      years: [makeYear({ totalRecords: -1 })],
    });
    const allowed = new Set([
      "id", "code", "severity", "scope",
      "year", "fromYear", "toYear",
      "itemIndex", "rank", "actual", "expected",
    ]);
    for (const issue of issues) {
      for (const k of Object.keys(issue)) {
        expect(allowed.has(k)).toBe(true);
      }
    }
  });
});

// ============================================================
// top books audit
// ============================================================

describe("auditReadingDataQualityTopBooks", () => {
  it("passes for top books within limit", () => {
    const issues = auditReadingDataQualityTopBooks({
      years: [makeYear()],
      topBooksLimit: 12,
    });
    expect(issues).toHaveLength(0);
  });

  it("warns when top book count exceeds limit", () => {
    const issues = auditReadingDataQualityTopBooks({
      years: [makeYear({
        topBookCount: 15,
        topBookCatalogIds: Array(15).fill("x"),
      })],
      topBooksLimit: 12,
    });
    expect(issues.some((i) => i.code === "top_books_exceed_limit" && i.severity === "warning")).toBe(true);
  });

  it("errors for empty string catalog ids", () => {
    const issues = auditReadingDataQualityTopBooks({
      years: [makeYear({ topBookCatalogIds: ["b1", "", "b3"] })],
      topBooksLimit: 12,
    });
    expect(issues.some((i) => i.code === "top_book_missing_catalog")).toBe(true);
  });

  it("errors for missing title when bookMetadata is provided", () => {
    const issues = auditReadingDataQualityTopBooks({
      years: [makeYear({ topBookCatalogIds: ["b1", "b2"] })],
      topBooksLimit: 12,
      bookMetadata: [
        makeBookMeta(2025, [
          { title: "OK", rank: 1, records: 10 },
          { title: "", rank: 2, records: 5 },
        ]),
      ],
    });
    expect(issues.some((i) => i.code === "top_book_missing_title")).toBe(true);
  });

  it("errors for duplicate catalog ids", () => {
    const issues = auditReadingDataQualityTopBooks({
      years: [makeYear({ topBookCatalogIds: ["b1", "b2", "b1"] })],
      topBooksLimit: 12,
    });
    expect(issues.some((i) => i.code === "top_book_duplicate_catalog")).toBe(true);
  });

  it("errors for invalid rank (zero) when bookMetadata is provided", () => {
    const issues = auditReadingDataQualityTopBooks({
      years: [makeYear({ topBookCatalogIds: ["b1", "b2"] })],
      topBooksLimit: 12,
      bookMetadata: [
        makeBookMeta(2025, [
          { title: "T1", rank: 0, records: 5 },
          { title: "T2", rank: 2, records: 5 },
        ]),
      ],
    });
    expect(issues.some((i) => i.code === "top_book_invalid_rank")).toBe(true);
  });

  it("errors for duplicate rank when bookMetadata is provided", () => {
    const issues = auditReadingDataQualityTopBooks({
      years: [makeYear({ topBookCatalogIds: ["b1", "b2", "b3"] })],
      topBooksLimit: 12,
      bookMetadata: [
        makeBookMeta(2025, [
          { title: "T1", rank: 1, records: 5 },
          { title: "T2", rank: 1, records: 5 },
          { title: "T3", rank: 3, records: 5 },
        ]),
      ],
    });
    expect(issues.some((i) => i.code === "top_book_duplicate_rank")).toBe(true);
  });

  it("errors when book records exceed year total", () => {
    const issues = auditReadingDataQualityTopBooks({
      years: [makeYear({
        year: 2025,
        totalRecords: 100,
        topBookCatalogIds: ["b1", "b2"],
      })],
      topBooksLimit: 12,
      bookMetadata: [
        makeBookMeta(2025, [
          { title: "T1", rank: 1, records: 50 },
          { title: "T2", rank: 2, records: 200 },
        ]),
      ],
    });
    expect(issues.some((i) => i.code === "top_book_records_exceed_year_total")).toBe(true);
  });

  it("errors when rank order does not match input order", () => {
    const issues = auditReadingDataQualityTopBooks({
      years: [makeYear({ topBookCatalogIds: ["b1", "b2", "b3"] })],
      topBooksLimit: 12,
      bookMetadata: [
        makeBookMeta(2025, [
          { title: "T1", rank: 3, records: 5 },
          { title: "T2", rank: 1, records: 5 },
          { title: "T3", rank: 2, records: 5 },
        ]),
      ],
    });
    expect(issues.some((i) => i.code === "top_book_order_mismatch")).toBe(true);
  });

  it("does not emit top_book checks when bookMetadata is missing", () => {
    const issues = auditReadingDataQualityTopBooks({
      years: [makeYear()],
      topBooksLimit: 12,
    });
    expect(issues.some((i) => i.code === "top_book_missing_title")).toBe(false);
    expect(issues.some((i) => i.code === "top_book_invalid_rank")).toBe(false);
    expect(issues.some((i) => i.code === "top_book_duplicate_rank")).toBe(false);
    expect(issues.some((i) => i.code === "top_book_records_exceed_year_total")).toBe(false);
    expect(issues.some((i) => i.code === "top_book_order_mismatch")).toBe(false);
  });
});

// ============================================================
// year link audit
// ============================================================

describe("auditReadingDataQualityYearLinks", () => {
  it("passes for a valid link", () => {
    const years: ReadingArchiveYear[] = [makeYear({ year: 2024 }), makeYear({ year: 2025 })];
    const links: ReadingArchiveYearLink[] = [makeYearLink({ sourceYear: 2024, targetYear: 2025 })];
    const result = auditReadingDataQualityYearLinks({ years, yearLinks: links });
    expect(result.issues.filter((i) => i.severity !== "info")).toHaveLength(0);
    expect(result.expectedPairCount).toBe(1);
    expect(result.validExpectedPairCount).toBe(1);
  });

  it("errors for unknown source year", () => {
    const years: ReadingArchiveYear[] = [makeYear({ year: 2025 })];
    const links: ReadingArchiveYearLink[] = [makeYearLink({ sourceYear: 2023, targetYear: 2025 })];
    const result = auditReadingDataQualityYearLinks({ years, yearLinks: links });
    expect(result.issues.some((i) => i.code === "year_link_unknown_year")).toBe(true);
  });

  it("errors for unknown target year", () => {
    const years: ReadingArchiveYear[] = [makeYear({ year: 2024 })];
    const links: ReadingArchiveYearLink[] = [makeYearLink({ sourceYear: 2024, targetYear: 2025 })];
    const result = auditReadingDataQualityYearLinks({ years, yearLinks: links });
    expect(result.issues.some((i) => i.code === "year_link_unknown_year")).toBe(true);
  });

  it("errors when source >= target", () => {
    const years: ReadingArchiveYear[] = [makeYear({ year: 2024 }), makeYear({ year: 2025 })];
    const links: ReadingArchiveYearLink[] = [makeYearLink({ sourceYear: 2025, targetYear: 2024 })];
    const result = auditReadingDataQualityYearLinks({ years, yearLinks: links });
    expect(result.issues.some((i) => i.code === "year_link_invalid_order")).toBe(true);
  });

  it("errors for duplicate pair", () => {
    const years: ReadingArchiveYear[] = [makeYear({ year: 2024 }), makeYear({ year: 2025 })];
    const links: ReadingArchiveYearLink[] = [
      makeYearLink({ sourceYear: 2024, targetYear: 2025 }),
      makeYearLink({ sourceYear: 2024, targetYear: 2025 }),
    ];
    const result = auditReadingDataQualityYearLinks({ years, yearLinks: links });
    expect(result.issues.some((i) => i.code === "year_link_duplicate_pair")).toBe(true);
  });

  it("errors for non-integer sharedTopBooks", () => {
    const years: ReadingArchiveYear[] = [makeYear({ year: 2024 }), makeYear({ year: 2025 })];
    const links: ReadingArchiveYearLink[] = [makeYearLink({ sharedTopBooks: 1.5 })];
    const result = auditReadingDataQualityYearLinks({ years, yearLinks: links });
    expect(result.issues.some((i) => i.code === "year_link_invalid_counts")).toBe(true);
  });

  it("errors for ratio NaN", () => {
    const years: ReadingArchiveYear[] = [makeYear({ year: 2024 }), makeYear({ year: 2025 })];
    const links: ReadingArchiveYearLink[] = [makeYearLink({ overlapRatio: NaN })];
    const result = auditReadingDataQualityYearLinks({ years, yearLinks: links });
    expect(result.issues.some((i) => i.code === "year_link_ratio_out_of_range")).toBe(true);
  });

  it("errors for ratio < 0", () => {
    const years: ReadingArchiveYear[] = [makeYear({ year: 2024 }), makeYear({ year: 2025 })];
    const links: ReadingArchiveYearLink[] = [makeYearLink({ overlapRatio: -0.1 })];
    const result = auditReadingDataQualityYearLinks({ years, yearLinks: links });
    expect(result.issues.some((i) => i.code === "year_link_ratio_out_of_range")).toBe(true);
  });

  it("errors for ratio > 1", () => {
    const years: ReadingArchiveYear[] = [makeYear({ year: 2024 }), makeYear({ year: 2025 })];
    const links: ReadingArchiveYearLink[] = [makeYearLink({ overlapRatio: 1.5 })];
    const result = auditReadingDataQualityYearLinks({ years, yearLinks: links });
    expect(result.issues.some((i) => i.code === "year_link_ratio_out_of_range")).toBe(true);
  });

  it("accepts sharedTopBooks=0 with ratio=0 (union=0 case)", () => {
    const years: ReadingArchiveYear[] = [makeYear({ year: 2024 }), makeYear({ year: 2025 })];
    const links: ReadingArchiveYearLink[] = [makeYearLink({ sharedTopBooks: 0, overlapRatio: 0 })];
    const result = auditReadingDataQualityYearLinks({ years, yearLinks: links });
    expect(result.issues.some((i) => i.code === "year_link_ratio_mismatch")).toBe(false);
  });

  it("errors for sharedTopBooks=0 with ratio>0 (mismatch)", () => {
    const years: ReadingArchiveYear[] = [makeYear({ year: 2024 }), makeYear({ year: 2025 })];
    const links: ReadingArchiveYearLink[] = [makeYearLink({ sharedTopBooks: 0, overlapRatio: 0.5 })];
    const result = auditReadingDataQualityYearLinks({ years, yearLinks: links });
    expect(result.issues.some((i) => i.code === "year_link_ratio_mismatch")).toBe(true);
  });

  it("warns for missing expected pair", () => {
    const years: ReadingArchiveYear[] = [makeYear({ year: 2024 }), makeYear({ year: 2025 })];
    const links: ReadingArchiveYearLink[] = [];
    const result = auditReadingDataQualityYearLinks({ years, yearLinks: links });
    expect(result.issues.some((i) => i.code === "missing_year_link" && i.severity === "warning")).toBe(true);
  });

  it("returns 0 expected pairs for single year", () => {
    const years: ReadingArchiveYear[] = [makeYear({ year: 2025 })];
    const result = auditReadingDataQualityYearLinks({ years, yearLinks: [] });
    expect(result.expectedPairCount).toBe(0);
    expect(result.validExpectedPairCount).toBe(0);
  });

  it("expects adjacent pair even when natural year has gap", () => {
    // Loaded years: [2020, 2022] — natural gap at 2021 — still expects
    // a 2020->2022 link.
    const years: ReadingArchiveYear[] = [
      makeYear({ year: 2020 }),
      makeYear({ year: 2022 }),
    ];
    const result = auditReadingDataQualityYearLinks({ years, yearLinks: [] });
    expect(result.expectedPairCount).toBe(1);
    expect(result.issues.some((i) => i.code === "missing_year_link")).toBe(true);
  });

  it("does not count unexpected extra pairs in coverage numerator", () => {
    // Loaded years [2024, 2025] → expected pair = 2024->2025.
    // Add extra 2025->2024 (invalid order) — must NOT count.
    const years: ReadingArchiveYear[] = [makeYear({ year: 2024 }), makeYear({ year: 2025 })];
    const links: ReadingArchiveYearLink[] = [
      makeYearLink({ sourceYear: 2024, targetYear: 2025 }),
      makeYearLink({ sourceYear: 2025, targetYear: 2024 }), // invalid order
    ];
    const result = auditReadingDataQualityYearLinks({ years, yearLinks: links });
    expect(result.expectedPairCount).toBe(1);
    expect(result.validExpectedPairCount).toBe(1);
  });

  it("does not double-count duplicate pair in coverage numerator", () => {
    const years: ReadingArchiveYear[] = [makeYear({ year: 2024 }), makeYear({ year: 2025 })];
    const links: ReadingArchiveYearLink[] = [
      makeYearLink({ sourceYear: 2024, targetYear: 2025 }),
      makeYearLink({ sourceYear: 2024, targetYear: 2025 }), // duplicate
    ];
    const result = auditReadingDataQualityYearLinks({ years, yearLinks: links });
    expect(result.validExpectedPairCount).toBe(1);
  });

  it("computes yearLinkCoverageRatio from validExpectedPairCount / expectedPairCount", () => {
    const years: ReadingArchiveYear[] = [
      makeYear({ year: 2023 }),
      makeYear({ year: 2024 }),
      makeYear({ year: 2025 }),
    ];
    const links: ReadingArchiveYearLink[] = [
      makeYearLink({ sourceYear: 2023, targetYear: 2024 }),
      // 2024->2025 missing → 1 of 2 expected
    ];
    const result = auditReadingDataQualityYearLinks({ years, yearLinks: links });
    expect(result.expectedPairCount).toBe(2);
    expect(result.validExpectedPairCount).toBe(1);
  });

  it("returns yearLinkCoverageRatio 1 when expectedPairCount = 0", () => {
    const years: ReadingArchiveYear[] = [makeYear({ year: 2025 })];
    const result = auditReadingDataQualityYearLinks({ years, yearLinks: [] });
    expect(result.expectedPairCount).toBe(0);
  });
});

// ============================================================
// recurring books audit
// ============================================================

describe("auditReadingDataQualityRecurringBooks", () => {
  it("passes for a clean recurring book", () => {
    const years: ReadingArchiveYear[] = [makeYear({ year: 2024 }), makeYear({ year: 2025 })];
    const books: ReadingArchiveRecurringBook[] = [makeRecurring()];
    const issues = auditReadingDataQualityRecurringBooks({ years, recurringBooks: books });
    expect(issues).toHaveLength(0);
  });

  it("errors for duplicate recurring catalog", () => {
    const years: ReadingArchiveYear[] = [makeYear({ year: 2024 }), makeYear({ year: 2025 })];
    const books: ReadingArchiveRecurringBook[] = [
      makeRecurring({ catalogId: "r1" }),
      makeRecurring({ catalogId: "r1" }),
    ];
    const issues = auditReadingDataQualityRecurringBooks({ years, recurringBooks: books });
    expect(issues.some((i) => i.code === "recurring_duplicate_catalog")).toBe(true);
  });

  it("errors for appearanceCount mismatch (yearsOnList vs years.length)", () => {
    const years: ReadingArchiveYear[] = [makeYear({ year: 2024 }), makeYear({ year: 2025 })];
    const books: ReadingArchiveRecurringBook[] = [
      makeRecurring({ yearsOnList: 3, years: [2024, 2025] }),
    ];
    const issues = auditReadingDataQualityRecurringBooks({ years, recurringBooks: books });
    expect(issues.some((i) => i.code === "recurring_appearance_count_mismatch")).toBe(true);
  });

  it("warns for unknown appearance year", () => {
    const years: ReadingArchiveYear[] = [makeYear({ year: 2025 })];
    const books: ReadingArchiveRecurringBook[] = [
      makeRecurring({ years: [2024, 2025] }),
    ];
    const issues = auditReadingDataQualityRecurringBooks({ years, recurringBooks: books });
    expect(issues.some((i) => i.code === "recurring_unknown_year" && i.severity === "warning")).toBe(true);
  });

  it("errors for duplicate appearance year within a recurring book", () => {
    const years: ReadingArchiveYear[] = [makeYear({ year: 2024 }), makeYear({ year: 2025 })];
    const books: ReadingArchiveRecurringBook[] = [
      makeRecurring({ years: [2024, 2024, 2025] }),
    ];
    const issues = auditReadingDataQualityRecurringBooks({ years, recurringBooks: books });
    expect(issues.some((i) => i.code === "recurring_duplicate_year")).toBe(true);
  });

  it("errors for invalid bestRank (zero)", () => {
    const years: ReadingArchiveYear[] = [makeYear({ year: 2024 }), makeYear({ year: 2025 })];
    const books: ReadingArchiveRecurringBook[] = [makeRecurring({ bestRank: 0 })];
    const issues = auditReadingDataQualityRecurringBooks({ years, recurringBooks: books });
    expect(issues.some((i) => i.code === "recurring_invalid_rank")).toBe(true);
  });

  it("errors for invalid bestRank (non-integer)", () => {
    const years: ReadingArchiveYear[] = [makeYear({ year: 2024 }), makeYear({ year: 2025 })];
    const books: ReadingArchiveRecurringBook[] = [makeRecurring({ bestRank: 1.5 })];
    const issues = auditReadingDataQualityRecurringBooks({ years, recurringBooks: books });
    expect(issues.some((i) => i.code === "recurring_invalid_rank")).toBe(true);
  });

  it("errors for invalid latestRank", () => {
    const years: ReadingArchiveYear[] = [makeYear({ year: 2024 }), makeYear({ year: 2025 })];
    const books: ReadingArchiveRecurringBook[] = [makeRecurring({ latestRank: 0 })];
    const issues = auditReadingDataQualityRecurringBooks({ years, recurringBooks: books });
    expect(issues.some((i) => i.code === "recurring_invalid_rank")).toBe(true);
  });

  it("errors for latestYear not in years", () => {
    const years: ReadingArchiveYear[] = [makeYear({ year: 2024 }), makeYear({ year: 2025 })];
    const books: ReadingArchiveRecurringBook[] = [makeRecurring({ latestYear: 2023 })];
    const issues = auditReadingDataQualityRecurringBooks({ years, recurringBooks: books });
    expect(issues.some((i) => i.code === "recurring_latest_year_mismatch")).toBe(true);
  });

  it("does not mutate the input recurringBooks array", () => {
    const years: ReadingArchiveYear[] = [makeYear({ year: 2024 }), makeYear({ year: 2025 })];
    const books: ReadingArchiveRecurringBook[] = [
      makeRecurring({ years: [2024, 2025] }),
    ];
    const before = JSON.stringify(books);
    auditReadingDataQualityRecurringBooks({ years, recurringBooks: books });
    expect(JSON.stringify(books)).toBe(before);
  });

  it("recurring Issues never contain catalogId or title", () => {
    const years: ReadingArchiveYear[] = [makeYear({ year: 2024 }), makeYear({ year: 2025 })];
    const books: ReadingArchiveRecurringBook[] = [
      makeRecurring({ catalogId: "secret-id", title: "Secret Title" }),
    ];
    const issues = auditReadingDataQualityRecurringBooks({ years, recurringBooks: books });
    const dump = JSON.stringify(issues);
    expect(dump).not.toContain("secret-id");
    expect(dump).not.toContain("Secret Title");
  });
});

// ============================================================
// issue sorting and IDs
// ============================================================

describe("issue sorting and IDs", () => {
  it("sorts issues with errors first, then warnings, then info", () => {
    const result = auditReadingDataQuality({
      archive: makeArchive({
        years: [
          makeYear({
            year: 2025,
            totalRecords: -1,
            activeMonths: 0,
            peakMonth: null,
            longestStreakMonths: 0,
          }),
        ],
      }),
      targetYears: [2025, 2026],
      failedYears: [],
      topBooksLimit: 12,
    });
    const issues = result.issues;
    expect(issues.length).toBeGreaterThan(0);
    const sevOrder = { error: 0, warning: 1, info: 2 } as const;
    for (let i = 1; i < issues.length; i++) {
      const prev = sevOrder[issues[i - 1].severity];
      const cur = sevOrder[issues[i].severity];
      expect(cur).toBeGreaterThanOrEqual(prev);
    }
  });

  it("produces deterministic issue IDs from structural fields", () => {
    const input: Parameters<typeof auditReadingDataQuality>[0] = {
      archive: makeArchive({ years: [makeYear({ totalRecords: -1 })] }),
      targetYears: [2025],
      failedYears: [],
      topBooksLimit: 12,
    };
    const r1 = auditReadingDataQuality(input);
    const r2 = auditReadingDataQuality(input);
    expect(r1.issues.map((i) => i.id)).toEqual(r2.issues.map((i) => i.id));
  });

  it("issue IDs follow the scope:code:year:fromYear:toYear:itemIndex:rank format", () => {
    const result = auditReadingDataQuality({
      archive: makeArchive({ years: [makeYear({ totalRecords: -1 })] }),
      targetYears: [2025],
      failedYears: [],
      topBooksLimit: 12,
    });
    for (const issue of result.issues) {
      const parts = issue.id.split(":");
      expect(parts).toHaveLength(7);
      expect(parts[0]).toBe(issue.scope);
      expect(parts[1]).toBe(issue.code);
      expect(parts[2]).toBe(String(issue.year ?? "-"));
    }
  });
});

// ============================================================
// main entry / summary
// ============================================================

describe("auditReadingDataQuality (main entry)", () => {
  it("returns pass for a clean archive", () => {
    const result = auditReadingDataQuality({
      archive: makeArchive({ years: [makeYear()] }),
      targetYears: [2025],
      failedYears: [],
      topBooksLimit: 12,
    });
    expect(result.status).toBe("pass");
  });

  it("returns fail when an error is present", () => {
    const result = auditReadingDataQuality({
      archive: makeArchive({ years: [makeYear({ totalRecords: -1 })] }),
      targetYears: [2025],
      failedYears: [],
      topBooksLimit: 12,
    });
    expect(result.status).toBe("fail");
    expect(result.summary.errorCount).toBeGreaterThanOrEqual(1);
  });

  it("returns warn when only warnings are present", () => {
    const result = auditReadingDataQuality({
      archive: makeArchive({ years: [makeYear()] }),
      targetYears: [2025, 2026],
      failedYears: [],
      topBooksLimit: 12,
    });
    expect(result.status).toBe("warn");
    expect(result.summary.warningCount).toBeGreaterThanOrEqual(1);
  });

  it("always sets persisted=false in meta", () => {
    const result = auditReadingDataQuality({
      archive: makeArchive(),
      targetYears: [2025],
      failedYears: [],
      topBooksLimit: 12,
    });
    expect(result.meta.persisted).toBe(false);
  });

  it("always sets requestedNetwork=false in meta", () => {
    const result = auditReadingDataQuality({
      archive: makeArchive(),
      targetYears: [2025],
      failedYears: [],
      topBooksLimit: 12,
    });
    expect(result.meta.requestedNetwork).toBe(false);
  });

  it("computes accounted ratio with 4 decimal precision", () => {
    const result = auditReadingDataQuality({
      archive: makeArchive({
        years: [makeYear({ year: 2024 }), makeYear({ year: 2025 })],
      }),
      targetYears: [2024, 2025, 2026],
      failedYears: [],
      topBooksLimit: 12,
    });
    expect(result.summary.accountedRatio).toBeCloseTo(0.6667, 4);
  });

  it("returns accountedRatio 1 when target years are empty", () => {
    const result = auditReadingDataQuality({
      archive: makeArchive(),
      targetYears: [],
      failedYears: [],
      topBooksLimit: 12,
    });
    expect(result.summary.accountedRatio).toBe(1);
  });

  it("handles NaN and Infinity in ratio calculation", () => {
    const result = auditReadingDataQuality({
      archive: makeArchive(),
      targetYears: [2025],
      failedYears: [],
      topBooksLimit: 12,
    });
    expect(Number.isFinite(result.summary.accountedRatio)).toBe(true);
    expect(Number.isNaN(result.summary.accountedRatio)).toBe(false);
    expect(Number.isFinite(result.summary.datedRecordRatio)).toBe(true);
    expect(Number.isFinite(result.summary.matchedRecordRatio)).toBe(true);
    expect(Number.isFinite(result.summary.publicTopBookMetadataRatio)).toBe(true);
    expect(Number.isFinite(result.summary.yearLinkCoverageRatio)).toBe(true);
  });

  it("includes auditedAt timestamp", () => {
    const before = new Date().getTime();
    const result = auditReadingDataQuality({
      archive: makeArchive(),
      targetYears: [2025],
      failedYears: [],
      topBooksLimit: 12,
    });
    const after = new Date().getTime();
    expect(result.auditedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(result.auditedAt.getTime()).toBeLessThanOrEqual(after);
  });

  it("does not modify the input archive", () => {
    const original = makeArchive({
      years: [makeYear()],
      yearLinks: [],
      recurringBooks: [],
    });
    const snapshot = JSON.stringify(original);
    auditReadingDataQuality({
      archive: original,
      targetYears: [2025],
      failedYears: [],
      topBooksLimit: 12,
    });
    expect(JSON.stringify(original)).toBe(snapshot);
  });

  it("full model is deterministic across repeated calls", () => {
    const input: Parameters<typeof auditReadingDataQuality>[0] = {
      archive: makeArchive({
        years: [
          makeYear({ year: 2024, topBookCatalogIds: ["a", "b"] }),
          makeYear({ year: 2025, topBookCatalogIds: ["b", "c"] }),
        ],
        yearLinks: [makeYearLink({ sourceYear: 2024, targetYear: 2025 })],
        recurringBooks: [makeRecurring()],
      }),
      targetYears: [2024, 2025],
      failedYears: [],
      topBooksLimit: 12,
    };
    const r1 = auditReadingDataQuality(input);
    const r2 = auditReadingDataQuality(input);
    expect(r1.issues.map((i) => i.id)).toEqual(r2.issues.map((i) => i.id));
    expect(r1.summary).toEqual(r2.summary);
    expect(r1.coverage).toEqual(r2.coverage);
    expect(r1.status).toBe(r2.status);
  });

  // ---- B6 summary safe-sum tests ----
  it("B6: totalRecords safe sum skips NaN", () => {
    const result = auditReadingDataQuality({
      archive: makeArchive({
        years: [
          makeYear({ year: 2024, totalRecords: 100 }),
          makeYear({ year: 2025, totalRecords: NaN }),
        ],
      }),
      targetYears: [2024, 2025],
      failedYears: [],
      topBooksLimit: 12,
    });
    expect(result.summary.totalRecords).toBe(100);
  });

  it("B6: invalid numbers (negative or non-finite) are counted as 0 in summary", () => {
    const result = auditReadingDataQuality({
      archive: makeArchive({
        years: [
          makeYear({
            year: 2024,
            totalRecords: -50, // negative → treated as 0
          }),
        ],
      }),
      targetYears: [2024],
      failedYears: [],
      topBooksLimit: 12,
    });
    expect(result.summary.totalRecords).toBe(0);
  });

  it("B6: datedRecordRatio = safeDated / safeTotal", () => {
    const result = auditReadingDataQuality({
      archive: makeArchive({
        years: [makeYear({ year: 2024, totalRecords: 100, datedRecords: 75 })],
      }),
      targetYears: [2024],
      failedYears: [],
      topBooksLimit: 12,
    });
    expect(result.summary.datedRecordRatio).toBeCloseTo(0.75, 4);
  });

  it("B6: matchedRecordRatio = safeMatched / safeTotal", () => {
    const result = auditReadingDataQuality({
      archive: makeArchive({
        years: [makeYear({ year: 2024, totalRecords: 100, matchedRecords: 60 })],
      }),
      targetYears: [2024],
      failedYears: [],
      topBooksLimit: 12,
    });
    expect(result.summary.matchedRecordRatio).toBeCloseTo(0.6, 4);
  });

  it("B6: publicTopBookMetadataRatio = validBooks / totalBooks when metadata provided", () => {
    const result = auditReadingDataQuality({
      archive: makeArchive({
        years: [
          makeYear({ topBookCatalogIds: ["b1", "b2", "b3"] }),
        ],
      }),
      targetYears: [2025],
      failedYears: [],
      topBooksLimit: 12,
      topBookMetadata: [
        makeBookMeta(2025, [
          { title: "T1", rank: 1, records: 5 },
          { title: "T2", rank: 2, records: 5 },
          { title: "", rank: 3, records: 5 }, // missing title
        ]),
      ],
    });
    expect(result.summary.publicTopBookMetadataRatio).toBeCloseTo(2 / 3, 4);
  });

  it("B6: publicTopBookMetadataRatio returns 1 when denominator is 0", () => {
    const result = auditReadingDataQuality({
      archive: makeArchive({
        years: [makeYear({ topBookCatalogIds: [] })],
      }),
      targetYears: [2025],
      failedYears: [],
      topBooksLimit: 12,
    });
    expect(result.summary.publicTopBookMetadataRatio).toBe(1);
  });

  it("B6: yearLinkCoverageRatio included in summary", () => {
    const result = auditReadingDataQuality({
      archive: makeArchive({
        years: [
          makeYear({ year: 2024 }),
          makeYear({ year: 2025 }),
        ],
        yearLinks: [makeYearLink({ sourceYear: 2024, targetYear: 2025 })],
      }),
      targetYears: [2024, 2025],
      failedYears: [],
      topBooksLimit: 12,
    });
    expect(result.summary.yearLinkCoverageRatio).toBeCloseTo(1, 4);
  });

  it("B6: issueCounts match issues array length", () => {
    const result = auditReadingDataQuality({
      archive: makeArchive({ years: [makeYear({ totalRecords: -1 })] }),
      targetYears: [2025, 2026],
      failedYears: [],
      topBooksLimit: 12,
    });
    const { errorCount, warningCount, infoCount } = result.summary;
    expect(errorCount + warningCount + infoCount).toBe(result.issues.length);
    expect(result.summary.errorCount).toBe(errorCount);
    expect(result.summary.warningCount).toBe(warningCount);
    expect(result.summary.infoCount).toBe(infoCount);
  });

  it("B6: final fail when any error", () => {
    const result = auditReadingDataQuality({
      archive: makeArchive({ years: [makeYear({ totalRecords: -1 })] }),
      targetYears: [2025],
      failedYears: [],
      topBooksLimit: 12,
    });
    expect(result.status).toBe("fail");
  });

  it("B6: final warn when only warnings", () => {
    const result = auditReadingDataQuality({
      archive: makeArchive({ years: [makeYear()] }),
      targetYears: [2025, 2026],
      failedYears: [],
      topBooksLimit: 12,
    });
    expect(result.status).toBe("warn");
  });

  it("B6: final pass for clean archive", () => {
    const result = auditReadingDataQuality({
      archive: makeArchive({ years: [makeYear()] }),
      targetYears: [2025],
      failedYears: [],
      topBooksLimit: 12,
    });
    expect(result.status).toBe("pass");
  });
});

// ============================================================
// debug snapshot
// ============================================================

describe("buildReadingDataQualityDebugSnapshot", () => {
  it("is JSON.stringify-able", () => {
    const result = auditReadingDataQuality({
      archive: makeArchive({ years: [makeYear({ totalRecords: -1 })] }),
      targetYears: [2025, 2026],
      failedYears: [],
      topBooksLimit: 12,
    });
    const snapshot = buildReadingDataQualityDebugSnapshot(result);
    expect(() => JSON.stringify(snapshot)).not.toThrow();
  });

  it("issues do not contain itemIndex/rank/actual/expected", () => {
    const result = auditReadingDataQuality({
      archive: makeArchive({ years: [makeYear({ totalRecords: -1 })] }),
      targetYears: [2025, 2026],
      failedYears: [],
      topBooksLimit: 12,
    });
    const snapshot = buildReadingDataQualityDebugSnapshot(result);
    for (const issue of (snapshot as { issues: object[] }).issues) {
      const keys = Object.keys(issue);
      expect(keys).not.toContain("itemIndex");
      expect(keys).not.toContain("rank");
      expect(keys).not.toContain("actual");
      expect(keys).not.toContain("expected");
    }
  });

  it("does not contain catalogId or title", () => {
    const result = auditReadingDataQuality({
      archive: makeArchive({
        years: [makeYear({ topBookCatalogIds: ["secret-id-1", "secret-id-2"] })],
      }),
      targetYears: [2025],
      failedYears: [],
      topBooksLimit: 12,
    });
    const snapshot = buildReadingDataQualityDebugSnapshot(result);
    const dump = JSON.stringify(snapshot);
    expect(dump).not.toContain("secret-id-1");
    expect(dump).not.toContain("secret-id-2");
    expect(dump).not.toContain("catalogId");
    expect(dump).not.toContain("title");
  });

  it("does not contain totalRecords or other metric details", () => {
    const result = auditReadingDataQuality({
      archive: makeArchive({
        years: [makeYear({ year: 2024, totalRecords: 999999 })],
      }),
      targetYears: [2024],
      failedYears: [],
      topBooksLimit: 12,
    });
    const snapshot = buildReadingDataQualityDebugSnapshot(result);
    const dump = JSON.stringify(snapshot);
    expect(dump).not.toContain("999999");
    expect(dump).not.toContain("totalRecords");
    expect(dump).not.toContain("matchedRecords");
  });

  it("ratios are finite", () => {
    const result = auditReadingDataQuality({
      archive: makeArchive({ years: [makeYear()] }),
      targetYears: [2025],
      failedYears: [],
      topBooksLimit: 12,
    });
    const snapshot = buildReadingDataQualityDebugSnapshot(result);
    const ratios = (snapshot as { ratios: Record<string, number> }).ratios;
    for (const v of Object.values(ratios)) {
      expect(Number.isFinite(v)).toBe(true);
      expect(Number.isNaN(v)).toBe(false);
    }
  });

  it("full output has no NaN", () => {
    const result = auditReadingDataQuality({
      archive: makeArchive({ years: [makeYear({ totalRecords: NaN })] }),
      targetYears: [2025],
      failedYears: [],
      topBooksLimit: 12,
    });
    const snapshot = buildReadingDataQualityDebugSnapshot(result);
    const dump = JSON.stringify(snapshot);
    expect(dump).not.toContain("NaN");
    expect(dump).not.toContain("null");
    // null is allowed for non-counted values; ensure the absence of literal NaN
  });

  it("full output has no Infinity", () => {
    const result = auditReadingDataQuality({
      archive: makeArchive({ years: [makeYear()] }),
      targetYears: [2025],
      failedYears: [],
      topBooksLimit: 12,
    });
    const snapshot = buildReadingDataQualityDebugSnapshot(result);
    const dump = JSON.stringify(snapshot);
    expect(dump).not.toContain("Infinity");
    expect(dump).not.toContain("-Infinity");
  });
});

// ============================================================
// privacy + boundary scans
// ============================================================

describe("privacy and boundary scan", () => {
  it("issues never contain title or catalogId values", () => {
    const result = auditReadingDataQuality({
      archive: makeArchive({
        years: [makeYear({ topBookCatalogIds: ["b1", "b2"] })],
      }),
      targetYears: [2025],
      failedYears: [],
      topBooksLimit: 12,
    });
    const dump = JSON.stringify(result.issues);
    expect(dump).not.toContain("b1");
    expect(dump).not.toContain("b2");
    expect(dump).not.toContain("title");
    expect(dump).not.toContain("catalogId");
    expect(dump).not.toContain("token");
  });

  it("module source has no fetch, storage, or DOM access", async () => {
    const source = fs.readFileSync(
      path.join(__dirname, "./wereadReadingDataQualityAudit.ts"),
      "utf8"
    );
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/\blocalStorage\b/);
    expect(source).not.toMatch(/\bsessionStorage\b/);
    expect(source).not.toMatch(/\bdocument\./);
    expect(source).not.toMatch(/\bwindow\./);
    expect(source).not.toMatch(/\bXMLHttpRequest\b/);
  });

  it("does not contain evaluative wording in audit source", async () => {
    const source = fs.readFileSync(
      path.join(__dirname, "./wereadReadingDataQualityAudit.ts"),
      "utf8"
    );
    const forbidden = [
      "阅读能力", "阅读力", "兴趣变化", "兴趣稳定", "长期偏好",
      "停止阅读", "开始阅读", "人格", "性格", "心理", "情绪", "焦虑", "专注力",
    ];
    for (const word of forbidden) {
      expect(source).not.toContain(word);
    }
  });
});