/**
 * S27J — Private WeRead "annual reading review" backend helpers.
 *
 * Strict privacy contract (mirrors S27H):
 *   - Operates ONLY on note dates, types, and the already-confirmed
 *     `wereadBookId → public catalogId` mapping. NEVER reads, analyses,
 *     or returns note text / comment / wereadBookId / noteId /
 *     highlightId / chapterTitle / raw WeRead title / author.
 *   - Public metadata (title / author / publisher / year) is read from
 *     the existing Meilisearch `books` index via `index.getDocument` —
 *     it does NOT call `/api/search`, and never echoes private fields.
 *   - There is NO call to MiniMax, no write to Meilisearch, no
 *     persistence of any kind, no logging of note bodies.
 *   - Failures from the public catalog lookup are swallowed with a
 *     deterministic fallback (`书目 ${catalogId}`) so the endpoint
 *     always succeeds when the caller is authenticated and the query
 *     is valid.
 *
 * The annual review is a deterministic, year-bounded aggregation:
 *   - `selectedYear` is the only year that participates in overview /
 *     months / streak / peak month / top books / quarters.
 *   - `availableYears` enumerates the descending list of years with
 *     ≥1 valid-dated note; the list itself is the only piece of
 *     information derived from the full history and we never expose
 *     per-year counts.
 */

import {
  monthKeyFromSeconds,
  normalizeNoteType,
  resolveNoteTimestampSeconds,
  type PrivateNoteAggregate,
  type PublicBookMetadata,
  type PublicMetadataFetcher,
} from "./private-reading-map.js";

// ---------- limits ----------

export const ANNUAL_REVIEW_LIMITS: {
  MIN_YEAR: number;
  ALLOWED_TOP_BOOKS: ReadonlyArray<number>;
  DEFAULT_TOP_BOOKS: number;
  MONTHS_PER_YEAR: number;
} = {
  MIN_YEAR: 2000,
  ALLOWED_TOP_BOOKS: [6, 12, 18],
  DEFAULT_TOP_BOOKS: 12,
  MONTHS_PER_YEAR: 12,
};

// ---------- public types ----------

export interface AnnualReviewOverview {
  year: number;
  totalRecords: number;
  datedRecords: number;
  matchedRecords: number;
  matchedBooks: number;
  activeMonths: number;
  longestStreakMonths: number;
  firstNoteAt: string | null;
  lastNoteAt: string | null;
  peakMonth: string | null;
  peakMonthRecords: number;
  averageRecordsPerActiveMonth: number;
}

export interface AnnualReviewMonth {
  month: string; // YYYY-MM
  total: number;
  highlights: number;
  thoughts: number;
  reviews: number;
  unknown: number;
  matched: number;
  bookCount: number;
}

export type AnnualReviewQuarterKey = "Q1" | "Q2" | "Q3" | "Q4";

export interface AnnualReviewQuarter {
  quarter: AnnualReviewQuarterKey;
  total: number;
  activeMonths: number;
  matchedRecords: number;
  bookCount: number;
}

export interface AnnualReviewBook {
  catalogId: string;
  title: string;
  author?: string | null;
  publisher?: string | null;
  publishYear?: string | number | null;
  noteCount: number;
  highlights: number;
  thoughts: number;
  reviews: number;
  unknown: number;
  activeMonths: number;
  firstNoteAt: string | null;
  lastNoteAt: string | null;
}

export interface AnnualReviewMeta {
  topBooksRequested: number;
  topBooksReturned: number;
  persisted: false;
  source: "private_snapshot+public_catalog";
}

export interface PrivateAnnualReviewResponse {
  ok: true;
  selectedYear: number;
  availableYears: number[];
  overview: AnnualReviewOverview;
  months: AnnualReviewMonth[];
  quarters: AnnualReviewQuarter[];
  topBooks: AnnualReviewBook[];
  meta: AnnualReviewMeta;
}

// ---------- result envelopes ----------

export type AnnualQueryValidationResult =
  | { ok: true; year: number; topBooks: number }
  | { ok: false; status: 400; message: string };

export interface YearResolutionResult {
  year: number;
  availableYears: number[];
}

