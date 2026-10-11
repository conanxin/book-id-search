/**
 * Real Chromium → signed Google-owner session + CSRF → production binding
 * router/service → real PostgreSQL as s32_app. Catalog and imported WeRead
 * snapshots are synthetic. This spec is excluded from the local no-PG mode.
 */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { expect, test, type BrowserContext, type Page, type Response as BrowserResponse } from "@playwright/test";
import { issueWebSession } from "../apps/api/src/auth/web-session.js";
import { createPostgresWereadBindingStore, type WereadBindingMode } from "../apps/api/src/weread/manual-bindings-store.js";
import { getBookBrowserCatalogIds } from "./book-browser-fixtures.js";

const WEB = "http://127.0.0.1:5173";
const runId = process.env.BOOK_LIBRARY_BROWSER_RUN_ID!;
const { A, B } = getBookBrowserCatalogIds(runId);
const TITLE_A = "古道阅读验证甲 " + runId, TITLE_B = "古道阅读验证乙 " + runId;
const SOURCE_A = "合成微信读书甲", SOURCE_B = "合成微信读书乙";
const rawSourceA = "synthetic-weread-" + runId + "-a";
const rawSourceB = "synthetic-weread-" + runId + "-b";
const sourceKey = createHash("sha256").update(rawSourceA).digest("hex");
const endpoint = "/api/private/weread/bindings/" + sourceKey;
const apiRequire = createRequire(new URL("../apps/api/package.json", import.meta.url));
const { Pool } = apiRequire("pg");
const sourceRow = (page: Page) => page.getByRole("region", { name: "微信读书书籍关联", exact: true })
  .getByRole("article", { name: SOURCE_A, exact: true });
const editor = (page: Page) => page.getByRole("region", { name: "核对《" + SOURCE_A + "》的关联", exact: true });

type Transition = {
  action: "bind" | "unbind" | "restore";
  target: string | null;
  revision: number;
  origin: "manual" | "unlinked" | "imported";
  label: "确认关联" | "确认更换" | "确认解除" | "确认恢复";
};
type Note = { catalogId: string | null; matched: boolean; text: string };

async function ownerSession(context: BrowserContext) {
  const { token } = issueWebSession({ sub: "book-library-test-owner", name: "合成验证账号", email: "library-test@example.test" }, {
    secret: "book-library-synthetic-session-secret-for-local-ci-only",
  });
  await context.addCookies([{ name: "book_id_search_session_dev", value: token, url: WEB, httpOnly: true, sameSite: "Lax" }]);
}

async function csrfHeaders(page: Page) {
  const session = await page.request.get("/api/auth/session");
  expect(session.ok()).toBe(true);
  const value = await session.json();
  expect(value.authenticated).toBe(true);
  expect(value.csrfToken).toEqual(expect.any(String));
  return { Origin: WEB, "X-CSRF-Token": value.csrfToken as string };
}

async function independentPersistedState(mode: WereadBindingMode, catalogId: string | null, revision: number) {
  // Every check opens another Pool/store. A passing UI reload alone would not
  // distinguish database persistence from state held by the running API.
  const pool = new Pool({ connectionString: process.env.S32_LIBRARY_TEST_DATABASE_URL });
  try {
    const rows = await createPostgresWereadBindingStore(pool).list();
    expect(rows.find(row => row.wereadBookId === rawSourceA)).toMatchObject({ mode, catalogId, revision });
    expect(rows.find(row => row.wereadBookId === rawSourceB)).toBeUndefined();
  } finally { await pool.end(); }
}

function totals(target: string | null) {
  return { a: target === A ? 27 : 0, b: target === B ? 30 : 3, matches: target === null ? 1 : 2 };
}

