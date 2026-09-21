import { it, expect, vi } from 'vitest';
import type { Pool } from 'pg';
import { createPostgresEvidenceSelectionStore } from './evidence-selection-store.js';
import { EvidenceSelectionIntegrityError, EvidenceSelectionStoreUnavailableError, EvidenceTargetNotAvailableError } from '../application/evidence-selection.js';
import { normalizeEvidencePreviewInput } from '../domain/evidence-selection.js';

const p = '11111111-1111-4111-8111-111111111111';
const i = '22222222-2222-4222-8222-222222222222';
const c = '33333333-3333-4333-8333-333333333333';
const eb = '44444444-4444-4444-8444-444444444444'; // edition binding
const ed = '55555555-5555-4555-8555-555555555555'; // edition
const src = '66666666-6666-4666-8666-666666666666'; // source
const sa = '77777777-7777-4777-8777-777777777777'; // source asset
const nb = '88888888-8888-4888-8888-888888888888'; // note binding
const note = '99999999-9999-4999-8999-999999999999';
const nr = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; // note revision

function scopeRow(o: any = {}) {
  return {
    project_id: p,
    project_state: o.projectState ?? 'ACTIVE',
    issue_id: i,
    issue_state: o.issueState ?? 'OPEN',
    issue_binding_id: eb,
    owner_project_id: o.owner ?? p,
    issue_binding_role: null,
    issue_binding_metadata: {},
    relation_claim_id: c,
    claim_statement: 'claim statement',
    claim_state: o.claimState ?? 'ACTIVE',
    claim_type: null,
    subject_type: null,
    subject_id: null,
    claim_metadata: {},
    claim_created_at: new Date(),
    claim_updated_at: new Date(),
  };
}

function materialRow(o: any = {}) {
  return {
    binding_id: o.bindingId ?? eb,
    binding_created_at: o.bindingCreatedAt ?? new Date('2026-01-01T00:00:00Z'),
    binding_metadata: o.bindingMetadata ?? { sourceId: o.sourceId ?? src },
    edition_id: o.editionId ?? ed,
    work_title: '北京古道志',
    source_id: o.sourceId ?? src,
    source_type: o.sourceType ?? 'DATABASE_RECORD',
    source_lifecycle: o.sourceLifecycle ?? 'ACTIVE',
    source_edition_id: o.sourceEdition ?? ed,
    source_observed_at: o.sourceObservedAt ?? new Date('2026-01-02T00:00:00Z'),
    asset_id: o.assetId ?? null,
    asset_type: o.assetId ? (o.assetType ?? 'DOCUMENT') : null,
    asset_role: o.assetId ? (o.assetRole ?? 'ORIGINAL') : null,
    asset_storage_mode: o.assetId ? (o.assetStorageMode ?? 'LOCAL') : null,
    asset_created_at: o.assetId ? (o.assetCreatedAt ?? new Date('2026-01-04T00:00:00Z')) : null,
    note_binding_id: o.noteBindingId ?? nb,
    note_binding_role: o.noteBindingRole ?? 'ANNOTATION',
    note_binding_metadata: o.noteBindingMetadata ?? { subjectBindingId: eb, subjectType: 'EDITION', subjectId: ed },
    note_id: o.noteId ?? note,
    note_type: o.noteType ?? 'PROJECT_ITEM_NOTE',
    note_lifecycle: o.noteLifecycle ?? 'ACTIVE',
    note_current_revision_id: o.currentRevisionId ?? nr,
    revision_id: o.revisionId ?? nr,
    revision_no: o.revisionNo ?? 2,
    revision_content_format: o.contentFormat ?? 'MARKDOWN',
    revision_created_at: o.revisionCreatedAt ?? new Date('2026-01-03T00:00:00Z'),
  };
}

