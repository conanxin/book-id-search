import { randomUUID } from "node:crypto";
import express, { type Express } from "express";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createResearchRunsService } from "../application/research-runs.js";
import { buildEvidenceManifestDraft } from "../domain/evidence-selection.js";
import { createPostgresResearchRunCommandStore } from "./research-run-command-store.js";
import { createPostgresResearchRunReadStore } from "./research-run-read-store.js";
import { createResearchRunBodyParser, createResearchRunRouter } from "../routes/research-run-routes.js";
import type { S32Config } from "../config.js";

const url = process.env.S32_M3A_GATE2_TEST_DATABASE_URL;
const parsed = url ? new URL(url) : null;
if (parsed && (parsed.hostname !== "127.0.0.1" || parsed.pathname !== "/s32_m3a_gate2_test")) {
  throw new Error("Gate2 ResearchRun integration requires isolated local s32_m3a_gate2_test on 127.0.0.1");
}
const d = url ? describe : describe.skip;

const TOKEN = "gate2-researchrun-local-test-token";
const config: S32Config = { enabled: true, databaseUrl: url ?? "postgresql://x", privateToken: TOKEN };

const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "12111111-1111-4111-8111-111111111111";
const I1 = "21111111-1111-4111-8111-111111111111";
const I2 = "22111111-1111-4111-8111-111111111111";
const SRC1 = "61111111-1111-4111-8111-111111111111";
const CLAIM1 = "31111111-1111-4111-8111-111111111111";
const CLAIM2 = "32111111-1111-4111-8111-111111111111";
const ASSESS1 = "91111111-1111-4111-8111-111111111111";
const RESOL1 = "d1111111-1111-4111-8111-111111111111";
const NOTEREV_HIST = "a4111111-1111-4111-8111-111111111111";
const BINDING_EDITION = "81111111-1111-4111-8111-111111111111";

const PROCEDURE = { version: 1, objective: "Gate2 acceptance", method: "real PG", steps: [{ kind: "SEARCH", description: "find" }] };
const EXECUTION = { version: 1, mode: "HUMAN_AI", reproducibilityLevel: "PROCEDURE", tools: [{ name: "gate2", version: "1" }] };
const ENVIRONMENT = { locale: "zh-CN" };

function startBody(manifestId: string) {
  return { procedure: PROCEDURE, executionContract: EXECUTION, environment: ENVIRONMENT, evidenceManifestId: manifestId, replayOf: null };
}
const outputWith = (produced: Record<string, string[]>) => ({
  version: 1, summary: "done",
  produced: { claimIds: [], assessmentIds: [], resolutionIds: [], noteRevisionIds: [], ...produced },
  gaps: [],
});

let pool: Pool;
let app: Express;
let server: { close: (cb: (e?: Error) => void) => void; port: number };

function buildApp(pgPool: Pool): Express {
  const service = createResearchRunsService(
    createPostgresResearchRunCommandStore(pgPool),
    createPostgresResearchRunReadStore(pgPool),
  );
  const a = express();
  a.use("/api/private/s32/projects", createResearchRunBodyParser(config));
  a.use(express.json({ limit: "256kb" }));
  a.use("/api/private/s32/projects", createResearchRunRouter(config, service));
  return a;
}

async function startServer(a: Express) {
  const srv = a.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => srv.once("listening", resolve));
  return { srv, port: (srv.address() as AddressInfo).port };
}
async function stopServer(s: { close: (cb: (e?: Error) => void) => void }) {
  await new Promise<void>((resolve, reject) => s.close(e => e ? reject(e) : resolve()));
}

const auth = { Authorization: `Bearer ${TOKEN}` } as Record<string, string>;
const base = (port: number, projectId = P1, issueId = I1) =>
  `http://127.0.0.1:${port}/api/private/s32/projects/${projectId}/issues/${issueId}/runs`;

async function post(port: number, path: string, key: string, body: unknown, projectId = P1, issueId = I1) {
  return fetch(`http://127.0.0.1:${port}/api/private/s32/projects/${projectId}/issues/${issueId}/runs${path}`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify(body),
  });
}

