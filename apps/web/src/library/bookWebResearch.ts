import { ensureAuthSessionLoaded, getWebAuthAuthGeneration, getWebAuthSnapshot } from "../auth/session";

export interface BookWebResearchBookClues {
  isbn: "matched" | "mixed" | "other_only" | "not_seen" | "unavailable";
  text: ("title" | "author")[];
}
export interface BookWebResearchTextContext {
  kind: "quoted_title" | "edition_text";
  field: "title" | "excerpt";
  value: string;
  matchStart: number;
  matchEnd: number;
  start: number;
  end: number;
  text: string;
}
export interface BookWebResearchTextContexts {
  items: BookWebResearchTextContext[];
  limited: boolean;
}
export interface BookWebResearchSource {
  id: string;
  kind: "web";
  title: string;
  url: string;
  excerpt: string;
  pageAge: string | null;
  truncated: boolean;
  readToken?: string;
  bookClues?: BookWebResearchBookClues;
  /** Optional metadata stays untrusted until the shared getter validates its original text ranges. */
  textContexts?: unknown;
}
export interface BookWebResearchResponse {
  scope?: "direct_book_review";
  bookId: string;
  question: string;
  mode: "source_excerpts";
  source: "web_research" | "insufficient_sources" | "unselected_sources";
  draft: { title: string; content: string };
  sources: BookWebResearchSource[];
  citedSourceIds: string[];
  search: { performed: true; queries: string[]; calls: number; limited?: boolean };
  generatedAt: string;
}
export interface BookWebResearchInput { question: string; scope?: "direct_book_review" }
export const BOOK_WEB_DIRECT_REVIEW_NOTICE = "严格本书书评：仅推荐能在搜索节选中同时找到目标书身份与书评性质线索的候选；不代表已确认书评全文，未入选来源仍可查看。";

export class BookWebResearchError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message); this.name = "BookWebResearchError";
  }
}

const API_BASE = import.meta.env.VITE_API_BASE_URL || "/api";
export const BOOK_WEB_RESEARCH_EXCERPTS_NOTICE = "已根据本次问题选出相关网页，以下保留搜索工具返回的来源节选。节选不等于网页或原书全文；来源之间可能有不同说法。";
export const BOOK_WEB_RESEARCH_LIMITED_NOTICE = "本次搜索已达到上限，已保留返回的资料。可以调整问题后再查。";
export const BOOK_WEB_RESEARCH_BOOK_CLUES_NOTICE = "这里只展示当前标题和搜索节选中的文字线索，不确认同书、版本或资料类型，也不代表已读全文或内容可信。";
export const BOOK_WEB_RESEARCH_SELECTED_ISBN_NOTICE = "所选资料尚缺可对应本书的 ISBN 线索；与本书的直接关联仍需核对。";
const BOOK_CLUE_LABELS: Record<BookWebResearchBookClues["isbn"], string> = {
  matched: "出现本书 ISBN",
  mixed: "本书与其他 ISBN 同时出现",
  other_only: "只看到其他 ISBN",
  not_seen: "未见本书 ISBN",
  unavailable: "本书 ISBN 无法用于比对",
};
export const BOOK_WEB_TEXT_CONTEXTS_UNAVAILABLE = "本次未提供可用的文字上下文。";
export const BOOK_WEB_TEXT_CONTEXTS_EMPTY = "当前没有可展示的书名号或版本字样上下文。";
export const BOOK_WEB_TEXT_CONTEXTS_LIMITED = "部分字样未列出，请结合标题和完整节选核对。";
const RESULT_TITLE = "查到的相关资料";
const UNSELECTED_TITLE = "待核对的网页资料";
const UNSELECTED_CONTENT = "已完成网页搜索，但本次自动挑选未完成。下方保留搜索返回的资料，可以打开原链接核对或读取网页正文。";
const INVALID_RESULT = "返回的研究资料未通过核对，请重新查询。";
const INSUFFICIENT_CONTENT = "本次已执行联网搜索，但没有选出与问题充分相关的资料。下方如有搜索结果，可以打开原链接核对，或调整问题后再查。";
const ERRORS: Record<number, string> = {
  400: "请填写想研究的问题，最多 1,000 字符。",
  401: "登录已失效，请使用 Google 登录后继续。",
  403: "当前登录暂不可用，请刷新登录状态后重试。",
  404: "这本书暂时找不到，请重新打开书页后再试。",
  413: "问题过长，请缩短后重试。",
  429: "研究请求较多，请稍后重试。",
  502: "本次搜索或来源核对未完成，请重试。",
  503: "联网研究暂不可用，请稍后重试。",
  504: "本次研究超时，请稍后重试。",
};

