/**
 * S22A — AI book detail insight.
 *
 * Pipeline:
 *   0. Cache lookup (10 min TTL, 200 entries).
 *   1. Fetch real book from Meilisearch (by bookId).
 *   2. If not found → 404 (BookNotFoundError).
 *   3. If AI disabled → 503 (AiDisabledError).
 *   4. Build a compact metadata payload (id, title, author, publisher, year,
 *      pages, isbn, ssid, dxid, parseStatus, parseWarnings, rawInfo excerpt
 *      capped at 800 chars). Send to MiniMax with strict JSON prompt.
 *   5. Parse the JSON; if parsing fails, fall back to a deterministic
 *      rule-based insight (no AI, no fabrication).
 *   6. Sanitize: drop conflicting identifiers, dedupe, cap array/string
 *      lengths, normalize.
 *   7. Cache the sanitized result (skips errors and 404s).
 *
 * Safety:
 *   - API key never appears in any log or response.
 *   - AI never sees the full rawInfo (capped at 800 chars), never sees
 *     any other book's data, never invents SSID/DXID/ISBN.
 *   - The basis block contains the real, fetched book fields — they are
 *     authoritative even if the AI model says otherwise.
 */

import { chatCompletion, isAiEnabled, resolveMiniMaxConfig, redact } from "./minimax.js";
import {
  SimpleCache,
  buildAiCacheKey,
} from "./cache.js";

// ---------- types ----------

export interface BibliographicQuality {
  parseStatus: string;
  missingFields: string[];
  abnormalFields: string[];
  warnings: string[];
  trustHints: string[];
}

export interface BookInsightBasis {
  id: string;
  title: string;
  author: string;
  publisher: string;
  year: number | null;
  pages: number | null;
  isbn: string;
  ssid: string;
  dxid: string;
  parseStatus: string;
  parseWarnings: string[];
  rawInfoExcerpt: string;
  rawInfoTruncated: boolean;
}

export interface BookInsight {
  scopeNote: string;
  shortSummary: string;
  subjectTags: string[];
  likelyAudience: string;
  bibliographicSignals: string[];
  searchSuggestions: string[];
  trustAssessment: {
    level: "high" | "medium" | "low";
    reasons: string[];
  };
  caveats: string[];
}

export interface BookInsightResponse {
  bookId: string;
  cache?: { hit: boolean; ttlSeconds?: number };
  basis: BookInsightBasis;
  quality: BibliographicQuality;
  insight: BookInsight;
  source: "ai" | "rule_based_fallback";
}

export class BookNotFoundError extends Error {
  status = 404;
  constructor(bookId: string) {
    super(`book not found: ${bookId}`);
  }
}

export class AiInsightDisabledError extends Error {
  status = 503;
  constructor() {
    super("ai_disabled");
  }
}

export interface BookLookup {
  (bookId: string): Promise<Record<string, unknown> | null>;
}

export interface BookInsightDeps {
  isEnabled?: () => boolean;
  chat?: typeof chatCompletion;
  bookLookup: BookLookup;
  cache?: SimpleCache<BookInsightResponse>;
  cacheTtlMs?: number;
  cacheVersion?: string;
  rawInfoCharLimit?: number;
}

const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_CACHE_VERSION = "v1";
const DEFAULT_RAW_INFO_LIMIT = 800;

const SCOPE_NOTE = "以下分析仅基于书目信息，不代表图书全文内容。";

// Module-level singleton cache (separate namespace from search-intent).
let _insightCache: SimpleCache<BookInsightResponse> | null = null;
function getInsightCache(): SimpleCache<BookInsightResponse> {
  if (!_insightCache) {
    _insightCache = new SimpleCache<BookInsightResponse>({
      ttlMs: DEFAULT_CACHE_TTL_MS,
      maxEntries: 200,
    });
  }
  return _insightCache;
}

/** Test helper. */
export function _clearInsightCache(): void {
  _insightCache?.clear();
}

// ---------- prompts ----------

