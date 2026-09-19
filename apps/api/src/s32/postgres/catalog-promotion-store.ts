import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  CanonicalStoreUnavailableError,
  IdentityConflictError,
  type CatalogPromotionStore,
  type PromotionResult,
} from "../application/promote-catalog-book.js";
import type { PromotionCandidate } from "../domain/catalog-promotion.js";

interface ExistingChainRow {
  target_type: string;
  source_id: string | null;
  edition_id: string | null;
  work_id: string | null;
}

function isConnectionError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code !== "string") return false;
  return (
    code === "ECONNREFUSED" ||
    code === "ENOTFOUND" ||
    code === "ETIMEDOUT" ||
    code === "ECONNRESET" ||
    code === "EPIPE" ||
    /^08[0-9A-Z]{3}$/.test(code)
  );
}

async function reserveIdentity(
  client: PoolClient,
  args: {
    id: string;
    sourceId: string;
    namespace: string;
    externalId: string;
    observedAt: string;
    metadata: Record<string, unknown>;
  },
): Promise<boolean> {
  const result = await client.query(
    `INSERT INTO core.external_identities (
       id, target_type, target_id, provider, namespace, external_id,
       binding_state, observed_at, metadata
     )
     VALUES ($1, 'SOURCE', $2, 'BOOK_ID_SEARCH', $3, $4,
             'ACTIVE', $5, $6::jsonb)
     ON CONFLICT (provider, namespace, external_id)
       WHERE binding_state <> 'RETIRED'
     DO NOTHING
     RETURNING id`,
    [
      args.id,
      args.sourceId,
      args.namespace,
      args.externalId,
      args.observedAt,
      JSON.stringify(args.metadata),
    ],
  );
  return result.rowCount === 1;
}

async function loadExistingChain(
  client: PoolClient,
  catalogBookId: string,
): Promise<ExistingChainRow | null> {
  const result = await client.query<ExistingChainRow>(
    `SELECT
       ei.target_type,
       ei.target_id AS source_id,
       s.edition_id,
       e.work_id
     FROM core.external_identities ei
     LEFT JOIN core.sources s
       ON ei.target_type = 'SOURCE' AND s.id = ei.target_id
     LEFT JOIN core.editions e ON e.id = s.edition_id
     WHERE ei.provider = 'BOOK_ID_SEARCH'
       AND ei.namespace = 'CATALOG_DOCUMENT'
       AND ei.external_id = $1
       AND ei.binding_state <> 'RETIRED'`,
    [catalogBookId],
  );
  return result.rows[0] ?? null;
}

function assertValidExistingChain(row: ExistingChainRow | null): asserts row is ExistingChainRow & {
  source_id: string;
  edition_id: string;
  work_id: string;
} {
  if (
    !row ||
    row.target_type !== "SOURCE" ||
    !row.source_id ||
    !row.edition_id ||
    !row.work_id
  ) {
    throw new IdentityConflictError("CATALOG_IDENTITY_INVALID_BINDING");
  }
}

async function assertExistingSecondaryIdentitiesDoNotConflict(
  client: PoolClient,
  sourceId: string,
  candidate: PromotionCandidate,
): Promise<void> {
  for (const identity of candidate.secondaryIdentities) {
    const result = await client.query<{ target_type: string; target_id: string }>(
      `SELECT target_type, target_id
       FROM core.external_identities
       WHERE provider = 'BOOK_ID_SEARCH'
         AND namespace = $1
         AND external_id = $2
         AND binding_state <> 'RETIRED'`,
      [identity.namespace, identity.externalId],
    );
    const row = result.rows[0];
    if (row && (row.target_type !== "SOURCE" || row.target_id !== sourceId)) {
      throw new IdentityConflictError(`SECONDARY_IDENTITY_CONFLICT:${identity.namespace}`);
    }
  }
}

function classifyStoreError(error: unknown): never {
  if (
    error instanceof IdentityConflictError ||
    error instanceof CanonicalStoreUnavailableError
  ) {
    throw error;
  }
  if (isConnectionError(error)) {
    throw new CanonicalStoreUnavailableError("CANONICAL_STORE_UNAVAILABLE");
  }
  throw error;
}

export function createPostgresCatalogPromotionStore(pool: Pool): CatalogPromotionStore {
  return {
    async promote(candidate: PromotionCandidate): Promise<PromotionResult> {
      let client: PoolClient;
      try {
        client = await pool.connect();
      } catch (error) {
        return classifyStoreError(error);
      }

      try {
        await client.query("BEGIN");
        try {
          const workId = randomUUID();
          const editionId = randomUUID();
          const sourceId = randomUUID();

          const ownsPrimaryIdentity = await reserveIdentity(client, {
            id: randomUUID(),
            sourceId,
            namespace: "CATALOG_DOCUMENT",
            externalId: candidate.catalogBookId,
            observedAt: candidate.source.observedAt,
            metadata: { role: "CATALOG_DOCUMENT" },
          });

          if (!ownsPrimaryIdentity) {
            const existing = await loadExistingChain(client, candidate.catalogBookId);
            assertValidExistingChain(existing);
            await assertExistingSecondaryIdentitiesDoNotConflict(
              client,
              existing.source_id,
              candidate,
            );
            await client.query("COMMIT");
            return {
              status: "existing",
              workId: existing.work_id,
              editionId: existing.edition_id,
              sourceId: existing.source_id,
              catalogBookId: candidate.catalogBookId,
            };
          }

          for (const identity of candidate.secondaryIdentities) {
            const reserved = await reserveIdentity(client, {
              id: randomUUID(),
              sourceId,
              namespace: identity.namespace,
              externalId: identity.externalId,
              observedAt: candidate.source.observedAt,
              metadata: { role: identity.namespace },
            });
            if (!reserved) {
              throw new IdentityConflictError(
                `SECONDARY_IDENTITY_CONFLICT:${identity.namespace}`,
              );
            }
          }

          await client.query(
            `INSERT INTO core.works (id, work_type, title, title_status)
             VALUES ($1, 'BOOK', $2, 'KNOWN')`,
            [workId, candidate.work.title],
          );

          await client.query(
            `INSERT INTO core.editions (
               id, work_id, edition_type, publisher,
               publication_date, publication_date_precision, isbn
             )
             VALUES ($1, $2, 'BOOK_EDITION', $3, $4, 'YEAR', $5)`,
            [
              editionId,
              workId,
              candidate.edition.publisher,
              candidate.edition.publicationDate,
              candidate.edition.isbn,
            ],
          );

          await client.query(
            `INSERT INTO core.sources (
               id, source_type, edition_id, observed_at, metadata
             )
             VALUES ($1, 'DATABASE_RECORD', $2, $3, $4::jsonb)`,
            [
              sourceId,
              editionId,
              candidate.source.observedAt,
              JSON.stringify(candidate.source.metadata),
            ],
          );

          await client.query("COMMIT");
          return {
            status: "created",
            workId,
            editionId,
            sourceId,
            catalogBookId: candidate.catalogBookId,
          };
        } catch (error) {
          try {
            await client.query("ROLLBACK");
          } catch (rollbackError) {
            throw new CanonicalStoreUnavailableError(
              isConnectionError(rollbackError)
                ? "CANONICAL_STORE_ROLLBACK_CONNECTION_LOST"
                : "CANONICAL_STORE_ROLLBACK_FAILED",
            );
          }
          return classifyStoreError(error);
        }
      } catch (error) {
        return classifyStoreError(error);
      } finally {
        client.release();
      }
    },
  };
}
