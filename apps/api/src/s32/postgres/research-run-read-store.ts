import type { Pool, PoolClient } from "pg";
import {
  ResearchRunIntegrityError,
  ResearchRunStoreUnavailableError,
  type ResearchRunDetail,
  type ResearchRunEvidenceSnapshot,
  type ResearchRunGetLookup,
  type ResearchRunListLookup,
  type ResearchRunReadStore,
  type ResearchRunSummary,
} from "../application/research-runs.js";
import {
  decodeResearchRunCursor,
  encodeResearchRunCursor,
  readResearchRunEnvironment,
  readResearchRunExecutionContract,
  readResearchRunOutput,
  readResearchRunProcedure,
  type ResearchRunEnvironment,
  type ResearchRunExecutionContract,
  type ResearchRunOutput,
  type ResearchRunProcedure,
  type ResearchRunStatus,
} from "../domain/research-run.js";
import { buildEvidenceManifestDraft, normalizeEvidencePreviewInput, type EvidenceDraftInputItem } from "../domain/evidence-selection.js";
import {
  loadProjectEvidenceAuthorization,
  loadProjectIssueScope,
  ProjectEvidenceIntegrityError,
  type ProjectEvidenceAuthorization,
} from "./project-evidence-authorization.js";

/**
 * ResearchRun PostgreSQL read store (M3-A Gate 2, Task 3).
 *
 * Read-only: every query path runs inside a single
 * `BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY` transaction with zero
 * mutation SQL. Corrupt persisted rows fail closed; historical runs stay
 * visible even when their evidence is no longer authorized (summary-only,
 * no target leakage).
 */

const uuidPattern = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/;
const MAX_LINEAGE_DEPTH = 100;

function uuid(value: unknown): value is string { return typeof value === "string" && uuidPattern.test(value); }
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function validDate(value: unknown): value is Date { return value instanceof Date && !Number.isNaN(value.getTime()); }
function integrity(detail: string): never { throw new ResearchRunIntegrityError(detail); }
function unavailable(): ResearchRunStoreUnavailableError {
  return new ResearchRunStoreUnavailableError("RESEARCH_RUN_STORE_UNAVAILABLE");
}

function isConnectionError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string") {
    if (code.startsWith("08")) return true;
    if (["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "ETIMEDOUT", "EPIPE", "57P01", "57P02", "57P03", "53300"].includes(code)) return true;
  }
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" &&
    /connection terminated|connection timeout|timeout exceeded|query read timeout|connection refused|connection reset/i.test(message);
}

function classify(error: unknown): Error {
  if (error instanceof ResearchRunIntegrityError || error instanceof ResearchRunStoreUnavailableError) return error;
  if (error instanceof ProjectEvidenceIntegrityError) return new ResearchRunIntegrityError(error.message);
  if (isConnectionError(error)) return unavailable();
  return error as Error;
}

async function readTransaction<T>(pool: Pool, run: (client: PoolClient) => Promise<T>): Promise<T> {
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

// ---------------------------------------------------------------------------
// Row shapes
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
  started_at_micros: string;
}

interface ManifestRow {
  id: string; schema_version: number; purpose: string;
  manifest_sha256: string; metadata: unknown; created_at: Date;
}

interface ManifestItemRow {
  item_id: string; manifest_id: string; ordinal: number; role: string;
  target_type: string; target_id: string; locator_type: string | null;
  locator: unknown; excerpt: string | null; note: string | null; created_at: Date;
}

const RUN_COLUMNS = `id,schema_version,issue_id,evidence_manifest_id,status,procedure,execution_contract,environment,output,
  knowledge_cutoff,replay_of,started_at,completed_at,created_at,
  (extract(epoch FROM started_at) * 1000000)::bigint AS started_at_micros`;

