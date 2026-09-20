import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { EditionNotAvailableError, ProjectBindingStoreUnavailableError, ProjectNotActiveError, ProjectNotFoundError, type ProjectBindingStore } from "../application/project-items.js";
import type { ProjectResearchItem } from "../domain/project-item.js";

interface ItemRow {
  binding_id: string; project_id: string; work_id: string; edition_id: string;
  metadata: unknown; title: string; publisher: string | null; publication_date: string | null;
  publication_date_precision: ProjectResearchItem["publicationDatePrecision"];
  isbn: string | null; created_at: Date;
}
const PROJECTION = `SELECT pb.id AS binding_id, pb.project_id, pb.metadata, pb.created_at,
  e.id AS edition_id, e.work_id, e.publisher, e.publication_date::text,
  e.publication_date_precision, e.isbn, w.title
  FROM core.project_bindings pb
  JOIN core.editions e ON pb.target_type = 'EDITION' AND e.id = pb.target_id
  JOIN core.works w ON w.id = e.work_id
  WHERE pb.project_id = $1 AND pb.target_type = 'EDITION'`;
function toItem(row: ItemRow): ProjectResearchItem {
  const metadata = row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
    ? row.metadata as Record<string, unknown> : {};
  const text = (value: unknown) => typeof value === "string" && value.trim() ? value : null;
  return {
    bindingId: row.binding_id, projectId: row.project_id, workId: row.work_id, editionId: row.edition_id,
    sourceId: text(metadata.sourceId), catalogBookId: text(metadata.catalogBookId),
    title: row.title, publisher: row.publisher, publicationDate: row.publication_date,
    publicationDatePrecision: row.publication_date_precision, isbn: row.isbn, addedAt: row.created_at.toISOString(),
  };
}
async function classify<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    const { code, message } = (error ?? {}) as { code?: string; message?: string };
    if (/^(ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EPIPE|08[0-9A-Z]{3}|57P0[123]|53300)$/.test(code ?? "")
      || /connection (terminated|timeout)|timeout exceeded|query read timeout/i.test(message ?? "")) {
      throw new ProjectBindingStoreUnavailableError("PROJECT_BINDING_STORE_UNAVAILABLE");
    }
    throw error;
  }
}
export function createPostgresProjectBindingStore(pool: Pool): ProjectBindingStore {
  return {
    addEdition(input) {
      return classify(async () => {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          // Promotion already committed. Recheck mutable parents inside this binding transaction.
          const project = await client.query("SELECT lifecycle_state FROM core.projects WHERE id = $1 FOR SHARE", [input.projectId]);
          if (!project.rows[0]) throw new ProjectNotFoundError("PROJECT_NOT_FOUND");
          if (project.rows[0].lifecycle_state !== "ACTIVE") throw new ProjectNotActiveError("PROJECT_NOT_ACTIVE");
          const edition = await client.query("SELECT id FROM core.editions WHERE id = $1 AND work_id = $2 AND lifecycle_state = 'ACTIVE' FOR SHARE", [input.editionId, input.workId]);
          if (!edition.rows[0]) throw new EditionNotAvailableError("EDITION_NOT_AVAILABLE");
          const inserted = await client.query(`INSERT INTO core.project_bindings (id, project_id, target_type, target_id, binding_role, metadata)
            VALUES ($1, $2, 'EDITION', $3, NULL, $4::jsonb)
            ON CONFLICT (project_id, target_type, target_id) DO NOTHING RETURNING id`,
          [randomUUID(), input.projectId, input.editionId, JSON.stringify({ addedVia: "BOOK_ID_SEARCH_CATALOG", catalogBookId: input.catalogBookId, sourceId: input.sourceId })]);
          // A separate READ COMMITTED statement sees the winning concurrent insert after its commit.
          const result = await client.query<ItemRow>(`${PROJECTION} AND pb.target_id = $2`, [input.projectId, input.editionId]);
          if (!result.rows[0]) throw new ProjectBindingStoreUnavailableError("PROJECT_BINDING_UNAVAILABLE");
          const item = toItem(result.rows[0]);
          await client.query("COMMIT");
          return { status: inserted.rows.length ? "created" as const : "existing" as const, item };
        } catch (error) {
          await client.query("ROLLBACK").catch(() => {});
          throw error;
        } finally { client.release(); }
      });
    },
    listEditionItems(projectId) {
      return classify(async () => (await pool.query<ItemRow>(`${PROJECTION} ORDER BY pb.created_at DESC, pb.id DESC`, [projectId])).rows.map(toItem));
    },
    removeEdition({ projectId, bindingId }) {
      return classify(async () => (await pool.query(`DELETE FROM core.project_bindings
        WHERE id = $1 AND project_id = $2 AND target_type = 'EDITION' RETURNING id`, [bindingId, projectId])).rowCount === 1);
    },
  };
}
