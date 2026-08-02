/**
 * S27G — Private WeRead "discover related books by note theme" backend
 * helpers.
 *
 * Strict privacy contract:
 *   - Only sanitised theme labels (1–6 seeds, ≤80 chars each, ≤320 chars
 *     total) ever leave the request handler. Raw note text, comments,
 *     prompts, AI summary text, search terms (`q`), private token,
 *     wereadBookId/noteId/highlightId/chapterTitle, or private
 *     title/author are NEVER carried into the helper.
 *   - The helper searches the public `books` Meilisearch index directly
 *     through the existing Meili index handle; it does NOT call the
 *     public `/api/search` HTTP endpoint, so the private theme text is
 *     invisible to any public access log.
 *   - The helper returns only redacted public catalog metadata.
 *   - RRF (Reciprocal Rank Fusion) is used to merge the per-seed candidate
 *     lists. Raw RRF scores and `_rankingScoreDetails` are deliberately
 *     stripped before the response is built.
 *   - No MiniMax / MiniMax call. No writes to Meilisearch. No settings
 *     changes. No persistence of any kind.
 */

import process from "node:process";

// ---------- limits ----------

export const RELATED_BOOKS_LIMITS: {
  MIN_SEEDS: number;
  MAX_SEEDS: number;
  MAX_SEED_CHARS: number;
  MAX_TOTAL_CHARS: number;
  MIN_LIMIT: number;
  MAX_LIMIT: number;
  DEFAULT_LIMIT: number;
  PER_SEED_FETCH: number;
  MAX_EXCLUDE_IDS: number;
  SEED_ID_RE: RegExp;
  CATALOG_ID_RE: RegExp;
  CONTROL_CHAR_RE: RegExp;
} = {
  MIN_SEEDS: 1,
  MAX_SEEDS: 6,
  MAX_SEED_CHARS: 80,
  MAX_TOTAL_CHARS: 320,
  MIN_LIMIT: 1,
  MAX_LIMIT: 24,
  DEFAULT_LIMIT: 12,
  PER_SEED_FETCH: 20,
  MAX_EXCLUDE_IDS: 100,
  SEED_ID_RE: /^[A-Za-z0-9_-]{1,32}$/,
  /** Public catalog id format — same regex used by other private endpoints. */
  CATALOG_ID_RE: /^[0-9]+_[0-9]{12}$/,
  /** Best-effort strip of NUL / C0 control characters (keep \t and \n). */
  CONTROL_CHAR_RE: /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g,
};

// ---------- public types ----------

export interface RelatedBookSeed {
  id: string;
  text: string;
}

export interface PrivateRelatedBooksRequest {
  seeds: RelatedBookSeed[];
  excludeCatalogIds?: string[];
  limit?: number;
}

export interface PrivateRelatedBookItem {
  catalogId: string;
  title: string;
  author?: string | null;
  publisher?: string | null;
  publishYear?: string | number | null;
  isbn?: string | null;
  matchedSeedIds: string[];
}

export interface PrivateRelatedBooksResponse {
  ok: true;
  items: PrivateRelatedBookItem[];
  meta: {
    seedsUsed: number;
    candidatesConsidered: number;
    returned: number;
    excluded: number;
    persisted: false;
    source: "meilisearch";
  };
}

/** Minimal Meili search handle we depend on — keeps the helper testable. */
export interface MeiliSearchHandle {
  search: (
    q: string,
    opts: {
      limit?: number;
      attributesToSearchOn?: string[];
      filter?: string | string[];
    }
  ) => Promise<{ hits: Array<Record<string, unknown>> }>;
}

/** Internal helper that the request handler passes in. */
export type Searcher = (
  query: string,
  perSeedFetch: number
) => Promise<Array<{ catalogId: string; doc: Record<string, unknown>; rank: number }>>;

// ---------- helpers ----------

function stripControlChars(input: string): string {
  return input.replace(RELATED_BOOKS_LIMITS.CONTROL_CHAR_RE, "");
}

/**
 * Normalise a single seed text:
 *   - coerced to string
 *   - control chars removed
 *   - trimmed
 *   - collapsed internal whitespace
 *   - length-clamped to MAX_SEED_CHARS
 */
function normalizeSeedText(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = stripControlChars(raw).trim();
  if (cleaned.length === 0) return null;
  const collapsed = cleaned.replace(/\s+/g, " ");
  if (collapsed.length === 0) return null;
  if (collapsed.length > RELATED_BOOKS_LIMITS.MAX_SEED_CHARS) {
    return collapsed.slice(0, RELATED_BOOKS_LIMITS.MAX_SEED_CHARS);
  }
  return collapsed;
}

