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

const recoveryFixtureKey = "recovery-" + fixtureKey;
const recoveryCatalogIds = getBookBrowserCatalogIds(recoveryFixtureKey);
const unselectedRecoveryId = getBookBrowserCatalogIds("unselected-" + fixtureKey).A;
const recoveryCases = [
  { kind: "limited", bookId: recoveryCatalogIds.A, title: "联网研究上限验证 " + recoveryFixtureKey },
  { kind: "retry", bookId: recoveryCatalogIds.B, title: "联网研究重试验证 " + recoveryFixtureKey },
  { kind: "unselected", bookId: unselectedRecoveryId, title: "联网研究未挑选验证 " + recoveryFixtureKey },
] as const;
const LIMITED_NOTICE = "本次搜索已达到上限，已保留返回的资料。可以调整问题后再查。";
const SEARCH_FAILURE_NOTICE = "本次网页搜索未完成，请稍后重试。";
const UNSELECTED_NOTICE = "已完成网页搜索，但本次自动挑选未完成。下方保留搜索返回的资料，可以打开原链接核对或读取网页正文。";
type RecoveryCounters = { searchRequests: number; selectionCalls: number; readerCalls: number };

for (const scenario of recoveryCases) {
  test("web research " + scenario.kind + " keeps completed evidence and personal edits", async ({ page, context }, testInfo) => {
    const workspace = "/api/private/s32/library/books/" + scenario.bookId;
    const researchUrl = "/api/ai/books/" + scenario.bookId + "/research";
    const { token } = issueWebSession({ sub: "book-library-test-owner", name: "合成验证账号", email: "library-test@example.test" }, {
      secret: "book-library-synthetic-session-secret-for-local-ci-only",
    });
    await context.addCookies([{ name: "book_id_search_session_dev", value: token, url: WEB, httpOnly: true, sameSite: "Lax" }]);
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: WEB });
    expect(await persisted(scenario.bookId)).toBeNull();
    const session = await (await page.request.get("/api/auth/session")).json();
    const headers = { Origin: WEB, "X-CSRF-Token": session.csrfToken };
    expect((await page.request.put(workspace, { headers, data: { introduction: INTRO, baseVersion: 0 } })).ok()).toBe(true);
    expect((await page.request.post(workspace + "/notes", { headers, data: { title: "私人阅读笔记", content: NOTE } })).ok()).toBe(true);
    const before = await persisted(scenario.bookId);
    const writes: string[] = [], pageErrors: string[] = [], sourcePageRequests: string[] = [];
    const researchRequests: unknown[] = [], otherResearchRequests: string[] = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    page.on("request", request => {
      const url = new URL(request.url());
      if (url.pathname.startsWith("/api/private/s32/library/") && ["POST", "PUT", "PATCH", "DELETE"].includes(request.method())) {
        writes.push(request.method() + " " + url.pathname);
      }
      if (url.hostname === "example.org") sourcePageRequests.push(request.url());
      if (url.pathname === researchUrl && request.method() === "POST") researchRequests.push(request.postDataJSON());
      if (url.pathname.startsWith(researchUrl + "/") && request.method() === "POST") otherResearchRequests.push(url.pathname);
    });
    async function counters(): Promise<RecoveryCounters> {
      const response = await page.request.get("/api/health");
      expect(response.ok()).toBe(true);
      return (await response.json()).bookWebResearchRecovery.cases[scenario.kind];
    }
    expect(await counters()).toEqual({ searchRequests: 0, selectionCalls: 0, readerCalls: 0 });
    await page.goto("/books/" + scenario.bookId);
    await expect(page.getByRole("heading", { name: scenario.title, exact: true })).toBeVisible();
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
    await pane.getByRole("button", { name: "联网研究", exact: true }).click();
    const questionInput = pane.getByRole("textbox", { name: "联网研究问题", exact: true });
    await pane.getByRole("button", { name: "内容与背景", exact: true }).click();
    await expect(questionInput).not.toHaveValue("");
    const question = await questionInput.inputValue();
    const submit = pane.getByRole("button", { name: "联网查资料", exact: true });
    async function submitResearch() {
      const pending = page.waitForResponse(response => new URL(response.url()).pathname === researchUrl && response.request().method() === "POST");
      await submit.click();
      const response = await pending;
      expect(response.request().postDataJSON()).toEqual({ question });
      return response;
    }
    let failureCounters: RecoveryCounters | null = null;
    let response = await submitResearch();
    if (scenario.kind === "retry") {
      expect(response.status()).toBe(502);
      const failed = await response.json();
      expect(failed.error.code).toBe("BOOK_RESEARCH_SEARCH_FAILED");
      expect(JSON.stringify(failed)).not.toContain("SYNTHETIC_RECOVERY_PROVIDER_DETAIL");
      await expect(pane.getByText(SEARCH_FAILURE_NOTICE, { exact: true })).toBeVisible();
      await expect(pane.getByRole("region", { name: "联网研究结果", exact: true })).toHaveCount(0);
      await expect(questionInput).toHaveValue(question);
      await expect(introEditor).toHaveValue(pendingIntro);
      await expect(noteEditor).toHaveValue(pendingNote);
      await expect(submit).toBeEnabled();
      expect(await persisted(scenario.bookId)).toEqual(before);
      failureCounters = await counters();
      expect(failureCounters).toEqual({ searchRequests: 1, selectionCalls: 0, readerCalls: 0 });
      expect(researchRequests).toEqual([{ question }]);
      expect(otherResearchRequests).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath("web-research-retry-error.png"), fullPage: true });
      expect(await counters()).toEqual(failureCounters);
      // The same question is retried only by this explicit click, with no refill.
      response = await submitResearch();
    }

    expect(response.status()).toBe(200);
    const value = await response.json() as BookWebResearchResponse;
    const limited = scenario.kind === "limited", unselected = scenario.kind === "unselected";
    expect(value).toMatchObject({ bookId: scenario.bookId, question, mode: "source_excerpts", source: unselected ? "unselected_sources" : "web_research" });
    const expectedQueries = limited
      ? Array.from({ length: 10 }, (_, index) => scenario.title + " " + question + " · 已完成检索 " + (index + 1))
      : [scenario.title + " " + question];
    expect(value.search).toEqual({ performed: true, calls: limited ? 10 : 1, queries: expectedQueries, ...(limited ? { limited: true } : {}) });
    expect(value.sources).toHaveLength(limited ? 10 : unselected ? 6 : 2);
    expect(value.citedSourceIds).toEqual(unselected ? [] : limited ? ["W1", "W2", "W3", "W4"] : ["W1", "W2"]);
    for (const forbidden of [INTRO, NOTE, pendingIntro, pendingNote, "待执行检索", "SYNTHETIC_RECOVERY_PROVIDER_DETAIL", "这段生成文字不是来源"]) {
      expect(JSON.stringify(value)).not.toContain(forbidden);
    }
    const resultRegion = pane.getByRole("region", { name: unselected ? "待核对的网页资料" : "联网研究结果", exact: true });
    await expect(resultRegion).toBeVisible();
    await expect(pane.getByText(SEARCH_FAILURE_NOTICE, { exact: true })).toHaveCount(0);
    if (limited) await expect(pane.getByText(LIMITED_NOTICE, { exact: true })).toBeVisible();
    else await expect(pane.getByText(LIMITED_NOTICE, { exact: true })).toHaveCount(0);
    if (unselected) {
      expect(value.draft).toMatchObject({ title: "待核对的网页资料", content: UNSELECTED_NOTICE });
      await expect(pane.getByRole("heading", { name: "待核对的网页资料", exact: true })).toBeVisible();
      await expect(pane.getByText("未自动挑选", { exact: true })).toBeVisible();
      await expect(pane.getByText(UNSELECTED_NOTICE, { exact: true })).toBeVisible();
      await expect(pane.getByText("资料不足", { exact: true })).toHaveCount(0);
      await expect(pane.getByText("已选中", { exact: true })).toHaveCount(0);
      await expect(pane.locator("[data-web-excerpt-source-id]")).toHaveCount(0);
      await expect(resultRegion.locator("[data-web-source-id]")).toHaveCount(6);
    }
    const displayedSources = unselected ? value.sources : value.citedSourceIds.map(id => value.sources.find(item => item.id === id)!);
    for (const source of displayedSources) {
      const attribute = unselected ? "data-web-source-id" : "data-web-excerpt-source-id";
      const card = resultRegion.locator("[" + attribute + '="' + source.id + '"]');
      await expect(card).toBeVisible();
      expect(await card.locator("blockquote").first().textContent()).toBe(source.excerpt);
      if (unselected) {
        await expect(card.getByRole("link", { name: "[" + source.id + "] " + source.title, exact: true })).toHaveAttribute("href", source.url);
        await expect(card.getByRole("button", { name: "读取网页正文 " + source.id, exact: true })).toBeVisible();
        await expect(card.getByRole("button", { name: "读取网页正文 " + source.id, exact: true })).toBeEnabled();
        expect(source.readToken).toEqual(expect.any(String));
      }
    }
    await pane.getByRole("button", { name: "复制结果与来源", exact: true }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain(question);
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    if (limited) expect(copied).toContain(LIMITED_NOTICE);
    if (unselected) {
      expect(copied).toContain(UNSELECTED_NOTICE);
      for (const source of value.sources) {
        expect(copied).toContain(source.title);
        expect(copied).toContain(source.url);
        expect(copied).toContain(source.excerpt);
      }
      await expect(pane.getByText("已复制待核对的网页资料与出处。", { exact: true })).toBeVisible();
    }
    for (const forbidden of [INTRO, NOTE, pendingIntro, pendingNote, "待执行检索", ...value.sources.map(source => source.readToken!)]) {
      expect(copied).not.toContain(forbidden);
    }
    await expect(questionInput).toHaveValue(question);
    await expect(introEditor).toHaveValue(pendingIntro);
    await expect(noteEditor).toHaveValue(pendingNote);
    const expectedRequests = scenario.kind === "retry" ? 2 : 1;
    expect(await counters()).toEqual({ searchRequests: expectedRequests, selectionCalls: 1, readerCalls: 0 });
    expect(otherResearchRequests).toEqual([]);
    if (unselected) {
      // Reading is a separate, explicit action after all unselected sources are retained.
      const source = value.sources[0];
      const readUrl = researchUrl + "/source";
      const pending = page.waitForResponse(item => new URL(item.url()).pathname === readUrl && item.request().method() === "POST");
      await resultRegion.getByRole("button", { name: "读取网页正文 " + source.id, exact: true }).click();
      const readResponse = await pending;
      expect(readResponse.status()).toBe(200);
      expect(readResponse.request().postDataJSON()).toEqual({ sourceToken: source.readToken });
      const read = await readResponse.json() as BookWebSourceResponse;
      expect(read).toMatchObject({ bookId: scenario.bookId, sourceId: source.id, requestedUrl: source.url });
      expect(read.text).toContain("这是未自动挑选资料的合成网页正文，只在用户显式读取后展示。");
      const readRegion = resultRegion.getByRole("region", { name: "网页可读文字 " + source.id, exact: true });
      await expect(readRegion).toBeVisible();
      expect(await readRegion.locator(".book-web-page-text").textContent()).toBe(read.text);
      await expect(questionInput).toHaveValue(question);
      await expect(introEditor).toHaveValue(pendingIntro);
      await expect(noteEditor).toHaveValue(pendingNote);
    }
    const finalCounters = await counters();
    expect(finalCounters).toEqual({ searchRequests: expectedRequests, selectionCalls: 1, readerCalls: unselected ? 1 : 0 });
    expect(researchRequests).toEqual(Array.from({ length: expectedRequests }, () => ({ question })));
    expect(otherResearchRequests).toEqual(unselected ? [researchUrl + "/source"] : []);
    expect(await persisted(scenario.bookId)).toEqual(before);
    expect(writes).toEqual([]);
    expect(sourcePageRequests).toEqual([]);
    expect(pageErrors).toEqual([]);
    await resultRegion.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("web-research-" + scenario.kind + "-success.png"), fullPage: true });
    const evidence = {
      task_id: "BOOK_AI_WEB_RESEARCH_RECOVERY_V1", scenario: scenario.kind,
      transport: "REAL_APP_HTTP_CSRF_AND_PRODUCTION_SEARCH_ADAPTER_SERVICE",
      provider: "INJECTED_HTTP_AND_IDS_ONLY_NO_LIVE_MODEL", question_example: "内容与背景", question_preserved: true,
      server_search_calls: value.search.calls, completed_queries: value.search.queries.length,
      returned_sources: value.sources.length, limited_notice: limited, pending_search_calls_excluded: limited ? 2 : 0,
      source: value.source, unselected_sources_retained: unselected, displayed_source_cards: displayedSources.length,
      failed_request_counts: failureCounters, final_counts: finalCounters, explicit_http_requests: researchRequests.length,
      automatic_continuation_or_retry: "NONE_OBSERVED", reader_http_requests: otherResearchRequests.length,
      personal_writes: writes.length, persistence: "REAL_POSTGRESQL_UNCHANGED", unsaved_editors: "PRESERVED",
      page_errors: pageErrors.length, external_source_requests: sourcePageRequests.length,
      real_google_oauth: "NOT_EXERCISED", real_minimax: "NOT_EXERCISED",
    };
    const path = testInfo.outputPath("web-research-" + scenario.kind + "-evidence.json");
    writeFileSync(path, JSON.stringify(evidence, null, 2));
    await testInfo.attach("web-research-" + scenario.kind + "-evidence.json", { contentType: "application/json", path });
  });
}


