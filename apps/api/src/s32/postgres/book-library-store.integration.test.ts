import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createBookLibraryService } from "../application/book-library.js";
import { createPromoteCatalogBookCommand } from "../application/promote-catalog-book.js";
import { createPostgresCatalogPromotionStore } from "./catalog-promotion-store.js";
import { createPostgresBookLibraryStore } from "./book-library-store.js";
import { createPostgresProjectItemNoteStore } from "./project-item-note-store.js";
import { createProjectItemNotesService } from "../application/project-item-notes.js";
import { createPostgresProjectBindingStore } from "./project-binding-store.js";
import type { BookWorkspace } from "../domain/book-library.js";

// The CI runner applies 001/002 as schema owner, creates/grants s32_app for
// existing tables, then applies 003 (including its grant-only additions).
// Tests connect only as the non-admin application role in a disposable DB.
const databaseUrl = process.env.S32_LIBRARY_TEST_DATABASE_URL;
const parsed = databaseUrl ? new URL(databaseUrl) : null;
if (parsed && (!["127.0.0.1", "localhost"].includes(parsed.hostname) || parsed.pathname !== "/s32_library_test")) {
  throw new Error("Book library integration requires isolated local s32_library_test");
}
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
afterAll(async () => { await pool?.end(); });

describe.skipIf(!pool)("Book library real PostgreSQL, s32_app runtime role", () => {
  const db = pool!;
  const reader = { async getById(id: string) { return {
    id, ssid: `ssid-${id}`, dxid: `dxid-${id}`, title: `古道研究 ${id}`, author: "测试作者", publisher: "测试出版社",
    year: 2001, pages: 123, isbn: "9787538455250", rawInfo: "deterministic library fixture", parseStatus: "ok" as const, parseWarnings: [],
  }; } };
  const promotionCommand = createPromoteCatalogBookCommand({ reader, store: createPostgresCatalogPromotionStore(db) });
  const store = createPostgresBookLibraryStore(db);
  const library = createBookLibraryService({ store, reader, promotionCommand });
  const bookId = () => `library-${randomUUID()}`;
  const resourceInput = { label: "扫描版", url: "https://example.test/book.pdf", format: "PDF", versionLabel: "2001 年版", notes: "外部电子版本" };
  function note(workspace: BookWorkspace, id?: string) {
    const found = id ? workspace.notes.find(value => value.noteId === id) : workspace.notes[0];
    if (!found) throw new Error("expected saved note");
    return found;
  }
  async function counts() {
    return (await db.query(`SELECT
      (SELECT count(*)::int FROM core.library_books) books,
      (SELECT count(*)::int FROM core.works) works,
      (SELECT count(*)::int FROM core.editions) editions,
      (SELECT count(*)::int FROM core.projects) projects,
      (SELECT count(*)::int FROM core.project_bindings) bindings`)).rows[0];
  }

  beforeAll(async () => {
    const role = (await db.query(`SELECT current_user AS name, r.rolsuper, r.rolcreatedb, r.rolcreaterole
      FROM pg_roles r WHERE r.rolname = current_user`)).rows[0];
    expect(role).toEqual({ name: "s32_app", rolsuper: false, rolcreatedb: false, rolcreaterole: false });
    expect((await db.query("SHOW server_version_num")).rows[0].server_version_num).toMatch(/^16/);
    for (const table of ["library_books", "library_book_notes", "library_book_resources"]) {
      expect((await db.query("SELECT has_table_privilege(current_user, $1, 'SELECT,INSERT,UPDATE,DELETE') AS allowed", [`core.${table}`])).rows[0].allowed).toBe(true);
    }
  });

  it("read-only opening does not promote/save; the first favorite reuses canonical identity and repeated saves are idempotent", async () => {
    const id = bookId(), before = await counts();
    expect(await library.get(id)).toEqual({ bookId: id, saved: false, editionId: null, introduction: "", version: 0, updatedAt: null, notes: [], resources: [] });
    expect(await counts()).toEqual(before);
    const saved = await library.save(id, {});
    expect(saved).toMatchObject({ bookId: id, saved: true, version: 1, introduction: "", notes: [], resources: [] });
    const again = await library.save(id, {});
    expect(again).toEqual(saved);
    const promotion = await promotionCommand.execute({ bookId: id });
    expect(promotion.editionId).toBe(saved.editionId);
    expect(await counts()).toEqual({ books: before.books + 1, works: before.works + 1, editions: before.editions + 1, projects: before.projects, bindings: before.bindings });
  });

  it("persists introductions with optimistic versions; concurrent stale writers cannot overwrite one another", async () => {
    const id = bookId();
    const initial = await library.save(id, { introduction: "初始介绍", baseVersion: 0 });
    expect(initial.version).toBe(1);
    const result = await Promise.allSettled(["更新甲", "更新乙"].map(introduction => library.save(id, { introduction, baseVersion: 1 })));
    expect(result.filter(value => value.status === "fulfilled")).toHaveLength(1);
    expect(result.find(value => value.status === "rejected")).toMatchObject({ reason: { code: "LIBRARY_STALE_VERSION" } });
    const current = await library.get(id);
    expect(current.version).toBe(2);
    expect(["更新甲", "更新乙"]).toContain(current.introduction);
    await expect(library.save(id, { introduction: "未带版本" })).rejects.toMatchObject({ code: "LIBRARY_STALE_VERSION" });
    expect((await library.save(id, {})).introduction).toBe(current.introduction);
    const cleared = await library.save(id, { introduction: "", baseVersion: 2 });
    expect(cleared).toMatchObject({ version: 3, introduction: "" });
    const source = (await db.query("SELECT s.metadata FROM core.library_books b JOIN core.sources s ON s.id = b.catalog_source_id WHERE b.catalog_book_id = $1", [id])).rows[0];
    expect(source.metadata.catalogDocument.rawInfo).toBe("deterministic library fixture");
  });

  it("adds multiple book Notes and an immutable, linear revision history with title and concurrent conflict checks", async () => {
    const id = bookId();
    const r1 = note(await library.createNote(id, { title: "第一篇", content: "  原文\r\n行二  " }));
    const original = (await db.query("SELECT * FROM core.note_revisions WHERE id = $1", [r1.currentRevisionId])).rows[0];
    expect(original.content).toBe("  原文\n行二  ");
    expect(original.content_sha256).toBe(createHash("sha256").update(original.content).digest("hex"));
    const twoNotes = await library.createNote(id, { title: "第二篇", content: "独立笔记" });
    expect(twoNotes.notes).toHaveLength(2);
    const r2 = note(await library.updateNote(id, r1.noteId, { title: "第一篇修订", content: "新正文", baseRevisionId: r1.currentRevisionId }), r1.noteId);
    expect(r2).toMatchObject({ title: "第一篇修订", content: "新正文", revisionNo: 2 });
    expect(await library.getRevision(id, r1.noteId, r1.currentRevisionId)).toMatchObject({ title: "第一篇", content: "  原文\n行二  ", revisionNo: 1 });
    const writers = await Promise.allSettled(["并发甲", "并发乙"].map(content => library.updateNote(id, r1.noteId, { title: "第三版", content, baseRevisionId: r2.currentRevisionId })));
    expect(writers.filter(value => value.status === "fulfilled")).toHaveLength(1);
    expect(writers.find(value => value.status === "rejected")).toMatchObject({ reason: { code: "LIBRARY_STALE_NOTE_REVISION" } });
    const current = note(await library.get(id), r1.noteId);
    expect(current.revisions.map(value => value.revisionNo)).toEqual([3, 2, 1]);
    const parents = (await db.query("SELECT child_revision_id, parent_revision_id FROM core.note_revision_parents WHERE note_id = $1", [r1.noteId])).rows;
    expect(parents).toEqual(expect.arrayContaining([
      { child_revision_id: r2.currentRevisionId, parent_revision_id: r1.currentRevisionId },
      { child_revision_id: current.currentRevisionId, parent_revision_id: r2.currentRevisionId },
    ]));
    expect((await db.query("SELECT * FROM core.note_revisions WHERE id = $1", [r1.currentRevisionId])).rows[0]).toEqual(original);
    await expect(db.query("UPDATE core.note_revisions SET title = 'forbidden' WHERE id = $1", [r1.currentRevisionId])).rejects.toThrow(/immutable/);
    await expect(db.query("DELETE FROM core.note_revisions WHERE id = $1", [r1.currentRevisionId])).rejects.toThrow(/immutable/);
  });

  it("rejects cross-book note/revision access and archives deletion while retaining the immutable revisions", async () => {
    const a = bookId(), b = bookId();
    const an = note(await library.createNote(a, { title: "A", content: "A" }));
    const bn = note(await library.createNote(b, { title: "B", content: "B" }));
    await expect(library.updateNote(b, an.noteId, { title: "forged", content: "forged", baseRevisionId: an.currentRevisionId })).rejects.toMatchObject({ code: "LIBRARY_NOTE_NOT_FOUND" });
    await expect(library.deleteNote(b, an.noteId)).rejects.toMatchObject({ code: "LIBRARY_NOTE_NOT_FOUND" });
    await expect(library.getRevision(b, an.noteId, an.currentRevisionId)).rejects.toMatchObject({ code: "LIBRARY_NOTE_NOT_FOUND" });
    await expect(library.getRevision(a, an.noteId, bn.currentRevisionId)).rejects.toMatchObject({ code: "LIBRARY_REVISION_NOT_FOUND" });
    expect((await library.deleteNote(a, an.noteId)).notes).toEqual([]);
    expect((await db.query("SELECT lifecycle_state FROM core.notes WHERE id = $1", [an.noteId])).rows[0].lifecycle_state).toBe("ARCHIVED");
    expect((await db.query("SELECT content FROM core.note_revisions WHERE id = $1", [an.currentRevisionId])).rows[0].content).toBe("A");
    expect(note(await library.get(b))).toMatchObject({ title: "B", content: "B" });
  });

  it("registers multiple remote resources without bytes, scopes edits to the book and preserves canonical assets after removal", async () => {
    const a = bookId(), b = bookId();
    const first = await library.createResource(a, resourceInput), resource = first.resources[0];
    const second = await library.createResource(a, { ...resourceInput, label: "网页", format: "HTML", url: "https://example.test/read" });
    expect(second.resources).toHaveLength(2);
    await library.save(b, {});
    const asset = (await db.query(`SELECT a.storage_mode, a.storage_key, a.remote_uri, a.sha256, a.metadata, s.edition_id
      FROM core.source_assets a JOIN core.sources s ON s.id = a.source_id WHERE a.id = $1`, [resource.resourceId])).rows[0];
    expect(asset).toEqual({ storage_mode: "REMOTE", storage_key: null, remote_uri: resourceInput.url, sha256: null, metadata: { registrationOnly: true }, edition_id: first.editionId });
    await expect(library.updateResource(b, resource.resourceId, { ...resourceInput, label: "wrong" })).rejects.toMatchObject({ code: "LIBRARY_RESOURCE_NOT_FOUND" });
    await expect(library.deleteResource(b, resource.resourceId)).rejects.toMatchObject({ code: "LIBRARY_RESOURCE_NOT_FOUND" });
    const edited = await library.updateResource(a, resource.resourceId, { ...resourceInput, url: "https://example.test/new.pdf", notes: "更新说明" });
    expect(edited.resources.find(value => value.resourceId === resource.resourceId)).toMatchObject({ url: "https://example.test/new.pdf", notes: "更新说明" });
    const removed = await library.deleteResource(a, resource.resourceId);
    expect(removed.resources).toHaveLength(1);
    expect((await db.query("SELECT remote_uri FROM core.source_assets WHERE id = $1", [resource.resourceId])).rows[0].remote_uri).toBe("https://example.test/new.pdf");
  });

  it("lists saved books with persisted metadata, content filters, literal search and pagination", async () => {
    const prefix = bookId(), ids = [`${prefix}-a`, `${prefix}-b`, `${prefix}-c`], term = `检索-${randomUUID()}`;
    await library.save(ids[0], { introduction: `阅读介绍 ${term}`, baseVersion: 0 });
    const first = note(await library.createNote(ids[1], { title: "阅读问题", content: `待核实 ${term}%_字面量` }));
    const latest = note(await library.createNote(ids[1], { title: `标题 ${term}%_字面量`, content: "第二篇的正文" }));
    await library.createResource(ids[2], resourceInput);
    const all = await library.list({ q: prefix, limit: "2" });
    expect(all).toMatchObject({ total: 3, page: 1, limit: 2 });
    expect(all.items).toHaveLength(2);
    expect(all.items[0]).toMatchObject({ author: "测试作者", publisher: "测试出版社", year: 2001 });
    expect(all.items.every(item => item.searchMatch === null)).toBe(true);
    expect((await library.list({ q: prefix, page: "2", limit: "2" })).items).toHaveLength(1);
    for (const [filter, id] of [["introduction", ids[0]], ["notes", ids[1]], ["resources", ids[2]]]) {
      const filtered = await library.list({ q: prefix, filter });
      expect(filtered.total).toBe(1); expect(filtered.items[0].bookId).toBe(id);
    }
    expect((await library.list({ q: `${prefix}%` })).total).toBe(0);

    // Current Note title/body both contribute, but a book remains one row.
    await db.query("UPDATE core.notes SET updated_at = '2001-01-01T00:00:00Z' WHERE id = $1", [first.noteId]);
    await db.query("UPDATE core.notes SET updated_at = '2002-01-01T00:00:00Z' WHERE id = $1", [latest.noteId]);
    const content = await library.list({ q: term });
    expect(content.total).toBe(2);
    expect(content.items.find(item => item.bookId === ids[1])).toMatchObject({
      noteCount: 2, searchMatch: { kind: "note", noteId: latest.noteId, noteTitle: latest.title, excerpt: latest.title },
    });
    expect(content.items.find(item => item.bookId === ids[0])?.searchMatch).toEqual({ kind: "introduction", excerpt: `阅读介绍 ${term}` });
    const literal = await library.list({ q: `${term}%_` });
    expect(literal.total).toBe(1); expect(literal.items[0].bookId).toBe(ids[1]);
    expect((await library.list({ q: `${term}__` })).total).toBe(0);
    expect((await library.list({ q: term, filter: "introduction" })).items.map(item => item.bookId)).toEqual([ids[0]]);
    expect((await library.list({ q: term, filter: "notes" })).items.map(item => item.bookId)).toEqual([ids[1]]);
    expect((await library.list({ q: term, filter: "resources" })).total).toBe(0);

    // A Note match never jumps ahead of a newer book; pagination counts books.
    await db.query("UPDATE core.library_books SET updated_at = '2005-01-01T00:00:00Z' WHERE catalog_book_id = $1", [ids[0]]);
    await db.query("UPDATE core.library_books SET updated_at = '2004-01-01T00:00:00Z' WHERE catalog_book_id = $1", [ids[1]]);
    const pageOne = await library.list({ q: term, limit: "1" });
    const pageTwo = await library.list({ q: term, limit: "1", page: "2" });
    expect(pageOne.total).toBe(2); expect(pageTwo.total).toBe(2);
    expect([...pageOne.items, ...pageTwo.items].map(item => item.bookId)).toEqual([ids[0], ids[1]]);
    await db.query("UPDATE core.notes SET updated_at = '2003-01-01T00:00:00Z' WHERE id = ANY($1::uuid[])", [[first.noteId, latest.noteId]]);
    const tied = (await library.list({ q: `${term}%_` })).items[0].searchMatch;
    expect(tied).toMatchObject({ kind: "note", noteId: [first.noteId, latest.noteId].sort()[0] });
    expect((await library.list({ limit: "100" })).items.every(item => item.searchMatch === null)).toBe(true);
  });

  it("searches only current active library Note revisions, excluding history, archives and other Note types", async () => {
    const id = bookId(), oldTerm = `旧版-${randomUUID()}`, currentTerm = `当前-${randomUUID()}`;
    const initial = note(await library.createNote(id, { title: `旧标题 ${oldTerm}`, content: `旧正文 ${oldTerm}` }));
    expect((await library.list({ q: oldTerm })).items.map(item => item.bookId)).toEqual([id]);
    const current = note(await library.updateNote(id, initial.noteId, {
      title: "当前标题", content: `当前正文 ${currentTerm}`, baseRevisionId: initial.currentRevisionId,
    }));
    expect((await library.list({ q: oldTerm })).total).toBe(0);
    expect((await library.list({ q: currentTerm })).items[0].searchMatch).toEqual({
      kind: "note", noteId: current.noteId, noteTitle: "当前标题", excerpt: `当前正文 ${currentTerm}`,
    });
    await library.deleteNote(id, current.noteId);
    expect((await library.list({ q: currentTerm })).total).toBe(0);
    expect((await db.query("SELECT count(*)::int AS total FROM core.note_revisions WHERE note_id = $1", [current.noteId])).rows[0].total).toBe(2);
    const other = note(await library.createNote(id, { title: "其他类型", content: currentTerm }));
    await db.query("UPDATE core.notes SET note_type = 'GENERAL' WHERE id = $1", [other.noteId]);
    expect((await library.list({ q: currentTerm })).total).toBe(0);
  });

  it("returns bounded Unicode excerpts around late matches and prefers a current Note over an introduction", async () => {
    const id = bookId(), term = `Late-${randomUUID()}`;
    const introduction = "介绍前文".repeat(200) + term + "介绍后文".repeat(200);
    await library.save(id, { introduction, baseVersion: 0 });
    const introMatch = (await library.list({ q: term.toLowerCase() })).items[0].searchMatch;
    expect(introMatch?.kind).toBe("introduction");
    expect(introMatch?.excerpt).toContain(term);
    expect(Array.from(introMatch!.excerpt)).toHaveLength(242);
    expect(introMatch?.excerpt.startsWith("…")).toBe(true);
    expect(introMatch?.excerpt.endsWith("…")).toBe(true);

    const content = "🧭".repeat(400) + term + "🚲".repeat(400);
    const saved = note(await library.createNote(id, { title: "正文晚段命中", content }));
    const matched = (await library.list({ q: term.toLowerCase() })).items[0];
    expect(matched.searchMatch).toMatchObject({ kind: "note", noteId: saved.noteId, noteTitle: saved.title });
    expect(matched.searchMatch?.excerpt).toBe("…" + "🧭".repeat(60) + term + "🚲".repeat(240 - 60 - Array.from(term).length) + "…");
    expect(Array.from(matched.searchMatch!.excerpt)).toHaveLength(242);
    expect(matched).not.toHaveProperty("content");
    expect(matched).not.toHaveProperty("search_text");
    expect(matched).not.toHaveProperty("revisions");

    const longTerm = `Long-${"字".repeat(195)}`;
    await library.createNote(id, { title: "长查询", content: "🧭".repeat(300) + longTerm + "🚲".repeat(300) });
    const longMatch = (await library.list({ q: longTerm })).items[0].searchMatch;
    expect(longMatch?.excerpt).toContain(longTerm);
    expect(Array.from(longMatch!.excerpt)).toHaveLength(242);
    await library.deleteNote(id, saved.noteId);
    expect((await library.list({ q: term })).items[0].searchMatch?.kind).toBe("introduction");
  });

  it("keeps an existing project Note independent when enriching the same canonical Edition", async () => {
    const id = bookId(), promotion = await promotionCommand.execute({ bookId: id }), projectId = randomUUID();
    await db.query("INSERT INTO core.projects (id, name) VALUES ($1, 'Existing research fixture')", [projectId]);
    const { item } = await createPostgresProjectBindingStore(db).addEdition({ projectId,
      workId: promotion.workId, editionId: promotion.editionId, sourceId: promotion.sourceId, catalogBookId: id });
    const projectNotes = createProjectItemNotesService(createPostgresProjectItemNoteStore(db));
    const historical = await projectNotes.create(projectId, item.bindingId, { content: "项目语境中的旧笔记" });
    const before = await counts();
    await library.save(id, { introduction: "书籍内容介绍", baseVersion: 0 });
    const saved = await library.createNote(id, { title: "书籍笔记", content: "独立阅读笔记" });
    expect(saved.editionId).toBe(item.editionId);
    expect(saved.notes).toHaveLength(1);
    expect(saved.notes[0].noteId).not.toBe(historical.noteId);
    expect(await projectNotes.get(projectId, item.bindingId)).toEqual(historical);
    expect((await library.list({ q: historical.currentRevision.content })).total).toBe(0);
    const after = await counts();
    expect(after.projects).toBe(before.projects); expect(after.bindings).toBe(before.bindings);
    expect(after.editions).toBe(before.editions); expect(after.works).toBe(before.works);
  });
});
