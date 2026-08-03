/**
 * S27L — Pure helpers for the private WeRead "long-term reading
 * archive index" workspace.
 *
 * Strict privacy contract (mirrors S27H / S27I / S27J / S27K):
 *   - These helpers NEVER read note text, note comment, private book id,
 *     noteId, highlightId, chapterTitle, AI summary body, token,
 *     or any private id.
 *   - They consume ONLY the public catalog fields returned by the
 *     `/api/private/weread/annual-review` endpoint (catalogId,
 *     title, author, publisher, publishYear, counts, dates).
 *   - All math runs in pure functions: no `Date.now()` inside the
 *     algorithm, no React, no DOM, no network calls. Results are
 *     fully serialisable objects that the dashboard maps onto JSX.
 *   - Persisted flag is hard-coded to `false` to make sure no caller
 *     ever writes the archive result anywhere.
 *
 * What this module produces:
 *   - `WereadReadingArchive` describes a long-term reading archive
 *     derived from multiple annual-review responses: per-year
 *     statistics, archive overview, recurring topBooks across
 *     years, and adjacent-year overlap links.
 *   - Descriptive `formatArchive*` helpers render deterministic
 *     rule-based text. They never guess about psychological traits,
 *     reading quality, or interest shifts.
 */

import type {
  WereadAnnualReviewBook,
  WereadAnnualReviewResponse,
  WereadAnnualReviewTopBooksOption,
} from "../wereadPrivate";

// ---------- public types ----------

export type ReadingArchiveSortKey =
  | "yearAsc"
  | "yearDesc"
  | "topBooksAsc"
  | "topBooksDesc";

export interface ReadingArchiveYear {
  year: number;
  totalRecords: number;
  datedRecords: number;
  matchedRecords: number;
  matchedBooks: number;
  activeMonths: number;
  longestStreakMonths: number;
  peakMonth: string | null;
  peakMonthRecords: number;
  averageRecordsPerActiveMonth: number;
  topBookCount: number;
  topBookCatalogIds: string[];
}

export interface ReadingArchiveRecurringBook {
  catalogId: string;
  title: string;
  author?: string | null;
  publisher?: string | null;
  publishYear?: string | number | null;
  yearsOnList: number;
  years: number[];
  totalNoteCountWithinLists: number;
  bestRank: number;
  latestYear: number;
  latestRank: number;
}

export interface ReadingArchiveYearLink {
  sourceYear: number;
  targetYear: number;
  sharedTopBooks: number;
  overlapRatio: number;
}

export interface ReadingArchiveOverview {
  yearsWithData: number;
  firstYear: number | null;
  latestYear: number | null;
  totalRecords: number;
  totalActiveMonths: number;
  averageRecordsPerYear: number;
  mostActiveYear: number | null;
  mostActiveYearRecords: number;
  longestActiveYearStreak: number;
  recurringTopBooks: number;
}

export interface ReadingArchiveMeta {
  requestedYears: number;
  loadedYears: number;
  topBooksLimit: 6 | 12 | 18;
  maxYears: number;
  persisted: false;
  source: "annual-review-cache";
}

export interface WereadReadingArchive {
  years: ReadingArchiveYear[];
  overview: ReadingArchiveOverview;
  recurringBooks: ReadingArchiveRecurringBook[];
  yearLinks: ReadingArchiveYearLink[];
  meta: ReadingArchiveMeta;
}

// ---------- constants ----------

export const READING_ARCHIVE_MAX_YEARS = 20;

export const READING_ARCHIVE_RANGE_OPTIONS = [
  { value: "recent5", label: "最近 5 年", count: 5 },
  { value: "recent10", label: "最近 10 年", count: 10 },
  { value: "all", label: "全部（最多 20 年）", count: READING_ARCHIVE_MAX_YEARS },
] as const;

export type ReadingArchiveRangeValue =
  (typeof READING_ARCHIVE_RANGE_OPTIONS)[number]["value"];

