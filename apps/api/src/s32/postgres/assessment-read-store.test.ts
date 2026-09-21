import { expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { AssessmentIntegrityError } from "../application/assessments.js";
import { buildEvidenceManifestDraft, type EvidenceDraftInputItem } from "../domain/evidence-selection.js";
import { createPostgresAssessmentReadStore } from "./assessment-read-store.js";

const P = "11111111-1111-4111-8111-111111111111";
const I = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const BINDING = "44444444-4444-4444-8444-444444444444";
const EDITION = "55555555-5555-4555-8555-555555555555";
const SOURCE = "66666666-6666-4666-8666-666666666666";
const ASSET = "77777777-7777-4777-8777-777777777777";
const NOTE_BINDING = "88888888-8888-4888-8888-888888888888";
const NOTE = "99999999-9999-4999-8999-999999999999";
const CURRENT_REV = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OLD_REV = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ACTOR = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function uuid(n: number) {
  const h = n.toString(16).padStart(8, "0");
  return `${h}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

function scopeRow() {
  return {
    project_id: P,
    project_name: "Project",
    project_state: "ACTIVE",
    issue_id: I,
    issue_title: "Question",
    issue_question: "When?",
    issue_state: "OPEN",
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
    source_lifecycle: "ARCHIVED",
    source_edition_id: EDITION,
    source_observed_at: new Date("2026-01-01T00:00:00Z"),
    asset_id: ASSET,
    asset_type: "DOCUMENT",
    asset_role: "ORIGINAL",
    asset_storage_mode: "LOCAL",
    asset_created_at: new Date("2026-01-01T00:00:00Z"),
    note_binding_id: NOTE_BINDING,
    note_binding_role: "ANNOTATION",
    note_binding_metadata: {
      subjectBindingId: BINDING,
      subjectType: "EDITION",
      subjectId: EDITION,
    },
    note_id: NOTE,
    note_type: "PROJECT_ITEM_NOTE",
    note_lifecycle: "ARCHIVED",
    note_current_revision_id: CURRENT_REV,
    revision_id: CURRENT_REV,
    revision_no: 2,
    revision_content_format: "MARKDOWN",
    revision_created_at: new Date("2026-01-01T00:00:00Z"),
  };
}

function frozenItem(manifestId: string, item: EvidenceDraftInputItem, ordinal = 1) {
  return {
    item_id: uuid(5000 + ordinal),
    manifest_id: manifestId,
    ordinal,
    role: item.role,
    target_type: item.targetType,
    target_id: item.targetId,
    locator_type: null,
    locator: null,
    excerpt: null,
    note: item.note,
    created_at: new Date("2026-09-21T00:00:00Z"),
  };
}

function assessmentRow(
  index: number,
  item: EvidenceDraftInputItem = {
    role: "SUPPORTING",
    targetType: "SOURCE",
    targetId: SOURCE,
    note: null,
  },
  overrides: Record<string, unknown> = {},
) {
  const manifestId = uuid(1000 + index);
  const assessmentId = uuid(2000 + index);
  const hash = buildEvidenceManifestDraft([item]).manifestSha256;
  return {
    assessment_id: assessmentId,
    claim_id: C,
    actor_id: null,
    stance: "SUPPORTS",
    confidence_level: null,
    numeric_score: null,
    score_kind: null,
    reasoning: "Reasoning " + index,
    assessment_metadata: {},
    assessment_created_at: new Date(Date.UTC(2026, 8, 21, 0, 0, 60 - index)),
    manifest_id: manifestId,
    schema_version: 1,
    purpose: "CLAIM_ASSESSMENT",
    manifest_sha256: hash,
    manifest_metadata: {},
    manifest_created_at: new Date("2026-09-21T00:00:00Z"),
    __item: item,
    ...overrides,
  };
}

type Options = {
  pageRows?: ReturnType<typeof assessmentRow>[];
  detailRows?: ReturnType<typeof assessmentRow>[];
  scopeMissing?: boolean;
  actorRows?: unknown[];
};

function fakePool(options: Options = {}) {
  const pageRows = options.pageRows ?? [];
  const detailRows = options.detailRows ?? pageRows.slice(0, 1);
  const queries: string[] = [];
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    queries.push(sql);
    if (sql === "BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY" || sql === "COMMIT" || sql === "ROLLBACK") {
      return { rows: [] };
    }
    if (sql.includes("FROM core.projects p")) {
      return { rows: options.scopeMissing ? [] : [scopeRow()] };
    }
    if (sql.includes("LEFT JOIN core.source_assets")) return { rows: [materialRow()] };
    if (sql.includes("/* assessment-history-visible */")) return { rows: pageRows };
    if (sql.includes("/* assessment-detail-visible */")) return { rows: detailRows };
    if (sql.includes("FROM core.evidence_manifest_items") && sql.includes("ANY($1::uuid[])")) {
      const ids = (params?.[0] as string[]) ?? [];
      const all = [...pageRows, ...detailRows];
      const byId = new Map(all.map(row => [row.manifest_id, row]));
      return {
        rows: ids.flatMap(id => {
          const row = byId.get(id);
          return row ? [frozenItem(id, row.__item)] : [];
        }),
      };
    }
    if (sql.includes("FROM core.actors") && sql.includes("ANY($1::uuid[])")) {
      return { rows: options.actorRows ?? [] };
    }
    throw new Error("Unexpected SQL: " + sql);
  });
  const client = { query, release: vi.fn() } as unknown as PoolClient;
  const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
  return { pool, query, queries };
}

it("filters visibility in SQL before keyset pagination and returns 20 of 21 visible rows", async () => {
  const rows = Array.from({ length: 21 }, (_, n) => assessmentRow(n + 1));
  const fx = fakePool({ pageRows: rows });
  const result = await createPostgresAssessmentReadStore(fx.pool).list({
    projectId: P,
    issueId: I,
    claimId: C,
    limit: 20,
    cursor: null,
  });
  expect(result.kind).toBe("ok");
  if (result.kind !== "ok") throw new Error("expected ok");
  expect(result.value.assessments).toHaveLength(20);
  expect(result.value.nextCursor).not.toBeNull();

  const sql = fx.queries.find(x => x.includes("/* assessment-history-visible */"))!;
  expect(sql.indexOf("NOT EXISTS")).toBeLessThan(sql.indexOf("ORDER BY"));
  expect(sql).toContain("target_type NOT IN ('SOURCE','SOURCE_ASSET','NOTE_REVISION')");
  expect(sql).toContain("nr.note_id = ANY");
  expect(sql).toContain("LIMIT");
});

it("uses a bounded query count independent of page size", async () => {
  const one = fakePool({ pageRows: [assessmentRow(1)] });
  await createPostgresAssessmentReadStore(one.pool).list({
    projectId: P, issueId: I, claimId: C, limit: 20, cursor: null,
  });
  const many = fakePool({ pageRows: Array.from({ length: 20 }, (_, n) => assessmentRow(n + 1)) });
  await createPostgresAssessmentReadStore(many.pool).list({
    projectId: P, issueId: I, claimId: C, limit: 20, cursor: null,
  });
  expect(many.query.mock.calls.length).toBe(one.query.mock.calls.length);
});

it("keeps archived Source/Note and an older immutable NoteRevision readable", async () => {
  const oldItem: EvidenceDraftInputItem = {
    role: "CONTEXTUAL",
    targetType: "NOTE_REVISION",
    targetId: OLD_REV,
    note: "old immutable revision",
  };
  const row = assessmentRow(1, oldItem);
  const fx = fakePool({ detailRows: [row] });
  const result = await createPostgresAssessmentReadStore(fx.pool).get({
    projectId: P, issueId: I, claimId: C, assessmentId: row.assessment_id,
  });
  expect(result.kind).toBe("ok");
  if (result.kind !== "ok") throw new Error("expected ok");
  expect(result.value.evidenceManifest.items[0].targetId).toBe(OLD_REV);
});

it("hides manifestless/non-visible/unsupported-target Assessments instead of leaking corruption", async () => {
  const fx = fakePool({ detailRows: [] });
  await expect(createPostgresAssessmentReadStore(fx.pool).get({
    projectId: P, issueId: I, claimId: C, assessmentId: uuid(99),
  })).resolves.toEqual({ kind: "not-visible" });
});

it("fails visible Manifest corruption after visibility is established", async () => {
  const row = assessmentRow(1, undefined, { manifest_sha256: "0".repeat(64) });
  const fx = fakePool({ detailRows: [row] });
  await expect(createPostgresAssessmentReadStore(fx.pool).get({
    projectId: P, issueId: I, claimId: C, assessmentId: row.assessment_id,
  })).rejects.toBeInstanceOf(AssessmentIntegrityError);
});

it("reads future schema-valid Actor/score/null reasoning when its Manifest is visible", async () => {
  const row = assessmentRow(1, undefined, {
    actor_id: ACTOR,
    numeric_score: 0.82,
    score_kind: "CALIBRATED_PROBABILITY",
    reasoning: null,
  });
  const fx = fakePool({
    detailRows: [row],
    actorRows: [{
      actor_id: ACTOR,
      actor_type: "AI_SYSTEM",
      display_name: "Research Model",
      actor_metadata: {},
      actor_created_at: new Date("2026-01-01T00:00:00Z"),
      actor_updated_at: new Date("2026-01-01T00:00:00Z"),
    }],
  });
  const result = await createPostgresAssessmentReadStore(fx.pool).get({
    projectId: P, issueId: I, claimId: C, assessmentId: row.assessment_id,
  });
  expect(result.kind).toBe("ok");
  if (result.kind !== "ok") throw new Error("expected ok");
  expect(result.value.assessment).toMatchObject({
    actorId: ACTOR,
    numericScore: 0.82,
    scoreKind: "CALIBRATED_PROBABILITY",
    reasoning: null,
  });
});

it("distinguishes missing route scope from an invisible Assessment", async () => {
  const fx = fakePool({ scopeMissing: true });
  await expect(createPostgresAssessmentReadStore(fx.pool).get({
    projectId: P, issueId: I, claimId: C, assessmentId: uuid(99),
  })).resolves.toEqual({ kind: "scope-missing" });
});
