/**
 * TEST ONLY: two independent pairs of synthetic catalog books + the actual signed-session,
 * Google-only middleware and S32 library router backed by PostgreSQL.
 * WeRead uses the production snapshot loaders/query services with two
 * synthetic, confirmed books; manual bindings use the production router,
 * effective-data service and PostgreSQL store. Book AI uses the production
 * collector, prompt/parser and router with one deterministic provider injection.
 * Related books use the production collector with a synthetic field-search
 * adapter; this exercises relation evidence, not Meilisearch relevance.
 * External catalog/MiniMax/WeRead and Google OAuth services are not exercised.
 */
import { createRequire } from "node:module";
import { createAuthRouter } from "../apps/api/src/auth/routes.js";
import { readGoogleSessionAuthConfig } from "../apps/api/src/auth/config.js";
import { createGoogleOwnerMiddleware, createGoogleOwnerRequestAuthorizer } from "../apps/api/src/auth/google-owner-request.js";
import { createS32Router } from "../apps/api/src/s32/register.js";
import { readS32Config } from "../apps/api/src/s32/config.js";
import { createBookLibraryBodyParser } from "../apps/api/src/s32/routes/book-library-routes.js";
import type { CatalogBookSnapshot } from "../apps/api/src/s32/domain/catalog-promotion.js";
import { createBookWereadFixture, getBookAiBrowserFixtureKey, getBookBrowserCatalogIds } from "./book-browser-fixtures.js";
import { normalizeNotesQuery, queryPrivateNotes, type WereadNotesQuery } from "../apps/api/src/weread/private-notes.js";
import { buildNotesTrend, getWereadStatusByCatalogId, getWereadStatusesByCatalogIds,
  getWereadSummary, getWereadConfirmedMatches } from "../apps/api/src/weread/private-overlay.js";
import { createPostgresWereadBindingStore } from "../apps/api/src/weread/manual-bindings-store.js";
import { createWereadBindingsService } from "../apps/api/src/weread/manual-bindings.js";
import { createWereadBindingsRouter } from "../apps/api/src/weread/manual-binding-routes.js";
import { createPostgresBookLibraryStore } from "../apps/api/src/s32/postgres/book-library-store.js";
import { createBookAssistantService } from "../apps/api/src/ai/book-assistant.js";
import { createBookAssistantRouter } from "../apps/api/src/ai/book-assistant-routes.js";
import type { ChatMessage, ChatCompletionResponse } from "../apps/api/src/ai/minimax.js";
import { collectRelatedBooks } from "../apps/api/src/search/related-books.js";

// Express/pg are owned by the API workspace, not new root dependencies.
const apiRequire = createRequire(new URL("../apps/api/package.json", import.meta.url));
const express = apiRequire("express");
const { Pool } = apiRequire("pg");
type TestRequest = Parameters<ReturnType<typeof createGoogleOwnerMiddleware>>[0];
type TestResponse = Parameters<ReturnType<typeof createGoogleOwnerMiddleware>>[1];

const env = process.env;
const browserScope = env.BOOK_LIBRARY_BROWSER_SCOPE ?? "all";
const wereadOnly = browserScope === "weread";
const databaseUrl = env.S32_LIBRARY_TEST_DATABASE_URL ?? "";
let parsed: URL | null = null;
try { parsed = new URL(databaseUrl); } catch { /* rejected below */ }
const fixtureKey = env.BOOK_LIBRARY_BROWSER_RUN_ID ?? "";
if (env.BOOK_LIBRARY_TEST_ONLY !== "YES" || env.NODE_ENV !== "development" || !["all", "weread"].includes(browserScope)
  || !parsed || parsed.protocol !== "postgresql:" || !["127.0.0.1", "localhost"].includes(parsed.hostname)
  || parsed.pathname !== "/s32_library_test" || parsed.username !== "s32_app"
  || !/^[a-z0-9-]{1,80}$/.test(fixtureKey)
  || env.BOOK_ID_SEARCH_OWNER_GOOGLE_SUB !== "book-library-test-owner"
  || env.BOOK_ID_SEARCH_PUBLIC_ORIGIN !== "http://127.0.0.1:5173") {
  throw new Error("BOOK_LIBRARY_TEST_API_REQUIRES_LOCAL_DISPOSABLE_DATABASE_AND_SYNTHETIC_OWNER");
}

