/**
 * S21A-TP2 AI search-intent orchestrator (with cache + evidence + fallback).
 *
 * Pipeline:
 *   0. Cache lookup (5 min TTL, 100 entries). On hit, return the prior
 *      response with `cache.hit=true`. On miss, continue.
 *   1. Sanitize user query (trim + length cap).
 *   2. Ask MiniMax to translate the natural-language description into a
 *      structured search plan: `searchQueries[]`, `keywords[]`, `reason`.
 *      Output MUST be valid JSON inside a fenced block — we extract the first
 *      JSON object we find and ignore surrounding prose.
 *   3. Run each `searchQueries[i]` against the live Meilisearch index (or
 *      via the injected `searchFn`). Merge results by `id`, attach
 *      `aiEvidence.matchedQueries` (list of search queries that hit this id).
 *   4. Re-rank by evidence: multi-query hits outrank single-query hits;
 *      parseStatus=ok > weak > failed; Meili's original rank is the
 *      tie-breaker.
 *   5. Take the top-N merged items, send them back to MiniMax with the
 *      original query and ask it to write a short `aiReason` per item.
 *      CRITICAL: the model is told it MAY NOT invent SSID/DXID/ISBN; it
 *      can only reference ids we pass in.
 *   6. Strip any aiReason that mentions an id not present in our items;
 *      if AI returned no reasons, fall back to a deterministic
 *      "based on real index, hit by AI query: …" message.
 *
 * Failure modes (graceful, never 500):
 *   - MiniMax unreachable for plan → fall back to searching the raw query.
 *   - AI plan returns but ALL search queries yield 0 Meili hits → fall
 *     back to the raw query and add `fallbackUsed=true`.
 *   - Feature flag off → 503 (AiDisabledError).
 *
 * Safety:
 *   - API key never logged or echoed.
 *   - Items are ALWAYS sourced from the injected search function (Meili),
 *     never invented.
 *   - Cache stores only response objects; never raw provider payloads.
 */

import {
  chatCompletion,
  isAiEnabled,
  resolveMiniMaxConfig,
  redact,
  type ChatMessage,
} from "./minimax.js";
import {
  SimpleCache,
  buildAiCacheKey,
  type SimpleCacheOptions,
} from "./cache.js";

export interface AiItem {
  id: string;
  ssid: string;
  dxid: string;
  title: string;
  author: string;
  publisher: string;
  year: number | null;
  pages: number | null;
  isbn: string;
  parseStatus?: string;
  parseWarnings?: string[];
  match?: unknown;
  aiReason?: string;
  aiEvidence?: AiEvidence;
}

export interface AiEvidence {
  matchedQueries: string[];
  matchedQueryCount: number;
  source: "ai_query" | "fallback_query";
  rankScore: number;
}

export interface AiSearchPlan {
  searchQueries: string[];
  keywords: string[];
  reason: string;
}

export interface AiSearchResponse {
  query: string;
  ai: {
    understanding: string;
    searchQueries: string[];
    keywords: string[];
    fallbackUsed: boolean;
    fallbackReason?: string;
  };
  items: AiItem[];
  warnings: string[];
  cache?: {
    hit: boolean;
    ttlSeconds?: number;
  };
}

export interface OrchestratorDeps {
  /** Resolve whether AI is enabled. Defaults to env-based check. */
  isEnabled?: () => boolean;
  /** Chat completion implementation (testable). */
  chat?: typeof chatCompletion;
  /** Search the index for a query string. Must return items from Meilisearch only. */
  searchFn: (q: string, limit: number) => Promise<AiItem[]>;
  /** Hard caps. */
  maxQueries?: number;       // default 4
  maxItemsPerQuery?: number; // default 8
  finalItemCount?: number;   // default 12
  maxQueryChars?: number;    // default 200
  /** Inject a cache for tests. */
  cache?: SimpleCache<AiSearchResponse>;
  cacheTtlMs?: number;       // default 5 * 60 * 1000
  cacheVersion?: string;     // bump to invalidate
}

const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_CACHE_VERSION = "v2"; // bump when response shape changes
const DEFAULT_MAX_QUERIES = 4;

// Module-level singleton (process-local). Resets on container restart, by design.
let _defaultCache: SimpleCache<AiSearchResponse> | null = null;
function getDefaultCache(): SimpleCache<AiSearchResponse> {
  if (!_defaultCache) {
    _defaultCache = new SimpleCache<AiSearchResponse>({
      ttlMs: DEFAULT_CACHE_TTL_MS,
      maxEntries: 100,
    });
  }
  return _defaultCache;
}

