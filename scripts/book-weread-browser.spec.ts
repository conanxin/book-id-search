/**
 * Real Chromium, Vite, signed owner session and production WeRead snapshot/query
 * services. All books/notes are synthetic; external WeRead and Google OAuth are
 * not exercised. The two race/error cases explicitly simulate network delivery.
 */
import { expect, test, type BrowserContext, type Page, type Response as PlaywrightResponse, type TestInfo } from "@playwright/test";
import { issueWebSession } from "../apps/api/src/auth/web-session.js";
import { getBookBrowserCatalogIds } from "./book-browser-fixtures.js";

const WEB = "http://127.0.0.1:5173";
const runId = process.env.BOOK_LIBRARY_BROWSER_RUN_ID!;
const { A, B } = getBookBrowserCatalogIds(runId);
const TITLE_A = `古道阅读验证甲 ${runId}`, TITLE_B = `古道阅读验证乙 ${runId}`;
const LOGIN_TITLE = "登录后，继续整理这本书与阅读资料";
const A_TEXT = /^甲书微信(?:划线|想法|书评) \d{2} · 合成验收$/;
const B_TEXT = /^乙书微信(?:划线|想法|书评) \d{2} · 合成验收$/;
const notesRegion = (page: Page) => page.getByRole("region", { name: "微信读书记录", exact: true });
const wereadOnly = process.env.BOOK_LIBRARY_BROWSER_SCOPE === "weread";

test.beforeEach(async ({ page }) => {
  if (!wereadOnly) return;
  // Local WeRead-only verification has no PostgreSQL. The unrelated personal
  // library panel gets an explicitly synthetic empty read. Default CI uses the
  // real library router/PG and never installs this route override.
  await page.route("**/api/private/s32/library/books/*", async route => {
    if (route.request().method() !== "GET") return route.abort("blockedbyclient");
    const bookId = decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-1)!);
    await route.fulfill({ status: 200, contentType: "application/json", json: { item: {
      bookId, saved: false, editionId: null, introduction: "", version: 0,
      updatedAt: null, notes: [], resources: [],
    } } });
  });
});

async function ownerSession(context: BrowserContext) {
  const { token } = issueWebSession({ sub: "book-library-test-owner", name: "合成验证账号", email: "library-test@example.test" }, {
    secret: "book-library-synthetic-session-secret-for-local-ci-only",
  });
  await context.addCookies([{ name: "book_id_search_session_dev", value: token, url: WEB, httpOnly: true, sameSite: "Lax" }]);
}

async function evidence(testInfo: TestInfo, network: string) {
  await testInfo.attach("weread-verification-scope.json", {
    body: JSON.stringify({
      task: "BOOK_CENTERED_WEREAD_NOTES_V1", catalog: "two synthetic books with valid catalog IDs",
      weread: "synthetic local snapshots + confirmed bindings; production loader, query and status services",
      authentication: "real signed owner session + production Google-only middleware", actualGoogleOAuth: "NOT_EXERCISED",
      libraryPersistence: wereadOnly ? "NOT_EXERCISED; unrelated library GET is a synthetic empty read" : "real PostgreSQL",
      externalWeread: "NOT_CONTACTED", network,
    }, null, 2), contentType: "application/json",
  });
}

function notesResponse(catalogId: string, type = "all", offset = 0) {
  return (response: PlaywrightResponse) => {
    const url = new URL(response.url());
    return url.pathname === "/api/private/weread/notes" && url.searchParams.get("catalogId") === catalogId
      && (url.searchParams.get("type") ?? "all") === type && Number(url.searchParams.get("offset") ?? 0) === offset;
  };
}

async function responsePage(response: PlaywrightResponse, catalogId: string, count: number, total: number, offset: number) {
  expect(response.ok()).toBe(true);
  const data = await response.json();
  expect(data).toMatchObject({ ok: true, pageInfo: { limit: 20, offset, total } });
  expect(data.items).toHaveLength(count);
  expect(data.items.every((item: { catalogId: string; matched: boolean }) => item.catalogId === catalogId && item.matched)).toBe(true);
}

