import type { PoolClient } from "pg";
import type {
  EvidenceAssetType,
  EvidenceCandidate,
  EvidenceClaimContext,
  EvidenceSourceType,
} from "../application/evidence-selection.js";
import type { EvidenceDraftInputItem } from "../domain/evidence-selection.js";
import { normalizeCandidateClaimStatement, readCandidateClaimId } from "../domain/candidate-claim.js";
import { readResearchIssueInput } from "../domain/research-issue.js";

export class ProjectEvidenceIntegrityError extends Error {}
export class ProjectEvidenceTargetUnavailableError extends Error {}

const uuidPattern = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const sourceTypes = new Set([
  "PUBLICATION", "WEB_PAGE", "ARCHIVAL_RECORD", "DATABASE_RECORD",
  "MUSEUM_OBJECT", "EXHIBITION_LABEL", "EMAIL",
  "FIELD_OBSERVATION", "INTERVIEW", "OTHER",
]);
const assetTypes = new Set(["DOCUMENT", "IMAGE", "AUDIO", "VIDEO", "WEB_SNAPSHOT", "TEXT", "DATA", "OTHER"]);
const assetRoles = new Set(["ORIGINAL", "DERIVED"]);
const storageModes = new Set(["LOCAL", "REMOTE", "HYBRID"]);
const contentFormats = new Set(["MARKDOWN", "PLAIN_TEXT"]);
const subjectTypeAllowlist = new Set(["WORK", "EDITION", "SOURCE", "SOURCE_ASSET", "NOTE", "ACTOR"]);

function integrity(detail: string): never {
  throw new ProjectEvidenceIntegrityError(detail);
}

function validDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

interface ScopeRow {
  project_id: string;
  project_name: string;
  project_state: string;
  issue_id: string | null;
  issue_title: string | null;
  issue_question: string | null;
  issue_state: string | null;
  issue_binding_id: string | null;
  owner_project_id: string | null;
  issue_binding_role: string | null;
  issue_binding_metadata: unknown;
  relation_claim_id: string | null;
  claim_statement: string | null;
  claim_state: string | null;
  claim_type: string | null;
  subject_type: string | null;
  subject_id: string | null;
  claim_metadata: unknown;
  claim_created_at: Date;
  claim_updated_at: Date;
}

export interface ProjectClaimScope {
  projectId: string;
  projectLifecycleState: "ACTIVE" | "ARCHIVED";
  issueId: string;
  issueLifecycleState: "OPEN" | "RESOLVED" | "ARCHIVED";
  claim: EvidenceClaimContext;
}

async function lockScopeRows(
  client: PoolClient,
  projectId: string,
  issueId: string,
  claimId: string,
): Promise<boolean> {
  const project = await client.query("SELECT id FROM core.projects WHERE id=$1 FOR UPDATE", [projectId]);
  if (!project.rows.length) return false;
  await client.query("SELECT id FROM core.research_issues WHERE id=$1 FOR UPDATE", [issueId]);
  await client.query(
    "SELECT issue_id,claim_id FROM core.research_issue_claims WHERE issue_id=$1 AND claim_id=$2 FOR UPDATE",
    [issueId, claimId],
  );
  await client.query("SELECT id FROM core.claims WHERE id=$1 FOR UPDATE", [claimId]);
  return true;
}