const catalogIds = getBookBrowserCatalogIds(fixtureKey);
const aiFixtureKey = getBookAiBrowserFixtureKey(fixtureKey);
const aiCatalogIds = getBookBrowserCatalogIds(aiFixtureKey);
const makeBook = (id: string, title: string): CatalogBookSnapshot => ({
  id, ssid: id.split("_")[0], dxid: id.split("_")[1],
  title, author: "合成测试作者", publisher: "合成测试出版社",
  year: 2001, pages: 208, isbn: "9787538455250", rawInfo: "SYNTHETIC BOOK LIBRARY BROWSER FIXTURE",
  parseStatus: "ok", parseWarnings: [],
});
const libraryBooks = [makeBook(catalogIds.A, `古道阅读验证甲 ${fixtureKey}`), makeBook(catalogIds.B, `古道阅读验证乙 ${fixtureKey}`)];
const aiBooks = [makeBook(aiCatalogIds.A, `AI 阅读验证甲 ${aiFixtureKey}`), makeBook(aiCatalogIds.B, `AI 阅读验证乙 ${aiFixtureKey}`)];
const books = [...libraryBooks, ...aiBooks];
const isAiBook = (id: string) => id === aiCatalogIds.A || id === aiCatalogIds.B;
const book = (id: string) => books.find(item => item.id === id);
const getCatalogDocument = async (id: string) => {
  const found = book(id);
  if (found) return found;
  throw Object.assign(new Error("Synthetic catalog book absent"), { code: "document_not_found" });
};
const wereadFixture = createBookWereadFixture(fixtureKey);
const aiWereadFixture = createBookWereadFixture(aiFixtureKey);
process.once("exit", () => { wereadFixture.dispose(); aiWereadFixture.dispose(); });
process.once("SIGTERM", () => process.exit(0));
process.once("SIGINT", () => process.exit(0));
const bindingPool = wereadOnly ? null : new Pool({ connectionString: databaseUrl });
const wereadBindings = createWereadBindingsService({
  dataDir: wereadFixture.directory,
  store: bindingPool ? createPostgresWereadBindingStore(bindingPool) : null,
  getCatalogDocument,
});
const aiWereadBindings = createWereadBindingsService({
  dataDir: aiWereadFixture.directory,
  store: bindingPool ? createPostgresWereadBindingStore(bindingPool) : null,
  getCatalogDocument,
});
// Catalog-scoped reads select the isolated AI snapshot. The old global WeRead
// journeys keep their original two-source totals and untouched binding rows.
const bindingsForBook = (id: string) => isAiBook(id) ? aiWereadBindings : wereadBindings;
const wereadData = () => wereadBindings.loadOverlay();

// Only the explicit local WeRead mode omits PostgreSQL. The default CI journey
// retains its application-role probe and real persistence without fallback.
const config = wereadOnly ? null : readS32Config({ ...env, S32_FEATURES_ENABLED: "true", S32_DATABASE_URL: databaseUrl });
const google = readGoogleSessionAuthConfig(env);
const authorize = createGoogleOwnerRequestAuthorizer(google);
const privateMiddleware = createGoogleOwnerMiddleware(google);
const libraryReadStore = bindingPool ? createPostgresBookLibraryStore(bindingPool) : null;
const bookAssistant = createBookAssistantService({
  getCatalogDocument,
  getWorkspace: libraryReadStore ? id => libraryReadStore.get(id) : null,
  loadWereadNotes: async () => {
    const data = await Promise.all([wereadBindings.loadNotes(), aiWereadBindings.loadNotes()]);
    return {
      notes: data.flatMap(item => item.notes),
      wereadBookIdToCatalogId: new Map(data.flatMap(item => [...item.wereadBookIdToCatalogId])),
    };
  },
  wereadEnabled: true,
  isEnabled: () => true,
  chat: deterministicBookAssistantChat,
});

