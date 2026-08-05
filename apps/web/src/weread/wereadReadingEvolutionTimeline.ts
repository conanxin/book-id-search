/**
 * S27P-1 — Reading Evolution Timeline Model (browser-local, pure).
 *
 * Pure-function model that takes the already-loaded
 * `WereadReadingArchive` and produces a deterministic, descriptive
 * timeline view of the user's reading history at the annual level.
 *
 * The model emits:
 *   - `years`: per-year normalised nodes (chronological, ascending).
 *   - `transitions`: adjacent-year metric deltas, top-N book diff, overlap.
 *   - `milestones`: first_year / latest_year / year_gap / statistical_shift.
 *
 * Hard rules (mirrors S27L / S27O / S27P-0B):
 *   - Never reads `note.text`, `note.comment`, `markedText`,
 *     `wereadBookId`, `noteId`, `highlightId`, `chapterTitle`,
 *     `Authorization`, `token=`, AI summary body, themes, or any
 *     private id.
 *   - No DOM, no React, no fetch, no storage writes, no `Date.now()`
 *     inside the algorithm. Results are deterministic for a given input.
 *   - `meta.persisted` is hard-coded to `false`;
 *     `meta.source` is hard-coded to `"current_loaded_archive"`.
 *   - The timeline is descriptive only. The model never infers
 *     reading quality, interest drift, attention, or psychological
 *     traits.
 *   - All numeric outputs are finite — NaN / Infinity are normalised
 *     to safe fallbacks before being emitted.
 *
 * Reuse policy:
 *   - `calculateMetricDelta` is reused verbatim from
 *     `wereadDualPeriodComparison` to keep the delta semantics
 *     identical to the dual-period model. We do NOT re-implement
 *     delta here.
 */

import type { WereadReadingArchive } from "./wereadReadingArchiveModel";
import { calculateMetricDelta } from "./wereadDualPeriodComparison";

// ---------- public types ----------

export type ReadingEvolutionDirection =
  | "increase"
  | "decrease"
  | "same"
  | "from_zero"
  | "to_zero";

export interface ReadingEvolutionMetricDelta {
  absolute: number;
  percentage: number | null;
  direction: ReadingEvolutionDirection;
}

export interface ReadingEvolutionBook {
  catalogId: string;
  title: string;
  author: string | null;
  publisher: string | null;
  publishYear: string | number | null;
  rank: number;
}

export interface ReadingEvolutionYearNode {
  year: number;
  totalRecords: number;
  matchedRecords: number;
  matchedBooks: number;
  activeMonths: number;
  averageRecordsPerActiveMonth: number;
  topBooks: ReadingEvolutionBook[];
}

export interface ReadingEvolutionBookDiff {
  catalogId: string;
  title: string;
  author: string | null;
  publisher: string | null;
  publishYear: string | number | null;
  previousRank: number;
  currentRank: number;
  rankDelta: number;
}

export interface ReadingEvolutionTopListOverlap {
  commonBooks: number;
  unionBooks: number;
  ratio: number;
}

export interface ReadingEvolutionTransition {
  fromYear: number;
  toYear: number;
  metrics: {
    totalRecords: ReadingEvolutionMetricDelta;
    matchedRecords: ReadingEvolutionMetricDelta;
    matchedBooks: ReadingEvolutionMetricDelta;
    activeMonths: ReadingEvolutionMetricDelta;
  };
  topListOverlap: ReadingEvolutionTopListOverlap;
  books: {
    continued: ReadingEvolutionBookDiff[];
    entered: ReadingEvolutionBookDiff[];
    left: ReadingEvolutionBookDiff[];
  };
  reasons: ReadingEvolutionTransitionReason[];
  significanceScore: number;
  significant: boolean;
}

export type ReadingEvolutionTransitionReason =
  | "year_gap"
  | "records_shift"
  | "active_months_shift"
  | "matched_books_shift"
  | "low_top_list_overlap";

export type ReadingEvolutionMilestoneKind =
  | "first_year"
  | "latest_year"
  | "year_gap"
  | "statistical_shift";

