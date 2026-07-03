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
  getWereadOverlayDataDir,
  getWereadStatusByCatalogId,
  getWereadStatusesByCatalogIds,
  getWereadSummary,
  loadWereadOverlay,
} from "./weread/private-overlay.js";
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
app.use(express.json());

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