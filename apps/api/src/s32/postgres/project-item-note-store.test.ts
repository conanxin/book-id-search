import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { createPostgresProjectItemNoteStore } from "./project-item-note-store.js";
import { ProjectItemInactiveError, ProjectItemNotFoundError, ProjectItemNoteAlreadyExistsError, ProjectItemNoteNotFoundError, ProjectItemNoteRevisionNotFoundError, ProjectItemNoteStoreUnavailableError, StaleNoteRevisionError } from "../application/project-item-notes.js";
import { sha256NoteContent } from "../domain/note.js";

const projectId = "11111111-1111-4111-8111-111111111111";
const bindingId = "22222222-2222-4222-8222-222222222222";
const editionId = "33333333-3333-4333-8333-333333333333";
const noteId = "44444444-4444-4444-8444-444444444444";
const r1 = "55555555-5555-4555-8555-555555555555";
const r2 = "66666666-6666-4666-8666-666666666666";
const now = new Date("2026-09-20T00:00:00Z");
const ids = { projectId, bindingId };
const revision = (id = r1, no = 1, content = "original") => ({ id, note_id: noteId, revision_no: String(no), content_format: "MARKDOWN", content, content_sha256: sha256NoteContent(content), created_at: now });
type Options = { exists?: boolean; firstRevision?: boolean; missingSubject?: boolean; projectState?: string; editionState?: string; metadata?: unknown; role?: string; duplicateBindings?: boolean; missingNote?: boolean; noteState?: string; missingCurrent?: boolean; connectError?: unknown; fail?: RegExp; error?: Error };
function fake(options: Options = {}) {
  let exists = options.exists !== false;
  let metadata = Object.hasOwn(options, "metadata") ? options.metadata : { subjectBindingId: bindingId, subjectType: "EDITION", subjectId: editionId };
  const note = { id: noteId, note_type: "PROJECT_ITEM_NOTE", lifecycle_state: options.noteState ?? "ACTIVE", current_revision_id: options.missingCurrent ? null : options.firstRevision ? r1 : r2, next_revision_no: options.firstRevision ? "2" : "3", created_at: now, updated_at: now };
  let revisions = options.firstRevision ? [revision()] : [revision(r2, 2, "second"), revision()];
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    if (options.fail?.test(sql)) throw options.error ?? new Error("injected SQL failure");
    if (sql.includes("FROM core.project_bindings pb")) return { rows: options.missingSubject ? [] : [{ binding_id: bindingId, edition_id: editionId, project_state: options.projectState ?? "ACTIVE", edition_state: options.editionState ?? "ACTIVE" }] };
    if (sql.includes("FROM core.project_bindings nb")) {
      const row = { note_id: note.id, binding_role: options.role ?? "ANNOTATION", metadata };
      return { rows: exists ? options.duplicateBindings ? [row, row] : [row] : [] };
    }
    if (sql.includes("FROM core.notes n")) return { rows: options.missingNote ? [] : [{ ...note }] };
    if (sql.includes("FROM core.note_revisions")) return { rows: sql.includes("ORDER BY") ? revisions : revisions.filter(r => r.id === values[1] && r.note_id === values[0]) };
    if (sql.startsWith("INSERT INTO core.notes")) { note.id = values[0] as string; revisions = []; }
    if (sql.startsWith("INSERT INTO core.note_revisions")) revisions.unshift({ ...revision(values[0] as string, values[2] as number, values[3] as string), note_id: values[1] as string, content_sha256: values[4] as string });
    if (sql.startsWith("UPDATE core.notes")) { note.current_revision_id = values[1] as string; note.next_revision_no = String(values[2]); }
    if (sql.startsWith("INSERT INTO core.project_bindings")) { exists = true; metadata = JSON.parse(values[3] as string); }
    return { rows: [], rowCount: 1 };
  });
  const release = vi.fn();
  const connect = vi.fn(async () => { if (options.connectError) throw options.connectError; return { query, release }; });
  const store = createPostgresProjectItemNoteStore({ connect } as unknown as Pool);
  return { store, query, release, note };
}

