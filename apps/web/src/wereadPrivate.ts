export interface WereadSummary {
  ok: boolean;
  dataAvailable: boolean;
  booksCount: number;
  notesCount: number;
  confirmedMatchesCount: number;
  confirmedWithNotesCount?: number;
  confirmedWithHighlightsCount?: number;
  totalConfirmedNoteRecords?: number;
}

export interface WereadNotesSummary {
  total: number;
  highlights: number;
  thoughts: number;
  reviews: number;
  unknown: number;
  hasNotes: boolean;
}

export interface WereadStatus {
  ok: boolean;
  matched: boolean;
  catalogId: string;
  weread?: {
    readingStatus?: string;
    progress?: number | null;
    noteCount?: number;
    highlightCount?: number;
    matchedRecordsCount?: number;
    notesSummary?: WereadNotesSummary;
    lastReadAt?: string | null;
    updatedAt?: string | null;
    matchMethod?: string;
    matchConfidence?: string;
    decisionSource?: string;
  };
}

export interface WereadTrendPoint {
  date: string;
  total: number;
  highlights: number;
  thoughts: number;
  reviews: number;
  unknown: number;
}

export interface WereadTrendWindow {
  total: number;
  activeDays: number;
  activeBooks: number;
  highlights: number;
  thoughts: number;
  reviews: number;
  unknown: number;
  daily?: WereadTrendPoint[];
}

export interface WereadTrendAllTimeWindow {
  total: number;
  activeDays: number;
  activeBooks: number;
  highlights: number;
  thoughts: number;
  reviews: number;
  unknown: number;
}

export interface WereadConfirmedOnlyStats {
  total: number;
  activeBooks: number;
  highlights: number;
  thoughts: number;
  reviews: number;
  unknown: number;
}

export interface WereadTrendCoverage {
  notesWithDate: number;
  notesWithoutDate: number;
  dateCoverageRatio: number;
}

export interface WereadTrends {
  generatedAt: string;
  windows: {
    days7: WereadTrendWindow;
    days30: WereadTrendWindow;
    days90: WereadTrendWindow;
    allTime: WereadTrendAllTimeWindow;
  };
  confirmedOnly: WereadConfirmedOnlyStats;
  coverage: WereadTrendCoverage;
}

export interface WereadTrendsResponse {
  ok: boolean;
  trends?: WereadTrends;
  error?: string;
}

export interface WereadCenterSummaryView {
  booksCount: number;
  notesCount: number;
  confirmedMatchesCount: number;
  confirmedWithNotesCount: number;
  confirmedWithHighlightsCount: number;
  totalConfirmedNoteRecords: number;
  matchRatePercent: number;
  notesPerConfirmedMatch: number;
  hasNotes: boolean;
  privacyCopy: string;
}

const TOKEN_KEY = "book-id-search:weread-private-token";

function getStorage(): Storage | null {
  try {
    return (globalThis as unknown as Window).sessionStorage ?? null;
  } catch {
    return null;
  }
}

export function getWereadToken(): string | null {
  try {
    return getStorage()?.getItem(TOKEN_KEY) || null;
  } catch {
    return null;
  }
}

export function saveWereadToken(token: string): void {
  try {
    getStorage()?.setItem(TOKEN_KEY, token);
  } catch {
    /* ignore storage errors */
  }
}

export function clearWereadToken(): void {
  try {
    getStorage()?.removeItem(TOKEN_KEY);
  } catch {
    /* ignore storage errors */
  }
}

export function isWereadEnabled(): boolean {
  return !!getWereadToken();
}

const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:3001/api";

async function privateRequestJson<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      ...(init?.headers || {}),
      Authorization: `Bearer ${token}`,
    },
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const message = data?.error ?? "请求失败";
    throw new Error(message);
  }
  return data as T;
}

export function fetchWereadSummary(token: string): Promise<WereadSummary> {
  return privateRequestJson<WereadSummary>(token, "/private/weread/summary");
}

export function fetchWereadStatus(token: string, catalogId: string): Promise<WereadStatus> {
  return privateRequestJson<WereadStatus>(token, `/private/weread/status?catalogId=${encodeURIComponent(catalogId)}`);
}

