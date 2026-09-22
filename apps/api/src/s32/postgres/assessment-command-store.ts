import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  AssessmentEvidenceTargetNotAvailableError,
  AssessmentIdempotencyConflictError,
  AssessmentIntegrityError,
  AssessmentScopeNotFoundError,
  AssessmentStoreUnavailableError,
  EvidencePreviewStaleError,
  ProjectReadOnlyForAssessmentError,
  ResearchIssueReadOnlyForAssessmentError,
  type AssessmentCommandResult,
  type AssessmentCommandStore,
  type AssessmentCreateCommand,
} from "../application/assessments.js";
import {
  buildEvidenceManifestDraft,
  type EvidenceDraftInputItem,
} from "../domain/evidence-selection.js";
import type {
  AssessmentManifestSummary,
  AssessmentRecord,
  NormalizedAssessmentInput,
} from "../domain/assessment.js";
import { hashAssessmentCreateRequest } from "../domain/assessment.js";
import {
  ProjectEvidenceIntegrityError,
  ProjectEvidenceTargetUnavailableError,
  authorizeEvidenceItems,
  loadProjectClaimScope,
  loadProjectEvidenceAuthorization,
} from "./project-evidence-authorization.js";

const uuidPattern = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

function integrity(detail: string): never {
  throw new AssessmentIntegrityError(detail);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isEmptyObject(value: unknown): boolean {
  return isPlainObject(value) && Object.keys(value).length === 0;
}

function validDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

function isConnectionError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string") {
    if (code.startsWith("08")) return true;
    if (
      [
        "ECONNREFUSED",
        "ECONNRESET",
        "ENOTFOUND",
        "ETIMEDOUT",
        "EPIPE",
        "57P01",
        "57P02",
        "57P03",
        "53300",
      ].includes(code)
    ) {
      return true;
    }
  }
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" &&
    /connection terminated|connection timeout|timeout exceeded|query read timeout|connection refused|connection reset/i.test(message);
}

function classify(error: unknown): Error {
  if (
    error instanceof AssessmentIdempotencyConflictError ||
    error instanceof AssessmentIntegrityError ||
    error instanceof AssessmentScopeNotFoundError ||
    error instanceof AssessmentStoreUnavailableError ||
    error instanceof AssessmentEvidenceTargetNotAvailableError ||
    error instanceof EvidencePreviewStaleError ||
    error instanceof ProjectReadOnlyForAssessmentError ||
    error instanceof ResearchIssueReadOnlyForAssessmentError
  ) {
    return error;
  }
  if (error instanceof ProjectEvidenceIntegrityError) {
    return new AssessmentIntegrityError(error.message);
  }
  if (error instanceof ProjectEvidenceTargetUnavailableError) {
    return new AssessmentEvidenceTargetNotAvailableError("EVIDENCE_TARGET_NOT_AVAILABLE");
  }
  if (isConnectionError(error)) {
    return new AssessmentStoreUnavailableError("ASSESSMENT_STORE_UNAVAILABLE");
  }
  return error as Error;
}

function retryableSqlState(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  return code === "40001" || code === "40P01";
}

async function serializableWithRetry<T>(
  pool: Pool,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let client: PoolClient | null = null;
    try {
      client = await pool.connect();
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      const value = await run(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      if (client) {
        await client.query("ROLLBACK").catch(() => undefined);
      }
      if (retryableSqlState(error)) {
        if (attempt < 2) continue;
        throw new AssessmentStoreUnavailableError("ASSESSMENT_STORE_UNAVAILABLE");
      }
      throw classify(error);
    } finally {
      client?.release();
    }
  }
  throw new AssessmentStoreUnavailableError("ASSESSMENT_STORE_UNAVAILABLE");
}

interface ReceiptRow {
  id: string;
  request_hash: string;
  status: string;
  resource_type: string | null;
  resource_id: string | null;
  result_payload?: unknown;
}

interface AssessmentManifestRow {
  assessment_id: string;
  claim_id: string;
  actor_id: string | null;
  stance: string;
  confidence_level: string | null;
  numeric_score: number | null;
  score_kind: string | null;
  evidence_manifest_id: string | null;
  reasoning: string | null;
  assessment_metadata: unknown;
  assessment_created_at: Date;
  manifest_id: string;
  schema_version: number;
  purpose: string;
  manifest_sha256: string;
  manifest_metadata: unknown;
  manifest_created_at: Date;
}

