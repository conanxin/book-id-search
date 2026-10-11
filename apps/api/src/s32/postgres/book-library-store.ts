import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { BookLibraryStore, LibrarySubject } from "../application/book-library.js";
import {
  LibraryError, type BookNote, type BookNoteInput, type BookNoteRevision,
  type BookResource, type BookWorkspace, type LibraryBookSummary,
} from "../domain/book-library.js";

interface BookRow {
  catalog_book_id: string; edition_id: string; catalog_source_id: string;
  introduction: string; version: number; updated_at: Date;
}
interface NoteRow {
  id: string; current_revision_id: string; next_revision_no: string;
  title: string; content: string; revision_no: string; created_at: Date; updated_at: Date;
}
interface RevisionRow {
  id: string; note_id: string; revision_no: string; title: string; content: string; created_at: Date;
}
interface ResourceRow {
  resource_id: string; label: string; remote_uri: string; format: string;
  version_label: string; notes: string; created_at: Date; updated_at: Date;
}
interface SummaryRow {
  catalog_book_id: string; edition_id: string; title: string; author: string;
  publisher: string; year: number | null; introduction_excerpt: string;
  note_count: number; resource_count: number; updated_at: Date;
  search_note_id: string | null; search_note_title: string | null; search_excerpt: string | null;
}

function number(value: string | number): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1) throw new LibraryError("LIBRARY_INTEGRITY_ERROR");
  return result;
}

function revision(row: RevisionRow): BookNoteRevision {
  return { revisionId: row.id, revisionNo: number(row.revision_no), title: row.title ?? "", content: row.content, createdAt: row.created_at.toISOString() };
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
    if (/^(ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EPIPE|08[0-9A-Z]{3}|57P0[123]|53300|42P01|42501)$/.test(code ?? "")
      || /connection (terminated|timeout)|timeout exceeded|query read timeout/i.test(message ?? "")) {
      throw new LibraryError("LIBRARY_UNAVAILABLE");
    }
    throw error;
  }
}

async function bookRow(client: PoolClient, bookId: string, lock = false): Promise<BookRow | null> {
  const result = await client.query<BookRow>(`SELECT catalog_book_id, edition_id, catalog_source_id, introduction, version, updated_at
    FROM core.library_books WHERE catalog_book_id = $1 ${lock ? "FOR UPDATE" : ""}`, [bookId]);
  return result.rows[0] ?? null;
}

async function requireBook(client: PoolClient, bookId: string): Promise<BookRow> {
  const row = await bookRow(client, bookId, true);
  if (!row) throw new LibraryError("LIBRARY_BOOK_NOT_FOUND");
  const edition = await client.query<{ lifecycle_state: string }>("SELECT lifecycle_state FROM core.editions WHERE id = $1", [row.edition_id]);
  if (edition.rows[0]?.lifecycle_state !== "ACTIVE") throw new LibraryError("LIBRARY_BOOK_READ_ONLY");
  return row;
}

async function ensureBook(client: PoolClient, input: LibrarySubject): Promise<{ row: BookRow; created: boolean }> {
  // Read catalog identity and canonical relationships instead of copying or
  // replacing the imported metadata. No Project or ProjectBinding is created.
  const inserted = await client.query(`INSERT INTO core.library_books (catalog_book_id, edition_id, catalog_source_id)
    SELECT $1, e.id, s.id
    FROM core.editions e JOIN core.sources s ON s.edition_id = e.id
    JOIN core.external_identities ei ON ei.target_type = 'SOURCE' AND ei.target_id = s.id
    WHERE e.id = $2 AND s.id = $3 AND e.lifecycle_state = 'ACTIVE'
      AND ei.provider = 'BOOK_ID_SEARCH' AND ei.namespace = 'CATALOG_DOCUMENT'
      AND ei.external_id = $1 AND ei.binding_state <> 'RETIRED'
    ON CONFLICT (catalog_book_id) DO NOTHING RETURNING catalog_book_id`, [input.bookId, input.editionId, input.sourceId]);
  const row = await requireBook(client, input.bookId);
  if (row.edition_id !== input.editionId || row.catalog_source_id !== input.sourceId) throw new LibraryError("LIBRARY_CATALOG_ID_MISMATCH");
  return { row, created: inserted.rowCount === 1 };
}

