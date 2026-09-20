import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  IdempotencyConflictError,
  ProjectReadOnlyError,
  ResearchIssueIntegrityError,
  ResearchIssueNotFoundError,
  ResearchIssueStoreUnavailableError,
  type ResearchIssueStore,
} from "../application/research-issues.js";
import {
  buildResearchIssueQuestionExcerpt,
  readResearchIssueId,
  readResearchIssueInput,
  type ResearchIssue,
  type ResearchIssueProjectContext,
  type ResearchIssueSummary,
} from "../domain/research-issue.js";

interface ProjectRow { id: string; name: string; lifecycle_state: string }
interface IssueRow {
  binding_id: string | null;
  owner_project_id: string | null;
  binding_role: string | null;
  binding_metadata: unknown;
  issue_id: string | null;
  title: string | null;
  question: string | null;
  lifecycle_state: string | null;
  created_at: Date | null;
  updated_at: Date | null;
  owner_count?: string | number | null;
}
interface IdempotencyRow {
  id: string;
  request_hash: string;
  status: string;
  resource_type: string | null;
  resource_id: string | null;
}

function integrity(message = "RESEARCH_ISSUE_INTEGRITY_ERROR"): never {
  throw new ResearchIssueIntegrityError(message);
}

function isConnectionError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return (
    (typeof code === "string" && (/^08[0-9A-Z]{3}$/.test(code) || /^(ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EPIPE|57P0[123]|53300)$/.test(code))) ||
    (typeof message === "string" && /connection (terminated|timeout)|timeout exceeded|query read timeout/i.test(message))
  );
}

