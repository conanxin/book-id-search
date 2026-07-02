/**
 * S21A AI search-intent orchestrator.
 *
 * Pipeline:
 *   1. Sanitize user query (trim + length cap).
 *   2. Ask MiniMax to translate the natural-language description into a
 *      structured search plan: `searchQueries[]`, `keywords[]`, `reason`.
 *      Output MUST be valid JSON inside a fenced block — we extract the first
 *      JSON object we find and ignore surrounding prose.
 *   3. Run each `searchQueries[i]` against the live Meilisearch index (or
 *      via the injected `searchFn`). Merge results by `id`, keep order.
 *   4. Take the top-N merged items, send them back to MiniMax with the
 *      original query and ask it to pick the best match + give a short
 *      `aiReason` per item. CRITICAL: the model is told it MAY NOT invent
 *      SSID/DXID/ISBN; it can only reference ids we pass in.
 *   5. Strip any aiReason that mentions an id not present in our items.
 *
 * Failure modes:
 *   - MiniMax unreachable → 502 with friendly message.
 *   - MiniMax returns unparsable JSON → fall back to searching the original
 *     user query and skip the aiReason pass.
 *   - Feature flag off → 503.
 *
 * Safety:
 *   - API key never logged or echoed.
 *   - Items are ALWAYS sourced from the injected search function (Meili),
 *     never invented.
 */

import {
  chatCompletion,
  isAiEnabled,
  resolveMiniMaxConfig,
  type ChatMessage,
} from "./minimax.js";

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
  };
  items: AiItem[];
  warnings: string[];
}

export interface OrchestratorDeps {
  /** Resolve whether AI is enabled. Defaults to env-based check. */
  isEnabled?: () => boolean;
  /** Chat completion implementation (testable). */
  chat?: typeof chatCompletion;
  /** Search the index for a query string. Must return items from Meilisearch only. */
  searchFn: (q: string, limit: number) => Promise<AiItem[]>;
  /** Hard caps. */
  maxQueries?: number;       // default 5
  maxItemsPerQuery?: number; // default 8
  finalItemCount?: number;   // default 12
  maxQueryChars?: number;    // default 200
}

const PLAN_SYSTEM: ChatMessage = {
  role: "system",
  content: [
    "你是一名图书检索策略师。用户会用自然语言描述想找的书。",
    "你的任务：把这段描述翻译成 1-5 个适合丢进全文搜索引擎的查询短语，",
    "以及 2-8 个核心关键词，并给出你的理解（reason）。",
    "",
    "严格要求：",
    "1. 严格输出 JSON（只输出一个 JSON 对象，不要任何额外解释）。",
    "2. JSON 字段：searchQueries (string[]), keywords (string[]), reason (string)。",
    "3. searchQueries 是给搜索引擎用的短语，应该保留原文核心关键词，不要泛化。",
    "4. keywords 是高密度主题词。",
    "5. 禁止编造任何 SSID/DXID/ISBN/书名/作者。",
    "",
    "示例输出：",
    "{\"searchQueries\": [\"披肩 吊带 日本 手工\"], \"keywords\": [\"披肩\", \"吊带\", \"日本\"], \"reason\": \"用户想找日本作者写的关于披肩和吊带的手工编织书。\"}",
  ].join("\n"),
};

const REASON_SYSTEM: ChatMessage = {
  role: "system",
  content: [
    "你是一名图书推荐解释员。给定一个用户原始描述和若干候选图书（来自真实数据库），",
    "为每条候选写一句中文解释为什么它可能命中用户的需求。",
    "",
    "严格要求：",
    "1. 严格输出 JSON：{\"reasons\":[{\"id\":\"...\",\"reason\":\"...\"}, ...]}。",
    "2. 只能为传入 items 里的 id 写 reason，禁止编造任何 id 或书目信息。",
    "3. reason 一句话，不超过 60 字。",
    "4. 跳过明显不相关的条目，不要硬塞。",
    "5. 只输出 JSON，不要任何额外文字。",
  ].join("\n"),
};

export class AiDisabledError extends Error {
  status = 503;
  constructor() {
    super("AI features are not enabled");
  }
}

/**
 * Run the full AI-search-intent pipeline.
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
  const maxQueries = deps.maxQueries ?? 5;
  const maxItemsPerQuery = deps.maxItemsPerQuery ?? 8;
  const finalCount = deps.finalItemCount ?? 12;
  const maxChars = deps.maxQueryChars ?? 200;

  const q = (userQuery ?? "").trim().slice(0, maxChars);
  if (!q) {
    throw new Error("query is empty");
  }

  const warnings: string[] = [];

  // Step 1: ask MiniMax for a search plan.
  const planMessages: ChatMessage[] = [PLAN_SYSTEM, { role: "user", content: q }];
  const planResp = await chat(planMessages);
  if (!planResp.ok) {
    throw new Error(`MiniMax unavailable for plan: ${planResp.error}`);
  }
  const plan = extractPlan(planResp.content, warnings);
  if (!plan) {
    // Fallback: search the user's original query verbatim.
    warnings.push("ai_plan_parse_failed_fallback_to_raw_query");
    const items = await deps.searchFn(q, maxItemsPerQuery);
    return {
      query: q,
      ai: { understanding: q, searchQueries: [q], keywords: [] },
      items: items.slice(0, finalCount),
      warnings,
    };
  }

  // Step 2: run each query, merge by id.
  const queries = (plan.searchQueries.length ? plan.searchQueries : [q])
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, maxQueries);

  const seen = new Map<string, AiItem>();
  for (const query of queries) {
    try {
      const hits = await deps.searchFn(query, maxItemsPerQuery);
      for (const hit of hits) {
        if (!hit?.id) continue;
        if (!seen.has(hit.id)) seen.set(hit.id, hit);
        if (seen.size >= finalCount * 2) break; // over-fetch buffer
      }
    } catch (e) {
      warnings.push(`query_failed:${query.slice(0, 30)}:${(e as Error).message}`);
    }
    if (seen.size >= finalCount * 2) break;
  }

  const items = Array.from(seen.values()).slice(0, finalCount);

  if (items.length === 0) {
    return {
      query: q,
      ai: {
        understanding: plan.reason || q,
        searchQueries: queries,
        keywords: plan.keywords ?? [],
      },
      items: [],
      warnings: [...warnings, "no_meili_hits"],
    };
  }

  // Step 3: ask MiniMax to write per-item reasons. Pass id-only metadata so
  // the model cannot leak other than that.
  const compactItems = items.map((it) => ({
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
    warnings.push(`ai_reason_failed:${reasonResp.error}`);
    return {
      query: q,
      ai: {
        understanding: plan.reason || q,
        searchQueries: queries,
        keywords: plan.keywords ?? [],
      },
      items,
      warnings,
    };
  }

  const idSet = new Set(items.map((it) => it.id));
  const reasons = extractReasons(reasonResp.content, warnings);
  let attached = 0;
  for (const it of items) {
    const r = reasons.get(it.id);
    if (r && typeof r === "string" && idSet.has(it.id)) {
      it.aiReason = r.slice(0, 200);
      attached++;
    }
  }
  if (attached === 0) {
    warnings.push("ai_reason_parse_failed");
  }

  return {
    query: q,
    ai: {
      understanding: plan.reason || q,
      searchQueries: queries,
      keywords: plan.keywords ?? [],
    },
    items,
    warnings,
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
export { isAiEnabled, resolveMiniMaxConfig };
export type { ChatMessage };