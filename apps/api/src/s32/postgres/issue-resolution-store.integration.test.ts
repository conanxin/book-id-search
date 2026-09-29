import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import {
  IssueResolutionEvidenceNotAvailableError,
  IssueResolutionIdempotencyConflictError,
  IssueResolutionInvalidPreferredClaimError,
  IssueResolutionStaleError,
  type IssueResolutionCreateCommand,
} from "../application/issue-resolutions.js";
import {
  hashIssueResolutionCreateRequest,
  normalizeIssueResolutionCreateInput,
} from "../domain/issue-resolution.js";
import {
  buildEvidenceManifestDraft,
  normalizeEvidencePreviewInput,
} from "../domain/evidence-selection.js";
import { createPostgresIssueResolutionCommandStore } from "./issue-resolution-command-store.js";
import { createPostgresIssueResolutionReadStore } from "./issue-resolution-read-store.js";

const url = process.env.S32_M2E_TEST_DATABASE_URL;
const parsed = url ? new URL(url) : null;
if (parsed && (parsed.hostname !== "127.0.0.1" || parsed.pathname !== "/s32_m2e_test")) {
  throw new Error("M2-E integration requires isolated local s32_m2e_test");
}
const d = url ? describe : describe.skip;

const P1 = "11111111-1111-4111-8111-111111111111";
const I1 = "21111111-1111-4111-8111-111111111111";
const C1 = "31111111-1111-4111-8111-111111111111";
const CX = "32111111-1111-4111-8111-111111111111";
const SRC1 = "61111111-1111-4111-8111-111111111111";

let pool: Pool;
let commandStore: ReturnType<typeof createPostgresIssueResolutionCommandStore>;
let readStore: ReturnType<typeof createPostgresIssueResolutionReadStore>;

async function currentPointer() {
  const { rows } = await pool.query(
    "SELECT current_resolution_id,lifecycle_state,updated_at FROM core.research_issues WHERE id=$1",
    [I1],
  );
  return rows[0] as { current_resolution_id: string | null; lifecycle_state: string; updated_at: Date };
}

async function makeCommand(options: {
  expectedCurrentResolutionId?: string | null;
  idempotencyKey?: string;
  resolutionType?: "PREFERRED_CLAIM" | "INSUFFICIENT_EVIDENCE" | "NO_WORKING_CONCLUSION";
  preferredClaimId?: string | null;
  rationale?: string;
  evidenceManifestId?: string | null;
} = {}): Promise<IssueResolutionCreateCommand> {
  const current = options.expectedCurrentResolutionId === undefined
    ? (await currentPointer()).current_resolution_id
    : options.expectedCurrentResolutionId;
  const resolutionType = options.resolutionType ?? "PREFERRED_CLAIM";
  const preferredClaimId = options.preferredClaimId === undefined
    ? (resolutionType === "PREFERRED_CLAIM" ? C1 : null)
    : options.preferredClaimId;
  const normalized = normalizeIssueResolutionCreateInput({
    expectedCurrentResolutionId: current,
    resolutionType,
    preferredClaimId,
    rationale: options.rationale ?? "Real PostgreSQL supports this working conclusion.",
    evidenceManifestId: options.evidenceManifestId ?? null,
  });
  return {
    projectId: P1,
    issueId: I1,
    resolutionId: randomUUID(),
    idempotencyKey: options.idempotencyKey ?? randomUUID(),
    requestHash: hashIssueResolutionCreateRequest(P1, I1, normalized),
    ...normalized,
  };
}

async function counts() {
  const { rows } = await pool.query(`
    SELECT
      (SELECT count(*)::int FROM core.issue_resolutions) AS resolutions,
      (SELECT count(*)::int FROM ops.idempotency_keys
        WHERE resource_type='ISSUE_RESOLUTION' AND status='COMPLETED') AS completed_receipts
  `);
  return rows[0] as { resolutions: number; completed_receipts: number };
}

