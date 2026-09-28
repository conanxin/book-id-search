import { expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import {
  ProjectEvidenceTargetUnavailableError,
  authorizeEvidenceItems,
  evidenceCandidatesFromAuthorization,
  loadProjectEvidenceAuthorization,
} from "./project-evidence-authorization.js";

const P = "11111111-1111-4111-8111-111111111111";
const BINDING = "22222222-2222-4222-8222-222222222222";
const EDITION = "33333333-3333-4333-8333-333333333333";
const SOURCE = "44444444-4444-4444-8444-444444444444";
const ASSET = "55555555-5555-4555-8555-555555555555";
const NOTE_BINDING = "66666666-6666-4666-8666-666666666666";
const NOTE = "77777777-7777-4777-8777-777777777777";
const CURRENT_REVISION = "88888888-8888-4888-8888-888888888888";
const OLD_REVISION = "99999999-9999-4999-8999-999999999999";

function materialRow() {
  return {
    binding_id: BINDING,
    binding_created_at: new Date("2026-01-01T00:00:00.000Z"),
    binding_metadata: { sourceId: SOURCE },
    edition_id: EDITION,
    work_title: "北京古道志",
    source_id: SOURCE,
    source_type: "DATABASE_RECORD",
    source_lifecycle: "ACTIVE",
    source_edition_id: EDITION,
    source_observed_at: new Date("2026-01-02T00:00:00.000Z"),
    asset_id: ASSET,
    asset_type: "DOCUMENT",
    asset_role: "ORIGINAL",
    asset_storage_mode: "LOCAL",
    asset_created_at: new Date("2026-01-03T00:00:00.000Z"),
    note_binding_id: NOTE_BINDING,
    note_binding_role: "ANNOTATION",
    note_binding_metadata: {
      subjectBindingId: BINDING,
      subjectType: "EDITION",
      subjectId: EDITION,
    },
    note_id: NOTE,
    note_type: "PROJECT_ITEM_NOTE",
    note_lifecycle: "ACTIVE",
    note_current_revision_id: CURRENT_REVISION,
    revision_id: CURRENT_REVISION,
    revision_no: 2,
    revision_content_format: "MARKDOWN",
    revision_created_at: new Date("2026-01-04T00:00:00.000Z"),
  };
}

function client(oldRows: unknown[] = []) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("LEFT JOIN core.source_assets")) return { rows: [materialRow()] };
    if (sql.includes("FROM core.note_revisions nr") && sql.includes("ANY(")) {
      return { rows: oldRows };
    }
    return { rows: [] };
  });
  return { query } as unknown as PoolClient;
}

it("builds one authorization index used for candidates and target checks", async () => {
  const auth = await loadProjectEvidenceAuthorization(client(), P);
  expect(auth.sourceIds.has(SOURCE)).toBe(true);
  expect(auth.sourceAssetIds.has(ASSET)).toBe(true);
  expect(auth.noteIds.has(NOTE)).toBe(true);
  expect(auth.currentRevisionNoteByRevision.get(CURRENT_REVISION)).toBe(NOTE);
  expect(evidenceCandidatesFromAuthorization(auth).map(x => x.targetType)).toEqual([
    "SOURCE",
    "SOURCE_ASSET",
    "NOTE_REVISION",
  ]);
});

it("authorizes an older immutable revision only when it belongs to an authorized Note", async () => {
  const c = client([{
    revision_id: OLD_REVISION,
    note_id: NOTE,
    revision_no: 1,
    content_format: "MARKDOWN",
    created_at: new Date("2025-12-31T00:00:00.000Z"),
  }]);
  const auth = await loadProjectEvidenceAuthorization(c, P);
  await expect(authorizeEvidenceItems(c, auth, [{
    role: "SUPPORTING",
    targetType: "NOTE_REVISION",
    targetId: OLD_REVISION,
    note: null,
  }])).resolves.toBeUndefined();
});

it("rejects a target absent from the current Project authorization graph", async () => {
  const c = client();
  const auth = await loadProjectEvidenceAuthorization(c, P);
  await expect(authorizeEvidenceItems(c, auth, [{
    role: "SUPPORTING",
    targetType: "SOURCE",
    targetId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    note: null,
  }])).rejects.toBeInstanceOf(ProjectEvidenceTargetUnavailableError);
});

