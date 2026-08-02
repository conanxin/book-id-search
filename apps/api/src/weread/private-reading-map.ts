/**
 * S27H — Private WeRead "personal reading map" backend helpers.
 *
 * Strict privacy contract:
 *   - The helper operates ONLY on note dates, types, and the
 *     already-confirmed `wereadBookId → public catalogId` mapping.
 *   - It NEVER reads, analyses, or returns note text / comment /
 *     wereadBookId / noteId / highlightId / chapterTitle / raw WeRead
 *     title / author. Those fields exist on `WereadNote` but are
 *     deliberately ignored by every aggregation step below.
 *   - Public metadata (title / author / publisher / year) is read from
 *     the existing Meilisearch `books` index through `index.getDocument`
 *     — it does NOT call `/api/search`, and never echoes private fields.
 *   - There is NO call to MiniMax / MiniMax, no write to Meilisearch,
 *     no persistence of any kind, and no logging of note bodies.
 *   - Failures from the public catalog lookup are swallowed with a
 *     deterministic fallback so the endpoint always succeeds when the
 *     caller is authenticated and the query is valid.
 */

import process from "node:process";

// ---------- limits ----------

export const READING_MAP_LIMITS: {
  MIN_MONTHS: number;
  MAX_MONTHS: number;
  ALLOWED_MONTHS: ReadonlyArray<number>;
  DEFAULT_MONTHS: number;
  MIN_TOP_BOOKS: number;
  MAX_TOP_BOOKS: number;
  DEFAULT_TOP_BOOKS: number;
  MAX_LINKS: number;
  CATALOG_ID_RE: RegExp;
  RADIUS_MIN: number;
  RADIUS_MAX: number;
} = {
  MIN_MONTHS: 6,
  MAX_MONTHS: 36,
  ALLOWED_MONTHS: [6, 12, 24, 36],
  DEFAULT_MONTHS: 24,
  MIN_TOP_BOOKS: 6,
  MAX_TOP_BOOKS: 18,
  DEFAULT_TOP_BOOKS: 12,
  MAX_LINKS: 24,
  CATALOG_ID_RE: /^[0-9]+_[0-9]{12}$/,
  RADIUS_MIN: 14,
  RADIUS_MAX: 36,
};

// ---------- public types ----------

export interface PrivateNoteAggregate {
  /** Public catalog id (already confirmed). */
  catalogId: string;
  /** Internal WeRead book id used as the grouping key. */
  wereadBookId: string;
  /** Optional note timestamp (epoch seconds or ISO string). */
  createdAt?: unknown;
  updatedAt?: unknown;
  /** Optional note type — high-cardinality values collapse to "unknown". */
  type?: unknown;
}

export interface PublicBookMetadata {
  catalogId: string;
  title: string;
  author?: string | null;
  publisher?: string | null;
  publishYear?: string | number | null;
}

export interface ReadingMapOverview {
  booksCount: number;
  notesCount: number;
  matchedCatalogsCount: number;
  matchedNoteRecordsCount: number;
  firstNoteAt: string | null;
  lastNoteAt: string | null;
  activeMonths: number;
  currentStreakMonths: number;
  longestStreakMonths: number;
}

export interface ReadingMapMonthBucket {
  month: string; // YYYY-MM
  total: number;
  highlights: number;
  thoughts: number;
  reviews: number;
  unknown: number;
  matched: number;
}

export interface ReadingMapBook {
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
  firstNoteAt?: string | null;
  lastNoteAt?: string | null;
}

export interface ReadingMapLink {
  sourceCatalogId: string;
  targetCatalogId: string;
  sharedMonths: number;
  weight: number;
}

export interface PrivateReadingMapResponse {
  ok: true;
  overview: ReadingMapOverview;
  timeline: ReadingMapMonthBucket[];
  books: ReadingMapBook[];
  links: ReadingMapLink[];
  meta: {
    monthsRequested: number;
    monthsReturned: number;
    topBooksRequested: number;
    topBooksReturned: number;
    linksReturned: number;
    persisted: false;
    source: "private_snapshot+public_catalog";
  };
}

// ---------- result envelopes ----------

export type QueryValidationResult =
  | { ok: true; months: number; topBooks: number }
  | { ok: false; status: 400; message: string };