const sourceContextFixtureKey = "context-" + fixtureKey;
const sourceContextCatalogIds = getBookBrowserCatalogIds(sourceContextFixtureKey);
type BookCluesFixture = {
  isbn: "matched" | "mixed" | "other_only" | "not_seen" | "unavailable";
  text: Array<"title" | "author">;
};
type ContextSource = BookWebResearchResponse["sources"][number] & { bookClues?: BookCluesFixture };
type ContextResearchResponse = Omit<BookWebResearchResponse, "sources"> & { sources: ContextSource[] };
type ContextCounters = RecoveryCounters & { comparisonCalls: number; legacyResponses: number };
const BOOK_CLUES_NOTICE = "书目线索只核对当前标题和搜索节选中的文字，不代表已读全文、内容可信或属于本书书评。";
const MISSING_SELECTED_ISBN_NOTICE = "所选资料尚缺可对应本书的 ISBN 线索；与本书的直接关联仍需核对。";
const clueLabels = {
  matched: "出现本书 ISBN", mixed: "本书与其他 ISBN 同时出现", other_only: "只看到其他 ISBN",
  not_seen: "未见本书 ISBN", unavailable: "本书 ISBN 无法用于比对", legacy: "书目线索未核对",
};
const contextRows = {
  mixed: [
    { title: "目录摘录甲", excerpt: "目录摘录原句：ISBN 978-7-5384-5525-0；这里记录了一个版本条目。", isbn: "matched" },
    { title: "异题目录乙", excerpt: "另一主题条目原句：ISBN 9787111128069；本文讨论与当前查询不同的研究材料。", isbn: "other_only" },
    { title: "并列目录丙", excerpt: "并列目录原句：ISBN 9787538455250 与 ISBN 9787111128069 同页列出，片段未说明两书关系。", isbn: "mixed" },
    { title: "主题方法丁", excerpt: "主题资料原句：这里讨论通用的田野记录方法，没有给出具体图书的出版信息。", isbn: "not_seen" },
  ],
  compat: [
    { title: "通用方法资料甲", excerpt: "通用方法原句：目录比对需要记录出处、页码与时间。", isbn: "not_seen" },
    { title: "其他版本资料乙", excerpt: "他书目录原句：ISBN 9787111128069；片段只陈列另一目录项，未说明与查询图书的关系。", isbn: "other_only" },
  ],
} as const;
const contextScenarios = [
  { kind: "mixed", bookId: sourceContextCatalogIds.A, title: "书目线索混合验证 " + sourceContextFixtureKey },
  { kind: "compat", bookId: sourceContextCatalogIds.B, title: "书目线索兼容验证 " + sourceContextFixtureKey },
] as const;

