import type { Pool } from "pg";
import { ProjectStoreUnavailableError, type ProjectStore } from "../application/projects.js";
import type { Project } from "../domain/project.js";

interface ProjectRow {
  id: string;
  name: string;
  metadata: Record<string, unknown>;
  lifecycle_state: Project["lifecycleState"];
  created_at: Date;
  updated_at: Date;
}
const COLUMNS = "id, name, metadata, lifecycle_state, created_at, updated_at";

function toProject(row: ProjectRow): Project {
  return {
    id: row.id, name: row.name,
    description: typeof row.metadata?.description === "string" ? row.metadata.description : null,
    lifecycleState: row.lifecycle_state,
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
  };
}

export function createPostgresProjectStore(pool: Pool): ProjectStore {
  async function query(sql: string, values: unknown[] = []) {
    try {
      return (await pool.query<ProjectRow>(sql, values)).rows;
    } catch (error) {
      const { code, message } = error as { code?: string; message?: string };
      if (/^(ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EPIPE|08[0-9A-Z]{3}|57P0[123]|53300)$/.test(code ?? "")
          || /connection (terminated|timeout)|timeout exceeded|query read timeout/i.test(message ?? "")) {
        throw new ProjectStoreUnavailableError("项目数据库暂不可用。");
      }
      throw error;
    }
  }
  return {
    async create(id, input) {
      const [row] = await query(
        `INSERT INTO core.projects (id, name, lifecycle_state, metadata)
         VALUES ($1, $2, 'ACTIVE', $3::jsonb) RETURNING ${COLUMNS}`,
        [id, input.name, JSON.stringify({ description: input.description })],
      );
      return toProject(row);
    },
    async list() {
      return (await query(`SELECT ${COLUMNS} FROM core.projects ORDER BY created_at DESC, id DESC`)).map(toProject);
    },
    async get(id) {
      const [row] = await query(`SELECT ${COLUMNS} FROM core.projects WHERE id = $1`, [id]);
      return row ? toProject(row) : null;
    },
  };
}
