/**
 * S27O-1 — Dual-period Reading Comparison Model (browser-local, pure).
 *
 * Pure-function comparison between two user-defined time windows
 * (Period A and Period B) drawn from the in-memory
 * `WereadReadingArchive`. The module emits a deterministic snapshot
 * describing both windows and the descriptive delta between them.
 * It NEVER fetches anything, NEVER persists anything, NEVER calls AI.
 *
 * Hard rules:
 *   - All inputs come from the already-loaded `WereadReadingArchive`.
 *     The model never reads `note.text`, `note.comment`,
 *     `wereadBookId`, `noteId`, `highlightId`, `chapterTitle`,
 *     AI summary, themes, token, or any private id.
 *   - No DOM access, no React, no fetch, no storage writes.
 *   - `meta.persisted` is hard-coded to `false`; `meta.source` is
 *     hard-coded to `"current_loaded_archive"`.
 *   - The comparison is descriptive only. The module never outputs
 *     text that infers reading quality, interest drift, attention,
 *     or psychological traits.
 *   - All numeric outputs are finite — NaN / Infinity are normalized
 *     to safe fallbacks before being emitted.
 */

import type {
  WereadReadingArchive,
  ReadingArchiveYear,
  ReadingArchiveRecurringBook,
  ReadingArchiveYearLink,
} from "./wereadReadingArchiveModel";

// ---------- public types ----------

export interface ReadingPeriod {
  startYear: number;
  endYear: number;
}

export interface DualPeriodMetrics {
  years: number[];
  totalRecords: number;
  totalActiveMonths: number;
  matchedRecords: number;
  matchedBooks: number;
  averageRecordsPerYear: number;
  averageRecordsPerActiveMonth: number;
  longestActiveStreak: number;
  peakYear: number | null;
  peakYearRecords: number;
}

export type MetricDeltaDirection =
  | "increase"
  | "decrease"
  | "same"
  | "from_zero"
  | "to_zero";

export interface MetricDelta {
  absolute: number;
  percentage: number | null;
  direction: MetricDeltaDirection;
}

export interface DualPeriodRecurringDiff {
  entered: ReadingArchiveRecurringBook[];
  left: ReadingArchiveRecurringBook[];
  continued: ReadingArchiveRecurringBook[];
}

export interface DualPeriodOverlap {
  average: number;
  comparablePairs: number;
}

export interface DualPeriodComparisonMeta {
  source: "current_loaded_archive";
  persisted: false;
}

export interface DualPeriodComparisonResult {
  periodA: {
    range: ReadingPeriod;
    metrics: DualPeriodMetrics;
  };
  periodB: {
    range: ReadingPeriod;
    metrics: DualPeriodMetrics;
  };
  delta: {
    totalRecords: MetricDelta;
    activeMonths: MetricDelta;
    matchedRecords: MetricDelta;
    matchedBooks: MetricDelta;
    averageRecords: MetricDelta;
  };
  recurringBooks: DualPeriodRecurringDiff;
  overlap: DualPeriodOverlap;
  meta: DualPeriodComparisonMeta;
}

// ---------- constants ----------

export const DUAL_PERIOD_RECURRING_BOOKS_LIMIT = 12;
export const DUAL_PERIOD_RECURRING_MIN_YEARS_DEFAULT = 2;

export const DUAL_PERIOD_DIRECTION_LABELS: Readonly<
  Record<MetricDeltaDirection, string>
> = {
  increase: "增加",
  decrease: "减少",
  same: "持平",
  from_zero: "由零起",
  to_zero: "归零",
};

export const DUAL_PERIOD_PRIVACY_NOTICE =
  "双时间段比较只基于当前浏览器已加载的长期档案，按两个时间窗分别汇总阅读统计与榜单重合，不读取笔记正文，不调用外部 AI，也不会保存到服务器。";

// ---------- helpers ----------

function ensureFinite(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

function clampNonNegative(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  return value;
}

function normalizeOverlapRatio(ratio: number): number {
  if (Number.isNaN(ratio)) return 0;
  if (ratio === Infinity) return 1;
  if (ratio === -Infinity) return 0;
  if (ratio < 0) return 0;
  if (ratio > 1) return 1;
  return ratio;
}

function uniqueSortedAsc(years: ReadonlyArray<number>): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const y of years) {
    if (!Number.isInteger(y)) continue;
    if (seen.has(y)) continue;
    seen.add(y);
    out.push(y);
  }
  out.sort((a, b) => a - b);
  return out;
}

