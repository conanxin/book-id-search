import type { Pool, PoolClient } from "pg";
import {
  ProjectReadOnlyForResearchRunError,
  ResearchIssueReadOnlyForResearchRunError,
  ResearchRunAlreadyTerminalError,
  ResearchRunEvidenceNotAvailableError,
  ResearchRunIdempotencyConflictError,
  ResearchRunIntegrityError,
  ResearchRunNotFoundError,
  ResearchRunReplayInvalidError,
  ResearchRunScopeNotFoundError,
  ResearchRunStoreUnavailableError,
  type ResearchRunCommandResult,
  type ResearchRunCommandStore,
  type ResearchRunReplayCommand,
  type ResearchRunStartCommand,
  type ResearchRunTransitionCommand,
} from "../application/research-runs.js";
import { readResearchRunExecutionContract, readResearchRunOutput, readResearchRunProcedure, type ResearchRunOutput, type ResearchRunStatus } from "../domain/research-run.js";
import { buildEvidenceManifestDraft, normalizeEvidencePreviewInput, type EvidenceDraftInputItem } from "../domain/evidence-selection.js";
import {
  loadProjectEvidenceAuthorization,
  loadProjectIssueScope,
  loadIssueCandidateClaim,
  authorizeEvidenceItems,
  ProjectEvidenceIntegrityError,
  ProjectEvidenceTargetUnavailableError,
} from "./project-evidence-authorization.js";

/**
 * ResearchRun PostgreSQL command store (M3-A Gate 2, Task 2).
 *
 * Every write runs in a SERIALIZABLE transaction with bounded 40001/40P01
 * retry (M2-E pattern). Reads back the persisted row canonically after every
 * write — INSERT/UPDATE success alone is never trusted.
 */

const uuidPattern = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/;
function uuid(value: unknown): value is string { return typeof value === "string" && uuidPattern.test(value); }
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function validDate(value: unknown): value is Date { return value instanceof Date && !Number.isNaN(value.getTime()); }
function integrity(detail: string): never { throw new ResearchRunIntegrityError(detail); }
function unavailable(): ResearchRunStoreUnavailableError {
  return new ResearchRunStoreUnavailableError("RESEARCH_RUN_STORE_UNAVAILABLE");
}
function evidenceUnavailable(): never {
  throw new ResearchRunEvidenceNotAvailableError("EVIDENCE_MANIFEST_NOT_AVAILABLE");
}

