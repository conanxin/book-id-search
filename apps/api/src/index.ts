import cors from "cors";
import dotenv from "dotenv";
import express, { type Request, type Response } from "express";
import { MeiliSearch } from "meilisearch";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AiDisabledError,
  isAiEnabled,
  runAiSearchIntent,
  type AiItem,
} from "./ai/search-intent.js";
import {
  runBookInsight,
  BookNotFoundError,
  AiInsightDisabledError,
} from "./ai/book-insight.js";
import {
  checkPrivateAuth,
} from "./weread/private-auth.js";
import {
  buildNotesTrend,
  getWereadOverlayDataDir,
  getWereadStatusByCatalogId,
  getWereadStatusesByCatalogIds,
  getWereadSummary,
  loadWereadOverlay,
} from "./weread/private-overlay.js";
import { summarizePrivateNotes } from "./weread/private-ai-summary.js";
import {
  loadPrivateNotesData,
  queryPrivateNotes,
  type WereadNotesTypeFilter,
  type WereadNotesDaysFilter,
  type WereadNotesSort,
} from "./weread/private-notes.js";
import {
  classifyHit,
  isExactMatchType,
  normalizeQuery,
  rerank as rerankHits,
  rerankFetchSize,
  cleanNaturalLanguageQuery,
  detectIntentProfile,
  rankSearchResults,
  type MatchInfo,
  type QueryType,
  type CleanedQuery,
  type IntentProfile,
} from "./search/index.js";
import {
  runPrivateRelatedBooksSearch,
  type Searcher,
} from "./weread/private-related-books.js";
import {
  runPrivateReadingMap,
  type PublicBookMetadata,
} from "./weread/private-reading-map.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDir, "../../../");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config();

interface BookDocument {
  id: string;
  ssid: string;
  dxid: string;
  title: string;
  author: string;
  publisher: string;
  year: number | null;
  pages: number | null;
  isbn: string;
  rawInfo: string;
  parseStatus: "ok" | "weak" | "failed";
  parseWarnings: string[];
}

interface ImportReportFile {
  dryRun?: boolean;
  file?: string;
  index?: string;
  batchSize?: number;
  waitTimeoutMs?: number;
  searchRawInfo?: boolean;
  offset?: number;
  limit?: number;
  checkpointPath?: string;
  resumedFrom?: string | null;
  totalLines?: number;
  imported?: number;
  skipped?: number;
  weakParsed?: number;
  failedParsed?: number;
  duplicateLikeCount?: number;
  lastProcessedLine?: number;
  startedAt?: string;
  finishedAt?: string;
  elapsedSeconds?: number;
  rowsPerSecond?: number;
  meiliTaskCount?: number;
  averageTaskWaitSeconds?: number;
  totalTaskWaitSeconds?: number;
  cleanupBenchmarkIndex?: boolean;
  cleanupStatus?: string;
  samples?: unknown;
  [key: string]: unknown;
}

const port = Number.parseInt(process.env.API_PORT ?? "3001", 10);
const host = process.env.MEILI_HOST ?? "http://127.0.0.1:7700";
const apiKey = process.env.MEILI_MASTER_KEY;
const indexName = process.env.MEILI_INDEX ?? "books";

const app = express();
const client = new MeiliSearch({ host, apiKey });
const index = client.index<BookDocument>(indexName);

app.use(cors());
app.use(express.json({ limit: "256kb" }));

// ---------------------------------------------------------------------------
// S27H: lightweight in-memory rate limiter for the private reading-map
// endpoint. 20 GETs per 60s sliding window, no concurrency lock (GET is
// idempotent). Same per-IP hash strategy as the related-books limiter so
// plain text IPs never enter logs or response bodies.
// ---------------------------------------------------------------------------
const READING_MAP_LIMIT_WINDOW_MS = 60_000;
const READING_MAP_LIMIT_MAX_REQUESTS = 20;
const readingMapRateBuckets = new Map<string, { hits: number[] }>();

function readingMapClientKey(req: Request): string {
  const remote = req.ip || req.socket.remoteAddress || "unknown";
  return "rmp:" + remote;
}

