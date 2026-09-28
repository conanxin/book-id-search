import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  IssueResolutionScopeNotFoundError, IssueResolutionInvalidPreferredClaimError,
  IssueResolutionEvidenceNotAvailableError, IssueResolutionStaleError,
  IssueResolutionIdempotencyConflictError, ProjectReadOnlyForResolutionError,
  ResearchIssueReadOnlyForResolutionError, IssueResolutionIntegrityError,
  IssueResolutionStoreUnavailableError,
  type IssueResolutionCommandStore, type IssueResolutionCommandResult, type IssueResolutionCreateCommand,
} from "../application/issue-resolutions.js";
import { hashIssueResolutionCreateRequest, normalizeIssueResolutionCreateInput } from "../domain/issue-resolution.js";
import { buildEvidenceManifestDraft, normalizeEvidencePreviewInput, type EvidenceDraftInputItem } from "../domain/evidence-selection.js";
import {
  loadProjectIssueScope, loadIssueCandidateClaim, loadProjectEvidenceAuthorization, authorizeEvidenceItems,
  ProjectEvidenceIntegrityError, ProjectEvidenceTargetUnavailableError,
} from "./project-evidence-authorization.js";

const uuidPattern = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/;
function integrity(detail: string): never { throw new IssueResolutionIntegrityError(detail); }
function uuid(value: unknown): value is string { return typeof value === "string" && uuidPattern.test(value); }
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function emptyObject(value: unknown): boolean { return object(value) && Object.keys(value).length === 0; }
function validDate(value: unknown): value is Date { return value instanceof Date && !Number.isNaN(value.getTime()); }
function unavailable(): IssueResolutionStoreUnavailableError {
  return new IssueResolutionStoreUnavailableError("ISSUE_RESOLUTION_STORE_UNAVAILABLE");
}
function evidenceUnavailable(): never {
  throw new IssueResolutionEvidenceNotAvailableError("EVIDENCE_NOT_AVAILABLE");
}
function classify(error: unknown): unknown {
  if (error instanceof IssueResolutionScopeNotFoundError || error instanceof IssueResolutionInvalidPreferredClaimError
    || error instanceof IssueResolutionEvidenceNotAvailableError || error instanceof IssueResolutionStaleError
    || error instanceof IssueResolutionIdempotencyConflictError || error instanceof ProjectReadOnlyForResolutionError
    || error instanceof ResearchIssueReadOnlyForResolutionError || error instanceof IssueResolutionIntegrityError
    || error instanceof IssueResolutionStoreUnavailableError) return error;
  if (error instanceof ProjectEvidenceIntegrityError) return new IssueResolutionIntegrityError(error.message);
  if (error instanceof ProjectEvidenceTargetUnavailableError) return new IssueResolutionEvidenceNotAvailableError("EVIDENCE_NOT_AVAILABLE");
  if (error && typeof error === "object") {
    const { code, message } = error as { code?: unknown; message?: unknown };
    if (typeof code === "string" && (code.startsWith("08") || ["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "ETIMEDOUT", "EPIPE", "57P01", "57P02", "57P03", "53300"].includes(code))) return unavailable();
    if (typeof message === "string" && /connection terminated|connection timeout|timeout exceeded|query read timeout|connection refused|connection reset/i.test(message)) return unavailable();
  }
  return error;
}
async function serializableWithRetry<T>(pool: Pool, run: (client: PoolClient) => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    let client: PoolClient | null = null;
    try {
      client = await pool.connect();
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      const value = await run(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      if (client) await client.query("ROLLBACK").catch(() => undefined);
      const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
      if (code === "40001" || code === "40P01") {
        if (attempt < 2) continue;
        throw unavailable();
      }
      throw classify(error);
    } finally { client?.release(); }
  }
  throw unavailable();
}
interface ReceiptRow {
  id: string; request_hash: string; status: string;
  resource_type: string | null; resource_id: string | null; result_payload: unknown;
  completed_at?: Date; updated_at?: Date;
}
function completedIdentity(receipt: ReceiptRow): string {
  if (!uuid(receipt.id) || receipt.status !== "COMPLETED" || receipt.resource_type !== "ISSUE_RESOLUTION"
    || !uuid(receipt.resource_id)) integrity("IDEMPOTENCY_RECEIPT_INVALID");
  const payload = receipt.result_payload;
  if (!object(payload) || Object.keys(payload).length !== 1 || !uuid(payload.resolutionId)
    || payload.resolutionId !== receipt.resource_id) integrity("IDEMPOTENCY_RESULT_PAYLOAD_INVALID");
  return receipt.resource_id;
}
interface ResolutionRow {
  id: string; issue_id: string; resolution_type: string; preferred_claim_id: string | null;
  rationale: string | null; evidence_manifest_id: string | null; created_at: Date;
}
async function canonicalReadback(client: PoolClient, id: string, input: IssueResolutionCreateCommand): Promise<ResolutionRow> {
  const { rows } = await client.query<ResolutionRow>(
    `SELECT id,issue_id,resolution_type,preferred_claim_id,rationale,evidence_manifest_id,created_at
     FROM core.issue_resolutions WHERE id=$1`, [id],
  );
  if (rows.length !== 1) integrity("ISSUE_RESOLUTION_READBACK_MISSING");
  const row = rows[0];
  if (!uuid(row.id) || row.id !== id || row.issue_id !== input.issueId || !validDate(row.created_at)) integrity("ISSUE_RESOLUTION_CANONICAL_INVALID");
  // Reuse the domain's write contract to verify a command-created row; this is
  // not a general history reader (schema-valid historical NULL rationale stays
  // a read-store concern). Never normalize a corrupt persisted value silently.
  let normalized: ReturnType<typeof normalizeIssueResolutionCreateInput>;
  try {
    normalized = normalizeIssueResolutionCreateInput({ expectedCurrentResolutionId: input.expectedCurrentResolutionId,
      resolutionType: row.resolution_type, preferredClaimId: row.preferred_claim_id,
      rationale: row.rationale, evidenceManifestId: row.evidence_manifest_id });
  } catch { integrity("ISSUE_RESOLUTION_CANONICAL_INVALID"); }
  if (normalized.resolutionType !== row.resolution_type || normalized.preferredClaimId !== row.preferred_claim_id
    || normalized.rationale !== row.rationale || normalized.evidenceManifestId !== row.evidence_manifest_id
    || row.resolution_type !== input.resolutionType || row.preferred_claim_id !== input.preferredClaimId
    || row.rationale !== input.rationale || row.evidence_manifest_id !== input.evidenceManifestId) {
    integrity("ISSUE_RESOLUTION_COMMAND_MISMATCH");
  }
  return row;
}
function resourceHash(input: IssueResolutionCreateCommand, row: ResolutionRow): string {
  // The old expected pointer is command-only, not a Resolution column. Bind
  // the retry's value through the original receipt hash, never today's pointer.
  return hashIssueResolutionCreateRequest(input.projectId, input.issueId, {
    expectedCurrentResolutionId: input.expectedCurrentResolutionId,
    resolutionType: row.resolution_type as IssueResolutionCreateCommand["resolutionType"],
    preferredClaimId: row.preferred_claim_id, rationale: row.rationale as string,
    evidenceManifestId: row.evidence_manifest_id,
  });
}
async function replay(client: PoolClient, input: IssueResolutionCreateCommand, scope: string): Promise<IssueResolutionCommandResult> {
  const { rows } = await client.query<ReceiptRow>(
    `SELECT id,request_hash,status,resource_type,resource_id,result_payload
     FROM ops.idempotency_keys WHERE scope=$1 AND idempotency_key=$2 FOR UPDATE`, [scope, input.idempotencyKey],
  );
  if (rows.length !== 1) integrity("IDEMPOTENCY_RECEIPT_MISSING");
  const receipt = rows[0];
  if (receipt.request_hash !== input.requestHash) throw new IssueResolutionIdempotencyConflictError("IDEMPOTENCY_CONFLICT");
  if (receipt.status === "IN_PROGRESS" || receipt.status === "FAILED") throw unavailable();
  const id = completedIdentity(receipt);
  const row = await canonicalReadback(client, id, input);
  if (!(await loadProjectIssueScope(client, input.projectId, input.issueId))) integrity("IDEMPOTENCY_SCOPE_MISSING");
  const hash = resourceHash(input, row);
  if (hash !== receipt.request_hash || hash !== input.requestHash) integrity("IDEMPOTENCY_REPLAY_HASH_MISMATCH");
  // No current pointer, writable lifecycle, preferred membership, or evidence
  // visibility gates after COMPLETED. Recover the original response identity.
  return { status: "replayed", resolutionId: id };
}
interface AssessmentBasisRow {
  assessment_id: string; claim_id: string; actor_id: string | null;
  stance: string; confidence_level: string | null; numeric_score: number | null; score_kind: string | null;
  reasoning: string | null; assessment_metadata: unknown; assessment_created_at: Date;
  evidence_manifest_id: string; manifest_id: string | null; schema_version: number;
  purpose: string; manifest_sha256: string; manifest_metadata: unknown; manifest_created_at: Date;
}
interface ManifestItemRow {
  item_id: string; manifest_id: string; ordinal: number; role: string; target_type: string; target_id: string;
  locator_type: string | null; locator: unknown; excerpt: string | null; note: string | null; created_at: Date;
}
async function validateEvidenceBasis(client: PoolClient, input: IssueResolutionCreateCommand): Promise<void> {
  if (input.evidenceManifestId === null) return;
  const { rows } = await client.query<AssessmentBasisRow>(
    `SELECT a.id AS assessment_id,a.claim_id,a.actor_id,a.stance,a.confidence_level,a.numeric_score,a.score_kind,
       a.reasoning,a.metadata AS assessment_metadata,a.created_at AS assessment_created_at,a.evidence_manifest_id,
       em.id AS manifest_id,em.schema_version,em.purpose,em.manifest_sha256,
       em.metadata AS manifest_metadata,em.created_at AS manifest_created_at
     FROM core.assessments a LEFT JOIN core.evidence_manifests em ON em.id=a.evidence_manifest_id
     WHERE a.evidence_manifest_id=$1`, [input.evidenceManifestId],
  );
  if (!rows.length) evidenceUnavailable();
  if (rows.length !== 1) integrity("EVIDENCE_ASSESSMENT_AMBIGUOUS");
  const row = rows[0];
  if (!uuid(row.assessment_id) || !uuid(row.claim_id) || row.evidence_manifest_id !== input.evidenceManifestId
    || row.manifest_id !== input.evidenceManifestId) integrity("EVIDENCE_ASSESSMENT_CANONICAL_INVALID");
  if (!(await loadIssueCandidateClaim(client, input.issueId, row.claim_id))) evidenceUnavailable();
  const { rows: items } = await client.query<ManifestItemRow>(
    `SELECT id AS item_id,manifest_id,ordinal,role,target_type,target_id,locator_type,locator,excerpt,note,created_at
     FROM core.evidence_manifest_items WHERE manifest_id=$1 ORDER BY ordinal`, [input.evidenceManifestId],
  );
  // Eligibility follows M2-D's schema-compatible read contract: canonical
  // historical attribution/score/nullable reasoning remain eligible.
  if (!["SUPPORTS", "CONTRADICTS", "INCONCLUSIVE"].includes(row.stance)
    || (row.confidence_level !== null && !["LOW", "MEDIUM", "HIGH"].includes(row.confidence_level))
    || (row.numeric_score !== null && (typeof row.numeric_score !== "number" || !Number.isFinite(row.numeric_score)
      || row.numeric_score < 0 || row.numeric_score > 1))
    || (row.numeric_score === null) !== (row.score_kind === null)
    || (row.score_kind !== null && (typeof row.score_kind !== "string" || !row.score_kind.trim()))
    || (row.reasoning !== null && typeof row.reasoning !== "string")
    || !object(row.assessment_metadata) || !validDate(row.assessment_created_at)
    || row.schema_version !== 1 || row.purpose !== "CLAIM_ASSESSMENT"
    || !/^[0-9a-f]{64}$/.test(row.manifest_sha256) || !emptyObject(row.manifest_metadata)
    || !validDate(row.manifest_created_at)) integrity("EVIDENCE_BASIS_CANONICAL_INVALID");
  for (const [index, item] of items.entries()) {
    if (!uuid(item.item_id) || item.manifest_id !== input.evidenceManifestId || item.ordinal !== index + 1
      || !uuid(item.target_id) || item.locator_type !== null || item.locator !== null || item.excerpt !== null
      || !validDate(item.created_at)) integrity("EVIDENCE_ITEM_CANONICAL_INVALID");
  }
  const draftItems = items.map(item => ({ role: item.role, targetType: item.target_type, targetId: item.target_id, note: item.note })) as EvidenceDraftInputItem[];
  if (row.actor_id !== null) {
    if (!uuid(row.actor_id)) integrity("EVIDENCE_ASSESSMENT_ACTOR_INVALID");
    const { rows: actors } = await client.query<{
      id: string; actor_type: string; display_name: string; metadata: unknown; created_at: Date; updated_at: Date;
    }>("SELECT id,actor_type,display_name,metadata,created_at,updated_at FROM core.actors WHERE id=$1", [row.actor_id]);
    const actor = actors[0];
    if (actors.length !== 1 || actor.id !== row.actor_id
      || !["HUMAN", "AI_SYSTEM", "SYSTEM_PROCESS", "EXTERNAL_PERSON", "INSTITUTION", "UNKNOWN"].includes(actor.actor_type)
      || typeof actor.display_name !== "string" || !actor.display_name.trim() || !object(actor.metadata)
      || !validDate(actor.created_at) || !validDate(actor.updated_at)) integrity("EVIDENCE_ASSESSMENT_ACTOR_INVALID");
  }
  let normalized: EvidenceDraftInputItem[];
  try { normalized = normalizeEvidencePreviewInput({ items: draftItems }); }
  catch { integrity("EVIDENCE_BASIS_CANONICAL_INVALID"); }
  if (JSON.stringify(normalized) !== JSON.stringify(draftItems)
    || buildEvidenceManifestDraft(draftItems).manifestSha256 !== row.manifest_sha256) integrity("EVIDENCE_BASIS_HASH_OR_CANONICALITY");
  const auth = await loadProjectEvidenceAuthorization(client, input.projectId);
  await authorizeEvidenceItems(client, auth, draftItems);
}
async function insertNew(client: PoolClient, receiptId: string, input: IssueResolutionCreateCommand): Promise<IssueResolutionCommandResult> {
  const scope = await loadProjectIssueScope(client, input.projectId, input.issueId, { lock: true });
  if (!scope) throw new IssueResolutionScopeNotFoundError("PROJECT_OR_ISSUE_NOT_FOUND");
  if (scope.projectLifecycleState !== "ACTIVE") throw new ProjectReadOnlyForResolutionError("PROJECT_READ_ONLY");
  if (scope.issueLifecycleState === "ARCHIVED") throw new ResearchIssueReadOnlyForResolutionError("RESEARCH_ISSUE_READ_ONLY");
  if (scope.currentResolutionId !== null && !uuid(scope.currentResolutionId)) integrity("ISSUE_CURRENT_RESOLUTION_INVALID");
  if (scope.currentResolutionId !== input.expectedCurrentResolutionId) throw new IssueResolutionStaleError("ISSUE_RESOLUTION_STALE");
  if (input.resolutionType === "PREFERRED_CLAIM") {
    if (!input.preferredClaimId || !(await loadIssueCandidateClaim(client, input.issueId, input.preferredClaimId, { lock: true }))) {
      throw new IssueResolutionInvalidPreferredClaimError("PREFERRED_CLAIM_NOT_AVAILABLE");
    }
  }
  await validateEvidenceBasis(client, input);
  await client.query(
    `INSERT INTO core.issue_resolutions (id,issue_id,resolution_type,preferred_claim_id,rationale,evidence_manifest_id)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [input.resolutionId, input.issueId, input.resolutionType, input.preferredClaimId, input.rationale, input.evidenceManifestId],
  );
  const updated = await client.query(
    `UPDATE core.research_issues SET current_resolution_id=$2,updated_at=now() WHERE id=$1 RETURNING id`,
    [input.issueId, input.resolutionId],
  );
  if (updated.rows.length !== 1 || updated.rows[0].id !== input.issueId) integrity("ISSUE_POINTER_UPDATE_MISSING");
  const row = await canonicalReadback(client, input.resolutionId, input);
  if (resourceHash(input, row) !== input.requestHash) integrity("ISSUE_RESOLUTION_REQUEST_HASH_MISMATCH");
  const completed = await client.query<ReceiptRow>(
    `UPDATE ops.idempotency_keys SET status='COMPLETED',resource_type='ISSUE_RESOLUTION',resource_id=$2,
       result_payload=$3::jsonb,completed_at=now(),updated_at=now() WHERE id=$1
     RETURNING id,request_hash,status,resource_type,resource_id,result_payload,completed_at,updated_at`,
    [receiptId, input.resolutionId, JSON.stringify({ resolutionId: input.resolutionId })],
  );
  if (completed.rows.length !== 1) integrity("IDEMPOTENCY_COMPLETE_MISSING");
  const receipt = completed.rows[0];
  if (completedIdentity(receipt) !== input.resolutionId || receipt.id !== receiptId || receipt.request_hash !== input.requestHash
    || !validDate(receipt.completed_at) || !validDate(receipt.updated_at)) integrity("IDEMPOTENCY_COMPLETE_INVALID");
  return { status: "created", resolutionId: input.resolutionId };
}
export function createPostgresIssueResolutionCommandStore(pool: Pool): IssueResolutionCommandStore {
  return {
    create(input) {
      return serializableWithRetry(pool, async client => {
        const scope = `S32:M2E:PROJECT_ISSUE_RESOLUTION_CREATE:${input.projectId}:${input.issueId}`;
        const reserved = await client.query<{ id: string }>(
          `INSERT INTO ops.idempotency_keys (id,scope,idempotency_key,request_hash,status)
           VALUES ($1,$2,$3,$4,'IN_PROGRESS') ON CONFLICT(scope,idempotency_key) DO NOTHING RETURNING id`,
          [randomUUID(), scope, input.idempotencyKey, input.requestHash],
        );
        if (!reserved.rows.length) return replay(client, input, scope);
        if (reserved.rows.length !== 1 || !uuid(reserved.rows[0].id)) integrity("IDEMPOTENCY_RESERVATION_INVALID");
        return insertNew(client, reserved.rows[0].id, input);
      });
    },
  };
}