function snapToAvailable(
  target: number,
  available: ReadonlyArray<number>,
): number | null {
  if (available.length === 0) return null;
  if (available.includes(target)) return target;
  let best = available[0];
  let bestDiff = Math.abs(target - best);
  for (const y of available) {
    const diff = Math.abs(target - y);
    if (diff < bestDiff) {
      best = y;
      bestDiff = diff;
    }
  }
  return best;
}

// ---------- period normalization ----------

/**
 * Normalize a Period definition. Swap start/end if reversed, snap any
 * out-of-range year to the nearest available year. If the available
 * set is empty, returns a degenerate period at the original years
 * (caller is expected to short-circuit on empty archive).
 */
export function normalizeReadingPeriod(args: {
  startYear: number;
  endYear: number;
  availableYears: ReadonlyArray<number>;
}): ReadingPeriod {
  const available = uniqueSortedAsc(args.availableYears);
  if (available.length === 0) {
    return {
      startYear: args.startYear,
      endYear: args.endYear,
    };
  }
  let start = snapToAvailable(args.startYear, available);
  let end = snapToAvailable(args.endYear, available);
  if (start === null || end === null) {
    return { startYear: available[0], endYear: available[available.length - 1] };
  }
  if (start > end) {
    const t = start;
    start = end;
    end = t;
  }
  return { startYear: start, endYear: end };
}

// ---------- period metrics ----------

/**
 * Longest consecutive-year streak inside the period. Uses the same
 * rule as the archive overview: consecutive year numbers are exactly
 * +1 apart; ties on zero-records years break the streak.
 */
function longestStreakWithinPeriod(years: ReadonlyArray<ReadingArchiveYear>): number {
  if (years.length === 0) return 0;
  const sorted = [...years].sort((a, b) => a.year - b.year);
  let best = 0;
  let current = 0;
  let prev: number | null = null;
  for (const y of sorted) {
    if (y.totalRecords <= 0) {
      current = 0;
      prev = y.year;
      continue;
    }
    if (prev === null) {
      current = 1;
    } else if (y.year === prev + 1) {
      current += 1;
    } else {
      current = 1;
    }
    if (current > best) best = current;
    prev = y.year;
  }
  return best;
}

function pickPeakYear(years: ReadonlyArray<ReadingArchiveYear>): {
  peakYear: number | null;
  peakYearRecords: number;
} {
  let peakYear: number | null = null;
  let peakYearRecords = 0;
  for (const y of years) {
    if (y.totalRecords <= 0) continue;
    if (peakYear === null) {
      peakYear = y.year;
      peakYearRecords = y.totalRecords;
      continue;
    }
    if (
      y.totalRecords > peakYearRecords ||
      (y.totalRecords === peakYearRecords && y.year < peakYear)
    ) {
      peakYear = y.year;
      peakYearRecords = y.totalRecords;
    }
  }
  return { peakYear, peakYearRecords };
}

/**
 * Build the metrics for a single period. Only years that fall inside
 * the period contribute. Empty period returns zero metrics with an
 * empty years array. All numeric outputs are finite.
 */