interface ManifestItemRow {
  item_id: string;
  manifest_id: string;
  ordinal: number;
  role: string;
  target_type: string;
  target_id: string;
  locator_type: string | null;
  locator: unknown;
  excerpt: string | null;
  note: string | null;
  created_at: Date;
}

function canonicalReceiptResourceId(value: unknown): string {
  if (typeof value !== "string" || !uuidPattern.test(value)) {
    integrity("IDEMPOTENCY_RESOURCE_INVALID");
  }
  return value.toLowerCase();
}

function readCompletedReceiptPayload(value: unknown): {
  assessmentId: string;
  manifestId: string;
} {
  if (
    !isPlainObject(value)
    || Object.keys(value).length !== 2
    || typeof value.assessmentId !== "string"
    || typeof value.manifestId !== "string"
    || !uuidPattern.test(value.assessmentId)
    || !uuidPattern.test(value.manifestId)
  ) {
    integrity("IDEMPOTENCY_RESULT_PAYLOAD_INVALID");
  }
  return {
    assessmentId: value.assessmentId.toLowerCase(),
    manifestId: value.manifestId.toLowerCase(),
  };
}

async function loadAssessmentReadback(
  client: PoolClient,
  assessmentId: string,
): Promise<AssessmentManifestRow> {
  const resource = await client.query<AssessmentManifestRow>(
    `SELECT
       a.id AS assessment_id,
       a.claim_id,
       a.actor_id,
       a.stance,
       a.confidence_level,
       a.numeric_score,
       a.score_kind,
       a.evidence_manifest_id,
       a.reasoning,
       a.metadata AS assessment_metadata,
       a.created_at AS assessment_created_at,
       em.id AS manifest_id,
       em.schema_version,
       em.purpose,
       em.manifest_sha256,
       em.metadata AS manifest_metadata,
       em.created_at AS manifest_created_at
     FROM core.assessments a
     JOIN core.evidence_manifests em ON em.id=a.evidence_manifest_id
     WHERE a.id=$1`,
    [assessmentId],
  );
  if (resource.rows.length !== 1) integrity("ASSESSMENT_READBACK_MISSING");
  return resource.rows[0];
}

async function loadManifestItemReadback(
  client: PoolClient,
  manifestId: string,
): Promise<ManifestItemRow[]> {
  const itemRows = await client.query<ManifestItemRow>(
    `SELECT
       id AS item_id,
       manifest_id,
       ordinal,
       role,
       target_type,
       target_id,
       locator_type,
       locator,
       excerpt,
       note,
       created_at
     FROM core.evidence_manifest_items
     WHERE manifest_id=$1
     ORDER BY ordinal`,
    [manifestId],
  );
  return itemRows.rows;
}

