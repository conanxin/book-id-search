/** Real browser/HTTP/Google session/PG; deterministic provider HTTP, no live model. */
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
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
const sourcePath = `${researchPath}/source`;
const evidencePath = `${sourcePath}/evidence`;

async function persisted() {
  const pool = new Pool({ connectionString: process.env.S32_LIBRARY_TEST_DATABASE_URL });
  try { return await createPostgresBookLibraryStore(pool).get(A); }
  finally { await pool.end(); }
}

test("web research, webpage reading and original evidence preserve personal content on desktop and mobile", async ({ page, context }, testInfo) => {
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
  const writes: string[] = [], pageErrors: string[] = [], sourcePageReads: string[] = [], readerRequests: unknown[] = [], evidenceRequests: unknown[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/private/s32/library/") && ["POST", "PUT", "PATCH", "DELETE"].includes(request.method())) writes.push(`${request.method()} ${url.pathname}`);
    if (url.hostname === "example.org") sourcePageReads.push(request.url());
    if (url.pathname === sourcePath && request.method() === "POST") readerRequests.push(request.postDataJSON());
    if (url.pathname === evidencePath && request.method() === "POST") evidenceRequests.push(request.postDataJSON());
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
      const excerpt = resultRegion.locator(`[data-web-excerpt-source-id="${source.id}"] > blockquote.book-web-excerpt`);
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
  expect(readerRequests).toEqual([]);
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

  async function readFirstSource(value: BookWebResearchResponse) {
    const source = value.sources[0];
    expect(source.readToken).toEqual(expect.any(String));
    const pending = page.waitForResponse(response => new URL(response.url()).pathname === sourcePath && response.request().method() === "POST");
    await pane.getByRole("button", { name: `读取网页正文 ${source.id}`, exact: true }).click();
    const response = await pending;
    expect(response.ok()).toBe(true);
    expect(response.request().postDataJSON()).toEqual({ sourceToken: source.readToken });
    const body = await response.json();
    expect(body).toMatchObject({ bookId: A, sourceId: source.id, requestedUrl: source.url,
      finalUrl: `${source.url}?view=full`, extraction: "html_readable_text", truncated: true });
    expect(body.text).toContain("这段正文只存在于网页读取响应，不在搜索节选中。");
    expect(body.text).toContain("字面文字 <img src=x> 保持纯文本。");
    expect(body.text).not.toContain("不应提取");
    const reader = pane.getByRole("region", { name: `网页可读文字 ${source.id}`, exact: true });
    await expect(reader).toBeVisible();
    expect(await reader.locator("blockquote.book-web-page-text").textContent()).toBe(body.text);
    expect(body.snapshotToken).toMatch(/^[A-Za-z0-9_-]{32}$/);
    await expect(reader).toContainText("本次提取已截短");
    await expect(reader.locator("img")).toHaveCount(0);
    await expect(reader.getByRole("link", { name: `查看已读取网页 ${source.id}`, exact: true })).toHaveAttribute("href", body.finalUrl);
    await reader.getByRole("button", { name: `展开网页文字 ${source.id}`, exact: true }).click();
    await expect(reader.getByRole("button", { name: `收起网页文字 ${source.id}`, exact: true })).toHaveAttribute("aria-expanded", "true");
    await reader.getByRole("button", { name: `收起网页文字 ${source.id}`, exact: true }).click();
    await reader.getByRole("button", { name: `复制网页文字与来源 ${source.id}`, exact: true }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain(body.text);
    const bodyCopy = await page.evaluate(() => navigator.clipboard.readText());
    for (const provenance of [source.url, body.finalUrl, body.fetchedAt, `[${source.id}]`]) expect(bodyCopy).toContain(provenance);
    await pane.getByRole("button", { name: "复制结果与来源", exact: true }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(copied.replace(result.generatedAt, value.generatedAt));
    return body;
  }
  async function findSourceEvidence(body: Awaited<ReturnType<typeof readFirstSource>>) {
    const sourceId = body.sourceId;
    const input = pane.getByRole("textbox", { name: `原文依据问题 ${sourceId}`, exact: true });
    await expect(input).toHaveValue(question);
    const evidenceQuestion = "这些记录对出版年份分别怎么说？";
    await input.fill(evidenceQuestion);
    const pending = page.waitForResponse(response => new URL(response.url()).pathname === evidencePath && response.request().method() === "POST");
    await pane.getByRole("button", { name: `查找原文依据 ${sourceId}`, exact: true }).click();
    const response = await pending;
    expect(response.ok()).toBe(true);
    expect(response.request().postDataJSON()).toEqual({ snapshotToken: body.snapshotToken, question: evidenceQuestion });
    const value = await response.json();
    expect(value).toMatchObject({
      bookId: A, sourceId, snapshotToken: body.snapshotToken, question: evidenceQuestion,
      mode: "source_passages", status: "selected", requestedUrl: body.requestedUrl,
      finalUrl: body.finalUrl, title: body.title, fetchedAt: body.fetchedAt, sourceTruncated: true,
    });
    expect(value.passages).toHaveLength(2);
    const evidenceRegion = pane.getByRole("region", { name: `原文依据 ${sourceId}`, exact: true });
    await expect(evidenceRegion).toBeVisible();
    const quoteText = value.passages.map((passage: { text: string }) => passage.text).join("\n");
    expect(quoteText).toContain("1935年初版");
    expect(quoteText).toContain("最早于1937年出版");
    expect(quoteText).not.toContain("1937年再版");
    let lastEnd = 0;
    for (const passage of value.passages) {
      expect(passage.start).toBeGreaterThanOrEqual(lastEnd);
      expect(passage.end - passage.start).toBeLessThanOrEqual(1200);
      expect(passage.text).toBe(body.text.slice(passage.start, passage.end));
      expect(await evidenceRegion.locator(`[data-evidence-passage-id="${passage.id}"] blockquote`).textContent()).toBe(passage.text);
      await evidenceRegion.getByRole("button", { name: `在网页正文中定位 ${passage.id} ${sourceId}`, exact: true }).click();
      const reader = pane.getByRole("region", { name: `网页可读文字 ${sourceId}`, exact: true });
      await expect(reader.locator(`[data-web-source-highlight="${passage.id}"]`)).toHaveText(passage.text);
      expect(await reader.locator("blockquote.book-web-page-text").textContent()).toBe(body.text);
      lastEnd = passage.end;
    }
    await evidenceRegion.getByRole("button", { name: `复制原文依据与来源 ${sourceId}`, exact: true }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain(evidenceQuestion);
    const evidenceCopy = await page.evaluate(() => navigator.clipboard.readText());
    for (const provenance of [body.requestedUrl, body.finalUrl, body.fetchedAt, `[${sourceId}]`]) expect(evidenceCopy).toContain(provenance);
    for (const passage of value.passages) expect(evidenceCopy).toContain(passage.text);
    for (const forbidden of [body.snapshotToken, INTRO, NOTE, pendingIntro, pendingNote, "1937年再版"]) expect(evidenceCopy).not.toContain(forbidden);
    await expect(introEditor).toHaveValue(pendingIntro);
    await expect(noteEditor).toHaveValue(pendingNote);
    return value;
  }
  const readBody = await readFirstSource(result);
  expect(evidenceRequests).toEqual([]);
  const desktopEvidence = await findSourceEvidence(readBody);
  const second = result.sources[1];
  const failed = page.waitForResponse(response => new URL(response.url()).pathname === sourcePath && response.request().method() === "POST");
  await pane.getByRole("button", { name: `读取网页正文 ${second.id}`, exact: true }).click();
  const failureResponse = await failed;
  expect(failureResponse.status()).toBe(502);
  expect((await failureResponse.json()).error.code).toBe("BOOK_SOURCE_UNAVAILABLE");
  await expect(pane.locator(`[data-web-reader-source-id="${second.id}"]`)).toContainText("未提取网页文字，搜索节选仍保留");
  await expect(pane.locator(`[data-web-excerpt-source-id="${second.id}"] > blockquote.book-web-excerpt`)).toHaveText(second.excerpt);
  await expect(introEditor).toHaveValue(pendingIntro);
  await expect(noteEditor).toHaveValue(pendingNote);
  expect(await persisted()).toEqual(before);
  expect(writes).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  expect(await pane.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await pane.getByRole("region", { name: "网页可读文字 W1", exact: true }).getByText("网页可读文字（自动提取）", { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("web-research-desktop.png"), fullPage: true });

  // Editing the question immediately clears old selections and does not call the model.
  const evidenceInput = pane.getByRole("textbox", { name: "原文依据问题 W1", exact: true });
  await evidenceInput.fill("网页是否提供 ISBN？");
  expect(evidenceRequests).toHaveLength(1);
  await expect(pane.locator("[data-evidence-passage-id]")).toHaveCount(0);
  await expect(pane.locator("[data-web-source-highlight]")).toHaveCount(0);
  const emptyPending = page.waitForResponse(response => new URL(response.url()).pathname === evidencePath && response.request().method() === "POST");
  await pane.getByRole("button", { name: "查找原文依据 W1", exact: true }).click();
  const emptyResponse = await emptyPending;
  expect(emptyResponse.ok()).toBe(true);
  expect(await emptyResponse.json()).toMatchObject({ status: "insufficient_evidence", passages: [] });
  await expect(pane.getByRole("region", { name: "原文依据 W1", exact: true })).toContainText("未找到足够相关的原文");
  expect(await pane.locator("blockquote.book-web-page-text").textContent()).toBe(readBody.text);

  // A new search can reuse W1, but must never reuse the previous page text/token.
  const refreshed = await research();
  expect(refreshed.sources[0].readToken).not.toBe(result.sources[0].readToken);
  await expect(pane.getByRole("region", { name: "网页可读文字 W1", exact: true })).toHaveCount(0);
  expect(readerRequests).toHaveLength(2);

  await pane.getByRole("button", { name: "清除结果", exact: true }).click();
  await expect(pane.getByRole("region", { name: "联网研究结果", exact: true })).toHaveCount(0);
  await pane.getByRole("button", { name: "本书资料", exact: true }).click();
  await expect(pane.getByRole("button", { name: "生成参考介绍", exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "打开 AI 助手", exact: true }).click();
  const mobileResult = await research();
  const mobileBody = await readFirstSource(mobileResult);
  expect(evidenceRequests).toHaveLength(2);
  await findSourceEvidence(mobileBody);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  expect(await pane.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await pane.getByRole("region", { name: "网页可读文字 W1", exact: true }).getByText("网页可读文字（自动提取）", { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("web-research-mobile.png"), fullPage: true });
  await page.getByRole("button", { name: "关闭 AI 助手", exact: true }).click();
  await expect(introEditor).toHaveValue(pendingIntro);
  await expect(noteEditor).toHaveValue(pendingNote);
  expect(await persisted()).toEqual(before);
  expect(writes).toEqual([]); expect(pageErrors).toEqual([]); expect(sourcePageReads).toEqual([]);
  expect(readerRequests).toHaveLength(3);
  expect(evidenceRequests).toHaveLength(3);
  const evidence = {
    task_id: "BOOK_AI_WEB_SOURCE_EVIDENCE_V1", provider: "INJECTED_HTTP_AND_ID_SELECTION_NO_LIVE_MODEL",
    output_mode: "source_excerpts", excerpt_text: "EXACT_SERVER_SNAPSHOTS", version_conflict: "PRESERVED_WITHOUT_INVENTED_EDITION_SEQUENCE",
    search_trace: "REAL_PRODUCTION_ADAPTER_PARSED_SYNTHETIC_TOOL_RESULTS", auth: "SIGNED_SYNTHETIC_OWNER_AND_REAL_CSRF",
    library_writes: writes.length, persistence: "REAL_POSTGRESQL_UNCHANGED", unsaved_editors: "PRESERVED",
    desktop_width: 1440, mobile_width: 390, page_errors: pageErrors, source_pages_fetched: sourcePageReads.length,
    reader: { requests: readerRequests.length, transport: "INJECTED_PUBLIC_HTML_NO_NETWORK", extractor: "PRODUCTION",
      explicit_only: true, text_characters: readBody.text.length, truncated: readBody.truncated,
      failed_source_retains_excerpt: true, refreshed_result_clears_body: true, separate_provenance_copy: true },
    source_evidence: { requests: evidenceRequests.length, mode: desktopEvidence.mode,
      exact_snapshot_quotes: true, question_change_clears_result: true, insufficient_evidence: true,
      context_location: "EXACT_OFFSETS_IN_UNCHANGED_BODY", separate_provenance_copy: true,
      transport: "REAL_HTTP_CSRF_AND_PRODUCTION_SERVICE_WITH_INJECTED_ID_ONLY_PROVIDER" },
    real_google_oauth: "NOT_EXERCISED", real_minimax: "NOT_EXERCISED",
  };
  const evidenceFile = testInfo.outputPath("web-research-evidence.json");
  writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2));
  await testInfo.attach("web-research-evidence.json", { contentType: "application/json", path: evidenceFile });
});