export function buildPeriodMetrics(args: {
  archive: WereadReadingArchive;
  period: ReadingPeriod;
}): DualPeriodMetrics {
  const { archive, period } = args;
  if (archive.years.length === 0) {
    return {
      years: [],
      totalRecords: 0,
      totalActiveMonths: 0,
      matchedRecords: 0,
      matchedBooks: 0,
      averageRecordsPerYear: 0,
      averageRecordsPerActiveMonth: 0,
      longestActiveStreak: 0,
      peakYear: null,
      peakYearRecords: 0,
    };
  }

  const inPeriod = archive.years
    .filter((y) => y.year >= period.startYear && y.year <= period.endYear)
    .sort((a, b) => a.year - b.year);

  if (inPeriod.length === 0) {
    return {
      years: [],
      totalRecords: 0,
      totalActiveMonths: 0,
      matchedRecords: 0,
      matchedBooks: 0,
      averageRecordsPerYear: 0,
      averageRecordsPerActiveMonth: 0,
      longestActiveStreak: 0,
      peakYear: null,
      peakYearRecords: 0,
    };
  }

  let totalRecords = 0;
  let totalActiveMonths = 0;
  let matchedRecords = 0;
  let matchedBooks = 0;
  for (const y of inPeriod) {
    totalRecords += ensureFinite(y.totalRecords);
    totalActiveMonths += ensureFinite(y.activeMonths);
    matchedRecords += ensureFinite(y.matchedRecords);
    matchedBooks += ensureFinite(y.matchedBooks);
  }

  const years = inPeriod.map((y) => y.year);
  const averageRecordsPerYear = totalRecords / inPeriod.length;
  const averageRecordsPerActiveMonth =
    totalActiveMonths > 0 ? totalRecords / totalActiveMonths : 0;
  const longestActiveStreak = longestStreakWithinPeriod(inPeriod);
  const { peakYear, peakYearRecords } = pickPeakYear(inPeriod);

  return {
    years,
    totalRecords,
    totalActiveMonths,
    matchedRecords,
    matchedBooks,
    averageRecordsPerYear: ensureFinite(averageRecordsPerYear),
    averageRecordsPerActiveMonth: ensureFinite(averageRecordsPerActiveMonth),
    longestActiveStreak,
    peakYear,
    peakYearRecords: ensureFinite(peakYearRecords),
  };
}

// ---------- delta calculation ----------

function roundToOneDecimal(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 10) / 10;
}

/**
 * Compute the descriptive delta from period A to period B.
 *   absolute = B - A
 *   percentage = (B - A) / A * 100  (when A > 0; null for from_zero)
 *
 * Direction tags:
 *   - "from_zero" : A = 0, B > 0 (no percentage baseline)
 *   - "to_zero"   : A > 0, B = 0 (percentage fixed at -100)
 *   - "increase"  : B > A
 *   - "decrease"  : B < A
 *   - "same"      : A === B  (percentage = 0 when A > 0)
 *
 * All outputs are finite numbers (no NaN, no Infinity).
 */
export function calculateMetricDelta(
  periodAValue: number,
  periodBValue: number,
): MetricDelta {
  const a = ensureFinite(periodAValue);
  const b = ensureFinite(periodBValue);
  const absolute = b - a;

  if (a === 0 && b === 0) {
    return {
      absolute: 0,
      percentage: 0,
      direction: "same",
    };
  }
  if (a === 0 && b > 0) {
    return {
      absolute,
      percentage: null,
      direction: "from_zero",
    };
  }
  if (a > 0 && b === 0) {
    return {
      absolute,
      percentage: -100,
      direction: "to_zero",
    };
  }

  const rawPercentage = ((b - a) / a) * 100;
  const percentage = roundToOneDecimal(rawPercentage);
  if (b > a) {
    return { absolute, percentage, direction: "increase" };
  }
  if (b < a) {
    return { absolute, percentage, direction: "decrease" };
  }
  return { absolute: 0, percentage: 0, direction: "same" };
}

// ---------- recurring books diff ----------

function pickCanonicalFromArchive(
  archive: WereadReadingArchive,
  catalogId: string,
): {
  title: string;
  author: string | null;
  publisher: string | null;
  publishYear: string | number | null;
} {
  const found = archive.recurringBooks.find((b) => b.catalogId === catalogId);
  if (found) {
    return {
      title: found.title,
      author: found.author ?? null,
      publisher: found.publisher ?? null,
      publishYear: found.publishYear ?? null,
    };
  }
  // Fallback: search per-year topBooks for canonical public fields.
  for (const y of archive.years) {
    const match = y.topBookCatalogIds.includes(catalogId);
    if (!match) continue;
    // We don't have direct book objects here; leave nulls for the
    // caller to fill in. Returning the catalogId as a placeholder title
    // is acceptable (mirrors the archive-model fallback).
    if (found) break;
  }
  return {
    title: `书目 ${catalogId}`,
    author: null,
    publisher: null,
    publishYear: null,
  };
}

/**
 * Compute the recurring-book diff between two periods.
 *   - continued: in both
 *   - entered:   only in B
 *   - left:      only in A
 * Each book is described by public catalog fields only. Sorted:
 *   - continued: yearsOnList desc → bestRank asc → latestYear desc → title
 *   - entered:   by B-period appearanceCount desc → bestRank asc
 *   - left:      by A-period appearanceCount desc → bestRank asc
 * All three lists are capped at `DUAL_PERIOD_RECURRING_BOOKS_LIMIT`.
 */
