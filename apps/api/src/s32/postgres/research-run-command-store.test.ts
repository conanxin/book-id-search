import { existsSync } from "node:fs";
import { expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import * as errors from "../application/research-runs.js";
import type {
  ResearchRunReplayCommand,
  ResearchRunStartCommand,
  ResearchRunTransitionCommand,
} from "../application/research-runs.js";
import { buildEvidenceManifestDraft } from "../domain/evidence-selection.js";

const modulePath = "./research-run-command-store.js";
const implementation = existsSync(new URL("./research-run-command-store.ts", import.meta.url))
  ? await import(modulePath) : {};
function factory(pool: Pool): errors.ResearchRunCommandStore {
  expect(implementation.createPostgresResearchRunCommandStore, "missing command-store contract").toBeTypeOf("function");
  return implementation.createPostgresResearchRunCommandStore(pool);
}

const P = "11111111-1111-4111-8111-111111111111";
const I = "22222222-2222-4222-8222-222222222222";
const RUN = "33333333-3333-4333-8333-333333333333";
const NEW_RUN = "44444444-4444-4444-8444-444444444444";
const M = "55555555-5555-4555-8555-555555555555";
const CLAIM = "66666666-6666-4666-8666-666666666666";
const ASSESS = "77777777-7777-4777-8777-777777777777";
const RESOL = "88888888-8888-4888-8888-888888888888";
const NOTEREV = "99999999-9999-4999-8999-999999999999";
const K = "aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbb1-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const BEFORE = new Date("2026-01-01T00:00:00Z");
const NOW = new Date("2026-09-30T00:00:00Z");

const PROCEDURE = { version: 1 as const, objective: "梳理古道", method: "文献比对", steps: [{ kind: "SEARCH", description: "检索" }] };
const EXECUTION = { version: 1 as const, mode: "HUMAN", reproducibilityLevel: "PROCEDURE", tools: [] };
const ENVIRONMENT = { locale: "zh-CN" };
const OUTPUT = { version: 1 as const, summary: "完成。", produced: { claimIds: [], assessmentIds: [], resolutionIds: [], noteRevisionIds: [] }, gaps: [] };

function startCommand(overrides: Partial<ResearchRunStartCommand> = {}): ResearchRunStartCommand {
  return { projectId: P, issueId: I, evidenceManifestId: M, runId: RUN, idempotencyKey: K,
    requestHash: "h".repeat(64), procedure: PROCEDURE, executionContract: EXECUTION,
    environment: ENVIRONMENT, replayOf: null, ...overrides };
}
function transitionCommand(overrides: Partial<ResearchRunTransitionCommand> = {}): ResearchRunTransitionCommand {
  return { projectId: P, issueId: I, runId: RUN, status: "SUCCEEDED", output: OUTPUT,
    idempotencyKey: K, requestHash: "t".repeat(64), ...overrides };
}
function replayCommand(overrides: Partial<ResearchRunReplayCommand> = {}): ResearchRunReplayCommand {
  return { projectId: P, issueId: I, priorRunId: RUN, evidenceManifestId: M, runId: NEW_RUN,
    idempotencyKey: K, requestHash: "r".repeat(64), procedure: PROCEDURE,
    executionContract: EXECUTION, environment: ENVIRONMENT, replayOf: RUN, ...overrides };
}
function runRow(overrides: Record<string, unknown> = {}) {
  return { id: RUN, schema_version: 1, issue_id: I, evidence_manifest_id: M, status: "RUNNING",
    procedure: PROCEDURE, execution_contract: EXECUTION, environment: ENVIRONMENT, output: null,
    knowledge_cutoff: BEFORE, replay_of: null, started_at: BEFORE, completed_at: null, created_at: BEFORE, ...overrides };
}
function scopeRow(overrides: Record<string, unknown> = {}) {
  return { project_id: P, project_name: "Project", project_state: "ACTIVE",
    project_created_at: BEFORE, project_updated_at: BEFORE,
    issue_id: I, issue_title: "Question", issue_question: "When?", issue_state: "OPEN",
    issue_created_at: BEFORE, issue_updated_at: BEFORE, current_resolution_id: null,
    issue_binding_id: OTHER, owner_project_id: P, issue_binding_role: null, issue_binding_metadata: {},
    issue_binding_created_at: BEFORE, ...overrides };
}
function claimRow() {
  return { relation_issue_id: I, relation_claim_id: CLAIM, claim_id: CLAIM,
    claim_statement: "Candidate", claim_state: "ACTIVE", claim_type: null,
    subject_type: null, subject_id: null, claim_metadata: {}, claim_created_at: BEFORE, claim_updated_at: BEFORE };
}
function manifestItemRow() {
  return { item_id: OTHER, manifest_id: M, ordinal: 1, role: "SUPPORTING", target_type: "SOURCE",
    target_id: OTHER, locator_type: null, locator: null, excerpt: null, note: null, created_at: BEFORE };
}
const manifestHash = buildEvidenceManifestDraft([{ role: "SUPPORTING", targetType: "SOURCE", targetId: OTHER, note: null }]).manifestSha256;
function manifestRow(overrides: Record<string, unknown> = {}) {
  return { id: M, schema_version: 1, purpose: "CLAIM_ASSESSMENT", manifest_sha256: manifestHash,
    metadata: {}, created_at: BEFORE, ...overrides };
}
function materialRow() {
  return { binding_id: OTHER, binding_created_at: BEFORE, binding_metadata: { sourceId: OTHER },
    edition_id: OTHER, work_title: "Book", source_id: OTHER, source_type: "DATABASE_RECORD",
    source_lifecycle: "ACTIVE", source_edition_id: OTHER, source_observed_at: BEFORE,
    asset_id: null, asset_type: null, asset_role: null, asset_storage_mode: null, asset_created_at: null,
    note_binding_id: null, note_binding_role: null, note_binding_metadata: null, note_id: null, note_type: null,
    note_lifecycle: null, note_current_revision_id: null, revision_id: null, revision_no: null,
    revision_content_format: null, revision_created_at: null };
}

type Row = Record<string, any>;
type State = { scope: Row; runs: Row[]; receipts: Row[]; claims: Row[]; assessments: Row[]; resolutions: Row[] };
type Faults = {
  scope?: Row; missingScope?: boolean; manifest?: Row | "missing"; items?: Row[];
  materials?: Row[]; claimInIssue?: boolean; assessments?: Row[]; resolutions?: Row[];
  runRows?: Row[]; readbackRun?: Row | "missing"; receipts?: "inProgress" | "conflict";
  failSql?: string; error?: Error; connectError?: Error; noteRevFound?: boolean;
};

function database(faults: Faults = {}) {
  const durable: State = { scope: { ...scopeRow(), ...faults.scope }, runs: faults.runRows ?? [], receipts: [], claims: [], assessments: [], resolutions: [] };
  let tx: State | null = null;
  let attempt = 0;
  const calls: Array<{ sql: string; params: any[] }> = [];
  const query = vi.fn(async (text: string, params: any[] = []) => {
    const sql = text.replace(/\s+/g, " ").trim(); calls.push({ sql, params });
    if (sql.startsWith("BEGIN")) { attempt++; tx = structuredClone(durable); return { rows: [], rowCount: 0 }; }
    if (faults.failSql && sql.includes(faults.failSql) && attempt <= 2) throw faults.error;
    if (sql === "ROLLBACK") { tx = null; return { rows: [], rowCount: 0 }; }
    if (sql === "COMMIT") { Object.assign(durable, structuredClone(tx)); tx = null; return { rows: [], rowCount: 0 }; }
    if (!tx) throw new Error("query outside transaction");

    if (sql.startsWith("INSERT INTO ops.idempotency_keys")) {
      expect(sql).toContain("ON CONFLICT(scope,idempotency_key) DO NOTHING");
      const existing = tx.receipts.find(r => r.scope === params[1] && r.idempotency_key === params[2]);
      if (existing) {
        if (faults.receipts === "conflict") { existing.request_hash = "different-hash"; }
        return { rows: [], rowCount: 0 };
      }
      tx.receipts.push({ id: params[0], scope: params[1], idempotency_key: params[2], request_hash: params[3],
        status: faults.receipts === "inProgress" ? "IN_PROGRESS" : "COMPLETED_PLACEHOLDER",
        resource_type: null, resource_id: null, result_payload: null });
      if (faults.receipts === "inProgress") {
        // simulate a pre-existing IN_PROGRESS receipt owned by someone else
        tx.receipts[tx.receipts.length - 1].status = "IN_PROGRESS";
      }
      return { rows: [{ id: params[0] }], rowCount: 1 };
    }
    if (sql.includes("FROM ops.idempotency_keys")) {
      expect(sql).toContain("FOR UPDATE");
      const found = tx.receipts.filter(r => r.scope === params[0] && r.idempotency_key === params[1]);
      if (!found.length) return { rows: [] };
      const r = found[0];
      // A receipt becomes COMPLETED only through the UPDATE below; the SELECT
      // returns its current state.
      return { rows: [r.status === "COMPLETED" ? { ...r, completed_at: NOW, updated_at: NOW } : r] };
    }
    if (sql === "SELECT id FROM core.projects WHERE id=$1 FOR UPDATE") return { rows: faults.missingScope ? [] : [{ id: P }] };
    if (sql === "SELECT id FROM core.research_issues WHERE id=$1 FOR UPDATE") return { rows: [{ id: I }] };
    if (sql.includes("FROM core.projects p")) {
      expect(params).toEqual([P, I]);
      return { rows: faults.missingScope ? [] : [tx.scope] };
    }
    if (sql.includes("FROM core.evidence_manifests")) {
      expect(params).toEqual([M]);
      if (faults.manifest === "missing") return { rows: [] };
      return { rows: [manifestRow(typeof faults.manifest === "object" ? faults.manifest : {})] };
    }
    if (sql.includes("FROM core.evidence_manifest_items")) {
      expect(params).toEqual([M]);
      return { rows: faults.items ?? [manifestItemRow()] };
    }
    if (sql.includes("LEFT JOIN core.source_assets")) return { rows: faults.materials ?? [materialRow()] };
    if (sql.includes("FROM core.research_issue_claims")) {
      const [issueParam, claimParam] = params;
      const inIssue = faults.claimInIssue !== false && issueParam === I && tx.claims.some(c => c.claim_id === claimParam);
      return { rows: inIssue ? [claimRow()] : [] };
    }
    if (sql.includes("FROM core.assessments")) {
      return { rows: faults.assessments ?? [] };
    }
    if (sql.includes("FROM core.issue_resolutions") && sql.includes("ANY")) {
      return { rows: faults.resolutions ?? [] };
    }
    if (sql.includes("FROM core.note_revisions")) {
      return { rows: faults.noteRevFound === false ? [] : [{ revision_id: NOTEREV }] };
    }
    if (sql.startsWith("INSERT INTO core.research_runs")) {
      const knowledgeCutoff = params[6];
      const replayOf = params[7];
      tx.runs.push({ id: params[0], schema_version: 1, issue_id: params[1], evidence_manifest_id: params[2],
        status: "RUNNING", procedure: JSON.parse(params[3]), execution_contract: JSON.parse(params[4]),
        environment: JSON.parse(params[5]), output: null, knowledge_cutoff: knowledgeCutoff,
        replay_of: replayOf, started_at: NOW, completed_at: null, created_at: NOW });
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE core.research_runs SET status=$2")) {
      const run = tx.runs.find(r => r.id === params[0] && r.status === "RUNNING");
      if (!run) return { rows: [], rowCount: 0 };
      run.status = params[1];
      run.output = params[2] === null ? null : JSON.parse(params[2]);
      run.completed_at = NOW;
      return { rows: [{ id: params[0] }], rowCount: 1 };
    }
    if (sql.includes("FROM core.research_runs")) {
      // SELECT ... WHERE id=$1 [AND issue_id=$2 / FOR UPDATE]
      const id = params[0];
      let rows = tx.runs.filter(r => r.id === id);
      if (params.length > 1) rows = rows.filter(r => r.issue_id === params[1]);
      if (faults.readbackRun === "missing" && !rows.some(r => r.status !== "RUNNING")) return { rows: [] };
      if (typeof faults.readbackRun === "object" && rows.length) return { rows: [{ ...rows[0], ...faults.readbackRun }] };
      return { rows };
    }
    if (sql.startsWith("UPDATE ops.idempotency_keys")) {
      const r = tx.receipts.find(r => r.id === params[0]);
      Object.assign(r!, { status: "COMPLETED", resource_type: "RESEARCH_RUN", resource_id: params[1],
        result_payload: JSON.parse(params[2]), completed_at: NOW, updated_at: NOW });
      return { rows: [{ ...r }], rowCount: 1 };
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

async function rejectsClean(pool: Pool, error: new (...args: any[]) => Error, fn: () => Promise<unknown>) {
  const db = pool as unknown as ReturnType<typeof database>;
  const before = structuredClone(db.durable);
  await expect(fn).rejects.toBeInstanceOf(error);
  expect(db.durable).toEqual(before);
}

// Seed a durable claim membership for produced-reference tests.
function withClaim(db: ReturnType<typeof database>) {
  db.durable.claims.push({ claim_id: CLAIM });
}

it("START: normal create writes canonical RUNNING run + COMPLETED receipt", async () => {
  const db = database();
  const result = await factory(db.pool).start(startCommand());
  expect(result).toEqual({ status: "created", runId: RUN });
  const run = db.durable.runs[0];
  expect(run).toMatchObject({ id: RUN, schema_version: 1, issue_id: I, evidence_manifest_id: M, status: "RUNNING", replay_of: null, completed_at: null });
  expect(run.procedure).toEqual(PROCEDURE);
  expect(run.execution_contract).toEqual(EXECUTION);
  expect(run.environment).toEqual(ENVIRONMENT);
  expect(db.durable.receipts[0]).toMatchObject({ scope: `S32:M3A:RESEARCH_RUN_START:${P}:${I}`,
    status: "COMPLETED", resource_type: "RESEARCH_RUN", resource_id: RUN, result_payload: { runId: RUN } });
  expect(db.calls[0].sql).toBe("BEGIN ISOLATION LEVEL SERIALIZABLE");
  expect(db.calls.at(-1)?.sql).toBe("COMMIT");
});

it("START: same-key completed replay returns original run; no second row", async () => {
  const db = database();
  const store = factory(db.pool);
  const first = await store.start(startCommand());
  const second = await store.start(startCommand());
  expect(first).toEqual({ status: "created", runId: RUN });
  expect(second).toEqual({ status: "replayed", runId: RUN });
  expect(db.durable.runs).toHaveLength(1);
  expect(db.durable.receipts).toHaveLength(1);
});

it("START: same-key different request hash → IDEMPOTENCY_CONFLICT, durable unchanged", async () => {
  const db = database();
  const store = factory(db.pool);
  await store.start(startCommand());
  const before = structuredClone(db.durable);
  await expect(store.start(startCommand({ requestHash: "x".repeat(64) })))
    .rejects.toBeInstanceOf(errors.ResearchRunIdempotencyConflictError);
  expect(db.durable).toEqual(before);
});

it("START: foreign project / nonexistent issue → privacy-safe scope error", async () => {
  const db = database({ missingScope: true });
  await rejectsClean(db.pool, errors.ResearchRunScopeNotFoundError, () => factory(db.pool).start(startCommand()));
});

it("START: archived Project → PROJECT_READ_ONLY", async () => {
  const db = database({ scope: { project_state: "ARCHIVED" } });
  await rejectsClean(db.pool, errors.ProjectReadOnlyForResearchRunError, () => factory(db.pool).start(startCommand()));
});

it("START: ARCHIVED Issue → RESEARCH_ISSUE_READ_ONLY", async () => {
  const db = database({ scope: { issue_state: "ARCHIVED" } });
  await rejectsClean(db.pool, errors.ResearchIssueReadOnlyForResearchRunError, () => factory(db.pool).start(startCommand()));
});

it("START: RESOLVED Issue remains writable", async () => {
  const db = database({ scope: { issue_state: "RESOLVED" } });
  const result = await factory(db.pool).start(startCommand());
  expect(result.status).toBe("created");
});

it("START: missing evidence manifest → EVIDENCE_MANIFEST_NOT_AVAILABLE", async () => {
  const db = database({ manifest: "missing" });
  await rejectsClean(db.pool, errors.ResearchRunEvidenceNotAvailableError, () => factory(db.pool).start(startCommand()));
});

it("START: corrupt manifest hash → integrity error", async () => {
  const db = database({ manifest: { manifest_sha256: "0".repeat(64) } });
  await rejectsClean(db.pool, errors.ResearchRunIntegrityError, () => factory(db.pool).start(startCommand()));
});

it("START: manifest item not authorized for project → evidence unavailable", async () => {
  const db = database({ materials: [] });
  await rejectsClean(db.pool, errors.ResearchRunEvidenceNotAvailableError, () => factory(db.pool).start(startCommand()));
});

it("transition: RUNNING → SUCCEEDED with output; semantic fields unchanged", async () => {
  const db = database({ runRows: [runRow()] });
  const result = await factory(db.pool).transition(transitionCommand(), "RUNNING");
  expect(result).toEqual({ status: "created", runId: RUN });
  const run = db.durable.runs[0];
  expect(run.status).toBe("SUCCEEDED");
  expect(run.output).toEqual(OUTPUT);
  expect(run.completed_at).toEqual(NOW);
  expect(run.procedure).toEqual(PROCEDURE);
  expect(run.issue_id).toBe(I);
  expect(run.evidence_manifest_id).toBe(M);
  expect(run.started_at).toEqual(BEFORE);
  expect(db.calls.some(c => c.sql.startsWith("UPDATE core.research_runs") && c.sql.includes("AND status='RUNNING'"))).toBe(true);
});

it("transition: RUNNING → FAILED with null output; → CANCELLED null output", async () => {
  const db = database({ runRows: [runRow()] });
  const store = factory(db.pool);
  await store.transition(transitionCommand({ status: "FAILED", output: null, requestHash: "f".repeat(64) }), "RUNNING");
  expect(db.durable.runs[0]).toMatchObject({ status: "FAILED", output: null });
  const db2 = database({ runRows: [runRow()] });
  await factory(db2.pool).transition(transitionCommand({ status: "CANCELLED", output: null, requestHash: "c".repeat(64) }), "RUNNING");
  expect(db2.durable.runs[0]).toMatchObject({ status: "CANCELLED", output: null });
});

it("transition: terminal run → AlreadyTerminal; original idempotency receipt still replays", async () => {
  const db = database({ runRows: [runRow({ status: "SUCCEEDED", output: OUTPUT, completed_at: NOW })] });
  const store = factory(db.pool);
  // Different idempotency key, run already terminal → reject.
  await rejectsClean(db.pool, errors.ResearchRunAlreadyTerminalError,
    () => store.transition(transitionCommand({ idempotencyKey: OTHER }), "RUNNING"));
});

it("transition: completed receipt replay BEFORE later lifecycle gate (project archived after completion)", async () => {
  // Run already SUCCEEDED with receipt COMPLETED; project has since archived.
  const db = database({
    scope: { project_state: "ARCHIVED" },
    runRows: [runRow({ status: "SUCCEEDED", output: OUTPUT, completed_at: NOW })],
  });
  const store = factory(db.pool);
  // First transition completes and archives the receipt.
  const first = await (async () => {
    const dbOk = database({ runRows: [runRow()] });
    const s = factory(dbOk.pool);
    return { result: await s.transition(transitionCommand(), "RUNNING"), db: dbOk };
  })();
  expect(first.result).toEqual({ status: "created", runId: RUN });
  // Now replay the SAME key against the archived-scope db seeded with the receipt.
  const db2 = database({ scope: { project_state: "ARCHIVED" }, runRows: [runRow({ status: "SUCCEEDED", output: OUTPUT, completed_at: NOW })] });
  db2.durable.receipts.push({ id: OTHER, scope: `S32:M3A:RESEARCH_RUN_SUCCEEDED:${P}:${I}:${RUN}`,
    idempotency_key: K, request_hash: "t".repeat(64), status: "COMPLETED",
    resource_type: "RESEARCH_RUN", resource_id: RUN, result_payload: { runId: RUN } });
  const replayed = await factory(db2.pool).transition(transitionCommand(), "RUNNING");
  expect(replayed).toEqual({ status: "replayed", runId: RUN });
});

it("transition: nonexistent run → not found", async () => {
  const db = database({ runRows: [] });
  await rejectsClean(db.pool, errors.ResearchRunNotFoundError, () => factory(db.pool).transition(transitionCommand(), "RUNNING"));
});

it("produced refs: claim in exact issue passes; foreign claim rejected", async () => {
  const ok = database({ runRows: [runRow()] });
  withClaim(ok);
  const out = { ...OUTPUT, produced: { ...OUTPUT.produced, claimIds: [CLAIM] } } as typeof OUTPUT;
  await factory(ok.pool).transition(transitionCommand({ output: out }), "RUNNING");
  expect(ok.durable.runs[0].status).toBe("SUCCEEDED");

  const foreign = database({ runRows: [runRow()], claimInIssue: false });
  withClaim(foreign);
  await rejectsClean(foreign.pool, errors.ResearchRunIntegrityError,
    () => factory(foreign.pool).transition(transitionCommand({ output: out }), "RUNNING"));
});

it("produced refs: foreign assessment (claim not in issue) rejected; dangling rejected", async () => {
  const foreign = database({
    runRows: [runRow()],
    assessments: [{ assessment_id: ASSESS, claim_id: OTHER }],
  });
  withClaim(foreign);
  const out = { ...OUTPUT, produced: { ...OUTPUT.produced, assessmentIds: [ASSESS] } } as typeof OUTPUT;
  await rejectsClean(foreign.pool, errors.ResearchRunIntegrityError,
    () => factory(foreign.pool).transition(transitionCommand({ output: out }), "RUNNING"));

  const dangling = database({ runRows: [runRow()], assessments: [] });
  await rejectsClean(dangling.pool, errors.ResearchRunIntegrityError,
    () => factory(dangling.pool).transition(transitionCommand({ output: out }), "RUNNING"));
});

it("produced refs: foreign resolution rejected; in-issue resolution passes", async () => {
  const out = { ...OUTPUT, produced: { ...OUTPUT.produced, resolutionIds: [RESOL] } } as typeof OUTPUT;
  const foreign = database({ runRows: [runRow()], resolutions: [{ id: RESOL, issue_id: OTHER }] });
  await rejectsClean(foreign.pool, errors.ResearchRunIntegrityError,
    () => factory(foreign.pool).transition(transitionCommand({ output: out }), "RUNNING"));

  const ok = database({ runRows: [runRow()], resolutions: [{ id: RESOL, issue_id: I }] });
  await factory(ok.pool).transition(transitionCommand({ output: out }), "RUNNING");
  expect(ok.durable.runs[0].status).toBe("SUCCEEDED");
});

it("produced refs: dangling note revision rejected; accessible passes", async () => {
  const out = { ...OUTPUT, produced: { ...OUTPUT.produced, noteRevisionIds: [NOTEREV] } } as typeof OUTPUT;
  const dangling = database({ runRows: [runRow()], noteRevFound: false, materials: [] });
  await rejectsClean(dangling.pool, errors.ResearchRunIntegrityError,
    () => factory(dangling.pool).transition(transitionCommand({ output: out }), "RUNNING"));
});

it("REPLAY: terminal prior → new RUNNING run with replay_of, prior untouched", async () => {
  const prior = runRow({ status: "SUCCEEDED", output: OUTPUT, completed_at: NOW });
  const db = database({ runRows: [prior] });
  const result = await factory(db.pool).replay(replayCommand());
  expect(result).toEqual({ status: "created", runId: NEW_RUN });
  expect(db.durable.runs).toHaveLength(2);
  const priorAfter = db.durable.runs.find(r => r.id === RUN)!;
  const priorBefore = { ...prior };
  expect(priorAfter).toEqual({ ...priorBefore, knowledge_cutoff: priorBefore.knowledge_cutoff });
  const fresh = db.durable.runs.find(r => r.id === NEW_RUN)!;
  expect(fresh).toMatchObject({ status: "RUNNING", replay_of: RUN, issue_id: I, completed_at: null });
  // No UPDATE ever touched the prior run id.
  const priorUpdates = db.calls.filter(c => c.sql.startsWith("UPDATE core.research_runs") && c.params[0] === RUN);
  expect(priorUpdates).toHaveLength(0);
});

it("REPLAY: RUNNING prior rejected; foreign prior rejected; missing prior rejected", async () => {
  const running = database({ runRows: [runRow()] });
  await rejectsClean(running.pool, errors.ResearchRunReplayInvalidError, () => factory(running.pool).replay(replayCommand()));

  const foreign = database({ runRows: [runRow({ status: "SUCCEEDED", completed_at: NOW, issue_id: OTHER })] });
  await rejectsClean(foreign.pool, errors.ResearchRunReplayInvalidError, () => factory(foreign.pool).replay(replayCommand()));

  const missing = database({ runRows: [] });
  await rejectsClean(missing.pool, errors.ResearchRunReplayInvalidError, () => factory(missing.pool).replay(replayCommand()));
});

it("REPLAY: same-key replay returns same new run; different request conflicts", async () => {
  const db = database({ runRows: [runRow({ status: "SUCCEEDED", output: OUTPUT, completed_at: NOW })] });
  const store = factory(db.pool);
  const first = await store.replay(replayCommand());
  const second = await store.replay(replayCommand());
  expect(second).toEqual({ status: "replayed", runId: NEW_RUN });
  expect(db.durable.runs).toHaveLength(2);
  const before = structuredClone(db.durable);
  await expect(store.replay(replayCommand({ requestHash: "z".repeat(64) })))
    .rejects.toBeInstanceOf(errors.ResearchRunIdempotencyConflictError);
  expect(db.durable).toEqual(before);
});

it("integrity: corrupt persisted run row fails closed", async () => {
  const corrupt = database({ runRows: [runRow({ procedure: { version: 2 } })] });
  await rejectsClean(corrupt.pool, errors.ResearchRunIntegrityError,
    () => factory(corrupt.pool).transition(transitionCommand(), "RUNNING"));
});

it("unavailable: connection error → store unavailable; SERIALIZABLE retry on 40001 then success", async () => {
  const db = database({ connectError: Object.assign(new Error("refused"), { code: "ECONNREFUSED" }) });
  await expect(factory(db.pool).start(startCommand())).rejects.toBeInstanceOf(errors.ResearchRunStoreUnavailableError);

  const conflict = Object.assign(new Error("serialization"), { code: "40001" });
  const db2 = database({ failSql: "INSERT INTO core.research_runs", error: conflict });
  const result = await factory(db2.pool).start(startCommand());
  expect(result.status).toBe("created");
  expect(db2.durable.runs).toHaveLength(1);
});
