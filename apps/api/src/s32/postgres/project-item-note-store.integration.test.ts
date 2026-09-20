import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createProjectsService } from "../application/projects.js";
import { createPromoteCatalogBookCommand } from "../application/promote-catalog-book.js";
import { createProjectItemsService } from "../application/project-items.js";
import { createProjectItemNotesService, ProjectItemHasNoteError, ProjectItemNotFoundError, ProjectItemNoteAlreadyExistsError, ProjectItemNoteRevisionNotFoundError, StaleNoteRevisionError } from "../application/project-item-notes.js";
import { sha256NoteContent } from "../domain/note.js";
import { createPostgresProjectStore } from "./project-store.js";
import { createPostgresCatalogPromotionStore } from "./catalog-promotion-store.js";
import { createPostgresProjectBindingStore } from "./project-binding-store.js";
import { createPostgresProjectItemNoteStore } from "./project-item-note-store.js";

const databaseUrl = process.env.S32_M1D_TEST_DATABASE_URL;
const parsed = databaseUrl ? new URL(databaseUrl) : null;
if (parsed && (parsed.hostname !== "127.0.0.1" || parsed.pathname !== "/s32_m1d_test")) throw new Error("M1D integration requires isolated s32_m1d_test");
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
afterAll(async () => { await pool?.end(); });

