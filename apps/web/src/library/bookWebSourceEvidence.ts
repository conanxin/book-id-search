import { ensureAuthSessionLoaded, getWebAuthAuthGeneration, getWebAuthSnapshot } from "../auth/session";
import type { BookWebResearchSource } from "./bookWebResearch";
import { assertBookWebSourceReadResponse, type BookWebSourceReadResponse } from "./bookWebSourceReader";

export interface BookWebSourcePassage { id: string; start: number; end: number; text: string }
export interface BookWebSourceEvidenceResponse {
  bookId: string; sourceId: string; snapshotToken: string; question: string;
  mode: "source_passages"; status: "selected" | "insufficient_evidence";
  requestedUrl: string; finalUrl: string; title: string; fetchedAt: string;
  sourceTruncated: boolean; passages: BookWebSourcePassage[]; generatedAt: string;
}

export class BookWebSourceEvidenceError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message); this.name = "BookWebSourceEvidenceError";
  }
}

const API_BASE = import.meta.env.VITE_API_BASE_URL || "/api";
const INVALID_OUTPUT = "返回的片段与当前网页不一致，请重新查找原文依据。";
const ERRORS: Record<number, string> = {
  400: "请填写要核对的问题，最多 1,000 字符，并重新读取网页后再试。",
  401: "登录已失效，请使用 Google 登录后继续。",
  403: "当前登录暂不可用，请刷新登录状态后重试。",
  410: "本次已读网页已过期，请重新读取网页正文后再查找原文依据。",
  429: "查找请求较多，请稍后重试。",
  502: "暂时无法查找原文依据，已读网页文字仍保留，可稍后重试。",
  503: "原文依据查找暂不可用，已读网页文字仍保留。",
  504: "本次查找原文依据超时，已读网页文字仍保留，可重试。",
};
const CODE_MESSAGES: Record<string, string> = {
  BOOK_EVIDENCE_INVALID_INPUT: ERRORS[400],
  BOOK_EVIDENCE_EXPIRED: ERRORS[410],
  BOOK_EVIDENCE_INVALID_OUTPUT: INVALID_OUTPUT,
  BOOK_EVIDENCE_UNAVAILABLE: ERRORS[502],
  BOOK_EVIDENCE_TIMEOUT: ERRORS[504],
};
type SourceIdentity = Pick<BookWebResearchSource, "id" | "url">;
const RESPONSE_KEYS = ["bookId", "sourceId", "snapshotToken", "question", "mode", "status", "requestedUrl", "finalUrl",
  "title", "fetchedAt", "sourceTruncated", "passages", "generatedAt"];
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function validText(value: unknown, max: number): value is string {
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
function validToken(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9_-]{32}$/.test(value); }
function safeBoundary(text: string, index: number): boolean {
  const code = text.charCodeAt(index);
  return !(code >= 0xdc00 && code <= 0xdfff);
}
function validTime(value: unknown): value is string {
  return validText(value, 40) && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value));
}
function fail(): never { throw new BookWebSourceEvidenceError(502, INVALID_OUTPUT, "BOOK_EVIDENCE_INVALID_OUTPUT"); }

/** The browser accepts only exact slices of the immutable text it is currently displaying. */
export function assertBookWebSourceEvidenceResponse(
  value: unknown, snapshot: BookWebSourceReadResponse, source: SourceIdentity, question: string,
): asserts value is BookWebSourceEvidenceResponse {
  try { assertBookWebSourceReadResponse(snapshot, snapshot.bookId, source); } catch { fail(); }
  if (!validToken(snapshot.snapshotToken) || !validText(question, 1000) || question !== question.trim()
    || !record(value) || Object.keys(value).some(key => !RESPONSE_KEYS.includes(key))
    || value.bookId !== snapshot.bookId || value.sourceId !== source.id || value.snapshotToken !== snapshot.snapshotToken
    || value.question !== question || value.mode !== "source_passages"
    || value.requestedUrl !== snapshot.requestedUrl || value.finalUrl !== snapshot.finalUrl
    || value.title !== snapshot.title || value.fetchedAt !== snapshot.fetchedAt
    || value.sourceTruncated !== snapshot.truncated || !validTime(value.generatedAt)
    || !Array.isArray(value.passages) || value.passages.length > 4
    || !(value.status === "selected" && value.passages.length > 0
      || value.status === "insufficient_evidence" && value.passages.length === 0)) fail();
  let previousEnd = 0, previousId = 0;
  for (const item of value.passages) {
    if (!record(item) || Object.keys(item).some(key => !["id", "start", "end", "text"].includes(key))
      || typeof item.id !== "string" || !/^P(?:[1-9]|[1-5][0-9]|6[0-4])$/.test(item.id)
      || typeof item.start !== "number" || typeof item.end !== "number"
      || !Number.isSafeInteger(item.start) || !Number.isSafeInteger(item.end)
      || item.start < previousEnd || item.start < 0 || item.end <= item.start || item.end > snapshot.text.length
      || !safeBoundary(snapshot.text, item.start) || !safeBoundary(snapshot.text, item.end)
      || !validText(item.text, 1200) || item.text !== snapshot.text.slice(item.start, item.end)) fail();
    const id = Number(item.id.slice(1));
    if (id <= previousId) fail();
    previousId = id; previousEnd = item.end;
  }
}
function requireCurrent(generation: number, signal?: AbortSignal): void {
  if (signal?.aborted || getWebAuthAuthGeneration() !== generation || getWebAuthSnapshot().status !== "authenticated") {
    throw new DOMException("Request no longer current", "AbortError");
  }
}
export function bookWebSourceEvidenceErrorMessage(error: unknown): string {
  return error instanceof BookWebSourceEvidenceError ? error.message : ERRORS[502];
}