export interface PublicMetadataFetcher {
  fetchByCatalogId: (catalogId: string) => Promise<PublicBookMetadata | null>;
}

// ---------- helpers ----------

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return Math.floor(value);
}

/**
 * Resolve a note's date as an epoch-seconds number. Strict priority:
 *   1. `createdAt` if it parses to a finite epoch-seconds value.
 *   2. `updatedAt` with the same rule.
 *   3. otherwise returns null and the caller MUST exclude the note.
 */
export function resolveNoteTimestampSeconds(note: PrivateNoteAggregate): number | null {
  for (const field of ["createdAt", "updatedAt"] as const) {
    const raw = (note as unknown as Record<string, unknown>)[field];
    if (raw === undefined || raw === null) continue;
    if (typeof raw === "number") {
      if (Number.isFinite(raw) && raw > 0) return raw;
      continue;
    }
    if (typeof raw === "string") {
      const trimmed = raw.trim();
      if (trimmed.length === 0) continue;
      // Pure numeric epoch seconds (10-11 digits for seconds, 13 for ms).
      if (/^-?\d{9,14}$/.test(trimmed)) {
        const parsed = Number(trimmed);
        if (Number.isFinite(parsed) && parsed > 0) {
          // Normalise milliseconds → seconds if the caller passed ms.
          return parsed > 1e12 ? Math.floor(parsed / 1000) : Math.floor(parsed);
        }
      }
      const d = new Date(trimmed);
      const ms = d.getTime();
      if (Number.isFinite(ms) && ms > 0) return Math.floor(ms / 1000);
    }
  }
  return null;
}

/** Normalise a note type into our 4-bucket vocabulary. */
export function normalizeNoteType(raw: unknown): "highlight" | "thought" | "review" | "unknown" {
  if (raw === "highlight" || raw === "thought" || raw === "review") return raw;
  return "unknown";
}