async function touchBook(client: PoolClient, bookId: string) {
  await client.query("UPDATE core.library_books SET updated_at = clock_timestamp() WHERE catalog_book_id = $1", [bookId]);
}

async function workspace(client: PoolClient, bookId: string): Promise<BookWorkspace | null> {
  const book = await bookRow(client, bookId);
  if (!book) return null;
  const noteRows = (await client.query<NoteRow>(`SELECT n.id, n.current_revision_id, n.next_revision_no, n.created_at, n.updated_at,
    r.title, r.content, r.revision_no
    FROM core.library_book_notes b JOIN core.notes n ON n.id = b.note_id
    JOIN core.note_revisions r ON r.note_id = n.id AND r.id = n.current_revision_id
    WHERE b.catalog_book_id = $1 AND n.note_type = 'BOOK_LIBRARY_NOTE' AND n.lifecycle_state = 'ACTIVE'
    ORDER BY n.updated_at DESC, n.id`, [bookId])).rows;
  const histories = noteRows.length ? (await client.query<RevisionRow>(`SELECT id, note_id, revision_no, created_at
    FROM core.note_revisions WHERE note_id = ANY($1::uuid[]) ORDER BY revision_no DESC`, [noteRows.map(row => row.id)])).rows : [];
  const notes: BookNote[] = noteRows.map(row => ({
    noteId: row.id, title: row.title ?? "", content: row.content,
    currentRevisionId: row.current_revision_id, revisionNo: number(row.revision_no),
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
    revisions: histories.filter(history => history.note_id === row.id).map(history => ({
      revisionId: history.id, revisionNo: number(history.revision_no), createdAt: history.created_at.toISOString(),
    })),
  }));
  const resourceRows = (await client.query<ResourceRow>(`SELECT r.resource_id, r.label, r.format, r.version_label, r.notes, r.created_at, r.updated_at, a.remote_uri
    FROM core.library_book_resources r JOIN core.source_assets a ON a.id = r.resource_id
    JOIN core.sources s ON s.id = a.source_id
    WHERE r.catalog_book_id = $1 AND r.removed_at IS NULL AND a.storage_mode = 'REMOTE' AND s.edition_id = $2
    ORDER BY r.created_at DESC, r.resource_id`, [bookId, book.edition_id])).rows;
  const resources: BookResource[] = resourceRows.map(row => ({
    resourceId: row.resource_id, label: row.label, url: row.remote_uri,
    format: row.format, versionLabel: row.version_label, notes: row.notes,
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
  }));
  return { bookId, saved: true, editionId: book.edition_id, introduction: book.introduction,
    version: number(book.version), updatedAt: book.updated_at.toISOString(), notes, resources };
}

async function savedWorkspace(client: PoolClient, bookId: string): Promise<BookWorkspace> {
  const result = await workspace(client, bookId);
  if (!result) throw new LibraryError("LIBRARY_INTEGRITY_ERROR");
  return result;
}

async function ownedNote(client: PoolClient, bookId: string, noteId: string, lock = false) {
  const result = await client.query<Pick<NoteRow, "id" | "current_revision_id" | "next_revision_no">>(`SELECT n.id, n.current_revision_id, n.next_revision_no
    FROM core.library_book_notes b JOIN core.notes n ON n.id = b.note_id
    WHERE b.catalog_book_id = $1 AND b.note_id = $2 AND n.note_type = 'BOOK_LIBRARY_NOTE' AND n.lifecycle_state = 'ACTIVE'
    ${lock ? "FOR UPDATE OF n" : ""}`, [bookId, noteId]);
  const row = result.rows[0];
  if (!row) throw new LibraryError("LIBRARY_NOTE_NOT_FOUND");
  return row;
}

