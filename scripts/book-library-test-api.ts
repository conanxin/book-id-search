/**
 * TEST ONLY: two synthetic catalog books + the actual signed-session,
 * Google-only middleware and S32 library router backed by PostgreSQL.
 * Google OAuth and external catalog/AI/WeRead services are not exercised.
 */
import { createRequire } from "node:module";
import { createAuthRouter } from "../apps/api/src/auth/routes.js";
import { readGoogleSessionAuthConfig } from "../apps/api/src/auth/config.js";
import { createGoogleOwnerMiddleware, createGoogleOwnerRequestAuthorizer } from "../apps/api/src/auth/google-owner-request.js";
import { createS32Router } from "../apps/api/src/s32/register.js";
import { readS32Config } from "../apps/api/src/s32/config.js";
import { createBookLibraryBodyParser } from "../apps/api/src/s32/routes/book-library-routes.js";
import type { CatalogBookSnapshot } from "../apps/api/src/s32/domain/catalog-promotion.js";

// Express/pg are owned by the API workspace, not new root dependencies.
const apiRequire = createRequire(new URL("../apps/api/package.json", import.meta.url));
const express = apiRequire("express");
const { Pool } = apiRequire("pg");
type TestRequest = Parameters<ReturnType<typeof createGoogleOwnerMiddleware>>[0];
type TestResponse = Parameters<ReturnType<typeof createGoogleOwnerMiddleware>>[1];

const env = process.env;
const databaseUrl = env.S32_LIBRARY_TEST_DATABASE_URL ?? "";
let parsed: URL | null = null;
try { parsed = new URL(databaseUrl); } catch { /* rejected below */ }
const fixtureKey = env.BOOK_LIBRARY_BROWSER_RUN_ID ?? "";
if (env.BOOK_LIBRARY_TEST_ONLY !== "YES" || env.NODE_ENV !== "development"
  || !parsed || parsed.protocol !== "postgresql:" || !["127.0.0.1", "localhost"].includes(parsed.hostname)
  || parsed.pathname !== "/s32_library_test" || parsed.username !== "s32_app"
  || !/^[a-z0-9-]{1,80}$/.test(fixtureKey)
  || env.BOOK_ID_SEARCH_OWNER_GOOGLE_SUB !== "book-library-test-owner"
  || env.BOOK_ID_SEARCH_PUBLIC_ORIGIN !== "http://127.0.0.1:5173") {
  throw new Error("BOOK_LIBRARY_TEST_API_REQUIRES_LOCAL_DISPOSABLE_DATABASE_AND_SYNTHETIC_OWNER");
}

const makeBook = (suffix: string, name: string): CatalogBookSnapshot => ({
  id: `library-browser-${fixtureKey}-${suffix}`, ssid: `test-ssid-${fixtureKey}-${suffix}`, dxid: `test-dxid-${fixtureKey}-${suffix}`,
  title: `古道阅读验证${name} ${fixtureKey}`, author: "合成测试作者", publisher: "合成测试出版社",
  year: 2001, pages: 208, isbn: "9787538455250", rawInfo: "SYNTHETIC BOOK LIBRARY BROWSER FIXTURE",
  parseStatus: "ok", parseWarnings: [],
});
const books = [makeBook("a", "甲"), makeBook("b", "乙")];
const book = (id: string) => books.find(item => item.id === id);

const config = readS32Config({ ...env, S32_FEATURES_ENABLED: "true", S32_DATABASE_URL: databaseUrl });
const google = readGoogleSessionAuthConfig(env);
const authorize = createGoogleOwnerRequestAuthorizer(google);
const privateMiddleware = createGoogleOwnerMiddleware(google);
const probe = new Pool({ connectionString: databaseUrl });
const role = (await probe.query("SELECT current_user AS name, rolsuper FROM pg_roles WHERE rolname = current_user")).rows[0];
if (role?.name !== "s32_app" || role.rolsuper) throw new Error("BOOK_LIBRARY_TEST_API_REQUIRES_APPLICATION_ROLE");
await probe.end();

const app = express();
app.use("/api/auth", createAuthRouter({ config: google }));
app.use("/api/private", privateMiddleware);
app.use("/api/books", privateMiddleware);
app.use("/api/ai", privateMiddleware);
app.use("/api/private/s32/library", createBookLibraryBodyParser(config, authorize));
app.use(express.json({ limit: "256kb" }));
app.use("/api/private/s32", createS32Router({
  env, config, requestAuthorizer: authorize, libraryRequestAuthorizer: authorize,
  getCatalogDocument: async id => {
    const found = book(id);
    if (found) return found;
    throw Object.assign(new Error("Synthetic catalog book absent"), { code: "document_not_found" });
  },
}));

app.get("/api/search", (req: TestRequest, res: TestResponse) => {
  const q = typeof req.query.q === "string" ? req.query.q : "";
  const items = books.filter(item => `${item.title} ${item.author} ${item.id}`.includes(q.trim()));
  res.json({ query: q, total: items.length, page: 1, limit: 20, items });
});
app.get("/api/stats", (_req: TestRequest, res: TestResponse) => {
  res.json({ indexName: "synthetic-library", numberOfDocuments: books.length, isIndexing: false, lastImportReport: null, parseQualityReport: null });
});
app.get("/api/books/:id", (req: TestRequest, res: TestResponse) => {
  const found = book(String(req.params.id));
  if (!found) return void res.status(404).json({ error: { message: "Synthetic book not found" } });
  res.json({ item: found });
});
app.get("/api/books/:id/related", (req: TestRequest, res: TestResponse) => {
  const items = book(String(req.params.id)) ? books.filter(item => item.id !== req.params.id) : [];
  res.json({ total: items.length, items });
});
app.get("/api/ai/status", (_req: TestRequest, res: TestResponse) => res.json({ enabled: false }));
app.post("/api/ai/book-insight", (_req: TestRequest, res: TestResponse) => res.status(503).json({ error: { message: "AI disabled in this deterministic browser fixture." } }));
app.get("/api/private/weread/status", (req: TestRequest, res: TestResponse) => res.json({ ok: true, matched: false, catalogId: req.query.catalogId }));
app.post("/api/private/weread/status/batch", (_req: TestRequest, res: TestResponse) => res.json({ ok: true, results: {} }));
app.get("/api/health", (_req: TestRequest, res: TestResponse) => res.json({ ok: true, syntheticCatalog: true, persistence: "postgresql", runtimeRole: role.name }));

app.listen(3001, "127.0.0.1", () => {
  console.log("BOOK_LIBRARY_TEST_API_READY=YES CATALOG=SYNTHETIC_TWO_BOOKS PERSISTENCE=POSTGRESQL ROLE=s32_app OAUTH=NOT_EXERCISED");
});