for (const scenario of contextScenarios) {
  test("web source context " + scenario.kind + " preserves original sources and private edits", async ({ page, context }, testInfo) => {
    const researchUrl = "/api/ai/books/" + scenario.bookId + "/research";
    const readUrl = researchUrl + "/source", compareUrl = researchUrl + "/sources/evidence";
    const workspace = "/api/private/s32/library/books/" + scenario.bookId;
    const { token } = issueWebSession({ sub: "book-library-test-owner", name: "合成验证账号", email: "library-test@example.test" }, {
      secret: "book-library-synthetic-session-secret-for-local-ci-only",
    });
    await context.addCookies([{ name: "book_id_search_session_dev", value: token, url: WEB, httpOnly: true, sameSite: "Lax" }]);
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: WEB });
    expect(await persisted(scenario.bookId)).toBeNull();
    const session = await (await page.request.get("/api/auth/session")).json();
    const headers = { Origin: WEB, "X-CSRF-Token": session.csrfToken };
    expect((await page.request.put(workspace, { headers, data: { introduction: INTRO, baseVersion: 0 } })).ok()).toBe(true);
    expect((await page.request.post(workspace + "/notes", { headers, data: { title: "私人阅读笔记", content: NOTE } })).ok()).toBe(true);
    const before = await persisted(scenario.bookId);
    const writes: string[] = [], pageErrors: string[] = [], externalRequests: string[] = [], unexpectedResearch: string[] = [];
    const researchRequests: unknown[] = [], readRequests: unknown[] = [], comparisonRequests: unknown[] = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    page.on("request", request => {
      const url = new URL(request.url());
      if (url.hostname === "example.org") externalRequests.push(request.url());
      if (url.pathname.startsWith("/api/private/s32/library/") && ["POST", "PUT", "PATCH", "DELETE"].includes(request.method())) {
        writes.push(request.method() + " " + url.pathname);
      }
      if (request.method() !== "POST") return;
      if (url.pathname === researchUrl) researchRequests.push(request.postDataJSON());
      else if (url.pathname === readUrl) readRequests.push(request.postDataJSON());
      else if (url.pathname === compareUrl) comparisonRequests.push(request.postDataJSON());
      else if (url.pathname.startsWith(researchUrl + "/")) unexpectedResearch.push(url.pathname);
    });
    async function counters(): Promise<ContextCounters> {
      const response = await page.request.get("/api/health");
      expect(response.ok()).toBe(true);
      return (await response.json()).bookWebSourceContext.cases[scenario.kind];
    }
    const expected: ContextCounters = { searchRequests: 0, selectionCalls: 0, readerCalls: 0, comparisonCalls: 0, legacyResponses: 0 };
    expect(await counters()).toEqual(expected);
    await page.goto("/books/" + scenario.bookId);
    await expect(page.getByRole("heading", { name: scenario.title, exact: true })).toBeVisible();
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
    await pane.getByRole("button", { name: "联网研究", exact: true }).click();
    const questionInput = pane.getByRole("textbox", { name: "联网研究问题", exact: true });
    const phases = scenario.kind === "mixed" ? [
      { kind: "mixed", question: "查找本书目录和其他主题资料。", source: "web_research" },
    ] : [
      { kind: "unknown", question: "查看这些资料的书目线索。", source: "web_research" },
      { kind: "legacy", question: "查看旧格式返回的公开资料。", source: "web_research" },
      { kind: "unselected", question: "保留未完成自动挑选的公开资料。", source: "unselected_sources" },
      { kind: "insufficient", question: "资料不足时保留返回的公开资料。", source: "insufficient_sources" },
    ];
    const evidencePhases: unknown[] = [];
    for (const phase of phases) {
      await questionInput.fill(phase.question);
      const pending = page.waitForResponse(response => new URL(response.url()).pathname === researchUrl && response.request().method() === "POST");
      await pane.getByRole("button", { name: "联网查资料", exact: true }).click();
      const response = await pending;
      expect(response.status()).toBe(200);
      expect(response.request().postDataJSON()).toEqual({ question: phase.question });
      const value = await response.json() as ContextResearchResponse;
      expected.searchRequests++; expected.selectionCalls++;
      if (phase.kind === "legacy") expected.legacyResponses++;
      expect(await counters()).toEqual(expected);
      expect(value).toMatchObject({ bookId: scenario.bookId, question: phase.question, source: phase.source, mode: "source_excerpts" });
      expect(value.search).toEqual({ performed: true, calls: 1, queries: [scenario.title + " " + phase.question] });
      const rows = contextRows[scenario.kind];
      const ids = rows.map((_, index) => "W" + (index + 1));
      expect(value.sources.map(source => source.id)).toEqual(ids);
      expect(value.sources.map(source => source.title)).toEqual(rows.map(row => row.title));
      expect(value.sources.map(source => source.excerpt)).toEqual(rows.map(row => row.excerpt));
      const selected = phase.source === "web_research";
      expect(value.citedSourceIds).toEqual(selected ? ids : []);
      expect(JSON.stringify(value)).not.toContain("合成生成文字不是原始网页片段");
      for (const privateText of [INTRO, NOTE, pendingIntro, pendingNote]) expect(JSON.stringify(value)).not.toContain(privateText);
      await expect(pane.getByText(BOOK_CLUES_NOTICE, { exact: true }).first()).toBeVisible();
      if (phase.kind === "unknown") await expect(pane.getByText(MISSING_SELECTED_ISBN_NOTICE, { exact: true })).toBeVisible();
      else await expect(pane.getByText(MISSING_SELECTED_ISBN_NOTICE, { exact: true })).toHaveCount(0);
      // A lexical clue never implies that a page or the original book was read.
      await expect(pane.locator(".book-web-page-text")).toHaveCount(0);
      await expect(pane.getByText("已提取网页文字", { exact: true })).toHaveCount(0);
      if (phase.source !== "unselected_sources") {
        await pane.getByText("查看本次网页来源（" + rows.length + "）", { exact: true }).click();
      }
      for (let index = 0; index < rows.length; index++) {
        const source = value.sources[index], row = rows[index];
        const clue = phase.kind === "legacy" ? "legacy" : row.isbn;
        if (clue === "legacy") expect(source.bookClues).toBeUndefined();
        else expect(source.bookClues).toEqual({ isbn: clue, text: [] });
        const allCard = pane.locator('[data-web-source-id="' + source.id + '"]');
        const cards = selected ? [allCard, pane.locator('[data-web-excerpt-source-id="' + source.id + '"]')] : [allCard];
        for (const card of cards) {
          await expect(card).toBeVisible();
          await expect(card).toHaveAttribute("data-book-clues", clue);
          await expect(card.getByLabel("本书书目线索 " + source.id, { exact: true })).toContainText(clueLabels[clue]);
          expect(await card.locator("blockquote").first().textContent()).toBe(row.excerpt);
        }
        await expect(pane.getByRole("button", { name: "读取网页正文 " + source.id, exact: true })).toBeEnabled();
        expect(source.readToken).toEqual(expect.any(String));
      }
      if (!selected) {
        await expect(pane.locator("[data-web-excerpt-source-id]")).toHaveCount(0);
        await expect(pane.getByText(phase.kind === "unselected" ? "未自动挑选" : "资料不足", { exact: true })).toBeVisible();
      }
      const copyLabel = phase.kind === "insufficient" ? "复制现有来源" : "复制结果与来源";
      await pane.getByRole("button", { name: copyLabel, exact: true }).click();
      await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain(phase.question);
      const copied = await page.evaluate(() => navigator.clipboard.readText());
      expect(copied).toContain(BOOK_CLUES_NOTICE);
      if (!selected) expect(copied).toContain(value.draft.content);
      for (let index = 0; index < rows.length; index++) {
        const source = value.sources[index];
        for (const original of [source.title, source.url, rows[index].excerpt]) expect(copied).toContain(original);
        expect(copied).toContain(clueLabels[phase.kind === "legacy" ? "legacy" : rows[index].isbn]);
        expect(copied).not.toContain(source.readToken!);
      }
      for (const privateText of [INTRO, NOTE, pendingIntro, pendingNote]) expect(copied).not.toContain(privateText);

      async function readSource(sourceId: string): Promise<BookWebSourceResponse> {
        const source = value.sources.find(item => item.id === sourceId)!;
        const pendingRead = page.waitForResponse(item => new URL(item.url()).pathname === readUrl && item.request().method() === "POST");
        await pane.getByRole("button", { name: "读取网页正文 " + sourceId, exact: true }).click();
        const readResponse = await pendingRead;
        expect(readResponse.status()).toBe(200);
        expect(readResponse.request().postDataJSON()).toEqual({ sourceToken: source.readToken });
        const read = await readResponse.json() as BookWebSourceResponse;
        expect(read).toMatchObject({ bookId: scenario.bookId, sourceId, requestedUrl: source.url });
        expect(read.text).toContain("正文原句：");
        const readRegion = pane.getByRole("region", { name: "网页可读文字 " + sourceId, exact: true });
        await expect(readRegion).toBeVisible();
        expect(await readRegion.locator(".book-web-page-text").textContent()).toBe(read.text);
        expected.readerCalls++;
        expect(await counters()).toEqual(expected);
        return read;
      }
      const first = await readSource("W1");
      if (scenario.kind === "mixed") {
        const third = await readSource("W3");
        const comparison = pane.getByRole("region", { name: "多来源原文对照", exact: true });
        await comparison.getByRole("checkbox", { name: "选择来源 W1", exact: true }).check();
        await comparison.getByRole("checkbox", { name: "选择来源 W3", exact: true }).check();
        const question = "对照两条目录的正文原句。";
        await comparison.getByRole("textbox", { name: "多来源对照问题", exact: true }).fill(question);
        const pendingCompare = page.waitForResponse(item => new URL(item.url()).pathname === compareUrl && item.request().method() === "POST");
        await comparison.getByRole("button", { name: "查找多来源原文依据", exact: true }).click();
        const compared = await pendingCompare;
        expect(compared.status()).toBe(200);
        expect(compared.request().postDataJSON()).toEqual({ snapshotTokens: [first.snapshotToken, third.snapshotToken], question });
        const comparisonValue = await compared.json() as BookWebSourceComparisonResponse;
        expect(comparisonValue).toMatchObject({ bookId: scenario.bookId, question, mode: "source_comparison" });
        expect(comparisonValue.sources.map(source => source.sourceId)).toEqual(["W1", "W3"]);
        expected.comparisonCalls++;
        expect(await counters()).toEqual(expected);
        const results = comparison.getByRole("region", { name: "多来源原文依据", exact: true });
        await expect(results).toBeVisible();
        for (let index = 0; index < 2; index++) {
          const snapshot = [first, third][index], group = comparisonValue.sources[index];
          expect(group.status).toBe("selected");
          expect(group.passages).toHaveLength(1);
          const passage = group.passages[0];
          expect(passage.text).toBe(snapshot.text.slice(passage.start, passage.end));
          const card = results.getByRole("region", { name: "对照来源 " + snapshot.sourceId, exact: true });
          expect(await card.locator('[data-comparison-passage-id="' + passage.id + '"] blockquote').textContent()).toBe(passage.text);
        }
        await comparison.getByRole("button", { name: "复制多来源原文与出处", exact: true }).click();
        await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain(question);
        const copiedComparison = await page.evaluate(() => navigator.clipboard.readText());
        for (const group of comparisonValue.sources) {
          for (const passage of group.passages) expect(copiedComparison).toContain(passage.text);
          expect(copiedComparison).toContain(group.requestedUrl);
        }
        for (const secret of [first.snapshotToken!, third.snapshotToken!, ...value.sources.map(source => source.readToken!), INTRO, NOTE, pendingIntro, pendingNote]) {
          expect(copiedComparison).not.toContain(secret);
        }
      }
      await expect(questionInput).toHaveValue(phase.question);
      await expect(introEditor).toHaveValue(pendingIntro);
      await expect(noteEditor).toHaveValue(pendingNote);
      // Reader/comparison interactions do not upgrade or rewrite search clues.
      for (let index = 0; index < rows.length; index++) {
        const card = pane.locator('[data-web-source-id="W' + (index + 1) + '"]');
        await expect(card).toHaveAttribute("data-book-clues", phase.kind === "legacy" ? "legacy" : rows[index].isbn);
        expect(await card.locator("blockquote").first().textContent()).toBe(rows[index].excerpt);
      }
      evidencePhases.push({ kind: phase.kind, source: value.source, source_ids: ids, selected_ids: value.citedSourceIds,
        clues: value.sources.map(source => source.bookClues ?? "legacy"), counts: { ...expected },
        originals_preserved: true, copied_originals_and_clues: true, explicit_read_succeeded: true });
    }
    expect(await counters()).toEqual(expected);
    expect(researchRequests).toEqual(phases.map(phase => ({ question: phase.question })));
    expect(readRequests).toHaveLength(scenario.kind === "mixed" ? 2 : 4);
    expect(comparisonRequests).toHaveLength(scenario.kind === "mixed" ? 1 : 0);
    expect(unexpectedResearch).toEqual([]);
    expect(writes).toEqual([]);
    expect(await persisted(scenario.bookId)).toEqual(before);
    expect(externalRequests).toEqual([]);
    expect(pageErrors).toEqual([]);
    await pane.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("web-source-context-" + scenario.kind + ".png"), fullPage: true });
    const evidence = {
      task_id: "BOOK_AI_WEB_SOURCE_CONTEXT_V1", scenario: scenario.kind, phases: evidencePhases,
      transport: "REAL_HTTP_CSRF_OWNER_AND_PRODUCTION_SEARCH_SERVICE",
      clues: "PRODUCTION_RULES_FROM_RETURNED_TITLE_AND_EXCERPT",
      legacy_compatibility: scenario.kind === "compat" ? "OPTIONAL_FIELD_REMOVED_AFTER_REAL_SERVICE" : "NOT_EXERCISED",
      provider: "INJECTED_SEARCH_HTTP_AND_SELECTION_IDS_NO_LIVE_MODEL",
      source_reading: "REAL_ROUTER_TOKEN_AND_EXTRACTOR_SYNTHETIC_PAGE_TRANSPORT",
      comparison: scenario.kind === "mixed" ? "EXACT_SNAPSHOT_SLICES_AND_COPY" : "NOT_EXERCISED",
      no_automatic_requests: true, personal_writes: writes.length, persistence: "REAL_POSTGRESQL_UNCHANGED",
      unsaved_editors: "PRESERVED", page_errors: pageErrors.length, external_source_requests: externalRequests.length,
      real_google_oauth: "NOT_EXERCISED", real_minimax: "NOT_EXERCISED",
    };
    const path = testInfo.outputPath("web-source-context-" + scenario.kind + "-evidence.json");
    writeFileSync(path, JSON.stringify(evidence, null, 2));
    await testInfo.attach("web-source-context-" + scenario.kind + "-evidence.json", { contentType: "application/json", path });
  });
}