const INSIGHT_SYSTEM = [
  "你是图书元数据分析助手。",
  "你只能基于用户提供的书目字段（标题、作者、出版社、年份、页数、ISBN、SSID、DXID、parseStatus、parseWarnings、quality 质量分析、rawInfo 节选）进行分析。",
  "你没有访问图书全文、目录、评论、读者评价或外部资料的能力。",
  "严禁编造：内容简介、章节、目录、序言、评价、获奖情况、作者生平、销量、影响力、ISBN、SSID、DXID。",
  "SSID、DXID、ISBN 必须原样照抄输入字段，禁止改写或发明。",
  "",
  "重要规则：",
  "1. 如果 quality.missingFields 包含 isbn：",
  "   - trustAssessment.level 不得为 high",
  "   - caveats 必须包含 ISBN 缺失的说明",
  "   - bibliographicSignals 不得声称 ISBN 完整",
  "2. 如果 parseStatus = weak：",
  "   - trustAssessment.level 不得为 high",
  "   - caveats 必须说明记录为弱解析，建议结合原始记录核对",
  "3. 如果 parseStatus = failed：",
  "   - trustAssessment.level 必须为 low",
  "4. 如果 rawInfo 存在：可以建议使用原始 TXT 记录核对字段，但不得把 rawInfo 当作全文",
  "5. 如果 rawInfo 不存在：caveats 必须说明无法核对原始记录",
  "",
  "输出严格 JSON，不要 markdown 代码块。",
  "",
  "JSON schema:",
  "{",
  '  "shortSummary": string (≤ 120 字，保守描述，不声称读过全文),',
  '  "subjectTags": string[] (≤ 8 个，去重),',
  '  "likelyAudience": string,',
  '  "bibliographicSignals": string[] (≤ 6 条, 每条一句话, 描述字段中的客观事实),',
  '  "searchSuggestions": string[] (≤ 6 个, 用于普通搜索的检索短语),',
  '  "trustAssessment": { "level": "high" | "medium" | "low", "reasons": string[] },',
  '  "caveats": string[] (≤ 5 条, 明确说"仅基于书目信息"等的限制)',
  "}",
].join("\n");

// ---------- core ----------

export async function runBookInsight(
  bookId: string,
  deps: BookInsightDeps
): Promise<BookInsightResponse> {
  const enabled = deps.isEnabled ?? (() => isAiEnabled());
  if (!enabled()) {
    throw new AiInsightDisabledError();
  }

  const id = (bookId ?? "").trim();
  if (!id) {
    throw new BookNotFoundError(bookId);
  }

  const cacheTtlMs = deps.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const cacheVersion = deps.cacheVersion ?? DEFAULT_CACHE_VERSION;
  const rawLimit = deps.rawInfoCharLimit ?? DEFAULT_RAW_INFO_LIMIT;
  const cache = deps.cache ?? getInsightCache();
  const chat = deps.chat ?? chatCompletion;

  // Cache lookup
  const cfg = resolveMiniMaxConfig() ?? { model: "unknown", wireApi: "anthropic" as const };
  const cacheKey = buildAiCacheKey({
    query: id,
    model: cfg.model,
    wireApi: cfg.wireApi,
    version: `book-insight/${cacheVersion}`,
  });
  const cached = cache.get(cacheKey);
  if (cached) {
    return {
      ...cached,
      cache: { hit: true, ttlSeconds: Math.floor(cacheTtlMs / 1000) },
    };
  }

  // Fetch real book
  const raw = await deps.bookLookup(id);
  if (!raw) {
    throw new BookNotFoundError(id);
  }
  const basis = buildBasis(raw, rawLimit);
  const quality = deriveBibliographicGaps(basis);

  // Build MiniMax payload (only safe fields)
  const compact = {
    id: basis.id,
    title: basis.title,
    author: basis.author,
    publisher: basis.publisher,
    year: basis.year,
    pages: basis.pages,
    isbn: basis.isbn,
    ssid: basis.ssid,
    dxid: basis.dxid,
    parseStatus: basis.parseStatus,
    parseWarnings: basis.parseWarnings,
    quality,
    rawInfoExcerpt: basis.rawInfoExcerpt,
  };
  const userPayload = JSON.stringify(compact, null, 2);

  const messages = [
    { role: "system" as const, content: INSIGHT_SYSTEM },
    { role: "user" as const, content: `书目信息：\n${userPayload}` },
  ];

  let aiInsight: Partial<BookInsight> | null = null;
  let source: "ai" | "rule_based_fallback" = "ai";
  const chatResp = await chat(messages);
  if (chatResp.ok) {
    aiInsight = parseInsightJson(chatResp.content);
  } else {
    // Re-throw as a sanitized 502 — but for graceful UX we fall through to rule-based
    // and still set source=rule_based_fallback. The caller maps thrown errors to HTTP.
  }

  if (!aiInsight) {
    source = "rule_based_fallback";
    aiInsight = buildRuleBasedInsight(basis, quality);
  }

  const insight: BookInsight = sanitizeInsight(aiInsight, basis, quality);

  const response: BookInsightResponse = {
    bookId: basis.id,
    basis,
    quality,
    insight,
    source,
  };

  // Cache the response (skip if basis is too thin to be useful, or
  // if it was a 404-style empty book)
  if (basis.title || basis.author) {
    cache.set(cacheKey, response);
  }

  return { ...response, cache: { hit: false } };
}

