/**
 * S27M — Reading Era Segmentation (browser-local, pure function).
 *
 * Pure-function segmentation of the in-memory WereadReadingArchive
 * into chronological reading eras. Era boundaries are computed only
 * from adjacent-year statistical deltas (year gap, totalRecords
 * ratio + absolute diff, activeMonths diff, Top N overlap) — never
 * from book titles, authors, themes, or any psychological inference.
 *
 * Hard rules:
 *   - Pure: never fetches, never persists, never reads note text /
 *     note comment / private IDs / AI summary bodies.
 *   - Deterministic: same input → same output (sorted years, fixed
 *     scoring, fixed tie-breaks).
 *   - No HTML strings, no rendering, no DOM access.
 *   - Catalog IDs from `archive.recurringBooks` are surfaced only
 *     as IDs; titles/authors are kept (they are public metadata)
 *     but the component layer must never treat them as
 *     psychological signals.
 */

import type {
  WereadReadingArchive,
  ReadingArchiveYear,
  ReadingArchiveRecurringBook,
  ReadingArchiveYearLink,
} from "./wereadReadingArchiveModel";

// ---------- public types ----------

export type ReadingEraBoundaryReason =
  | "year_gap"
  | "activity_shift"
  | "active_month_shift"
  | "top_list_shift";

export type ReadingEraSegmentationMode = "automatic" | "gaps_only";

export interface ReadingEraYearProfile {
  year: number;
  totalRecords: number;
  activeMonths: number;
  matchedRecords: number;
  matchedBooks: number;
  topBookCatalogIds: string[];
}

export interface ReadingEraBoundary {
  /** The year immediately before the gap. */
  afterYear: number;
  /** The year immediately after the gap. */
  beforeYear: number;
  /** Total boundary score (sum of reason weights). */
  score: number;
  /** Reasons contributing to the score. */
  reasons: ReadingEraBoundaryReason[];
}

export interface ReadingEra {
  id: string;
  startYear: number;
  endYear: number;
  years: number[];
  totalRecords: number;
  totalActiveMonths: number;
  averageRecordsPerYear: number;
  peakYear: number | null;
  peakYearRecords: number;
  /** Recurring books within THIS era only (catalogId appears in ≥ 2
   *  era years' Top N). Capped at 6. */
  recurringBooks: ReadingArchiveRecurringBook[];
  /** The boundary that ended this era (if any). null for the final era. */
  boundaryBefore: ReadingEraBoundary | null;
}

export interface WereadReadingEraResult {
  eras: ReadingEra[];
  boundaries: ReadingEraBoundary[];
  meta: {
    yearsUsed: number;
    erasReturned: number;
    mode: ReadingEraSegmentationMode;
    persisted: false;
  };
}

// ---------- constants ----------

export const READING_ERA_REASON_WEIGHTS: Readonly<Record<ReadingEraBoundaryReason, number>> = {
  year_gap: 100,
  activity_shift: 35,
  active_month_shift: 25,
  top_list_shift: 25,
};

export const READING_ERA_AUTOMATIC_THRESHOLD = 50;
export const READING_ERA_ACTIVITY_RATIO = 2;
export const READING_ERA_ACTIVITY_DIFF = 20;
export const READING_ERA_ACTIVE_MONTHS_DIFF = 5;
export const READING_ERA_OVERLAP_RATIO = 0.2;
export const READING_ERA_RECURRING_BOOKS_LIMIT = 6;

// ---------- helpers ----------