// ---------- year helpers ----------

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return Math.floor(value);
}

/** UTC year for an epoch-seconds value. */
function yearFromSeconds(seconds: number): number {
  return new Date(seconds * 1000).getUTCFullYear();
}

/** Format a YYYY-MM string as YYYY-MM (no transform; helper for symmetry). */
function padMonth(monthIndex: number): string {
  return String(monthIndex + 1).padStart(2, "0");
}

/** Validate the year+topBooks query pair used by the route. */
export function validateAnnualReviewQuery(input: unknown, now: Date): AnnualQueryValidationResult {
  if (!input || typeof input !== "object") {
    return { ok: false, status: 400, message: "请求参数必须是 JSON object。" };
  }
  const body = input as Record<string, unknown>;

  const currentYear = now.getUTCFullYear();
  const maxYear = currentYear + 1;

  let year: number | null = null;
  if (body.year !== undefined && body.year !== null) {
    if (typeof body.year !== "number" || !Number.isInteger(body.year)) {
      return { ok: false, status: 400, message: "year 必须是四位整数。" };
    }
    if (body.year < ANNUAL_REVIEW_LIMITS.MIN_YEAR || body.year > maxYear) {
      return {
        ok: false,
        status: 400,
        message: `year 必须在 ${ANNUAL_REVIEW_LIMITS.MIN_YEAR} 到 ${maxYear} 之间。`,
      };
    }
    year = body.year;
  }

  let topBooks: number = ANNUAL_REVIEW_LIMITS.DEFAULT_TOP_BOOKS;
  if (body.topBooks !== undefined && body.topBooks !== null) {
    if (typeof body.topBooks !== "number" || !Number.isInteger(body.topBooks)) {
      return { ok: false, status: 400, message: "topBooks 必须是 6 / 12 / 18 之一。" };
    }
    if (!ANNUAL_REVIEW_LIMITS.ALLOWED_TOP_BOOKS.includes(body.topBooks)) {
      return { ok: false, status: 400, message: "topBooks 必须是 6 / 12 / 18 之一。" };
    }
    topBooks = body.topBooks;
  }

  return { ok: true, year: year ?? Number.NaN, topBooks };
}

/**
 * Extract the descending list of years that contain ≥1 valid-dated
 * note. Records with no valid date are silently skipped. Order is
 * strict descending; duplicates are removed.
 */
export function extractAvailableReviewYears(notes: ReadonlyArray<PrivateNoteAggregate>): number[] {
  const set = new Set<number>();
  for (const note of notes) {
    const ts = resolveNoteTimestampSeconds(note);
    if (ts === null) continue;
    set.add(yearFromSeconds(ts));
  }
  return Array.from(set).sort((a, b) => b - a);
}

/**
 * Resolve which year the endpoint should serve.
 *
 * Priority:
 *   1. Caller-supplied `selectedYear` if it parses + falls in range.
 *   2. The latest year that has ≥1 valid-dated note (most-recent).
 *   3. The current UTC year (when no valid dated notes exist at all).
 *
 * Always returns the year and the descending list of available years.
 */
export function resolveAnnualReviewYear(args: {
  requestedYear: number;
  availableYears: number[];
  now: Date;
}): number {
  if (
    Number.isInteger(args.requestedYear) &&
    args.requestedYear >= ANNUAL_REVIEW_LIMITS.MIN_YEAR &&
    args.requestedYear <= args.now.getUTCFullYear() + 1
  ) {
    return args.requestedYear;
  }
  if (args.availableYears.length > 0) {
    return args.availableYears[0];
  }
  return args.now.getUTCFullYear();
}

// ---------- per-year filtering ----------

/**
 * Filter `notes` down to those with a valid date inside `year`. Records
 * without a valid date are silently dropped. Returned order matches
 * input order.
 */
export function filterNotesByYear(
  notes: ReadonlyArray<PrivateNoteAggregate>,
  year: number
): PrivateNoteAggregate[] {
  const out: PrivateNoteAggregate[] = [];
  for (const note of notes) {
    const ts = resolveNoteTimestampSeconds(note);
    if (ts === null) continue;
    if (yearFromSeconds(ts) !== year) continue;
    out.push(note);
  }
  return out;
}

