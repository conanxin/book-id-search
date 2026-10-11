/**
 * Real Chromium → signed owner session + CSRF → production book AI collector,
 * parser and router. Only the model provider is deterministic. AI stays in a
 * read-only sidebar; only the separate manual editors may write to PostgreSQL.
 * The second journey delays actual local responses to exercise stale delivery.
 */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { expect, test, type BrowserContext, type Page, type Response as BrowserResponse, type TestInfo } from "@playwright/test";
import { issueWebSession } from "../apps/api/src/auth/web-session.js";
import type { BookAssistantResponse } from "../apps/api/src/ai/book-assistant.js";
import type { BookWorkspace } from "../apps/api/src/s32/domain/book-library.js";
import { createPostgresBookLibraryStore } from "../apps/api/src/s32/postgres/book-library-store.js";
import { createPostgresWereadBindingStore } from "../apps/api/src/weread/manual-bindings-store.js";
import { getBookAiBrowserFixtureKey, getBookBrowserCatalogIds } from "./book-browser-fixtures.js";

const WEB = "http://127.0.0.1:5173";
const fixtureKey = getBookAiBrowserFixtureKey(process.env.BOOK_LIBRARY_BROWSER_RUN_ID!);
const { A, B } = getBookBrowserCatalogIds(fixtureKey);
const TITLE_A = `AI 阅读验证甲 ${fixtureKey}`, TITLE_B = `AI 阅读验证乙 ${fixtureKey}`;
const INTRO_A = "甲书已保存介绍：古道连接山口与聚落，考察时应区分地形证据和后出的地方传说。";
const INTRO_B = "乙书独有介绍：河流渡口与集镇的形成。乙书内容不能进入甲书草稿。";
const NOTE_A_TITLE = "甲书田野笔记";
const NOTE_A = "甲书独立笔记：先核对山口、旧驿站和道路坡度，再安排沿线步行。";
const NOTE_B = "乙书独有笔记：比较古渡口迁移与集市变化，不能当作甲书记录。";
const RESOURCE_URL = "https://example.test/book-ai-electronic-version.pdf";
const RESOURCE_NOTE = "电子版仅登记，正文没有提供给 AI。";
const LOGIN_TITLE = "登录后，继续整理这本书与阅读资料";
const apiRequire = createRequire(new URL("../apps/api/package.json", import.meta.url));
const { Pool } = apiRequire("pg");
const endpoint = (id: string) => `/api/ai/books/${id}/assistant`;
const workspaceEndpoint = (id: string) => `/api/private/s32/library/books/${id}`;
const assistant = (page: Page) => page.getByRole("complementary", { name: "本书 AI 助手", exact: true });
const aiResult = (page: Page) => assistant(page).getByRole("region", { name: "AI 参考结果", exact: true });
const generationResponse = (id: string) => (response: BrowserResponse) =>
  new URL(response.url()).pathname === endpoint(id) && response.request().method() === "POST";

async function ownerSession(context: BrowserContext) {
  const { token } = issueWebSession({ sub: "book-library-test-owner", name: "合成验证账号", email: "library-test@example.test" }, {
    secret: "book-library-synthetic-session-secret-for-local-ci-only",
  });
  await context.addCookies([{ name: "book_id_search_session_dev", value: token, url: WEB, httpOnly: true, sameSite: "Lax" }]);
}

async function csrfHeaders(page: Page) {
  const response = await page.request.get("/api/auth/session");
  expect(response.ok()).toBe(true);
  const session = await response.json();
  expect(session.authenticated).toBe(true);
  return { Origin: WEB, "X-CSRF-Token": session.csrfToken as string };
}

async function persistedWorkspace(id: string): Promise<BookWorkspace | null> {
  // New connection and production store on every read distinguish persistence
  // from a frontend state change or an in-process API cache.
  const pool = new Pool({ connectionString: process.env.S32_LIBRARY_TEST_DATABASE_URL });
  try { return await createPostgresBookLibraryStore(pool).get(id); }
  finally { await pool.end(); }
}

async function seedBook(page: Page, id: string, introduction: string, title: string, content: string) {
  const headers = await csrfHeaders(page);
  expect((await page.request.put(workspaceEndpoint(id), { headers, data: { introduction, baseVersion: 0 } })).ok()).toBe(true);
  const created = await page.request.post(`${workspaceEndpoint(id)}/notes`, { headers, data: { title, content } });
  expect(created.ok()).toBe(true);
  return (await created.json()).item as BookWorkspace;
}

