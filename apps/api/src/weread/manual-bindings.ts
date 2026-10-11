import { createHash } from "node:crypto";
import { createMeiliCatalogBookReader } from "../s32/catalog/meili-catalog-book-reader.js";
import {
  clearWereadOverlayCache, getWereadConfirmedMatches, loadWereadOverlay,
  type ConfirmedMatch, type WereadOverlayData,
} from "./private-overlay.js";
import { createPrivateNotesData, type PrivateNotesData } from "./private-notes.js";
import {
  WereadBindingConflictError, type WereadBindingOverride, type WereadBindingStore, type WereadBindingWrite,
} from "./manual-bindings-store.js";

export type BindingOrigin = "imported" | "manual" | "unlinked" | "none";
export type BindingCatalog = {
  id: string; title: string; author: string; publisher: string;
  year: number | null; isbn: string | null; available: boolean;
};
export type WereadBindingItem = {
  sourceKey: string; title: string; author: string; isbn: string | null;
  notesCount: number; effectiveCatalog: BindingCatalog | null;
  importedCatalogId: string | null; origin: BindingOrigin;
  revision: number; updatedAt: string | null;
};

const errors = {
  WEREAD_BINDING_INVALID_INPUT: [400, "关联请求格式不正确，请检查输入。"],
  WEREAD_BINDING_SOURCE_NOT_FOUND: [404, "这条微信读书来源已不存在，请重新加载列表。"],
  WEREAD_BINDING_CATALOG_NOT_FOUND: [404, "所选书目已不存在，请重新选择。"],
  WEREAD_BINDING_CONFLICT: [409, "关联已被更新，请读取最新关联后再次确认。"],
  WEREAD_BINDING_UNAVAILABLE: [503, "微信读书关联服务暂不可用，请稍后重试。"],
} as const;
export class WereadBindingError extends Error {
  readonly status: number;
  constructor(readonly code: keyof typeof errors) {
    super(errors[code][1]);
    this.status = errors[code][0];
  }
}
const invalid = () => new WereadBindingError("WEREAD_BINDING_INVALID_INPUT");
const unavailable = () => new WereadBindingError("WEREAD_BINDING_UNAVAILABLE");
const asText = (value: unknown): string => typeof value === "string" ? value.trim() : "";
const sourceKeyFor = (id: string): string => createHash("sha256").update(id).digest("hex");
function catalogId(value: unknown): string {
  if (typeof value !== "string") throw invalid();
  const id = value.trim();
  if (id.length > 128 || !/^[0-9]+_[0-9]{12}$/.test(id)) throw invalid();
  return id;
}
function sourceKey(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw invalid();
  return value;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}
function integerQuery(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^\d+$/.test(value)) throw invalid();
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw invalid();
  return n;
}
function listQuery(raw: unknown) {
  const query = record(raw);
  if (query.q !== undefined && (typeof query.q !== "string" || query.q.trim().length > 200)) throw invalid();
  const status = query.status === undefined ? "all" : query.status;
  if (typeof status !== "string" || !["all", "matched", "unmatched", "manual"].includes(status)) throw invalid();
  return {
    q: asText(query.q).toLocaleLowerCase(), status,
    catalogId: Object.hasOwn(query, "catalogId") ? catalogId(query.catalogId) : undefined,
    limit: integerQuery(query.limit, 20, 1, 100), offset: integerQuery(query.offset, 0, 0, 1_000_000),
  };
}
function updateBody(raw: unknown): Omit<WereadBindingWrite, "wereadBookId"> {
  const body = record(raw);
  if (Object.keys(body).some(key => !["action", "catalogId", "expectedRevision"].includes(key))) throw invalid();
  if (body.action !== "bind" && body.action !== "unbind" && body.action !== "restore") throw invalid();
  if (typeof body.expectedRevision !== "number" || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0) throw invalid();
  if (body.action !== "bind" && Object.hasOwn(body, "catalogId")) throw invalid();
  return {
    mode: body.action === "restore" ? "inherit" as const : body.action,
    catalogId: body.action === "bind" ? catalogId(body.catalogId) : null,
    expectedRevision: body.expectedRevision,
  };
}