// ---------- month timeline (fixed 12 months) ----------

/**
 * Build the 12 fixed YYYY-01 .. YYYY-12 buckets for the supplied year.
 * Empty months stay as zero-value buckets so the chart is complete.
 *
 * `matchedCatalogIdSet` decides whether a note counts toward `matched`.
 * `bookCountPerMonth` is computed from a separate pass so that
 * unmatched notes still count in `total`/type but not in `bookCount`.
 */
export function buildAnnualReviewMonths(args: {
  notes: ReadonlyArray<PrivateNoteAggregate>;
  year: number;
  matchedCatalogIdSet: ReadonlySet<string>;
}): AnnualReviewMonth[] {
  const buckets: AnnualReviewMonth[] = [];
  for (let i = 0; i < ANNUAL_REVIEW_LIMITS.MONTHS_PER_YEAR; i += 1) {
    buckets.push({
      month: `${args.year}-${padMonth(i)}`,
      total: 0,
      highlights: 0,
      thoughts: 0,
      reviews: 0,
      unknown: 0,
      matched: 0,
      bookCount: 0,
    });
  }

  // Track distinct matched catalog ids per month for `bookCount`.
  const distinctByMonth: Map<number, Set<string>> = new Map();

  for (const note of args.notes) {
    const ts = resolveNoteTimestampSeconds(note);
    if (ts === null) continue;
    const d = new Date(ts * 1000);
    if (d.getUTCFullYear() !== args.year) continue;
    const mIdx = d.getUTCMonth();
    const bucket = buckets[mIdx];
    const t = normalizeNoteType(note.type);
    bucket.total += 1;
    if (t === "highlight") bucket.highlights += 1;
    else if (t === "thought") bucket.thoughts += 1;
    else if (t === "review") bucket.reviews += 1;
    else bucket.unknown += 1;
    if (args.matchedCatalogIdSet.has(note.catalogId)) {
      bucket.matched += 1;
      let set = distinctByMonth.get(mIdx);
      if (!set) {
        set = new Set<string>();
        distinctByMonth.set(mIdx, set);
      }
      set.add(note.catalogId);
    }
  }

  for (let i = 0; i < buckets.length; i += 1) {
    const set = distinctByMonth.get(i);
    buckets[i].bookCount = set ? set.size : 0;
  }

  return buckets;
}

// ---------- annual streak (12-month bounded) ----------

/**
 * Longest contiguous block of active months inside the selected year.
 * Walks the 12 fixed buckets in chronological order; gaps reset the
 * counter. Zero when the year has no active months.
 *
 * `activeMonths` is the count of months with total > 0.
 */
export function calculateAnnualReviewStreak(months: ReadonlyArray<AnnualReviewMonth>): {
  activeMonths: number;
  longestStreakMonths: number;
} {
  let activeMonths = 0;
  let longest = 0;
  let run = 0;
  for (const m of months) {
    if (m.total > 0) {
      activeMonths += 1;
      run += 1;
      if (run > longest) longest = run;
    } else {
      run = 0;
    }
  }
  return { activeMonths, longestStreakMonths: longest };
}

// ---------- peak month ----------

/**
 * Identify the peak month inside the supplied 12-bucket array.
 *
 * Selection rules:
 *   1. The month with the highest `total`.
 *   2. On ties, the earlier month wins (chronological order).
 *   3. Returns `null` when every bucket is zero.
 */
export function findAnnualPeakMonth(months: ReadonlyArray<AnnualReviewMonth>): {
  peakMonth: string | null;
  peakMonthRecords: number;
} {
  let bestTotal = 0;
  let bestIdx = -1;
  for (let i = 0; i < months.length; i += 1) {
    const t = months[i].total;
    if (t > bestTotal) {
      bestTotal = t;
      bestIdx = i;
    }
  }
  if (bestIdx < 0 || bestTotal === 0) {
    return { peakMonth: null, peakMonthRecords: 0 };
  }
  return { peakMonth: months[bestIdx].month, peakMonthRecords: bestTotal };
}

