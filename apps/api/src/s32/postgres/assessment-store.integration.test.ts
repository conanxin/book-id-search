import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import {
  AssessmentEvidenceTargetNotAvailableError,
  AssessmentIdempotencyConflictError,
  AssessmentIntegrityError,
  EvidencePreviewStaleError,
  type AssessmentCreateCommand,
} from "../application/assessments.js";
import {
  hashAssessmentCreateRequest,
  normalizeAssessmentCreateInput,
} from "../domain/assessment.js";
import {
  buildEvidenceManifestDraft,
  normalizeEvidencePreviewInput,
  type EvidenceDraftInputItem,
} from "../domain/evidence-selection.js";
import { createPostgresAssessmentCommandStore } from "./assessment-command-store.js";
import { createPostgresAssessmentReadStore } from "./assessment-read-store.js";

const url = process.env.S32_M2D_TEST_DATABASE_URL;
const parsed = url ? new URL(url) : null;
if (parsed && (parsed.hostname !== "127.0.0.1" || parsed.pathname !== "/s32_m2d_test")) {
  throw new Error("M2-D integration requires isolated local s32_m2d_test");
}

const d = url ? describe : describe.skip;

const P1 = "11111111-1111-4111-8111-111111111111";
const I1 = "21111111-1111-4111-8111-111111111111";
const C1 = "31111111-1111-4111-8111-111111111111";
const CPAGE = "31311111-1111-4111-8111-111111111111";
const SRC1 = "61111111-1111-4111-8111-111111111111";
const SRCX = "62111111-1111-4111-8111-111111111111";
const EB1 = "81111111-1111-4111-8111-111111111111";
const NOTE1 = "91111111-1111-4111-8111-111111111111";
const REV1 = "a1111111-1111-4111-8111-111111111111";
const ACTOR = "f1111111-1111-4111-8111-111111111111";

let pool: Pool;
let commandStore: ReturnType<typeof createPostgresAssessmentCommandStore>;
let readStore: ReturnType<typeof createPostgresAssessmentReadStore>;

function canonicalItems(raw: Array<{
  role: "SUPPORTING" | "CONTRADICTORY" | "CONTEXTUAL";
  targetType: "SOURCE" | "SOURCE_ASSET" | "NOTE_REVISION";
  targetId: string;
  note: string | null;
}>): EvidenceDraftInputItem[] {
  return normalizeEvidencePreviewInput({ items: raw });
}

function makeCommand(options: {
  claimId?: string;
  idempotencyKey?: string;
  reasoning?: string;
  expectedManifestSha256?: string;
  items?: EvidenceDraftInputItem[];
} = {}): AssessmentCreateCommand {
  const claimId = options.claimId ?? C1;
  const items = options.items ?? canonicalItems([
    { role: "SUPPORTING", targetType: "SOURCE", targetId: SRC1, note: "source support" },
    { role: "CONTEXTUAL", targetType: "NOTE_REVISION", targetId: REV1, note: "older note context" },
  ]);
  const expectedManifestSha256 = options.expectedManifestSha256
    ?? buildEvidenceManifestDraft(items).manifestSha256;
  const normalized = normalizeAssessmentCreateInput({
    stance: "SUPPORTS",
    confidenceLevel: "HIGH",
    reasoning: options.reasoning ?? "Real PostgreSQL evidence supports this assessment.",
    expectedManifestSha256,
    items,
  });
  return {
    projectId: P1,
    issueId: I1,
    claimId,
    assessmentId: randomUUID(),
    manifestId: randomUUID(),
    manifestItemIds: normalized.items.map(() => randomUUID()),
    idempotencyKey: options.idempotencyKey ?? randomUUID(),
    requestHash: hashAssessmentCreateRequest(P1, I1, claimId, normalized),
    ...normalized,
  };
}

async function counts() {
  const { rows } = await pool.query(`
    SELECT
      (SELECT count(*)::int FROM core.evidence_manifests) AS manifests,
      (SELECT count(*)::int FROM core.evidence_manifest_items) AS manifest_items,
      (SELECT count(*)::int FROM core.assessments) AS assessments,
      (SELECT count(*)::int FROM ops.idempotency_keys WHERE status='COMPLETED') AS completed_receipts
  `);
  return rows[0] as {
    manifests: number;
    manifest_items: number;
    assessments: number;
    completed_receipts: number;
  };
}

