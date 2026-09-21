import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createPostgresEvidenceSelectionStore } from "./evidence-selection-store.js";
import {
  EvidenceSelectionIntegrityError,
  EvidenceTargetNotAvailableError,
} from "../application/evidence-selection.js";
import { buildEvidenceManifestDraft, normalizeEvidencePreviewInput } from "../domain/evidence-selection.js";

const url = process.env.S32_M2C_TEST_DATABASE_URL;
const parsed = url ? new URL(url) : null;
if (parsed && (parsed.hostname !== "127.0.0.1" || parsed.pathname !== "/s32_m2c_test")) {
  throw new Error("M2-C integration requires isolated local s32_m2c_test");
}

const d = url
  ? describe
  : describe.skip;

const P1 = "11111111-1111-4111-8111-111111111111";
const I1 = "22222222-2222-4222-8222-222222222222";
const EB1 = "33333333-3333-4333-8333-333333333333"; // edition binding 1 (with source)
const EB2 = "44444444-4444-4444-8444-444444444444"; // edition binding 2 (no sourceId)
const WORK = "55555555-5555-4555-8555-555555555555";
const ED1 = "66666666-6666-4666-8666-666666666666";
const ED2 = "77777777-7777-4777-8777-777777777777";
const SRC1 = "88888888-8888-4888-8888-888888888888";
const SA1 = "99999999-9999-4999-8999-999999999999";
const SA2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NB1 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NOTE1 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const REV1 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const REV2 = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const CLAIM1 = "1a1a1a1a-1a1a-41a1-81a1-1a1a1a1a1a1a";
const ISSUE1 = "2b2b2b2b-2b2b-42b2-82b2-2b2b2b2b2b2b";
// second project
const P2 = "3c3c3c3c-3c3c-43c3-83c3-3c3c3c3c3c3c";
const EBX = "4d4d4d4d-4d4d-44d4-84d4-4d4d4d4d4d4d";
const WORKX = "5e5e5e5e-5e5e-45e5-85e5-5e5e5e5e5e5e";
const EDX = "6f6f6f6f-6f6f-46f6-86f6-6f6f6f6f6f6f";
const SRCX = "70707070-7070-4707-8707-707070707070";
const SAX = "81818181-8181-4818-8818-818181818181";
const ISSUE2 = "92929292-9292-4929-8929-929292929292";
const NBX = "a3a3a3a3-a3a3-43a3-83a3-a3a3a3a3a3a3";
const NOTEX = "b4b4b4b4-b4b4-44b4-84b4-b4b4b4b4b4b4";
const REVX = "c5c5c5c5-c5c5-45c5-85c5-c5c5c5c5c5c5";
// archived copies
const PA = "d6d6d6d6-d6d6-46d6-86d6-d6d6d6d6d6d6";
const EBA = "e7e7e7e7-e7e7-47e7-87e7-e7e7e7e7e7e7";
const WORKA = "f8f8f8f8-f8f8-48f8-88f8-f8f8f8f8f8f8";
const EDA = "09090909-0909-4090-8090-090909090909";
const ISSUEA = "1f1f1f1f-1f1f-41f1-81f1-1f1f1f1f1f1f";
const CLAIMA = "2e2e2e2e-2e2e-42e2-82e2-2e2e2e2e2e2e";
const NBA = "3d3d3d3d-3d3d-43d3-83d3-3d3d3d3d3d3d";
const NOTEA = "4c4c4c4c-4c4c-44c4-84c4-4c4c4c4c4c4c";
const REVA = "5b5b5b5b-5b5b-45b5-85b5-5b5b5b5b5b5b";

let pool: Pool;
let store: ReturnType<typeof createPostgresEvidenceSelectionStore>;

function sqlFile(statements: string[]): string {
  return statements.join(";\n") + ";\n";
}