export function fetchWereadTrends(token: string): Promise<WereadTrendsResponse> {
  return privateRequestJson<WereadTrendsResponse>(token, "/private/weread/trends");
}

// ---------- private notes library (S27C) ----------

export type WereadNoteTypeFilter = "all" | "highlight" | "thought" | "review";
export type WereadNotesDaysFilter = "7" | "30" | "90" | "all";
export type WereadNotesSort = "newest" | "oldest";

export interface WereadPrivateNoteItem {
  type: "highlight" | "thought" | "review" | "unknown";
  text: string;
  comment: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  matched: boolean;
  catalogId: string | null;
  source: "private_weread";
}

export interface WereadNotesQuery {
  type?: WereadNoteTypeFilter;
  days?: WereadNotesDaysFilter;
  matchedOnly?: boolean;
  hasComment?: boolean;
  limit?: number;
  offset?: number;
  sort?: WereadNotesSort;
  /** S27D: optional full-text query over note text/comment only. */
  q?: string;
  /**
   * S27F: optional public catalog id filter. When provided, only notes
   * matched to that catalogId are returned. Must be a non-empty string
   * matching the public catalogId format. Never logged or echoed in
   * error messages; only the trimmed value (if non-empty) is sent.
   */
  catalogId?: string;
}

export interface WereadNotesPageInfo {
  limit: number;
  offset: number;
  total: number;
  hasMore: boolean;
}

export interface WereadNotesLibrarySummary {
  totalAfterFilter: number;
  highlights: number;
  thoughts: number;
  reviews: number;
  unknown: number;
  matchedCount: number;
  unmatchedCount: number;
}

/**
 * S27D: server-side search telemetry. Never contains the raw query or
 * the per-term list — only length/term-count/matched-count plus a flag.
 */
export interface WereadNotesSearchInfo {
  enabled: boolean;
  queryLength: number;
  termsCount: number;
  matchedCount: number;
}

export interface WereadNotesResponse {
  ok: boolean;
  items: WereadPrivateNoteItem[];
  pageInfo: WereadNotesPageInfo;
  summary: WereadNotesLibrarySummary;
  searchInfo?: WereadNotesSearchInfo;
  error?: string;
}

export function fetchWereadNotes(token: string, query: WereadNotesQuery = {}): Promise<WereadNotesResponse> {
  const params = new URLSearchParams();
  if (query.type) params.set("type", query.type);
  if (query.days) params.set("days", query.days);
  if (typeof query.matchedOnly === "boolean") params.set("matchedOnly", String(query.matchedOnly));
  if (typeof query.hasComment === "boolean") params.set("hasComment", String(query.hasComment));
  if (typeof query.limit === "number") params.set("limit", String(query.limit));
  if (typeof query.offset === "number") params.set("offset", String(query.offset));
  if (query.sort) params.set("sort", query.sort);
  // S27D: trim q and only attach when non-empty. The query is sent over the
  // wire exactly once — there is no client-side cache of note bodies, and we
  // never log q or include it in error messages.
  if (typeof query.q === "string") {
    const trimmed = query.q.trim();
    if (trimmed.length > 0) params.set("q", trimmed);
  }
  // S27F: catalogId — trimmed, only sent when it matches the public
  // catalogId format. Never logged; never echoed in error messages.
  if (typeof query.catalogId === "string") {
    const trimmed = query.catalogId.trim();
    if (/^[0-9]+_[0-9]{12}$/.test(trimmed)) params.set("catalogId", trimmed);
  }
  const qs = params.toString();
  const path = qs ? `/private/weread/notes?${qs}` : "/private/weread/notes";
  return privateRequestJson<WereadNotesResponse>(token, path);
}

/* -----------------------------------------------------------------------
 * S27H — Private WeRead "personal reading map".
 *
 * Only aggregated counts (timeline, top books, contemporaneous-reading
 * links, streak counters) leave the server. The endpoint never returns
 * note text / comment / wereadBookId / noteId / highlightId /
 * chapterTitle / raw WeRead title / author.
 *
 * The browser request is a plain `GET` with an `Authorization: Bearer …`
 * header — no body, no `q`, no raw notes. Nothing is cached to
 * localStorage / sessionStorage and the response is never logged.
 * ----------------------------------------------------------------------- */