function ensureFinite(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

function sortByYearAsc<T extends { year: number }>(arr: ReadonlyArray<T>): T[] {
  return [...arr].sort((a, b) => a.year - b.year);
}

function buildYearIndex(
  years: ReadonlyArray<ReadingArchiveYear>,
): Map<number, ReadingArchiveYear> {
  const idx = new Map<number, ReadingArchiveYear>();
  for (const y of years) idx.set(y.year, y);
  return idx;
}

function buildYearLinksIndex(
  links: ReadonlyArray<ReadingArchiveYearLink>,
): Map<string, ReadingArchiveYearLink> {
  const idx = new Map<string, ReadingArchiveYearLink>();
  for (const l of links) idx.set(`${l.sourceYear}->${l.targetYear}`, l);
  return idx;
}

function lookupOverlap(
  links: Map<string, ReadingArchiveYearLink>,
  sourceYear: number,
  targetYear: number,
): ReadingArchiveYearLink | null {
  return links.get(`${sourceYear}->${targetYear}`) ?? null;
}

// ---------- boundary detection ----------

interface RawBoundary {
  afterYear: number;
  beforeYear: number;
  reasons: ReadingEraBoundaryReason[];
}

/**
 * Compute raw boundaries between adjacent archive years. Always
 * includes year_gap. Other reasons contribute by their heuristic.
 * Pure: depends only on the year list and links; order-stable.
 */
export function detectEraBoundaries(
  years: ReadonlyArray<ReadingArchiveYear>,
  links: ReadonlyArray<ReadingArchiveYearLink>,
): RawBoundary[] {
  const sorted = sortByYearAsc(years);
  if (sorted.length < 2) return [];
  const linkIdx = buildYearLinksIndex(links);

  const out: RawBoundary[] = [];
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const base = sorted[i];
    const target = sorted[i + 1];
    const reasons: ReadingEraBoundaryReason[] = [];

    // (1) year_gap — always a boundary when consecutive years are
    // missing in the archive.
    if (target.year - base.year > 1) {
      reasons.push("year_gap");
    }

    // (2) activity_shift — requires BOTH a 2× ratio AND an absolute
    // difference of at least 20 records. Both gates prevent tiny
    // archives from being split by 1-vs-2 records.
    const baseTotal = ensureFinite(base.totalRecords);
    const targetTotal = ensureFinite(target.totalRecords);
    const maxTotal = Math.max(baseTotal, targetTotal);
    const minTotal = Math.max(1, Math.min(baseTotal, targetTotal));
    const ratio = maxTotal / minTotal;
    const absDiff = Math.abs(targetTotal - baseTotal);
    if (ratio >= READING_ERA_ACTIVITY_RATIO && absDiff >= READING_ERA_ACTIVITY_DIFF) {
      reasons.push("activity_shift");
    }

    // (3) active_month_shift — absolute drop or jump ≥ 5 active months.
    const baseMonths = ensureFinite(base.activeMonths);
    const targetMonths = ensureFinite(target.activeMonths);
    if (Math.abs(targetMonths - baseMonths) >= READING_ERA_ACTIVE_MONTHS_DIFF) {
      reasons.push("active_month_shift");
    }

    // (4) top_list_shift — overlap below 0.2 AND both Top N lists non-empty.
    const link = lookupOverlap(linkIdx, base.year, target.year);
    const baseTopN = base.topBookCatalogIds.length;
    const targetTopN = target.topBookCatalogIds.length;
    if (
      link &&
      baseTopN > 0 &&
      targetTopN > 0 &&
      link.overlapRatio < READING_ERA_OVERLAP_RATIO
    ) {
      reasons.push("top_list_shift");
    }

    if (reasons.length > 0) {
      out.push({ afterYear: base.year, beforeYear: target.year, reasons });
    }
  }
  return out;
}

/**
 * Convert raw boundaries into scored boundaries. year_gap reasons
 * score 100, others apply their weight. A boundary is "active"
 * (kept) in automatic mode if year_gap is present OR the total
 * score meets READING_ERA_AUTOMATIC_THRESHOLD. In gaps_only mode,
 * only year_gap boundaries are kept.
 */
export function finalizeEraBoundaries(
  raw: ReadonlyArray<RawBoundary>,
  mode: ReadingEraSegmentationMode,
): ReadingEraBoundary[] {
  const out: ReadingEraBoundary[] = [];
  for (const r of raw) {
    const score = r.reasons.reduce(
      (acc, reason) => acc + READING_ERA_REASON_WEIGHTS[reason],
      0,
    );
    const keep =
      mode === "gaps_only"
        ? r.reasons.includes("year_gap")
        : r.reasons.includes("year_gap") ||
          score >= READING_ERA_AUTOMATIC_THRESHOLD;
    if (keep) {
      out.push({
        afterYear: r.afterYear,
        beforeYear: r.beforeYear,
        score,
        reasons: [...r.reasons],
      });
    }
  }
  return out;
}

// ---------- era segmentation ----------

interface RawEra {
  startYear: number;
  endYear: number;
  years: number[];
  boundaryBefore: ReadingEraBoundary | null;
}

/**
 * Split sorted years into raw eras using kept boundaries. A boundary
 * at `afterYear → beforeYear` ends an era at `afterYear` and starts a
 * new one at `beforeYear`.
 */
