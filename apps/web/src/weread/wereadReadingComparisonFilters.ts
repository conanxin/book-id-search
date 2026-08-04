/**
 * S27N — Long-term Reading Comparison Filters (browser-local, pure).
 *
 * Pure-function filters over the in-memory `WereadReadingArchive`.
 * Produces a deterministic snapshot of the currently loaded archive
 * under a set of user-selected filter conditions. NEVER fetches
 * anything, NEVER persists anything, NEVER calls AI.
 *
 * Hard rules:
 *   - All inputs come from the already-loaded `WereadReadingArchive`.
 *     The model never reads `note.text`, `note.comment`, `wereadBookId`,
 *     `noteId`, `highlightId`, `chapterTitle`, AI summary, themes,
 *     token, or any private id.
 *   - No DOM access, no React, no fetch, no storage writes.
 *   - `meta.persisted` is hard-coded to `false`; `meta.source` is
 *     hard-coded to `"current_loaded_archive"`.
 *   - Overlap / recurring / summary classifications are deterministic
 *     and do not infer psychological traits, interest drift, or
 *     reading quality.
 */

import type {
  WereadReadingArchive,
  ReadingArchiveYear,
  ReadingArchiveRecurringBook,
  ReadingArchiveYearLink,
} from "./wereadReadingArchiveModel";

// ---------- public types ----------

export type ReadingComparisonOverlapFilter = "all" | "low" | "medium" | "high";

export type ReadingComparisonMinRecords = 0 | 10 | 25 | 50 | 100;
export type ReadingComparisonMinActiveMonths = 0 | 3 | 6 | 9 | 12;
export type ReadingComparisonRecurringMinYears = 2 | 3 | 4;

export interface ReadingComparisonFilters {
  startYear: number | null;
  endYear: number | null;
  minRecords: ReadingComparisonMinRecords;
  minActiveMonths: ReadingComparisonMinActiveMonths;
  recurringMinYears: ReadingComparisonRecurringMinYears;
  overlap: ReadingComparisonOverlapFilter;
}

export type ReadingComparisonExcludedYearReason =
  | "before_start"
  | "after_end"
  | "records_below_min"
  | "active_months_below_min";

export interface ReadingComparisonExcludedYear {
  year: number;
  reasons: ReadingComparisonExcludedYearReason[];
}

export interface ReadingComparisonYear {
  year: number;
  totalRecords: number;
  datedRecords: number;
  matchedRecords: number;
  matchedBooks: number;
  activeMonths: number;
  longestActiveStreak: number;
  peakMonth: string | null;
  averageRecordsPerActiveMonth: number;
}

export interface ReadingComparisonSummary {
  includedYearCount: number;
  excludedYearCount: number;
  totalRecords: number;
  totalActiveMonths: number;
  averageRecordsPerYear: number;
  earliestYear: number | null;
  latestYear: number | null;
}

export interface ReadingComparisonMeta {
  source: "current_loaded_archive";
  persisted: false;
}

export interface ReadingComparisonResult {
  filters: ReadingComparisonFilters;
  availableYears: number[];
  includedYears: ReadingComparisonYear[];
  excludedYears: ReadingComparisonExcludedYear[];
  recurringBooks: ReadingArchiveRecurringBook[];
  yearLinks: ReadingArchiveYearLink[];
  summary: ReadingComparisonSummary;
  meta: ReadingComparisonMeta;
}

// ---------- constants ----------

export const READING_COMPARISON_MIN_RECORDS_OPTIONS: ReadonlyArray<ReadingComparisonMinRecords> =
  [0, 10, 25, 50, 100];
export const READING_COMPARISON_MIN_ACTIVE_MONTHS_OPTIONS: ReadonlyArray<ReadingComparisonMinActiveMonths> =
  [0, 3, 6, 9, 12];
export const READING_COMPARISON_RECURRING_MIN_YEARS_OPTIONS: ReadonlyArray<ReadingComparisonRecurringMinYears> =
  [2, 3, 4];
