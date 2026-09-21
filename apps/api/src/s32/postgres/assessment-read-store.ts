import type { Pool, PoolClient } from "pg";
import {
  AssessmentIntegrityError,
  AssessmentStoreUnavailableError,
  type AssessmentDetailLookup,
  type AssessmentGetCommand,
  type AssessmentHistoryLookup,
  type AssessmentListCommand,
  type AssessmentReadStore,
} from "../application/assessments.js";
import {
  encodeAssessmentCursor,
  type AssessmentDetailResponse,
  type AssessmentManifestItem,
  type AssessmentManifestSummary,
  type AssessmentRecord,
  type AssessmentSummary,
} from "../domain/assessment.js";
import {
  buildEvidenceManifestDraft,
  normalizeEvidenceItemNote,
  type EvidenceDraftInputItem,
} from "../domain/evidence-selection.js";
import {
  ProjectEvidenceIntegrityError,
  loadProjectClaimScope,
  loadProjectEvidenceAuthorization,
  type ProjectEvidenceAuthorization,
} from "./project-evidence-authorization.js";

const uuidPattern = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const stances = new Set(["SUPPORTS", "CONTRADICTS", "INCONCLUSIVE"]);
const confidences = new Set(["LOW", "MEDIUM", "HIGH"]);
const actorTypes = new Set(["HUMAN", "AI_SYSTEM", "SYSTEM_PROCESS", "EXTERNAL_PERSON", "INSTITUTION", "UNKNOWN"]);
const roles = new Set(["SUPPORTING", "CONTRADICTORY", "CONTEXTUAL"]);
const targetTypes = new Set(["SOURCE", "SOURCE_ASSET", "NOTE_REVISION"]);

function integrity(detail: string): never {
  throw new AssessmentIntegrityError(detail);
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function emptyObject(value: unknown): boolean {
  return plainObject(value) && Object.keys(value).length === 0;
}

function validDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

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
  return typeof message === "string" &&
    /connection terminated|connection timeout|timeout exceeded|query read timeout|connection refused|connection reset/i.test(message);
}

