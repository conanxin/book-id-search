/** Real browser/HTTP/Google session/PG; deterministic provider HTTP, no live model. */
import { createRequire } from "node:module";
import { expect, test } from "@playwright/test";
import { issueWebSession } from "../apps/api/src/auth/web-session.js";
import type { BookWebResearchResponse } from "../apps/api/src/ai/book-web-research.js";
import { createPostgresBookLibraryStore } from "../apps/api/src/s32/postgres/book-library-store.js";
import { getBookBrowserCatalogIds, getBookWebResearchBrowserFixtureKey } from "./book-browser-fixtures.js";

const WEB = "http://127.0.0.1:5173";
const fixtureKey = getBookWebResearchBrowserFixtureKey(process.env.BOOK_LIBRARY_BROWSER_RUN_ID!);
const { A } = getBookBrowserCatalogIds(fixtureKey);
const INTRO = "我的原始介绍：这是个人保存的文字，不应变成公开搜索词。";
const NOTE = "我的原始笔记：山口与旧驿站的位置待核对，不应作为网页材料。";
const TITLE = `联网研究验证甲 ${fixtureKey}`;
const apiRequire = createRequire(new URL("../apps/api/package.json", import.meta.url));
const { Pool } = apiRequire("pg");
const workspacePath = `/api/private/s32/library/books/${A}`;
const researchPath = `/api/ai/books/${A}/research`;

async function persisted() {
  const pool = new Pool({ connectionString: process.env.S32_LIBRARY_TEST_DATABASE_URL });
  try { return await createPostgresBookLibraryStore(pool).get(A); }
  finally { await pool.end(); }
}

