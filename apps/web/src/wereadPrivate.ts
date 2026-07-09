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
  const qs = params.toString();
  const path = qs ? `/private/weread/notes?${qs}` : "/private/weread/notes";
  return privateRequestJson<WereadNotesResponse>(token, path);
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