export function compareRecurringBooks(args: {
  archive: WereadReadingArchive;
  periodA: ReadingPeriod;
  periodB: ReadingPeriod;
  recurringMinYears?: number;
}): DualPeriodRecurringDiff {
  const minYears =
    typeof args.recurringMinYears === "number" && args.recurringMinYears > 0
      ? Math.floor(args.recurringMinYears)
      : DUAL_PERIOD_RECURRING_MIN_YEARS_DEFAULT;

  const recurringInPeriod = (period: ReadingPeriod): ReadingArchiveRecurringBook[] => {
    const topN = args.archive.meta.topBooksLimit;
    const inPeriodYears = args.archive.years.filter(
      (y) => y.year >= period.startYear && y.year <= period.endYear,
    );
    if (inPeriodYears.length === 0) return [];

    const yearIds = new Map<number, Set<string>>();
    for (const y of inPeriodYears) {
      yearIds.set(
        y.year,
        new Set(y.topBookCatalogIds.slice(0, topN)),
      );
    }

    const stats = new Map<
      string,
      { years: number[]; ranks: { year: number; rank: number }[] }
    >();
    for (const [year, ids] of yearIds.entries()) {
      let rank = 0;
      for (const id of ids) {
        rank += 1;
        const entry = stats.get(id) || { years: [], ranks: [] };
        entry.years.push(year);
        entry.ranks.push({ year, rank });
        stats.set(id, entry);
      }
    }

    const out: ReadingArchiveRecurringBook[] = [];
    for (const [catalogId, entry] of stats.entries()) {
      if (entry.years.length < minYears) continue;
      const sortedYears = [...entry.years].sort((a, b) => a - b);
      const latestYear = sortedYears[sortedYears.length - 1];
      const bestRank = Math.min(...entry.ranks.map((r) => r.rank));
      const latestRankEntry = entry.ranks
        .filter((r) => r.year === latestYear)
        .sort((a, b) => a.rank - b.rank)[0];

      const canonical = pickCanonicalFromArchive(args.archive, catalogId);
      out.push({
        catalogId,
        title: canonical.title,
        author: canonical.author,
        publisher: canonical.publisher,
        publishYear: canonical.publishYear,
        years: sortedYears,
        yearsOnList: sortedYears.length,
        totalNoteCountWithinLists: 0,
        bestRank,
        latestYear,
        latestRank: latestRankEntry ? latestRankEntry.rank : bestRank,
      });
    }

    out.sort((a, b) => {
      if (a.yearsOnList !== b.yearsOnList) return b.yearsOnList - a.yearsOnList;
      if (a.bestRank !== b.bestRank) return a.bestRank - b.bestRank;
      if (a.latestYear !== b.latestYear) return b.latestYear - a.latestYear;
      return a.title < b.title ? -1 : a.title > b.title ? 1 : 0;
    });

    return out.slice(0, DUAL_PERIOD_RECURRING_BOOKS_LIMIT);
  };

  const aList = recurringInPeriod(args.periodA);
  const bList = recurringInPeriod(args.periodB);

  const aIds = new Set(aList.map((b) => b.catalogId));
  const bIds = new Set(bList.map((b) => b.catalogId));

  const byIdB = new Map(bList.map((b) => [b.catalogId, b]));
  const byIdA = new Map(aList.map((b) => [b.catalogId, b]));

  const continued: ReadingArchiveRecurringBook[] = [];
  for (const id of aIds) {
    if (!bIds.has(id)) continue;
    const aBook = byIdA.get(id);
    const bBook = byIdB.get(id);
    if (!aBook || !bBook) continue;
    continued.push({
      catalogId: id,
      title: aBook.title,
      author: aBook.author,
      publisher: aBook.publisher,
      publishYear: aBook.publishYear,
      years: [...aBook.years, ...bBook.years.filter((y) => !aBook.years.includes(y))].sort(
        (x, y) => x - y,
      ),
      yearsOnList: new Set([...aBook.years, ...bBook.years]).size,
      totalNoteCountWithinLists:
        aBook.totalNoteCountWithinLists + bBook.totalNoteCountWithinLists,
      bestRank: Math.min(aBook.bestRank, bBook.bestRank),
      latestYear: Math.max(aBook.latestYear, bBook.latestYear),
      latestRank:
        aBook.latestYear >= bBook.latestYear ? aBook.latestRank : bBook.latestRank,
    });
  }
  continued.sort((a, b) => {
    if (a.yearsOnList !== b.yearsOnList) return b.yearsOnList - a.yearsOnList;
    if (a.bestRank !== b.bestRank) return a.bestRank - b.bestRank;
    if (a.latestYear !== b.latestYear) return b.latestYear - a.latestYear;
    return a.title < b.title ? -1 : a.title > b.title ? 1 : 0;
  });
  const continuedCapped = continued.slice(0, DUAL_PERIOD_RECURRING_BOOKS_LIMIT);

  const entered: ReadingArchiveRecurringBook[] = bList
    .filter((b) => !aIds.has(b.catalogId))
    .slice(0, DUAL_PERIOD_RECURRING_BOOKS_LIMIT);

  const left: ReadingArchiveRecurringBook[] = aList
    .filter((b) => !bIds.has(b.catalogId))
    .slice(0, DUAL_PERIOD_RECURRING_BOOKS_LIMIT);

  return { continued: continuedCapped, entered, left };
}

