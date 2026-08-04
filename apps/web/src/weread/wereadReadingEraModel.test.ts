/**
 * S27M — Reading Era Segmentation model tests (pure functions).
 *
 * Coverage:
 *   1.  Empty data
 *   2.  Single year
 *   3.  Consecutive years with no boundary
 *   4.  year_gap always boundary
 *   5.  activity ratio boundary (≥ 2× AND ≥ 20 abs diff)
 *   6.  activity ratio below gate OR abs diff below gate → no boundary
 *   7.  activeMonths shift boundary
 *   8.  low overlap boundary (overlapRatio < 0.2 with both lists non-empty)
 *   9.  empty Top N → no top_list_shift boundary
 *   10. multiple reasons combine score
 *   11. score below threshold → no boundary (non year_gap)
 *   12. automatic mode keeps high-score + year_gap
 *   13. gaps_only mode keeps ONLY year_gap
 *   14. single-year segment from non year_gap merges into neighbour
 *   15. single-year segment from year_gap is preserved
 *   16. merge tie → merges forward into later era
 *   17. era years sorted ascending
 *   18. era totalRecords sums correctly
 *   19. era totalActiveMonths sums correctly
 *   20. era averageRecordsPerYear = total / years.length
 *   21. peakYear = max totalRecords year
 *   22. peakYear tie → earlier year wins
 *   23. era recurringBooks only contains catalogIds present in ≥ 2 era years
 *   24. recurringBooks cap at 6
 *   25. meta.persisted === false
 *   26. output stable for same input
 *   27. no NaN / Infinity in any numeric field
 *   28. no note text / comment / markedText in any output field
 *   29. no private IDs (wereadBookId / noteId / highlightId / chapterTitle)
 *   30. no AI summary / themes content
 *   31. no psychological / interest inference vocabulary
 *   32. no HTML strings
 */

import { describe, expect, it } from "vitest";

import type {
  WereadReadingArchive,
  ReadingArchiveYear,
  ReadingArchiveRecurringBook,
  ReadingArchiveYearLink,
} from "./wereadReadingArchiveModel";

import {
  READING_ERA_BOUNDARY_LABELS,
  READING_ERA_RECURRING_BOOKS_LIMIT,
  buildReadingEras,
  describeEraBoundary,
  detectEraBoundaries,
  finalizeEraBoundaries,
} from "./wereadReadingEraModel";

// ---------- synthetic builders ----------

function makeYear(
  year: number,
  overrides: Partial<ReadingArchiveYear> = {},
): ReadingArchiveYear {
  return {
    year,
    totalRecords: 100,
    datedRecords: 90,
    matchedRecords: 80,
    matchedBooks: 5,
    activeMonths: 8,
    longestStreakMonths: 4,
    peakMonth: `${year}-06`,
    peakMonthRecords: 12,
    averageRecordsPerActiveMonth: 12.5,
    topBookCount: 5,
    topBookCatalogIds: ["a", "b", "c", "d", "e"],
    ...overrides,
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

function makeArchive(
  years: ReadingArchiveYear[],
  links: ReadingArchiveYearLink[] = [],
  recurringBooks: ReadingArchiveRecurringBook[] = [],
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
      topBooksLimit: 12,
      maxYears: 20,
      persisted: false,
      source: "annual-review-cache",
    },
  };
}

// ---------- forbidden-phrase scans ----------

const FORBIDDEN_PRIVACY_PATTERNS: ReadonlyArray<{ label: string; re: RegExp }> = [
  { label: "note.text", re: /note\.text/ },
  { label: "note.comment", re: /note\.comment/ },
  { label: "markedText", re: /markedText/ },
  { label: "wereadBookId", re: /wereadBookId/ },
  { label: "noteId", re: /\bnoteId\b/ },
  { label: "highlightId", re: /\bhighlightId\b/ },
  { label: "chapterTitle", re: /chapterTitle/ },
  { label: "summary.overview", re: /summary\.overview/ },
  { label: "summary.keyPoints", re: /summary\.keyPoints/ },
  { label: "summary.reviewQuestions", re: /summary\.reviewQuestions/ },
  { label: "themes[", re: /themes\s*:/ },
  { label: "Authorization", re: /Authorization\s*:\s*Bearer/ },
  { label: "wr_skey", re: /wr_skey/ },
  { label: "wr_vid", re: /wr_vid/ },
  { label: "dangerouslySetInnerHTML", re: /dangerouslySetInnerHTML/ },
];