describe.skipIf(!pool)("M1-D real PostgreSQL16", () => {
  const db = pool!;
  const projects = createProjectsService(createPostgresProjectStore(db));
  const bindings = createPostgresProjectBindingStore(db);
  const notes = createProjectItemNotesService(createPostgresProjectItemNoteStore(db));
  const promotionCommand = createPromoteCatalogBookCommand({ reader: { async getById(id) { return {
    id, ssid: `ssid-${id}`, dxid: `dxid-${id}`, title: `古道测试 ${id}`, author: "测试作者", publisher: "测试出版社", year: 2001,
    pages: 123, isbn: "9787538455250", rawInfo: "deterministic M1D fixture", parseStatus: "ok", parseWarnings: [],
  }; } }, store: createPostgresCatalogPromotionStore(db) });
  const items = createProjectItemsService({ projects, promotionCommand, bindings });
  async function fixture(bookId = randomUUID()) {
    const project = await projects.create({ name: `M1D ${randomUUID()}` });
    const { item } = await items.addCatalogBook(project.id, { bookId });
    return { project, item };
  }
  async function counts() {
    return (await db.query(`SELECT (SELECT count(*)::int FROM core.notes) notes,
      (SELECT count(*)::int FROM core.note_revisions) revisions,
      (SELECT count(*)::int FROM core.note_revision_parents) parents,
      (SELECT count(*)::int FROM core.project_bindings WHERE target_type='NOTE') bindings`)).rows[0];
  }
  async function rawRevision(id: string) { return (await db.query("SELECT * FROM core.note_revisions WHERE id=$1", [id])).rows[0]; }
  async function rawNote(id: string) { return (await db.query("SELECT * FROM core.notes WHERE id=$1", [id])).rows[0]; }
  beforeAll(async () => { expect((await db.query("SHOW server_version_num")).rows[0].server_version_num).toMatch(/^16/); });

  it("A/B: atomic normalized R1, exact ownership/hash, no parent, duplicate leaves counts unchanged", async () => {
    const { project, item } = await fixture();
    const before = await counts();
    expect(await notes.get(project.id, item.bindingId)).toBeNull();
    const note = await notes.create(project.id.toUpperCase(), item.bindingId.toUpperCase(), { content: "  R1\r\n古道\r原文  " });
    expect(note.currentRevision).toMatchObject({ revisionNo: 1, contentFormat: "MARKDOWN", content: "  R1\n古道\n原文  ", contentSha256: sha256NoteContent("  R1\n古道\n原文  ") });
    expect(await counts()).toEqual({ notes: before.notes + 1, revisions: before.revisions + 1, parents: before.parents, bindings: before.bindings + 1 });
    expect(await rawNote(note.noteId)).toMatchObject({ note_type: "PROJECT_ITEM_NOTE", lifecycle_state: "ACTIVE", current_revision_id: note.currentRevision.revisionId, next_revision_no: "2" });
    expect(await rawRevision(note.currentRevision.revisionId)).toMatchObject({ title: null, change_summary: null });
    expect((await db.query("SELECT * FROM core.project_bindings WHERE target_type='NOTE' AND target_id=$1", [note.noteId])).rows).toMatchObject([{ project_id: project.id, binding_role: "ANNOTATION", metadata: { subjectBindingId: item.bindingId, subjectType: "EDITION", subjectId: item.editionId } }]);
    const after = await counts();
    await expect(notes.create(project.id, item.bindingId, { content: "duplicate" })).rejects.toBeInstanceOf(ProjectItemNoteAlreadyExistsError);
    expect(await counts()).toEqual(after);
  });

  it("C: concurrent create commits exactly one Note/R1/NOTE binding", async () => {
    const { project, item } = await fixture(); const before = await counts();
    const result = await Promise.allSettled(["one", "two"].map(content => notes.create(project.id, item.bindingId, { content })));
    expect(result.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(result.find(r => r.status === "rejected")).toMatchObject({ reason: expect.any(ProjectItemNoteAlreadyExistsError) });
    expect(await counts()).toEqual({ notes: before.notes + 1, revisions: before.revisions + 1, parents: before.parents, bindings: before.bindings + 1 });
  });

  it("D/E/F: immutable R1, linear parents, concurrent R2 saves yield one R3 and one stale", async () => {
    const { project, item } = await fixture();
    const r1 = await notes.create(project.id, item.bindingId, { content: "R1 原文 \n" });
    const original = await rawRevision(r1.currentRevision.revisionId);
    const r2 = await notes.append(project.id, item.bindingId, { baseRevisionId: r1.currentRevision.revisionId.toUpperCase(), content: "R2" });
    expect(r2.currentRevision.revisionNo).toBe(2);
    expect(await rawRevision(r1.currentRevision.revisionId)).toEqual(original);
    expect(await rawNote(r1.noteId)).toMatchObject({ current_revision_id: r2.currentRevision.revisionId, next_revision_no: "3" });
    const result = await Promise.allSettled(["R3 A", "R3 B"].map(content => notes.append(project.id, item.bindingId, { baseRevisionId: r2.currentRevision.revisionId, content })));
    expect(result.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(result.find(r => r.status === "rejected")).toMatchObject({ reason: expect.any(StaleNoteRevisionError) });
    const current = (await notes.get(project.id, item.bindingId))!;
    expect(current.revisions.map(r => r.revisionNo)).toEqual([3, 2, 1]);
    expect(await rawNote(current.noteId)).toMatchObject({ current_revision_id: current.currentRevision.revisionId, next_revision_no: "4" });
    expect((await db.query("SELECT child_revision_id, parent_revision_id, parent_order FROM core.note_revision_parents WHERE note_id=$1 ORDER BY child_revision_id", [current.noteId])).rows).toEqual([
      { child_revision_id: r2.currentRevision.revisionId, parent_revision_id: r1.currentRevision.revisionId, parent_order: 1 },
      { child_revision_id: current.currentRevision.revisionId, parent_revision_id: r2.currentRevision.revisionId, parent_order: 1 },
    ].sort((a,b) => a.child_revision_id.localeCompare(b.child_revision_id)));
    expect(await notes.getRevision(project.id, item.bindingId, r1.currentRevision.revisionId)).toEqual(r1.currentRevision);
    expect(await rawRevision(r1.currentRevision.revisionId)).toEqual(original);
    await expect(db.query("UPDATE core.note_revisions SET content='forbidden' WHERE id=$1", [r1.currentRevision.revisionId])).rejects.toThrow(/immutable/);
    await expect(db.query("DELETE FROM core.note_revisions WHERE id=$1", [r1.currentRevision.revisionId])).rejects.toThrow(/immutable/);
  });

  it("G/H: same Edition in two projects has independent Notes; foreign revisions remain inaccessible", async () => {
    const bookId = randomUUID(); const a = await fixture(bookId), b = await fixture(bookId);
    expect(a.item.editionId).toBe(b.item.editionId);
    const an = await notes.create(a.project.id, a.item.bindingId, { content: "A" });
    const bn = await notes.create(b.project.id, b.item.bindingId, { content: "B" });
    expect(an.noteId).not.toBe(bn.noteId); expect(bn.currentRevision.revisionNo).toBe(1);
    await expect(notes.getRevision(a.project.id, a.item.bindingId, bn.currentRevision.revisionId)).rejects.toBeInstanceOf(ProjectItemNoteRevisionNotFoundError);
    await expect(notes.getRevision(b.project.id, b.item.bindingId, an.currentRevision.revisionId)).rejects.toBeInstanceOf(ProjectItemNoteRevisionNotFoundError);
    await expect(notes.get(b.project.id, a.item.bindingId)).rejects.toBeInstanceOf(ProjectItemNotFoundError);
  });

  it("I/J: Note guards removal without loss; another unannotated Edition removes without deleting canonical data", async () => {
    const { project, item } = await fixture(); const note = await notes.create(project.id, item.bindingId, { content: "kept" });
    const before = await counts();
    await expect(items.remove(project.id, item.bindingId)).rejects.toBeInstanceOf(ProjectItemHasNoteError);
    expect(await items.list(project.id)).toHaveLength(1); expect(await notes.get(project.id, item.bindingId)).toEqual(note); expect(await counts()).toEqual(before);
    const other = await fixture();
    const identitiesBefore = (await db.query("SELECT * FROM core.external_identities WHERE target_type='SOURCE' AND target_id=$1 ORDER BY id", [other.item.sourceId])).rows;
    expect(identitiesBefore).toHaveLength(3);
    await items.remove(other.project.id, other.item.bindingId); expect(await items.list(other.project.id)).toEqual([]);
    for (const [table,id] of [["works",other.item.workId],["editions",other.item.editionId],["sources",other.item.sourceId]]) expect((await db.query(`SELECT count(*)::int n FROM core.${table} WHERE id=$1`,[id])).rows[0].n).toBe(1);
    expect((await db.query("SELECT * FROM core.external_identities WHERE target_type='SOURCE' AND target_id=$1 ORDER BY id", [other.item.sourceId])).rows).toEqual(identitiesBefore);
  });

  for (const first of ["create", "remove"] as const) it(`K: real lock overlap, ${first} queued first; no orphan Note`, async () => {
    const { project, item } = await fixture(); const before = await counts();
    const blocker = await db.connect();
    const createPool = new Pool({ connectionString: databaseUrl, application_name: `m1d-create-${first}` });
    const removePool = new Pool({ connectionString: databaseUrl, application_name: `m1d-remove-${first}` });
    const create = () => createProjectItemNotesService(createPostgresProjectItemNoteStore(createPool)).create(project.id,item.bindingId,{content:"race"});
    const remove = () => createPostgresProjectBindingStore(removePool).removeEdition({projectId:project.id,bindingId:item.bindingId});
    const waitLocked = async (name: string) => {
      for (let i=0;i<200;i++) {
        if ((await db.query("SELECT count(*)::int n FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'",[name])).rows[0].n === 1) return;
        await new Promise(resolve => setTimeout(resolve,10));
      }
      throw new Error(`Expected overlapping lock wait: ${name}`);
    };
    const settled = <T,>(p: Promise<T>) => p.then(value => ({ok:true as const,value}), error => ({ok:false as const,error}));
    let operations: Promise<unknown>[] = [];
    try {
      await blocker.query("BEGIN"); await blocker.query("SELECT id FROM core.project_bindings WHERE id=$1 FOR UPDATE", [item.bindingId]);
      const firstOp = settled(first === "create" ? create() : remove()); operations.push(firstOp);
      await waitLocked(`m1d-${first}-${first}`);
      const secondOp = settled(first === "create" ? remove() : create()); operations.push(secondOp);
      await waitLocked(`m1d-${first === "create" ? "remove" : "create"}-${first}`);
      await blocker.query("COMMIT");
      const [one,two] = await Promise.all([firstOp,secondOp]);
      expect(one.ok).toBe(true); expect(two).toMatchObject({ok:false,error:expect.any(first === "create" ? ProjectItemHasNoteError : ProjectItemNotFoundError)});
      if (first === "create") {
        expect(await items.list(project.id)).toHaveLength(1); expect(await notes.get(project.id,item.bindingId)).not.toBeNull();
      } else { expect(await items.list(project.id)).toEqual([]); expect(await counts()).toEqual(before); }
    } finally { await blocker.query("ROLLBACK"); blocker.release(); await Promise.allSettled(operations); await Promise.all([createPool.end(),removePool.end()]); }
  });

  it("L: failure after R1/pointer but before NOTE binding rolls back all partial rows", async () => {
    const { project,item } = await fixture(); const before = await counts();
    await db.query(`CREATE FUNCTION public.m1d_fail_binding() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.target_type='NOTE' THEN RAISE EXCEPTION 'M1D_INJECTED_BINDING_FAILURE'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER m1d_fail_binding BEFORE INSERT ON core.project_bindings FOR EACH ROW EXECUTE FUNCTION public.m1d_fail_binding()`);
    try { await expect(notes.create(project.id,item.bindingId,{content:"rollback"})).rejects.toThrow("M1D_INJECTED_BINDING_FAILURE"); }
    finally { await db.query("DROP TRIGGER m1d_fail_binding ON core.project_bindings; DROP FUNCTION public.m1d_fail_binding()"); }
    expect(await counts()).toEqual(before); expect(await notes.get(project.id,item.bindingId)).toBeNull();
    expect((await notes.create(project.id,item.bindingId,{content:"retry"})).currentRevision.revisionNo).toBe(1);
  });

  it("L append: failure after new revision/parent rolls back pointer, sequence and inserted rows", async () => {
    const { project,item } = await fixture(); const note = await notes.create(project.id,item.bindingId,{content:"original"});
    const before = await counts(); const rawBefore = await rawNote(note.noteId);
    await db.query(`CREATE FUNCTION public.m1d_fail_advance() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      RAISE EXCEPTION 'M1D_INJECTED_ADVANCE_FAILURE'; END $$;
      CREATE TRIGGER m1d_fail_advance BEFORE UPDATE ON core.notes FOR EACH ROW EXECUTE FUNCTION public.m1d_fail_advance()`);
    try { await expect(notes.append(project.id,item.bindingId,{baseRevisionId:note.currentRevision.revisionId,content:"rollback"})).rejects.toThrow("M1D_INJECTED_ADVANCE_FAILURE"); }
    finally { await db.query("DROP TRIGGER m1d_fail_advance ON core.notes; DROP FUNCTION public.m1d_fail_advance()"); }
    expect(await counts()).toEqual(before); expect(await rawNote(note.noteId)).toEqual(rawBefore); expect(await notes.get(project.id,item.bindingId)).toEqual(note);
  });

  it("M: no unrelated domain writes", async () => {
    const allowed = ["projects","works","editions","sources","external_identities","project_bindings","notes","note_revisions","note_revision_parents"];
    const quote = (value: string) => `"${value.replaceAll('"','""')}"`;
    const tables = (await db.query("SELECT schemaname,tablename FROM pg_tables WHERE schemaname IN ('core','ops','derived')")).rows;
    for (const {schemaname,tablename} of tables) {
      if (schemaname === "core" && allowed.includes(tablename)) continue;
      expect((await db.query(`SELECT count(*)::int n FROM ${quote(schemaname)}.${quote(tablename)}`)).rows[0].n,`${schemaname}.${tablename}`).toBe(0);
    }
  });
});
