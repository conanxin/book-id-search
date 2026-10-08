/**
 * Gate 4 Task 4: actual Chromium, actual API/session, disposable PG16.
 * Only the orchestrator owns disposable services. Never accesses production.
 */
import { execFileSync } from "node:child_process";
import { expect, test, type Browser, type Page } from "@playwright/test";
const WEB = process.env.GATE4_BROWSER_WEB ?? "http://127.0.0.1:5173";
const COOKIE = process.env.GATE4_BROWSER_SESSION_COOKIE!;
const CONTAINER = process.env.GATE4_BROWSER_CONTAINER!;
const DB_NAME = process.env.GATE4_BROWSER_DB_NAME ?? "s32_m3a_gate4_browser";
const DB_USER = process.env.GATE4_BROWSER_DB_USER ?? "s32browser";
const P1 = "11111111-1111-4111-8111-111111111111";
const I1 = "21111111-1111-4111-8111-111111111111";
const I_EMPTY = "25111111-1111-4111-8111-111111111111";
const I2 = "22111111-1111-4111-8111-111111111111";
const PA = "13111111-1111-4111-8111-111111111111";
const IA = "23111111-1111-4111-8111-111111111111";
const SOURCE = "61111111-1111-4111-8111-111111111111";
const EDITION_BINDING = "81111111-1111-4111-8111-111111111111";
const RUN_PENDING_KEY = "book-id-search:s32-m3a-research-run-action-v1";
function psql(sql: string) {
  return execFileSync("docker", [
    "--host", "unix:///var/run/docker.sock", "exec", "-i", CONTAINER,
    "psql", "-X", "-U", DB_USER, "-d", DB_NAME, "-Atc", sql,
  ], { encoding: "utf8", timeout: 120_000 }).trim();
}
function dossierUrl(projectId: string, issueId: string) {
  return WEB + "/research/projects/" + projectId + "/issues/" + issueId + "/dossier";
}
async function owner(browser: Browser, viewport?: { width: number; height: number }) {
  const context = await browser.newContext(viewport ? { viewport } : {});
  const [name, value] = COOKIE.split("=");
  await context.addCookies([{ name, value, url: WEB }]);
  return context;
}
function collectWrites(page: Page) {
  const domainWrites: string[] = [];
  page.on("request", request => {
    if (request.url().includes("/api/private/s32/") && request.method() !== "GET") {
      domainWrites.push(request.method() + " " + request.url());
    }
  });
  return domainWrites;
}
async function activeDossier(page: Page) {
  await page.goto(dossierUrl(P1, I1));
  await expect(page.getByRole("heading", { name: "Gate2 Open Issue" })).toBeVisible({ timeout: 25_000 });
  await expect(page.locator("#dossier-current")).toContainText("Gate2 working conclusion", { timeout: 20_000 });
  await expect(page.locator("#dossier-runs .dossier-item")).toHaveCount(20, { timeout: 20_000 });
}
test.describe.configure({ mode: "serial" });

test("A — owner session and anonymous private isolation", async ({ browser }) => {
  const ctx = await owner(browser);
  const page = await ctx.newPage();
  await activeDossier(page);
  const session = await page.evaluate(async () => (await fetch("/api/auth/session")).json());
  expect(session.authenticated).toBe(true);
  expect(typeof session.csrfToken).toBe("string");
  await ctx.close();

  const anon = await browser.newContext();
  const page2 = await anon.newPage();
  await page2.goto(dossierUrl(P1, I1));
  await expect(page2.locator(".research-access")).toContainText("使用 Google 账号登录", { timeout: 20_000 });
  await expect(page2.getByText("Gate2 working conclusion")).toHaveCount(0);
  const response = await page2.request.get(WEB + "/api/private/s32/projects/" + P1 + "/issues/" + I1);
  expect(response.status()).toBe(401);
  await anon.close();
});