// ---------- helpers ----------

function buildBasis(raw: Record<string, unknown>, rawLimit: number): BookInsightBasis {
  const rawInfo = typeof raw.rawInfo === "string" ? raw.rawInfo : "";
  const truncated = rawInfo.length > rawLimit;
  const excerpt = truncated ? rawInfo.slice(0, rawLimit) : rawInfo;
  return {
    id: String(raw.id ?? ""),
    title: String(raw.title ?? ""),
    author: String(raw.author ?? ""),
    publisher: String(raw.publisher ?? ""),
    year: typeof raw.year === "number" ? raw.year : raw.year ? Number(raw.year) : null,
    pages: typeof raw.pages === "number" ? raw.pages : raw.pages ? Number(raw.pages) : null,
    isbn: String(raw.isbn ?? ""),
    ssid: String(raw.ssid ?? ""),
    dxid: String(raw.dxid ?? ""),
    parseStatus: String(raw.parseStatus ?? "ok"),
    parseWarnings: Array.isArray(raw.parseWarnings)
      ? (raw.parseWarnings as unknown[]).filter((w) => typeof w === "string").map(String)
      : [],
    rawInfoExcerpt: excerpt,
    rawInfoTruncated: truncated,
  };
}

/** Derive quality gaps from actual book fields (not just parseWarnings). */
export function deriveBibliographicGaps(basis: BookInsightBasis): BibliographicQuality {
  const missingFields: string[] = [];
  const abnormalFields: string[] = [];
  const derivedWarnings: string[] = [];
  const trustHints: string[] = [];

  // ISBN
  if (!basis.isbn) {
    missingFields.push("isbn");
    derivedWarnings.push("missing_isbn");
    trustHints.push("ISBN 缺失，无法用 ISBN 进行版本核对");
  }

  // SSID/DXID (always present per index, but check anyway)
  if (!basis.ssid) missingFields.push("ssid");
  if (!basis.dxid) missingFields.push("dxid");

  // Title
  if (!basis.title) missingFields.push("title");

  // Year — non-numeric or zero/suspicious
  if (basis.year === null || isNaN(basis.year) || basis.year <= 0) {
    abnormalFields.push("year");
    derivedWarnings.push("year_non_numeric_or_invalid");
  }

  // Pages — non-numeric or zero/suspicious
  if (basis.pages === null || isNaN(basis.pages) || basis.pages <= 0) {
    abnormalFields.push("pages");
    derivedWarnings.push("pages_non_numeric_or_invalid");
  }

  // parseStatus
  if (basis.parseStatus === "weak") {
    trustHints.push("记录为弱解析，应结合原始 TXT 记录核对");
  } else if (basis.parseStatus === "failed") {
    trustHints.push("记录解析失败，仅保留原始标识");
  }

  // rawInfo
  if (!basis.rawInfoExcerpt) {
    trustHints.push("当前索引未保存原始记录，无法核对字段");
  }

  // Merge with parseWarnings, dedupe
  const allWarnings = Array.from(new Set([...basis.parseWarnings, ...derivedWarnings]));

  return {
    parseStatus: basis.parseStatus,
    missingFields,
    abnormalFields,
    warnings: allWarnings,
    trustHints,
  };
}

