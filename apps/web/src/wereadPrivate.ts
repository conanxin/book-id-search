export interface WereadSummary {
  ok: boolean;
  dataAvailable: boolean;
  booksCount: number;
  notesCount: number;
  confirmedMatchesCount: number;
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
    lastReadAt?: string | null;
    updatedAt?: string | null;
    matchMethod?: string;
    matchConfidence?: string;
    decisionSource?: string;
  };
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