async function createVisibleEvidenceBasis() {
  const items = normalizeEvidencePreviewInput({
    items: [{ role: "SUPPORTING", targetType: "SOURCE", targetId: SRC1, note: "M2E real PG evidence" }],
  });
  const draft = buildEvidenceManifestDraft(items);
  const manifestId = randomUUID();
  const itemId = randomUUID();
  const assessmentId = randomUUID();
  await pool.query(
    `INSERT INTO core.evidence_manifests
       (id,schema_version,purpose,manifest_sha256,metadata)
     VALUES ($1,1,'CLAIM_ASSESSMENT',$2,'{}'::jsonb)`,
    [manifestId, draft.manifestSha256],
  );
  await pool.query(
    `INSERT INTO core.evidence_manifest_items
       (id,manifest_id,ordinal,role,target_type,target_id,locator_type,locator,excerpt,note)
     VALUES ($1,$2,1,'SUPPORTING','SOURCE',$3,NULL,NULL,NULL,$4)`,
    [itemId, manifestId, SRC1, items[0].note],
  );
  await pool.query(
    `INSERT INTO core.assessments
       (id,claim_id,stance,confidence_level,evidence_manifest_id,reasoning,metadata)
     VALUES ($1,$2,'SUPPORTS','HIGH',$3,'M2E visible basis','{}'::jsonb)`,
    [assessmentId, C1, manifestId],
  );
  return { assessmentId, manifestId };
}

