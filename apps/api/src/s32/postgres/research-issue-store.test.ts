import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import {
  IdempotencyConflictError,
  ProjectReadOnlyError,
  ResearchIssueIntegrityError,
  ResearchIssueNotFoundError,
  ResearchIssueStoreUnavailableError,
} from "../application/research-issues.js";
import { createPostgresResearchIssueStore } from "./research-issue-store.js";

const projectId = "11111111-1111-4111-8111-111111111111";
const otherProjectId = "22222222-2222-4222-8222-222222222222";
const issueId = "33333333-3333-4333-8333-333333333333";
const bindingId = "44444444-4444-4444-8444-444444444444";
const key = "55555555-5555-4555-8555-555555555555";
const hash = "a".repeat(64);

const projectRow = (overrides: Record<string, unknown> = {}) => ({
  id: projectId,
  name: "北京古道研究",
  lifecycle_state: "ACTIVE",
  ...overrides,
});

const issueRow = (overrides: Record<string, unknown> = {}) => ({
  binding_id: bindingId,
  owner_project_id: projectId,
  binding_role: null,
  binding_metadata: {},
  issue_id: issueId,
  title: "刘祥店迁出时间",
  question: "第一行\n第二行",
  lifecycle_state: "OPEN",
  created_at: new Date("2026-09-20T00:00:00.000Z"),
  updated_at: new Date("2026-09-20T01:00:00.000Z"),
  owner_count: 1,
  ...overrides,
});

type Handler = (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;
function fake(handler: Handler) {
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (sql.startsWith("BEGIN") || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
    return handler(sql, params);
  });
  const release = vi.fn();
  const pool = { connect: vi.fn(async () => ({ query, release })) };
  return { store: createPostgresResearchIssueStore(pool as unknown as Pool), query, release };
}

function readFake(options: { project?: any | null; listRows?: any[]; detailRows?: any[] } = {}) {
  return fake(async (sql) => {
    if (sql.includes("FROM core.projects")) return { rows: options.project === null ? [] : [options.project ?? projectRow()] };
    if (sql.includes("WITH owner_counts")) return { rows: options.listRows ?? [issueRow()] };
    if (sql.includes("FROM core.research_issues ri")) return { rows: options.detailRows ?? [issueRow()] };
    throw new Error(`unexpected SQL: ${sql}`);
  });
}