// Relation and material kind are model judgments backed by server-owned snippets.
// The fixtures deliberately keep target-book bibliography separate from reviews.
const sourceRelevanceFixtureKey = "relevance-" + fixtureKey;
const sourceRelevanceCatalogIds = getBookBrowserCatalogIds(sourceRelevanceFixtureKey);
const relevanceRelationshipLabels = {
  book_candidate: "可能直接涉及本书", other_book: "其他著作",
  related_background: "相关主题背景", unclear: "与本书关系待核对",
} as const;
const relevanceMaterialLabels = {
  bibliographic: "书目或商品信息", review: "书评或读后感", research: "研究性文章",
  discussion: "讨论资料", other: "其他资料",
} as const;
const RELEVANCE_NOTICE = "AI 根据当前标题和搜索节选作初步判断；原句可核对，判断和资料内容仍需核实。";
const BOOK_REVIEW_PRESET = "查找直接评论这本书的书评或研究，并区分其他著作、版本信息与相关背景资料。";
type RelevanceAssessment = {
  sourceId: string;
  relationship: keyof typeof relevanceRelationshipLabels;
  materialType: keyof typeof relevanceMaterialLabels;
  evidence: Array<{ id: string; field: "title" | "excerpt"; start: number; end: number; text: string }>;
};
type RelevanceResearchResponse = BookWebResearchResponse & { assessments?: RelevanceAssessment[] };
type RelevanceCounters = RecoveryCounters & { comparisonCalls: number; legacySelections: number; invalidAssessments: number };
const relevanceScenarios = [
  { kind: "classified", bookId: sourceRelevanceCatalogIds.A, title: "资料判断分类验证 " + sourceRelevanceFixtureKey },
  { kind: "compat", bookId: sourceRelevanceCatalogIds.B, title: "资料判断兼容验证 " + sourceRelevanceFixtureKey },
] as const;

