/**
 * S27N — Unit tests for the long-term reading comparison filters model.
 *
 * All tests use synthetic `WereadReadingArchive` objects; no network,
 * no real user data, no storage writes.
 */

import { describe, it, expect } from "vitest";
import type {
  WereadReadingArchive,
  ReadingArchiveYear,
  ReadingArchiveRecurringBook,
  ReadingArchiveYearLink,
} from "./wereadReadingArchiveModel";
import {
  createDefaultReadingComparisonFilters,
  normalizeReadingComparisonFilters,
  normalizeComparisonYearRange,
  classifyOverlapRatio,
  filterReadingComparisonYears,
  filterReadingComparisonRecurringBooks,
  filterReadingComparisonYearLinks,
  buildReadingComparisonResult,
  buildReadingComparisonDebugSnapshot,
  READING_COMPARISON_RECURRING_BOOKS_LIMIT,
  READING_COMPARISON_MIN_RECORDS_OPTIONS,
  READING_COMPARISON_MIN_ACTIVE_MONTHS_OPTIONS,
  READING_COMPARISON_RECURRING_MIN_YEARS_OPTIONS,
  READING_COMPARISON_OVERLAP_OPTIONS,
  READING_COMPARISON_REASON_LABELS,
  READING_COMPARISON_OVERLAP_LABELS,
  READING_COMPARISON_PANEL_NOTICE,
} from "./wereadReadingComparisonFilters";

// ---------- fixtures ----------

function makeYear(
  year: number,
  overrides: Partial<ReadingArchiveYear> = {},
): ReadingArchiveYear {
  return {
    year,
    totalRecords: 100,
    datedRecords: 80,
    matchedRecords: 70,
    matchedBooks: 5,
    activeMonths: 8,
    longestStreakMonths: 4,
    peakMonth: `${year}-06`,
    peakMonthRecords: 12,
    averageRecordsPerActiveMonth: 12.5,
    topBookCount: 3,
    topBookCatalogIds: [`c-${year}-a`, `c-${year}-b`, `c-${year}-c`],
    ...overrides,
  };
}

function makeRecurringBook(
  catalogId: string,
  years: number[],
  title = "",
  author: string | null = null,
): ReadingArchiveRecurringBook {
  return {
    catalogId,
    title,
    author,
    publisher: null,
    publishYear: null,
    years,
    yearsOnList: years.length,
    totalNoteCountWithinLists: 0,
    bestRank: 1,
    latestYear: years[years.length - 1],
    latestRank: 1,
  };
}

function makeLink(
  sourceYear: number,
  targetYear: number,
  overlapRatio: number,
  sharedTopBooks = 1,
): ReadingArchiveYearLink {
  return { sourceYear, targetYear, sharedTopBooks, overlapRatio };
}

function makeArchive(
  years: ReadingArchiveYear[],
  links: ReadingArchiveYearLink[] = [],
  recurringBooks: ReadingArchiveRecurringBook[] = [],
  topBooksLimit: 6 | 12 | 18 = 12,
): WereadReadingArchive {
  return {
    years,
    overview: {
      yearsWithData: years.length,
      firstYear: years[0]?.year ?? null,
      latestYear: years[years.length - 1]?.year ?? null,
      totalRecords: years.reduce((acc, y) => acc + y.totalRecords, 0),
      totalActiveMonths: years.reduce((acc, y) => acc + y.activeMonths, 0),
      averageRecordsPerYear:
        years.length > 0
          ? years.reduce((acc, y) => acc + y.totalRecords, 0) / years.length
          : 0,
      mostActiveYear: years[0]?.year ?? null,
      mostActiveYearRecords: years[0]?.totalRecords ?? 0,
      longestActiveYearStreak: years.length,
      recurringTopBooks: recurringBooks.length,
    },
    recurringBooks,
    yearLinks: links,
    meta: {
      requestedYears: years.length,
      loadedYears: years.length,
      topBooksLimit,
      maxYears: 20,
      persisted: false,
      source: "annual-review-cache",
    },
  };
}

// ---------- tests ----------

