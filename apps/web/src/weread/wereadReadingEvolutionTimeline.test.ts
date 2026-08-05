/**
 * S27P-1 — Unit tests for the reading evolution timeline model.
 *
 * All tests use synthetic `WereadReadingArchive` objects. No network,
 * no real user data, no storage writes, no DOM, no React.
 */

import { describe, it, expect } from "vitest";
import type {
  WereadReadingArchive,
  ReadingArchiveYear,
  ReadingArchiveRecurringBook,
} from "./wereadReadingArchiveModel";
import {
  buildReadingEvolutionYearNodes,
  calculateReadingEvolutionDelta,
  compareReadingEvolutionTopBooks,
  calculateReadingEvolutionTopListOverlap,
  evaluateTransitionReasons,
  calculateSignificanceScore,
  buildReadingEvolutionMilestones,
  buildWereadReadingEvolutionTimeline,
  buildReadingEvolutionDebugSnapshot,
  READING_EVOLUTION_TOP_BOOKS_LIMIT,
  READING_EVOLUTION_PRIVACY_NOTICE,
  READING_EVOLUTION_FORBIDDEN_TOKENS,
  READING_EVOLUTION_FORBIDDEN_PSYCHOLOGICAL_WORDS,
  READING_EVOLUTION_SIGNIFICANCE_THRESHOLD,
} from "./wereadReadingEvolutionTimeline";

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

function makeArchive(args: {
  years?: ReadingArchiveYear[];
  recurring?: ReadingArchiveRecurringBook[];
  topBooksLimit?: 6 | 12 | 18;
} = {}): WereadReadingArchive {
  const years = args.years ?? [makeYear(2024)];
  const recurring = args.recurring ?? [];
  return {
    years,
    overview: {
      yearsWithData: years.length,
      firstYear: years[0]?.year ?? null,
      latestYear: years[years.length - 1]?.year ?? null,
      totalRecords: years.reduce((acc, y) => acc + y.totalRecords, 0),
      totalActiveMonths: years.reduce((acc, y) => acc + y.activeMonths, 0),
      averageRecordsPerYear: years.length > 0
        ? years.reduce((acc, y) => acc + y.totalRecords, 0) / years.length
        : 0,
      mostActiveYear: null,
      mostActiveYearRecords: 0,
      longestActiveYearStreak: 1,
      recurringTopBooks: recurring.length,
    },
    recurringBooks: recurring,
    yearLinks: [],
    meta: {
      requestedYears: years.length,
      loadedYears: years.length,
      topBooksLimit: args.topBooksLimit ?? 12,
      maxYears: 20,
      persisted: false,
      source: "annual-review-cache",
    },
  };
}

// ---------- tests ----------