export const READING_ARCHIVE_TOP_BOOKS_OPTIONS: ReadonlyArray<WereadAnnualReviewTopBooksOption> = [6, 12, 18];

export const DEFAULT_READING_ARCHIVE_RANGE: ReadingArchiveRangeValue = "recent5";
export const DEFAULT_READING_ARCHIVE_TOP_BOOKS: WereadAnnualReviewTopBooksOption = 12;
export const DEFAULT_READING_ARCHIVE_RECURRING_LIMIT = 12;

const PRIVACY_DISCLAIMER =
  "长期档案仅复用各年度的日期、数量和已确认公共书目统计，不读取笔记正文，不调用外部 AI，也不会保存到服务器。";

const TOP_N_SCOPE_DISCLAIMER =
  "多年重复书目和年度榜单重合只基于当前 Top N 范围。";

const RECURRING_SCOPE_NOTE =
  "这里只统计各年度当前 Top N 榜单，不代表全部阅读历史，也不推断阅读偏好。";

const OVERLAP_SCOPE_NOTE =
  "榜单重合只描述公共书目榜单交集，不表示阅读兴趣的稳定或改变，也不代表阅读质量。";

// ---------- year normalization ----------

/**
 * Deduplicate and sort `availableYears` descending. Years that are not
 * integers or fall outside [2000, current+1] are filtered out. Returns
 * a stable array — the input order is irrelevant.
 */
export function normalizeArchiveYears(years: ReadonlyArray<number>): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const y of years) {
    if (!Number.isInteger(y)) continue;
    if (y < 2000) continue;
    if (y > 9999) continue;
    if (seen.has(y)) continue;
    seen.add(y);
    out.push(y);
  }
  out.sort((a, b) => b - a);
  return out;
}

/**
 * Pick the year slice to load based on the user's range selection.
 * Always clamps to `READING_ARCHIVE_MAX_YEARS`. If the slice would be
 * empty, returns an empty array.
 */
export function pickArchiveYearSlice(args: {
  availableYears: ReadonlyArray<number>;
  range: ReadingArchiveRangeValue;
}): number[] {
  const sorted = normalizeArchiveYears(args.availableYears);
  const opt = READING_ARCHIVE_RANGE_OPTIONS.find((o) => o.value === args.range);
  const limit = opt?.count ?? READING_ARCHIVE_MAX_YEARS;
  const clamped = Math.max(0, Math.min(READING_ARCHIVE_MAX_YEARS, limit));
  return sorted.slice(0, clamped);
}

/**
 * Build the per-year archive row for a single annual-review response.
 * Returns a fresh object — never mutates the input.
 */
export function buildReadingArchiveYear(
  response: WereadAnnualReviewResponse
): ReadingArchiveYear {
  const o = response.overview;
  const topBooks = Array.isArray(response.topBooks) ? response.topBooks : [];
  const topBookCatalogIds: string[] = [];
  const seen = new Set<string>();
  for (const b of topBooks) {
    if (!b.catalogId) continue;
    if (seen.has(b.catalogId)) continue;
    seen.add(b.catalogId);
    topBookCatalogIds.push(b.catalogId);
  }
  return {
    year: response.selectedYear,
    totalRecords: o.totalRecords,
    datedRecords: o.datedRecords,
    matchedRecords: o.matchedRecords,
    matchedBooks: o.matchedBooks,
    activeMonths: o.activeMonths,
    longestStreakMonths: o.longestStreakMonths,
    peakMonth: o.peakMonth,
    peakMonthRecords: o.peakMonthRecords,
    averageRecordsPerActiveMonth: o.averageRecordsPerActiveMonth,
    topBookCount: topBookCatalogIds.length,
    topBookCatalogIds,
  };
}