const CODE_ERRORS: Record<string, { status: number; message: string }> = {
  BOOK_RESEARCH_SEARCH_FAILED: { status: 502, message: "本次网页搜索未完成，请稍后重试。" },
  BOOK_RESEARCH_INVALID_RESPONSE: { status: 502, message: "本次来源挑选结果未通过核对，请重新查询。" },
  BOOK_RESEARCH_SELECTION_FAILED: { status: 502, message: "网页搜索已完成，但来源挑选未完成，请重试。" },
  BOOK_RESEARCH_SEARCH_TIMEOUT: { status: 504, message: "本次网页搜索超时，请稍后重试。" },
  BOOK_RESEARCH_SELECTION_TIMEOUT: { status: 504, message: "网页搜索已完成，但来源挑选超时，请重试。" },
  BOOK_RESEARCH_SEARCH_RATE_LIMITED: { status: 429, message: "网页搜索请求较多，请稍后重试。" },
  BOOK_RESEARCH_SELECTION_RATE_LIMITED: { status: 429, message: "来源挑选请求较多，请稍后重试。" },
  BOOK_RESEARCH_UNAVAILABLE: { status: 503, message: ERRORS[503] },
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function text(value: unknown, max: number): value is string {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) return false;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}
function bookIdValid(value: unknown): value is string {
  return typeof value === "string" && value.length <= 128 && /^[0-9]+_[0-9]{12}$/.test(value);
}
function webUrl(value: unknown): string | null {
  if (!text(value, 4096) || /[\u0000-\u0020\u007f\\]/u.test(value) || !/^https?:\/\//i.test(value)) return null;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
function validBookClues(value: unknown): value is BookWebResearchBookClues {
  return record(value) && Object.keys(value).length === 2
    && Object.keys(value).every(key => key === "isbn" || key === "text")
    && typeof value.isbn === "string" && Object.hasOwn(BOOK_CLUE_LABELS, value.isbn)
    && Array.isArray(value.text) && value.text.length <= 2
    && value.text.every(clue => clue === "title" || clue === "author")
    && new Set(value.text).size === value.text.length
    && (value.text.length < 2 || value.text[0] === "title");
}
function utf16Boundary(value: string, position: number): boolean {
  return position === 0 || position === value.length
    || !(value.charCodeAt(position - 1) >= 0xd800 && value.charCodeAt(position - 1) <= 0xdbff
      && value.charCodeAt(position) >= 0xdc00 && value.charCodeAt(position) <= 0xdfff);
}

function validTextContexts(value: unknown, source: BookWebResearchSource): value is BookWebResearchTextContexts {
  if (!record(value) || Object.keys(value).length !== 2
    || !Object.keys(value).every(key => key === "items" || key === "limited")
    || typeof value.limited !== "boolean" || !Array.isArray(value.items) || value.items.length > 8) return false;
  let quotedTitles = 0, editions = 0, previousField = -1, previousStart = -1;
  for (const item of value.items) {
    if (!record(item) || Object.keys(item).length !== 8
      || !Object.keys(item).every(key => ["kind", "field", "value", "matchStart", "matchEnd", "start", "end", "text"].includes(key))
      || (item.kind !== "quoted_title" && item.kind !== "edition_text")
      || (item.field !== "title" && item.field !== "excerpt")
      || !text(item.value, item.kind === "quoted_title" ? 120 : 40) || !text(item.text, 400)
      || typeof item.start !== "number" || typeof item.end !== "number"
      || typeof item.matchStart !== "number" || typeof item.matchEnd !== "number"
      || ![item.start, item.end, item.matchStart, item.matchEnd].every(Number.isSafeInteger)) return false;
    const original = source[item.field], fieldOrder = item.field === "title" ? 0 : 1;
    if (typeof original !== "string" || item.start < 0 || item.start > item.matchStart
      || item.matchStart >= item.matchEnd || item.matchEnd > item.end || item.end > original.length
      || item.text !== original.slice(item.start, item.end) || item.value !== original.slice(item.matchStart, item.matchEnd)
      || ![item.start, item.end, item.matchStart, item.matchEnd].every(position => utf16Boundary(original, position))
      || fieldOrder < previousField || (fieldOrder === previousField && item.matchStart <= previousStart)) return false;
    if (item.kind === "quoted_title") {
      if (++quotedTitles > 4 || !/^《[^《》\r\n\u0085\u2028\u2029]+》$/u.test(item.value) || !item.value.slice(1, -1).trim()) return false;
      let depth = 0;
      for (let index = 0; index < item.matchStart; index++) {
        if (original[index] === "《") depth++;
        else if (original[index] === "》" && depth > 0) depth--;
      }
      if (depth !== 0) return false;
    } else {
      if (++editions > 4 || !/^(?:第[ \t]*[0-9０-９一二三四五六七八九十百千零〇两兩]+[ \t]*版|初版|再版|重版|修订版|修訂版|增订版|增訂版|版本|版次)$/u.test(item.value)) return false;
    }
    previousField = fieldOrder; previousStart = item.matchStart;
  }
  return true;
}

/** An invalid optional block must not discard a source or expose unvalidated text in the view or clipboard. */
export function bookWebSourceTextContexts(source: BookWebResearchSource): BookWebResearchTextContexts | undefined {
  return validTextContexts(source.textContexts, source) ? source.textContexts : undefined;
}

export function bookWebTextContextHeading(item: BookWebResearchTextContext): string {
  return (item.kind === "quoted_title" ? "书名号中的文字" : "版本字样")
    + "（" + (item.field === "title" ? "标题中的文字" : "搜索节选中的文字") + "）：" + item.value;
}

function bookWebSourceTextContextsContent(source: BookWebResearchSource): string {
  const contexts = bookWebSourceTextContexts(source);
  const content = !contexts ? BOOK_WEB_TEXT_CONTEXTS_UNAVAILABLE
    : contexts.items.length === 0 ? BOOK_WEB_TEXT_CONTEXTS_EMPTY
      : contexts.items.map(item => bookWebTextContextHeading(item) + "\n" + item.text).join("\n\n");
  return "书目文字上下文：\n" + content + (contexts?.limited ? "\n\n" + BOOK_WEB_TEXT_CONTEXTS_LIMITED : "");
}

function validSource(value: unknown, index: number): value is BookWebResearchSource {
  return record(value) && value.id === `W${index + 1}` && value.kind === "web"
    && text(value.title, 300) && webUrl(value.url) !== null && text(value.excerpt, 3000)
    && (value.pageAge === null || text(value.pageAge, 100)) && typeof value.truncated === "boolean"
    && (value.readToken === undefined || (typeof value.readToken === "string" && /^[A-Za-z0-9_-]{32}$/.test(value.readToken)))
    && (value.bookClues === undefined || validBookClues(value.bookClues));
}
function validResponse(value: unknown, bookId: string, question: string): value is BookWebResearchResponse {
  if (!record(value) || value.bookId !== bookId || value.question !== question || !record(value.draft)
    || value.mode !== "source_excerpts"
    || (value.scope !== undefined && value.scope !== "direct_book_review")
    || value.draft.title !== (value.source === "unselected_sources" ? UNSELECTED_TITLE : RESULT_TITLE) || !text(value.draft.content, 12000)
    || !Array.isArray(value.sources) || value.sources.length > 12 || !value.sources.every(validSource)
    || !Array.isArray(value.citedSourceIds) || value.citedSourceIds.length > 4 || !value.citedSourceIds.every(id => typeof id === "string")
    || new Set(value.citedSourceIds).size !== value.citedSourceIds.length
    || (value.source !== "web_research" && value.source !== "insufficient_sources" && value.source !== "unselected_sources")
    || !text(value.generatedAt, 40) || !/^\d{4}-\d\d-\d\dT/.test(value.generatedAt)
    || !Number.isFinite(Date.parse(value.generatedAt)) || !record(value.search)
    || value.search.performed !== true || (value.search.limited !== undefined && typeof value.search.limited !== "boolean")
    || !Array.isArray(value.search.queries)
    || value.search.queries.length < 1 || value.search.queries.length > 12
    || !value.search.queries.every(query => text(query, 1000)) || !Number.isSafeInteger(value.search.calls)
    || Number(value.search.calls) !== value.search.queries.length || Number(value.search.calls) > 12) return false;
  const sources = value.sources as BookWebResearchSource[];
  if (sources.reduce((sum, source) => sum + source.excerpt.length, 0) > 24000
    || new Set(sources.map(source => webUrl(source.url))).size !== sources.length) return false;
  const known = new Set(sources.map(source => source.id));
  const cited = new Set(value.citedSourceIds as string[]);
  const markers = new Set(Array.from(value.draft.content.matchAll(/\[((?:W|S)\d+)\]/g), match => match[1]));
  if (Array.from(cited).some(id => !known.has(id)) || markers.size !== cited.size
    || Array.from(markers).some(id => !cited.has(id))) return false;
  if (value.source === "unselected_sources") return sources.length > 0 && cited.size === 0 && value.draft.content === UNSELECTED_CONTENT;
  return value.source === "web_research"
    ? cited.size > 0 && value.draft.content === `${BOOK_WEB_RESEARCH_EXCERPTS_NOTICE}\n\n建议先查看：${value.citedSourceIds.map(id => `[${id}]`).join(" ")}`
    : cited.size === 0 && value.draft.content === INSUFFICIENT_CONTENT;
}

/** Prevent older or free-form research output from entering the excerpt-only view. */
export function assertBookWebResearchResponse(value: unknown, bookId: string, question: string, scope?: "direct_book_review"): asserts value is BookWebResearchResponse {
  if (!bookIdValid(bookId) || !text(question, 1000) || !validResponse(value, bookId, question)
    || (value as BookWebResearchResponse).scope !== scope) {
    throw new BookWebResearchError(502, INVALID_RESULT, "BOOK_RESEARCH_CLIENT_INVALID_RESPONSE");
  }
}
function requireCurrent(generation: number, signal?: AbortSignal): void {
  if (signal?.aborted || getWebAuthAuthGeneration() !== generation || getWebAuthSnapshot().status !== "authenticated") {
    throw new DOMException("Request no longer current", "AbortError");
  }
}
export function isBookWebResearchAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
export function bookWebResearchErrorMessage(error: unknown): string {
  return error instanceof BookWebResearchError ? error.message : "暂时无法完成研究，请重试。";
}

/** Sends only the current book identity and explicit question, with no personal-library writes. */
export async function generateBookWebResearch(bookId: string, value: BookWebResearchInput, signal?: AbortSignal): Promise<BookWebResearchResponse> {
  if (!bookIdValid(bookId) || !record(value) || Object.keys(value).some(key => key !== "question" && key !== "scope")
    || (value.scope !== undefined && value.scope !== "direct_book_review")
    || typeof value.question !== "string" || !text(value.question.trim(), 1000)) throw new BookWebResearchError(400, ERRORS[400]);
  const question = value.question.trim(), session = getWebAuthSnapshot(), generation = getWebAuthAuthGeneration();
  if (session.status !== "authenticated") throw new BookWebResearchError(401, ERRORS[401]);
  if (!session.csrfToken) throw new BookWebResearchError(403, ERRORS[403]);
  requireCurrent(generation, signal);
  let response: Response;
  try {
    response = await fetch(`${API_BASE}/ai/books/${encodeURIComponent(bookId)}/research`, {
      method: "POST", credentials: "same-origin", cache: "no-store", signal,
      headers: { "content-type": "application/json", "x-csrf-token": session.csrfToken }, body: JSON.stringify({ question, ...(value.scope === "direct_book_review" ? { scope: value.scope } : {}) }),
    });
  } catch {
    requireCurrent(generation, signal);
    throw new BookWebResearchError(502, "暂时无法连接联网研究服务，请重试。");
  }
  requireCurrent(generation, signal);
  const result: unknown = await response.json().catch(() => null);
  requireCurrent(generation, signal);
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) void ensureAuthSessionLoaded();
    const code = record(result) && record(result.error) && typeof result.error.code === "string"
      && /^BOOK_RESEARCH_[A-Z_]+$/.test(result.error.code) ? result.error.code : undefined;
    const known = code && Object.hasOwn(CODE_ERRORS, code) ? CODE_ERRORS[code] : undefined;
    const message = known?.status === response.status ? known.message
      : ERRORS[response.status] ?? "暂时无法完成研究，请稍后重试。";
    throw new BookWebResearchError(response.status, message, code);
  }
  assertBookWebResearchResponse(result, bookId, question, value.scope);
  return result;
}

