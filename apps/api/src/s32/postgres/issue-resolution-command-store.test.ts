import { existsSync } from "node:fs";
import { expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import * as errors from "../application/issue-resolutions.js";
import type { IssueResolutionCreateCommand } from "../application/issue-resolutions.js";
import { hashIssueResolutionCreateRequest } from "../domain/issue-resolution.js";
import { buildEvidenceManifestDraft } from "../domain/evidence-selection.js";

const modulePath = "./issue-resolution-command-store.js";
const implementation = existsSync(new URL("./issue-resolution-command-store.ts", import.meta.url))
  ? await import(modulePath) : {};
function factory(pool: Pool): errors.IssueResolutionCommandStore {
  expect(implementation.createPostgresIssueResolutionCommandStore, "missing command-store contract").toBeTypeOf("function");
  return implementation.createPostgresIssueResolutionCommandStore(pool);
}
const P = "11111111-1111-4111-8111-111111111111";
const I = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const R = "44444444-4444-4444-8444-444444444444";
const M = "55555555-5555-4555-8555-555555555555";
const A = "66666666-6666-4666-8666-666666666666";
const K = "77777777-7777-4777-8777-777777777777";
const B = "88888888-8888-4888-8888-888888888888";
const S = "99999999-9999-4999-8999-999999999999";
const OTHER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BEFORE = new Date("2026-01-01T00:00:00Z");
const NOW = new Date("2026-09-28T00:00:00Z");
function command(overrides: Partial<IssueResolutionCreateCommand> = {}): IssueResolutionCreateCommand {
  const value = { projectId: P, issueId: I, resolutionId: R, idempotencyKey: K,
    expectedCurrentResolutionId: null, resolutionType: "INSUFFICIENT_EVIDENCE" as const,
    preferredClaimId: null, rationale: "当前证据不足。", evidenceManifestId: null, ...overrides };
  return { ...value, requestHash: overrides.requestHash ?? hashIssueResolutionCreateRequest(P, I, {
    expectedCurrentResolutionId: value.expectedCurrentResolutionId, resolutionType: value.resolutionType,
    preferredClaimId: value.preferredClaimId, rationale: value.rationale, evidenceManifestId: value.evidenceManifestId,
  }) };
}
function scopeRow() {
  return { project_id: P, project_name: "Project", project_state: "ACTIVE",
    project_created_at: BEFORE, project_updated_at: BEFORE,
    issue_id: I, issue_title: "Question", issue_question: "When?", issue_state: "OPEN",
    issue_created_at: BEFORE, issue_updated_at: BEFORE, current_resolution_id: null,
    issue_binding_id: B, owner_project_id: P, issue_binding_role: null, issue_binding_metadata: {},
    issue_binding_created_at: BEFORE };
}
function claimRow() {
  return { relation_issue_id: I, relation_claim_id: C, claim_id: C,
    claim_statement: "Candidate", claim_state: "ACTIVE", claim_type: null,
    subject_type: null, subject_id: null, claim_metadata: {}, claim_created_at: BEFORE, claim_updated_at: BEFORE };
}
function manifestItem() {
  return { item_id: B, manifest_id: M, ordinal: 1, role: "SUPPORTING", target_type: "SOURCE", target_id: S,
    locator_type: null, locator: null, excerpt: null, note: null, created_at: BEFORE };
}
const manifestHash = buildEvidenceManifestDraft([{ role: "SUPPORTING", targetType: "SOURCE", targetId: S, note: null }]).manifestSha256;
function assessmentRow() {
  return { assessment_id: A, claim_id: C, actor_id: null, stance: "SUPPORTS", confidence_level: null,
    numeric_score: null, score_kind: null, reasoning: "证据支持。", assessment_metadata: {}, assessment_created_at: BEFORE,
    evidence_manifest_id: M, manifest_id: M, schema_version: 1, purpose: "CLAIM_ASSESSMENT",
    manifest_sha256: manifestHash, manifest_metadata: {}, manifest_created_at: BEFORE };
}
function materialRow() {
  return { binding_id: B, binding_created_at: BEFORE, binding_metadata: { sourceId: S }, edition_id: OTHER,
    work_title: "Book", source_id: S, source_type: "DATABASE_RECORD", source_lifecycle: "ARCHIVED",
    source_edition_id: OTHER, source_observed_at: BEFORE,
    asset_id: null, asset_type: null, asset_role: null, asset_storage_mode: null, asset_created_at: null,
    note_binding_id: null, note_binding_role: null, note_binding_metadata: null, note_id: null, note_type: null,
    note_lifecycle: null, note_current_revision_id: null, revision_id: null, revision_no: null,
    revision_content_format: null, revision_created_at: null };
}
type Row = Record<string, any>;
type State = { scope: Row; resolutions: Row[]; receipts: Row[] };
type Faults = {
  scope?: Row; owners?: number; missingScope?: boolean; claim?: Row; membership?: boolean; membershipIssueId?: string; actorMissing?: boolean;
  assessments?: readonly Row[]; items?: readonly Row[]; materials?: readonly Row[];
  readback?: Row | "missing"; completed?: Row | "missing"; updateMissing?: boolean;
  failSql?: string; error?: Error; failAttempts?: number; connectError?: Error;
};
// Model only the database boundary: the real store chooses SQL/parameters/order.
// Durable state changes only on COMMIT; ROLLBACK discards all three resources.
function database(faults: Faults = {}) {
  const durable: State = { scope: { ...scopeRow(), ...faults.scope }, resolutions: [], receipts: [] };
  let tx: State | null = null;
  let attempt = 0;
  const calls: Array<{ sql: string; params: any[] }> = [];
  const query = vi.fn(async (text: string, params: any[] = []) => {
    const sql = text.replace(/\s+/g, " ").trim(); calls.push({ sql, params });
    if (sql.startsWith("BEGIN")) { attempt++; tx = structuredClone(durable); return { rows: [], rowCount: 0 }; }
    if (faults.failSql && sql.includes(faults.failSql) && attempt <= (faults.failAttempts ?? Infinity)) throw faults.error;
    if (sql === "ROLLBACK") { tx = null; return { rows: [], rowCount: 0 }; }
    if (sql === "COMMIT") { Object.assign(durable, structuredClone(tx)); tx = null; return { rows: [], rowCount: 0 }; }
    if (!tx) throw new Error("query outside transaction");
    if (sql.startsWith("INSERT INTO ops.idempotency_keys")) {
      expect(params[1]).toBe(`S32:M2E:PROJECT_ISSUE_RESOLUTION_CREATE:${P}:${I}`);
      expect(sql).toContain("ON CONFLICT(scope,idempotency_key) DO NOTHING");
      if (tx.receipts.some(r => r.scope === params[1] && r.idempotency_key === params[2])) return { rows: [], rowCount: 0 };
      tx.receipts.push({ id: params[0], scope: params[1], idempotency_key: params[2], request_hash: params[3],
        status: "IN_PROGRESS", resource_type: null, resource_id: null, result_payload: null });
      return { rows: [{ id: params[0] }], rowCount: 1 };
    }
    if (sql.includes("FROM ops.idempotency_keys")) {
      expect(sql).toContain("FOR UPDATE");
      return { rows: tx.receipts.filter(r => r.scope === params[0] && r.idempotency_key === params[1]) };
    }
    if (sql === "SELECT id FROM core.projects WHERE id=$1 FOR UPDATE") return { rows: faults.missingScope ? [] : [{ id: P }] };
    if (sql === "SELECT id FROM core.research_issues WHERE id=$1 FOR UPDATE") return { rows: [{ id: I }] };
    if (sql.includes("FROM core.projects p")) {
      expect(params).toEqual([P, I]);
      return { rows: faults.missingScope ? [] : Array.from({ length: faults.owners ?? 1 }, () => tx!.scope) };
    }
    if (sql.includes("FROM core.research_issue_claims")) {
      expect(params).toEqual([I, C]);
      return { rows: (faults.membership === false || (faults.membershipIssueId && faults.membershipIssueId !== params[0])) ? [] : [{ ...claimRow(), ...faults.claim }] };
    }
    if (sql.includes("FROM core.claims") && sql.includes("FOR UPDATE")) return { rows: [{ id: C }] };
    if (sql.includes("FROM core.actors")) {
      expect(params).toEqual([OTHER]);
      return { rows: faults.actorMissing ? [] : [{ id: OTHER, actor_type: "HUMAN", display_name: "Researcher",
        metadata: {}, created_at: BEFORE, updated_at: BEFORE }] };
    }
    if (sql.includes("FROM core.assessments")) {
      expect(params).toEqual([M]); return { rows: faults.assessments ?? [assessmentRow()] };
    }
    if (sql.includes("FROM core.evidence_manifest_items")) {
      expect(params).toEqual([M]); return { rows: faults.items ?? [manifestItem()] };
    }
    if (sql.includes("LEFT JOIN core.source_assets")) return { rows: faults.materials ?? [materialRow()] };
    if (sql.startsWith("INSERT INTO core.issue_resolutions")) {
      expect(sql).toMatch(/\(id,issue_id,resolution_type,preferred_claim_id,rationale,evidence_manifest_id\)/);
      tx.resolutions.push({ id: params[0], issue_id: params[1], resolution_type: params[2], preferred_claim_id: params[3],
        rationale: params[4], evidence_manifest_id: params[5], created_at: NOW });
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE core.research_issues")) {
      expect(params).toEqual([I, tx.resolutions.at(-1)?.id]);
      expect(sql).not.toContain("lifecycle_state=");
      expect(sql).toContain("updated_at=now()");
      if (faults.updateMissing) return { rows: [], rowCount: 0 };
      tx.scope.current_resolution_id = params[1]; tx.scope.issue_updated_at = NOW;
      return { rows: [{ id: I }], rowCount: 1 };
    }
    if (sql.includes("FROM core.issue_resolutions")) {
      if (faults.readback === "missing") return { rows: [] };
      return { rows: tx.resolutions.filter(r => r.id === params[0]).map(r => ({ ...r, ...(typeof faults.readback === "object" ? faults.readback : {}) })) };
    }
    if (sql.startsWith("UPDATE ops.idempotency_keys")) {
      const r = tx.receipts.find(r => r.id === params[0]);
      expect(sql).toContain("completed_at=now()"); expect(sql).toContain("updated_at=now()");
      Object.assign(r!, { status: "COMPLETED", resource_type: "ISSUE_RESOLUTION", resource_id: params[1],
        result_payload: JSON.parse(params[2]), completed_at: NOW, updated_at: NOW });
      return { rows: faults.completed === "missing" ? [] : [{ ...r, ...faults.completed }], rowCount: 1 };
    }
    throw new Error("Unexpected command query: " + sql);
  });
  const release = vi.fn();
  const connect = vi.fn(async () => {
    if (faults.connectError) throw faults.connectError;
    return { query, release } as unknown as PoolClient;
  });
  return { pool: { connect } as unknown as Pool, durable, calls, query, release, connect };
}
async function rejectsWithoutWrite(faults: Faults, error: new (...args: any[]) => Error, input = command()) {
  const db = database(faults); const before = structuredClone(db.durable);
  await expect(factory(db.pool).create(input)).rejects.toBeInstanceOf(error);
  expect(db.durable).toEqual(before);
  expect(db.calls.at(-1)?.sql).toBe("ROLLBACK"); expect(db.release).toHaveBeenCalledOnce();
  return db;
}

it.each(["OPEN", "RESOLVED"])("atomically creates Resolution, advances pointer/time and preserves %s", async state => {
  const db = database({ scope: { issue_state: state } });
  expect(await factory(db.pool).create(command())).toEqual({ status: "created", resolutionId: R });
  expect(db.durable.resolutions).toEqual([{ id: R, issue_id: I, resolution_type: "INSUFFICIENT_EVIDENCE",
    preferred_claim_id: null, rationale: "当前证据不足。", evidence_manifest_id: null, created_at: NOW }]);
  expect(db.durable.scope).toMatchObject({ issue_state: state, current_resolution_id: R, issue_updated_at: NOW });
  expect(db.durable.scope.issue_updated_at.getTime()).toBeGreaterThan(BEFORE.getTime());
  expect(db.durable.receipts).toHaveLength(1);
  expect(db.durable.receipts[0]).toMatchObject({ scope: `S32:M2E:PROJECT_ISSUE_RESOLUTION_CREATE:${P}:${I}`,
    status: "COMPLETED", resource_type: "ISSUE_RESOLUTION", resource_id: R,
    result_payload: { resolutionId: R }, completed_at: NOW });
  expect(db.calls[0].sql).toBe("BEGIN ISOLATION LEVEL SERIALIZABLE");
  expect(db.calls.at(-1)?.sql).toBe("COMMIT"); expect(db.release).toHaveBeenCalledOnce();
  expect(db.calls.some(c => c.sql.includes("FROM core.assessments"))).toBe(false);
});
it("locks/writes in order without locking all candidate Claims or Assessment history", async () => {
  const db = database();
  await factory(db.pool).create(command({ resolutionType: "PREFERRED_CLAIM", preferredClaimId: C, evidenceManifestId: M }));
  const markers = ["INSERT INTO ops.idempotency_keys", "FROM core.projects WHERE", "FROM core.research_issues WHERE",
    "FROM core.research_issue_claims", "FROM core.assessments", "INSERT INTO core.issue_resolutions",
    "UPDATE core.research_issues", "FROM core.issue_resolutions", "UPDATE ops.idempotency_keys", "COMMIT"];
  const indices = markers.map(m => db.calls.findIndex(c => c.sql.includes(m)));
  expect(indices.every(i => i >= 0)).toBe(true); expect(indices).toEqual([...indices].sort((a, b) => a - b));
  for (const c of db.calls.filter(c => c.sql.includes("FOR UPDATE") && c.sql.includes("research_issue_claims"))) {
    expect(c.params).toEqual([I, C]); expect(c.sql).toContain("claim_id=$2");
  }
  expect(db.calls.filter(c => c.sql.includes("FROM core.assessments")).some(c => c.sql.includes("FOR UPDATE"))).toBe(false);
  expect(db.calls.some(c => /^(INSERT INTO|UPDATE|DELETE FROM) core\.(claims|assessments|evidence_manifest)/.test(c.sql))).toBe(false);
});
it("allows an archived canonical preferred Claim without changing it", async () => {
  const db = database({ claim: { claim_state: "ARCHIVED" } });
  await expect(factory(db.pool).create(command({ resolutionType: "PREFERRED_CLAIM", preferredClaimId: C })))
    .resolves.toEqual({ status: "created", resolutionId: R });
  expect(db.durable.resolutions[0].preferred_claim_id).toBe(C);
});
it("replays original A after B advances the pointer without mutating B", async () => {
  const db = database(); const store = factory(db.pool); const first = command();
  await store.create(first);
  await store.create(command({ resolutionId: OTHER, idempotencyKey: OTHER, expectedCurrentResolutionId: R, rationale: "新结论。" }));
  const before = structuredClone(db.durable); db.calls.length = 0;
  expect(await store.create({ ...first, resolutionId: B })).toEqual({ status: "replayed", resolutionId: R });
  expect(db.durable).toEqual(before); expect(db.durable.scope.current_resolution_id).toBe(OTHER);
  expect(db.calls.some(c => c.sql.startsWith("UPDATE") || c.sql.startsWith("INSERT INTO core"))).toBe(false);
});
it.each(["issue_state", "project_state"])("replays before read-only %s drift", async field => {
  const db = database(); const store = factory(db.pool); await store.create(command());
  db.durable.scope[field] = "ARCHIVED"; const before = structuredClone(db.durable);
  expect(await store.create(command({ resolutionId: OTHER }))).toEqual({ status: "replayed", resolutionId: R });
  expect(db.durable).toEqual(before);
});
it("completed replay ignores later preferred membership/evidence visibility/current pointer", async () => {
  const faults: Faults = {}; const db = database(faults); const store = factory(db.pool);
  const input = command({ resolutionType: "PREFERRED_CLAIM", preferredClaimId: C, evidenceManifestId: M });
  await store.create(input); faults.membership = false; faults.materials = [];
  db.durable.scope.current_resolution_id = OTHER; db.calls.length = 0;
  expect(await store.create({ ...input, resolutionId: OTHER })).toEqual({ status: "replayed", resolutionId: R });
  expect(db.calls.some(c => /FROM core\.(research_issue_claims|assessments|evidence_manifest_items)/.test(c.sql))).toBe(false);
});
it("changed request or old expected pointer on same key conflicts", async () => {
  const db = database(); const store = factory(db.pool); await store.create(command());
  const before = structuredClone(db.durable);
  for (const change of [{ rationale: "different" }, { expectedCurrentResolutionId: R }]) {
    await expect(store.create(command(change))).rejects.toBeInstanceOf(errors.IssueResolutionIdempotencyConflictError);
    expect(db.durable).toEqual(before);
  }
});
it.each([
  ["missing payload", { result_payload: null }], ["extra payload key", { result_payload: { resolutionId: R, x: 1 } }],
  ["array payload", { result_payload: [R] }], ["string payload", { result_payload: JSON.stringify({ resolutionId: R }) }],
  ["wrong payload UUID", { result_payload: { resolutionId: "bad" } }],
  ["payload mismatch", { result_payload: { resolutionId: OTHER } }],
  ["wrong resource type", { resource_type: "ASSESSMENT" }], ["missing resource", { resource_id: null }],
  ["noncanonical resource", { resource_id: OTHER.toUpperCase(), result_payload: { resolutionId: OTHER.toUpperCase() } }],
  ["invalid status", { status: "UNKNOWN" }],
] as const)("fails closed on completed receipt corruption: %s", async (_name, mutation) => {
  const db = database(); const store = factory(db.pool); await store.create(command());
  Object.assign(db.durable.receipts[0], mutation); const before = structuredClone(db.durable);
  await expect(store.create(command({ resolutionId: OTHER }))).rejects.toBeInstanceOf(errors.IssueResolutionIntegrityError);
  expect(db.durable).toEqual(before);
});
it.each(["IN_PROGRESS", "FAILED"])("existing %s receipt is unavailable, never duplicated", async status => {
  const db = database(); const store = factory(db.pool); await store.create(command()); db.durable.receipts[0].status = status;
  const before = structuredClone(db.durable);
  await expect(store.create(command())).rejects.toThrow("ISSUE_RESOLUTION_STORE_UNAVAILABLE");
  expect(db.durable).toEqual(before);
});
it.each([
  { issue_id: OTHER }, { resolution_type: "BAD" }, { preferred_claim_id: C },
  { rationale: null }, { rationale: "changed" }, { rationale: " 当前证据不足。 " },
  { evidence_manifest_id: M }, { created_at: new Date(NaN) },
])("replay closes receipt to exact original semantic resource: %j", async mutation => {
  const db = database(); const store = factory(db.pool); await store.create(command());
  Object.assign(db.durable.resolutions[0], mutation); const before = structuredClone(db.durable);
  await expect(store.create(command({ resolutionId: OTHER }))).rejects.toBeInstanceOf(errors.IssueResolutionIntegrityError);
  expect(db.durable).toEqual(before);
});
it("recomputes hash rather than accepting two equal forged hash strings", async () => {
  const db = database(); const store = factory(db.pool); await store.create(command());
  db.durable.receipts[0].request_hash = "f".repeat(64);
  await expect(store.create(command({ requestHash: "f".repeat(64) }))).rejects.toThrow("IDEMPOTENCY_REPLAY_HASH_MISMATCH");
});
it("missing replay resource is integrity, never a new insert", async () => {
  const db = database(); const store = factory(db.pool); await store.create(command()); db.durable.resolutions = [];
  const before = structuredClone(db.durable);
  await expect(store.create(command())).rejects.toBeInstanceOf(errors.IssueResolutionIntegrityError);
  expect(db.durable).toEqual(before);
});
it.each([
  [{ scope: { current_resolution_id: R } }, errors.IssueResolutionStaleError],
  [{ scope: { project_state: "ARCHIVED" } }, errors.ProjectReadOnlyForResolutionError],
  [{ scope: { issue_state: "ARCHIVED" } }, errors.ResearchIssueReadOnlyForResolutionError],
  [{ scope: { issue_binding_id: null } }, errors.IssueResolutionIntegrityError],
  [{ scope: { owner_project_id: OTHER } }, errors.IssueResolutionScopeNotFoundError],
  [{ scope: { owner_project_id: "bad" } }, errors.IssueResolutionIntegrityError],
  [{ owners: 2 }, errors.IssueResolutionIntegrityError],
  [{ missingScope: true }, errors.IssueResolutionScopeNotFoundError],
  [{ scope: { current_resolution_id: "bad" } }, errors.IssueResolutionIntegrityError],
] as const)("scope/lifecycle/CAS failure rolls back reservation before domain writes: %j", async (fault, error) => {
  const db = await rejectsWithoutWrite(fault, error);
  expect(db.calls.some(c => c.sql.startsWith("INSERT INTO core") || c.sql.startsWith("UPDATE core"))).toBe(false);
});
it.each([false, true])("missing/cross-Issue preferred Claim rolls back (belongs to another Issue=%s)", async crossIssue => {
  await rejectsWithoutWrite(crossIssue ? { membershipIssueId: OTHER } : { membership: false },
    errors.IssueResolutionInvalidPreferredClaimError, command({ resolutionType: "PREFERRED_CLAIM", preferredClaimId: C }));
});
it("canonical preferred Claim corruption is integrity", async () => {
  await rejectsWithoutWrite({ claim: { claim_statement: "  " } }, errors.IssueResolutionIntegrityError,
    command({ resolutionType: "PREFERRED_CLAIM", preferredClaimId: C }));
});
it("visible Manifest references one candidate Assessment without duplicating evidence", async () => {
  const db = database(); await factory(db.pool).create(command({ evidenceManifestId: M }));
  expect(db.durable.resolutions[0].evidence_manifest_id).toBe(M);
  expect(db.calls.filter(c => c.sql.startsWith("INSERT INTO core")).map(c => c.sql.split(" ")[2])).toEqual(["core.issue_resolutions"]);
});
it.each([
  ["no Assessment", { assessments: [] }], ["not candidate", { membership: false }], ["hidden material", { materials: [] }],
] as const)("unavailable evidence rolls back: %s", async (_name, fault) => {
  await rejectsWithoutWrite(fault, errors.IssueResolutionEvidenceNotAvailableError, command({ evidenceManifestId: M }));
});
it.each([
  ["ambiguous", { assessments: [assessmentRow(), { ...assessmentRow(), assessment_id: OTHER }] }],
  ["dangling Manifest", { assessments: [{ ...assessmentRow(), manifest_id: null }] }],
  ["bad stance", { assessments: [{ ...assessmentRow(), stance: "BAD" }] }],
  ["bad hash", { assessments: [{ ...assessmentRow(), manifest_sha256: "f".repeat(64) }] }],
  ["Manifest metadata", { assessments: [{ ...assessmentRow(), manifest_metadata: { extra: true } }] }],
  ["missing items", { items: [] }], ["ordinal", { items: [{ ...manifestItem(), ordinal: 2 }] }],
  ["item locator", { items: [{ ...manifestItem(), locator: {} }] }],
  ["item date", { items: [{ ...manifestItem(), created_at: new Date(NaN) }] }],
  ["authorization graph", { materials: [{ ...materialRow(), source_type: "BAD" }] }],
] as const)("evidence corruption rolls back: %s", async (_name, fault) => {
  await rejectsWithoutWrite(fault as Faults, errors.IssueResolutionIntegrityError, command({ evidenceManifestId: M }));
});
it.each([
  { readback: "missing" }, { readback: { id: OTHER } }, { readback: { issue_id: OTHER } },
  { readback: { rationale: null } }, { readback: { rationale: "bad" } }, { readback: { created_at: new Date(NaN) } },
  { completed: "missing" }, { completed: { result_payload: { resolutionId: OTHER } } },
  { updateMissing: true },
] as Faults[])("readback/receipt failure leaves no partial durable write: %j", async fault => {
  await rejectsWithoutWrite(fault, errors.IssueResolutionIntegrityError);
});
it.each(["INSERT INTO core.issue_resolutions", "UPDATE core.research_issues", "FROM core.issue_resolutions", "UPDATE ops.idempotency_keys", "COMMIT"])("SQL failure at %s rolls back all modeled writes", async failSql => {
  const error = Object.assign(new Error("SQL failure"), { code: "23514" });
  const db = database({ failSql, error }); const before = structuredClone(db.durable);
  await expect(factory(db.pool).create(command())).rejects.toBe(error);
  expect(db.durable).toEqual(before); expect(db.release).toHaveBeenCalledOnce();
});
it.each(["40001", "40P01"])("retries only %s with stable command ID and releases failed transaction", async code => {
  const db = database({ failSql: "UPDATE ops.idempotency_keys", error: Object.assign(new Error("retry"), { code }), failAttempts: 1 });
  expect(await factory(db.pool).create(command())).toEqual({ status: "created", resolutionId: R });
  expect(db.durable.resolutions).toHaveLength(1); expect(db.durable.receipts).toHaveLength(1);
  expect(db.release).toHaveBeenCalledTimes(2); expect(db.calls.filter(c => c.sql === "ROLLBACK")).toHaveLength(1);
  expect(db.calls.filter(c => c.sql.startsWith("INSERT INTO core.issue_resolutions")).map(c => c.params[0])).toEqual([R, R]);
});
it.each(["40001", "40P01"])("exhausts %s after exactly three rolled-back attempts", async code => {
  const db = database({ failSql: "UPDATE ops.idempotency_keys", error: Object.assign(new Error("retry"), { code }) });
  const before = structuredClone(db.durable);
  await expect(factory(db.pool).create(command())).rejects.toThrow("ISSUE_RESOLUTION_STORE_UNAVAILABLE");
  expect(db.release).toHaveBeenCalledTimes(3); expect(db.durable).toEqual(before);
  expect(db.calls.filter(c => c.sql === "ROLLBACK")).toHaveLength(3);
});
it.each(["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "ETIMEDOUT", "EPIPE", "57P01", "57P02", "57P03", "53300", "08006"])("classifies connection %s without transaction retry", async code => {
  const db = database({ connectError: Object.assign(new Error("private database details"), { code }) });
  await expect(factory(db.pool).create(command())).rejects.toThrow("ISSUE_RESOLUTION_STORE_UNAVAILABLE");
  expect(db.connect).toHaveBeenCalledOnce(); expect(db.release).not.toHaveBeenCalled();
});
it.each(["connection terminated", "connection timeout", "timeout exceeded", "query read timeout", "connection refused", "connection reset"])("classifies established connection pattern: %s", async message => {
  await rejectsWithoutWrite({ failSql: "UPDATE core.research_issues", error: new Error(message) }, errors.IssueResolutionStoreUnavailableError);
});
it.each([errors.IssueResolutionStaleError, errors.IssueResolutionIntegrityError, errors.ProjectReadOnlyForResolutionError])("preserves semantic error identity before connection text matching: %s", async ErrorClass => {
  const error = new ErrorClass("connection timeout"); const db = database({ failSql: "INSERT INTO ops.idempotency_keys", error });
  await expect(factory(db.pool).create(command())).rejects.toBe(error); expect(db.release).toHaveBeenCalledOnce();
});

it("accepts schema-valid visible Assessment attribution/score/null reasoning like M2-D reads", async () => {
  const db = database({ assessments: [{ ...assessmentRow(), actor_id: OTHER, numeric_score: 0.8,
    score_kind: "WEIGHT", reasoning: null, assessment_metadata: { source: "historical" } }] });
  await expect(factory(db.pool).create(command({ evidenceManifestId: M })))
    .resolves.toEqual({ status: "created", resolutionId: R });
});
it("fails closed on dangling historical Assessment Actor", async () => {
  await rejectsWithoutWrite({ assessments: [{ ...assessmentRow(), actor_id: OTHER }], actorMissing: true },
    errors.IssueResolutionIntegrityError, command({ evidenceManifestId: M }));
});