describe("S27P-1 reading evolution timeline model", () => {
  it("1. empty archive → empty timeline", () => {
    const result = buildWereadReadingEvolutionTimeline({ archive: null });
    expect(result.years).toEqual([]);
    expect(result.transitions).toEqual([]);
    expect(result.milestones).toEqual([]);
    expect(result.summary.firstYear).toBeNull();
    expect(result.summary.latestYear).toBeNull();
    expect(result.summary.loadedYearCount).toBe(0);
    expect(result.summary.transitionCount).toBe(0);
    expect(result.summary.significantTransitionCount).toBe(0);
    expect(result.summary.yearGapCount).toBe(0);
    expect(result.meta.persisted).toBe(false);
  });

  it("2. single-year archive → 1 year, 0 transitions, 1 milestone", () => {
    const archive = makeArchive({ years: [makeYear(2024)] });
    const result = buildWereadReadingEvolutionTimeline({ archive });
    expect(result.years).toHaveLength(1);
    expect(result.transitions).toHaveLength(0);
    expect(result.milestones).toHaveLength(1);
    expect(result.milestones[0].kind).toBe("first_year");
    expect(result.milestones[0].year).toBe(2024);
    expect(result.summary.firstYear).toBe(2024);
    expect(result.summary.latestYear).toBe(2024);
  });

  it("3. multi-year archive years sorted ascending", () => {
    const archive = makeArchive({
      years: [
        makeYear(2025),
        makeYear(2020),
        makeYear(2022),
        makeYear(2021),
      ],
    });
    const result = buildWereadReadingEvolutionTimeline({ archive });
    expect(result.years.map((y) => y.year)).toEqual([2020, 2021, 2022, 2025]);
  });

  it("4. duplicate years collapse (last wins)", () => {
    const archive = makeArchive({
      years: [
        makeYear(2020, { totalRecords: 100 }),
        makeYear(2020, { totalRecords: 200 }),
        makeYear(2021, { totalRecords: 300 }),
      ],
    });
    const nodes = buildReadingEvolutionYearNodes({ archive });
    expect(nodes).toHaveLength(2);
    const yr2020 = nodes.find((n) => n.year === 2020)!;
    expect(yr2020.totalRecords).toBe(200);
  });

  it("5. NaN numeric fields → 0", () => {
    const archive = makeArchive({
      years: [
        makeYear(2024, {
          totalRecords: NaN,
          matchedRecords: NaN,
          matchedBooks: NaN,
          activeMonths: NaN,
        }),
      ],
    });
    const nodes = buildReadingEvolutionYearNodes({ archive });
    expect(nodes[0].totalRecords).toBe(0);
    expect(nodes[0].matchedRecords).toBe(0);
    expect(nodes[0].matchedBooks).toBe(0);
    expect(nodes[0].activeMonths).toBe(0);
  });

  it("6. Infinity numeric fields → 0", () => {
    const archive = makeArchive({
      years: [
        makeYear(2024, {
          totalRecords: Infinity,
          matchedRecords: Infinity,
        }),
      ],
    });
    const nodes = buildReadingEvolutionYearNodes({ archive });
    expect(nodes[0].totalRecords).toBe(0);
    expect(nodes[0].matchedRecords).toBe(0);
  });

  it("7. negative numeric fields → 0", () => {
    const archive = makeArchive({
      years: [
        makeYear(2024, {
          totalRecords: -50,
          matchedRecords: -10,
          matchedBooks: -2,
          activeMonths: -3,
        }),
      ],
    });
    const nodes = buildReadingEvolutionYearNodes({ archive });
    expect(nodes[0].totalRecords).toBe(0);
    expect(nodes[0].matchedRecords).toBe(0);
    expect(nodes[0].matchedBooks).toBe(0);
    expect(nodes[0].activeMonths).toBe(0);
  });

  it("8. topBooks ordered by rank ascending", () => {
    const archive = makeArchive({
      years: [
        makeYear(2024, {
          topBookCatalogIds: ["c-a", "c-b", "c-c"],
        }),
      ],
    });
    const nodes = buildReadingEvolutionYearNodes({ archive });
    expect(nodes[0].topBooks.map((b) => b.rank)).toEqual([1, 2, 3]);
  });

  it("9. topBooks catalogId de-duplicated", () => {
    const archive = makeArchive({
      years: [
        makeYear(2024, {
          topBookCatalogIds: ["c-a", "c-a", "c-b", "c-b"],
        }),
      ],
    });
    const nodes = buildReadingEvolutionYearNodes({ archive });
    expect(nodes[0].topBooks).toHaveLength(2);
    expect(nodes[0].topBooks.map((b) => b.catalogId)).toEqual(["c-a", "c-b"]);
  });

  it("10. topBooks only carry public fields", () => {
    const archive = makeArchive({
      years: [
        makeYear(2024, {
          topBookCatalogIds: ["c-a"],
        }),
      ],
    });
    const nodes = buildReadingEvolutionYearNodes({ archive });
    const book = nodes[0].topBooks[0];
    const obj = JSON.parse(JSON.stringify(book));
    const keys = Object.keys(obj).sort();
    expect(keys).toEqual(
      ["author", "catalogId", "publisher", "publishYear", "rank", "title"].sort(),
    );
  });

  it("11. delta increase", () => {
    const d = calculateReadingEvolutionDelta(100, 150);
    expect(d.direction).toBe("increase");
    expect(d.absolute).toBe(50);
    expect(d.percentage).toBe(50);
  });

  it("12. delta decrease", () => {
    const d = calculateReadingEvolutionDelta(100, 80);
    expect(d.direction).toBe("decrease");
    expect(d.absolute).toBe(-20);
    expect(d.percentage).toBe(-20);
  });

  it("13. delta same", () => {
    const d = calculateReadingEvolutionDelta(100, 100);
    expect(d.direction).toBe("same");
    expect(d.absolute).toBe(0);
    expect(d.percentage).toBe(0);
  });

  it("14. delta from_zero", () => {
    const d = calculateReadingEvolutionDelta(0, 100);
    expect(d.direction).toBe("from_zero");
    expect(d.percentage).toBeNull();
    expect(d.absolute).toBe(100);
  });

  it("15. delta to_zero", () => {
    const d = calculateReadingEvolutionDelta(100, 0);
    expect(d.direction).toBe("to_zero");
    expect(d.absolute).toBe(-100);
    expect(d.percentage).toBe(-100);
  });

  it("16. delta percentage rounding to 1 decimal", () => {
    const d = calculateReadingEvolutionDelta(3, 1);
    expect(d.direction).toBe("decrease");
    expect(d.percentage).toBe(-66.7);
  });

  it("17. continued books identified correctly", () => {
    const prev = [
      { catalogId: "c-a", title: "A", author: null, publisher: null, publishYear: null, rank: 1 },
      { catalogId: "c-b", title: "B", author: null, publisher: null, publishYear: null, rank: 2 },
    ];
    const cur = [
      { catalogId: "c-a", title: "A", author: null, publisher: null, publishYear: null, rank: 1 },
      { catalogId: "c-c", title: "C", author: null, publisher: null, publishYear: null, rank: 2 },
    ];
    const result = compareReadingEvolutionTopBooks({
      previousBooks: prev,
      currentBooks: cur,
    });
    expect(result.continued).toHaveLength(1);
    expect(result.continued[0].catalogId).toBe("c-a");
  });

  it("18. entered books identified correctly", () => {
    const prev = [
      { catalogId: "c-a", title: "A", author: null, publisher: null, publishYear: null, rank: 1 },
    ];
    const cur = [
      { catalogId: "c-a", title: "A", author: null, publisher: null, publishYear: null, rank: 1 },
      { catalogId: "c-b", title: "B", author: null, publisher: null, publishYear: null, rank: 2 },
      { catalogId: "c-c", title: "C", author: null, publisher: null, publishYear: null, rank: 3 },
    ];
    const result = compareReadingEvolutionTopBooks({
      previousBooks: prev,
      currentBooks: cur,
    });
    expect(result.entered.map((b) => b.catalogId)).toEqual(["c-b", "c-c"]);
  });

  it("19. left books identified correctly", () => {
    const prev = [
      { catalogId: "c-a", title: "A", author: null, publisher: null, publishYear: null, rank: 1 },
      { catalogId: "c-b", title: "B", author: null, publisher: null, publishYear: null, rank: 2 },
      { catalogId: "c-c", title: "C", author: null, publisher: null, publishYear: null, rank: 3 },
    ];
    const cur = [
      { catalogId: "c-a", title: "A", author: null, publisher: null, publishYear: null, rank: 1 },
    ];
    const result = compareReadingEvolutionTopBooks({
      previousBooks: prev,
      currentBooks: cur,
    });
    expect(result.left.map((b) => b.catalogId)).toEqual(["c-b", "c-c"]);
  });

  it("20. continued rankDelta positive when current rank smaller", () => {
    const prev = [
      { catalogId: "c-a", title: "A", author: null, publisher: null, publishYear: null, rank: 5 },
    ];
    const cur = [
      { catalogId: "c-a", title: "A", author: null, publisher: null, publishYear: null, rank: 2 },
    ];
    const result = compareReadingEvolutionTopBooks({
      previousBooks: prev,
      currentBooks: cur,
    });
    expect(result.continued[0].rankDelta).toBe(3);
  });

  it("21. continued rankDelta negative when current rank larger", () => {
    const prev = [
      { catalogId: "c-a", title: "A", author: null, publisher: null, publishYear: null, rank: 2 },
    ];
    const cur = [
      { catalogId: "c-a", title: "A", author: null, publisher: null, publishYear: null, rank: 5 },
    ];
    const result = compareReadingEvolutionTopBooks({
      previousBooks: prev,
      currentBooks: cur,
    });
    expect(result.continued[0].rankDelta).toBe(-3);
  });

  it("22. book diff sorted by currentRank/previousRank/title", () => {
    const prev = [
      { catalogId: "c-a", title: "A", author: null, publisher: null, publishYear: null, rank: 1 },
      { catalogId: "c-b", title: "B", author: null, publisher: null, publishYear: null, rank: 2 },
    ];
    const cur = [
      { catalogId: "c-a", title: "A", author: null, publisher: null, publishYear: null, rank: 1 },
      { catalogId: "c-b", title: "B", author: null, publisher: null, publishYear: null, rank: 2 },
      { catalogId: "c-c", title: "C", author: null, publisher: null, publishYear: null, rank: 3 },
    ];
    const result = compareReadingEvolutionTopBooks({
      previousBooks: prev,
      currentBooks: cur,
    });
    expect(result.continued[0].catalogId).toBe("c-a");
    expect(result.continued[1].catalogId).toBe("c-b");
  });

  it("23. book diff cap of 12 per bucket", () => {
    const prev: { catalogId: string; title: string; author: null; publisher: null; publishYear: null; rank: number }[] = [];
    const cur: { catalogId: string; title: string; author: null; publisher: null; publishYear: null; rank: number }[] = [];
    for (let i = 1; i <= 20; i += 1) {
      cur.push({ catalogId: `c-${i}`, title: `T${i}`, author: null, publisher: null, publishYear: null, rank: i });
    }
    const result = compareReadingEvolutionTopBooks({
      previousBooks: prev,
      currentBooks: cur,
    });
    expect(result.entered).toHaveLength(READING_EVOLUTION_TOP_BOOKS_LIMIT);
    expect(result.entered.length).toBe(12);
  });

  it("24. overlap ratio normal case", () => {
    const prev = [
      { catalogId: "c-a", title: "A", author: null, publisher: null, publishYear: null, rank: 1 },
      { catalogId: "c-b", title: "B", author: null, publisher: null, publishYear: null, rank: 2 },
    ];
    const cur = [
      { catalogId: "c-a", title: "A", author: null, publisher: null, publishYear: null, rank: 1 },
      { catalogId: "c-c", title: "C", author: null, publisher: null, publishYear: null, rank: 2 },
    ];
    const overlap = calculateReadingEvolutionTopListOverlap({
      previousBooks: prev,
      currentBooks: cur,
    });
    // common = 1 (c-a), union = 3 (a,b,c), ratio = 1/3
    expect(overlap.commonBooks).toBe(1);
    expect(overlap.unionBooks).toBe(3);
    expect(overlap.ratio).toBeCloseTo(1 / 3, 4);
  });

  it("25. overlap ratio when union = 0 → 0", () => {
    const overlap = calculateReadingEvolutionTopListOverlap({
      previousBooks: [],
      currentBooks: [],
    });
    expect(overlap.commonBooks).toBe(0);
    expect(overlap.unionBooks).toBe(0);
    expect(overlap.ratio).toBe(0);
  });

  it("26. overlap ratio never NaN", () => {
    const overlap = calculateReadingEvolutionTopListOverlap({
      previousBooks: [],
      currentBooks: [],
    });
    expect(Number.isNaN(overlap.ratio)).toBe(false);
    expect(Number.isFinite(overlap.ratio)).toBe(true);
  });

  it("27. year_gap reason when toYear - fromYear > 1", () => {
    const reasons = evaluateTransitionReasons({
      fromYear: 2020,
      toYear: 2023,
      previous: makeYearNode(2020),
      current: makeYearNode(2023),
      overlapRatio: 0.5,
    });
    expect(reasons).toContain("year_gap");
  });

  it("28. no year_gap when consecutive", () => {
    const reasons = evaluateTransitionReasons({
      fromYear: 2020,
      toYear: 2021,
      previous: makeYearNode(2020),
      current: makeYearNode(2021),
      overlapRatio: 0.5,
    });
    expect(reasons).not.toContain("year_gap");
  });

  it("29. records_shift when ratio >= 2 and absolute >= 20", () => {
    const reasons = evaluateTransitionReasons({
      fromYear: 2020,
      toYear: 2021,
      previous: makeYearNode(2020, { totalRecords: 100 }),
      current: makeYearNode(2021, { totalRecords: 250 }),
      overlapRatio: 0.5,
    });
    expect(reasons).toContain("records_shift");
  });

  it("30. records_shift blocked when absolute < 20", () => {
    const reasons = evaluateTransitionReasons({
      fromYear: 2020,
      toYear: 2021,
      previous: makeYearNode(2020, { totalRecords: 100 }),
      current: makeYearNode(2021, { totalRecords: 110 }),
      overlapRatio: 0.5,
    });
    expect(reasons).not.toContain("records_shift");
  });

  it("31. records_shift blocked when ratio < 2", () => {
    const reasons = evaluateTransitionReasons({
      fromYear: 2020,
      toYear: 2021,
      previous: makeYearNode(2020, { totalRecords: 100 }),
      current: makeYearNode(2021, { totalRecords: 130 }),
      overlapRatio: 0.5,
    });
    expect(reasons).not.toContain("records_shift");
  });

  it("32. active_months_shift when delta >= 5", () => {
    const reasons = evaluateTransitionReasons({
      fromYear: 2020,
      toYear: 2021,
      previous: makeYearNode(2020, { activeMonths: 3 }),
      current: makeYearNode(2021, { activeMonths: 9 }),
      overlapRatio: 0.5,
    });
    expect(reasons).toContain("active_months_shift");
  });

  it("33. no active_months_shift when delta < 5", () => {
    const reasons = evaluateTransitionReasons({
      fromYear: 2020,
      toYear: 2021,
      previous: makeYearNode(2020, { activeMonths: 6 }),
      current: makeYearNode(2021, { activeMonths: 8 }),
      overlapRatio: 0.5,
    });
    expect(reasons).not.toContain("active_months_shift");
  });

  it("34. matched_books_shift when absolute >= 5 and ratio >= 1.5", () => {
    const reasons = evaluateTransitionReasons({
      fromYear: 2020,
      toYear: 2021,
      previous: makeYearNode(2020, { matchedBooks: 4 }),
      current: makeYearNode(2021, { matchedBooks: 10 }),
      overlapRatio: 0.5,
    });
    expect(reasons).toContain("matched_books_shift");
  });

  it("35. matched_books_shift blocked when absolute < 5", () => {
    const reasons = evaluateTransitionReasons({
      fromYear: 2020,
      toYear: 2021,
      previous: makeYearNode(2020, { matchedBooks: 5 }),
      current: makeYearNode(2021, { matchedBooks: 7 }),
      overlapRatio: 0.5,
    });
    expect(reasons).not.toContain("matched_books_shift");
  });

  it("36. matched_books_shift blocked when ratio < 1.5", () => {
    const reasons = evaluateTransitionReasons({
      fromYear: 2020,
      toYear: 2021,
      previous: makeYearNode(2020, { matchedBooks: 10 }),
      current: makeYearNode(2021, { matchedBooks: 13 }),
      overlapRatio: 0.5,
    });
    expect(reasons).not.toContain("matched_books_shift");
  });

  it("37. low_top_list_overlap when ratio < 0.2 with non-empty lists", () => {
    const reasons = evaluateTransitionReasons({
      fromYear: 2020,
      toYear: 2021,
      previous: makeYearNode(2020, { topBookCatalogIds: ["c-a", "c-b"] }),
      current: makeYearNode(2021, { topBookCatalogIds: ["c-x", "c-y"] }),
      overlapRatio: 0.1,
    });
    expect(reasons).toContain("low_top_list_overlap");
  });

  it("38. low_top_list_overlap not triggered with empty list", () => {
    const reasons = evaluateTransitionReasons({
      fromYear: 2020,
      toYear: 2021,
      previous: makeYearNode(2020, { topBookCatalogIds: [] }),
      current: makeYearNode(2021, { topBookCatalogIds: ["c-a"] }),
      overlapRatio: 0.0,
    });
    expect(reasons).not.toContain("low_top_list_overlap");
  });

  it("39. multi-reason combination", () => {
    const reasons = evaluateTransitionReasons({
      fromYear: 2020,
      toYear: 2023,
      previous: makeYearNode(2020, { totalRecords: 100, activeMonths: 3, matchedBooks: 4 }),
      current: makeYearNode(2023, { totalRecords: 250, activeMonths: 9, matchedBooks: 10 }),
      overlapRatio: 0.1,
    });
    expect(reasons).toContain("year_gap");
    expect(reasons).toContain("records_shift");
    expect(reasons).toContain("active_months_shift");
    expect(reasons).toContain("matched_books_shift");
    expect(reasons).toContain("low_top_list_overlap");
  });

  it("40. significance year_gap always significant", () => {
    const { significant, score } = calculateSignificanceScore(["year_gap"]);
    expect(significant).toBe(true);
    expect(score).toBe(100);
  });

  it("41. score 50 is significant", () => {
    // records_shift(35) + active_months_shift(25) = 60 → significant
    const { significant, score } = calculateSignificanceScore([
      "records_shift",
      "active_months_shift",
    ]);
    expect(score).toBe(60);
    expect(significant).toBe(true);
  });

  it("42. score below 50 not significant", () => {
    // matched_books_shift(20) only = 20 → not significant
    const { significant, score } = calculateSignificanceScore([
      "matched_books_shift",
    ]);
    expect(score).toBe(20);
    expect(significant).toBe(false);
  });

  it("43. first milestone present in multi-year archive", () => {
    const archive = makeArchive({
      years: [
        makeYear(2020),
        makeYear(2021),
        makeYear(2022),
      ],
    });
    const result = buildWereadReadingEvolutionTimeline({ archive });
    const first = result.milestones.find((m) => m.kind === "first_year");
    expect(first).toBeDefined();
    expect(first!.year).toBe(2020);
  });

  it("44. latest milestone present in multi-year archive", () => {
    const archive = makeArchive({
      years: [
        makeYear(2020),
        makeYear(2021),
        makeYear(2022),
      ],
    });
    const result = buildWereadReadingEvolutionTimeline({ archive });
    const latest = result.milestones.find((m) => m.kind === "latest_year");
    expect(latest).toBeDefined();
    expect(latest!.year).toBe(2022);
  });

  it("45. single-year milestone merges first/latest into one", () => {
    const archive = makeArchive({ years: [makeYear(2024)] });
    const result = buildWereadReadingEvolutionTimeline({ archive });
    expect(result.milestones).toHaveLength(1);
    expect(result.milestones[0].kind).toBe("first_year");
    expect(result.milestones[0].year).toBe(2024);
  });

  it("46. year_gap milestone generated", () => {
    // Make a 2020→2023 transition with year_gap (which is always significant)
    const archive = makeArchive({
      years: [
        makeYear(2020, { totalRecords: 50 }),
        makeYear(2023, { totalRecords: 100 }),
      ],
    });
    const result = buildWereadReadingEvolutionTimeline({ archive });
    const gap = result.milestones.find((m) => m.kind === "year_gap");
    expect(gap).toBeDefined();
    expect(gap!.year).toBe(2023);
  });

  it("47. statistical_shift milestone generated", () => {
    const archive = makeArchive({
      years: [
        makeYear(2020, { totalRecords: 100, activeMonths: 5 }),
        makeYear(2021, { totalRecords: 250, activeMonths: 11 }),
      ],
    });
    const result = buildWereadReadingEvolutionTimeline({ archive });
    const shift = result.milestones.find((m) => m.kind === "statistical_shift");
    expect(shift).toBeDefined();
  });

  it("48. milestones sorted year-asc, kind-order", () => {
    const archive = makeArchive({
      years: [
        makeYear(2020, { totalRecords: 50 }),
        makeYear(2023, { totalRecords: 100 }),
      ],
    });
    const result = buildWereadReadingEvolutionTimeline({ archive });
    const years = result.milestones.map((m) => m.year);
    const sorted = [...years].sort((a, b) => a - b);
    expect(years).toEqual(sorted);
  });

  it("49. milestones dedup by (year, kind)", () => {
    const archive = makeArchive({
      years: [
        makeYear(2024),
        makeYear(2025, {
          totalRecords: 250,
          activeMonths: 11,
        }),
      ],
    });
    const result = buildWereadReadingEvolutionTimeline({ archive });
    const seen = new Set<string>();
    for (const m of result.milestones) {
      const key = `${m.year}:${m.kind}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it("50. summary first/latest correct", () => {
    const archive = makeArchive({
      years: [
        makeYear(2020),
        makeYear(2022),
        makeYear(2024),
      ],
    });
    const result = buildWereadReadingEvolutionTimeline({ archive });
    expect(result.summary.firstYear).toBe(2020);
    expect(result.summary.latestYear).toBe(2024);
  });

  it("51. summary transition count", () => {
    const archive = makeArchive({
      years: [
        makeYear(2020),
        makeYear(2021),
        makeYear(2022),
        makeYear(2023),
      ],
    });
    const result = buildWereadReadingEvolutionTimeline({ archive });
    expect(result.summary.transitionCount).toBe(3);
  });

  it("52. summary significant count", () => {
    const archive = makeArchive({
      years: [
        makeYear(2020, { totalRecords: 100, activeMonths: 5 }),
        makeYear(2021, { totalRecords: 200, activeMonths: 11 }),
      ],
    });
    const result = buildWereadReadingEvolutionTimeline({ archive });
    // records_shift + active_months_shift = 35+25 = 60, >= 50 → significant
    expect(result.summary.significantTransitionCount).toBeGreaterThanOrEqual(1);
  });

  it("53. summary gap count", () => {
    const archive = makeArchive({
      years: [
        makeYear(2020, { totalRecords: 50 }),
        makeYear(2022, { totalRecords: 100 }),
        makeYear(2025, { totalRecords: 200 }),
      ],
    });
    const result = buildWereadReadingEvolutionTimeline({ archive });
    expect(result.summary.yearGapCount).toBe(2);
  });

  it("54. persisted=false hard-coded", () => {
    const archive = makeArchive({ years: [makeYear(2024)] });
    const result = buildWereadReadingEvolutionTimeline({ archive });
    expect(result.meta.persisted).toBe(false);
  });

  it("55. deterministic output (same input → same result)", () => {
    const archive = makeArchive({
      years: [
        makeYear(2020),
        makeYear(2021),
        makeYear(2022),
      ],
    });
    const a = buildWereadReadingEvolutionTimeline({ archive });
    const b = buildWereadReadingEvolutionTimeline({ archive });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("56. debug snapshot does not contain catalogId", () => {
    const archive = makeArchive({ years: [makeYear(2024)] });
    const result = buildWereadReadingEvolutionTimeline({ archive });
    const snap = buildReadingEvolutionDebugSnapshot(result);
    const dump = JSON.stringify(snap);
    expect(dump).not.toMatch(/c-\d+-a/);
    expect(dump).not.toMatch(/catalogId/i);
  });

  it("57. debug snapshot does not contain title", () => {
    const archive = makeArchive({ years: [makeYear(2024)] });
    const result = buildWereadReadingEvolutionTimeline({ archive });
    const snap = buildReadingEvolutionDebugSnapshot(result);
    const dump = JSON.stringify(snap);
    expect(dump).not.toMatch(/书目/);
    expect(dump).not.toMatch(/title/i);
  });

  it("58. model does not emit note text/comment", () => {
    const archive = makeArchive({ years: [makeYear(2024)] });
    const result = buildWereadReadingEvolutionTimeline({ archive });
    const dump = JSON.stringify(result);
    expect(dump).not.toMatch(/note\.text/);
    expect(dump).not.toMatch(/note\.comment/);
  });

  it("59. model does not emit private IDs", () => {
    const archive = makeArchive({ years: [makeYear(2024)] });
    const result = buildWereadReadingEvolutionTimeline({ archive });
    const dump = JSON.stringify(result);
    expect(dump).not.toMatch(/wereadBookId/);
    expect(dump).not.toMatch(/noteId/);
    expect(dump).not.toMatch(/highlightId/);
  });

  it("60. model does not emit token/Authorization/api key", () => {
    const archive = makeArchive({ years: [makeYear(2024)] });
    const result = buildWereadReadingEvolutionTimeline({ archive });
    const dump = JSON.stringify(result);
    expect(dump).not.toMatch(/Authorization/);
    expect(dump).not.toMatch(/token=/);
    expect(dump).not.toMatch(/api[_-]?key/i);
  });

  it("61. model does not emit AI/themes", () => {
    const archive = makeArchive({ years: [makeYear(2024)] });
    const result = buildWereadReadingEvolutionTimeline({ archive });
    const dump = JSON.stringify(result);
    expect(dump).not.toMatch(/ai summary/i);
    expect(dump).not.toMatch(/themes/i);
  });

  it("62. model does not emit fetch/storage strings", () => {
    const archive = makeArchive({ years: [makeYear(2024)] });
    const result = buildWereadReadingEvolutionTimeline({ archive });
    const dump = JSON.stringify(result);
    expect(dump).not.toMatch(/localStorage/);
    expect(dump).not.toMatch(/sessionStorage/);
    expect(dump).not.toMatch(/indexedDB/);
  });

  it("63. model does not emit inference-language strings", () => {
    const archive = makeArchive({ years: [makeYear(2024)] });
    const result = buildWereadReadingEvolutionTimeline({ archive });
    const dump = JSON.stringify(result);
    for (const word of READING_EVOLUTION_FORBIDDEN_PSYCHOLOGICAL_WORDS) {
      expect(dump).not.toContain(word);
    }
  });

  it("64. numeric outputs finite (no NaN/Infinity)", () => {
    const archive = makeArchive({
      years: [
        makeYear(2020, {
          totalRecords: 0,
          matchedRecords: 0,
          matchedBooks: 0,
          activeMonths: 0,
        }),
        makeYear(2021, {
          totalRecords: 100,
          matchedRecords: 80,
          matchedBooks: 6,
          activeMonths: 8,
        }),
      ],
    });
    const result = buildWereadReadingEvolutionTimeline({ archive });
    const dump = JSON.stringify(result);
    expect(dump).not.toMatch(/NaN/);
    expect(dump).not.toMatch(/Infinity/);
  });

  it("65. no HTML in output", () => {
    const archive = makeArchive({ years: [makeYear(2024)] });
    const result = buildWereadReadingEvolutionTimeline({ archive });
    const dump = JSON.stringify(result);
    expect(dump).not.toMatch(/<script/);
    expect(dump).not.toMatch(/<\/script>/);
    expect(dump).not.toMatch(/dangerouslySetInnerHTML/);
    expect(dump).not.toMatch(/innerHTML/);
  });

  it("66. privacy notice string is available", () => {
    expect(typeof READING_EVOLUTION_PRIVACY_NOTICE).toBe("string");
    expect(READING_EVOLUTION_PRIVACY_NOTICE.length).toBeGreaterThan(20);
  });

  it("67. forbidden tokens list populated", () => {
    expect(READING_EVOLUTION_FORBIDDEN_TOKENS.length).toBeGreaterThan(0);
    expect(READING_EVOLUTION_FORBIDDEN_TOKENS).toContain("note.text");
    expect(READING_EVOLUTION_FORBIDDEN_TOKENS).toContain("token=");
  });

  it("68. significance threshold exported", () => {
    expect(READING_EVOLUTION_SIGNIFICANCE_THRESHOLD).toBe(50);
  });

  it("69. year nodes handle archive with no recurringBooks", () => {
    const archive = makeArchive({
      years: [
        makeYear(2024, { topBookCatalogIds: ["c-x"] }),
      ],
      recurring: [],
    });
    const nodes = buildReadingEvolutionYearNodes({ archive });
    expect(nodes[0].topBooks[0].catalogId).toBe("c-x");
    expect(nodes[0].topBooks[0].title).toBe("书目 c-x");
  });

  it("70. archive with cached recurringBooks gives canonical titles", () => {
    const archive = makeArchive({
      years: [
        makeYear(2024, { topBookCatalogIds: ["c-canon"] }),
      ],
      recurring: [makeRecurringBook("c-canon", [2024], "Canonical Title", "Author")],
    });
    const nodes = buildReadingEvolutionYearNodes({ archive });
    expect(nodes[0].topBooks[0].title).toBe("Canonical Title");
    expect(nodes[0].topBooks[0].author).toBe("Author");
  });

  it("71. multi-year end-to-end produces transitions", () => {
    const archive = makeArchive({
      years: [
        makeYear(2020, { totalRecords: 100 }),
        makeYear(2021, { totalRecords: 150 }),
        makeYear(2022, { totalRecords: 200 }),
      ],
    });
    const result = buildWereadReadingEvolutionTimeline({ archive });
    expect(result.years).toHaveLength(3);
    expect(result.transitions).toHaveLength(2);
    expect(result.transitions[0].fromYear).toBe(2020);
    expect(result.transitions[0].toYear).toBe(2021);
    expect(result.transitions[1].fromYear).toBe(2021);
    expect(result.transitions[1].toYear).toBe(2022);
  });

  it("72. transition delta direction reflects year-to-year change", () => {
    const archive = makeArchive({
      years: [
        makeYear(2020, { totalRecords: 100 }),
        makeYear(2021, { totalRecords: 150 }),
      ],
    });
    const result = buildWereadReadingEvolutionTimeline({ archive });
    expect(result.transitions[0].metrics.totalRecords.direction).toBe("increase");
  });
});

// ---------- helpers for transition-reason tests ----------

function makeYearNode(
  year: number,
  overrides: Partial<{
    totalRecords: number;
    matchedRecords: number;
    matchedBooks: number;
    activeMonths: number;
    topBookCatalogIds: string[];
  }> = {},
): {
  year: number;
  totalRecords: number;
  matchedRecords: number;
  matchedBooks: number;
  activeMonths: number;
  averageRecordsPerActiveMonth: number;
  topBooks: { catalogId: string; title: string; author: string | null; publisher: string | null; publishYear: string | number | null; rank: number }[];
} {
  const totalRecords = overrides.totalRecords ?? 100;
  const matchedRecords = overrides.matchedRecords ?? 70;
  const matchedBooks = overrides.matchedBooks ?? 5;
  const activeMonths = overrides.activeMonths ?? 8;
  const topIds = overrides.topBookCatalogIds ?? ["c-a", "c-b", "c-c"];
  const topBooks = topIds.map((id, i) => ({
    catalogId: id,
    title: `T${i}`,
    author: null,
    publisher: null,
    publishYear: null,
    rank: i + 1,
  }));
  return {
    year,
    totalRecords,
    matchedRecords,
    matchedBooks,
    activeMonths,
    averageRecordsPerActiveMonth: activeMonths > 0 ? totalRecords / activeMonths : 0,
    topBooks,
  };
}