export interface ReadingEvolutionMilestone {
  year: number;
  kind: ReadingEvolutionMilestoneKind;
  transitionIndex: number | null;
  reasons: ReadingEvolutionTransitionReason[];
  significanceScore: number;
}

export interface WereadReadingEvolutionTimeline {
  years: ReadingEvolutionYearNode[];
  transitions: ReadingEvolutionTransition[];
  milestones: ReadingEvolutionMilestone[];
  summary: {
    firstYear: number | null;
    latestYear: number | null;
    loadedYearCount: number;
    transitionCount: number;
    significantTransitionCount: number;
    yearGapCount: number;
  };
  meta: {
    source: "current_loaded_archive";
    persisted: false;
  };
}

// ---------- constants ----------

export const READING_EVOLUTION_TOP_BOOKS_LIMIT = 12;

export const READING_EVOLUTION_REASON_SCORES: Readonly<
  Record<ReadingEvolutionTransitionReason, number>
> = {
  year_gap: 100,
  records_shift: 35,
  active_months_shift: 25,
  matched_books_shift: 20,
  low_top_list_overlap: 25,
};

export const READING_EVOLUTION_SIGNIFICANCE_THRESHOLD = 50;

export const READING_EVOLUTION_RECORDS_RATIO_THRESHOLD = 2;
export const READING_EVOLUTION_RECORDS_ABSOLUTE_THRESHOLD = 20;

export const READING_EVOLUTION_ACTIVE_MONTHS_THRESHOLD = 5;

export const READING_EVOLUTION_MATCHED_BOOKS_ABSOLUTE_THRESHOLD = 5;
export const READING_EVOLUTION_MATCHED_BOOKS_RATIO_THRESHOLD = 1.5;

export const READING_EVOLUTION_LOW_OVERLAP_THRESHOLD = 0.2;

export const READING_EVOLUTION_PRIVACY_NOTICE =
  "年度时间线只基于当前浏览器已加载的长期档案，按相邻成功加载年份生成统计与榜单差异，不读取笔记正文，不调用外部 AI，也不会保存到服务器。";

// ---------- helpers ----------