/**
 * Pull `catalogId` and basic public metadata out of an arbitrary hit
 * shape. Index documents are not typed at the search index level so we
 * defensively cast.
 */
function pickCatalogId(doc: Record<string, unknown>): string | null {
  const candidates = [doc.id, doc.catalogId, doc["catalog id"]];
  for (const c of candidates) {
    if (typeof c === "string" && /^[0-9]+_[0-9]{12}$/.test(c.trim())) {
      return c.trim();
    }
  }
  return null;
}

function pickTitle(doc: Record<string, unknown>): string {
  const t = doc.title;
  return typeof t === "string" ? t.trim() : "";
}

function pickAuthor(doc: Record<string, unknown>): string | null {
  const a = doc.author;
  return typeof a === "string" && a.trim().length > 0 ? a.trim() : null;
}

function pickPublisher(doc: Record<string, unknown>): string | null {
  const p = doc.publisher;
  return typeof p === "string" && p.trim().length > 0 ? p.trim() : null;
}

function pickYear(doc: Record<string, unknown>): string | number | null {
  const y = doc.year;
  if (typeof y === "number" && Number.isFinite(y)) return y;
  if (typeof y === "string" && y.trim().length > 0) return y.trim();
  return null;
}

function pickIsbn(doc: Record<string, unknown>): string | null {
  const i = doc.isbn;
  return typeof i === "string" && i.trim().length > 0 ? i.trim() : null;
}

// ---------- public API ----------

export type ValidationResult =
  | { ok: true; seeds: RelatedBookSeed[]; excludeCatalogIds: string[]; limit: number }
  | { ok: false; status: 400 | 500; message: string };

/**
 * Validate a request body, returning a strongly-typed result with the
 * sanitised payload. Strictly enforces:
 *   - seeds.length ∈ [1, 6]
 *   - seed.id matches SEED_ID_RE
 *   - seed.text after sanitisation is non-empty and ≤ 80 chars
 *   - total sanitised seed chars ≤ 320
 *   - duplicate seed.text collapses to the first seed.id
 *   - excludeCatalogIds is an optional string array, max 100, each
 *     matches the public catalogId format
 *   - limit ∈ [1, 24] (default 12)
 *
 * On rejection the message NEVER echoes user input.
 */