describe("createDefaultReadingComparisonFilters", () => {
  it("returns documented defaults", () => {
    const f = createDefaultReadingComparisonFilters();
    expect(f).toEqual({
      startYear: null,
      endYear: null,
      minRecords: 0,
      minActiveMonths: 0,
      recurringMinYears: 2,
      overlap: "all",
    });
  });
});

describe("normalizeReadingComparisonFilters", () => {
  it("clamps invalid minRecords to default", () => {
    const f = normalizeReadingComparisonFilters({ minRecords: 999 as never });
    expect(f.minRecords).toBe(0);
  });
  it("accepts valid minRecords", () => {
    expect(normalizeReadingComparisonFilters({ minRecords: 25 }).minRecords).toBe(25);
  });
  it("clamps invalid minActiveMonths to default", () => {
    const f = normalizeReadingComparisonFilters({ minActiveMonths: 999 as never });
    expect(f.minActiveMonths).toBe(0);
  });
  it("accepts valid minActiveMonths", () => {
    expect(normalizeReadingComparisonFilters({ minActiveMonths: 6 }).minActiveMonths).toBe(6);
  });
  it("clamps invalid recurringMinYears", () => {
    const f = normalizeReadingComparisonFilters({ recurringMinYears: 99 as never });
    expect(f.recurringMinYears).toBe(2);
  });
  it("accepts valid recurringMinYears", () => {
    expect(normalizeReadingComparisonFilters({ recurringMinYears: 3 }).recurringMinYears).toBe(3);
    expect(normalizeReadingComparisonFilters({ recurringMinYears: 4 }).recurringMinYears).toBe(4);
  });
  it("clamps invalid overlap", () => {
    const f = normalizeReadingComparisonFilters({ overlap: "garbage" as never });
    expect(f.overlap).toBe("all");
  });
  it("replaces NaN startYear with null", () => {
    const f = normalizeReadingComparisonFilters({ startYear: NaN });
    expect(f.startYear).toBe(null);
  });
  it("rounds valid startYear", () => {
    const f = normalizeReadingComparisonFilters({ startYear: 2020.7 });
    expect(f.startYear).toBe(2021);
  });
});

describe("normalizeComparisonYearRange", () => {
  it("returns nulls when no available years", () => {
    const r = normalizeComparisonYearRange({ startYear: 2020, endYear: 2025, availableYears: [] });
    expect(r).toEqual({ startYear: null, endYear: null });
  });
  it("swaps when startYear > endYear", () => {
    const r = normalizeComparisonYearRange({ startYear: 2025, endYear: 2020, availableYears: [2020, 2021, 2022, 2023, 2024, 2025] });
    expect(r).toEqual({ startYear: 2020, endYear: 2025 });
  });
  it("snaps out-of-range years to nearest available", () => {
    const r = normalizeComparisonYearRange({ startYear: 2019, endYear: 2026, availableYears: [2020, 2022, 2024] });
    expect(r.startYear).toBe(2020);
    expect(r.endYear).toBe(2024);
  });
  it("preserves valid years", () => {
    const r = normalizeComparisonYearRange({ startYear: 2021, endYear: 2023, availableYears: [2020, 2021, 2022, 2023, 2024] });
    expect(r).toEqual({ startYear: 2021, endYear: 2023 });
  });
  it("preserves null bounds", () => {
    const r = normalizeComparisonYearRange({ startYear: null, endYear: null, availableYears: [2020, 2021] });
    expect(r).toEqual({ startYear: null, endYear: null });
  });
});