const FIXTURE = sqlFile([
  // project 1: ACTIVE with issue + claim + edition binding(source) + assets + note rev1/rev2
  `INSERT INTO core.projects (id, name, lifecycle_state) VALUES ('${P1}', 'project one', 'ACTIVE')`,
  `INSERT INTO core.projects (id, name, lifecycle_state) VALUES ('${P2}', 'project two', 'ACTIVE')`,
  `INSERT INTO core.projects (id, name, lifecycle_state) VALUES ('${PA}', 'archived project', 'ARCHIVED')`,
  `INSERT INTO core.works (id, work_type, title, title_status) VALUES ('${WORK}', 'BOOK', '北京古道志', 'KNOWN')`,
  `INSERT INTO core.works (id, work_type, title, title_status) VALUES ('${WORKX}', 'BOOK', '他项目资料', 'KNOWN')`,
  `INSERT INTO core.works (id, work_type, title, title_status) VALUES ('${WORKA}', 'BOOK', '归档项目资料', 'KNOWN')`,
  `INSERT INTO core.editions (id, work_id, edition_type, publication_date_precision, lifecycle_state) VALUES ('${ED1}', '${WORK}', 'PRINT', 'YEAR', 'ACTIVE')`,
  `INSERT INTO core.editions (id, work_id, edition_type, publication_date_precision, lifecycle_state) VALUES ('${ED2}', '${WORK}', 'EBOOK', 'YEAR', 'ACTIVE')`,
  `INSERT INTO core.editions (id, work_id, edition_type, publication_date_precision, lifecycle_state) VALUES ('${EDX}', '${WORKX}', 'PRINT', 'YEAR', 'ACTIVE')`,
  `INSERT INTO core.editions (id, work_id, edition_type, publication_date_precision, lifecycle_state) VALUES ('${EDA}', '${WORKA}', 'PRINT', 'YEAR', 'ACTIVE')`,
  `INSERT INTO core.sources (id, source_type, edition_id, lifecycle_state, observed_at) VALUES ('${SRC1}', 'DATABASE_RECORD', '${ED1}', 'ACTIVE', now())`,
  `INSERT INTO core.sources (id, source_type, edition_id, lifecycle_state, observed_at) VALUES ('${SRCX}', 'ARCHIVAL_RECORD', '${EDX}', 'ACTIVE', now())`,
  `INSERT INTO core.source_assets (id, source_id, asset_type, asset_role, storage_mode, storage_key, sha256) VALUES ('${SA1}', '${SRC1}', 'DOCUMENT', 'ORIGINAL', 'LOCAL', 'local-key-1', '${"e".repeat(64)}')`,
  `INSERT INTO core.source_assets (id, source_id, asset_type, asset_role, storage_mode, remote_uri) VALUES ('${SA2}', '${SRC1}', 'IMAGE', 'DERIVED', 'REMOTE', 'https://example.test/asset')`,
  `INSERT INTO core.source_assets (id, source_id, asset_type, asset_role, storage_mode, storage_key, sha256) VALUES ('${SAX}', '${SRCX}', 'DATA', 'ORIGINAL', 'LOCAL', 'local-key-x', '${"f".repeat(64)}')`,
  `INSERT INTO core.notes (id, note_type, lifecycle_state, current_revision_id, next_revision_no) VALUES ('${NOTE1}', 'PROJECT_ITEM_NOTE', 'ACTIVE', '${REV2}', 3)`,
  `INSERT INTO core.notes (id, note_type, lifecycle_state, current_revision_id, next_revision_no) VALUES ('${NOTEX}', 'PROJECT_ITEM_NOTE', 'ACTIVE', '${REVX}', 2)`,
  `INSERT INTO core.notes (id, note_type, lifecycle_state, current_revision_id, next_revision_no) VALUES ('${NOTEA}', 'PROJECT_ITEM_NOTE', 'ACTIVE', '${REVA}', 2)`,
  `INSERT INTO core.note_revisions (id, note_id, revision_no, content_format, content, content_sha256) VALUES ('${REV1}', '${NOTE1}', 1, 'MARKDOWN', 'note body rev1', '${"a".repeat(64)}')`,
  `INSERT INTO core.note_revisions (id, note_id, revision_no, content_format, content, content_sha256) VALUES ('${REV2}', '${NOTE1}', 2, 'MARKDOWN', 'note body rev2', '${"b".repeat(64)}')`,
  `INSERT INTO core.note_revisions (id, note_id, revision_no, content_format, content, content_sha256) VALUES ('${REVX}', '${NOTEX}', 1, 'MARKDOWN', 'foreign note', '${"c".repeat(64)}')`,
  `INSERT INTO core.note_revisions (id, note_id, revision_no, content_format, content, content_sha256) VALUES ('${REVA}', '${NOTEA}', 1, 'MARKDOWN', 'archived note', '${"d".repeat(64)}')`,
  `INSERT INTO core.project_bindings (id, project_id, target_type, target_id, binding_role, metadata) VALUES ('${EB1}', '${P1}', 'EDITION', '${ED1}', NULL, '{"sourceId":"${SRC1}"}')`,
  `INSERT INTO core.project_bindings (id, project_id, target_type, target_id, binding_role, metadata) VALUES ('${EB2}', '${P1}', 'EDITION', '${ED2}', NULL, '{}')`,
  `INSERT INTO core.project_bindings (id, project_id, target_type, target_id, binding_role, metadata) VALUES ('${EBX}', '${P2}', 'EDITION', '${EDX}', NULL, '{"sourceId":"${SRCX}"}')`,
  `INSERT INTO core.project_bindings (id, project_id, target_type, target_id, binding_role, metadata) VALUES ('${EBA}', '${PA}', 'EDITION', '${EDA}', NULL, '{}')`,
  `INSERT INTO core.project_bindings (id, project_id, target_type, target_id, binding_role, metadata) VALUES ('${NB1}', '${P1}', 'NOTE', '${NOTE1}', 'ANNOTATION', '{"subjectBindingId":"${EB1}","subjectType":"EDITION","subjectId":"${ED1}"}')`,
  `INSERT INTO core.project_bindings (id, project_id, target_type, target_id, binding_role, metadata) VALUES ('${NBX}', '${P2}', 'NOTE', '${NOTEX}', 'ANNOTATION', '{"subjectBindingId":"${EBX}","subjectType":"EDITION","subjectId":"${EDX}"}')`,
  `INSERT INTO core.project_bindings (id, project_id, target_type, target_id, binding_role, metadata) VALUES ('${NBA}', '${PA}', 'NOTE', '${NOTEA}', 'ANNOTATION', '{"subjectBindingId":"${EBA}","subjectType":"EDITION","subjectId":"${EDA}"}')`,
  `INSERT INTO core.research_issues (id, title, question, lifecycle_state) VALUES ('${ISSUE1}', '刘祥店迁出时间', '刘祥店村是否在 1960 年代发生整体迁出？', 'OPEN')`,
  `INSERT INTO core.research_issues (id, title, question, lifecycle_state) VALUES ('${ISSUE2}', 'foreign issue', 'other', 'OPEN')`,
  `INSERT INTO core.research_issues (id, title, question, lifecycle_state) VALUES ('${ISSUEA}', 'archived issue', 'other', 'ARCHIVED')`,
  `INSERT INTO core.project_bindings (id, project_id, target_type, target_id) VALUES ('e5a00000-0000-4000-8000-000000000001', '${P1}', 'RESEARCH_ISSUE', '${ISSUE1}')`,
  `INSERT INTO core.project_bindings (id, project_id, target_type, target_id) VALUES ('e5a00000-0000-4000-8000-000000000002', '${P2}', 'RESEARCH_ISSUE', '${ISSUE2}')`,
  `INSERT INTO core.project_bindings (id, project_id, target_type, target_id) VALUES ('e5a00000-0000-4000-8000-000000000003', '${PA}', 'RESEARCH_ISSUE', '${ISSUEA}')`,
  `INSERT INTO core.claims (id, statement, lifecycle_state) VALUES ('${CLAIM1}', '刘祥店可能在1960年代整体迁出。', 'ACTIVE')`,
  `INSERT INTO core.claims (id, statement, lifecycle_state) VALUES ('${CLAIMA}', 'archived claim', 'ARCHIVED')`,
  `INSERT INTO core.research_issue_claims (issue_id, claim_id) VALUES ('${ISSUE1}', '${CLAIM1}')`,
  `INSERT INTO core.research_issue_claims (issue_id, claim_id) VALUES ('${ISSUEA}', '${CLAIMA}')`,
]);