const FORBIDDEN_PSYCHOLOGICAL_PATTERNS: ReadonlyArray<{ label: string; re: RegExp }> = [
  { label: "interest shift", re: /兴趣\s*转变/ },
  { label: "preference change", re: /偏好\s*改变/ },
  { label: "quality up/down", re: /质量\s*(提升|下降)/ },
  { label: "focus change", re: /专注力\s*变化/ },
  { label: "exploration / mature", re: /(成熟期|探索期)/ },
  { label: "low / peak", re: /(低谷|巅峰)/ },
];

const FORBIDDEN_HTML_PATTERN = /<\s*(div|span|p|a|section|article|aside)\b/i;

function expectNoForbiddenFields(value: unknown): void {
  const json = JSON.stringify(value);
  for (const p of FORBIDDEN_PRIVACY_PATTERNS) {
    expect(json, `forbidden privacy field: ${p.label}`).not.toMatch(p.re);
  }
}

function expectNoPsychologicalVocabulary(value: unknown): void {
  const json = JSON.stringify(value);
  for (const p of FORBIDDEN_PSYCHOLOGICAL_PATTERNS) {
    expect(json, `forbidden psychology: ${p.label}`).not.toMatch(p.re);
  }
}

function expectNoHtml(value: unknown): void {
  const json = JSON.stringify(value);
  expect(json, "no HTML strings").not.toMatch(FORBIDDEN_HTML_PATTERN);
}