describe("classifyOverlapRatio", () => {
  it("classifies low", () => {
    expect(classifyOverlapRatio(0.1)).toBe("low");
    expect(classifyOverlapRatio(0.249)).toBe("low");
    expect(classifyOverlapRatio(0)).toBe("low");
  });
  it("classifies medium", () => {
    expect(classifyOverlapRatio(0.25)).toBe("medium");
    expect(classifyOverlapRatio(0.4)).toBe("medium");
    expect(classifyOverlapRatio(0.499)).toBe("medium");
  });
  it("classifies high", () => {
    expect(classifyOverlapRatio(0.5)).toBe("high");
    expect(classifyOverlapRatio(0.7)).toBe("high");
    expect(classifyOverlapRatio(1)).toBe("high");
  });
  it("normalizes negative to 0 → low", () => {
    expect(classifyOverlapRatio(-0.3)).toBe("low");
  });
  it("normalizes >1 to 1 → high", () => {
    expect(classifyOverlapRatio(1.5)).toBe("high");
  });
  it("normalizes NaN to 0 → low", () => {
    expect(classifyOverlapRatio(NaN)).toBe("low");
  });
  it("normalizes Infinity to 1 → high", () => {
    expect(classifyOverlapRatio(Infinity)).toBe("high");
  });
});

describe("filterReadingComparisonYears (year filter result)", () => {
  it("default includes all loaded years", () => {
    const archive = makeArchive([
      makeYear(2020, { totalRecords: 100, activeMonths: 8 }),
      makeYear(2021, { totalRecords: 200, activeMonths: 10 }),
      makeYear(2022, { totalRecords: 50, activeMonths: 6 }),
    ]);
    const r = buildReadingComparisonResult(archive, createDefaultReadingComparisonFilters());
    expect(r.includedYears.map((y) => y.year)).toEqual([2020, 2021, 2022]);
    expect(r.excludedYears).toEqual([]);
  });

  it("empty archive → empty result", () => {
    const archive = makeArchive([]);
    const r = buildReadingComparisonResult(archive, createDefaultReadingComparisonFilters());
    expect(r.includedYears).toEqual([]);
    expect(r.excludedYears).toEqual([]);
    expect(r.summary.totalRecords).toBe(0);
    expect(r.summary.earliestYear).toBe(null);
    expect(r.summary.latestYear).toBe(null);
  });

  it("single-year archive", () => {
    const archive = makeArchive([makeYear(2025, { totalRecords: 50, activeMonths: 6 })]);
    const r = buildReadingComparisonResult(archive, createDefaultReadingComparisonFilters());
    expect(r.includedYears.map((y) => y.year)).toEqual([2025]);
  });

  it("filters by startYear/endYear range", () => {
    const archive = makeArchive([
      makeYear(2020, { totalRecords: 100 }),
      makeYear(2021, { totalRecords: 200 }),
      makeYear(2022, { totalRecords: 300 }),
      makeYear(2023, { totalRecords: 400 }),
    ]);
    const r = buildReadingComparisonResult(archive, {
      ...createDefaultReadingComparisonFilters(),
      startYear: 2021,
      endYear: 2022,
    });
    expect(r.includedYears.map((y) => y.year)).toEqual([2021, 2022]);
    expect(r.excludedYears.map((e) => e.year)).toEqual([2020, 2023]);
  });

  it("swaps reversed startYear and endYear", () => {
    const archive = makeArchive([
      makeYear(2020),
      makeYear(2021),
      makeYear(2022),
    ]);
    const r = buildReadingComparisonResult(archive, {
      ...createDefaultReadingComparisonFilters(),
      startYear: 2022,
      endYear: 2020,
    });
    expect(r.includedYears.map((y) => y.year)).toEqual([2020, 2021, 2022]);
  });

  it("snaps illegal years to nearest available", () => {
    const archive = makeArchive([
      makeYear(2020),
      makeYear(2021),
      makeYear(2022),
    ]);
    const r = buildReadingComparisonResult(archive, {
      ...createDefaultReadingComparisonFilters(),
      startYear: 1999,
      endYear: 9999,
    });
    expect(r.includedYears.map((y) => y.year)).toEqual([2020, 2021, 2022]);
  });

  it("filters by minRecords", () => {
    const archive = makeArchive([
      makeYear(2020, { totalRecords: 5 }),
      makeYear(2021, { totalRecords: 50 }),
      makeYear(2022, { totalRecords: 200 }),
    ]);
    const r = buildReadingComparisonResult(archive, {
      ...createDefaultReadingComparisonFilters(),
      minRecords: 10,
    });
    expect(r.includedYears.map((y) => y.year)).toEqual([2021, 2022]);
    expect(r.excludedYears.find((e) => e.year === 2020)?.reasons).toContain("records_below_min");
  });

  it("filters by minActiveMonths", () => {
    const archive = makeArchive([
      makeYear(2020, { activeMonths: 1 }),
      makeYear(2021, { activeMonths: 4 }),
      makeYear(2022, { activeMonths: 10 }),
    ]);
    const r = buildReadingComparisonResult(archive, {
      ...createDefaultReadingComparisonFilters(),
      minActiveMonths: 3,
    });
    expect(r.includedYears.map((y) => y.year)).toEqual([2021, 2022]);
  });

  it("supports multiple exclusion reasons for same year", () => {
    const archive = makeArchive([
      makeYear(2020, { totalRecords: 1, activeMonths: 1 }),
      makeYear(2021),
    ]);
    const r = buildReadingComparisonResult(archive, {
      ...createDefaultReadingComparisonFilters(),
      startYear: 2021,
      endYear: 2023,
      minRecords: 10,
      minActiveMonths: 3,
    });
    expect(r.excludedYears.find((e) => e.year === 2020)?.reasons).toEqual(
      expect.arrayContaining(["before_start", "records_below_min", "active_months_below_min"]),
    );
  });

  it("includedYears sorted ascending", () => {
    const archive = makeArchive([
      makeYear(2025),
      makeYear(2020),
      makeYear(2022),
    ]);
    const r = buildReadingComparisonResult(archive, createDefaultReadingComparisonFilters());
    expect(r.includedYears.map((y) => y.year)).toEqual([2020, 2022, 2025]);
  });

  it("excludedYears sorted ascending", () => {
    const archive = makeArchive([
      makeYear(2020, { totalRecords: 1 }),
      makeYear(2025, { totalRecords: 1 }),
      makeYear(2022),
    ]);
    const r = buildReadingComparisonResult(archive, {
      ...createDefaultReadingComparisonFilters(),
      minRecords: 10,
    });
    expect(r.excludedYears.map((e) => e.year)).toEqual([2020, 2025]);
  });
});