function classify(error: unknown): Error {
  if (error instanceof AssessmentIntegrityError || error instanceof AssessmentStoreUnavailableError) return error;
  if (error instanceof ProjectEvidenceIntegrityError) return new AssessmentIntegrityError(error.message);
  if (isConnectionError(error)) return new AssessmentStoreUnavailableError("ASSESSMENT_STORE_UNAVAILABLE");
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

interface VisibleAssessmentRow {
  assessment_id: string;
  claim_id: string;
  actor_id: string | null;
  stance: string;
  confidence_level: string | null;
  numeric_score: number | string | null;
  score_kind: string | null;
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

interface ActorRow {
  actor_id: string;
  actor_type: string;
  display_name: string;
  actor_metadata: unknown;
  actor_created_at: Date;
  actor_updated_at: Date;
}

function authArrays(auth: ProjectEvidenceAuthorization): [string[], string[], string[]] {
  return [
    Array.from(auth.sourceIds),
    Array.from(auth.sourceAssetIds),
    Array.from(auth.noteIds),
  ];
}

function visibilityPredicate(itemAlias: string, sourceParam: number, assetParam: number, noteParam: number): string {
  return `
    EXISTS (
      SELECT 1
      FROM core.evidence_manifest_items emi_exists
      WHERE emi_exists.manifest_id = em.id
    )
    AND NOT EXISTS (
      SELECT 1
      FROM core.evidence_manifest_items ${itemAlias}
      WHERE ${itemAlias}.manifest_id = em.id
        AND (
          ${itemAlias}.target_type NOT IN ('SOURCE','SOURCE_ASSET','NOTE_REVISION')
          OR (
            ${itemAlias}.target_type = 'SOURCE'
            AND NOT (${itemAlias}.target_id = ANY($${sourceParam}::uuid[]))
          )
          OR (
            ${itemAlias}.target_type = 'SOURCE_ASSET'
            AND NOT (${itemAlias}.target_id = ANY($${assetParam}::uuid[]))
          )
          OR (
            ${itemAlias}.target_type = 'NOTE_REVISION'
            AND NOT EXISTS (
              SELECT 1
              FROM core.note_revisions nr
              WHERE nr.id = ${itemAlias}.target_id
                AND nr.note_id = ANY($${noteParam}::uuid[])
            )
          )
        )
    )`;
}

async function visibleHistoryRows(
  client: PoolClient,
  input: AssessmentListCommand,
  auth: ProjectEvidenceAuthorization,
): Promise<VisibleAssessmentRow[]> {
  const [sources, assets, notes] = authArrays(auth);
  const cursorAt = input.cursor?.createdAt ?? null;
  const cursorId = input.cursor?.id ?? null;
  const { rows } = await client.query<VisibleAssessmentRow>(
    `/* assessment-history-visible */
     SELECT
       a.id AS assessment_id,
       a.claim_id,
       a.actor_id,
       a.stance,
       a.confidence_level,
       a.numeric_score,
       a.score_kind,
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
     JOIN core.evidence_manifests em ON em.id = a.evidence_manifest_id
     WHERE a.claim_id = $1
       AND ${visibilityPredicate("emi", 2, 3, 4)}
       AND (
         $5::timestamptz IS NULL
         OR (a.created_at, a.id) < ($5::timestamptz, $6::uuid)
       )
     ORDER BY a.created_at DESC, a.id DESC
     LIMIT $7`,
    [input.claimId, sources, assets, notes, cursorAt, cursorId, input.limit + 1],
  );
  return rows;
}

async function visibleDetailRows(
  client: PoolClient,
  input: AssessmentGetCommand,
  auth: ProjectEvidenceAuthorization,
): Promise<VisibleAssessmentRow[]> {
  const [sources, assets, notes] = authArrays(auth);
  const { rows } = await client.query<VisibleAssessmentRow>(
    `/* assessment-detail-visible */
     SELECT
       a.id AS assessment_id,
       a.claim_id,
       a.actor_id,
       a.stance,
       a.confidence_level,
       a.numeric_score,
       a.score_kind,
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
     JOIN core.evidence_manifests em ON em.id = a.evidence_manifest_id
     WHERE a.claim_id = $1
       AND a.id = $2
       AND ${visibilityPredicate("emi", 3, 4, 5)}
     LIMIT 1`,
    [input.claimId, input.assessmentId, sources, assets, notes],
  );
  return rows;
}

async function loadItems(
  client: PoolClient,
  manifestIds: string[],
): Promise<Map<string, ManifestItemRow[]>> {
  const result = new Map<string, ManifestItemRow[]>();
  for (const id of manifestIds) result.set(id, []);
  if (!manifestIds.length) return result;

  const { rows } = await client.query<ManifestItemRow>(
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
     WHERE manifest_id = ANY($1::uuid[])
     ORDER BY manifest_id, ordinal`,
    [manifestIds],
  );
  for (const row of rows) {
    const id = row.manifest_id.toLowerCase();
    const bucket = result.get(id);
    if (!bucket) integrity("MANIFEST_ITEM_ORPHAN");
    bucket.push(row);
  }
  return result;
}

async function loadActors(
  client: PoolClient,
  actorIds: string[],
): Promise<Map<string, ActorRow>> {
  const map = new Map<string, ActorRow>();
  if (!actorIds.length) return map;
  const { rows } = await client.query<ActorRow>(
    `SELECT
       id AS actor_id,
       actor_type,
       display_name,
       metadata AS actor_metadata,
       created_at AS actor_created_at,
       updated_at AS actor_updated_at
     FROM core.actors
     WHERE id = ANY($1::uuid[])`,
    [actorIds],
  );
  for (const row of rows) map.set(row.actor_id.toLowerCase(), row);
  return map;
}

function canonicalActor(row: ActorRow | undefined, expectedId: string): void {
  if (!row || !uuidPattern.test(row.actor_id) || row.actor_id.toLowerCase() !== expectedId) integrity("ASSESSMENT_ACTOR_INVALID");
  if (!actorTypes.has(row.actor_type)) integrity("ASSESSMENT_ACTOR_TYPE_INVALID");
  if (typeof row.display_name !== "string" || !row.display_name.trim()) integrity("ASSESSMENT_ACTOR_NAME_INVALID");
  if (!plainObject(row.actor_metadata)) integrity("ASSESSMENT_ACTOR_METADATA_INVALID");
  if (!validDate(row.actor_created_at) || !validDate(row.actor_updated_at)) integrity("ASSESSMENT_ACTOR_DATE_INVALID");
}

function numericScore(value: number | string | null): number | null {
  if (value === null) return null;
  const number = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(number) || number < 0 || number > 1) integrity("ASSESSMENT_SCORE_INVALID");
  return number;
}

function validateVisible(
  row: VisibleAssessmentRow,
  itemRows: ManifestItemRow[],
  actors: Map<string, ActorRow>,
): { record: AssessmentRecord; manifest: AssessmentDetailResponse["evidenceManifest"]; summary: AssessmentSummary } {
  if (!uuidPattern.test(row.assessment_id) || !uuidPattern.test(row.claim_id)) integrity("ASSESSMENT_ID_INVALID");
  if (!stances.has(row.stance)) integrity("ASSESSMENT_STANCE_INVALID");
  if (row.confidence_level !== null && !confidences.has(row.confidence_level)) integrity("ASSESSMENT_CONFIDENCE_INVALID");
  const score = numericScore(row.numeric_score);
  if ((score === null) !== (row.score_kind === null)) integrity("ASSESSMENT_SCORE_PAIR_INVALID");
  if (row.score_kind !== null && (typeof row.score_kind !== "string" || !row.score_kind.trim())) integrity("ASSESSMENT_SCORE_KIND_INVALID");
  if (row.reasoning !== null && typeof row.reasoning !== "string") integrity("ASSESSMENT_REASONING_INVALID");
  if (!plainObject(row.assessment_metadata)) integrity("ASSESSMENT_METADATA_INVALID");
  if (!validDate(row.assessment_created_at)) integrity("ASSESSMENT_DATE_INVALID");

  const actorId = row.actor_id === null ? null : row.actor_id.toLowerCase();
  if (actorId !== null) {
    if (!uuidPattern.test(actorId)) integrity("ASSESSMENT_ACTOR_INVALID");
    canonicalActor(actors.get(actorId), actorId);
  }

  if (!uuidPattern.test(row.manifest_id)) integrity("MANIFEST_ID_INVALID");
  if (row.schema_version !== 1) integrity("MANIFEST_SCHEMA_INVALID");
  if (row.purpose !== "CLAIM_ASSESSMENT") integrity("MANIFEST_PURPOSE_INVALID");
  if (!/^[0-9a-f]{64}$/.test(row.manifest_sha256)) integrity("MANIFEST_HASH_INVALID");
  if (!emptyObject(row.manifest_metadata)) integrity("MANIFEST_METADATA_INVALID");
  if (!validDate(row.manifest_created_at)) integrity("MANIFEST_DATE_INVALID");
  if (itemRows.length < 1 || itemRows.length > 100) integrity("MANIFEST_ITEM_COUNT_INVALID");

  const draftItems: EvidenceDraftInputItem[] = [];
  const items: AssessmentManifestItem[] = [];
  itemRows.forEach((item, index) => {
    if (!uuidPattern.test(item.item_id)) integrity("MANIFEST_ITEM_ID_INVALID");
    if (item.manifest_id.toLowerCase() !== row.manifest_id.toLowerCase()) integrity("MANIFEST_ITEM_MANIFEST_INVALID");
    if (item.ordinal !== index + 1) integrity("MANIFEST_ITEM_ORDINAL_INVALID");
    if (!roles.has(item.role)) integrity("MANIFEST_ITEM_ROLE_INVALID");
    if (!targetTypes.has(item.target_type)) integrity("MANIFEST_ITEM_TARGET_TYPE_INVALID");
    if (!uuidPattern.test(item.target_id)) integrity("MANIFEST_ITEM_TARGET_INVALID");
    if (item.locator_type !== null || item.locator !== null || item.excerpt !== null) integrity("MANIFEST_ITEM_LOCATOR_INVALID");
    let note: string | null;
    try {
      note = normalizeEvidenceItemNote(item.note);
    } catch {
      integrity("MANIFEST_ITEM_NOTE_INVALID");
    }
    if (note !== item.note) integrity("MANIFEST_ITEM_NOTE_CANONICALITY");
    if (!validDate(item.created_at)) integrity("MANIFEST_ITEM_DATE_INVALID");

    const canonical = {
      ordinal: item.ordinal,
      role: item.role as AssessmentManifestItem["role"],
      targetType: item.target_type as AssessmentManifestItem["targetType"],
      targetId: item.target_id.toLowerCase(),
      locatorType: null,
      locator: null,
      excerpt: null,
      note,
    };
    items.push(canonical);
    draftItems.push({
      role: canonical.role,
      targetType: canonical.targetType,
      targetId: canonical.targetId,
      note: canonical.note,
    });
  });

  const rebuilt = buildEvidenceManifestDraft(draftItems);
  if (rebuilt.manifestSha256 !== row.manifest_sha256) integrity("MANIFEST_HASH_MISMATCH");

  const record: AssessmentRecord = {
    id: row.assessment_id.toLowerCase(),
    claimId: row.claim_id.toLowerCase(),
    stance: row.stance as AssessmentRecord["stance"],
    confidenceLevel: row.confidence_level as AssessmentRecord["confidenceLevel"],
    actorId,
    numericScore: score,
    scoreKind: row.score_kind,
    reasoning: row.reasoning,
    createdAt: row.assessment_created_at.toISOString(),
  };

  const manifest: AssessmentDetailResponse["evidenceManifest"] = {
    id: row.manifest_id.toLowerCase(),
    schemaVersion: 1,
    purpose: "CLAIM_ASSESSMENT",
    manifestSha256: row.manifest_sha256,
    createdAt: row.manifest_created_at.toISOString(),
    items,
  };

  const summary: AssessmentSummary = {
    id: record.id,
    stance: record.stance,
    confidenceLevel: record.confidenceLevel,
    actorId,
    numericScore: score,
    scoreKind: row.score_kind,
    reasoningExcerpt: reasoningExcerpt(row.reasoning),
    createdAt: record.createdAt,
    evidenceManifest: {
      id: manifest.id,
      schemaVersion: 1,
      purpose: "CLAIM_ASSESSMENT",
      manifestSha256: manifest.manifestSha256,
      itemCount: items.length,
    },
  };

  return { record, manifest, summary };
}

export function reasoningExcerpt(reasoning: string | null): string | null {
  if (reasoning === null) return null;
  const flat = reasoning.replace(/\p{White_Space}+/gu, " ").trim();
  const chars = Array.from(flat);
  return chars.length <= 240 ? flat : chars.slice(0, 240).join("") + "…";
}

async function validateRows(
  client: PoolClient,
  rows: VisibleAssessmentRow[],
): Promise<Array<{ row: VisibleAssessmentRow; canonical: ReturnType<typeof validateVisible> }>> {
  const manifestIds = rows.map(row => row.manifest_id.toLowerCase());
  const itemMap = await loadItems(client, manifestIds);
  const actorIds = Array.from(new Set(
    rows.flatMap(row => row.actor_id === null ? [] : [row.actor_id.toLowerCase()]),
  ));
  const actors = await loadActors(client, actorIds);

  return rows.map(row => {
    const manifestId = row.manifest_id.toLowerCase();
    return {
      row,
      canonical: validateVisible(row, itemMap.get(manifestId) ?? [], actors),
    };
  });
}

export function createPostgresAssessmentReadStore(pool: Pool): AssessmentReadStore {
  return {
    async list(input): Promise<AssessmentHistoryLookup> {
      return readTransaction(pool, async client => {
        const scope = await loadProjectClaimScope(client, input.projectId, input.issueId, input.claimId);
        if (!scope) return { kind: "scope-missing" };

        const auth = await loadProjectEvidenceAuthorization(client, input.projectId);
        const visible = await visibleHistoryRows(client, input, auth);
        const hasMore = visible.length > input.limit;
        const page = visible.slice(0, input.limit);
        const validated = await validateRows(client, page);

        const last = page.at(-1);
        return {
          kind: "ok",
          value: {
            claim: {
              id: scope.claim.id,
              statement: scope.claim.statement,
              lifecycleState: scope.claim.lifecycleState,
            },
            assessments: validated.map(item => item.canonical.summary),
            nextCursor: hasMore && last
              ? encodeAssessmentCursor({
                  createdAt: last.assessment_created_at.toISOString(),
                  id: last.assessment_id.toLowerCase(),
                })
              : null,
          },
        };
      });
    },

    async get(input): Promise<AssessmentDetailLookup> {
      return readTransaction(pool, async client => {
        const scope = await loadProjectClaimScope(client, input.projectId, input.issueId, input.claimId);
        if (!scope) return { kind: "scope-missing" };

        const auth = await loadProjectEvidenceAuthorization(client, input.projectId);
        const visible = await visibleDetailRows(client, input, auth);
        if (!visible.length) return { kind: "not-visible" };
        if (visible.length !== 1) integrity("ASSESSMENT_DETAIL_AMBIGUOUS");

        const [validated] = await validateRows(client, visible);
        return {
          kind: "ok",
          value: {
            claim: {
              id: scope.claim.id,
              statement: scope.claim.statement,
              lifecycleState: scope.claim.lifecycleState,
            },
            assessment: validated.canonical.record,
            evidenceManifest: validated.canonical.manifest,
          },
        };
      });
    },
  };
}