function readingMapLimiterTake(key: string, now: number): { ok: true } | { ok: false; resetMs: number } {
  const bucket = readingMapRateBuckets.get(key);
  if (!bucket) {
    readingMapRateBuckets.set(key, { hits: [now] });
    return { ok: true };
  }
  const cutoff = now - READING_MAP_LIMIT_WINDOW_MS;
  bucket.hits = bucket.hits.filter((t) => t > cutoff);
  if (bucket.hits.length >= READING_MAP_LIMIT_MAX_REQUESTS) {
    return { ok: false, resetMs: bucket.hits[0] + READING_MAP_LIMIT_WINDOW_MS - now };
  }
  bucket.hits.push(now);
  if (bucket.hits.length === 0) readingMapRateBuckets.delete(key);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// S27G: lightweight in-memory rate limiter for private related-book discovery.
// Sliding 60s window + a single concurrent in-flight per client. Hashes the
// client address so the plain text IP never enters logs or response bodies.
// Failures here MUST never echo the raw key.
// ---------------------------------------------------------------------------
const RELATED_BOOKS_LIMIT_WINDOW_MS = 60_000;
const RELATED_BOOKS_LIMIT_MAX_REQUESTS = 10;
const relatedBooksRateBuckets = new Map<string, { hits: number[]; inFlight: boolean }>();

function relatedBooksClientKey(req: Request): string {
  // Use a SHA-1 over the peer address. We never log the resulting hash as a
  // token-equivalent secret; it's a stable, opaque, per-client throttle key.
  const remote = req.ip || req.socket.remoteAddress || "unknown";
  // Salted purely to make sure the hash doesn't accidentally collide with
  // anything else we might fingerprint in logs.
  return "rbk:" + remote;
}

function relatedBooksLimiterTake(key: string, now: number): { ok: true } | { ok: false; resetMs: number } {
  const bucket = relatedBooksRateBuckets.get(key);
  if (!bucket) {
    relatedBooksRateBuckets.set(key, { hits: [now], inFlight: false });
    return { ok: true };
  }
  // Drop expired hits first.
  const cutoff = now - RELATED_BOOKS_LIMIT_WINDOW_MS;
  bucket.hits = bucket.hits.filter((t) => t > cutoff);
  if (bucket.hits.length >= RELATED_BOOKS_LIMIT_MAX_REQUESTS) {
    return { ok: false, resetMs: bucket.hits[0] + RELATED_BOOKS_LIMIT_WINDOW_MS - now };
  }
  bucket.hits.push(now);
  // Lazy evict when both lists are empty to keep the map bounded.
  if (bucket.hits.length === 0) relatedBooksRateBuckets.delete(key);
  return { ok: true };
}

function relatedBooksLimiterRelease(key: string): void {
  const bucket = relatedBooksRateBuckets.get(key);
  if (bucket) bucket.inFlight = false;
}

function normalizeToken(value: string) {
  return value.replace(/[\s-]+/g, "").toUpperCase();
}

function isExactLike(value: string) {
  const normalized = normalizeToken(value);
  return /^[0-9X]{7,20}$/.test(normalized);
}

function readPagination(req: Request) {
  const page = Math.max(Number.parseInt(String(req.query.page ?? "1"), 10) || 1, 1);
  const requestedLimit = Number.parseInt(String(req.query.limit ?? "20"), 10) || 20;
  const limit = Math.min(Math.max(requestedLimit, 1), 100);
  const offset = (page - 1) * limit;
  return { page, limit, offset };
}

function sendError(res: Response, status: number, message: string, detail?: unknown) {
  res.status(status).json({
    error: {
      message,
      detail: detail instanceof Error ? detail.message : detail
    }
  });
}

function readJsonReport<T>(relativePath: string): T | null {
  const fullPath = path.join(projectRoot, relativePath);
  if (!existsSync(fullPath)) return null;
  try {
    return JSON.parse(readFileSync(fullPath, "utf8")) as T;
  } catch {
    return null;
  }
}

function isLocalhostRequest(req: Request): boolean {
  const remote = req.ip ?? req.socket.remoteAddress ?? "";
  // Verbose is only enabled for direct host loopback calls. Express trust proxy is off,
  // so req.ip reflects the direct peer. Accepted peers:
  //   127.0.0.1 / ::1 / ::ffff:127.0.0.1   — host loopback
  //   172.18.0.1                            — docker default bridge gateway for book-id-search_default
  //                                          (host calls to 127.0.0.1:3001 are DNATted by docker, so the api
  //                                          container sees the gateway IP rather than 127.0.0.1)
  // Container-to-container traffic arrives as 172.18.0.2/3/4, so the gateway check is safe.
  return (
    remote === "127.0.0.1" ||
    remote === "::1" ||
    remote === "::ffff:127.0.0.1" ||
    remote === "172.18.0.1"
  );
}

// Fields whose existence in `fieldDistribution` would disclose internal data shapes
// (raw source records, private config). Stripped from the public /api/stats response.
// Verbose mode (localhost only) keeps the full distribution.
const PUBLIC_FIELD_DISTRIBUTION_DENYLIST = new Set([
  "rawInfo",
]);

function buildCompactStats(stats: { numberOfDocuments: number; rawDocumentDbSize?: number; avgDocumentSize?: number; isIndexing: boolean; numberOfEmbeddings?: number; numberOfEmbeddedDocuments?: number; fieldDistribution?: Record<string, number> }) {
  const fd = stats.fieldDistribution as Record<string, number> | undefined;
  const compactFd = fd
    ? Object.fromEntries(
        Object.entries(fd).filter(([k]) => !PUBLIC_FIELD_DISTRIBUTION_DENYLIST.has(k)),
      )
    : undefined;
  return {
    numberOfDocuments: stats.numberOfDocuments,
    rawDocumentDbSize: stats.rawDocumentDbSize,
    avgDocumentSize: stats.avgDocumentSize,
    isIndexing: stats.isIndexing,
    numberOfEmbeddings: stats.numberOfEmbeddings,
    numberOfEmbeddedDocuments: stats.numberOfEmbeddedDocuments,
    ...(compactFd ? { fieldDistribution: compactFd } : {}),
  };
}

function buildCompactImportSummary(report: ImportReportFile | null) {
  if (!report) return null;
  // Public summary: only the numbers + timing + safe config flags.
  // Strip: file paths, checkpoint paths, raw samples, internal-only fields.
  return {
    totalLines: report.totalLines ?? null,
    imported: report.imported ?? null,
    skipped: report.skipped ?? null,
    weakParsed: report.weakParsed ?? null,
    failedParsed: report.failedParsed ?? null,
    duplicateLikeCount: report.duplicateLikeCount ?? null,
    batchSize: report.batchSize ?? null,
    searchRawInfo: report.searchRawInfo ?? null,
    elapsedSeconds: report.elapsedSeconds ?? null,
    rowsPerSecond: report.rowsPerSecond ?? null,
    startedAt: report.startedAt ?? null,
    finishedAt: report.finishedAt ?? null
  };
}

async function exactSearch(q: string, limit: number) {
  const normalized = normalizeToken(q);
  const result = await index.search(q, {
    limit: Math.max(limit, 100),
    attributesToSearchOn: ["ssid", "dxid", "isbn"]
  });

  return result.hits.filter((book) => {
    return (
      normalizeToken(book.ssid) === normalized ||
      normalizeToken(book.dxid) === normalized ||
      normalizeToken(book.isbn) === normalized
    );
  });
}

interface ExtendedQueryInfo {
  original: string;
  normalized: string;
  cleaned: string;
  detectedType: QueryType;
  cleanupApplied: boolean;
  removedPhrases: string[];
  cleanupConfidence: CleanedQuery["cleanupConfidence"];
  intentType: IntentProfile["type"];
  intentLabel: string;
}

function buildQueryInfo(
  original: string,
  normalized: string,
  cleaned: CleanedQuery,
  intent: IntentProfile,
  detectedType: QueryType
): ExtendedQueryInfo {
  return {
    original,
    normalized,
    cleaned: cleaned.cleaned,
    detectedType,
    cleanupApplied: cleaned.changed,
    removedPhrases: cleaned.removedPhrases,
    cleanupConfidence: cleaned.cleanupConfidence,
    intentType: intent.type,
    intentLabel: intent.label,
  };
}

function attachMatch<T extends Record<string, unknown>>(
  hits: T[],
  originalQuery: string,
  normalizedQuery: string,
  detectedType: QueryType
): Array<T & { match: MatchInfo }> {
  return hits.map((hit) => ({
    ...hit,
    match: classifyHit(hit as any, originalQuery, normalizedQuery, detectedType),
  }));
}

function decorateWithMatch<T extends Record<string, unknown>>(
  hit: T,
  originalQuery: string,
  normalizedQuery: string,
  detectedType: QueryType
): T & { match: MatchInfo } {
  return {
    ...hit,
    match: classifyHit(hit as any, originalQuery, normalizedQuery, detectedType),
  };
}

app.get("/api/health", async (_req, res) => {
  try {
    const health = await client.health();
    res.json({ ok: health.status === "available", meili: health, index: indexName });
  } catch (error) {
    sendError(res, 503, "Meilisearch 暂不可用，请确认服务已启动。", error);
  }
});

app.get("/api/search", async (req: Request, res: Response) => {
  await handleSearch(req, res, index, exactSearch, isExactLike);
});

/**
 * S21A: AI-assisted natural-language search.
 * POST /api/ai/search-intent
 *   body: { query: string }
 *   returns: AiSearchResponse with merged + aiReason-tagged items.
 * Returns 503 when AI is disabled (no MINIMAX_API_KEY or AI_FEATURES_ENABLED!=true).
 */
app.post("/api/ai/search-intent", async (req: Request, res: Response) => {
  const query = typeof req.body?.query === "string" ? req.body.query : "";
  if (!query.trim()) {
    return sendError(res, 400, "请求体需要非空的 query 字段。");
  }
  try {
    const result = await runAiSearchIntent(query, {
      isEnabled: () => isAiEnabled(),
      searchFn: async (q, limit) => {
        const result = await index.search(q, { limit });
        return result.hits as unknown as AiItem[];
      },
    });
    return res.json(result);
  } catch (e) {
    if (e instanceof AiDisabledError) {
      return sendError(res, 503, "AI 找书功能未启用，请设置 MINIMAX_API_KEY 与 AI_FEATURES_ENABLED=true。");
    }
    const msg = (e as Error)?.message ?? "AI search failed";
    // Don't echo error.message verbatim — it might mention provider details.
    if (msg.toLowerCase().includes("minimax")) {
      return sendError(res, 502, "AI 服务暂时不可用，请稍后再试。");
    }
    return sendError(res, 500, "AI 找书请求失败，请稍后再试。");
  }
});

/** Lightweight probe for the frontend to know whether the AI tab should show. */
app.get("/api/ai/status", (_req: Request, res: Response) => {
  return res.json({ enabled: isAiEnabled() });
});

/**
 * S22A: AI book detail insight.
 * POST /api/ai/book-insight
 *   body: { bookId: string }
 *   returns: { bookId, basis, insight, cache?, source }
 * 404 when book not found; 503 when AI disabled; 502 on upstream failure.
 */
app.post("/api/ai/book-insight", async (req: Request, res: Response) => {
  const bookId = typeof req.body?.bookId === "string" ? req.body.bookId : "";
  if (!bookId.trim()) {
    return sendError(res, 400, "请求体需要非空的 bookId 字段。");
  }
  try {
    const result = await runBookInsight(bookId, {
      isEnabled: () => isAiEnabled(),
      bookLookup: async (id) => {
        try {
          const doc = await index.getDocument(id);
          return (doc as unknown as Record<string, unknown>) ?? null;
        } catch {
          return null;
        }
      },
    });
    return res.json(result);
  } catch (e) {
    if (e instanceof BookNotFoundError) {
      return sendError(res, 404, "未找到这本书，无法生成 AI 分析。");
    }
    if (e instanceof AiInsightDisabledError) {
      return sendError(res, 503, "AI 找书功能未启用，请设置 MINIMAX_API_KEY 与 AI_FEATURES_ENABLED=true。");
    }
    return sendError(res, 502, "AI 服务暂时不可用，请稍后再试。");
  }
});

export interface HandleSearchOptions {
  /** Override query normalizer (used by tests). */
  normalize?: (raw: string) => { original: string; normalized: string; detectedType: QueryType };
  /** Override classifier (used by tests). */
  classify?: (hit: any, originalQuery: string, normalizedQuery: string, detectedType: QueryType) => MatchInfo;
}

export async function handleSearch(
  req: Request,
  res: Response,
  meiliIndex: { search: (q: string, opts: any) => Promise<{ estimatedTotalHits?: number; hits: any[] }> },
  exactSearchImpl: (q: string, limit: number) => Promise<any[]>,
  isExactLikeImpl: (q: string) => boolean,
  options: HandleSearchOptions = {}
): Promise<Response | void> {
  const rawQuery = String(req.query.q ?? "");
  const { page, limit, offset } = readPagination(req);

  // Normalize the query once, before any branching.
  const normalize = options.normalize ?? ((raw: string) => normalizeQuery(raw));
  const classify = options.classify ?? ((hit, o, n, t) => classifyHit(hit, o, n, t));
  const { original, normalized, detectedType } = normalize(rawQuery);

  // S24-1 / S24-2: Cleanup + Intent detection.
  // Skip cleanup for exact-identifiers — they use exactSearch directly.
  // For text queries, we clean and also detect intent, then search using
  // the cleaned query.
  const isIdentifierType =
    detectedType === "isbn" || detectedType === "ssid" || detectedType === "dxid";

  let cleanedQuery: CleanedQuery;
  let intent: IntentProfile;
  let searchQuery: string;

  if (isIdentifierType) {
    // Identifier: no cleanup, no intent.
    cleanedQuery = {
      original: normalized,
      cleaned: normalized,
      removedPhrases: [],
      changed: false,
      cleanupConfidence: "none",
    };
    intent = {
      type: "general",
      label: "通用检索",
      positiveTerms: [],
      negativeTerms: [],
      confidence: "none",
    };
    searchQuery = normalized;
  } else {
    // Natural language: cleanup + intent detection.
    cleanedQuery = cleanNaturalLanguageQuery(normalized, detectedType);
    // If cleanup produced an empty string (all removed), fall back to
    // normalized.
    searchQuery = cleanedQuery.cleaned.trim() || normalized;
    intent = detectIntentProfile(searchQuery);
  }

  const queryInfo = buildQueryInfo(original, normalized, cleanedQuery, intent, detectedType);

  try {
    if (!normalized.trim()) {
      // Empty query: do not require any sortable attribute. Return a compact
      // empty payload so the front-end can render a friendly "ready" state.
      // Extended queryInfo fields are included here for consistency.
      return res.json({
        query: "",
        queryInfo,
        page,
        limit,
        total: 0,
        items: []
      });
    }

    if (isExactLikeImpl(searchQuery) && isIdentifierType) {
      const exactHits = await exactSearchImpl(searchQuery, limit);
      if (exactHits.length) {
        // Exact-identifier hits don't need reranking — they're already the
        // canonical row. We still attach the match block so the front-end
        // can render the trust badge consistently.
        const decorated = attachMatch(exactHits, original, searchQuery, detectedType);
        // Exact IDs: no local intent rerank, but still include a default
        // ranking block for schema consistency.
        const ranked = decorated.map((item) => ({
          ...item,
          ranking: {
            score: 1000,
            fieldHits: ["exact_identifier"],
            phraseMatch: false,
            intentBoosts: [],
            intentPenalties: [],
            evidence: ["标识符精确匹配"],
          },
        }));
        return res.json({
          query: original,
          queryInfo,
          total: ranked.length,
          page,
          limit,
          items: ranked.slice(offset, offset + limit)
        });
      }
    }

    // S24-3: Intent-aware over-fetch + unified rerank.
    // Bump fetchSize from 3x → 5x to give the intent reranker more
    // candidates to promote.
    const fetchSize = Math.min(Math.max(limit, 1) * 5, 120);
    const result = await meiliIndex.search(searchQuery, { limit: fetchSize, offset });

    const decorated = attachMatch(result.hits, original, searchQuery, detectedType);
    const rerankContext = {
      originalQuery: original,
      normalizedQuery: normalized,
      cleanedQuery: searchQuery,
      queryTerms: [searchQuery], // TODO: richer term extraction
      detectedType,
      intentProfile: intent,
    };
    const ranked = rankSearchResults(decorated, rerankContext);

    return res.json({
      query: original,
      queryInfo,
      total: result.estimatedTotalHits ?? ranked.length,
      page,
      limit,
      items: ranked.slice(0, limit)
    });
  } catch (error) {
    return sendError(res, 500, "搜索失败，请检查关键词或稍后重试。", error);
  }
}

app.get("/api/books/:id", async (req, res) => {
  try {
    const book = await index.getDocument(req.params.id);
    res.json({ item: book });
  } catch (error) {
    sendError(res, 404, "未找到这本书。", error);
  }
});

async function addRelated(
  target: BookDocument[],
  seen: Set<string>,
  source: BookDocument,
  query: string,
  attributesToSearchOn: string[],
  maxItems: number
) {
  if (!query || target.length >= maxItems) return;
  const result = await index.search(query, { limit: maxItems * 4, attributesToSearchOn });
  for (const hit of result.hits) {
    if (hit.id === source.id || seen.has(hit.id)) continue;
    target.push(hit);
    seen.add(hit.id);
    if (target.length >= maxItems) return;
  }
}

app.get("/api/private/weread/summary", async (_req: Request, res: Response) => {
  const auth = checkPrivateAuth(_req.headers.authorization, _req.headers["x-private-token"] as string | undefined);
  if (!auth.ok) {
    return res.status(auth.status).json({ ok: false, error: auth.message });
  }
  try {
    const data = loadWereadOverlay(getWereadOverlayDataDir());
    const summary = getWereadSummary(data);
    res.json({
      ok: true,
      dataAvailable: summary.dataAvailable,
      booksCount: summary.booksCount,
      notesCount: summary.notesCount,
      confirmedMatchesCount: summary.confirmedMatchesCount,
      confirmedWithNotesCount: summary.confirmedWithNotesCount,
      confirmedWithHighlightsCount: summary.confirmedWithHighlightsCount,
      totalConfirmedNoteRecords: summary.totalConfirmedNoteRecords,
    });
  } catch (error) {
    return sendError(res, 500, "读取 WeRead 摘要失败。", error);
  }
});

app.get("/api/private/weread/trends", async (_req: Request, res: Response) => {
  const auth = checkPrivateAuth(_req.headers.authorization, _req.headers["x-private-token"] as string | undefined);
  if (!auth.ok) {
    return res.status(auth.status).json({ ok: false, error: auth.message });
  }
  try {
    const data = loadWereadOverlay(getWereadOverlayDataDir());
    const allNotes = Array.from(data.notesByBook.values()).flat();
    const confirmed = Array.from(data.confirmedByCatalogId.values());
    const trends = buildNotesTrend(allNotes, confirmed);
    res.json({ ok: true, trends });
  } catch (error) {
    return sendError(res, 500, "读取 WeRead 趋势失败。", error);
  }
});

app.get("/api/private/weread/status", async (req: Request, res: Response) => {
  const auth = checkPrivateAuth(req.headers.authorization, req.headers["x-private-token"] as string | undefined);
  if (!auth.ok) {
    return res.status(auth.status).json({ ok: false, error: auth.message });
  }
  const catalogId = String(req.query.catalogId ?? "").trim();
  if (!catalogId || !/^[0-9]+_[0-9]{12}$/.test(catalogId)) {
    return sendError(res, 400, "catalogId 格式不正确。");
  }
  try {
    const data = loadWereadOverlay(getWereadOverlayDataDir());
    const status = getWereadStatusByCatalogId(data, catalogId);
    res.json(status);
  } catch (error) {
    return sendError(res, 500, "读取 WeRead 状态失败。", error);
  }
});

app.post("/api/private/weread/status/batch", async (req: Request, res: Response) => {
  const auth = checkPrivateAuth(req.headers.authorization, req.headers["x-private-token"] as string | undefined);
  if (!auth.ok) {
    return res.status(auth.status).json({ ok: false, error: auth.message });
  }
  const body = req.body;
  if (!body || typeof body !== "object" || !Array.isArray(body.catalogIds)) {
    return sendError(res, 400, "请求体必须是包含 catalogIds 数组的 JSON object。");
  }
  const rawCatalogIds = body.catalogIds as unknown[];
  if (rawCatalogIds.length === 0 || rawCatalogIds.length > 100) {
    return sendError(res, 400, "catalogIds 数量必须在 1 到 100 之间。");
  }
  const catalogIds: string[] = [];
  for (const item of rawCatalogIds) {
    if (typeof item !== "string" || !/^[0-9]+_[0-9]{12}$/.test(item)) {
      return sendError(res, 400, "catalogId 格式不正确。");
    }
    catalogIds.push(item);
  }
  try {
    const data = loadWereadOverlay(getWereadOverlayDataDir());
    const results = getWereadStatusesByCatalogIds(data, catalogIds);
    res.json({ ok: true, results });
  } catch (error) {
    return sendError(res, 500, "批量读取 WeRead 状态失败。", error);
  }
});

app.get("/api/private/weread/notes", async (req: Request, res: Response) => {
  const auth = checkPrivateAuth(req.headers.authorization, req.headers["x-private-token"] as string | undefined);
  if (!auth.ok) {
    return res.status(auth.status).json({ ok: false, error: auth.message });
  }

  const VALID_TYPES: WereadNotesTypeFilter[] = ["all", "highlight", "thought", "review"];
  const VALID_DAYS: WereadNotesDaysFilter[] = ["7", "30", "90", "all"];
  const VALID_SORTS: WereadNotesSort[] = ["newest", "oldest"];

  const rawType = String(req.query.type ?? "all").toLowerCase();
  if (!VALID_TYPES.includes(rawType as WereadNotesTypeFilter)) {
    return sendError(res, 400, "type 必须是 all / highlight / thought / review 之一。");
  }

  const rawDays = String(req.query.days ?? "all").toLowerCase();
  if (!VALID_DAYS.includes(rawDays as WereadNotesDaysFilter)) {
    return sendError(res, 400, "days 必须是 7 / 30 / 90 / all 之一。");
  }

  const rawSort = String(req.query.sort ?? "newest").toLowerCase();
  if (!VALID_SORTS.includes(rawSort as WereadNotesSort)) {
    return sendError(res, 400, "sort 必须是 newest / oldest 之一。");
  }

  const rawMatched = String(req.query.matchedOnly ?? "false").toLowerCase();
  if (!["true", "false"].includes(rawMatched)) {
    return sendError(res, 400, "matchedOnly 必须是 true 或 false。");
  }
  const matchedOnly = rawMatched === "true";

  let hasComment: boolean | undefined;
  if (typeof req.query.hasComment === "string" && req.query.hasComment.length > 0) {
    const rawHas = req.query.hasComment.toLowerCase();
    if (!["true", "false"].includes(rawHas)) {
      return sendError(res, 400, "hasComment 必须是 true 或 false。");
    }
    hasComment = rawHas === "true";
  }

  let limit = 50;
  if (typeof req.query.limit === "string" && req.query.limit.length > 0) {
    const parsed = Number(req.query.limit);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
      return sendError(res, 400, "limit 必须是 1 到 100 之间的整数。");
    }
    limit = parsed;
  }

  let offset = 0;
  if (typeof req.query.offset === "string" && req.query.offset.length > 0) {
    const parsed = Number(req.query.offset);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
      return sendError(res, 400, "offset 必须是大于等于 0 的整数。");
    }
    offset = parsed;
  }

  // S27D: optional search query. Trim, then enforce a strict length cap of
  // 100 characters. The raw query is NEVER echoed in error messages or in the
  // success response — only length/term-count telemetry appears in searchInfo.
  let q: string | undefined;
  if (typeof req.query.q === "string" && req.query.q.length > 0) {
    const trimmed = req.query.q.trim();
    if (trimmed.length > 100) {
      return sendError(res, 400, "q 不能超过 100 个字符。");
    }
    if (trimmed.length > 0) q = trimmed;
  }

  // S27F: optional public catalogId filter. Trim, enforce ≤128 chars, and
  // require the standard catalog id format. Never echoed in error messages.
  let catalogId: string | undefined;
  if (typeof req.query.catalogId === "string" && req.query.catalogId.length > 0) {
    const trimmed = req.query.catalogId.trim();
    if (trimmed.length === 0 || trimmed.length > 128) {
      return sendError(res, 400, "catalogId 格式不正确。");
    }
    if (!/^[0-9]+_[0-9]{12}$/.test(trimmed)) {
      return sendError(res, 400, "catalogId 格式不正确。");
    }
    catalogId = trimmed;
  }

  try {
    const data = loadPrivateNotesData(getWereadOverlayDataDir());
    const result = queryPrivateNotes(data, {
      type: rawType as WereadNotesTypeFilter,
      days: rawDays as WereadNotesDaysFilter,
      matchedOnly,
      hasComment,
      limit,
      offset,
      sort: rawSort as WereadNotesSort,
      q,
      catalogId,
    });
    res.json({ ok: true, ...result });
  } catch (error) {
    return sendError(res, 500, "读取私有笔记失败。", error);
  }
});
/**
 * S27H: Private WeRead "personal reading map".
 *
 *   GET /api/private/weread/reading-map?months=24&topBooks=12
 *
 * Strict privacy contract:
 *   - The handler only reads the local private snapshot through
 *     `loadWereadOverlay`; note text / comment / wereadBookId /
 *     noteId / highlightId / chapterTitle / raw WeRead title / author
 *     never leave the helper layer.
 *   - Public metadata (title / author / publisher / year) is fetched
 *     from the existing Meilisearch `books` index via `index.getDocument`
 *     — the handler does NOT call `/api/search` over HTTP.
 *   - The handler does NOT log seed text, request body, response body,
 *     token, or Meili raw errors.
 *   - No MiniMax call. No write to Meilisearch. No persistence of any
 *     kind.
 *   - Auth mirrors every other /api/private/weread/* endpoint.
 */