// ---------- quarters ----------

const QUARTER_KEYS: AnnualReviewQuarterKey[] = ["Q1", "Q2", "Q3", "Q4"];

function quarterIndex(monthIndex: number): number {
  if (monthIndex < 3) return 0;
  if (monthIndex < 6) return 1;
  if (monthIndex < 9) return 2;
  return 3;
}

/**
 * Roll the 12 monthly buckets into 4 quarters (Q1..Q4).
 *
 * `bookCount` is the distinct matched catalogId count across the whole
 * quarter. We approximate it by summing monthly distinct counts when
 * no shared matched books span two months — exact union requires the
 * helper to know the full note set, so we compute the union separately
 * in `buildAnnualReviewQuarters` below. This helper is therefore
 * `quartersFromMonths` and the route uses the full variant.
 */
export function quartersFromMonths(months: ReadonlyArray<AnnualReviewMonth>): AnnualReviewQuarter[] {
  const sums = QUARTER_KEYS.map((quarter, idx) => {
    let total = 0;
    let activeMonths = 0;
    let matchedRecords = 0;
    let bookCount = 0;
    for (let m = idx * 3; m < idx * 3 + 3; m += 1) {
      const bucket = months[m];
      total += bucket.total;
      if (bucket.total > 0) activeMonths += 1;
      matchedRecords += bucket.matched;
      bookCount += bucket.bookCount;
    }
    return { quarter, total, activeMonths, matchedRecords, bookCount };
  });
  return sums;
}

/**
 * Build quarter summaries with exact `bookCount` (union of matched
 * catalog ids per quarter). The monthly `bookCount` is an approximation
 * already (we don't carry the note set in each bucket); the full
 * quarter view accepts the original notes to compute the precise
 * distinct catalogId set.
 */
export function buildAnnualReviewQuarters(args: {
  notes: ReadonlyArray<PrivateNoteAggregate>;
  year: number;
  matchedCatalogIdSet: ReadonlySet<string>;
}): AnnualReviewQuarter[] {
  const quarterBooks: Set<string>[] = QUARTER_KEYS.map(() => new Set<string>());
  const quarterTotals = QUARTER_KEYS.map(() => ({
    total: 0,
    activeMonths: new Set<number>(),
    matchedRecords: 0,
  }));

  for (const note of args.notes) {
    const ts = resolveNoteTimestampSeconds(note);
    if (ts === null) continue;
    const d = new Date(ts * 1000);
    if (d.getUTCFullYear() !== args.year) continue;
    const mIdx = d.getUTCMonth();
    const qIdx = quarterIndex(mIdx);
    const acc = quarterTotals[qIdx];
    acc.total += 1;
    acc.activeMonths.add(mIdx);
    const catalogId = note.catalogId;
    if (args.matchedCatalogIdSet.has(catalogId)) {
      acc.matchedRecords += 1;
      quarterBooks[qIdx].add(catalogId);
    }
  }

  return QUARTER_KEYS.map((quarter, idx) => ({
    quarter,
    total: quarterTotals[idx].total,
    activeMonths: quarterTotals[idx].activeMonths.size,
    matchedRecords: quarterTotals[idx].matchedRecords,
    bookCount: quarterBooks[idx].size,
  }));
}

// ---------- annual top books ----------

interface AnnualAggregatedBook {
  catalogId: string;
  noteCount: number;
  highlights: number;
  thoughts: number;
  reviews: number;
  unknown: number;
  activeMonths: number;
  firstNoteAt: string | null;
  lastNoteAt: string | null;
}

/**
 * Aggregate year-bounded notes by confirmed public catalogId.
 *
 * - The aggregation is keyed by `catalogId`, NOT by `wereadBookId`.
 *   Multiple WeRead book ids that map to the same catalogId merge.
 * - Same-body duplicates are intentionally NOT collapsed.
 * - Notes whose date is outside `year` are excluded.
 * - Notes with no valid date are excluded.
 * - Sort: noteCount DESC → activeMonths DESC → lastNoteAt DESC → catalogId ASC.
 * - Result is truncated to `limit`.
 */