type BindingState = {
  imported: WereadOverlayData;
  importedBySource: Map<string, ConfirmedMatch>;
  overrides: Map<string, WereadBindingOverride>;
  sourcesByKey: Map<string, string>;
};
function effectiveMatch(state: BindingState, id: string): ConfirmedMatch | null {
  const override = state.overrides.get(id);
  if (override?.mode === "unbind") return null;
  if (override?.mode === "bind" && override.catalogId) {
    const [ssid, dxid] = override.catalogId.split("_");
    return {
      wereadBookId: id, catalogId: override.catalogId, ssid, dxid,
      isbn: asText(state.imported.books.get(id)?.isbn) || null,
      matchMethod: "manual", matchConfidence: "high", decisionSource: "manual",
    };
  }
  return state.importedBySource.get(id) ?? null;
}
function origin(state: BindingState, id: string): BindingOrigin {
  const mode = state.overrides.get(id)?.mode;
  if (mode === "bind") return "manual";
  if (mode === "unbind") return "unlinked";
  return state.importedBySource.has(id) ? "imported" : "none";
}
function overlayFrom(state: BindingState): WereadOverlayData {
  const confirmedMatches: ConfirmedMatch[] = [];
  for (const id of state.sourcesByKey.values()) {
    const match = effectiveMatch(state, id);
    if (match) confirmedMatches.push(match);
  }
  return {
    ...state.imported, confirmedMatches,
    confirmedByCatalogId: new Map(confirmedMatches.map(match => [match.catalogId, match])),
  };
}

export interface WereadBindingsService {
  readonly writable: boolean;
  loadOverlay(): Promise<WereadOverlayData>;
  loadNotes(): Promise<PrivateNotesData>;
  list(query?: unknown): Promise<{
    items: WereadBindingItem[];
    pageInfo: { limit: number; offset: number; total: number; hasMore: boolean };
    writable: boolean;
  }>;
  get(sourceKey: unknown): Promise<WereadBindingItem>;
  update(sourceKey: unknown, body: unknown): Promise<WereadBindingItem>;
}

