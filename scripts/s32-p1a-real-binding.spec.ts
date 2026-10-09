/**
 * P1-A exact-head full-write acceptance: real Playwright Chromium → real
 * Vite → real Express Owner session/CSRF/S32 router → real disposable PG16.
 * Catalog source contains ONLY fixed in-memory synthetic records in the
 * TEST-ONLY API; no Meilisearch or production requests. Unlike the P1A UI
 * suite, neither public Book GET nor catalog-binding POST is mocked here.
 */
import { execFileSync } from "node:child_process";
import { expect, test, type Browser, type Page } from "@playwright/test";

const WEB = process.env.GATE4_BROWSER_WEB ?? "http://127.0.0.1:5173";
const COOKIE = process.env.GATE4_BROWSER_SESSION_COOKIE!;
const CONTAINER = process.env.GATE4_BROWSER_CONTAINER!;
const DB_USER = process.env.GATE4_BROWSER_DB_USER ?? "s32browser";
const DB_NAME = process.env.GATE4_BROWSER_DB_NAME ?? "s32_m3a_gate3_browser";
const P = "11111111-1111-4111-8111-111111111111";
const ARCHIVED = "13111111-1111-4111-8111-111111111111";
const FOREIGN = "12111111-1111-4111-8111-111111111111";
const A = "p1a-synthetic-book";
const B = "p1a-synthetic-other";
const TITLE_A = "P1A Synthetic Primary";
const TITLE_B = "P1A Synthetic Secondary";
const RACE_SAME = "p1a-synthetic-concurrent";
const RACE_CROSS = "p1a-synthetic-cross-race";
const TITLE_RACE_SAME = "P1A Concurrent Same Project";
const TITLE_RACE_CROSS = "P1A Concurrent Cross Project";
const COLLISION = "p1a-synthetic-conflict";
const TITLE_COLLISION = "P1A Synthetic Identity Collision";
const ALL_SYNTHETIC_IDS = [A, B, RACE_SAME, RACE_CROSS, COLLISION];

function psql(sql: string): string {
  return execFileSync("docker", [
    "--host", "unix:///var/run/docker.sock", "exec", "-i", CONTAINER,
    "psql", "-X", "-v", "ON_ERROR_STOP=1", "-h", "127.0.0.1",
    "-U", DB_USER, "-d", DB_NAME, "-Atc", sql,
  ], { encoding: "utf8", timeout: 30_000 }).trim();
}

function bindingCount(bookId: string, projectId = P): number {
  const allowed = ALL_SYNTHETIC_IDS;
  if (!allowed.includes(bookId) || ![P, ARCHIVED, FOREIGN].includes(projectId)) throw Error("invalid fixture");
  return Number(psql(
    "SELECT count(*) FROM core.project_bindings WHERE target_type='EDITION' " +
    "AND project_id='" + projectId + "' AND metadata->>'catalogBookId'='" + bookId + "'",
  ));
}
function identityCount(bookId: string): number {
  if (!ALL_SYNTHETIC_IDS.includes(bookId)) throw Error("invalid fixture");
  return Number(psql("SELECT count(*) FROM core.external_identities WHERE provider='BOOK_ID_SEARCH' " +
    "AND namespace='CATALOG_DOCUMENT' AND external_id='" + bookId + "' AND binding_state<>'RETIRED'"));
}

