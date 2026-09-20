import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createProjectsService } from "../application/projects.js";
import { createPromoteCatalogBookCommand } from "../application/promote-catalog-book.js";
import { createProjectItemsService, ProjectNotActiveError } from "../application/project-items.js";
import {
  createProjectItemNotesService,
  ProjectReadOnlyError,
} from "../application/project-item-notes.js";
import {
  createResearchMembershipService,
  ResearchMembershipIntegrityError,
} from "../application/research-memberships.js";
import {
  createProjectOverviewService,
  ProjectOverviewIntegrityError,
} from "../application/project-overview.js";
import { createPostgresProjectStore } from "./project-store.js";
import { createPostgresCatalogPromotionStore } from "./catalog-promotion-store.js";
import { createPostgresProjectBindingStore } from "./project-binding-store.js";
import { createPostgresProjectItemNoteStore } from "./project-item-note-store.js";
import { createPostgresResearchMembershipStore } from "./research-membership-store.js";
import { createPostgresProjectOverviewStore } from "./project-overview-store.js";

const databaseUrl = process.env.S32_M1E_TEST_DATABASE_URL;
const parsed = databaseUrl ? new URL(databaseUrl) : null;
if (parsed && (parsed.hostname !== "127.0.0.1" || parsed.pathname !== "/s32_m1e_test")) {
  throw new Error("M1E integration requires isolated s32_m1e_test");
}

const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
afterAll(async () => { await pool?.end(); });

