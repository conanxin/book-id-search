import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import {
  createPostgresProjectOverviewStore,
} from "./project-overview-store.js";
import {
  ProjectOverviewIntegrityError,
  ProjectOverviewStoreUnavailableError,
} from "../application/project-overview.js";

const projectId = "11111111-1111-4111-8111-111111111111";
const editionId = "22222222-2222-4222-8222-222222222222";
const workId = "33333333-3333-4333-8333-333333333333";
const bindingId = "44444444-4444-4444-8444-444444444444";
const sourceId = "55555555-5555-4555-8555-555555555555";
const noteId = "66666666-6666-4666-8666-666666666666";
const revisionId = "77777777-7777-4777-8777-777777777777";

function projectRow(overrides: Record<string, unknown> = {}) {
  return {
    id: projectId,
    name: "北京古道研究",
    metadata: { description: "核对线路" },
    lifecycle_state: "ACTIVE",
    created_at: new Date("2026-09-19T00:00:00.000Z"),
    updated_at: new Date("2026-09-20T00:00:00.000Z"),
    ...overrides,
  };
}

function itemRow(overrides: Record<string, unknown> = {}) {
  return {
    binding_id: bindingId,
    binding_metadata: { sourceId, catalogBookId: "book-a" },
    added_at: new Date("2026-09-20T07:00:00.000Z"),
    edition_id: editionId,
    work_id: workId,
    publisher: "出版社",
    publication_date: "2001-02-03",
    publication_date_precision: "DAY",
    isbn: "isbn",
    title: "北京古道考",
    note_binding_id: null,
    note_id: null,
    note_binding_role: null,
    note_binding_metadata: null,
    note_type: null,
    note_lifecycle_state: null,
    current_revision_id: null,
    note_updated_at: null,
    current_revision_actual_id: null,
    current_revision_note_id: null,
    current_revision_no: null,
    current_content_format: null,
    current_content: null,
    current_content_sha256: null,
    ...overrides,
  };
}

function notedRow(overrides: Record<string, unknown> = {}) {
  return itemRow({
    note_binding_id: "88888888-8888-4888-8888-888888888888",
    note_id: noteId,
    note_binding_role: "ANNOTATION",
    note_binding_metadata: {
      subjectBindingId: bindingId,
      subjectType: "EDITION",
      subjectId: editionId,
    },
    note_type: "PROJECT_ITEM_NOTE",
    note_lifecycle_state: "ACTIVE",
    current_revision_id: revisionId,
    note_updated_at: new Date("2026-09-20T08:00:00.000Z"),
    current_revision_actual_id: revisionId,
    current_revision_note_id: noteId,
    current_revision_no: "3",
    current_content_format: "MARKDOWN",
    current_content: "  第一段\r\n\t第二段  ",
    current_content_sha256: "a".repeat(64),
    ...overrides,
  });
}

type Options = {
  project?: any | null;
  items?: any[];
  error?: Error & { code?: string };
};

