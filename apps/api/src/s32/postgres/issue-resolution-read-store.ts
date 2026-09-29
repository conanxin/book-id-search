import type { Pool, PoolClient } from "pg";
import * as errors from "../application/issue-resolutions.js";
import type {
  IssueResolutionReadStore,
  IssueResolutionEvidenceBasisSummary,
} from "../application/issue-resolutions.js";
import {
  encodeIssueResolutionCursor,
  type IssueResolutionRecord,
  type IssueResolutionSummary,
  type IssueResolutionDetailResponse,
  type IssueResolutionIssueState,
} from "../domain/issue-resolution.js";
import type {
  AssessmentManifestSummary,
  AssessmentManifestItem,
} from "../domain/assessment.js";
import {
  buildEvidenceManifestDraft,
  normalizeEvidenceItemNote,
  normalizeEvidencePreviewInput,
  type EvidenceDraftInputItem,
} from "../domain/evidence-selection.js";
import { normalizeCandidateClaimStatement } from "../domain/candidate-claim.js";
import { reasoningExcerpt } from "./assessment-read-store.js";
import {
  loadProjectIssueScope,
  loadProjectEvidenceAuthorization,
  authorizeEvidenceItems,
  ProjectEvidenceIntegrityError,
  ProjectEvidenceTargetUnavailableError,
  type ProjectIssueScope,
} from "./project-evidence-authorization.js";

type Row = Record<string, unknown>;
type Manifest = IssueResolutionDetailResponse["evidenceManifest"] & {};
const uuidPattern =
  /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