async function assertEffectiveReaders(page: Page, transition: Transition) {
  const expected = totals(transition.target);
  const headers = await csrfHeaders(page);
  const batchResponse = await page.request.post("/api/private/weread/status/batch", { headers, data: { catalogIds: [A, B] } });
  expect(batchResponse.ok()).toBe(true);
  const batch = await batchResponse.json();
  for (const [id, total, sources] of [[A, expected.a, expected.a ? 1 : 0], [B, expected.b, transition.target === B ? 2 : 1]] as const) {
    const [statusResponse, notesResponse] = await Promise.all([
      page.request.get("/api/private/weread/status?catalogId=" + id),
      page.request.get("/api/private/weread/notes?catalogId=" + id + "&limit=100"),
    ]);
    expect(statusResponse.ok()).toBe(true); expect(notesResponse.ok()).toBe(true);
    const status = await statusResponse.json(), notes = await notesResponse.json();
    expect(status).toMatchObject({ ok: true, catalogId: id, matched: total > 0 });
    if (sources) expect(status.weread).toMatchObject({ matchedRecordsCount: sources, notesSummary: { total } });
    else expect(status.weread).toBeUndefined();
    // Single-book status and search-card batch must describe the same sources.
    const { ok: _ok, ...singleStatus } = status;
    expect(batch.results[id]).toEqual(singleStatus);
    expect(notes).toMatchObject({ ok: true, pageInfo: { total, hasMore: false } });
    expect(notes.items).toHaveLength(total);
    expect(notes.items.every((item: Note) => item.catalogId === id && item.matched)).toBe(true);
    expect(notes.items.filter((item: Note) => item.text.startsWith("甲书"))).toHaveLength(id === transition.target ? 27 : 0);
    expect(notes.items.filter((item: Note) => item.text.startsWith("乙书"))).toHaveLength(id === B ? 3 : 0);
    for (const item of notes.items) {
      expect(item).not.toHaveProperty("wereadBookId");
      expect(item).not.toHaveProperty("noteId");
    }
  }
  const summaryResponse = await page.request.get("/api/private/weread/summary");
  expect(summaryResponse.ok()).toBe(true);
  expect(await summaryResponse.json()).toMatchObject({
    ok: true, booksCount: 2, notesCount: 30, confirmedMatchesCount: expected.matches,
    confirmedWithNotesCount: expected.matches, totalConfirmedNoteRecords: expected.a + expected.b,
  });
  const allNotesResponse = await page.request.get("/api/private/weread/notes?limit=100");
  expect(allNotesResponse.ok()).toBe(true);
  const allNotes = await allNotesResponse.json();
  expect(allNotes.pageInfo.total).toBe(30);
  expect(allNotes.items).toHaveLength(30);
  expect(allNotes.items.filter((item: Note) => item.matched)).toHaveLength(expected.a + expected.b);
  const bindingResponse = await page.request.get(endpoint);
  expect(bindingResponse.ok()).toBe(true);
  const binding = await bindingResponse.json();
  expect(binding).toMatchObject({ ok: true, writable: true, item: {
    sourceKey, origin: transition.origin, revision: transition.revision, importedCatalogId: A, notesCount: 27,
  } });
  if (transition.target) expect(binding.item.effectiveCatalog).toMatchObject({ id: transition.target, available: true });
  else expect(binding.item.effectiveCatalog).toBeNull();
  expect(JSON.stringify(binding)).not.toContain(rawSourceA);
  const mode = transition.action === "restore" ? "inherit" : transition.action;
  await independentPersistedState(mode, mode === "bind" ? transition.target : null, transition.revision);
}

async function searchCards(page: Page, target: string | null) {
  // All navigation before this assertion is via React links, so a manual
  // mutation must invalidate the already populated search-status cache.
  await page.getByRole("navigation", { name: "主导航", exact: true }).getByRole("link", { name: "搜书", exact: true }).click();
  await page.getByPlaceholder("搜索书名、作者、出版社、ISBN、SSID、DXID").fill(runId);
  await page.getByRole("button", { name: "开始搜索", exact: true }).click();
  const a = page.getByRole("article").filter({ has: page.getByRole("heading", { name: TITLE_A, exact: true }) });
  const b = page.getByRole("article").filter({ has: page.getByRole("heading", { name: TITLE_B, exact: true }) });
  await expect(a).toBeVisible(); await expect(b).toBeVisible();
  // B always has its own source. Wait for its badge before asserting that A's
  // badge is absent, otherwise the loading state could produce a false pass.
  await expect(b.getByLabel("微信读书已匹配", { exact: true })).toBeVisible();
  await expect(a.getByLabel("微信读书已匹配", { exact: true })).toHaveCount(target === A ? 1 : 0);
}