export async function loadProjectClaimScope(
  client: PoolClient,
  projectId: string,
  issueId: string,
  claimId: string,
  options: { lock?: boolean } = {},
): Promise<ProjectClaimScope | null> {
  readCandidateClaimId(claimId);
  if (options.lock && !(await lockScopeRows(client, projectId, issueId, claimId))) return null;

  const { rows } = await client.query<ScopeRow>(
    `SELECT
       p.id AS project_id,
       p.name AS project_name,
       p.lifecycle_state AS project_state,
       ri.id AS issue_id,
       ri.title AS issue_title,
       ri.question AS issue_question,
       ri.lifecycle_state AS issue_state,
       pb.id AS issue_binding_id,
       pb.project_id AS owner_project_id,
       pb.binding_role AS issue_binding_role,
       pb.metadata AS issue_binding_metadata,
       ric.claim_id AS relation_claim_id,
       c.statement AS claim_statement,
       c.lifecycle_state AS claim_state,
       c.claim_type,
       c.subject_type,
       c.subject_id,
       c.metadata AS claim_metadata,
       c.created_at AS claim_created_at,
       c.updated_at AS claim_updated_at
     FROM core.projects p
     LEFT JOIN core.research_issues ri ON ri.id = $2
     LEFT JOIN core.project_bindings pb
       ON pb.target_type = 'RESEARCH_ISSUE' AND pb.target_id = ri.id
     LEFT JOIN core.research_issue_claims ric
       ON ric.issue_id = ri.id AND ric.claim_id = $3
     LEFT JOIN core.claims c ON c.id = ric.claim_id
     WHERE p.id = $1
     ORDER BY pb.id`,
    [projectId, issueId, claimId],
  );

  if (rows.length > 1) integrity("ISSUE_OWNER_AMBIGUOUS");
  if (!rows.length) return null;
  const row = rows[0];

  if (typeof row.project_name !== "string" || !row.project_name.trim()) integrity("PROJECT_NAME_INVALID");
  if (!["ACTIVE", "ARCHIVED"].includes(row.project_state)) integrity("PROJECT_LIFECYCLE_INVALID");

  if (row.issue_id === null) {
    const danglingProbe = await client.query<{ id: string }>(
      `SELECT id FROM core.project_bindings pb_only
       WHERE pb_only.target_type = 'RESEARCH_ISSUE' AND pb_only.target_id = $1
       LIMIT 1`,
      [issueId],
    );
    if (danglingProbe.rows.length > 0) integrity("ISSUE_BINDING_DANGLING");
    return null;
  }
  if (row.issue_id !== issueId) return null;
  if (typeof row.issue_title !== "string" || typeof row.issue_question !== "string") {
    integrity("ISSUE_CANONICAL_INVALID");
  }

  let normalizedIssueTitle: string;
  let normalizedIssueQuestion: string;
  try {
    const normalized = readResearchIssueInput({ title: row.issue_title, question: row.issue_question });
    normalizedIssueTitle = normalized.title;
    normalizedIssueQuestion = normalized.question;
  } catch {
    integrity("ISSUE_CANONICAL_INVALID");
  }
  if (row.issue_title !== normalizedIssueTitle || row.issue_question !== normalizedIssueQuestion) {
    integrity("ISSUE_CANONICAL_INVALID");
  }
  if (!row.issue_binding_id) integrity("ISSUE_BINDING_DANGLING");
  if (!["OPEN", "RESOLVED", "ARCHIVED"].includes(row.issue_state ?? "")) {
    integrity("ISSUE_LIFECYCLE_INVALID");
  }
  if (row.owner_project_id !== projectId) return null;
  if (row.issue_binding_role !== null) integrity("ISSUE_OWNER_BINDING_ROLE_INVALID");
  if (
    !row.issue_binding_metadata ||
    typeof row.issue_binding_metadata !== "object" ||
    Array.isArray(row.issue_binding_metadata)
  ) {
    integrity("ISSUE_BINDING_METADATA_INVALID");
  }
  if (!row.relation_claim_id) return null;
  if (!["ACTIVE", "ARCHIVED"].includes(row.claim_state ?? "")) integrity("CLAIM_LIFECYCLE_INVALID");
  if (typeof row.claim_statement !== "string") integrity("CLAIM_STATEMENT_INVALID");

  let claimStatement: string;
  try {
    claimStatement = normalizeCandidateClaimStatement(row.claim_statement);
  } catch {
    integrity("CLAIM_STATEMENT_INVALID");
  }
  if (!claimStatement) integrity("CLAIM_STATEMENT_INVALID");
  if (claimStatement !== row.claim_statement) integrity("CLAIM_STATEMENT_CANONICALITY");
  if (row.claim_metadata === null || typeof row.claim_metadata !== "object" || Array.isArray(row.claim_metadata)) {
    integrity("CLAIM_METADATA_INVALID");
  }
  if (!validDate(row.claim_created_at) || !validDate(row.claim_updated_at)) integrity("CLAIM_TIMESTAMP_INVALID");
  if (row.claim_type !== null && typeof row.claim_type !== "string") integrity("CLAIM_TYPE_INVALID");
  if (row.subject_type !== null) {
    if (typeof row.subject_type !== "string" || !subjectTypeAllowlist.has(row.subject_type)) {
      integrity("CLAIM_SUBJECT_TYPE_INVALID");
    }
  }
  if (row.subject_type === null && row.subject_id !== null) integrity("CLAIM_SUBJECT_TYPE_INVALID");
  if (row.subject_type !== null && row.subject_id === null) integrity("CLAIM_SUBJECT_ID_INVALID");
  if (row.subject_id !== null && (typeof row.subject_id !== "string" || !uuidPattern.test(row.subject_id))) {
    integrity("CLAIM_SUBJECT_ID_INVALID");
  }

  return {
    projectId,
    projectLifecycleState: row.project_state as "ACTIVE" | "ARCHIVED",
    issueId,
    issueLifecycleState: row.issue_state as "OPEN" | "RESOLVED" | "ARCHIVED",
    claim: {
      id: claimId,
      statement: claimStatement,
      lifecycleState: row.claim_state as "ACTIVE" | "ARCHIVED",
    },
  };
}

