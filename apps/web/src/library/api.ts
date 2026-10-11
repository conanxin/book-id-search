import {
  ensureAuthSessionLoaded,
  getWebAuthAuthGeneration,
  getWebAuthSnapshot,
} from "../auth/session";

export interface BookNoteRevisionSummary {
  revisionId: string;
  revisionNo: number;
  createdAt: string;
}

export interface BookNoteRevision extends BookNoteRevisionSummary {
  title: string;
  content: string;
}

export interface BookNote {
  noteId: string;
  title: string;
  content: string;
  currentRevisionId: string;
  revisionNo: number;
  createdAt: string;
  updatedAt: string;
  revisions: BookNoteRevisionSummary[];
}

export interface BookResourceInput {
  label: string;
  url: string;
  format: string;
  versionLabel: string;
  notes: string;
}

export interface BookResource extends BookResourceInput {
  resourceId: string;
  createdAt: string;
  updatedAt: string;
}

export interface BookWorkspaceData {
  bookId: string;
  saved: boolean;
  editionId: string | null;
  introduction: string;
  version: number;
  updatedAt: string | null;
  notes: BookNote[];
  resources: BookResource[];
}

export type LibraryFilter = "all" | "introduction" | "notes" | "resources";

export type LibrarySearchMatch =
  | { kind: "introduction"; excerpt: string }
  | { kind: "note"; noteId: string; noteTitle: string; excerpt: string };

export interface LibraryItem {
  bookId: string;
  editionId: string;
  title: string;
  author: string | null;
  publisher: string | null;
  year: string | number | null;
  introductionExcerpt: string;
  noteCount: number;
  resourceCount: number;
  updatedAt: string;
  searchMatch?: LibrarySearchMatch | null;
}

export interface LibraryResult {
  items: LibraryItem[];
  total: number;
  page: number;
  limit: number;
}

export class LibraryApiError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
    this.name = "LibraryApiError";
  }
}

const ROOT = "/api/private/s32/library";
const statusMessages: Record<number, string> = {
  400: "请检查填写的内容后重试。",
  401: "登录已失效，请重新使用 Google 登录。",
  403: "当前登录暂不可用，请刷新登录状态后重试。",
  404: "这项内容暂时找不到，请重新读取后再试。",
  409: "内容已在其他页面发生变化。你的草稿已保留，请读取最新内容后再保存。",
  413: "填写的内容过长，请缩短后再保存。",
  422: "这本书的信息暂时无法保存，请稍后重试。",
  503: "书籍内容服务暂不可用，请稍后重试。",
};

export function isLibraryAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function libraryErrorMessage(error: unknown): string {
  return error instanceof LibraryApiError ? error.message : "暂时无法完成操作，请重试。你的草稿仍然保留。";
}

/** Both editors and rendered links use the same absolute HTTP(S) rule. */
export function safeResourceUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isString(value: unknown): value is string { return typeof value === "string"; }
function isId(value: unknown): value is string { return isString(value) && value.length > 0; }
function isNullableString(value: unknown): value is string | null { return value === null || isString(value); }
function isCount(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0; }
function isDate(value: unknown): value is string { return isString(value) && Number.isFinite(Date.parse(value)); }

function isRevisionSummary(value: unknown): value is BookNoteRevisionSummary {
  return isRecord(value) && isId(value.revisionId) && isCount(value.revisionNo)
    && value.revisionNo > 0 && isDate(value.createdAt);
}
function isRevision(value: unknown): value is BookNoteRevision {
  return isRecord(value) && isRevisionSummary(value) && isString(value.title) && isString(value.content);
}
function isNote(value: unknown): value is BookNote {
  return isRecord(value) && isId(value.noteId) && isString(value.title) && isString(value.content)
    && isId(value.currentRevisionId) && isCount(value.revisionNo) && value.revisionNo > 0
    && isDate(value.createdAt) && isDate(value.updatedAt) && Array.isArray(value.revisions)
    && value.revisions.every(isRevisionSummary);
}
function isResource(value: unknown): value is BookResource {
  return isRecord(value) && isId(value.resourceId)
    && [value.label, value.url, value.format, value.versionLabel, value.notes].every(isString)
    && isDate(value.createdAt) && isDate(value.updatedAt);
}
function isWorkspace(value: unknown, bookId: string): value is BookWorkspaceData {
  return isRecord(value) && value.bookId === bookId && typeof value.saved === "boolean"
    && isNullableString(value.editionId) && isString(value.introduction) && isCount(value.version)
    && (value.updatedAt === null || isDate(value.updatedAt))
    && Array.isArray(value.notes) && value.notes.every(isNote)
    && Array.isArray(value.resources) && value.resources.every(isResource);
}
function isLibrarySearchMatch(value: unknown): value is LibrarySearchMatch | null | undefined {
  if (value === undefined || value === null) return true;
  if (!isRecord(value) || !isString(value.excerpt) || Array.from(value.excerpt).length > 242) return false;
  return value.kind === "introduction"
    || (value.kind === "note" && isId(value.noteId) && isString(value.noteTitle));
}
function isLibraryItem(value: unknown): value is LibraryItem {
  return isRecord(value) && isId(value.bookId) && isId(value.editionId) && isString(value.title)
    && isNullableString(value.author) && isNullableString(value.publisher)
    && (value.year === null || isString(value.year) || typeof value.year === "number")
    && isString(value.introductionExcerpt) && isCount(value.noteCount) && isCount(value.resourceCount)
    && isDate(value.updatedAt) && isLibrarySearchMatch(value.searchMatch);
}
function isLibraryResult(value: unknown): value is LibraryResult {
  return isRecord(value) && Array.isArray(value.items) && value.items.every(isLibraryItem)
    && isCount(value.total) && isCount(value.page) && value.page > 0
    && isCount(value.limit) && value.limit > 0;
}

