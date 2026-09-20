import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  ProjectItemInactiveError, ProjectItemNotFoundError, ProjectItemNoteAlreadyExistsError,
  ProjectItemNoteNotFoundError, ProjectItemNoteRevisionNotFoundError, ProjectItemNoteStoreUnavailableError, StaleNoteRevisionError,
  type ProjectItemNoteStore,
} from "../application/project-item-notes.js";
import type { ProjectItemNote, ProjectItemNoteRevision, ProjectItemNoteRevisionSummary } from "../domain/note.js";

interface Subject { binding_id: string; edition_id: string; project_state: string; edition_state: string }
interface NoteBinding { note_id: string; binding_role: string | null; metadata: unknown }
interface NoteRow {
  id: string; note_type: string; lifecycle_state: string; current_revision_id: string | null;
  next_revision_no: string; created_at: Date; updated_at: Date;
}
interface RevisionRow {
  id: string; note_id: string; revision_no: string; content_format: string;
  content: string; content_sha256: string; created_at: Date;
}
type SubjectInput = { projectId: string; bindingId: string };

function integrity(): never { throw new Error("Project item note integrity error."); }
function revisionNumber(value: string | number): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) integrity();
  return number;
}
function summary(row: Pick<RevisionRow, "id" | "revision_no" | "created_at">): ProjectItemNoteRevisionSummary {
  return { revisionId: row.id, revisionNo: revisionNumber(row.revision_no), createdAt: row.created_at.toISOString() };
}
function revision(row: RevisionRow): ProjectItemNoteRevision {
  if (row.content_format !== "MARKDOWN" || !/^[0-9a-f]{64}$/.test(row.content_sha256)) integrity();
  return { ...summary(row), contentFormat: "MARKDOWN", content: row.content, contentSha256: row.content_sha256 };
}
async function transaction<T>(pool: Pool, readOnly: boolean, operation: (client: PoolClient) => Promise<T>): Promise<T> {
  try {
    const client = await pool.connect();
    try {
      await client.query(readOnly ? "BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY" : "BEGIN");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally { client.release(); }
  } catch (error) {
    const { code, message } = (error ?? {}) as { code?: string; message?: string };
    if (/^(ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EPIPE|08[0-9A-Z]{3}|57P0[123]|53300)$/.test(code ?? "")
      || /connection (terminated|timeout)|timeout exceeded|query read timeout/i.test(message ?? "")) {
      throw new ProjectItemNoteStoreUnavailableError("NOTE_STORE_UNAVAILABLE");
    }
    throw error;
  }
}
async function readSubject(client: PoolClient, input: SubjectInput, lock: boolean): Promise<Subject> {
  const result = await client.query<Subject>(`SELECT pb.id AS binding_id, pb.target_id AS edition_id,
    p.lifecycle_state AS project_state, e.lifecycle_state AS edition_state
    FROM core.project_bindings pb
    JOIN core.projects p ON p.id = pb.project_id
    JOIN core.editions e ON pb.target_type = 'EDITION' AND e.id = pb.target_id
    WHERE pb.id = $1 AND pb.project_id = $2 AND pb.target_type = 'EDITION'
    ${lock ? "FOR UPDATE OF pb" : ""}`, [input.bindingId, input.projectId]);
  const subject = result.rows[0];
  if (!subject) throw new ProjectItemNotFoundError("PROJECT_ITEM_NOT_FOUND");
  if (subject.project_state !== "ACTIVE" || subject.edition_state !== "ACTIVE") throw new ProjectItemInactiveError("PROJECT_ITEM_INACTIVE");
  return subject;
}
async function noteBindings(client: PoolClient, projectId: string, bindingId: string): Promise<NoteBinding[]> {
  // Include malformed roles so existing relationships cannot silently become "no Note".
  return (await client.query<NoteBinding>(`SELECT nb.target_id AS note_id, nb.binding_role, nb.metadata
    FROM core.project_bindings nb
    WHERE nb.project_id = $1 AND nb.target_type = 'NOTE'
      AND nb.metadata->>'subjectBindingId' = $2`, [projectId, bindingId])).rows;
}
async function ownedNote(client: PoolClient, projectId: string, subject: Subject, lock = false): Promise<NoteRow | null> {
  const bindings = await noteBindings(client, projectId, subject.binding_id);
  if (!bindings.length) return null;
  if (bindings.length !== 1) integrity();
  const binding = bindings[0];
  const metadata = binding.metadata as Record<string, unknown> | null;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)
    || binding.binding_role !== "ANNOTATION" || metadata.subjectBindingId !== subject.binding_id
    || metadata.subjectType !== "EDITION" || metadata.subjectId !== subject.edition_id) integrity();
  const result = await client.query<NoteRow>(`SELECT n.id, n.note_type, n.lifecycle_state,
    n.current_revision_id, n.next_revision_no, n.created_at, n.updated_at
    FROM core.notes n WHERE n.id = $1 ${lock ? "FOR UPDATE OF n" : ""}`, [binding.note_id]);
  const note = result.rows[0];
  if (!note || note.note_type !== "PROJECT_ITEM_NOTE" || !note.current_revision_id) integrity();
  if (note.lifecycle_state !== "ACTIVE") throw new ProjectItemInactiveError("NOTE_INACTIVE");
  revisionNumber(note.next_revision_no);
  return note;
}
async function projectNote(client: PoolClient, projectId: string, subject: Subject, note: NoteRow): Promise<ProjectItemNote> {
  const current = (await client.query<RevisionRow>(`SELECT id, note_id, revision_no, content_format, content, content_sha256, created_at
    FROM core.note_revisions WHERE note_id = $1 AND id = $2`, [note.id, note.current_revision_id])).rows[0];
  if (!current) integrity();
  const revisions = (await client.query<RevisionRow>(`SELECT id, revision_no, created_at
    FROM core.note_revisions WHERE note_id = $1 ORDER BY revision_no DESC`, [note.id])).rows.map(summary);
  if (revisions[0]?.revisionId !== current.id || revisionNumber(note.next_revision_no) !== revisionNumber(current.revision_no) + 1) integrity();
  return {
    noteId: note.id, projectId, subjectBindingId: subject.binding_id, subjectId: subject.edition_id,
    createdAt: note.created_at.toISOString(), updatedAt: note.updated_at.toISOString(), currentRevision: revision(current), revisions,
  };
}
async function insertRevision(client: PoolClient, noteId: string, revisionNo: number, content: string, hash: string) {
  const id = randomUUID();
  await client.query(`INSERT INTO core.note_revisions
    (id, note_id, revision_no, title, content_format, content, content_sha256, change_summary)
    VALUES ($1, $2, $3, NULL, 'MARKDOWN', $4, $5, NULL)`, [id, noteId, revisionNo, content, hash]);
  return id;
}
async function advanceNote(client: PoolClient, noteId: string, revisionId: string, nextRevisionNo: number) {
  await client.query(`UPDATE core.notes SET current_revision_id = $2, next_revision_no = $3, updated_at = now()
    WHERE id = $1`, [noteId, revisionId, nextRevisionNo]);
}

