import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWereadBindingsService } from "./manual-bindings.js";
import { WereadBindingConflictError, type WereadBindingOverride, type WereadBindingStore } from "./manual-bindings-store.js";
import { buildNotesTrend, clearWereadOverlayCache, getWereadConfirmedMatches, getWereadStatusesByCatalogIds, getWereadSummary } from "./private-overlay.js";
import { queryPrivateNotes } from "./private-notes.js";
import { runPrivateReadingMap } from "./private-reading-map.js";
import { runPrivateAnnualReview } from "./private-annual-review.js";

const A = "13000001_000000000001", B = "13000002_000000000002", C = "13000003_000000000003";
const sourceA = "private-source-A", sourceB = "private-source-B", sourceC = "private-source-C";
const key = (id: string) => createHash("sha256").update(id).digest("hex");
const confirmed = (wereadBookId: string, catalogId: string) => ({ wereadBookId, catalogId,
  ssid: catalogId.split("_")[0], dxid: catalogId.split("_")[1], isbn: null,
  matchMethod: "isbn", matchConfidence: "high", decisionSource: "auto_seed" });
let dataDir: string;
function write(name: string, value: unknown) {
  const file = path.join(dataDir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}
const writeImport = (a = A) => write("derived/latest/weread-matches.confirmed.json", [confirmed(sourceA, a), confirmed(sourceB, B)]);
function memoryStore() {
  const rows = new Map<string, WereadBindingOverride>();
  const store: WereadBindingStore = {
    list: vi.fn(async () => Array.from(rows.values())),
    write: vi.fn(async input => {
      const current = rows.get(input.wereadBookId);
      if ((current?.revision ?? 0) !== input.expectedRevision) throw new WereadBindingConflictError();
      const now = new Date().toISOString();
      const row = { wereadBookId: input.wereadBookId, mode: input.mode, catalogId: input.catalogId,
        revision: input.expectedRevision + 1, createdAt: current?.createdAt ?? now, updatedAt: now };
      rows.set(row.wereadBookId, row);
      return row;
    }),
  };
  return store;
}
function setup(store: WereadBindingStore | null = memoryStore()) {
  const getCatalogDocument = vi.fn(async (id: string) => {
    if (![A, B, C].includes(id)) throw new Error("private upstream detail", { cause: { code: "document_not_found" } });
    return { id, title: `公开书目 ${id}`, author: "公开作者", publisher: "出版社", year: 2001, isbn: "9787538455250" };
  });
  return { service: createWereadBindingsService({ dataDir, store, getCatalogDocument }), store, getCatalogDocument };
}
beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "weread-binding-unit-"));
  clearWereadOverlayCache();
  write("snapshots/latest/weread-books.snapshot.json", [
    { wereadBookId: sourceA, title: "甲的源书", author: "甲作者", isbn: "9787538455250" },
    { wereadBookId: sourceB, title: "乙的源书", author: "乙作者", isbn: null },
    { wereadBookId: sourceC, title: "丙的源书", author: "丙作者", isbn: null },
  ]);
  const createdAt = Math.floor(new Date("2026-10-01T00:00:00Z").getTime() / 1000);
  // A/B/A interleaving with equal dates guards stable pagination order.
  write("snapshots/latest/weread-notes.snapshot.json", [
    { wereadBookId: sourceA, type: "highlight", note: "A 第一条", createdAt },
    { wereadBookId: sourceB, type: "review", note: "B 第一条", createdAt },
    { wereadBookId: sourceA, type: "thought", note: "A 第二条", createdAt },
    { wereadBookId: sourceC, type: "highlight", note: "C 未匹配", createdAt },
  ]);
  writeImport();
});
afterEach(() => { clearWereadOverlayCache(); fs.rmSync(dataDir, { recursive: true, force: true }); });

