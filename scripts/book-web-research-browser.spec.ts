/** Real browser/HTTP/Google session/PG; deterministic provider HTTP, no live model. */
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { issueWebSession } from "../apps/api/src/auth/web-session.js";
import type { BookWebResearchResponse } from "../apps/api/src/ai/book-web-research.js";
import type { BookWebSourceResponse } from "../apps/api/src/ai/book-web-source-contract.js";
import type { BookWebSourceComparisonResponse } from "../apps/api/src/ai/book-web-source-comparison-contract.js";
import { createPostgresBookLibraryStore } from "../apps/api/src/s32/postgres/book-library-store.js";
import { getBookBrowserCatalogIds, getBookWebResearchBrowserFixtureKey, getBookWebSourceComparisonBrowserFixtureKey } from "./book-browser-fixtures.js";

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

async function persisted(bookId = A) {
  const pool = new Pool({ connectionString: process.env.S32_LIBRARY_TEST_DATABASE_URL });
  try { return await createPostgresBookLibraryStore(pool).get(bookId); }
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


test("multi-source original passages preserve distinct wording, selection scope and personal edits", async ({ page, context }, testInfo) => {
  const comparisonKey = getBookWebSourceComparisonBrowserFixtureKey(process.env.BOOK_LIBRARY_BROWSER_RUN_ID!);
  const { A: comparisonBook } = getBookBrowserCatalogIds(comparisonKey);
  const title = "多来源对照验证甲 " + comparisonKey;
  const workspace = "/api/private/s32/library/books/" + comparisonBook;
  const researchUrl = "/api/ai/books/" + comparisonBook + "/research";
  const readUrl = researchUrl + "/source";
  const compareUrl = researchUrl + "/sources/evidence";
  type Snapshot = BookWebSourceResponse & { snapshotToken: string };

  const { token } = issueWebSession({ sub: "book-library-test-owner", name: "合成验证账号", email: "library-test@example.test" }, {
    secret: "book-library-synthetic-session-secret-for-local-ci-only",
  });
  await context.addCookies([{ name: "book_id_search_session_dev", value: token, url: WEB, httpOnly: true, sameSite: "Lax" }]);
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: WEB });
  expect(await persisted(comparisonBook)).toBeNull();
  const session = await (await page.request.get("/api/auth/session")).json();
  const headers = { Origin: WEB, "X-CSRF-Token": session.csrfToken };
  expect((await page.request.put(workspace, { headers, data: { introduction: INTRO, baseVersion: 0 } })).ok()).toBe(true);
  expect((await page.request.post(workspace + "/notes", { headers, data: { title: "私人阅读笔记", content: NOTE } })).ok()).toBe(true);
  const before = await persisted(comparisonBook);
  const writes: string[] = [], pageErrors: string[] = [], externalSourceRequests: string[] = [];
  const comparisonRequests: unknown[] = [], readRequests: unknown[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/private/s32/library/") && ["POST", "PUT", "PATCH", "DELETE"].includes(request.method())) writes.push(request.method() + " " + url.pathname);
    if (url.hostname === "example.org") externalSourceRequests.push(request.url());
    if (url.pathname === compareUrl && request.method() === "POST") comparisonRequests.push(request.postDataJSON());
    if (url.pathname === readUrl && request.method() === "POST") readRequests.push(request.postDataJSON());
  });
  async function providerCalls() {
    const health = await (await page.request.get("/api/health")).json();
    return health.bookWebSourceComparison.providerCalls as number;
  }
  expect(await providerCalls()).toBe(0);
  await page.goto("/books/" + comparisonBook);
  await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
  const pane = page.getByRole("complementary", { name: "本书 AI 助手", exact: true });
  const introRegion = page.getByRole("region", { name: "我的补充介绍", exact: true });
  await introRegion.getByRole("button", { name: "编辑介绍", exact: true }).click();
  const introEditor = introRegion.getByRole("textbox", { name: "书籍介绍", exact: true });
  const pendingIntro = INTRO + "\n尚未保存：下次核对版本。";
  await introEditor.fill(pendingIntro);
  await page.getByRole("article", { name: "笔记：私人阅读笔记", exact: true }).getByRole("button", { name: "编辑笔记", exact: true }).click();
  const noteEditor = page.getByRole("form", { name: "编辑笔记", exact: true }).getByRole("textbox", { name: "笔记正文", exact: true });
  const pendingNote = NOTE + "\n尚未保存：先读完附录。";
  await noteEditor.fill(pendingNote);

  const searchQuestion = "查找可对照的公开版本资料";
  await pane.getByRole("button", { name: "联网研究", exact: true }).click();
  await pane.getByRole("textbox", { name: "联网研究问题", exact: true }).fill(searchQuestion);
  const researchPending = page.waitForResponse(response => new URL(response.url()).pathname === researchUrl && response.request().method() === "POST");
  await pane.getByRole("button", { name: "联网查资料", exact: true }).click();
  const researchResponse = await researchPending;
  expect(researchResponse.ok()).toBe(true);
  const research = await researchResponse.json() as BookWebResearchResponse;
  expect(research.sources.map(source => source.id)).toEqual(["W1", "W2", "W3"]);
  const comparison = pane.getByRole("region", { name: "多来源原文对照", exact: true });
  await expect(comparison).toBeVisible();
  await expect(comparison.getByRole("textbox", { name: "多来源对照问题", exact: true })).toHaveValue(searchQuestion);
  await expect(comparison.getByRole("button", { name: "查找多来源原文依据", exact: true })).toBeDisabled();
  expect(readRequests).toEqual([]);
  expect(comparisonRequests).toEqual([]);

  const snapshots: Snapshot[] = [];
  async function readSource(sourceId: string, reread = false): Promise<Snapshot> {
    const source = research.sources.find(item => item.id === sourceId)!;
    const pending = page.waitForResponse(response => new URL(response.url()).pathname === readUrl && response.request().method() === "POST");
    await pane.getByRole("button", { name: (reread ? "重新读取网页正文 " : "读取网页正文 ") + sourceId, exact: true }).click();
    const response = await pending;
    expect(response.ok()).toBe(true);
    expect(response.request().postDataJSON()).toEqual({ sourceToken: source.readToken });
    const body = await response.json() as Snapshot;
    expect(body).toMatchObject({ bookId: comparisonBook, sourceId, requestedUrl: source.url, finalUrl: source.url + "?view=full", truncated: false });
    expect(body.snapshotToken).toMatch(/^[A-Za-z0-9_-]{32}$/);
    await expect(pane.getByRole("region", { name: "网页可读文字 " + sourceId, exact: true })).toBeVisible();
    await expect(comparison.getByRole("checkbox", { name: "选择来源 " + sourceId, exact: true })).toBeVisible();
    snapshots.push(body);
    return body;
  }
  const first = await readSource("W1");
  const third = await readSource("W3");
  expect(first.text).toContain("1935年初版");
  expect(first.text).not.toContain("1937年");
  expect(third.text).toContain("最早于1937年出版");
  expect(third.text).not.toContain("1935年");
  await expect(comparison.getByRole("checkbox", { name: "选择来源 W2", exact: true })).toHaveCount(0);
  expect(await providerCalls()).toBe(0);
  expect(comparisonRequests).toEqual([]);

  // Selection order is intentional and differs from both source-list and provider order.
  await comparison.getByRole("checkbox", { name: "选择来源 W3", exact: true }).check();
  await expect(comparison.getByRole("button", { name: "查找多来源原文依据", exact: true })).toBeDisabled();
  await comparison.getByRole("checkbox", { name: "选择来源 W1", exact: true }).check();
  const yearQuestion = "两篇网页对出版年份分别怎么说？";
  async function compare(selected: Snapshot[], question: string, expectedEmpty: string[] = []) {
    const input = comparison.getByRole("textbox", { name: "多来源对照问题", exact: true });
    await input.fill(question);
    const callsBefore = await providerCalls();
    const readsBefore = readRequests.length;
    const pending = page.waitForResponse(response => new URL(response.url()).pathname === compareUrl && response.request().method() === "POST");
    await comparison.getByRole("button", { name: "查找多来源原文依据", exact: true }).click();
    const response = await pending;
    expect(response.ok()).toBe(true);
    expect(response.request().postDataJSON()).toEqual({ snapshotTokens: selected.map(source => source.snapshotToken), question });
    const value = await response.json() as BookWebSourceComparisonResponse;
    expect(Object.keys(value).sort()).toEqual(["bookId", "generatedAt", "mode", "question", "sources"]);
    expect(value).toMatchObject({ bookId: comparisonBook, question, mode: "source_comparison" });
    expect(value.sources.map(source => source.sourceId)).toEqual(selected.map(source => source.sourceId));
    expect(await providerCalls()).toBe(callsBefore + 1);
    expect(readRequests).toHaveLength(readsBefore);
    const results = comparison.getByRole("region", { name: "多来源原文依据", exact: true });
    await expect(results).toBeVisible();
    expect(await results.locator("[data-comparison-source-id]").evaluateAll(elements => elements.map(element => element.getAttribute("data-comparison-source-id"))))
      .toEqual(selected.map(source => source.sourceId));
    for (let index = 0; index < selected.length; index++) {
      const source = selected[index];
      const actual = value.sources[index];
      expect(actual).toMatchObject({
        bookId: comparisonBook, sourceId: source.sourceId, snapshotToken: source.snapshotToken,
        question, mode: "source_passages", requestedUrl: source.requestedUrl, finalUrl: source.finalUrl,
        title: source.title, fetchedAt: source.fetchedAt, sourceTruncated: false, generatedAt: value.generatedAt,
      });
      const group = results.getByRole("region", { name: "对照来源 " + source.sourceId, exact: true });
      await expect(group).toBeVisible();
      if (expectedEmpty.includes(source.sourceId)) {
        expect(actual.status).toBe("insufficient_evidence");
        expect(actual.passages).toEqual([]);
        await expect(group.locator("[data-comparison-passage-id]")).toHaveCount(0);
        await expect(group).toHaveAttribute("data-comparison-source-status", "insufficient_evidence");
        await expect(group).toContainText("本次未选出足够相关的原文");
      } else {
        expect(actual.status).toBe("selected");
        expect(actual.passages.length).toBeGreaterThan(0);
        expect(actual.passages.length).toBeLessThanOrEqual(2);
      }
      for (const passage of actual.passages) {
        expect(passage.text).toBe(source.text.slice(passage.start, passage.end));
        expect(passage.end - passage.start).toBeLessThanOrEqual(1200);
        expect(await group.locator('[data-comparison-passage-id="' + passage.id + '"] blockquote').textContent()).toBe(passage.text);
        await group.getByRole("button", { name: "在对照正文中定位 " + passage.id + " " + source.sourceId, exact: true }).click();
        await expect(group.locator('[data-comparison-highlight="' + passage.id + '"]')).toHaveText(passage.text);
        expect(await group.locator("blockquote.book-web-comparison-body").textContent()).toBe(source.text);
      }
    }
    for (const privateText of [INTRO, NOTE, pendingIntro, pendingNote, "1937年再版"]) expect(JSON.stringify(value)).not.toContain(privateText);
    await comparison.getByRole("button", { name: "复制多来源原文与出处", exact: true }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain(question);
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toContain(value.generatedAt);
    for (const source of value.sources) {
      for (const provenance of [source.sourceId, source.title, source.requestedUrl, source.finalUrl, source.fetchedAt]) expect(copied).toContain(provenance);
      for (const passage of source.passages) expect(copied).toContain(passage.text);
    }
    for (const forbidden of [...snapshots.map(source => source.snapshotToken), ...research.sources.map(source => source.readToken!), INTRO, NOTE, pendingIntro, pendingNote, "1937年再版"]) expect(copied).not.toContain(forbidden);
    await expect(introEditor).toHaveValue(pendingIntro);
    await expect(noteEditor).toHaveValue(pendingNote);
    return value;
  }

  const desktop = await compare([third, first], yearQuestion);
  expect(desktop.sources.find(source => source.sourceId === "W1")!.passages.map(passage => passage.text).join("\n")).toContain("1935年初版");
  expect(desktop.sources.find(source => source.sourceId === "W3")!.passages.map(passage => passage.text).join("\n")).toContain("最早于1937年出版");
  expect(await persisted(comparisonBook)).toEqual(before);
  expect(writes).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  expect(await pane.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await comparison.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("web-source-comparison-desktop.png"), fullPage: true });
  await comparison.getByRole("heading", { name: "多来源原文对照", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("web-source-comparison-desktop-controls.png"), fullPage: true });

  await comparison.getByRole("checkbox", { name: "选择来源 W1", exact: true }).uncheck();
  await expect(comparison.getByRole("region", { name: "多来源原文依据", exact: true })).toHaveCount(0);
  await expect(comparison.getByRole("button", { name: "查找多来源原文依据", exact: true })).toBeDisabled();
  expect(comparisonRequests).toHaveLength(1);
  await comparison.getByRole("checkbox", { name: "选择来源 W1", exact: true }).check();
  const partial = await compare([third, first], "两篇网页各自提供了什么目录号？", ["W3"]);
  expect(partial.sources).toHaveLength(2);
  expect(partial.sources.map(source => source.status)).toEqual(["insufficient_evidence", "selected"]);

  // Rereading a selected source invalidates its selection, even though old text remains readable.
  const freshFirst = await readSource("W1", true);
  expect(freshFirst.snapshotToken).not.toBe(first.snapshotToken);
  await expect(comparison.getByRole("checkbox", { name: "选择来源 W1", exact: true })).not.toBeChecked();
  await expect(comparison.getByRole("checkbox", { name: "选择来源 W3", exact: true })).toBeChecked();
  await expect(comparison.getByRole("region", { name: "多来源原文依据", exact: true })).toHaveCount(0);
  expect(comparisonRequests).toHaveLength(2);
  await pane.getByRole("button", { name: "清除网页正文 W3", exact: true }).click();
  await expect(comparison.getByRole("checkbox", { name: "选择来源 W3", exact: true })).toHaveCount(0);
  const freshThird = await readSource("W3");
  expect(freshThird.snapshotToken).not.toBe(third.snapshotToken);
  await expect(comparison.getByRole("checkbox", { name: "选择来源 W3", exact: true })).not.toBeChecked();
  expect(await providerCalls()).toBe(2);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "打开 AI 助手", exact: true }).click();
  await comparison.getByRole("checkbox", { name: "选择来源 W1", exact: true }).check();
  await comparison.getByRole("checkbox", { name: "选择来源 W3", exact: true }).check();
  await compare([freshFirst, freshThird], yearQuestion);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  expect(await pane.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await page.getByRole("button", { name: "关闭 AI 助手", exact: true }).click();
  await expect(introEditor).toHaveValue(pendingIntro);
  await expect(noteEditor).toHaveValue(pendingNote);
  await page.getByRole("button", { name: "打开 AI 助手", exact: true }).click();
  await expect(comparison.getByRole("region", { name: "多来源原文依据", exact: true })).toBeVisible();
  await expect(comparison.getByRole("checkbox", { name: "选择来源 W1", exact: true })).toBeChecked();
  await expect(comparison.getByRole("checkbox", { name: "选择来源 W3", exact: true })).toBeChecked();
  expect(await providerCalls()).toBe(3);
  expect(comparisonRequests).toHaveLength(3);
  expect(readRequests).toHaveLength(4);
  await comparison.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("web-source-comparison-mobile.png"), fullPage: true });
  await comparison.getByRole("heading", { name: "多来源原文对照", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("web-source-comparison-mobile-controls.png"), fullPage: true });
  expect(await persisted(comparisonBook)).toEqual(before);
  expect(writes).toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(externalSourceRequests).toEqual([]);
  const evidence = {
    task_id: "BOOK_AI_WEB_SOURCE_COMPARISON_V1",
    output_mode: "source_comparison", transport: "REAL_HTTP_CSRF_AND_PRODUCTION_COMPARISON_SERVICE",
    provider: "INJECTED_IDS_ONLY_NO_LIVE_MODEL", provider_calls: await providerCalls(),
    explicit_requests: comparisonRequests.length, source_reads: readRequests.length,
    source_group_order: ["W3", "W1"], provider_reversed_order_restored: true,
    source_quotes: "EXACT_PER_SOURCE_UTF16_SLICES", different_years: "PRESERVED_WITHOUT_INVENTED_EDITION_SEQUENCE",
    partial_insufficient_source_kept: true, comparison_location: "EXACT_FULL_SNAPSHOT_AND_HIGHLIGHT",
    copy: "QUESTION_QUOTES_PER_SOURCE_METADATA_NO_CAPABILITY_TOKENS",
    selection_change_clears_result: true, reread_requires_explicit_reselection: true,
    clear_source_removes_selection: true, mobile_close_reopen_preserves_result_without_requests: true,
    library_writes: writes.length, persistence: "REAL_POSTGRESQL_UNCHANGED", unsaved_editors: "PRESERVED",
    desktop_width: 1440, mobile_width: 390, page_errors: pageErrors, external_source_requests: externalSourceRequests.length,
    real_google_oauth: "NOT_EXERCISED", real_minimax: "NOT_EXERCISED",
  };
  const evidenceFile = testInfo.outputPath("web-source-comparison-evidence.json");
  writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2));
  await testInfo.attach("web-source-comparison-evidence.json", { contentType: "application/json", path: evidenceFile });
});
