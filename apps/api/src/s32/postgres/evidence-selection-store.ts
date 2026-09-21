import type { Pool, PoolClient } from 'pg';
import {
  EvidenceSelectionIntegrityError,
  EvidenceSelectionStoreUnavailableError,
  EvidenceTargetNotAvailableError,
  type EvidenceCandidate,
  type EvidenceClaimContext,
  type EvidenceSelectionStore,
} from '../application/evidence-selection.js';
import type { EvidenceDraftInputItem } from '../domain/evidence-selection.js';

const uuidPattern = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/;
const sourceTypes = new Set(['PUBLICATION', 'WEB_PAGE', 'ARCHIVAL_RECORD', 'DATABASE_RECORD', 'MUSEUM_OBJECT', 'EXHIBITION_LABEL', 'EMAIL', 'FIELD_OBSERVATION', 'INTERVIEW', 'OTHER']);
const assetTypes = new Set(['DOCUMENT', 'IMAGE', 'AUDIO', 'VIDEO', 'WEB_SNAPSHOT', 'TEXT', 'DATA', 'OTHER']);
const assetRoles = new Set(['ORIGINAL', 'DERIVED']);
const storageModes = new Set(['LOCAL', 'REMOTE', 'HYBRID']);
const contentFormats = new Set(['MARKDOWN', 'PLAIN_TEXT']);

function integrity(detail: string): never {
  throw new EvidenceSelectionIntegrityError(detail);
}

function classify(error: unknown): Error {
  if (error instanceof EvidenceSelectionIntegrityError || error instanceof EvidenceTargetNotAvailableError) return error;
  return new EvidenceSelectionStoreUnavailableError('EVIDENCE_SELECTION_STORE_UNAVAILABLE');
}

async function readOnlyTransaction<T>(pool: Pool, run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    const value = await run(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw classify(error);
  } finally {
    client.release();
  }
}

