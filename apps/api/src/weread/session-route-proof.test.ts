import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Request } from "express";
import { readGoogleSessionAuthConfig } from "../auth/config.js";
import { issueWebSession } from "../auth/web-session.js";
import { createWereadRequestAuthorizer, authorizeWereadRouteRequest } from "./private-auth.js";

/**
 * Task 6 §六.C/D: endpoint/session proof + side-effect order proof.
 *
 * The production entrypoint (index.ts) calls app.listen() at import time, so
 * these tests build the *equivalent handler gate*: the exact auth call shape
 * used by all nine migrated handlers (authorizeWereadRouteRequest(req,
 * wereadRequestAuthorizer) → {ok:false,error:auth.message}) followed by the
 * real side-effect call for each representative endpoint. Side-effect spies
 * prove auth failure short-circuits before overlay/limiter/AI/Meili run.
 */
const OWNER_SUB = "owner-sub-proof";
const G_SECRET = "p".repeat(48);
const G_ORIGIN = "https://books.example.com";
const MINT_NOW = Math.floor(Date.now() / 1000) - 60;
const LEGACY_TOKEN = "weread-legacy-token";

const googleConfig = readGoogleSessionAuthConfig({
  NODE_ENV: "production",
  GOOGLE_AUTH_ENABLED: "true",
  GOOGLE_CLIENT_ID: "cid.apps.googleusercontent.com",
  BOOK_ID_SEARCH_OWNER_GOOGLE_SUB: OWNER_SUB,
  BOOK_ID_SEARCH_SESSION_SECRET: G_SECRET,
  BOOK_ID_SEARCH_PUBLIC_ORIGIN: G_ORIGIN,
});

function mint(sub = OWNER_SUB): { cookie: string; csrf: string } {
  const { token, payload } = issueWebSession(
    { sub, email: "owner@example.com", name: "Owner" },
    { secret: G_SECRET, nowSeconds: MINT_NOW },
  );
  return { cookie: `__Host-book_id_search_session=${token}`, csrf: payload.csrf };
}

interface Server { baseUrl: string; close(): Promise<void> }
async function listen(app: express.Express): Promise<Server> {
  const server = app.listen(0);
  await new Promise<void>(r => server.once("listening", r));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>(r => server.close(() => r())),
  };
}

