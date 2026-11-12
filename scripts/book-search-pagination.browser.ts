import { expect, test } from "@playwright/test";
import type { Book, SearchResponse } from "../apps/web/src/api.js";

const BROAD = "江绍原";
const NARROW = "精确书名";
const EMPTY = "空结果";
const CAP = 1000;

function fixture(query: string, page: number, limit: number): SearchResponse {
  const total = query === BROAD ? 36730 : query === NARROW ? 3 : 0;
  const start = (page - 1) * limit;
  const count = Math.max(0, Math.min(limit, Math.min(total, CAP) - start));
  const items: Book[] = Array.from({ length: count }, (_, i) => {
    const ordinal = start + i + 1;
    return {
      id: `${query}-${ordinal}`,
      ssid: String(10000000 + ordinal),
      dxid: String(100000000000 + ordinal),
      title: `${query} · 第 ${ordinal} 本`,
      author: "合成分页作者",
      publisher: "合成分页出版社",
      year: 1989,
      pages: 124,
      isbn: "",
      rawInfo: "",
      parseStatus: "ok",
      parseWarnings: [],
    };
  });
  return { query, total, page, limit, items };
}

test("public search respects its browse boundary and restores query navigation on desktop and mobile", async ({ page }, testInfo) => {
  const requests: Array<{ query: string; page: number; limit: number }> = [];
  const unexpectedApi: string[] = [];
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/auth/session") {
      await route.fulfill({ json: { authenticated: false } });
    } else if (url.pathname === "/api/stats") {
      await route.fulfill({ json: {
        indexName: "books-pagination-fixture", numberOfDocuments: 2000,
        isIndexing: false, lastImportReport: null, parseQualityReport: null,
      } });
    } else if (url.pathname === "/api/search") {
      const request = {
        query: url.searchParams.get("q") ?? "",
        page: Number(url.searchParams.get("page") ?? 1),
        limit: Number(url.searchParams.get("limit") ?? 20),
      };
      requests.push(request);
      await route.fulfill({ json: fixture(request.query, request.page, request.limit) });
    } else {
      unexpectedApi.push(`${route.request().method()} ${url.pathname}`);
      await route.fulfill({ status: 404, json: { error: { message: "Unexpected test API request" } } });
    }
  });

  const input = page.getByRole("textbox", { name: "搜索关键词", exact: true });
  const pager = page.getByRole("navigation", { name: "分页", exact: true });
  const cards = page.locator(".card-list .book-card");
  const urlFor = (query: string, number: number) => `/?${new URLSearchParams({ q: query, page: String(number) })}`;
  async function expectResult(query: string, number: number, count = 20) {
    await expect.poll(() => new URL(page.url()).searchParams.get("q")).toBe(query);
    await expect.poll(() => new URL(page.url()).searchParams.get("page")).toBe(String(number));
    await expect(input).toHaveValue(query);
    await expect(cards).toHaveCount(count);
    if (count) await expect(cards.first().getByRole("heading")).toHaveText(`${query} · 第 ${(number - 1) * 20 + 1} 本`);
    await expect(page.getByText("搜索中", { exact: true })).toHaveCount(0);
  }

  await page.clock.install({ time: new Date("2026-11-12T00:00:00Z") });
  await page.goto(urlFor(BROAD, 1));
  await expectResult(BROAD, 1);
  await expect(page.locator(".results__count")).toContainText("36,730");
  await expect(page.locator(".results__browse-note")).toContainText("1,000");
  await expect(pager.getByRole("button", { name: "首页", exact: true })).toBeDisabled();
  await expect(pager.getByRole("button", { name: "上一页", exact: true })).toBeDisabled();
  await pager.getByRole("button", { name: "下一页", exact: true }).click();
  await expectResult(BROAD, 2);

  // Back must discard an uncommitted draft even when only the page changes.
  // Hold the debounce clock so this race does not depend on machine speed.
  await page.clock.pauseAt(new Date("2026-11-12T01:00:00Z"));
  await input.fill(NARROW);
  await page.clock.runFor(299);
  await expect(input).toHaveValue(NARROW);
  expect(new URL(page.url()).searchParams.get("q")).toBe(BROAD);
  expect(new URL(page.url()).searchParams.get("page")).toBe("2");
  expect(requests.filter(r => r.query === NARROW)).toHaveLength(0);
  await page.goBack();
  await expectResult(BROAD, 1);
  await page.clock.runFor(301);
  await expectResult(BROAD, 1);
  expect(requests.filter(r => r.query === NARROW)).toHaveLength(0);
  await page.clock.resume();

  await pager.getByRole("button", { name: "末页", exact: true }).click();
  await expectResult(BROAD, 50);
  await expect(pager.locator(".pager__current")).toHaveText("第 50 / 50 页");
  await expect(pager.getByRole("button", { name: "下一页", exact: true })).toBeDisabled();
  await expect(pager.getByRole("button", { name: "末页", exact: true })).toBeDisabled();
  await input.blur();
  await page.keyboard.press("ArrowRight");
  await expectResult(BROAD, 50);
  await page.keyboard.press("ArrowLeft");
  await expectResult(BROAD, 49);
  await page.keyboard.press("ArrowRight");
  await expectResult(BROAD, 50);

  await page.goto(urlFor(BROAD, 51));
  await expectResult(BROAD, 51, 0);
  const returnToLast = page.getByRole("button", { name: "返回第 50 页", exact: true });
  await expect(returnToLast).toBeVisible();
  await expect(page.getByText("没有找到匹配", { exact: false })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("pagination-desktop.png"), fullPage: true });
  await returnToLast.click();
  await expectResult(BROAD, 50);

  // Typing a narrower query is an automatic search, without pressing Enter.
  await input.fill(NARROW);
  await expectResult(NARROW, 1, 3);
  await expect(pager).toHaveCount(0);
  await page.goBack();
  await expectResult(BROAD, 50);
  await page.goForward();
  await expectResult(NARROW, 1, 3);

  await input.fill(EMPTY);
  await expectResult(EMPTY, 1, 0);
  await expect(page.getByText(`没有找到匹配“${EMPTY}”的图书。`, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /返回第 .* 页/ })).toHaveCount(0);
  await expect(page.locator(".results__browse-note")).toHaveCount(0);

  // Explicit submission commits the newly typed query, not an older request.
  await input.fill(BROAD);
  await input.press("Enter");
  await expectResult(BROAD, 1);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(urlFor(BROAD, 51));
  await expectResult(BROAD, 51, 0);
  await expect(page.locator(".results__browse-note")).toBeVisible();
  await expect(returnToLast).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("pagination-mobile.png"), fullPage: true });
  await returnToLast.click();
  await expectResult(BROAD, 50);
  await expect(pager.getByRole("button", { name: "下一页", exact: true })).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await input.fill(EMPTY);
  await expectResult(EMPTY, 1, 0);
  await expect(page.getByText(`没有找到匹配“${EMPTY}”的图书。`, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /返回第 .* 页/ })).toHaveCount(0);

  // Only the two intentional deep-link visits may request a page beyond 50.
  expect(requests.filter(r => r.query === BROAD && r.page > 50).map(r => r.page)).toEqual([51, 51]);
  expect(requests.filter(r => r.query === NARROW).every(r => r.page === 1)).toBe(true);
  expect(unexpectedApi).toEqual([]);
  expect(pageErrors).toEqual([]);
  await testInfo.attach("pagination-evidence.json", {
    contentType: "application/json",
    body: JSON.stringify({
      task_id: "BOOK_SEARCH_PAGINATION_R5",
      frontend: "BUILT_WEB_PREVIEW",
      backend: "SYNTHETIC_PUBLIC_SEARCH_RESPONSES",
      requests, unexpected_api: unexpectedApi, page_errors: pageErrors,
      desktop_width: 1440, mobile_width: 390,
      real_google_oauth: "NOT_EXERCISED", real_meilisearch: "NOT_EXERCISED",
    }, null, 2),
  });
});
