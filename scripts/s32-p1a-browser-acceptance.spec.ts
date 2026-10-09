/**
 * P1-A real Chromium against isolated PG16 + real Web/API/Owner cookie.
 * Public catalog payload and POST catalog promotion are explicitly mocked:
 * no Meilisearch/full catalog and NO real new binding is inserted.
 * The destination Project Overview/deep-link is backed by real PG16 fixture.
 */
import { expect, test, type Browser, type Page } from "@playwright/test";

const WEB = process.env.GATE4_BROWSER_WEB ?? "http://127.0.0.1:5173";
const COOKIE = process.env.GATE4_BROWSER_SESSION_COOKIE!;
const P = "11111111-1111-4111-8111-111111111111";
const BINDING = "81111111-1111-4111-8111-111111111111";
const A = "p1a-synthetic-book";
const B = "p1a-synthetic-other";
const fixture = (id: string, title: string) => ({
  id, title, author: "Synthetic Author", publisher: "Synthetic Publisher",
  year: 2024, pages: 101, isbn: "9780000000012",
  ssid: "SYNTH-01", dxid: "SYNTH-02", rawInfo: "SYNTHETIC_ONLY",
  parseStatus: "ok", parseWarnings: [],
});
const bookA = fixture(A, "P1A Synthetic Primary");
const bookB = fixture(B, "P1A Synthetic Secondary");

async function context(browser: Browser, authorized: boolean, viewport?: { width: number; height: number }) {
  const ctx = await browser.newContext(viewport ? { viewport } : {});
  if (authorized) {
    const [name, value] = COOKIE.split("=");
    await ctx.addCookies([{ name, value, url: WEB }]);
  }
  return ctx;
}

async function stubPublicBook(page: Page, { relatedFail = false, withOther = false } = {}) {
  await page.route("**/api/books/" + A, route =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ item: bookA }) }));
  await page.route("**/api/books/" + A + "/related", route =>
    relatedFail
      ? route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { message: "Synthetic related unavailable" } }) })
      : route.fulfill({ status: 200, contentType: "application/json",
          body: JSON.stringify({ total: withOther ? 1 : 0, items: withOther ? [bookB] : [] }) }));
  await page.route("**/api/books/" + B + "/related", route =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ total: 0, items: [] }) }));
}

test("P1A-B01: authenticated Book Detail → existing real PG project, mocked add receipt → exact binding deep-link", async ({ browser }) => {
  const ctx = await context(browser, true);
  const page = await ctx.newPage();
  await stubPublicBook(page);
  let addCalls = 0;
  await page.route("**/api/private/s32/projects/" + P + "/catalog-books", async route => {
    addCalls += 1;
    expect(route.request().method()).toBe("POST");
    expect(route.request().postDataJSON()).toEqual({ bookId: A });
    // Isolated UI contract stub ONLY: binding itself already exists in PG fixture.
    await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({
      promotionStatus: "created", bindingStatus: "created",
      item: { bindingId: BINDING, projectId: P,
        workId: "41111111-1111-4111-8111-111111111111",
        editionId: "51111111-1111-4111-8111-111111111111",
        sourceId: "61111111-1111-4111-8111-111111111111",
        catalogBookId: A, title: bookA.title, publisher: null,
        publicationDate: null, publicationDatePrecision: "YEAR", isbn: null,
        addedAt: "2026-10-09T01:02:03.123Z",
      },
    }) });
  });
  await page.goto(WEB + "/books/" + A);
  await expect(page.getByRole("heading", { name: bookA.title })).toBeVisible({ timeout: 20000 });
  const section = page.getByRole("region", { name: "本书的研究操作" });
  await expect(section).toBeVisible();
  await section.getByRole("button", { name: "加入研究" }).click();
  await section.getByRole("button", { name: "Gate2 Run Project" }).click();
  await expect(section.getByRole("link", { name: "查看这本书在项目中的资料" })).toBeVisible();
  const destination = WEB + "/research/projects/" + P + "?item=" + BINDING;
  await expect(section.getByRole("link", { name: "查看这本书在项目中的资料" })).toHaveAttribute("href", "/research/projects/" + P + "?item=" + BINDING);
  expect(addCalls).toBe(1);
  await section.getByRole("link", { name: "查看这本书在项目中的资料" }).click();
  await expect(page).toHaveURL(destination);
  await expect(page.locator("[data-binding-id='" + BINDING + "']")).toBeVisible({ timeout: 20000 });
  await ctx.close();
});

test("P1A-B02: anonymous view retains public Book Detail but no private membership traffic", async ({ browser }) => {
  const ctx = await context(browser, false);
  const page = await ctx.newPage();
  const privateCalls: string[] = [];
  page.on("request", request => {
    if (request.url().includes("/api/private/s32/")) privateCalls.push(request.method() + " " + request.url());
  });
  await stubPublicBook(page);
  await page.goto(WEB + "/books/" + A);
  await expect(page.getByRole("heading", { name: bookA.title })).toBeVisible({ timeout: 20000 });
  const section = page.getByRole("region", { name: "本书的研究操作" });
  await section.getByRole("button", { name: "加入研究" }).click();
  await expect(section.getByRole("link", { name: "私人研究空间" })).toBeVisible();
  expect(privateCalls).toEqual([]);
  await ctx.close();
});

test("P1A-B03: mobile Book Detail is usable even when related-book service fails", async ({ browser }) => {
  const ctx = await context(browser, true, { width: 390, height: 844 });
  const page = await ctx.newPage();
  await stubPublicBook(page, { relatedFail: true });
  await page.goto(WEB + "/books/" + A);
  await expect(page.getByRole("heading", { name: bookA.title })).toBeVisible({ timeout: 20000 });
  await expect(page.getByText("相关图书暂时无法加载，不影响当前书目信息。")).toBeVisible();
  const section = page.getByRole("region", { name: "本书的研究操作" });
  await expect(section.getByRole("button", { name: "加入研究" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  await section.getByRole("button", { name: "加入研究" }).focus();
  await page.keyboard.press("Enter");
  await expect(section.getByRole("button", { name: "Gate2 Run Project" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  await page.screenshot({ path: "test-results/p1a-mobile.png", fullPage: true });
  await ctx.close();
});

test("P1A-B04: rapid route A→B never lets A's private research action persist while B loads", async ({ browser }) => {
  const ctx = await context(browser, true);
  const page = await ctx.newPage();
  await stubPublicBook(page, { withOther: true });
  let resumeB!: () => void;
  await page.route("**/api/books/" + B, async route => {
    await new Promise<void>(resolve => { resumeB = resolve; });
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ item: bookB }) });
  });
  await page.goto(WEB + "/books/" + A);
  await expect(page.getByRole("heading", { name: bookA.title })).toBeVisible({ timeout: 20000 });
  await page.getByRole("link", { name: "查看 P1A Synthetic Secondary 详情" }).click();
  await expect(page).toHaveURL(WEB + "/books/" + B);
  await expect(page.getByRole("heading", { name: bookA.title })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "本书的研究操作" })).toHaveCount(0);
  resumeB();
  await expect(page.getByRole("heading", { name: bookB.title })).toBeVisible({ timeout: 20000 });
  await expect(page.getByRole("region", { name: "本书的研究操作" })).toBeVisible();
  await ctx.close();
});
