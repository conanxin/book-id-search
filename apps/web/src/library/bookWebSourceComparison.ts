import { ensureAuthSessionLoaded, getWebAuthAuthGeneration, getWebAuthSnapshot } from "../auth/session";
import type { BookWebResearchSource } from "./bookWebResearch";
import { assertBookWebSourceReadResponse, type BookWebSourceReadResponse } from "./bookWebSourceReader";
import { assertBookWebSourceEvidenceResponse, type BookWebSourceEvidenceResponse } from "./bookWebSourceEvidence";

export interface BookWebSourceComparisonSelection {
  source: BookWebResearchSource;
  snapshot: BookWebSourceReadResponse;
}
export interface BookWebSourceComparisonResponse {
  bookId: string;
  question: string;
  mode: "source_comparison";
  sources: BookWebSourceEvidenceResponse[];
  generatedAt: string;
}
export class BookWebSourceComparisonError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message); this.name = "BookWebSourceComparisonError";
  }
}

const API_BASE = import.meta.env.VITE_API_BASE_URL || "/api";
const INVALID_INPUT = "请选择 2–3 篇不同的已读网页，并填写最多 1,000 字符的问题。";
const INVALID_OUTPUT = "返回的原文依据与所选网页不一致，请重新查找。";
const TEXT_LIMIT = "所选网页文字合计超过 60,000 字符，请减少来源后再试。";
const ERRORS: Record<number, string> = {
  400: INVALID_INPUT,
  401: "登录已失效，请使用 Google 登录后继续。",
  403: "当前登录暂不可用，请刷新登录状态后重试。",
  410: "至少一篇所选网页的读取已过期，请重新读取所选来源后再试。已读文字仍保留。",
  429: "查找请求较多，请稍后重试。",
  502: "暂时无法查找多来源原文依据，已读网页文字仍保留，可稍后重试。",
  503: "多来源原文依据暂不可用，已读网页文字仍保留。",
  504: "本次多来源原文查找超时，已读网页文字仍保留，可重试。",
};
const CODE_MESSAGES: Record<string, string> = {
  BOOK_COMPARISON_INVALID_INPUT: INVALID_INPUT,
  BOOK_COMPARISON_TEXT_LIMIT: TEXT_LIMIT,
  BOOK_COMPARISON_EXPIRED: ERRORS[410],
  BOOK_COMPARISON_INVALID_OUTPUT: INVALID_OUTPUT,
  BOOK_COMPARISON_UNAVAILABLE: ERRORS[503],
  BOOK_COMPARISON_TIMEOUT: ERRORS[504],
};
const RESPONSE_KEYS = ["bookId", "question", "mode", "sources", "generatedAt"];
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
function failInput(code = "BOOK_COMPARISON_INVALID_INPUT"): never {
  throw new BookWebSourceComparisonError(400, CODE_MESSAGES[code], code);
}
function failOutput(): never {
  throw new BookWebSourceComparisonError(502, INVALID_OUTPUT, "BOOK_COMPARISON_INVALID_OUTPUT");
}
/** Same normalization as the API: remove the fragment, preserving path and query semantics. */
export function bookWebSourceComparisonUrl(url: string): string {
  const parsed = new URL(url); parsed.hash = ""; return parsed.href;
}
export function assertBookWebSourceComparisonInput(
  bookId: string, selections: readonly BookWebSourceComparisonSelection[], question: string,
): void {
  if (!Array.isArray(selections) || selections.length < 2 || selections.length > 3
    || !validText(question, 1000) || question !== question.trim()) failInput();
  const tokens = new Set<string>(), ids = new Set<string>(), urls = new Set<string>();
  let characters = 0;
  for (const entry of selections) {
    if (!record(entry) || !record(entry.snapshot) || !record(entry.source)
      || typeof entry.source.id !== "string" || typeof entry.source.url !== "string") failInput();
    const source = { id: entry.source.id, url: entry.source.url };
    try { assertBookWebSourceReadResponse(entry.snapshot, bookId, source); } catch { failInput(); }
    const snapshot = entry.snapshot;
    if (typeof snapshot.snapshotToken !== "string" || !/^[A-Za-z0-9_-]{32}$/.test(snapshot.snapshotToken)) failInput();
    let url: string;
    try { url = bookWebSourceComparisonUrl(snapshot.finalUrl); } catch { failInput(); }
    if (tokens.has(snapshot.snapshotToken) || ids.has(source.id) || urls.has(url)) failInput();
    tokens.add(snapshot.snapshotToken); ids.add(source.id); urls.add(url);
    characters += snapshot.text.length;
  }
  if (characters > 60000) failInput("BOOK_COMPARISON_TEXT_LIMIT");
}