async function resolveExistingReceipt(
  client: PoolClient,
  input: AssessmentCreateCommand,
  scope: string,
): Promise<AssessmentCommandResult | null> {
  const { rows } = await client.query<ReceiptRow>(
    `SELECT id,request_hash,status,resource_type,resource_id,result_payload
       FROM ops.idempotency_keys
      WHERE scope=$1 AND idempotency_key=$2
      FOR UPDATE`,
    [scope, input.idempotencyKey],
  );
  if (rows.length !== 1) integrity("IDEMPOTENCY_RECEIPT_MISSING");

  const receipt = rows[0];
  if (typeof receipt.request_hash !== "string" || receipt.request_hash.trim() !== input.requestHash) {
    throw new AssessmentIdempotencyConflictError("IDEMPOTENCY_CONFLICT");
  }

  if (receipt.status === "IN_PROGRESS" || receipt.status === "FAILED") {
    throw new AssessmentStoreUnavailableError("ASSESSMENT_STORE_UNAVAILABLE");
  }
  if (receipt.status !== "COMPLETED") {
    integrity("IDEMPOTENCY_STATUS_INVALID");
  }
  if (receipt.resource_type !== "ASSESSMENT") {
    integrity("IDEMPOTENCY_RESOURCE_TYPE_INVALID");
  }

  const assessmentId = canonicalReceiptResourceId(receipt.resource_id);
  const payload = readCompletedReceiptPayload(receipt.result_payload);
  if (payload.assessmentId !== assessmentId) {
    integrity("IDEMPOTENCY_RESULT_ASSESSMENT_INVALID");
  }

  const row = await loadAssessmentReadback(client, assessmentId);
  if (row.claim_id.toLowerCase() !== input.claimId) {
    integrity("IDEMPOTENCY_RESOURCE_INVALID");
  }
  if (row.manifest_id.toLowerCase() !== payload.manifestId) {
    integrity("IDEMPOTENCY_RESULT_MANIFEST_INVALID");
  }

  const itemRows = await loadManifestItemReadback(client, payload.manifestId);

  // Replay validates against the persisted canonical resource, not this
  // retry's freshly generated manifestItemIds (a new HTTP attempt regenerates
  // assessmentId/manifestId/manifestItemIds; the first successful attempt's
  // IDs are the identity of record).
  validateReadback(input, row, itemRows, "replay");

  // Close the identity loop end-to-end: rebuild the original command's
  // semantic input purely from the persisted canonical resource and re-derive
  // its request hash. This proves receipt -> exact canonical Assessment ->
  // exact original command, not merely "some Assessment on this Claim".
  // Field shapes are already proven by validateReadback(..., "replay") above
  // (stance/confidence enum match, reasoning string equality, hash format,
  // item content/order), so the cast is safe.
  const replayInput = {
    stance: row.stance,
    confidenceLevel: row.confidence_level,
    reasoning: row.reasoning as string,
    expectedManifestSha256: row.manifest_sha256,
    items: itemRows.map(item => ({
      role: item.role,
      targetType: item.target_type,
      targetId: item.target_id.toLowerCase(),
      note: item.note,
    })),
  } as NormalizedAssessmentInput;
  const replayRequestHash = hashAssessmentCreateRequest(
    input.projectId,
    input.issueId,
    input.claimId,
    replayInput,
  );
  if (
    replayRequestHash !== receipt.request_hash
    || replayRequestHash !== input.requestHash
  ) {
    integrity("IDEMPOTENCY_REPLAY_HASH_MISMATCH");
  }

  return { status: "replayed", assessmentId };
}