async function context(browser: Browser, loggedIn: boolean) {
  const ctx = await browser.newContext();
  if (loggedIn) {
    const [name, value] = COOKIE.split("=");
    await ctx.addCookies([{ name, value, url: WEB }]);
  }
  return ctx;
}
async function detail(page: Page, bookId: string, name: string) {
  await page.goto(WEB + "/books/" + bookId);
  await expect(page.getByRole("heading", { name })).toBeVisible({ timeout: 20_000 });
  return page.getByRole("region", { name: "本书的研究操作" });
}
async function postBinding(page: Page, projectId: string, bookId: string, validCsrf = true) {
  return page.evaluate(async ({ projectId, bookId, validCsrf }) => {
    const session = await fetch("/api/auth/session", { credentials: "same-origin", cache: "no-store" })
      .then(r => r.json());
    const res = await fetch("/api/private/s32/projects/" + projectId + "/catalog-books", {
      method: "POST", cache: "no-store", credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": validCsrf ? (session.csrfToken ?? "") : "invalid-p1a-csrf" },
      body: JSON.stringify({ bookId }),
    });
    return { status: res.status, body: await res.json() };
  }, { projectId, bookId, validCsrf });
}
test.describe.serial("P1A real owner session + synthetic catalog → actual PG16 binding", () => {
  let createdBinding: string | null = null;

  test("R01 — browser first add does real 201/INSERT and links to the exact newly created PG row", async ({ browser }) => {
    const ctx = await context(browser, true);
    const page = await ctx.newPage();
    expect(bindingCount(A)).toBe(0);
    expect(identityCount(A)).toBe(0);
    const region = await detail(page, A, TITLE_A);
    await region.getByRole("button", { name: "加入研究" }).click();
    const wire = page.waitForResponse(response => response.url().endsWith(
      "/api/private/s32/projects/" + P + "/catalog-books",
    ) && response.request().method() === "POST");
    await region.getByRole("button", { name: "Gate2 Run Project" }).click();
    const response = await wire;
    expect(response.status()).toBe(201);
    const receipt = await response.json();
    expect(receipt).toMatchObject({
      promotionStatus: "created", bindingStatus: "created",
      item: { projectId: P, catalogBookId: A, title: TITLE_A },
    });
    createdBinding = receipt.item.bindingId;
    expect(createdBinding).toMatch(/^[0-9a-f-]{36}$/);
    expect(bindingCount(A)).toBe(1);
    expect(identityCount(A)).toBe(1);
    expect(Number(psql("SELECT count(*) FROM core.works WHERE title='" + TITLE_A + "'"))).toBe(1);
    expect(Number(psql("SELECT count(*) FROM core.editions e JOIN core.works w ON w.id=e.work_id WHERE w.title='" + TITLE_A + "'"))).toBe(1);
    expect(Number(psql("SELECT count(*) FROM core.sources s JOIN core.editions e ON e.id=s.edition_id JOIN core.works w ON w.id=e.work_id WHERE w.title='" + TITLE_A + "'"))).toBe(1);
    const link = region.getByRole("link", { name: "查看这本书在项目中的资料" });
    await expect(link).toHaveAttribute("href", "/research/projects/" + P + "?item=" + createdBinding);
    await link.click();
    const item = page.locator("[data-binding-id='" + createdBinding + "']");
    await expect(item.getByRole("heading", { name: TITLE_A })).toBeVisible({ timeout: 20_000 });
    console.log("P1A_REAL_WRITE_201_CREATED=PASS");
    console.log("P1A_REAL_PG_BINDING_ROW_AND_IDENTITY=PASS");
    console.log("P1A_NEW_BINDING_DEEP_LINK=PASS");
    await ctx.close();
  });

  test("R02 — re-adding same book via actual authenticated HTTP returns 200 existing, no extra canonical rows", async ({ browser }) => {
    expect(createdBinding).toBeTruthy();
    const ctx = await context(browser, true);
    const page = await ctx.newPage();
    const region = await detail(page, A, TITLE_A);
    await expect(region.getByRole("link", { name: "Gate2 Run Project" })).toBeVisible();
    const receipt = await postBinding(page, P, A);
    expect(receipt.status).toBe(200);
    expect(receipt.body).toMatchObject({
      promotionStatus: "existing", bindingStatus: "existing",
      item: { projectId: P, bindingId: createdBinding, catalogBookId: A, title: TITLE_A },
    });
    expect(bindingCount(A)).toBe(1);
    expect(identityCount(A)).toBe(1);
    expect(Number(psql("SELECT count(*) FROM core.works WHERE title='" + TITLE_A + "'"))).toBe(1);
    console.log("P1A_REAL_HTTP_200_EXISTING_IDEMPOTENT=PASS");
    await ctx.close();
  });

  test("R03 — archive scope rejects real add with 409 and never promotes another catalog book", async ({ browser }) => {
    const ctx = await context(browser, true);
    const page = await ctx.newPage();
    const region = await detail(page, B, TITLE_B);
    await region.getByRole("button", { name: "加入研究" }).click();
    await expect(region.getByRole("button", { name: "Gate2 Run Project" })).toBeVisible();
    await expect(region.getByRole("button", { name: "Gate3 Archived Project" })).toHaveCount(0);
    expect(bindingCount(B)).toBe(0);
    expect(identityCount(B)).toBe(0);
    const denied = await postBinding(page, ARCHIVED, B);
    expect(denied.status).toBe(409);
    expect(denied.body.error.code).toBe("PROJECT_READ_ONLY");
    expect(bindingCount(B)).toBe(0);
    expect(bindingCount(B, ARCHIVED)).toBe(0);
    expect(identityCount(B)).toBe(0);
    console.log("P1A_REAL_PG_ARCHIVED_REJECTED_ZERO_WRITE=PASS");
    await ctx.close();
  });

  test("R04 — anonymous POST 401 and forged CSRF 403 both fail without any promotion", async ({ browser }) => {
    const anon = await context(browser, false);
    const ap = await anon.newPage();
    await detail(ap, B, TITLE_B);
    const unauth = await postBinding(ap, P, B);
    expect(unauth.status).toBe(401);
    expect(bindingCount(B)).toBe(0);
    expect(identityCount(B)).toBe(0);
    await anon.close();

    const owner = await context(browser, true);
    const page = await owner.newPage();
    await detail(page, B, TITLE_B);
    const forged = await postBinding(page, P, B, false);
    expect(forged.status).toBe(403);
    expect(bindingCount(B)).toBe(0);
    expect(identityCount(B)).toBe(0);
    console.log("P1A_REAL_OWNER_AUTH_401_CSRF_403_NO_WRITE=PASS");
    await owner.close();
  });

  test("R05 — adding a second catalog edition creates a distinct canonical identity and project item", async ({ browser }) => {
    const ctx = await context(browser, true);
    const page = await ctx.newPage();
    const region = await detail(page, B, TITLE_B);
    await region.getByRole("button", { name: "加入研究" }).click();
    const wire = page.waitForResponse(response => response.url().endsWith(
      "/api/private/s32/projects/" + P + "/catalog-books",
    ) && response.request().method() === "POST");
    await region.getByRole("button", { name: "Gate2 Run Project" }).click();
    const response = await wire;
    expect(response.status()).toBe(201);
    const payload = await response.json();
    expect(payload.bindingStatus).toBe("created");
    expect(payload.item.title).toBe(TITLE_B);
    expect(payload.item.catalogBookId).toBe(B);
    expect(payload.item.bindingId).not.toBe(createdBinding);
    expect(bindingCount(B)).toBe(1);
    expect(identityCount(B)).toBe(1);
    expect(bindingCount(A)).toBe(1);
    const link = region.getByRole("link", { name: "查看这本书在项目中的资料" });
    await link.click();
    const item = page.locator("[data-binding-id='" + payload.item.bindingId + "']");
    await expect(item.getByRole("heading", { name: TITLE_B })).toBeVisible({ timeout: 20_000 });
    console.log("P1A_REAL_DISTINCT_BOOK_NO_IDENTITY_COLLISION=PASS");
    await ctx.close();
  });
  test("R06 — one canonical edition may enter another ACTIVE project with a second binding, not a second Work", async ({ browser }) => {
    expect(createdBinding).toBeTruthy();
    expect(bindingCount(A, FOREIGN)).toBe(0);
    const ctx = await context(browser, true);
    const page = await ctx.newPage();
    const section = await detail(page, A, TITLE_A);
    await expect(section.getByRole("link", { name: "Gate2 Run Project" })).toBeVisible();
    await section.getByRole("button", { name: "加入研究" }).click();
    await expect(section.getByRole("button", { name: "Gate2 Run Project" })).toHaveCount(0);
    const network = page.waitForResponse(response =>
      response.url().endsWith("/api/private/s32/projects/" + FOREIGN + "/catalog-books")
      && response.request().method() === "POST");
    await section.getByRole("button", { name: "Gate2 Foreign Project" }).click();
    const response = await network;
    expect(response.status()).toBe(201);
    const receipt = await response.json();
    expect(receipt).toMatchObject({
      promotionStatus: "existing",
      bindingStatus: "created",
      item: { projectId: FOREIGN, catalogBookId: A, title: TITLE_A },
    });
    const foreignBinding = receipt.item.bindingId as string;
    expect(foreignBinding).not.toBe(createdBinding);
    expect(bindingCount(A)).toBe(1);
    expect(bindingCount(A, FOREIGN)).toBe(1);
    expect(identityCount(A)).toBe(1);
    expect(Number(psql("SELECT count(*) FROM core.works WHERE title='" + TITLE_A + "'"))).toBe(1);
    expect(Number(psql(
      "SELECT count(DISTINCT target_id) FROM core.project_bindings " +
      "WHERE target_type='EDITION' AND project_id IN ('" + P + "','" + FOREIGN + "') " +
      "AND metadata->>'catalogBookId'='" + A + "'",
    ))).toBe(1);
    const link = section.getByRole("link", { name: "查看这本书在项目中的资料" });
    await expect(link).toHaveAttribute("href", "/research/projects/" + FOREIGN + "?item=" + foreignBinding);
    await link.click();
    await expect(page.locator("[data-binding-id='" + foreignBinding + "']")
      .getByRole("heading", { name: TITLE_A })).toBeVisible({ timeout: 20_000 });
    console.log("P1A_REAL_CROSS_PROJECT_REUSES_EDITION_NEW_BINDING=PASS");
    await ctx.close();
  });

  test("R07 — missing synthetic catalog ID yields 404 with zero new identities, Works or Project bindings", async ({ browser }) => {
    const ctx = await context(browser, true);
    const page = await ctx.newPage();
    await detail(page, A, TITLE_A);
    const before = psql("SELECT (SELECT count(*) FROM core.works)::text || ':' || " +
      "(SELECT count(*) FROM core.editions)::text || ':' || " +
      "(SELECT count(*) FROM core.sources)::text || ':' || " +
      "(SELECT count(*) FROM core.external_identities)::text || ':' || " +
      "(SELECT count(*) FROM core.project_bindings)::text");
    const missingId = "p1a-synthetic-missing";
    const result = await postBinding(page, P, missingId);
    expect(result.status).toBe(404);
    expect(result.body.error).toBeTruthy();
    const after = psql("SELECT (SELECT count(*) FROM core.works)::text || ':' || " +
      "(SELECT count(*) FROM core.editions)::text || ':' || " +
      "(SELECT count(*) FROM core.sources)::text || ':' || " +
      "(SELECT count(*) FROM core.external_identities)::text || ':' || " +
      "(SELECT count(*) FROM core.project_bindings)::text");
    expect(after).toBe(before);
    console.log("P1A_REAL_MISSING_CATALOG_ZERO_WRITE=PASS");
    await ctx.close();
  });

  test("R08 — two parallel first-add POSTs into one Project create exactly one canonical Edition and Binding", async ({ browser }) => {
    expect(bindingCount(RACE_SAME)).toBe(0);
    expect(identityCount(RACE_SAME)).toBe(0);
    const ctx = await context(browser, true);
    const page = await ctx.newPage();
    await detail(page, A, TITLE_A); // same-origin real Owner session, no catalog/book mocks
    const [first, second] = await Promise.all([
      postBinding(page, P, RACE_SAME),
      postBinding(page, P, RACE_SAME),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 201]);
    expect([first.body.promotionStatus, second.body.promotionStatus].sort()).toEqual(["created", "existing"]);
    expect([first.body.bindingStatus, second.body.bindingStatus].sort()).toEqual(["created", "existing"]);
    expect(first.body.item.bindingId).toBe(second.body.item.bindingId);
    expect(first.body.item.editionId).toBe(second.body.item.editionId);
    expect(first.body.item.workId).toBe(second.body.item.workId);
    expect(first.body.item.sourceId).toBe(second.body.item.sourceId);
    expect(first.body.item.catalogBookId).toBe(RACE_SAME);
    expect(first.body.item.title).toBe(TITLE_RACE_SAME);
    expect(bindingCount(RACE_SAME)).toBe(1);
    expect(identityCount(RACE_SAME)).toBe(1);
    expect(Number(psql("SELECT count(*) FROM core.works WHERE title='" + TITLE_RACE_SAME + "'"))).toBe(1);
    expect(Number(psql("SELECT count(*) FROM core.editions e JOIN core.works w ON w.id=e.work_id WHERE w.title='" + TITLE_RACE_SAME + "'"))).toBe(1);
    expect(Number(psql("SELECT count(*) FROM core.sources s JOIN core.editions e ON e.id=s.edition_id JOIN core.works w ON w.id=e.work_id WHERE w.title='" + TITLE_RACE_SAME + "'"))).toBe(1);
    console.log("P1A_REAL_PARALLEL_SAME_PROJECT_IDEMPOTENT=PASS");
    await ctx.close();
  });

  test("R09 — concurrent first-add into two ACTIVE Projects preserves one Edition and independent bindings", async ({ browser }) => {
    expect(bindingCount(RACE_CROSS, P)).toBe(0);
    expect(bindingCount(RACE_CROSS, FOREIGN)).toBe(0);
    expect(identityCount(RACE_CROSS)).toBe(0);
    const ctx = await context(browser, true);
    const page = await ctx.newPage();
    await detail(page, B, TITLE_B);
    const [main, foreign] = await Promise.all([
      postBinding(page, P, RACE_CROSS),
      postBinding(page, FOREIGN, RACE_CROSS),
    ]);
    expect(main.status).toBe(201);
    expect(foreign.status).toBe(201);
    expect([main.body.promotionStatus, foreign.body.promotionStatus].sort()).toEqual(["created", "existing"]);
    expect(main.body.bindingStatus).toBe("created");
    expect(foreign.body.bindingStatus).toBe("created");
    expect(main.body.item.bindingId).not.toBe(foreign.body.item.bindingId);
    expect(main.body.item.editionId).toBe(foreign.body.item.editionId);
    expect(main.body.item.workId).toBe(foreign.body.item.workId);
    expect(main.body.item.sourceId).toBe(foreign.body.item.sourceId);
    expect(main.body.item.title).toBe(TITLE_RACE_CROSS);
    expect(foreign.body.item.title).toBe(TITLE_RACE_CROSS);
    expect(bindingCount(RACE_CROSS, P)).toBe(1);
    expect(bindingCount(RACE_CROSS, FOREIGN)).toBe(1);
    expect(identityCount(RACE_CROSS)).toBe(1);
    expect(Number(psql("SELECT count(*) FROM core.works WHERE title='" + TITLE_RACE_CROSS + "'"))).toBe(1);
    expect(Number(psql("SELECT count(*) FROM core.editions e JOIN core.works w ON w.id=e.work_id WHERE w.title='" + TITLE_RACE_CROSS + "'"))).toBe(1);
    expect(Number(psql("SELECT count(DISTINCT target_id) FROM core.project_bindings WHERE target_type='EDITION' AND metadata->>'catalogBookId'='" + RACE_CROSS + "'"))).toBe(1);
    console.log("P1A_REAL_PARALLEL_CROSS_PROJECT_SHARED_EDITION=PASS");
    await ctx.close();
  });

  test("R10 — conflicting SSID in a different catalog document rolls back all attempted canonical writes", async ({ browser }) => {
    expect(identityCount(A)).toBe(1); // book A is already authoritative
    expect(bindingCount(COLLISION)).toBe(0);
    expect(identityCount(COLLISION)).toBe(0);
    const snapshot = "SELECT (SELECT count(*) FROM core.works)::text || ':' || " +
      "(SELECT count(*) FROM core.editions)::text || ':' || " +
      "(SELECT count(*) FROM core.sources)::text || ':' || " +
      "(SELECT count(*) FROM core.external_identities)::text || ':' || " +
      "(SELECT count(*) FROM core.project_bindings)::text";
    const before = psql(snapshot);
    const ctx = await context(browser, true);
    const page = await ctx.newPage();
    await detail(page, A, TITLE_A);
    const denied = await postBinding(page, P, COLLISION);
    expect(denied.status).toBe(409);
    expect(denied.body.error?.message).toContain("身份冲突");
    const after = psql(snapshot);
    expect(after).toBe(before);
    expect(bindingCount(COLLISION)).toBe(0);
    expect(identityCount(COLLISION)).toBe(0);
    expect(Number(psql("SELECT count(*) FROM core.works WHERE title='" + TITLE_COLLISION + "'"))).toBe(0);
    expect(bindingCount(A)).toBe(1);
    console.log("P1A_REAL_SECONDARY_IDENTITY_CONFLICT_ROLLBACK=PASS");
    await ctx.close();
  });

});