describe.skipIf(!pool)("M1-E real PostgreSQL16", () => {
  const db = pool!;
  const projects = createProjectsService(createPostgresProjectStore(db));
  const bindings = createPostgresProjectBindingStore(db);
  const notes = createProjectItemNotesService(createPostgresProjectItemNoteStore(db));
  const memberships = createResearchMembershipService(createPostgresResearchMembershipStore(db));
  const overview = createProjectOverviewService(createPostgresProjectOverviewStore(db));
  const promotionCommand = createPromoteCatalogBookCommand({
    reader: {
      async getById(id) {
        return {
          id,
          ssid: `ssid-${id}`,
          dxid: `dxid-${id}`,
          title: `古道测试 ${id}`,
          author: "测试作者",
          publisher: "测试出版社",
          year: 2001,
          pages: 123,
          isbn: "9787538455250",
          rawInfo: "deterministic M1E fixture",
          parseStatus: "ok" as const,
          parseWarnings: [],
        };
      },
    },
    store: createPostgresCatalogPromotionStore(db),
  });
  const items = createProjectItemsService({ projects, promotionCommand, bindings });

  async function fixture(bookId = randomUUID()) {
    const project = await projects.create({ name: `M1E ${randomUUID()}` });
    const added = await items.addCatalogBook(project.id, { bookId });
    return { project, item: added.item, bookId };
  }

  async function counts() {
    return (await db.query(`SELECT
      (SELECT count(*)::int FROM core.projects) projects,
      (SELECT count(*)::int FROM core.works) works,
      (SELECT count(*)::int FROM core.editions) editions,
      (SELECT count(*)::int FROM core.sources) sources,
      (SELECT count(*)::int FROM core.external_identities) identities,
      (SELECT count(*)::int FROM core.project_bindings) bindings,
      (SELECT count(*)::int FROM core.notes) notes,
      (SELECT count(*)::int FROM core.note_revisions) revisions,
      (SELECT count(*)::int FROM core.note_revision_parents) parents`)).rows[0];
  }

  beforeAll(async () => {
    expect((await db.query("SHOW server_version_num")).rows[0].server_version_num).toMatch(/^16/);
  });

  it("A-D: returns explicit unknowns, shared-Edition memberships, lifecycle state, and Note activity", async () => {
    const bookId = randomUUID();
    const active = await fixture(bookId);
    const archived = await fixture(bookId);
    expect(active.item.editionId).toBe(archived.item.editionId);

    await notes.create(active.project.id, active.item.bindingId, { content: "active note" });
    await db.query("UPDATE core.projects SET lifecycle_state='ARCHIVED' WHERE id=$1", [archived.project.id]);

    const result = await memberships.lookup({ bookIds: [bookId, "unknown-book", bookId] });
    expect(result.memberships["unknown-book"]).toEqual([]);
    expect(result.memberships[bookId]).toHaveLength(2);
    expect(result.memberships[bookId].map((entry) => entry.projectLifecycleState)).toEqual(["ACTIVE", "ARCHIVED"]);
    expect(result.memberships[bookId][0]).toMatchObject({
      projectId: active.project.id,
      bindingId: active.item.bindingId,
      hasNote: true,
    });
    expect(result.memberships[bookId][0].noteUpdatedAt).toMatch(/^2026-/);
    expect(result.memberships[bookId][1]).toMatchObject({
      projectId: archived.project.id,
      bindingId: archived.item.bindingId,
      hasNote: false,
      noteUpdatedAt: null,
    });
  });

  it("E-F: non-SOURCE identity and broken Source→Edition→Work chain fail closed", async () => {
    const wrongTargetBook = randomUUID();
    const wrongTarget = await promotionCommand.execute({ bookId: wrongTargetBook });
    await db.query(
      `UPDATE core.external_identities
       SET target_type='WORK', target_id=$2
       WHERE provider='BOOK_ID_SEARCH' AND namespace='CATALOG_DOCUMENT' AND external_id=$1
         AND binding_state <> 'RETIRED'`,
      [wrongTargetBook, wrongTarget.workId],
    );
    await expect(memberships.lookup({ bookIds: [wrongTargetBook] }))
      .rejects.toBeInstanceOf(ResearchMembershipIntegrityError);

    const brokenBook = randomUUID();
    const broken = await promotionCommand.execute({ bookId: brokenBook });
    await db.query("UPDATE core.sources SET edition_id=NULL WHERE id=$1", [broken.sourceId]);
    await expect(memberships.lookup({ bookIds: [brokenBook] }))
      .rejects.toBeInstanceOf(ResearchMembershipIntegrityError);
  });

  it("G: malformed NOTE relationship is integrity failure for membership and overview", async () => {
    const { project, item, bookId } = await fixture();
    const note = await notes.create(project.id, item.bindingId, { content: "kept" });
    await db.query(
      "UPDATE core.project_bindings SET binding_role='BROKEN' WHERE target_type='NOTE' AND target_id=$1",
      [note.noteId],
    );
    await expect(memberships.lookup({ bookIds: [bookId] }))
      .rejects.toBeInstanceOf(ResearchMembershipIntegrityError);
    await expect(overview.get(project.id))
      .rejects.toBeInstanceOf(ProjectOverviewIntegrityError);
    await db.query(
      "UPDATE core.project_bindings SET binding_role='ANNOTATION' WHERE target_type='NOTE' AND target_id=$1",
      [note.noteId],
    );
  });

  it("H-K: overview handles empty/no-Note/current-Note and recent-research ordering", async () => {
    const empty = await projects.create({ name: `Empty ${randomUUID()}` });
    expect(await overview.get(empty.id)).toMatchObject({
      summary: { itemCount: 0, noteCount: 0, lastActivityAt: null },
      items: [],
    });

    const project = await projects.create({ name: `Overview ${randomUUID()}` });
    const a = (await items.addCatalogBook(project.id, { bookId: randomUUID() })).item;
    const b = (await items.addCatalogBook(project.id, { bookId: randomUUID() })).item;
    const c = (await items.addCatalogBook(project.id, { bookId: randomUUID() })).item;

    await db.query("UPDATE core.project_bindings SET created_at='2026-01-01T00:00:00Z' WHERE id=$1", [a.bindingId]);
    await db.query("UPDATE core.project_bindings SET created_at='2026-02-01T00:00:00Z' WHERE id=$1", [b.bindingId]);
    await db.query("UPDATE core.project_bindings SET created_at='2026-03-01T00:00:00Z' WHERE id=$1", [c.bindingId]);

    const note = await notes.create(project.id, b.bindingId, { content: "  第一段\r\n\t第二段  " });
    await db.query("UPDATE core.notes SET updated_at='2026-04-01T00:00:00Z' WHERE id=$1", [note.noteId]);

    const result = await overview.get(project.id);
    expect(result?.summary).toEqual({
      itemCount: 3,
      noteCount: 1,
      lastActivityAt: "2026-04-01T00:00:00.000Z",
    });
    expect(result?.items.map((item) => item.bindingId)).toEqual([b.bindingId, c.bindingId, a.bindingId]);
    expect(result?.items[0].noteSummary).toMatchObject({
      noteId: note.noteId,
      currentRevisionId: note.currentRevision.revisionId,
      currentRevisionNo: 1,
      excerpt: "第一段 第二段",
      updatedAt: "2026-04-01T00:00:00.000Z",
    });
    expect(result?.items[1].noteSummary).toBeNull();
  });

  it("L-M: archived Project stays readable while every M1 write is rejected without row changes", async () => {
    const { project, item } = await fixture();
    const note = await notes.create(project.id, item.bindingId, { content: "R1 archived" });
    await db.query("UPDATE core.projects SET lifecycle_state='ARCHIVED' WHERE id=$1", [project.id]);

    expect(await projects.get(project.id)).toMatchObject({ lifecycleState: "ARCHIVED" });
    expect(await overview.get(project.id)).toMatchObject({ project: { readOnly: true, lifecycleState: "ARCHIVED" } });
    expect(await notes.get(project.id, item.bindingId)).toMatchObject({ noteId: note.noteId });
    expect(await notes.getRevision(project.id, item.bindingId, note.currentRevision.revisionId))
      .toEqual(note.currentRevision);

    const before = await counts();
    await expect(items.addCatalogBook(project.id, { bookId: randomUUID() })).rejects.toBeInstanceOf(ProjectNotActiveError);
    await expect(notes.create(project.id, item.bindingId, { content: "forbidden" })).rejects.toBeInstanceOf(ProjectReadOnlyError);
    await expect(notes.append(project.id, item.bindingId, {
      baseRevisionId: note.currentRevision.revisionId,
      content: "forbidden",
    })).rejects.toBeInstanceOf(ProjectReadOnlyError);
    await expect(items.remove(project.id, item.bindingId)).rejects.toBeInstanceOf(ProjectNotActiveError);
    expect(await counts()).toEqual(before);
  });

  it("N: no unrelated domain tables receive rows", async () => {
    const allowed = new Set([
      "projects", "works", "editions", "sources", "external_identities",
      "project_bindings", "notes", "note_revisions", "note_revision_parents",
    ]);
    const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
    const tables = (await db.query(
      "SELECT schemaname, tablename FROM pg_tables WHERE schemaname IN ('core','ops','derived')",
    )).rows;
    for (const { schemaname, tablename } of tables) {
      if (schemaname === "core" && allowed.has(tablename)) continue;
      expect(
        (await db.query(`SELECT count(*)::int n FROM ${quote(schemaname)}.${quote(tablename)}`)).rows[0].n,
        `${schemaname}.${tablename}`,
      ).toBe(0);
    }
  });
});