export interface WereadReadingMapOverview {
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

export interface WereadReadingMapMonth {
  month: string;
  total: number;
  highlights: number;
  thoughts: number;
  reviews: number;
  unknown: number;
  matched: number;
}

export interface WereadReadingMapBook {
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

export interface WereadReadingMapLink {
  sourceCatalogId: string;
  targetCatalogId: string;
  sharedMonths: number;
  weight: number;
}

export interface WereadReadingMapMeta {
  monthsRequested: number;
  monthsReturned: number;
  topBooksRequested: number;
  topBooksReturned: number;
  linksReturned: number;
  persisted: false;
  source: "private_snapshot+public_catalog";
}

export interface WereadReadingMapResponse {
  ok: true;
  overview: WereadReadingMapOverview;
  timeline: WereadReadingMapMonth[];
  books: WereadReadingMapBook[];
  links: WereadReadingMapLink[];
  meta: WereadReadingMapMeta;
}

export interface WereadReadingMapErrorResponse {
  ok?: false;
  error?: string;
}

export const WEREAD_READING_MAP_CLIENT_LIMITS = {
  MIN_MONTHS: 6,
  MAX_MONTHS: 36,
  ALLOWED_MONTHS: [6, 12, 24, 36] as const,
  DEFAULT_MONTHS: 24,
  MIN_TOP_BOOKS: 6,
  MAX_TOP_BOOKS: 18,
  DEFAULT_TOP_BOOKS: 12,
} as const;

export type WereadReadingMapMonthsOption =
  (typeof WEREAD_READING_MAP_CLIENT_LIMITS.ALLOWED_MONTHS)[number];

export interface FetchWereadReadingMapOptions {
  months?: WereadReadingMapMonthsOption;
  topBooks?: number;
  signal?: AbortSignal;
}

/**
 * GET /api/private/weread/reading-map
 *
 * The browser request carries no body and no identifiers besides the
 * `Authorization: Bearer …` header. Months and topBooks are validated
 * client-side before being attached so that a typo can never silently
 * broaden the request — any out-of-range value is silently clamped to
 * the documented default and no error is raised (the server is the
 * authoritative validator; this is purely UX polish).
 */
export function fetchWereadReadingMap(
  token: string,
  options: FetchWereadReadingMapOptions = {}
): Promise<WereadReadingMapResponse> {
  const params = new URLSearchParams();
  let months: WereadReadingMapMonthsOption = WEREAD_READING_MAP_CLIENT_LIMITS.DEFAULT_MONTHS;
  if (
    typeof options.months === "number" &&
    (WEREAD_READING_MAP_CLIENT_LIMITS.ALLOWED_MONTHS as ReadonlyArray<number>).includes(options.months)
  ) {
    months = options.months as WereadReadingMapMonthsOption;
  }
  params.set("months", String(months));
  let topBooks: number = WEREAD_READING_MAP_CLIENT_LIMITS.DEFAULT_TOP_BOOKS;
  if (typeof options.topBooks === "number" && Number.isInteger(options.topBooks)) {
    topBooks = Math.min(
      WEREAD_READING_MAP_CLIENT_LIMITS.MAX_TOP_BOOKS,
      Math.max(WEREAD_READING_MAP_CLIENT_LIMITS.MIN_TOP_BOOKS, options.topBooks)
    );
  }
  params.set("topBooks", String(topBooks));
  const qs = params.toString();
  const path = qs
    ? `/private/weread/reading-map?${qs}`
    : "/private/weread/reading-map";
  return privateRequestJson<WereadReadingMapResponse>(token, path, {
    method: "GET",
    signal: options.signal,
  });
}

// ---------- S27F per-book pagination helper ----------

export const WEREAD_BOOK_PAGINATION = {
  DEFAULT_PAGE_SIZE: 100,
  MAX_PAGE_SIZE: 100,
  DEFAULT_MAX_ITEMS: 2000,
  MAX_MAX_ITEMS: 2000,
  MAX_PAGES: 20,
} as const;

export interface FetchAllWereadBookNotesOptions {
  maxItems?: number;
  pageSize?: number;
  signal?: AbortSignal;
}

/**
 * S27F: getWereadBookPagination — return the default pagination envelope
 * for fetchAllWereadBookNotes. This lets call sites spread the defaults
 * alongside their own overrides without re-importing the constants.
 */
export function getWereadBookPagination(): { maxItems: number; pageSize: number } {
  return {
    maxItems: WEREAD_BOOK_PAGINATION.DEFAULT_MAX_ITEMS,
    pageSize: WEREAD_BOOK_PAGINATION.DEFAULT_PAGE_SIZE,
  };
}

export interface FetchAllWereadBookNotesOptions {
  maxItems?: number;
  pageSize?: number;
  signal?: AbortSignal;
}

export interface FetchAllWereadBookNotesResult {
  items: WereadPrivateNoteItem[];
  total: number;
  truncated: boolean;
}

/**
 * S27F: paginated aggregation of every private note attached to a single
 * public catalog id.
 *
 * Rules:
 *  - pageSize clamped to [1, MAX_PAGE_SIZE]; default DEFAULT_PAGE_SIZE.
 *  - maxItems clamped to [1, MAX_MAX_ITEMS]; default DEFAULT_MAX_ITEMS.
 *  - iterates from offset=0 until either hasMore=false, the page is empty,
 *    maxItems is reached, or MAX_PAGES pages have been fetched.
 *  - every page passes catalogId so the server can filter directly.
 *  - identical notes (same text/comment) are NOT deduplicated — the server
 *    already redacts private IDs, and legitimate duplicate highlights are
 *    common.
 *  - the `signal` aborts between page fetches too.
 *  - nothing is logged and the returned array is a fresh defensive copy.
 */
export async function fetchAllWereadBookNotes(
  token: string,
  catalogId: string,
  options: FetchAllWereadBookNotesOptions = {}
): Promise<FetchAllWereadBookNotesResult> {
  const trimmedCatalogId = typeof catalogId === "string" ? catalogId.trim() : "";
  if (!/^[0-9]+_[0-9]{12}$/.test(trimmedCatalogId)) {
    throw new Error("catalogId 格式不正确。");
  }
  const rawPageSize = typeof options.pageSize === "number" ? options.pageSize : WEREAD_BOOK_PAGINATION.DEFAULT_PAGE_SIZE;
  const pageSize = Math.min(WEREAD_BOOK_PAGINATION.MAX_PAGE_SIZE, Math.max(1, Math.floor(rawPageSize)));
  const rawMax = typeof options.maxItems === "number" ? options.maxItems : WEREAD_BOOK_PAGINATION.DEFAULT_MAX_ITEMS;
  const maxItems = Math.min(WEREAD_BOOK_PAGINATION.MAX_MAX_ITEMS, Math.max(1, Math.floor(rawMax)));

  const items: WereadPrivateNoteItem[] = [];
  let total = 0;
  let truncated = false;
  let lastOffset = -1;
  for (let page = 0; page < WEREAD_BOOK_PAGINATION.MAX_PAGES; page++) {
    if (options.signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    const offset = page * pageSize;
    if (offset === lastOffset) break;
    lastOffset = offset;
    const resp = await fetchWereadNotes(token, {
      type: "all",
      days: "all",
      matchedOnly: true,
      sort: "newest",
      catalogId: trimmedCatalogId,
      limit: pageSize,
      offset,
    });
    if (!resp || resp.ok !== true) throw new Error("私有 API 返回异常");
    if (page === 0) total = typeof resp.pageInfo.total === "number" ? resp.pageInfo.total : 0;
    const batch = Array.isArray(resp.items) ? resp.items : [];
    for (const item of batch) {
      if (items.length >= maxItems) {
        truncated = true;
        break;
      }
      items.push(item);
    }
    if (truncated) break;
    if (!resp.pageInfo.hasMore) break;
    if (batch.length === 0) break;
  }
  if (items.length >= maxItems && total > items.length) truncated = true;
  // If we exited the loop because MAX_PAGES was hit but the server still
  // reports more records available, mark truncated.
  if (items.length < maxItems && total > items.length) truncated = true;
  return { items, total, truncated };
}

const statusCache = new Map<string, Promise<WereadStatus>>();
const CACHE_LIMIT = 200;
const BATCH_MAX = 100;

export async function fetchWereadStatusesForBooks(
  token: string,
  catalogIds: string[]
): Promise<Record<string, WereadStatus>> {
  const uniqueIds = [...new Set(catalogIds)].slice(0, CACHE_LIMIT);
  if (uniqueIds.length === 0) return {};

  const out: Record<string, WereadStatus> = {};
  const toFetch: string[] = [];

  for (const id of uniqueIds) {
    const cached = statusCache.get(id);
    if (cached) {
      try {
        out[id] = await cached;
      } catch {
        /* leave out on error */
      }
    } else {
      toFetch.push(id);
    }
  }

  if (toFetch.length === 0) return out;

  // Try batch endpoint first for uncached ids
  const batchIds = toFetch.slice(0, BATCH_MAX);
  try {
    const response = await fetch(`${API_BASE}/private/weread/status/batch`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ catalogIds: batchIds }),
    });

