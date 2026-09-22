import type { Pool, PoolClient } from "pg";
import {
  EvidenceSelectionIntegrityError,
  EvidenceSelectionStoreUnavailableError,
  EvidenceTargetNotAvailableError,
  type EvidenceSelectionStore,
} from "../application/evidence-selection.js";
import {
  ProjectEvidenceIntegrityError,
  ProjectEvidenceTargetUnavailableError,
  authorizeEvidenceItems,
  evidenceCandidatesFromAuthorization,
  loadProjectClaimScope,
  loadProjectEvidenceAuthorization,
} from "./project-evidence-authorization.js";

function isConnectionError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string") {
    if (code.startsWith("08")) return true;
    if (["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "ETIMEDOUT", "EPIPE", "57P01", "57P02", "57P03", "53300"].includes(code)) {
      return true;
    }
  }
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" && /connection terminated|query read timeout|connection refused|connection reset/i.test(message);
}

function classify(error: unknown): Error {
  if (error instanceof ProjectEvidenceIntegrityError) {
    return new EvidenceSelectionIntegrityError(error.message);
  }
  if (error instanceof ProjectEvidenceTargetUnavailableError) {
    return new EvidenceTargetNotAvailableError("EVIDENCE_TARGET_NOT_AVAILABLE");
  }
  if (error instanceof EvidenceSelectionIntegrityError || error instanceof EvidenceTargetNotAvailableError) {
    return error;
  }
  if (isConnectionError(error)) {
    return new EvidenceSelectionStoreUnavailableError("EVIDENCE_SELECTION_STORE_UNAVAILABLE");
  }
  return error as Error;
}

async function readOnlyTransaction<T>(
  pool: Pool,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  let client: PoolClient | null = null;
  try {
    client = await pool.connect();
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    const value = await run(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    if (client) await client.query("ROLLBACK").catch(() => undefined);
    throw classify(error);
  } finally {
    client?.release();
  }
}

export function createPostgresEvidenceSelectionStore(pool: Pool): EvidenceSelectionStore {
  return {
    async candidates(input) {
      return readOnlyTransaction(pool, async client => {
        const scope = await loadProjectClaimScope(client, input.projectId, input.issueId, input.claimId);
        if (!scope) return null;
        const auth = await loadProjectEvidenceAuthorization(client, input.projectId);
        return {
          claim: scope.claim,
          candidates: evidenceCandidatesFromAuthorization(auth),
        };
      });
    },

    async authorizePreview(input) {
      return readOnlyTransaction(pool, async client => {
        const scope = await loadProjectClaimScope(client, input.projectId, input.issueId, input.claimId);
        if (!scope) return null;
        const auth = await loadProjectEvidenceAuthorization(client, input.projectId);
        await authorizeEvidenceItems(client, auth, input.items);
        return { claim: scope.claim };
      });
    },
  };
}