describe("filterReadingComparisonRecurringBooks (recurring result)", () => {
  it("recurringMinYears=2 keeps books in 2+ included years", () => {
    const archive = makeArchive(
      [
        makeYear(2020, { topBookCatalogIds: ["a", "b", "c"] }),
        makeYear(2021, { topBookCatalogIds: ["a", "d", "e"] }),
        makeYear(2022, { topBookCatalogIds: ["f", "g", "h"] }),
      ],
      [],
      [makeRecurringBook("a", [2020, 2021], "Book A")],
    );
    const r = buildReadingComparisonResult(archive, {
      ...createDefaultReadingComparisonFilters(),
      recurringMinYears: 2,
    });
    expect(r.recurringBooks.map((b) => b.catalogId)).toEqual(["a"]);
  });

  it("recurringMinYears=3 filters out 2-year books", () => {
    const archive = makeArchive(
      [
        makeYear(2020, { topBookCatalogIds: ["a", "b"] }),
        makeYear(2021, { topBookCatalogIds: ["a", "c"] }),
        makeYear(2022, { topBookCatalogIds: ["a", "d"] }),
      ],
    );
    const r3 = buildReadingComparisonResult(archive, {
      ...createDefaultReadingComparisonFilters(),
      recurringMinYears: 3,
    });
    const r2 = buildReadingComparisonResult(archive, {
      ...createDefaultReadingComparisonFilters(),
      recurringMinYears: 2,
    });
    expect(r3.recurringBooks.map((b) => b.catalogId)).toEqual(["a"]);
    expect(r2.recurringBooks.map((b) => b.catalogId)).toEqual(["a"]);
  });

  it("recurringMinYears=4 filters out 3-year books", () => {
    const archive = makeArchive(
      [
        makeYear(2020, { topBookCatalogIds: ["a", "b"] }),
        makeYear(2021, { topBookCatalogIds: ["a", "c"] }),
        makeYear(2022, { topBookCatalogIds: ["a", "d"] }),
        makeYear(2023, { topBookCatalogIds: ["a", "e"] }),
      ],
    );
    const r4 = buildReadingComparisonResult(archive, {
      ...createDefaultReadingComparisonFilters(),
      recurringMinYears: 4,
    });
    const r3 = buildReadingComparisonResult(archive, {
      ...createDefaultReadingComparisonFilters(),
      recurringMinYears: 3,
    });
    expect(r4.recurringBooks.map((b) => b.catalogId)).toEqual(["a"]);
    expect(r3.recurringBooks.map((b) => b.catalogId)).toEqual(["a"]);
  });

  it("appears only counted for included years", () => {
    // Year 2020 is excluded by startYear; only 2021+ counts.
    const archive = makeArchive(
      [
        makeYear(2020, { topBookCatalogIds: ["a", "b"] }),
        makeYear(2021, { topBookCatalogIds: ["a", "c"] }),
        makeYear(2022, { topBookCatalogIds: ["a", "d"] }),
      ],
    );
    const r = buildReadingComparisonResult(archive, {
      ...createDefaultReadingComparisonFilters(),
      startYear: 2021,
      endYear: 2022,
      recurringMinYears: 2,
    });
    // "a" should still appear in 2 included years (2021+2022).
    expect(r.recurringBooks.map((b) => b.catalogId)).toContain("a");
    expect(r.recurringBooks.find((b) => b.catalogId === "a")?.years).toEqual([2021, 2022]);
  });

  it("recomputes bestRank, latestYear, latestRank", () => {
    const archive = makeArchive(
      [
        makeYear(2020, { topBookCatalogIds: ["a", "x"] }),
        makeYear(2021, { topBookCatalogIds: ["y", "a"] }),
        makeYear(2022, { topBookCatalogIds: ["z", "w", "a"] }),
      ],
    );
    const r = buildReadingComparisonResult(archive, createDefaultReadingComparisonFilters());
    const a = r.recurringBooks.find((b) => b.catalogId === "a");
    expect(a).toBeDefined();
    // Ranks: 2020→1, 2021→2, 2022→3 → bestRank=1
    expect(a!.bestRank).toBe(1);
    expect(a!.latestYear).toBe(2022);
    expect(a!.latestRank).toBe(3);
  });

  it("sorts by appearanceCount desc, bestRank asc, latestYear desc, title", () => {
    const archive = makeArchive(
      [
        makeYear(2020, { topBookCatalogIds: ["a", "b"] }),
        makeYear(2021, { topBookCatalogIds: ["a", "b"] }),
        makeYear(2022, { topBookCatalogIds: ["a"] }),
      ],
    );
    const r = buildReadingComparisonResult(archive, createDefaultReadingComparisonFilters());
    // Both a and b appear in 2 years. a's best rank is 1, b's is 2.
    expect(r.recurringBooks.map((b) => b.catalogId)).toEqual(["a", "b"]);
  });

  it("caps recurring books at 12", () => {
    const years = Array.from({ length: 3 }, (_, i) => makeYear(2020 + i, {
      topBookCatalogIds: Array.from({ length: 15 }, (_, j) => `b${j}`),
    }));
    const archive = makeArchive(years);
    const r = buildReadingComparisonResult(archive, createDefaultReadingComparisonFilters());
    expect(r.recurringBooks.length).toBeLessThanOrEqual(READING_COMPARISON_RECURRING_BOOKS_LIMIT);
  });
});