function sessionChanged(generation: number, signal?: AbortSignal): boolean {
  return signal?.aborted === true || generation !== getWebAuthAuthGeneration()
    || getWebAuthSnapshot().status !== "authenticated";
}

async function request<T>(path: string, options: {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  input?: unknown;
  signal?: AbortSignal;
}, valid: (value: unknown) => value is T): Promise<T> {
  const { method = "GET", input, signal } = options;
  const session = getWebAuthSnapshot();
  const generation = getWebAuthAuthGeneration();
  if (session.status !== "authenticated") throw new LibraryApiError(401, "请先使用 Google 登录。");
  if (method !== "GET" && !session.csrfToken) throw new LibraryApiError(403, statusMessages[403]);
  const response = await fetch(`${ROOT}${path}`, {
    method,
    credentials: "same-origin",
    cache: "no-store",
    signal,
    headers: {
      ...(input !== undefined ? { "content-type": "application/json" } : {}),
      ...(method !== "GET" ? { "x-csrf-token": session.csrfToken! } : {}),
    },
    ...(input !== undefined ? { body: JSON.stringify(input) } : {}),
  });
  if (sessionChanged(generation, signal)) throw new DOMException("Request no longer current", "AbortError");
  const body: unknown = await response.json().catch(() => null);
  if (sessionChanged(generation, signal)) throw new DOMException("Request no longer current", "AbortError");
  if (!response.ok) {
    const code = isRecord(body) && isRecord(body.error) && isString(body.error.code) ? body.error.code : undefined;
    if (response.status === 401 || response.status === 403) void ensureAuthSessionLoaded();
    // Use stable user-facing messages, never arbitrary database/provider details.
    throw new LibraryApiError(response.status, statusMessages[response.status] ?? "暂时无法完成操作，请稍后重试。", code);
  }
  if (!valid(body)) throw new LibraryApiError(502, "书籍内容返回异常，请重新读取后再试。");
  return body;
}

const bookPath = (bookId: string) => `/books/${encodeURIComponent(bookId)}`;
function workspaceRequest(bookId: string, suffix: string, options: Parameters<typeof request>[1]) {
  return request(`${bookPath(bookId)}${suffix}`, options,
    (body): body is { item: BookWorkspaceData } => isRecord(body) && isWorkspace(body.item, bookId))
    .then(body => body.item);
}

export function listLibrary(input: { page: number; limit?: number; q?: string; filter?: LibraryFilter }, signal?: AbortSignal) {
  const params = new URLSearchParams({ page: String(input.page), limit: String(input.limit ?? 24), filter: input.filter ?? "all" });
  if (input.q) params.set("q", input.q);
  return request(`/?${params}`, { signal }, isLibraryResult);
}
export const getBookWorkspace = (bookId: string, signal?: AbortSignal) => workspaceRequest(bookId, "", { signal });
export const saveBookWorkspace = (bookId: string, input: { introduction?: string; baseVersion?: number }, signal?: AbortSignal) =>
  workspaceRequest(bookId, "", { method: "PUT", input, signal });
export const createBookNote = (bookId: string, input: { title: string; content: string }, signal?: AbortSignal) =>
  workspaceRequest(bookId, "/notes", { method: "POST", input, signal });
export const updateBookNote = (bookId: string, noteId: string, input: { title: string; content: string; baseRevisionId: string }, signal?: AbortSignal) =>
  workspaceRequest(bookId, `/notes/${encodeURIComponent(noteId)}`, { method: "PUT", input, signal });
export const deleteBookNote = (bookId: string, noteId: string, signal?: AbortSignal) =>
  workspaceRequest(bookId, `/notes/${encodeURIComponent(noteId)}`, { method: "DELETE", signal });
export const getBookNoteRevision = (bookId: string, noteId: string, revisionId: string, signal?: AbortSignal) =>
  request(`${bookPath(bookId)}/notes/${encodeURIComponent(noteId)}/revisions/${encodeURIComponent(revisionId)}`, { signal },
    (body): body is { item: BookNoteRevision } => isRecord(body) && isRevision(body.item) && body.item.revisionId === revisionId)
    .then(body => body.item);
export const createBookResource = (bookId: string, input: BookResourceInput, signal?: AbortSignal) =>
  workspaceRequest(bookId, "/resources", { method: "POST", input, signal });
export const updateBookResource = (bookId: string, resourceId: string, input: BookResourceInput, signal?: AbortSignal) =>
  workspaceRequest(bookId, `/resources/${encodeURIComponent(resourceId)}`, { method: "PUT", input, signal });
export const deleteBookResource = (bookId: string, resourceId: string, signal?: AbortSignal) =>
  workspaceRequest(bookId, `/resources/${encodeURIComponent(resourceId)}`, { method: "DELETE", signal });