/** Test helper: clear the module-level cache. */
export function _clearDefaultCache(): void {
  _defaultCache?.clear();
}

const PLAN_SYSTEM: ChatMessage = {
  role: "system",
  content: [
    "你是一名图书检索策略师。用户会用自然语言描述想找的书。",
    "你的任务：把这段描述翻译成 1-4 个适合丢进全文搜索引擎的查询短语，",
    "以及 2-8 个核心关键词，并给出你的理解（reason）。",
    "",
    "严格要求：",
    "1. 严格输出 JSON（只输出一个 JSON 对象，不要任何额外解释，不要 markdown）。",
    "2. JSON 字段：searchQueries (string[]), keywords (string[]), reason (string)。",
    "3. searchQueries 每个 2-12 个中文字符 / 词组组合（最多 4 个），不要长句。",
    "4. 优先生成可在书目库命中的名词短语（书名 / 作者 / 出版社 / 主题词），避免泛化抽象词。",
    "5. keywords 是高密度主题词。",
    "6. 禁止编造任何 SSID/DXID/ISBN/书名/作者/出版社。",
    "7. 如果用户描述像具体书名，保留原始书名作为第一个 searchQuery。",
    "8. 如果用户描述包含作者、出版社、年份，要在 searchQueries 中保留这些线索。",
    "",
    "示例输出：",
    "{\"searchQueries\": [\"披肩 吊带 日本 手工\", \"时尚秋冬披肩\"], \"keywords\": [\"披肩\", \"吊带\", \"日本\"], \"reason\": \"用户想找日本作者写的关于披肩和吊带的手工编织书。\"}",
  ].join("\n"),
};

const REASON_SYSTEM: ChatMessage = {
  role: "system",
  content: [
    "你是一名图书推荐解释员。给定一个用户原始描述和若干候选图书（来自真实书目数据库），",
    "为每条候选写一句中文解释为什么它可能命中用户的需求。",
    "",
    "严格要求：",
    "1. 严格输出 JSON：{\"reasons\":[{\"id\":\"...\",\"reason\":\"...\"}, ...]}，不要 markdown。",
    "2. 只能为传入 items 里的 id 写 reason，禁止编造任何 id 或书目信息（不存在的 SSID/DXID/ISBN/目录/评价/内容介绍）。",
    "3. reason 一句话，不超过 40 字。",
    "4. 跳过明显不相关的条目，不要硬塞。",
    "5. 必须说\"基于书目信息\"，不要补充书中内容、目录、评价。",
    "6. 只输出 JSON，不要任何额外文字。",
  ].join("\n"),
};

export class AiDisabledError extends Error {
  status = 503;
  constructor() {
    super("AI features are not enabled");
  }
}

/**
 * Run the full AI-search-intent pipeline (with cache + evidence + fallback).
 */