describe("filterReadingComparisonYearLinks (overlap result)", () => {
  it("overlap=all keeps all included pairs", () => {
    const archive = makeArchive(
      [makeYear(2020), makeYear(2021), makeYear(2022)],
      [makeLink(2020, 2021, 0.1), makeLink(2021, 2022, 0.7)],
    );
    const r = buildReadingComparisonResult(archive, {
      ...createDefaultReadingComparisonFilters(),
      overlap: "all",
    });
    expect(r.yearLinks.length).toBe(2);
  });

  it("overlap=low keeps only low-classified links", () => {
    const archive = makeArchive(
      [makeYear(2020), makeYear(2021), makeYear(2022)],
      [makeLink(2020, 2021, 0.1), makeLink(2021, 2022, 0.7)],
    );
    const r = buildReadingComparisonResult(archive, {
      ...createDefaultReadingComparisonFilters(),
      overlap: "low",
    });
    expect(r.yearLinks.length).toBe(1);
    expect(r.yearLinks[0].sourceYear).toBe(2020);
    expect(r.yearLinks[0].targetYear).toBe(2021);
  });

  it("overlap=medium keeps only medium-classified links", () => {
    const archive = makeArchive(
      [makeYear(2020), makeYear(2021), makeYear(2022)],
      [
        makeLink(2020, 2021, 0.1),
        makeLink(2021, 2022, 0.3),
        makeLink(2020, 2022, 0.7),
      ],
    );
    const r = buildReadingComparisonResult(archive, {
      ...createDefaultReadingComparisonFilters(),
      overlap: "medium",
    });
    expect(r.yearLinks.map((l) => `${l.sourceYear}->${l.targetYear}`)).toEqual([
      "2021->2022",
    ]);
  });

  it("overlap=high keeps only high-classified links", () => {
    const archive = makeArchive(
      [makeYear(2020), makeYear(2021), makeYear(2022)],
      [
        makeLink(2020, 2021, 0.1),
        makeLink(2021, 2022, 0.3),
        makeLink(2020, 2022, 0.7),
      ],
    );
    const r = buildReadingComparisonResult(archive, {
      ...createDefaultReadingComparisonFilters(),
      overlap: "high",
    });
    expect(r.yearLinks.map((l) => `${l.sourceYear}->${l.targetYear}`)).toEqual([
      "2020->2022",
    ]);
  });

  it("yearLink requires both endpoints to be included", () => {
    const archive = makeArchive(
      [makeYear(2020), makeYear(2021), makeYear(2022)],
      [
        makeLink(2020, 2021, 0.1),
        makeLink(2021, 2022, 0.5),
      ],
    );
    const r = buildReadingComparisonResult(archive, {
      ...createDefaultReadingComparisonFilters(),
      startYear: 2021,
      endYear: 2022,
      overlap: "all",
    });
    expect(r.yearLinks.map((l) => `${l.sourceYear}->${l.targetYear}`)).toEqual([
      "2021->2022",
    ]);
  });

  it("clamps negative ratio to 0", () => {
    const archive = makeArchive(
      [makeYear(2020), makeYear(2021)],
      [makeLink(2020, 2021, -0.5)],
    );
    const r = buildReadingComparisonResult(archive, createDefaultReadingComparisonFilters());
    expect(r.yearLinks[0].overlapRatio).toBe(0);
  });

  it("clamps ratio >1 to 1", () => {
    const archive = makeArchive(
      [makeYear(2020), makeYear(2021)],
      [makeLink(2020, 2021, 1.5)],
    );
    const r = buildReadingComparisonResult(archive, createDefaultReadingComparisonFilters());
    expect(r.yearLinks[0].overlapRatio).toBe(1);
  });

  it("NaN ratio becomes 0", () => {
    const archive = makeArchive(
      [makeYear(2020), makeYear(2021)],
      [makeLink(2020, 2021, NaN)],
    );
    const r = buildReadingComparisonResult(archive, createDefaultReadingComparisonFilters());
    expect(r.yearLinks[0].overlapRatio).toBe(0);
  });
});