    if (response.status === 401 || response.status === 403) {
      const data = await response.json().catch(() => null);
      const message = data?.error ?? "认证失败";
      throw new Error(message);
    }

    if (response.ok) {
      const data = (await response.json()) as {
        ok: boolean;
        results?: Record<string, WereadStatus>;
      };
      const results = data.results ?? {};
      for (const [id, value] of Object.entries(results)) {
        if (statusCache.size >= CACHE_LIMIT) break;
        statusCache.set(id, Promise.resolve(value));
        out[id] = value;
      }
      return out;
    }
  } catch (err) {
    if (err instanceof Error && /401|403|认证失败|Invalid token|Missing token/i.test(err.message)) {
      throw err;
    }
    // continue to fallback on network/server errors
  }

  // Fallback: per-catalogId single status
  const concurrency = 4;
  for (let i = 0; i < toFetch.length; i += concurrency) {
    const batch = toFetch.slice(i, i + concurrency);
    await Promise.all(
      batch.map(async (id) => {
        const promise = fetchWereadStatus(token, id).catch((err: Error) => {
          statusCache.delete(id);
          return {
            ok: false,
            matched: false,
            catalogId: id,
            error: err.message,
          } as unknown as WereadStatus;
        });
        if (statusCache.size < CACHE_LIMIT) {
          statusCache.set(id, promise);
        }
        try {
          out[id] = await promise;
        } catch {
          /* leave out */
        }
      })
    );
  }