/**
 * Build the list of per-year rows. Each response's `selectedYear` is
 * the canonical key. If the same year appears twice the last one
 * wins. Years are sorted ascending (oldest to newest) so the trend
 * chart can render chronologically.
 */
export function buildReadingArchiveYears(args: {
  responses: ReadonlyArray<WereadAnnualReviewResponse>;
}): ReadingArchiveYear[] {
  const byYear = new Map<number, WereadAnnualReviewResponse>();
  for (const r of args.responses) {
    if (!r || typeof r.selectedYear !== "number") continue;
    byYear.set(r.selectedYear, r);
  }
  const out: ReadingArchiveYear[] = [];
  for (const r of byYear.values()) {
    out.push(buildReadingArchiveYear(r));
  }
  out.sort((a, b) => a.year - b.year);
  return out;
}

// ---------- helpers ----------

/**
 * Determine which years actually carry data (totalRecords > 0). Years
 * with zero records are still listed in `years` but excluded from
 * `yearsWithData`, `mostActiveYear`, and `longestActiveYearStreak`.
 */
function yearsWithData(years: ReadonlyArray<ReadingArchiveYear>): ReadingArchiveYear[] {
  return years.filter((y) => y.totalRecords > 0);
}

// ---------- streak ----------

/**
 * Compute the longest consecutive run of calendar years that carry
 * data. Consecutive here means the year numbers are exactly +1 apart
 * (e.g. 2021 / 2022 / 2023 → 3; 2021 / 2023 → 1). Years with no
 * records break the streak. Returns 0 for an empty list.
 */