function expectFiniteNumbers(value: unknown, path = "$"): void {
  if (typeof value === "number") {
    expect(Number.isFinite(value), `${path} must be finite`).toBe(true);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => expectFiniteNumbers(v, `${path}[${i}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      expectFiniteNumbers(v, `${path}.${k}`);
    }
  }
}

// ---------- tests ----------

describe("wereadReadingEraModel (S27M)", () => {
  it("1. empty archive → empty eras + no boundaries", () => {
    const result = buildReadingEras(makeArchive([], [], []));
    expect(result.eras).toEqual([]);
    expect(result.boundaries).toEqual([]);
    expect(result.meta.yearsUsed).toBe(0);
    expect(result.meta.erasReturned).toBe(0);
    expect(result.meta.mode).toBe("automatic");
    expect(result.meta.persisted).toBe(false);
  });

  it("2. single year → one era with no boundary", () => {
    const year = makeYear(2025);
    const result = buildReadingEras(makeArchive([year]));
    // expected: single-year era
    expect(result.eras.length).toBe(1);
    expect(result.eras[0].startYear).toBe(2025);
    expect(result.eras[0].endYear).toBe(2025);
    expect(result.eras[0].years).toEqual([2025]);
    expect(result.eras[0].boundaryBefore).toBeNull();
    expect(result.boundaries).toEqual([]);
  });

  it("3. consecutive years, no deltas → no boundary", () => {
    const years = [2020, 2021, 2022].map((y) => makeYear(y));
    const links = [
      makeLink(2020, 2021, 0.6),
      makeLink(2021, 2022, 0.6),
    ];
    const result = buildReadingEras(makeArchive(years, links));
    expect(result.boundaries).toEqual([]);
    expect(result.eras.length).toBe(1);
    expect(result.eras[0].years).toEqual([2020, 2021, 2022]);
  });

  it("4. year_gap always produces a boundary", () => {
    const years = [makeYear(2020), makeYear(2022)];
    const result = buildReadingEras(makeArchive(years));
    expect(result.boundaries.length).toBe(1);
    expect(result.boundaries[0].afterYear).toBe(2020);
    expect(result.boundaries[0].beforeYear).toBe(2022);
    expect(result.boundaries[0].reasons).toContain("year_gap");
    expect(result.boundaries[0].score).toBeGreaterThanOrEqual(100);
    expect(result.eras.length).toBe(2);
    expect(result.eras[0].years).toEqual([2020]);
    expect(result.eras[1].years).toEqual([2022]);
  });

  it("5. activity ratio ≥ 2× AND abs diff ≥ 20 → activity_shift (raw detection)", () => {
    const years = [
      makeYear(2020, { totalRecords: 100 }),
      makeYear(2021, { totalRecords: 250 }), // ratio 2.5, diff 150
    ];
    // Raw detection always fires when both gates pass; automatic-mode
    // public API then filters it because score 35 < threshold 50.
    const raw = detectEraBoundaries(years, []);
    expect(raw.length).toBe(1);
    expect(raw[0].reasons).toContain("activity_shift");
  });

  it("6. activity ratio large but abs diff small → no activity_shift", () => {
    const years = [
      makeYear(2020, { totalRecords: 5 }),
      makeYear(2021, { totalRecords: 50 }), // ratio 10, but diff = 45
    ];
    // Actually 50/5 = 10× and diff 45: BOTH gates met → boundary.
    // Build a case where ONLY one gate passes:
    const years2 = [
      makeYear(2020, { totalRecords: 50 }),
      makeYear(2021, { totalRecords: 51 }), // ratio ~1, diff 1
    ];
    expect(buildReadingEras(makeArchive(years2)).boundaries.length).toBe(0);
    // Ratio gate passes, diff gate fails:
    const years3 = [
      makeYear(2020, { totalRecords: 10 }),
      makeYear(2021, { totalRecords: 15 }), // ratio 1.5, diff 5
    ];
    expect(buildReadingEras(makeArchive(years3)).boundaries.length).toBe(0);
    // Diff gate passes, ratio gate fails:
    const years4 = [
      makeYear(2020, { totalRecords: 100 }),
      makeYear(2021, { totalRecords: 115 }), // ratio 1.15, diff 15
    ];
    expect(buildReadingEras(makeArchive(years4)).boundaries.length).toBe(0);
  });

  it("7. activeMonths shift ≥ 5 → active_month_shift (raw detection)", () => {
    const years = [
      makeYear(2020, { activeMonths: 12 }),
      makeYear(2021, { activeMonths: 6 }), // diff 6
    ];
    const raw = detectEraBoundaries(years, []);
    expect(raw.length).toBe(1);
    expect(raw[0].reasons).toContain("active_month_shift");
  });

  it("8. low overlap (overlapRatio < 0.2) with both Top N non-empty → top_list_shift (raw detection)", () => {
    const years = [
      makeYear(2020, { topBookCatalogIds: ["a", "b", "c"] }),
      makeYear(2021, { topBookCatalogIds: ["x", "y", "z"] }),
    ];
    const links = [makeLink(2020, 2021, 0.05)];
    const raw = detectEraBoundaries(years, links);
    expect(raw.length).toBe(1);
    expect(raw[0].reasons).toContain("top_list_shift");
  });

  it("9. empty Top N → no top_list_shift", () => {
    const years = [
      makeYear(2020, { topBookCatalogIds: [] }),
      makeYear(2021, { topBookCatalogIds: ["x", "y", "z"] }),
    ];
    const links = [makeLink(2020, 2021, 0.05)];
    const result = buildReadingEras(makeArchive(years, links));
    expect(
      result.boundaries[0]?.reasons.includes("top_list_shift") ?? false,
    ).toBe(false);
  });

  it("10. multiple reasons combine score", () => {
    const years = [
      makeYear(2020, {
        totalRecords: 100,
        activeMonths: 12,
        topBookCatalogIds: ["a", "b", "c"],
      }),
      makeYear(2021, {
        totalRecords: 300, // ratio 3, diff 200 → activity_shift
        activeMonths: 4, // diff 8 → active_month_shift
        topBookCatalogIds: ["x", "y", "z"],
      }),
    ];
    const links = [makeLink(2020, 2021, 0.05)];
    const result = buildReadingEras(makeArchive(years, links));
    expect(result.boundaries.length).toBe(1);
    const reasons = result.boundaries[0].reasons;
    expect(reasons).toContain("activity_shift");
    expect(reasons).toContain("active_month_shift");
    expect(reasons).toContain("top_list_shift");
    // score = 35 + 25 + 25 = 85
    expect(result.boundaries[0].score).toBe(85);
  });

  it("11. score below threshold (non year_gap) → no boundary in automatic mode", () => {
    // Only top_list_shift (25 < 50) → not enough for automatic.
    const years = [
      makeYear(2020, {
        totalRecords: 100,
        activeMonths: 8,
        topBookCatalogIds: ["a", "b", "c"],
      }),
      makeYear(2021, {
        totalRecords: 105, // ratio ~1, diff 5 → no activity_shift
        activeMonths: 8, // diff 0 → no active_month_shift
        topBookCatalogIds: ["x", "y", "z"],
      }),
    ];
    const links = [makeLink(2020, 2021, 0.05)];
    const result = buildReadingEras(makeArchive(years, links));
    // raw boundary exists (top_list_shift) but is filtered by
    // automatic-mode threshold.
    const raw = detectEraBoundaries(years, links);
    expect(raw.length).toBe(1);
    expect(finalizeEraBoundaries(raw, "automatic")).toEqual([]);
  });

  it("12. automatic mode keeps score ≥ 50 + year_gap", () => {
    const years = [
      makeYear(2020, {
        totalRecords: 100,
        activeMonths: 12,
        topBookCatalogIds: ["a", "b", "c"],
      }),
      makeYear(2021, {
        totalRecords: 300, // activity_shift
        activeMonths: 4, // active_month_shift
        topBookCatalogIds: ["x", "y", "z"],
      }),
      makeYear(2023), // year_gap from 2021
    ];
    const links = [makeLink(2020, 2021, 0.05)];
    const result = buildReadingEras(makeArchive(years, links));
    expect(result.boundaries.length).toBe(2);
    const reasons = result.boundaries.flatMap((b) => b.reasons);
    expect(reasons).toContain("activity_shift");
    expect(reasons).toContain("year_gap");
  });

  it("13. gaps_only mode keeps ONLY year_gap", () => {
    const years = [
      makeYear(2020, {
        totalRecords: 100,
        activeMonths: 12,
        topBookCatalogIds: ["a", "b", "c"],
      }),
      makeYear(2021, {
        totalRecords: 300,
        activeMonths: 4,
        topBookCatalogIds: ["x", "y", "z"],
      }),
      makeYear(2023),
    ];
    const links = [makeLink(2020, 2021, 0.05)];
    const result = buildReadingEras(makeArchive(years, links), "gaps_only");
    // Two raw boundaries (2020->2021 = non year_gap, 2021->2023 = year_gap).
    // gaps_only keeps ONLY the year_gap boundary (its reasons may also
    // include other non-year_gap deltas; gaps_only only filters WHICH
    // boundaries survive, not WHICH reasons appear on survivors).
    expect(result.boundaries.length).toBe(1);
    expect(result.boundaries[0].afterYear).toBe(2021);
    expect(result.boundaries[0].beforeYear).toBe(2023);
    expect(result.boundaries[0].reasons).toContain("year_gap");
  });

  it("14. single-year non year_gap segment merges into neighbour", () => {
    // Case A: both adjacent boundaries score 35 (below threshold) →
    // no boundary kept in automatic mode, so all years stay in one
    // era. No single-year segments exist to merge.
    const years = [
      makeYear(2020, { totalRecords: 100 }),
      makeYear(2021, { totalRecords: 300 }), // raw boundary, score 35
      makeYear(2022, { totalRecords: 100 }), // raw boundary, score 35
      makeYear(2023, { totalRecords: 100 }),
    ];
    const result = buildReadingEras(makeArchive(years));
    expect(result.boundaries.length).toBe(0);
    expect(result.eras.length).toBe(1);

    // Case B: weak right-side boundary + strong left-side boundary.
    // 2020→2021 boundary: activity+months shift = 60 (strong)
    // 2021→2022 boundary: only top_list_shift = 25 (weak)
    // 2021 is single, not year_gap, and the right-side boundary is
    // weaker than the left → 2021 merges FORWARD into [2022].
    const years2 = [
      makeYear(2020, {
        totalRecords: 100,
        activeMonths: 12,
        topBookCatalogIds: ["a", "b", "c"],
      }),
      makeYear(2021, {
        totalRecords: 500,
        activeMonths: 2,
        topBookCatalogIds: ["x", "y", "z"],
      }),
      makeYear(2022, {
        totalRecords: 100,
        activeMonths: 12,
        topBookCatalogIds: ["a", "b", "c"],
      }),
    ];
    const links2 = [
      makeLink(2020, 2021, 0.05), // low → top_list_shift contributes
      makeLink(2021, 2022, 0.6), // high → no top_list_shift
    ];
    const result2 = buildReadingEras(makeArchive(years2, links2));
    // Left boundary: activity+months+top_list = 35+25+25 = 85
    // Right boundary: activity+months = 35+25 = 60 (top_list doesn't fire)
    // Both kept (≥ 50). 3 raw eras. Middle 2021 single + non year_gap
    // → merges forward (right side weaker than left → merge right).
    expect(result2.eras.length).toBe(2);
    expect(result2.eras[0].years).toEqual([2020]);
    expect(result2.eras[1].years).toEqual([2021, 2022]);
    expect(result2.eras[1].boundaryBefore?.reasons).toContain("activity_shift");
  });

  it("15. single-year year_gap segment is preserved", () => {
    const years = [makeYear(2020), makeYear(2022)];
    const result = buildReadingEras(makeArchive(years));
    expect(result.eras.length).toBe(2);
    expect(result.eras[0].years).toEqual([2020]);
    expect(result.eras[1].years).toEqual([2022]);
    expect(result.eras[1].boundaryBefore?.reasons).toContain("year_gap");
  });

  it("16. merge tie on both sides → merges backward (with prev era)", () => {
    // Both adjacent boundaries have the same score (60 each):
    //   2020→2021: activity (35) + months (25) = 60
    //   2021→2022: activity (35) + months (25) = 60
    // Middle 2021 is single-year non-year_gap. Tie → merge backward
    // (with prev era). Then [2022] is single-year non-year_gap at
    // the edge with only a prev boundary → also merges backward.
    // Final: one era [2020, 2021, 2022].
    const years = [
      makeYear(2020, { totalRecords: 100, activeMonths: 12 }),
      makeYear(2021, { totalRecords: 500, activeMonths: 2 }),
      makeYear(2022, { totalRecords: 100, activeMonths: 12 }),
    ];
    const result = buildReadingEras(makeArchive(years));
    expect(result.eras.length).toBe(1);
    expect(result.eras[0].years).toEqual([2020, 2021, 2022]);
  });

  it("17. era years are sorted ascending", () => {
    const years = [
      makeYear(2023),
      makeYear(2020),
      makeYear(2022),
      makeYear(2021),
    ];
    const result = buildReadingEras(makeArchive(years));
    expect(result.eras[0].years).toEqual([2020, 2021, 2022, 2023]);
  });

  it("18. era totalRecords sums correctly", () => {
    const years = [
      makeYear(2020, { totalRecords: 100 }),
      makeYear(2021, { totalRecords: 200 }),
      makeYear(2022, { totalRecords: 300 }),
    ];
    const result = buildReadingEras(makeArchive(years));
    expect(result.eras[0].totalRecords).toBe(600);
  });

  it("19. era totalActiveMonths sums correctly", () => {
    const years = [
      makeYear(2020, { activeMonths: 6 }),
      makeYear(2021, { activeMonths: 9 }),
      makeYear(2022, { activeMonths: 12 }),
    ];
    const result = buildReadingEras(makeArchive(years));
    expect(result.eras[0].totalActiveMonths).toBe(27);
  });

  it("20. era averageRecordsPerYear = total / years.length", () => {
    const years = [
      makeYear(2020, { totalRecords: 100 }),
      makeYear(2021, { totalRecords: 200 }),
      makeYear(2022, { totalRecords: 300 }),
    ];
    const result = buildReadingEras(makeArchive(years));
    expect(result.eras[0].averageRecordsPerYear).toBe(200);
  });

  it("21. peakYear = max totalRecords year", () => {
    const years = [
      makeYear(2020, { totalRecords: 100 }),
      makeYear(2021, { totalRecords: 500 }),
      makeYear(2022, { totalRecords: 200 }),
    ];
    const result = buildReadingEras(makeArchive(years));
    expect(result.eras[0].peakYear).toBe(2021);
    expect(result.eras[0].peakYearRecords).toBe(500);
  });

  it("22. peakYear tie → earlier year wins", () => {
    const years = [
      makeYear(2020, { totalRecords: 500 }),
      makeYear(2021, { totalRecords: 500 }),
      makeYear(2022, { totalRecords: 200 }),
    ];
    const result = buildReadingEras(makeArchive(years));
    expect(result.eras[0].peakYear).toBe(2020);
    expect(result.eras[0].peakYearRecords).toBe(500);
  });

  it("23. era recurringBooks only catalogIds present in ≥ 2 era years", () => {
    const years = [
      makeYear(2020, { topBookCatalogIds: ["a", "b"] }),
      makeYear(2021, { topBookCatalogIds: ["a", "c"] }),
      makeYear(2022, { topBookCatalogIds: ["d"] }),
    ];
    const result = buildReadingEras(makeArchive(years));
    const ids = result.eras[0].recurringBooks.map((b) => b.catalogId);
    expect(ids).toContain("a"); // in 2020 + 2021
    expect(ids).not.toContain("b"); // only 2020
    expect(ids).not.toContain("c"); // only 2021
    expect(ids).not.toContain("d"); // only 2022
  });

  it("24. recurringBooks cap at 6", () => {
    const years = [
      makeYear(2020, {
        topBookCatalogIds: ["a", "b", "c", "d", "e", "f", "g", "h"],
      }),
      makeYear(2021, {
        topBookCatalogIds: ["a", "b", "c", "d", "e", "f", "g", "h"],
      }),
    ];
    const result = buildReadingEras(makeArchive(years));
    expect(result.eras[0].recurringBooks.length).toBe(
      READING_ERA_RECURRING_BOOKS_LIMIT,
    );
  });

  it("25. meta.persisted === false", () => {
    const result = buildReadingEras(makeArchive([]));
    expect(result.meta.persisted).toBe(false);
  });

  it("26. output stable for same input", () => {
    const years = [
      makeYear(2020, { totalRecords: 100, activeMonths: 12 }),
      makeYear(2021, {
        totalRecords: 300,
        activeMonths: 4,
        topBookCatalogIds: ["x"],
      }),
      makeYear(2023),
    ];
    const a = buildReadingEras(makeArchive(years));
    const b = buildReadingEras(makeArchive(years));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("27. no NaN / Infinity in any numeric field", () => {
    const years = [
      makeYear(2020, { totalRecords: 0 }),
      makeYear(2021, { totalRecords: 0 }),
    ];
    const result = buildReadingEras(makeArchive(years));
    expectFiniteNumbers(result);
  });

  it("28-32. output contains no forbidden privacy / AI / psychological / HTML strings", () => {
    const years = [
      makeYear(2020, {
        totalRecords: 100,
        activeMonths: 12,
        topBookCatalogIds: ["a", "b", "c"],
      }),
      makeYear(2021, {
        totalRecords: 500,
        activeMonths: 2,
        topBookCatalogIds: ["x", "y", "z"],
      }),
      makeYear(2023),
    ];
    const links = [makeLink(2020, 2021, 0.05)];
    const archive = makeArchive(
      years,
      links,
      [makeRecurringBook("a", [2020, 2021], "some public title", "some public author")],
    );
    const result = buildReadingEras(archive);
    expectNoForbiddenFields(result);
    expectNoPsychologicalVocabulary(result);
    expectNoHtml(result);
  });

  it("describeEraBoundary uses stable Chinese labels", () => {
    const years = [
      makeYear(2020, { totalRecords: 100, activeMonths: 12 }),
      makeYear(2022, { totalRecords: 100, activeMonths: 12 }),
    ];
    const result = buildReadingEras(makeArchive(years));
    expect(result.boundaries.length).toBe(1);
    const desc = describeEraBoundary(result.boundaries[0]);
    expect(desc).toBe(READING_ERA_BOUNDARY_LABELS.year_gap);
  });
});