test("web research exposes actual search trace and external excerpts while preserving personal content on desktop and mobile", async ({ page, context }, testInfo) => {
  const { token } = issueWebSession({ sub: "book-library-test-owner", name: "合成验证账号", email: "library-test@example.test" }, {
    secret: "book-library-synthetic-session-secret-for-local-ci-only",
  });
  await context.addCookies([{ name: "book_id_search_session_dev", value: token, url: WEB, httpOnly: true, sameSite: "Lax" }]);
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: WEB });
  expect(await persisted()).toBeNull();
  const session = await (await page.request.get("/api/auth/session")).json();
  const headers = { Origin: WEB, "X-CSRF-Token": session.csrfToken };
  expect((await page.request.put(workspacePath, { headers, data: { introduction: INTRO, baseVersion: 0 } })).ok()).toBe(true);
  expect((await page.request.post(`${workspacePath}/notes`, { headers, data: { title: "私人阅读笔记", content: NOTE } })).ok()).toBe(true);
  const before = await persisted();
  const writes: string[] = [], pageErrors: string[] = [], sourcePageReads: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/private/s32/library/") && ["POST", "PUT", "PATCH", "DELETE"].includes(request.method())) writes.push(`${request.method()} ${url.pathname}`);
    if (url.hostname === "example.org") sourcePageReads.push(request.url());
  });
  await page.goto(`/books/${A}`);
  await expect(page.getByRole("heading", { name: TITLE, exact: true })).toBeVisible();
  const pane = page.getByRole("complementary", { name: "本书 AI 助手", exact: true });
  const introRegion = page.getByRole("region", { name: "我的补充介绍", exact: true });
  await introRegion.getByRole("button", { name: "编辑介绍", exact: true }).click();
  const introEditor = introRegion.getByRole("textbox", { name: "书籍介绍", exact: true });
  const pendingIntro = `${INTRO}\n尚未保存：下次核对版本。`;
  await introEditor.fill(pendingIntro);
  await page.getByRole("article", { name: "笔记：私人阅读笔记", exact: true }).getByRole("button", { name: "编辑笔记", exact: true }).click();
  const noteForm = page.getByRole("form", { name: "编辑笔记", exact: true });
  const noteEditor = noteForm.getByRole("textbox", { name: "笔记正文", exact: true });
  const pendingNote = `${NOTE}\n尚未保存：先读完附录。`;
  await noteEditor.fill(pendingNote);

  const question = "查找本书的公开资料与研究方法";
  async function research() {
    await pane.getByRole("button", { name: "联网研究", exact: true }).click();
    await pane.getByRole("textbox", { name: "联网研究问题", exact: true }).fill(question);
    const pending = page.waitForResponse(response => new URL(response.url()).pathname === researchPath && response.request().method() === "POST");
    await pane.getByRole("button", { name: "联网查资料", exact: true }).click();
    const response = await pending;
    expect(response.ok()).toBe(true);
    expect(response.request().postDataJSON()).toEqual({ question });
    const value = await response.json() as BookWebResearchResponse;
    expect(value).toMatchObject({ bookId: A, question, mode: "source_excerpts", source: "web_research", search: { performed: true, calls: 1 } });
    expect(value.search.queries).toEqual([`${TITLE} ${question}`]);
    expect(value.sources).toHaveLength(2);
    for (const forbidden of [INTRO, NOTE, pendingIntro, pendingNote, "这段生成文字不是来源"]) expect(JSON.stringify(value)).not.toContain(forbidden);
    const resultRegion = pane.getByRole("region", { name: "联网研究结果", exact: true });
    await expect(resultRegion).toBeVisible();
    for (const source of value.sources) {
      expect(value.citedSourceIds).toContain(source.id);
      expect(value.draft.content).toContain(`[${source.id}]`);
      const excerpt = resultRegion.locator(`[data-web-excerpt-source-id="${source.id}"] blockquote`);
      expect(await excerpt.textContent()).toBe(source.excerpt);
      await pane.getByRole("button", { name: `查看网页依据 ${source.id}`, exact: true }).click();
      const row = pane.locator(`[data-web-source-id="${source.id}"]`);
      await expect(row).toBeVisible();
      await expect(row.getByRole("link", { name: `[${source.id}] ${source.title}`, exact: true })).toHaveAttribute("href", source.url);
      await expect(row).toContainText(source.excerpt);
      await expect(row).toContainText("搜索结果节选");
    }
    return value;
  }

  const result = await research();
  await pane.getByRole("button", { name: "复制结果与来源", exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain(result.generatedAt);
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain(result.question);
  for (const source of result.sources) {
    expect(copied).toContain(source.url);
    expect(copied).toContain(source.excerpt);
  }
  expect(copied).toContain("1935年初版");
  expect(copied).toContain("最早于1937年出版");
  expect(copied).not.toContain("1937年再版");
  await expect(introEditor).toHaveValue(pendingIntro);
  await expect(noteEditor).toHaveValue(pendingNote);
  expect(await persisted()).toEqual(before);
  expect(writes).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("web-research-desktop.png"), fullPage: true });

  await pane.getByRole("button", { name: "清除结果", exact: true }).click();
  await expect(pane.getByRole("region", { name: "联网研究结果", exact: true })).toHaveCount(0);
  await pane.getByRole("button", { name: "本书资料", exact: true }).click();
  await expect(pane.getByRole("button", { name: "生成参考介绍", exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "打开 AI 助手", exact: true }).click();
  await research();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("web-research-mobile.png"), fullPage: true });
  await page.getByRole("button", { name: "关闭 AI 助手", exact: true }).click();
  await expect(introEditor).toHaveValue(pendingIntro);
  await expect(noteEditor).toHaveValue(pendingNote);
  expect(await persisted()).toEqual(before);
  expect(writes).toEqual([]); expect(pageErrors).toEqual([]); expect(sourcePageReads).toEqual([]);
  await testInfo.attach("web-research-evidence.json", { contentType: "application/json", body: JSON.stringify({
    task_id: "BOOK_AI_WEB_RESEARCH_V1", provider: "INJECTED_HTTP_AND_ID_SELECTION_NO_LIVE_MODEL",
    output_mode: "source_excerpts", excerpt_text: "EXACT_SERVER_SNAPSHOTS", version_conflict: "PRESERVED_WITHOUT_INVENTED_EDITION_SEQUENCE",
    search_trace: "REAL_PRODUCTION_ADAPTER_PARSED_SYNTHETIC_TOOL_RESULTS", auth: "SIGNED_SYNTHETIC_OWNER_AND_REAL_CSRF",
    library_writes: writes.length, persistence: "REAL_POSTGRESQL_UNCHANGED", unsaved_editors: "PRESERVED",
    desktop_width: 1440, mobile_width: 390, page_errors: pageErrors, source_pages_fetched: sourcePageReads.length,
    real_google_oauth: "NOT_EXERCISED", real_minimax: "NOT_EXERCISED",
  }, null, 2) });
});