  return out;
}

export function clearWereadStatusCache(): void {
  statusCache.clear();
}

export function formatWereadCenterSummary(summary: WereadSummary | null): WereadCenterSummaryView {
  const safe = (n: number | undefined) => (typeof n === "number" && !Number.isNaN(n) ? n : 0);
  const booksCount = safe(summary?.booksCount);
  const notesCount = safe(summary?.notesCount);
  const confirmedMatchesCount = safe(summary?.confirmedMatchesCount);
  const confirmedWithNotesCount = safe(summary?.confirmedWithNotesCount);
  const confirmedWithHighlightsCount = safe(summary?.confirmedWithHighlightsCount);
  const totalConfirmedNoteRecords = safe(summary?.totalConfirmedNoteRecords);
  const matchRatePercent = booksCount > 0 ? Math.round((confirmedMatchesCount / booksCount) * 1000) / 10 : 0;
  const notesPerConfirmedMatch = confirmedMatchesCount > 0 ? Math.round(totalConfirmedNoteRecords / confirmedMatchesCount) : 0;
  return {
    booksCount,
    notesCount,
    confirmedMatchesCount,
    confirmedWithNotesCount,
    confirmedWithHighlightsCount,
    totalConfirmedNoteRecords,
    matchRatePercent,
    notesPerConfirmedMatch,
    hasNotes: notesCount > 0,
    privacyCopy: "Token 仅保存在 sessionStorage，不显示笔记或划线的原文，不返回微信读书内部 ID。",
  };
}

export const WEREAD_FORBIDDEN_WORDS = [
  "wereadBookId",
  "noteId",
  "highlightId",
  "chapterTitle",
  "笔记正文",
  "划线正文",
  "笔记原文",
  "划线原文",
];