export function calculateActiveYearStreak(
  years: ReadonlyArray<ReadingArchiveYear>
): number {
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

// ---------- most active year ----------

/**
 * Find the year with the most totalRecords. On ties, returns the
 * earlier year (the spec rule — earlier wins). Returns null when no
 * year carries data.
 */
export function findMostActiveArchiveYear(
  years: ReadonlyArray<ReadingArchiveYear>
): ReadingArchiveYear | null {
  let best: ReadingArchiveYear | null = null;
  for (const y of years) {
    if (y.totalRecords <= 0) continue;
    if (best === null) {
      best = y;
      continue;
    }
    if (y.totalRecords > best.totalRecords) {
      best = y;
    } else if (y.totalRecords === best.totalRecords && y.year < best.year) {
      best = y;
    }
  }
  return best;
}

// ---------- overview ----------

/**
 * Build the archive overview metrics from the per-year rows. All
 * counters here are aggregations across the loaded year slice — never
 * invent years that were not requested. Returns `null` for first /
 * latest / most-active when no year carries data.
 */
export function buildReadingArchiveOverview(args: {
  years: ReadonlyArray<ReadingArchiveYear>;
}): ReadingArchiveOverview {
  const dataYears = yearsWithData(args.years);
  const totalRecords = dataYears.reduce((acc, y) => acc + y.totalRecords, 0);
  const totalActiveMonths = dataYears.reduce((acc, y) => acc + y.activeMonths, 0);
  const yearsWithDataCount = dataYears.length;
  const averageRecordsPerYear =
    yearsWithDataCount > 0 ? totalRecords / yearsWithDataCount : 0;

  let firstYear: number | null = null;
  let latestYear: number | null = null;
  if (dataYears.length > 0) {
    const sorted = [...dataYears].sort((a, b) => a.year - b.year);
    firstYear = sorted[0].year;
    latestYear = sorted[sorted.length - 1].year;
  }

  const mostActive = findMostActiveArchiveYear(dataYears);
  const streak = calculateActiveYearStreak(args.years);

  // recurringTopBooks count: filled by the dashboard (it needs the
  // recurringBooks list). We default to 0 here so the pure helper
  // stays self-contained — the dashboard fills it in after computing
  // `recurringBooks`.
  return {
    yearsWithData: yearsWithDataCount,
    firstYear,
    latestYear,
    totalRecords,
    totalActiveMonths,
    averageRecordsPerYear,
    mostActiveYear: mostActive ? mostActive.year : null,
    mostActiveYearRecords: mostActive ? mostActive.totalRecords : 0,
    longestActiveYearStreak: streak,
    recurringTopBooks: 0,
  };
}

// ---------- recurring books ----------

interface RecurringBookAccumulator {
  catalogId: string;
  title: string;
  author?: string | null;
  publisher?: string | null;
  publishYear?: string | number | null;
  yearMeta: Map<number, WereadAnnualReviewBook>;
}

function indexTopBooksByCatalogId(
  books: ReadonlyArray<WereadAnnualReviewBook>
): Map<string, WereadAnnualReviewBook> {
  const map = new Map<string, WereadAnnualReviewBook>();
  for (const b of books) {
    if (!b.catalogId) continue;
    if (map.has(b.catalogId)) continue;
    map.set(b.catalogId, b);
  }
  return map;
}

/**
 * Walk every year's `topBooks`, collect catalog ids that appear in at
 * least 2 distinct years, and emit the deterministic descriptor. The
 * returned list is sorted by:
 *   1. yearsOnList DESC
 *   2. totalNoteCountWithinLists DESC
 *   3. latestYear DESC
 *   4. bestRank ASC
 *   5. catalogId ASC (stable tiebreaker)
 */
export function buildRecurringArchiveBooks(args: {
  responses: ReadonlyArray<WereadAnnualReviewResponse>;
  limit?: number;
}): ReadingArchiveRecurringBook[] {
  const limit =
    typeof args.limit === "number" && args.limit > 0
      ? Math.floor(args.limit)
      : DEFAULT_READING_ARCHIVE_RECURRING_LIMIT;

  // For each year we need (catalogId -> book meta + rank). We use the
  // position-in-array to compute rank (1-based).
  const yearBooks = new Map<number, WereadAnnualReviewBook[]>();
  for (const r of args.responses) {
    if (!r || typeof r.selectedYear !== "number") continue;
    yearBooks.set(r.selectedYear, Array.isArray(r.topBooks) ? r.topBooks : []);
  }

  const accum = new Map<string, RecurringBookAccumulator>();
  for (const [year, books] of yearBooks) {
    const yearIdx = indexTopBooksByCatalogId(books);
    for (const [catalogId, book] of yearIdx) {
      let entry = accum.get(catalogId);
      if (!entry) {
        entry = {
          catalogId,
          title: "",
          author: null,
          publisher: null,
          publishYear: null,
          yearMeta: new Map(),
        };
        accum.set(catalogId, entry);
      }
      entry.yearMeta.set(year, book);
    }
  }

  const recurring: ReadingArchiveRecurringBook[] = [];
  for (const entry of accum.values()) {
    const years = Array.from(entry.yearMeta.keys()).sort((a, b) => a - b);
    if (years.length < 2) continue; // spec: at least 2 years to qualify

    // Refresh public metadata preferring the latest year first, then
    // falling back to older years. We iterate latest → earliest and
    // only fill in fields when the current value is missing.
    const isEmpty = (v: unknown): boolean => {
      if (v === null || v === undefined) return true;
      if (typeof v === "string" && v.trim().length === 0) return true;
      return false;
    };
    for (let i = years.length - 1; i >= 0; i -= 1) {
      const book = entry.yearMeta.get(years[i]);
      if (!book) continue;
      const candidateTitle = pickString(book.title);
      if (isEmpty(entry.title) && candidateTitle) entry.title = candidateTitle;
      const candidateAuthor = book.author ?? null;
      if (isEmpty(entry.author) && !isEmpty(candidateAuthor)) entry.author = candidateAuthor;
      const candidatePublisher = book.publisher ?? null;
      if (isEmpty(entry.publisher) && !isEmpty(candidatePublisher)) entry.publisher = candidatePublisher;
      const candidatePublishYear = book.publishYear ?? null;
      if (isEmpty(entry.publishYear) && !isEmpty(candidatePublishYear)) {
        entry.publishYear = candidatePublishYear;
      }
    }

    let totalNoteCountWithinLists = 0;
    let bestRank = Number.POSITIVE_INFINITY;
    let latestYear = Number.NEGATIVE_INFINITY;
    let latestRank = Number.POSITIVE_INFINITY;
    for (const year of years) {
      const books = yearBooks.get(year) ?? [];
      const rank = rankOf(books, entry.catalogId);
      if (rank === null) continue;
      const book = entry.yearMeta.get(year);
      if (!book) continue;
      totalNoteCountWithinLists += book.noteCount;
      if (rank < bestRank) bestRank = rank;
      if (year > latestYear || (year === latestYear && rank < latestRank)) {
        latestYear = year;
        latestRank = rank;
      }
    }
    if (!Number.isFinite(bestRank)) continue;
    if (!Number.isFinite(latestYear)) continue;
    if (!Number.isFinite(latestRank)) latestRank = bestRank;

    recurring.push({
      catalogId: entry.catalogId,
      title: entry.title || entry.catalogId,
      author: entry.author ?? null,
      publisher: entry.publisher ?? null,
      publishYear: entry.publishYear ?? null,
      yearsOnList: years.length,
      years,
      totalNoteCountWithinLists,
      bestRank,
      latestYear,
      latestRank,
    });
  }

  recurring.sort((a, b) => {
    if (b.yearsOnList !== a.yearsOnList) return b.yearsOnList - a.yearsOnList;
    if (b.totalNoteCountWithinLists !== a.totalNoteCountWithinLists) {
      return b.totalNoteCountWithinLists - a.totalNoteCountWithinLists;
    }
    if (b.latestYear !== a.latestYear) return b.latestYear - a.latestYear;
    if (a.bestRank !== b.bestRank) return a.bestRank - b.bestRank;
    return a.catalogId < b.catalogId ? -1 : a.catalogId > b.catalogId ? 1 : 0;
  });

  return recurring.slice(0, limit);
}

function rankOf(
  books: ReadonlyArray<WereadAnnualReviewBook>,
  catalogId: string
): number | null {
  const idx = books.findIndex((b) => b.catalogId === catalogId);
  return idx === -1 ? null : idx + 1;
}

function pickString(...candidates: Array<string | null | undefined>): string {
  for (const c of candidates) {
    if (typeof c === "string" && c.trim().length > 0) return c;
  }
  return "";
}

// ---------- adjacent-year overlap ----------

/**
 * Build the adjacent-year overlap links. We only ever compare a year
 * to its immediate chronological neighbour that carries data — we
 * never compare arbitrary pairs (that would inflate the table and
 * is explicitly disallowed by the spec).
 *
 *   sourceYear = older year, targetYear = newer year
 *
 *   sharedTopBooks = |topBooks(source) ∩ topBooks(target)|
 *   overlapRatio   = shared / |topBooks(source) ∪ topBooks(target)|
 *                    (0 when both lists are empty)
 */
export function buildArchiveYearLinks(args: {
  responses: ReadonlyArray<WereadAnnualReviewResponse>;
}): ReadingArchiveYearLink[] {
  const sorted = [...args.responses]
    .filter((r) => r && typeof r.selectedYear === "number")
    .sort((a, b) => a.selectedYear - b.selectedYear);

  const links: ReadingArchiveYearLink[] = [];
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const source = sorted[i];
    const target = sorted[i + 1];
    const sourceIds = new Set<string>();
    const targetIds = new Set<string>();
    for (const b of source.topBooks) {
      if (b.catalogId) sourceIds.add(b.catalogId);
    }
    for (const b of target.topBooks) {
      if (b.catalogId) targetIds.add(b.catalogId);
    }
    const intersection = new Set<string>();
    for (const id of sourceIds) {
      if (targetIds.has(id)) intersection.add(id);
    }
    const union = new Set<string>();
    for (const id of sourceIds) union.add(id);
    for (const id of targetIds) union.add(id);
    const shared = intersection.size;
    const unionSize = union.size;
    const overlapRatio = unionSize > 0 ? shared / unionSize : 0;
    links.push({
      sourceYear: source.selectedYear,
      targetYear: target.selectedYear,
      sharedTopBooks: shared,
      overlapRatio: clampUnit(overlapRatio),
    });
  }
  return links;
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

// ---------- main entry point ----------

export interface BuildWereadReadingArchiveArgs {
  responses: ReadonlyArray<WereadAnnualReviewResponse>;
  requestedYears: number;
  topBooksLimit: WereadAnnualReviewTopBooksOption;
  recurringLimit?: number;
}

export function buildWereadReadingArchive(
  args: BuildWereadReadingArchiveArgs
): WereadReadingArchive {
  const years = buildReadingArchiveYears({ responses: args.responses });
  const overview = buildReadingArchiveOverview({ years });
  const recurringBooks = buildRecurringArchiveBooks({
    responses: args.responses,
    limit: args.recurringLimit,
  });
  const yearLinks = buildArchiveYearLinks({ responses: args.responses });
  overview.recurringTopBooks = recurringBooks.length;
  const loadedYears = args.responses.filter((r) => r && typeof r.selectedYear === "number").length;
  return {
    years,
    overview,
    recurringBooks,
    yearLinks,
    meta: {
      requestedYears: Math.max(0, Math.floor(args.requestedYears)),
      loadedYears,
      topBooksLimit: args.topBooksLimit,
      maxYears: READING_ARCHIVE_MAX_YEARS,
      persisted: false,
      source: "annual-review-cache",
    },
  };
}

// ---------- helpers ----------

export function hasReadingArchiveData(
  archive: WereadReadingArchive | null | undefined
): boolean {
  if (!archive) return false;
  if (archive.years.length === 0) return false;
  return archive.overview.totalRecords > 0 || archive.recurringBooks.length > 0;
}

// ---------- formatters ----------

export function formatArchiveYearRange(args: {
  firstYear: number | null;
  latestYear: number | null;
}): string {
  if (args.firstYear === null && args.latestYear === null) return "—";
  if (args.firstYear !== null && args.latestYear !== null) {
    if (args.firstYear === args.latestYear) return `${args.firstYear} 年`;
    return `${args.firstYear}–${args.latestYear} 年`;
  }
  return `${args.firstYear ?? args.latestYear} 年`;
}

export function formatArchiveOverview(archive: WereadReadingArchive): string {
  const o = archive.overview;
  if (o.yearsWithData === 0) return "暂无长期档案数据。";
  const range = formatArchiveYearRange({
    firstYear: o.firstYear,
    latestYear: o.latestYear,
  });
  return `共 ${o.yearsWithData} 个有数据年份（${range}），阅读记录合计 ${o.totalRecords.toLocaleString("zh-CN")} 条。`;
}

export function formatArchiveOverlap(overlap: number): string {
  if (!Number.isFinite(overlap)) return "0%";
  const ratio = clampUnit(overlap);
  const pct = ratio * 100;
  const rounded = Math.round(pct * 10) / 10;
  const body = Number.isInteger(rounded) ? `${rounded.toFixed(0)}` : `${rounded.toFixed(1)}`;
  return `${body}%`;
}

export function getArchivePrivacyDisclaimer(): string {
  return PRIVACY_DISCLAIMER;
}

export function getArchiveTopNScopeNotice(): string {
  return TOP_N_SCOPE_DISCLAIMER;
}

export function getArchiveRecurringScopeNote(): string {
  return RECURRING_SCOPE_NOTE;
}

export function getArchiveOverlapScopeNote(): string {
  return OVERLAP_SCOPE_NOTE;
}