/** Format an epoch-seconds value as YYYY-MM in UTC. */
export function monthKeyFromSeconds(seconds: number): string {
  const d = new Date(seconds * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

/** Build the list of the N most recent completed-or-current YYYY-MM buckets ending at `nowSeconds`. */
export function buildMonthWindow(nowSeconds: number, months: number): string[] {
  const safeMonths = clamp(months, READING_MAP_LIMITS.MIN_MONTHS, READING_MAP_LIMITS.MAX_MONTHS);
  const ref = new Date(nowSeconds * 1000);
  const endYear = ref.getUTCFullYear();
  const endMonth = ref.getUTCMonth(); // 0-indexed
  const out: string[] = [];
  let y = endYear;
  let m = endMonth;
  for (let i = 0; i < safeMonths; i++) {
    out.unshift(`${y}-${String(m + 1).padStart(2, "0")}`);
    m -= 1;
    if (m < 0) {
      m = 11;
      y -= 1;
    }
  }
  return out;
}

// ---------- pure aggregations ----------

/**
 * Validate the reading-map query. Accepts:
 *   months ∈ {6,12,24,36} — default 24
 *   topBooks ∈ [6, 18]    — default 12
 */
export function validateReadingMapQuery(input: unknown): QueryValidationResult {
  if (!input || typeof input !== "object") {
    return { ok: false, status: 400, message: "请求参数必须是 JSON object。" };
  }
  const body = input as Record<string, unknown>;

  let months = READING_MAP_LIMITS.DEFAULT_MONTHS;
  if (body.months !== undefined) {
    if (typeof body.months !== "number" || !Number.isInteger(body.months)) {
      return { ok: false, status: 400, message: "months 必须是 6 / 12 / 24 / 36 之一。" };
    }
    if (!READING_MAP_LIMITS.ALLOWED_MONTHS.includes(body.months)) {
      return { ok: false, status: 400, message: "months 必须是 6 / 12 / 24 / 36 之一。" };
    }
    months = body.months;
  }

  let topBooks = READING_MAP_LIMITS.DEFAULT_TOP_BOOKS;
  if (body.topBooks !== undefined) {
    if (typeof body.topBooks !== "number" || !Number.isInteger(body.topBooks)) {
      return { ok: false, status: 400, message: "topBooks 必须是整数。" };
    }
    if (body.topBooks < READING_MAP_LIMITS.MIN_TOP_BOOKS || body.topBooks > READING_MAP_LIMITS.MAX_TOP_BOOKS) {
      return {
        ok: false,
        status: 400,
        message: `topBooks 必须在 ${READING_MAP_LIMITS.MIN_TOP_BOOKS} 到 ${READING_MAP_LIMITS.MAX_TOP_BOOKS} 之间。`,
      };
    }
    topBooks = body.topBooks;
  }

  return { ok: true, months, topBooks };
}

/**
 * Build the timeline (one bucket per requested month). The bucket shape
 * is fixed; months with no matching notes still appear with total=0 so
 * the chart renders a complete window without gaps.
 */
export function buildReadingMapTimeline(
  notes: ReadonlyArray<PrivateNoteAggregate>,
  matchedCatalogIdSet: ReadonlySet<string>,
  nowSeconds: number,
  months: number
): ReadingMapMonthBucket[] {
  const window = buildMonthWindow(nowSeconds, months);
  const buckets = new Map<string, ReadingMapMonthBucket>();
  for (const key of window) {
    buckets.set(key, {
      month: key,
      total: 0,
      highlights: 0,
      thoughts: 0,
      reviews: 0,
      unknown: 0,
      matched: 0,
    });
  }

  for (const note of notes) {
    const ts = resolveNoteTimestampSeconds(note);
    if (ts === null) continue;
    const key = monthKeyFromSeconds(ts);
    const bucket = buckets.get(key);
    if (!bucket) continue;
    const t = normalizeNoteType(note.type);
    bucket.total += 1;
    if (t === "highlight") bucket.highlights += 1;
    else if (t === "thought") bucket.thoughts += 1;
    else if (t === "review") bucket.reviews += 1;
    else bucket.unknown += 1;
    if (matchedCatalogIdSet.has(note.catalogId)) bucket.matched += 1;
  }

  return window.map((key) => buckets.get(key)!);
}

/**
 * Calculate active / current / longest streak month counts.
 *
 * activeMonths: total number of months that received at least one valid-date note.
 * longestStreakMonths: length of the longest contiguous block of active months
 *   across the full history (not just the visible window).
 * currentStreakMonths: count of contiguous active months ending at the most
 *   recent active month. If the latest active month is < current month the
 *   streak still counts — we count back from the latest active month.
 */
export function calculateReadingStreaks(args: {
  notes: ReadonlyArray<PrivateNoteAggregate>;
  nowSeconds: number;
  /** Pre-computed timeline (ordered chronologically ascending). */
  timeline?: ReadonlyArray<{ month: string; total: number }>;
}): { activeMonths: number; currentStreakMonths: number; longestStreakMonths: number } {
  const monthHits = new Set<string>();
  for (const note of args.notes) {
    const ts = resolveNoteTimestampSeconds(note);
    if (ts === null) continue;
    monthHits.add(monthKeyFromSeconds(ts));
  }
  if (monthHits.size === 0) {
    return { activeMonths: 0, currentStreakMonths: 0, longestStreakMonths: 0 };
  }

  // Build a sortable list of (year, monthIndex) ascending.
  const keys = Array.from(monthHits);
  keys.sort();
  const activeMonths = keys.length;

  let longest = 1;
  let run = 1;
  for (let i = 1; i < keys.length; i++) {
    const prev = parseMonthKey(keys[i - 1]);
    const cur = parseMonthKey(keys[i]);
    if (prev === null || cur === null) continue;
    const expectedNext = nextMonthKey(prev.year, prev.month);
    if (expectedNext.year === cur.year && expectedNext.month === cur.month) {
      run += 1;
      if (run > longest) longest = run;
    } else {
      run = 1;
    }
  }

  // Current streak: count contiguous active months ending at the latest
  // active month (which is the last element of `keys`).
  const latest = keys[keys.length - 1];
  let currentStreak = 1;
  for (let i = keys.length - 2; i >= 0; i--) {
    const next = parseMonthKey(keys[i + 1]);
    const cur = parseMonthKey(keys[i]);
    if (next === null || cur === null) break;
    const expected = nextMonthKey(cur.year, cur.month);
    if (expected.year === next.year && expected.month === next.month) {
      currentStreak += 1;
    } else {
      break;
    }
  }
  // If the latest active month is the same as the current month, leave
  // it as-is. If the latest is older than the current month, the streak
  // is still meaningful (a "last reading burst") so we return it as is.
  void args.nowSeconds;
  void args.timeline;

  return {
    activeMonths,
    currentStreakMonths: currentStreak,
    longestStreakMonths: longest,
  };
}

interface ParsedMonthKey {
  year: number;
  month: number; // 1-12
}

function parseMonthKey(key: string): ParsedMonthKey | null {
  const m = /^(\d{4})-(\d{2})$/.exec(key);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (!Number.isFinite(year) || !Number.isFinite(month)) return null;
  if (month < 1 || month > 12) return null;
  return { year, month };
}

function nextMonthKey(year: number, month: number): ParsedMonthKey {
  if (month === 12) return { year: year + 1, month: 1 };
  return { year, month: month + 1 };
}

// ---------- per-catalog aggregation ----------

export interface AggregatedMatchedBook {
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

function isoFromSeconds(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

/**
 * Aggregate notes by public catalogId. Multiple WeRead book ids may map
 * to the same catalogId — we accumulate them. Same-body duplicates are
 * intentionally NOT collapsed (legitimate re-highlights are common).
 *
 * Sort order (stable):
 *   1) noteCount DESC
 *   2) activeMonths DESC
 *   3) lastNoteAt DESC (newer first; null treated as -Infinity)
 *   4) catalogId ASC (lexicographic)
 */
export function aggregateMatchedBooks(args: {
  notes: ReadonlyArray<PrivateNoteAggregate>;
  /** Map wereadBookId → public catalogId for confirmed matches only. */
  wereadToCatalog: ReadonlyMap<string, string>;
  /** How many top books to return. */
  limit: number;
}): AggregatedMatchedBook[] {
  const limit = clamp(args.limit, READING_MAP_LIMITS.MIN_TOP_BOOKS, READING_MAP_LIMITS.MAX_TOP_BOOKS);
  const out = new Map<string, AggregatedMatchedBook>();

  for (const note of args.notes) {
    const catalogId = args.wereadToCatalog.get(note.wereadBookId);
    if (!catalogId) continue;
    const ts = resolveNoteTimestampSeconds(note);
    if (ts === null) continue;
    const t = normalizeNoteType(note.type);
    const monthKey = monthKeyFromSeconds(ts);
    const iso = isoFromSeconds(ts);
    const existing = out.get(catalogId);
    if (!existing) {
      const bucket: AggregatedMatchedBook = {
        catalogId,
        noteCount: 1,
        highlights: t === "highlight" ? 1 : 0,
        thoughts: t === "thought" ? 1 : 0,
        reviews: t === "review" ? 1 : 0,
        unknown: t === "unknown" ? 1 : 0,
        activeMonths: 1,
        firstNoteAt: iso,
        lastNoteAt: iso,
        __monthSet: new Set<string>([monthKey]),
      } as AggregatedMatchedBook & { __monthSet: Set<string> };
      out.set(catalogId, bucket);
      continue;
    }
    existing.noteCount += 1;
    if (t === "highlight") existing.highlights += 1;
    else if (t === "thought") existing.thoughts += 1;
    else if (t === "review") existing.reviews += 1;
    else existing.unknown += 1;
    if (iso < existing.firstNoteAt!) existing.firstNoteAt = iso;
    if (iso > existing.lastNoteAt!) existing.lastNoteAt = iso;
    const monthSet = (existing as AggregatedMatchedBook & { __monthSet?: Set<string> }).__monthSet;
    if (monthSet && !monthSet.has(monthKey)) {
      monthSet.add(monthKey);
      existing.activeMonths = monthSet.size;
    }
  }

  const arr = Array.from(out.values()).map((entry) => {
    const { __monthSet, ...rest } = entry as AggregatedMatchedBook & { __monthSet?: Set<string> };
    void __monthSet;
    return rest;
  });
  arr.sort((a, b) => {
    if (b.noteCount !== a.noteCount) return b.noteCount - a.noteCount;
    if (b.activeMonths !== a.activeMonths) return b.activeMonths - a.activeMonths;
    const aLast = a.lastNoteAt ?? "";
    const bLast = b.lastNoteAt ?? "";
    if (aLast !== bLast) return bLast.localeCompare(aLast);
    return a.catalogId < b.catalogId ? -1 : a.catalogId > b.catalogId ? 1 : 0;
  });
  return arr.slice(0, limit);
}

// ---------- link builder ----------

/**
 * Build contemporaneous-reading links restricted to the supplied
 * topBooks catalog ids. For every month:
 *   - find which topBooks have ≥1 valid-date note in that month
 *   - for each unordered pair (A, B): sharedMonths += 1, weight += min(A_count, B_count)
 *
 * After aggregation:
 *   - remove self-pairs
 *   - normalise source/target ordering (source = lexicographically smaller)
 *   - dedupe by the unordered pair
 *   - sort by (sharedMonths DESC, weight DESC, sourceCatalogId ASC, targetCatalogId ASC)
 *   - cap at READING_MAP_LIMITS.MAX_LINKS (24)
 */
export function buildReadingMapLinks(args: {
  notes: ReadonlyArray<PrivateNoteAggregate>;
  /** wereadBookId → catalogId (same map used by aggregateMatchedBooks). */
  wereadToCatalog: ReadonlyMap<string, string>;
  /** Catalog ids participating in the network (topBooks). */
  topCatalogIds: ReadonlyArray<string>;
}): ReadingMapLink[] {
  if (args.topCatalogIds.length < 2) return [];
  const topSet = new Set(args.topCatalogIds);

  type PairAcc = { sharedMonths: number; weight: number };
  const pairMap = new Map<string, PairAcc>();
  type MonthAcc = Map<string, number>; // catalogId → count
  const monthMap = new Map<string, MonthAcc>();

  for (const note of args.notes) {
    const catalogId = args.wereadToCatalog.get(note.wereadBookId);
    if (!catalogId) continue;
    if (!topSet.has(catalogId)) continue;
    const ts = resolveNoteTimestampSeconds(note);
    if (ts === null) continue;
    const monthKey = monthKeyFromSeconds(ts);
    let monthAcc = monthMap.get(monthKey);
    if (!monthAcc) {
      monthAcc = new Map();
      monthMap.set(monthKey, monthAcc);
    }
    monthAcc.set(catalogId, (monthAcc.get(catalogId) ?? 0) + 1);
  }

  for (const monthAcc of monthMap.values()) {
    const ids = Array.from(monthAcc.keys());
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = ids[i];
        const b = ids[j];
        const aCount = monthAcc.get(a) ?? 0;
        const bCount = monthAcc.get(b) ?? 0;
        if (aCount === 0 || bCount === 0) continue;
        // source = lexicographically smaller so dedupe is canonical
        const source = a < b ? a : b;
        const target = a < b ? b : a;
        const key = source + "|" + target;
        const existing = pairMap.get(key);
        if (existing) {
          existing.sharedMonths += 1;
          existing.weight += Math.min(aCount, bCount);
        } else {
          pairMap.set(key, { sharedMonths: 1, weight: Math.min(aCount, bCount) });
        }
      }
    }
  }

  const links: ReadingMapLink[] = [];
  for (const [key, acc] of pairMap.entries()) {
    const sepIdx = key.indexOf("|");
    const source = key.slice(0, sepIdx);
    const target = key.slice(sepIdx + 1);
    if (source === target) continue;
    links.push({
      sourceCatalogId: source,
      targetCatalogId: target,
      sharedMonths: acc.sharedMonths,
      weight: acc.weight,
    });
  }
  links.sort((a, b) => {
    if (b.sharedMonths !== a.sharedMonths) return b.sharedMonths - a.sharedMonths;
    if (b.weight !== a.weight) return b.weight - a.weight;
    if (a.sourceCatalogId !== b.sourceCatalogId) return a.sourceCatalogId < b.sourceCatalogId ? -1 : 1;
    return a.targetCatalogId < b.targetCatalogId ? -1 : 1;
  });
  return links.slice(0, READING_MAP_LIMITS.MAX_LINKS);
}

// ---------- public metadata hydration ----------

/**
 * Attach public title / author / publisher / year to each aggregated
 * book by calling the supplied fetcher for every catalog id. The
 * fetcher is responsible for swallowing upstream errors; this helper
 * only translates its result.
 *
 * Fallback contract:
 *   - fetch returned null OR threw → title = `书目 ${catalogId}`,
 *     all ancillary fields = null.
 *   - we NEVER fall back to private WeRead title / author.
 *
 * Concurrency: fetches run in parallel via Promise.all — the caller
 * decides the underlying transport (Meili getDocument, an in-memory
 * stub for tests, etc.).
 */
export async function hydratePublicBookMetadata(
  books: ReadonlyArray<AggregatedMatchedBook>,
  fetcher: PublicMetadataFetcher
): Promise<ReadingMapBook[]> {
  const results = await Promise.all(
    books.map(async (book): Promise<ReadingMapBook> => {
      const base: ReadingMapBook = {
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
      try {
        const meta = await fetcher.fetchByCatalogId(book.catalogId);
        if (!meta || typeof meta.title !== "string" || meta.title.length === 0) return base;
        return {
          ...base,
          title: meta.title,
          author: typeof meta.author === "string" ? meta.author : null,
          publisher: typeof meta.publisher === "string" ? meta.publisher : null,
          publishYear:
            typeof meta.publishYear === "string" || typeof meta.publishYear === "number"
              ? meta.publishYear
              : null,
        };
      } catch {
        return base;
      }
    })
  );
  return results;
}

/**
 * Sync-friendly metadata resolver: given a pre-fetched `Map<catalogId, PublicBookMetadata>`
 * and a list of aggregated books, return the public-book-list shape. We
 * keep `hydratePublicBookMetadata` async-aware (returns Promise) but the
 * route handler does the fetches in parallel and then calls this helper.
 */
export function buildPublicBookItems(
  books: ReadonlyArray<AggregatedMatchedBook>,
  metadataByCatalog: ReadonlyMap<string, PublicBookMetadata>
): ReadingMapBook[] {
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
      author: meta.author ?? null,
      publisher: meta.publisher ?? null,
      publishYear: meta.publishYear ?? null,
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

// ---------- top-level orchestrator ----------

export interface BuildReadingMapArgs {
  notes: ReadonlyArray<PrivateNoteAggregate>;
  confirmedMatches: ReadonlyArray<{ wereadBookId: string; catalogId: string }>;
  /** Map wereadBookId → catalogId for confirmed matches. */
  wereadToCatalog: ReadonlyMap<string, string>;
  nowSeconds: number;
  months: number;
  topBooks: number;
  metadataByCatalog: ReadonlyMap<string, PublicBookMetadata>;
  booksCount: number;
}

/**
 * Compose the full reading-map response from validated inputs. Pure
 * function — no I/O — so it can be exercised with synthetic fixtures.
 */
export function buildPrivateReadingMap(args: BuildReadingMapArgs): PrivateReadingMapResponse {
  const matchedCatalogIds = new Set<string>();
  for (const m of args.confirmedMatches) {
    if (m.catalogId) matchedCatalogIds.add(m.catalogId);
  }

  const timeline = buildReadingMapTimeline(args.notes, matchedCatalogIds, args.nowSeconds, args.months);
  const streaks = calculateReadingStreaks({ notes: args.notes, nowSeconds: args.nowSeconds });

  // Find first/last valid-date timestamps across all notes.
  let firstMs = Number.POSITIVE_INFINITY;
  let lastMs = Number.NEGATIVE_INFINITY;
  for (const note of args.notes) {
    const ts = resolveNoteTimestampSeconds(note);
    if (ts === null) continue;
    if (ts < firstMs) firstMs = ts;
    if (ts > lastMs) lastMs = ts;
  }
  const firstNoteAt = Number.isFinite(firstMs) ? isoFromSeconds(firstMs) : null;
  const lastNoteAt = Number.isFinite(lastMs) ? isoFromSeconds(lastMs) : null;

  // matchedNoteRecordsCount: notes that have a valid date AND a confirmed mapping.
  let matchedNoteRecordsCount = 0;
  for (const note of args.notes) {
    if (!args.wereadToCatalog.has(note.wereadBookId)) continue;
    if (resolveNoteTimestampSeconds(note) === null) continue;
    matchedNoteRecordsCount += 1;
  }

  const aggregated = aggregateMatchedBooks({
    notes: args.notes,
    wereadToCatalog: args.wereadToCatalog,
    limit: args.topBooks,
  });
  const topCatalogIds = aggregated.map((b) => b.catalogId);
  const books = buildPublicBookItems(aggregated, args.metadataByCatalog);
  const links = buildReadingMapLinks({
    notes: args.notes,
    wereadToCatalog: args.wereadToCatalog,
    topCatalogIds,
  });

  return {
    ok: true,
    overview: {
      booksCount: args.booksCount,
      notesCount: args.notes.length,
      matchedCatalogsCount: matchedCatalogIds.size,
      matchedNoteRecordsCount,
      firstNoteAt,
      lastNoteAt,
      activeMonths: streaks.activeMonths,
      currentStreakMonths: streaks.currentStreakMonths,
      longestStreakMonths: streaks.longestStreakMonths,
    },
    timeline,
    books,
    links,
    meta: {
      monthsRequested: args.months,
      monthsReturned: timeline.length,
      topBooksRequested: args.topBooks,
      topBooksReturned: books.length,
      linksReturned: links.length,
      persisted: false,
      source: "private_snapshot+public_catalog",
    },
  };
}

// ---------- end-to-end orchestration ----------

export interface OrchestrationResult {
  response?: PrivateReadingMapResponse;
  error?: { status: number; message: string };
}

export interface RunReadingMapArgs {
  query: unknown;
  notes: ReadonlyArray<PrivateNoteAggregate>;
  confirmedMatches: ReadonlyArray<{ wereadBookId: string; catalogId: string }>;
  booksCount: number;
  /** Resolves a catalogId to public metadata. */
  fetchMetadata: PublicMetadataFetcher;
  /** Override for "now" in tests. Defaults to `Date.now() / 1000`. */
  nowSeconds?: number;
}

/**
 * End-to-end orchestrator used by the route handler:
 *   - validate query
 *   - build the wereadBookId → catalogId map from confirmed matches
 *   - fetch public metadata for the candidate topBooks in parallel
 *   - assemble the full response
 *
 * The helper deliberately swallows public metadata failures: any
 * `fetchMetadata.fetchByCatalogId` exception or null result falls back
 * to `书目 ${catalogId}` with empty ancillary fields. The endpoint
 * itself therefore only fails on bad input or auth (which is handled
 * upstream of this helper).
 */
export async function runPrivateReadingMap(args: RunReadingMapArgs): Promise<OrchestrationResult> {
  const validation = validateReadingMapQuery(args.query);
  if (!validation.ok) {
    return { error: { status: validation.status, message: validation.message } };
  }

  const wereadToCatalog = new Map<string, string>();
  for (const m of args.confirmedMatches) {
    if (typeof m?.wereadBookId === "string" && typeof m?.catalogId === "string") {
      wereadToCatalog.set(m.wereadBookId, m.catalogId);
    }
  }

  // Pre-compute the aggregated top catalog ids so we know exactly which
  // metadata to fetch. We do this twice (once here, once in
  // buildPrivateReadingMap) to avoid pulling public data for catalog ids
  // that won't make it into topBooks.
  const quickAggregate = aggregateMatchedBooks({
    notes: args.notes,
    wereadToCatalog,
    limit: validation.topBooks,
  });
  const candidateIds = quickAggregate.map((b) => b.catalogId);

  const metadataByCatalog = new Map<string, PublicBookMetadata>();
  await Promise.all(
    candidateIds.map(async (catalogId) => {
      try {
        const meta = await args.fetchMetadata.fetchByCatalogId(catalogId);
        if (meta && typeof meta.title === "string" && meta.title.length > 0) {
          // Defensive: only keep the documented public fields, in case
          // the upstream doc shape ever starts carrying private data.
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
        /* swallow — fallback handled in buildPublicBookItems */
      }
    })
  );

  const nowSeconds = typeof args.nowSeconds === "number" ? args.nowSeconds : Math.floor(Date.now() / 1000);
  const response = buildPrivateReadingMap({
    notes: args.notes,
    confirmedMatches: args.confirmedMatches,
    wereadToCatalog,
    nowSeconds,
    months: validation.months,
    topBooks: validation.topBooks,
    metadataByCatalog,
    booksCount: args.booksCount,
  });

  return { response };
}

// Process side-effect-free reference so the module is not flagged by
// noUnusedLocals during type checking.
void process;