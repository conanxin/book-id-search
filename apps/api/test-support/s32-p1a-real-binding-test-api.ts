/**
 * P1-A TEST-ONLY API: original owner session + original S32 router + real PG16,
 * with two fixed synthetic catalog records. Never a production entrypoint.
 * The same S32 project-binding service will actually INSERT and read back rows.
 */
import express from "express";
import { createAuthRouter } from "../src/auth/routes.js";
import { readGoogleSessionAuthConfig } from "../src/auth/config.js";
import { createS32Router } from "../src/s32/register.js";
import { readS32Config } from "../src/s32/config.js";
import { createS32RequestAuthorizer } from "../src/s32/routes/private-auth.js";
import type { CatalogBookSnapshot } from "../src/s32/domain/catalog-promotion.js";

const env = process.env;
const databaseUrl = env.S32_DATABASE_URL ?? "";
const parsed = (() => { try { return new URL(databaseUrl); } catch { return null; } })();

// Test guard: real writes allowed only to the harness-owned disposable database.
// Require immutable scope; do not rely on arbitrary envs that a production host
// may also use. No private research records, secrets or user catalog read.
const safe = env.S32_P1A_REAL_BINDING_TEST_ONLY === "YES"
  && env.S32_BROWSER_SUITE === "P1A_REAL"
  && env.NODE_ENV === "development"
  && env.S32_FEATURES_ENABLED === "true"
  && env.GOOGLE_AUTH_ENABLED === "true"
  && env.BOOK_ID_SEARCH_OWNER_GOOGLE_SUB === "gate4-browser-owner-sub"
  && parsed?.protocol === "postgresql:"
  && parsed.hostname === "127.0.0.1"
  && parsed.pathname === "/s32_m3a_gate3_browser"
  && /^[0-9]+$/.test(parsed.port)
  && env.API_HOST === "127.0.0.1"
  && env.API_PORT === "3001";

if (!safe) {
  console.error("STATUS=BLOCKED reason=P1A_SYNTHETIC_DISPOSABLE_ONLY");
  process.exit(3);
}

const book = (id: string, title: string, ordinal: number): CatalogBookSnapshot => ({
  id,
  ssid: "P1A-SSID-" + ordinal,
  dxid: "P1A-DXID-" + ordinal,
  title,
  author: "P1A Synthetic Researcher",
  publisher: "P1A Synthetic Press",
  year: 2024,
  pages: 101 + ordinal,
  isbn: "9780000000012",
  rawInfo: "P1A_SYNTHETIC_ONLY",
  parseStatus: "ok",
  parseWarnings: [],
});
export const TEST_BOOKS = Object.freeze({
  "p1a-synthetic-book": book("p1a-synthetic-book", "P1A Synthetic Primary", 1),
  "p1a-synthetic-other": book("p1a-synthetic-other", "P1A Synthetic Secondary", 2),
  // R3: fixed synthetic fixtures for concurrent same-project/cross-project
  // requests; never fetched from production Meili or a user's catalog.
  "p1a-synthetic-concurrent": book("p1a-synthetic-concurrent", "P1A Concurrent Same Project", 3),
  "p1a-synthetic-cross-race": book("p1a-synthetic-cross-race", "P1A Concurrent Cross Project", 4),
  // Deliberately aliases the primary book's SSID to prove canonical rollback
  // when two distinct catalog IDs claim one secondary identity.
  "p1a-synthetic-conflict": {
    ...book("p1a-synthetic-conflict", "P1A Synthetic Identity Collision", 5),
    ssid: "P1A-SSID-1",
  },
});
function knownBook(id: string): CatalogBookSnapshot | null {
  return Object.hasOwn(TEST_BOOKS, id)
    ? TEST_BOOKS[id as keyof typeof TEST_BOOKS]
    : null;
}

const app = express();
const google = readGoogleSessionAuthConfig(env);
const s32 = readS32Config(env);
const authorizer = createS32RequestAuthorizer(s32, google);

// Exact production authentication + S32 domain/database routers, but NO
// production Meilisearch client, no real book corpus and no Google OAuth flow.
app.use("/api/auth", createAuthRouter({ config: google }));
app.use(express.json({ limit: "256kb" }));
app.use("/api/private/s32", createS32Router({
  env,
  config: s32,
  requestAuthorizer: authorizer,
  getCatalogDocument: async (id: string) => {
    const record = knownBook(id);
    if (record) return record;
    throw Object.assign(new Error("synthetic catalog book absent"), { code: "document_not_found" });
  },
}));

app.get("/api/books/:id", (req, res) => {
  const record = knownBook(String(req.params.id));
  if (!record) return void res.status(404).json({ error: { message: "Synthetic book not found" } });
  res.set("Cache-Control", "no-store").json({ item: record });
});
app.get("/api/books/:id/related", (req, res) => {
  res.set("Cache-Control", "no-store").json({
    total: req.params.id === "p1a-synthetic-book" ? 1 : 0,
    items: req.params.id === "p1a-synthetic-book" ? [TEST_BOOKS["p1a-synthetic-other"]] : [],
  });
});
app.post("/api/ai/book-insight", (_req, res) => res.status(200).json({ hasInsight: false }));
app.get("/api/health", (_req, res) => res.json({ ok: true, synthetic: true }));

app.listen(3001, "127.0.0.1", () => {
  console.log("P1A_REAL_BINDING_TEST_API_READY=YES");
  console.log("CATALOG_SOURCE=SYNTHETIC_IN_MEMORY");
  console.log("PERSISTENCE=DISPOSABLE_PG16");
});
