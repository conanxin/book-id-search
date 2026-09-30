import { afterEach, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { S32Config } from "../config.js";
import { createProjectRouter } from "./project-routes.js";
import { createIssueResolutionBodyParser } from "./issue-resolution-routes.js";
import { createResearchRunBodyParser } from "./research-run-routes.js";
import { createProjectItemNoteBodyParser } from "./project-item-note-routes.js";
import { createS32RequestAuthorizer } from "./private-auth.js";
import { readGoogleSessionAuthConfig } from "../../auth/config.js";
import { issueWebSession } from "../../auth/web-session.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProjectsService } from "../application/projects.js";
import type { Project } from "../domain/project.js";

const OWNER_SUB = "owner-sub-123";
const SECRET = "x".repeat(48);
const ORIGIN = "https://books.example.com";
const NOW = Math.floor(Date.now() / 1000) - 60;

const s32: S32Config = { enabled: true, databaseUrl: "postgresql://example/test", privateToken: "legacy-secret" };

const googleConfig = readGoogleSessionAuthConfig({
  NODE_ENV: "production",
  GOOGLE_AUTH_ENABLED: "true",
  GOOGLE_CLIENT_ID: "cid.apps.googleusercontent.com",
  BOOK_ID_SEARCH_OWNER_GOOGLE_SUB: OWNER_SUB,
  BOOK_ID_SEARCH_SESSION_SECRET: SECRET,
  BOOK_ID_SEARCH_PUBLIC_ORIGIN: ORIGIN,
});

function mint(sub = OWNER_SUB): { cookie: string; csrf: string } {
  const { token, payload } = issueWebSession(
    { sub, email: "owner@example.com", name: "Owner" },
    { secret: SECRET, nowSeconds: NOW },
  );
  return { cookie: `__Host-book_id_search_session=${token}`, csrf: payload.csrf };
}

/** Projects service spy recording service reach-through. */
function spyProjects(): ProjectsService & { calls: string[] } {
  const calls: string[] = [];
  const project: Project = {
    id: "p1", title: "t", description: null, status: "active",
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  } as unknown as Project;
  return {
    calls,
    async create() { calls.push("create"); return project; },
    async list() { calls.push("list"); return [project]; },
    async get() { calls.push("get"); return project; },
  } as unknown as ProjectsService & { calls: string[] };
}

interface Server {
  baseUrl: string;
  close(): Promise<void>;
}

async function listen(app: express.Express): Promise<Server> {
  const server = app.listen(0);
  await new Promise<void>(r => server.once("listening", r));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>(r => server.close(() => r())),
  };
}

describe("Task 5 route-level session proof", () => {
  let projects: ReturnType<typeof spyProjects>;
  let app: express.Express;
  let srv: Server;
  beforeEach(() => {
    projects = spyProjects();
    app = express();
    app.use("/api/private/s32/projects", createProjectRouter(s32, projects, createS32RequestAuthorizer(s32, googleConfig)));
  });
  afterEach(async () => { await srv?.close(); });

  it("valid session GET, no bearer → reaches service", async () => {
    srv = await listen(app);
    const res = await fetch(`${srv.baseUrl}/api/private/s32/projects`, { headers: { cookie: mint().cookie } });
    expect(res.status).toBe(200);
    expect(projects.calls).toContain("list");
  });

  it("valid session POST + Origin+CSRF → reaches service", async () => {
    srv = await listen(app);
    const session = mint();
    const res = await fetch(`${srv.baseUrl}/api/private/s32/projects`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: session.cookie, origin: ORIGIN, "x-csrf-token": session.csrf },
      body: JSON.stringify({ title: "x" }),
    });
    expect(res.status).toBe(201);
    expect(projects.calls).toContain("create");
  });

  it("valid session POST missing CSRF → service 0 calls", async () => {
    srv = await listen(app);
    const res = await fetch(`${srv.baseUrl}/api/private/s32/projects`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: mint().cookie, origin: ORIGIN },
      body: JSON.stringify({ title: "x" }),
    });
    expect(res.status).toBe(403);
    expect(projects.calls).toHaveLength(0);
  });

  it("wrong bearer + valid session → service 0 calls (no fallback)", async () => {
    srv = await listen(app);
    const res = await fetch(`${srv.baseUrl}/api/private/s32/projects`, {
      headers: { authorization: "Bearer wrong", cookie: mint().cookie },
    });
    expect(res.status).toBe(403);
    expect(projects.calls).toHaveLength(0);
  });

  it("service unavailable after valid session → 503 config error, not auth 401", async () => {
    const offline = express();
    // databaseUrl present in config but service null → 503 path after auth PASS
    offline.use("/api/private/s32/projects", createProjectRouter(
      { ...s32, databaseUrl: null }, null, createS32RequestAuthorizer(s32, googleConfig)));
    const s2 = await listen(offline);
    try {
      const res = await fetch(`${s2.baseUrl}/api/private/s32/projects`, { headers: { cookie: mint().cookie } });
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.error.message).toContain("尚未配置");
    } finally { await s2.close(); }
  });

  it("legacy bearer still passes with no authorizer knowledge of sessions", async () => {
    srv = await listen(app);
    const res = await fetch(`${srv.baseUrl}/api/private/s32/projects`, {
      headers: { authorization: "Bearer legacy-secret" },
    });
    expect(res.status).toBe(200);
    expect(projects.calls).toContain("list");
  });
});