/** Canonical row read: domain readers + persisted invariants. Fail-closed. */
function canonicalRun(row: RunRow | undefined, expectIssueId: string): {
  procedure: ResearchRunProcedure;
  executionContract: ResearchRunExecutionContract;
  environment: ResearchRunEnvironment;
  output: ResearchRunOutput | null;
} {
  if (!row) integrity("RESEARCH_RUN_READBACK_MISSING");
  if (!uuid(row.id)) integrity("RESEARCH_RUN_ID_INVALID");
  if (row.schema_version !== 1) integrity("RESEARCH_RUN_SCHEMA_VERSION_INVALID");
  // Application contract: issue_id mandatory and must equal the exact scope.
  if (row.issue_id !== expectIssueId) integrity("RESEARCH_RUN_ISSUE_MISMATCH");
  if (!uuid(row.evidence_manifest_id)) integrity("RESEARCH_RUN_MANIFEST_INVALID");
  if (row.status !== "RUNNING" && row.status !== "SUCCEEDED" && row.status !== "FAILED" && row.status !== "CANCELLED") {
    integrity("RESEARCH_RUN_STATUS_INVALID");
  }
  if (!validDate(row.started_at) || !validDate(row.created_at)) integrity("RESEARCH_RUN_TIMESTAMPS_INVALID");
  if (row.knowledge_cutoff !== null && !validDate(row.knowledge_cutoff)) integrity("RESEARCH_RUN_CUTOFF_INVALID");
  if (row.replay_of !== null && (!uuid(row.replay_of) || row.replay_of === row.id)) integrity("RESEARCH_RUN_REPLAY_OF_INVALID");
  const terminal = row.status !== "RUNNING";
  if (terminal !== (row.completed_at !== null)) integrity("RESEARCH_RUN_COMPLETION_INVARIANT");
  if (terminal && !validDate(row.completed_at)) integrity("RESEARCH_RUN_COMPLETED_AT_INVALID");
  let procedure: ResearchRunProcedure;
  let executionContract: ResearchRunExecutionContract;
  let environment: ResearchRunEnvironment;
  try {
    procedure = readResearchRunProcedure(row.procedure);
    executionContract = readResearchRunExecutionContract(row.execution_contract);
    environment = readResearchRunEnvironment(row.environment);
  } catch { integrity("RESEARCH_RUN_CANONICAL_INVALID"); }
  let output: ResearchRunOutput | null = null;
  if (row.output !== null) {
    try { output = readResearchRunOutput(row.output); } catch { integrity("RESEARCH_RUN_OUTPUT_CANONICAL_INVALID"); }
  }
  if (row.status === "RUNNING" && output !== null) integrity("RESEARCH_RUN_RUNNING_WITH_OUTPUT");
  if (row.status === "SUCCEEDED" && output === null) integrity("RESEARCH_RUN_SUCCEEDED_WITHOUT_OUTPUT");
  if (!/^\d{1,19}$/.test(String(row.started_at_micros)) || String(row.started_at_micros) === "0") {
    integrity("RESEARCH_RUN_MICROS_INVALID");
  }
  return { procedure, executionContract, environment, output };
}

// ---------------------------------------------------------------------------
// Evidence manifest snapshot
// ---------------------------------------------------------------------------

async function loadManifests(client: PoolClient, manifestIds: string[]): Promise<Map<string, { manifest: ManifestRow; items: ManifestItemRow[]; canonicalItems: EvidenceDraftInputItem[] }>> {
  const result = new Map<string, { manifest: ManifestRow; items: ManifestItemRow[]; canonicalItems: EvidenceDraftInputItem[] }>();
  if (!manifestIds.length) return result;
  const { rows: manifests } = await client.query<ManifestRow>(
    `SELECT id,schema_version,purpose,manifest_sha256,metadata,created_at
     FROM core.evidence_manifests WHERE id = ANY($1::uuid[])`, [manifestIds],
  );
  const { rows: items } = await client.query<ManifestItemRow>(
    `SELECT id AS item_id,manifest_id,ordinal,role,target_type,target_id,locator_type,locator,excerpt,note,created_at
     FROM core.evidence_manifest_items WHERE manifest_id = ANY($1::uuid[]) ORDER BY manifest_id, ordinal`, [manifestIds],
  );
  for (const manifest of manifests) {
    if (manifest.schema_version !== 1 || manifest.purpose !== "CLAIM_ASSESSMENT"
      || !/^[0-9a-f]{64}$/.test(manifest.manifest_sha256)
      || !isObject(manifest.metadata) || Object.keys(manifest.metadata).length !== 0
      || !validDate(manifest.created_at)) integrity("EVIDENCE_MANIFEST_CANONICAL_INVALID");
    result.set(manifest.id, { manifest, items: [], canonicalItems: [] });
  }
  for (const manifestId of manifestIds) {
    if (!result.has(manifestId)) integrity("EVIDENCE_MANIFEST_MISSING");
  }
  for (const item of items) {
    const bucket = result.get(item.manifest_id);
    if (bucket) bucket.items.push(item);
  }
  for (const [manifestId, bucket] of result) {
    if (!bucket.items.length) integrity("EVIDENCE_MANIFEST_ITEMS_EMPTY");
    for (const [index, item] of bucket.items.entries()) {
      if (!uuid(item.item_id) || item.manifest_id !== manifestId || item.ordinal !== index + 1
        || !uuid(item.target_id) || item.locator_type !== null || item.locator !== null || item.excerpt !== null
        || !validDate(item.created_at)) integrity("EVIDENCE_ITEM_CANONICAL_INVALID");
    }
    const draftItems = bucket.items.map(item => ({ role: item.role, targetType: item.target_type, targetId: item.target_id, note: item.note })) as EvidenceDraftInputItem[];
    let normalized: EvidenceDraftInputItem[];
    try { normalized = normalizeEvidencePreviewInput({ items: draftItems }); }
    catch { integrity("EVIDENCE_MANIFEST_CANONICAL_INVALID"); }
    if (JSON.stringify(normalized) !== JSON.stringify(draftItems)
      || buildEvidenceManifestDraft(draftItems).manifestSha256 !== bucket.manifest.manifest_sha256) {
      integrity("EVIDENCE_MANIFEST_HASH_OR_CANONICALITY");
    }
    bucket.canonicalItems = draftItems;
  }
  return result;
}