async function evidence(testInfo: TestInfo, network: string) {
  await testInfo.attach("book-ai-verification-scope.json", {
    body: JSON.stringify({
      task: "BOOK_AI_READONLY_SIDEBAR",
      catalog: "isolated synthetic AI book pair; independent of the previous eight journeys",
      sources: "production collector reads real PG workspaces and effective WeRead data from synthetic imported snapshots",
      provider: "deterministic chatCompletion injection; production prompt and response parsing retained",
      externalMiniMax: "NOT_EXERCISED", externalWeRead: "NOT_CONTACTED", actualGoogleOAuth: "NOT_EXERCISED",
      authentication: "real signed Google owner session, CSRF and production mounted signOut",
      persistence: "zero library writes from repeated AI generation, source inspection, copy and clear; independent new Pool/store reads",
      manualEditing: "unsaved introduction and note editors survive AI use; only their own save buttons persist changes",
      sourceReading: "actual sidebar citation link returns to the existing focused note; copied result includes source excerpts",
      layout: "desktop sidebar is beside the article; mobile opens and closes without horizontal overflow",
      network,
    }, null, 2), contentType: "application/json",
  });
}

async function generate(page: Page, id: string, action: "introduction" | "notes_summary" | "question", question?: string) {
  const pane = assistant(page);
  const mode = { introduction: "参考介绍", notes_summary: "笔记摘要", question: "资料问答" }[action];
  const button = { introduction: "生成参考介绍", notes_summary: "生成笔记摘要", question: "根据资料回答" }[action];
  await pane.getByRole("button", { name: mode, exact: true }).click();
  if (action === "question") await pane.getByRole("textbox", { name: "想问这本书的问题", exact: true }).fill(question!);
  const responsePromise = page.waitForResponse(generationResponse(id));
  await pane.getByRole("button", { name: button, exact: true }).click();
  const response = await responsePromise;
  expect(response.ok()).toBe(true);
  expect(response.request().postDataJSON()).toEqual({ action, ...(action === "question" ? { question } : {}) });
  const value = await response.json() as BookAssistantResponse;
  expect(value).toMatchObject({ bookId: id, action, question: action === "question" ? question : null, source: "ai" });
  await expect(aiResult(page)).toBeVisible();
  await expect(aiResult(page)).toContainText(value.draft.content);
  await expect(aiResult(page).locator("textarea, input, [contenteditable=true]")).toHaveCount(0);
  await expect(pane.getByRole("textbox", { name: "AI 草稿正文", exact: true })).toHaveCount(0);
  await expect(pane.getByRole("textbox", { name: "AI 笔记标题", exact: true })).toHaveCount(0);
  await expect(pane.getByRole("button", { name: /保存为书籍介绍|保存为新笔记/ })).toHaveCount(0);
  return value;
}

