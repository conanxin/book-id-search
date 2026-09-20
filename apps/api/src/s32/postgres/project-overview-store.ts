import type { Pool, PoolClient } from "pg";
import {
  ProjectOverviewIntegrityError,
  ProjectOverviewStoreUnavailableError,
  type ProjectOverviewStore,
} from "../application/project-overview.js";
import {
  buildNoteExcerpt,
  type ProjectOverview,
  type ProjectOverviewItem,
  type ProjectOverviewNoteSummary,
} from "../domain/rediscover.js";

interface ProjectRow {
  id: string;
  name: string;
  metadata: unknown;
  lifecycle_state: string;
  created_at: Date;
  updated_at: Date;
}

interface ItemRow {
  binding_id: string;
  binding_metadata: unknown;
  added_at: Date;
  edition_id: string;
  work_id: string;
  publisher: string | null;
  publication_date: string | null;
  publication_date_precision: string;
  isbn: string | null;
  title: string;
  note_binding_id: string | null;
  note_id: string | null;
  note_binding_role: string | null;
  note_binding_metadata: unknown;
  note_type: string | null;
  note_lifecycle_state: string | null;
  current_revision_id: string | null;
  note_updated_at: Date | null;
  current_revision_actual_id: string | null;
  current_revision_note_id: string | null;
  current_revision_no: string | number | null;
  current_content_format: string | null;
  current_content: string | null;
  current_content_sha256: string | null;
}

function integrity(message: string): never {
  throw new ProjectOverviewIntegrityError(message);
}

function validDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

function iso(value: unknown, label: string): string {
  if (!validDate(value)) integrity(label);
  return value.toISOString();
}

function isConnectionError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return (
    (typeof code === "string" &&
      (/^08[0-9A-Z]{3}$/.test(code) ||
        /^(ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EPIPE|57P0[123]|53300)$/.test(code))) ||
    (typeof message === "string" &&
      /connection (terminated|timeout)|timeout exceeded|query read timeout/i.test(message))
  );
}

async function readOnlyTransaction<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  let client: PoolClient | null = null;
  try {
    client = await pool.connect();
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    if (client) await client.query("ROLLBACK").catch(() => {});
    if (
      error instanceof ProjectOverviewIntegrityError ||
      error instanceof ProjectOverviewStoreUnavailableError
    ) {
      throw error;
    }
    if (isConnectionError(error)) {
      throw new ProjectOverviewStoreUnavailableError("PROJECT_OVERVIEW_STORE_UNAVAILABLE");
    }
    throw error;
  } finally {
    client?.release();
  }
}

function optionalMetadataText(metadata: unknown, key: string): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function revisionNumber(value: string | number | null): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) integrity("CURRENT_REVISION_NUMBER_INVALID");
  return number;
}

function noteSummary(row: ItemRow): ProjectOverviewNoteSummary | null {
  if (row.note_binding_id === null) {
    if (
      row.note_id !== null ||
      row.note_binding_role !== null ||
      row.note_binding_metadata !== null ||
      row.note_type !== null ||
      row.note_lifecycle_state !== null ||
      row.current_revision_id !== null ||
      row.note_updated_at !== null ||
      row.current_revision_actual_id !== null ||
      row.current_revision_note_id !== null ||
      row.current_revision_no !== null ||
      row.current_content_format !== null ||
      row.current_content !== null ||
      row.current_content_sha256 !== null
    ) {
      integrity("NOTE_RELATION_PARTIAL");
    }
    return null;
  }

  const metadata =
    row.note_binding_metadata &&
    typeof row.note_binding_metadata === "object" &&
    !Array.isArray(row.note_binding_metadata)
      ? (row.note_binding_metadata as Record<string, unknown>)
      : null;

  if (
    !row.note_id ||
    row.note_binding_role !== "ANNOTATION" ||
    !metadata ||
    metadata.subjectBindingId !== row.binding_id ||
    metadata.subjectType !== "EDITION" ||
    metadata.subjectId !== row.edition_id ||
    row.note_type !== "PROJECT_ITEM_NOTE" ||
    row.note_lifecycle_state !== "ACTIVE" ||
    !row.current_revision_id ||
    row.current_revision_actual_id !== row.current_revision_id ||
    row.current_revision_note_id !== row.note_id ||
    row.current_content_format !== "MARKDOWN" ||
    typeof row.current_content !== "string" ||
    typeof row.current_content_sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(row.current_content_sha256) ||
    !validDate(row.note_updated_at)
  ) {
    integrity("NOTE_RELATION_INVALID");
  }

  return {
    noteId: row.note_id,
    currentRevisionId: row.current_revision_id,
    currentRevisionNo: revisionNumber(row.current_revision_no),
    excerpt: buildNoteExcerpt(row.current_content),
    updatedAt: row.note_updated_at.toISOString(),
  };
}