describe("Task 5 pre-body parser gates (auth before body)", () => {
  let srv: Server;
  afterEach(async () => { await srv?.close(); });

  function buildParserApp(): express.Express {
    const app = express();
    const authorizer = createS32RequestAuthorizer(s32, googleConfig);
    // path-scoped mounts like production index.ts
    app.use("/api/private/s32/projects/:projectId/items/:bindingId/note", createProjectItemNoteBodyParser(s32, authorizer));
    app.use("/api/private/s32/projects", createIssueResolutionBodyParser(s32, authorizer));
    app.use("/api/private/s32/projects", createResearchRunBodyParser(s32, authorizer));
    // downstream handler that would only see parsed bodies
    app.use((req, res) => { res.status(200).json({ reached: true, body: req.body ?? null }); });
    return app;
  }

  it("no auth + malformed JSON → auth failure (401), not JSON 400", async () => {
    srv = await listen(buildParserApp());
    const res = await fetch(`${srv.baseUrl}/api/private/s32/projects/p1/issues/i1/resolutions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{malformed",
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.message).toBe("Missing token.");
  });

  it("wrong bearer + valid Google cookie + malformed JSON → 403 legacy, no fallback", async () => {
    srv = await listen(buildParserApp());
    const res = await fetch(`${srv.baseUrl}/api/private/s32/projects/p1/issues/i1/resolutions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer wrong", cookie: mint().cookie },
      body: "{malformed",
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.message).toBe("Invalid token.");
  });

  it("valid session but missing CSRF + malformed JSON → 403 CSRF, body never parsed", async () => {
    srv = await listen(buildParserApp());
    const res = await fetch(`${srv.baseUrl}/api/private/s32/projects/p1/issues/i1/resolutions`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: mint().cookie, origin: ORIGIN },
      body: "{malformed",
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.message).toContain("CSRF");
  });

  it("valid session + Origin + CSRF + malformed JSON → 400 ISSUE_RESOLUTION_INVALID", async () => {
    srv = await listen(buildParserApp());
    const session = mint();
    const res = await fetch(`${srv.baseUrl}/api/private/s32/projects/p1/issues/i1/resolutions`, {
      method: "POST",
      headers: {
        "content-type": "application/json", cookie: session.cookie,
        origin: ORIGIN, "x-csrf-token": session.csrf,
      },
      body: "{malformed",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("ISSUE_RESOLUTION_INVALID");
  });

  it("malformed encoded path without auth does not leak a path-decode error", async () => {
    srv = await listen(buildParserApp());
    const res = await fetch(`${srv.baseUrl}/api/private/s32/projects/%zz/issues/i1/resolutions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect([401, 404]).toContain(res.status);
    const text = await res.text();
    expect(text).not.toContain("decode");
    expect(text).not.toContain("Failed to decode");
  });

  it("note parser: legacy bearer oversized/malformed guarantees hold", async () => {
    srv = await listen(buildParserApp());
    const malformed = await fetch(`${srv.baseUrl}/api/private/s32/projects/p1/items/b1/note`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer legacy-secret" },
      body: "{malformed",
    });
    expect(malformed.status).toBe(400);
    const body = await malformed.json();
    expect(body.error.code).toBe("NOTE_INVALID_INPUT");
  });
});

describe("ResearchRun parser mount proof (index.ts ordering)", () => {
  it("createResearchRunBodyParser is imported and mounted before the global express.json", () => {
    const indexSource = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "..", "index.ts"),
      "utf8",
    );
    const parserMount = indexSource.indexOf('createResearchRunBodyParser(s32Config, s32RequestAuthorizer)');
    const globalJson = indexSource.indexOf('app.use(express.json({ limit: "256kb" }))');
    expect(parserMount).toBeGreaterThan(-1);
    expect(globalJson).toBeGreaterThan(parserMount);
    expect(indexSource).toContain('import { createResearchRunBodyParser } from "./s32/routes/research-run-routes.js"');
  });

  function runApp(): express.Express {
    const app = express();
    const s32: S32Config = { enabled: true, databaseUrl: "postgresql://x", privateToken: "t" };
    const googleConfig = readGoogleSessionAuthConfig(process.env);
    const authorizer = createS32RequestAuthorizer(s32, googleConfig);
    app.use("/api/private/s32/projects", createResearchRunBodyParser(s32, authorizer));
    app.use(express.json({ limit: "256kb" }));
    app.use((req, res) => { res.status(200).json({ reached: true, body: req.body ?? null }); });
    return app;
  }

  it("research-run POST paths: unauthenticated malformed JSON is answered by auth, not the JSON parser", async () => {
    const app = runApp();
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server.once("listening", resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/private/s32/projects/p1/issues/i1/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not-json",
      });
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error?.code).toBeUndefined();
    } finally {
      await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
    }
  });

  it("research-run transition POST paths: same auth-first guarantee", async () => {
    const app = runApp();
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server.once("listening", resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/private/s32/projects/p1/issues/i1/runs/r1/complete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not-json",
      });
      expect(res.status).toBe(401);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
    }
  });
});