/**
 * Evidence availability: every manifest item must still be authorized for
 * this Project (historical NoteRevisions on Project-owned notes stay valid,
 * mirroring the Assessment read-store pattern).
 */
function evidenceAvailable(auth: ProjectEvidenceAuthorization, items: EvidenceDraftInputItem[]): boolean {
  const currentRevisions = new Set<string>(auth.currentRevisionNoteByRevision.keys());
  for (const item of items) {
    if (item.targetType === "SOURCE") {
      if (!auth.sourceIds.has(item.targetId)) return false;
    } else if (item.targetType === "SOURCE_ASSET") {
      if (!auth.sourceAssetIds.has(item.targetId)) return false;
    } else if (item.targetType === "NOTE_REVISION") {
      if (currentRevisions.has(item.targetId)) continue;
      // Historical revision: validated lazily by the caller (needs a query).
      return "HISTORICAL" as unknown as boolean;
    } else {
      return false;
    }
  }
  return true;
}

async function historicalRevisionsBelongToProjectNotes(
  client: PoolClient,
  auth: ProjectEvidenceAuthorization,
  revisionIds: string[],
): Promise<boolean> {
  if (!revisionIds.length) return true;
  const noteIds = Array.from(auth.noteIds);
  if (!noteIds.length) return false;
  const { rows } = await client.query<{ revision_id: string }>(
    `SELECT nr.id::text AS revision_id FROM core.note_revisions nr
     WHERE nr.id = ANY($1::uuid[]) AND nr.note_id = ANY($2::uuid[])`,
    [revisionIds, noteIds],
  );
  const found = new Set(rows.map(row => row.revision_id));
  return revisionIds.every(id => found.has(id));
}

/** Full availability check including historical revisions (single query). */
async function checkEvidenceAvailability(
  client: PoolClient,
  auth: ProjectEvidenceAuthorization,
  items: EvidenceDraftInputItem[],
): Promise<boolean> {
  const currentRevisions = new Set<string>(auth.currentRevisionNoteByRevision.keys());
  const historical: string[] = [];
  for (const item of items) {
    if (item.targetType === "SOURCE") {
      if (!auth.sourceIds.has(item.targetId)) return false;
    } else if (item.targetType === "SOURCE_ASSET") {
      if (!auth.sourceAssetIds.has(item.targetId)) return false;
    } else if (item.targetType === "NOTE_REVISION") {
      if (!currentRevisions.has(item.targetId)) historical.push(item.targetId);
    } else {
      return false;
    }
  }
  return await historicalRevisionsBelongToProjectNotes(client, auth, historical);
}

function evidenceSnapshot(
  bucket: { manifest: ManifestRow; items: ManifestItemRow[] },
  available: boolean,
): ResearchRunEvidenceSnapshot {
  const base = {
    id: bucket.manifest.id,
    manifestSha256: bucket.manifest.manifest_sha256,
    itemCount: bucket.items.length,
    available,
  };
  // Item details only when available; NEVER expose target IDs.
  if (!available) return base;
  return {
    ...base,
    items: bucket.items.map(item => ({ ordinal: item.ordinal, role: item.role, targetType: item.target_type, note: item.note })),
  };
}

// ---------------------------------------------------------------------------
// Summary construction
// ---------------------------------------------------------------------------