async function insertRevision(client: PoolClient, noteId: string, revisionNo: number, input: BookNoteInput): Promise<string> {
  const revisionId = randomUUID();
  await client.query(`INSERT INTO core.note_revisions (id, note_id, revision_no, title, content_format, content, content_sha256)
    VALUES ($1, $2, $3, $4, 'MARKDOWN', $5, $6)`,
  [revisionId, noteId, revisionNo, input.title, input.content, createHash("sha256").update(input.content, "utf8").digest("hex")]);
  return revisionId;
}

async function advanceNote(client: PoolClient, noteId: string, revisionId: string, nextRevisionNo: number) {
  await client.query(`UPDATE core.notes SET current_revision_id = $2, next_revision_no = $3, updated_at = clock_timestamp()
    WHERE id = $1`, [noteId, revisionId, nextRevisionNo]);
}

async function ownedResource(client: PoolClient, bookId: string, resourceId: string, editionId: string) {
  const result = await client.query(`SELECT r.resource_id FROM core.library_book_resources r
    JOIN core.source_assets a ON a.id = r.resource_id JOIN core.sources s ON s.id = a.source_id
    WHERE r.catalog_book_id = $1 AND r.resource_id = $2 AND r.removed_at IS NULL
      AND a.storage_mode = 'REMOTE' AND s.edition_id = $3 FOR UPDATE OF r`, [bookId, resourceId, editionId]);
  if (result.rowCount !== 1) throw new LibraryError("LIBRARY_RESOURCE_NOT_FOUND");
}