function splitYearsIntoEras(
  sortedYears: ReadonlyArray<ReadingArchiveYear>,
  boundaries: ReadonlyArray<ReadingEraBoundary>,
): RawEra[] {
  if (sortedYears.length === 0) return [];
  const boundarySet = new Set(boundaries.map((b) => `${b.afterYear}->${b.beforeYear}`));

  const eras: RawEra[] = [];
  let current: number[] = [];
  let currentBoundary: ReadingEraBoundary | null = null;

  for (let i = 0; i < sortedYears.length; i += 1) {
    const y = sortedYears[i];
    if (i > 0) {
      const prev = sortedYears[i - 1];
      const key = `${prev.year}->${y.year}`;
      if (boundarySet.has(key)) {
        // Close the previous era.
        eras.push({
          startYear: current[0],
          endYear: current[current.length - 1],
          years: [...current],
          boundaryBefore: currentBoundary,
        });
        current = [];
        currentBoundary =
          boundaries.find((b) => `${b.afterYear}->${b.beforeYear}` === key) ?? null;
      }
    }
    current.push(y.year);
  }

  if (current.length > 0) {
    eras.push({
      startYear: current[0],
      endYear: current[current.length - 1],
      years: [...current],
      boundaryBefore: currentBoundary,
    });
  }
  return eras;
}

/**
 * Collapse single-year raw eras that are NOT caused by a year_gap
 * boundary into an adjacent era. A single-year era prefers to merge
 * toward the side with the LOWER boundary score (i.e. the weaker
 * boundary). When both sides tie on score, it merges BACKWARD (with
 * the previous era). Single-year eras that DO come from year_gap are
 * kept as-is (a missing year in the archive is a real discontinuity).
 *
 * Two passes:
 *   1. Walk forward. For each single-year non-year_gap era, peek at
 *      the next era. If the next era is multi-year (or year_gap /
 *      null), pick the side with the lower boundary score (tie =
 *      backward). Merge accordingly.
 *   2. Any adjacent single-year non-year_gap survivors from step 1
 *      are fused into one era (keeps the earlier / lower-score
 *      boundaryBefore).
 */
function mergeSingleYearEras(eras: ReadonlyArray<RawEra>): RawEra[] {
  if (eras.length <= 1) return [...eras];

  const isSingleNonYearGap = (e: RawEra): boolean => {
    if (e.years.length !== 1) return false;
    return !(e.boundaryBefore?.reasons.includes("year_gap") ?? false);
  };

  // Pass 1: walk forward, marking single-year non-year_gap eras to
  // merge backward or forward. The "skip" sentinel tells the apply
  // loop that the input era has already been absorbed by a previous
  // forward-merge and should not be emitted again.
  type PlanAction = "keep" | "merge-back" | "merge-forward" | "skip";
  const plan: PlanAction[] = eras.map(() => "keep" as const);

  for (let i = 1; i < eras.length - 1; i += 1) {
    const cur = eras[i];
    if (!isSingleNonYearGap(cur)) continue;
    const prev = eras[i - 1];
    const next = eras[i + 1];
    const curScore = cur.boundaryBefore?.score ?? 0;
    const nextScore = next.boundaryBefore?.score ?? 0;
    const prevScore = prev.boundaryBefore?.score ?? 0;
    // The "right side" boundary score is `nextScore` (the boundary
    // between this era and the next). The "left side" boundary score
    // is `curScore` (the boundary between prev and this era).
    // Lower side wins. Tie → merge backward.
    const mergeForward = nextScore < curScore;
    plan[i] = mergeForward ? "merge-forward" : "merge-back";
    // Silence the unused-var lint without changing behaviour.
    void prevScore;
  }

  // Also consider the last era (index = eras.length - 1): if it is a
  // single-year non-year_gap era at the tail, merge it backward into
  // the previous era (no forward neighbour).
  if (isSingleNonYearGap(eras[eras.length - 1])) {
    plan[eras.length - 1] = "merge-back";
  }

  // Apply the plan. To handle forward-merge cleanly, walk the eras
  // and produce an output list.
  const out: RawEra[] = [];
  let i = 0;
  while (i < eras.length) {
    const e = eras[i];
    const action = plan[i];
    if (action === "merge-back") {
      // Fuse `e` into the LAST era in `out`.
      const last = out[out.length - 1];
      out[out.length - 1] = {
        startYear: last.startYear,
        endYear: e.endYear,
        years: [...last.years, ...e.years],
        boundaryBefore: last.boundaryBefore,
      };
      i += 1;
      continue;
    }
    if (action === "merge-forward") {
      // Fuse `e` into the NEXT era. We push `e` now and skip `next`
      // by marking next as "skip".
      const nextEra = eras[i + 1];
      const fused: RawEra = {
        startYear: e.startYear,
        endYear: nextEra.endYear,
        years: [...e.years, ...nextEra.years],
        boundaryBefore: e.boundaryBefore,
      };
      out.push(fused);
      // Skip the next era in the input.
      plan[i + 1] = "skip";
      i += 2;
      continue;
    }
    if (action === "skip") {
      // Already absorbed by previous forward-merge; skip.
      i += 1;
      continue;
    }
    out.push(e);
    i += 1;
  }

  // Pass 2: any adjacent single-year non-year_gap eras left in `out`
  // are fused into one. (Edge case: after pass 1, two neighbours may
  // both still be single-year non-year_gap if neither had a strong
  // enough neighbour to absorb into.)
  const collapsed: RawEra[] = [];
  for (const era of out) {
    const last = collapsed[collapsed.length - 1];
    if (
      last &&
      isSingleNonYearGap(last) &&
      isSingleNonYearGap(era)
    ) {
      const lastScore = last.boundaryBefore?.score ?? 0;
      const eraScore = era.boundaryBefore?.score ?? 0;
      const merged: RawEra = {
        startYear: last.startYear,
        endYear: era.endYear,
        years: [...last.years, ...era.years],
        boundaryBefore: lastScore <= eraScore ? last.boundaryBefore : era.boundaryBefore,
      };
      collapsed[collapsed.length - 1] = merged;
      continue;
    }
    collapsed.push(era);
  }

  return collapsed;
}