// Task 4: exercise the real scope helper against query-bound row fixtures.
import * as scopeModule from "./project-evidence-authorization.js";
const ISSUE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CLAIM = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DATE = new Date("2026-01-01T00:00:00.000Z");
function issueScopeRow(overrides: Record<string, unknown> = {}) {
  return {
    project_id: P, project_name: "Project", project_state: "ACTIVE",
    project_created_at: DATE, project_updated_at: DATE,
    issue_id: ISSUE, issue_title: "Question", issue_question: "When?", issue_state: "OPEN",
    issue_created_at: DATE, issue_updated_at: DATE, current_resolution_id: null,
    issue_binding_id: BINDING, owner_project_id: P, issue_binding_role: null,
    issue_binding_metadata: {}, issue_binding_created_at: DATE,
    ...overrides,
  };
}
function claimScopeRow(overrides: Record<string, unknown> = {}) {
  return { relation_issue_id: ISSUE, relation_claim_id: CLAIM, claim_id: CLAIM,
    claim_statement: "Candidate", claim_state: "ACTIVE", claim_type: null,
    subject_type: null, subject_id: null, claim_metadata: {},
    claim_created_at: DATE, claim_updated_at: DATE, ...overrides };
}
function scopeClient(rows = [issueScopeRow()], dangling = false, claimRows = [claimScopeRow()]) {
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (sql === "SELECT id FROM core.projects WHERE id=$1 FOR UPDATE") {
      expect(params).toEqual([P]); return { rows: rows.length ? [{ id: P }] : [] };
    }
    if (sql === "SELECT id FROM core.research_issues WHERE id=$1 FOR UPDATE") {
      expect(params).toEqual([ISSUE]); return { rows: [{ id: ISSUE }] };
    }
    if (sql.includes("FROM core.projects p")) {
      expect(params).toEqual([P, ISSUE]);
      expect(sql).toContain("pb.target_type = 'RESEARCH_ISSUE'");
      return { rows };
    }
    if (sql.includes("pb_only")) return { rows: dangling ? [{ id: BINDING }] : [] };
    if (sql.includes("FROM core.research_issue_claims")) return { rows: claimRows };
    if (sql.includes("FROM core.claims") && sql.includes("FOR UPDATE")) return { rows: [{ id: CLAIM }] };
    throw new Error("Unexpected scope query: " + sql);
  });
  return { query } as unknown as PoolClient;
}
function issueLoader() {
  const fn = (scopeModule as unknown as Record<string, unknown>).loadProjectIssueScope;
  expect(fn, "missing loadProjectIssueScope contract").toBeTypeOf("function");
  return fn as (c: PoolClient, p: string, i: string, options?: { lock?: boolean }) => Promise<unknown>;
}
it("loads exact Project/Issue with canonical single owner and nullable pointer", async () => {
  const value = await issueLoader()(scopeClient(), P, ISSUE);
  expect(value).toEqual({ projectId: P, projectLifecycleState: "ACTIVE", issueId: ISSUE,
    issueLifecycleState: "OPEN", currentResolutionId: null, issueUpdatedAt: DATE });
});
it("locks only Project then Issue for Issue scope", async () => {
  const c = scopeClient(); await issueLoader()(c, P, ISSUE, { lock: true });
  const calls = vi.mocked(c.query).mock.calls.map(x => String(x[0]));
  expect(calls.filter(x => x.includes("FOR UPDATE"))).toEqual([
    "SELECT id FROM core.projects WHERE id=$1 FOR UPDATE",
    "SELECT id FROM core.research_issues WHERE id=$1 FOR UPDATE",
  ]);
});
it.each([
  ["zero owner", { issue_binding_id: null }],
  ["wrong owner project", { owner_project_id: SOURCE }],
  ["non-null role", { issue_binding_role: "OWNER" }],
  ["metadata array", { issue_binding_metadata: [] }],
  ["metadata nonempty", { issue_binding_metadata: { unexpected: true } }],
  ["metadata null", { issue_binding_metadata: null }],
  ["metadata non-JSON object", { issue_binding_metadata: new Date() }],
  ["project lifecycle", { project_state: "OPEN" }],
  ["issue lifecycle", { issue_state: "ACTIVE" }],
  ["project identity", { project_id: SOURCE }],
  ["issue identity", { issue_id: SOURCE }],
  ["binding identity", { issue_binding_id: "bad" }],
  ["project created timestamp", { project_created_at: "2026-01-01" }],
  ["project updated timestamp", { project_updated_at: new Date(NaN) }],
  ["issue created timestamp", { issue_created_at: null }],
  ["issue updated timestamp", { issue_updated_at: new Date(NaN) }],
  ["binding timestamp", { issue_binding_created_at: null }],
  ["issue title", { issue_title: " Question " }],
] as const)("fails closed for %s rather than returning not-found", async (_name, mutation) => {
  const load = issueLoader();
  await expect(load(scopeClient([issueScopeRow(mutation)]), P, ISSUE))
    .rejects.toBeInstanceOf(scopeModule.ProjectEvidenceIntegrityError);
});
it("rejects multiple owners even when one is the requested Project", async () => {
  await expect(issueLoader()(scopeClient([issueScopeRow(), issueScopeRow({ owner_project_id: SOURCE })]), P, ISSUE))
    .rejects.toThrow("ISSUE_OWNER_AMBIGUOUS");
});
it("rejects a dangling binding for a missing Issue", async () => {
  await expect(issueLoader()(scopeClient([issueScopeRow({ issue_id: null })], true), P, ISSUE))
    .rejects.toThrow("ISSUE_BINDING_DANGLING");
});
it("returns null for genuinely absent Project or Issue without a binding", async () => {
  const load = issueLoader();
  await expect(load(scopeClient([]), P, ISSUE)).resolves.toBeNull();
  await expect(load(scopeClient([issueScopeRow({ issue_id: null })]), P, ISSUE)).resolves.toBeNull();
});
it("Claim scope composes Issue scope and exact membership with unchanged public shape", async () => {
  issueLoader();
  const c = scopeClient();
  await expect(scopeModule.loadProjectClaimScope(c, P, ISSUE, CLAIM, { lock: true })).resolves.toEqual({
    projectId: P, projectLifecycleState: "ACTIVE", issueId: ISSUE, issueLifecycleState: "OPEN",
    claim: { id: CLAIM, statement: "Candidate", lifecycleState: "ACTIVE" },
  });
  const calls = vi.mocked(c.query).mock.calls;
  const locked = calls.filter(x => String(x[0]).includes("FOR UPDATE"));
  expect(locked.map(x => String(x[0]))).toEqual([
    "SELECT id FROM core.projects WHERE id=$1 FOR UPDATE", "SELECT id FROM core.research_issues WHERE id=$1 FOR UPDATE",
    "SELECT issue_id,claim_id FROM core.research_issue_claims WHERE issue_id=$1 AND claim_id=$2 FOR UPDATE",
    "SELECT id FROM core.claims WHERE id=$1 FOR UPDATE",
  ]);
  expect(calls.find(x => String(x[0]).includes("JOIN core.claims"))?.[1]).toEqual([ISSUE, CLAIM]);
});
it("Claim scope preserves cross-project privacy and absent-membership not-found", async () => {
  issueLoader();
  await expect(scopeModule.loadProjectClaimScope(scopeClient([issueScopeRow({ owner_project_id: SOURCE })]), P, ISSUE, CLAIM)).resolves.toBeNull();
  await expect(scopeModule.loadProjectClaimScope(scopeClient(undefined, false, []), P, ISSUE, CLAIM)).resolves.toBeNull();
});
it.each([
  { relation_issue_id: SOURCE }, { relation_claim_id: SOURCE }, { claim_id: null },
  { claim_statement: " Candidate " }, { claim_state: "OPEN" }, { claim_updated_at: new Date(NaN) },
])("Claim canonical corruption still fails closed: %j", async mutation => {
  issueLoader();
  await expect(scopeModule.loadProjectClaimScope(scopeClient(undefined, false, [claimScopeRow(mutation)]), P, ISSUE, CLAIM))
    .rejects.toBeInstanceOf(scopeModule.ProjectEvidenceIntegrityError);
});

it.each([null, "bad-owner-id"])("Claim scope does not disguise malformed owner %s as cross-project not-found", async owner_project_id => {
  await expect(scopeModule.loadProjectClaimScope(scopeClient([issueScopeRow({ owner_project_id })]), P, ISSUE, CLAIM))
    .rejects.toBeInstanceOf(scopeModule.ProjectEvidenceIntegrityError);
});