export function createPostgresBookLibraryStore(pool: Pool): BookLibraryStore {
  return {
    subject(bookId) {
      return transaction(pool, true, async client => {
        const row = await bookRow(client, bookId);
        return row ? { bookId, editionId: row.edition_id, sourceId: row.catalog_source_id } : null;
      });
    },
    get(bookId) { return transaction(pool, true, client => workspace(client, bookId)); },
    list(input) {
      return transaction(pool, true, async client => {
        // At most one current, active library Note per book: note matches do
        // not multiply books or change count/pagination. The ordinary list
        // does not join revisions or read any Note title/content at all.
        const matchingNote = input.q ? `LEFT JOIN LATERAL (
          SELECT n.id, COALESCE(r.title, '') AS title,
            CASE WHEN strpos(lower(COALESCE(r.title, '')), lower($1)) > 0
              THEN r.title ELSE r.content END AS match_text
          FROM core.library_book_notes bn JOIN core.notes n ON n.id = bn.note_id
          JOIN core.note_revisions r ON r.note_id = n.id AND r.id = n.current_revision_id
          WHERE bn.catalog_book_id = b.catalog_book_id
            AND n.note_type = 'BOOK_LIBRARY_NOTE' AND n.lifecycle_state = 'ACTIVE'
            AND (strpos(lower(COALESCE(r.title, '')), lower($1)) > 0 OR strpos(lower(r.content), lower($1)) > 0)
          ORDER BY n.updated_at DESC, n.id LIMIT 1
        ) matched_note ON true` : "";
        const searchColumns = input.q ? `matched_note.id AS search_note_id, matched_note.title AS search_note_title,
            CASE WHEN matched_note.id IS NOT NULL THEN matched_note.match_text
              WHEN strpos(lower(b.introduction), lower($1)) > 0 THEN b.introduction END AS search_text`
          : "NULL::uuid AS search_note_id, NULL::text AS search_note_title, NULL::text AS search_text";
        const cte = `WITH summaries AS (
          SELECT b.catalog_book_id, b.edition_id, w.title,
            COALESCE(s.metadata->'catalogDocument'->>'author', '') AS author,
            COALESCE(e.publisher, '') AS publisher,
            EXTRACT(YEAR FROM e.publication_date)::int AS year,
            left(b.introduction, 180) AS introduction_excerpt, b.introduction, b.updated_at,
            ${searchColumns},
            (SELECT count(*)::int FROM core.library_book_notes bn JOIN core.notes n ON n.id = bn.note_id
              WHERE bn.catalog_book_id = b.catalog_book_id AND n.note_type = 'BOOK_LIBRARY_NOTE' AND n.lifecycle_state = 'ACTIVE') AS note_count,
            (SELECT count(*)::int FROM core.library_book_resources r
              WHERE r.catalog_book_id = b.catalog_book_id AND r.removed_at IS NULL) AS resource_count
          FROM core.library_books b JOIN core.editions e ON e.id = b.edition_id
          JOIN core.works w ON w.id = e.work_id JOIN core.sources s ON s.id = b.catalog_source_id
          ${matchingNote}
        )`;
        const where = `WHERE ($1 = '' OR strpos(lower(title || ' ' || author || ' ' || publisher || ' ' || introduction), lower($1)) > 0
            OR search_note_id IS NOT NULL)
          AND ($2 = 'all' OR ($2 = 'introduction' AND length(btrim(introduction)) > 0)
            OR ($2 = 'notes' AND note_count > 0) OR ($2 = 'resources' AND resource_count > 0))`;
        const total = (await client.query<{ total: number }>(`${cte} SELECT count(*)::int AS total FROM summaries ${where}`, [input.q, input.filter])).rows[0].total;
        // PostgreSQL substring/char_length count Unicode characters, not JS
        // UTF-16 units. Keep the whole query in a 240-character window and
        // return only that window, with ellipses for omitted surrounding text.
        const excerptStart = "GREATEST(1, strpos(lower(search_text), lower($1)) - LEAST(60, GREATEST(0, (240 - char_length($1)) / 2)))";
        const rows = (await client.query<SummaryRow>(`${cte} SELECT catalog_book_id, edition_id, title, author, publisher, year,
            introduction_excerpt, note_count, resource_count, updated_at, search_note_id, search_note_title,
            CASE WHEN search_text IS NOT NULL THEN
              CASE WHEN ${excerptStart} > 1 THEN '…' ELSE '' END
              || substring(search_text FROM ${excerptStart} FOR 240)
              || CASE WHEN char_length(search_text) >= ${excerptStart} + 240 THEN '…' ELSE '' END
            END AS search_excerpt
          FROM summaries ${where}
          ORDER BY updated_at DESC, catalog_book_id LIMIT $3 OFFSET $4`, [input.q, input.filter, input.limit, (input.page - 1) * input.limit])).rows;
        const items: LibraryBookSummary[] = rows.map(row => ({
          bookId: row.catalog_book_id, editionId: row.edition_id, title: row.title, author: row.author,
          publisher: row.publisher, year: row.year, introductionExcerpt: row.introduction_excerpt,
          noteCount: row.note_count, resourceCount: row.resource_count, updatedAt: row.updated_at.toISOString(),
          searchMatch: row.search_excerpt === null ? null : row.search_note_id
            ? { kind: "note", noteId: row.search_note_id, noteTitle: row.search_note_title ?? "", excerpt: row.search_excerpt }
            : { kind: "introduction", excerpt: row.search_excerpt },
        }));
        return { items, total, page: input.page, limit: input.limit };
      });
    },
    save(input) {
      return transaction(pool, false, async client => {
        const { row, created } = await ensureBook(client, input);
        if (input.introduction !== undefined) {
          if (input.baseVersion !== (created ? 0 : row.version)) throw new LibraryError("LIBRARY_STALE_VERSION");
          if (created || input.introduction !== row.introduction) {
            await client.query(`UPDATE core.library_books SET introduction = $2, version = $3, updated_at = clock_timestamp()
              WHERE catalog_book_id = $1`, [input.bookId, input.introduction, created ? 1 : row.version + 1]);
          }
        }
        return savedWorkspace(client, input.bookId);
      });
    },
    createNote(input) {
      return transaction(pool, false, async client => {
        await ensureBook(client, input);
        const noteId = randomUUID();
        await client.query("INSERT INTO core.notes (id, note_type) VALUES ($1, 'BOOK_LIBRARY_NOTE')", [noteId]);
        const revisionId = await insertRevision(client, noteId, 1, input);
        await advanceNote(client, noteId, revisionId, 2);
        await client.query("INSERT INTO core.library_book_notes (note_id, catalog_book_id) VALUES ($1, $2)", [noteId, input.bookId]);
        await touchBook(client, input.bookId);
        return savedWorkspace(client, input.bookId);
      });
    },
    updateNote(input) {
      return transaction(pool, false, async client => {
        await requireBook(client, input.bookId);
        const note = await ownedNote(client, input.bookId, input.noteId, true);
        if (note.current_revision_id !== input.baseRevisionId) throw new LibraryError("LIBRARY_STALE_NOTE_REVISION");
        const revisionNo = number(note.next_revision_no);
        const revisionId = await insertRevision(client, note.id, revisionNo, input);
        await client.query(`INSERT INTO core.note_revision_parents (note_id, child_revision_id, parent_revision_id)
          VALUES ($1, $2, $3)`, [note.id, revisionId, note.current_revision_id]);
        await advanceNote(client, note.id, revisionId, revisionNo + 1);
        await touchBook(client, input.bookId);
        return savedWorkspace(client, input.bookId);
      });
    },
    deleteNote(input) {
      return transaction(pool, false, async client => {
        await requireBook(client, input.bookId);
        await ownedNote(client, input.bookId, input.noteId, true);
        await client.query("UPDATE core.notes SET lifecycle_state = 'ARCHIVED', updated_at = clock_timestamp() WHERE id = $1", [input.noteId]);
        await touchBook(client, input.bookId);
        return savedWorkspace(client, input.bookId);
      });
    },
    getRevision(input) {
      return transaction(pool, true, async client => {
        await ownedNote(client, input.bookId, input.noteId);
        const row = (await client.query<RevisionRow>(`SELECT id, note_id, revision_no, title, content, created_at
          FROM core.note_revisions WHERE note_id = $1 AND id = $2`, [input.noteId, input.revisionId])).rows[0];
        if (!row) throw new LibraryError("LIBRARY_REVISION_NOT_FOUND");
        return revision(row);
      });
    },
    createResource(input) {
      return transaction(pool, false, async client => {
        await ensureBook(client, input);
        const resourceId = randomUUID(), sourceId = randomUUID();
        await client.query(`INSERT INTO core.sources (id, source_type, edition_id, metadata)
          VALUES ($1, 'PUBLICATION', $2, $3::jsonb)`, [sourceId, input.editionId, JSON.stringify({ origin: "BOOK_LIBRARY_RESOURCE", catalogBookId: input.bookId })]);
        await client.query(`INSERT INTO core.source_assets (id, source_id, asset_type, asset_role, storage_mode, remote_uri, metadata)
          VALUES ($1, $2, 'DOCUMENT', 'ORIGINAL', 'REMOTE', $3, '{"registrationOnly":true}'::jsonb)`, [resourceId, sourceId, input.url]);
        await client.query(`INSERT INTO core.library_book_resources (resource_id, catalog_book_id, label, format, version_label, notes)
          VALUES ($1, $2, $3, $4, $5, $6)`, [resourceId, input.bookId, input.label, input.format, input.versionLabel, input.notes]);
        await touchBook(client, input.bookId);
        return savedWorkspace(client, input.bookId);
      });
    },
    updateResource(input) {
      return transaction(pool, false, async client => {
        const book = await requireBook(client, input.bookId);
        await ownedResource(client, input.bookId, input.resourceId, book.edition_id);
        await client.query("UPDATE core.source_assets SET remote_uri = $2 WHERE id = $1", [input.resourceId, input.url]);
        await client.query(`UPDATE core.library_book_resources SET label = $2, format = $3, version_label = $4, notes = $5, updated_at = clock_timestamp()
          WHERE resource_id = $1`, [input.resourceId, input.label, input.format, input.versionLabel, input.notes]);
        await touchBook(client, input.bookId);
        return savedWorkspace(client, input.bookId);
      });
    },
    deleteResource(input) {
      return transaction(pool, false, async client => {
        const book = await requireBook(client, input.bookId);
        await ownedResource(client, input.bookId, input.resourceId, book.edition_id);
        await client.query("UPDATE core.library_book_resources SET removed_at = clock_timestamp(), updated_at = clock_timestamp() WHERE resource_id = $1", [input.resourceId]);
        await touchBook(client, input.bookId);
        return savedWorkspace(client, input.bookId);
      });
    },
  };
}
