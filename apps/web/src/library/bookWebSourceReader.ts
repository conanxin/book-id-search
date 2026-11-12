import { ensureAuthSessionLoaded, getWebAuthAuthGeneration, getWebAuthSnapshot } from "../auth/session";
import type { BookWebResearchSource } from "./bookWebResearch";

export interface BookWebSourceReadResponse {
  bookId: string;
  sourceId: string;
  requestedUrl: string;
  finalUrl: string;
  title: string;
  text: string;
  contentType: "text/html" | "application/xhtml+xml" | "text/plain";
  extraction: "html_readable_text" | "plain_text";
  truncated: boolean;
  fetchedAt: string;
}

export class BookWebSourceReadError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message); this.name = "BookWebSourceReadError";
  }
}

const API_BASE = import.meta.env.VITE_API_BASE_URL || "/api";
const ERRORS: Record<number, string> = {
  400: "这个来源暂不可读取，请重新联网查资料后再试。",
  401: "登录已失效，请使用 Google 登录后继续。",
  403: "当前登录暂不可用，请刷新登录状态后重试。",
  404: "这本书暂时找不到，请重新打开书页后再试。",
  410: "本次来源已过期，请重新联网查资料后再读取。",
  413: "这个网页内容过大，请打开原网页查看。",
  415: "暂不支持读取这类链接，请打开原网页查看。",
  422: "这个网页没有可提取的文字，请打开原网页查看。",
  429: "读取请求较多，请稍后重试。",
  502: "暂时无法读取这个网页，可重试或打开原网页。",
  503: "网页读取暂不可用，请稍后重试。",
  504: "本次网页读取超时，可重试或打开原网页。",
};
const CODE_MESSAGES: Record<string, string> = {
  BOOK_SOURCE_INVALID_INPUT: ERRORS[400],
  BOOK_SOURCE_BLOCKED: "这个地址不支持直接读取，请打开原网页查看。",
  BOOK_SOURCE_EXPIRED: ERRORS[410],
  BOOK_SOURCE_TOO_LARGE: ERRORS[413],
  BOOK_SOURCE_UNSUPPORTED: ERRORS[415],
  BOOK_SOURCE_UNREADABLE: ERRORS[422],
  BOOK_SOURCE_UNAVAILABLE: ERRORS[502],
  BOOK_SOURCE_TIMEOUT: ERRORS[504],
};
type SourceIdentity = Pick<BookWebResearchSource, "id" | "url">;

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
function webUrl(value: unknown): value is string {
  if (!text(value, 4096) || /[\u0000-\u0020\u007f\\]/u.test(value) || !/^https?:\/\//i.test(value)) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password;
  } catch { return false; }
}
function sourceIdentityValid(value: unknown): value is SourceIdentity {
  return record(value) && typeof value.id === "string" && /^W(?:[1-9]|1[0-2])$/.test(value.id) && webUrl(value.url);
}

/** Bind extracted text to the current book and exact search source before showing or copying it. */
export function assertBookWebSourceReadResponse(value: unknown, bookId: string, source: SourceIdentity): asserts value is BookWebSourceReadResponse {
  if (!bookIdValid(bookId) || !sourceIdentityValid(source) || !record(value)
    || value.bookId !== bookId || value.sourceId !== source.id || value.requestedUrl !== source.url
    || !webUrl(value.finalUrl) || !text(value.title, 300) || !text(value.text, 30000)
    || typeof value.truncated !== "boolean" || !text(value.fetchedAt, 40)
    || !/^\d{4}-\d\d-\d\dT/.test(value.fetchedAt) || !Number.isFinite(Date.parse(value.fetchedAt))
    || !((value.contentType === "text/html" || value.contentType === "application/xhtml+xml") && value.extraction === "html_readable_text"
      || value.contentType === "text/plain" && value.extraction === "plain_text")) {
    throw new BookWebSourceReadError(502, ERRORS[502]);
  }
}
function requireCurrent(generation: number, signal?: AbortSignal): void {
  if (signal?.aborted || getWebAuthAuthGeneration() !== generation || getWebAuthSnapshot().status !== "authenticated") {
    throw new DOMException("Request no longer current", "AbortError");
  }
}
export function bookWebSourceReadErrorMessage(error: unknown): string {
  return error instanceof BookWebSourceReadError ? error.message : ERRORS[502];
}

/** Only the server-issued source token is sent; no arbitrary URL or personal content is submitted. */
export async function readBookWebSource(bookId: string, source: BookWebResearchSource, signal?: AbortSignal): Promise<BookWebSourceReadResponse> {
  if (!bookIdValid(bookId) || !sourceIdentityValid(source) || typeof source.readToken !== "string"
    || !/^[A-Za-z0-9_-]{32}$/.test(source.readToken)) throw new BookWebSourceReadError(400, ERRORS[400]);
  const session = getWebAuthSnapshot(), generation = getWebAuthAuthGeneration();
  if (session.status !== "authenticated") throw new BookWebSourceReadError(401, ERRORS[401]);
  if (!session.csrfToken) throw new BookWebSourceReadError(403, ERRORS[403]);
  requireCurrent(generation, signal);
  let response: Response;
  try {
    response = await fetch(`${API_BASE}/ai/books/${encodeURIComponent(bookId)}/research/source`, {
      method: "POST", credentials: "same-origin", cache: "no-store", signal,
      headers: { "content-type": "application/json", "x-csrf-token": session.csrfToken },
      body: JSON.stringify({ sourceToken: source.readToken }),
    });
  } catch {
    requireCurrent(generation, signal);
    throw new BookWebSourceReadError(502, ERRORS[502]);
  }
  requireCurrent(generation, signal);
  const result: unknown = await response.json().catch(() => null);
  requireCurrent(generation, signal);
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) void ensureAuthSessionLoaded();
    const code = record(result) && record(result.error) && typeof result.error.code === "string"
      && Object.hasOwn(CODE_MESSAGES, result.error.code) ? result.error.code : undefined;
    const message = response.status === 401 || response.status === 403 ? ERRORS[response.status]
      : code ? CODE_MESSAGES[code] : ERRORS[response.status] ?? ERRORS[502];
    throw new BookWebSourceReadError(response.status, message, code);
  }
  assertBookWebSourceReadResponse(result, bookId, source);
  return result;
}

function oneLine(value: string): string { return value.replace(/\s+/g, " ").replace(/[\\`*_\[\]<>]/g, "\\$&"); }

/** Copies extracted webpage text separately from the original search snapshot. */
export function bookWebSourceContent(result: BookWebSourceReadResponse, source: SourceIdentity): string {
  assertBookWebSourceReadResponse(result, result.bookId, source);
  return `# 网页可读文字（自动提取）\n\n[${result.sourceId}] ${oneLine(result.title)}\n来源：${result.requestedUrl}\n${result.finalUrl !== result.requestedUrl ? `最终网页：${result.finalUrl}\n` : ""}读取时间：${result.fetchedAt}\n\n自动提取的网页文字可能不完整，不代表已读取原书。${result.truncated ? "本次提取已截短。" : ""}\n\n${result.text}`;
}