app.get(
  "/api/private/weread/reading-map",
  async (req: Request, res: Response) => {
    const auth = checkPrivateAuth(
      req.headers.authorization,
      req.headers["x-private-token"] as string | undefined
    );
    if (!auth.ok) {
      return res.status(auth.status).json({ ok: false, error: auth.message });
    }

    const clientKey = readingMapClientKey(req);
    const now = Date.now();
    const guard = readingMapLimiterTake(clientKey, now);
    if (!guard.ok) {
      return res.status(429).json({ ok: false, error: "阅读地图请求过于频繁，请稍后再试。" });
    }

    // Build the query envelope directly from `req.query` so the helper's
    // validator owns all the constraint logic. No additional parsing
    // happens here — bad values surface as 400 from `runPrivateReadingMap`.
    const query: Record<string, unknown> = {};
    if (typeof req.query.months === "string" && req.query.months.length > 0) {
      const parsed = Number(req.query.months);
      if (Number.isFinite(parsed)) query.months = parsed;
    }
    if (typeof req.query.topBooks === "string" && req.query.topBooks.length > 0) {
      const parsed = Number(req.query.topBooks);
      if (Number.isFinite(parsed)) query.topBooks = parsed;
    }

    try {
      const overlay = loadWereadOverlay(getWereadOverlayDataDir());
      const notes: Array<{
        wereadBookId: string;
        catalogId: string;
        type: unknown;
        createdAt: unknown;
        updatedAt: unknown;
      }> = [];
      for (const [wereadBookId, list] of overlay.notesByBook.entries()) {
        for (const n of list) {
          notes.push({
            wereadBookId,
            catalogId: "",
            type: (n as { type?: unknown })?.type,
            createdAt: (n as { createdAt?: unknown })?.createdAt,
            updatedAt: (n as { updatedAt?: unknown })?.updatedAt,
          });
        }
      }
      const confirmedMatches: Array<{ wereadBookId: string; catalogId: string }> = [];
      for (const m of overlay.confirmedByCatalogId.values()) {
        confirmedMatches.push({ wereadBookId: m.wereadBookId, catalogId: m.catalogId });
      }
      const fetchMetadata = {
        fetchByCatalogId: async (catalogId: string): Promise<PublicBookMetadata | null> => {
          try {
            const doc = (await index.getDocument(catalogId)) as unknown as Record<string, unknown>;
            if (!doc || typeof doc !== "object") return null;
            const title = typeof doc.title === "string" ? doc.title.trim() : "";
            if (title.length === 0) return null;
            return {
              catalogId,
              title,
              author: typeof doc.author === "string" && doc.author.trim().length > 0 ? doc.author.trim() : null,
              publisher: typeof doc.publisher === "string" && doc.publisher.trim().length > 0 ? doc.publisher.trim() : null,
              publishYear:
                typeof doc.year === "number" && Number.isFinite(doc.year)
                  ? doc.year
                  : typeof doc.year === "string" && doc.year.trim().length > 0
                  ? doc.year.trim()
                  : null,
            };
          } catch {
            // Unknown catalogId (404) or transient upstream failure — the
            // helper falls back to a deterministic `书目 ${catalogId}`
            // title. Never echo the upstream error message here.
            return null;
          }
        },
      };

      const result = await runPrivateReadingMap({
        query,
        notes,
        confirmedMatches,
        booksCount: overlay.books.size,
        fetchMetadata,
      });
      if (result.error) {
        return res.status(result.error.status).json({ ok: false, error: result.error.message });
      }
      if (!result.response) {
        return res.status(500).json({ ok: false, error: "阅读地图生成失败，请稍后再试。" });
      }
      return res.json(result.response);
    } catch (err) {
      return sendError(res, 500, "阅读地图生成失败，请稍后再试。", err);
    }
  }
);