/** Describe visible bibliographic text without claiming that the source or its content is verified. */
export function bookWebSourceCluesText(source: BookWebResearchSource): string {
  if (!source.bookClues) return "书目线索未核对";
  return "书目线索：" + [
    BOOK_CLUE_LABELS[source.bookClues.isbn],
    ...source.bookClues.text.map(clue => clue === "title" ? "出现书名文字" : "出现作者文字"),
  ].join("；");
}

export function bookWebResearchNeedsIsbnReview(result: BookWebResearchResponse): boolean {
  return result.citedSourceIds.length > 0 && result.citedSourceIds.every(id => {
    const isbn = result.sources.find(source => source.id === id)?.bookClues?.isbn;
    return isbn !== undefined && isbn !== "matched" && isbn !== "mixed";
  });
}

function oneLine(value: string): string { return value.replace(/\s+/g, " ").replace(/[\\`*_\[\]<>]/g, "\\$&"); }

/** Copy validated source excerpts, retaining available snapshots when selection is incomplete or insufficient. */
export function bookWebResearchContent(result: BookWebResearchResponse): string {
  assertBookWebResearchResponse(result, result.bookId, result.question);
  if (result.source === "insufficient_sources" && result.sources.length === 0) throw new BookWebResearchError(400, "本次资料不足，请调整问题后继续查找。");
  const sources = result.source === "web_research"
    ? result.citedSourceIds.map(id => result.sources.find(source => source.id === id)!) : result.sources;
  const references = sources.map(source =>
    "[" + source.id + "] " + oneLine(source.title) + "\n" + source.url
    + (source.pageAge ? "\n页面时间：" + oneLine(source.pageAge) : "")
    + "\n\n" + bookWebSourceCluesText(source) + "\n\n搜索结果节选：\n" + source.excerpt
    + (source.truncated ? "\n\n（本条搜索节选已截短）" : "")
    + "\n\n" + bookWebSourceTextContextsContent(source),
  ).join("\n\n");
  const limitedNotice = result.search.limited === true ? `${BOOK_WEB_RESEARCH_LIMITED_NOTICE}\n\n` : "";
  const title = result.source === "insufficient_sources" ? "本次搜索资料不足" : result.draft.title;
  const selectedNotice = bookWebResearchNeedsIsbnReview(result) ? `\n\n${BOOK_WEB_RESEARCH_SELECTED_ISBN_NOTICE}` : "";
  return `# ${oneLine(title)}\n\n问题：${result.question}\n\n${result.draft.content}\n\n${BOOK_WEB_RESEARCH_BOOK_CLUES_NOTICE}${selectedNotice}\n\n---\n\n### 联网研究来源（搜索时摘录）\n\n生成时间：${result.generatedAt}\n\n${limitedNotice}本次搜索：\n${result.search.queries.map(query => `- ${oneLine(query)}`).join("\n")}\n\n${references}`;
}