interface MaterialRow {
  binding_id: string;
  binding_created_at: Date;
  binding_metadata: unknown;
  edition_id: string | null;
  work_title: string | null;
  source_id: string | null;
  source_type: string | null;
  source_lifecycle: string | null;
  source_edition_id: string | null;
  source_observed_at: Date | null;
  asset_id: string | null;
  asset_type: string | null;
  asset_role: string | null;
  asset_storage_mode: string | null;
  asset_created_at: Date | null;
  note_binding_id: string | null;
  note_binding_role: string | null;
  note_binding_metadata: unknown;
  note_id: string | null;
  note_type: string | null;
  note_lifecycle: string | null;
  note_current_revision_id: string | null;
  revision_id: string | null;
  revision_no: string | number | null;
  revision_content_format: string | null;
  revision_created_at: Date | null;
}

export interface ProjectMaterialGroup {
  bindingId: string;
  createdAt: Date;
  workTitle: string;
  declaredSourceId: string | null;
  source: {
    id: string;
    type: EvidenceSourceType;
    lifecycle: "ACTIVE" | "ARCHIVED";
    observedAt: Date;
  } | null;
  assets: Array<{
    id: string;
    type: EvidenceAssetType;
    role: "ORIGINAL" | "DERIVED";
    storageMode: "LOCAL" | "REMOTE" | "HYBRID";
    createdAt: Date;
  }>;
  note: {
    bindingId: string;
    noteId: string;
    revisionId: string;
    revisionNo: number;
    contentFormat: "MARKDOWN" | "PLAIN_TEXT";
    createdAt: Date;
  } | null;
}

function normalizeRevisionNo(value: string | number | null): number | null {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : null;
}

function readDeclaredSourceId(metadata: unknown): string | null {
  if (metadata === null || metadata === undefined) return null;
  if (typeof metadata !== "object" || Array.isArray(metadata)) integrity("EDITION_BINDING_METADATA_INVALID");
  const record = metadata as Record<string, unknown>;
  if (!("sourceId" in record) || record.sourceId === null || record.sourceId === undefined) return null;
  const value = record.sourceId;
  if (typeof value !== "string" || !value.trim()) integrity("EDITION_BINDING_SOURCE_ID_INVALID");
  const normalized = value.trim().toLowerCase();
  if (!uuidPattern.test(normalized)) integrity("EDITION_BINDING_SOURCE_ID_INVALID");
  return normalized;
}