export function createPostgresProjectItemNoteStore(pool: Pool): ProjectItemNoteStore {
  return {
    get(input) {
      return transaction(pool, true, async client => {
        const subject = await readSubject(client, input, false);
        const note = await ownedNote(client, input.projectId, subject);
        return note ? projectNote(client, input.projectId, subject, note) : null;
      });
    },
    create(input) {
      return transaction(pool, false, async client => {
        const subject = await readSubject(client, input, true);
        if ((await noteBindings(client, input.projectId, subject.binding_id)).length) throw new ProjectItemNoteAlreadyExistsError("NOTE_ALREADY_EXISTS");
        const noteId = randomUUID();
        await client.query(`INSERT INTO core.notes
          (id, note_type, lifecycle_state, current_revision_id, next_revision_no, metadata)
          VALUES ($1, 'PROJECT_ITEM_NOTE', 'ACTIVE', NULL, 1, '{}'::jsonb)`, [noteId]);
        const revisionId = await insertRevision(client, noteId, 1, input.content, input.contentSha256);
        await advanceNote(client, noteId, revisionId, 2);
        await client.query(`INSERT INTO core.project_bindings
          (id, project_id, target_type, target_id, binding_role, metadata)
          VALUES ($1, $2, 'NOTE', $3, 'ANNOTATION', $4::jsonb)`,
        [randomUUID(), input.projectId, noteId, JSON.stringify({ subjectBindingId: subject.binding_id, subjectType: "EDITION", subjectId: subject.edition_id })]);
        const note = await ownedNote(client, input.projectId, subject);
        if (!note) integrity();
        return projectNote(client, input.projectId, subject, note);
      });
    },
    appendRevision(input) {
      return transaction(pool, false, async client => {
        const subject = await readSubject(client, input, false);
        const note = await ownedNote(client, input.projectId, subject, true);
        if (!note) throw new ProjectItemNoteNotFoundError("NOTE_NOT_FOUND");
        if (input.baseRevisionId !== note.current_revision_id) throw new StaleNoteRevisionError("STALE_NOTE_REVISION");
        const revisionNo = revisionNumber(note.next_revision_no);
        const revisionId = await insertRevision(client, note.id, revisionNo, input.content, input.contentSha256);
        await client.query(`INSERT INTO core.note_revision_parents
          (note_id, child_revision_id, parent_revision_id, parent_order)
          VALUES ($1, $2, $3, 1)`, [note.id, revisionId, note.current_revision_id]);
        await advanceNote(client, note.id, revisionId, revisionNo + 1);
        const updated = await ownedNote(client, input.projectId, subject);
        if (!updated) integrity();
        return projectNote(client, input.projectId, subject, updated);
      });
    },
    getRevision(input) {
      return transaction(pool, true, async client => {
        const subject = await readSubject(client, input, false);
        const note = await ownedNote(client, input.projectId, subject);
        if (!note) throw new ProjectItemNoteNotFoundError("NOTE_NOT_FOUND");
        const result = await client.query<RevisionRow>(`SELECT r.id, r.note_id, r.revision_no, r.content_format, r.content, r.content_sha256, r.created_at
          FROM core.note_revisions r JOIN core.project_bindings nb ON nb.target_type = 'NOTE' AND nb.target_id = r.note_id
          WHERE r.note_id = $1 AND r.id = $2 AND nb.project_id = $3 AND nb.binding_role = 'ANNOTATION'
            AND nb.metadata->>'subjectBindingId' = $4`, [note.id, input.revisionId, input.projectId, subject.binding_id]);
        if (!result.rows[0]) throw new ProjectItemNoteRevisionNotFoundError("NOTE_REVISION_NOT_FOUND");
        return revision(result.rows[0]);
      });
    },
  };
}