for (const scenario of relevanceScenarios) {
  test("web source relevance " + scenario.kind + " preserves judgment scope, original text and private edits", async ({ page, context }, testInfo) => {
    const researchUrl = "/api/ai/books/" + scenario.bookId + "/research";
    const readUrl = researchUrl + "/source", compareUrl = researchUrl + "/sources/evidence";
    const workspace = "/api/private/s32/library/books/" + scenario.bookId;
    const { token } = issueWebSession({ sub: "book-library-test-owner", name: "合成验证账号", email: "library-test@example.test" }, {
      secret: "book-library-synthetic-session-secret-for-local-ci-only",
    });
    await context.addCookies([{ name: "book_id_search_session_dev", value: token, url: WEB, httpOnly: true, sameSite: "Lax" }]);
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: WEB });
    expect(await persisted(scenario.bookId)).toBeNull();
    const session = await (await page.request.get("/api/auth/session")).json();
    const headers = { Origin: WEB, "X-CSRF-Token": session.csrfToken };
    expect((await page.request.put(workspace, { headers, data: { introduction: INTRO, baseVersion: 0 } })).ok()).toBe(true);
    expect((await page.request.post(workspace + "/notes", { headers, data: { title: "私人阅读笔记", content: NOTE } })).ok()).toBe(true);
    const before = await persisted(scenario.bookId);
    const writes: string[] = [], pageErrors: string[] = [], externalRequests: string[] = [], unexpectedResearch: string[] = [];
    const researchRequests: unknown[] = [], readRequests: unknown[] = [], comparisonRequests: unknown[] = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    page.on("request", request => {
      const url = new URL(request.url());
      if (url.hostname === "example.org") externalRequests.push(request.url());
      if (url.pathname.startsWith("/api/private/s32/library/") && ["POST", "PUT", "PATCH", "DELETE"].includes(request.method())) {
        writes.push(request.method() + " " + url.pathname);
      }
      if (request.method() !== "POST") return;
      if (url.pathname === researchUrl) researchRequests.push(request.postDataJSON());
      else if (url.pathname === readUrl) readRequests.push(request.postDataJSON());
      else if (url.pathname === compareUrl) comparisonRequests.push(request.postDataJSON());
      else if (url.pathname.startsWith(researchUrl + "/")) unexpectedResearch.push(url.pathname);
    });
    async function counters(): Promise<RelevanceCounters> {
      const response = await page.request.get("/api/health");
      expect(response.ok()).toBe(true);
      return (await response.json()).bookWebSourceRelevance.cases[scenario.kind];
    }
    const expected: RelevanceCounters = {
      searchRequests: 0, selectionCalls: 0, readerCalls: 0, comparisonCalls: 0, legacySelections: 0, invalidAssessments: 0,
    };
    expect(await counters()).toEqual(expected);
    await page.goto("/books/" + scenario.bookId);
    await expect(page.getByRole("heading", { name: scenario.title, exact: true })).toBeVisible();
    const introRegion = page.getByRole("region", { name: "我的补充介绍", exact: true });
    await introRegion.getByRole("button", { name: "编辑介绍", exact: true }).click();
    const introEditor = introRegion.getByRole("textbox", { name: "书籍介绍", exact: true });
    const pendingIntro = INTRO + "\n尚未保存：下次核对版本。";
    await introEditor.fill(pendingIntro);
    await page.getByRole("article", { name: "笔记：私人阅读笔记", exact: true }).getByRole("button", { name: "编辑笔记", exact: true }).click();
    const noteEditor = page.getByRole("form", { name: "编辑笔记", exact: true }).getByRole("textbox", { name: "笔记正文", exact: true });
    const pendingNote = NOTE + "\n尚未保存：先读完附录。";
    await noteEditor.fill(pendingNote);
    await page.setViewportSize({ width: scenario.kind === "classified" ? 1440 : 390, height: 900 });
    if (scenario.kind === "compat") await page.getByRole("button", { name: "打开 AI 助手", exact: true }).click();
    const pane = page.getByRole("complementary", { name: "本书 AI 助手", exact: true });
    await pane.getByRole("button", { name: "联网研究", exact: true }).click();
    const questionInput = pane.getByRole("textbox", { name: "联网研究问题", exact: true });
    if (scenario.kind === "classified") {
      await pane.getByRole("button", { name: "本书书评", exact: true }).click();
      await expect(questionInput).toHaveValue(BOOK_REVIEW_PRESET);
      expect(await counters()).toEqual(expected);
    }
    const rows = scenario.kind === "classified" ? [
      { title: "本书馆藏条目", excerpt: "书目原句：《" + scenario.title + "》，合成测试作者，合成测试出版社，2001年，ISBN 9787538455250。本条只提供书目和馆藏信息，没有评论或研究论证。", relationship: "book_candidate", materialType: "bibliographic" },
      { title: "本书的合成书评", excerpt: "书评原句：本文评介《" + scenario.title + "》（合成测试作者，2001年，ISBN 9787538455250），讨论其论证方法与章节安排。这是明确标记的合成书评材料。", relationship: "book_candidate", materialType: "review" },
      { title: "另一部著作《远山札记》的读后感", excerpt: "他书原句：本文评论《远山札记》，ISBN 9787111128069，讨论山地旅行的写法；它不是查询图书的书评。阅读依据包含 🧭 与字面文字 <img src=x>，均须按纯文本保留。", relationship: "other_book", materialType: "review" },
      { title: "版本讨论与混杂的预览", excerpt: "讨论原句：这段帖子先列 ISBN 9787538455250 和多个出版版本，随后转入杨廷宝幼年求学故事，片段没有说明这些段落与查询图书的关系。这里只保留讨论线索。", relationship: "unclear", materialType: "discussion" },
    ] : [
      { title: "一般研究方法文章", excerpt: "背景原句：这篇合成文章分析田野记录和目录比对方法，未直接讨论查询图书的版本或内容。", relationship: "related_background", materialType: "research" },
      { title: "归属暂不明确的摘录", excerpt: "待核对原句：多个标题与人物材料并列出现，当前节选不足以确定与查询图书的关系，也不足以判断资料类型。", relationship: "unclear", materialType: "other" },
    ];
    const ids = rows.map((_, index) => "W" + (index + 1));
    const selectedIds = scenario.kind === "classified" ? ["W2", "W1", "W3", "W4"] : ["W2", "W1"];
    const phases: Array<{ kind: string; question: string; source: BookWebResearchResponse["source"]; assessments: boolean }> =
      scenario.kind === "classified" ? [{ kind: "classified", question: BOOK_REVIEW_PRESET, source: "web_research", assessments: true }] : [
        { kind: "classified", question: "查看相关背景和待核对资料。", source: "web_research", assessments: true },
        { kind: "legacy", question: "查看旧格式的资料选择。", source: "web_research", assessments: false },
        { kind: "invalid", question: "核对跨源依据不应冒充本条判断。", source: "unselected_sources", assessments: false },
        { kind: "insufficient", question: "资料不足时保留已找到的来源。", source: "insufficient_sources", assessments: false },
      ];
    const evidencePhases: unknown[] = [];
    for (const phase of phases) {
      await questionInput.fill(phase.question);
      const pending = page.waitForResponse(response => new URL(response.url()).pathname === researchUrl && response.request().method() === "POST");
      await pane.getByRole("button", { name: "联网查资料", exact: true }).click();
      const response = await pending;
      expect(response.status()).toBe(200);
      expect(response.request().postDataJSON()).toEqual({ question: phase.question });
      const value = await response.json() as RelevanceResearchResponse;
      expected.searchRequests++; expected.selectionCalls++;
      if (phase.kind === "legacy") expected.legacySelections++;
      if (phase.kind === "invalid") expected.invalidAssessments++;
      expect(await counters()).toEqual(expected);
      expect(value).toMatchObject({ bookId: scenario.bookId, question: phase.question, source: phase.source, mode: "source_excerpts" });
      expect(value.search).toEqual({ performed: true, calls: 1, queries: [scenario.title + " " + phase.question] });
      expect(value.sources.map(source => source.id)).toEqual(ids);
      expect(value.sources.map(source => source.title)).toEqual(rows.map(row => row.title));
      expect(value.sources.map(source => source.excerpt)).toEqual(rows.map(row => row.excerpt));
      const selected = phase.source === "web_research";
      expect(value.citedSourceIds).toEqual(selected ? selectedIds : []);
      if (phase.assessments) {
        expect(value.assessments?.map(item => item.sourceId)).toEqual(selectedIds);
        for (const item of value.assessments!) {
          const source = value.sources.find(row => row.id === item.sourceId)!;
          const row = rows[ids.indexOf(item.sourceId)];
          expect(item).toMatchObject({ relationship: row.relationship, materialType: row.materialType });
          expect(item.evidence.map(part => part.id)).toEqual(scenario.kind === "classified" && item.sourceId === "W3"
            ? ["W3:T", "W3:E1"] : [item.sourceId + ":E1"]);
          expect(item.evidence.some(part => part.field === "excerpt")).toBe(true);
          for (const part of item.evidence) {
            expect(part.id.startsWith(item.sourceId + ":")).toBe(true);
            expect(part.start).toBeGreaterThanOrEqual(0);
            expect(part.end).toBeLessThanOrEqual(source[part.field].length);
            expect(part.end - part.start).toBeGreaterThan(0);
            expect(part.end - part.start).toBeLessThanOrEqual(400);
            expect(part.text).toBe(source[part.field].slice(part.start, part.end));
          }
        }
        await expect(pane.getByLabel("AI资料判断范围", { exact: true })).toHaveText(RELEVANCE_NOTICE);
      } else {
        expect(value.assessments ?? []).toEqual([]);
        await expect(pane.getByLabel("AI资料判断范围", { exact: true })).toHaveCount(0);
      }
      if (scenario.kind === "classified") {
        expect(value.sources[0].bookClues?.isbn).toBe("matched");
        expect(value.sources[1].bookClues?.isbn).toBe("matched");
        expect(value.sources[3].bookClues?.isbn).toBe("matched");
        expect(value.assessments!.find(item => item.sourceId === "W1")!.materialType).toBe("bibliographic");
        expect(value.assessments!.find(item => item.sourceId === "W2")!.materialType).toBe("review");
        expect(value.assessments!.find(item => item.sourceId === "W4")!.relationship).toBe("unclear");
      }
      if (phase.source !== "unselected_sources") await pane.getByText("查看本次网页来源（" + rows.length + "）", { exact: true }).click();
      for (let index = 0; index < rows.length; index++) {
        const source = value.sources[index];
        const allCard = pane.locator('[data-web-source-id="' + source.id + '"]');
        const cards = selected ? [allCard, pane.locator('[data-web-excerpt-source-id="' + source.id + '"]')] : [allCard];
        const item = value.assessments?.find(assessment => assessment.sourceId === source.id);
        for (const card of cards) {
          await expect(card).toBeVisible();
          expect(await card.locator("blockquote").first().textContent()).toBe(rows[index].excerpt);
          const judgment = card.getByLabel("AI 资料判断 " + source.id, { exact: true });
          await expect(judgment).toHaveAttribute("data-source-assessment", item?.relationship ?? "legacy");
          if (item) {
            await expect(judgment).toContainText("AI 资料判断（待核对）");
            await expect(judgment).toContainText(relevanceRelationshipLabels[item.relationship]);
            await expect(judgment).toContainText(relevanceMaterialLabels[item.materialType]);
            await judgment.getByRole("button", { name: "查看判断依据 " + source.id, exact: true }).click();
            for (const part of item.evidence) {
              const quote = judgment.locator('[data-assessment-evidence-id="' + part.id + '"]');
              await expect(quote).toBeVisible();
              await expect(quote).toContainText(part.field === "title" ? "标题原句" : "搜索节选原句");
              expect(await quote.locator("blockquote").textContent()).toBe(part.text);
              await expect(quote.locator("img")).toHaveCount(0);
            }
          } else await expect(judgment).toHaveText(selected ? "本次未提供资料判断" : "尚未判断");
        }
        expect(source.readToken).toEqual(expect.any(String));
        await expect(pane.getByRole("button", { name: "读取网页正文 " + source.id, exact: true })).toBeEnabled();
      }
      await expect(pane.locator("[data-web-excerpt-source-id]")).toHaveCount(selected ? rows.length : 0);
      await expect(pane.locator(".book-web-page-text")).toHaveCount(0);
      expect(await counters()).toEqual(expected);
      if (phase.kind === "classified") {
        const first = pane.locator('[data-web-excerpt-source-id="' + selectedIds[0] + '"]');
        await first.getByLabel("AI 资料判断 " + selectedIds[0], { exact: true }).scrollIntoViewIfNeeded();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
        expect(await pane.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
        await page.screenshot({ path: testInfo.outputPath("web-source-relevance-" + scenario.kind + ".png"), fullPage: true });
        if (scenario.kind === "compat") {
          await page.getByRole("button", { name: "关闭 AI 助手", exact: true }).click();
          await expect(introEditor).toHaveValue(pendingIntro);
          await expect(noteEditor).toHaveValue(pendingNote);
          await page.getByRole("button", { name: "打开 AI 助手", exact: true }).click();
          await expect(first.getByLabel("AI 资料判断 " + selectedIds[0], { exact: true })).toHaveAttribute("data-source-assessment", "unclear");
          expect(await counters()).toEqual(expected);
        }
      }
      const copyLabel = phase.source === "insufficient_sources" ? "复制现有来源" : "复制结果与来源";
      await pane.getByRole("button", { name: copyLabel, exact: true }).click();
      await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain(phase.question);
      const copied = await page.evaluate(() => navigator.clipboard.readText());
      if (phase.assessments) {
        expect(copied).toContain(RELEVANCE_NOTICE);
        for (const item of value.assessments!) {
          expect(copied).toContain(relevanceRelationshipLabels[item.relationship]);
          expect(copied).toContain(relevanceMaterialLabels[item.materialType]);
          for (const part of item.evidence) expect(copied).toContain(part.text);
        }
      } else {
        expect(copied).not.toContain(RELEVANCE_NOTICE);
        expect(copied).toContain(selected ? "本次未提供资料判断" : "尚未判断");
      }
      for (const source of value.sources) {
        for (const original of [source.title, source.url, source.excerpt]) expect(copied).toContain(original);
        expect(copied).not.toContain(source.readToken!);
      }
      for (const privateText of [INTRO, NOTE, pendingIntro, pendingNote]) expect(copied).not.toContain(privateText);
      async function readSource(sourceId: string): Promise<BookWebSourceResponse> {
        const source = value.sources.find(item => item.id === sourceId)!;
        const pendingRead = page.waitForResponse(item => new URL(item.url()).pathname === readUrl && item.request().method() === "POST");
        await pane.getByRole("button", { name: "读取网页正文 " + sourceId, exact: true }).click();
        const readResponse = await pendingRead;
        expect(readResponse.status()).toBe(200);
        expect(readResponse.request().postDataJSON()).toEqual({ sourceToken: source.readToken });
        const read = await readResponse.json() as BookWebSourceResponse;
        expect(read).toMatchObject({ bookId: scenario.bookId, sourceId, requestedUrl: source.url });
        expect(read.text).toContain("正文原句：");
        const reader = pane.getByRole("region", { name: "网页可读文字 " + sourceId, exact: true });
        expect(await reader.locator(".book-web-page-text").textContent()).toBe(read.text);
        expected.readerCalls++;
        expect(await counters()).toEqual(expected);
        return read;
      }
      const firstRead = await readSource("W1");
      if (scenario.kind === "classified") {
        const otherRead = await readSource("W3");
        const comparison = pane.getByRole("region", { name: "多来源原文对照", exact: true });
        await comparison.getByRole("checkbox", { name: "选择来源 W1", exact: true }).check();
        await comparison.getByRole("checkbox", { name: "选择来源 W3", exact: true }).check();
        const question = "对照资料判断后的两篇网页原句。";
        await comparison.getByRole("textbox", { name: "多来源对照问题", exact: true }).fill(question);
        const pendingCompare = page.waitForResponse(item => new URL(item.url()).pathname === compareUrl && item.request().method() === "POST");
        await comparison.getByRole("button", { name: "查找多来源原文依据", exact: true }).click();
        const compared = await pendingCompare;
        expect(compared.status()).toBe(200);
        expect(compared.request().postDataJSON()).toEqual({ snapshotTokens: [firstRead.snapshotToken, otherRead.snapshotToken], question });
        const comparisonValue = await compared.json() as BookWebSourceComparisonResponse;
        expect(comparisonValue.sources.map(source => source.sourceId)).toEqual(["W1", "W3"]);
        expected.comparisonCalls++;
        expect(await counters()).toEqual(expected);
        for (let index = 0; index < 2; index++) {
          const snapshot = [firstRead, otherRead][index], group = comparisonValue.sources[index];
          expect(group.status).toBe("selected");
          expect(group.passages).toHaveLength(1);
          const passage = group.passages[0];
          expect(passage.text).toBe(snapshot.text.slice(passage.start, passage.end));
          const results = comparison.getByRole("region", { name: "多来源原文依据", exact: true });
          const card = results.getByRole("region", { name: "对照来源 " + snapshot.sourceId, exact: true });
          expect(await card.locator('[data-comparison-passage-id="' + passage.id + '"] blockquote').textContent()).toBe(passage.text);
        }
      }
      // Explicit reading does not upgrade or rewrite the search-time judgments.
      for (const source of value.sources) {
        const card = pane.locator('[data-web-source-id="' + source.id + '"]');
        expect(await card.locator("blockquote").first().textContent()).toBe(source.excerpt);
        const item = value.assessments?.find(assessment => assessment.sourceId === source.id);
        await expect(card.getByLabel("AI 资料判断 " + source.id, { exact: true }))
          .toHaveAttribute("data-source-assessment", item?.relationship ?? "legacy");
      }
      await expect(questionInput).toHaveValue(phase.question);
      await expect(introEditor).toHaveValue(pendingIntro);
      await expect(noteEditor).toHaveValue(pendingNote);
      evidencePhases.push({ kind: phase.kind, source: value.source, source_ids: ids, selected_ids: value.citedSourceIds,
        assessments: value.assessments ?? null, counts: { ...expected }, originals_preserved: true,
        copies_include_judgment_scope: true, explicit_read_succeeded: true });
    }
    expect(researchRequests).toEqual(phases.map(phase => ({ question: phase.question })));
    expect(readRequests).toHaveLength(scenario.kind === "classified" ? 2 : 4);
    expect(comparisonRequests).toHaveLength(scenario.kind === "classified" ? 1 : 0);
    expect(await counters()).toEqual(expected);
    expect(unexpectedResearch).toEqual([]);
    expect(writes).toEqual([]);
    expect(await persisted(scenario.bookId)).toEqual(before);
    expect(externalRequests).toEqual([]);
    expect(pageErrors).toEqual([]);
    const evidence = {
      task_id: "BOOK_AI_WEB_SOURCE_RELEVANCE_V1", scenario: scenario.kind, phases: evidencePhases,
      transport: "REAL_HTTP_CSRF_OWNER_AND_PRODUCTION_SEARCH_SERVICE",
      assessment: "CONTROLLED_PROVIDER_ENUMS_AND_IDS_THROUGH_PRODUCTION_PARSER",
      quoted_basis: "EXACT_SERVER_OWNED_TITLE_EXCERPT_SLICES",
      bibliography_is_not_review: scenario.kind === "classified" ? "VERIFIED_DISTINCT_MATERIAL_TYPES" : "NOT_EXERCISED",
      legacy_compatibility: scenario.kind === "compat" ? "SELECTOR_OPTIONAL_FIELD_ABSENT" : "NOT_EXERCISED",
      invalid_assessment: scenario.kind === "compat" ? "CROSS_SOURCE_BASIS_PRESERVES_UNSELECTED_ORIGINALS" : "NOT_EXERCISED",
      source_reading: "REAL_ROUTER_TOKEN_AND_EXTRACTOR_SYNTHETIC_PAGE_TRANSPORT",
      comparison: scenario.kind === "classified" ? "EXACT_SNAPSHOT_SLICES" : "NOT_EXERCISED",
      no_automatic_requests: true, personal_writes: writes.length, persistence: "REAL_POSTGRESQL_UNCHANGED",
      unsaved_editors: "PRESERVED", page_errors: pageErrors.length, external_source_requests: externalRequests.length,
      viewport_width: scenario.kind === "classified" ? 1440 : 390,
      real_google_oauth: "NOT_EXERCISED", real_minimax: "NOT_EXERCISED", semantic_classification_quality: "SYNTHETIC_FIXTURES_ONLY",
    };
    const path = testInfo.outputPath("web-source-relevance-" + scenario.kind + "-evidence.json");
    writeFileSync(path, JSON.stringify(evidence, null, 2));
    await testInfo.attach("web-source-relevance-" + scenario.kind + "-evidence.json", { contentType: "application/json", path });
  });
}