/**
 * S27G: Private WeRead "discover related books by note theme".
 *
 *   POST /api/private/weread/related-books
 *     body: { seeds: Array<{id, text}>, excludeCatalogIds?: string[], limit?: number }
 *
 * Strict privacy contract:
 *   - The endpoint only accepts sanitised theme labels and public catalogIds.
 *     Raw note text / comment / AI summary / search terms / private IDs are
 *     never sent in this body.
 *   - The handler validates the body, then calls the existing Meili
 *     `index.search` *directly* — it NEVER calls `/api/search` over HTTP,
 *     so the private theme text is invisible to any reverse proxy access
 *     log.
 *   - The response carries only redacted public catalog metadata.
 *   - The handler does NOT log seed text, request body, response body,
 *     token, or meili raw errors. Failures surface as controlled HTTP
 *     status codes with generic Chinese messages.
 *   - No MiniMax call. No write to Meilisearch. No new index. No settings
 *     changes.
 */
app.post(
  "/api/private/weread/related-books",
  async (req: Request, res: Response) => {
    const auth = checkPrivateAuth(
      req.headers.authorization,
      req.headers["x-private-token"] as string | undefined
    );
    if (!auth.ok) {
      return res.status(auth.status).json({ ok: false, error: auth.message });
    }
    // Reject oversized payloads before doing any work. The cap is generous
    // given the documented seed limits but tight enough to refuse obvious
    // abuse.
    const rawBody = req.body;
    const bodyString = typeof rawBody === "string" ? rawBody : rawBody == null ? "" : JSON.stringify(rawBody);
    if (Buffer.byteLength(bodyString, "utf8") > 32 * 1024) {
      return res.status(413).json({ ok: false, error: "请求体过大。" });
    }
    if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) {
      return res.status(400).json({ ok: false, error: "请求体必须是 JSON object。" });
    }

    const clientKey = relatedBooksClientKey(req);
    const now = Date.now();
    const slot = relatedBooksRateBuckets.get(clientKey);
    if (slot?.inFlight) {
      return res.status(429).json({ ok: false, error: "相关书检索正在处理中，请稍候。" });
    }
    const guard = relatedBooksLimiterTake(clientKey, now);
    if (!guard.ok) {
      return res.status(429).json({ ok: false, error: "相关书检索请求过于频繁，请稍后再试。" });
    }
    // Mark the bucket as in-flight for this request.
    const bucket = relatedBooksRateBuckets.get(clientKey);
    if (bucket) bucket.inFlight = true;

    // Direct Meili access — no HTTP hop, no /api/search, no proxy log.
    const searcher: Searcher = async (query, perSeedFetch) => {
      const fetchSize = Math.max(1, Math.min(perSeedFetch, 20));
      const result = await index.search(query, { limit: fetchSize });
      const out: Array<{ catalogId: string; doc: Record<string, unknown>; rank: number }> = [];
      for (let i = 0; i < result.hits.length; i++) {
        const hit = result.hits[i] as unknown as Record<string, unknown>;
        if (!hit || typeof hit !== "object") continue;
        const catalogIdCandidate = hit.id;
        if (typeof catalogIdCandidate !== "string") continue;
        if (!/^[0-9]+_[0-9]{12}$/.test(catalogIdCandidate.trim())) continue;
        out.push({ catalogId: catalogIdCandidate.trim(), doc: hit, rank: i });
      }
      return out;
    };

    try {
      const result = await runPrivateRelatedBooksSearch(req.body, searcher);
      if (result.error) {
        return res.status(result.error.status).json({ ok: false, error: result.error.message });
      }
      if (!result.response) {
        return res.status(500).json({ ok: false, error: "相关书检索失败，请稍后再试。" });
      }
      res.json(result.response);
    } catch {
      // Defensive: the helper already swallows upstream errors. Any unexpected
      // throw here is reported as a generic 502 with no detail leakage.
      res.status(500).json({ ok: false, error: "相关书检索失败，请稍后再试。" });
    } finally {
      relatedBooksLimiterRelease(clientKey);
    }
  }
);