function setup(o: any = {}) {
  const query = vi.fn(async (sql: string) => {
    if (o.fail && sql.includes(o.fail)) throw Object.assign(new Error('SECRET'), { code: o.code });
    if (sql.includes('WITH requested')) return { rows: o.authorized ?? [{ ordinal: 1, ok: true }] };
    if (sql.includes('FROM core.projects p')) return { rows: o.scope ?? [scopeRow(o)] };
    if (sql.includes('LEFT JOIN core.source_assets')) return { rows: o.materials ?? [materialRow()] };
    return { rows: [] };
  });
  const release = vi.fn();
  return { query, release, store: createPostgresEvidenceSelectionStore({ connect: async () => ({ query, release }) } as unknown as Pool) };
}

it('candidates and preview both use REPEATABLE READ READ ONLY transactions', async () => {
  const s = setup();
  await s.store.candidates({ projectId: p, issueId: i, claimId: c });
  expect(s.query.mock.calls[0][0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY');
  const s2 = setup();
  await s2.store.authorizePreview({ projectId: p, issueId: i, claimId: c, items: [{ role: 'SUPPORTING', targetType: 'SOURCE', targetId: src, note: null }] });
  expect(s2.query.mock.calls[0][0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY');
});

it('no SQL statement contains INSERT/UPDATE/DELETE', async () => {
  const s = setup();
  await s.store.candidates({ projectId: p, issueId: i, claimId: c });
  await s.store.authorizePreview({ projectId: p, issueId: i, claimId: c, items: [{ role: 'SUPPORTING', targetType: 'SOURCE', targetId: src, note: null }] });
  for (const call of s.query.mock.calls) {
    expect(call[0]).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
  }
});

it('accepts ACTIVE and ARCHIVED project/issue/claim for reads', async () => {
  for (const o of [
    { projectState: 'ACTIVE' }, { projectState: 'ARCHIVED' },
    { issueState: 'OPEN' }, { issueState: 'RESOLVED' }, { issueState: 'ARCHIVED' },
    { claimState: 'ACTIVE' }, { claimState: 'ARCHIVED' },
  ]) {
    const s = setup(o);
    const result = await s.store.candidates({ projectId: p, issueId: i, claimId: c });
    expect(result?.claim.id).toBe(c);
  }
});

it('wrong-project issue, missing claim relation return null', async () => {
  const wrong = setup({ owner: 'ffffffff-ffff-4fff-8fff-ffffffffffff' });
  await expect(wrong.store.candidates({ projectId: p, issueId: i, claimId: c })).resolves.toBeNull();
  const noRelation = setup({ scope: [{ ...scopeRow(), relation_claim_id: null }] });
  await expect(noRelation.store.candidates({ projectId: p, issueId: i, claimId: c })).resolves.toBeNull();
});

it('zero/multiple issue owners and corrupt claims fail closed', async () => {
  const zero = setup({ scope: [] });
  await expect(zero.store.candidates({ projectId: p, issueId: i, claimId: c })).resolves.toBeNull();
  const multi = setup({ scope: [scopeRow(), scopeRow()] });
  await expect(multi.store.candidates({ projectId: p, issueId: i, claimId: c })).rejects.toBeInstanceOf(EvidenceSelectionIntegrityError);
  const corrupt = setup({ scope: [{ ...scopeRow(), claim_statement: null }] });
  await expect(corrupt.store.candidates({ projectId: p, issueId: i, claimId: c })).rejects.toBeInstanceOf(EvidenceSelectionIntegrityError);
});

it('absent sourceId yields no SOURCE candidate; declared dangling/malformed sourceId fails closed', async () => {
  const absentRow = {
    ...materialRow(),
    binding_metadata: {},
    source_id: null,
    source_type: null,
    source_lifecycle: null,
    source_edition_id: null,
    source_observed_at: null,
  };
  const absent = setup({ materials: [absentRow] });
  const absentResult = await absent.store.candidates({ projectId: p, issueId: i, claimId: c });
  expect(absentResult?.candidates.filter(x => x.targetType === 'SOURCE')).toHaveLength(0);
  // note candidate still present
  expect(absentResult?.candidates.some(x => x.targetType === 'NOTE_REVISION')).toBe(true);

  // declared but no source row: metadata declaring a different id than the joined row
  const danglingDeclared = setup({ materials: [materialRow({ bindingMetadata: { sourceId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' } })] });
  await expect(danglingDeclared.store.candidates({ projectId: p, issueId: i, claimId: c })).rejects.toBeInstanceOf(EvidenceSelectionIntegrityError);

  const mismatch = setup({ materials: [materialRow({ sourceEdition: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' })] });
  await expect(mismatch.store.candidates({ projectId: p, issueId: i, claimId: c })).rejects.toBeInstanceOf(EvidenceSelectionIntegrityError);
});

it('assets appear only under validated sources and never leak storage keys', async () => {
  const s = setup({ materials: [materialRow({ assetId: sa })] });
  const result = await s.store.candidates({ projectId: p, issueId: i, claimId: c });
  const asset = result?.candidates.find(x => x.targetType === 'SOURCE_ASSET');
  expect(asset).toBeTruthy();
  expect(JSON.stringify(result)).not.toMatch(/storage_key|remote_uri/);
});

it('note binding must be ANNOTATION with exact subject metadata; duplicates fail closed', async () => {
  const badRole = setup({ materials: [materialRow({ noteBindingRole: 'OTHER' })] });
  await expect(badRole.store.candidates({ projectId: p, issueId: i, claimId: c })).rejects.toBeInstanceOf(EvidenceSelectionIntegrityError);
  const badMeta = setup({ materials: [materialRow({ noteBindingMetadata: { subjectBindingId: 'x', subjectType: 'EDITION', subjectId: ed } })] });
  await expect(badMeta.store.candidates({ projectId: p, issueId: i, claimId: c })).rejects.toBeInstanceOf(EvidenceSelectionIntegrityError);
  const dup = setup({ materials: [materialRow(), materialRow({ noteBindingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' })] });
  await expect(dup.store.candidates({ projectId: p, issueId: i, claimId: c })).rejects.toBeInstanceOf(EvidenceSelectionIntegrityError);
});

it('only current revision appears in candidates', async () => {
  const s = setup();
  const result = await s.store.candidates({ projectId: p, issueId: i, claimId: c });
  const notes = result?.candidates.filter(x => x.targetType === 'NOTE_REVISION') ?? [];
  expect(notes).toHaveLength(1);
  expect((notes[0] as { revisionNo: number }).revisionNo).toBe(2);
});

it('candidate order is material binding ASC then SOURCE, assets, current note', async () => {
  const e0 = new Date('2026-01-01T00:00:00Z');
  const e1 = new Date('2026-01-05T00:00:00Z');
  const b0 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const b1 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const metaFor = (bindingId: string) => ({ subjectBindingId: bindingId, subjectType: 'EDITION', subjectId: ed });
  const s = setup({
    materials: [
      materialRow({ bindingId: b1, bindingCreatedAt: e1, assetId: null, noteBindingMetadata: metaFor(b1) }),
      materialRow({ bindingId: b0, bindingCreatedAt: e0, assetId: sa, assetCreatedAt: e0, noteBindingMetadata: metaFor(b0) }),
    ],
  });
  const result = await s.store.candidates({ projectId: p, issueId: i, claimId: c });
  const order = result?.candidates.map(x => `${x.targetType}:${x.materialBindingId}`);
  // material b0 first: SOURCE, SOURCE_ASSET, NOTE_REVISION; then b1: SOURCE, NOTE_REVISION
  expect(order).toEqual([
    `SOURCE:${b0}`, `SOURCE_ASSET:${b0}`, `NOTE_REVISION:${b0}`,
    `SOURCE:${b1}`, `NOTE_REVISION:${b1}`,
  ]);
});

it('authorizePreview accepts current revision and rejects orphan old revision (fail closed)', async () => {
  // M2-C PR17 fix: authorizePreview no longer uses the WITH requested ordinal SQL.
  // It authorizes against the validated material graph (Finding 1). The graph
  // holds the current revision directly. Old revisions are accepted only when
  // they belong to a note that is itself in the graph; orphans are rejected.
  // Graph-miss cases surface as EvidenceTargetNotAvailableError to preserve
  // cross-project 404 equivalence (existing acceptance).
  const s = setup({
    materials: [
      materialRow({ noteBindingMetadata: { subjectBindingId: eb, subjectType: 'EDITION', subjectId: ed } }),
    ],
  });
  // current revision is the default materialRow.note.revisionId (== nr) → must succeed.
  const currentItems = normalizeEvidencePreviewInput({ items: [{ role: 'SUPPORTING', targetType: 'NOTE_REVISION', targetId: nr, note: null }] });
  await expect(s.store.authorizePreview({ projectId: p, issueId: i, claimId: c, items: currentItems }))
    .resolves.toBeTruthy();
  // an OLD revision that does NOT belong to any graph note → fail-closed (target not available).
  const orphanItems = normalizeEvidencePreviewInput({ items: [{ role: 'SUPPORTING', targetType: 'NOTE_REVISION', targetId: '00000000-0000-4000-8000-000000000001', note: null }] });
  await expect(s.store.authorizePreview({ projectId: p, issueId: i, claimId: c, items: orphanItems }))
    .rejects.toBeInstanceOf(EvidenceTargetNotAvailableError);
});

it('preview authorization rejects targets not present in the validated material graph', async () => {
  // M2-C PR17 fix: when the graph does not contain the requested target,
  // authorizePreview fails closed with EvidenceTargetNotAvailableError so the
  // route layer keeps the canonical "target not available" response for
  // cross-project / nonexistent / archived cases (existing acceptance). The
  // store now enforces the same canonical rules as candidates() — the
  // difference is only the error class (not available vs canonical corruption).
  const s = setup({ materials: [] });
  const items = normalizeEvidencePreviewInput({ items: [{ role: 'SUPPORTING', targetType: 'SOURCE', targetId: 'ffffffff-ffff-4fff-8fff-ffffffffffff', note: null }] });
  await expect(s.store.authorizePreview({ projectId: p, issueId: i, claimId: c, items }))
    .rejects.toBeInstanceOf(EvidenceTargetNotAvailableError);
});

it('preview authorization validates scope first: null scope returns null before target query', async () => {
  const s = setup({ owner: 'ffffffff-ffff-4fff-8fff-ffffffffffff' });
  await expect(s.store.authorizePreview({
    projectId: p, issueId: i, claimId: c,
    items: [{ role: 'SUPPORTING', targetType: 'SOURCE', targetId: src, note: null }],
  })).resolves.toBeNull();
  expect(s.query.mock.calls.some(x => x[0].includes('WITH requested'))).toBe(false);
});

it('connection failures become typed unavailable', async () => {
  await expect(setup({ fail: 'FROM core.projects p', code: 'ECONNREFUSED' }).store.candidates({ projectId: p, issueId: i, claimId: c }))
    .rejects.toBeInstanceOf(EvidenceSelectionStoreUnavailableError);
});

// ===== Finding 1: preview authorization must use the same canonical material graph =====

it('preview rejects source whose edition does not match the project edition binding', async () => {
  const s = setup({
    materials: [materialRow({ sourceEdition: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' })],
    authorized: [{ ordinal: 1, ok: true }],
  });
  await expect(s.store.authorizePreview({
    projectId: p, issueId: i, claimId: c,
    items: [{ role: 'SUPPORTING', targetType: 'SOURCE', targetId: src, note: null }],
  })).rejects.toBeInstanceOf(EvidenceSelectionIntegrityError);
});

it('preview rejects source asset whose source edition does not match the project edition binding', async () => {
  const s = setup({
    materials: [materialRow({ assetId: sa, sourceEdition: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' })],
    authorized: [{ ordinal: 1, ok: true }],
  });
  await expect(s.store.authorizePreview({
    projectId: p, issueId: i, claimId: c,
    items: [{ role: 'SUPPORTING', targetType: 'SOURCE_ASSET', targetId: sa, note: null }],
  })).rejects.toBeInstanceOf(EvidenceSelectionIntegrityError);
});

it('preview rejects malformed note subject metadata (subjectType not EDITION)', async () => {
  const s = setup({
    materials: [materialRow({ noteBindingMetadata: { subjectBindingId: eb, subjectType: 'WORK', subjectId: ed } })],
    authorized: [{ ordinal: 1, ok: true }],
  });
  await expect(s.store.authorizePreview({
    projectId: p, issueId: i, claimId: c,
    items: [{ role: 'SUPPORTING', targetType: 'NOTE_REVISION', targetId: nr, note: null }],
  })).rejects.toBeInstanceOf(EvidenceSelectionIntegrityError);
});

it('preview rejects malformed note subject metadata (subjectId not exact bound edition)', async () => {
  const s = setup({
    materials: [materialRow({ noteBindingMetadata: { subjectBindingId: eb, subjectType: 'EDITION', subjectId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' } })],
    authorized: [{ ordinal: 1, ok: true }],
  });
  await expect(s.store.authorizePreview({
    projectId: p, issueId: i, claimId: c,
    items: [{ role: 'SUPPORTING', targetType: 'NOTE_REVISION', targetId: nr, note: null }],
  })).rejects.toBeInstanceOf(EvidenceSelectionIntegrityError);
});

// ===== Finding 2: scope canonicality + error classification =====

it('issue binding role non-null (e.g. OWNER) fails closed', async () => {
  const s = setup({ scope: [{ ...scopeRow(), issue_binding_role: 'OWNER' }] });
  await expect(s.store.candidates({ projectId: p, issueId: i, claimId: c })).rejects.toBeInstanceOf(EvidenceSelectionIntegrityError);
  await expect(s.store.authorizePreview({
    projectId: p, issueId: i, claimId: c,
    items: [{ role: 'SUPPORTING', targetType: 'SOURCE', targetId: src, note: null }],
  })).rejects.toBeInstanceOf(EvidenceSelectionIntegrityError);
});

it('issue binding metadata non-object (e.g. array) fails closed', async () => {
  const s = setup({ scope: [{ ...scopeRow(), issue_binding_metadata: [] }] });
  await expect(s.store.candidates({ projectId: p, issueId: i, claimId: c })).rejects.toBeInstanceOf(EvidenceSelectionIntegrityError);
});

it('claim statement reduces to empty after canonical normalization (CRLF-only input) fails closed', async () => {
  // CRLF-only / whitespace-only statements normalize to empty string and must fail closed.
  const s = setup({ scope: [{ ...scopeRow(), claim_statement: '\r\n \t \r\n' }] });
  await expect(s.store.candidates({ projectId: p, issueId: i, claimId: c })).rejects.toBeInstanceOf(EvidenceSelectionIntegrityError);
});

it('claim statement reduces to empty after canonical normalization (whitespace-only input) fails closed', async () => {
  const s = setup({ scope: [{ ...scopeRow(), claim_statement: '   \t  \n  ' }] });
  await expect(s.store.candidates({ projectId: p, issueId: i, claimId: c })).rejects.toBeInstanceOf(EvidenceSelectionIntegrityError);
});

it('claim subject pair malformed (subject_type NULL but subject_id set) fails closed', async () => {
  const s = setup({ scope: [{ ...scopeRow(), subject_type: null, subject_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }] });
  await expect(s.store.candidates({ projectId: p, issueId: i, claimId: c })).rejects.toBeInstanceOf(EvidenceSelectionIntegrityError);
});

it('claim subject_type outside allowlist fails closed', async () => {
  const s = setup({ scope: [{ ...scopeRow(), subject_type: 'RESEARCH_ISSUE', subject_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }] });
  await expect(s.store.candidates({ projectId: p, issueId: i, claimId: c })).rejects.toBeInstanceOf(EvidenceSelectionIntegrityError);
});

it('claim_type non-null non-string fails closed', async () => {
  const s = setup({ scope: [{ ...scopeRow(), claim_type: 42 }] });
  await expect(s.store.candidates({ projectId: p, issueId: i, claimId: c })).rejects.toBeInstanceOf(EvidenceSelectionIntegrityError);
});

it('claim subject_type EDITION with valid uuid passes (historical/global compatibility)', async () => {
  const s = setup({ scope: [{ ...scopeRow(), subject_type: 'EDITION', subject_id: ed }] });
  const result = await s.store.candidates({ projectId: p, issueId: i, claimId: c });
  expect(result?.claim.id).toBe(c);
});

it('claim claim_type non-null string passes (historical/global compatibility)', async () => {
  const s = setup({ scope: [{ ...scopeRow(), claim_type: 'OBSERVATION' }] });
  const result = await s.store.candidates({ projectId: p, issueId: i, claimId: c });
  expect(result?.claim.id).toBe(c);
});

// Malformed declared sourceId: the SQL cast `(metadata->>'sourceId')::uuid` would throw 22P02
// and current classify() catches it as StoreUnavailable. After fix it must surface as IntegrityError.

it('declared sourceId malformed string surfaces as integrity (candidates path)', async () => {
  // We simulate by setting binding_metadata to {sourceId:'not-a-uuid'}; current production code's
  // readDeclaredSourceId() never runs because the SQL cast fires first.
  const s = setup({ materials: [materialRow({ bindingMetadata: { sourceId: 'not-a-uuid' } })] });
  await expect(s.store.candidates({ projectId: p, issueId: i, claimId: c })).rejects.toBeInstanceOf(EvidenceSelectionIntegrityError);
});

// Error classification: connection-stage failures (from pool.connect) must be typed unavailable;
// mid-transaction PostgreSQL errors that product did not wrap must NOT be silently re-wrapped
// as StoreUnavailable.

it('connection-stage failure (pool.connect rejects ECONNREFUSED) becomes typed unavailable', async () => {
  // Distinct harness: the connect call itself rejects. Setup with a separate connectionRejectingPool.
  const query = vi.fn();
  const release = vi.fn();
  const pool = { connect: async () => { throw Object.assign(new Error('connect down'), { code: 'ECONNREFUSED' }); } } as unknown as Pool;
  const store = createPostgresEvidenceSelectionStore(pool);
  await expect(store.candidates({ projectId: p, issueId: i, claimId: c })).rejects.toBeInstanceOf(EvidenceSelectionStoreUnavailableError);
  await expect(store.authorizePreview({
    projectId: p, issueId: i, claimId: c,
    items: [{ role: 'SUPPORTING', targetType: 'SOURCE', targetId: src, note: null }],
  })).rejects.toBeInstanceOf(EvidenceSelectionStoreUnavailableError);
});

it('mid-transaction 22P02 not rewrapped to StoreUnavailable when no product validator runs', async () => {
  // The candidate query SELECT itself fires after begin and gets 22P02 on the cast.
  // In the current implementation, classify() catches it and wraps to StoreUnavailable.
  // After fix, raw cast is removed, so this path no longer occurs. The test should still
  // assert: when the cast IS the only validator, the error type must NOT be StoreUnavailable
  // — but more importantly, this test pins behavior so future regression is impossible.
  // We assert: throwing 22P02 inside the SELECT mid-transaction must not become StoreUnavailable.
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('BEGIN')) return { rows: [] };
    if (sql.includes('ROLLBACK')) return { rows: [] };
    if (sql.includes('FROM core.projects p')) {
      throw Object.assign(new Error('invalid input syntax for type uuid'), { code: '22P02' });
    }
    return { rows: [] };
  });
  const release = vi.fn();
  const pool = { connect: async () => ({ query, release }) } as unknown as Pool;
  const store = createPostgresEvidenceSelectionStore(pool);
  // We don't constrain the type (it could be the raw 22P02 error or rethrown as-is); the contract
  // is that it is NOT wrapped to StoreUnavailable.
  try {
    await store.candidates({ projectId: p, issueId: i, claimId: c });
    throw new Error('expected throw');
  } catch (e) {
    expect(e).not.toBeInstanceOf(EvidenceSelectionStoreUnavailableError);
  }
});
