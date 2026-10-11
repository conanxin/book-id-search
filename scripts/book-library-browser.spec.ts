/**
 * Real Chromium → Vite → production auth/library router → real PostgreSQL.
 * Catalog records are synthetic. Related-book collection uses the production
 * implementation with an in-memory search adapter. The session is signed with
 * the real session implementation; actual Google OAuth and Meili are untested.
 */
import { createRequire } from "node:module";
import { expect, test, type Page } from "@playwright/test";
import { issueWebSession } from "../apps/api/src/auth/web-session.js";
import { getBookBrowserCatalogIds } from "./book-browser-fixtures.js";

const WEB = "http://127.0.0.1:5173";
const runId = process.env.BOOK_LIBRARY_BROWSER_RUN_ID!;
const { A, B } = getBookBrowserCatalogIds(runId);
const TITLE_A = `古道阅读验证甲 ${runId}`, TITLE_B = `古道阅读验证乙 ${runId}`;
const LOGIN_TITLE = "登录后，继续整理这本书与阅读资料";
const INTRODUCTION = "这是一段持久保存的私人书籍介绍：古道的地理线索与历史沿革。";
const NOTE_SEARCH_TERM = `笔记独有石阶线索-${runId}`;
const FIRST_NOTE_CONTENT = `第一篇笔记的私人正文。${NOTE_SEARCH_TERM}。待下次踏查核对。`;
const RESOURCE_URL = "https://example.test/ebook.pdf";
const apiRequire = createRequire(new URL("../apps/api/package.json", import.meta.url));
const { Pool } = apiRequire("pg");
const db = new Pool({ connectionString: process.env.S32_LIBRARY_TEST_DATABASE_URL });
test.afterAll(async () => { await db.end(); });

async function save(page: Page, method: string, suffix: string, button: string) {
  const response = page.waitForResponse(value => value.request().method() === method
    && new URL(value.url()).pathname.endsWith(suffix));
  await page.getByRole("button", { name: button, exact: true }).click();
  const result = await response;
  expect(result.ok()).toBe(true);
  return result.json();
}

test("anonymous catalog search works and every private entry requires Google", async ({ page, request }) => {
  await page.goto("/");
  await page.getByPlaceholder("搜索书名、作者、出版社、ISBN、SSID、DXID").fill("古道阅读验证");
  await page.getByRole("button", { name: "开始搜索" }).click();
  await expect(page.getByRole("link", { name: `查看 ${TITLE_A} 详情`, exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: `查看 ${TITLE_B} 详情`, exact: true })).toBeVisible();
  await page.getByRole("link", { name: `查看 ${TITLE_A} 详情`, exact: true }).click();
  await expect(page).toHaveURL(`/books/${A}`);
  await expect(page.getByRole("heading", { name: LOGIN_TITLE })).toBeVisible();
  await expect(page.getByRole("button", { name: "补充介绍" })).toHaveCount(0);
  for (const path of [`/api/books/${A}`, `/api/books/${A}/related`, "/api/private/s32/library", "/api/ai/status"]) {
    expect((await request.get(path)).status()).toBe(401);
  }
  expect((await request.get("/api/private/s32/library", { headers: { Authorization: "Bearer fake-legacy-token" } })).status()).toBe(401);
  const rows = await db.query("SELECT count(*)::int AS n FROM core.library_books WHERE catalog_book_id = ANY($1::text[])", [[A, B]]);
  expect(rows.rows[0].n).toBe(0);
});