function groupMaterials(rows: MaterialRow[]): ProjectMaterialGroup[] {
  const groups = new Map<string, ProjectMaterialGroup>();

  for (const row of rows) {
    let group = groups.get(row.binding_id);
    if (!group) {
      if (!uuidPattern.test(row.binding_id)) integrity("EDITION_BINDING_ID_INVALID");
      if (!validDate(row.binding_created_at)) integrity("EDITION_BINDING_DATE_INVALID");
      if (!row.edition_id || !uuidPattern.test(row.edition_id)) integrity("EDITION_ID_INVALID");
      group = {
        bindingId: row.binding_id,
        createdAt: row.binding_created_at,
        workTitle: typeof row.work_title === "string" && row.work_title.trim() ? row.work_title : "",
        declaredSourceId: null,
        source: null,
        assets: [],
        note: null,
      };
      groups.set(row.binding_id, group);
    }

    if (group.declaredSourceId === null) group.declaredSourceId = readDeclaredSourceId(row.binding_metadata);

    if (row.source_id && !group.source) {
      if (!uuidPattern.test(row.source_id)) integrity("SOURCE_ID_INVALID");
      if (!sourceTypes.has(row.source_type ?? "")) integrity("SOURCE_TYPE_INVALID");
      if (!["ACTIVE", "ARCHIVED"].includes(row.source_lifecycle ?? "")) integrity("SOURCE_LIFECYCLE_INVALID");
      if (row.source_edition_id !== row.edition_id) integrity("SOURCE_EDITION_MISMATCH");
      if (!validDate(row.source_observed_at)) integrity("SOURCE_OBSERVED_AT_INVALID");
      group.source = {
        id: row.source_id,
        type: row.source_type as EvidenceSourceType,
        lifecycle: row.source_lifecycle as "ACTIVE" | "ARCHIVED",
        observedAt: row.source_observed_at,
      };
    }

    if (row.asset_id) {
      if (!group.source) integrity("SOURCE_ASSET_WITHOUT_SOURCE");
      if (!uuidPattern.test(row.asset_id)) integrity("SOURCE_ASSET_ID_INVALID");
      if (!assetTypes.has(row.asset_type ?? "")) integrity("SOURCE_ASSET_TYPE_INVALID");
      if (!assetRoles.has(row.asset_role ?? "")) integrity("SOURCE_ASSET_ROLE_INVALID");
      if (!storageModes.has(row.asset_storage_mode ?? "")) integrity("SOURCE_ASSET_STORAGE_MODE_INVALID");
      if (!validDate(row.asset_created_at)) integrity("SOURCE_ASSET_DATE_INVALID");
      if (!group.assets.some(asset => asset.id === row.asset_id)) {
        group.assets.push({
          id: row.asset_id,
          type: row.asset_type as EvidenceAssetType,
          role: row.asset_role as "ORIGINAL" | "DERIVED",
          storageMode: row.asset_storage_mode as "LOCAL" | "REMOTE" | "HYBRID",
          createdAt: row.asset_created_at,
        });
      }
    }

    if (row.note_binding_id) {
      if (group.note) {
        if (group.note.bindingId !== row.note_binding_id) integrity("DUPLICATE_NOTE_BINDING");
      } else {
        if (row.note_binding_role !== "ANNOTATION") integrity("NOTE_BINDING_ROLE_INVALID");
        if (!row.note_binding_metadata || typeof row.note_binding_metadata !== "object" || Array.isArray(row.note_binding_metadata)) {
          integrity("NOTE_BINDING_METADATA_INVALID");
        }
        const metadata = row.note_binding_metadata as Record<string, unknown>;
        if (
          metadata.subjectBindingId !== row.binding_id ||
          metadata.subjectType !== "EDITION" ||
          metadata.subjectId !== row.edition_id
        ) {
          integrity("NOTE_BINDING_SUBJECT_MISMATCH");
        }
        if (row.note_type !== "PROJECT_ITEM_NOTE") integrity("NOTE_TYPE_INVALID");
        if (!["ACTIVE", "ARCHIVED"].includes(row.note_lifecycle ?? "")) integrity("NOTE_LIFECYCLE_INVALID");
        if (!row.note_id || !uuidPattern.test(row.note_id)) integrity("NOTE_ID_INVALID");
        if (!row.note_current_revision_id || !uuidPattern.test(row.note_current_revision_id)) {
          integrity("NOTE_CURRENT_REVISION_INVALID");
        }
        if (row.revision_id !== row.note_current_revision_id) integrity("NOTE_REVISION_NOT_CURRENT");
        const revisionNo = normalizeRevisionNo(row.revision_no);
        if (!revisionNo) integrity("NOTE_REVISION_NO_INVALID");
        if (!contentFormats.has(row.revision_content_format ?? "")) integrity("NOTE_REVISION_FORMAT_INVALID");
        if (!validDate(row.revision_created_at)) integrity("NOTE_REVISION_DATE_INVALID");
        group.note = {
          bindingId: row.note_binding_id,
          noteId: row.note_id,
          revisionId: row.revision_id as string,
          revisionNo,
          contentFormat: row.revision_content_format as "MARKDOWN" | "PLAIN_TEXT",
          createdAt: row.revision_created_at,
        };
      }
    }
  }

  for (const group of groups.values()) {
    if (group.declaredSourceId && !group.source) integrity("DECLARED_SOURCE_MISSING");
    if (group.source && group.source.id !== group.declaredSourceId) integrity("DECLARED_SOURCE_MISMATCH");
  }

  return Array.from(groups.values()).sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.bindingId < b.bindingId ? -1 : 1),
  );
}