export function aggregateAnnualReviewBooks(args: {
  notes: ReadonlyArray<PrivateNoteAggregate>;
  wereadToCatalog: ReadonlyMap<string, string>;
  year: number;
  limit: number;
}): AnnualAggregatedBook[] {
  const safeLimit = clamp(
    args.limit,
    ANNUAL_REVIEW_LIMITS.ALLOWED_TOP_BOOKS[0],
    ANNUAL_REVIEW_LIMITS.ALLOWED_TOP_BOOKS[ANNUAL_REVIEW_LIMITS.ALLOWED_TOP_BOOKS.length - 1]
  );

  type BucketState = AnnualAggregatedBook & { __months: Set<string> };
  const out = new Map<string, BucketState>();

  for (const note of args.notes) {
    const catalogId = args.wereadToCatalog.get(note.wereadBookId);
    if (!catalogId) continue;
    const ts = resolveNoteTimestampSeconds(note);
    if (ts === null) continue;
    if (yearFromSeconds(ts) !== args.year) continue;
    const t = normalizeNoteType(note.type);
    const iso = new Date(ts * 1000).toISOString();
    const monthKey = monthKeyFromSeconds(ts);
    const existing = out.get(catalogId);
    if (!existing) {
      const bucket: BucketState = {
        catalogId,
        noteCount: 1,
        highlights: t === "highlight" ? 1 : 0,
        thoughts: t === "thought" ? 1 : 0,
        reviews: t === "review" ? 1 : 0,
        unknown: t === "unknown" ? 1 : 0,
        activeMonths: 1,
        firstNoteAt: iso,
        lastNoteAt: iso,
        __months: new Set<string>([monthKey]),
      };
      out.set(catalogId, bucket);
      continue;
    }
    existing.noteCount += 1;
    if (t === "highlight") existing.highlights += 1;
    else if (t === "thought") existing.thoughts += 1;
    else if (t === "review") existing.reviews += 1;
    else existing.unknown += 1;
    if (existing.firstNoteAt === null || iso < existing.firstNoteAt) existing.firstNoteAt = iso;
    if (existing.lastNoteAt === null || iso > existing.lastNoteAt) existing.lastNoteAt = iso;
    if (!existing.__months.has(monthKey)) {
      existing.__months.add(monthKey);
      existing.activeMonths = existing.__months.size;
    }
  }

  const arr: AnnualAggregatedBook[] = [];
  for (const bucket of out.values()) {
    arr.push({
      catalogId: bucket.catalogId,
      noteCount: bucket.noteCount,
      highlights: bucket.highlights,
      thoughts: bucket.thoughts,
      reviews: bucket.reviews,
      unknown: bucket.unknown,
      activeMonths: bucket.activeMonths,
      firstNoteAt: bucket.firstNoteAt,
      lastNoteAt: bucket.lastNoteAt,
    });
  }

  arr.sort((a, b) => {
    if (b.noteCount !== a.noteCount) return b.noteCount - a.noteCount;
    if (b.activeMonths !== a.activeMonths) return b.activeMonths - a.activeMonths;
    const aLast = a.lastNoteAt ?? "";
    const bLast = b.lastNoteAt ?? "";
    if (aLast !== bLast) return bLast.localeCompare(aLast);
    return a.catalogId < b.catalogId ? -1 : a.catalogId > b.catalogId ? 1 : 0;
  });

  return arr.slice(0, safeLimit);
}

/**
 * Public-metadata hydration for the aggregated annual book list.
 *
 * Fallback contract (mirrors reading-map):
 *   - fetch returned null OR threw → title = `书目 ${catalogId}`,
 *     author / publisher / publishYear = null.
 *   - never falls back to the private WeRead title / author.
 */
