import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import {
  IdempotencyConflictError,
  ProjectReadOnlyError,
  ResearchIssueIntegrityError,
} from "../application/research-issues.js";
import { hashResearchIssueCreateRequest } from "../domain/research-issue.js";
import { createPostgresResearchIssueStore } from "./research-issue-store.js";

const databaseUrl = process.env.S32_M2A_TEST_DATABASE_URL;
const parsed = databaseUrl ? new URL(databaseUrl) : null;
if (parsed && (parsed.hostname !== "127.0.0.1" || parsed.pathname !== "/s32_m2a_test")) {
  throw new Error("M2-A integration requires isolated local s32_m2a_test");
}
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
afterAll(async () => { await pool?.end(); });

describe.skipIf(!pool)("M2-A real PostgreSQL16", () => {
  const db = pool!;
  const store = createPostgresResearchIssueStore(db);

  beforeAll(async () => {
    expect((await db.query("SHOW server_version_num")).rows[0].server_version_num).toMatch(/^16/);
  });

  async function project(lifecycle: "ACTIVE" | "ARCHIVED" = "ACTIVE") {
    const id = randomUUID();
    await db.query(
      "INSERT INTO core.projects (id,name,lifecycle_state,metadata) VALUES ($1,$2,$3,'{}'::jsonb)",
      [id, `M2A ${id}`, lifecycle],
    );
    return id;
  }

  function input(projectId: string, key = randomUUID(), issueId = randomUUID(), title = "刘祥店迁出时间", question = "刘祥店村何时迁出？") {
    return {
      projectId,
      issueId,
      idempotencyKey: key,
      requestHash: hashResearchIssueCreateRequest(projectId, { title, question }),
      title,
      question,
    };
  }

  async function counts(projectId: string) {
    return (await db.query(
      `SELECT
         (SELECT count(*)::int FROM core.research_issues ri
          JOIN core.project_bindings pb ON pb.target_type='RESEARCH_ISSUE' AND pb.target_id=ri.id
          WHERE pb.project_id=$1) issues,
         (SELECT count(*)::int FROM core.project_bindings WHERE project_id=$1 AND target_type='RESEARCH_ISSUE') bindings,
         (SELECT count(*)::int FROM ops.idempotency_keys WHERE scope=$2) receipts`,
      [projectId, `S32:M2A:PROJECT_ISSUE_CREATE:${projectId}`],
    )).rows[0] as { issues: number; bindings: number; receipts: number };
  }

  it("creates one OPEN issue, one owner and one completed receipt atomically", async () => {
    const projectId = await project();
    const before = await counts(projectId);
    const created = await store.create(input(projectId));
    expect(created.status).toBe("created");
    expect(await counts(projectId)).toEqual({ issues: before.issues + 1, bindings: before.bindings + 1, receipts: before.receipts + 1 });
    expect((await db.query("SELECT lifecycle_state,current_resolution_id FROM core.research_issues WHERE id=$1", [created.issue.id])).rows[0])
      .toEqual({ lifecycle_state: "OPEN", current_resolution_id: null });
    expect((await db.query("SELECT project_id,binding_role,metadata FROM core.project_bindings WHERE target_type='RESEARCH_ISSUE' AND target_id=$1", [created.issue.id])).rows)
      .toEqual([{ project_id: projectId, binding_role: null, metadata: {} }]);
    expect((await db.query("SELECT status,resource_type,resource_id FROM ops.idempotency_keys WHERE scope=$1", [`S32:M2A:PROJECT_ISSUE_CREATE:${projectId}`])).rows)
      .toEqual([{ status: "COMPLETED", resource_type: "RESEARCH_ISSUE", resource_id: created.issue.id }]);
  });

  it("serializes concurrent same-key creates to one canonical issue", async () => {
    const projectId = await project();
    const key = randomUUID();
    const before = await counts(projectId);
    const a = input(projectId, key);
    const b = { ...a, issueId: randomUUID() };
    const results = await Promise.all([store.create(a), store.create(b)]);
    expect(new Set(results.map((result) => result.issue.id))).toEqual(new Set([results[0].issue.id]));
    expect(results.map((result) => result.status).sort()).toEqual(["created", "replayed"]);
    expect(await counts(projectId)).toEqual({ issues: before.issues + 1, bindings: before.bindings + 1, receipts: before.receipts + 1 });
  });

  it("rejects same key with a different normalized hash without a second issue", async () => {
    const projectId = await project();
    const key = randomUUID();
    await store.create(input(projectId, key));
    const after = await counts(projectId);
    await expect(store.create(input(projectId, key, randomUUID(), "另一个问题", "不同内容"))).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect(await counts(projectId)).toEqual(after);
  });

  it("replays completed creation after archive but rejects a genuinely new key", async () => {
    const projectId = await project();
    const request = input(projectId);
    const created = await store.create(request);
    await db.query("UPDATE core.projects SET lifecycle_state='ARCHIVED' WHERE id=$1", [projectId]);
    const replay = await store.create({ ...request, issueId: randomUUID() });
    expect(replay).toMatchObject({ status: "replayed", project: { readOnly: true }, issue: { id: created.issue.id } });
    await expect(store.create(input(projectId))).rejects.toBeInstanceOf(ProjectReadOnlyError);
    expect(await counts(projectId)).toEqual({ issues: 1, bindings: 1, receipts: 1 });
  });

  it("rolls back reservation and issue when the owner binding insert conflicts", async () => {
    const projectId = await project();
    const issueId = randomUUID();
    const corruptBinding = randomUUID();
    await db.query("INSERT INTO core.project_bindings (id,project_id,target_type,target_id,binding_role,metadata) VALUES ($1,$2,'RESEARCH_ISSUE',$3,NULL,'{}'::jsonb)", [corruptBinding, projectId, issueId]);
    const request = input(projectId, randomUUID(), issueId);
    try {
      await expect(store.create(request)).rejects.toThrow();
      expect((await db.query("SELECT count(*)::int n FROM core.research_issues WHERE id=$1", [issueId])).rows[0].n).toBe(0);
      expect((await db.query("SELECT count(*)::int n FROM ops.idempotency_keys WHERE scope=$1 AND idempotency_key=$2", [`S32:M2A:PROJECT_ISSUE_CREATE:${projectId}`, request.idempotencyKey])).rows[0].n).toBe(0);
      expect((await db.query("SELECT count(*)::int n FROM core.project_bindings WHERE id=$1", [corruptBinding])).rows[0].n).toBe(1);
    } finally {
      await db.query("DELETE FROM core.project_bindings WHERE id=$1", [corruptBinding]);
    }
  });

  it("fails closed for orphan, multi-owner, dangling, non-null role and malformed canonical rows", async () => {
    const a = await project();
    const b = await project();

    const orphan = randomUUID();
    await db.query("INSERT INTO core.research_issues (id,title,question) VALUES ($1,'orphan','question')", [orphan]);
    await expect(store.get(a, orphan)).rejects.toBeInstanceOf(ResearchIssueIntegrityError);
    await db.query("DELETE FROM core.research_issues WHERE id=$1", [orphan]);

    const multi = randomUUID();
    await db.query("INSERT INTO core.research_issues (id,title,question) VALUES ($1,'multi','question')", [multi]);
    await db.query("INSERT INTO core.project_bindings (id,project_id,target_type,target_id,metadata) VALUES ($1,$2,'RESEARCH_ISSUE',$3,'{}'),($4,$5,'RESEARCH_ISSUE',$3,'{}')", [randomUUID(), a, multi, randomUUID(), b]);
    await expect(store.list(a)).rejects.toBeInstanceOf(ResearchIssueIntegrityError);
    await expect(store.get(a, multi)).rejects.toBeInstanceOf(ResearchIssueIntegrityError);
    await db.query("DELETE FROM core.project_bindings WHERE target_type='RESEARCH_ISSUE' AND target_id=$1", [multi]);
    await db.query("DELETE FROM core.research_issues WHERE id=$1", [multi]);

    const dangling = randomUUID();
    await db.query("INSERT INTO core.project_bindings (id,project_id,target_type,target_id,metadata) VALUES ($1,$2,'RESEARCH_ISSUE',$3,'{}')", [randomUUID(), a, dangling]);
    await expect(store.list(a)).rejects.toBeInstanceOf(ResearchIssueIntegrityError);
    await db.query("DELETE FROM core.project_bindings WHERE target_type='RESEARCH_ISSUE' AND target_id=$1", [dangling]);

    const role = randomUUID();
    await db.query("INSERT INTO core.research_issues (id,title,question) VALUES ($1,'role','question')", [role]);
    await db.query("INSERT INTO core.project_bindings (id,project_id,target_type,target_id,binding_role,metadata) VALUES ($1,$2,'RESEARCH_ISSUE',$3,'OWNER','{}')", [randomUUID(), a, role]);
    await expect(store.list(a)).rejects.toBeInstanceOf(ResearchIssueIntegrityError);
    await db.query("DELETE FROM core.project_bindings WHERE target_type='RESEARCH_ISSUE' AND target_id=$1", [role]);
    await db.query("DELETE FROM core.research_issues WHERE id=$1", [role]);

    const malformed = randomUUID();
    await db.query("INSERT INTO core.research_issues (id,title,question) VALUES ($1,' ','bad\rquestion')", [malformed]);
    await db.query("INSERT INTO core.project_bindings (id,project_id,target_type,target_id,metadata) VALUES ($1,$2,'RESEARCH_ISSUE',$3,'{}')", [randomUUID(), a, malformed]);
    await expect(store.get(a, malformed)).rejects.toBeInstanceOf(ResearchIssueIntegrityError);
  });

  it("returns scoped null for an issue validly owned by another Project", async () => {
    const a = await project();
    const b = await project();
    const created = await store.create(input(b));
    await expect(store.get(a, created.issue.id)).resolves.toBeNull();
  });
});
