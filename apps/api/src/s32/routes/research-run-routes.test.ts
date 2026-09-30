import { beforeEach, describe, expect, it, vi } from "vitest";
import express, { type Express, type Request, type Response } from "express";
import type { AddressInfo } from "node:net";
import type { S32Config } from "../config.js";
import type { S32RequestAuthorizer } from "./private-auth.js";
import {
  ProjectReadOnlyForResearchRunError,
  ResearchIssueReadOnlyForResearchRunError,
  ResearchRunAlreadyTerminalError,
  ResearchRunEvidenceNotAvailableError,
  ResearchRunIdempotencyConflictError,
  ResearchRunIntegrityError,
  ResearchRunInvalidInputError,
  ResearchRunNotFoundError,
  ResearchRunReplayInvalidError,
  ResearchRunScopeNotFoundError,
  ResearchRunStoreUnavailableError,
} from "../application/research-runs.js";
import { createResearchRunBodyParser, createResearchRunRouter } from "./research-run-routes.js";

const P = "11111111-1111-4111-8111-111111111111";
const I = "22222222-2222-4222-8222-222222222222";
const RUN = "33333333-3333-4333-8333-333333333333";
const KEY = "44444444-4444-4444-8444-444444444444";

const config: S32Config = { enabled: true, databaseUrl: "postgresql://x", privateToken: "t" };
const validToken = "Bearer t";

const START_BODY = {
  procedure: { version: 1, objective: "o", method: "m", steps: [{ kind: "SEARCH", description: "d" }] },
  executionContract: { version: 1, mode: "HUMAN", reproducibilityLevel: "PROCEDURE", tools: [] },
  environment: { locale: "zh-CN" },
  evidenceManifestId: "55555555-5555-4555-8555-555555555555",
  replayOf: null,
};
const OUTPUT = { version: 1, summary: "s", produced: { claimIds: [], assessmentIds: [], resolutionIds: [], noteRevisionIds: [] }, gaps: [] };

function serviceMock() {
  return {
    start: vi.fn(async () => ({ status: "created", runId: RUN })),
    list: vi.fn(async () => ({ runs: [], nextCursor: null })),
    get: vi.fn(async () => ({ run: { runId: RUN }, evidenceManifest: { available: true }, ancestors: [] })),
    complete: vi.fn(async () => ({ status: "created", runId: RUN })),
    fail: vi.fn(async () => ({ status: "created", runId: RUN })),
    cancel: vi.fn(async () => ({ status: "created", runId: RUN })),
    replay: vi.fn(async () => ({ status: "created", runId: RUN })),
  };
}
type ServiceMock = ReturnType<typeof serviceMock>;

function app(service: ServiceMock | null, opts: { authorizer?: S32RequestAuthorizer; withParser?: boolean } = {}) {
  const application: Express = express();
  application.use("/api/private/s32/projects", createResearchRunBodyParser(config, opts.authorizer));
  application.use(express.json({ limit: "256kb" }));
  application.use("/api/private/s32/projects", createResearchRunRouter(config, service as never, opts.authorizer));
  return application;
}