export const READING_COMPARISON_OVERLAP_OPTIONS: ReadonlyArray<ReadingComparisonOverlapFilter> =
  ["all", "low", "medium", "high"];
export const READING_COMPARISON_RECURRING_BOOKS_LIMIT = 12;
export const READING_COMPARISON_OVERLAP_LOW_MAX = 0.25;
export const READING_COMPARISON_OVERLAP_MEDIUM_MAX = 0.5;

export const READING_COMPARISON_REASON_LABELS: Readonly<
  Record<ReadingComparisonExcludedYearReason, string>
> = {
  before_start: "早于起始年份",
  after_end: "晚于结束年份",
  records_below_min: "低于最低阅读记录",
  active_months_below_min: "低于最低活跃月份",
};

export const READING_COMPARISON_OVERLAP_LABELS: Readonly<
  Record<ReadingComparisonOverlapFilter, string>
> = {
  all: "全部",
  low: "较低（< 0.25）",
  medium: "中等（0.25 — 0.5）",
  high: "较高（≥ 0.5）",
};

export const READING_COMPARISON_PANEL_NOTICE =
  "筛选只作用于当前浏览器已加载的长期档案，不会重新请求年度数据。" +
  "结果用于比较统计，不代表阅读兴趣、内在状态或阅读质量。";

// ---------- helpers ----------