function integrity(message: string): never {
  throw new errors.IssueResolutionIntegrityError(message);
}
function uuid(value: unknown): string {
  if (typeof value !== "string" || !uuidPattern.test(value))
    integrity("CANONICAL_UUID_INVALID");
  return value.toLowerCase();
}
function nullableUuid(value: unknown): string | null {
  return value === null ? null : uuid(value);
}
function date(value: unknown): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime()))
    integrity("CANONICAL_DATE_INVALID");
  return value;
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function micros(value: unknown, id: string): string {
  // Validate with the frozen cursor contract; never convert the exact bigint key to Number/Date.
  if (typeof value !== "string") integrity("CANONICAL_MICROSECONDS_INVALID");
  try {
    encodeIssueResolutionCursor({ createdAtMicros: value, id });
  } catch {
    integrity("CANONICAL_MICROSECONDS_INVALID");
  }
  return value;
}
function classify(error: unknown): unknown {
  if (
    Object.values(errors).some(
      (value) =>
        typeof value === "function" &&
        value.prototype instanceof Error &&
        error instanceof value,
    )
  )
    return error;
  if (error instanceof ProjectEvidenceIntegrityError)
    return new errors.IssueResolutionIntegrityError(error.message);
  if (error && typeof error === "object") {
    const { code, message } = error as { code?: unknown; message?: unknown };
    if (
      (typeof code === "string" &&
        (code.startsWith("08") ||
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
          ].includes(code))) ||
      (typeof message === "string" &&
        /connection terminated|connection timeout|timeout exceeded|query read timeout|connection refused|connection reset/i.test(
          message,
        ))
    ) {
      return new errors.IssueResolutionStoreUnavailableError(
        "ISSUE_RESOLUTION_STORE_UNAVAILABLE",
      );
    }
  }
  return error;
}
async function readTransaction<T>(
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
function issueState(scope: ProjectIssueScope): IssueResolutionIssueState {
  return {
    id: uuid(scope.issueId),
    lifecycleState: scope.issueLifecycleState,
    currentResolutionId: nullableUuid(scope.currentResolutionId),
    updatedAt: date(scope.issueUpdatedAt).toISOString(),
  };
}
interface Resolution {
  record: IssueResolutionRecord;
  micros: string;
}
function resolution(row: Row, issueId: string): Resolution {
  const id = uuid(row.id);
  if (uuid(row.issue_id) !== issueId) integrity("RESOLUTION_ISSUE_MISMATCH");
  if (
    ![
      "PREFERRED_CLAIM",
      "INSUFFICIENT_EVIDENCE",
      "NO_WORKING_CONCLUSION",
    ].includes(row.resolution_type as string)
  )
    integrity("RESOLUTION_TYPE_INVALID");
  const preferredClaimId = nullableUuid(row.preferred_claim_id);
  if (
    (row.resolution_type === "PREFERRED_CLAIM") !==
    (preferredClaimId !== null)
  )
    integrity("RESOLUTION_PREFERRED_CLAIM_INVALID");
  if (row.rationale !== null && typeof row.rationale !== "string")
    integrity("RESOLUTION_RATIONALE_INVALID");
  return {
    record: {
      id,
      issueId,
      resolutionType:
        row.resolution_type as IssueResolutionRecord["resolutionType"],
      preferredClaimId,
      rationale: row.rationale,
      evidenceManifestId: nullableUuid(row.evidence_manifest_id),
      createdAt: date(row.created_at).toISOString(),
    },
    micros: micros(row.created_at_micros, id),
  };
}
const resolutionColumns = `r.id,r.issue_id,r.resolution_type,r.preferred_claim_id,r.rationale,r.evidence_manifest_id,r.created_at,
 (extract(epoch FROM r.created_at) * 1000000)::bigint AS created_at_micros`;
async function loadClaims(
  client: PoolClient,
  issueId: string,
  ids: string[],
): Promise<Map<string, string>> {
  const claims = new Map<string, string>();
  if (!ids.length) return claims;
  const { rows } = await client.query<Row>(
    `/* resolution-claim-batch */
    SELECT ric.issue_id AS relation_issue_id,ric.claim_id AS relation_claim_id,c.id AS claim_id,
      c.statement AS claim_statement,c.lifecycle_state AS claim_state,c.claim_type,c.subject_type,c.subject_id,
      c.metadata AS claim_metadata,c.created_at AS claim_created_at,c.updated_at AS claim_updated_at
    FROM core.research_issue_claims ric LEFT JOIN core.claims c ON c.id=ric.claim_id
    WHERE ric.issue_id=$1 AND ric.claim_id=ANY($2::uuid[])`,
    [issueId, ids],
  );
  for (const row of rows) {
    const id = uuid(row.claim_id);
    if (
      uuid(row.relation_issue_id) !== issueId ||
      uuid(row.relation_claim_id) !== id ||
      !ids.includes(id) ||
      claims.has(id)
    )
      integrity("CLAIM_MEMBERSHIP_INVALID");
    let statement: string;
    try {
      statement = normalizeCandidateClaimStatement(row.claim_statement);
    } catch {
      integrity("CLAIM_STATEMENT_INVALID");
    }
    if (
      statement !== row.claim_statement ||
      !["ACTIVE", "ARCHIVED"].includes(row.claim_state as string) ||
      !object(row.claim_metadata) ||
      (row.claim_type !== null && typeof row.claim_type !== "string")
    )
      integrity("CLAIM_CANONICAL_INVALID");
    date(row.claim_created_at);
    date(row.claim_updated_at);
    if (
      row.subject_type !== null &&
      !["WORK", "EDITION", "SOURCE", "SOURCE_ASSET", "NOTE", "ACTOR"].includes(
        row.subject_type as string,
      )
    )
      integrity("CLAIM_SUBJECT_INVALID");
    if ((row.subject_type === null) !== (row.subject_id === null))
      integrity("CLAIM_SUBJECT_INVALID");
    nullableUuid(row.subject_id);
    claims.set(id, statement);
  }
  if (claims.size !== ids.length) integrity("CLAIM_MEMBERSHIP_MISSING");
  return claims;
}
interface Basis {
  assessmentId: string;
  claimId: string;
  micros: string;
  summary: IssueResolutionEvidenceBasisSummary;
  manifest: Manifest;
  draft: EvidenceDraftInputItem[];
  actorId: string | null;
}
function canonicalBasis(
  row: Row,
  items: Row[],
  claims: Map<string, string>,
): Basis {
  const id = uuid(row.manifest_id),
    assessmentId = uuid(row.assessment_id),
    claimId = uuid(row.claim_id);
  if (
    id !== uuid(row.requested_id) ||
    id !== uuid(row.evidence_manifest_id) ||
    !claims.has(claimId)
  )
    integrity("EVIDENCE_RELATIONSHIP_INVALID");
  if (
    row.schema_version !== 1 ||
    row.purpose !== "CLAIM_ASSESSMENT" ||
    typeof row.manifest_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(row.manifest_sha256) ||
    !object(row.manifest_metadata) ||
    Object.keys(row.manifest_metadata).length
  )
    integrity("MANIFEST_CANONICAL_INVALID");
  if (
    !["SUPPORTS", "CONTRADICTS", "INCONCLUSIVE"].includes(
      row.stance as string,
    ) ||
    (row.confidence_level !== null &&
      !["LOW", "MEDIUM", "HIGH"].includes(row.confidence_level as string))
  )
    integrity("ASSESSMENT_CANONICAL_INVALID");
  const score =
    row.numeric_score === null
      ? null
      : typeof row.numeric_score === "string"
        ? Number(row.numeric_score)
        : row.numeric_score;
  if (
    (score !== null &&
      (typeof score !== "number" ||
        !Number.isFinite(score) ||
        score < 0 ||
        score > 1)) ||
    (score === null) !== (row.score_kind === null) ||
    (row.score_kind !== null &&
      (typeof row.score_kind !== "string" || !row.score_kind.trim())) ||
    (row.reasoning !== null && typeof row.reasoning !== "string") ||
    !object(row.assessment_metadata)
  )
    integrity("ASSESSMENT_CANONICAL_INVALID");
  if (items.length < 1 || items.length > 100)
    integrity("MANIFEST_ITEM_COUNT_INVALID");
  const seen = new Set<string>();
  const canonicalItems: AssessmentManifestItem[] = items.map((item, index) => {
    const itemId = uuid(item.item_id);
    if (seen.has(itemId)) integrity("MANIFEST_ITEM_DUPLICATE");
    seen.add(itemId);
    if (
      uuid(item.manifest_id) !== id ||
      item.ordinal !== index + 1 ||
      !["SUPPORTING", "CONTRADICTORY", "CONTEXTUAL"].includes(
        item.role as string,
      ) ||
      !["SOURCE", "SOURCE_ASSET", "NOTE_REVISION"].includes(
        item.target_type as string,
      ) ||
      item.locator_type !== null ||
      item.locator !== null ||
      item.excerpt !== null
    )
      integrity("MANIFEST_ITEM_INVALID");
    let note: string | null;
    try {
      note = normalizeEvidenceItemNote(item.note);
    } catch {
      integrity("MANIFEST_ITEM_NOTE_INVALID");
    }
    if (note !== item.note) integrity("MANIFEST_ITEM_NOTE_CANONICALITY");
    date(item.created_at);
    return {
      ordinal: index + 1,
      role: item.role as AssessmentManifestItem["role"],
      targetType: item.target_type as AssessmentManifestItem["targetType"],
      targetId: uuid(item.target_id),
      locatorType: null,
      locator: null,
      excerpt: null,
      note,
    };
  });
  const draft = canonicalItems.map(({ role, targetType, targetId, note }) => ({
    role,
    targetType,
    targetId,
    note,
  }));
  // Keep eligible read bases compatible with the frozen command contract,
  // including target-pair uniqueness even when the Manifest hash is valid.
  try {
    normalizeEvidencePreviewInput({ items: draft });
  } catch {
    integrity("MANIFEST_ITEMS_CANONICAL_INVALID");
  }
  if (buildEvidenceManifestDraft(draft).manifestSha256 !== row.manifest_sha256)
    integrity("MANIFEST_HASH_MISMATCH");
  const manifest: Manifest = {
    id,
    schemaVersion: 1,
    purpose: "CLAIM_ASSESSMENT",
    manifestSha256: row.manifest_sha256,
    createdAt: date(row.manifest_created_at).toISOString(),
    items: canonicalItems,
  };
  return {
    assessmentId,
    claimId,
    micros: micros(row.assessment_created_at_micros, assessmentId),
    manifest,
    draft,
    actorId: nullableUuid(row.actor_id),
    summary: {
      assessmentId,
      claimId,
      claimStatementExcerpt: reasoningExcerpt(claims.get(claimId)!)!,
      stance: row.stance as IssueResolutionEvidenceBasisSummary["stance"],
      confidenceLevel:
        row.confidence_level as IssueResolutionEvidenceBasisSummary["confidenceLevel"],
      manifestId: id,
      manifestSha256: manifest.manifestSha256,
      itemCount: canonicalItems.length,
      assessmentCreatedAt: date(row.assessment_created_at).toISOString(),
    },
  };
}
interface VisibleBasis {
  basis: Basis;
  available: boolean;
}
async function evidenceBatch(
  client: PoolClient,
  projectId: string,
  issueId: string,
  manifestIds: string[],
  preferredIds: string[],
): Promise<Map<string, VisibleBasis>> {
  const result = new Map<string, VisibleBasis>();
  if (!manifestIds.length) {
    await loadClaims(client, issueId, preferredIds);
    return result;
  }
  const { rows } = await client.query<Row>(
    `/* resolution-manifest-batch */
    SELECT requested.id AS requested_id,em.id AS manifest_id,em.schema_version,em.purpose,em.manifest_sha256,
      em.metadata AS manifest_metadata,em.created_at AS manifest_created_at,a.id AS assessment_id,a.claim_id,a.actor_id,
      a.stance,a.confidence_level,a.numeric_score,a.score_kind,a.reasoning,a.metadata AS assessment_metadata,
      a.created_at AS assessment_created_at,(extract(epoch FROM a.created_at) * 1000000)::bigint AS assessment_created_at_micros,a.evidence_manifest_id
    FROM unnest($1::uuid[]) AS requested(id)
    LEFT JOIN core.evidence_manifests em ON em.id=requested.id
    LEFT JOIN core.assessments a ON a.evidence_manifest_id=em.id`,
    [manifestIds],
  );
  const byId = new Map<string, Row>();
  for (const row of rows) {
    const id = uuid(row.requested_id);
    if (!manifestIds.includes(id) || byId.has(id))
      integrity("EVIDENCE_ASSESSMENT_AMBIGUOUS");
    // A persisted Resolution reference must still resolve to exactly one Assessment.
    uuid(row.manifest_id);
    uuid(row.assessment_id);
    uuid(row.claim_id);
    byId.set(id, row);
  }
  if (byId.size !== manifestIds.length)
    integrity("EVIDENCE_RELATIONSHIP_MISSING");
  const claimIds = [
    ...new Set([...preferredIds, ...rows.map((row) => uuid(row.claim_id))]),
  ];
  const claims = await loadClaims(client, issueId, claimIds);
  const { rows: items } = await client.query<Row>(
    `SELECT id AS item_id,manifest_id,ordinal,role,target_type,target_id,locator_type,locator,excerpt,note,created_at
    FROM core.evidence_manifest_items WHERE manifest_id=ANY($1::uuid[]) ORDER BY manifest_id,ordinal`,
    [manifestIds],
  );
  const itemMap = new Map(manifestIds.map((id) => [id, [] as Row[]]));
  for (const item of items) {
    const bucket = itemMap.get(uuid(item.manifest_id));
    if (!bucket) integrity("MANIFEST_ITEM_ORPHAN");
    bucket.push(item);
  }
  const bases = rows.map((row) =>
    canonicalBasis(row, itemMap.get(uuid(row.manifest_id))!, claims),
  );
  const actorIds = [
    ...new Set(bases.flatMap((b) => (b.actorId ? [b.actorId] : []))),
  ];
  if (actorIds.length) {
    const { rows: actors } = await client.query<Row>(
      "SELECT id,actor_type,display_name,metadata,created_at,updated_at FROM core.actors WHERE id=ANY($1::uuid[])",
      [actorIds],
    );
    const found = new Set<string>();
    for (const actor of actors) {
      const id = uuid(actor.id);
      if (
        !actorIds.includes(id) ||
        found.has(id) ||
        ![
          "HUMAN",
          "AI_SYSTEM",
          "SYSTEM_PROCESS",
          "EXTERNAL_PERSON",
          "INSTITUTION",
          "UNKNOWN",
        ].includes(actor.actor_type as string) ||
        typeof actor.display_name !== "string" ||
        !actor.display_name.trim() ||
        !object(actor.metadata)
      )
        integrity("ASSESSMENT_ACTOR_INVALID");
      date(actor.created_at);
      date(actor.updated_at);
      found.add(id);
    }
    if (found.size !== actorIds.length) integrity("ASSESSMENT_ACTOR_MISSING");
  }
  const auth = await loadProjectEvidenceAuthorization(client, projectId);
  // Resolve historical revisions once for the whole page. Passing the expanded
  // canonical map to the existing authorizer avoids one SQL query per Manifest.
  const revisionIds = [
    ...new Set(
      bases.flatMap((b) =>
        b.draft
          .filter((i) => i.targetType === "NOTE_REVISION")
          .map((i) => i.targetId),
      ),
    ),
  ];
  const authorizedRevisions = new Map(auth.currentRevisionNoteByRevision);
  if (revisionIds.length) {
    const { rows: revisions } = await client.query<Row>(
      `SELECT nr.id::text AS revision_id,nr.note_id::text AS note_id,nr.revision_no,nr.content_format,nr.created_at
      FROM core.note_revisions nr WHERE nr.id=ANY($1::uuid[]) AND nr.note_id=ANY($2::uuid[])`,
      [revisionIds, [...auth.noteIds]],
    );
    const seen = new Set<string>();
    for (const row of revisions) {
      const id = uuid(row.revision_id),
        noteId = uuid(row.note_id);
      const n =
        typeof row.revision_no === "string"
          ? Number(row.revision_no)
          : row.revision_no;
      if (
        !revisionIds.includes(id) ||
        !auth.noteIds.has(noteId) ||
        seen.has(id) ||
        typeof n !== "number" ||
        !Number.isInteger(n) ||
        n <= 0 ||
        !["MARKDOWN", "PLAIN_TEXT"].includes(row.content_format as string)
      )
        integrity("NOTE_REVISION_CANONICAL_INVALID");
      date(row.created_at);
      seen.add(id);
      authorizedRevisions.set(id, noteId);
    }
  }
  const batchedAuth = {
    ...auth,
    currentRevisionNoteByRevision: authorizedRevisions,
  };
  for (const basis of bases) {
    let available = !basis.draft.some(
      (i) =>
        i.targetType === "NOTE_REVISION" &&
        !authorizedRevisions.has(i.targetId),
    );
    if (available) {
      try {
        await authorizeEvidenceItems(client, batchedAuth, basis.draft);
      } catch (error) {
        if (error instanceof ProjectEvidenceTargetUnavailableError)
          available = false;
        else throw error;
      }
    }
    result.set(basis.manifest.id, { basis, available });
  }
  return result;
}
async function context(
  client: PoolClient,
  projectId: string,
  issueId: string,
  resolutions: Resolution[],
) {
  return evidenceBatch(
    client,
    projectId,
    issueId,
    [
      ...new Set(
        resolutions.flatMap((r) =>
          r.record.evidenceManifestId ? [r.record.evidenceManifestId] : [],
        ),
      ),
    ],
    [
      ...new Set(
        resolutions.flatMap((r) =>
          r.record.preferredClaimId ? [r.record.preferredClaimId] : [],
        ),
      ),
    ],
  );
}
function evidence(
  record: IssueResolutionRecord,
  bases: Map<string, VisibleBasis>,
) {
  return record.evidenceManifestId
    ? bases.get(record.evidenceManifestId)
    : undefined;
}
function summary(
  r: Resolution,
  issue: IssueResolutionIssueState,
  bases: Map<string, VisibleBasis>,
): IssueResolutionSummary {
  const { rationale, evidenceManifestId: _reference, ...record } = r.record;
  const common = {
    ...record,
    rationaleExcerpt: reasoningExcerpt(rationale),
    isCurrent: record.id === issue.currentResolutionId,
  };
  const value = evidence(r.record, bases);
  if (!value?.available)
    return { ...common, evidenceBasisAvailable: false, evidenceManifest: null };
  const b = value.basis;
  const manifest: AssessmentManifestSummary = {
    id: b.manifest.id,
    schemaVersion: 1,
    purpose: "CLAIM_ASSESSMENT",
    manifestSha256: b.manifest.manifestSha256,
    itemCount: b.manifest.items.length,
  };
  return {
    ...common,
    evidenceBasisAvailable: true,
    evidenceManifest: manifest,
  };
}
export function createPostgresIssueResolutionReadStore(
  pool: Pool,
): IssueResolutionReadStore {
  return {
    list(input) {
      return readTransaction(pool, async (client) => {
        const scope = await loadProjectIssueScope(
          client,
          input.projectId,
          input.issueId,
        );
        if (!scope) return { kind: "scope-missing" };
        const issue = issueState(scope);
        let current: Resolution | null = null;
        if (issue.currentResolutionId !== null) {
          const { rows } = await client.query<Row>(
            `/* resolution-current */ SELECT ${resolutionColumns} FROM core.issue_resolutions r WHERE r.id=$1`,
            [issue.currentResolutionId],
          );
          if (rows.length !== 1) integrity("CURRENT_RESOLUTION_MISSING");
          current = resolution(rows[0], input.issueId);
          if (current.record.id !== issue.currentResolutionId)
            integrity("CURRENT_RESOLUTION_ID_MISMATCH");
        }
        const { rows } = await client.query<Row>(
          `/* resolution-history */ SELECT ${resolutionColumns}
          FROM core.issue_resolutions r WHERE r.issue_id=$1
          AND ($2::bigint IS NULL OR ((extract(epoch FROM r.created_at) * 1000000)::bigint,r.id) < ($2::bigint, $3::uuid))
          ORDER BY r.created_at DESC, r.id DESC LIMIT $4`,
          [
            input.issueId,
            input.cursor?.createdAtMicros ?? null,
            input.cursor?.id ?? null,
            input.limit + 1,
          ],
        );
        const validated = rows.map((row) => resolution(row, input.issueId));
        const page = validated.slice(0, input.limit);
        const bases = await context(
          client,
          input.projectId,
          input.issueId,
          current ? [...page, current] : page,
        );
        const last = page.at(-1);
        return {
          kind: "ok",
          value: {
            issue,
            currentResolution: current ? summary(current, issue, bases) : null,
            resolutions: page.map((row) => summary(row, issue, bases)),
            nextCursor:
              validated.length > input.limit && last
                ? encodeIssueResolutionCursor({
                    createdAtMicros: last.micros,
                    id: last.record.id,
                  })
                : null,
          },
        };
      });
    },
    get(input) {
      return readTransaction(pool, async (client) => {
        const scope = await loadProjectIssueScope(
          client,
          input.projectId,
          input.issueId,
        );
        if (!scope) return { kind: "scope-missing" };
        const issue = issueState(scope);
        const { rows } = await client.query<Row>(
          `/* resolution-detail */ SELECT ${resolutionColumns}
          FROM core.issue_resolutions r WHERE r.issue_id=$1 AND r.id=$2`,
          [input.issueId, input.resolutionId],
        );
        if (!rows.length) return { kind: "not-found" };
        if (rows.length !== 1) integrity("RESOLUTION_DETAIL_AMBIGUOUS");
        // Do not validate or reveal another Issue's Resolution contents.
        if (uuid(rows[0].issue_id) !== input.issueId)
          return { kind: "not-found" };
        const r = resolution(rows[0], input.issueId);
        if (r.record.id !== input.resolutionId)
          integrity("RESOLUTION_DETAIL_ID_MISMATCH");
        const bases = await context(client, input.projectId, input.issueId, [
          r,
        ]);
        const { evidenceManifestId: _reference, ...record } = r.record;
        const common = {
          issue,
          resolution: {
            ...record,
            isCurrent: record.id === issue.currentResolutionId,
          },
        };
        const value = evidence(r.record, bases);
        return {
          kind: "ok",
          value: value?.available
            ? {
                ...common,
                evidenceBasisAvailable: true,
                evidenceManifest: value.basis.manifest,
              }
            : {
                ...common,
                evidenceBasisAvailable: false,
                evidenceManifest: null,
              },
        };
      });
    },
    listEvidenceBases(input) {
      return readTransaction(pool, async (client) => {
        const scope = await loadProjectIssueScope(
          client,
          input.projectId,
          input.issueId,
        );
        if (!scope) return { kind: "scope-missing" };
        const auth = await loadProjectEvidenceAuthorization(
          client,
          input.projectId,
        );
        const { rows } = await client.query<Row>(
          `/* resolution-evidence-candidates */
          SELECT a.id AS assessment_id,a.evidence_manifest_id AS manifest_id,
            (extract(epoch FROM a.created_at) * 1000000)::bigint AS assessment_created_at_micros
          FROM core.research_issue_claims ric JOIN core.claims c ON c.id=ric.claim_id
          JOIN core.assessments a ON a.claim_id=c.id LEFT JOIN core.evidence_manifests em ON em.id=a.evidence_manifest_id
          WHERE ric.issue_id = $1
          AND EXISTS (SELECT 1 FROM core.evidence_manifest_items present WHERE present.manifest_id=em.id)
          AND NOT EXISTS (SELECT 1 FROM core.evidence_manifest_items emi WHERE emi.manifest_id=em.id AND (
            emi.target_type NOT IN ('SOURCE','SOURCE_ASSET','NOTE_REVISION')
            OR (emi.target_type='SOURCE' AND NOT (emi.target_id = ANY($2::uuid[])))
            OR (emi.target_type='SOURCE_ASSET' AND NOT (emi.target_id = ANY($3::uuid[])))
            OR (emi.target_type='NOTE_REVISION' AND NOT EXISTS (SELECT 1 FROM core.note_revisions nr WHERE nr.id=emi.target_id AND nr.note_id = ANY($4::uuid[])))))
          AND ($5::bigint IS NULL OR ((extract(epoch FROM a.created_at) * 1000000)::bigint,a.id) < ($5::bigint, $6::uuid))
          ORDER BY a.created_at DESC, a.id DESC LIMIT $7`,
          [
            input.issueId,
            [...auth.sourceIds],
            [...auth.sourceAssetIds],
            [...auth.noteIds],
            input.cursor?.createdAtMicros ?? null,
            input.cursor?.id ?? null,
            input.limit + 1,
          ],
        );
        const ids = rows.map((row) => uuid(row.manifest_id));
        const bases = await evidenceBatch(
          client,
          input.projectId,
          input.issueId,
          [...new Set(ids)],
          [],
        );
        const canonical = rows.map((row) => {
          const value = bases.get(uuid(row.manifest_id));
          if (
            !value?.available ||
            value.basis.assessmentId !== uuid(row.assessment_id) ||
            value.basis.micros !==
              micros(row.assessment_created_at_micros, uuid(row.assessment_id))
          )
            integrity("EVIDENCE_VISIBLE_READBACK_MISMATCH");
          return value.basis;
        });
        const page = canonical.slice(0, input.limit),
          last = page.at(-1);
        return {
          kind: "ok",
          value: {
            issueId: uuid(scope.issueId),
            evidenceBases: page.map((b) => b.summary),
            nextCursor:
              canonical.length > input.limit && last
                ? encodeIssueResolutionCursor({
                    createdAtMicros: last.micros,
                    id: last.assessmentId,
                  })
                : null,
          },
        };
      });
    },
  };
}