async function insertSchemaCompatibleAssessment(options: {
  claimId?: string;
  actorId?: string | null;
  numericScore?: number | null;
  scoreKind?: string | null;
  reasoning?: string | null;
  createdAtSql?: string;
} = {}) {
  const claimId = options.claimId ?? C1;
  const items = canonicalItems([
    { role: "SUPPORTING", targetType: "SOURCE", targetId: SRC1, note: null },
  ]);
  const draft = buildEvidenceManifestDraft(items);
  const manifestId = randomUUID();
  const assessmentId = randomUUID();
  const itemId = randomUUID();
  await pool.query(
    `INSERT INTO core.evidence_manifests
       (id,schema_version,purpose,manifest_sha256,metadata)
     VALUES ($1,1,'CLAIM_ASSESSMENT',$2,'{}'::jsonb)`,
    [manifestId, draft.manifestSha256],
  );
  await pool.query(
    `INSERT INTO core.evidence_manifest_items
       (id,manifest_id,ordinal,role,target_type,target_id,locator_type,locator,excerpt,note)
     VALUES ($1,$2,1,'SUPPORTING','SOURCE',$3,NULL,NULL,NULL,NULL)`,
    [itemId, manifestId, SRC1],
  );
  const createdAt = options.createdAtSql ?? "now()";
  await pool.query(
    `INSERT INTO core.assessments
       (id,claim_id,actor_id,stance,confidence_level,numeric_score,score_kind,evidence_manifest_id,reasoning,metadata,created_at)
     VALUES ($1,$2,$3,'SUPPORTS','HIGH',$4,$5,$6,$7,'{}'::jsonb,${createdAt})`,
    [
      assessmentId,
      claimId,
      options.actorId ?? null,
      options.numericScore ?? null,
      options.scoreKind ?? null,
      manifestId,
      options.reasoning === undefined ? "schema-compatible reasoning" : options.reasoning,
    ],
  );
  return { assessmentId, manifestId, itemId, manifestSha256: draft.manifestSha256 };
}