describe("summary computation", () => {
  it("sums totals and computes average", () => {
    const archive = makeArchive([
      makeYear(2020, { totalRecords: 100, activeMonths: 6 }),
      makeYear(2021, { totalRecords: 200, activeMonths: 12 }),
    ]);
    const r = buildReadingComparisonResult(archive, createDefaultReadingComparisonFilters());
    expect(r.summary.totalRecords).toBe(300);
    expect(r.summary.totalActiveMonths).toBe(18);
    expect(r.summary.averageRecordsPerYear).toBe(150);
    expect(r.summary.earliestYear).toBe(2020);
    expect(r.summary.latestYear).toBe(2021);
  });

  it("empty includedYears → zero summary", () => {
    const archive = makeArchive([makeYear(2020, { totalRecords: 5 })]);
    const r = buildReadingComparisonResult(archive, {
      ...createDefaultReadingComparisonFilters(),
      minRecords: 100,
    });
    expect(r.summary.totalRecords).toBe(0);
    expect(r.summary.totalActiveMonths).toBe(0);
    expect(r.summary.averageRecordsPerYear).toBe(0);
    expect(r.summary.earliestYear).toBe(null);
    expect(r.summary.latestYear).toBe(null);
  });

  it("excludedYearCount reflects excluded list size", () => {
    const archive = makeArchive([
      makeYear(2020),
      makeYear(2021, { totalRecords: 1 }),
    ]);
    const r = buildReadingComparisonResult(archive, {
      ...createDefaultReadingComparisonFilters(),
      minRecords: 10,
    });
    expect(r.summary.excludedYearCount).toBe(1);
    expect(r.excludedYears.length).toBe(1);
  });
});

