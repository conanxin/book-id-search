import { randomUUID } from "node:crypto";
import { afterAll, expect, test } from "vitest";
import { Pool } from "pg";
import { createProjectsService } from "../application/projects.js";
import { createPromoteCatalogBookCommand } from "../application/promote-catalog-book.js";
import { createProjectItemsService, EditionNotAvailableError, ProjectBindingStoreUnavailableError, ProjectNotActiveError } from "../application/project-items.js";
import { createPostgresProjectStore } from "./project-store.js";
import { createPostgresCatalogPromotionStore } from "./catalog-promotion-store.js";
import { createPostgresProjectBindingStore } from "./project-binding-store.js";
const databaseUrl = process.env.S32_M1C_TEST_DATABASE_URL;
const parsed = databaseUrl ? new URL(databaseUrl) : null;
if (parsed && (parsed.hostname !== "127.0.0.1" || parsed.pathname !== "/s32_m1c_test")) throw new Error("M1C integration requires isolated s32_m1c_test");
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
afterAll(async () => { await pool?.end(); });

test.skipIf(!pool)("real PG16 promotion + binding: duplicate/concurrency, retry, stable canonical reads, safe removal", async () => {
  const db = pool!;
  const projects = createProjectsService(createPostgresProjectStore(db));
  const [a,b,c] = await Promise.all(["A","B","C"].map(name => projects.create({ name })));
  const promotionCommand = createPromoteCatalogBookCommand({ reader: { async getById(id) { return {
    id, ssid: `ssid-${id}`, dxid: `dxid-${id}`, title: `北京古道考 ${id}`, author: "原始作者", publisher: "测试出版社", year: 2001,
    pages: 123, isbn: "9787538455250", rawInfo: "deterministic test", parseStatus: "ok", parseWarnings: [],
  }; } }, store: createPostgresCatalogPromotionStore(db) });
  const bindings = createPostgresProjectBindingStore(db);
  const service = createProjectItemsService({ projects, promotionCommand, bindings });
  const counts = async () => (await db.query(`SELECT (SELECT count(*)::int FROM core.works) works,
    (SELECT count(*)::int FROM core.editions) editions, (SELECT count(*)::int FROM core.sources) sources,
    (SELECT count(*)::int FROM core.external_identities) identities`)).rows[0];
  const first = await service.addCatalogBook(a.id, { bookId: "one" });
  expect(first).toMatchObject({ promotionStatus: "created", bindingStatus: "created", item: { projectId: a.id, title: "北京古道考 one", publisher: "测试出版社", publicationDate: "2001-01-01", publicationDatePrecision: "YEAR", isbn: "9787538455250", catalogBookId: "one" } });
  expect(await counts()).toEqual({ works: 1, editions: 1, sources: 1, identities: 3 });
  const original = (await db.query("SELECT * FROM core.project_bindings WHERE id=$1", [first.item.bindingId])).rows[0];
  expect(original).toMatchObject({ target_type: "EDITION", target_id: first.item.editionId, binding_role: null, metadata: { addedVia: "BOOK_ID_SEARCH_CATALOG", sourceId: first.item.sourceId, catalogBookId: "one" } });
  expect(await service.addCatalogBook(a.id, { bookId: "one" })).toEqual({ ...first, promotionStatus: "existing", bindingStatus: "existing" });
  expect((await db.query("SELECT * FROM core.project_bindings WHERE id=$1", [first.item.bindingId])).rows[0]).toEqual(original);
  const concurrent = await Promise.all([service.addCatalogBook(b.id, { bookId: "one" }), service.addCatalogBook(b.id, { bookId: "one" })]);
  expect(concurrent.map(r => r.bindingStatus).sort()).toEqual(["created", "existing"]);
  expect(concurrent[0].item.bindingId).toBe(concurrent[1].item.bindingId);
  expect((await bindings.listEditionItems(b.id))).toHaveLength(1);
  expect(await counts()).toEqual({ works: 1, editions: 1, sources: 1, identities: 3 });
  expect(await bindings.removeEdition({ projectId: b.id, bindingId: first.item.bindingId })).toBe(false);
  expect(await service.list(a.id)).toEqual([first.item]);
  await service.remove(a.id, first.item.bindingId);
  expect(await service.list(a.id)).toEqual([]);
  expect(await counts()).toEqual({ works: 1, editions: 1, sources: 1, identities: 3 });
  console.log("M1C_CREATED_DUPLICATE_CONCURRENT_DELETE_PRESERVES_CANONICAL=PASS");

  let failOnce = true;
  const flaky = createProjectItemsService({ projects, promotionCommand, bindings: { ...bindings, async addEdition(input) {
    if (failOnce) { failOnce = false; throw new ProjectBindingStoreUnavailableError("simulated"); }
    return bindings.addEdition(input);
  } } });
  await expect(flaky.addCatalogBook(c.id, { bookId: "two" })).rejects.toBeInstanceOf(ProjectBindingStoreUnavailableError);
  expect(await bindings.listEditionItems(c.id)).toEqual([]);
  expect(await counts()).toEqual({ works: 2, editions: 2, sources: 2, identities: 6 });
  const retried = await flaky.addCatalogBook(c.id, { bookId: "two" });
  expect(retried).toMatchObject({ promotionStatus: "existing", bindingStatus: "created" });
  expect(await counts()).toEqual({ works: 2, editions: 2, sources: 2, identities: 6 });
  console.log("M1C_PROMOTION_COMMIT_BINDING_FAILURE_RETRY=PASS");

  const secondB = await service.addCatalogBook(b.id, { bookId: "two" });
  await db.query("UPDATE core.project_bindings SET created_at='2026-01-01T00:00:00Z' WHERE project_id=$1", [b.id]);
  const expectedOrder = [concurrent[0].item.bindingId, secondB.item.bindingId].sort().reverse();
  for (let i=0;i<3;i++) expect((await service.list(b.id)).map(r => r.bindingId)).toEqual(expectedOrder);
  // Metadata is provenance, never bibliographic truth, and retries never replace it.
  await db.query("UPDATE core.works SET title='canonical revised' WHERE id=$1", [first.item.workId]);
  for (const metadata of [null, [], "wrong", { catalogBookId: 42, sourceId: [] }]) {
    await db.query("UPDATE core.project_bindings SET metadata=$1::jsonb WHERE id=$2", [JSON.stringify(metadata), concurrent[0].item.bindingId]);
    const result = await service.addCatalogBook(b.id, { bookId: "one" });
    expect(result.item).toMatchObject({ title: "canonical revised", catalogBookId: null, sourceId: null });
    expect((await db.query("SELECT metadata FROM core.project_bindings WHERE id=$1", [result.item.bindingId])).rows[0].metadata).toEqual(metadata);
  }
  // Non-Edition binding sharing the same project is neither listed nor deletable here.
  const workBinding = randomUUID();
  await db.query("INSERT INTO core.project_bindings(id,project_id,target_type,target_id) VALUES($1,$2,'WORK',$3)", [workBinding,b.id,first.item.workId]);
  expect(await bindings.removeEdition({ projectId: b.id, bindingId: workBinding })).toBe(false);
  expect((await service.list(b.id))).toHaveLength(2);
  const canonicalInput = { ...first.item, projectId: a.id, sourceId: first.item.sourceId!, catalogBookId: "one" };
  await expect(bindings.addEdition({ ...canonicalInput, editionId: randomUUID() })).rejects.toBeInstanceOf(EditionNotAvailableError);
  await expect(bindings.addEdition({ ...canonicalInput, workId: randomUUID() })).rejects.toBeInstanceOf(EditionNotAvailableError);
  await db.query("UPDATE core.editions SET lifecycle_state='ARCHIVED' WHERE id=$1", [first.item.editionId]);
  await expect(bindings.addEdition(canonicalInput)).rejects.toBeInstanceOf(EditionNotAvailableError);
  await db.query("UPDATE core.projects SET lifecycle_state='ARCHIVED' WHERE id=$1", [a.id]);
  await expect(bindings.addEdition(canonicalInput)).rejects.toBeInstanceOf(ProjectNotActiveError);
  console.log("M1C_STABLE_CANONICAL_LEGACY_METADATA_AND_ID_GUARDS=PASS");
  const allowed = ['projects','works','editions','sources','external_identities','project_bindings'];
  const tables = (await db.query("SELECT schemaname, tablename FROM pg_tables WHERE schemaname IN ('core','ops','derived')")).rows;
  for (const { schemaname, tablename } of tables) {
    if (schemaname === "core" && allowed.includes(tablename)) continue;
    const quote = (v: string) => `"${v.replaceAll('"', '""')}"`;
    expect((await db.query(`SELECT count(*)::int n FROM ${quote(schemaname)}.${quote(tablename)}`)).rows[0].n, `${schemaname}.${tablename}`).toBe(0);
  }
  console.log("M1C_NO_OTHER_DOMAIN_WRITES=PASS");
}, 45000);