async function counts() {
  const { rows } = await pool.query(`
    SELECT
      (SELECT count(*)::int FROM core.research_runs) AS runs,
      (SELECT count(*)::int FROM ops.idempotency_keys
        WHERE resource_type='RESEARCH_RUN' AND status='COMPLETED') AS receipts
  `);
  return rows[0] as { runs: number; receipts: number };
}

async function seedManifest(items: Array<{ role: string; targetType: string; targetId: string }>) {
  const draft = buildEvidenceManifestDraft(items.map(i => ({ role: i.role as "SUPPORTING", targetType: i.targetType as "SOURCE", targetId: i.targetId, note: null })));
  const manifestId = randomUUID();
  await pool.query(
    `INSERT INTO core.evidence_manifests (id,schema_version,purpose,manifest_sha256,metadata)
     VALUES ($1,1,'CLAIM_ASSESSMENT',$2,'{}'::jsonb)`,
    [manifestId, draft.manifestSha256],
  );
  for (const [index, item] of items.entries()) {
    await pool.query(
      `INSERT INTO core.evidence_manifest_items (id,manifest_id,ordinal,role,target_type,target_id)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [randomUUID(), manifestId, index + 1, item.role, item.targetType, item.targetId],
    );
  }
  return manifestId;
}

d("ResearchRun whole backend on real PostgreSQL 16", () => {
  let manifestId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url });
    manifestId = await seedManifest([{ role: "SUPPORTING", targetType: "SOURCE", targetId: SRC1 }]);
    app = buildApp(pool);
    const s = await startServer(app);
    server = { close: (cb: (e?: Error) => void) => s.srv.close(cb), port: s.port };
  });
  afterAll(async () => {
    await stopServer(server).catch(() => {});
    await pool.end();
  });

  // ---- A. START + read -------------------------------------------------
  it("A: real HTTP START → 201, one RUNNING row, one receipt, history+detail readback", async () => {
    const key = randomUUID();
    const before = await counts();
    const res = await post(server.port, "", key, startBody(manifestId));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.runId).toBeTypeOf("string");
    expect(await counts()).toEqual({ runs: before.runs + 1, receipts: before.receipts + 1 });

    const row = await pool.query("SELECT status,issue_id,evidence_manifest_id::text AS m,output FROM core.research_runs WHERE id=$1", [body.runId]);
    expect(row.rows[0].status).toBe("RUNNING");
    expect(row.rows[0].issue_id).toBe(I1);
    expect(row.rows[0].m).toBe(manifestId);
    expect(row.rows[0].output).toBeNull();

    const list = await fetch(base(server.port), { headers: auth });
    expect(list.status).toBe(200);
    const listBody = await list.json();
    expect(listBody.runs.some((r: { runId: string }) => r.runId === body.runId)).toBe(true);

    const detail = await fetch(`${base(server.port)}/${body.runId}`, { headers: auth });
    expect(detail.status).toBe(200);
    const detailBody = await detail.json();
    expect(detailBody.run.status).toBe("RUNNING");
    expect(detailBody.evidenceManifest.available).toBe(true);

    // Same key + same body → 200 same runId, counts unchanged.
    const replayRes = await post(server.port, "", key, startBody(manifestId));
    expect(replayRes.status).toBe(200);
    expect((await replayRes.json()).runId).toBe(body.runId);
    expect(await counts()).toEqual({ runs: before.runs + 1, receipts: before.receipts + 1 });
  });

  // ---- B. Concurrent idempotency --------------------------------------
  it("B: two concurrent identical STARTs → exactly one run, one receipt, same runId", async () => {
    const key = randomUUID();
    const before = await counts();
    const [r1, r2] = await Promise.all([
      post(server.port, "", key, startBody(manifestId)),
      post(server.port, "", key, startBody(manifestId)),
    ]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([200, 201]);
    const b1 = await r1.json();
    const b2 = await r2.json();
    expect(b1.runId).toBe(b2.runId);
    expect(await counts()).toEqual({ runs: before.runs + 1, receipts: before.receipts + 1 });
  });

  // ---- C. Terminal lifecycle ------------------------------------------
  it("C: RUNNING→SUCCEEDED/FAILED/CANCELLED via HTTP; 409 on fresh key after terminal; receipt replay after archival; read-only gates", async () => {
    // SUCCEEDED with output
    const sk = randomUUID();
    const s1 = await post(server.port, "", sk, startBody(manifestId));
    const succeededId = (await s1.json()).runId;
    const ck = randomUUID();
    const completeBody = { output: outputWith({ claimIds: [CLAIM1], assessmentIds: [ASSESS1], resolutionIds: [RESOL1], noteRevisionIds: [NOTEREV_HIST] }) };
    const complete = await post(server.port, `/${succeededId}/complete`, ck, completeBody);
    expect(complete.status).toBe(200);
    const completedRun = (await pool.query("SELECT status FROM core.research_runs WHERE id=$1", [succeededId])).rows[0];
    expect(completedRun.status).toBe("SUCCEEDED");

    // Same transition key + same body → original result recoverable
    const replayComplete = await post(server.port, `/${succeededId}/complete`, ck, completeBody);
    expect(replayComplete.status).toBe(200);

    // Fresh key against terminal → 409
    const fresh = await post(server.port, `/${succeededId}/cancel`, randomUUID(), { output: null });
    expect(fresh.status).toBe(409);
    expect((await fresh.json()).error.code).toBe("RESEARCH_RUN_ALREADY_TERMINAL");

    // FAILED with null output
    const fk = randomUUID();
    const f1 = await post(server.port, "", fk, startBody(manifestId));
    const failedId = (await f1.json()).runId;
    const fail = await post(server.port, `/${failedId}/fail`, randomUUID(), { output: null });
    expect(fail.status).toBe(200);

    // CANCELLED with null output
    const ckx = randomUUID();
    const c1 = await post(server.port, "", ckx, startBody(manifestId));
    const cancelledId = (await c1.json()).runId;
    const cancel = await post(server.port, `/${cancelledId}/cancel`, randomUUID(), { output: null });
    expect(cancel.status).toBe(200);
    for (const id of [failedId, cancelledId]) {
      const status = (await pool.query("SELECT status FROM core.research_runs WHERE id=$1", [id])).rows[0].status;
      expect(["FAILED", "CANCELLED"]).toContain(status);
    }

    // Archival: completed receipt replay still recoverable; fresh write gated.
    await pool.query("UPDATE core.projects SET lifecycle_state='ARCHIVED' WHERE id=$1", [P1]);
    const archivedReplay = await post(server.port, `/${succeededId}/complete`, ck, completeBody);
    expect(archivedReplay.status).toBe(200);
    const freshArchived = await post(server.port, "", randomUUID(), startBody(manifestId));
    expect(freshArchived.status).toBe(409);
    expect((await freshArchived.json()).error.code).toBe("PROJECT_READ_ONLY");
    await pool.query("UPDATE core.projects SET lifecycle_state='ACTIVE' WHERE id=$1", [P1]);

    // Issue archival → RESEARCH_ISSUE_READ_ONLY
    await pool.query("UPDATE core.research_issues SET lifecycle_state='ARCHIVED' WHERE id=$1", [I1]);
    const issueArchived = await post(server.port, "", randomUUID(), startBody(manifestId));
    expect(issueArchived.status).toBe(409);
    expect((await issueArchived.json()).error.code).toBe("RESEARCH_ISSUE_READ_ONLY");
    await pool.query("UPDATE core.research_issues SET lifecycle_state='OPEN' WHERE id=$1", [I1]);
  });

  // ---- D. DB terminal trigger -----------------------------------------
  it("D: direct SQL UPDATE/DELETE on terminal run rejected with TERMINAL_RUN_IMMUTABILITY; RUNNING protected fields locked", async () => {
    const s = await post(server.port, "", randomUUID(), startBody(manifestId));
    const runId = (await s.json()).runId;
    await post(server.port, `/${runId}/cancel`, randomUUID(), { output: null });

    const up = await pool.query("UPDATE core.research_runs SET output='\"x\"'::jsonb WHERE id=$1", [runId]).catch(e => e);
    expect(String(up.message)).toContain("TERMINAL_RUN_IMMUTABILITY");
    const del = await pool.query("DELETE FROM core.research_runs WHERE id=$1", [runId]).catch(e => e);
    expect(String(del.message)).toContain("TERMINAL_RUN_IMMUTABILITY");

    const s2 = await post(server.port, "", randomUUID(), startBody(manifestId));
    const runningId = (await s2.json()).runId;
    const mutate = await pool.query("UPDATE core.research_runs SET issue_id=$2 WHERE id=$1", [runningId, I2]).catch(e => e);
    expect(String(mutate.message)).toContain("TERMINAL_RUN_IMMUTABILITY");
    const mutate2 = await pool.query("UPDATE core.research_runs SET replay_of=$2 WHERE id=$1", [runningId, runId]).catch(e => e);
    expect(String(mutate2.message)).toContain("TERMINAL_RUN_IMMUTABILITY");
  });

  // ---- E. Produced references -----------------------------------------
  it("E: non-empty produced round-trip; foreign/dangling refs fail closed leaving run RUNNING without receipt", async () => {
    const s = await post(server.port, "", randomUUID(), startBody(manifestId));
    const runId = (await s.json()).runId;
    const key = randomUUID();
    const good = await post(server.port, `/${runId}/complete`, key, {
      output: outputWith({ claimIds: [CLAIM1], assessmentIds: [ASSESS1], resolutionIds: [RESOL1], noteRevisionIds: [NOTEREV_HIST] }),
    });
    expect(good.status).toBe(200);
    const detail = await fetch(`${base(server.port)}/${runId}`, { headers: auth });
    const detailBody = await detail.json();
    expect(detailBody.run.output.produced.claimIds).toEqual([CLAIM1]);
    expect(detailBody.run.output.produced.noteRevisionIds).toEqual([NOTEREV_HIST]);

    // Negative: foreign claim (belongs to I2), foreign assessment (its claim outside I1),
    // foreign resolution (issue I2), dangling note revision.
    for (const produced of [
      { claimIds: [CLAIM2] },
      { assessmentIds: [ASSESS1] }, // ASSESS1 belongs to CLAIM1∈I1 — need a真 foreign one; use claim-mismatch via foreign assessment below
      { resolutionIds: [RESOL1] },
      { noteRevisionIds: [NOTEREV_HIST] },
    ].slice(0, 1)) {
      const s2 = await post(server.port, "", randomUUID(), startBody(manifestId));
      const rid = (await s2.json()).runId;
      const before = await counts();
      const bad = await post(server.port, `/${rid}/complete`, randomUUID(), { output: outputWith(produced) });
      expect(bad.status).toBe(500); // integrity fail-closed (safe 500, no detail leak)
      const row = (await pool.query("SELECT status FROM core.research_runs WHERE id=$1", [rid])).rows[0];
      expect(row.status).toBe("RUNNING");
      expect(await counts()).toEqual(before);
    }

    // True foreign assessment: create one against the foreign claim.
    const foreignAssess = randomUUID();
    await pool.query(
      `INSERT INTO core.assessments (id,claim_id,stance,confidence_level,reasoning,metadata)
       VALUES ($1,$2,'CONTRADICTS','LOW','foreign','{}'::jsonb)`,
      [foreignAssess, CLAIM2],
    );
    const s3 = await post(server.port, "", randomUUID(), startBody(manifestId));
    const rid3 = (await s3.json()).runId;
    const badAssess = await post(server.port, `/${rid3}/complete`, randomUUID(), { output: outputWith({ assessmentIds: [foreignAssess] }) });
    expect(badAssess.status).toBe(500);

    // Foreign resolution belongs to I2? RESOL1 belongs to I1 — create one on I2.
    const foreignResol = randomUUID();
    await pool.query(
      `INSERT INTO core.issue_resolutions (id,issue_id,resolution_type,preferred_claim_id,rationale)
       VALUES ($1,$2,'PREFERRED_CLAIM',$3,'foreign')`,
      [foreignResol, I2, CLAIM2],
    );
    const s4 = await post(server.port, "", randomUUID(), startBody(manifestId));
    const rid4 = (await s4.json()).runId;
    const badResol = await post(server.port, `/${rid4}/fail`, randomUUID(), { output: outputWith({ resolutionIds: [foreignResol] }) });
    expect(badResol.status).toBe(500);

    // Dangling note revision.
    const s5 = await post(server.port, "", randomUUID(), startBody(manifestId));
    const rid5 = (await s5.json()).runId;
    const badNote = await post(server.port, `/${rid5}/cancel`, randomUUID(), { output: outputWith({ noteRevisionIds: [randomUUID()] }) });
    expect(badNote.status).toBe(500);
  });

  // ---- F. Replay --------------------------------------------------------
  it("F: replay terminal run → new RUNNING run with replay_of, prior unchanged, lineage, same-key 200; RUNNING prior 409; cross-Issue prior rejected", async () => {
    const s = await post(server.port, "", randomUUID(), startBody(manifestId));
    const priorId = (await s.json()).runId;
    await post(server.port, `/${priorId}/complete`, randomUUID(), { output: outputWith({}) });
    const priorSnapshot = (await pool.query(
      "SELECT status::text,output::text,completed_at::text,replay_of::text FROM core.research_runs WHERE id=$1", [priorId],
    )).rows[0];

    const key = randomUUID();
    const rep = await post(server.port, `/${priorId}/replay`, key, {
      procedure: PROCEDURE, executionContract: EXECUTION, environment: ENVIRONMENT, evidenceManifestId: manifestId,
    });
    expect(rep.status).toBe(201);
    const newRun = (await rep.json()).runId;
    expect(newRun).not.toBe(priorId);
    const row = (await pool.query("SELECT status FROM core.research_runs WHERE id=$1", [newRun])).rows[0];
    expect(row.status).toBe("RUNNING");

    const replayOf = (await pool.query("SELECT replay_of::text FROM core.research_runs WHERE id=$1", [newRun])).rows[0].replay_of;
    expect(replayOf).toBe(priorId);

    const after = (await pool.query(
      "SELECT status::text,output::text,completed_at::text,replay_of::text FROM core.research_runs WHERE id=$1", [priorId],
    )).rows[0];
    expect(after).toEqual(priorSnapshot);

    const detail = await fetch(`${base(server.port)}/${newRun}`, { headers: auth });
    const detailBody = await detail.json();
    expect(detailBody.ancestors.map((a: { runId: string }) => a.runId)).toEqual([priorId]);

    const retry = await post(server.port, `/${priorId}/replay`, key, {
      procedure: PROCEDURE, executionContract: EXECUTION, environment: ENVIRONMENT, evidenceManifestId: manifestId,
    });
    expect(retry.status).toBe(200);
    expect((await retry.json()).runId).toBe(newRun);

    // RUNNING prior → 409
    const s2 = await post(server.port, "", randomUUID(), startBody(manifestId));
    const runningPrior = (await s2.json()).runId;
    const badReplay = await post(server.port, `/${runningPrior}/replay`, randomUUID(), {
      procedure: PROCEDURE, executionContract: EXECUTION, environment: ENVIRONMENT, evidenceManifestId: manifestId,
    });
    expect(badReplay.status).toBe(409);

    // Cross-Issue prior: start in I2 scope… prior belongs to I1; replay under P2/I2 scope must reject.
    const cross = await post(server.port, `/${priorId}/replay`, randomUUID(), {
      procedure: PROCEDURE, executionContract: EXECUTION, environment: ENVIRONMENT, evidenceManifestId: manifestId,
    }, P2, I2);
    expect([404, 409]).toContain(cross.status);
  });

  // ---- G. History / cursor on real PG ----------------------------------
  it("G: list order started_at DESC id DESC; limit=1 cursor pages without dup/skip; tie-break with identical started_at", async () => {
    // Insert two runs with identical started_at directly (allowed fields on INSERT).
    const t = "2026-09-30T12:00:00.123456Z";
    const tieA = randomUUID(); const tieB = randomUUID();
    for (const id of [tieA, tieB]) {
      await pool.query(
        `INSERT INTO core.research_runs (id,issue_id,evidence_manifest_id,status,procedure,execution_contract,environment,started_at)
         VALUES ($1,$2,$3,'RUNNING',$4::jsonb,$5::jsonb,$6::jsonb,$7)`,
        [id, I1, manifestId, JSON.stringify(PROCEDURE), JSON.stringify(EXECUTION), JSON.stringify(ENVIRONMENT), t],
      );
    }
    const list = await fetch(`${base(server.port)}?limit=1`, { headers: auth });
    expect(list.status).toBe(200);
    const page1 = await list.json();
    expect(page1.runs).toHaveLength(1);
    expect(page1.nextCursor).toBeTruthy();
    const seen = new Set<string>([page1.runs[0].runId]);
    // Walk pages until both tie rows appear adjacently ordered id DESC.
    let cursor: string | null = page1.nextCursor;
    let guard = 0;
    let order: string[] = [page1.runs[0].runId];
    while (cursor && guard++ < 100) {
      const page = await (await fetch(`${base(server.port)}?limit=1&cursor=${encodeURIComponent(cursor)}`, { headers: auth })).json();
      for (const r of page.runs) {
        expect(seen.has(r.runId)).toBe(false);
        seen.add(r.runId);
        order.push(r.runId);
      }
      cursor = page.nextCursor;
    }
    const ia = order.indexOf(tieA); const ib = order.indexOf(tieB);
    expect(ia).toBeGreaterThan(-1); expect(ib).toBeGreaterThan(-1);
    expect(Math.abs(ia - ib)).toBe(1);
    expect(order[Math.min(ia, ib)]).toBe(tieA > tieB ? tieA : tieB); // id DESC tie-break
  });

  // ---- H. Historical evidence visibility -------------------------------
  it("H: removing material binding keeps run visible with available=false and no target leakage", async () => {
    const s = await post(server.port, "", randomUUID(), startBody(manifestId));
    const runId = (await s.json()).runId;
    await pool.query("DELETE FROM core.project_bindings WHERE id=$1", [BINDING_EDITION]);
    try {
      const res = await fetch(`${base(server.port)}/${runId}`, { headers: auth });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.run.runId).toBe(runId);
      expect(body.evidenceManifest.available).toBe(false);
      const text = JSON.stringify(body.evidenceManifest);
      expect(text).not.toContain(SRC1);
      expect(text).not.toContain("targetId");
    } finally {
      await pool.query(
        `INSERT INTO core.project_bindings (id,project_id,target_type,target_id,binding_role,metadata)
         VALUES ($1,$2,'EDITION',$3,NULL,'{"sourceId":"61111111-1111-4111-8111-111111111111"}')`,
        [BINDING_EDITION, P1, "51111111-1111-4111-8111-111111111111"],
      );
    }
  });

  // ---- I. Privacy -------------------------------------------------------
  it("I: foreign scope and nonexistent run resolve identically (no existence oracle)", async () => {
    const s = await post(server.port, "", randomUUID(), startBody(manifestId));
    const runId = (await s.json()).runId;
    const foreign = await fetch(`${base(server.port, P2, I2)}/${runId}`, { headers: auth });
    const foreignBody = await foreign.json();
    expect(foreign.status).toBe(404);
    const nonexistent = await fetch(`${base(server.port)}/${randomUUID()}`, { headers: auth });
    const nonexistentBody = await nonexistent.json();
    expect(nonexistent.status).toBe(404);
    expect(foreignBody).toEqual(nonexistentBody);
  });

  // ---- J. Persistence across restart ------------------------------------
  it("J: close server+pool, rebuild stack, all runs/receipts/lineage intact", async () => {
    const s = await post(server.port, "", randomUUID(), startBody(manifestId));
    const runId = (await s.json()).runId;
    await post(server.port, `/${runId}/complete`, randomUUID(), { output: outputWith({ claimIds: [CLAIM1] }) });
    const before = await counts();

    await stopServer(server);
    await pool.end();

    pool = new Pool({ connectionString: url });
    app = buildApp(pool);
    const s2 = await startServer(app);
    server = { close: (cb: (e?: Error) => void) => s2.srv.close(cb), port: s2.port };

    expect(await counts()).toEqual(before);
    const detail = await fetch(`${base(server.port)}/${runId}`, { headers: auth });
    expect(detail.status).toBe(200);
    const body = await detail.json();
    expect(body.run.status).toBe("SUCCEEDED");
    const list = await (await fetch(base(server.port), { headers: auth })).json();
    expect(list.runs.some((r: { runId: string }) => r.runId === runId)).toBe(true);
  });
});