function ensureFinite(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

function clampNonNegative(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  return value;
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function roundOverlap(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 10000) / 10000;
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

function stableTitle(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

// ---------- year node construction ----------

/**
 * Build the chronological per-year node list. Deterministic for a
 * given `archive.years`:
 *   - Years are processed ascending.
 *   - Duplicate year numbers are collapsed; the LAST deterministic
 *     entry from `archive.years` wins (matches the archive model).
 *   - Numeric fields are finite-normalised:
 *       * NaN / Infinity  → 0
 *       * negative values → 0
 *   - topBooks are drawn from the archive's year-level top-N list,
 *     de-duplicated by catalogId, ranked by archive position.
 *     Only public catalog fields are kept.
 */
export function buildReadingEvolutionYearNodes(args: {
  archive: WereadReadingArchive;
}): ReadingEvolutionYearNode[] {
  const archive = args.archive;
  if (!archive || archive.years.length === 0) return [];

  const yearBookMap = new Map<
    number,
    { catalogId: string; title: string; author: string | null; publisher: string | null; publishYear: string | number | null; rank: number }[]
  >();
  // Re-derive books from the archive.years[].topBookCatalogIds and the
  // archive.recurringBooks list (the archive doesn't expose full book
  // objects per year; we look up the canonical public fields from
  // recurringBooks or from the per-year topBooks cache keys).
  const topBooksLimit = archive.meta.topBooksLimit;
  // Build a catalogId → canonical metadata map from recurringBooks
  // (which carries public fields) and from a synthetic fallback.
  const canonicalMeta = new Map<
    string,
    { title: string; author: string | null; publisher: string | null; publishYear: string | number | null }
  >();
  for (const rb of archive.recurringBooks) {
    canonicalMeta.set(rb.catalogId, {
      title: rb.title || `书目 ${rb.catalogId}`,
      author: rb.author ?? null,
      publisher: rb.publisher ?? null,
      publishYear: rb.publishYear ?? null,
    });
  }
  const fallbackTitle = (catalogId: string) => `书目 ${catalogId}`;

  for (const y of archive.years) {
    const ids = y.topBookCatalogIds.slice(0, topBooksLimit);
    const list: { catalogId: string; title: string; author: string | null; publisher: string | null; publishYear: string | number | null; rank: number }[] = [];
    const seen = new Set<string>();
    let rank = 0;
    for (const catalogId of ids) {
      if (!catalogId) continue;
      if (seen.has(catalogId)) continue;
      seen.add(catalogId);
      rank += 1;
      const meta = canonicalMeta.get(catalogId);
      list.push({
        catalogId,
        title: meta?.title ?? fallbackTitle(catalogId),
        author: meta?.author ?? null,
        publisher: meta?.publisher ?? null,
        publishYear: meta?.publishYear ?? null,
        rank,
      });
    }
    yearBookMap.set(y.year, list);
  }

  // Iterate in ascending year order; collapse duplicates (later wins).
  const sortedYears = [...archive.years].sort((a, b) => a.year - b.year);
  const dedup = new Map<number, typeof sortedYears[number]>();
  for (const y of sortedYears) {
    dedup.set(y.year, y); // last wins
  }
  const out: ReadingEvolutionYearNode[] = [];
  for (const [, y] of [...dedup.entries()].sort((a, b) => a[0] - b[0])) {
    const totalRecords = ensureFinite(y.totalRecords);
    const matchedRecords = ensureFinite(y.matchedRecords);
    const matchedBooks = ensureFinite(y.matchedBooks);
    const activeMonths = ensureFinite(y.activeMonths);
    const avg = activeMonths > 0 ? totalRecords / activeMonths : 0;

    out.push({
      year: y.year,
      totalRecords: clampNonNegative(totalRecords),
      matchedRecords: clampNonNegative(matchedRecords),
      matchedBooks: clampNonNegative(matchedBooks),
      activeMonths: clampNonNegative(activeMonths),
      averageRecordsPerActiveMonth: ensureFinite(avg),
      topBooks: yearBookMap.get(y.year) ?? [],
    });
  }
  return out;
}

// ---------- generic delta (re-export wrapper) ----------

/**
 * Re-export wrapper so the timeline module has a single import
 * surface for delta calculation. Internally delegates to
 * `calculateMetricDelta` from the dual-period model so the
 * semantics are guaranteed consistent.
 */
export function calculateReadingEvolutionDelta(
  previous: number,
  current: number,
): ReadingEvolutionMetricDelta {
  const r = calculateMetricDelta(previous, current);
  return {
    absolute: ensureFinite(r.absolute),
    percentage: r.percentage,
    direction: r.direction,
  };
}

// ---------- top-N book diff ----------

/**
 * Compare the Top N book lists of two adjacent years. Returns the
 * three buckets (continued / entered / left) with deterministic
 * ordering and a cap of 12 per bucket.
 *
 *   continued: catalogId in both lists
 *   entered:   catalogId only in `currentBooks`
 *   left:      catalogId only in `previousBooks`
 *
 *   rankDelta = previousRank - currentRank
 *               positive → current rank is numerically smaller (improved)
 *               negative → current rank is numerically larger (worsened)
 *
 * Sorting:
 *   - continued: currentRank asc, previousRank asc, title stable
 *   - entered:   currentRank asc, title stable
 *   - left:      previousRank asc, title stable
 */
export function compareReadingEvolutionTopBooks(args: {
  previousBooks: ReadonlyArray<ReadingEvolutionBook>;
  currentBooks: ReadonlyArray<ReadingEvolutionBook>;
}): {
  continued: ReadingEvolutionBookDiff[];
  entered: ReadingEvolutionBookDiff[];
  left: ReadingEvolutionBookDiff[];
} {
  const previousById = new Map<string, ReadingEvolutionBook>();
  for (const b of args.previousBooks) {
    if (!b.catalogId) continue;
    if (previousById.has(b.catalogId)) continue;
    previousById.set(b.catalogId, b);
  }
  const currentById = new Map<string, ReadingEvolutionBook>();
  for (const b of args.currentBooks) {
    if (!b.catalogId) continue;
    if (currentById.has(b.catalogId)) continue;
    currentById.set(b.catalogId, b);
  }

  const continued: ReadingEvolutionBookDiff[] = [];
  for (const [catalogId, current] of currentById.entries()) {
    const prev = previousById.get(catalogId);
    if (!prev) continue;
    continued.push({
      catalogId,
      title: current.title,
      author: current.author,
      publisher: current.publisher,
      publishYear: current.publishYear,
      previousRank: prev.rank,
      currentRank: current.rank,
      rankDelta: prev.rank - current.rank,
    });
  }
  continued.sort((a, b) => {
    if (a.currentRank !== b.currentRank) return a.currentRank - b.currentRank;
    if (a.previousRank !== b.previousRank) return a.previousRank - b.previousRank;
    return stableTitle(a.title, b.title);
  });

  const entered: ReadingEvolutionBookDiff[] = [];
  for (const [catalogId, current] of currentById.entries()) {
    if (previousById.has(catalogId)) continue;
    entered.push({
      catalogId,
      title: current.title,
      author: current.author,
      publisher: current.publisher,
      publishYear: current.publishYear,
      previousRank: -1,
      currentRank: current.rank,
      rankDelta: -current.rank,
    });
  }
  entered.sort((a, b) => {
    if (a.currentRank !== b.currentRank) return a.currentRank - b.currentRank;
    return stableTitle(a.title, b.title);
  });

  const left: ReadingEvolutionBookDiff[] = [];
  for (const [catalogId, prev] of previousById.entries()) {
    if (currentById.has(catalogId)) continue;
    left.push({
      catalogId,
      title: prev.title,
      author: prev.author,
      publisher: prev.publisher,
      publishYear: prev.publishYear,
      previousRank: prev.rank,
      currentRank: -1,
      rankDelta: prev.rank,
    });
  }
  left.sort((a, b) => {
    if (a.previousRank !== b.previousRank) return a.previousRank - b.previousRank;
    return stableTitle(a.title, b.title);
  });

  return {
    continued: continued.slice(0, READING_EVOLUTION_TOP_BOOKS_LIMIT),
    entered: entered.slice(0, READING_EVOLUTION_TOP_BOOKS_LIMIT),
    left: left.slice(0, READING_EVOLUTION_TOP_BOOKS_LIMIT),
  };
}

// ---------- top list overlap ----------

/**
 * Compute the adjacent-year Top-N overlap ratio. This is the ratio
 * of common catalogIds to union catalogIds, normalised to [0, 1]
 * and rounded to 4 decimal places of internal precision.
 *
 * The function NEVER labels the result as "stable", "changing",
 * "drift", or any psychological term. It only emits the numeric
 * overlap ratio and the supporting counts.
 */
export function calculateReadingEvolutionTopListOverlap(args: {
  previousBooks: ReadonlyArray<ReadingEvolutionBook>;
  currentBooks: ReadonlyArray<ReadingEvolutionBook>;
}): ReadingEvolutionTopListOverlap {
  const previousIds = new Set<string>();
  for (const b of args.previousBooks) {
    if (b.catalogId) previousIds.add(b.catalogId);
  }
  const currentIds = new Set<string>();
  for (const b of args.currentBooks) {
    if (b.catalogId) currentIds.add(b.catalogId);
  }
  if (previousIds.size === 0 && currentIds.size === 0) {
    return { commonBooks: 0, unionBooks: 0, ratio: 0 };
  }
  const union = new Set<string>();
  for (const id of previousIds) union.add(id);
  for (const id of currentIds) union.add(id);
  let common = 0;
  for (const id of previousIds) {
    if (currentIds.has(id)) common += 1;
  }
  const unionSize = union.size;
  const raw = unionSize > 0 ? common / unionSize : 0;
  return {
    commonBooks: common,
    unionBooks: unionSize,
    ratio: roundOverlap(clampUnit(raw)),
  };
}

// ---------- transition reasons ----------

function ratioSafe(a: number, b: number): number {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  if (lo <= 0) return Number.POSITIVE_INFINITY;
  return hi / lo;
}

function hasNumericGap(previous: number, current: number): number {
  return current - previous;
}

/**
 * Evaluate which transition reasons apply between two adjacent year
 * nodes. Each reason is checked against the spec thresholds:
 *
 *   year_gap:
 *     toYear - fromYear > 1
 *
 *   records_shift:
 *     max(prev,cur) / max(1, min(prev,cur)) >= 2
 *     AND |cur - prev| >= 20
 *
 *   active_months_shift:
 *     |cur - prev| >= 5
 *
 *   matched_books_shift:
 *     |cur - prev| >= 5
 *     AND max(prev,cur) / max(1, min(prev,cur)) >= 1.5
 *
 *   low_top_list_overlap:
 *     previous topBooks non-empty
 *     AND current topBooks non-empty
 *     AND overlapRatio < 0.2
 */
export function evaluateTransitionReasons(args: {
  fromYear: number;
  toYear: number;
  previous: ReadingEvolutionYearNode;
  current: ReadingEvolutionYearNode;
  overlapRatio: number;
}): ReadingEvolutionTransitionReason[] {
  const reasons: ReadingEvolutionTransitionReason[] = [];

  if (args.toYear - args.fromYear > 1) {
    reasons.push("year_gap");
  }

  const prevRec = args.previous.totalRecords;
  const curRec = args.current.totalRecords;
  if (
    ratioSafe(prevRec, curRec) >= READING_EVOLUTION_RECORDS_RATIO_THRESHOLD &&
    Math.abs(hasNumericGap(prevRec, curRec)) >= READING_EVOLUTION_RECORDS_ABSOLUTE_THRESHOLD
  ) {
    reasons.push("records_shift");
  }

  if (
    Math.abs(hasNumericGap(args.previous.activeMonths, args.current.activeMonths)) >=
    READING_EVOLUTION_ACTIVE_MONTHS_THRESHOLD
  ) {
    reasons.push("active_months_shift");
  }

  const prevMb = args.previous.matchedBooks;
  const curMb = args.current.matchedBooks;
  if (
    Math.abs(hasNumericGap(prevMb, curMb)) >=
      READING_EVOLUTION_MATCHED_BOOKS_ABSOLUTE_THRESHOLD &&
    ratioSafe(prevMb, curMb) >= READING_EVOLUTION_MATCHED_BOOKS_RATIO_THRESHOLD
  ) {
    reasons.push("matched_books_shift");
  }

  if (
    args.previous.topBooks.length > 0 &&
    args.current.topBooks.length > 0 &&
    args.overlapRatio < READING_EVOLUTION_LOW_OVERLAP_THRESHOLD
  ) {
    reasons.push("low_top_list_overlap");
  }

  return reasons;
}

// ---------- significance score ----------

/**
 * Sum the per-reason scores. `year_gap` is always significant.
 * Otherwise the transition is significant iff the score >= 50.
 */
export function calculateSignificanceScore(
  reasons: ReadonlyArray<ReadingEvolutionTransitionReason>,
): { score: number; significant: boolean } {
  let score = 0;
  for (const r of reasons) {
    score += READING_EVOLUTION_REASON_SCORES[r];
  }
  const hasGap = reasons.includes("year_gap");
  const significant = hasGap || score >= READING_EVOLUTION_SIGNIFICANCE_THRESHOLD;
  return { score, significant };
}

// ---------- milestones ----------

/**
 * Build the milestone list:
 *   - Always includes `first_year` and `latest_year` when there is
 *     at least one year.
 *   - Single-year case: `first_year` and `latest_year` collapse
 *     into a single milestone with kind=first_year (no synthetic
 *     transition).
 *   - For each significant transition:
 *       year_gap            → milestone year=toYear, kind=year_gap
 *       statistical_shift   → milestone year=toYear, kind=statistical_shift
 *   - Sort: year asc, then first_year, year_gap, statistical_shift, latest_year.
 *   - De-duplicate by (year, kind).
 */
export function buildReadingEvolutionMilestones(args: {
  yearNodes: ReadonlyArray<ReadingEvolutionYearNode>;
  transitions: ReadonlyArray<ReadingEvolutionTransition>;
}): ReadingEvolutionMilestone[] {
  const milestones: ReadingEvolutionMilestone[] = [];
  if (args.yearNodes.length === 0) return milestones;

  const firstYear = args.yearNodes[0].year;
  const lastYear = args.yearNodes[args.yearNodes.length - 1].year;

  if (args.yearNodes.length === 1) {
    milestones.push({
      year: firstYear,
      kind: "first_year",
      transitionIndex: null,
      reasons: [],
      significanceScore: 0,
    });
    return milestones;
  }

  milestones.push({
    year: firstYear,
    kind: "first_year",
    transitionIndex: null,
    reasons: [],
    significanceScore: 0,
  });

  for (let i = 0; i < args.transitions.length; i += 1) {
    const t = args.transitions[i];
    if (!t.significant) continue;
    const kind: ReadingEvolutionMilestoneKind = t.reasons.includes("year_gap")
      ? "year_gap"
      : "statistical_shift";
    milestones.push({
      year: t.toYear,
      kind,
      transitionIndex: i,
      reasons: [...t.reasons],
      significanceScore: t.significanceScore,
    });
  }

  milestones.push({
    year: lastYear,
    kind: "latest_year",
    transitionIndex: null,
    reasons: [],
    significanceScore: 0,
  });

  const kindOrder: Record<ReadingEvolutionMilestoneKind, number> = {
    first_year: 0,
    year_gap: 1,
    statistical_shift: 2,
    latest_year: 3,
  };
  milestones.sort((a, b) => {
    if (a.year !== b.year) return a.year - b.year;
    return kindOrder[a.kind] - kindOrder[b.kind];
  });

  // Dedup by (year, kind).
  const seen = new Set<string>();
  const out: ReadingEvolutionMilestone[] = [];
  for (const m of milestones) {
    const key = `${m.year}:${m.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(m);
  }
  return out;
}

// ---------- transition building ----------

function buildTransition(args: {
  fromYear: number;
  toYear: number;
  previous: ReadingEvolutionYearNode;
  current: ReadingEvolutionYearNode;
}): ReadingEvolutionTransition {
  const overlap = calculateReadingEvolutionTopListOverlap({
    previousBooks: args.previous.topBooks,
    currentBooks: args.current.topBooks,
  });
  const books = compareReadingEvolutionTopBooks({
    previousBooks: args.previous.topBooks,
    currentBooks: args.current.topBooks,
  });
  const reasons = evaluateTransitionReasons({
    fromYear: args.fromYear,
    toYear: args.toYear,
    previous: args.previous,
    current: args.current,
    overlapRatio: overlap.ratio,
  });
  const { score, significant } = calculateSignificanceScore(reasons);
  return {
    fromYear: args.fromYear,
    toYear: args.toYear,
    metrics: {
      totalRecords: calculateReadingEvolutionDelta(
        args.previous.totalRecords,
        args.current.totalRecords,
      ),
      matchedRecords: calculateReadingEvolutionDelta(
        args.previous.matchedRecords,
        args.current.matchedRecords,
      ),
      matchedBooks: calculateReadingEvolutionDelta(
        args.previous.matchedBooks,
        args.current.matchedBooks,
      ),
      activeMonths: calculateReadingEvolutionDelta(
        args.previous.activeMonths,
        args.current.activeMonths,
      ),
    },
    topListOverlap: overlap,
    books,
    reasons,
    significanceScore: score,
    significant,
  };
}

// ---------- main entry point ----------

/**
 * Build the deterministic Reading Evolution Timeline. Pure: never
 * fetches, never persists, never calls AI.
 *
 * Empty archive returns an empty timeline with all counters at 0.
 * Single-year archive returns 1 year node, 0 transitions, 1 milestone.
 */
export function buildWereadReadingEvolutionTimeline(args: {
  archive: WereadReadingArchive | null;
}): WereadReadingEvolutionTimeline {
  const archive = args.archive;
  if (!archive || archive.years.length === 0) {
    return {
      years: [],
      transitions: [],
      milestones: [],
      summary: {
        firstYear: null,
        latestYear: null,
        loadedYearCount: 0,
        transitionCount: 0,
        significantTransitionCount: 0,
        yearGapCount: 0,
      },
      meta: {
        source: "current_loaded_archive",
        persisted: false,
      },
    };
  }

  const yearNodes = buildReadingEvolutionYearNodes({ archive });
  const transitions: ReadingEvolutionTransition[] = [];
  let yearGapCount = 0;
  for (let i = 0; i < yearNodes.length - 1; i += 1) {
    const prev = yearNodes[i];
    const cur = yearNodes[i + 1];
    const t = buildTransition({
      fromYear: prev.year,
      toYear: cur.year,
      previous: prev,
      current: cur,
    });
    transitions.push(t);
    if (t.reasons.includes("year_gap")) yearGapCount += 1;
  }
  const milestones = buildReadingEvolutionMilestones({
    yearNodes,
    transitions,
  });

  const firstYear = yearNodes.length > 0 ? yearNodes[0].year : null;
  const latestYear =
    yearNodes.length > 0 ? yearNodes[yearNodes.length - 1].year : null;
  const significantTransitionCount = transitions.filter((t) => t.significant).length;

  return {
    years: yearNodes,
    transitions,
    milestones,
    summary: {
      firstYear,
      latestYear,
      loadedYearCount: yearNodes.length,
      transitionCount: transitions.length,
      significantTransitionCount,
      yearGapCount,
    },
    meta: {
      source: "current_loaded_archive",
      persisted: false,
    },
  };
}

// ---------- debug snapshot ----------

/**
 * Privacy-safe debug snapshot. Counts and identifiers only. Never
 * includes title, author, catalogId, records detail, token, raw
 * archive, or any request/cache info.
 */
export function buildReadingEvolutionDebugSnapshot(
  timeline: WereadReadingEvolutionTimeline,
): {
  yearCount: number;
  yearNumbers: number[];
  transitionCount: number;
  milestoneCount: number;
  milestoneKinds: ReadingEvolutionMilestoneKind[];
  reasons: ReadingEvolutionTransitionReason[];
  significanceScores: number[];
  persisted: boolean;
} {
  const yearNumbers = uniqueSortedAsc(timeline.years.map((y) => y.year));
  const milestoneKinds: ReadingEvolutionMilestoneKind[] = timeline.milestones.map(
    (m) => m.kind,
  );
  const reasons: ReadingEvolutionTransitionReason[] = [];
  const significanceScores: number[] = [];
  for (const t of timeline.transitions) {
    for (const r of t.reasons) {
      if (!reasons.includes(r)) reasons.push(r);
    }
    significanceScores.push(t.significanceScore);
  }
  return {
    yearCount: timeline.years.length,
    yearNumbers,
    transitionCount: timeline.transitions.length,
    milestoneCount: timeline.milestones.length,
    milestoneKinds,
    reasons,
    significanceScores,
    persisted: false,
  };
}

// ---------- privacy scan helpers ----------

export const READING_EVOLUTION_FORBIDDEN_TOKENS: ReadonlyArray<string> = [
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

export const READING_EVOLUTION_FORBIDDEN_PSYCHOLOGICAL_WORDS: ReadonlyArray<string> = [
  "心理",
  "兴趣",
  "人格",
  "质量",
  "成长",
  "退步",
  "改善",
  "提升",
  "稳定",
  "变化",
  "巅峰",
  "低谷",
  "成熟期",
  "探索期",
  "转折点",
  "阅读质量",
  "阅读低谷",
  "阅读巅峰",
  "能力变化",
  "偏好改变",
];
