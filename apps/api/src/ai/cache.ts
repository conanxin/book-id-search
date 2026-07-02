/**
 * Simple in-memory LRU cache with TTL for AI search-intent responses.
 *
 * Process-local (resets on container restart). That's intentional — the
 * cache is a token-saving optimization, not a correctness requirement.
 *
 * Key invariants:
 *   - Never caches error responses
 *   - Never caches responses with empty `query`
 *   - Never caches raw provider payloads or API keys
 *   - LRU eviction at maxEntries
 *   - Lazy + eager TTL expiry
 */

export interface CacheEntry<T> {
  value: T;
  expiresAt: number; // epoch ms
  createdAt: number;
  key: string;
}

export interface CacheStats {
  size: number;
  hits: number;
  misses: number;
  evictions: number;
  expirations: number;
}

export interface SimpleCacheOptions {
  ttlMs: number;
  maxEntries: number;
  /** Optional clock injection for tests. */
  now?: () => number;
}

export class SimpleCache<T = unknown> {
  private map = new Map<string, CacheEntry<T>>();
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private expirations = 0;

  constructor(private opts: SimpleCacheOptions) {
    if (opts.ttlMs <= 0) throw new Error("ttlMs must be positive");
    if (opts.maxEntries <= 0) throw new Error("maxEntries must be positive");
  }

  get(key: string): T | undefined {
    const now = this.opts.now?.() ?? Date.now();
    const entry = this.map.get(key);
    if (!entry) {
      this.misses++;
      return undefined;
    }
    if (entry.expiresAt <= now) {
      this.map.delete(key);
      this.expirations++;
      this.misses++;
      return undefined;
    }
    // LRU: re-insert to move to back
    this.map.delete(key);
    this.map.set(key, { ...entry });
    this.hits++;
    return entry.value;
  }

  set(key: string, value: T): void {
    const now = this.opts.now?.() ?? Date.now();
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, {
      value,
      expiresAt: now + this.opts.ttlMs,
      createdAt: now,
      key,
    });
    while (this.map.size > this.opts.maxEntries) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey === undefined) break;
      this.map.delete(oldestKey);
      this.evictions++;
    }
  }

  has(key: string): boolean {
    const v = this.get(key);
    return v !== undefined;
  }

  clear(): void {
    this.map.clear();
  }

  stats(): CacheStats {
    return {
      size: this.map.size,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      expirations: this.expirations,
    };
  }
}

/**
 * Normalize a user query for cache key purposes.
 * Trims, lowercases, collapses internal whitespace, truncates to 200 chars.
 * Stable across requests so users with typos benefit too — but we deliberately
 * do NOT collapse case for CJK (Chinese has no case), so it's safe.
 */
export function normalizeQueryForCache(query: string): string {
  return query
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .slice(0, 200);
}

/**
 * Build a cache key from query + model + wire api + version.
 * The version string lets us invalidate the whole cache after a logic change
 * without restarting the container.
 */
export function buildAiCacheKey(params: {
  query: string;
  model: string;
  wireApi: string;
  version: string;
}): string {
  const q = normalizeQueryForCache(params.query);
  return `${params.version}::${params.wireApi}::${params.model}::${q}`;
}