export function validateRelatedBooksRequest(input: unknown): ValidationResult {
  if (!input || typeof input !== "object") {
    return { ok: false, status: 400, message: "请求体必须是 JSON object。" };
  }
  const body = input as Record<string, unknown>;

  const rawSeeds = body.seeds;
  if (!Array.isArray(rawSeeds)) {
    return { ok: false, status: 400, message: "seeds 必须是数组。" };
  }
  if (rawSeeds.length === 0) {
    return { ok: false, status: 400, message: "至少需要 1 个主题种子。" };
  }
  if (rawSeeds.length > RELATED_BOOKS_LIMITS.MAX_SEEDS) {
    return {
      ok: false,
      status: 400,
      message: `主题种子最多 ${RELATED_BOOKS_LIMITS.MAX_SEEDS} 个。`,
    };
  }

  const dedupMap = new Map<string, RelatedBookSeed>();
  let totalChars = 0;
  for (let i = 0; i < rawSeeds.length; i++) {
    const raw = rawSeeds[i];
    if (!raw || typeof raw !== "object") {
      return { ok: false, status: 400, message: `seeds[${i}] 必须是对象。` };
    }
    const seedBody = raw as Record<string, unknown>;
    const id = typeof seedBody.id === "string" ? seedBody.id : "";
    const rawText = typeof seedBody.text === "string" ? seedBody.text : "";
    const stripped = stripControlChars(rawText).trim();
    if (!RELATED_BOOKS_LIMITS.SEED_ID_RE.test(id)) {
      return { ok: false, status: 400, message: `seeds[${i}].id 格式不正确。` };
    }
    if (typeof seedBody.text !== "string") {
      return { ok: false, status: 400, message: `seeds[${i}].text 必须是字符串。` };
    }
    if (stripped.length === 0) {
      return { ok: false, status: 400, message: `seeds[${i}].text 不能为空。` };
    }
    // Reject strings longer than MAX_SEED_CHARS even before normalisation so
    // callers can't sneak past the cap via embedded control chars / spaces.
    if (rawText.length > RELATED_BOOKS_LIMITS.MAX_SEED_CHARS) {
      return {
        ok: false,
        status: 400,
        message: `seeds[${i}].text 不能超过 ${RELATED_BOOKS_LIMITS.MAX_SEED_CHARS} 个字符。`,
      };
    }
    const text = stripped.replace(/\s+/g, " ");
    if (text.length > RELATED_BOOKS_LIMITS.MAX_SEED_CHARS) {
      return {
        ok: false,
        status: 400,
        message: `seeds[${i}].text 不能超过 ${RELATED_BOOKS_LIMITS.MAX_SEED_CHARS} 个字符。`,
      };
    }
    if (totalChars + text.length > RELATED_BOOKS_LIMITS.MAX_TOTAL_CHARS) {
      return {
        ok: false,
        status: 400,
        message: `seeds 总字符数不能超过 ${RELATED_BOOKS_LIMITS.MAX_TOTAL_CHARS}。`,
      };
    }
    if (!dedupMap.has(text)) {
      dedupMap.set(text, { id, text });
      totalChars += text.length;
    }
  }
  const seeds = Array.from(dedupMap.values());
  if (seeds.length === 0) {
    return { ok: false, status: 400, message: "至少需要一个有效的主题种子。" };
  }

  let excludeCatalogIds: string[] = [];
  if (body.excludeCatalogIds !== undefined) {
    const rawExcludes = body.excludeCatalogIds;
    if (!Array.isArray(rawExcludes)) {
      return { ok: false, status: 400, message: "excludeCatalogIds 必须是字符串数组。" };
    }
    if (rawExcludes.length > RELATED_BOOKS_LIMITS.MAX_EXCLUDE_IDS) {
      return {
        ok: false,
        status: 400,
        message: `excludeCatalogIds 最多 ${RELATED_BOOKS_LIMITS.MAX_EXCLUDE_IDS} 个。`,
      };
    }
    const dedupExcludes = new Set<string>();
    for (let i = 0; i < rawExcludes.length; i++) {
      const item = rawExcludes[i];
      if (typeof item !== "string") {
        return {
          ok: false,
          status: 400,
          message: `excludeCatalogIds[${i}] 必须是字符串。`,
        };
      }
      const trimmed = item.trim();
      if (!RELATED_BOOKS_LIMITS.CATALOG_ID_RE.test(trimmed)) {
        return {
          ok: false,
          status: 400,
          message: `excludeCatalogIds[${i}] 格式不正确。`,
        };
      }
      dedupExcludes.add(trimmed);
    }
    excludeCatalogIds = Array.from(dedupExcludes);
  }

  let limit = RELATED_BOOKS_LIMITS.DEFAULT_LIMIT;
  if (body.limit !== undefined) {
    const rawLimit = body.limit;
    if (typeof rawLimit !== "number" || !Number.isInteger(rawLimit)) {
      return { ok: false, status: 400, message: "limit 必须是整数。" };
    }
    if (
      rawLimit < RELATED_BOOKS_LIMITS.MIN_LIMIT ||
      rawLimit > RELATED_BOOKS_LIMITS.MAX_LIMIT
    ) {
      return {
        ok: false,
        status: 400,
        message: `limit 必须在 ${RELATED_BOOKS_LIMITS.MIN_LIMIT} 到 ${RELATED_BOOKS_LIMITS.MAX_LIMIT} 之间。`,
      };
    }
    limit = rawLimit;
  }

  return { ok: true, seeds, excludeCatalogIds, limit };
}

/**
 * Exposed for tests — returns the strict sanitisation pipeline that
 * `validateRelatedBooksRequest` runs on `seeds`. Same rules, but returns
 * the seed list rather than a validation envelope.
 */
export function sanitizeRelatedBookSeeds(
  rawSeeds: ReadonlyArray<unknown>
): { seeds: RelatedBookSeed[]; totalChars: number } {
  const dedupMap = new Map<string, RelatedBookSeed>();
  let totalChars = 0;
  for (const raw of rawSeeds) {
    if (!raw || typeof raw !== "object") continue;
    const seedBody = raw as Record<string, unknown>;
    const id = typeof seedBody.id === "string" ? seedBody.id : "";
    const text = normalizeSeedText(seedBody.text);
    if (!RELATED_BOOKS_LIMITS.SEED_ID_RE.test(id)) continue;
    if (text === null) continue;
    const truncated =
      text.length > RELATED_BOOKS_LIMITS.MAX_SEED_CHARS
        ? text.slice(0, RELATED_BOOKS_LIMITS.MAX_SEED_CHARS)
        : text;
    if (truncated.length > 0 && !dedupMap.has(truncated)) {
      if (totalChars + truncated.length > RELATED_BOOKS_LIMITS.MAX_TOTAL_CHARS) break;
      totalChars += truncated.length;
      dedupMap.set(truncated, { id, text: truncated });
    }
  }
  return { seeds: Array.from(dedupMap.values()), totalChars };
}