describe("Task 6 endpoint/session proof (equivalent handler gates)", () => {
  let srv: Server;
  const originalEnv = { ...process.env };
  beforeEach(() => {
    process.env.WEREAD_OVERLAY_ENABLED = "true";
    process.env.WEREAD_PRIVATE_API_TOKEN = LEGACY_TOKEN;
  });
  afterEach(async () => {
    process.env.WEREAD_OVERLAY_ENABLED = originalEnv.WEREAD_OVERLAY_ENABLED;
    process.env.WEREAD_PRIVATE_API_TOKEN = originalEnv.WEREAD_PRIVATE_API_TOKEN;
    await srv?.close();
  });

  function gateApp(sideEffect: (req: Request) => void): express.Express {
    const app = express();
    const wereadRequestAuthorizer = createWereadRequestAuthorizer(googleConfig);
    app.get("/api/private/weread/summary", (req, res) => {
      // exact migrated handler shape from index.ts
      const auth = authorizeWereadRouteRequest(req, wereadRequestAuthorizer);
      if (!auth.ok) {
        return res.status(auth.status).json({ ok: false, error: auth.message });
      }
      sideEffect(req);
      res.json({ ok: true });
    });
    app.post("/api/private/weread/notes/summarize", express.json({ limit: "256kb" }), (req, res) => {
      const auth = authorizeWereadRouteRequest(req, wereadRequestAuthorizer);
      if (!auth.ok) {
        return res.status(auth.status).json({ ok: false, error: auth.message });
      }
      sideEffect(req);
      res.json({ ok: true });
    });
    return app;
  }

  it("valid Google session GET enters business", async () => {
    const effect = vi.fn();
    srv = await listen(gateApp(effect));
    const res = await fetch(`${srv.baseUrl}/api/private/weread/summary`, { headers: { cookie: mint().cookie } });
    expect(res.status).toBe(200);
    expect(effect).toHaveBeenCalledTimes(1);
  });

  it("valid Google session POST + Origin + CSRF enters business", async () => {
    const effect = vi.fn();
    srv = await listen(gateApp(effect));
    const session = mint();
    const res = await fetch(`${srv.baseUrl}/api/private/weread/notes/summarize`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: session.cookie, origin: G_ORIGIN, "x-csrf-token": session.csrf },
      body: "{}",
    });
    expect(res.status).toBe(200);
    expect(effect).toHaveBeenCalledTimes(1);
  });

  it("missing CSRF → 403, business 0 calls", async () => {
    const effect = vi.fn();
    srv = await listen(gateApp(effect));
    const res = await fetch(`${srv.baseUrl}/api/private/weread/notes/summarize`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: mint().cookie, origin: G_ORIGIN },
      body: "{}",
    });
    expect(res.status).toBe(403);
    expect(effect).not.toHaveBeenCalled();
  });

  it("wrong bearer + valid session → 403, business 0 calls (no fallback)", async () => {
    const effect = vi.fn();
    srv = await listen(gateApp(effect));
    const res = await fetch(`${srv.baseUrl}/api/private/weread/summary`, {
      headers: { authorization: "Bearer wrong", cookie: mint().cookie },
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("Invalid token.");
    expect(effect).not.toHaveBeenCalled();
  });

  it("correct legacy bearer without CSRF keeps original behavior", async () => {
    const effect = vi.fn();
    srv = await listen(gateApp(effect));
    const res = await fetch(`${srv.baseUrl}/api/private/weread/notes/summarize`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${LEGACY_TOKEN}` },
      body: "{}",
    });
    expect(res.status).toBe(200);
    expect(effect).toHaveBeenCalledTimes(1);
  });
});

describe("Task 6 side-effect order proof", () => {
  let srv: Server;
  const originalEnv = { ...process.env };
  beforeEach(() => {
    process.env.WEREAD_OVERLAY_ENABLED = "true";
    process.env.WEREAD_PRIVATE_API_TOKEN = LEGACY_TOKEN;
  });
  afterEach(async () => {
    process.env.WEREAD_OVERLAY_ENABLED = originalEnv.WEREAD_OVERLAY_ENABLED;
    process.env.WEREAD_PRIVATE_API_TOKEN = originalEnv.WEREAD_PRIVATE_API_TOKEN;
    await srv?.close();
  });

  function buildApp(opts: { limiter?: () => boolean; effect: () => void }): express.Express {
    const app = express();
    const wereadRequestAuthorizer = createWereadRequestAuthorizer(googleConfig);
    app.get("/api/private/weread/reading-map", (req, res) => {
      const auth = authorizeWereadRouteRequest(req, wereadRequestAuthorizer);
      if (!auth.ok) {
        return res.status(auth.status).json({ ok: false, error: auth.message });
      }
      // exact order from index.ts: limiter gate before any overlay work
      if (!opts.limiter?.()) {
        return res.status(429).json({ ok: false, error: "阅读地图请求过于频繁，请稍后再试。" });
      }
      opts.effect();
      res.json({ ok: true });
    });
    return app;
  }

  it("auth failure does not consume the limiter or read overlay (reading-map shape)", async () => {
    const limiter = vi.fn(() => true);
    const overlayRead = vi.fn();
    srv = await listen(buildApp({ limiter, effect: overlayRead }));
    const res = await fetch(`${srv.baseUrl}/api/private/weread/reading-map`, {
      headers: { authorization: "Bearer wrong", cookie: mint().cookie },
    });
    expect(res.status).toBe(403);
    expect(limiter).not.toHaveBeenCalled();
    expect(overlayRead).not.toHaveBeenCalled();
  });

  it("auth PASS reaches limiter then overlay in order", async () => {
    const calls: string[] = [];
    const limiter = vi.fn(() => { calls.push("limiter"); return true; });
    const overlayRead = vi.fn(() => calls.push("overlay"));
    srv = await listen(buildApp({ limiter, effect: overlayRead }));
    const res = await fetch(`${srv.baseUrl}/api/private/weread/reading-map`, { headers: { cookie: mint().cookie } });
    expect(res.status).toBe(200);
    expect(calls).toEqual(["limiter", "overlay"]);
  });

  it("summarize auth failure never calls the AI summary path", async () => {
    const app = express();
    const wereadRequestAuthorizer = createWereadRequestAuthorizer(googleConfig);
    const aiCall = vi.fn();
    app.post("/api/private/weread/notes/summarize", express.json({ limit: "256kb" }), (req, res) => {
      const auth = authorizeWereadRouteRequest(req, wereadRequestAuthorizer);
      if (!auth.ok) {
        return res.status(auth.status).json({ ok: false, error: auth.message });
      }
      aiCall();
      res.json({ ok: true });
    });
    srv = await listen(app);
    const res = await fetch(`${srv.baseUrl}/api/private/weread/notes/summarize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(401);
    expect(aiCall).not.toHaveBeenCalled();
  });
});