function ensureFinite(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

function normalizeOverlapRatio(ratio: number): number {
  if (Number.isNaN(ratio)) return 0;
  if (ratio === Infinity) return 1;
  if (ratio === -Infinity) return 0;
  if (ratio < 0) return 0;
  if (ratio > 1) return 1;
  return ratio;
}

export function classifyOverlapRatio(ratio: number): ReadingComparisonOverlapFilter {
  const normalized = normalizeOverlapRatio(ratio);
  if (normalized < READING_COMPARISON_OVERLAP_LOW_MAX) return "low";
  if (normalized < READING_COMPARISON_OVERLAP_MEDIUM_MAX) return "medium";
  return "high";
}

function isValidOverlap(filter: ReadingComparisonOverlapFilter): filter is ReadingComparisonOverlapFilter {
  return READING_COMPARISON_OVERLAP_OPTIONS.includes(filter);
}

function isMinRecords(n: number): n is ReadingComparisonMinRecords {
  return READING_COMPARISON_MIN_RECORDS_OPTIONS.includes(n as ReadingComparisonMinRecords);
}

function isMinActiveMonths(n: number): n is ReadingComparisonMinActiveMonths {
  return READING_COMPARISON_MIN_ACTIVE_MONTHS_OPTIONS.includes(n as ReadingComparisonMinActiveMonths);
}

function isRecurringMinYears(n: number): n is ReadingComparisonRecurringMinYears {
  return READING_COMPARISON_RECURRING_MIN_YEARS_OPTIONS.includes(n as ReadingComparisonRecurringMinYears);
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

// ---------- factory / normalizers ----------

export function createDefaultReadingComparisonFilters(): ReadingComparisonFilters {
  return {
    startYear: null,
    endYear: null,
    minRecords: 0,
    minActiveMonths: 0,
    recurringMinYears: 2,
    overlap: "all",
  };
}

/**
 * Normalize a filter set: ensure numeric fields use the allowed
 * literals, replace NaN with 0 for thresholds, drop invalid overlap.
 */
export function normalizeReadingComparisonFilters(
  filters: Partial<ReadingComparisonFilters>,
): ReadingComparisonFilters {
  const defaults = createDefaultReadingComparisonFilters();
  const minRecords = ensureFinite(
    typeof filters.minRecords === "number" ? filters.minRecords : defaults.minRecords,
  );
  const minActiveMonths = ensureFinite(
    typeof filters.minActiveMonths === "number" ? filters.minActiveMonths : defaults.minActiveMonths,
  );
  const recurringMinYears = ensureFinite(
    typeof filters.recurringMinYears === "number" ? filters.recurringMinYears : defaults.recurringMinYears,
  );
  return {
    startYear:
      typeof filters.startYear === "number" && Number.isFinite(filters.startYear)
        ? Math.round(filters.startYear)
        : null,
    endYear:
      typeof filters.endYear === "number" && Number.isFinite(filters.endYear)
        ? Math.round(filters.endYear)
        : null,
    minRecords: isMinRecords(minRecords) ? minRecords : defaults.minRecords,
    minActiveMonths: isMinActiveMonths(minActiveMonths)
      ? minActiveMonths
      : defaults.minActiveMonths,
    recurringMinYears: isRecurringMinYears(recurringMinYears)
      ? recurringMinYears
      : defaults.recurringMinYears,
    overlap: isValidOverlap(filters.overlap as ReadingComparisonOverlapFilter)
      ? (filters.overlap as ReadingComparisonOverlapFilter)
      : defaults.overlap,
  };
}

/**
 * Normalize the year range: if startYear > endYear, swap them. If a
 * boundary year is not in the available set, snap it to the nearest
 * available year. Returns the normalized { startYear, endYear } in
 * ascending order (or null for an open bound).
 */
export function normalizeComparisonYearRange(args: {
  startYear: number | null;
  endYear: number | null;
  availableYears: ReadonlyArray<number>;
}): { startYear: number | null; endYear: number | null } {
  const available = uniqueSortedAsc(args.availableYears);
  if (available.length === 0) {
    return { startYear: null, endYear: null };
  }

  const snap = (target: number | null): number | null => {
    if (target === null) return null;
    if (available.includes(target)) return target;
    // Snap to nearest available year.
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
  };

  let start = snap(args.startYear);
  let end = snap(args.endYear);

  if (start !== null && end !== null && start > end) {
    const t = start;
    start = end;
    end = t;
  }

  return { startYear: start, endYear: end };
}

// ---------- filtering ----------

function yearRow(year: ReadingArchiveYear): ReadingComparisonYear {
  return {
    year: year.year,
    totalRecords: ensureFinite(year.totalRecords),
    datedRecords: ensureFinite(year.datedRecords),
    matchedRecords: ensureFinite(year.matchedRecords),
    matchedBooks: ensureFinite(year.matchedBooks),
    activeMonths: ensureFinite(year.activeMonths),
    longestActiveStreak: ensureFinite(year.longestStreakMonths),
    peakMonth: year.peakMonth ?? null,
    averageRecordsPerActiveMonth: ensureFinite(year.averageRecordsPerActiveMonth),
  };
}

export function filterReadingComparisonYears(args: {
  archive: WereadReadingArchive;
  filters: ReadingComparisonFilters;
  startYear: number | null;
  endYear: number | null;
  availableYears: number[];
}): { included: ReadingComparisonYear[]; excluded: ReadingComparisonExcludedYear[] } {
  const { archive, filters, startYear, endYear } = args;
  const included: ReadingComparisonYear[] = [];
  const excluded: ReadingComparisonExcludedYear[] = [];

  for (const y of archive.years) {
    const reasons: ReadingComparisonExcludedYearReason[] = [];
    if (startYear !== null && y.year < startYear) reasons.push("before_start");
    if (endYear !== null && y.year > endYear) reasons.push("after_end");
    if (y.totalRecords < filters.minRecords) reasons.push("records_below_min");
    if (y.activeMonths < filters.minActiveMonths) reasons.push("active_months_below_min");

    if (reasons.length === 0) {
      included.push(yearRow(y));
    } else {
      excluded.push({ year: y.year, reasons });
    }
  }

  included.sort((a, b) => a.year - b.year);
  excluded.sort((a, b) => a.year - b.year);

  return { included, excluded };
}

export function filterReadingComparisonRecurringBooks(args: {
  archive: WereadReadingArchive;
  includedYears: ReadonlyArray<ReadingComparisonYear>;
  recurringMinYears: ReadingComparisonRecurringMinYears;
}): ReadingArchiveRecurringBook[] {
  const { archive, includedYears, recurringMinYears } = args;
  if (includedYears.length === 0) return [];

  const includedYearSet = new Set(includedYears.map((y) => y.year));
  const limit = includedYears.length > 0
    ? Math.min(archive.meta.topBooksLimit, READING_COMPARISON_RECURRING_BOOKS_LIMIT)
    : READING_COMPARISON_RECURRING_BOOKS_LIMIT;
  const topN = archive.meta.topBooksLimit;

  // Build a per-catalogId set of years (from included years) when the
  // catalogId appeared in that year's Top N list.
  const yearTopBookIds = new Map<number, Set<string>>();
  for (const y of archive.years) {
    if (!includedYearSet.has(y.year)) continue;
    const ids = new Set<string>(y.topBookCatalogIds.slice(0, topN));
    yearTopBookIds.set(y.year, ids);
  }

  // Count per-catalogId appearance counts and tracking stats.
  const catalogStats = new Map<string, { years: number[]; ranks: { year: number; rank: number }[] }>();
  for (const [year, ids] of yearTopBookIds.entries()) {
    let rank = 0;
    for (const id of ids) {
      rank += 1;
      const stats = catalogStats.get(id) || { years: [], ranks: [] };
      stats.years.push(year);
      stats.ranks.push({ year, rank });
      catalogStats.set(id, stats);
    }
  }

  // Find canonical book metadata from the archive's recurringBooks list
  // when available; otherwise emit stub records from year-level data.
  const canonical = new Map<string, ReadingArchiveRecurringBook>();
  for (const b of archive.recurringBooks) {
    canonical.set(b.catalogId, b);
  }

  const out: ReadingArchiveRecurringBook[] = [];
  for (const [catalogId, stats] of catalogStats.entries()) {
    if (stats.years.length < recurringMinYears) continue;

    const sortedYears = [...stats.years].sort((a, b) => a - b);
    const latestYear = sortedYears[sortedYears.length - 1];
    const bestRank = Math.min(...stats.ranks.map((r) => r.rank));
    const latestRankEntry = stats.ranks
      .filter((r) => r.year === latestYear)
      .sort((a, b) => a.rank - b.rank)[0];

    const base = canonical.get(catalogId);
    out.push({
      catalogId,
      title: base?.title ?? `书目 ${catalogId}`,
      author: base?.author ?? null,
      publisher: base?.publisher ?? null,
      publishYear: base?.publishYear ?? null,
      yearsOnList: sortedYears.length,
      years: sortedYears,
      totalNoteCountWithinLists: base?.totalNoteCountWithinLists ?? 0,
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

  return out.slice(0, limit);
}

export function filterReadingComparisonYearLinks(args: {
  archive: WereadReadingArchive;
  includedYears: ReadonlyArray<ReadingComparisonYear>;
  overlap: ReadingComparisonOverlapFilter;
}): ReadingArchiveYearLink[] {
  const { archive, includedYears, overlap } = args;
  if (includedYears.length === 0) return [];
  const includedYearSet = new Set(includedYears.map((y) => y.year));

  const filterClass = (ratio: number): boolean => {
    const cls = classifyOverlapRatio(ratio);
    if (overlap === "all") return true;
    return cls === overlap;
  };

  const out: ReadingArchiveYearLink[] = [];
  for (const link of archive.yearLinks) {
    if (!includedYearSet.has(link.sourceYear)) continue;
    if (!includedYearSet.has(link.targetYear)) continue;
    if (!filterClass(link.overlapRatio)) continue;
    out.push({
      sourceYear: link.sourceYear,
      targetYear: link.targetYear,
      sharedTopBooks: ensureFinite(link.sharedTopBooks),
      overlapRatio: normalizeOverlapRatio(link.overlapRatio),
    });
  }
  out.sort((a, b) => {
    if (a.sourceYear !== b.sourceYear) return a.sourceYear - b.sourceYear;
    return a.targetYear - b.targetYear;
  });
  return out;
}

function buildSummary(included: ReadonlyArray<ReadingComparisonYear>): ReadingComparisonSummary {
  if (included.length === 0) {
    return {
      includedYearCount: 0,
      excludedYearCount: 0,
      totalRecords: 0,
      totalActiveMonths: 0,
      averageRecordsPerYear: 0,
      earliestYear: null,
      latestYear: null,
    };
  }
  let totalRecords = 0;
  let totalActiveMonths = 0;
  for (const y of included) {
    totalRecords += y.totalRecords;
    totalActiveMonths += y.activeMonths;
  }
  const years = included.map((y) => y.year);
  const earliest = Math.min(...years);
  const latest = Math.max(...years);
  return {
    includedYearCount: included.length,
    excludedYearCount: 0, // patched by caller after excluded list exists
    totalRecords,
    totalActiveMonths,
    averageRecordsPerYear: totalRecords / included.length,
    earliestYear: earliest,
    latestYear: latest,
  };
}

// ---------- public builder ----------

/**
 * Build the deterministic filtered comparison result for the given
 * archive + filters. Pure: never fetches, never persists.
 */
export function buildReadingComparisonResult(
  archive: WereadReadingArchive | null,
  filters: ReadingComparisonFilters,
): ReadingComparisonResult {
  const safeFilters = normalizeReadingComparisonFilters(filters);
  const availableYears = archive
    ? uniqueSortedAsc(archive.years.map((y) => y.year))
    : [];
  const { startYear, endYear } = normalizeComparisonYearRange({
    startYear: safeFilters.startYear,
    endYear: safeFilters.endYear,
    availableYears,
  });

  const empty: ReadingComparisonResult = {
    filters: { ...safeFilters, startYear, endYear },
    availableYears,
    includedYears: [],
    excludedYears: [],
    recurringBooks: [],
    yearLinks: [],
    summary: {
      includedYearCount: 0,
      excludedYearCount: 0,
      totalRecords: 0,
      totalActiveMonths: 0,
      averageRecordsPerYear: 0,
      earliestYear: null,
      latestYear: null,
    },
    meta: {
      source: "current_loaded_archive",
      persisted: false,
    },
  };

  if (!archive || availableYears.length === 0) {
    return empty;
  }

  const { included, excluded } = filterReadingComparisonYears({
    archive,
    filters: safeFilters,
    startYear,
    endYear,
    availableYears,
  });

  const recurringBooks = filterReadingComparisonRecurringBooks({
    archive,
    includedYears: included,
    recurringMinYears: safeFilters.recurringMinYears,
  });

  const yearLinks = filterReadingComparisonYearLinks({
    archive,
    includedYears: included,
    overlap: safeFilters.overlap,
  });

  const summary = buildSummary(included);
  summary.excludedYearCount = excluded.length;

  return {
    filters: { ...safeFilters, startYear, endYear },
    availableYears,
    includedYears: included,
    excludedYears: excluded,
    recurringBooks,
    yearLinks,
    summary,
    meta: {
      source: "current_loaded_archive",
      persisted: false,
    },
  };
}

// ---------- debug snapshot ----------

/**
 * A compact, privacy-safe debug snapshot for logs / smoke outputs.
 * Never includes the original archive JSON, only counts and filters.
 */
export function buildReadingComparisonDebugSnapshot(
  result: ReadingComparisonResult,
): {
  filterKeys: string[];
  availableYearCount: number;
  includedYearCount: number;
  excludedYearCount: number;
  recurringBookCount: number;
  yearLinkCount: number;
} {
  return {
    filterKeys: Object.keys(result.filters),
    availableYearCount: result.availableYears.length,
    includedYearCount: result.summary.includedYearCount,
    excludedYearCount: result.summary.excludedYearCount,
    recurringBookCount: result.recurringBooks.length,
    yearLinkCount: result.yearLinks.length,
  };
}