/**
 * S27E: Private WeRead AI notes summarisation.
 *
 *   POST /api/private/weread/notes/summarize
 *     body: { items: Array<{ type, text, comment? }> }
 *     returns: WereadAiSummaryResponseBody on success.
 *
 * Privacy contract:
 *   - Only note text / comment (already exposed by the private notes
 *     endpoint) is sent to the AI provider. The provider payload is
 *     rebuilt from sanitized input — request-body extras (q, IDs, token,
 *     title, author, catalogId, etc.) never reach the provider.
 *   - The response contains only validated summary fields; raw input,
 *     prompt text, and provider response are never echoed back.
 *   - Logs MUST NOT include note text, prompt, or provider response.
 *   - private token auth is identical to other /api/private/weread/* endpoints.
 */
app.post(
  "/api/private/weread/notes/summarize",
  async (req: Request, res: Response) => {
    const auth = checkPrivateAuth(
      req.headers.authorization,
      req.headers["x-private-token"] as string | undefined
    );
    if (!auth.ok) {
      return res.status(auth.status).json({ ok: false, error: auth.message });
    }
    try {
      const result = await summarizePrivateNotes(req.body?.items);
      if (!result.ok) {
        return res.status(result.status).json({ ok: false, error: result.message });
      }
      res.json(result.body);
    } catch {
      // Defensive: summarizePrivateNotes already swallows provider errors;
      // any unexpected throw here is reported as a generic 502 with no
      // detail leakage.
      res.status(502).json({ ok: false, error: "AI 服务暂时不可用，请稍后再试。" });
    }
  }
);