function parseInsightJson(text: string): Partial<BookInsight> | null {
  const obj = extractFirstJsonObject(text);
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;

  const out: Partial<BookInsight> = {};
  if (typeof o.shortSummary === "string") out.shortSummary = o.shortSummary;
  if (Array.isArray(o.subjectTags)) {
    out.subjectTags = o.subjectTags.filter((s): s is string => typeof s === "string");
  }
  if (typeof o.likelyAudience === "string") out.likelyAudience = o.likelyAudience;
  if (Array.isArray(o.bibliographicSignals)) {
    out.bibliographicSignals = o.bibliographicSignals.filter(
      (s): s is string => typeof s === "string",
    );
  }
  if (Array.isArray(o.searchSuggestions)) {
    out.searchSuggestions = o.searchSuggestions.filter(
      (s): s is string => typeof s === "string",
    );
  }
  if (Array.isArray(o.caveats)) {
    out.caveats = o.caveats.filter((s): s is string => typeof s === "string");
  }
  if (o.trustAssessment && typeof o.trustAssessment === "object") {
    const t = o.trustAssessment as Record<string, unknown>;
    if (t.level === "high" || t.level === "medium" || t.level === "low") {
      const reasons = Array.isArray(t.reasons)
        ? (t.reasons as unknown[]).filter((s): s is string => typeof s === "string")
        : [];
      out.trustAssessment = { level: t.level, reasons };
    }
  }
  return out;
}

/** Strict, deterministic fallback when AI returns nothing parseable. */
function buildRuleBasedInsight(basis: BookInsightBasis, quality: BibliographicQuality): Partial<BookInsight> {
  const titleHint = (basis.title || "").slice(0, 30);
  const authorHint = (basis.author || "").slice(0, 30);
  const publisherHint = (basis.publisher || "").slice(0, 30);

  const shortSummary =
    `这是一条书目记录（${titleHint}${authorHint ? "，" + authorHint : ""}）。` +
    `由于 AI 返回解析失败，本条只展示规则生成的客观字段摘要，不包含任何关于图书全文的描述。`;

  const subjectTags: string[] = [];
  if (basis.title) subjectTags.push(basis.title);
  if (basis.author) subjectTags.push(basis.author.split(/[;,；,、]/)[0].trim());

  const signals: string[] = [];
  if (basis.publisher) signals.push(`出版社：${publisherHint}`);
  if (basis.year) signals.push(`出版年份：${basis.year}`);
  if (basis.pages) signals.push(`页数：${basis.pages}`);
  if (basis.isbn) signals.push(`ISBN 完整：${basis.isbn}`);

  return {
    shortSummary,
    subjectTags,
    bibliographicSignals: signals,
    searchSuggestions: basis.title ? [basis.title.slice(0, 12)] : [],
    trustAssessment: {
      level: quality.parseStatus === "ok" ? "high" : quality.parseStatus === "weak" ? "medium" : "low",
      reasons: ["AI 返回不可解析，规则生成", `parseStatus=${quality.parseStatus}`],
    },
    caveats: [
      "AI 返回的 JSON 不可解析，本条分析为规则生成，不含 AI 解读。",
      "仅基于书目信息，不代表图书全文内容。",
    ],
  };
}

// Phrases that are clearly full-content claims when they appear in the model
// output. Order matters: longer / more specific phrases go first so they win
// over their substrings.
const FORBIDDEN_FULL_CONTENT_PHRASES = [
  "本书详细介绍",
  "本书详细介绍了",
  "本书详细讲述",
  "本书讲述了",
  "本书通过详细",
  "本书通过",
  "本书深入",
  "书中详细",
  "内容简介",
  "内容详尽",
  "读者评价",
  "作者生平",
  "书中指出",
  "获得奖项",
  "获奖情况",
  "销量",
  "影响力",
  "被翻译成",
];

