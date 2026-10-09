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

function psql(sql: string): string {
  return execFileSync("docker", [
    "--host", "unix:///var/run/docker.sock", "exec", "-i", CONTAINER,
    "psql", "-X", "-v", "ON_ERROR_STOP=1", "-h", "127.0.0.1",
    "-U", DB_USER, "-d", DB_NAME, "-Atc", sql,
  ], { encoding: "utf8", timeout: 30_000 }).trim();
}

function bindingCount(bookId: string, projectId = P): number {
  const allowed = [A, B];
  if (!allowed.includes(bookId) || ![P, ARCHIVED, FOREIGN].includes(projectId)) throw Error("invalid fixture");
  return Number(psql(
    "SELECT count(*) FROM core.project_bindings WHERE target_type='EDITION' " +
    "AND project_id='" + projectId + "' AND metadata->>'catalogBookId'='" + bookId + "'",
  ));
}
function identityCount(bookId: string): number {
  if (![A, B].includes(bookId)) throw Error("invalid fixture");
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

});