d("M2-D assessment stores on real PostgreSQL 16", () => {
  beforeAll(() => {
    pool = new Pool({ connectionString: url });
    commandStore = createPostgresAssessmentCommandStore(pool);
    readStore = createPostgresAssessmentReadStore(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("atomically creates Manifest + items + Assessment + completed receipt and reads the old Note revision", async () => {
    const before = await counts();
    const command = makeCommand();
    const result = await commandStore.create(command);
    expect(result.status).toBe("created");
    if (result.status !== "created") throw new Error("expected created result");
    expect(result.assessment.id).toBe(command.assessmentId);
    expect(result.evidenceManifest.id).toBe(command.manifestId);
    expect(result.evidenceManifest.manifestSha256).toBe(command.expectedManifestSha256);

    const after = await counts();
    expect(after).toEqual({
      manifests: before.manifests + 1,
      manifest_items: before.manifest_items + command.items.length,
      assessments: before.assessments + 1,
      completed_receipts: before.completed_receipts + 1,
    });

    const detail = await readStore.get({
      projectId: P1,
      issueId: I1,
      claimId: C1,
      assessmentId: command.assessmentId,
    });
    expect(detail.kind).toBe("ok");
    if (detail.kind !== "ok") throw new Error("expected visible detail");
    expect(detail.value.evidenceManifest.manifestSha256).toBe(command.expectedManifestSha256);
    expect(detail.value.evidenceManifest.items.map(item => item.targetId))
      .toEqual([SRC1, REV1]);
  });

  it("stale preview rolls back receipt, Manifest, items, and Assessment", async () => {
    const before = await counts();
    const command = makeCommand({ expectedManifestSha256: "f".repeat(64) });
    await expect(commandStore.create(command)).rejects.toBeInstanceOf(EvidencePreviewStaleError);
    expect(await counts()).toEqual(before);
  });

  it("cross-Project evidence returns safe target-unavailable and leaves zero durable writes", async () => {
    const before = await counts();
    const foreign = canonicalItems([
      { role: "SUPPORTING", targetType: "SOURCE", targetId: SRCX, note: null },
    ]);
    const command = makeCommand({ items: foreign });
    await expect(commandStore.create(command))
      .rejects.toBeInstanceOf(AssessmentEvidenceTargetNotAvailableError);
    expect(await counts()).toEqual(before);
  });

  it("current Project graph corruption fails closed and rolls back all command writes", async () => {
    const before = await counts();
    try {
      await pool.query(
        `UPDATE core.project_bindings SET metadata=$1::jsonb WHERE id=$2`,
        [JSON.stringify({ sourceId: "not-a-uuid" }), EB1],
      );
      await expect(commandStore.create(makeCommand())).rejects.toBeInstanceOf(AssessmentIntegrityError);
      expect(await counts()).toEqual(before);
    } finally {
      await pool.query(
        `UPDATE core.project_bindings SET metadata=$1::jsonb WHERE id=$2`,
        [JSON.stringify({ sourceId: SRC1 }), EB1],
      );
    }
  });

  it("same key/same command replays exact IDs with no new rows", async () => {
    const command = makeCommand();
    const first = await commandStore.create(command);
    expect(first.status).toBe("created");
    const beforeReplay = await counts();
    const second = await commandStore.create(command);
    expect(second).toEqual({ status: "replayed", assessmentId: command.assessmentId });
    expect(await counts()).toEqual(beforeReplay);
  });

  it("same key/different command conflicts without new rows", async () => {
    const key = randomUUID();
    const first = makeCommand({ idempotencyKey: key });
    await commandStore.create(first);
    const beforeConflict = await counts();
    const changed = makeCommand({
      idempotencyKey: key,
      reasoning: "Changed intent must not reuse the receipt.",
    });
    await expect(commandStore.create(changed)).rejects.toBeInstanceOf(AssessmentIdempotencyConflictError);
    expect(await counts()).toEqual(beforeConflict);
  });

  it("two concurrent identical commands create one durable Assessment and one replay", async () => {
    const command = makeCommand();
    const before = await counts();
    const results = await Promise.all([
      commandStore.create(command),
      commandStore.create(command),
    ]);
    expect(results.map(result => result.status).sort()).toEqual(["created", "replayed"]);
    const after = await counts();
    expect(after.assessments).toBe(before.assessments + 1);
    expect(after.manifests).toBe(before.manifests + 1);
    expect(after.manifest_items).toBe(before.manifest_items + command.items.length);
    expect(after.completed_receipts).toBe(before.completed_receipts + 1);
  });

  it("archived Source and Note remain visible for a frozen historical Assessment", async () => {
    const command = makeCommand();
    await commandStore.create(command);
    try {
      await pool.query("UPDATE core.sources SET lifecycle_state='ARCHIVED' WHERE id=$1", [SRC1]);
      await pool.query("UPDATE core.notes SET lifecycle_state='ARCHIVED' WHERE id=$1", [NOTE1]);
      const detail = await readStore.get({
        projectId: P1,
        issueId: I1,
        claimId: C1,
        assessmentId: command.assessmentId,
      });
      expect(detail.kind).toBe("ok");
    } finally {
      await pool.query("UPDATE core.sources SET lifecycle_state='ACTIVE' WHERE id=$1", [SRC1]);
      await pool.query("UPDATE core.notes SET lifecycle_state='ACTIVE' WHERE id=$1", [NOTE1]);
    }
  });

  it("removing the current Project edition binding hides the whole Assessment without deleting it", async () => {
    const command = makeCommand({
      items: canonicalItems([
        { role: "SUPPORTING", targetType: "SOURCE", targetId: SRC1, note: null },
      ]),
    });
    await commandStore.create(command);
    try {
      await pool.query("DELETE FROM core.project_bindings WHERE id=$1", [EB1]);
      const hidden = await readStore.get({
        projectId: P1,
        issueId: I1,
        claimId: C1,
        assessmentId: command.assessmentId,
      });
      expect(hidden).toEqual({ kind: "not-visible" });
    } finally {
      await pool.query(
        `INSERT INTO core.project_bindings
           (id,project_id,target_type,target_id,binding_role,metadata)
         VALUES ($1,$2,'EDITION',$3,NULL,$4::jsonb)`,
        [
          EB1,
          P1,
          "51111111-1111-4111-8111-111111111111",
          JSON.stringify({ sourceId: SRC1 }),
        ],
      );
    }
  });

  it("reads a schema-valid Actor/score Assessment with null reasoning when its Manifest is visible", async () => {
    const row = await insertSchemaCompatibleAssessment({
      actorId: ACTOR,
      numericScore: 0.82,
      scoreKind: "CALIBRATED_PROBABILITY",
      reasoning: null,
    });
    const detail = await readStore.get({
      projectId: P1,
      issueId: I1,
      claimId: C1,
      assessmentId: row.assessmentId,
    });
    expect(detail.kind).toBe("ok");
    if (detail.kind !== "ok") throw new Error("expected compatible detail");
    expect(detail.value.assessment).toMatchObject({
      actorId: ACTOR,
      numericScore: 0.82,
      scoreKind: "CALIBRATED_PROBABILITY",
      reasoning: null,
    });
  });

  it("treats manifestless Assessment as schema-valid but invisible in the Project-routed API", async () => {
    const assessmentId = randomUUID();
    await pool.query(
      `INSERT INTO core.assessments
         (id,claim_id,stance,confidence_level,evidence_manifest_id,reasoning,metadata)
       VALUES ($1,$2,'INCONCLUSIVE',NULL,NULL,NULL,'{}'::jsonb)`,
      [assessmentId, C1],
    );
    const detail = await readStore.get({
      projectId: P1,
      issueId: I1,
      claimId: C1,
      assessmentId,
    });
    expect(detail).toEqual({ kind: "not-visible" });
  });

  it("filters hidden newest rows before limit and returns 20 visible rows with no false next page", async () => {
    for (let index = 0; index < 20; index += 1) {
      await commandStore.create(makeCommand({
        claimId: CPAGE,
        reasoning: `visible page row ${index}`,
        items: canonicalItems([
          { role: "SUPPORTING", targetType: "SOURCE", targetId: SRC1, note: null },
        ]),
      }));
    }
    for (let index = 0; index < 15; index += 1) {
      await pool.query(
        `INSERT INTO core.assessments
           (id,claim_id,stance,confidence_level,evidence_manifest_id,reasoning,metadata,created_at)
         VALUES ($1,$2,'INCONCLUSIVE',NULL,NULL,NULL,'{}'::jsonb,now()+interval '1 day'+($3::int * interval '1 second'))`,
        [randomUUID(), CPAGE, index],
      );
    }

    const page = await readStore.list({
      projectId: P1,
      issueId: I1,
      claimId: CPAGE,
      limit: 20,
      cursor: null,
    });
    expect(page.kind).toBe("ok");
    if (page.kind !== "ok") throw new Error("expected page");
    expect(page.value.assessments).toHaveLength(20);
    expect(page.value.nextCursor).toBeNull();
  });

  it("fresh frozen triggers reject Assessment, Manifest, and ManifestItem UPDATE/DELETE", async () => {
    const command = makeCommand();
    const result = await commandStore.create(command);
    expect(result.status).toBe("created");

    await expect(pool.query("UPDATE core.assessments SET reasoning=reasoning WHERE id=$1", [command.assessmentId]))
      .rejects.toThrow(/ASSESSMENT_APPEND_ONLY/);
    await expect(pool.query("DELETE FROM core.assessments WHERE id=$1", [command.assessmentId]))
      .rejects.toThrow(/ASSESSMENT_APPEND_ONLY/);
    await expect(pool.query("UPDATE core.evidence_manifests SET metadata=metadata WHERE id=$1", [command.manifestId]))
      .rejects.toThrow(/MANIFEST_IMMUTABLE/);
    await expect(pool.query("DELETE FROM core.evidence_manifests WHERE id=$1", [command.manifestId]))
      .rejects.toThrow(/MANIFEST_IMMUTABLE/);
    await expect(pool.query("UPDATE core.evidence_manifest_items SET note=note WHERE id=$1", [command.manifestItemIds[0]]))
      .rejects.toThrow(/MANIFEST_IMMUTABLE/);
    await expect(pool.query("DELETE FROM core.evidence_manifest_items WHERE id=$1", [command.manifestItemIds[0]]))
      .rejects.toThrow(/MANIFEST_IMMUTABLE/);
  });
});