export function hydrateAnnualReviewBooks(
  books: ReadonlyArray<AnnualAggregatedBook>,
  metadataByCatalog: ReadonlyMap<string, PublicBookMetadata>
): AnnualReviewBook[] {
  return books.map((book) => {
    const meta = metadataByCatalog.get(book.catalogId);
    if (!meta) {
      return {
        catalogId: book.catalogId,
        title: `书目 ${book.catalogId}`,
        author: null,
        publisher: null,
        publishYear: null,
        noteCount: book.noteCount,
        highlights: book.highlights,
        thoughts: book.thoughts,
        reviews: book.reviews,
        unknown: book.unknown,
        activeMonths: book.activeMonths,
        firstNoteAt: book.firstNoteAt,
        lastNoteAt: book.lastNoteAt,
      };
    }
    return {
      catalogId: book.catalogId,
      title: meta.title && meta.title.length > 0 ? meta.title : `书目 ${book.catalogId}`,
      author: typeof meta.author === "string" ? meta.author : null,
      publisher: typeof meta.publisher === "string" ? meta.publisher : null,
      publishYear:
        typeof meta.publishYear === "string" || typeof meta.publishYear === "number"
          ? meta.publishYear
          : null,
      noteCount: book.noteCount,
      highlights: book.highlights,
      thoughts: book.thoughts,
      reviews: book.reviews,
      unknown: book.unknown,
      activeMonths: book.activeMonths,
      firstNoteAt: book.firstNoteAt,
      lastNoteAt: book.lastNoteAt,
    };
  });
}

// ---------- orchestrator ----------

export interface BuildAnnualReviewArgs {
  notes: ReadonlyArray<PrivateNoteAggregate>;
  /** Confirmed `wereadBookId → public catalogId` pairs. */
  wereadToCatalog: ReadonlyMap<string, string>;
  selectedYear: number;
  topBooks: number;
  metadataByCatalog: ReadonlyMap<string, PublicBookMetadata>;
  now: Date;
}

/**
 * Pure helper that assembles the full annual-review response from
 * validated inputs. No I/O — exercised entirely with synthetic fixtures.
 */
export function buildPrivateAnnualReview(args: BuildAnnualReviewArgs): PrivateAnnualReviewResponse {
  const yearNotes = filterNotesByYear(args.notes, args.selectedYear);

  // Collect the distinct catalog ids whose notes appear in this year.
  const matchedNoteCatalogIds = new Set<string>();
  for (const note of yearNotes) {
    const catalogId = args.wereadToCatalog.get(note.wereadBookId);
    if (catalogId) matchedNoteCatalogIds.add(catalogId);
  }

  const months = buildAnnualReviewMonths({
    notes: yearNotes,
    year: args.selectedYear,
    matchedCatalogIdSet: matchedNoteCatalogIds,
  });

  const { activeMonths, longestStreakMonths } = calculateAnnualReviewStreak(months);
  const { peakMonth, peakMonthRecords } = findAnnualPeakMonth(months);
  const quarters = buildAnnualReviewQuarters({
    notes: yearNotes,
    year: args.selectedYear,
    matchedCatalogIdSet: matchedNoteCatalogIds,
  });

  // First / last note dates scoped to the selected year.
  let firstMs = Number.POSITIVE_INFINITY;
  let lastMs = Number.NEGATIVE_INFINITY;
  for (const note of yearNotes) {
    const ts = resolveNoteTimestampSeconds(note);
    if (ts === null) continue;
    if (ts < firstMs) firstMs = ts;
    if (ts > lastMs) lastMs = ts;
  }
  const firstNoteAt = Number.isFinite(firstMs) ? new Date(firstMs * 1000).toISOString() : null;
  const lastNoteAt = Number.isFinite(lastMs) ? new Date(lastMs * 1000).toISOString() : null;

  const datedRecords = yearNotes.length;
  let matchedRecords = 0;
  for (const note of yearNotes) {
    if (args.wereadToCatalog.has(note.wereadBookId)) matchedRecords += 1;
  }

  const averageRecordsPerActiveMonth =
    activeMonths > 0 ? Number((datedRecords / activeMonths).toFixed(4)) : 0;

  const aggregated = aggregateAnnualReviewBooks({
    notes: args.notes, // helper re-filters by year internally
    wereadToCatalog: args.wereadToCatalog,
    year: args.selectedYear,
    limit: args.topBooks,
  });
  const topBooks = hydrateAnnualReviewBooks(aggregated, args.metadataByCatalog);

  // matchedBooks = the number of distinct catalog ids active in this year.
  const matchedBooks = matchedNoteCatalogIds.size;

  const availableYears = extractAvailableReviewYears(args.notes);

  return {
    ok: true,
    selectedYear: args.selectedYear,
    availableYears,
    overview: {
      year: args.selectedYear,
      totalRecords: datedRecords,
      datedRecords,
      matchedRecords,
      matchedBooks,
      activeMonths,
      longestStreakMonths,
      firstNoteAt,
      lastNoteAt,
      peakMonth,
      peakMonthRecords,
      averageRecordsPerActiveMonth,
    },
    months,
    quarters,
    topBooks,
    meta: {
      topBooksRequested: args.topBooks,
      topBooksReturned: topBooks.length,
      persisted: false,
      source: "private_snapshot+public_catalog",
    },
  };
}