export function createWereadBindingsService(deps: {
  dataDir: string; store: WereadBindingStore | null;
  getCatalogDocument: (id: string) => Promise<unknown>;
}): WereadBindingsService {
  const reader = createMeiliCatalogBookReader(deps.getCatalogDocument);
  async function state(): Promise<BindingState> {
    const imported = loadWereadOverlay(deps.dataDir);
    let rows: WereadBindingOverride[];
    try { rows = deps.store ? await deps.store.list() : []; }
    catch { throw unavailable(); } // A failed configured store must never restore imported links.
    const importedBySource = new Map(getWereadConfirmedMatches(imported).map(match => [match.wereadBookId, match]));
    const sources = new Set([...imported.books.keys(), ...imported.notesByBook.keys(), ...importedBySource.keys()]);
    return {
      imported, importedBySource,
      overrides: new Map(rows.map(row => [row.wereadBookId, row])),
      sourcesByKey: new Map(Array.from(sources, id => [sourceKeyFor(id), id])),
    };
  }
  function findSource(snapshot: BindingState, key: string): string {
    const id = snapshot.sourcesByKey.get(key);
    if (!id) throw new WereadBindingError("WEREAD_BINDING_SOURCE_NOT_FOUND");
    return id;
  }
  async function catalog(id: string, required = false): Promise<BindingCatalog> {
    try {
      const book = await reader.getById(id);
      if (!book) {
        if (required) throw new WereadBindingError("WEREAD_BINDING_CATALOG_NOT_FOUND");
      } else if (book.id === id) {
        return { id, title: book.title || "未命名书目", author: book.author,
          publisher: book.publisher, year: book.year, isbn: book.isbn || null, available: true };
      } else if (required) throw unavailable();
    } catch (error) {
      if (required) {
        if (error instanceof WereadBindingError) throw error;
        throw unavailable();
      }
    }
    // Metadata outage/removal does not change an existing binding's identity.
    return { id, title: "书目暂不可用", author: "", publisher: "", year: null, isbn: null, available: false };
  }
  async function item(snapshot: BindingState, id: string, getCatalog = (id: string) => catalog(id)): Promise<WereadBindingItem> {
    const book = snapshot.imported.books.get(id), override = snapshot.overrides.get(id);
    const effective = effectiveMatch(snapshot, id);
    return {
      sourceKey: sourceKeyFor(id), title: asText(book?.title) || "未命名的微信读书书籍",
      author: asText(book?.author), isbn: asText(book?.isbn) || null,
      notesCount: snapshot.imported.notesByBook.get(id)?.length ?? 0,
      effectiveCatalog: effective ? await getCatalog(effective.catalogId) : null,
      importedCatalogId: snapshot.importedBySource.get(id)?.catalogId ?? null,
      origin: origin(snapshot, id), revision: override?.revision ?? 0, updatedAt: override?.updatedAt ?? null,
    };
  }
  return {
    writable: deps.store !== null,
    async loadOverlay() { return overlayFrom(await state()); },
    async loadNotes() {
      const overlay = overlayFrom(await state());
      return createPrivateNotesData(overlay.notes ?? Array.from(overlay.notesByBook.values()).flat(), getWereadConfirmedMatches(overlay));
    },
    async list(raw = {}) {
      const query = listQuery(raw), snapshot = await state();
      const ids = Array.from(snapshot.sourcesByKey.values()).filter(id => {
        const book = snapshot.imported.books.get(id), effective = effectiveMatch(snapshot, id);
        if (query.q && ![book?.title, book?.author, book?.isbn].some(value => asText(value).toLocaleLowerCase().includes(query.q))) return false;
        if (query.status === "matched" && !effective || query.status === "unmatched" && effective) return false;
        if (query.status === "manual" && !["manual", "unlinked"].includes(origin(snapshot, id))) return false;
        return !query.catalogId || effective?.catalogId === query.catalogId;
      }).sort((a, b) => asText(snapshot.imported.books.get(a)?.title).localeCompare(asText(snapshot.imported.books.get(b)?.title), "zh-CN")
        || sourceKeyFor(a).localeCompare(sourceKeyFor(b)));
      const metadata = new Map<string, Promise<BindingCatalog>>();
      const getCatalog = (id: string) => {
        if (!metadata.has(id)) metadata.set(id, catalog(id));
        return metadata.get(id)!;
      };
      const items = await Promise.all(ids.slice(query.offset, query.offset + query.limit).map(id => item(snapshot, id, getCatalog)));
      return { items, pageInfo: { limit: query.limit, offset: query.offset, total: ids.length,
        hasMore: query.offset + query.limit < ids.length }, writable: deps.store !== null };
    },
    async get(rawKey) {
      const key = sourceKey(rawKey), snapshot = await state();
      return item(snapshot, findSource(snapshot, key));
    },
    async update(rawKey, rawBody) {
      const key = sourceKey(rawKey), body = updateBody(rawBody);
      if (!deps.store) throw unavailable();
      const snapshot = await state(), id = findSource(snapshot, key);
      if ((snapshot.overrides.get(id)?.revision ?? 0) !== body.expectedRevision) throw new WereadBindingError("WEREAD_BINDING_CONFLICT");
      if (body.catalogId) await catalog(body.catalogId, true);
      let written: WereadBindingOverride;
      try { written = await deps.store.write({ wereadBookId: id, ...body }); }
      catch (error) {
        if (error instanceof WereadBindingConflictError) throw new WereadBindingError("WEREAD_BINDING_CONFLICT");
        throw unavailable();
      }
      snapshot.overrides.set(id, written);
      clearWereadOverlayCache();
      return item(snapshot, id);
    },
  };
}