test("real synthetic snapshots: first 20, load more, type filters and book/WeRead navigation keep one book scope", async ({ page, context }, testInfo) => {
  await evidence(testInfo, "WEREAD_REAL_LOCAL_API; no WeRead response mocking");
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  expect((await page.request.get(`/api/private/weread/notes?catalogId=${A}`)).status()).toBe(401);
  await ownerSession(context);
  const first = page.waitForResponse(notesResponse(A));
  await page.goto(`/books/${A}`);
  await expect(page.getByRole("heading", { name: TITLE_A, exact: true })).toBeVisible();
  await responsePage(await first, A, 20, 27, 0);
  const region = notesRegion(page);
  await expect(region.getByRole("article")).toHaveCount(20);
  await expect(region.getByText(B_TEXT)).toHaveCount(0);
  await expect(region.getByRole("status").filter({ hasText: /已显示 20 条.*当前筛选共 27 条/ })).toBeVisible();
  await region.screenshot({ path: testInfo.outputPath("weread-book-first-20.png") });

  const next = page.waitForResponse(notesResponse(A, "all", 20));
  await region.getByRole("button", { name: "加载更多", exact: true }).click();
  await responsePage(await next, A, 7, 27, 20);
  await expect(region.getByRole("article")).toHaveCount(27);
  await expect(region.getByRole("button", { name: "加载更多", exact: true })).toHaveCount(0);
  await expect(region.getByText(B_TEXT)).toHaveCount(0);

  for (const filter of [{ value: "highlight", count: 20, total: 22 }, { value: "thought", count: 3, total: 3 }, { value: "review", count: 2, total: 2 }]) {
    const response = page.waitForResponse(notesResponse(A, filter.value));
    await region.getByRole("combobox", { name: "记录类型", exact: true }).selectOption(filter.value);
    await responsePage(await response, A, filter.count, filter.total, 0);
    await expect(region.getByRole("article")).toHaveCount(filter.count);
    await expect(region.getByText(B_TEXT)).toHaveCount(0);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await region.screenshot({ path: testInfo.outputPath("weread-book-review-mobile.png") });
  await page.setViewportSize({ width: 1440, height: 1000 });
  const reset = page.waitForResponse(notesResponse(A));
  await region.getByRole("combobox", { name: "记录类型", exact: true }).selectOption("all");
  await responsePage(await reset, A, 20, 27, 0);

  const centerPage = page.waitForResponse(notesResponse(A));
  await region.getByRole("link", { name: "在微信读书中心查看本书记录", exact: true }).click();
  await expect(page).toHaveURL(`/weread?catalogId=${A}`);
  const scope = page.getByRole("region", { name: "本书笔记", exact: true });
  await expect(scope.getByText(`当前书目：${A}`, { exact: true })).toBeVisible();
  await expect(scope.getByRole("link", { name: "返回书籍详情", exact: true })).toHaveAttribute("href", `/books/${A}`);
  await responsePage(await centerPage, A, 20, 27, 0);
  await expect(page.getByText(A_TEXT)).toHaveCount(20);
  await expect(page.getByText(B_TEXT)).toHaveCount(0);
  const detailLinks = page.getByRole("link", { name: "查看书籍详情", exact: true });
  await expect(detailLinks).toHaveCount(20);
  await expect(detailLinks.first()).toHaveAttribute("href", `/books/${A}`);
  await page.screenshot({ path: testInfo.outputPath("weread-center-book-scope.png"), fullPage: true });
  await detailLinks.first().click();
  await expect(page).toHaveURL(`/books/${A}`);
  await expect(notesRegion(page).getByRole("article")).toHaveCount(20);

  const other = page.waitForResponse(notesResponse(B));
  await page.getByRole("link", { name: `查看 ${TITLE_B} 详情`, exact: true }).click();
  await expect(page).toHaveURL(`/books/${B}`);
  await responsePage(await other, B, 3, 3, 0);
  await expect(notesRegion(page).getByRole("article")).toHaveCount(3);
  await expect(notesRegion(page).getByText(A_TEXT)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("synthetic wrong-book response is rejected before private records render", async ({ page, context }, testInfo) => {
  await evidence(testInfo, "SYNTHETIC_RESPONSE_SWAP: A receives B's synthetic API payload");
  await ownerSession(context);
  const otherResponse = await page.request.get(`/api/private/weread/notes?catalogId=${B}&limit=20`);
  expect(otherResponse.ok()).toBe(true);
  const otherPayload = await otherResponse.json();
  await page.route("**/api/private/weread/notes?**", async route => {
    if (new URL(route.request().url()).searchParams.get("catalogId") !== A) return route.continue();
    await route.fulfill({ status: 200, contentType: "application/json", json: otherPayload });
  });
  await page.goto(`/books/${A}`);
  const region = notesRegion(page);
  await expect(region.getByRole("alert")).toBeVisible();
  await expect(region.getByRole("button", { name: "重试读取记录", exact: true })).toBeVisible();
  await expect(region.getByRole("article")).toHaveCount(0);
  await expect(region.getByText(B_TEXT)).toHaveCount(0);
  await region.screenshot({ path: testInfo.outputPath("weread-wrong-book-rejected.png") });
});

// Delay a real local API response and deliberately ignore transport cancellation.
// This proves stale-response guards even if the fetch resolves after navigation
// or sign-out; it is a synthetic timing scenario, not a production network trace.
async function holdSecondPage(page: Page) {
  await page.addInitScript(({ catalogId }) => {
    const original = window.fetch.bind(window);
    const pending: Array<() => void> = [];
    const control = { pending: 0, release: () => { for (const deliver of pending.splice(0)) deliver(); control.pending = 0; } };
    (window as typeof window & { __bookWereadDelivery: typeof control }).__bookWereadDelivery = control;
    window.fetch = (input, init) => {
      const value = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(value, window.location.origin);
      if (url.pathname === "/api/private/weread/notes" && url.searchParams.get("catalogId") === catalogId && url.searchParams.get("offset") === "20") {
        return original(input, { ...init, signal: undefined }).then(response => new Promise<Response>(resolve => {
          pending.push(() => resolve(response)); control.pending = pending.length;
        }));
      }
      return original(input, init);
    };
  }, { catalogId: A });
}

async function waitForHeldPage(page: Page) {
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __bookWereadDelivery?: { pending: number } }).__bookWereadDelivery?.pending)).toBe(1);
}