function toItem(row: ItemRow): ProjectOverviewItem {
  if (!["YEAR", "MONTH", "DAY"].includes(row.publication_date_precision)) {
    integrity("PUBLICATION_DATE_PRECISION_INVALID");
  }
  const addedAt = iso(row.added_at, "EDITION_BINDING_DATE_INVALID");
  const note = noteSummary(row);
  return {
    bindingId: row.binding_id,
    workId: row.work_id,
    editionId: row.edition_id,
    sourceId: optionalMetadataText(row.binding_metadata, "sourceId"),
    catalogBookId: optionalMetadataText(row.binding_metadata, "catalogBookId"),
    title: row.title,
    publisher: row.publisher,
    publicationDate: row.publication_date,
    publicationDatePrecision: row.publication_date_precision as "YEAR" | "MONTH" | "DAY",
    isbn: row.isbn,
    addedAt,
    activityAt: note?.updatedAt ?? addedAt,
    noteSummary: note,
  };
}

function descendingText(a: string, b: string): number {
  return a > b ? -1 : a < b ? 1 : 0;
}

export function createPostgresProjectOverviewStore(pool: Pool): ProjectOverviewStore {
  return {
    get(projectId) {
      return readOnlyTransaction(pool, async (client) => {
        const project = (
          await client.query<ProjectRow>(
            `SELECT id, name, metadata, lifecycle_state, created_at, updated_at
             FROM core.projects
             WHERE id = $1`,
            [projectId],
          )
        ).rows[0];

        if (!project) return null;
        if (project.lifecycle_state !== "ACTIVE" && project.lifecycle_state !== "ARCHIVED") {
          integrity("PROJECT_LIFECYCLE_INVALID");
        }

        const rows = (
          await client.query<ItemRow>(
            `SELECT
               pb.id AS binding_id,
               pb.metadata AS binding_metadata,
               pb.created_at AS added_at,
               e.id AS edition_id,
               e.work_id,
               e.publisher,
               e.publication_date::text,
               e.publication_date_precision,
               e.isbn,
               w.title,
               nb.id AS note_binding_id,
               nb.target_id AS note_id,
               nb.binding_role AS note_binding_role,
               nb.metadata AS note_binding_metadata,
               n.note_type,
               n.lifecycle_state AS note_lifecycle_state,
               n.current_revision_id,
               n.updated_at AS note_updated_at,
               r.id AS current_revision_actual_id,
               r.note_id AS current_revision_note_id,
               r.revision_no AS current_revision_no,
               r.content_format AS current_content_format,
               r.content AS current_content,
               r.content_sha256 AS current_content_sha256
             FROM core.project_bindings pb
             JOIN core.editions e
               ON pb.target_type = 'EDITION'
              AND e.id = pb.target_id
             JOIN core.works w
               ON w.id = e.work_id
             LEFT JOIN core.project_bindings nb
               ON nb.project_id = pb.project_id
              AND nb.target_type = 'NOTE'
              AND nb.metadata->>'subjectBindingId' = pb.id::text
             LEFT JOIN core.notes n
               ON n.id = nb.target_id
             LEFT JOIN core.note_revisions r
               ON r.note_id = n.id
              AND r.id = n.current_revision_id
             WHERE pb.project_id = $1
               AND pb.target_type = 'EDITION'
             ORDER BY pb.id, nb.id`,
            [projectId],
          )
        ).rows;

        const grouped = new Map<string, ItemRow[]>();
        for (const row of rows) {
          const values = grouped.get(row.binding_id) ?? [];
          values.push(row);
          grouped.set(row.binding_id, values);
        }

        const items: ProjectOverviewItem[] = [];
        for (const values of grouped.values()) {
          if (values.length !== 1) integrity("NOTE_RELATION_DUPLICATE");
          items.push(toItem(values[0]));
        }

        items.sort((a, b) => {
          const activity = descendingText(a.activityAt, b.activityAt);
          return activity !== 0 ? activity : descendingText(a.bindingId, b.bindingId);
        });

        const lifecycleState = project.lifecycle_state as "ACTIVE" | "ARCHIVED";
        const overview: ProjectOverview = {
          project: {
            id: project.id,
            name: project.name,
            description: optionalMetadataText(project.metadata, "description"),
            lifecycleState,
            readOnly: lifecycleState === "ARCHIVED",
            createdAt: iso(project.created_at, "PROJECT_CREATED_AT_INVALID"),
            updatedAt: iso(project.updated_at, "PROJECT_UPDATED_AT_INVALID"),
          },
          summary: {
            itemCount: items.length,
            noteCount: items.filter((item) => item.noteSummary !== null).length,
            lastActivityAt: items[0]?.activityAt ?? null,
          },
          items,
        };

        return overview;
      });
    },
  };
}