/** Every source must remain bound to the exact current snapshot, in the user's selected order. */
export function assertBookWebSourceComparisonResponse(
  value: unknown, bookId: string, selections: readonly BookWebSourceComparisonSelection[], question: string,
): asserts value is BookWebSourceComparisonResponse {
  try { assertBookWebSourceComparisonInput(bookId, selections, question); } catch { failOutput(); }
  if (!record(value) || Object.keys(value).some(key => !RESPONSE_KEYS.includes(key))
    || value.bookId !== bookId || value.question !== question || value.mode !== "source_comparison"
    || !validText(value.generatedAt, 40) || !/^\d{4}-\d\d-\d\dT/.test(value.generatedAt)
    || !Number.isFinite(Date.parse(value.generatedAt))
    || !Array.isArray(value.sources) || value.sources.length !== selections.length) failOutput();
  for (const [index, entry] of selections.entries()) {
    const sourceResult: unknown = value.sources[index];
    try { assertBookWebSourceEvidenceResponse(sourceResult, entry.snapshot, entry.source, question); }
    catch { failOutput(); }
    if (sourceResult.passages.length > 2 || sourceResult.generatedAt !== value.generatedAt) failOutput();
  }
}
function requireCurrent(generation: number, signal?: AbortSignal): void {
  if (signal?.aborted || getWebAuthAuthGeneration() !== generation || getWebAuthSnapshot().status !== "authenticated") {
    throw new DOMException("Request no longer current", "AbortError");
  }
}
export function bookWebSourceComparisonErrorMessage(error: unknown): string {
  return error instanceof BookWebSourceComparisonError ? error.message : ERRORS[502];
}

/** One request contains only snapshot tokens and the explicit question, never browser-supplied text. */
export async function findBookWebSourceComparison(
  bookId: string, selections: readonly BookWebSourceComparisonSelection[], question: string, signal?: AbortSignal,
): Promise<BookWebSourceComparisonResponse> {
  const asked = typeof question === "string" ? question.trim() : "";
  assertBookWebSourceComparisonInput(bookId, selections, asked);
  const session = getWebAuthSnapshot(), generation = getWebAuthAuthGeneration();
  if (session.status !== "authenticated") throw new BookWebSourceComparisonError(401, ERRORS[401]);
  if (!session.csrfToken) throw new BookWebSourceComparisonError(403, ERRORS[403]);
  requireCurrent(generation, signal);
  let response: Response;
  try {
    response = await fetch(API_BASE + "/ai/books/" + encodeURIComponent(bookId) + "/research/sources/evidence", {
      method: "POST", credentials: "same-origin", cache: "no-store", signal,
      headers: { "content-type": "application/json", "x-csrf-token": session.csrfToken },
      body: JSON.stringify({ snapshotTokens: selections.map(entry => entry.snapshot.snapshotToken), question: asked }),
    });
  } catch {
    requireCurrent(generation, signal);
    throw new BookWebSourceComparisonError(502, ERRORS[502]);
  }
  requireCurrent(generation, signal);
  const value: unknown = await response.json().catch(() => null);
  requireCurrent(generation, signal);
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) void ensureAuthSessionLoaded();
    const code = record(value) && record(value.error) && typeof value.error.code === "string"
      && Object.hasOwn(CODE_MESSAGES, value.error.code) ? value.error.code : undefined;
    const message = response.status === 401 || response.status === 403 ? ERRORS[response.status]
      : code ? CODE_MESSAGES[code] : ERRORS[response.status] ?? ERRORS[502];
    throw new BookWebSourceComparisonError(response.status, message, code);
  }
  assertBookWebSourceComparisonResponse(value, bookId, selections, asked);
  return value;
}
function oneLine(value: string): string { return value.replace(/\s+/g, " ").replace(/[\\\x60*_\[\]<>]/g, "\\$&"); }

export function bookWebSourceComparisonContent(
  value: BookWebSourceComparisonResponse, bookId: string, selections: readonly BookWebSourceComparisonSelection[],
): string {
  assertBookWebSourceComparisonResponse(value, bookId, selections, value.question);
  const lines = ["# 多来源原文依据", "", "问题：" + oneLine(value.question), "选段时间：" + value.generatedAt, "",
    "以下分源文字逐字来自本次已读网页，供核对不同来源各自的说法；不构成共同结论或独立证据判定。",
    "片段编号仅用于本次提取文字定位，不是原书页码。"];
  for (const source of value.sources) {
    lines.push("", "## [" + source.sourceId + "] " + oneLine(source.title), "来源：" + source.requestedUrl);
    if (source.finalUrl !== source.requestedUrl) lines.push("最终网页：" + source.finalUrl);
    lines.push("网页读取时间：" + source.fetchedAt);
    if (source.sourceTruncated) lines.push("本次网页提取已截短，片段只覆盖已读取的部分。");
    if (source.status === "insufficient_evidence") lines.push("", "本次未选出足够相关的原文，可调整问题或查看该网页。");
    else for (const passage of source.passages) lines.push("", "### [" + source.sourceId + " / " + passage.id + "]", "", passage.text);
  }
  return lines.join("\n");
}