export function hasForbiddenWereadText(value: string): boolean {
  return WEREAD_FORBIDDEN_WORDS.some((word) => value.includes(word));
}

/* -----------------------------------------------------------------------
 * S27E — Private WeRead AI notes summarisation.
 *
 * Only the items currently loaded in the browser are sent. The payload is
 * sanitized again on the server (apps/api/src/weread/private-ai-summary.ts)
 * but the client rebuilds the request body from a fixed schema so that
 * `q`, `catalogId`, `matched`, IDs, dates, and any other private data
 * cannot leak via the request.
 * ----------------------------------------------------------------------- */

export type WereadAiSummaryNoteType = "highlight" | "thought" | "review" | "unknown";

export type WereadAiSummaryInputItem = {
  type: WereadAiSummaryNoteType;
  text: string;
  comment?: string | null;
};

export type WereadAiSummaryTheme = {
  title: string;
  summary: string;
  evidenceCount: number;
};

export type WereadAiSummaryResult = {
  overview: string;
  themes: WereadAiSummaryTheme[];
  keyPoints: string[];
  reviewQuestions: string[];
  readingDirections: string[];
};

export type WereadAiSummaryMeta = {
  itemsUsed: number;
  totalCharacters: number;
  persisted: false;
  provider: "minimax";
};

export type WereadAiSummaryResponse = {
  ok: true;
  summary: WereadAiSummaryResult;
  meta: WereadAiSummaryMeta;
};

export type WereadAiSummaryErrorStatus =
  | 400
  | 401
  | 403
  | 404
  | 413
  | 429
  | 502
  | 503
  | 504;

/**
 * POST /api/private/weread/notes/summarize
 *
 * `signal` lets callers abort an in-flight request when the token changes
 * or the user leaves /weread, so a stale response can never write into
 * the page after the user has moved on.
 */
export function fetchWereadAiSummary(
  token: string,
  items: WereadAiSummaryInputItem[],
  signal?: AbortSignal
): Promise<WereadAiSummaryResponse> {
  // Defensive rebuild: ignore anything except type/text/comment, and make
  // sure both fields are strings before they leave the browser.
  const safeItems: WereadAiSummaryInputItem[] = [];
  for (const it of items) {
    if (!it || typeof it !== "object") continue;
    const type: WereadAiSummaryNoteType =
      it.type === "highlight" ||
      it.type === "thought" ||
      it.type === "review"
        ? it.type
        : "unknown";
    const text = typeof it.text === "string" ? it.text : "";
    const comment = typeof it.comment === "string" ? it.comment : null;
    if (!text && !comment) continue;
    safeItems.push({ type, text, comment });
  }
  return privateRequestJson<WereadAiSummaryResponse>(
    token,
    "/private/weread/notes/summarize",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: safeItems }),
      signal,
    }
  );
}

/* -----------------------------------------------------------------------
 * S27G — Discover related public books from sanitised AI-summary themes.
 *
 * Only short theme labels (≤80 chars per seed, ≤320 total, ≤6 seeds)
 * leave the browser. Raw note text, AI summary body, search terms (`q`),
 * token, wereadBookId/noteId/highlightId/chapterTitle, private titles,
 * and authors are NEVER included in the request body.
 *
 * The endpoint is `POST /api/private/weread/related-books` and returns a
 * list of public catalog metadata with the local seed ids that matched.
 * Requests are NOT cached to local/session storage and never logged.
 * ----------------------------------------------------------------------- */

export interface WereadRelatedBookSeed {
  id: string;
  text: string;
}

export interface WereadRelatedBookItem {
  catalogId: string;
  title: string;
  author?: string | null;
  publisher?: string | null;
  publishYear?: string | number | null;
  isbn?: string | null;
  matchedSeedIds: string[];
}

export interface WereadRelatedBooksMeta {
  seedsUsed: number;
  candidatesConsidered: number;
  returned: number;
  excluded: number;
  persisted: false;
  source: "meilisearch";
}

export interface WereadRelatedBooksResponse {
  ok: true;
  items: WereadRelatedBookItem[];
  meta: WereadRelatedBooksMeta;
}