describe("meta + persistence", () => {
  it("persisted is always false", () => {
    const archive = makeArchive([makeYear(2020)]);
    const r = buildReadingComparisonResult(archive, createDefaultReadingComparisonFilters());
    expect(r.meta.persisted).toBe(false);
  });

  it("source is always current_loaded_archive", () => {
    const archive = makeArchive([makeYear(2020)]);
    const r = buildReadingComparisonResult(archive, createDefaultReadingComparisonFilters());
    expect(r.meta.source).toBe("current_loaded_archive");
  });
});

describe("privacy guarantees", () => {
  it("result does not contain note/comment fields", () => {
    const archive = makeArchive([makeYear(2020)]);
    const r = buildReadingComparisonResult(archive, createDefaultReadingComparisonFilters());
    const json = JSON.stringify(r);
    expect(json.toLowerCase()).not.toContain("note.text");
    expect(json.toLowerCase()).not.toContain("note.comment");
    expect(json.toLowerCase()).not.toContain("markedtext");
    expect(json.toLowerCase()).not.toContain("wereadbookid");
    expect(json.toLowerCase()).not.toContain("noteid");
    expect(json.toLowerCase()).not.toContain("highlightid");
    expect(json.toLowerCase()).not.toContain("chaptertitle");
  });

  it("result does not contain private IDs / token / API key", () => {
    const archive = makeArchive([makeYear(2020)]);
    const r = buildReadingComparisonResult(archive, createDefaultReadingComparisonFilters());
    const json = JSON.stringify(r);
    expect(json.toLowerCase()).not.toContain("authorization");
    expect(json.toLowerCase()).not.toContain("api key");
    expect(json).not.toContain("wr_skey");
    expect(json).not.toContain("wr_vid");
    expect(json.toLowerCase()).not.toContain("token=");
  });

  it("result does not contain AI / themes", () => {
    const archive = makeArchive([makeYear(2020)]);
    const r = buildReadingComparisonResult(archive, createDefaultReadingComparisonFilters());
    const json = JSON.stringify(r);
    expect(json.toLowerCase()).not.toContain("ai summary");
    expect(json.toLowerCase()).not.toContain("themes");
  });

  it("result contains no NaN/Infinity in any number field", () => {
    const archive = makeArchive([
      makeYear(2020, { totalRecords: 100, averageRecordsPerActiveMonth: 12.5 }),
      makeYear(2021, { totalRecords: 200, averageRecordsPerActiveMonth: 16.7 }),
    ]);
    const r = buildReadingComparisonResult(archive, createDefaultReadingComparisonFilters());
    const json = JSON.stringify(r);
    expect(json).not.toContain("NaN");
    expect(json).not.toContain("Infinity");
  });

  it("does not include raw archive JSON", () => {
    const archive = makeArchive([makeYear(2020)]);
    const r = buildReadingComparisonResult(archive, createDefaultReadingComparisonFilters());
    // The model exposes only counts, no archive-specific internal fields.
    const json = JSON.stringify(r);
    expect(json).not.toContain("annual-review-cache");
    expect(json).not.toContain("maxYears");
    expect(json).not.toContain("mostActiveYear");
    expect(json).not.toContain("longestActiveYearStreak");
    expect(json).not.toContain("requestedYears");
  });
});