/**
 * Run a single Meili search for one sanitised seed. Returns a list of
 * `{catalogId, doc, rank}`; if Meili throws, the error is propagated so
 * the route handler can map it to a controlled 500/502.
 */
export async function searchRelatedBooksForSeed(
  seed: RelatedBookSeed,
  perSeedFetch: number,
  meili: MeiliSearchHandle
): Promise<Array<{ catalogId: string; doc: Record<string, unknown>; rank: number }>> {
  const fetch = Math.min(
    Math.max(perSeedFetch, 1),
    RELATED_BOOKS_LIMITS.PER_SEED_FETCH
  );
  const result = await meili.search(seed.text, { limit: fetch });
  if (!result || !Array.isArray(result.hits)) return [];
  const out: Array<{ catalogId: string; doc: Record<string, unknown>; rank: number }> = [];
  for (let i = 0; i < result.hits.length; i++) {
    const hit = result.hits[i];
    if (!hit || typeof hit !== "object") continue;
    const catalogId = pickCatalogId(hit);
    if (!catalogId) continue;
    out.push({ catalogId, doc: hit, rank: i });
  }
  return out;
}

/** Internal entry stored during fusion. Not exposed. */
interface FusedEntry {
  doc: Record<string, unknown>;
  matchedSeedIds: Set<string>;
  score: number;
  distinctSeedCount: number;
  bestRank: number;
}

export interface FuseOptions {
  excludeCatalogIds?: ReadonlySet<string>;
  /**
   * If provided, entries whose `title` is empty AND whose author /
   * publisher / isbn are all empty are dropped. Defaults to true.
   */
  dropEmptyTitle?: boolean;
}

/**
 * Merge per-seed candidate lists using Reciprocal Rank Fusion.
 *
 *   score += 1 / (60 + rank)
 *
 * Final ordering:
 *   1) RRF total score descending
 *   2) distinct seed hit count descending
 *   3) best rank ascending
 *   4) catalogId ascending (stable tie-break)
 */
export function fuseRelatedBookCandidates(
  perSeedHits: ReadonlyArray<{
    seed: RelatedBookSeed;
    hits: ReadonlyArray<{ catalogId: string; doc: Record<string, unknown>; rank: number }>;
  }>,
  options: FuseOptions = {}
): {
  ranked: Array<{ catalogId: string; doc: Record<string, unknown>; matchedSeedIds: string[]; score: number }>;
  candidatesConsidered: number;
} {
  const seen = new Map<string, FusedEntry>();
  const dropEmpty = options.dropEmptyTitle !== false;
  const excludes = options.excludeCatalogIds ?? new Set<string>();
  let candidatesConsidered = 0;

  for (const group of perSeedHits) {
    for (const hit of group.hits) {
      candidatesConsidered++;
      if (excludes.has(hit.catalogId)) continue;
      const title = pickTitle(hit.doc);
      const author = pickAuthor(hit.doc);
      const publisher = pickPublisher(hit.doc);
      const isbn = pickIsbn(hit.doc);
      if (dropEmpty && title.length === 0 && !author && !publisher && !isbn) {
        continue;
      }
      const existing = seen.get(hit.catalogId);
      if (existing) {
        existing.matchedSeedIds.add(group.seed.id);
        existing.score += 1 / (60 + hit.rank);
        existing.distinctSeedCount = existing.matchedSeedIds.size;
        if (hit.rank < existing.bestRank) existing.bestRank = hit.rank;
        continue;
      }
      seen.set(hit.catalogId, {
        doc: hit.doc,
        matchedSeedIds: new Set([group.seed.id]),
        score: 1 / (60 + hit.rank),
        distinctSeedCount: 1,
        bestRank: hit.rank,
      });
    }
  }

  const ranked = Array.from(seen.entries()).map(([catalogId, entry]) => ({
    catalogId,
    doc: entry.doc,
    matchedSeedIds: Array.from(entry.matchedSeedIds),
    score: entry.score,
    distinctSeedCount: entry.distinctSeedCount,
    bestRank: entry.bestRank,
  }));

  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.distinctSeedCount !== a.distinctSeedCount) {
      return b.distinctSeedCount - a.distinctSeedCount;
    }
    if (a.bestRank !== b.bestRank) return a.bestRank - b.bestRank;
    return a.catalogId < b.catalogId ? -1 : a.catalogId > b.catalogId ? 1 : 0;
  });

  return { ranked, candidatesConsidered };
}