test("B — Current outside first history page, exact paging and separate timelines", async ({ browser }) => {
  const ctx = await owner(browser);
  const page = await ctx.newPage();
  const writes = collectWrites(page);
  const runsBefore = psql("SELECT COUNT(*) FROM core.research_runs");
  const resBefore = psql("SELECT COUNT(*) FROM core.issue_resolutions");
  await activeDossier(page);
  const history = page.locator("#dossier-history");
  await expect(history.locator(".dossier-item")).toHaveCount(20);
  await expect(history).not.toContainText("Gate2 working conclusion");
  await history.getByRole("button", { name: "加载更多" }).click();
  await expect(history.locator(".dossier-item")).toHaveCount(25, { timeout: 20_000 });
  await expect(history).toContainText("Gate2 working conclusion");
  const current = page.locator("#dossier-current");
  await expect(current).toContainText("采用一个可能答案");
  await current.getByRole("button", { name: "读取完整理由" }).click();
  await expect(current).toContainText("Gate2 working conclusion");
  const runs = page.locator("#dossier-runs");
  await runs.getByRole("button", { name: "加载更多" }).click();
  await expect(runs.locator(".dossier-item")).toHaveCount(24, { timeout: 20_000 });
  const timeline = page.locator("#dossier-change");
  await expect(timeline).toContainText("D01-A");
  await expect(timeline).toContainText("同一毫秒内跨类型记录不推断先后");
  await expect(timeline).toContainText("已完成于");
  expect(await timeline.locator("ol").count()).toBe(2);
  expect(writes).toEqual([]);
  expect(psql("SELECT COUNT(*) FROM core.research_runs")).toBe(runsBefore);
  expect(psql("SELECT COUNT(*) FROM core.issue_resolutions")).toBe(resBefore);
  await test.info().attach("gate4-populated-dossier.png", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
  await ctx.close();
});

test("C — existing pending Run action receipt cannot escape read-only Dossier", async ({ browser }) => {
  const ctx = await owner(browser);
  const receipt = JSON.stringify({
    projectId: P1, issueId: I1, runId: "e4000000-0000-4000-8000-000000000001", action: "CANCEL",
    requestHash: "a".repeat(64), idempotencyKey: "88888888-8888-4888-8888-888888888888",
    createdAt: "2026-10-09T01:02:03.123Z", command: { output: null },
  });
  await ctx.addInitScript(([key, value]) => { window.sessionStorage.setItem(key, value); }, [RUN_PENDING_KEY, receipt]);
  const page = await ctx.newPage();
  const writes = collectWrites(page);
  const count = psql("SELECT COUNT(*) FROM core.research_runs");
  await activeDossier(page);
  await page.locator("#dossier-runs .dossier-item").first().getByRole("button", { name: "只读查看轮次详情" }).click();
  await expect(page.locator("#dossier-runs .dossier-detail")).toContainText("Gate4 研究轮次", { timeout: 20_000 });
  await expect(page.locator("#dossier-runs .dossier-detail")).toContainText("Gate4 terminal summary");
  await expect(page.locator("#dossier-runs .dossier-detail")).not.toContainText(SOURCE);
  expect(await page.evaluate(key => sessionStorage.getItem(key), RUN_PENDING_KEY)).toBe(receipt);
  await page.reload();
  await expect(page.locator("#dossier-runs .dossier-item")).toHaveCount(20, { timeout: 20_000 });
  expect(await page.evaluate(key => sessionStorage.getItem(key), RUN_PENDING_KEY)).toBe(receipt);
  expect(writes).toEqual([]);
  expect(psql("SELECT COUNT(*) FROM core.research_runs")).toBe(count);
  await ctx.close();
});

test("D — empty and archived Issue Dossiers remain read-only", async ({ browser }) => {
  const ctx = await owner(browser);
  const page = await ctx.newPage();
  const writes = collectWrites(page);
  await page.goto(dossierUrl(P1, I_EMPTY));
  await expect(page.getByRole("heading", { name: "Gate4 Empty Dossier" })).toBeVisible({ timeout: 25_000 });
  await expect(page.locator("#dossier-current")).toContainText("尚未形成当前工作结论", { timeout: 20_000 });
  await expect(page.locator("#dossier-claims")).toContainText("当前没有可见的可能答案");
  await expect(page.locator("#dossier-runs")).toContainText("还没有研究轮次");
  await page.goto(dossierUrl(PA, IA));
  await expect(page.getByRole("heading", { name: "Gate3 Archived Issue" })).toBeVisible({ timeout: 25_000 });
  await expect(page.locator(".dossier-header")).toContainText("已归档 · 只读");
  await expect(page.locator("#dossier-runs .dossier-item")).toHaveCount(1, { timeout: 20_000 });
  await page.locator("#dossier-runs .dossier-item").first().getByRole("button", { name: "只读查看轮次详情" }).click();
  await expect(page.locator("#dossier-runs .dossier-detail")).toContainText("归档范围历史目标", { timeout: 20_000 });
  expect(await page.getByRole("button", { name: /标记完成|取消研究轮次|重放研究轮次|开始新的研究轮次/ }).count()).toBe(0);
  expect(writes).toEqual([]);
  await ctx.close();
});

test("E — foreign Issue is neutral 404 without private content", async ({ browser }) => {
  const ctx = await owner(browser);
  const page = await ctx.newPage();
  await page.goto(dossierUrl(P1, I2));
  await expect(page.getByRole("alert")).toContainText("研究问题不存在，或不属于当前项目", { timeout: 20_000 });
  expect(await page.getByText("Gate2 Foreign Issue").count()).toBe(0);
  const response = await page.request.get(WEB + "/api/private/s32/projects/" + P1 + "/issues/" + I2);
  expect(response.status()).toBe(404);
  await ctx.close();
});

test("F — revocation removes unavailable Run evidence without target-ID reconstruction", async ({ browser }) => {
  const ctx = await owner(browser);
  const page = await ctx.newPage();
  await activeDossier(page);
  const before = psql("SELECT COUNT(*) FROM core.research_runs");
  await expect(page.locator("#dossier-history .dossier-item").first()).toContainText("证据当前可用");
  psql("DELETE FROM core.project_bindings WHERE id='" + EDITION_BINDING + "'");
  await page.getByRole("button", { name: "刷新整个档案" }).click();
  await expect(page.locator("#dossier-runs .dossier-item").first()).toContainText("当前不可展开", { timeout: 20_000 });
  await expect(page.locator("#dossier-history .dossier-item").first()).toContainText("证据未指定或不可展开");
  await expect(page.locator("#dossier-history")).toContainText("Gate4 historical Resolution #24");
  await page.locator("#dossier-runs .dossier-item").first().getByRole("button", { name: "只读查看轮次详情" }).click();
  await expect(page.locator("#dossier-runs .dossier-detail")).toContainText("当前不可展开原始证据条目", { timeout: 20_000 });
  await expect(page.locator("#dossier-runs .dossier-detail")).not.toContainText(SOURCE);
  expect(psql("SELECT COUNT(*) FROM core.research_runs")).toBe(before);
  // Restore only the fixture material's binding inside the disposable database.
  psql("INSERT INTO core.project_bindings (id, project_id, target_type, target_id, binding_role, metadata) VALUES " +
    "('" + EDITION_BINDING + "', '" + P1 + "', 'EDITION', '51111111-1111-4111-8111-111111111111', NULL, " +
    "'{\"sourceId\":\"61111111-1111-4111-8111-111111111111\"}'::jsonb)");
  await ctx.close();
});

test("G — network failure in Resolution reader is explicit and retryable", async ({ browser }) => {
  const ctx = await owner(browser);
  const page = await ctx.newPage();
  let failOnce = true;
  await page.route(/\/resolutions(?:\?.*)?$/, async route => {
    if (failOnce) { failOnce = false; await route.abort("failed"); }
    else await route.continue();
  });
  await page.goto(dossierUrl(P1, I1));
  await expect(page.getByRole("heading", { name: "Gate2 Open Issue" })).toBeVisible({ timeout: 25_000 });
  await expect(page.locator("#dossier-current")).toContainText("当前工作结论读取失败", { timeout: 15_000 });
  await page.locator("#dossier-history").getByRole("button", { name: "重试读取" }).click();
  await expect(page.locator("#dossier-current")).toContainText("Gate2 working conclusion", { timeout: 20_000 });
  await ctx.close();
});

test("H — 390px viewport, keyboard opening and scope switch wipe old content", async ({ browser }) => {
  const ctx = await owner(browser, { width: 390, height: 844 });
  const page = await ctx.newPage();
  await activeDossier(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  await page.locator("#dossier-runs .dossier-item").first().getByRole("button", { name: "只读查看轮次详情" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#dossier-runs .dossier-detail")).toContainText("Gate4 研究轮次", { timeout: 20_000 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  await page.goto(dossierUrl(P1, I_EMPTY));
  await expect(page.locator("#dossier-current")).toContainText("尚未形成当前工作结论", { timeout: 20_000 });
  await expect(page.getByText("Gate2 working conclusion")).toHaveCount(0);
  await test.info().attach("gate4-mobile-empty.png", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
  await ctx.close();
});

test("I — actual Issue navigation opens the authorized Dossier route", async ({ browser }) => {
  const ctx = await owner(browser);
  const page = await ctx.newPage();
  await page.goto(WEB + "/research/projects/" + P1 + "/issues/" + I1);
  await expect(page.getByRole("heading", { name: "Gate2 Open Issue" })).toBeVisible({ timeout: 25_000 });
  const entry = page.getByRole("link", { name: "查看研究档案（只读）" });
  await expect(entry).toBeVisible();
  await entry.click();
  await expect(page).toHaveURL(dossierUrl(P1, I1));
  await expect(page.locator("#dossier-current")).toContainText("Gate2 working conclusion", { timeout: 20_000 });
  await ctx.close();
});

test("J — malformed Run success becomes section 502, retry keeps Current intact", async ({ browser }) => {
  const ctx = await owner(browser);
  const page = await ctx.newPage();
  let corruptOnce = true;
  await page.route(/\/runs(?:\?.*)?$/, async route => {
    if (corruptOnce) {
      corruptOnce = false;
      await route.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ runs: "invalid", nextCursor: null }) });
    } else {
      await route.continue();
    }
  });
  await page.goto(dossierUrl(P1, I1));
  await expect(page.getByRole("heading", { name: "Gate2 Open Issue" })).toBeVisible({ timeout: 25_000 });
  await expect(page.locator("#dossier-runs")).toContainText("读取失败（502）", { timeout: 20_000 });
  await expect(page.locator("#dossier-current")).toContainText("Gate2 working conclusion", { timeout: 20_000 });
  await page.locator("#dossier-runs").getByRole("button", { name: "重试读取" }).click();
  await expect(page.locator("#dossier-runs .dossier-item")).toHaveCount(20, { timeout: 20_000 });
  await ctx.close();
});

test("K — signing out clears the Dossier subtree, never exposing private Issue data", async ({ browser }) => {
  const ctx = await owner(browser);
  const page = await ctx.newPage();
  const domainWrites = collectWrites(page);
  await activeDossier(page);
  await page.getByRole("button", { name: "退出登录" }).click();
  await expect(page.getByRole("heading", { name: "Gate2 Open Issue" })).toHaveCount(0, { timeout: 20_000 });
  await expect(page.getByText("Gate2 working conclusion")).toHaveCount(0);
  const response = await ctx.request.get(WEB + "/api/private/s32/projects/" + P1 + "/issues/" + I1);
  expect(response.status()).toBe(401);
  expect(domainWrites).toEqual([]);
  await ctx.close();
});