function validateReadback(
  input: AssessmentCreateCommand,
  row: AssessmentManifestRow,
  itemRows: ManifestItemRow[],
  mode: "created" | "replay" = "created",
): { assessment: AssessmentRecord; evidenceManifest: AssessmentManifestSummary } {
  // "created": this attempt just wrote the rows; every generated ID must match.
  // "replay": the caller (resolveExistingReceipt) already proved the receipt's
  // canonical assessment/manifest identity against the payload and the loaded
  // row. A retry attempt carries freshly generated assessmentId / manifestId /
  // manifestItemIds which are NOT the identity of record, so ID-equality
  // against input is skipped; content and content-derived hash still must
  // match the original command exactly.
  if (mode === "created") {
    if (!uuidPattern.test(row.assessment_id) || row.assessment_id.toLowerCase() !== input.assessmentId) {
      integrity("ASSESSMENT_ID_INVALID");
    }
    if (row.evidence_manifest_id?.toLowerCase() !== input.manifestId) integrity("ASSESSMENT_MANIFEST_INVALID");
    if (row.manifest_id.toLowerCase() !== input.manifestId) integrity("MANIFEST_ID_INVALID");
  }
  if (row.claim_id.toLowerCase() !== input.claimId) integrity("ASSESSMENT_CLAIM_INVALID");
  if (row.actor_id !== null) integrity("ASSESSMENT_ACTOR_INVALID");
  if (row.stance !== input.stance) integrity("ASSESSMENT_STANCE_INVALID");
  if (row.confidence_level !== input.confidenceLevel) integrity("ASSESSMENT_CONFIDENCE_INVALID");
  if (row.numeric_score !== null || row.score_kind !== null) integrity("ASSESSMENT_SCORE_INVALID");
  if (row.reasoning !== input.reasoning) integrity("ASSESSMENT_REASONING_INVALID");
  if (!isEmptyObject(row.assessment_metadata)) integrity("ASSESSMENT_METADATA_INVALID");
  if (!validDate(row.assessment_created_at)) integrity("ASSESSMENT_CREATED_AT_INVALID");

  if (row.schema_version !== 1) integrity("MANIFEST_SCHEMA_INVALID");
  if (row.purpose !== "CLAIM_ASSESSMENT") integrity("MANIFEST_PURPOSE_INVALID");
  if (!/^[0-9a-f]{64}$/.test(row.manifest_sha256)) integrity("MANIFEST_HASH_INVALID");
  if (!isEmptyObject(row.manifest_metadata)) integrity("MANIFEST_METADATA_INVALID");
  if (!validDate(row.manifest_created_at)) integrity("MANIFEST_CREATED_AT_INVALID");

  // Item count always equals the command's item list; in "created" mode the
  // persisted IDs must also equal this attempt's generated UUID list.
  if (itemRows.length !== input.items.length) {
    integrity("MANIFEST_ITEM_COUNT_INVALID");
  }
  if (mode === "created" && itemRows.length !== input.manifestItemIds.length) {
    integrity("MANIFEST_ITEM_COUNT_INVALID");
  }

  const manifestRef = mode === "replay"
    ? row.manifest_id.toLowerCase()
    : input.manifestId;
  const draftItems: EvidenceDraftInputItem[] = [];
  itemRows.forEach((item, index) => {
    const expected = input.items[index];
    if (mode === "created" && item.item_id.toLowerCase() !== input.manifestItemIds[index]) {
      integrity("MANIFEST_ITEM_ID_INVALID");
    }
    if (item.manifest_id.toLowerCase() !== manifestRef) integrity("MANIFEST_ITEM_MANIFEST_INVALID");
    if (item.ordinal !== index + 1) integrity("MANIFEST_ITEM_ORDINAL_INVALID");
    if (item.role !== expected.role) integrity("MANIFEST_ITEM_ROLE_INVALID");
    if (item.target_type !== expected.targetType) integrity("MANIFEST_ITEM_TARGET_TYPE_INVALID");
    if (item.target_id.toLowerCase() !== expected.targetId) integrity("MANIFEST_ITEM_TARGET_INVALID");
    if (item.locator_type !== null || item.locator !== null || item.excerpt !== null) {
      integrity("MANIFEST_ITEM_LOCATOR_INVALID");
    }
    if (item.note !== expected.note) integrity("MANIFEST_ITEM_NOTE_INVALID");
    if (!validDate(item.created_at)) integrity("MANIFEST_ITEM_CREATED_AT_INVALID");
    draftItems.push({
      role: expected.role,
      targetType: expected.targetType,
      targetId: expected.targetId,
      note: expected.note,
    });
  });

  const rebuilt = buildEvidenceManifestDraft(draftItems);
  if (
    rebuilt.manifestSha256 !== row.manifest_sha256 ||
    row.manifest_sha256 !== input.expectedManifestSha256
  ) {
    integrity("MANIFEST_HASH_READBACK_MISMATCH");
  }

  return {
    assessment: {
      id: row.assessment_id.toLowerCase(),
      claimId: row.claim_id.toLowerCase(),
      stance: input.stance,
      confidenceLevel: input.confidenceLevel,
      actorId: null,
      numericScore: null,
      scoreKind: null,
      reasoning: input.reasoning,
      createdAt: row.assessment_created_at.toISOString(),
    },
    evidenceManifest: {
      id: row.manifest_id.toLowerCase(),
      schemaVersion: 1,
      purpose: "CLAIM_ASSESSMENT",
      manifestSha256: row.manifest_sha256,
      itemCount: itemRows.length,
    },
  };
}