// ---------- era statistics ----------

/**
 * Compute era-level statistics from sorted years. Recurring books are
 * books whose catalogId appears in at least 2 of the era's Top N
 * lists. The catalogId/title/author for each recurring book comes
 * from the parent archive's `recurringBooks` list when present
 * (filtered by the era's catalogId set), otherwise synthesised as
 * minimal stub records carrying only the ID and the year span.
 */
function computeEraStats(
  rawEra: RawEra,
  yearIndex: Map<number, ReadingArchiveYear>,
  archive: WereadReadingArchive,
): ReadingEra {
  const yearProfiles: ReadingEraYearProfile[] = rawEra.years.map((y) => {
    const src = yearIndex.get(y);
    return {
      year: y,
      totalRecords: ensureFinite(src?.totalRecords ?? 0),
      activeMonths: ensureFinite(src?.activeMonths ?? 0),
      matchedRecords: ensureFinite(src?.matchedRecords ?? 0),
      matchedBooks: ensureFinite(src?.matchedBooks ?? 0),
      topBookCatalogIds: Array.isArray(src?.topBookCatalogIds)
        ? [...(src?.topBookCatalogIds ?? [])]
        : [],
    };
  });

  const totalRecords = yearProfiles.reduce((acc, y) => acc + y.totalRecords, 0);
  const totalActiveMonths = yearProfiles.reduce((acc, y) => acc + y.activeMonths, 0);
  const averageRecordsPerYear =
    yearProfiles.length > 0 ? totalRecords / yearProfiles.length : 0;

  // peakYear: max totalRecords, tie = earlier year.
  let peakYear: number | null = null;
  let peakYearRecords = 0;
  for (const y of yearProfiles) {
    if (
      peakYear === null ||
      y.totalRecords > peakYearRecords ||
      (y.totalRecords === peakYearRecords && y.year < peakYear)
    ) {
      peakYear = y.year;
      peakYearRecords = y.totalRecords;
    }
  }

  // recurringBooks: catalogIds appearing in ≥ 2 era-year Top Ns.
  const counts = new Map<string, number>();
  const yearsForCatalog = new Map<string, number[]>();
  for (const y of yearProfiles) {
    for (const cid of y.topBookCatalogIds) {
      counts.set(cid, (counts.get(cid) ?? 0) + 1);
      const arr = yearsForCatalog.get(cid) ?? [];
      arr.push(y.year);
      yearsForCatalog.set(cid, arr);
    }
  }
  const qualifyingCatalogIds: string[] = [];
  for (const [cid, n] of counts) {
    if (n >= 2) qualifyingCatalogIds.push(cid);
  }

  // Prefer to reuse the archive-level recurringBooks entries (they
  // carry richer public metadata). Fall back to a minimal stub for
  // any catalogId that appears in the era Top Ns but not in the
  // archive-level recurring list (can happen when topBooksLimit is
  // small).
  const archiveIndex = new Map<string, ReadingArchiveRecurringBook>();
  for (const b of archive.recurringBooks) archiveIndex.set(b.catalogId, b);

  const recurringBooks: ReadingArchiveRecurringBook[] = [];
  for (const cid of qualifyingCatalogIds) {
    const years = (yearsForCatalog.get(cid) ?? []).slice().sort((a, b) => a - b);
    const fromArchive = archiveIndex.get(cid);
    if (fromArchive) {
      // Re-scope the archive-level recurring book to this era's
      // years. Preserve title/author/publisher/publishYear from the
      // archive (they are public metadata).
      recurringBooks.push({
        ...fromArchive,
        years,
        yearsOnList: years.length,
        latestYear: years[years.length - 1],
      });
    } else {
      recurringBooks.push({
        catalogId: cid,
        title: "",
        author: null,
        publisher: null,
        publishYear: null,
        years,
        yearsOnList: years.length,
        // We deliberately omit note/highlight counts because the
        // archive-level recurring list is the only authoritative
        // source for those; without it the entry would be all zeros
        // and misleading.
        totalNoteCountWithinLists: 0,
        bestRank: 0,
        latestYear: years[years.length - 1],
        latestRank: 0,
      });
    }
  }
  // Stable order: most years first, tie = earlier latestYear, tie = catalogId asc.
  recurringBooks.sort((a, b) => {
    if (b.yearsOnList !== a.yearsOnList) return b.yearsOnList - a.yearsOnList;
    if (a.latestYear !== b.latestYear) return a.latestYear - b.latestYear;
    return a.catalogId.localeCompare(b.catalogId);
  });

  return {
    id: `era-${rawEra.startYear}-${rawEra.endYear}`,
    startYear: rawEra.startYear,
    endYear: rawEra.endYear,
    years: rawEra.years,
    totalRecords,
    totalActiveMonths,
    averageRecordsPerYear,
    peakYear,
    peakYearRecords,
    recurringBooks: recurringBooks.slice(0, READING_ERA_RECURRING_BOOKS_LIMIT),
    boundaryBefore: rawEra.boundaryBefore,
  };
}

