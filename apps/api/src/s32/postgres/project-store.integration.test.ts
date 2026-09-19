import { once } from "node:events";
import type { Server } from "node:http";
import express from "express";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createProjectsService } from "../application/projects.js";
import { createProjectRouter } from "../routes/project-routes.js";
import { createPostgresProjectStore } from "./project-store.js";

// Only the disposable runner sets this variable. Never fall back to S32_DATABASE_URL.
const databaseUrl = process.env.S32_M1B_TEST_DATABASE_URL;
const url = databaseUrl ? new URL(databaseUrl) : null;
if (url && (url.hostname !== "127.0.0.1" || url.pathname !== "/s32_m1b_test")) {
  throw new Error("M1B integration tests require the isolated local s32_m1b_test database");
}
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
let server: Server;
let base: string;
beforeAll(async () => {
  if (!pool) return;
  const app = express();
  app.use(express.json());
  app.use("/api/private/s32/projects", createProjectRouter(
    { enabled: true, databaseUrl: databaseUrl!, privateToken: "integration-only" },
    createProjectsService(createPostgresProjectStore(pool)),
  ));
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/private/s32/projects`;
}, 15000);
afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve()));
  await pool?.end();
}, 30000);

test.skipIf(!pool)("real PostgreSQL persists projects, stable ordering and read-only GET without other domain writes", async () => {
  const headers = { Authorization: "Bearer integration-only", "Content-Type": "application/json" };
  const call = (path = "", init: RequestInit = {}) => fetch(base + path, { ...init, headers });
  expect((await (await call()).json()).projects).toEqual([]);
  const create = async (description: string | null) => {
    const res = await call("", { method: "POST", body: JSON.stringify({
      name: "  北京古道研究  ", description, metadata: { injected: true },
      lifecycleState: "ARCHIVED", id: "00000000-0000-0000-0000-000000000000",
    }) });
    expect(res.status).toBe(201);
    return (await res.json()).project;
  };
  const first = await create("  梳理北京古道的历史路线、沿线村落与文献线索。  ");
  const second = await create(null);
  expect(first.id).not.toBe(second.id);
  expect(first).toMatchObject({ name: "北京古道研究", description: "梳理北京古道的历史路线、沿线村落与文献线索。", lifecycleState: "ACTIVE" });
  expect(first.createdAt).toBe(first.updatedAt);
  const stored = await pool!.query("SELECT metadata FROM core.projects WHERE id=$1", [first.id]);
  expect(stored.rows[0].metadata).toEqual({ description: first.description });
  expect((await (await call(`/${first.id}`)).json()).project).toEqual(first);
  expect((await (await call(`/${second.id}`)).json()).project.description).toBeNull();
  expect((await (await call()).json()).projects.map((p: { id: string }) => p.id)).toEqual([second.id, first.id]);

  // Force a timestamp tie to exercise the UUID tie-breaker.
  await pool!.query("UPDATE core.projects SET created_at = '2026-01-01T00:00:00Z'");
  const before = (await pool!.query("SELECT * FROM core.projects ORDER BY id")).rows;
  for (let i = 0; i < 3; i++) {
    expect((await (await call()).json()).projects.map((p: { id: string }) => p.id)).toEqual([first.id, second.id].sort().reverse());
    expect((await call(`/${first.id}`)).status).toBe(200);
  }
  expect((await pool!.query("SELECT * FROM core.projects ORDER BY id")).rows).toEqual(before);
  expect((await call("/00000000-0000-0000-0000-000000000000")).status).toBe(404);
  expect((await call("/not-a-uuid")).status).toBe(400);
  await pool!.query("UPDATE core.projects SET metadata = '{\"description\":42}' WHERE id=$1", [second.id]);
  expect((await (await call(`/${second.id}`)).json()).project.description).toBeNull();
  const tables = (await pool!.query("SELECT schemaname, tablename FROM pg_tables WHERE schemaname IN ('core','ops','derived') AND NOT (schemaname='core' AND tablename='projects')")).rows;
  for (const { schemaname, tablename } of tables) {
    // Identifiers come only from the PostgreSQL catalog, quote them defensively.
    const quote = (s: string) => `"${s.replaceAll('"', '""')}"`;
    const count = await pool!.query(`SELECT count(*)::int AS n FROM ${quote(schemaname)}.${quote(tablename)}`);
    expect(count.rows[0].n, `${schemaname}.${tablename}`).toBe(0);
  }
}, 30000);
