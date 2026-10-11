import {
  ensureAuthSessionLoaded,
  getWebAuthAuthGeneration,
  getWebAuthSnapshot,
} from "./auth/session";
import { clearWereadStatusCache, isValidWereadCatalogId } from "./wereadPrivate";

export type WereadBindingStatus = "all" | "matched" | "unmatched" | "manual";
export type WereadBindingOrigin = "imported" | "manual" | "unlinked" | "none";

export interface WereadBindingCatalog {
  id: string;
  title: string;
  author: string;
  publisher: string;
  year: number | null;
  isbn: string | null;
  available: boolean;
}

export interface WereadBindingItem {
  sourceKey: string;
  title: string;
  author: string;
  isbn: string | null;
  notesCount: number;
  effectiveCatalog: WereadBindingCatalog | null;
  importedCatalogId: string | null;
  origin: WereadBindingOrigin;
  revision: number;
  updatedAt: string | null;
}

export interface WereadBindingsQuery {
  q?: string;
  status?: WereadBindingStatus;
  catalogId?: string;
  limit?: number;
  offset?: number;
}

export interface WereadBindingsResponse {
  ok: true;
  items: WereadBindingItem[];
  pageInfo: { limit: number; offset: number; total: number; hasMore: boolean };
  writable: boolean;
}

export type WereadBindingMutation =
  | { action: "bind"; catalogId: string; expectedRevision: number }
  | { action: "unbind" | "restore"; expectedRevision: number; catalogId?: never };

export interface WereadBindingCatalogResults {
  items: WereadBindingCatalog[];
  total: number;
  page: number;
  limit: number;
}

export interface WereadBindingRequestOptions { signal?: AbortSignal }

export class WereadBindingError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "WereadBindingError";
  }
}