async function openManager(page: Page) {
  await page.getByRole("navigation", { name: "主导航", exact: true }).getByRole("link", { name: "微信读书", exact: true }).click();
  await page.getByRole("link", { name: "管理书籍关联", exact: true }).click();
  await expect(page).toHaveURL("/weread/bindings");
  await expect(sourceRow(page)).toBeVisible();
}

function notesFor(id: string) {
  return (response: BrowserResponse) => {
    const url = new URL(response.url());
    return url.pathname === "/api/private/weread/notes" && url.searchParams.get("catalogId") === id
      && Number(url.searchParams.get("offset") ?? 0) === 0;
  };
}

async function bookViews(page: Page, target: string | null) {
  const count = totals(target);
  for (const [id, title, total] of [[A, TITLE_A, count.a], [B, TITLE_B, count.b]] as const) {
    const response = page.waitForResponse(notesFor(id));
    await page.getByRole("link", { name: "查看 " + title + " 详情", exact: true }).click();
    const value = await response;
    expect(value.ok()).toBe(true);
    expect(await value.json()).toMatchObject({ ok: true, pageInfo: { total } });
    await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
    const region = page.getByRole("region", { name: "微信读书记录", exact: true });
    await expect(region.getByRole("article")).toHaveCount(Math.min(total, 20));
    if (total) {
      const highlights = id === A ? 22 : target === B ? 23 : 1;
      await expect(page.getByText("划线 " + highlights, { exact: true })).toBeVisible();
    } else {
      await expect(page.getByText("在读", { exact: true })).toHaveCount(0);
    }
    await expect(page.getByText("多记录匹配", { exact: true })).toHaveCount(id === B && target === B ? 1 : 0);
  }
}

async function mutateFromUi(page: Page, transition: Transition) {
  const row = sourceRow(page);
  if (transition.revision === 1) {
    await row.getByRole("button", { name: "确认现有关联", exact: true }).click();
  } else if (transition.action === "bind") {
    await row.getByRole("button", { name: "更换关联", exact: true }).click();
    await editor(page).getByRole("searchbox", { name: "搜索目录书籍", exact: true }).fill(TITLE_B);
    await editor(page).getByRole("button", { name: "搜索目录", exact: true }).click();
    await editor(page).getByRole("button", { name: "选择《" + TITLE_B + "》", exact: true }).click();
  } else {
    await row.getByRole("button", { name: transition.action === "unbind" ? "解除关联" : "恢复导入匹配", exact: true }).click();
  }
  const saved = page.waitForResponse(response => new URL(response.url()).pathname === endpoint && response.request().method() === "PUT");
  await editor(page).getByRole("button", { name: transition.label, exact: true }).click();
  const response = await saved;
  expect(response.request().postDataJSON()).toEqual({
    action: transition.action, expectedRevision: transition.revision - 1,
    ...(transition.action === "bind" ? { catalogId: transition.target } : {}),
  });
  expect(response.ok()).toBe(true);
  expect(await response.json()).toMatchObject({ ok: true, writable: true, item: { revision: transition.revision, origin: transition.origin } });
  await expect(editor(page)).toHaveCount(0);
}

test("binding management rejects anonymous and invalid-CSRF writes without changing imported links", async ({ page, context }) => {
  expect((await page.request.get("/api/private/weread/bindings")).status()).toBe(401);
  expect((await page.request.get(endpoint)).status()).toBe(401);
  expect((await page.request.put(endpoint, { data: { action: "bind", catalogId: B, expectedRevision: 0 } })).status()).toBe(401);
  await page.goto("/weread/bindings");
  await expect(page.getByRole("link", { name: "使用 Google 登录", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "微信读书书籍关联", exact: true })).toHaveCount(0);
  await ownerSession(context);
  await page.reload();
  await expect(sourceRow(page)).toBeVisible();
  const before = await page.request.get(endpoint);
  expect(before.ok()).toBe(true);
  const baseline = await before.json();
  expect(baseline).toMatchObject({ ok: true, writable: true, item: { origin: "imported", revision: 0, effectiveCatalog: { id: A } } });
  const denied = await page.request.put(endpoint, {
    headers: { Origin: WEB, "X-CSRF-Token": "invalid-synthetic-csrf" },
    data: { action: "bind", catalogId: B, expectedRevision: 0 },
  });
  expect(denied.status()).toBe(403);
  expect(await (await page.request.get(endpoint)).json()).toEqual(baseline);
});