// ---------- period overlap ----------

function overlapRatiosInPeriod(args: {
  archive: WereadReadingArchive;
  period: ReadingPeriod;
}): number[] {
  const inPeriodSet = new Set<number>();
  for (const y of args.archive.years) {
    if (y.year >= args.period.startYear && y.year <= args.period.endYear) {
      inPeriodSet.add(y.year);
    }
  }
  const ratios: number[] = [];
  for (const link of args.archive.yearLinks) {
    if (!inPeriodSet.has(link.sourceYear)) continue;
    if (!inPeriodSet.has(link.targetYear)) continue;
    ratios.push(normalizeOverlapRatio(link.overlapRatio));
  }
  return ratios;
}

/**
 * Compare the internal adjacent-year overlap ratio of two periods.
 * Returns the average ratio across comparable adjacent pairs found
 * inside each period, plus the comparable pair count. Both fields
 * are guaranteed finite (NaN → 0, <0 → 0, >1 → 1).
 *
 * The function never labels the result as "stable" or "changing" —
 * only as the period-A and period-B average overlap ratio.
 */
export function comparePeriodOverlap(args: {
  archive: WereadReadingArchive;
  periodA: ReadingPeriod;
  periodB: ReadingPeriod;
}): DualPeriodOverlap {
  const aRatios = overlapRatiosInPeriod({
    archive: args.archive,
    period: args.periodA,
  });
  const bRatios = overlapRatiosInPeriod({
    archive: args.archive,
    period: args.periodB,
  });
  const all = [...aRatios, ...bRatios];
  if (all.length === 0) {
    return { average: 0, comparablePairs: 0 };
  }
  let sum = 0;
  for (const r of all) sum += clampNonNegative(r);
  const avg = sum / all.length;
  return {
    average: roundToOneDecimal(ensureFinite(avg)),
    comparablePairs: all.length,
  };
}

// ---------- public builder ----------

/**
 * Build the deterministic dual-period comparison snapshot. Pure:
 * never fetches, never persists. Both periods are normalized so that
 * `startYear <= endYear` and both ends lie inside `availableYears`.
 */
export function buildDualPeriodComparisonResult(args: {
  archive: WereadReadingArchive | null;
  periodA: ReadingPeriod;
  periodB: ReadingPeriod;
  recurringMinYears?: number;
}): DualPeriodComparisonResult {
  const archive = args.archive;

  if (!archive || archive.years.length === 0) {
    return buildEmptyDualPeriodComparison({
      periodA: args.periodA,
      periodB: args.periodB,
    });
  }

  const availableYears = uniqueSortedAsc(archive.years.map((y) => y.year));
  const periodA = normalizeReadingPeriod({
    startYear: args.periodA.startYear,
    endYear: args.periodA.endYear,
    availableYears,
  });
  const periodB = normalizeReadingPeriod({
    startYear: args.periodB.startYear,
    endYear: args.periodB.endYear,
    availableYears,
  });

  const metricsA = buildPeriodMetrics({ archive, period: periodA });
  const metricsB = buildPeriodMetrics({ archive, period: periodB });

  const recurringBooks = compareRecurringBooks({
    archive,
    periodA,
    periodB,
    recurringMinYears: args.recurringMinYears,
  });
  const overlap = comparePeriodOverlap({ archive, periodA, periodB });

  return {
    periodA: { range: periodA, metrics: metricsA },
    periodB: { range: periodB, metrics: metricsB },
    delta: {
      totalRecords: calculateMetricDelta(metricsA.totalRecords, metricsB.totalRecords),
      activeMonths: calculateMetricDelta(
        metricsA.totalActiveMonths,
        metricsB.totalActiveMonths,
      ),
      matchedRecords: calculateMetricDelta(
        metricsA.matchedRecords,
        metricsB.matchedRecords,
      ),
      matchedBooks: calculateMetricDelta(metricsA.matchedBooks, metricsB.matchedBooks),
      averageRecords: calculateMetricDelta(
        metricsA.averageRecordsPerYear,
        metricsB.averageRecordsPerYear,
      ),
    },
    recurringBooks,
    overlap,
    meta: {
      source: "current_loaded_archive",
      persisted: false,
    },
  };
}