const API_BASE = import.meta.env.VITE_API_BASE_URL || "/api";
const ROOT = "/private/weread/bindings";
const STATUSES: WereadBindingStatus[] = ["all", "matched", "unmatched", "manual"];
const ORIGINS: WereadBindingOrigin[] = ["imported", "manual", "unlinked", "none"];
const errors: Record<number, string> = {
  400: "请检查书籍、筛选条件和关联操作后重试。",
  401: "登录已失效，请使用 Google 登录后继续。",
  403: "当前登录暂不可用，请刷新登录状态后重试。",
  404: "这本来源书或目录书暂时找不到，请读取最新内容后再试。",
  409: "关联已在其他页面发生变化。已保留你的候选，请读取最新关联并核对后再确认。",
  413: "填写的内容过长，请缩短后重试。",
  503: "书籍关联服务暂不可用，请稍后重试。",
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function count(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}
function nullableText(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}
function catalogId(value: unknown): value is string {
  return isValidWereadCatalogId(value) && typeof value === "string" && value === value.trim();
}
function sourceKey(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
function invalid(message = errors[400]): never { throw new WereadBindingError(400, message); }
function parseQuery(value: unknown, allowEmpty: boolean): string {
  if (typeof value !== "string" || value.trim().length > 200 || (!allowEmpty && !value.trim())) {
    invalid("请输入不超过 200 字的书名、作者或 ISBN。");
  }
  return value.trim();
}
function positive(value: unknown, max: number): value is number {
  return count(value) && value > 0 && value <= max;
}
function isCatalog(value: unknown): value is WereadBindingCatalog {
  return record(value) && catalogId(value.id)
    && [value.title, value.author, value.publisher].every(v => typeof v === "string")
    && (value.year === null || (typeof value.year === "number" && Number.isFinite(value.year)))
    && nullableText(value.isbn) && typeof value.available === "boolean";
}
function isItem(value: unknown): value is WereadBindingItem {
  if (!record(value) || !sourceKey(value.sourceKey)
    || typeof value.title !== "string" || typeof value.author !== "string"
    || !nullableText(value.isbn) || !count(value.notesCount) || !count(value.revision)
    || !(value.effectiveCatalog === null || isCatalog(value.effectiveCatalog))
    || !(value.importedCatalogId === null || catalogId(value.importedCatalogId))
    || !ORIGINS.includes(value.origin as WereadBindingOrigin)
    || !(value.updatedAt === null || (typeof value.updatedAt === "string" && Number.isFinite(Date.parse(value.updatedAt))))) return false;
  if ((value.revision === 0) !== (value.updatedAt === null)) return false;
  if (value.origin === "manual") return value.revision > 0 && value.effectiveCatalog !== null;
  if (value.origin === "unlinked") return value.revision > 0 && value.effectiveCatalog === null;
  if (value.origin === "none") return value.effectiveCatalog === null && value.importedCatalogId === null;
  return value.effectiveCatalog !== null && value.effectiveCatalog.id === value.importedCatalogId;
}

function requireCurrent(generation: number, signal?: AbortSignal): void {
  if (signal?.aborted || generation !== getWebAuthAuthGeneration() || getWebAuthSnapshot().status !== "authenticated") {
    throw new DOMException("Request no longer current", "AbortError");
  }
}

async function request<T>(path: string, options: WereadBindingRequestOptions & {
  method?: "GET" | "PUT";
  body?: WereadBindingMutation;
}, valid: (value: unknown) => value is T): Promise<T> {
  const { signal, method = "GET", body } = options;
  const session = getWebAuthSnapshot();
  const generation = getWebAuthAuthGeneration();
  if (session.status !== "authenticated") throw new WereadBindingError(401, "请先使用 Google 登录。");
  if (method !== "GET" && !session.csrfToken) throw new WereadBindingError(403, errors[403]);
  requireCurrent(generation, signal);
  if (method !== "GET") clearWereadStatusCache();
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method, signal, credentials: "same-origin", cache: "no-store",
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(method !== "GET" ? { "x-csrf-token": session.csrfToken! } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (error) {
    // Aborting a browser request cannot undo a write already accepted by the
    // server. Discard cached badges even when the outcome is not acknowledged.
    if (method !== "GET") clearWereadStatusCache();
    requireCurrent(generation, signal);
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new WereadBindingError(0, "暂时无法连接书籍服务，请重试。");
  }
  // A successful write may already be committed even if its response body is
  // truncated or the editor has since been closed. Invalidate before checking
  // the request's current UI scope or parsing its acknowledgement.
  if (method !== "GET" && response.ok) clearWereadStatusCache();
  requireCurrent(generation, signal);
  const data: unknown = await response.json().catch(() => null);
  requireCurrent(generation, signal);
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      clearWereadStatusCache();
      void ensureAuthSessionLoaded();
    }
    throw new WereadBindingError(response.status, errors[response.status] ?? "未能完成操作，请稍后重试。");
  }
  if (!valid(data)) throw new WereadBindingError(502, "书籍关联返回异常，请读取最新内容后再试。");
  return data;
}

export function listWereadBindings(query: WereadBindingsQuery = {}, options: WereadBindingRequestOptions = {}): Promise<WereadBindingsResponse> {
  if (!record(query)) return Promise.reject(new WereadBindingError(400, errors[400]));
  return Promise.resolve().then(() => {
    const q = parseQuery(query.q ?? "", true);
    const status = query.status ?? "all";
    const limit = query.limit ?? 20;
    const offset = query.offset ?? 0;
    if (typeof status !== "string" || !STATUSES.includes(status as WereadBindingStatus)
      || !positive(limit, 100) || !count(offset) || offset > 1_000_000) invalid();
    const params = new URLSearchParams({ status, limit: String(limit), offset: String(offset) });
    if (q) params.set("q", q);
    let scopedId: string | undefined;
    if (Object.prototype.hasOwnProperty.call(query, "catalogId")) {
      if (typeof query.catalogId !== "string" || !isValidWereadCatalogId(query.catalogId)) invalid("书目编号格式不正确。");
      scopedId = query.catalogId.trim();
      params.set("catalogId", scopedId);
    }
    return request(`${ROOT}?${params}`, options, (data): data is WereadBindingsResponse => {
      if (!record(data) || data.ok !== true || typeof data.writable !== "boolean"
        || !Array.isArray(data.items) || !data.items.every(isItem) || data.items.length > limit
        || !record(data.pageInfo) || data.pageInfo.limit !== limit || data.pageInfo.offset !== offset
        || !count(data.pageInfo.total) || typeof data.pageInfo.hasMore !== "boolean") return false;
      if (new Set(data.items.map(item => item.sourceKey)).size !== data.items.length) return false;
      return data.items.every(item => (!scopedId || item.effectiveCatalog?.id === scopedId)
        && (status !== "matched" || item.effectiveCatalog !== null)
        && (status !== "unmatched" || item.effectiveCatalog === null)
        && (status !== "manual" || item.origin === "manual" || item.origin === "unlinked"));
    });
  });
}

export function getWereadBinding(key: string, options: WereadBindingRequestOptions = {}): Promise<WereadBindingItem> {
  if (!sourceKey(key)) return Promise.reject(new WereadBindingError(400, "来源书标识无效，请重新打开关联管理。"));
  return request(`${ROOT}/${key}`, options,
    (data): data is { ok: true; item: WereadBindingItem; writable: boolean } => record(data)
      && data.ok === true && typeof data.writable === "boolean" && isItem(data.item) && data.item.sourceKey === key)
    .then(data => data.item);
}

export function updateWereadBinding(key: string, input: WereadBindingMutation, options: WereadBindingRequestOptions = {}): Promise<WereadBindingItem> {
  return Promise.resolve().then(() => {
    if (!sourceKey(key) || !record(input) || !["bind", "unbind", "restore"].includes(input.action)
      || !count(input.expectedRevision)
      || Object.keys(input).some(k => !["action", "expectedRevision", "catalogId"].includes(k))) invalid();
    let body: WereadBindingMutation;
    if (input.action === "bind") {
      if (!isValidWereadCatalogId(input.catalogId)) invalid("请选择有效的目录书籍。");
      body = { action: "bind", expectedRevision: input.expectedRevision, catalogId: input.catalogId.trim() };
    } else {
      if (Object.prototype.hasOwnProperty.call(input, "catalogId")) invalid();
      body = { action: input.action, expectedRevision: input.expectedRevision };
    }
    return request(`${ROOT}/${key}`, { ...options, method: "PUT", body },
      (data): data is { ok: true; item: WereadBindingItem; writable: true } => {
        if (!record(data) || data.ok !== true || data.writable !== true || !isItem(data.item)
          || data.item.sourceKey !== key || data.item.revision <= body.expectedRevision) return false;
        if (body.action === "bind") return data.item.origin === "manual" && data.item.effectiveCatalog?.id === body.catalogId;
        if (body.action === "unbind") return data.item.origin === "unlinked" && data.item.effectiveCatalog === null;
        return data.item.origin === "imported" || data.item.origin === "none";
      }).then(data => data.item);
  });
}

/** Catalog search stays public globally; this management action is session-bound. */
export function searchWereadBindingCatalog(q: string, page = 1, limit = 10, options: WereadBindingRequestOptions = {}): Promise<WereadBindingCatalogResults> {
  return Promise.resolve().then(async () => {
    const normalized = parseQuery(q, false);
    if (!positive(page, 100_000) || !positive(limit, 100)) invalid();
    const params = new URLSearchParams({ q: normalized, page: String(page), limit: String(limit) });
    const data = await request(`/search?${params}`, options,
      (value): value is { items: Array<{ id: string; title: string; author: string; publisher: string; year: number | null; isbn: string | null }>; total: number; page: number; limit: number } => {
        return record(value) && count(value.total) && value.page === page && value.limit === limit
          && Array.isArray(value.items) && value.items.length <= limit && value.items.every(item => record(item)
            && catalogId(item.id) && [item.title, item.author, item.publisher].every(v => typeof v === "string")
            && nullableText(item.isbn) && (item.year === null || (typeof item.year === "number" && Number.isFinite(item.year))));
      });
    return {
      items: data.items.map(item => ({ id: item.id, title: item.title, author: item.author,
        publisher: item.publisher, year: item.year, isbn: item.isbn, available: true })),
      total: data.total, page: data.page, limit: data.limit,
    };
  });
}