export async function runAiSearchIntent(
  userQuery: string,
  deps: OrchestratorDeps
): Promise<AiSearchResponse> {
  const enabled = deps.isEnabled ?? (() => isAiEnabled());
  if (!enabled()) {
    throw new AiDisabledError();
  }
  const chat = deps.chat ?? chatCompletion;
  const maxQueries = deps.maxQueries ?? DEFAULT_MAX_QUERIES;
  const maxItemsPerQuery = deps.maxItemsPerQuery ?? 8;
  const finalCount = deps.finalItemCount ?? 12;
  const maxChars = deps.maxQueryChars ?? 200;
  const cacheTtlMs = deps.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const cacheVersion = deps.cacheVersion ?? DEFAULT_CACHE_VERSION;
  const cache = deps.cache ?? getDefaultCache();

  const q = (userQuery ?? "").trim().slice(0, maxChars);
  if (!q) {
    throw new Error("query is empty");
  }

  // Step 0: cache lookup.
  const cfg = resolveMiniMaxConfig() ?? { model: "unknown", wireApi: "anthropic" as const };
  const cacheKey = buildAiCacheKey({
    query: q,
    model: cfg.model,
    wireApi: cfg.wireApi,
    version: cacheVersion,
  });
  const cached = cache.get(cacheKey);
  if (cached) {
    return {
      ...cached,
      cache: { hit: true, ttlSeconds: Math.floor(cacheTtlMs / 1000) },
    };
  }

  const warnings: string[] = [];

  // Step 1: ask MiniMax for a search plan.
  const planMessages: ChatMessage[] = [PLAN_SYSTEM, { role: "user", content: q }];
  const planResp = await chat(planMessages);
  let plan: AiSearchPlan | null = null;
  let planParseFailed = false;
  if (!planResp.ok) {
    warnings.push(`ai_plan_chat_failed:${redact(planResp.error).slice(0, 80)}`);
    planParseFailed = true;
  } else {
    plan = extractPlan(planResp.content, warnings);
    if (!plan) planParseFailed = true;
  }

  // Step 2: determine queries — AI plan or fallback to raw query.
  let queries: string[];
  let usingFallback = false;
  if (plan && plan.searchQueries.length > 0) {
    queries = plan.searchQueries.map((s) => s.trim()).filter(Boolean).slice(0, maxQueries);
  } else {
    queries = [q];
    usingFallback = true;
    warnings.push("ai_plan_unavailable_fallback_to_raw_query");
  }
  if (queries.length === 0) queries = [q];

  // Step 3: run each query, merge by id, track which queries hit each id.
  const seen = new Map<string, { item: AiItem; matched: string[]; firstRank: number }>();
  let rankCounter = 0;
  for (const query of queries) {
    try {
      const hits = await deps.searchFn(query, maxItemsPerQuery);
      for (const hit of hits) {
        if (!hit?.id) continue;
        if (!seen.has(hit.id)) {
          seen.set(hit.id, { item: hit, matched: [query], firstRank: rankCounter++ });
        } else {
          const entry = seen.get(hit.id)!;
          if (!entry.matched.includes(query)) entry.matched.push(query);
        }
        if (seen.size >= finalCount * 2) break; // over-fetch buffer
      }
    } catch (e) {
      warnings.push(`query_failed:${query.slice(0, 30)}:${(e as Error).message}`);
    }
    if (seen.size >= finalCount * 2) break;
  }

  let items = Array.from(seen.entries());

  // Step 3.5: fallback to raw query if AI queries produced 0 hits and we
  // haven't already used fallback.
  if (items.length === 0 && !usingFallback) {
    warnings.push("ai_queries_no_hits_fallback_to_raw_query");
    usingFallback = true;
    try {
      const rawHits = await deps.searchFn(q, maxItemsPerQuery);
      for (const hit of rawHits) {
        if (!hit?.id) continue;
        if (!seen.has(hit.id)) {
          seen.set(hit.id, { item: hit, matched: [q], firstRank: rankCounter++ });
        }
      }
      items = Array.from(seen.entries());
    } catch (e) {
      warnings.push(`fallback_query_failed:${(e as Error).message}`);
    }
  }

  // Step 4: re-rank by evidence.
  const parseStatusWeight: Record<string, number> = {
    ok: 0,
    weak: -1,
    failed: -2,
  };
  function rankOf(entry: { matched: string[]; firstRank: number; item: AiItem }): number {
    const matchedCount = entry.matched.length;
    const parseBonus = parseStatusWeight[entry.item.parseStatus ?? "ok"] ?? 0;
    // matchedCount contributes 100, parseStatus contributes 0..2, firstRank breaks ties
    return matchedCount * 100 + parseBonus * 10 - entry.firstRank * 0.01;
  }
  items.sort((a, b) => rankOf(b[1]) - rankOf(a[1]));
  const topItems = items.slice(0, finalCount).map(([, e]) => e.item);

  // Attach aiEvidence
  for (let i = 0; i < topItems.length; i++) {
    const [, entry] = items[i];
    topItems[i].aiEvidence = {
      matchedQueries: entry.matched,
      matchedQueryCount: entry.matched.length,
      source: usingFallback ? "fallback_query" : "ai_query",
      rankScore: Number(rankOf(entry).toFixed(2)),
    };
  }

  // Step 5: ask MiniMax to write per-item reasons (only if we have items).
  if (topItems.length > 0) {
    const compactItems = topItems.map((it) => ({
      id: it.id,
      title: it.title,
      author: it.author,
      publisher: it.publisher,
      year: it.year,
      isbn: it.isbn,
    }));
    const reasonMessages: ChatMessage[] = [
      REASON_SYSTEM,
      {
        role: "user",
        content: `用户描述：${q}\n\n候选图书：${JSON.stringify(compactItems)}`,
      },
    ];
    const reasonResp = await chat(reasonMessages);
    if (!reasonResp.ok) {
      warnings.push(`ai_reason_chat_failed:${redact(reasonResp.error).slice(0, 80)}`);
    } else {
      const idSet = new Set(topItems.map((it) => it.id));
      const reasons = extractReasons(reasonResp.content, warnings);
      let attached = 0;
      for (const it of topItems) {
        const r = reasons.get(it.id);
        if (r && typeof r === "string" && idSet.has(it.id)) {
          it.aiReason = r.slice(0, 200);
          attached++;
        }
      }
      if (attached === 0) warnings.push("ai_reason_parse_failed");
    }
  }

  // Step 5.5: fallback reason for items that AI didn't explain.
  for (const it of topItems) {
    if (!it.aiReason) {
      const qlist = it.aiEvidence?.matchedQueries ?? [];
      const head = qlist.slice(0, 2).join(" / ") || q;
      it.aiReason = `这条记录来自真实书目库，命中了检索词：${head}。`;
    }
  }

  // Step 6: build response.
  const response: AiSearchResponse = {
    query: q,
    ai: {
      understanding: plan?.reason || q,
      searchQueries: queries,
      keywords: plan?.keywords ?? [],
      fallbackUsed: usingFallback || planParseFailed,
      fallbackReason: usingFallback
        ? planParseFailed
          ? "AI 生成的检索词不可用，已回退到原始描述搜索。"
          : "AI 生成的检索词没有命中，已回退到原始描述搜索。"
        : undefined,
    },
    items: topItems,
    warnings,
  };

  // Step 7: cache the response (only if it has items and no provider raw errors).
  const hasProviderError = warnings.some((w) => /chat_failed/i.test(w));
  if (topItems.length > 0 && !hasProviderError) {
    cache.set(cacheKey, response);
  }

  return {
    ...response,
    cache: { hit: false },
  };
}