export const WEREAD_RELATED_BOOKS_CLIENT_LIMITS = {
  MAX_SEEDS: 6,
  MAX_SEED_CHARS: 80,
  MAX_TOTAL_CHARS: 320,
  MIN_LIMIT: 1,
  MAX_LIMIT: 24,
  DEFAULT_LIMIT: 12,
  MAX_EXCLUDE_IDS: 100,
  SEED_ID_RE: /^[A-Za-z0-9_-]{1,32}$/,
  CATALOG_ID_RE: /^[0-9]+_[0-9]{12}$/,
} as const;

const RELATED_BOOKS_CONTROL_CHAR_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

function sanitizeRelatedBookSeed(raw: unknown, totalCharsRef: { count: number }): WereadRelatedBookSeed | null {
  if (!raw || typeof raw !== "object") return null;
  const body = raw as Record<string, unknown>;
  const id = typeof body.id === "string" ? body.id : "";
  if (!WEREAD_RELATED_BOOKS_CLIENT_LIMITS.SEED_ID_RE.test(id)) return null;
  const rawText = typeof body.text === "string" ? body.text : "";
  if (rawText.length > WEREAD_RELATED_BOOKS_CLIENT_LIMITS.MAX_SEED_CHARS) {
    return null;
  }
  const cleaned = rawText.replace(RELATED_BOOKS_CONTROL_CHAR_RE, "").trim();
  if (cleaned.length === 0) return null;
  const collapsed = cleaned.replace(/\s+/g, " ");
  if (collapsed.length === 0) return null;
  if (collapsed.length > WEREAD_RELATED_BOOKS_CLIENT_LIMITS.MAX_SEED_CHARS) return null;
  if (totalCharsRef.count + collapsed.length > WEREAD_RELATED_BOOKS_CLIENT_LIMITS.MAX_TOTAL_CHARS) {
    return null;
  }
  totalCharsRef.count += collapsed.length;
  return { id, text: collapsed };
}

function sanitizeRelatedBookExclusions(
  raw: ReadonlyArray<unknown>
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of raw) {
    if (typeof id !== "string") continue;
    const trimmed = id.trim();
    if (!WEREAD_RELATED_BOOKS_CLIENT_LIMITS.CATALOG_ID_RE.test(trimmed)) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= WEREAD_RELATED_BOOKS_CLIENT_LIMITS.MAX_EXCLUDE_IDS) break;
  }
  return out;
}

/**
 * POST /api/private/weread/related-books
 *
 * The body is reconstructed from a strict `{seeds, excludeCatalogIds, limit}`
 * schema; everything else (overview, keyPoints, questions, raw note text,
 * token, q, private IDs) is dropped before the request is issued.
 *
 * Errors thrown by this function NEVER include the token or the seed text
 * — only the Chinese-language status / error message returned by the
 * server, or a synthetic fetch failure message.
 */
export function fetchWereadRelatedBooks(
  token: string,
  seeds: ReadonlyArray<unknown>,
  excludeCatalogIds: ReadonlyArray<unknown> = [],
  signal?: AbortSignal
): Promise<WereadRelatedBooksResponse> {
  // 1. Strictly rebuild the seeds list. Order is preserved.
  const totalCharsRef = { count: 0 };
  const safeSeeds: WereadRelatedBookSeed[] = [];
  const seenTexts = new Set<string>();
  for (const raw of seeds) {
    const cleaned = sanitizeRelatedBookSeed(raw, totalCharsRef);
    if (!cleaned) continue;
    if (seenTexts.has(cleaned.text)) continue;
    seenTexts.add(cleaned.text);
    safeSeeds.push(cleaned);
    if (safeSeeds.length >= WEREAD_RELATED_BOOKS_CLIENT_LIMITS.MAX_SEEDS) break;
  }
  if (safeSeeds.length === 0) {
    return Promise.reject(new Error("至少需要 1 个有效主题。"));
  }

  // 2. Build exclusions from the caller's supplied list.
  const safeExcludes = sanitizeRelatedBookExclusions(excludeCatalogIds);

  // 3. Issue the request with a strict JSON body. Limit is bounded by the
  //    server contract (1-24, default 12) so any client-provided value is
  //    clamped before leaving the browser.
  const rawLimit = WEREAD_RELATED_BOOKS_CLIENT_LIMITS.DEFAULT_LIMIT;
  const limit = Math.min(
    WEREAD_RELATED_BOOKS_CLIENT_LIMITS.MAX_LIMIT,
    Math.max(WEREAD_RELATED_BOOKS_CLIENT_LIMITS.MIN_LIMIT, Math.floor(rawLimit))
  );

  return privateRequestJson<WereadRelatedBooksResponse>(
    token,
    "/private/weread/related-books",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        seeds: safeSeeds,
        excludeCatalogIds: safeExcludes,
        limit,
      }),
      signal,
    }
  );
}