describe("determinism", () => {
  it("produces the same result for the same archive and filters", () => {
    const archive = makeArchive([
      makeYear(2020, { totalRecords: 100, topBookCatalogIds: ["a", "b", "c"] }),
      makeYear(2021, { totalRecords: 200, topBookCatalogIds: ["a", "b", "d"] }),
      makeYear(2022, { totalRecords: 150, topBookCatalogIds: ["e", "f"] }),
    ], [
      makeLink(2020, 2021, 0.3),
      makeLink(2021, 2022, 0.1),
    ]);
    const f: import("./wereadReadingComparisonFilters").ReadingComparisonFilters = {
      startYear: 2020,
      endYear: 2022,
      minRecords: 100,
      minActiveMonths: 3,
      recurringMinYears: 2,
      overlap: "medium",
    };
    const r1 = buildReadingComparisonResult(archive, f);
    const r2 = buildReadingComparisonResult(archive, f);
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });
});

describe("constants and labels", () => {
  it("exports the option arrays", () => {
    expect(READING_COMPARISON_MIN_RECORDS_OPTIONS).toEqual([0, 10, 25, 50, 100]);
    expect(READING_COMPARISON_MIN_ACTIVE_MONTHS_OPTIONS).toEqual([0, 3, 6, 9, 12]);
    expect(READING_COMPARISON_RECURRING_MIN_YEARS_OPTIONS).toEqual([2, 3, 4]);
    expect(READING_COMPARISON_OVERLAP_OPTIONS).toEqual(["all", "low", "medium", "high"]);
  });

  it("exports reason labels", () => {
    expect(READING_COMPARISON_REASON_LABELS.before_start).toBe("早于起始年份");
    expect(READING_COMPARISON_REASON_LABELS.after_end).toBe("晚于结束年份");
    expect(READING_COMPARISON_REASON_LABELS.records_below_min).toBe("低于最低阅读记录");
    expect(READING_COMPARISON_REASON_LABELS.active_months_below_min).toBe("低于最低活跃月份");
  });

  it("exports overlap labels", () => {
    expect(READING_COMPARISON_OVERLAP_LABELS.all).toBe("全部");
    expect(READING_COMPARISON_OVERLAP_LABELS.low).toBe("较低（< 0.25）");
    expect(READING_COMPARISON_OVERLAP_LABELS.medium).toBe("中等（0.25 — 0.5）");
    expect(READING_COMPARISON_OVERLAP_LABELS.high).toBe("较高（≥ 0.5）");
  });

  it("exports panel notice", () => {
    expect(READING_COMPARISON_PANEL_NOTICE).toContain("不会重新请求年度数据");
    expect(READING_COMPARISON_PANEL_NOTICE).toContain("不代表阅读兴趣、内在状态或阅读质量");
  });
});

describe("debug snapshot", () => {
  it("returns counts and filter keys", () => {
    const archive = makeArchive([
      makeYear(2020),
      makeYear(2021, { topBookCatalogIds: ["a"] }),
      makeYear(2022, { topBookCatalogIds: ["a"] }),
    ]);
    const r = buildReadingComparisonResult(archive, createDefaultReadingComparisonFilters());
    const snap = buildReadingComparisonDebugSnapshot(r);
    expect(snap.availableYearCount).toBe(3);
    expect(snap.includedYearCount).toBe(3);
    expect(snap.excludedYearCount).toBe(0);
    expect(snap.recurringBookCount).toBe(1);
    expect(snap.yearLinkCount).toBe(0);
    expect(snap.filterKeys).toEqual([
      "startYear",
      "endYear",
      "minRecords",
      "minActiveMonths",
      "recurringMinYears",
      "overlap",
    ]);
  });
});