function classify(error: unknown): unknown {
  if (error instanceof ProjectReadOnlyForResearchRunError || error instanceof ResearchIssueReadOnlyForResearchRunError
    || error instanceof ResearchRunAlreadyTerminalError || error instanceof ResearchRunEvidenceNotAvailableError
    || error instanceof ResearchRunIdempotencyConflictError || error instanceof ResearchRunIntegrityError
    || error instanceof ResearchRunNotFoundError || error instanceof ResearchRunReplayInvalidError
    || error instanceof ResearchRunScopeNotFoundError || error instanceof ResearchRunStoreUnavailableError) return error;
  if (error instanceof ProjectEvidenceIntegrityError) return new ResearchRunIntegrityError(error.message);
  if (error instanceof ProjectEvidenceTargetUnavailableError) return evidenceUnavailable();
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

// ---------------------------------------------------------------------------
// Persisted row shape + canonical readback
// ---------------------------------------------------------------------------

interface RunRow {
  id: string;
  schema_version: number;
  issue_id: string | null;
  evidence_manifest_id: string;
  status: ResearchRunStatus;
  procedure: unknown;
  execution_contract: unknown;
  environment: unknown;
  output: unknown;
  knowledge_cutoff: Date | null;
  replay_of: string | null;
  started_at: Date;
  completed_at: Date | null;
  created_at: Date;
}

function canonicalReadback(row: RunRow | undefined, expect: {
  id: string;
  issueId: string;
  manifestId: string;
}): { procedure: ReturnType<typeof readResearchRunProcedure>; executionContract: ReturnType<typeof readResearchRunExecutionContract>; output: ResearchRunOutput | null } {
  if (!row) integrity("RESEARCH_RUN_READBACK_MISSING");
  if (!uuid(row.id) || row.id !== expect.id) integrity("RESEARCH_RUN_READBACK_ID_INVALID");
  if (row.schema_version !== 1) integrity("RESEARCH_RUN_SCHEMA_VERSION_INVALID");
  if (row.issue_id !== expect.issueId) integrity("RESEARCH_RUN_ISSUE_MISMATCH");
  if (row.evidence_manifest_id !== expect.manifestId) integrity("RESEARCH_RUN_MANIFEST_MISMATCH");
  if (row.status !== "RUNNING" && row.status !== "SUCCEEDED" && row.status !== "FAILED" && row.status !== "CANCELLED") {
    integrity("RESEARCH_RUN_STATUS_INVALID");
  }
  if (!validDate(row.started_at) || !validDate(row.created_at)) integrity("RESEARCH_RUN_TIMESTAMPS_INVALID");
  const terminal = row.status !== "RUNNING";
  if (terminal !== (row.completed_at !== null)) integrity("RESEARCH_RUN_COMPLETION_INVARIANT");
  if (terminal && !validDate(row.completed_at)) integrity("RESEARCH_RUN_COMPLETED_AT_INVALID");
  if (row.replay_of !== null && !uuid(row.replay_of)) integrity("RESEARCH_RUN_REPLAY_OF_INVALID");
  // Domain canonical readers reject corrupt persisted JSONB fail-closed.
  let procedure: ReturnType<typeof readResearchRunProcedure>;
  let executionContract: ReturnType<typeof readResearchRunExecutionContract>;
  try {
    procedure = readResearchRunProcedure(row.procedure);
    executionContract = readResearchRunExecutionContract(row.execution_contract);
  } catch { integrity("RESEARCH_RUN_CANONICAL_INVALID"); }
  let output: ResearchRunOutput | null = null;
  if (row.output !== null) {
    try { output = readResearchRunOutput(row.output); } catch { integrity("RESEARCH_RUN_OUTPUT_CANONICAL_INVALID"); }
  } else if (row.status === "SUCCEEDED") {
    integrity("RESEARCH_RUN_SUCCEEDED_WITHOUT_OUTPUT");
  }
  return { procedure, executionContract, output };
}

async function selectRun(client: PoolClient, id: string): Promise<RunRow | undefined> {
  const { rows } = await client.query<RunRow>(
    `SELECT id,schema_version,issue_id,evidence_manifest_id,status,procedure,execution_contract,environment,output,
       knowledge_cutoff,replay_of,started_at,completed_at,created_at
     FROM core.research_runs WHERE id=$1`, [id],
  );
  return rows[0];
}

// ---------------------------------------------------------------------------
// Idempotency receipts
// ---------------------------------------------------------------------------

interface ReceiptRow {
  id: string; request_hash: string; status: string;
  resource_type: string | null; resource_id: string | null; result_payload: unknown;
  completed_at?: Date; updated_at?: Date;
}

function completedIdentity(receipt: ReceiptRow): string {
  if (!uuid(receipt.id) || receipt.status !== "COMPLETED" || receipt.resource_type !== "RESEARCH_RUN"
    || !uuid(receipt.resource_id)) integrity("IDEMPOTENCY_RECEIPT_INVALID");
  const payload = receipt.result_payload;
  if (!isObject(payload) || Object.keys(payload).length !== 1 || !uuid(payload.runId)
    || payload.runId !== receipt.resource_id) integrity("IDEMPOTENCY_RESULT_PAYLOAD_INVALID");
  return receipt.resource_id;
}

/** Completed receipt recovery BEFORE today's lifecycle/authorization gates. */
async function replayReceipt(client: PoolClient, requestHash: string, scope: string, idempotencyKey: string): Promise<ResearchRunCommandResult | null> {
  const { rows } = await client.query<ReceiptRow>(
    `SELECT id,request_hash,status,resource_type,resource_id,result_payload
     FROM ops.idempotency_keys WHERE scope=$1 AND idempotency_key=$2 FOR UPDATE`, [scope, idempotencyKey],
  );
  if (!rows.length) integrity("IDEMPOTENCY_RECEIPT_MISSING");
  const receipt = rows[0];
  if (receipt.request_hash !== requestHash) throw new ResearchRunIdempotencyConflictError("IDEMPOTENCY_CONFLICT");
  if (receipt.status === "IN_PROGRESS" || receipt.status === "FAILED") throw unavailable();
  const runId = completedIdentity(receipt);
  const row = await selectRun(client, runId);
  if (!row) integrity("IDEMPOTENCY_RUN_MISSING");
  // Canonicality of the receipt's run is verified; scope/lifecycle gates are
  // deliberately NOT re-run here (completed replay survives later archival).
  canonicalReadback(row, { id: runId, issueId: row.issue_id ?? "", manifestId: row.evidence_manifest_id });
  return { status: "replayed", runId };
}

async function completeReceipt(client: PoolClient, receiptId: string, runId: string, requestHash: string): Promise<void> {
  const completed = await client.query<ReceiptRow>(
    `UPDATE ops.idempotency_keys SET status='COMPLETED',resource_type='RESEARCH_RUN',resource_id=$2,
       result_payload=$3::jsonb,completed_at=now(),updated_at=now() WHERE id=$1
     RETURNING id,request_hash,status,resource_type,resource_id,result_payload,completed_at,updated_at`,
    [receiptId, runId, JSON.stringify({ runId })],
  );
  if (completed.rows.length !== 1) integrity("IDEMPOTENCY_COMPLETE_MISSING");
  const receipt = completed.rows[0];
  if (completedIdentity(receipt) !== runId || receipt.id !== receiptId || receipt.request_hash !== requestHash
    || !validDate(receipt.completed_at) || !validDate(receipt.updated_at)) integrity("IDEMPOTENCY_COMPLETE_INVALID");
}

async function reserveReceipt(client: PoolClient, scope: string, input: { idempotencyKey: string; requestHash: string }): Promise<string | null> {
  const { randomUUID } = await import("node:crypto");
  const reserved = await client.query<{ id: string }>(
    `INSERT INTO ops.idempotency_keys (id,scope,idempotency_key,request_hash,status)
     VALUES ($1,$2,$3,$4,'IN_PROGRESS') ON CONFLICT(scope,idempotency_key) DO NOTHING RETURNING id`,
    [randomUUID(), scope, input.idempotencyKey, input.requestHash],
  );
  if (!reserved.rows.length) return null;
  if (reserved.rows.length !== 1 || !uuid(reserved.rows[0].id)) integrity("IDEMPOTENCY_RESERVATION_INVALID");
  return reserved.rows[0].id;
}

// ---------------------------------------------------------------------------
// Evidence manifest validation (existing immutable manifest, consumed only)
// ---------------------------------------------------------------------------

interface ManifestRow {
  id: string; schema_version: number; purpose: string;
  manifest_sha256: string; metadata: unknown; created_at: Date;
}

async function validateEvidenceManifest(client: PoolClient, projectId: string, manifestId: string): Promise<void> {
  const { rows } = await client.query<ManifestRow>(
    `SELECT id,schema_version,purpose,manifest_sha256,metadata,created_at
     FROM core.evidence_manifests WHERE id=$1`, [manifestId],
  );
  if (!rows.length) evidenceUnavailable();
  if (rows.length !== 1) integrity("EVIDENCE_MANIFEST_AMBIGUOUS");
  const manifest = rows[0];
  if (manifest.id !== manifestId) integrity("EVIDENCE_MANIFEST_CANONICAL_INVALID");
  if (manifest.schema_version !== 1 || manifest.purpose !== "CLAIM_ASSESSMENT"
    || !/^[0-9a-f]{64}$/.test(manifest.manifest_sha256)
    || !isObject(manifest.metadata) || Object.keys(manifest.metadata).length !== 0
    || !validDate(manifest.created_at)) integrity("EVIDENCE_MANIFEST_CANONICAL_INVALID");

  const { rows: items } = await client.query<{
    item_id: string; manifest_id: string; ordinal: number; role: string;
    target_type: string; target_id: string; locator_type: string | null;
    locator: unknown; excerpt: string | null; note: string | null; created_at: Date;
  }>(
    `SELECT id AS item_id,manifest_id,ordinal,role,target_type,target_id,locator_type,locator,excerpt,note,created_at
     FROM core.evidence_manifest_items WHERE manifest_id=$1 ORDER BY ordinal`, [manifestId],
  );
  if (!items.length) integrity("EVIDENCE_MANIFEST_ITEMS_EMPTY");
  for (const [index, item] of items.entries()) {
    if (!uuid(item.item_id) || item.manifest_id !== manifestId || item.ordinal !== index + 1
      || !uuid(item.target_id) || item.locator_type !== null || item.locator !== null || item.excerpt !== null
      || !validDate(item.created_at)) integrity("EVIDENCE_ITEM_CANONICAL_INVALID");
  }
  const draftItems = items.map(item => ({ role: item.role, targetType: item.target_type, targetId: item.target_id, note: item.note })) as EvidenceDraftInputItem[];
  let normalized: EvidenceDraftInputItem[];
  try { normalized = normalizeEvidencePreviewInput({ items: draftItems }); }
  catch { integrity("EVIDENCE_MANIFEST_CANONICAL_INVALID"); }
  if (JSON.stringify(normalized) !== JSON.stringify(draftItems)
    || buildEvidenceManifestDraft(draftItems).manifestSha256 !== manifest.manifest_sha256) {
    integrity("EVIDENCE_MANIFEST_HASH_OR_CANONICALITY");
  }
  // Project evidence authorization: every manifest item must still be legal
  // and visible for this exact Project.
  const auth = await loadProjectEvidenceAuthorization(client, projectId);
  await authorizeEvidenceItems(client, auth, draftItems);
}

// ---------------------------------------------------------------------------
// Produced-object reference integrity (audit references, not ownership)
// ---------------------------------------------------------------------------

async function validateProducedReferences(
  client: PoolClient,
  issueId: string,
  projectId: string,
  output: ResearchRunOutput,
): Promise<void> {
  const { produced } = output;

  for (const claimId of produced.claimIds) {
    if (!(await loadIssueCandidateClaim(client, issueId, claimId))) {
      throw new ResearchRunIntegrityError("PRODUCED_CLAIM_NOT_IN_ISSUE");
    }
  }

  if (produced.assessmentIds.length) {
    const { rows } = await client.query<{ assessment_id: string; claim_id: string }>(
      `SELECT a.id AS assessment_id,a.claim_id FROM core.assessments a WHERE a.id = ANY($1::uuid[])`,
      [produced.assessmentIds],
    );
    const byId = new Map(rows.map(row => [row.assessment_id, row.claim_id]));
    for (const assessmentId of produced.assessmentIds) {
      const claimId = byId.get(assessmentId);
      if (!claimId) throw new ResearchRunIntegrityError("PRODUCED_ASSESSMENT_DANGLING");
      if (!(await loadIssueCandidateClaim(client, issueId, claimId))) {
        throw new ResearchRunIntegrityError("PRODUCED_ASSESSMENT_CLAIM_NOT_IN_ISSUE");
      }
    }
  }

  if (produced.resolutionIds.length) {
    const { rows } = await client.query<{ id: string; issue_id: string }>(
      `SELECT id,issue_id FROM core.issue_resolutions WHERE id = ANY($1::uuid[])`, [produced.resolutionIds],
    );
    const byId = new Map(rows.map(row => [row.id, row.issue_id]));
    for (const resolutionId of produced.resolutionIds) {
      if (byId.get(resolutionId) !== issueId) throw new ResearchRunIntegrityError("PRODUCED_RESOLUTION_NOT_IN_ISSUE");
    }
  }

  if (produced.noteRevisionIds.length) {
    // NoteRevision must belong to a Note reachable through THIS project's
    // material graph (project bindings), i.e. the same authorization lens as
    // evidence NOTE_REVISION targets.
    const auth = await loadProjectEvidenceAuthorization(client, projectId);
    const currentRevisions = new Set<string>();
    for (const revisionId of auth.currentRevisionNoteByRevision.keys()) currentRevisions.add(revisionId);
    const pending = produced.noteRevisionIds.filter(id => !currentRevisions.has(id));
    if (pending.length) {
      const noteIds = Array.from(auth.noteIds);
      const { rows } = await client.query<{ revision_id: string }>(
        `SELECT nr.id::text AS revision_id FROM core.note_revisions nr
         WHERE nr.id = ANY($1::uuid[]) AND nr.note_id = ANY($2::uuid[])`,
        [pending, noteIds],
      );
      const found = new Set(rows.map(row => row.revision_id));
      for (const revisionId of pending) {
        if (!found.has(revisionId)) throw new ResearchRunIntegrityError("PRODUCED_NOTE_REVISION_NOT_ACCESSIBLE");
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Lifecycle / authorization write gate (for NEW writes only)
// ---------------------------------------------------------------------------

async function authorizeNewWrite(client: PoolClient, projectId: string, issueId: string): Promise<void> {
  const scope = await loadProjectIssueScope(client, projectId, issueId, { lock: true });
  if (!scope) throw new ResearchRunScopeNotFoundError("PROJECT_OR_ISSUE_NOT_FOUND");
  if (scope.projectLifecycleState !== "ACTIVE") throw new ProjectReadOnlyForResearchRunError("PROJECT_READ_ONLY");
  if (scope.issueLifecycleState === "ARCHIVED") throw new ResearchIssueReadOnlyForResearchRunError("RESEARCH_ISSUE_READ_ONLY");
}

// ---------------------------------------------------------------------------
// START
// ---------------------------------------------------------------------------

const START_SCOPE = "S32:M3A:RESEARCH_RUN_START";

async function insertRunningRun(client: PoolClient, input: ResearchRunStartCommand | ResearchRunReplayCommand, runId: string): Promise<void> {
  const knowledgeCutoff = new Date();
  await client.query(
    `INSERT INTO core.research_runs
       (id,schema_version,issue_id,evidence_manifest_id,status,procedure,execution_contract,environment,output,
        knowledge_cutoff,replay_of,started_at,completed_at)
     VALUES ($1,1,$2,$3,'RUNNING',$4::jsonb,$5::jsonb,$6::jsonb,NULL,$7,$8,now(),NULL)`,
    [
      runId,
      input.issueId,
      input.evidenceManifestId,
      JSON.stringify(input.procedure),
      JSON.stringify(input.executionContract),
      JSON.stringify(input.environment),
      knowledgeCutoff,
      input.replayOf,
    ],
  );
  const row = await selectRun(client, runId);
  const read = canonicalReadback(row, { id: runId, issueId: input.issueId, manifestId: input.evidenceManifestId });
  if (row!.status !== "RUNNING" || row!.completed_at !== null || row!.replay_of !== input.replayOf) {
    integrity("RESEARCH_RUN_START_READBACK_MISMATCH");
  }
  if (JSON.stringify(read.procedure) !== JSON.stringify(input.procedure)
    || JSON.stringify(read.executionContract) !== JSON.stringify(input.executionContract)) {
    integrity("RESEARCH_RUN_START_CANONICAL_MISMATCH");
  }
  if (read.output !== null) integrity("RESEARCH_RUN_START_OUTPUT_MUST_BE_NULL");
}

// ---------------------------------------------------------------------------
// Store factory
// ---------------------------------------------------------------------------

export function createPostgresResearchRunCommandStore(pool: Pool): ResearchRunCommandStore {
  return {
    start(input) {
      return serializableWithRetry(pool, async client => {
        const scope = `${START_SCOPE}:${input.projectId}:${input.issueId}`;
        const receiptId = await reserveReceipt(client, scope, input);
        if (receiptId === null) {
          const replayed = await replayReceipt(client, input.requestHash, scope, input.idempotencyKey);
          if (replayed) return replayed;
          integrity("IDEMPOTENCY_RESERVATION_MISSING");
        }
        await authorizeNewWrite(client, input.projectId, input.issueId);
        await validateEvidenceManifest(client, input.projectId, input.evidenceManifestId);
        if (input.replayOf !== null) {
          // START carrying a replayOf reference must point at a terminal run
          // of this exact issue (defense in depth; replay() is the main path).
          const prior = await selectRun(client, input.replayOf);
          if (!prior || prior.issue_id !== input.issueId) throw new ResearchRunReplayInvalidError("REPLAY_PRIOR_NOT_IN_ISSUE");
          if (prior.status === "RUNNING") throw new ResearchRunReplayInvalidError("REPLAY_PRIOR_NOT_TERMINAL");
        }
        await insertRunningRun(client, input, input.runId);
        await completeReceipt(client, receiptId!, input.runId, input.requestHash);
        return { status: "created", runId: input.runId };
      });
    },

    transition(input, from) {
      return serializableWithRetry(pool, async client => {
        const action = input.status;
        const scope = `S32:M3A:RESEARCH_RUN_${action}:${input.projectId}:${input.issueId}:${input.runId}`;
        const receiptId = await reserveReceipt(client, scope, input);
        if (receiptId === null) {
          const replayed = await replayReceipt(client, input.requestHash, scope, input.idempotencyKey);
          if (replayed) return replayed;
          integrity("IDEMPOTENCY_RESERVATION_MISSING");
        }
        // Completed-receipt recovery happened above. New transition writes
        // must pass today's lifecycle/authorization gate.
        await authorizeNewWrite(client, input.projectId, input.issueId);

        const current = await client.query<RunRow>(
          `SELECT id,schema_version,issue_id,evidence_manifest_id,status,procedure,execution_contract,environment,output,
             knowledge_cutoff,replay_of,started_at,completed_at,created_at
           FROM core.research_runs WHERE id=$1 AND issue_id=$2 FOR UPDATE`, [input.runId, input.issueId],
        );
        if (!current.rows.length) throw new ResearchRunNotFoundError("RESEARCH_RUN_NOT_FOUND");
        const row = current.rows[0];
        canonicalReadback(row, { id: input.runId, issueId: input.issueId, manifestId: row.evidence_manifest_id });
        if (row.status !== from) {
          if (row.status !== "RUNNING") throw new ResearchRunAlreadyTerminalError("RESEARCH_RUN_ALREADY_TERMINAL");
          integrity("RESEARCH_RUN_TRANSITION_STATE_UNEXPECTED");
        }

        if (input.output !== null) {
          await validateProducedReferences(client, input.issueId, input.projectId, input.output);
        }

        const updated = await client.query(
          `UPDATE core.research_runs SET status=$2,output=$3::jsonb,completed_at=now()
           WHERE id=$1 AND status='RUNNING' RETURNING id`, [input.runId, action, input.output === null ? null : JSON.stringify(input.output)],
        );
        if (updated.rows.length !== 1 || updated.rows[0].id !== input.runId) {
          // Lost the RUNNING row between SELECT and UPDATE inside the same
          // SERIALIZABLE transaction — treat as terminal conflict.
          throw new ResearchRunAlreadyTerminalError("RESEARCH_RUN_ALREADY_TERMINAL");
        }
        const after = await selectRun(client, input.runId);
        const read = canonicalReadback(after, { id: input.runId, issueId: input.issueId, manifestId: row.evidence_manifest_id });
        if (after!.status !== action || !validDate(after!.completed_at)) integrity("RESEARCH_RUN_TRANSITION_READBACK_MISMATCH");
        // Semantic fields must be unchanged by the transition.
        if (JSON.stringify(after!.procedure) !== JSON.stringify(row.procedure)
          || JSON.stringify(after!.execution_contract) !== JSON.stringify(row.execution_contract)
          || JSON.stringify(after!.environment) !== JSON.stringify(row.environment)
          || after!.evidence_manifest_id !== row.evidence_manifest_id
          || after!.replay_of !== row.replay_of
          || after!.started_at.getTime() !== row.started_at.getTime()
          || after!.knowledge_cutoff?.getTime() !== row.knowledge_cutoff?.getTime()) {
          integrity("RESEARCH_RUN_SEMANTIC_FIELDS_MUTATED");
        }
        if (JSON.stringify(read.output) !== (input.output === null ? "null" : JSON.stringify(input.output))) {
          integrity("RESEARCH_RUN_TRANSITION_OUTPUT_MISMATCH");
        }
        await completeReceipt(client, receiptId!, input.runId, input.requestHash);
        return { status: "created", runId: input.runId };
      });
    },

    replay(input) {
      return serializableWithRetry(pool, async client => {
        const scope = `S32:M3A:RESEARCH_RUN_REPLAY:${input.projectId}:${input.issueId}:${input.priorRunId}`;
        const receiptId = await reserveReceipt(client, scope, input);
        if (receiptId === null) {
          const replayed = await replayReceipt(client, input.requestHash, scope, input.idempotencyKey);
          if (replayed) return replayed;
          integrity("IDEMPOTENCY_RESERVATION_MISSING");
        }
        await authorizeNewWrite(client, input.projectId, input.issueId);

        // Prior run: exists, belongs to exact issue, terminal, and is NOT
        // mutated (read-only FOR UPDATE lock; no UPDATE statements on it).
        const priorRows = await client.query<RunRow>(
          `SELECT id,schema_version,issue_id,evidence_manifest_id,status,procedure,execution_contract,environment,output,
             knowledge_cutoff,replay_of,started_at,completed_at,created_at
           FROM core.research_runs WHERE id=$1 FOR UPDATE`, [input.priorRunId],
        );
        if (!priorRows.rows.length) throw new ResearchRunReplayInvalidError("REPLAY_PRIOR_NOT_FOUND");
        const prior = priorRows.rows[0];
        if (prior.issue_id !== input.issueId) throw new ResearchRunReplayInvalidError("REPLAY_PRIOR_NOT_IN_ISSUE");
        canonicalReadback(prior, { id: input.priorRunId, issueId: input.issueId, manifestId: prior.evidence_manifest_id });
        if (prior.status === "RUNNING") throw new ResearchRunReplayInvalidError("REPLAY_PRIOR_NOT_TERMINAL");

        await validateEvidenceManifest(client, input.projectId, input.evidenceManifestId);
        await insertRunningRun(client, input, input.runId);
        await completeReceipt(client, receiptId!, input.runId, input.requestHash);
        return { status: "created", runId: input.runId };
      });
    },
  };
}