describe("Postgres research issue store reads", () => {
  it("lists in one repeatable-read read-only snapshot with fixed query count", async () => {
    const s = readFake({ listRows: [
      issueRow({ issue_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", lifecycle_state: "ARCHIVED" }),
      issueRow({ issue_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", lifecycle_state: "OPEN", updated_at: new Date("2026-09-21T00:00:00Z") }),
      issueRow({ issue_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", lifecycle_state: "RESOLVED" }),
    ] });
    const result = await s.store.list(projectId);
    expect(s.query.mock.calls[0][0]).toMatch(/BEGIN.*REPEATABLE READ.*READ ONLY/i);
    expect(s.query).toHaveBeenCalledTimes(4);
    expect(result?.issues.map((item) => item.lifecycleState)).toEqual(["OPEN", "RESOLVED", "ARCHIVED"]);
    expect(result?.issues[0].questionExcerpt).toBe("第一行 第二行");
    expect(result?.issues[0]).not.toHaveProperty("question");
  });

  it("returns explicit empty list and archived project context", async () => {
    const result = await readFake({ project: projectRow({ lifecycle_state: "ARCHIVED" }), listRows: [] }).store.list(projectId);
    expect(result).toEqual({ project: { id: projectId, name: "北京古道研究", lifecycleState: "ARCHIVED", readOnly: true }, issues: [] });
  });

  it("returns full detail and hides a valid issue owned by another project", async () => {
    const own = await readFake().store.get(projectId, issueId);
    expect(own?.issue.question).toBe("第一行\n第二行");
    await expect(readFake({ detailRows: [issueRow({ owner_project_id: otherProjectId })] }).store.get(projectId, issueId)).resolves.toBeNull();
  });

  it("does not query an issue when the requested project is missing", async () => {
    const s = readFake({ project: null });
    await expect(s.store.get(projectId, issueId)).resolves.toBeNull();
    expect(s.query.mock.calls.some(([sql]) => String(sql).includes("FROM core.research_issues ri"))).toBe(false);
  });

  it.each([
    ["dangling", [issueRow({ issue_id: null })]],
    ["multi-owner", [issueRow({ owner_count: 2 })]],
    ["role", [issueRow({ binding_role: "OWNER" })]],
    ["metadata", [issueRow({ binding_metadata: [] })]],
    ["blank title", [issueRow({ title: " " })]],
    ["CR title", [issueRow({ title: "bad\rtitle" })]],
    ["CR question", [issueRow({ question: "bad\rquestion" })]],
    ["lifecycle", [issueRow({ lifecycle_state: "UNKNOWN" })]],
  ])("fails closed for corrupt list state: %s", async (_label, listRows) => {
    await expect(readFake({ listRows }).store.list(projectId)).rejects.toBeInstanceOf(ResearchIssueIntegrityError);
  });

  it("fails closed for orphan and multi-owner detail", async () => {
    await expect(readFake({ detailRows: [issueRow({ binding_id: null, owner_project_id: null, binding_metadata: null })] }).store.get(projectId, issueId))
      .rejects.toBeInstanceOf(ResearchIssueIntegrityError);
    await expect(readFake({ detailRows: [issueRow(), issueRow({ binding_id: "66666666-6666-4666-8666-666666666666", owner_project_id: otherProjectId })] }).store.get(projectId, issueId))
      .rejects.toBeInstanceOf(ResearchIssueIntegrityError);
  });

  it("maps connection failures to unavailable", async () => {
    const s = fake(async () => { throw Object.assign(new Error("private"), { code: "ECONNREFUSED" }); });
    await expect(s.store.list(projectId)).rejects.toBeInstanceOf(ResearchIssueStoreUnavailableError);
  });
});

function createInput() {
  return { projectId, issueId, idempotencyKey: key, requestHash: hash, title: "刘祥店迁出时间", question: "问题" };
}

describe("Postgres research issue store create", () => {
  it("atomically creates an OPEN issue, owner binding, and completed receipt", async () => {
    const s = fake(async (sql) => {
      if (sql.includes("INSERT INTO ops.idempotency_keys")) return { rows: [{ id: "77777777-7777-4777-8777-777777777777" }] };
      if (sql.includes("FROM core.projects") && sql.includes("FOR UPDATE")) return { rows: [projectRow()] };
      if (sql.includes("INSERT INTO core.research_issues")) return { rows: [] };
      if (sql.includes("INSERT INTO core.project_bindings")) return { rows: [] };
      if (sql.includes("FROM core.research_issues ri")) return { rows: [issueRow({ question: "问题" })] };
      if (sql.includes("UPDATE ops.idempotency_keys")) return { rows: [] };
      throw new Error(`unexpected SQL: ${sql}`);
    });
    await expect(s.store.create(createInput())).resolves.toMatchObject({ status: "created", issue: { id: issueId } });
    expect(s.query.mock.calls[0][0]).toBe("BEGIN");
    expect(s.query.mock.calls.at(-1)![0]).toBe("COMMIT");
    expect(s.query.mock.calls.some(([sql]) => /lifecycle_state.*OPEN/is.test(String(sql)))).toBe(true);
  });

  it("replays a completed request before applying archived write gating", async () => {
    const s = fake(async (sql) => {
      if (sql.includes("INSERT INTO ops.idempotency_keys")) return { rows: [] };
      if (sql.includes("FROM ops.idempotency_keys")) return { rows: [{ id: "77777777-7777-4777-8777-777777777777", request_hash: hash, status: "COMPLETED", resource_type: "RESEARCH_ISSUE", resource_id: issueId }] };
      if (sql.includes("FROM core.projects")) return { rows: [projectRow({ lifecycle_state: "ARCHIVED" })] };
      if (sql.includes("FROM core.research_issues ri")) return { rows: [issueRow({ question: "问题" })] };
      throw new Error(`unexpected SQL: ${sql}`);
    });
    await expect(s.store.create(createInput())).resolves.toMatchObject({ status: "replayed", project: { readOnly: true }, issue: { id: issueId } });
    expect(s.query.mock.calls.filter(([sql]) => String(sql).includes("INSERT INTO core.research_issues"))).toHaveLength(0);
  });

  it("rejects a key reused with a different hash", async () => {
    const s = fake(async (sql) => {
      if (sql.includes("INSERT INTO ops.idempotency_keys")) return { rows: [] };
      if (sql.includes("FROM ops.idempotency_keys")) return { rows: [{ request_hash: "b".repeat(64), status: "COMPLETED", resource_type: "RESEARCH_ISSUE", resource_id: issueId }] };
      throw new Error(`unexpected SQL: ${sql}`);
    });
    await expect(s.store.create(createInput())).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect(s.query.mock.calls.at(-1)![0]).toBe("ROLLBACK");
  });

  it("rejects a genuinely new request for an archived project", async () => {
    const s = fake(async (sql) => {
      if (sql.includes("INSERT INTO ops.idempotency_keys")) return { rows: [{ id: "77777777-7777-4777-8777-777777777777" }] };
      if (sql.includes("FROM core.projects")) return { rows: [projectRow({ lifecycle_state: "ARCHIVED" })] };
      throw new Error(`unexpected SQL: ${sql}`);
    });
    await expect(s.store.create(createInput())).rejects.toBeInstanceOf(ProjectReadOnlyError);
    expect(s.query.mock.calls.at(-1)![0]).toBe("ROLLBACK");
  });

  it("rejects missing projects and unexpected durable idempotency rows", async () => {
    const missing = fake(async (sql) => {
      if (sql.includes("INSERT INTO ops.idempotency_keys")) return { rows: [{ id: "77777777-7777-4777-8777-777777777777" }] };
      if (sql.includes("FROM core.projects")) return { rows: [] };
      throw new Error(`unexpected SQL: ${sql}`);
    });
    await expect(missing.store.create(createInput())).rejects.toBeInstanceOf(ResearchIssueNotFoundError);

    const durable = fake(async (sql) => {
      if (sql.includes("INSERT INTO ops.idempotency_keys")) return { rows: [] };
      if (sql.includes("FROM ops.idempotency_keys")) return { rows: [{ request_hash: hash, status: "IN_PROGRESS", resource_type: null, resource_id: null }] };
      throw new Error(`unexpected SQL: ${sql}`);
    });
    await expect(durable.store.create(createInput())).rejects.toBeInstanceOf(ResearchIssueIntegrityError);
  });

  it.each([
    [{ status: "COMPLETED", resource_type: "OTHER", resource_id: issueId }, "wrong type"],
    [{ status: "COMPLETED", resource_type: "RESEARCH_ISSUE", resource_id: null }, "missing resource"],
  ])("fails closed for corrupt completed receipts: %s", async (receipt) => {
    const s = fake(async (sql) => {
      if (sql.includes("INSERT INTO ops.idempotency_keys")) return { rows: [] };
      if (sql.includes("FROM ops.idempotency_keys")) return { rows: [{ request_hash: hash, ...receipt }] };
      throw new Error(`unexpected SQL: ${sql}`);
    });
    await expect(s.store.create(createInput())).rejects.toBeInstanceOf(ResearchIssueIntegrityError);
  });
});
