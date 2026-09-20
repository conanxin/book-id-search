import type { Pool, PoolClient } from "pg";
import {
  ResearchMembershipIntegrityError,
  ResearchMembershipStoreUnavailableError,
  type ResearchMembershipStore,
} from "../application/research-memberships.js";
import type { CatalogBookMembership } from "../domain/rediscover.js";

interface IdentityRow {
  book_id: string;
  identity_target_type: string | null;
  source_id: string | null;
  edition_id: string | null;
  work_id: string | null;
}

interface MembershipRow {
  edition_id: string;
  binding_id: string;
  project_id: string;
  project_name: string;
  project_lifecycle_state: string;
  note_binding_id: string | null;
  note_id: string | null;
  note_binding_role: string | null;
  note_binding_metadata: unknown;
  note_type: string | null;
  note_lifecycle_state: string | null;
  current_revision_id: string | null;
  current_revision_actual_id: string | null;
  note_updated_at: Date | null;
}

function integrity(message: string): never {
  throw new ResearchMembershipIntegrityError(message);
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
      error instanceof ResearchMembershipIntegrityError ||
      error instanceof ResearchMembershipStoreUnavailableError
    ) {
      throw error;
    }
    if (isConnectionError(error)) {
      throw new ResearchMembershipStoreUnavailableError("RESEARCH_MEMBERSHIP_STORE_UNAVAILABLE");
    }
    throw error;
  } finally {
    client?.release();
  }
}

function validateIdentity(row: IdentityRow): {
  bookId: string;
  editionId: string;
} | null {
  if (row.identity_target_type === null) return null;
  if (
    row.identity_target_type !== "SOURCE" ||
    !row.source_id ||
    !row.edition_id ||
    !row.work_id
  ) {
    integrity("CATALOG_DOCUMENT_IDENTITY_CHAIN_INVALID");
  }
  return { bookId: row.book_id, editionId: row.edition_id };
}

function toMembership(row: MembershipRow): CatalogBookMembership {
  if (
    row.project_lifecycle_state !== "ACTIVE" &&
    row.project_lifecycle_state !== "ARCHIVED"
  ) {
    integrity("PROJECT_LIFECYCLE_INVALID");
  }

  const hasBinding = row.note_binding_id !== null;
  if (!hasBinding) {
    if (
      row.note_id !== null ||
      row.note_binding_role !== null ||
      row.note_binding_metadata !== null ||
      row.note_type !== null ||
      row.note_lifecycle_state !== null ||
      row.current_revision_id !== null ||
      row.current_revision_actual_id !== null ||
      row.note_updated_at !== null
    ) {
      integrity("NOTE_RELATION_PARTIAL");
    }
    return {
      projectId: row.project_id,
      projectName: row.project_name,
      projectLifecycleState: row.project_lifecycle_state,
      bindingId: row.binding_id,
      hasNote: false,
      noteUpdatedAt: null,
    };
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
    !(row.note_updated_at instanceof Date) ||
    Number.isNaN(row.note_updated_at.getTime())
  ) {
    integrity("NOTE_RELATION_INVALID");
  }

  return {
    projectId: row.project_id,
    projectName: row.project_name,
    projectLifecycleState: row.project_lifecycle_state,
    bindingId: row.binding_id,
    hasNote: true,
    noteUpdatedAt: row.note_updated_at.toISOString(),
  };
}

export function createPostgresResearchMembershipStore(pool: Pool): ResearchMembershipStore {
  return {
    lookup(bookIds) {
      return readOnlyTransaction(pool, async (client) => {
        const identityRows = (
          await client.query<IdentityRow>(
            `SELECT
               requested.book_id,
               ei.target_type AS identity_target_type,
               ei.target_id AS source_id,
               s.edition_id,
               w.id AS work_id
             FROM unnest($1::text[]) AS requested(book_id)
             LEFT JOIN core.external_identities ei
               ON ei.provider = 'BOOK_ID_SEARCH'
              AND ei.namespace = 'CATALOG_DOCUMENT'
              AND ei.external_id = requested.book_id
              AND ei.binding_state <> 'RETIRED'
             LEFT JOIN core.sources s
               ON s.id = ei.target_id
             LEFT JOIN core.editions e
               ON e.id = s.edition_id
             LEFT JOIN core.works w
               ON w.id = e.work_id`,
            [bookIds],
          )
        ).rows;

        const editionToBooks = new Map<string, string[]>();
        for (const row of identityRows) {
          const identity = validateIdentity(row);
          if (!identity) continue;
          const ids = editionToBooks.get(identity.editionId) ?? [];
          ids.push(identity.bookId);
          editionToBooks.set(identity.editionId, ids);
        }

        const result = new Map<string, CatalogBookMembership[]>();
        if (editionToBooks.size === 0) return result;

        const editionIds = [...editionToBooks.keys()];
        const membershipRows = (
          await client.query<MembershipRow>(
            `SELECT
               pb.target_id AS edition_id,
               pb.id AS binding_id,
               p.id AS project_id,
               p.name AS project_name,
               p.lifecycle_state AS project_lifecycle_state,
               nb.id AS note_binding_id,
               nb.target_id AS note_id,
               nb.binding_role AS note_binding_role,
               nb.metadata AS note_binding_metadata,
               n.note_type,
               n.lifecycle_state AS note_lifecycle_state,
               n.current_revision_id,
               r.id AS current_revision_actual_id,
               n.updated_at AS note_updated_at
             FROM core.project_bindings pb
             JOIN core.projects p
               ON p.id = pb.project_id
             LEFT JOIN core.project_bindings nb
               ON nb.project_id = pb.project_id
              AND nb.target_type = 'NOTE'
              AND nb.metadata->>'subjectBindingId' = pb.id::text
             LEFT JOIN core.notes n
               ON n.id = nb.target_id
             LEFT JOIN core.note_revisions r
               ON r.note_id = n.id
              AND r.id = n.current_revision_id
             WHERE pb.target_type = 'EDITION'
               AND pb.target_id = ANY($1::uuid[])
             ORDER BY pb.id, nb.id`,
            [editionIds],
          )
        ).rows;

        const grouped = new Map<string, MembershipRow[]>();
        for (const row of membershipRows) {
          const rows = grouped.get(row.binding_id) ?? [];
          rows.push(row);
          grouped.set(row.binding_id, rows);
        }

        for (const rows of grouped.values()) {
          if (rows.length !== 1) integrity("NOTE_RELATION_DUPLICATE");
          const row = rows[0];
          if (!editionToBooks.has(row.edition_id)) integrity("EDITION_MEMBERSHIP_OUT_OF_SCOPE");
          const membership = toMembership(row);
          for (const bookId of editionToBooks.get(row.edition_id) ?? []) {
            const memberships = result.get(bookId) ?? [];
            memberships.push(membership);
            result.set(bookId, memberships);
          }
        }

        return result;
      });
    },
  };
}
