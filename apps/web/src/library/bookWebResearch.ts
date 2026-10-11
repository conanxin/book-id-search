import { ensureAuthSessionLoaded, getWebAuthAuthGeneration, getWebAuthSnapshot } from "../auth/session";

export interface BookWebResearchSource {
  id: string;
  kind: "web";
  title: string;
  url: string;
  excerpt: string;
  pageAge: string | null;
  truncated: boolean;
}
export interface BookWebResearchResponse {
  bookId: string;
  question: string;
  source: "web_research" | "insufficient_sources";
  draft: { title: string; content: string };
  sources: BookWebResearchSource[];
  citedSourceIds: string[];
  search: { performed: true; queries: string[]; calls: number };
  generatedAt: string;
}
export interface BookWebResearchInput { question: string }

export class BookWebResearchError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message); this.name = "BookWebResearchError";
  }
}

const API_BASE = import.meta.env.VITE_API_BASE_URL || "/api";
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
function validSource(value: unknown, index: number): value is BookWebResearchSource {
  return record(value) && value.id === `W${index + 1}` && value.kind === "web"
    && text(value.title, 300) && webUrl(value.url) !== null && text(value.excerpt, 3000)
    && (value.pageAge === null || text(value.pageAge, 100)) && typeof value.truncated === "boolean";
}
function validResponse(value: unknown, bookId: string, question: string): value is BookWebResearchResponse {
  if (!record(value) || value.bookId !== bookId || value.question !== question || !record(value.draft)
    || !text(value.draft.title, 300) || !text(value.draft.content, 12000)
    || !Array.isArray(value.sources) || value.sources.length > 12 || !value.sources.every(validSource)
    || !Array.isArray(value.citedSourceIds) || !value.citedSourceIds.every(id => typeof id === "string")
    || new Set(value.citedSourceIds).size !== value.citedSourceIds.length
    || (value.source !== "web_research" && value.source !== "insufficient_sources")
    || !text(value.generatedAt, 40) || !/^\d{4}-\d\d-\d\dT/.test(value.generatedAt)
    || !Number.isFinite(Date.parse(value.generatedAt)) || !record(value.search)
    || value.search.performed !== true || !Array.isArray(value.search.queries)
    || value.search.queries.length < 1 || value.search.queries.length > 12
    || !value.search.queries.every(query => text(query, 1000)) || !Number.isSafeInteger(value.search.calls)
    || Number(value.search.calls) < value.search.queries.length || Number(value.search.calls) > 32) return false;
  const sources = value.sources as BookWebResearchSource[];
  if (sources.reduce((sum, source) => sum + source.excerpt.length, 0) > 24000
    || new Set(sources.map(source => webUrl(source.url))).size !== sources.length) return false;
  const known = new Set(sources.map(source => source.id));
  const cited = new Set(value.citedSourceIds as string[]);
  const markers = new Set(Array.from(value.draft.content.matchAll(/\[((?:W|S)\d+)\]/g), match => match[1]));
  if (Array.from(cited).some(id => !known.has(id)) || markers.size !== cited.size
    || Array.from(markers).some(id => !cited.has(id))) return false;
  return value.source === "web_research" ? cited.size > 0 : cited.size === 0;
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
  if (!bookIdValid(bookId) || !record(value) || Object.keys(value).some(key => key !== "question")
    || typeof value.question !== "string" || !text(value.question.trim(), 1000)) throw new BookWebResearchError(400, ERRORS[400]);
  const question = value.question.trim(), session = getWebAuthSnapshot(), generation = getWebAuthAuthGeneration();
  if (session.status !== "authenticated") throw new BookWebResearchError(401, ERRORS[401]);
  if (!session.csrfToken) throw new BookWebResearchError(403, ERRORS[403]);
  requireCurrent(generation, signal);
  let response: Response;
  try {
    response = await fetch(`${API_BASE}/ai/books/${encodeURIComponent(bookId)}/research`, {
      method: "POST", credentials: "same-origin", cache: "no-store", signal,
      headers: { "content-type": "application/json", "x-csrf-token": session.csrfToken }, body: JSON.stringify({ question }),
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
    throw new BookWebResearchError(response.status, ERRORS[response.status] ?? "暂时无法完成研究，请稍后重试。", code);
  }
  if (!validResponse(result, bookId, question)) throw new BookWebResearchError(502, ERRORS[502]);
  return result;
}

function oneLine(value: string): string { return value.replace(/\s+/g, " ").replace(/[\\`*_\[\]<>]/g, "\\$&"); }

/** Copy only validated results, together with the actual cited search snapshots. */
export function bookWebResearchContent(result: BookWebResearchResponse): string {
  if (!bookIdValid(result.bookId) || !text(result.question, 1000) || !validResponse(result, result.bookId, result.question)) {
    throw new BookWebResearchError(502, ERRORS[502]);
  }
  if (result.source !== "web_research") throw new BookWebResearchError(400, "本次资料不足，请调整问题后继续查找。");
  const cited = new Set(result.citedSourceIds);
  const references = result.sources.filter(source => cited.has(source.id)).map(source =>
    `[${source.id}] ${oneLine(source.title)}\n${source.url}\n${source.pageAge ? `页面时间：${oneLine(source.pageAge)}\n` : ""}\n搜索结果节选：\n${source.excerpt.split(/\r?\n/).map(line => `> ${line}`).join("\n")}${source.truncated ? "\n\n（本条搜索节选已截短）" : ""}`,
  ).join("\n\n");
  return `# ${oneLine(result.draft.title)}\n\n问题：${result.question}\n\n${result.draft.content}\n\n---\n\n### 联网研究来源（搜索时摘录）\n\n生成时间：${result.generatedAt}\n\n本次搜索：\n${result.search.queries.map(query => `- ${oneLine(query)}`).join("\n")}\n\n${references}`;
}