async function transaction<T>(pool: Pool, readOnly: boolean, operation: (client: PoolClient) => Promise<T>): Promise<T> {
  let client: PoolClient | null = null;
  try {
    client = await pool.connect();
    await client.query(readOnly ? "BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY" : "BEGIN");
    const value = await operation(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    if (client) await client.query("ROLLBACK").catch(() => {});
    if (
      error instanceof ResearchIssueIntegrityError ||
      error instanceof ResearchIssueStoreUnavailableError ||
      error instanceof ResearchIssueNotFoundError ||
      error instanceof ProjectReadOnlyError ||
      error instanceof IdempotencyConflictError
    ) throw error;
    if (isConnectionError(error)) throw new ResearchIssueStoreUnavailableError("RESEARCH_ISSUE_STORE_UNAVAILABLE");
    throw error;
  } finally {
    client?.release();
  }
}

function projectContext(row: ProjectRow): ResearchIssueProjectContext {
  if (
    typeof row.id !== "string" ||
    typeof row.name !== "string" ||
    !row.name.trim() ||
    row.name !== row.name.trim() ||
    (row.lifecycle_state !== "ACTIVE" && row.lifecycle_state !== "ARCHIVED")
  ) integrity("PROJECT_CANONICAL_INVALID");
  return {
    id: row.id,
    name: row.name,
    lifecycleState: row.lifecycle_state,
    readOnly: row.lifecycle_state === "ARCHIVED",
  };
}

function validMetadata(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalIssue(row: IssueRow, ownerProjectId: string): ResearchIssue {
  if (
    typeof row.issue_id !== "string" ||
    typeof row.title !== "string" ||
    typeof row.question !== "string" ||
    !row.created_at || Number.isNaN(row.created_at.getTime()) ||
    !row.updated_at || Number.isNaN(row.updated_at.getTime()) ||
    !["OPEN", "RESOLVED", "ARCHIVED"].includes(row.lifecycle_state ?? "")
  ) integrity("ISSUE_CANONICAL_INVALID");

  let normalized;
  try {
    normalized = readResearchIssueInput({ title: row.title, question: row.question });
    readResearchIssueId(row.issue_id);
  } catch {
    integrity("ISSUE_CANONICAL_INVALID");
  }
  if (normalized.title !== row.title || normalized.question !== row.question) integrity("ISSUE_CANONICAL_INVALID");

  return {
    id: row.issue_id,
    projectId: ownerProjectId,
    title: row.title,
    question: row.question,
    lifecycleState: row.lifecycle_state as ResearchIssue["lifecycleState"],
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function validOwner(row: IssueRow, expectedProjectId?: string): string {
  if (
    !row.binding_id ||
    !row.owner_project_id ||
    row.binding_role !== null ||
    !validMetadata(row.binding_metadata) ||
    (expectedProjectId && row.owner_project_id !== expectedProjectId)
  ) integrity("ISSUE_OWNER_INVALID");
  return row.owner_project_id;
}

async function readProject(client: PoolClient, projectId: string, forUpdate = false): Promise<ProjectRow | null> {
  const result = await client.query<ProjectRow>(
    `SELECT id, name, lifecycle_state
     FROM core.projects
     WHERE id = $1${forUpdate ? " FOR UPDATE" : ""}`,
    [projectId],
  );
  return result.rows[0] ?? null;
}

async function readIssueRows(client: PoolClient, issueId: string): Promise<IssueRow[]> {
  return (await client.query<IssueRow>(
    `SELECT
       ri.id AS issue_id,
       ri.title,
       ri.question,
       ri.lifecycle_state,
       ri.created_at,
       ri.updated_at,
       pb.id AS binding_id,
       pb.project_id AS owner_project_id,
       pb.binding_role,
       pb.metadata AS binding_metadata
     FROM core.research_issues ri
     LEFT JOIN core.project_bindings pb
       ON pb.target_type = 'RESEARCH_ISSUE'
      AND pb.target_id = ri.id
     WHERE ri.id = $1
     ORDER BY pb.id`,
    [issueId],
  )).rows;
}

function issueFromDetailRows(rows: IssueRow[], requestedProjectId: string): ResearchIssue | null {
  if (rows.length === 0) return null;
  if (rows.length !== 1 || !rows[0].binding_id) integrity("ISSUE_OWNER_COUNT_INVALID");
  const ownerProjectId = validOwner(rows[0]);
  const issue = canonicalIssue(rows[0], ownerProjectId);
  return ownerProjectId === requestedProjectId ? issue : null;
}

function lifecycleOrder(value: ResearchIssue["lifecycleState"]): number {
  return value === "OPEN" ? 0 : value === "RESOLVED" ? 1 : 2;
}

export function createPostgresResearchIssueStore(pool: Pool): ResearchIssueStore {
  return {
    list(projectId) {
      return transaction(pool, true, async (client) => {
        const projectRow = await readProject(client, projectId);
        if (!projectRow) return null;
        const project = projectContext(projectRow);
        const rows = (await client.query<IssueRow>(
          `WITH owner_counts AS (
             SELECT target_id AS issue_id, count(*)::int AS owner_count
             FROM core.project_bindings
             WHERE target_type = 'RESEARCH_ISSUE'
             GROUP BY target_id
           )
           SELECT
             pb.id AS binding_id,
             pb.project_id AS owner_project_id,
             pb.binding_role,
             pb.metadata AS binding_metadata,
             ri.id AS issue_id,
             ri.title,
             ri.question,
             ri.lifecycle_state,
             ri.created_at,
             ri.updated_at,
             oc.owner_count
           FROM core.project_bindings pb
           LEFT JOIN core.research_issues ri ON ri.id = pb.target_id
           LEFT JOIN owner_counts oc ON oc.issue_id = pb.target_id
           WHERE pb.project_id = $1
             AND pb.target_type = 'RESEARCH_ISSUE'
           ORDER BY CASE ri.lifecycle_state WHEN 'OPEN' THEN 0 WHEN 'RESOLVED' THEN 1 WHEN 'ARCHIVED' THEN 2 ELSE 3 END,
                    ri.updated_at DESC,
                    ri.id DESC`,
          [projectId],
        )).rows;

        const issues: ResearchIssueSummary[] = rows.map((row) => {
          if (Number(row.owner_count) !== 1) integrity("ISSUE_OWNER_COUNT_INVALID");
          const ownerProjectId = validOwner(row, projectId);
          const issue = canonicalIssue(row, ownerProjectId);
          return {
            id: issue.id,
            projectId: issue.projectId,
            title: issue.title,
            questionExcerpt: buildResearchIssueQuestionExcerpt(issue.question),
            lifecycleState: issue.lifecycleState,
            createdAt: issue.createdAt,
            updatedAt: issue.updatedAt,
          };
        });
        issues.sort((a, b) => {
          const lifecycle = lifecycleOrder(a.lifecycleState) - lifecycleOrder(b.lifecycleState);
          if (lifecycle) return lifecycle;
          if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? -1 : 1;
          return a.id > b.id ? -1 : a.id < b.id ? 1 : 0;
        });
        return { project, issues };
      });
    },

    get(projectId, issueId) {
      return transaction(pool, true, async (client) => {
        const row = await readProject(client, projectId);
        if (!row) return null;
        const project = projectContext(row);
        const issue = issueFromDetailRows(await readIssueRows(client, issueId), projectId);
        return issue ? { project, issue } : null;
      });
    },

    create(input) {
      return transaction(pool, false, async (client) => {
        const scope = `S32:M2A:PROJECT_ISSUE_CREATE:${input.projectId}`;
        const reservationId = randomUUID();
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO ops.idempotency_keys
             (id, scope, idempotency_key, request_hash, status)
           VALUES ($1, $2, $3, $4, 'IN_PROGRESS')
           ON CONFLICT (scope, idempotency_key) DO NOTHING
           RETURNING id`,
          [reservationId, scope, input.idempotencyKey, input.requestHash],
        );

        if (inserted.rows.length === 0) {
          const existing = (await client.query<IdempotencyRow>(
            `SELECT id, request_hash, status, resource_type, resource_id, result_payload
             FROM ops.idempotency_keys
             WHERE scope = $1 AND idempotency_key = $2
             FOR UPDATE`,
            [scope, input.idempotencyKey],
          )).rows[0];
          if (!existing) integrity("IDEMPOTENCY_ROW_MISSING");
          if (existing.request_hash.trim() !== input.requestHash) throw new IdempotencyConflictError("IDEMPOTENCY_CONFLICT");
          if (existing.status !== "COMPLETED" || existing.resource_type !== "RESEARCH_ISSUE" || !existing.resource_id) {
            integrity("IDEMPOTENCY_ROW_INVALID");
          }
          const projectRow = await readProject(client, input.projectId);
          if (!projectRow) integrity("REPLAY_PROJECT_MISSING");
          const project = projectContext(projectRow);
          const issue = issueFromDetailRows(await readIssueRows(client, existing.resource_id), input.projectId);
          if (!issue) integrity("REPLAY_RESOURCE_INVALID");
          return { status: "replayed" as const, project, issue };
        }

        const lockedProject = await readProject(client, input.projectId, true);
        if (!lockedProject) throw new ResearchIssueNotFoundError("PROJECT_NOT_FOUND");
        const project = projectContext(lockedProject);
        if (project.readOnly) throw new ProjectReadOnlyError("PROJECT_READ_ONLY");

        await client.query(
          `INSERT INTO core.research_issues
             (id, title, question, lifecycle_state, current_resolution_id, metadata)
           VALUES ($1, $2, $3, 'OPEN', NULL, '{}'::jsonb)`,
          [input.issueId, input.title, input.question],
        );
        await client.query(
          `INSERT INTO core.project_bindings
             (id, project_id, target_type, target_id, binding_role, metadata)
           VALUES ($1, $2, 'RESEARCH_ISSUE', $3, NULL, '{}'::jsonb)`,
          [randomUUID(), input.projectId, input.issueId],
        );

        const issue = issueFromDetailRows(await readIssueRows(client, input.issueId), input.projectId);
        if (!issue) integrity("CREATED_ISSUE_OWNER_INVALID");
        await client.query(
          `UPDATE ops.idempotency_keys
           SET status = 'COMPLETED',
               resource_type = 'RESEARCH_ISSUE',
               resource_id = $2,
               result_payload = $3::jsonb,
               updated_at = now(),
               completed_at = now()
           WHERE id = $1`,
          [inserted.rows[0].id, input.issueId, JSON.stringify({ issueId: input.issueId })],
        );
        return { status: "created" as const, project, issue };
      });
    },
  };
}