function toSummary(row: RunRow, snapshot: ResearchRunEvidenceSnapshot): ResearchRunSummary {
  return {
    runId: row.id,
    issueId: row.issue_id!,
    status: row.status,
    replayOf: row.replay_of,
    startedAtMicros: String(row.started_at_micros),
    startedAt: row.started_at.toISOString(),
    completedAt: row.completed_at ? row.completed_at.toISOString() : null,
    evidenceManifest: {
      id: snapshot.id,
      manifestSha256: snapshot.manifestSha256,
      itemCount: snapshot.itemCount,
      available: snapshot.available,
    },
  };
}

// ---------------------------------------------------------------------------
// Store factory
// ---------------------------------------------------------------------------

export function createPostgresResearchRunReadStore(pool: Pool): ResearchRunReadStore {
  return {
    list(input) {
      return readTransaction(pool, async client => {
        // Reads allow every lifecycle state; only scope must exist.
        const scope = await loadProjectIssueScope(client, input.projectId, input.issueId);
        if (!scope) return { kind: "scope-missing" } as const;

        const cursor = input.cursor ? decodeResearchRunCursor(input.cursor) : null;
        const cursorMicros = cursor?.startedAtMicros ?? null;
        const cursorId = cursor?.id ?? null;
        const { rows } = await client.query<RunRow>(
          `/* research-run-history */
           SELECT ${RUN_COLUMNS}
           FROM core.research_runs
           WHERE issue_id = $1
             AND (
               $2::bigint IS NULL
               OR (
                 (extract(epoch FROM started_at) * 1000000)::bigint, id
               ) < ($2::bigint, $3::uuid)
             )
           ORDER BY started_at DESC, id DESC
           LIMIT $4`,
          [input.issueId, cursorMicros, cursorId, input.limit + 1],
        );

        const page = rows.slice(0, input.limit);
        for (const row of page) canonicalRun(row, input.issueId);

        const auth = await loadProjectEvidenceAuthorization(client, input.projectId);
        const manifests = await loadManifests(client, Array.from(new Set(page.map(row => row.evidence_manifest_id))));
        const summaries: ResearchRunSummary[] = [];
        for (const row of page) {
          const bucket = manifests.get(row.evidence_manifest_id)!;
          const available = await checkEvidenceAvailability(client, auth, bucket.canonicalItems);
          summaries.push(toSummary(row, evidenceSnapshot(bucket, available)));
        }

        let nextCursor: string | null = null;
        if (rows.length > input.limit && page.length) {
          const last = page[page.length - 1];
          nextCursor = encodeResearchRunCursor({ startedAtMicros: String(last.started_at_micros), id: last.id });
        }
        return { kind: "ok", value: { runs: summaries, nextCursor } } as const;
      });
    },

    get(input) {
      return readTransaction(pool, async client => {
        const scope = await loadProjectIssueScope(client, input.projectId, input.issueId);
        if (!scope) return { kind: "scope-missing" } as const;

        const { rows } = await client.query<RunRow>(
          `/* research-run-detail */
           SELECT ${RUN_COLUMNS}
           FROM core.research_runs
           WHERE id = $1 AND issue_id = $2
           LIMIT 1`,
          [input.runId, input.issueId],
        );
        if (!rows.length) {
          // Distinguish not-visible from not-found without leaking existence:
          // both map to the same application error; the store-level split
          // exists for future HTTP 404 equivalence.
          const exists = await client.query(`SELECT 1 FROM core.research_runs WHERE id=$1`, [input.runId]);
          return exists.rows.length ? { kind: "not-visible" } as const : { kind: "not-found" } as const;
        }
        const row = rows[0];
        const canonical = canonicalRun(row, input.issueId);

        const auth = await loadProjectEvidenceAuthorization(client, input.projectId);
        const manifests = await loadManifests(client, [row.evidence_manifest_id]);
        const bucket = manifests.get(row.evidence_manifest_id)!;
        const available = await checkEvidenceAvailability(client, auth, bucket.canonicalItems);

        // Produced reference integrity on read.
        if (canonical.output !== null) {
          await validateProducedReferences(client, input.issueId, input.projectId, canonical.output, auth);
        }

        // Replay lineage: walk replay_of, bounded depth, cycle-safe.
        const ancestors: ResearchRunSummary[] = [];
        const seen = new Set<string>([row.id]);
        let parentId = row.replay_of;
        while (parentId !== null) {
          if (ancestors.length >= MAX_LINEAGE_DEPTH) integrity("RESEARCH_RUN_LINEAGE_DEPTH_EXCEEDED");
          if (seen.has(parentId)) integrity("RESEARCH_RUN_LINEAGE_CYCLE");
          seen.add(parentId);
          const { rows: parentRows } = await client.query<RunRow>(
            `SELECT ${RUN_COLUMNS} FROM core.research_runs WHERE id=$1 LIMIT 1`, [parentId],
          );
          if (!parentRows.length) integrity("RESEARCH_RUN_LINEAGE_PARENT_MISSING");
          const parent = parentRows[0];
          canonicalRun(parent, input.issueId); // exact-issue + canonical gate
          if (parent.status === "RUNNING") integrity("RESEARCH_RUN_LINEAGE_PARENT_RUNNING");
          const parentManifests = await loadManifests(client, [parent.evidence_manifest_id]);
          const parentBucket = parentManifests.get(parent.evidence_manifest_id)!;
          const parentAvailable = await checkEvidenceAvailability(client, auth, parentBucket.canonicalItems);
          ancestors.unshift(toSummary(parent, evidenceSnapshot(parentBucket, parentAvailable)));
          parentId = parent.replay_of;
        }

        const detail: ResearchRunDetail = {
          run: {
            runId: row.id,
            projectId: input.projectId,
            issueId: row.issue_id!,
            status: row.status,
            evidenceManifestId: row.evidence_manifest_id,
            replayOf: row.replay_of,
            procedure: canonical.procedure,
            executionContract: canonical.executionContract,
            environment: canonical.environment,
            output: canonical.output,
            knowledgeCutoff: row.knowledge_cutoff ? row.knowledge_cutoff.toISOString() : null,
            startedAt: row.started_at.toISOString(),
            completedAt: row.completed_at ? row.completed_at.toISOString() : null,
            createdAt: row.created_at.toISOString(),
          },
          evidenceManifest: evidenceSnapshot(bucket, available),
          ancestors,
        };
        return { kind: "ok", value: detail } as const;
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Produced reference integrity (read-side, historical revisions allowed)
// ---------------------------------------------------------------------------

async function validateProducedReferences(
  client: PoolClient,
  issueId: string,
  projectId: string,
  output: ResearchRunOutput,
  auth: ProjectEvidenceAuthorization,
): Promise<void> {
  const { produced } = output;

  if (produced.claimIds.length) {
    const { rows } = await client.query<{ claim_id: string }>(
      `SELECT ric.claim_id FROM core.research_issue_claims ric
       WHERE ric.issue_id=$1 AND ric.claim_id = ANY($2::uuid[])`, [issueId, produced.claimIds],
    );
    const inIssue = new Set(rows.map(row => row.claim_id));
    for (const claimId of produced.claimIds) {
      if (!inIssue.has(claimId)) integrity("PRODUCED_CLAIM_NOT_IN_ISSUE");
    }
  }

  if (produced.assessmentIds.length) {
    const { rows } = await client.query<{ id: string; claim_id: string }>(
      `SELECT a.id,a.claim_id FROM core.assessments a WHERE a.id = ANY($1::uuid[])`, [produced.assessmentIds],
    );
    const byId = new Map(rows.map(row => [row.id, row.claim_id]));
    const claimIds: string[] = [];
    for (const assessmentId of produced.assessmentIds) {
      const claimId = byId.get(assessmentId);
      if (!claimId) integrity("PRODUCED_ASSESSMENT_DANGLING");
      claimIds.push(claimId);
    }
    const { rows: claimRows } = await client.query<{ claim_id: string }>(
      `SELECT ric.claim_id FROM core.research_issue_claims ric
       WHERE ric.issue_id=$1 AND ric.claim_id = ANY($2::uuid[])`, [issueId, claimIds],
    );
    const inIssue = new Set(claimRows.map(row => row.claim_id));
    for (const claimId of claimIds) {
      if (!inIssue.has(claimId)) integrity("PRODUCED_ASSESSMENT_CLAIM_NOT_IN_ISSUE");
    }
  }

  if (produced.resolutionIds.length) {
    const { rows } = await client.query<{ id: string; issue_id: string }>(
      `SELECT id,issue_id FROM core.issue_resolutions WHERE id = ANY($1::uuid[])`, [produced.resolutionIds],
    );
    const byId = new Map(rows.map(row => [row.id, row.issue_id]));
    for (const resolutionId of produced.resolutionIds) {
      if (byId.get(resolutionId) !== issueId) integrity("PRODUCED_RESOLUTION_NOT_IN_ISSUE");
    }
  }

  if (produced.noteRevisionIds.length) {
    const ok = await historicalRevisionsBelongToProjectNotes(client, auth, produced.noteRevisionIds);
    if (!ok) integrity("PRODUCED_NOTE_REVISION_NOT_ACCESSIBLE");
  }
}