// ---------- entry point ----------

export function buildReadingEras(
  archive: WereadReadingArchive,
  mode: ReadingEraSegmentationMode = "automatic",
): WereadReadingEraResult {
  if (!archive || !Array.isArray(archive.years)) {
    return {
      eras: [],
      boundaries: [],
      meta: { yearsUsed: 0, erasReturned: 0, mode, persisted: false },
    };
  }

  const sortedYears = sortByYearAsc(archive.years);
  const rawBoundaries = detectEraBoundaries(sortedYears, archive.yearLinks ?? []);
  const boundaries = finalizeEraBoundaries(rawBoundaries, mode);

  const yearIndex = buildYearIndex(sortedYears);
  const rawEras = splitYearsIntoEras(sortedYears, boundaries);
  const merged = mergeSingleYearEras(rawEras);
  const eras = merged.map((raw) => computeEraStats(raw, yearIndex, archive));

  return {
    eras,
    boundaries,
    meta: {
      yearsUsed: sortedYears.length,
      erasReturned: eras.length,
      mode,
      persisted: false,
    },
  };
}

// ---------- human-readable boundary reason labels ----------

/**
 * Stable Chinese labels for boundary reasons. The dashboard MUST use
 * these labels so that no psychological vocabulary can sneak in via
 * ad-hoc strings.
 */
export const READING_ERA_BOUNDARY_LABELS: Readonly<Record<ReadingEraBoundaryReason, string>> = {
  year_gap: "年份存在中断",
  activity_shift: "阅读记录数量变化较大",
  active_month_shift: "活跃月份数量变化较大",
  top_list_shift: "相邻年度 Top N 榜单重合较低",
};

export function describeEraBoundary(b: ReadingEraBoundary): string {
  const labels = b.reasons.map((r) => READING_ERA_BOUNDARY_LABELS[r]);
  return labels.join("、");
}