describe("Postgres project item note store", () => {
  it.each(["ECONNREFUSED", "ECONNRESET", "08006", "57P01", "53300"])("classifies connection unavailable %s", async code => {
    const s = fake({ connectError: Object.assign(new Error("secret connection"), { code }) });
    await expect(s.store.get(ids)).rejects.toBeInstanceOf(ProjectItemNoteStoreUnavailableError);
  });
  it("rethrows unexpected SQL errors and rolls back", async () => {
    const error = Object.assign(new Error("secret SQL"), { code: "42601" }); const s = fake({ fail: /FROM core.project_bindings pb/, error });
    await expect(s.store.get(ids)).rejects.toBe(error);
    expect(s.query).toHaveBeenCalledWith("ROLLBACK"); expect(s.release).toHaveBeenCalledOnce();
  });
  it("returns null only for an existing active subject with no NOTE binding", async () => {
    const s = fake({ exists: false }); expect(await s.store.get(ids)).toBeNull();
    expect(s.query).toHaveBeenCalledWith(expect.stringMatching(/REPEATABLE READ.*READ ONLY/));
    expect(s.query).toHaveBeenCalledWith("COMMIT"); expect(s.release).toHaveBeenCalledOnce();
  });
  it.each([{ missingSubject: true }, { projectState: "ARCHIVED" }, { editionState: "ARCHIVED" }])("fails closed for missing/inactive subject %j", async options => {
    const s = fake(options);
    await expect(s.store.get(ids)).rejects.toBeInstanceOf(options.missingSubject ? ProjectItemNotFoundError : ProjectItemInactiveError);
  });
  it("returns canonical current revision and newest-first summaries without old bodies", async () => {
    const s = fake(); const note = await s.store.get(ids);
    expect(note).toEqual({ noteId, projectId, subjectBindingId: bindingId, subjectId: editionId, createdAt: now.toISOString(), updatedAt: now.toISOString(), currentRevision: { revisionId: r2, revisionNo: 2, contentFormat: "MARKDOWN", content: "second", contentSha256: sha256NoteContent("second"), createdAt: now.toISOString() }, revisions: [{ revisionId: r2, revisionNo: 2, createdAt: now.toISOString() }, { revisionId: r1, revisionNo: 1, createdAt: now.toISOString() }] });
    expect(s.query).toHaveBeenCalledWith(expect.stringMatching(/ORDER BY revision_no DESC/), [noteId]);
  });
  it.each([null, [], {}, { subjectBindingId: bindingId, subjectType: "WORK", subjectId: editionId }, { subjectBindingId: bindingId, subjectType: "EDITION", subjectId: noteId }])("malformed NOTE metadata %j is integrity error, never absent", async metadata => {
    await expect(fake({ metadata }).store.get(ids)).rejects.toThrow("integrity");
  });
  it.each([{ role: "OTHER" }, { duplicateBindings: true }, { missingNote: true }, { missingCurrent: true }])("inconsistent NOTE chain fails closed %j", async options => {
    await expect(fake(options).store.get(ids)).rejects.toThrow("integrity");
  });
  it("rejects inactive Note", async () => {
    await expect(fake({ noteState: "ARCHIVED" }).store.get(ids)).rejects.toBeInstanceOf(ProjectItemInactiveError);
  });
  it("scopes historical revision lookup to owned Note/project/subject", async () => {
    const s = fake(); const result = await s.store.getRevision({ ...ids, revisionId: r1 });
    expect(result).toMatchObject({ revisionId: r1, revisionNo: 1, content: "original" });
    expect(s.query).toHaveBeenCalledWith(expect.stringMatching(/JOIN core.project_bindings[\s\S]*project_id[\s\S]*subjectBindingId/), [noteId, r1, projectId, bindingId]);
    await expect(s.store.getRevision({ ...ids, revisionId: editionId })).rejects.toBeInstanceOf(ProjectItemNoteRevisionNotFoundError);
    await expect(fake({ exists: false }).store.getRevision({ ...ids, revisionId: r1 })).rejects.toBeInstanceOf(ProjectItemNoteNotFoundError);
  });
  it("creates Note, R1, current pointer and NOTE binding inside the subject lock transaction", async () => {
    const s = fake({ exists: false }); const content = "  保存\n正文  ";
    const result = await s.store.create({ ...ids, content, contentSha256: sha256NoteContent(content) });
    expect(result.currentRevision).toMatchObject({ revisionNo: 1, content, contentSha256: sha256NoteContent(content), contentFormat: "MARKDOWN" });
    const calls = s.query.mock.calls;
    expect(calls[0][0]).toBe("BEGIN");
    expect(calls[1]).toEqual([expect.stringMatching(/pb.id = \$1[\s\S]*pb.project_id = \$2[\s\S]*FOR UPDATE OF pb/), [bindingId, projectId]]);
    expect(calls.find(([sql]) => sql.startsWith("INSERT INTO core.notes"))![0]).toMatch(/'PROJECT_ITEM_NOTE', 'ACTIVE', NULL, 1/);
    expect(calls.find(([sql]) => sql.startsWith("INSERT INTO core.note_revisions"))![0]).toMatch(/NULL, 'MARKDOWN',[\s\S]*NULL/);
    expect(calls.some(([sql]) => sql.includes("note_revision_parents"))).toBe(false);
    const binding = calls.find(([sql]) => sql.startsWith("INSERT INTO core.project_bindings"))!;
    expect(binding[0]).toMatch(/'NOTE'[\s\S]*'ANNOTATION'/);
    expect(JSON.parse(binding[1][3] as string)).toEqual({ subjectBindingId: bindingId, subjectType: "EDITION", subjectId: editionId });
    expect(s.note.next_revision_no).toBe("2");
    expect(calls.at(-1)![0]).toBe("COMMIT"); expect(s.release).toHaveBeenCalledOnce();
  });
  it("rejects duplicate creation under the subject lock before any insert", async () => {
    const s = fake();
    await expect(s.store.create({ ...ids, content: "x", contentSha256: sha256NoteContent("x") })).rejects.toBeInstanceOf(ProjectItemNoteAlreadyExistsError);
    expect(s.query.mock.calls.some(([sql]) => sql.startsWith("INSERT"))).toBe(false);
    expect(s.query).toHaveBeenCalledWith("ROLLBACK");
  });
  it.each([/INSERT INTO core.notes/, /INSERT INTO core.note_revisions/, /UPDATE core.notes/, /INSERT INTO core.project_bindings/, /^COMMIT$/])("rolls back create failures at %s and releases the client", async fail => {
    const s = fake({ exists: false, fail });
    await expect(s.store.create({ ...ids, content: "x", contentSha256: sha256NoteContent("x") })).rejects.toThrow("injected");
    expect(s.query).toHaveBeenCalledWith("ROLLBACK"); expect(s.release).toHaveBeenCalledOnce();
  });
  it("locks the current Note and rejects stale base before any insert", async () => {
    const s = fake();
    await expect(s.store.appendRevision({ ...ids, baseRevisionId: r1, content: "stale", contentSha256: sha256NoteContent("stale") })).rejects.toBeInstanceOf(StaleNoteRevisionError);
    expect(s.query).toHaveBeenCalledWith(expect.stringMatching(/FROM core.notes n[\s\S]*FOR UPDATE OF n/), [noteId]);
    expect(s.query.mock.calls.some(([sql]) => sql.startsWith("INSERT") || sql.startsWith("UPDATE"))).toBe(false);
    expect(s.query).toHaveBeenCalledWith("ROLLBACK"); expect(s.release).toHaveBeenCalledOnce();
  });
  it("appends R2 and its single parent, advances the pointer, never updates old revisions", async () => {
    const s = fake({ firstRevision: true }); const content = "second version";
    const note = await s.store.appendRevision({ ...ids, baseRevisionId: r1, content, contentSha256: sha256NoteContent(content) });
    expect(note.currentRevision).toMatchObject({ revisionNo: 2, content, contentSha256: sha256NoteContent(content) });
    expect(note.revisions.map(r => r.revisionNo)).toEqual([2, 1]);
    const calls = s.query.mock.calls;
    expect(calls.filter(([sql]) => sql.startsWith("INSERT INTO core.note_revisions"))).toHaveLength(1);
    expect(calls.filter(([sql]) => sql.startsWith("INSERT INTO core.note_revision_parents"))).toEqual([[expect.stringMatching(/parent_order[\s\S]*1\)/), [noteId, note.currentRevision.revisionId, r1]]]);
    expect(s.query).toHaveBeenCalledWith(expect.stringMatching(/^UPDATE core.notes/), [noteId, note.currentRevision.revisionId, 3]);
    expect(calls.some(([sql]) => /^(UPDATE|DELETE FROM) core.note_revisions/.test(sql))).toBe(false);
    expect(calls.findIndex(([sql]) => sql.includes("FOR UPDATE OF n"))).toBeLessThan(calls.findIndex(([sql]) => sql.startsWith("INSERT")));
    expect(calls.at(-1)![0]).toBe("COMMIT"); expect(s.release).toHaveBeenCalledOnce();
  });
  it.each([{ exists: false }, { noteState: "ARCHIVED" }, { missingCurrent: true }])("append rejects missing/inactive/inconsistent Note %j", async options => {
    const s = fake(options);
    const operation = s.store.appendRevision({ ...ids, baseRevisionId: r2, content: "new", contentSha256: sha256NoteContent("new") });
    if (options.exists === false) await expect(operation).rejects.toBeInstanceOf(ProjectItemNoteNotFoundError);
    else if (options.noteState) await expect(operation).rejects.toBeInstanceOf(ProjectItemInactiveError);
    else await expect(operation).rejects.toThrow("integrity");
    expect(s.query.mock.calls.some(([sql]) => sql.startsWith("INSERT") || sql.startsWith("UPDATE"))).toBe(false);
  });
  it.each([/INSERT INTO core.note_revisions/, /INSERT INTO core.note_revision_parents/, /UPDATE core.notes/, /^COMMIT$/])("rolls back append failure at %s", async fail => {
    const s = fake({ fail });
    await expect(s.store.appendRevision({ ...ids, baseRevisionId: r2, content: "new", contentSha256: sha256NoteContent("new") })).rejects.toThrow("injected");
    expect(s.query).toHaveBeenCalledWith("ROLLBACK"); expect(s.release).toHaveBeenCalledOnce();
  });
});