d("M2-E issue resolution stores on real PostgreSQL 16", () => {
  beforeAll(() => {
    pool = new Pool({ connectionString: url });
    commandStore = createPostgresIssueResolutionCommandStore(pool);
    readStore = createPostgresIssueResolutionReadStore(pool);
  });
  afterAll(async () => { await pool.end(); });

  it("creates atomically, preserves OPEN lifecycle, advances pointer and completed receipt", async () => {
    const before = await counts();
    const beforeIssue = await currentPointer();
    const command = await makeCommand();
    const result = await commandStore.create(command);
    expect(result).toEqual({ status: "created", resolutionId: command.resolutionId });

    const after = await counts();
    expect(after).toEqual({
      resolutions: before.resolutions + 1,
      completed_receipts: before.completed_receipts + 1,
    });
    const issue = await currentPointer();
    expect(issue.current_resolution_id).toBe(command.resolutionId);
    expect(issue.lifecycle_state).toBe("OPEN");
    expect(issue.updated_at.getTime()).toBeGreaterThan(beforeIssue.updated_at.getTime());
  });

  it("moves the authoritative pointer while retaining prior history", async () => {
    const first = await makeCommand({ resolutionType: "INSUFFICIENT_EVIDENCE", preferredClaimId: null, rationale: "First conclusion." });
    await commandStore.create(first);
    const second = await makeCommand({ resolutionType: "NO_WORKING_CONCLUSION", preferredClaimId: null, rationale: "Second conclusion." });
    await commandStore.create(second);

    const page = await readStore.list({ projectId: P1, issueId: I1, limit: 20, cursor: null });
    expect(page.kind).toBe("ok");
    if (page.kind !== "ok") throw new Error("expected visible history");
    expect(page.value.issue.currentResolutionId).toBe(second.resolutionId);
    expect(page.value.currentResolution?.id).toBe(second.resolutionId);
    expect(page.value.resolutions.some(row => row.id === first.resolutionId && !row.isCurrent)).toBe(true);
    expect(page.value.resolutions.some(row => row.id === second.resolutionId && row.isCurrent)).toBe(true);
  });

  it("stale CAS loses with no durable Resolution or receipt", async () => {
    const before = await counts();
    const command = await makeCommand({ expectedCurrentResolutionId: randomUUID() });
    await expect(commandStore.create(command)).rejects.toBeInstanceOf(IssueResolutionStaleError);
    expect(await counts()).toEqual(before);
  });

  it("same key and same command concurrently yields one create and one replay", async () => {
    const command = await makeCommand();
    const before = await counts();
    const results = await Promise.all([commandStore.create(command), commandStore.create(command)]);
    expect(results.map(value => value.status).sort()).toEqual(["created", "replayed"]);
    const after = await counts();
    expect(after.resolutions).toBe(before.resolutions + 1);
    expect(after.completed_receipts).toBe(before.completed_receipts + 1);
  });

  it("same key with a changed command conflicts without a new Resolution", async () => {
    const key = randomUUID();
    const first = await makeCommand({ idempotencyKey: key, rationale: "Original intent." });
    await commandStore.create(first);
    const before = await counts();
    const changed = await makeCommand({
      idempotencyKey: key,
      expectedCurrentResolutionId: first.expectedCurrentResolutionId,
      rationale: "Changed intent.",
    });
    await expect(commandStore.create(changed)).rejects.toBeInstanceOf(IssueResolutionIdempotencyConflictError);
    expect(await counts()).toEqual(before);
  });

  it("rejects a preferred Claim owned by a different Issue with zero durable writes", async () => {
    const before = await counts();
    const command = await makeCommand({ preferredClaimId: CX });
    await expect(commandStore.create(command)).rejects.toBeInstanceOf(IssueResolutionInvalidPreferredClaimError);
    expect(await counts()).toEqual(before);
  });

  it("accepts one visible Assessment Manifest as evidence and exposes it through reads", async () => {
    const basis = await createVisibleEvidenceBasis();
    const evidencePage = await readStore.listEvidenceBases({
      projectId: P1, issueId: I1, limit: 20, cursor: null,
    });
    expect(evidencePage.kind).toBe("ok");
    if (evidencePage.kind !== "ok") throw new Error("expected evidence bases");
    expect(evidencePage.value.issueId).toBe(I1);
    expect(evidencePage.value.evidenceBases.some(row =>
      row.assessmentId === basis.assessmentId && row.manifestId === basis.manifestId
    )).toBe(true);

    const command = await makeCommand({ evidenceManifestId: basis.manifestId });
    await commandStore.create(command);
    const detail = await readStore.get({
      projectId: P1, issueId: I1, resolutionId: command.resolutionId,
    });
    expect(detail.kind).toBe("ok");
    if (detail.kind !== "ok") throw new Error("expected resolution detail");
    expect(detail.value.evidenceBasisAvailable).toBe(true);
    expect(detail.value.evidenceManifest?.id).toBe(basis.manifestId);
  });

  it("rejects a Manifest whose Assessment Claim is not a member of this Issue", async () => {
    const items = normalizeEvidencePreviewInput({
      items: [{ role: "SUPPORTING", targetType: "SOURCE", targetId: SRC1, note: null }],
    });
    const draft = buildEvidenceManifestDraft(items);
    const manifestId = randomUUID();
    await pool.query(
      "INSERT INTO core.evidence_manifests (id,schema_version,purpose,manifest_sha256,metadata) VALUES ($1,1,'CLAIM_ASSESSMENT',$2,'{}'::jsonb)",
      [manifestId, draft.manifestSha256],
    );
    await pool.query(
      "INSERT INTO core.evidence_manifest_items (id,manifest_id,ordinal,role,target_type,target_id) VALUES ($1,$2,1,'SUPPORTING','SOURCE',$3)",
      [randomUUID(), manifestId, SRC1],
    );
    await pool.query(
      "INSERT INTO core.assessments (id,claim_id,stance,evidence_manifest_id,metadata) VALUES ($1,$2,'SUPPORTS',$3,'{}'::jsonb)",
      [randomUUID(), CX, manifestId],
    );
    const before = await counts();
    const command = await makeCommand({ evidenceManifestId: manifestId });
    await expect(commandStore.create(command)).rejects.toBeInstanceOf(IssueResolutionEvidenceNotAvailableError);
    expect(await counts()).toEqual(before);
  });

  it("fresh 002 triggers reject Resolution UPDATE and DELETE", async () => {
    const command = await makeCommand();
    await commandStore.create(command);
    await expect(pool.query(
      "UPDATE core.issue_resolutions SET rationale=rationale WHERE id=$1",
      [command.resolutionId],
    )).rejects.toThrow(/S32_M2E_ISSUE_RESOLUTION_IMMUTABLE/);
    await expect(pool.query(
      "DELETE FROM core.issue_resolutions WHERE id=$1",
      [command.resolutionId],
    )).rejects.toThrow(/S32_M2E_ISSUE_RESOLUTION_IMMUTABLE/);
  });
});