async function insertNewAssessment(
  client: PoolClient,
  receiptId: string,
  input: AssessmentCreateCommand,
): Promise<AssessmentCommandResult> {
  const scope = await loadProjectClaimScope(
    client,
    input.projectId,
    input.issueId,
    input.claimId,
    { lock: true },
  );
  if (!scope) throw new AssessmentScopeNotFoundError("PROJECT_ISSUE_OR_CLAIM_NOT_FOUND");
  if (scope.projectLifecycleState !== "ACTIVE") {
    throw new ProjectReadOnlyForAssessmentError("PROJECT_READ_ONLY");
  }
  if (scope.issueLifecycleState === "ARCHIVED") {
    throw new ResearchIssueReadOnlyForAssessmentError("RESEARCH_ISSUE_READ_ONLY");
  }

  const auth = await loadProjectEvidenceAuthorization(client, input.projectId);
  try {
    await authorizeEvidenceItems(client, auth, input.items);
  } catch (error) {
    if (error instanceof ProjectEvidenceTargetUnavailableError) {
      throw new AssessmentEvidenceTargetNotAvailableError("EVIDENCE_TARGET_NOT_AVAILABLE");
    }
    if (error instanceof ProjectEvidenceIntegrityError) {
      throw new AssessmentIntegrityError(error.message);
    }
    throw error;
  }

  const draft = buildEvidenceManifestDraft(input.items);
  if (draft.manifestSha256 !== input.expectedManifestSha256) {
    throw new EvidencePreviewStaleError("EVIDENCE_PREVIEW_STALE");
  }

  await client.query(
    `INSERT INTO core.evidence_manifests
       (id,schema_version,purpose,manifest_sha256,metadata)
     VALUES ($1,1,'CLAIM_ASSESSMENT',$2,'{}'::jsonb)`,
    [input.manifestId, draft.manifestSha256],
  );

  for (let index = 0; index < input.items.length; index += 1) {
    const item = input.items[index];
    await client.query(
      `INSERT INTO core.evidence_manifest_items
         (id,manifest_id,ordinal,role,target_type,target_id,locator_type,locator,excerpt,note)
       VALUES ($1,$2,$3,$4,$5,$6,NULL,NULL,NULL,$7)`,
      [
        input.manifestItemIds[index],
        input.manifestId,
        index + 1,
        item.role,
        item.targetType,
        item.targetId,
        item.note,
      ],
    );
  }

  await client.query(
    `INSERT INTO core.assessments
       (id,claim_id,actor_id,stance,confidence_level,numeric_score,score_kind,evidence_manifest_id,reasoning,metadata)
     VALUES ($1,$2,NULL,$3,$4,NULL,NULL,$5,$6,'{}'::jsonb)`,
    [
      input.assessmentId,
      input.claimId,
      input.stance,
      input.confidenceLevel,
      input.manifestId,
      input.reasoning,
    ],
  );

  const row = await loadAssessmentReadback(client, input.assessmentId);
  const itemRows = await loadManifestItemReadback(client, input.manifestId);

  const canonical = validateReadback(input, row, itemRows);

  await client.query(
    `UPDATE ops.idempotency_keys
        SET status='COMPLETED',
            resource_type='ASSESSMENT',
            resource_id=$2,
            result_payload=$3::jsonb,
            completed_at=now(),
            updated_at=now()
      WHERE id=$1`,
    [
      receiptId,
      input.assessmentId,
      JSON.stringify({
        assessmentId: input.assessmentId,
        manifestId: input.manifestId,
      }),
    ],
  );

  return { status: "created", ...canonical };
}

export function createPostgresAssessmentCommandStore(pool: Pool): AssessmentCommandStore {
  return {
    async create(input) {
      return serializableWithRetry(pool, async client => {
        const scope =
          `S32:M2D:PROJECT_ISSUE_CLAIM_ASSESSMENT_CREATE:${input.projectId}:${input.issueId}:${input.claimId}`;

        const inserted = await client.query<{ id: string }>(
          `INSERT INTO ops.idempotency_keys
             (id,scope,idempotency_key,request_hash,status)
           VALUES ($1,$2,$3,$4,'IN_PROGRESS')
           ON CONFLICT(scope,idempotency_key) DO NOTHING
           RETURNING id`,
          [randomUUID(), scope, input.idempotencyKey, input.requestHash],
        );

        if (!inserted.rows.length) {
          const replay = await resolveExistingReceipt(client, input, scope);
          if (!replay) integrity("IDEMPOTENCY_REPLAY_INVALID");
          return replay;
        }

        return insertNewAssessment(client, inserted.rows[0].id, input);
      });
    },
  };
}