// Only the model transport is replaced. The provider receives the actual
// production prompt's bounded source excerpts and echoes one cited paragraph
// for each kind. Production parsing validates these citations before delivery.
async function deterministicBookAssistantChat(messages: ChatMessage[]): Promise<ChatCompletionResponse> {
  const raw = messages.find(message => message.role === "user")?.content;
  if (!raw) throw new Error("SYNTHETIC_BOOK_ASSISTANT_PROMPT_MISSING");
  const input = JSON.parse(raw) as { action: string; sources: Array<{ id: string; kind: string; label: string; excerpt: string }> };
  const seen = new Set<string>();
  const selected = input.sources.filter(source => {
    if (seen.has(source.kind)) return false;
    seen.add(source.kind); return true;
  });
  return {
    ok: true, model: "synthetic-book-assistant-no-network",
    content: JSON.stringify({
      title: `AI 合成${input.action === "introduction" ? "介绍" : input.action === "notes_summary" ? "笔记摘要" : "资料问答"}`,
      paragraphs: selected.map(source => ({ text: `已核对的${source.label}：${source.excerpt.slice(0, 600).replace(/\[S\d+\]/g, "")}`, sourceIds: [source.id] })),
      insufficientEvidence: false,
    }),
  };
}
let runtimeRole = "NOT_EXERCISED";
if (!wereadOnly) {
  const probe = new Pool({ connectionString: databaseUrl });
  try {
    const role = (await probe.query("SELECT current_user AS name, rolsuper FROM pg_roles WHERE rolname = current_user")).rows[0];
    if (role?.name !== "s32_app" || role.rolsuper) throw new Error("BOOK_LIBRARY_TEST_API_REQUIRES_APPLICATION_ROLE");
    runtimeRole = role.name;
  } finally { await probe.end(); }
}

const app = express();
app.use("/api/auth", createAuthRouter({ config: google }));
app.use("/api/private", privateMiddleware);
app.use("/api/books", privateMiddleware);
app.use("/api/ai", privateMiddleware);
app.use("/api/ai/books", createBookAssistantRouter({ service: bookAssistant, requestAuthorizer: authorize }));
app.use("/api/private/weread/bindings", createWereadBindingsRouter({ service: wereadBindings, requestAuthorizer: authorize }));
if (config) app.use("/api/private/s32/library", createBookLibraryBodyParser(config, authorize));
app.use(express.json({ limit: "256kb" }));
if (config) app.use("/api/private/s32", createS32Router({
  env, config, requestAuthorizer: authorize, libraryRequestAuthorizer: authorize,
  getCatalogDocument,
}));

