import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPostgresWereadBindingStore, WereadBindingConflictError } from "./manual-bindings-store.js";
import { createWereadBindingsService } from "./manual-bindings.js";
import { clearWereadOverlayCache, getWereadStatusByCatalogId } from "./private-overlay.js";

// Explicit disposable database + non-admin role, supplied by the PG16 CI job.
// This suite skips without PG; unit stores are not evidence of SQL persistence.
const databaseUrl = process.env.S32_LIBRARY_TEST_DATABASE_URL;
const parsed = databaseUrl ? new URL(databaseUrl) : null;
if (parsed && (!["127.0.0.1", "localhost"].includes(parsed.hostname) || parsed.pathname !== "/s32_library_test")) {
  throw new Error("WeRead binding integration requires isolated local s32_library_test");
}
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 3000, query_timeout: 5000 }) : null;
afterAll(async () => { await pool?.end(); });
const A = "13000001_000000000001", B = "13000002_000000000002", C = "13000003_000000000003";
const key = (id: string) => createHash("sha256").update(id).digest("hex");

describe.skipIf(!pool)("WeRead binding overrides: real PostgreSQL16, non-admin s32_app", () => {
  const db = pool!;
  let dataDir: string, sourceA: string, sourceB: string;
  function write(file: string, data: unknown) {
    const target = path.join(dataDir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, JSON.stringify(data));
  }
  function importMatches(a = A) {
    write("derived/latest/weread-matches.confirmed.json", [
      { wereadBookId: sourceA, catalogId: a, matchMethod: "isbn", matchConfidence: "high", decisionSource: "auto_seed" },
      { wereadBookId: sourceB, catalogId: B, matchMethod: "isbn", matchConfidence: "high", decisionSource: "auto_seed" },
    ]);
  }
  const getCatalogDocument = async (id: string) => ({ id, title: `合成目录 ${id}`, author: "合成作者", year: 2001, isbn: null });
  const serviceFor = (target: Pool) => createWereadBindingsService({ dataDir, store: createPostgresWereadBindingStore(target), getCatalogDocument });
  async function freshRead() {
    const other = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 3000, query_timeout: 5000 });
    try { return await serviceFor(other).get(key(sourceA)); }
    finally { await other.end(); }
  }
  beforeAll(async () => {
    expect((await db.query(`SELECT current_user AS name, r.rolsuper, r.rolcreatedb, r.rolcreaterole
      FROM pg_roles r WHERE r.rolname = current_user`)).rows[0]).toEqual({ name: "s32_app", rolsuper: false, rolcreatedb: false, rolcreaterole: false });
    expect((await db.query("SHOW server_version_num")).rows[0].server_version_num).toMatch(/^16/);
    expect((await db.query("SELECT has_table_privilege(current_user, 'core.weread_binding_overrides', 'SELECT,INSERT,UPDATE') AS allowed")).rows[0].allowed).toBe(true);
    expect((await db.query("SELECT has_table_privilege(current_user, 'core.weread_binding_overrides', 'DELETE') AS allowed")).rows[0].allowed).toBe(false);
  });
  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "weread-binding-pg-"));
    sourceA = `pg-A-${randomUUID()}`; sourceB = `pg-B-${randomUUID()}`;
    clearWereadOverlayCache();
    write("snapshots/latest/weread-books.snapshot.json", [
      { wereadBookId: sourceA, title: "源书甲", author: "作者甲", isbn: null },
      { wereadBookId: sourceB, title: "源书乙", author: "作者乙", isbn: null },
    ]);
    write("snapshots/latest/weread-notes.snapshot.json", [
      { wereadBookId: sourceA, type: "highlight", note: "合成摘录一" },
      { wereadBookId: sourceA, type: "thought", note: "合成笔记二" },
      { wereadBookId: sourceB, type: "review", note: "合成书评三" },
    ]);
    importMatches();
  });
  afterEach(() => { clearWereadOverlayCache(); fs.rmSync(dataDir, { recursive: true, force: true }); });

  it("persists confirm/move/unlink/restore for a fresh Pool and Store, retaining revision through restore", async () => {
    const service = serviceFor(db);
    expect(await freshRead()).toMatchObject({ revision: 0, origin: "imported", effectiveCatalog: { id: A } });
    await service.update(key(sourceA), { action: "bind", catalogId: A, expectedRevision: 0 });
    expect(await freshRead()).toMatchObject({ revision: 1, origin: "manual", effectiveCatalog: { id: A } });
    await service.update(key(sourceA), { action: "bind", catalogId: B, expectedRevision: 1 });
    expect(await freshRead()).toMatchObject({ revision: 2, origin: "manual", effectiveCatalog: { id: B } });
    const before = (await createPostgresWereadBindingStore(db).list()).find(row => row.wereadBookId === sourceA)!;
    await service.update(key(sourceA), { action: "unbind", expectedRevision: 2 });
    expect(await freshRead()).toMatchObject({ revision: 3, origin: "unlinked", effectiveCatalog: null });
    await service.update(key(sourceA), { action: "restore", expectedRevision: 3 });
    expect(await freshRead()).toMatchObject({ revision: 4, origin: "imported", effectiveCatalog: { id: A } });
    const persisted = (await createPostgresWereadBindingStore(db).list()).find(row => row.wereadBookId === sourceA)!;
    expect(persisted).toMatchObject({ mode: "inherit", revision: 4, catalogId: null, createdAt: before.createdAt });
    await expect(service.update(key(sourceA), { action: "unbind", expectedRevision: 0 })).rejects.toMatchObject({ code: "WEREAD_BINDING_CONFLICT" });
  });
  it("atomically accepts one concurrent first writer and one concurrent later writer without lost updates", async () => {
    const store = createPostgresWereadBindingStore(db);
    const first = await Promise.allSettled([A, B].map(catalogId => store.write({ wereadBookId: sourceA, mode: "bind", catalogId, expectedRevision: 0 })));
    expect(first.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const rejected = first.find(result => result.status === "rejected");
    expect(rejected).toMatchObject({ status: "rejected", reason: expect.any(WereadBindingConflictError) });
    const later = await Promise.allSettled(["unbind", "inherit"].map(mode => store.write({ wereadBookId: sourceA, mode: mode as "unbind" | "inherit", catalogId: null, expectedRevision: 1 })));
    expect(later.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(later.find(result => result.status === "rejected")).toMatchObject({ reason: expect.any(WereadBindingConflictError) });
    expect(await freshRead()).toMatchObject({ revision: 2 });
    expect((await store.list()).filter(row => row.wereadBookId === sourceA)).toHaveLength(1);
  });
  it("applies persisted decisions ahead of new imports and aggregates two sources into one catalog", async () => {
    const service = serviceFor(db);
    await service.update(key(sourceA), { action: "bind", catalogId: B, expectedRevision: 0 });
    importMatches(C);
    expect(await freshRead()).toMatchObject({ revision: 1, importedCatalogId: C, effectiveCatalog: { id: B } });
    const overlay = await serviceFor(db).loadOverlay();
    expect(getWereadStatusByCatalogId(overlay, B).weread).toMatchObject({ matchedRecordsCount: 2, notesSummary: { total: 3 } });
    expect((await serviceFor(db).loadNotes()).wereadBookIdToCatalogId.get(sourceA)).toBe(B);
    await service.update(key(sourceA), { action: "unbind", expectedRevision: 1 });
    importMatches(A);
    expect(await freshRead()).toMatchObject({ revision: 2, origin: "unlinked", effectiveCatalog: null });
    expect((await serviceFor(db).loadNotes()).wereadBookIdToCatalogId.has(sourceA)).toBe(false);
    importMatches(C);
    await service.update(key(sourceA), { action: "restore", expectedRevision: 2 });
    expect(await freshRead()).toMatchObject({ revision: 3, origin: "imported", effectiveCatalog: { id: C } });
  });
  it("database constraints reject ambiguous tombstones, malformed targets and unsafe revisions", async () => {
    for (const [mode, catalogId, revision] of [["unbind", A, 1], ["inherit", B, 1], ["bind", null, 1], ["bind", "invalid", 1], ["bind", A, "9007199254740992"]]) {
      await expect(db.query("INSERT INTO core.weread_binding_overrides (weread_book_id, mode, catalog_id, revision) VALUES ($1,$2,$3,$4)",
        [`constraint-${randomUUID()}`, mode, catalogId, revision])).rejects.toMatchObject({ code: "23514" });
    }
  });
});