async function listen(application: Express) {
  const server = application.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  return { server, port: (server.address() as AddressInfo).port };
}
async function close(server: { close: (cb: (e?: Error) => void) => void }) {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
const base = (port: number) => `http://127.0.0.1:${port}/api/private/s32/projects/${P}/issues/${I}/runs`;

describe("ResearchRun auth-before-parser", () => {
  it("unauthenticated malformed JSON → auth error, not JSON 400", async () => {
    const svc = serviceMock();
    const { server, port } = await listen(app(svc));
    try {
      const res = await fetch(base(port), {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{not-json",
      });
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toBeDefined();
      expect(body.error.code).toBeUndefined();
      expect(svc.start).not.toHaveBeenCalled();
    } finally { await close(server); }
  });

  it("invalid legacy token malformed body → auth error; authorizer called before parsing", async () => {
    const authorizer: S32RequestAuthorizer = vi.fn(() => ({ ok: false as const, status: 403 as const, message: "denied" }));
    const svc = serviceMock();
    const { server, port } = await listen(app(svc, { authorizer }));
    try {
      const res = await fetch(base(port), {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer wrong" }, body: "{not-json",
      });
      expect(res.status).toBe(403);
      expect(authorizer).toHaveBeenCalled();
      expect(svc.start).not.toHaveBeenCalled();
    } finally { await close(server); }
  });

  it("authorized malformed JSON → 400 RESEARCH_RUN_INVALID; authorized valid body reaches service", async () => {
    const svc = serviceMock();
    const { server, port } = await listen(app(svc));
    try {
      const bad = await fetch(base(port), {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: validToken, "Idempotency-Key": KEY }, body: "{not-json",
      });
      expect(bad.status).toBe(400);
      expect(await bad.json()).toEqual({ error: { code: "RESEARCH_RUN_INVALID", message: "研究执行输入不正确。" } });

      const ok = await fetch(base(port), {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: validToken, "Idempotency-Key": KEY },
        body: JSON.stringify(START_BODY),
      });
      expect(ok.status).toBe(201);
      expect(svc.start).toHaveBeenCalledExactlyOnceWith(P, I, KEY, START_BODY);
    } finally { await close(server); }
  });

  it("body over 256kb rejected after auth with 400", async () => {
    const svc = serviceMock();
    const { server, port } = await listen(app(svc));
    try {
      const big = JSON.stringify({ ...START_BODY, environment: { pad: "x".repeat(300 * 1024) } });
      const res = await fetch(base(port), {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: validToken, "Idempotency-Key": KEY }, body: big,
      });
      expect(res.status).toBe(400);
      expect(svc.start).not.toHaveBeenCalled();
    } finally { await close(server); }
  });

  it("transition POSTs are pre-parsed; GET list/detail need auth but no body parsing", async () => {
    const svc = serviceMock();
    const { server, port } = await listen(app(svc));
    try {
      const bad = await fetch(`${base(port)}/${RUN}/complete`, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: validToken, "Idempotency-Key": KEY }, body: "{oops",
      });
      expect(bad.status).toBe(400);

      const unauth = await fetch(base(port));
      expect(unauth.status).toBe(401);
      const ok = await fetch(base(port), { headers: { Authorization: validToken } });
      expect(ok.status).toBe(200);
      expect(svc.list).toHaveBeenCalledExactlyOnceWith(P, I, {});
    } finally { await close(server); }
  });

  it("sibling POST paths (e.g. resolutions) are NOT intercepted by the pre-parser", async () => {
    let parsedByGlobal = false;
    const application = express();
    application.use("/api/private/s32/projects", createResearchRunBodyParser(config));
    application.use(express.json({ limit: "256kb" }));
    application.use("/api/private/s32/projects", (req: Request, res: Response) => {
      parsedByGlobal = true;
      res.status(200).json({ sibling: true });
    });
    const { server, port } = await listen(application);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/private/s32/projects/${P}/issues/${I}/resolutions`, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: validToken }, body: "{}",
      });
      expect(res.status).toBe(200);
      expect(parsedByGlobal).toBe(true);
    } finally { await close(server); }
  });
});

describe("ResearchRun routing semantics", () => {
  let svc: ServiceMock;
  let server: { close: (cb: (e?: Error) => void) => void };
  let port: number;

  beforeEach(async () => {
    svc = serviceMock();
    const l = await listen(app(svc));
    server = l.server; port = l.port;
    return async () => { await close(server); };
  });

  it("START created → 201; same-key replay → 200", async () => {
    const created = await fetch(base(port), {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: validToken, "Idempotency-Key": KEY },
      body: JSON.stringify(START_BODY),
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ status: "created", runId: RUN });

    svc.start.mockResolvedValueOnce({ status: "replayed", runId: RUN });
    const replayed = await fetch(base(port), {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: validToken, "Idempotency-Key": KEY },
      body: JSON.stringify(START_BODY),
    });
    expect(replayed.status).toBe(200);
  });

  it("REPLAY created → 201; replay → 200; runId + Idempotency-Key forwarded exactly", async () => {
    const created = await fetch(`${base(port)}/${RUN}/replay`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: validToken, "Idempotency-Key": KEY },
      body: JSON.stringify({ procedure: START_BODY.procedure, executionContract: START_BODY.executionContract, environment: START_BODY.environment, evidenceManifestId: START_BODY.evidenceManifestId }),
    });
    expect(created.status).toBe(201);
    expect(svc.replay).toHaveBeenCalledExactlyOnceWith(P, I, RUN, KEY, {
      procedure: START_BODY.procedure, executionContract: START_BODY.executionContract, environment: START_BODY.environment, evidenceManifestId: START_BODY.evidenceManifestId,
    });

    svc.replay.mockResolvedValueOnce({ status: "replayed", runId: RUN });
    const replayed = await fetch(`${base(port)}/${RUN}/replay`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: validToken, "Idempotency-Key": KEY },
      body: JSON.stringify({ procedure: START_BODY.procedure, executionContract: START_BODY.executionContract, environment: START_BODY.environment, evidenceManifestId: START_BODY.evidenceManifestId }),
    });
    expect(replayed.status).toBe(200);
  });

  it.each(["complete", "fail", "cancel"] as const)("TRANSITION %s forwards key + exact body; 200 on success and replay", async (action) => {
    const body = action === "complete" ? { output: OUTPUT } : { output: null };
    const first = await fetch(`${base(port)}/${RUN}/${action}`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: validToken, "Idempotency-Key": KEY },
      body: JSON.stringify(body),
    });
    expect(first.status).toBe(200);
    expect(svc[action]).toHaveBeenCalledExactlyOnceWith(P, I, RUN, KEY, body);

    svc[action].mockResolvedValueOnce({ status: "replayed", runId: RUN });
    const replayed = await fetch(`${base(port)}/${RUN}/${action}`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: validToken, "Idempotency-Key": KEY },
      body: JSON.stringify(body),
    });
    expect(replayed.status).toBe(200);
  });

  it("transition body with unknown field → 400 from service strict parser; missing Idempotency-Key → 400", async () => {
    svc.complete.mockRejectedValueOnce(new ResearchRunInvalidInputError("strict"));
    const bad = await fetch(`${base(port)}/${RUN}/complete`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: validToken, "Idempotency-Key": KEY },
      body: JSON.stringify({ output: OUTPUT, extra: 1 }),
    });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: { code: "RESEARCH_RUN_INVALID", message: "研究执行输入不正确。" } });

    svc.cancel.mockRejectedValueOnce(new ResearchRunInvalidInputError("key"));
    const noKey = await fetch(`${base(port)}/${RUN}/cancel`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: validToken },
      body: JSON.stringify({ output: null }),
    });
    expect(noKey.status).toBe(400);
  });

  it("LIST forwards query; DETAIL forwards runId; Cache-Control no-store everywhere", async () => {
    const list = await fetch(`${base(port)}?limit=5&cursor=abc`, { headers: { Authorization: validToken } });
    expect(list.status).toBe(200);
    expect(list.headers.get("Cache-Control")).toBe("no-store");
    expect(svc.list).toHaveBeenCalledExactlyOnceWith(P, I, { limit: "5", cursor: "abc" });

    const detail = await fetch(`${base(port)}/${RUN}`, { headers: { Authorization: validToken } });
    expect(detail.status).toBe(200);
    expect(detail.headers.get("Cache-Control")).toBe("no-store");
    expect(svc.get).toHaveBeenCalledExactlyOnceWith(P, I, RUN);
  });

  it("every typed error maps to its exact safe status/code", async () => {
    const cases: Array<[Error, number, string | undefined]> = [
      [new ResearchRunInvalidInputError("x"), 400, "RESEARCH_RUN_INVALID"],
      [new ResearchRunScopeNotFoundError("x"), 404, "PROJECT_OR_ISSUE_NOT_FOUND"],
      [new ResearchRunNotFoundError("x"), 404, "RESEARCH_RUN_NOT_FOUND"],
      [new ResearchRunEvidenceNotAvailableError("x"), 404, "EVIDENCE_MANIFEST_NOT_AVAILABLE"],
      [new ProjectReadOnlyForResearchRunError("x"), 409, "PROJECT_READ_ONLY"],
      [new ResearchIssueReadOnlyForResearchRunError("x"), 409, "RESEARCH_ISSUE_READ_ONLY"],
      [new ResearchRunAlreadyTerminalError("x"), 409, "RESEARCH_RUN_ALREADY_TERMINAL"],
      [new ResearchRunReplayInvalidError("x"), 409, "RESEARCH_RUN_REPLAY_INVALID"],
      [new ResearchRunIdempotencyConflictError("x"), 409, "IDEMPOTENCY_CONFLICT"],
      [new ResearchRunStoreUnavailableError("x"), 503, "RESEARCH_RUN_STORE_UNAVAILABLE"],
      [new ResearchRunIntegrityError("internal-detail-must-not-leak"), 500, undefined],
      [new Error("anything"), 500, undefined],
    ];
    for (const [error, status, code] of cases) {
      svc.start.mockRejectedValueOnce(error);
      const res = await fetch(base(port), {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: validToken, "Idempotency-Key": KEY },
        body: JSON.stringify(START_BODY),
      });
      expect(res.status).toBe(status);
      const body = await res.json();
      expect(body.error.code).toBe(code);
      expect(JSON.stringify(body)).not.toContain("internal-detail");
    }
  });

  it("service unconfigured (null) → 503 on ResearchRun paths only", async () => {
    const application = express();
    application.use("/api/private/s32/projects", createResearchRunBodyParser(config));
    application.use(express.json({ limit: "256kb" }));
    const s32 = express.Router();
    s32.use("/projects", createResearchRunRouter(config, null));
    s32.use("/projects", (_req: Request, res: Response) => res.json({ sibling: true }));
    application.use("/api/private/s32", s32);
    const { server: srv, port: p } = await listen(application);
    try {
      const res = await fetch(base(p), { headers: { Authorization: validToken } });
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.error.code).toBe("RESEARCH_RUN_STORE_UNAVAILABLE");

      const sibling = await fetch(`http://127.0.0.1:${p}/api/private/s32/projects/${P}/overview`, { headers: { Authorization: validToken } });
      expect(sibling.status).toBe(200);
    } finally { await close(srv); }
  });
});