describe("WeRead manual relationships (unit store, imported fixtures)", () => {
  it("lists safe source metadata and effective catalog details, with literal search, filters and pagination", async () => {
    const { service } = setup();
    const all = await service.list({ limit: "2" });
    expect(all).toMatchObject({ writable: true, pageInfo: { limit: 2, offset: 0, total: 3, hasMore: true } });
    expect((await service.list({ offset: "2", limit: "2" })).items).toHaveLength(1);
    const a = await service.get(key(sourceA));
    expect(a).toEqual({ sourceKey: key(sourceA), title: "甲的源书", author: "甲作者", isbn: "9787538455250", notesCount: 2,
      effectiveCatalog: { id: A, title: `公开书目 ${A}`, author: "公开作者", publisher: "出版社", year: 2001, isbn: "9787538455250", available: true },
      importedCatalogId: A, origin: "imported", revision: 0, updatedAt: null });
    expect(JSON.stringify(a)).not.toMatch(/private-source|wereadBookId|A 第一条/);
    expect((await service.list({ q: "  甲作者 " })).items).toEqual([a]);
    expect((await service.list({ q: "9787538455250" })).items).toEqual([a]);
    expect((await service.list({ q: "甲%" })).items).toEqual([]);
    expect((await service.list({ catalogId: A })).items).toEqual([a]);
    expect((await service.list({ status: "matched" })).pageInfo.total).toBe(2);
    expect((await service.list({ status: "unmatched" })).items[0].sourceKey).toBe(key(sourceC));
    expect((await service.list({ status: "manual" })).items).toEqual([]);
  });

  it("confirms, moves, unlinks and restores across notes, status, batch, summary, trends, reading map and annual review", async () => {
    const { service } = setup();
    expect(await service.update(key(sourceA), { action: "bind", catalogId: A, expectedRevision: 0 })).toMatchObject({ origin: "manual", revision: 1, effectiveCatalog: { id: A } });
    expect(await service.update(key(sourceA), { action: "bind", catalogId: B, expectedRevision: 1 })).toMatchObject({ origin: "manual", revision: 2, effectiveCatalog: { id: B }, importedCatalogId: A });
    async function verify(expectedMatched: number, catalogs: number, bCount: number) {
      const overlay = await service.loadOverlay(), matches = getWereadConfirmedMatches(overlay);
      const statuses = getWereadStatusesByCatalogIds(overlay, [A, B]);
      expect(statuses[A].matched).toBe(false);
      expect(statuses[B].weread).toMatchObject({ notesSummary: { total: bCount }, matchedRecordsCount: expectedMatched });
      expect(getWereadSummary(overlay)).toMatchObject({ confirmedMatchesCount: expectedMatched, totalConfirmedNoteRecords: bCount, notesCount: 4 });
      expect(buildNotesTrend(overlay.notes!, matches).confirmedOnly.total).toBe(bCount);
      const notes = queryPrivateNotes(await service.loadNotes(), { type: "all", days: "all", matchedOnly: true, sort: "oldest", limit: 100, offset: 0, catalogId: B });
      expect(notes.pageInfo.total).toBe(bCount);
      expect(notes.items.every(item => item.catalogId === B && item.matched)).toBe(true);
      const aggregates = overlay.notes!.map(note => ({ wereadBookId: note.wereadBookId, catalogId: "", type: note.type, createdAt: note.createdAt, updatedAt: note.updatedAt }));
      const fetchMetadata = { fetchByCatalogId: async (catalogId: string) => ({ catalogId, title: "公开书目" }) };
      const map = await runPrivateReadingMap({ query: {}, notes: aggregates, confirmedMatches: matches, booksCount: 3, fetchMetadata });
      expect(map.response?.overview).toMatchObject({ matchedCatalogsCount: catalogs, matchedNoteRecordsCount: bCount });
      const annual = await runPrivateAnnualReview({ query: { year: 2026 }, notes: aggregates, confirmedMatches: matches, fetchMetadata, now: new Date("2026-10-11T00:00:00Z") });
      expect(annual.response?.overview).toMatchObject({ matchedBooks: catalogs, matchedRecords: bCount });
    }
    await verify(2, 1, 3);
    const mixed = queryPrivateNotes(await service.loadNotes(), { type: "all", days: "all", matchedOnly: true, sort: "oldest", limit: 2, offset: 0, catalogId: B });
    expect(mixed.items.map(item => item.text)).toEqual(["A 第一条", "B 第一条"]);
    expect(await service.update(key(sourceA), { action: "unbind", expectedRevision: 2 })).toMatchObject({ origin: "unlinked", revision: 3, effectiveCatalog: null });
    await verify(1, 1, 1);
    expect((await service.list({ status: "manual" })).items[0]).toMatchObject({ sourceKey: key(sourceA), origin: "unlinked" });
    expect((await service.list({ catalogId: B })).pageInfo.total).toBe(1);
    // The single-item endpoint still locates a source that left the old filter.
    expect(await service.get(key(sourceA))).toMatchObject({ revision: 3 });
    expect(await service.update(key(sourceA), { action: "restore", expectedRevision: 3 })).toMatchObject({ origin: "imported", revision: 4, effectiveCatalog: { id: A } });
    expect(getWereadStatusesByCatalogIds(await service.loadOverlay(), [A])[A].weread?.notesSummary?.total).toBe(2);
  });

  it("manual bind and unlink survive a replacement import; restore uses the latest import without resetting revision", async () => {
    const { service } = setup();
    await service.update(key(sourceA), { action: "bind", catalogId: B, expectedRevision: 0 });
    writeImport(C);
    expect(await service.get(key(sourceA))).toMatchObject({ revision: 1, importedCatalogId: C, effectiveCatalog: { id: B } });
    await service.update(key(sourceA), { action: "unbind", expectedRevision: 1 });
    writeImport(A);
    expect(await service.get(key(sourceA))).toMatchObject({ revision: 2, origin: "unlinked", importedCatalogId: A, effectiveCatalog: null });
    writeImport(C);
    expect(await service.update(key(sourceA), { action: "restore", expectedRevision: 2 })).toMatchObject({ revision: 3, origin: "imported", effectiveCatalog: { id: C } });
    await expect(service.update(key(sourceA), { action: "bind", catalogId: A, expectedRevision: 0 })).rejects.toMatchObject({ status: 409, code: "WEREAD_BINDING_CONFLICT" });
    write("derived/latest/weread-matches.confirmed.json", [confirmed(sourceB, B)]);
    expect(await service.get(key(sourceA))).toMatchObject({ revision: 3, origin: "none", effectiveCatalog: null, importedCatalogId: null });
  });

  it("supports initially unmatched sources and prevents both stale and concurrent overwrite", async () => {
    const { service, store } = setup();
    const attempts = await Promise.allSettled([A, B].map(catalogId => service.update(key(sourceC), { action: "bind", catalogId, expectedRevision: 0 })));
    expect(attempts.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(attempts.find(result => result.status === "rejected")).toMatchObject({ reason: { code: "WEREAD_BINDING_CONFLICT" } });
    const before = await service.get(key(sourceC));
    await expect(service.update(key(sourceC), { action: "unbind", expectedRevision: 0 })).rejects.toMatchObject({ status: 409 });
    expect(await service.get(key(sourceC))).toEqual(before);
    expect((await store!.list()).find(row => row.wereadBookId === sourceC)?.revision).toBe(1);
    expect(await service.update(key(sourceC), { action: "restore", expectedRevision: 1 })).toMatchObject({ revision: 2, origin: "none", effectiveCatalog: null });
  });

  it.each([
    { catalogId: "" }, { catalogId: "wrong" }, { catalogId: [A, B] }, { catalogId: undefined },
    { q: ["甲", "乙"] }, { q: "私".repeat(201) }, { status: "unknown" }, { status: ["matched"] },
    { limit: "0" }, { limit: "101" }, { limit: "1.5" }, { limit: ["1"] }, { offset: "-1" }, { offset: "1000001" },
  ])("rejects malformed query before any store or catalog access: %j", async query => {
    const { service, store, getCatalogDocument } = setup();
    await expect(service.list(query)).rejects.toMatchObject({ status: 400 });
    expect(store!.list).not.toHaveBeenCalled(); expect(getCatalogDocument).not.toHaveBeenCalled();
  });
  it.each([
    {}, [], { action: "bind", catalogId: A }, { action: "bind", catalogId: "", expectedRevision: 0 },
    { action: "unbind", catalogId: A, expectedRevision: 0 }, { action: "restore", catalogId: null, expectedRevision: 0 },
    { action: "bind", catalogId: A, expectedRevision: -1 }, { action: "unbind", expectedRevision: 0.5 },
    { action: "unbind", expectedRevision: Number.MAX_SAFE_INTEGER + 1 }, { action: "unbind", expectedRevision: "0" },
    { action: "unbind", expectedRevision: 0, note: "private text" },
  ])("rejects invalid mutation before writes: %j", async body => {
    const { service, store } = setup();
    await expect(service.update(key(sourceA), body)).rejects.toMatchObject({ status: 400 });
    expect(store!.list).not.toHaveBeenCalled(); expect(store!.write).not.toHaveBeenCalled();
  });

  it("rejects raw/invalid source IDs, unknown sources and missing target catalogs without changes", async () => {
    const { service, store } = setup();
    await expect(service.get(sourceA)).rejects.toMatchObject({ status: 400 });
    await expect(service.get(key(sourceA).toUpperCase())).rejects.toMatchObject({ status: 400 });
    await expect(service.update(key("no-source"), { action: "unbind", expectedRevision: 0 })).rejects.toMatchObject({ code: "WEREAD_BINDING_SOURCE_NOT_FOUND" });
    await expect(service.update(key(sourceA), { action: "bind", catalogId: "999_000000000001", expectedRevision: 0 })).rejects.toMatchObject({ code: "WEREAD_BINDING_CATALOG_NOT_FOUND" });
    expect(store!.write).not.toHaveBeenCalled();
  });
  it("retains binding identity through catalog removal/outage, while refusing a new target lookup failure", async () => {
    const { service, getCatalogDocument, store } = setup();
    getCatalogDocument.mockRejectedValue(new Error("private catalog credential"));
    expect(await service.get(key(sourceA))).toMatchObject({ effectiveCatalog: { id: A, available: false }, origin: "imported" });
    expect((await service.list({ status: "matched" })).pageInfo.total).toBe(2);
    await expect(service.update(key(sourceA), { action: "bind", catalogId: B, expectedRevision: 0 })).rejects.toMatchObject({ code: "WEREAD_BINDING_UNAVAILABLE" });
    expect(store!.write).not.toHaveBeenCalled();
    expect(await service.update(key(sourceA), { action: "unbind", expectedRevision: 0 })).toMatchObject({ effectiveCatalog: null, origin: "unlinked" });
    expect(await service.update(key(sourceA), { action: "restore", expectedRevision: 1 })).toMatchObject({ revision: 2, effectiveCatalog: { id: A, available: false } });
  });
  it("keeps imported read-only behavior without PG, but never falls back after a configured PG read failure", async () => {
    const readOnly = setup(null).service;
    expect((await readOnly.list()).writable).toBe(false);
    expect((await readOnly.loadNotes()).wereadBookIdToCatalogId.get(sourceA)).toBe(A);
    await expect(readOnly.update(key(sourceA), { action: "unbind", expectedRevision: 0 })).rejects.toMatchObject({ status: 503 });
    const { service, store } = setup();
    await service.update(key(sourceA), { action: "unbind", expectedRevision: 0 });
    vi.mocked(store!.list).mockRejectedValue(new Error("password=private-db-detail"));
    for (const read of [() => service.loadOverlay(), () => service.loadNotes(), () => service.list(), () => service.get(key(sourceA)), () => service.update(key(sourceA), { action: "restore", expectedRevision: 1 })]) {
      await expect(read()).rejects.toMatchObject({ status: 503, code: "WEREAD_BINDING_UNAVAILABLE" });
      await expect(read()).rejects.not.toThrow(/password|private-db-detail/);
    }
  });
});