function fake(options: Options = {}) {
  const query = vi.fn(async (sql: string) => {
    if (options.error && !/^(BEGIN|ROLLBACK)$/.test(sql)) throw options.error;
    if (sql.startsWith("BEGIN")) return { rows: [] };
    if (sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
    if (sql.includes("FROM core.projects")) {
      return { rows: options.project === null ? [] : [options.project ?? projectRow()] };
    }
    if (sql.includes("FROM core.project_bindings pb")) {
      return { rows: options.items ?? [itemRow()] };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  });
  const release = vi.fn();
  const pool = { connect: vi.fn(async () => ({ query, release })) };
  return {
    store: createPostgresProjectOverviewStore(pool as unknown as Pool),
    query,
    release,
  };
}

describe("Postgres project overview store", () => {
  it("returns null for a missing project in one repeatable-read read-only snapshot", async () => {
    const s = fake({ project: null });
    await expect(s.store.get(projectId)).resolves.toBeNull();
    expect(s.query.mock.calls[0][0]).toMatch(/BEGIN.*REPEATABLE READ.*READ ONLY/i);
    expect(s.query.mock.calls.filter(([sql]) => String(sql).includes("FROM core.project_bindings pb"))).toHaveLength(0);
    expect(s.query.mock.calls.at(-1)![0]).toBe("COMMIT");
  });

  it("projects an ACTIVE item without Note and provenance metadata", async () => {
    const s = fake();
    await expect(s.store.get(projectId)).resolves.toEqual({
      project: {
        id: projectId,
        name: "北京古道研究",
        description: "核对线路",
        lifecycleState: "ACTIVE",
        readOnly: false,
        createdAt: "2026-09-19T00:00:00.000Z",
        updatedAt: "2026-09-20T00:00:00.000Z",
      },
      summary: {
        itemCount: 1,
        noteCount: 0,
        lastActivityAt: "2026-09-20T07:00:00.000Z",
      },
      items: [{
        bindingId,
        workId,
        editionId,
        sourceId,
        catalogBookId: "book-a",
        title: "北京古道考",
        publisher: "出版社",
        publicationDate: "2001-02-03",
        publicationDatePrecision: "DAY",
        isbn: "isbn",
        addedAt: "2026-09-20T07:00:00.000Z",
        activityAt: "2026-09-20T07:00:00.000Z",
        noteSummary: null,
      }],
    });
    expect(s.query.mock.calls.filter(([sql]) => String(sql).includes("FROM core.project_bindings pb"))).toHaveLength(1);
    expect(s.query.mock.calls.some(([sql]) => /\b(INSERT|UPDATE|DELETE)\b/i.test(String(sql)))).toBe(false);
  });

  it("returns ARCHIVED projects read-only and summarizes only the current Note revision", async () => {
    const s = fake({
      project: projectRow({ lifecycle_state: "ARCHIVED" }),
      items: [notedRow()],
    });
    const result = await s.store.get(projectId);
    expect(result?.project).toMatchObject({ lifecycleState: "ARCHIVED", readOnly: true });
    expect(result?.summary).toEqual({
      itemCount: 1,
      noteCount: 1,
      lastActivityAt: "2026-09-20T08:00:00.000Z",
    });
    expect(result?.items[0]).toMatchObject({
      activityAt: "2026-09-20T08:00:00.000Z",
      noteSummary: {
        noteId,
        currentRevisionId: revisionId,
        currentRevisionNo: 3,
        excerpt: "第一段 第二段",
        updatedAt: "2026-09-20T08:00:00.000Z",
      },
    });
  });

  it("returns 0/0/null for an empty Project", async () => {
    const result = await fake({ items: [] }).store.get(projectId);
    expect(result?.summary).toEqual({ itemCount: 0, noteCount: 0, lastActivityAt: null });
    expect(result?.items).toEqual([]);
  });

  it("sorts by activityAt DESC then bindingId DESC", async () => {
    const olderBinding = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const newerBinding = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const result = await fake({ items: [
      itemRow({ binding_id: olderBinding, added_at: new Date("2026-09-20T06:00:00Z") }),
      itemRow({ binding_id: newerBinding, added_at: new Date("2026-09-20T09:00:00Z") }),
      notedRow({ binding_id: bindingId, note_binding_metadata: { subjectBindingId: bindingId, subjectType: "EDITION", subjectId: editionId }, note_updated_at: new Date("2026-09-20T08:00:00Z") }),
    ] }).store.get(projectId);
    expect(result?.items.map((item) => item.bindingId)).toEqual([newerBinding, bindingId, olderBinding]);
  });

  it("treats legacy Edition binding metadata as nullable provenance", async () => {
    const result = await fake({ items: [itemRow({ binding_metadata: { sourceId: 42, catalogBookId: [] } })] }).store.get(projectId);
    expect(result?.items[0]).toMatchObject({ sourceId: null, catalogBookId: null });
  });

  it("fails closed for duplicate or malformed NOTE relationships", async () => {
    await expect(fake({ items: [notedRow(), notedRow({ note_binding_id: "99999999-9999-4999-8999-999999999999" })] }).store.get(projectId))
      .rejects.toBeInstanceOf(ProjectOverviewIntegrityError);
    await expect(fake({ items: [notedRow({ current_revision_actual_id: null })] }).store.get(projectId))
      .rejects.toBeInstanceOf(ProjectOverviewIntegrityError);
    await expect(fake({ items: [notedRow({ current_content_format: "PLAIN_TEXT" })] }).store.get(projectId))
      .rejects.toBeInstanceOf(ProjectOverviewIntegrityError);
  });

  it.each(["ECONNREFUSED", "08006", "57P01", "53300"])("classifies unavailable storage %s", async (code) => {
    const error = Object.assign(new Error("private"), { code });
    await expect(fake({ error }).store.get(projectId)).rejects.toBeInstanceOf(ProjectOverviewStoreUnavailableError);
  });
});