test("signed owner session saves introduction, notes and resource through the UI; refresh, revisit, edits and logout", async ({ page, context }, testInfo) => {
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await testInfo.attach("verification-scope.json", {
    body: JSON.stringify({ catalog: "two synthetic books", relatedBooks: "production collector + synthetic field-search adapter",
      savedContentSearch: "production PostgreSQL list + browser note-fragment navigation",
      actualMeilisearch: "NOT_EXERCISED", persistence: "real PostgreSQL", role: "s32_app",
      authentication: "real signed session + CSRF", actualGoogleOAuth: "NOT_EXERCISED" }, null, 2),
    contentType: "application/json",
  });
  await page.goto(`/books/${A}`);
  await page.getByRole("link", { name: "使用 Google 登录", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/account\\?returnTo=`));
  const { token } = issueWebSession({ sub: "book-library-test-owner", name: "合成验证账号", email: "library-test@example.test" }, {
    secret: "book-library-synthetic-session-secret-for-local-ci-only",
  });
  await context.addCookies([{ name: "book_id_search_session_dev", value: token, url: WEB, httpOnly: true, sameSite: "Lax" }]);
  const initialRelated = page.waitForResponse(response => new URL(response.url()).pathname === `/api/books/${A}/related`);
  await page.reload();
  await expect(page).toHaveURL(`/books/${A}`);
  await expect(page.getByRole("heading", { name: TITLE_A, exact: true })).toBeVisible();
  expect(await (await initialRelated).json()).toMatchObject({
    sourceBookId: A, total: 1, partial: false, unavailableFields: [],
    items: [{ id: B, relations: expect.arrayContaining([{ kind: "same_isbn", label: "ISBN 相同" }]) }],
  });
  const related = page.locator("#related-books");
  const relatedBookB = related.getByRole("link", { name: `查看 ${TITLE_B} 详情`, exact: true });
  await expect(relatedBookB).toBeVisible();
  await expect(related.getByText("ISBN 相同", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await related.screenshot({ path: testInfo.outputPath("book-related-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(relatedBookB).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await related.screenshot({ path: testInfo.outputPath("book-related-mobile.png") });
  await page.setViewportSize({ width: 1440, height: 1000 });

  const nextRelated = page.waitForResponse(response => new URL(response.url()).pathname === `/api/books/${B}/related`);
  await relatedBookB.click();
  await expect(page).toHaveURL(`/books/${B}`);
  await expect(page.getByRole("heading", { name: TITLE_B, exact: true })).toBeVisible();
  expect(await (await nextRelated).json()).toMatchObject({ sourceBookId: B, items: [{ id: A }] });
  await expect(related.getByRole("link", { name: `查看 ${TITLE_A} 详情`, exact: true })).toBeVisible();
  await expect(related.getByRole("link", { name: `查看 ${TITLE_B} 详情`, exact: true })).toHaveCount(0);
  const returningRelated = page.waitForResponse(response => new URL(response.url()).pathname === `/api/books/${A}/related`);
  await page.goBack();
  await expect(page).toHaveURL(`/books/${A}`);
  expect(await (await returningRelated).json()).toMatchObject({ sourceBookId: A, items: [{ id: B }] });
  await expect(page.getByRole("heading", { name: TITLE_A, exact: true })).toBeVisible();
  await expect(relatedBookB).toBeVisible();
  await expect(related.getByRole("link", { name: `查看 ${TITLE_A} 详情`, exact: true })).toHaveCount(0);
  const denied = await page.request.put(`/api/private/s32/library/books/${B}`, {
    headers: { Origin: WEB, "X-CSRF-Token": "invalid-test-csrf" }, data: { introduction: "must not save", baseVersion: 0 },
  });
  expect(denied.status()).toBe(403);
  expect((await db.query("SELECT count(*)::int AS n FROM core.library_books WHERE catalog_book_id = $1", [B])).rows[0].n).toBe(0);

  await page.getByRole("button", { name: "补充介绍", exact: true }).click();
  await page.getByRole("textbox", { name: "书籍介绍", exact: true }).fill(INTRODUCTION);
  const saved = await save(page, "PUT", `/library/books/${A}`, "保存介绍");
  expect(saved.item).toMatchObject({ bookId: A, saved: true, version: 1, introduction: INTRODUCTION });
  let firstNoteId = "";
  for (const [title, content] of [["第一篇阅读笔记", FIRST_NOTE_CONTENT], ["第二篇阅读笔记", "第二篇笔记的私人正文"]]) {
    await page.getByRole("button", { name: "写一篇笔记", exact: true }).click();
    await page.getByLabel("笔记标题", { exact: true }).fill(title);
    await page.getByRole("textbox", { name: "笔记正文", exact: true }).fill(content);
    const created = await save(page, "POST", `/library/books/${A}/notes`, "保存笔记");
    if (title === "第一篇阅读笔记") firstNoteId = created.item.notes[0].noteId;
    await expect(page.getByRole("article", { name: `笔记：${title}`, exact: true })).toBeVisible();
  }
  await page.getByRole("button", { name: "添加电子版链接", exact: true }).click();
  await page.getByLabel("资源名称", { exact: true }).fill("原版扫描本");
  await page.getByLabel("电子版链接", { exact: true }).fill(RESOURCE_URL);
  await page.getByLabel("版本说明（可选）", { exact: true }).fill("2001 年版");
  await page.getByRole("textbox", { name: "来源与备注（可选）", exact: true }).fill("仅登记外链");
  await save(page, "POST", `/library/books/${A}/resources`, "保存电子版链接");
  const resource = page.getByRole("article", { name: "电子版本：原版扫描本", exact: true });
  await expect(resource.getByRole("link", { name: "打开电子版本 ↗" })).toHaveAttribute("href", RESOURCE_URL);

  await page.reload();
  await expect(page.getByText(INTRODUCTION, { exact: true })).toBeVisible();
  await expect(page.getByRole("article", { name: /^笔记：/ })).toHaveCount(2);
  await expect(resource).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("book-workspace-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("button", { name: "编辑介绍" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("book-workspace-mobile.png"), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });

  await page.getByRole("navigation", { name: "主导航" }).getByRole("link", { name: "我的书籍", exact: true }).click();
  await expect(page.getByRole("heading", { name: "我的书籍", exact: true })).toBeVisible();
  await page.getByLabel("在我的书籍中查找", { exact: true }).fill(runId);
  const filteredCollection = page.waitForResponse(response => {
    const url = new URL(response.url());
    return response.request().method() === "GET"
      && /^\/api\/private\/s32\/library\/?$/.test(url.pathname)
      && url.searchParams.get("q") === runId;
  });
  await page.getByRole("button", { name: "查找", exact: true }).click();
  const filteredResponse = await filteredCollection;
  expect(filteredResponse.ok()).toBe(true);
  expect(await filteredResponse.json()).toMatchObject({ total: 1, items: [{ bookId: A }] });
  await expect(page.getByRole("status").filter({ hasText: /^当前筛选\s*·\s*1 本书$/ })).toBeVisible();
  // The preceding PG contracts also create saved books. Scope counts to the
  // exact fixture card instead of matching equal counts in the whole shelf.
  const savedBookCard = page.getByRole("article").filter({ has: page.getByRole("heading", { name: TITLE_A, exact: true }) });
  await expect(savedBookCard).toHaveCount(1);
  await expect(savedBookCard.getByText("2 篇笔记", { exact: true })).toBeVisible();
  await expect(savedBookCard.getByText("1 个电子版本", { exact: true })).toBeVisible();
  // The whole query appears only in this note's current body, not in catalog
  // metadata, its title or the introduction. Search uses the production PG list.
  await page.getByLabel("在我的书籍中查找", { exact: true }).fill(NOTE_SEARCH_TERM);
  const matchedCollection = page.waitForResponse(response => {
    const url = new URL(response.url());
    return response.request().method() === "GET"
      && /^\/api\/private\/s32\/library\/?$/.test(url.pathname)
      && url.searchParams.get("q") === NOTE_SEARCH_TERM;
  });
  await page.getByRole("button", { name: "查找", exact: true }).click();
  const matchedResponse = await matchedCollection;
  expect(matchedResponse.ok()).toBe(true);
  expect(await matchedResponse.json()).toMatchObject({ total: 1, items: [{
    bookId: A, searchMatch: { kind: "note", noteId: firstNoteId, noteTitle: "第一篇阅读笔记", excerpt: expect.stringContaining(NOTE_SEARCH_TERM) },
  }] });
  await expect(savedBookCard).toContainText(NOTE_SEARCH_TERM);
  const noteLink = savedBookCard.getByRole("link", { name: "查看这篇笔记", exact: true });
  const notePath = `/books/${A}#book-note-${firstNoteId}`;
  await expect(noteLink).toHaveAttribute("href", notePath);
  await savedBookCard.screenshot({ path: testInfo.outputPath("book-library-note-search.png") });
  await noteLink.click();
  const firstNote = page.getByRole("article", { name: "笔记：第一篇阅读笔记", exact: true });
  await expect(page).toHaveURL(notePath);
  await expect(firstNote).toBeFocused();
  await expect(firstNote).toBeInViewport();
  await page.reload();
  await expect(page).toHaveURL(notePath);
  await expect(firstNote).toBeFocused();
  await expect(firstNote).toBeInViewport();
  await firstNote.screenshot({ path: testInfo.outputPath("book-note-search-target.png") });
  await expect(page.getByText(INTRODUCTION, { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "编辑介绍", exact: true }).click();
  // A textarea's initial text is included by the wrapped-label text selector.
  // Its accessible textbox name stays "书籍介绍" when editing saved content.
  await page.getByRole("textbox", { name: "书籍介绍", exact: true }).fill(`${INTRODUCTION}\n补充后的版本。`);
  await save(page, "PUT", `/library/books/${A}`, "保存介绍");
  await firstNote.getByRole("button", { name: "编辑笔记", exact: true }).click();
  await page.getByRole("textbox", { name: "笔记正文", exact: true }).fill("第一篇笔记的修订正文");
  await save(page, "PUT", `/notes/${firstNoteId}`, "保存笔记");
  await firstNote.getByRole("button", { name: "查看历史版本（2）", exact: true }).click();
  await firstNote.getByRole("button", { name: "第 1 版", exact: true }).click();
  await expect(firstNote.getByRole("region", { name: "历史版本 1", exact: true }).getByText(FIRST_NOTE_CONTENT, { exact: true })).toBeVisible();

  await resource.getByRole("button", { name: "编辑链接", exact: true }).click();
  await page.getByLabel("资源名称", { exact: true }).fill("修订扫描本");
  const resourceId = (await db.query("SELECT resource_id FROM core.library_book_resources WHERE catalog_book_id = $1 AND removed_at IS NULL", [A])).rows[0].resource_id;
  await save(page, "PUT", `/resources/${resourceId}`, "保存电子版链接");
  await expect(page.getByRole("article", { name: "电子版本：修订扫描本", exact: true })).toBeVisible();
  const secondNote = page.getByRole("article", { name: "笔记：第二篇阅读笔记", exact: true });
  await secondNote.getByRole("button", { name: "删除笔记", exact: true }).click();
  await secondNote.getByRole("group", { name: "删除 第二篇阅读笔记", exact: true })
    .getByRole("button", { name: "确认删除笔记", exact: true }).click();
  await expect(secondNote).toHaveCount(0);
  await page.getByRole("article", { name: "电子版本：修订扫描本", exact: true }).getByRole("button", { name: "移除链接", exact: true }).click();
  await save(page, "DELETE", `/resources/${resourceId}`, "确认移除链接");
  await expect(page.getByRole("article", { name: /^电子版本：/ })).toHaveCount(0);

  const persisted = (await db.query(`SELECT b.introduction, b.version,
    (SELECT count(*)::int FROM core.library_book_notes bn JOIN core.notes n ON n.id = bn.note_id WHERE bn.catalog_book_id = b.catalog_book_id AND n.lifecycle_state = 'ACTIVE') AS notes,
    (SELECT count(*)::int FROM core.library_book_resources r WHERE r.catalog_book_id = b.catalog_book_id AND r.removed_at IS NULL) AS resources
    FROM core.library_books b WHERE b.catalog_book_id = $1`, [A])).rows[0];
  expect(persisted).toEqual({ introduction: `${INTRODUCTION}\n补充后的版本。`, version: 2, notes: 1, resources: 0 });
  expect((await db.query("SELECT count(*)::int AS n FROM core.source_assets WHERE id = $1", [resourceId])).rows[0].n).toBe(1);

  await page.goto("/account");
  const signedOut = page.waitForResponse(response => new URL(response.url()).pathname === "/api/auth/logout"
    && response.request().method() === "POST");
  await page.getByRole("region", { name: "Google 账号", exact: true })
    .getByRole("button", { name: "退出登录", exact: true }).click();
  await expect(page.getByTestId("google-login-authenticated")).toHaveCount(0);
  expect((await signedOut).status()).toBe(204);
  await page.goto(notePath);
  await expect(page.getByRole("heading", { name: LOGIN_TITLE })).toBeVisible();
  await expect(page.getByRole("link", { name: "使用 Google 登录", exact: true }))
    .toHaveAttribute("href", `/account?returnTo=${encodeURIComponent(notePath)}`);
  await expect(page.getByText(INTRODUCTION, { exact: false })).toHaveCount(0);
  await expect(page.getByRole("article", { name: /^笔记：/ })).toHaveCount(0);
  expect((await page.request.get(`/api/private/s32/library/books/${A}`)).status()).toBe(401);
  expect(pageErrors).toEqual([]);
});