async function copyResult(page: Page, value: BookAssistantResponse) {
  await page.evaluate(() => navigator.clipboard.writeText("BOOK_AI_COPY_NOT_STARTED"));
  await assistant(page).getByRole("button", { name: "复制结果与来源", exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain(`生成时间：${value.generatedAt}`);
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain(value.draft.content);
  expect(copied).toContain("### 参考资料（生成时摘录）");
  expect(copied).toContain(`生成时间：${value.generatedAt}`);
  if (value.question) expect(copied).toContain(`问题：${value.question}`);
  for (const id of value.citedSourceIds) {
    const source = value.sources.find(item => item.id === id)!;
    expect(copied).toContain(`[${id}]`);
    expect(copied).toContain(source.href);
    expect(copied).toContain(source.excerpt.split(/\r?\n/).map(line => `> ${line}`).join("\n"));
  }
}

test("book AI sidebar reads saved sources and copies references without changing saved content or open manual editors", async ({ page, context }, testInfo) => {
  await evidence(testInfo, "REAL_LOCAL_API; no response mocking; only deterministic model injection");
  const errors: string[] = [];
  const electronicRequests: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => { if (request.url() === RESOURCE_URL) electronicRequests.push(request.url()); });
  expect(await (await page.request.get("/api/health")).json()).toMatchObject({
    persistence: "postgresql", runtimeRole: "s32_app",
    bookAssistant: { sources: "production_collector", provider: "deterministic_injected", externalMiniMax: "NOT_EXERCISED" },
  });
  await ownerSession(context);
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: WEB });
  expect(await persistedWorkspace(A)).toBeNull();
  expect(await persistedWorkspace(B)).toBeNull();
  const seeded = await seedBook(page, A, INTRO_A, NOTE_A_TITLE, NOTE_A);
  await seedBook(page, B, INTRO_B, "乙书独有笔记", NOTE_B);
  expect((await page.request.post(`${workspaceEndpoint(A)}/resources`, {
    headers: await csrfHeaders(page), data: { label: "AI 验收电子版外链", url: RESOURCE_URL, notes: RESOURCE_NOTE },
  })).ok()).toBe(true);

  // The source-B override is persisted with the same production store used by
  // management. The collector must use this effective relation on every call.
  const bindingPool = new Pool({ connectionString: process.env.S32_LIBRARY_TEST_DATABASE_URL });
  try {
    await createPostgresWereadBindingStore(bindingPool).write({
      wereadBookId: `synthetic-weread-${fixtureKey}-b`, mode: "bind", catalogId: A, expectedRevision: 0,
    });
  } finally { await bindingPool.end(); }
  const before = await persistedWorkspace(A);
  const beforeOther = await persistedWorkspace(B);
  const writes: string[] = [];
  page.on("request", request => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/api/private/s32/library/") && ["PUT", "POST", "PATCH", "DELETE"].includes(request.method())) writes.push(`${request.method()} ${path}`);
  });
  await page.goto(`/books/${A}`);
  await expect(page.getByRole("heading", { name: TITLE_A, exact: true })).toBeVisible();
  const introduction = page.getByRole("region", { name: "我的补充介绍", exact: true });
  const sourceNote = page.getByRole("article", { name: `笔记：${NOTE_A_TITLE}`, exact: true });
  await expect(introduction).toContainText(INTRO_A);
  await expect(sourceNote).toContainText(NOTE_A);

  // The sidebar is a sibling of the reading article, not another content editor.
  const article = page.locator(".book-detail-layout > article.detail");
  await expect(article).toBeVisible();
  await expect(assistant(page)).toBeVisible();
  expect(await assistant(page).evaluate(element => element.parentElement?.classList.contains("book-detail-layout"))).toBe(true);
  const articleBox = (await article.boundingBox())!;
  const sidebarBox = (await assistant(page).boundingBox())!;
  expect(sidebarBox.x).toBeGreaterThanOrEqual(articleBox.x + articleBox.width);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);

  const introductionAddition = "尚未保存的人工介绍：先标记山口，再核对旧图。";
  const noteAddition = "尚未保存的人工笔记：下次补拍驿站遗址。";
  const manualIntroduction = `${INTRO_A}\n\n${introductionAddition}`;
  const manualNoteTitle = `${NOTE_A_TITLE} · 人工编辑`;
  const manualNoteContent = `${NOTE_A}\n\n${noteAddition}`;
  await introduction.getByRole("button", { name: "编辑介绍", exact: true }).click();
  const introductionEditor = introduction.getByRole("textbox", { name: "书籍介绍", exact: true });
  await introductionEditor.fill(manualIntroduction);
  await sourceNote.getByRole("button", { name: "编辑笔记", exact: true }).click();
  const noteEditor = page.getByRole("form", { name: "编辑笔记", exact: true });
  await noteEditor.getByRole("textbox", { name: "笔记标题", exact: true }).fill(manualNoteTitle);
  await noteEditor.getByRole("textbox", { name: "笔记正文", exact: true }).fill(manualNoteContent);

  async function expectPersonalContentUntouched() {
    expect(writes).toEqual([]);
    expect(await persistedWorkspace(A)).toEqual(before);
    expect(await persistedWorkspace(B)).toEqual(beforeOther);
    await expect(introductionEditor).toHaveValue(manualIntroduction);
    await expect(noteEditor.getByRole("textbox", { name: "笔记标题", exact: true })).toHaveValue(manualNoteTitle);
    await expect(noteEditor.getByRole("textbox", { name: "笔记正文", exact: true })).toHaveValue(manualNoteContent);
    await expect(sourceNote).toContainText(NOTE_A);
  }

  const generated = await generate(page, A, "introduction");
  expect(generated.context).toMatchObject({ workspaceVersion: 1, introductionIncluded: true, notesAvailable: 1, notesIncluded: 1, wereadAvailable: 30, wereadEnabled: true });
  expect(generated.context.wereadIncluded).toBeGreaterThan(0);
  expect(generated.sources.filter(source => source.kind === "weread")).toHaveLength(generated.context.wereadIncluded);
  expect(generated.sources.find(source => source.kind === "introduction")?.excerpt).toBe(INTRO_A);
  expect(generated.sources.find(source => source.kind === "note")).toMatchObject({ excerpt: NOTE_A, revisionId: seeded.notes[0].currentRevisionId });
  expect(generated.sources.find(source => source.kind === "catalog")?.excerpt).toContain(TITLE_A);
  for (const forbidden of [INTRO_B, NOTE_B, TITLE_B, RESOURCE_URL, RESOURCE_NOTE, introductionAddition, manualNoteTitle, noteAddition, "synthetic-weread-", "synthetic-private-note-"]) {
    expect(JSON.stringify(generated)).not.toContain(forbidden);
  }
  expect(generated.citedSourceIds.length).toBeGreaterThan(0);
  for (const id of generated.citedSourceIds) {
    const source = generated.sources.find(item => item.id === id)!;
    expect(source).toBeDefined();
    expect(generated.draft.content).toContain(`[${id}]`);
    expect(source.contentHash).toBe(createHash("sha256").update(source.excerpt, "utf8").digest("hex"));
    await assistant(page).getByRole("button", { name: `查看依据 ${id}`, exact: true }).click();
    const row = assistant(page).locator(`[data-ai-source-id="${id}"]`);
    await expect(row).toBeVisible();
    await expect(row.getByRole("link").first()).toHaveAttribute("href", source.href);
    await expect(row).toContainText(source.excerpt);
  }
  await copyResult(page, generated);
  await expectPersonalContentUntouched();
  await page.screenshot({ path: testInfo.outputPath("book-ai-readonly-sidebar-desktop.png"), fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(assistant(page)).toBeHidden();
  const openAssistant = page.getByRole("button", { name: "打开 AI 助手", exact: true });
  await expect(openAssistant).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await openAssistant.click();
  await expect(assistant(page)).toBeVisible();
  await expect(aiResult(page)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("book-ai-readonly-sidebar-mobile-open.png") });
  await copyResult(page, generated);
  await page.getByRole("button", { name: "关闭 AI 助手", exact: true }).click();
  await expect(assistant(page)).toBeHidden();
  await expect(openAssistant).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("book-ai-readonly-sidebar-mobile-closed.png") });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(assistant(page)).toBeVisible();
  await expectPersonalContentUntouched();

  // Regeneration keeps reading the original saved introduction, never the last
  // AI answer or either open manual draft.
  const regenerated = await generate(page, A, "introduction");
  expect(regenerated.sources.find(source => source.kind === "introduction")?.excerpt).toBe(INTRO_A);
  expect(regenerated.context.workspaceVersion).toBe(1);
  await expectPersonalContentUntouched();
  const summary = await generate(page, A, "notes_summary");
  expect(summary.context).toMatchObject({ workspaceVersion: 1, notesAvailable: 1, notesIncluded: 1, wereadAvailable: 30 });
  expect(summary.sources.find(source => source.kind === "note")?.excerpt).toBe(NOTE_A);
  await copyResult(page, summary);

  // Follow the actual source link without changing or submitting either editor.
  const personalSource = summary.sources.find(source => source.kind === "note")!;
  const sourcePath = `/books/${A}#book-note-${seeded.notes[0].noteId}`;
  expect(personalSource.href).toBe(sourcePath);
  expect(summary.citedSourceIds).toContain(personalSource.id);
  await assistant(page).getByRole("button", { name: `查看依据 ${personalSource.id}`, exact: true }).click();
  await assistant(page).locator(`[data-ai-source-id="${personalSource.id}"]`).getByRole("link").first().click();
  await expect(page).toHaveURL(sourcePath);
  await expect(sourceNote).toBeFocused();
  await expect(sourceNote).toBeInViewport();
  await sourceNote.screenshot({ path: testInfo.outputPath("book-ai-note-source-target.png") });
  await expectPersonalContentUntouched();
  await assistant(page).getByRole("button", { name: "清除结果", exact: true }).click();
  await expect(aiResult(page)).toHaveCount(0);
  await expectPersonalContentUntouched();

  // Only the independent human editors can commit the text entered above.
  const introSave = page.waitForResponse(response => new URL(response.url()).pathname === workspaceEndpoint(A) && response.request().method() === "PUT");
  await introduction.getByRole("button", { name: "保存介绍", exact: true }).click();
  const savedIntro = await introSave;
  expect(savedIntro.ok()).toBe(true);
  expect(savedIntro.request().postDataJSON()).toEqual({ introduction: manualIntroduction, baseVersion: 1 });
  await expect(introduction.getByText("书籍介绍已保存。", { exact: true })).toBeVisible();
  expect(await persistedWorkspace(A)).toMatchObject({ introduction: manualIntroduction, version: 2, notes: before!.notes });
  await expect(noteEditor.getByRole("textbox", { name: "笔记正文", exact: true })).toHaveValue(manualNoteContent);

  const notePath = `${workspaceEndpoint(A)}/notes/${seeded.notes[0].noteId}`;
  const noteSave = page.waitForResponse(response => new URL(response.url()).pathname === notePath && response.request().method() === "PUT");
  await noteEditor.getByRole("button", { name: "保存笔记", exact: true }).click();
  const savedNote = await noteSave;
  expect(savedNote.ok()).toBe(true);
  expect(savedNote.request().postDataJSON()).toEqual({
    title: manualNoteTitle, content: manualNoteContent, baseRevisionId: seeded.notes[0].currentRevisionId,
  });
  const persisted = await persistedWorkspace(A);
  expect(persisted?.introduction).toBe(manualIntroduction);
  expect(persisted?.notes).toHaveLength(1);
  expect(persisted?.notes[0]).toMatchObject({ noteId: seeded.notes[0].noteId, title: manualNoteTitle, content: manualNoteContent, revisionNo: 2 });
  expect(persisted?.resources).toEqual(before?.resources);
  expect(await persistedWorkspace(B)).toEqual(beforeOther);
  expect(writes).toEqual([`PUT ${workspaceEndpoint(A)}`, `PUT ${notePath}`]);
  await page.reload();
  await expect(introduction).toContainText(manualIntroduction);
  await expect(page.getByRole("article", { name: `笔记：${manualNoteTitle}`, exact: true })).toContainText(manualNoteContent);
  await expect(aiResult(page)).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("book-ai-manual-content-after-reload.png"), fullPage: true });
  expect(electronicRequests).toEqual([]);
  expect(errors).toEqual([]);
});

