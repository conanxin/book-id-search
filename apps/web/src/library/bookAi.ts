import {
  ensureAuthSessionLoaded, getWebAuthAuthGeneration, getWebAuthSnapshot,
} from "../auth/session";

export type BookAiAction = "introduction" | "notes_summary" | "question";
export interface BookAiInput { action: BookAiAction; question?: string }
export interface BookAiSource {
  id: string;
  kind: "catalog" | "introduction" | "note" | "weread";
  label: string;
  excerpt: string;
  href: string;
  contentHash: string;
  truncated: boolean;
  revisionId: string | null;
}
export interface BookAiContext {
  workspaceVersion: number;
  introductionIncluded: boolean;
  notesAvailable: number;
  notesIncluded: number;
  wereadAvailable: number;
  wereadIncluded: number;
  wereadEnabled: boolean;
  truncated: boolean;
  sourceChars: number;
}
export interface BookAiResponse {
  bookId: string;
  action: BookAiAction;
  question: string | null;
  draft: { title: string; content: string };
  sources: BookAiSource[];
  citedSourceIds: string[];
  context: BookAiContext;
  source: "ai" | "insufficient_context";
  generatedAt: string;
}

export class BookAiError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
    this.name = "BookAiError";
  }
}

const API_BASE = import.meta.env.VITE_API_BASE_URL || "/api";
const ACTIONS: BookAiAction[] = ["introduction", "notes_summary", "question"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ERRORS: Record<number, string> = {
  400: "请检查书籍和问题后重试。问题最多 1,000 字符。",
  401: "登录已失效，请使用 Google 登录后继续。",
  403: "当前登录暂不可用，请刷新登录状态后重试。",
  404: "这本书暂时找不到，请重新打开书页后再试。",
  413: "问题过长，请缩短后重试。",
  429: "AI 请求较多，请稍后重试。",
  502: "AI 返回的内容或来源异常，请重新生成。",
  503: "本书 AI 助手暂不可用，请稍后重试。",
  504: "AI 生成超时，请稍后重试。",
};

export function isBookAiAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
export function bookAiErrorMessage(error: unknown): string {
  return error instanceof BookAiError ? error.message : "暂时无法生成，请重试。";
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function count(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}
function text(value: unknown, max: number): value is string {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) return false;
  // Reject malformed Unicode before rendering or copying the result.
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
function input(value: unknown): BookAiInput {
  if (!record(value) || !ACTIONS.includes(value.action as BookAiAction)
    || Object.keys(value).some(key => key !== "action" && key !== "question")) {
    throw new BookAiError(400, ERRORS[400]);
  }
  if (value.action === "question") {
    if (typeof value.question !== "string" || !text(value.question.trim(), 1000)) throw new BookAiError(400, ERRORS[400]);
    return { action: "question", question: value.question.trim() };
  }
  if ("question" in value) throw new BookAiError(400, ERRORS[400]);
  return { action: value.action as BookAiAction };
}

function validSource(value: unknown, bookId: string, index: number): value is BookAiSource {
  if (!record(value) || value.id !== `S${index + 1}` || !text(value.label, 160) || !text(value.excerpt, 4000)
    || typeof value.truncated !== "boolean" || typeof value.contentHash !== "string"
    || !/^[a-f0-9]{64}$/.test(value.contentHash) || typeof value.href !== "string") return false;
  const path = `/books/${bookId}`;
  if (value.kind === "note") {
    const prefix = `${path}#book-note-`;
    return typeof value.revisionId === "string" && UUID.test(value.revisionId)
      && value.href.startsWith(prefix) && UUID.test(value.href.slice(prefix.length));
  }
  if (value.revisionId !== null) return false;
  if (value.kind === "catalog") return value.href === path;
  if (value.kind === "introduction") return value.href === `${path}#library-introduction-heading`;
  return value.kind === "weread" && value.href === `/weread?catalogId=${bookId}`;
}

function validResponse(value: unknown, bookId: string, request: BookAiInput): value is BookAiResponse {
  if (!record(value) || value.bookId !== bookId || value.action !== request.action
    || value.question !== (request.question ?? null) || !record(value.draft)
    || !text(value.draft.title, 160) || !text(value.draft.content, 12000)
    || !Array.isArray(value.sources) || value.sources.length < 1 || value.sources.length > 24
    || !value.sources.every((source, i) => validSource(source, bookId, i))
    || !Array.isArray(value.citedSourceIds) || !value.citedSourceIds.every(id => typeof id === "string")
    || new Set(value.citedSourceIds).size !== value.citedSourceIds.length
    || (value.source !== "ai" && value.source !== "insufficient_context")
    || !text(value.generatedAt, 40) || !Number.isFinite(Date.parse(value.generatedAt)) || !record(value.context)) return false;
  const sources = value.sources as BookAiSource[], c = value.context;
  if (![c.workspaceVersion, c.notesAvailable, c.notesIncluded, c.wereadAvailable, c.wereadIncluded, c.sourceChars].every(count)
    || ![c.introductionIncluded, c.wereadEnabled, c.truncated].every(v => typeof v === "boolean")) return false;
  const kinds = (kind: BookAiSource["kind"]) => sources.filter(source => source.kind === kind).length;
  if (kinds("catalog") !== 1 || kinds("introduction") > 1
    || c.introductionIncluded !== (kinds("introduction") === 1)
    || c.notesIncluded !== kinds("note") || c.wereadIncluded !== kinds("weread")
    || Number(c.notesAvailable) < Number(c.notesIncluded) || Number(c.wereadAvailable) < Number(c.wereadIncluded)
    || (!c.wereadEnabled && (c.wereadAvailable !== 0 || c.wereadIncluded !== 0))
    || c.sourceChars !== sources.reduce((sum, source) => sum + source.excerpt.length, 0) || Number(c.sourceChars) > 24000
    || (!c.truncated && (sources.some(source => source.truncated) || c.notesAvailable !== c.notesIncluded || c.wereadAvailable !== c.wereadIncluded))) return false;
  const known = new Set(sources.map(source => source.id));
  if (value.citedSourceIds.some(id => !known.has(id))) return false;
  const markers = new Set(Array.from(value.draft.content.matchAll(/\[(S\d+)\]/g), match => match[1]));
  const cited = new Set(value.citedSourceIds as string[]);
  if (markers.size !== cited.size || Array.from(markers).some(id => !cited.has(id))) return false;
  return value.source !== "ai" || cited.size > 0;
}

function requireCurrent(generation: number, signal?: AbortSignal): void {
  if (signal?.aborted || getWebAuthAuthGeneration() !== generation || getWebAuthSnapshot().status !== "authenticated") {
    throw new DOMException("Request no longer current", "AbortError");
  }
}

/** Generates a transient result without writing to the book's personal content. */
export async function generateBookAi(bookId: string, value: BookAiInput, signal?: AbortSignal): Promise<BookAiResponse> {
  if (!bookIdValid(bookId)) throw new BookAiError(400, ERRORS[400]);
  const body = input(value), session = getWebAuthSnapshot(), generation = getWebAuthAuthGeneration();
  if (session.status !== "authenticated") throw new BookAiError(401, ERRORS[401]);
  if (!session.csrfToken) throw new BookAiError(403, ERRORS[403]);
  requireCurrent(generation, signal);
  let response: Response;
  try {
    response = await fetch(`${API_BASE}/ai/books/${encodeURIComponent(bookId)}/assistant`, {
      method: "POST", credentials: "same-origin", cache: "no-store", signal,
      headers: { "content-type": "application/json", "x-csrf-token": session.csrfToken },
      body: JSON.stringify(body),
    });
  } catch {
    requireCurrent(generation, signal);
    throw new BookAiError(502, "暂时无法连接 AI 服务，请重试。");
  }
  requireCurrent(generation, signal);
  const result: unknown = await response.json().catch(() => null);
  requireCurrent(generation, signal);
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) void ensureAuthSessionLoaded();
    const code = record(result) && record(result.error) && typeof result.error.code === "string"
      && /^BOOK_AI_[A-Z_]+$/.test(result.error.code) ? result.error.code : undefined;
    const message = code === "BOOK_AI_DISABLED" ? "本书 AI 助手尚未启用，现有介绍和笔记仍可编辑。"
      : ERRORS[response.status] ?? "暂时无法生成，请稍后重试。";
    throw new BookAiError(response.status, message, code);
  }
  if (!validResponse(result, bookId, body)) throw new BookAiError(502, ERRORS[502]);
  return result;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").replace(/[\\`*_\[\]<>]/g, "\\$&");
}

/** Copyable text includes the cited source snapshots and generation time. */
export function bookAiDraftContent(result: BookAiResponse): string {
  const request: BookAiInput = result.action === "question" ? { action: result.action, question: result.question ?? "" } : { action: result.action };
  if (!bookIdValid(result.bookId) || !validResponse(result, result.bookId, request)) throw new BookAiError(502, ERRORS[502]);
  if (result.source !== "ai") throw new BookAiError(400, "请先补充本书资料，再生成参考结果。");
  const cited = new Set(result.citedSourceIds);
  const references = result.sources.filter(source => cited.has(source.id)).map(source =>
    `[${source.id}] ${oneLine(source.label)}\n[查看来源](${source.href})\n\n${source.excerpt.split(/\r?\n/).map(line => `> ${line}`).join("\n")}`,
  ).join("\n\n");
  const draft = `${result.question ? `问题：${result.question}\n\n` : ""}${result.draft.content}\n\n---\n\n### 参考资料（生成时摘录）\n\n生成时间：${result.generatedAt}\n\n${references}`;
  if (draft.length > 50000) throw new BookAiError(413, "结果与引用摘录过长，请减少本次资料后重试。");
  return draft;
}