/** No URL, webpage text, personal introduction or note is sent from the browser. */
export async function findBookWebSourceEvidence(
  snapshot: BookWebSourceReadResponse, source: SourceIdentity, question: string, signal?: AbortSignal,
): Promise<BookWebSourceEvidenceResponse> {
  const asked = typeof question === "string" ? question.trim() : "";
  try { assertBookWebSourceReadResponse(snapshot, snapshot.bookId, source); }
  catch { throw new BookWebSourceEvidenceError(400, ERRORS[400]); }
  if (!validToken(snapshot.snapshotToken) || !validText(asked, 1000)) throw new BookWebSourceEvidenceError(400, ERRORS[400]);
  const session = getWebAuthSnapshot(), generation = getWebAuthAuthGeneration();
  if (session.status !== "authenticated") throw new BookWebSourceEvidenceError(401, ERRORS[401]);
  if (!session.csrfToken) throw new BookWebSourceEvidenceError(403, ERRORS[403]);
  requireCurrent(generation, signal);
  let response: Response;
  try {
    response = await fetch(API_BASE + "/ai/books/" + encodeURIComponent(snapshot.bookId) + "/research/source/evidence", {
      method: "POST", credentials: "same-origin", cache: "no-store", signal,
      headers: { "content-type": "application/json", "x-csrf-token": session.csrfToken },
      body: JSON.stringify({ snapshotToken: snapshot.snapshotToken, question: asked }),
    });
  } catch {
    requireCurrent(generation, signal);
    throw new BookWebSourceEvidenceError(502, ERRORS[502]);
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
    throw new BookWebSourceEvidenceError(response.status, message, code);
  }
  assertBookWebSourceEvidenceResponse(result, snapshot, source, asked);
  return result;
}
function oneLine(value: string): string { return value.replace(/\s+/g, " ").replace(/[\\\x60*_\[\]<>]/g, "\\$&"); }

/** Original excerpts and source metadata only; the capability token is never copied. */
export function bookWebSourceEvidenceContent(
  result: BookWebSourceEvidenceResponse, snapshot: BookWebSourceReadResponse, source: SourceIdentity,
): string {
  assertBookWebSourceEvidenceResponse(result, snapshot, source, result.question);
  const lines = ["# AI 选中的原文片段", "", "问题：" + oneLine(result.question), "",
    "[" + result.sourceId + "] " + oneLine(result.title), "来源：" + result.requestedUrl];
  if (result.finalUrl !== result.requestedUrl) lines.push("最终网页：" + result.finalUrl);
  lines.push("网页读取时间：" + result.fetchedAt, "选段时间：" + result.generatedAt, "",
    "以下为已读网页中的原文片段；片段编号仅用于本次提取文字定位，不是原书页码。");
  if (result.sourceTruncated) lines.push("本次网页提取已截短，片段只覆盖已读取的部分。");
  if (result.status === "insufficient_evidence") lines.push("", "未找到足够相关的原文，请调整问题或查看网页。");
  else for (const passage of result.passages) lines.push("", "## [" + result.sourceId + " / " + passage.id + "]", "", passage.text);
  return lines.join("\n");
}