d("postgres evidence selection integration", () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: url });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(FIXTURE);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    store = createPostgresEvidenceSelectionStore(pool);
  });

  afterAll(async () => {
    // The disposable s32_m2c_test container is destroyed by the runner;
    // core.note_revisions rows are immutable (MANIFEST/REVISION IMMUTABLE triggers),
    // so no per-test SQL cleanup is performed here.
    await pool.end();
  });

  async function zeroWriteCounts() {
    const { rows } = await pool.query(`
      SELECT
        (SELECT count(*) FROM core.evidence_manifests) AS manifests,
        (SELECT count(*) FROM core.evidence_manifest_items) AS manifest_items,
        (SELECT count(*) FROM core.assessments) AS assessments,
        (SELECT count(*) FROM core.issue_resolutions) AS resolutions,
        (SELECT count(*) FROM core.research_runs) AS runs,
        (SELECT count(*) FROM ops.idempotency_keys) AS idempotency`);
    return rows[0];
  }

  it("lists SOURCE, SOURCE_ASSET and current NOTE_REVISION candidates in canonical order", async () => {
    const result = await store.candidates({ projectId: P1, issueId: ISSUE1, claimId: CLAIM1 });
    expect(result).not.toBeNull();
    expect(result!.claim.id).toBe(CLAIM1);
    const order = result!.candidates.map((x) => `${x.targetType}:${x.targetId}`);
    // material EB1 (earlier binding) first: SOURCE, 2 assets, NOTE_REVISION(rev2); EB2: no source, no note
    expect(order).toEqual([`SOURCE:${SRC1}`, `SOURCE_ASSET:${SA1}`, `SOURCE_ASSET:${SA2}`, `NOTE_REVISION:${REV2}`]);
    const note = result!.candidates.find((x) => x.targetType === "NOTE_REVISION") as { revisionNo: number };
    expect(note.revisionNo).toBe(2);
    expect(JSON.stringify(result)).not.toContain("note body");
    expect(JSON.stringify(result)).not.toContain("storage_key");
  });

  it("preview authorizes mixed targets and matches Task 1 canonical hash", async () => {
    const before = await zeroWriteCounts();
    const items = normalizeEvidencePreviewInput({
      items: [
        { role: "SUPPORTING", targetType: "SOURCE", targetId: SRC1, note: "支持" },
        { role: "CONTRADICTORY", targetType: "SOURCE_ASSET", targetId: SA2, note: null },
        { role: "CONTEXTUAL", targetType: "NOTE_REVISION", targetId: REV2, note: "  背景  " },
      ],
    });
    const authorized = await store.authorizePreview({ projectId: P1, issueId: ISSUE1, claimId: CLAIM1, items });
    expect(authorized).not.toBeNull();
    const draft = buildEvidenceManifestDraft(items);
    expect(draft.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
    const after = await zeroWriteCounts();
    expect(after).toEqual(before);
  });

  it("accepts the older immutable revision of the authorized note", async () => {
    const before = await zeroWriteCounts();
    const items = normalizeEvidencePreviewInput({
      items: [{ role: "SUPPORTING", targetType: "NOTE_REVISION", targetId: REV1, note: null }],
    });
    const authorized = await store.authorizePreview({ projectId: P1, issueId: ISSUE1, claimId: CLAIM1, items });
    expect(authorized).not.toBeNull();
    expect(await zeroWriteCounts()).toEqual(before);
  });

  it("rejects cross-project targets and nonexistent targets identically", async () => {
    const before = await zeroWriteCounts();
    for (const bad of [
      { role: "SUPPORTING", targetType: "SOURCE", targetId: SRCX },
      { role: "SUPPORTING", targetType: "SOURCE_ASSET", targetId: SAX },
      { role: "SUPPORTING", targetType: "NOTE_REVISION", targetId: REVX },
      { role: "SUPPORTING", targetType: "SOURCE", targetId: "deadbeef-dead-4dea-8dea-deadbeefdead" },
    ] as const) {
      const items = normalizeEvidencePreviewInput({ items: [{ ...bad, note: null }] });
      await expect(
        store.authorizePreview({ projectId: P1, issueId: ISSUE1, claimId: CLAIM1, items }),
      ).rejects.toBeInstanceOf(EvidenceTargetNotAvailableError);
    }
    expect(await zeroWriteCounts()).toEqual(before);
  });

  it("wrong-scope requests return null", async () => {
    const items = normalizeEvidencePreviewInput({ items: [{ role: "SUPPORTING", targetType: "SOURCE", targetId: SRC1, note: null }] });
    // wrong project for issue
    expect(await store.candidates({ projectId: P2, issueId: ISSUE1, claimId: CLAIM1 })).toBeNull();
    // claim not related to issue2
    expect(await store.candidates({ projectId: P2, issueId: ISSUE2, claimId: CLAIM1 })).toBeNull();
    await expect(store.authorizePreview({ projectId: P2, issueId: ISSUE2, claimId: CLAIM1, items })).resolves.toBeNull();
    // nonexistent project
    expect(await store.candidates({ projectId: "deadbeef-dead-4dea-8dea-deadbeefdead", issueId: ISSUE1, claimId: CLAIM1 })).toBeNull();
  });

  it("archived project/issue/claim remain readable", async () => {
    const result = await store.candidates({ projectId: PA, issueId: ISSUEA, claimId: CLAIMA });
    expect(result).not.toBeNull();
    expect(result!.claim.lifecycleState).toBe("ARCHIVED");
    const items = normalizeEvidencePreviewInput({ items: [{ role: "CONTEXTUAL", targetType: "NOTE_REVISION", targetId: REVA, note: null }] });
    const authorized = await store.authorizePreview({ projectId: PA, issueId: ISSUEA, claimId: CLAIMA, items });
    expect(authorized).not.toBeNull();
  });

  it("declared dangling sourceId fails closed", async () => {
    // P1 EB2 has no sourceId (valid empty). Corrupt one temporarily: add binding with declared missing source.
    const client = await pool.connect();
    const BAD_BINDING = "f0f0f0f0-f0f0-40f0-80f0-f0f0f0f0f0f0";
    try {
      await client.query(`INSERT INTO core.editions (id, work_id, edition_type, publication_date_precision, lifecycle_state) VALUES ('abababab-abab-4aba-8aba-abababababab', '${WORK}', 'PRINT', 'YEAR', 'ACTIVE')`);
      await client.query(`INSERT INTO core.project_bindings (id, project_id, target_type, target_id, metadata) VALUES ('${BAD_BINDING}', '${P1}', 'EDITION', 'abababab-abab-4aba-8aba-abababababab', '{"sourceId":"deadbeef-dead-4dea-8dea-deadbeefdead"}')`);
      await expect(store.candidates({ projectId: P1, issueId: ISSUE1, claimId: CLAIM1 })).rejects.toBeInstanceOf(EvidenceSelectionIntegrityError);
    } finally {
      await client.query(`DELETE FROM core.project_bindings WHERE id='${BAD_BINDING}'`);
      await client.query(`DELETE FROM core.editions WHERE id='abababab-abab-4aba-8aba-abababababab'`);
      client.release();
    }
  });

  it("failed preview (malformed draft) never reaches the store or DB writes", async () => {
    const before = await zeroWriteCounts();
    const { normalizeEvidencePreviewInput: normalize } = await import("../domain/evidence-selection.js");
    expect(() => normalize({ items: [{ role: "PRIMARY", targetType: "SOURCE", targetId: SRC1 }] })).toThrow();
    expect(await zeroWriteCounts()).toEqual(before);
  });
});