/* -----------------------------------------------------------------------
 * S27J — Private WeRead "annual reading review".
 *
 * Endpoint:
 *   GET /api/private/weread/annual-review?year=<YYYY>&topBooks=<6|12|18>
 *
 * Only year / count / type / month / public catalog metadata leave the
 * server. The browser request is a plain `GET` with an
 * `Authorization: Bearer …` header — no body, no note ids, no
 * `/api/search` call. Nothing is cached to localStorage /
 * sessionStorage and the response is never logged.
 * ----------------------------------------------------------------------- */

export interface WereadAnnualReviewOverview {
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

export interface WereadAnnualReviewMonth {
  month: string;
  total: number;
  highlights: number;
  thoughts: number;
  reviews: number;
  unknown: number;
  matched: number;
  bookCount: number;
}

export type WereadAnnualReviewQuarterKey = "Q1" | "Q2" | "Q3" | "Q4";

export interface WereadAnnualReviewQuarter {
  quarter: WereadAnnualReviewQuarterKey;
  total: number;
  activeMonths: number;
  matchedRecords: number;
  bookCount: number;
}

export interface WereadAnnualReviewBook {
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

export interface WereadAnnualReviewMeta {
  topBooksRequested: number;
  topBooksReturned: number;
  persisted: false;
  source: "private_snapshot+public_catalog";
}

export interface WereadAnnualReviewResponse {
  ok: true;
  selectedYear: number;
  availableYears: number[];
  overview: WereadAnnualReviewOverview;
  months: WereadAnnualReviewMonth[];
  quarters: WereadAnnualReviewQuarter[];
  topBooks: WereadAnnualReviewBook[];
  meta: WereadAnnualReviewMeta;
}

export const WEREAD_ANNUAL_REVIEW_CLIENT_LIMITS = {
  MIN_YEAR: 2000,
  ALLOWED_TOP_BOOKS: [6, 12, 18] as const,
  DEFAULT_TOP_BOOKS: 12,
} as const;

export type WereadAnnualReviewTopBooksOption =
  (typeof WEREAD_ANNUAL_REVIEW_CLIENT_LIMITS.ALLOWED_TOP_BOOKS)[number];

export interface FetchWereadAnnualReviewOptions {
  year?: number;
  topBooks?: WereadAnnualReviewTopBooksOption;
  signal?: AbortSignal;
}

export function fetchWereadAnnualReview(
  token: string,
  options: FetchWereadAnnualReviewOptions = {}
): Promise<WereadAnnualReviewResponse> {
  const params = new URLSearchParams();
  if (
    typeof options.year === "number" &&
    Number.isInteger(options.year) &&
    options.year >= WEREAD_ANNUAL_REVIEW_CLIENT_LIMITS.MIN_YEAR
  ) {
    params.set("year", String(options.year));
  }
  let topBooks: WereadAnnualReviewTopBooksOption = WEREAD_ANNUAL_REVIEW_CLIENT_LIMITS.DEFAULT_TOP_BOOKS;
  if (
    typeof options.topBooks === "number" &&
    (WEREAD_ANNUAL_REVIEW_CLIENT_LIMITS.ALLOWED_TOP_BOOKS as ReadonlyArray<number>).includes(options.topBooks)
  ) {
    topBooks = options.topBooks;
  }
  params.set("topBooks", String(topBooks));
  const qs = params.toString();
  const path = qs
    ? `/private/weread/annual-review?${qs}`
    : "/private/weread/annual-review";
  return privateRequestJson<WereadAnnualReviewResponse>(token, path, {
    method: "GET",
    signal: options.signal,
  });
}