function materialGraphQuery(): string {
  return `SELECT
      pb.id AS binding_id,
      pb.created_at AS binding_created_at,
      pb.metadata AS binding_metadata,
      e.id AS edition_id,
      w.title AS work_title,
      s.id AS source_id,
      s.source_type,
      s.lifecycle_state AS source_lifecycle,
      s.edition_id AS source_edition_id,
      s.observed_at AS source_observed_at,
      sa.id AS asset_id,
      sa.asset_type,
      sa.asset_role,
      sa.storage_mode AS asset_storage_mode,
      sa.created_at AS asset_created_at,
      nb.id AS note_binding_id,
      nb.binding_role AS note_binding_role,
      nb.metadata AS note_binding_metadata,
      n.id AS note_id,
      n.note_type,
      n.lifecycle_state AS note_lifecycle,
      n.current_revision_id AS note_current_revision_id,
      nr.id AS revision_id,
      nr.revision_no,
      nr.content_format AS revision_content_format,
      nr.created_at AS revision_created_at
    FROM core.project_bindings pb
    JOIN core.editions e ON e.id = pb.target_id AND pb.target_type = 'EDITION'
    JOIN core.works w ON w.id = e.work_id
    LEFT JOIN core.sources s
      ON s.id::text = pb.metadata->>'sourceId'
     AND s.edition_id = e.id
    LEFT JOIN core.source_assets sa ON sa.source_id = s.id
    LEFT JOIN core.project_bindings nb
      ON nb.project_id = pb.project_id
     AND nb.target_type = 'NOTE'
     AND nb.binding_role = 'ANNOTATION'
     AND nb.metadata->>'subjectBindingId' = pb.id::text
    LEFT JOIN core.notes n ON n.id = nb.target_id AND n.note_type = 'PROJECT_ITEM_NOTE'
    LEFT JOIN core.note_revisions nr ON nr.id = n.current_revision_id
    WHERE pb.project_id = $1
    ORDER BY pb.created_at ASC, pb.id ASC, sa.created_at ASC, sa.id ASC`;
}

export interface ProjectEvidenceAuthorization {
  groups: ProjectMaterialGroup[];
  sourceIds: ReadonlySet<string>;
  sourceAssetIds: ReadonlySet<string>;
  noteIds: ReadonlySet<string>;
  currentRevisionNoteByRevision: ReadonlyMap<string, string>;
}

export async function loadProjectEvidenceAuthorization(
  client: PoolClient,
  projectId: string,
): Promise<ProjectEvidenceAuthorization> {
  const { rows } = await client.query<MaterialRow>(materialGraphQuery(), [projectId]);
  const groups = groupMaterials(rows);
  const sourceIds = new Set<string>();
  const sourceAssetIds = new Set<string>();
  const noteIds = new Set<string>();
  const currentRevisionNoteByRevision = new Map<string, string>();

  for (const group of groups) {
    if (group.source) sourceIds.add(group.source.id);
    for (const asset of group.assets) sourceAssetIds.add(asset.id);
    if (group.note) {
      noteIds.add(group.note.noteId);
      currentRevisionNoteByRevision.set(group.note.revisionId, group.note.noteId);
    }
  }

  return { groups, sourceIds, sourceAssetIds, noteIds, currentRevisionNoteByRevision };
}