function buildEmptyDualPeriodComparison(args: {
  periodA: ReadingPeriod;
  periodB: ReadingPeriod;
}): DualPeriodComparisonResult {
  const emptyMetrics: DualPeriodMetrics = {
    years: [],
    totalRecords: 0,
    totalActiveMonths: 0,
    matchedRecords: 0,
    matchedBooks: 0,
    averageRecordsPerYear: 0,
    averageRecordsPerActiveMonth: 0,
    longestActiveStreak: 0,
    peakYear: null,
    peakYearRecords: 0,
  };
  return {
    periodA: { range: args.periodA, metrics: emptyMetrics },
    periodB: { range: args.periodB, metrics: emptyMetrics },
    delta: {
      totalRecords: calculateMetricDelta(0, 0),
      activeMonths: calculateMetricDelta(0, 0),
      matchedRecords: calculateMetricDelta(0, 0),
      matchedBooks: calculateMetricDelta(0, 0),
      averageRecords: calculateMetricDelta(0, 0),
    },
    recurringBooks: { entered: [], left: [], continued: [] },
    overlap: { average: 0, comparablePairs: 0 },
    meta: {
      source: "current_loaded_archive",
      persisted: false,
    },
  };
}

// ---------- debug snapshot ----------

/**
 * Compact, privacy-safe debug snapshot. Counts and identifiers only.
 * Never includes the raw archive JSON or any note / comment fields.
 */
export function buildDualPeriodComparisonDebugSnapshot(result: DualPeriodComparisonResult): {
  periodA: { startYear: number; endYear: number; yearCount: number };
  periodB: { startYear: number; endYear: number; yearCount: number };
  deltaKeys: string[];
  recurringCounts: { entered: number; left: number; continued: number };
  overlap: { average: number; comparablePairs: number };
} {
  return {
    periodA: {
      startYear: result.periodA.range.startYear,
      endYear: result.periodA.range.endYear,
      yearCount: result.periodA.metrics.years.length,
    },
    periodB: {
      startYear: result.periodB.range.startYear,
      endYear: result.periodB.range.endYear,
      yearCount: result.periodB.metrics.years.length,
    },
    deltaKeys: Object.keys(result.delta),
    recurringCounts: {
      entered: result.recurringBooks.entered.length,
      left: result.recurringBooks.left.length,
      continued: result.recurringBooks.continued.length,
    },
    overlap: {
      average: result.overlap.average,
      comparablePairs: result.overlap.comparablePairs,
    },
  };
}

// ---------- privacy scan ----------

/**
 * Forbidden tokens / phrases that must never appear in the model
 * output. Kept as a helper so the test file can scan the source text
 * as well as the runtime result.
 */
export const DUAL_PERIOD_FORBIDDEN_TOKENS: ReadonlyArray<string> = [
  "note.text",
  "note.comment",
  "markedText",
  "wereadBookId",
  "noteId",
  "highlightId",
  "chapterTitle",
  "authorization",
  "token=",
  "ai summary",
  "themes",
  "fetch",
  "localStorage",
  "sessionStorage",
  "indexedDB",
];

export const DUAL_PERIOD_FORBIDDEN_PSYCHOLOGICAL_WORDS: ReadonlyArray<string> = [
  "心理",
  "兴趣",
  "人格",
  "质量",
  "成长",
  "退步",
  "稳定",
  "变化",
  "巅峰",
  "低谷",
  "成熟期",
  "探索期",
];