interface ScopeRow {
  project_id: string;
  project_state: string;
  issue_id: string;
  issue_state: string;
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

function validDate(value: unknown): boolean {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

async function loadScope(client: PoolClient, projectId: string, issueId: string, claimId: string): Promise<EvidenceClaimContext | null> {
  const { rows } = await client.query<ScopeRow>(
    `SELECT
       p.id AS project_id,
       p.lifecycle_state AS project_state,
       ri.id AS issue_id,
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
  if (!rows.length) return null;
  if (rows.length > 1) integrity('ISSUE_OWNER_AMBIGUOUS');
  const row = rows[0];
  if (!['ACTIVE', 'ARCHIVED'].includes(row.project_state)) integrity('PROJECT_LIFECYCLE_INVALID');
  if (row.issue_id !== issueId || !row.issue_binding_id) {
    if (row.issue_id === null) return null;
    if (!row.issue_binding_id) integrity('ISSUE_BINDING_DANGLING');
  }
  if (!['OPEN', 'RESOLVED', 'ARCHIVED'].includes(row.issue_state)) integrity('ISSUE_LIFECYCLE_INVALID');
  if (row.owner_project_id !== projectId) return null;
  if (!row.relation_claim_id) return null;
  if (!['ACTIVE', 'ARCHIVED'].includes(row.claim_state ?? '')) integrity('CLAIM_LIFECYCLE_INVALID');
  if (typeof row.claim_statement !== 'string' || !row.claim_statement.trim()) integrity('CLAIM_STATEMENT_INVALID');
  if (row.claim_metadata === null || typeof row.claim_metadata !== 'object' || Array.isArray(row.claim_metadata)) integrity('CLAIM_METADATA_INVALID');
  if (!validDate(row.claim_created_at) || !validDate(row.claim_updated_at)) integrity('CLAIM_TIMESTAMP_INVALID');
  return { id: claimId, statement: row.claim_statement, lifecycleState: row.claim_state as 'ACTIVE' | 'ARCHIVED' };
}

interface MaterialRow {
  binding_id: string;
  binding_created_at: Date;
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

interface MaterialGroup {
  bindingId: string;
  createdAt: Date;
  workTitle: string;
  declaredSourceId: string | null | undefined;
  source: { id: string; type: string; lifecycle: string; observedAt: Date } | null;
  assets: Array<{ id: string; type: string; role: string; storageMode: string; createdAt: Date }>;
  note: { bindingId: string; noteId: string; revisionId: string; revisionNo: number; contentFormat: string; createdAt: Date } | null;
}

function normalizeRevisionNo(value: string | number | null): number | null {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : null;
}

function readDeclaredSourceId(metadata: unknown): string | null | undefined {
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) integrity('EDITION_BINDING_METADATA_INVALID');
  const record = metadata as Record<string, unknown>;
  if (!('sourceId' in record) || record.sourceId === null || record.sourceId === undefined) return null;
  const value = record.sourceId;
  if (typeof value !== 'string' || !value.trim()) integrity('EDITION_BINDING_SOURCE_ID_INVALID');
  if (!uuidPattern.test(value)) integrity('EDITION_BINDING_SOURCE_ID_INVALID');
  return value.toLowerCase();
}

function groupMaterials(rows: MaterialRow[]): MaterialGroup[] {
  const groups = new Map<string, MaterialGroup>();
  for (const row of rows) {
    let group = groups.get(row.binding_id);
    if (!group) {
      if (!uuidPattern.test(row.binding_id)) integrity('EDITION_BINDING_ID_INVALID');
      if (!validDate(row.binding_created_at)) integrity('EDITION_BINDING_DATE_INVALID');
      if (!row.edition_id || !uuidPattern.test(row.edition_id)) integrity('EDITION_ID_INVALID');
      const created: MaterialGroup = {
        bindingId: row.binding_id,
        createdAt: row.binding_created_at,
        workTitle: typeof row.work_title === 'string' && row.work_title.trim() ? row.work_title : '',
        declaredSourceId: undefined,
        source: null,
        assets: [],
        note: null,
      };
      groups.set(row.binding_id, created);
      group = created;
    }
    const current: MaterialGroup = group;
    if (current.declaredSourceId === undefined) current.declaredSourceId = readDeclaredSourceId((row as MaterialRow & { binding_metadata?: unknown }).binding_metadata ?? {});
    if (row.source_id) {
      if (!current.source) {
        if (!uuidPattern.test(row.source_id)) integrity('SOURCE_ID_INVALID');
        if (!sourceTypes.has(row.source_type ?? '')) integrity('SOURCE_TYPE_INVALID');
        if (!['ACTIVE', 'ARCHIVED'].includes(row.source_lifecycle ?? '')) integrity('SOURCE_LIFECYCLE_INVALID');
        if (row.source_edition_id !== row.edition_id) integrity('SOURCE_EDITION_MISMATCH');
        if (!validDate(row.source_observed_at)) integrity('SOURCE_OBSERVED_AT_INVALID');
        current.source = { id: row.source_id, type: row.source_type as string, lifecycle: row.source_lifecycle as string, observedAt: row.source_observed_at as Date };
      }
    }
    if (row.asset_id) {
      if (!current.source) integrity('SOURCE_ASSET_WITHOUT_SOURCE');
      if (!uuidPattern.test(row.asset_id)) integrity('SOURCE_ASSET_ID_INVALID');
      if (!assetTypes.has(row.asset_type ?? '')) integrity('SOURCE_ASSET_TYPE_INVALID');
      if (!assetRoles.has(row.asset_role ?? '')) integrity('SOURCE_ASSET_ROLE_INVALID');
      if (!storageModes.has(row.asset_storage_mode ?? '')) integrity('SOURCE_ASSET_STORAGE_MODE_INVALID');
      if (!validDate(row.asset_created_at)) integrity('SOURCE_ASSET_DATE_INVALID');
      if (!current.assets.some(a => a.id === row.asset_id)) {
        current.assets.push({ id: row.asset_id, type: row.asset_type as string, role: row.asset_role as string, storageMode: row.asset_storage_mode as string, createdAt: row.asset_created_at as Date });
      }
    }
    if (row.note_binding_id) {
      // The material graph LEFT JOIN fans out one row per asset, so the same note
      // binding legitimately appears on multiple rows of the SAME edition binding.
      // Only a genuinely different note binding is corruption.
      if (current.note) {
        if (current.note.bindingId !== row.note_binding_id) integrity('DUPLICATE_NOTE_BINDING');
      } else {
      if (row.note_binding_role !== 'ANNOTATION') integrity('NOTE_BINDING_ROLE_INVALID');
      const meta = row.note_binding_metadata;
      if (!meta || typeof meta !== 'object' || Array.isArray(meta)) integrity('NOTE_BINDING_METADATA_INVALID');
      const record = meta as Record<string, unknown>;
      if (record.subjectBindingId !== row.binding_id || record.subjectType !== 'EDITION' || record.subjectId !== row.edition_id) {
        integrity('NOTE_BINDING_SUBJECT_MISMATCH');
      }
      if (row.note_type !== 'PROJECT_ITEM_NOTE') integrity('NOTE_TYPE_INVALID');
      if (!['ACTIVE', 'ARCHIVED'].includes(row.note_lifecycle ?? '')) integrity('NOTE_LIFECYCLE_INVALID');
      if (!row.note_id || !uuidPattern.test(row.note_id)) integrity('NOTE_ID_INVALID');
      if (!row.note_current_revision_id || !uuidPattern.test(row.note_current_revision_id)) integrity('NOTE_CURRENT_REVISION_INVALID');
      if (row.revision_id !== row.note_current_revision_id) integrity('NOTE_REVISION_NOT_CURRENT');
      const revisionNo = normalizeRevisionNo(row.revision_no);
      if (!revisionNo) integrity('NOTE_REVISION_NO_INVALID');
      if (!contentFormats.has(row.revision_content_format ?? '')) integrity('NOTE_REVISION_FORMAT_INVALID');
      if (!validDate(row.revision_created_at)) integrity('NOTE_REVISION_DATE_INVALID');
      current.note = {
        bindingId: row.note_binding_id,
        noteId: row.note_id,
        revisionId: row.revision_id as string,
        revisionNo,
        contentFormat: row.revision_content_format as string,
        createdAt: row.revision_created_at as Date,
      };
      }
    }
  }
  // fail closed: declared sourceId must resolve to an actual Source row
  for (const group of groups.values()) {
    if (group.declaredSourceId && !group.source) integrity('DECLARED_SOURCE_MISSING');
    if (group.source && group.source.id !== group.declaredSourceId) integrity('DECLARED_SOURCE_MISMATCH');
  }
  return Array.from(groups.values()).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.bindingId < b.bindingId ? -1 : 1));
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
    LEFT JOIN core.sources s ON s.id = (pb.metadata->>'sourceId')::uuid
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

function toCandidates(groups: MaterialGroup[]): EvidenceCandidate[] {
  const out: EvidenceCandidate[] = [];
  for (const group of groups) {
    if (group.source) {
      out.push({
        targetType: 'SOURCE',
        targetId: group.source.id,
        materialBindingId: group.bindingId,
        materialTitle: group.workTitle,
        sourceType: group.source.type as EvidenceCandidate extends { sourceType: infer T } ? T : never,
        sourceLifecycleState: group.source.lifecycle as 'ACTIVE' | 'ARCHIVED',
        observedAt: group.source.observedAt.toISOString(),
      });
    }
    const assets = [...group.assets].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1));
    for (const asset of assets) {
      out.push({
        targetType: 'SOURCE_ASSET',
        targetId: asset.id,
        materialBindingId: group.bindingId,
        materialTitle: group.workTitle,
        sourceId: group.source!.id,
        assetType: asset.type as never,
        assetRole: asset.role as 'ORIGINAL' | 'DERIVED',
        storageMode: asset.storageMode as 'LOCAL' | 'REMOTE' | 'HYBRID',
        createdAt: asset.createdAt.toISOString(),
      });
    }
    if (group.note) {
      out.push({
        targetType: 'NOTE_REVISION',
        targetId: group.note.revisionId,
        materialBindingId: group.bindingId,
        materialTitle: group.workTitle,
        noteId: group.note.noteId,
        revisionNo: group.note.revisionNo,
        contentFormat: group.note.contentFormat as 'MARKDOWN' | 'PLAIN_TEXT',
        createdAt: group.note.createdAt.toISOString(),
      });
    }
  }
  return out;
}

export function createPostgresEvidenceSelectionStore(pool: Pool): EvidenceSelectionStore {
  return {
    async candidates(input) {
      return readOnlyTransaction(pool, async (client) => {
        const claim = await loadScope(client, input.projectId, input.issueId, input.claimId);
        if (!claim) return null;
        const { rows } = await client.query<MaterialRow>(materialGraphQuery(), [input.projectId]);
        const groups = groupMaterials(rows);
        return { claim, candidates: toCandidates(groups) };
      });
    },
    async authorizePreview(input) {
      return readOnlyTransaction(pool, async (client) => {
        const claim = await loadScope(client, input.projectId, input.issueId, input.claimId);
        if (!claim) return null;
        const values: unknown[] = [];
        const tuples = input.items.map((item, index) => {
          const base = index * 3;
          values.push(index + 1, item.targetType, item.targetId);
          return `($${base + 1}::int, $${base + 2}::text, $${base + 3}::uuid)`;
        });
        const { rows } = await client.query<{ ordinal: number }>(
          `WITH requested(ordinal, target_type, target_id) AS (
             VALUES ${tuples.join(', ')}
           )
           SELECT r.ordinal
           FROM requested r
           JOIN core.project_bindings pb ON pb.project_id = $${values.length + 1} AND pb.target_type = 'EDITION'
           JOIN core.editions e ON e.id = pb.target_id
           LEFT JOIN core.sources s ON s.id = (pb.metadata->>'sourceId')::uuid
           LEFT JOIN core.source_assets sa ON sa.source_id = s.id
           LEFT JOIN core.project_bindings nb
             ON nb.project_id = pb.project_id AND nb.target_type = 'NOTE'
            AND nb.binding_role = 'ANNOTATION'
            AND nb.metadata->>'subjectBindingId' = pb.id::text
           LEFT JOIN core.notes n ON n.id = nb.target_id AND n.note_type = 'PROJECT_ITEM_NOTE'
           LEFT JOIN core.note_revisions nr ON nr.note_id = n.id
           WHERE (r.target_type = 'SOURCE' AND s.id = r.target_id)
              OR (r.target_type = 'SOURCE_ASSET' AND sa.id = r.target_id)
              OR (r.target_type = 'NOTE_REVISION' AND nr.id = r.target_id)
           GROUP BY r.ordinal
           ORDER BY r.ordinal`,
          [...values, input.projectId],
        );
        const authorizedOrdinals = new Set(rows.map(row => Number(row.ordinal)));
        for (let index = 1; index <= input.items.length; index += 1) {
          if (!authorizedOrdinals.has(index)) throw new EvidenceTargetNotAvailableError('EVIDENCE_TARGET_NOT_AVAILABLE');
        }
        return { claim };
      });
    },
  };
}

export type { EvidenceDraftInputItem };