export function evidenceCandidatesFromAuthorization(auth: ProjectEvidenceAuthorization): EvidenceCandidate[] {
  const out: EvidenceCandidate[] = [];

  for (const group of auth.groups) {
    if (group.source) {
      out.push({
        targetType: "SOURCE",
        targetId: group.source.id,
        materialBindingId: group.bindingId,
        materialTitle: group.workTitle,
        sourceType: group.source.type,
        sourceLifecycleState: group.source.lifecycle,
        observedAt: group.source.observedAt.toISOString(),
      });
    }

    const assets = [...group.assets].sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1),
    );
    for (const asset of assets) {
      out.push({
        targetType: "SOURCE_ASSET",
        targetId: asset.id,
        materialBindingId: group.bindingId,
        materialTitle: group.workTitle,
        sourceId: group.source!.id,
        assetType: asset.type,
        assetRole: asset.role,
        storageMode: asset.storageMode,
        createdAt: asset.createdAt.toISOString(),
      });
    }

    if (group.note) {
      out.push({
        targetType: "NOTE_REVISION",
        targetId: group.note.revisionId,
        materialBindingId: group.bindingId,
        materialTitle: group.workTitle,
        noteId: group.note.noteId,
        revisionNo: group.note.revisionNo,
        contentFormat: group.note.contentFormat,
        createdAt: group.note.createdAt.toISOString(),
      });
    }
  }

  return out;
}

export async function authorizeEvidenceItems(
  client: PoolClient,
  auth: ProjectEvidenceAuthorization,
  items: ReadonlyArray<EvidenceDraftInputItem>,
): Promise<void> {
  const pendingOldRevisions = new Set<string>();

  for (const item of items) {
    if (item.targetType === "SOURCE") {
      if (!auth.sourceIds.has(item.targetId)) throw new ProjectEvidenceTargetUnavailableError("EVIDENCE_TARGET_NOT_AVAILABLE");
    } else if (item.targetType === "SOURCE_ASSET") {
      if (!auth.sourceAssetIds.has(item.targetId)) {
        throw new ProjectEvidenceTargetUnavailableError("EVIDENCE_TARGET_NOT_AVAILABLE");
      }
    } else if (item.targetType === "NOTE_REVISION") {
      if (auth.currentRevisionNoteByRevision.has(item.targetId)) continue;
      pendingOldRevisions.add(item.targetId);
    }
  }

  if (!pendingOldRevisions.size) return;

  const revisionIds = Array.from(pendingOldRevisions);
  const noteIds = Array.from(auth.noteIds);
  const { rows } = await client.query<{
    revision_id: string;
    note_id: string;
    revision_no: string | number | null;
    content_format: string | null;
    created_at: Date | null;
  }>(
    `SELECT nr.id::text AS revision_id,
            nr.note_id::text AS note_id,
            nr.revision_no,
            nr.content_format,
            nr.created_at
     FROM core.note_revisions nr
     WHERE nr.id = ANY($1::uuid[])
       AND nr.note_id = ANY($2::uuid[])`,
    [revisionIds, noteIds],
  );

  const found = new Set(rows.map(row => row.revision_id));
  for (const revisionId of pendingOldRevisions) {
    if (!found.has(revisionId)) throw new ProjectEvidenceTargetUnavailableError("EVIDENCE_TARGET_NOT_AVAILABLE");
  }

  for (const row of rows) {
    const revisionNo = normalizeRevisionNo(row.revision_no);
    if (!revisionNo || !contentFormats.has(row.content_format ?? "") || !validDate(row.created_at)) {
      integrity("NOTE_REVISION_CANONICAL_INVALID");
    }
  }
}