// ---------- end-to-end orchestration ----------

export interface AnnualReviewOrchestrationResult {
  response?: PrivateAnnualReviewResponse;
  error?: { status: number; message: string };
}

export interface RunAnnualReviewArgs {
  query: unknown;
  notes: ReadonlyArray<PrivateNoteAggregate>;
  confirmedMatches: ReadonlyArray<{ wereadBookId: string; catalogId: string }>;
  fetchMetadata: PublicMetadataFetcher;
  now?: Date;
}

/**
 * End-to-end orchestrator used by the route handler:
 *   1. validate query (year + topBooks)
 *   2. resolve selected year (request → latest with data → current year)
 *   3. derive the wereadBookId → catalogId map from confirmed matches
 *   4. fetch public metadata for the annual top books in parallel
 *   5. assemble the full response
 *
 * Public metadata failures are swallowed and fall back to
 * `书目 ${catalogId}` with empty ancillary fields. The endpoint itself
 * therefore only fails on bad input (400) or auth (handled upstream).
 */
export async function runPrivateAnnualReview(args: RunAnnualReviewArgs): Promise<AnnualReviewOrchestrationResult> {
  const now = args.now ?? new Date();
  const validation = validateAnnualReviewQuery(args.query, now);
  if (!validation.ok) {
    return { error: { status: validation.status, message: validation.message } };
  }

  const wereadToCatalog = new Map<string, string>();
  for (const m of args.confirmedMatches) {
    if (typeof m?.wereadBookId === "string" && typeof m?.catalogId === "string") {
      wereadToCatalog.set(m.wereadBookId, m.catalogId);
    }
  }

  const availableYears = extractAvailableReviewYears(args.notes);
  const selectedYear = resolveAnnualReviewYear({
    requestedYear: validation.year,
    availableYears,
    now,
  });

  // Quick aggregation so we know which catalogIds to hydrate.
  const quickAggregate = aggregateAnnualReviewBooks({
    notes: args.notes,
    wereadToCatalog,
    year: selectedYear,
    limit: validation.topBooks,
  });
  const candidateIds = quickAggregate.map((b) => b.catalogId);

  const metadataByCatalog = new Map<string, PublicBookMetadata>();
  await Promise.all(
    candidateIds.map(async (catalogId) => {
      try {
        const meta = await args.fetchMetadata.fetchByCatalogId(catalogId);
        if (meta && typeof meta.title === "string" && meta.title.length > 0) {
          metadataByCatalog.set(catalogId, {
            catalogId,
            title: meta.title,
            author: typeof meta.author === "string" ? meta.author : null,
            publisher: typeof meta.publisher === "string" ? meta.publisher : null,
            publishYear:
              typeof meta.publishYear === "string" || typeof meta.publishYear === "number"
                ? meta.publishYear
                : null,
          });
        }
      } catch {
        /* swallow — fallback handled in hydrateAnnualReviewBooks */
      }
    })
  );

  const response = buildPrivateAnnualReview({
    notes: args.notes,
    wereadToCatalog,
    selectedYear,
    topBooks: validation.topBooks,
    metadataByCatalog,
    now,
  });

  return { response };
}

// silence unused import warning when isolated from the helper it delegates to.
void monthKeyFromSeconds;