import { expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import {
  AssessmentIdempotencyConflictError,
  AssessmentIntegrityError,
  AssessmentStoreUnavailableError,
  EvidencePreviewStaleError,
  ProjectReadOnlyForAssessmentError,
  ResearchIssueReadOnlyForAssessmentError,
  type AssessmentCreateCommand,
} from "../application/assessments.js";
import { buildEvidenceManifestDraft } from "../domain/evidence-selection.js";
import { hashAssessmentCreateRequest } from "../domain/assessment.js";
import { createPostgresAssessmentCommandStore } from "./assessment-command-store.js";

const P = "11111111-1111-4111-8111-111111111111";
const I = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const A = "44444444-4444-4444-8444-444444444444";
const M = "55555555-5555-4555-8555-555555555555";
const MI = "66666666-6666-4666-8666-666666666666";
const KEY = "77777777-7777-4777-8777-777777777777";
const RECEIPT = "88888888-8888-4888-8888-888888888888";
const BINDING = "99999999-9999-4999-8999-999999999999";
const EDITION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SOURCE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
// A different Assessment on the same Claim: exists, visible, but NOT the
// product of COMMAND. A corrupted COMPLETED receipt pointing here must fail
// closed instead of replaying the wrong historical Assessment.
const OTHER = "c0000000-0000-4000-8000-00000000000c";
const OTHER_MANIFEST = "d0000000-0000-4000-8000-00000000000d";

const items = [{
  role: "SUPPORTING" as const,
  targetType: "SOURCE" as const,
  targetId: SOURCE,
  note: null,
}];
const manifestHash = buildEvidenceManifestDraft(items).manifestSha256;
// The command carries a real request hash so the replay path's end-to-end
// reconstruction (persisted resource -> hash) can match it.
const REQUEST_HASH = hashAssessmentCreateRequest(P, I, C, {
  stance: "SUPPORTS",
  confidenceLevel: null,
  reasoning: "当前证据支持。",
  expectedManifestSha256: manifestHash,
  items,
});

const COMMAND: AssessmentCreateCommand = {
  projectId: P,
  issueId: I,
  claimId: C,
  assessmentId: A,
  manifestId: M,
  manifestItemIds: [MI],
  idempotencyKey: KEY,
  requestHash: REQUEST_HASH,
  stance: "SUPPORTS",
  confidenceLevel: null,
  reasoning: "当前证据支持。",
  expectedManifestSha256: manifestHash,
  items,
};

function scopeRow(projectState = "ACTIVE", issueState = "OPEN") {
  return {
    project_id: P,
    project_name: "Project",
    project_state: projectState,
    issue_id: I,
    issue_title: "Question",
    issue_question: "When?",
    issue_state: issueState,
    issue_binding_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    owner_project_id: P,
    issue_binding_role: null,
    issue_binding_metadata: {},
    relation_claim_id: C,
    claim_statement: "Candidate",
    claim_state: "ACTIVE",
    claim_type: null,
    subject_type: null,
    subject_id: null,
    claim_metadata: {},
    claim_created_at: new Date("2026-01-01T00:00:00Z"),
    claim_updated_at: new Date("2026-01-01T00:00:00Z"),
  };
}

function materialRow() {
  return {
    binding_id: BINDING,
    binding_created_at: new Date("2026-01-01T00:00:00Z"),
    binding_metadata: { sourceId: SOURCE },
    edition_id: EDITION,
    work_title: "Book",
    source_id: SOURCE,
    source_type: "DATABASE_RECORD",
    source_lifecycle: "ACTIVE",
    source_edition_id: EDITION,
    source_observed_at: new Date("2026-01-01T00:00:00Z"),
    asset_id: null,
    asset_type: null,
    asset_role: null,
    asset_storage_mode: null,
    asset_created_at: null,
    note_binding_id: null,
    note_binding_role: null,
    note_binding_metadata: null,
    note_id: null,
    note_type: null,
    note_lifecycle: null,
    note_current_revision_id: null,
    revision_id: null,
    revision_no: null,
    revision_content_format: null,
    revision_created_at: null,
  };
}

function readbackAssessment() {
  return {
    assessment_id: A,
    claim_id: C,
    actor_id: null,
    stance: "SUPPORTS",
    confidence_level: null,
    numeric_score: null,
    score_kind: null,
    evidence_manifest_id: M,
    reasoning: "当前证据支持。",
    assessment_metadata: {},
    assessment_created_at: new Date("2026-09-21T00:00:00Z"),
    manifest_id: M,
    schema_version: 1,
    purpose: "CLAIM_ASSESSMENT",
    manifest_sha256: manifestHash,
    manifest_metadata: {},
    manifest_created_at: new Date("2026-09-21T00:00:00Z"),
  };
}

function readbackItem() {
  return {
    item_id: MI,
    manifest_id: M,
    ordinal: 1,
    role: "SUPPORTING",
    target_type: "SOURCE",
    target_id: SOURCE,
    locator_type: null,
    locator: null,
    excerpt: null,
    note: null,
    created_at: new Date("2026-09-21T00:00:00Z"),
  };
}

type Options = {
  projectState?: string;
  issueState?: string;
  existingReceipt?: null | {
    request_hash: string;
    status: string;
    resource_type: string | null;
    resource_id: string | null;
    result_payload?: unknown;
  };
  firstSerializableError?: "40001" | "40P01";
  /** Overrides for the Assessment row the receipt's resource_id points at. */
  replayAssessmentOverrides?: Record<string, unknown>;
  /** Overrides for the ManifestItem rows loaded during replay verification. */
  replayItemOverrides?: Array<Record<string, unknown>>;
};

function fakePool(options: Options = {}) {
  const sql: string[] = [];
  let attempt = 0;
  const query = vi.fn(async (text: string, params?: unknown[]) => {
    sql.push(text);
    if (text.startsWith("BEGIN ISOLATION LEVEL SERIALIZABLE")) {
      attempt += 1;
      return { rows: [] };
    }
    if (text.startsWith("INSERT INTO ops.idempotency_keys")) {
      if (options.firstSerializableError && attempt === 1) {
        const error = Object.assign(new Error("serialization"), { code: options.firstSerializableError });
        throw error;
      }
      return { rows: options.existingReceipt ? [] : [{ id: RECEIPT }] };
    }
    if (text.includes("FROM ops.idempotency_keys") && text.includes("FOR UPDATE")) {
      return { rows: options.existingReceipt ? [{ id: RECEIPT, ...options.existingReceipt }] : [] };
    }
    if (text === "SELECT id FROM core.projects WHERE id=$1 FOR UPDATE") return { rows: [{ id: P }] };
    if (text === "SELECT id FROM core.research_issues WHERE id=$1 FOR UPDATE") return { rows: [{ id: I }] };
    if (text.startsWith("SELECT issue_id,claim_id FROM core.research_issue_claims")) return { rows: [{ issue_id: I, claim_id: C }] };
    if (text === "SELECT id FROM core.claims WHERE id=$1 FOR UPDATE") return { rows: [{ id: C }] };
    if (text.includes("FROM core.projects p")) {
      return { rows: [scopeRow(options.projectState, options.issueState)] };
    }
    if (text.includes("LEFT JOIN core.source_assets")) return { rows: [materialRow()] };
    if (text.includes("FROM core.note_revisions nr") && text.includes("ANY(")) return { rows: [] };
    if (text.startsWith("INSERT INTO core.evidence_manifests")) return { rows: [] };
    if (text.startsWith("INSERT INTO core.evidence_manifest_items")) return { rows: [] };
    if (text.startsWith("INSERT INTO core.assessments")) return { rows: [] };
    if (text.includes("FROM core.assessments a") && text.includes("JOIN core.evidence_manifests")) {
      // Readback of an Assessment joined with its Manifest. Serves both the
      // created path (after INSERTs) and the replay verification path.
      return { rows: [{ ...readbackAssessment(), ...(options.replayAssessmentOverrides ?? {}) }] };
    }
    if (text.includes("FROM core.evidence_manifest_items") && text.includes("ORDER BY ordinal")) {
      if (options.replayItemOverrides) {
        return { rows: options.replayItemOverrides.map(row => ({ ...readbackItem(), ...row })) };
      }
      return { rows: [readbackItem()] };
    }
    if (text.startsWith("UPDATE ops.idempotency_keys")) return { rows: [] };
    if (text === "COMMIT" || text === "ROLLBACK") return { rows: [] };
    throw new Error(`Unexpected SQL: ${text} :: ${JSON.stringify(params)}`);
  });
  const client = { query, release: vi.fn() } as unknown as PoolClient;
  const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
  return { pool, query, sql, get attempts() { return attempt; } };
}

it("creates Manifest + item + Assessment, reads them back, then completes the receipt", async () => {
  const fx = fakePool();
  const result = await createPostgresAssessmentCommandStore(fx.pool).create(COMMAND);
  expect(result).toEqual({
    status: "created",
    assessment: expect.objectContaining({ id: A, claimId: C, stance: "SUPPORTS" }),
    evidenceManifest: {
      id: M,
      schemaVersion: 1,
      purpose: "CLAIM_ASSESSMENT",
      manifestSha256: manifestHash,
      itemCount: 1,
    },
  });
  expect(fx.sql[0]).toBe("BEGIN ISOLATION LEVEL SERIALIZABLE");
  expect(fx.sql.findIndex(x => x.startsWith("INSERT INTO core.evidence_manifests")))
    .toBeLessThan(fx.sql.findIndex(x => x.startsWith("INSERT INTO core.assessments")));
  expect(fx.sql.findIndex(x => x.includes("JOIN core.evidence_manifests")))
    .toBeLessThan(fx.sql.findIndex(x => x.startsWith("UPDATE ops.idempotency_keys")));
});

it("returns the original assessmentId from a completed receipt before lifecycle gates", async () => {
  const fx = fakePool({
    projectState: "ARCHIVED",
    existingReceipt: {
      request_hash: COMMAND.requestHash,
      status: "COMPLETED",
      resource_type: "ASSESSMENT",
      resource_id: A,
      result_payload: { assessmentId: A, manifestId: M },
    },
  });
  const result = await createPostgresAssessmentCommandStore(fx.pool).create(COMMAND);
  expect(result).toEqual({ status: "replayed", assessmentId: A });
  expect(fx.sql.some(x => x.includes("FROM core.projects p"))).toBe(false);
  expect(fx.sql.some(x => x.startsWith("INSERT INTO core.assessments"))).toBe(false);
});

it("rejects same key with a different request hash", async () => {
  const fx = fakePool({
    existingReceipt: {
      request_hash: "d".repeat(64),
      status: "COMPLETED",
      resource_type: "ASSESSMENT",
      resource_id: A,
      result_payload: { assessmentId: A, manifestId: M },
    },
  });
  await expect(createPostgresAssessmentCommandStore(fx.pool).create(COMMAND))
    .rejects.toBeInstanceOf(AssessmentIdempotencyConflictError);
});

const replayTamperCases: Array<[string, {
  resource_id: string;
  result_payload: unknown;
  replayAssessmentOverrides: Record<string, unknown>;
  replayItemOverrides?: Array<Record<string, unknown>>;
  requestHashOverride?: string;
  /** When set, COMMAND.requestHash is overridden too so the entry check passes. */
  requestHashAlsoOnCommand?: boolean;
}]> = [
  ["a completed receipt whose resource_id points at a different same-Claim Assessment", {
    resource_id: OTHER,
    result_payload: { assessmentId: OTHER, manifestId: M },
    replayAssessmentOverrides: {
      assessment_id: OTHER,
      stance: "CONTRADICTS",
      confidence_level: "LOW",
      reasoning: "A different historical judgment, not this command's product.",
      manifest_id: OTHER_MANIFEST,
      evidence_manifest_id: OTHER_MANIFEST,
      manifest_sha256: "1".repeat(64),
    },
  }],
  ["a completed receipt whose minimal result_payload IDs disagree with the receipt resource", {
    resource_id: A,
    result_payload: { assessmentId: A, manifestId: OTHER_MANIFEST },
    replayAssessmentOverrides: {},
  }],
  ["a completed receipt with a malformed result_payload shape", {
    resource_id: A,
    result_payload: { assessmentId: A },
    replayAssessmentOverrides: {},
  }],
  ["a completed receipt with a non-object result_payload", {
    resource_id: A,
    result_payload: "corrupted",
    replayAssessmentOverrides: {},
  }],
  ["a completed receipt whose referenced Assessment content diverges from the command", {
    resource_id: A,
    result_payload: { assessmentId: A, manifestId: M },
    replayAssessmentOverrides: {
      stance: "CONTRADICTS",
    },
  }],
  ["a completed receipt whose referenced Assessment was written for a different manifest hash", {
    resource_id: A,
    result_payload: { assessmentId: A, manifestId: M },
    replayAssessmentOverrides: {
      manifest_sha256: "2".repeat(64),
    },
  }],
  ["a completed receipt whose referenced Assessment manifest items diverge from the command", {
    resource_id: A,
    result_payload: { assessmentId: A, manifestId: M },
    replayAssessmentOverrides: {},
    replayItemOverrides: [{ note: "tampered item note" }],
  }],
  ["a completed receipt whose stored request hash was corrupted", {
    // request_hash still matches the retry's command hash at the entry check,
    // but the persisted resource is NOT what that hash was computed from:
    // the reconstruction (resource -> hash) must diverge and fail closed.
    resource_id: A,
    result_payload: { assessmentId: A, manifestId: M },
    replayAssessmentOverrides: {},
    requestHashOverride: "e".repeat(64),
    requestHashAlsoOnCommand: true,
  }],
];

for (const [label, overrides] of replayTamperCases) {
  it(`fails closed on ${label}`, async () => {
    const command = overrides.requestHashAlsoOnCommand
      ? { ...COMMAND, requestHash: overrides.requestHashOverride! }
      : COMMAND;
    const fx = fakePool({
      existingReceipt: {
        request_hash: overrides.requestHashOverride ?? COMMAND.requestHash,
        status: "COMPLETED",
        resource_type: "ASSESSMENT",
        resource_id: overrides.resource_id,
        result_payload: overrides.result_payload,
      },
      replayAssessmentOverrides: overrides.replayAssessmentOverrides,
      replayItemOverrides: overrides.replayItemOverrides,
    });
    await expect(createPostgresAssessmentCommandStore(fx.pool).create(command))
      .rejects.toBeInstanceOf(AssessmentIntegrityError);
    expect(fx.sql.some(x => x.startsWith("INSERT INTO core.assessments"))).toBe(false);
  });
}

it.each([
  ["ARCHIVED", "OPEN", ProjectReadOnlyForAssessmentError],
  ["ACTIVE", "ARCHIVED", ResearchIssueReadOnlyForAssessmentError],
])("rejects new write lifecycle %s/%s", async (projectState, issueState, ErrorType) => {
  const fx = fakePool({ projectState, issueState });
  await expect(createPostgresAssessmentCommandStore(fx.pool).create(COMMAND))
    .rejects.toBeInstanceOf(ErrorType);
});

it("allows RESOLVED issue for a new Assessment", async () => {
  const fx = fakePool({ issueState: "RESOLVED" });
  await expect(createPostgresAssessmentCommandStore(fx.pool).create(COMMAND))
    .resolves.toMatchObject({ status: "created" });
});

it("rejects stale preview before durable domain inserts", async () => {
  const fx = fakePool();
  await expect(createPostgresAssessmentCommandStore(fx.pool).create({
    ...COMMAND,
    expectedManifestSha256: "0".repeat(64),
  })).rejects.toBeInstanceOf(EvidencePreviewStaleError);
  expect(fx.sql.some(x => x.startsWith("INSERT INTO core.evidence_manifests"))).toBe(false);
  expect(fx.sql.at(-1)).toBe("ROLLBACK");
});

it.each(["IN_PROGRESS", "FAILED"])("does not blindly recreate from durable %s receipt", async status => {
  const fx = fakePool({
    existingReceipt: {
      request_hash: COMMAND.requestHash,
      status,
      resource_type: null,
      resource_id: null,
    },
  });
  await expect(createPostgresAssessmentCommandStore(fx.pool).create(COMMAND))
    .rejects.toBeInstanceOf(AssessmentStoreUnavailableError);
  expect(fx.sql.some(x => x.startsWith("INSERT INTO core.assessments"))).toBe(false);
});

it.each(["40001", "40P01"] as const)("retries %s and reuses the command's stable IDs", async code => {
  const fx = fakePool({ firstSerializableError: code });
  const result = await createPostgresAssessmentCommandStore(fx.pool).create(COMMAND);
  expect(result.status).toBe("created");
  expect(fx.attempts).toBe(2);
  const manifestCalls = fx.query.mock.calls.filter(([text]) =>
    String(text).startsWith("INSERT INTO core.evidence_manifests"));
  expect(manifestCalls).toHaveLength(1);
  expect(manifestCalls[0][1]?.[0]).toBe(M);
});