// ---------- helpers ----------

/** Try to extract a JSON object from a chat reply. Returns null on failure. */
export function extractPlan(text: string, warnings: string[]): AiSearchPlan | null {
  const obj = extractFirstJsonObject(text);
  if (!obj || typeof obj !== "object") {
    warnings.push("plan_no_json_object");
    return null;
  }
  const sq = Array.isArray((obj as any).searchQueries)
    ? (obj as any).searchQueries.filter((s: unknown) => typeof s === "string")
    : [];
  const kw = Array.isArray((obj as any).keywords)
    ? (obj as any).keywords.filter((s: unknown) => typeof s === "string")
    : [];
  const reason = typeof (obj as any).reason === "string" ? (obj as any).reason : "";
  if (sq.length === 0 && kw.length === 0 && !reason) {
    warnings.push("plan_empty_fields");
    return null;
  }
  return {
    searchQueries: sq as string[],
    keywords: kw as string[],
    reason: reason as string,
  };
}

export function extractReasons(
  text: string,
  warnings: string[]
): Map<string, string> {
  const out = new Map<string, string>();
  const obj = extractFirstJsonObject(text);
  if (!obj || typeof obj !== "object") {
    warnings.push("reasons_no_json_object");
    return out;
  }
  const arr = Array.isArray((obj as any).reasons) ? (obj as any).reasons : [];
  for (const r of arr) {
    if (r && typeof r === "object" && typeof r.id === "string" && typeof r.reason === "string") {
      out.set(r.id, r.reason);
    }
  }
  if (out.size === 0) warnings.push("reasons_empty");
  return out;
}

/**
 * Extract the first balanced {...} JSON object from arbitrary text.
 * Handles fenced ```json blocks, raw JSON, and embedded prose.
 */
export function extractFirstJsonObject(text: string): unknown | null {
  // 1. Try fenced ```json ... ``` block first.
  const fence = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/i);
  const candidates: string[] = [];
  if (fence) candidates.push(fence[1]);
  // 2. Find every top-level {...} by scanning braces.
  const stack: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "{") stack.push(i);
    else if (c === "}") {
      const start = stack.pop();
      if (start !== undefined && stack.length === 0) {
        candidates.push(text.slice(start, i + 1));
      }
    }
  }
  for (const raw of candidates) {
    try {
      return JSON.parse(raw);
    } catch {
      // continue
    }
  }
  return null;
}

// Re-export for the route handler
export { isAiEnabled, resolveMiniMaxConfig, getDefaultCache };
export type { ChatMessage, SimpleCacheOptions };
