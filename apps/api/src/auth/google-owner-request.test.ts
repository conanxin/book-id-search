import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readGoogleSessionAuthConfig } from "./config.js";
import { createGoogleOwnerMiddleware } from "./google-owner-request.js";
import { issueWebSession } from "./web-session.js";

const SECRET = "disposable-book-library-test-secret-48-characters";
const ORIGIN = "https://books.example.test";
const config = readGoogleSessionAuthConfig({
  NODE_ENV: "production", GOOGLE_AUTH_ENABLED: "true", GOOGLE_CLIENT_ID: "test.apps.googleusercontent.com",
  BOOK_ID_SEARCH_OWNER_GOOGLE_SUB: "test-owner", BOOK_ID_SEARCH_SESSION_SECRET: SECRET,
  BOOK_ID_SEARCH_PUBLIC_ORIGIN: ORIGIN,
});
const privatePaths = ["/api/books/one", "/api/books/one/related", "/api/ai/status", "/api/private/s32/library/books/one", "/api/private/weread/summary"];
const hit = vi.fn();
let server: Server;
let base: string;
function session(sub = "test-owner", expired = false) {
  const issued = issueWebSession({ sub, email: "owner@example.test", name: "Test Owner" }, {
    secret: SECRET,
    ...(expired ? { nowSeconds: Math.floor(Date.now() / 1000) - 3600, ttlSeconds: 60 } : {}),
  });
  return { cookie: `${config.cookieName}=${issued.token}`, csrf: issued.payload.csrf };
}

beforeEach(async () => {
  hit.mockClear();
  const app = express();
  app.use(["/api/books", "/api/ai", "/api/private"], createGoogleOwnerMiddleware(config));
  app.use(express.json());
  app.get("/api/search", (_req, res) => res.json({ items: [{ id: "one", title: "Public catalog" }] }));
  for (const path of privatePaths) app.all(path, (req, res) => { hit(req.method, path); res.json({ saved: true }); });
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });

describe("book-centred Google owner boundary", () => {
  it("keeps catalog search public while protecting every personal/detail/AI prefix", async () => {
    expect((await fetch(base + "/api/search")).status).toBe(200);
    for (const path of privatePaths) {
      const response = await fetch(base + path);
      expect(response.status).toBe(401);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toMatchObject({ error: { code: "GOOGLE_LOGIN_REQUIRED" } });
    }
    expect(hit).not.toHaveBeenCalled();
  });

  it("legacy credentials cannot replace Google, even for an old private endpoint", async () => {
    for (const headers of [{ authorization: "Bearer legacy-test-token" }, { "x-private-token": "legacy-test-token" }]) {
      const response = await fetch(base + "/api/private/weread/summary", { headers });
      expect(response.status).toBe(401);
    }
    expect(hit).not.toHaveBeenCalled();
  });

  it("accepts the signed owner session for detail and rejects expired or another owner's session", async () => {
    expect((await fetch(base + privatePaths[0], { headers: { cookie: session().cookie } })).status).toBe(200);
    hit.mockClear();
    for (const cookie of [session("other-owner").cookie, session("test-owner", true).cookie, "broken=session"]) {
      expect((await fetch(base + privatePaths[0], { headers: { cookie } })).status).toBe(401);
    }
    expect(hit).not.toHaveBeenCalled();
  });

  it("checks Google before parsing a write and requires both the origin and matching CSRF", async () => {
    const path = base + "/api/private/s32/library/books/one";
    expect((await fetch(path, { method: "PUT", headers: { "content-type": "application/json" }, body: "{invalid" })).status).toBe(401);
    const owner = session();
    const headers = { cookie: owner.cookie, "content-type": "application/json" };
    for (const extra of [{}, { origin: ORIGIN }, { "x-csrf-token": owner.csrf }, { origin: "https://other.example.test", "x-csrf-token": owner.csrf }]) {
      expect((await fetch(path, { method: "PUT", headers: { ...headers, ...extra }, body: "{}" })).status).toBe(403);
    }
    expect(hit).not.toHaveBeenCalled();
    expect((await fetch(path, { method: "PUT", headers: { ...headers, origin: ORIGIN, "x-csrf-token": owner.csrf }, body: "{}" })).status).toBe(200);
    expect(hit).toHaveBeenCalledTimes(1);
  });
});