test("real PG bindings: confirm, move, unlink and restore keep book notes, search badges, summaries and persisted revisions consistent", async ({ page, context }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await testInfo.attach("weread-bindings-verification-scope.json", {
    body: JSON.stringify({
      task: "BOOK_CENTERED_WEREAD_MANUAL_BINDING_V1",
      catalog: "two synthetic books; distinct SSID and DXID",
      importedWeread: "synthetic read-only snapshots; A has 27 records, B has 3",
      writes: "production binding router and effective-data service; real PostgreSQL as s32_app",
      persistence: "separate new Pool/store reads after every write plus browser reloads",
      authentication: "real signed owner session and CSRF; production signOut while management is mounted",
      actualGoogleOAuth: "NOT_EXERCISED", externalWeread: "NOT_CONTACTED", responseMocking: "NONE",
    }, null, 2), contentType: "application/json",
  });
  expect(await (await page.request.get("/api/health")).json()).toMatchObject({
    persistence: "postgresql", wereadBindingsPersistence: "postgresql", runtimeRole: "s32_app",
  });
  await ownerSession(context);
  await page.goto("/");
  let currentTarget: string | null = A;
  const transitions: Transition[] = [
    { action: "bind", target: A, revision: 1, origin: "manual", label: "确认关联" },
    { action: "bind", target: B, revision: 2, origin: "manual", label: "确认更换" },
    { action: "unbind", target: null, revision: 3, origin: "unlinked", label: "确认解除" },
    { action: "restore", target: A, revision: 4, origin: "imported", label: "确认恢复" },
  ];
  for (const transition of transitions) {
    await searchCards(page, currentTarget);
    await openManager(page);
    await mutateFromUi(page, transition);
    await assertEffectiveReaders(page, transition);
    if (transition.revision === 1) {
      const stale = await page.request.put(endpoint, {
        headers: await csrfHeaders(page), data: { action: "bind", catalogId: B, expectedRevision: 0 },
      });
      expect(stale.status()).toBe(409);
      await independentPersistedState("bind", A, 1);
    }
    await searchCards(page, transition.target);
    await bookViews(page, transition.target);
    await openManager(page);
    await page.reload();
    const origin = { manual: "手动确认", unlinked: "手动解除", imported: "导入匹配" }[transition.origin];
    await expect(sourceRow(page).getByText(origin, { exact: true })).toBeVisible();
    if (transition.target) await expect(sourceRow(page).getByRole("link", { name: transition.target === A ? TITLE_A : TITLE_B, exact: true }))
      .toHaveAttribute("href", "/books/" + transition.target);
    else await expect(sourceRow(page).getByRole("link")).toHaveCount(0);
    if (transition.revision === 2) {
      await page.screenshot({ path: testInfo.outputPath("manual-binding-two-sources-to-book-b.png"), fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath("manual-binding-mobile.png"), fullPage: true });
      await page.setViewportSize({ width: 1440, height: 1000 });
    }
    currentTarget = transition.target;
  }
  await expect(page.getByRole("article", { name: SOURCE_B, exact: true }).getByText("导入匹配", { exact: true })).toBeVisible();
  const signedOut = page.waitForResponse(response => new URL(response.url()).pathname === "/api/auth/logout" && response.request().method() === "POST");
  await page.evaluate(async () => {
    const sessionModule = "/src/auth/session.ts";
    await (await import(sessionModule)).signOut();
  });
  expect((await signedOut).status()).toBe(204);
  await expect(page.getByRole("region", { name: "微信读书书籍关联", exact: true })).toHaveCount(0);
  await expect(page.getByText(SOURCE_A, { exact: true })).toHaveCount(0);
  expect((await page.request.get(endpoint)).status()).toBe(401);
  expect((await page.request.get("/api/private/weread/notes?catalogId=" + A)).status()).toBe(401);
  expect((await page.request.put(endpoint, { data: { action: "unbind", expectedRevision: 4 } })).status()).toBe(401);
  await independentPersistedState("inherit", null, 4);
  expect(errors).toEqual([]);
});