app.get("/api/search", (req: TestRequest, res: TestResponse) => {
  const q = typeof req.query.q === "string" ? req.query.q : "";
  const page = req.query.page === undefined ? 1 : Number(req.query.page);
  const limit = req.query.limit === undefined ? 20 : Number(req.query.limit);
  if (!Number.isSafeInteger(page) || page < 1 || page > 1_000_000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    return void res.status(400).json({ error: { message: "Invalid synthetic catalog pagination" } });
  }
  const matches = books.filter(item => `${item.title} ${item.author} ${item.isbn} ${item.id}`.includes(q.trim()));
  res.json({ query: q, total: matches.length, page, limit, items: matches.slice((page - 1) * limit, page * limit) });
});
app.get("/api/stats", (_req: TestRequest, res: TestResponse) => {
  res.json({ indexName: "synthetic-library", numberOfDocuments: books.length, isIndexing: false, lastImportReport: null, parseQualityReport: null });
});
app.get("/api/books/:id", (req: TestRequest, res: TestResponse) => {
  const found = book(String(req.params.id));
  if (!found) return void res.status(404).json({ error: { message: "Synthetic book not found" } });
  res.json({ item: found });
});
app.get("/api/books/:id/related", async (req: TestRequest, res: TestResponse) => {
  const id = String(req.params.id);
  const source = book(id);
  if (!source) return void res.status(404).json({ error: { message: "Synthetic book not found" } });
  const group = isAiBook(id) ? aiBooks : libraryBooks;
  // Keep the original isolated catalog groups. This field-only in-memory
  // adapter replaces Meili transport while collection/ranking/reasons are real.
  const normalize = (value: string) => value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
  try {
    const result = await collectRelatedBooks(source, async (query, options) => ({
      hits: group.filter(item => options.attributesToSearchOn.some(field =>
        normalize(String(item[field] ?? "")).includes(normalize(query))))
        .slice(0, options.limit),
    }));
    res.json(result);
  } catch {
    res.status(503).json({ error: { message: "Synthetic related catalog unavailable" } });
  }
});
app.get("/api/ai/status", (_req: TestRequest, res: TestResponse) => res.json({ enabled: false }));
app.post("/api/ai/book-insight", (_req: TestRequest, res: TestResponse) => res.status(503).json({ error: { message: "AI disabled in this deterministic browser fixture." } }));
app.get("/api/private/weread/summary", async (_req: TestRequest, res: TestResponse) => res.json({ ok: true, ...getWereadSummary(await wereadData()) }));
app.get("/api/private/weread/trends", async (_req: TestRequest, res: TestResponse) => {
  const data = await wereadData();
  res.json({ ok: true, trends: buildNotesTrend(Array.from(data.notesByBook.values()).flat(), getWereadConfirmedMatches(data)) });
});
app.get("/api/private/weread/status", async (req: TestRequest, res: TestResponse) => {
  const catalogId = String(req.query.catalogId ?? "");
  if (!/^[0-9]+_[0-9]{12}$/.test(catalogId)) return void res.status(400).json({ ok: false, error: "Invalid synthetic catalog ID" });
  res.json({ ok: true, ...getWereadStatusByCatalogId(await bindingsForBook(catalogId).loadOverlay(), catalogId) });
});
app.post("/api/private/weread/status/batch", async (req: TestRequest, res: TestResponse) => {
  const ids = req.body?.catalogIds;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 100 || ids.some(id => typeof id !== "string" || !/^[0-9]+_[0-9]{12}$/.test(id))) {
    return void res.status(400).json({ ok: false, error: "Invalid synthetic catalog IDs" });
  }
  const [baseData, aiData] = await Promise.all([wereadData(), ids.some(isAiBook) ? aiWereadBindings.loadOverlay() : null]);
  res.json({ ok: true, results: {
    ...getWereadStatusesByCatalogIds(baseData, ids.filter(id => !isAiBook(id))),
    ...(aiData ? getWereadStatusesByCatalogIds(aiData, ids.filter(isAiBook)) : {}),
  } });
});
app.get("/api/private/weread/notes", async (req: TestRequest, res: TestResponse) => {
  const catalogId = req.query.catalogId;
  if (catalogId !== undefined && (typeof catalogId !== "string" || catalogId.length > 128 || !/^[0-9]+_[0-9]{12}$/.test(catalogId))) {
    return void res.status(400).json({ ok: false, error: "Invalid synthetic catalog ID" });
  }
  // Reuse actual snapshot loading, confirmed matching, sanitization, filtering
  // and pagination; this small test wrapper only adapts valid query parameters.
  const query = normalizeNotesQuery({
    catalogId, type: String(req.query.type ?? "all") as WereadNotesQuery["type"],
    days: String(req.query.days ?? "all") as WereadNotesQuery["days"],
    sort: String(req.query.sort ?? "newest") as WereadNotesQuery["sort"],
    limit: Number(req.query.limit ?? 50), offset: Number(req.query.offset ?? 0),
    matchedOnly: req.query.matchedOnly === "true",
    ...(req.query.hasComment !== undefined ? { hasComment: req.query.hasComment === "true" } : {}),
    ...(typeof req.query.q === "string" ? { q: req.query.q } : {}),
  });
  res.json({ ok: true, ...queryPrivateNotes(await bindingsForBook(typeof catalogId === "string" ? catalogId : "").loadNotes(), query) });
});
app.get("/api/health", (_req: TestRequest, res: TestResponse) => res.json({ ok: true, syntheticCatalog: true,
  persistence: wereadOnly ? "NOT_EXERCISED" : "postgresql", wereadBindingsPersistence: wereadOnly ? "NOT_EXERCISED" : "postgresql", runtimeRole,
  bookAssistant: { sources: "production_collector", provider: "deterministic_injected", externalMiniMax: "NOT_EXERCISED" } }));

app.listen(3001, "127.0.0.1", () => {
  console.log(`BOOK_LIBRARY_TEST_API_READY=YES CATALOG=SYNTHETIC_TWO_PAIRS WEREAD=SYNTHETIC_SNAPSHOTS_REAL_QUERY BOOK_AI=DETERMINISTIC_PROVIDER_REAL_COLLECTOR PERSISTENCE=${wereadOnly ? "NOT_EXERCISED" : "POSTGRESQL"} ROLE=${runtimeRole} OAUTH=NOT_EXERCISED`);
});