/**
 * Translate a fused ranked list into the public response shape. Strictly
 * strips:
 *   - seed texts (never present here, but defensive)
 *   - raw `_rankingScore`, `_rankingScoreDetails`, `_matchesPosition`,
 *     `_formatted`, etc.
 *   - private fields (`wereadBookId`, `noteId`, `highlightId`,
 *     `chapterTitle`, `title`, `author` are mapped to safe public fields
 *     only; any other private keys are NOT echoed back).
 *   - the entire raw Meili document — only known public fields are
 *     mapped onto the response item.
 */
export function buildPrivateRelatedBooksResponse(args: {
  seeds: RelatedBookSeed[];
  ranked: Array<{ catalogId: string; doc: Record<string, unknown>; matchedSeedIds: string[] }>;
  excluded: number;
  candidatesConsidered: number;
  limit: number;
}): PrivateRelatedBooksResponse {
  const items: PrivateRelatedBookItem[] = args.ranked
    .slice(0, args.limit)
    .map((entry) => ({
      catalogId: entry.catalogId,
      title: pickTitle(entry.doc),
      author: pickAuthor(entry.doc),
      publisher: pickPublisher(entry.doc),
      publishYear: pickYear(entry.doc),
      isbn: pickIsbn(entry.doc),
      matchedSeedIds: entry.matchedSeedIds.slice().sort(),
    }));
  return {
    ok: true,
    items,
    meta: {
      seedsUsed: args.seeds.length,
      candidatesConsidered: args.candidatesConsidered,
      returned: items.length,
      excluded: args.excluded,
      persisted: false,
      source: "meilisearch",
    },
  };
}

// ---------- top-level orchestration (used by the route handler) ----------

export interface OrchestrationResult {
  response?: PrivateRelatedBooksResponse;
  error?: { status: number; message: string };
  /** Number of catalog ids filtered out (excluded + missing title). */
  excluded: number;
  /** Number of candidate hits read from Meili before filtering. */
  candidatesConsidered: number;
  /** Number of distinct candidate catalogIds kept after fusion. */
  rankedCount: number;
}

/**
 * Run the full pipeline using a caller-supplied `searcher`. The route
 * handler supplies a `searcher` that wraps the existing Meili index
 * handle. Validation errors and search-time exceptions are surfaced as
 * `{status, message}` with safe messages (NEVER echoes seed.text).
 */
export async function runPrivateRelatedBooksSearch(
  body: unknown,
  searcher: Searcher
): Promise<OrchestrationResult> {
  const validation = validateRelatedBooksRequest(body);
  if (!validation.ok) {
    return {
      error: { status: validation.status, message: validation.message },
      excluded: 0,
      candidatesConsidered: 0,
      rankedCount: 0,
    };
  }

  const { seeds, excludeCatalogIds, limit } = validation;
  const excludes = new Set(excludeCatalogIds);
  const perSeed: Array<{
    seed: RelatedBookSeed;
    hits: Awaited<ReturnType<Searcher>>;
  }> = [];
  for (const seed of seeds) {
    try {
      const hits = await searcher(seed.text, RELATED_BOOKS_LIMITS.PER_SEED_FETCH);
      perSeed.push({ seed, hits });
    } catch (err) {
      const msg = (err instanceof Error && err.message) || "";
      // Never echo private upstream error text. Use a generic Chinese message.
      return {
        error: {
          status: 502,
          message: "相关书检索暂不可用，请稍后再试。",
        },
        excluded: 0,
        candidatesConsidered: 0,
        rankedCount: 0,
      };
    }
  }

  const { ranked, candidatesConsidered } = fuseRelatedBookCandidates(perSeed, {
    excludeCatalogIds: excludes,
  });
  const excluded = candidatesConsidered - ranked.length;

  const response = buildPrivateRelatedBooksResponse({
    seeds,
    ranked,
    excluded,
    candidatesConsidered,
    limit,
  });
  return {
    response,
    excluded,
    candidatesConsidered,
    rankedCount: ranked.length,
  };
}

// ---------- unused but exported for test parity ----------

// Process side-effect-free reference so the module is not flagged by
// noUnusedLocals during type checking.
void process;