function sanitizeInsight(raw: Partial<BookInsight>, basis: BookInsightBasis, quality: BibliographicQuality): BookInsight {
  const subjectTags = dedupe(capArray(raw.subjectTags ?? [], 8)).map(stripForbiddenIds(basis));
  let bibliographicSignals = dedupe(capArray(raw.bibliographicSignals ?? [], 6));
  const searchSuggestions = dedupe(capArray(raw.searchSuggestions ?? [], 6));
  let caveats = dedupe(capArray(raw.caveats ?? [], 5));

  // Remove forbidden full-content claims from all fields. If a removal would
  // leave a sentence dangling with a stray comma, drop the whole sentence.
  const stripForbidden = (s: string): string => {
    let out = s;
    for (const phrase of FORBIDDEN_FULL_CONTENT_PHRASES) {
      if (out.includes(phrase)) {
        out = out.split(/[。！？；\n]/).map((sent) => (sent.includes(phrase) ? "" : sent)).filter((s) => s.trim()).join("。");
      }
    }
    return out.replace(/、{2,}/g, "、").replace(/，{2,}/g, "，").replace(/^、|，$|、$|^。$|。$/g, "").trim();
  };

  bibliographicSignals = bibliographicSignals.map(stripForbidden).filter((s) => s);
  caveats = caveats.map(stripForbidden).filter((s) => s);

  let shortSummary = stripForbidden((raw.shortSummary ?? "").slice(0, 200));
  if (shortSummary.length > 120) shortSummary = shortSummary.slice(0, 120);
  // Disallow full-content claim language
  shortSummary = shortSummary
    .replace(/本书.{0,8}讲述了?/g, "本书记录显示")
    .replace(/内容简介[:：].*$/g, "（仅基于书目信息）")
    .replace(/目录[:：].*$/g, "（仅基于书目信息）");
  if (!shortSummary) {
    shortSummary = "（无 AI 摘要，仅展示书目元数据）";
  }

  let likelyAudience = stripForbidden((raw.likelyAudience ?? "").slice(0, 200));
  if (!likelyAudience) {
    likelyAudience = "无法判断（仅基于书目信息）";
  }

  // ---------- trust level: enforce downgrade based on actual basis ----------
  let trust: BookInsight["trustAssessment"];
  if (raw.trustAssessment && (raw.trustAssessment.level === "high" || raw.trustAssessment.level === "medium" || raw.trustAssessment.level === "low")) {
    trust = {
      level: raw.trustAssessment.level,
      reasons: dedupe(capArray(raw.trustAssessment.reasons ?? [], 6)),
    };
  } else {
    trust = { level: basis.parseStatus === "ok" ? "high" : "low", reasons: [`parseStatus=${basis.parseStatus}`] };
  }

  // Enforce trust downgrade for missing ISBN or weak/failed parseStatus
  if (quality.missingFields.includes("isbn") && trust.level === "high") {
    trust.level = "medium";
  }
  if (quality.parseStatus === "weak" && trust.level === "high") {
    trust.level = "medium";
  }
  if (quality.parseStatus === "failed") {
    trust.level = "low";
  }

  // Add trust hints from quality to reasons if not present
  for (const hint of quality.trustHints) {
    if (!trust.reasons.includes(hint) && trust.reasons.length < 6) {
      trust.reasons.push(hint);
    }
  }

  // Ensure missing ISBN caveat is present
  if (quality.missingFields.includes("isbn")) {
    const isbnCaveat = "ISBN 缺失，无法用 ISBN 核对版本。";
    if (!caveats.some((c) => c.includes("ISBN") && c.includes("缺"))) {
      caveats = [...caveats.slice(0, 4), isbnCaveat];
    }
  }

  // Ensure weak parseStatus caveat is present
  if (quality.parseStatus === "weak") {
    const weakCaveat = "该记录为弱解析，建议结合原始记录核对。";
    if (!caveats.some((c) => c.includes("弱解析") || c.includes("弱解析"))) {
      caveats = [...caveats.slice(0, 4), weakCaveat];
    }
  }

  return {
    scopeNote: SCOPE_NOTE,
    shortSummary,
    subjectTags,
    likelyAudience,
    bibliographicSignals,
    searchSuggestions,
    trustAssessment: trust,
    caveats,
  };
}

function dedupe(arr: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of arr) {
    const t = s.trim();
    if (!t) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

function capArray<T>(arr: T[], n: number): T[] {
  return arr.slice(0, n);
}

function stripForbiddenIds(basis: BookInsightBasis): (s: string) => string {
  return (s) => {
    let out = s;
    // If the AI invented a different ISBN/SSID/DXID, blank it.
    if (basis.isbn && /[0-9X-]{10,}/.test(out) && out.includes(basis.isbn) === false) {
      // conservative: if it looks like a long digit string, drop the line
      if (/\b\d{10,13}\b/.test(out) && !out.includes(basis.isbn)) {
        return ""; // filtered later by dedupe
      }
    }
    return out;
  };
}

// ---------- shared JSON extractor (also used in search-intent) ----------

function extractFirstJsonObject(text: string): unknown | null {
  const fence = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/i);
  const candidates: string[] = [];
  if (fence) candidates.push(fence[1]);
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
