import { existsSync } from "node:fs";
import { expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import * as errors from "../application/research-runs.js";
import { buildEvidenceManifestDraft } from "../domain/evidence-selection.js";
import { encodeResearchRunCursor } from "../domain/research-run.js";

const modulePath = "./research-run-read-store.js";
const implementation = existsSync(new URL("./research-run-read-store.ts", import.meta.url))
  ? await import(modulePath) : {};
function factory(pool: Pool): errors.ResearchRunReadStore {
  expect(implementation.createPostgresResearchRunReadStore, "missing read-store contract").toBeTypeOf("function");
  return implementation.createPostgresResearchRunReadStore(pool);
}

const P = "11111111-1111-4111-8111-111111111111";
const I = "22222222-2222-4222-8222-222222222222";
const RUN1 = "33333333-3333-4333-8333-333333333333";
const RUN2 = "44444444-4444-4444-8444-444444444444";
const RUN3 = "55555555-5555-4555-8555-555555555555";
const M = "66666666-6666-4666-8666-666666666666";
const CLAIM = "77777777-7777-4777-8777-777777777777";
const ASSESS = "88888888-8888-4888-8888-888888888888";
const RESOL = "99999999-9999-4999-8999-999999999999";
const NOTEREV = "aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbb1-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SRC = "0ccccc1c-cccc-4ccc-8ccc-cccccccccccc";
const BEFORE = new Date("2026-01-01T00:00:00Z");
const T1 = new Date("2026-09-30T01:00:00.123456Z");
const T2 = new Date("2026-09-30T02:00:00.123456Z");
const T3 = new Date("2026-09-30T03:00:00.123456Z");
const MICROS = (d: Date) => String(BigInt(Math.floor(d.getTime() * 1000)) + BigInt(456));

const PROCEDURE = { version: 1 as const, objective: "梳理古道", method: "文献比对", steps: [{ kind: "SEARCH", description: "检索" }] };
const EXECUTION = { version: 1 as const, mode: "HUMAN", reproducibilityLevel: "PROCEDURE", tools: [] };
const ENVIRONMENT = { locale: "zh-CN" };
const OUTPUT = { version: 1 as const, summary: "完成。", produced: { claimIds: [], assessmentIds: [], resolutionIds: [], noteRevisionIds: [] }, gaps: [] };
const OUTPUT_WITH_REFS = { version: 1 as const, summary: "完成。", produced: { claimIds: [CLAIM], assessmentIds: [], resolutionIds: [], noteRevisionIds: [] }, gaps: [] } as typeof OUTPUT;

const manifestHash = buildEvidenceManifestDraft([{ role: "SUPPORTING", targetType: "SOURCE", targetId: SRC, note: null }]).manifestSha256;
const noteRevManifestHash = buildEvidenceManifestDraft([{ role: "SUPPORTING", targetType: "NOTE_REVISION", targetId: NOTEREV, note: null }]).manifestSha256;

function runRow(overrides: Record<string, unknown> = {}) {
  return { id: RUN1, schema_version: 1, issue_id: I, evidence_manifest_id: M, status: "RUNNING",
    procedure: PROCEDURE, execution_contract: EXECUTION, environment: ENVIRONMENT, output: null,
    knowledge_cutoff: BEFORE, replay_of: null, started_at: T1, completed_at: null, created_at: BEFORE,
    started_at_micros: MICROS(T1), ...overrides };
}
function scopeRow(overrides: Record<string, unknown> = {}) {
  return { project_id: P, project_name: "Project", project_state: "ACTIVE",
    project_created_at: BEFORE, project_updated_at: BEFORE,
    issue_id: I, issue_title: "Question", issue_question: "When?", issue_state: "OPEN",
    issue_created_at: BEFORE, issue_updated_at: BEFORE, current_resolution_id: null,
    issue_binding_id: OTHER, owner_project_id: P, issue_binding_role: null, issue_binding_metadata: {},
    issue_binding_created_at: BEFORE, ...overrides };
}
function manifestItemRow() {
  return { item_id: OTHER, manifest_id: M, ordinal: 1, role: "SUPPORTING", target_type: "SOURCE",
    target_id: SRC, locator_type: null, locator: null, excerpt: null, note: null, created_at: BEFORE };
}
const EDITION = "3333333a-3333-4333-8333-33333333333a";
const WORK = "4444444a-4444-4444-8444-44444444444a";
function materialRow(overrides: Record<string, unknown> = {}) {
  return { binding_id: OTHER, binding_created_at: BEFORE, binding_metadata: { sourceId: SRC },
    edition_id: EDITION, work_title: "Book", source_id: SRC, source_type: "DATABASE_RECORD",
    source_lifecycle: "ACTIVE", source_edition_id: EDITION, source_observed_at: BEFORE,
    asset_id: null, asset_type: null, asset_role: null, asset_storage_mode: null, asset_created_at: null,
    note_binding_id: null, note_binding_role: null, note_binding_metadata: null, note_id: null, note_type: null,
    note_lifecycle: null, note_current_revision_id: null, revision_id: null, revision_no: null,
    revision_content_format: null, revision_created_at: null, ...overrides };
}

type Row = Record<string, any>;
type Faults = {
  scope?: Row; missingScope?: boolean; runs?: Row[]; manifests?: Row | "missing"; items?: Row[];
  materials?: Row[]; claimRows?: Row[]; assessmentRows?: Row[]; resolutionRows?: Row[];
  noteRevRows?: Row[]; connectError?: Error;
};
function database(faults: Faults = {}) {
  const state = {
    scope: { ...scopeRow(), ...faults.scope },
    runs: faults.runs ?? [],
    claimRows: faults.claimRows ?? [],
    assessmentRows: faults.assessmentRows ?? [],
    resolutionRows: faults.resolutionRows ?? [],
    noteRevRows: faults.noteRevRows ?? [{ revision_id: NOTEREV }],
  };
  const sqls: string[] = [];
  const query = vi.fn(async (text: string, params: any[] = []) => {
    const sql = text.replace(/\s+/g, " ").trim(); sqls.push(sql);
    if (sql === "BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY") return { rows: [], rowCount: 0 };
    if (sql === "COMMIT" || sql === "ROLLBACK") return { rows: [], rowCount: 0 };
    if (sql.includes("FROM core.projects p")) {
      return { rows: faults.missingScope ? [] : [state.scope] };
    }
    if (sql.includes("SELECT 1 FROM core.research_runs WHERE id=$1")) {
      return { rows: state.runs.some(r => r.id === params[0]) ? [{}] : [] };
    }
    if (sql.includes("FROM core.research_runs")) {
      let rows = [...state.runs];
      if (sql.includes("AND issue_id = $2")) rows = rows.filter(r => r.id === params[0] && r.issue_id === params[1]);
      else if (sql.includes("ORDER BY started_at DESC")) {
        // history query: issue filter + keyset + limit
        rows = rows.filter(r => r.issue_id === params[0]);
        const cursorMicros = params[1];
        if (cursorMicros !== null) {
          const cursorId = params[2];
          rows = rows.filter(r => (r.started_at_micros < cursorMicros) || (r.started_at_micros === cursorMicros && r.id < cursorId));
        }
        rows.sort((a, b) => b.started_at_micros.localeCompare(a.started_at_micros) || b.id.localeCompare(a.id));
        rows = rows.slice(0, params[3]);
      } else if (sql.includes("WHERE id=$1")) {
        rows = rows.filter(r => r.id === params[0]);
      }
      return { rows: rows.map(r => ({ ...r })) };
    }
    if (sql.includes("FROM core.evidence_manifests")) {
      if (faults.manifests === "missing") return { rows: [] };
      const base = { id: M, schema_version: 1, purpose: "CLAIM_ASSESSMENT", manifest_sha256: manifestHash,
        metadata: {}, created_at: BEFORE };
      const row = typeof faults.manifests === "object" ? { ...base, ...faults.manifests } : base;
      // ANY($1) 查询按 manifestIds 过滤(ancestry 多级时 manifest 不同行)
      const ids = Array.isArray(params[0]) ? params[0] : [M];
      return { rows: ids.includes(row.id) ? [row] : [] };
    }
    if (sql.includes("FROM core.evidence_manifest_items")) {
      return { rows: faults.items ?? [manifestItemRow()] };
    }
    if (sql.includes("LEFT JOIN core.source_assets")) return { rows: faults.materials ?? [materialRow()] };
    if (sql.includes("FROM core.research_issue_claims")) {
      if (params[0] !== I) return { rows: [] };
      const wanted = Array.isArray(params[1]) ? params[1] : null;
      return { rows: state.claimRows.filter(r => !wanted || wanted.includes(r.claim_id)) };
    }
    if (sql.includes("FROM core.assessments")) {
      return { rows: state.assessmentRows };
    }
    if (sql.includes("FROM core.issue_resolutions")) {
      return { rows: state.resolutionRows };
    }
    if (sql.includes("FROM core.note_revisions")) {
      return { rows: state.noteRevRows };
    }
    throw new Error("Unexpected read query: " + sql);
  });
  const release = vi.fn();
  const connect = vi.fn(async () => {
    if (faults.connectError) throw faults.connectError;
    return { query, release } as unknown as PoolClient;
  });
  return { pool: { connect } as unknown as Pool, state, sqls, query, release, connect };
}

function listCmd(overrides: Record<string, unknown> = {}) {
  return { projectId: P, issueId: I, limit: 20, cursor: null, ...overrides };
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

it("history: empty list → runs=[] nextCursor=null", async () => {
  const db = database();
  const result = await factory(db.pool).list(listCmd());
  expect(result).toEqual({ kind: "ok", value: { runs: [], nextCursor: null } });
});

it("history: multiple runs ordered started_at DESC, id DESC; keyset pagination exact microseconds", async () => {
  const db = database({
    runs: [
      runRow({ id: RUN1, started_at: T1, started_at_micros: MICROS(T1) }),
      runRow({ id: RUN2, started_at: T2, started_at_micros: MICROS(T2) }),
      runRow({ id: RUN3, started_at: T3, started_at_micros: MICROS(T3) }),
    ],
  });
  const store = factory(db.pool);
  const page1 = await store.list(listCmd({ limit: 2 }));
  if (page1.kind !== "ok") throw new Error("expected ok");
  expect(page1.value.runs.map(r => r.runId)).toEqual([RUN3, RUN2]);
  expect(page1.value.nextCursor).not.toBeNull();
  // Cursor encodes the exact last row micros + id.
  const decoded = JSON.parse(Buffer.from(page1.value.nextCursor!, "base64url").toString("utf8"));
  expect(decoded).toEqual({ v: 1, startedAtMicros: MICROS(T2), id: RUN2 });
  const page2 = await store.list(listCmd({ limit: 2, cursor: page1.value.nextCursor }));
  if (page2.kind !== "ok") throw new Error("expected ok");
  expect(page2.value.runs.map(r => r.runId)).toEqual([RUN1]);
  expect(page2.value.nextCursor).toBeNull();
});

it("history: same timestamp rows tie-break by id DESC; cursor rounds correctly", async () => {
  const same = MICROS(T2);
  const db = database({
    runs: [
      runRow({ id: RUN1, started_at: T2, started_at_micros: same }),
      runRow({ id: RUN3, started_at: T2, started_at_micros: same }),
      runRow({ id: RUN2, started_at: T2, started_at_micros: same }),
    ],
  });
  const store = factory(db.pool);
  const page1 = await store.list(listCmd({ limit: 2 }));
  if (page1.kind !== "ok") throw new Error("expected ok");
  // id DESC among identical timestamps: RUN3 > RUN2 > RUN1
  expect(page1.value.runs.map(r => r.runId)).toEqual([RUN3, RUN2]);
  const page2 = await store.list(listCmd({ limit: 2, cursor: page1.value.nextCursor }));
  if (page2.kind !== "ok") throw new Error("expected ok");
  expect(page2.value.runs.map(r => r.runId)).toEqual([RUN1]);
});

it("history: malformed cursor rejects via domain decoder; limit bounds enforced at application layer", async () => {
  const db = database({ runs: [runRow()] });
  const store = factory(db.pool);
  await expect(store.list(listCmd({ cursor: "!!!not-base64!!!" }))).rejects.toThrow();
  await expect(store.list(listCmd({ cursor: Buffer.from("garbage").toString("base64url") }))).rejects.toThrow();
});

it("history: limit 1 and 100 work", async () => {
  const db = database({ runs: [runRow()] });
  const store = factory(db.pool);
  const one = await store.list(listCmd({ limit: 1 }));
  expect(one.kind).toBe("ok");
  const hundred = await store.list(listCmd({ limit: 100 }));
  expect(hundred.kind).toBe("ok");
});

it.each([
  ["ACTIVE project / OPEN issue", {}],
  ["ARCHIVED project readable", { project_state: "ARCHIVED" }],
  ["RESOLVED issue readable", { issue_state: "RESOLVED" }],
  ["ARCHIVED issue readable", { issue_state: "ARCHIVED" }],
])("history: %s", async (_label, scopeOverride) => {
  const db = database({ scope: scopeOverride, runs: [runRow()] });
  const result = await factory(db.pool).list(listCmd());
  expect(result.kind).toBe("ok");
});

it("history: foreign/nonexistent scope → privacy-equivalent scope-missing", async () => {
  const db = database({ missingScope: true });
  const result = await factory(db.pool).list(listCmd());
  expect(result).toEqual({ kind: "scope-missing" });
});

// ---------------------------------------------------------------------------
// Canonical rows
// ---------------------------------------------------------------------------

it.each([
  ["RUNNING", { status: "RUNNING", output: null, completed_at: null }],
  ["SUCCEEDED", { status: "SUCCEEDED", output: OUTPUT, completed_at: T2 }],
  ["FAILED", { status: "FAILED", output: null, completed_at: T2 }],
  ["CANCELLED", { status: "CANCELLED", output: OUTPUT, completed_at: T2 }],
])("detail: %s canonical row reads", async (_label, overrides) => {
  const db = database({ runs: [runRow(overrides)] });
  const result = await factory(db.pool).get({ projectId: P, issueId: I, runId: RUN1 });
  if (result.kind !== "ok") throw new Error("expected ok");
  expect(result.value.run.status).toBe(overrides.status);
  expect(result.value.ancestors).toEqual([]);
});

it.each([
  ["RUNNING with output", { status: "RUNNING", output: OUTPUT, completed_at: null }],
  ["terminal missing completed_at", { status: "SUCCEEDED", output: OUTPUT, completed_at: null }],
  ["SUCCEEDED null output", { status: "SUCCEEDED", output: null, completed_at: T2 }],
  ["corrupt procedure JSON", { procedure: { version: 9 } }],
  ["replay_of self link", { replay_of: RUN1 }],
])("detail: %s rejects", async (_label, overrides) => {
  const db = database({ runs: [runRow(overrides)] });
  await expect(factory(db.pool).get({ projectId: P, issueId: I, runId: RUN1 }))
    .rejects.toBeInstanceOf(errors.ResearchRunIntegrityError);
});

it("detail: wrong issue_id → privacy-safe not-visible (row filtered at SQL level)", async () => {
  const db = database({ runs: [runRow({ issue_id: OTHER })] });
  const result = await factory(db.pool).get({ projectId: P, issueId: I, runId: RUN1 });
  expect(result).toEqual({ kind: "not-visible" });
});

it("detail: normal get returns full record + evidence snapshot", async () => {
  const db = database({ runs: [runRow()] });
  const result = await factory(db.pool).get({ projectId: P, issueId: I, runId: RUN1 });
  if (result.kind !== "ok") throw new Error("expected ok");
  const { run, evidenceManifest, ancestors } = result.value;
  expect(run.runId).toBe(RUN1);
  expect(run.projectId).toBe(P);
  expect(run.procedure).toEqual(PROCEDURE);
  expect(run.environment).toEqual(ENVIRONMENT);
  expect(run.knowledgeCutoff).toBeTypeOf("string");
  expect(evidenceManifest).toMatchObject({ id: M, manifestSha256: manifestHash, itemCount: 1, available: true });
  expect(evidenceManifest.items).toHaveLength(1);
  expect(ancestors).toEqual([]);
});

it("detail: foreign run ≡ nonexistent (privacy-safe) — both not-visible/not-found", async () => {
  const nonexistent = database({ runs: [] });
  const r1 = await factory(nonexistent.pool).get({ projectId: P, issueId: I, runId: RUN1 });
  expect(r1).toEqual({ kind: "not-found" });

  // run exists but belongs to another issue: detail query filters issue_id.
  const foreign = database({ runs: [runRow({ issue_id: OTHER })] });
  const r2 = await factory(foreign.pool).get({ projectId: P, issueId: I, runId: RUN1 });
  expect(r2).toEqual({ kind: "not-visible" });
});

// ---------------------------------------------------------------------------
// Evidence snapshot
// ---------------------------------------------------------------------------

it("evidence: hash mismatch → integrity error", async () => {
  const db = database({ runs: [runRow()], manifests: { manifest_sha256: "0".repeat(64) } });
  await expect(factory(db.pool).get({ projectId: P, issueId: I, runId: RUN1 }))
    .rejects.toBeInstanceOf(errors.ResearchRunIntegrityError);
});

it("evidence: unauthorized evidence → run visible, available=false, NO target leakage", async () => {
  const db = database({ runs: [runRow()], materials: [] }); // no sources authorized
  const result = await factory(db.pool).get({ projectId: P, issueId: I, runId: RUN1 });
  if (result.kind !== "ok") throw new Error("expected ok");
  expect(result.value.run.runId).toBe(RUN1); // run stays visible
  expect(result.value.evidenceManifest.available).toBe(false);
  expect(result.value.evidenceManifest.items).toBeUndefined(); // no details
  expect(JSON.stringify(result.value.evidenceManifest)).not.toContain(SRC);
  expect(JSON.stringify(result.value.evidenceManifest)).not.toContain(OTHER);
});

it("evidence: historical NoteRevision on project-owned note remains available", async () => {
  // manifest targets a NOTE_REVISION that is NOT current but belongs to a project note
  const noteMaterial = materialRow({ note_binding_id: OTHER, note_binding_role: "ANNOTATION",
    note_binding_metadata: { subjectBindingId: OTHER, subjectType: "EDITION", subjectId: EDITION },
    note_id: "1111111a-1111-4111-8111-11111111111a", note_type: "PROJECT_ITEM_NOTE", note_lifecycle: "ACTIVE",
    note_current_revision_id: "2222222a-2222-4222-8222-22222222222a",
    revision_id: "2222222a-2222-4222-8222-22222222222a", revision_no: 2,
    revision_content_format: "MARKDOWN", revision_created_at: BEFORE });
  const db = database({
    runs: [runRow()],
    manifests: { manifest_sha256: noteRevManifestHash },
    items: [{ ...manifestItemRow(), target_type: "NOTE_REVISION", target_id: NOTEREV }],
    materials: [noteMaterial],
  });
  const result = await factory(db.pool).get({ projectId: P, issueId: I, runId: RUN1 });
  if (result.kind !== "ok") throw new Error("expected ok");
  expect(result.value.evidenceManifest.available).toBe(true);
  expect(result.value.evidenceManifest.items).toHaveLength(1);
});

// ---------------------------------------------------------------------------
// Replay lineage
// ---------------------------------------------------------------------------

it("replay: one parent — ancestors lists terminal prior as summary", async () => {
  const db = database({
    runs: [
      runRow({ id: RUN2, status: "SUCCEEDED", output: OUTPUT, completed_at: T2, started_at: T2, started_at_micros: MICROS(T2) }),
      runRow({ id: RUN1, replay_of: RUN2, started_at: T3, started_at_micros: MICROS(T3) }),
    ],
  });
  const result = await factory(db.pool).get({ projectId: P, issueId: I, runId: RUN1 });
  if (result.kind !== "ok") throw new Error("expected ok");
  expect(result.value.ancestors.map(a => a.runId)).toEqual([RUN2]);
  expect(result.value.ancestors[0].status).toBe("SUCCEEDED");
  expect(result.value.ancestors[0].evidenceManifest.available).toBe(true);
});

it("replay: multi-level ancestry oldest-first", async () => {
  const db = database({
    runs: [
      runRow({ id: RUN3, status: "FAILED", output: null, completed_at: T1, started_at: T1, started_at_micros: MICROS(T1) }),
      runRow({ id: RUN2, status: "SUCCEEDED", output: OUTPUT, completed_at: T2, started_at: T2, started_at_micros: MICROS(T2), replay_of: RUN3 }),
      runRow({ id: RUN1, replay_of: RUN2, started_at: T3, started_at_micros: MICROS(T3) }),
    ],
  });
  const result = await factory(db.pool).get({ projectId: P, issueId: I, runId: RUN1 });
  if (result.kind !== "ok") throw new Error("expected ok");
  expect(result.value.ancestors.map(a => a.runId)).toEqual([RUN3, RUN2]);
});

it.each([
  ["RUNNING parent", [
    runRow({ id: RUN1, replay_of: RUN2 }),
    runRow({ id: RUN2, status: "RUNNING" }),
  ]],
  ["cross-Issue parent", [
    runRow({ id: RUN1, replay_of: RUN2 }),
    runRow({ id: RUN2, status: "SUCCEEDED", output: OUTPUT, completed_at: T2, issue_id: OTHER }),
  ]],
  ["missing parent", [
    runRow({ id: RUN1, replay_of: RUN2 }),
  ]],
  ["cycle", [
    runRow({ id: RUN1, replay_of: RUN2 }),
    runRow({ id: RUN2, replay_of: RUN1, status: "SUCCEEDED", output: OUTPUT, completed_at: T2 }),
  ]],
])("replay: %s rejected", async (_label, runs) => {
  const db = database({ runs });
  await expect(factory(db.pool).get({ projectId: P, issueId: I, runId: RUN1 }))
    .rejects.toBeInstanceOf(errors.ResearchRunIntegrityError);
});

it("replay: depth > 100 fails closed", async () => {
  const runs: Row[] = [];
  for (let i = 0; i < 105; i++) {
    const id = `${String(i).padStart(8, "0")}-0000-4000-8000-${String(i).padStart(12, "0")}`;
    const priorId = i === 0 ? null : `${String(i - 1).padStart(8, "0")}-0000-4000-8000-${String(i - 1).padStart(12, "0")}`;
    runs.push(runRow({
      id, replay_of: priorId,
      status: i === 104 ? "RUNNING" : "SUCCEEDED",
      output: i === 104 ? null : OUTPUT,
      completed_at: i === 104 ? null : T2,
    }));
  }
  const db = database({ runs });
  const last = runs[104].id;
  await expect(factory(db.pool).get({ projectId: P, issueId: I, runId: last }))
    .rejects.toBeInstanceOf(errors.ResearchRunIntegrityError);
});

// ---------------------------------------------------------------------------
// Produced references (read-side)
// ---------------------------------------------------------------------------

it("produced: valid claim ref passes; foreign claim rejects", async () => {
  const ok = database({
    runs: [runRow({ status: "SUCCEEDED", output: OUTPUT_WITH_REFS, completed_at: T2 })],
    claimRows: [{ claim_id: CLAIM }],
  });
  const r = await factory(ok.pool).get({ projectId: P, issueId: I, runId: RUN1 });
  expect(r.kind).toBe("ok");

  const foreign = database({
    runs: [runRow({ status: "SUCCEEDED", output: OUTPUT_WITH_REFS, completed_at: T2 })],
    claimRows: [],
  });
  await expect(factory(foreign.pool).get({ projectId: P, issueId: I, runId: RUN1 }))
    .rejects.toBeInstanceOf(errors.ResearchRunIntegrityError);
});

it("produced: foreign assessment rejects", async () => {
  const assessOut = { ...OUTPUT, produced: { ...OUTPUT.produced, claimIds: [], assessmentIds: [ASSESS], resolutionIds: [], noteRevisionIds: [] } } as typeof OUTPUT;
  const foreignAssess = database({
    runs: [runRow({ status: "SUCCEEDED", output: assessOut, completed_at: T2 })],
    assessmentRows: [{ id: ASSESS, claim_id: OTHER }],
    claimRows: [],
  });
  await expect(factory(foreignAssess.pool).get({ projectId: P, issueId: I, runId: RUN1 }))
    .rejects.toBeInstanceOf(errors.ResearchRunIntegrityError);
});

it("produced: foreign resolution rejects", async () => {
  const resOut = { ...OUTPUT, produced: { ...OUTPUT.produced, claimIds: [], assessmentIds: [], resolutionIds: [RESOL], noteRevisionIds: [] } } as typeof OUTPUT;
  const foreignRes = database({
    runs: [runRow({ status: "SUCCEEDED", output: resOut, completed_at: T2 })],
    resolutionRows: [{ id: RESOL, issue_id: OTHER }],
  });
  await expect(factory(foreignRes.pool).get({ projectId: P, issueId: I, runId: RUN1 }))
    .rejects.toBeInstanceOf(errors.ResearchRunIntegrityError);
});

it("produced: dangling note revision rejects", async () => {
  const noteOut = { ...OUTPUT, produced: { ...OUTPUT.produced, noteRevisionIds: [NOTEREV] } } as typeof OUTPUT;
  const danglingNote = database({
    runs: [runRow({ status: "SUCCEEDED", output: noteOut, completed_at: T2 })],
    noteRevRows: [],
  });
  await expect(factory(danglingNote.pool).get({ projectId: P, issueId: I, runId: RUN1 }))
    .rejects.toBeInstanceOf(errors.ResearchRunIntegrityError);
});