// Deliberately ignore AbortSignal only for delivery of an actual local AI
// response, so cleanup is proven even when transport cancellation is ignored.
async function holdAssistantDelivery(page: Page) {
  await page.addInitScript(({ path }) => {
    const original = window.fetch.bind(window);
    const pending: Array<() => void> = [];
    const control = { pending: 0, release: () => { for (const deliver of pending.splice(0)) deliver(); control.pending = 0; } };
    (window as typeof window & { __bookAiDelivery: typeof control }).__bookAiDelivery = control;
    window.fetch = (input, init) => {
      const value = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (new URL(value, window.location.origin).pathname === path && init?.method === "POST") {
        return original(input, { ...init, signal: undefined }).then(response => new Promise<Response>(resolve => {
          pending.push(() => resolve(response)); control.pending = pending.length;
        }));
      }
      return original(input, init);
    };
  }, { path: endpoint(A) });
}

async function waitForHeld(page: Page) {
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __bookAiDelivery?: { pending: number } }).__bookAiDelivery?.pending)).toBe(1);
}

async function releaseHeld(page: Page) {
  await page.evaluate(async () => {
    (window as typeof window & { __bookAiDelivery?: { release: () => void } }).__bookAiDelivery?.release();
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
  });
}

test("book AI rejects forged inputs and delayed results cannot survive cancellation, book navigation or sign-out", async ({ page, context }, testInfo) => {
  await evidence(testInfo, "SYNTHETIC_DELIVERY_DELAY; real local generation response held across cancel, SPA navigation and signOut; abort deliberately ignored");
  const errors: string[] = [];
  const writes: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/api/private/s32/library/") && ["PUT", "POST", "PATCH", "DELETE"].includes(request.method())) writes.push(`${request.method()} ${path}`);
  });
  const beforeA = await persistedWorkspace(A), beforeB = await persistedWorkspace(B);
  expect((await page.request.post(endpoint(A), { data: { action: "introduction" } })).status()).toBe(401);
  await page.goto(`/books/${A}`);
  await expect(page.getByRole("heading", { name: LOGIN_TITLE })).toBeVisible();
  await expect(assistant(page)).toHaveCount(0);
  await ownerSession(context);
  expect((await page.request.post(endpoint(A), {
    headers: { Origin: WEB, "X-CSRF-Token": "invalid-synthetic-csrf" }, data: { action: "introduction" },
  })).status()).toBe(403);
  expect((await page.request.post(endpoint(A), {
    headers: await csrfHeaders(page), data: { action: "question", question: "请根据本书资料回答。", sources: [{ id: "S1", excerpt: "客户端伪造资料" }] },
  })).status()).toBe(400);
  await holdAssistantDelivery(page);
  await page.goto(`/books/${A}`);
  await assistant(page).getByRole("button", { name: "资料问答", exact: true }).click();
  await assistant(page).getByRole("textbox", { name: "想问这本书的问题", exact: true }).fill("取消后不应显示这次参考结果。");
  await assistant(page).getByRole("button", { name: "根据资料回答", exact: true }).click();
  await waitForHeld(page);
  await assistant(page).getByRole("button", { name: "取消生成", exact: true }).click();
  await releaseHeld(page);
  await expect(aiResult(page)).toHaveCount(0);
  await expect(assistant(page).getByRole("button", { name: "根据资料回答", exact: true })).toBeEnabled();

  await assistant(page).getByRole("textbox", { name: "想问这本书的问题", exact: true }).fill("甲书下一次田野应该核对什么？");
  await assistant(page).getByRole("button", { name: "根据资料回答", exact: true }).click();
  await waitForHeld(page);
  await page.getByRole("link", { name: `查看 ${TITLE_B} 详情`, exact: true }).click();
  await expect(page.getByRole("heading", { name: TITLE_B, exact: true })).toBeVisible();
  await expect(assistant(page)).toBeVisible();
  await releaseHeld(page);
  await expect(aiResult(page)).toHaveCount(0);
  await expect(assistant(page)).not.toContainText(INTRO_A);
  await expect(assistant(page)).not.toContainText(NOTE_A);
  const other = await generate(page, B, "question", "这本书现有资料提到了哪些线索？");
  const otherNotes = await page.request.get(`/api/private/weread/notes?catalogId=${B}&limit=20`);
  expect(otherNotes.ok()).toBe(true);
  expect(other.context.wereadAvailable).toBe((await otherNotes.json()).pageInfo.total);
  expect(other.sources.find(source => source.kind === "catalog")?.excerpt).toContain(TITLE_B);
  expect(JSON.stringify(other)).not.toContain(TITLE_A);
  expect(JSON.stringify(other)).not.toContain(INTRO_A);
  expect(JSON.stringify(other)).not.toContain(NOTE_A);

  await page.getByRole("link", { name: `查看 ${TITLE_A} 详情`, exact: true }).click();
  await assistant(page).getByRole("button", { name: "资料问答", exact: true }).click();
  await assistant(page).getByRole("textbox", { name: "想问这本书的问题", exact: true }).fill("甲书还有什么线索需要继续阅读？");
  await assistant(page).getByRole("button", { name: "根据资料回答", exact: true }).click();
  await waitForHeld(page);
  const signedOut = page.waitForResponse(response => new URL(response.url()).pathname === "/api/auth/logout" && response.request().method() === "POST");
  await page.evaluate(async () => {
    const sessionModule = "/src/auth/session.ts";
    await (await import(sessionModule)).signOut();
  });
  expect((await signedOut).status()).toBe(204);
  await expect(page.getByRole("heading", { name: LOGIN_TITLE })).toBeVisible();
  await releaseHeld(page);
  await expect(assistant(page)).toHaveCount(0);
  await expect(page.getByText(INTRO_A, { exact: true })).toHaveCount(0);
  await expect(page.getByText(NOTE_A, { exact: true })).toHaveCount(0);
  expect((await page.request.post(endpoint(A), { data: { action: "introduction" } })).status()).toBe(401);
  expect(await persistedWorkspace(A)).toEqual(beforeA);
  expect(await persistedWorkspace(B)).toEqual(beforeB);
  expect(writes).toEqual([]);
  expect(errors).toEqual([]);
});