async function releaseHeldPage(page: Page) {
  await page.evaluate(async () => {
    (window as typeof window & { __bookWereadDelivery?: { release: () => void } }).__bookWereadDelivery?.release();
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
  });
}

test("synthetically delayed page from book A cannot append to book B", async ({ page, context }, testInfo) => {
  await evidence(testInfo, "SYNTHETIC_DELIVERY_DELAY: real A page 2 resolves after navigating to B; abort is deliberately ignored");
  await ownerSession(context);
  await holdSecondPage(page);
  await page.goto(`/books/${A}`);
  await expect(notesRegion(page).getByRole("article")).toHaveCount(20);
  await notesRegion(page).getByRole("button", { name: "加载更多", exact: true }).click();
  await waitForHeldPage(page);
  await page.getByRole("link", { name: `查看 ${TITLE_B} 详情`, exact: true }).click();
  await expect(notesRegion(page).getByRole("article")).toHaveCount(3);
  await releaseHeldPage(page);
  await expect(page).toHaveURL(`/books/${B}`);
  await expect(notesRegion(page).getByRole("article")).toHaveCount(3);
  await expect(notesRegion(page).getByText(A_TEXT)).toHaveCount(0);
});

test("sign-out clears mounted book records and a synthetically delayed response cannot restore them", async ({ page, context }, testInfo) => {
  await evidence(testInfo, "SYNTHETIC_DELIVERY_DELAY + production signOut action while book is mounted; existing library journey covers the account logout button");
  await ownerSession(context);
  await holdSecondPage(page);
  await page.goto(`/books/${A}`);
  await expect(notesRegion(page).getByRole("article")).toHaveCount(20);
  await notesRegion(page).getByRole("button", { name: "加载更多", exact: true }).click();
  await waitForHeldPage(page);
  const signedOut = page.waitForResponse(response => new URL(response.url()).pathname === "/api/auth/logout" && response.request().method() === "POST");
  await page.evaluate(async () => {
    const sessionModule = "/src/auth/session.ts";
    await (await import(sessionModule)).signOut();
  });
  expect((await signedOut).status()).toBe(204);
  await expect(page.getByRole("heading", { name: LOGIN_TITLE })).toBeVisible();
  await expect(notesRegion(page)).toHaveCount(0);
  await releaseHeldPage(page);
  await expect(page.getByText(A_TEXT)).toHaveCount(0);
  await expect(page.getByText(B_TEXT)).toHaveCount(0);
  await expect(notesRegion(page)).toHaveCount(0);
  expect((await page.request.get(`/api/private/weread/notes?catalogId=${A}`)).status()).toBe(401);
  await page.screenshot({ path: testInfo.outputPath("weread-signout-cleared.png"), fullPage: true });
});