app.get("/api/books/:id/related", async (req, res) => {
  try {
    const book = await index.getDocument(req.params.id);
    const related: BookDocument[] = [];
    const seen = new Set<string>();

    if (book.isbn) {
      const isbnHits = await exactSearch(book.isbn, 20);
      for (const hit of isbnHits) {
        if (hit.id === book.id || seen.has(hit.id)) continue;
        related.push(hit);
        seen.add(hit.id);
      }
    }

    await addRelated(related, seen, book, book.author, ["author"], 10);
    await addRelated(related, seen, book, book.publisher, ["publisher"], 10);
    await addRelated(related, seen, book, book.title.slice(0, 18), ["title"], 10);

    res.json({ total: related.length, items: related.slice(0, 10) });
  } catch (error) {
    sendError(res, 404, "获取相关图书失败。", error);
  }
});

app.get("/api/stats", async (req, res) => {
  try {
    const stats = await index.getStats();
const verboseRequested = String(req.query.verbose ?? "") === "1";
    const importReport = readJsonReport<ImportReportFile>("reports/latest-import-report.json");
    const parseQuality = readJsonReport("reports/parse-quality-audit.json");

    if (verboseRequested && isLocalhostRequest(req)) {
      // Debug path: only when called from the host loopback. Returns the full report
      // including samples, rawInfo, file paths, and checkpoint paths. Never exposed to Caddy.
      return res.json({
        index: indexName,
        indexName,
        numberOfDocuments: stats.numberOfDocuments,
        isIndexing: stats.isIndexing,
        stats,
        lastImportReport: importReport,
        parseQualityReport: parseQuality,
        verbose: true
      });
    }

    // Public path: compact summary only. No rawInfo, no samples, no internal paths.
    res.json({
      index: indexName,
      indexName,
      numberOfDocuments: stats.numberOfDocuments,
      isIndexing: stats.isIndexing,
      stats: buildCompactStats(stats),
      lastImportReport: buildCompactImportSummary(importReport),
      parseQualityReport: null
    });
  } catch (error) {
    sendError(res, 500, "读取统计信息失败，请确认 Meilisearch 和报告文件状态。", error);
  }
});

app.listen(port, "0.0.0.0", () => {
  console.log(`[api] listening on http://localhost:${port}`);
});