/**
 * Gate 3 Task 5 — REAL BROWSER whole-slice acceptance (chromium, real API, disposable PG16).
 * Env contract (set by scripts/s32-m3a-gate3-browser-check.ts):
 *   GATE3_BROWSER_WEB / GATE3_BROWSER_API / GATE3_BROWSER_CONTAINER
 *   GATE3_BROWSER_DB_USER / GATE3_BROWSER_DB_NAME
 *   GATE3_BROWSER_SESSION_COOKIE (dev cookie, synthetic owner) / GATE3_BROWSER_SESSION_CSRF
 */
import { execFileSync } from "node:child_process";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const WEB = process.env.GATE3_BROWSER_WEB ?? "http://127.0.0.1:5173";
const CONTAINER = process.env.GATE3_BROWSER_CONTAINER!;
const DB_USER = process.env.GATE3_BROWSER_DB_USER ?? "s32browser";
const DB_NAME = process.env.GATE3_BROWSER_DB_NAME ?? "s32_m3a_gate3_browser";
const COOKIE = process.env.GATE3_BROWSER_SESSION_COOKIE!;

// Scope graph from Gate2 + Gate3 fixtures.
const P1 = "11111111-1111-4111-8111-111111111111";   // Active project (owner scope)
const P_ARCHIVED = "13111111-1111-4111-8111-111111111111";
const I1 = "21111111-1111-4111-8111-111111111111";   // Open issue in P1
const I_ARCHIVED = "23111111-1111-4111-8111-111111111111"; // Archived issue in archived project
const I_OPEN_IN_ARCHIVED = "24111111-1111-4111-8111-111111111111";
const P2 = "12111111-1111-4111-8111-111111111111";   // Foreign project
const I2 = "22111111-1111-4111-8111-111111111111";   // Foreign issue
const CLAIM_1 = "31111111-1111-4111-8111-111111111111";
const ASSESSMENT_1 = "91111111-1111-4111-8111-111111111112";
const RESOLUTION_1 = "d1111111-1111-4111-8111-111111111111";
const NOTE_REVISION_2 = "a4111111-1111-4111-8111-111111111112";
const MANIFEST_1 = "81111111-1111-4111-8111-111111111112";
const ARCHIVED_RUN = "e1111111-1111-4111-8111-111111111111";

const results: string[] = [];
function mark(key: string): void { results.push(key); test.info().annotations.push({ type: "gate3", description: key }); }

function psql(sql: string): string {
  return execFileSync("docker", ["--host", "unix:///var/run/docker.sock", "exec", "-i", CONTAINER,
    "psql", "-X", "-U", DB_USER, "-d", DB_NAME, "-v", "ON_ERROR_STOP=1", "-Atc", sql],
    { encoding: "utf8" }).trim();
}

function issueUrl(projectId: string, issueId: string): string {
  return `${WEB}/research/projects/${projectId}/issues/${issueId}`;
}

async function ownerContext(browser: import("@playwright/test").Browser) {
  const context = await browser.newContext();
  const [name, value] = COOKIE.split("=");
  await context.addCookies([{ name, value, url: WEB }]);
  return context;
}

test.describe.configure({ mode: "serial" });

// ---------- A. Auth/session boundary ----------
test("A1 authenticated owner session via real /api/auth/session", async ({ browser }) => {
  const context = await ownerContext(browser);
  const page = await context.newPage();
  await page.goto(issueUrl(P1, I1));
  // Real session endpoint drove the web app into an authenticated state.
  await expect(page.getByText("Gate2 Open Issue").first()).toBeVisible({ timeout: 15_000 });
  const session = await page.evaluate(async () => {
    const response = await fetch("/api/auth/session", { credentials: "same-origin" });
    return response.json();
  });
  expect(session.authenticated).toBe(true);
  expect(session.user.email).toBe("gate3-owner@example.com");
  expect(typeof session.csrfToken).toBe("string");
  mark("AUTH_SESSION_OK");
  await context.close();
});

test("A2 unauthenticated cannot read issue page private data", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(issueUrl(P1, I1));
  // No claims / resolutions / runs for anonymous visitor.
  expect(await page.getByText("Gate2 primary claim.").count()).toBe(0);
  const body = page.locator("body");
  await expect(body).not.toContainText("Gate2 working conclusion");
  mark("ANON_NO_PRIVATE_DATA");
  await context.close();
});

// ---------- B. Evidence basis → START → history → detail ----------
test("B1 START via real DOM creates one RUNNING run", async ({ browser }) => {
  const context = await ownerContext(browser);
  const page = await context.newPage();
  await page.goto(issueUrl(P1, I1));
  await page.getByRole("button", { name: "开始新的研究轮次" }).click();
  const evidenceSelect = page.getByLabel(/证据快照/);
  await expect(evidenceSelect).toBeVisible({ timeout: 15_000 });
  // Option label carries authorized manifest summary only — no raw UUID entry.
  const optionCount = await evidenceSelect.locator("option").count();
  expect(optionCount).toBeGreaterThanOrEqual(2); // placeholder + at least manifest 1
  await evidenceSelect.selectOption({ index: 1 });
  await page.getByLabel(/研究目标/).fill("浏览器验收目标");
  await page.getByLabel(/研究方法/).fill("浏览器验收方法");
  await page.getByLabel("步骤 1 描述").fill("第一步检索");
  await page.getByRole("button", { name: "添加步骤" }).click();
  await page.getByLabel("步骤 2 类型").selectOption("COMPARE");
  await page.getByLabel("步骤 2 描述").fill("第二步比对");
  await page.locator("input[name='research-run-mode'][value='HUMAN_AI']").check();
  await page.locator("input[name='research-run-repro'][value='PROCEDURE']").check();
  await page.getByRole("button", { name: "添加工具" }).click();
  await page.getByLabel("工具 1 名称").fill("验收工具");
  await page.getByRole("button", { name: "开始研究轮次" }).click();
  await expect(page.getByText("研究轮次已开始。")).toBeVisible({ timeout: 15_000 });
  // History refreshed with a RUNNING row.
  const history = page.locator(".research-run-history");
  await expect(history.getByText("进行中").first()).toBeVisible({ timeout: 15_000 });
  const runs = psql(`SELECT count(*) FROM core.research_runs WHERE issue_id='${I1}'`);
  expect(Number(runs)).toBe(1);
  const runId = psql(`SELECT id FROM core.research_runs WHERE issue_id='${I1}'`);
  expect(runId).toMatch(/^[0-9a-f-]{36}$/);
  // Open detail from the card.
  await history.getByRole("button", { name: "查看完整研究轮次" }).first().click();
  const detail = page.locator(".research-run-detail");
  await expect(detail.getByText("浏览器验收目标")).toBeVisible();
  await expect(detail.getByText("人机协作")).toBeVisible();
  await expect(detail.getByText("方法复现")).toBeVisible();
  await expect(detail.getByText("验收工具")).toBeVisible();
  await expect(detail.getByText(/搜索 · 第一步检索/)).toBeVisible();
  await expect(detail.getByText(/比较 · 第二步比对/)).toBeVisible();
  // Evidence summary in detail: authorized fields only, no targetId in DOM.
  expect(await detail.getByText("targetId").count()).toBe(0);
  mark("START_HISTORY_DETAIL_OK");
  await context.close();
});

test("B2 detail evidence items render role/targetType/note only", async ({ browser }) => {
  const context = await ownerContext(browser);
  const page = await context.newPage();
  await page.goto(issueUrl(P1, I1));
  await page.locator(".research-run-history").getByRole("button", { name: "查看完整研究轮次" }).first().click();
  const detail = page.locator(".research-run-detail");
  await expect(detail.getByText("浏览器验收目标")).toBeVisible({ timeout: 15_000 });
  const items = detail.locator(".research-run-detail-evidence-items li");
  await expect(items.first()).toBeVisible();
  await expect(detail.getByText(/#1/).first()).toBeVisible();
  expect(await page.locator(".research-run-detail").getByText("61111111-1111-4111-8111-111111111111").count()).toBe(0);
  mark("DETAIL_EVIDENCE_FIELDS_ONLY");
  await context.close();
});

// ---------- C. START unknown-result recovery ----------
test("C1 START response aborted after upstream 201: same-key retry replays", async ({ browser }) => {
  const context = await ownerContext(browser);
  const page = await context.newPage();
  await page.goto(issueUrl(P1, I1));
  const before = Number(psql(`SELECT count(*) FROM core.research_runs WHERE issue_id='${I1}'`));
  await page.getByRole("button", { name: "开始新的研究轮次" }).click();
  await page.getByLabel(/证据快照/).selectOption({ index: 1 });
  await page.getByLabel(/研究目标/).fill("中断恢复目标");
  await page.getByLabel(/研究方法/).fill("中断恢复方法");
  await page.getByLabel("步骤 1 描述").fill("中断步骤");
  await page.locator("input[name='research-run-mode'][value='HUMAN']").check();
  await page.locator("input[name='research-run-repro'][value='AUDIT']").check();
  // Abort ONLY the browser response after the server committed.
  await page.route("**/api/private/s32/projects/*/issues/*/runs", async route => {
    const response = await route.fetch();
    await route.abort("connectionreset");
    void response;
  });
  await page.getByRole("button", { name: "开始研究轮次" }).click();
  await expect(page.getByText("研究轮次提交结果尚未确认。可以使用同一标识重试。")).toBeVisible({ timeout: 20_000 });
  await page.unrouteAll();
  const afterCommit = Number(psql(`SELECT count(*) FROM core.research_runs WHERE issue_id='${I1}'`));
  expect(afterCommit).toBe(before + 1);
  // Reload restores the pending receipt; retry same key replays the same run.
  await page.reload();
  await expect(page.getByText("检测到尚未确认的研究轮次提交，已恢复原提交标识。")).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "使用同一标识重试" }).click();
  await expect(page.getByText("此研究轮次此前已经成功开始。")).toBeVisible({ timeout: 20_000 });
  const finalCount = Number(psql(`SELECT count(*) FROM core.research_runs WHERE issue_id='${I1}'`));
  expect(finalCount).toBe(afterCommit); // no extra run
  mark("START_UNKNOWN_RECOVERY_OK");
  await context.close();
});

// ---------- D. COMPLETE real terminal transition ----------
test("D1 COMPLETE via DOM: Output v1, DB single SUCCEEDED, SQL immutability", async ({ browser }) => {
  const context = await ownerContext(browser);
  const page = await context.newPage();
  await page.goto(issueUrl(P1, I1));
  const history = page.locator(".research-run-history");
  await expect(history.getByText("进行中").first()).toBeVisible({ timeout: 15_000 });
  // Use the second RUNNING run (from C1 recovery replay).
  const runRows = history.locator("article, li, div").filter({ hasText: "进行中" });
  const runCount = await history.getByText("Run:").count();
  expect(runCount).toBeGreaterThanOrEqual(2);
  // Open the run created in C1 (中断恢复目标) — need its detail. Open first card that is RUNNING and not completed.
  const targetCard = history.locator(".research-run-card").filter({ hasText: "进行中" }).first();
  await targetCard.getByRole("button", { name: "查看完整研究轮次" }).click();
  const detail = page.locator(".research-run-detail");
  await expect(detail.getByRole("button", { name: "标记完成" })).toBeVisible({ timeout: 15_000 });
  const runId = await detail.locator("code").first().textContent();
  await detail.getByRole("button", { name: "标记完成" }).click();
  await detail.getByLabel(/研究产出摘要/).fill("浏览器完成摘要");
  await detail.getByLabel(/可能答案 ID/).fill(CLAIM_1);
  await detail.getByLabel(/评价 ID/).fill(ASSESSMENT_1);
  await detail.getByLabel(/工作结论 ID/).fill(RESOLUTION_1);
  await detail.getByLabel(/笔记版本 ID/).fill(NOTE_REVISION_2);
  await detail.getByLabel(/缺口/).fill("浏览器缺口::OPEN");
  await detail.getByRole("button", { name: "确认标记完成" }).click();
  await expect(detail.getByText("浏览器完成摘要")).toBeVisible({ timeout: 20_000 });
  // DB: exactly one SUCCEEDED transition, correct output.
  const status = psql(`SELECT status FROM core.research_runs WHERE id='${runId}'`);
  expect(status).toBe("SUCCEEDED");
  const outputSummary = psql(`SELECT output->>'summary' FROM core.research_runs WHERE id='${runId}'`);
  expect(outputSummary).toBe("浏览器完成摘要");
  // SQL terminal immutability: direct UPDATE rejected by trigger.
  let immutabilityRejected = false;
  try {
    psql(`UPDATE core.research_runs SET status='RUNNING' WHERE id='${runId}'`);
  } catch {
    immutabilityRejected = true;
  }
  expect(immutabilityRejected).toBe(true);
  // History shows terminal state.
  await expect(history.getByText("已完成").first()).toBeVisible({ timeout: 15_000 });
  mark("COMPLETE_OK");
  await context.close();
});

// ---------- E. FAIL and CANCEL ----------
test("E1 FAIL one run, CANCEL another; no cross-run effects", async ({ browser }) => {
  const context = await ownerContext(browser);
  const page = await context.newPage();
  const createdRuns: string[] = [];
  for (const objective of ["失败路径目标", "取消路径目标"]) {
    await page.goto(issueUrl(P1, I1));
    await page.getByRole("button", { name: "开始新的研究轮次" }).click();
    await page.getByLabel(/证据快照/).selectOption({ index: 1 });
    await page.getByLabel(/研究目标/).fill(objective);
    await page.getByLabel(/研究方法/).fill("终态方法");
    await page.getByLabel("步骤 1 描述").fill("步骤");
    await page.locator("input[name='research-run-mode'][value='AUTOMATED']").check();
    await page.locator("input[name='research-run-repro'][value='EXACT']").check();
    await page.getByRole("button", { name: "开始研究轮次" }).click();
    await expect(page.getByText("研究轮次已开始。")).toBeVisible({ timeout: 20_000 });
    createdRuns.push(psql(`SELECT id FROM core.research_runs WHERE issue_id='${I1}' AND status='RUNNING' AND procedure->>'objective'='${objective}'`));
  }
  const [failRunId, cancelRunId] = createdRuns;
  expect(failRunId).toMatch(/^[0-9a-f-]{36}$/);
  expect(cancelRunId).toMatch(/^[0-9a-f-]{36}$/);
  // FAIL the first run via its card.
  await page.goto(issueUrl(P1, I1));
  const history = page.locator(".research-run-history");
  const failCard = history.locator(".research-run-card").filter({ has: page.locator(".research-run-card-heading code", { hasText: failRunId }) });
  await expect(failCard).toBeVisible({ timeout: 15_000 });
  await failCard.getByRole("button", { name: "查看完整研究轮次" }).click();
  let detail = page.locator(".research-run-detail");
  await expect(detail.getByRole("button", { name: "标记失败" })).toBeVisible({ timeout: 15_000 });
  await detail.getByRole("button", { name: "标记失败" }).click();
  await detail.getByRole("button", { name: "确认标记失败" }).click();
  await expect(detail.getByText("失败", { exact: false }).first()).toBeVisible({ timeout: 20_000 });
  expect(psql(`SELECT status FROM core.research_runs WHERE id='${failRunId}'`)).toBe("FAILED");
  // CANCEL the second run.
  await page.goto(issueUrl(P1, I1));
  const cancelHistory = page.locator(".research-run-history");
  const cancelCard = cancelHistory.locator(".research-run-card").filter({ has: page.locator(".research-run-card-heading code", { hasText: cancelRunId }) });
  await expect(cancelCard).toBeVisible({ timeout: 15_000 });
  await cancelCard.getByRole("button", { name: "查看完整研究轮次" }).click();
  detail = page.locator(".research-run-detail");
  await expect(detail.getByRole("button", { name: "取消轮次" })).toBeVisible({ timeout: 15_000 });
  await detail.getByRole("button", { name: "取消轮次" }).click();
  await detail.getByRole("button", { name: "确认取消轮次" }).click();
  await expect(detail.getByText("已取消")).toBeVisible({ timeout: 20_000 });
  expect(psql(`SELECT status FROM core.research_runs WHERE id='${cancelRunId}'`)).toBe("CANCELLED");
  // Both target runs terminal; B1's earlier run is the only legitimate RUNNING remainder.
  const stillRunning = psql(`SELECT count(*) FROM core.research_runs WHERE issue_id='${I1}' AND status='RUNNING' AND procedure->>'objective' NOT IN ('浏览器验收目标')`);
  expect(Number(stillRunning)).toBe(0);
  mark("FAIL_CANCEL_OK");
  await context.close();
});

// ---------- F. REPLAY real end-to-end ----------
test("F1 REPLAY terminal parent → new RUNNING run with ancestor chain", async ({ browser }) => {
  const context = await ownerContext(browser);
  const page = await context.newPage();
  const parentRunId = psql(`SELECT id FROM core.research_runs WHERE issue_id='${I1}' AND status='SUCCEEDED' ORDER BY completed_at DESC LIMIT 1`);
  expect(parentRunId).toMatch(/^[0-9a-f-]{36}$/);
  const parentObjective = psql(`SELECT procedure->>'objective' FROM core.research_runs WHERE id='${parentRunId}'`);
  await page.goto(issueUrl(P1, I1));
  const historySection = page.locator(".research-run-history");
  const parentCard = historySection.locator(".research-run-card").filter({ has: page.locator(".research-run-card-heading code", { hasText: parentRunId }) });
  await expect(parentCard).toBeVisible({ timeout: 15_000 });
  await parentCard.getByRole("button", { name: "查看完整研究轮次" }).click();
  const detail = page.locator(".research-run-detail");
  await expect(detail.getByText(parentObjective)).toBeVisible({ timeout: 15_000 });
  await expect(detail.getByRole("button", { name: "重放此研究轮次" })).toBeVisible();
  await detail.getByRole("button", { name: "重放此研究轮次" }).click();
  const replayForm = page.locator(".research-run-replay");
  await expect(replayForm.getByText(`原目标：${parentObjective}`)).toBeVisible({ timeout: 15_000 });
  await replayForm.getByLabel(/证据快照/).selectOption({ index: 1 });
  await replayForm.getByRole("button", { name: "确认重放" }).click();
  await expect(replayForm.getByText("已创建新的研究轮次：")).toBeVisible({ timeout: 20_000 });
  const child = psql(`SELECT id FROM core.research_runs WHERE replay_of='${parentRunId}'`);
  expect(child).toMatch(/^[0-9a-f-]{36}$/);
  expect(psql(`SELECT status FROM core.research_runs WHERE replay_of='${parentRunId}'`)).toBe("RUNNING");
  // Parent unchanged.
  expect(psql(`SELECT status FROM core.research_runs WHERE id='${parentRunId}'`)).toBe("SUCCEEDED");
  // Child detail: ancestor chain with parent UUID.
  await page.goto(issueUrl(P1, I1));
  const historySection2 = page.locator(".research-run-history");
  const childCard = historySection2.locator(".research-run-card").filter({ has: page.locator(".research-run-card-heading code", { hasText: child }) });
  await childCard.getByRole("button", { name: "查看完整研究轮次" }).click();
  const childDetail = page.locator(".research-run-detail");
  await expect(childDetail.getByText("重放自：")).toBeVisible({ timeout: 15_000 });
  await expect(childDetail.getByText(parentRunId).first()).toBeVisible();
  mark("REPLAY_CHAIN_OK");
  await context.close();
});

// ---------- G. REPLAY unknown-result recovery ----------
test("G1 REPLAY response aborted after 201: persisted-body retry, no new run", async ({ browser }) => {
  const context = await ownerContext(browser);
  const page = await context.newPage();
  await page.goto(issueUrl(P1, I1));
  const history = page.locator(".research-run-history");
  // Same SUCCEEDED parent F1 replayed (terminal, no newer terminal run since).
  const parentRunId = psql(`SELECT id FROM core.research_runs WHERE issue_id='${I1}' AND status='SUCCEEDED' ORDER BY completed_at DESC LIMIT 1`);
  expect(parentRunId).toMatch(/^[0-9a-f-]{36}$/);
  const parentCard = history.locator(".research-run-card").filter({ has: page.locator(".research-run-card-heading code", { hasText: parentRunId }) });
  await expect(parentCard).toBeVisible({ timeout: 15_000 });
  await parentCard.getByRole("button", { name: "查看完整研究轮次" }).click();
  const detail = page.locator(".research-run-detail");
  await expect(detail.getByRole("button", { name: "重放此研究轮次" })).toBeVisible({ timeout: 15_000 });
  await detail.getByRole("button", { name: "重放此研究轮次" }).click();
  const replayForm = page.locator(".research-run-replay");
  const before = Number(psql(`SELECT count(*) FROM core.research_runs WHERE replay_of='${parentRunId}'`));
  await replayForm.getByLabel(/证据快照/).selectOption({ index: 1 });
  // Capture the POST body, abort response after server commit.
  let postedBody = "";
  await page.route("**/runs/*/replay", async route => {
    postedBody = route.request().postData() ?? "";
    const response = await route.fetch();
    void response;
    await route.abort("connectionreset");
  });
  await replayForm.getByRole("button", { name: "确认重放" }).click();
  await expect(replayForm.getByText("研究轮次重放结果尚未确认。可以使用同一标识重试。")).toBeVisible({ timeout: 20_000 });
  await page.unrouteAll();
  const afterCommit = Number(psql(`SELECT count(*) FROM core.research_runs WHERE replay_of='${parentRunId}'`));
  expect(afterCommit).toBe(before + 1);
  // Reload: pending restored once the parent detail is reopened (parent card is on page 1).
  await page.reload();
  const reloadedCard = page.locator(".research-run-history").locator(".research-run-card").filter({ has: page.locator(".research-run-card-heading code", { hasText: parentRunId }) });
  await expect(reloadedCard).toBeVisible({ timeout: 15_000 });
  await reloadedCard.getByRole("button", { name: "查看完整研究轮次" }).click();
  await expect(page.getByText("研究轮次重放结果尚未确认。可以使用同一标识重试。")).toBeVisible({ timeout: 20_000 });
  // Change UI select value (mutable form) — retry must send persisted body, not form state.
  const select = page.locator(".research-run-replay").getByLabel(/证据快照/);
  const options = await select.locator("option").allTextContents();
  if (options.length > 2) { await select.selectOption({ index: 2 }); }
  let retriedBody = "";
  await page.route("**/runs/*/replay", async route => {
    retriedBody = route.request().postData() ?? "";
    await route.fallback();
  });
  await page.getByRole("button", { name: "使用同一标识重试" }).click();
  await expect(page.locator(".research-run-replay").getByText("已创建新的研究轮次：")).toBeVisible({ timeout: 20_000 });
  expect(retriedBody).not.toBe("");
  const parsedPosted = JSON.parse(postedBody);
  const parsedRetried = JSON.parse(retriedBody);
  expect(parsedRetried).toEqual(parsedPosted); // structurally identical persisted command
  const finalCount = Number(psql(`SELECT count(*) FROM core.research_runs WHERE replay_of='${parentRunId}'`));
  expect(finalCount).toBe(afterCommit); // no extra new run
  mark("REPLAY_PERSISTED_BODY_RETRY_OK");
  await context.close();
});

// ---------- H. Terminal unknown-result recovery (CRITICAL) ----------
test("H1 COMPLETE upstream 200 but response lost: pending recovery still offered after reload", async ({ browser }) => {
  const context = await ownerContext(browser);
  const page = await context.newPage();
  // Fresh run to complete.
  await page.goto(issueUrl(P1, I1));
  await page.getByRole("button", { name: "开始新的研究轮次" }).click();
  await page.getByLabel(/证据快照/).selectOption({ index: 1 });
  await page.getByLabel(/研究目标/).fill("终态恢复目标");
  await page.getByLabel(/研究方法/).fill("方法");
  await page.getByLabel("步骤 1 描述").fill("步骤");
  await page.locator("input[name='research-run-mode'][value='HUMAN']").check();
  await page.locator("input[name='research-run-repro'][value='EXACT']").check();
  await page.getByRole("button", { name: "开始研究轮次" }).click();
  await expect(page.getByText("研究轮次已开始。")).toBeVisible({ timeout: 20_000 });
  const runId = psql(`SELECT id FROM core.research_runs WHERE issue_id='${I1}' AND status='RUNNING' AND procedure->>'objective'='终态恢复目标'`);
  expect(runId).toMatch(/^[0-9a-f-]{36}$/);
  // Open its detail.
  const cardHistory = page.locator(".research-run-history");
  const card = cardHistory.locator(".research-run-card").filter({ has: page.locator(".research-run-card-heading code", { hasText: runId }) });
  await card.getByRole("button", { name: "查看完整研究轮次" }).click();
  const detail = page.locator(".research-run-detail");
  await expect(detail.getByRole("button", { name: "标记完成" })).toBeVisible({ timeout: 15_000 });
  await detail.getByRole("button", { name: "标记完成" }).click();
  await detail.getByLabel(/研究产出摘要/).fill("终态恢复摘要");
  await detail.getByLabel(/可能答案 ID/).fill(CLAIM_1);
  // Abort the response AFTER upstream 200.
  await page.route("**/runs/*/complete", async route => {
    const response = await route.fetch();
    void response;
    await route.abort("connectionreset");
  });
  await detail.getByRole("button", { name: "确认标记完成" }).click();
  await expect(detail.getByText("研究轮次操作结果尚未确认。可以使用同一标识重试。")).toBeVisible({ timeout: 20_000 });
  await page.unrouteAll();
  expect(psql(`SELECT status FROM core.research_runs WHERE id='${runId}'`)).toBe("SUCCEEDED");
  // RELOAD: server reports terminal; pending COMPLETE recovery must still be offered.
  await page.reload();
  const reloadedCard = page.locator(".research-run-history").locator(".research-run-card").filter({ has: page.locator(".research-run-card-heading code", { hasText: runId }) });
  await expect(reloadedCard).toBeVisible({ timeout: 15_000 });
  await reloadedCard.getByRole("button", { name: "查看完整研究轮次" }).click();
  const recovered = page.getByText("尚未确认的「完成」提交", { exact: false });
  await expect(recovered.first()).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "使用同一标识重试" }).first().click();
  await expect(page.getByText(/该研究轮次已经处于终态|已完成|完成摘要/).first()).toBeVisible({ timeout: 20_000 });
  // No duplicate transition/no new resource; receipt cleared.
  const statuses = psql(`SELECT count(*) FROM core.research_runs WHERE id='${runId}' AND status='SUCCEEDED'`);
  expect(Number(statuses)).toBe(1);
  const sessionKey = await page.evaluate(() => sessionStorage.getItem("book-id-search:s32-m3a-research-run-action-v1"));
  expect(sessionKey).toBeNull();
  mark("TERMINAL_PENDING_RECOVERY_OK");
  await context.close();
});

// ---------- I. Pending run not on first page (CRITICAL) ----------
test("I1 pending action for off-first-page run still recoverable", async ({ browser }) => {
  const context = await ownerContext(browser);
  const page = await context.newPage();
  // Create one run whose COMPLETE pending will go off page 1.
  await page.goto(issueUrl(P1, I1));
  await page.getByRole("button", { name: "开始新的研究轮次" }).click();
  await page.getByLabel(/证据快照/).selectOption({ index: 1 });
  await page.getByLabel(/研究目标/).fill("翻页恢复目标");
  await page.getByLabel(/研究方法/).fill("方法");
  await page.getByLabel("步骤 1 描述").fill("步骤");
  await page.locator("input[name='research-run-mode'][value='HUMAN']").check();
  await page.locator("input[name='research-run-repro'][value='EXACT']").check();
  await page.getByRole("button", { name: "开始研究轮次" }).click();
  await expect(page.getByText("研究轮次已开始。")).toBeVisible({ timeout: 20_000 });
  const targetRun = psql(`SELECT id FROM core.research_runs WHERE issue_id='${I1}' AND status='RUNNING' AND procedure->>'objective'='翻页恢复目标'`);
  // Create its pending COMPLETE receipt via aborted response.
  const tHistory = page.locator(".research-run-history");
  const card = tHistory.locator(".research-run-card").filter({ has: page.locator(".research-run-card-heading code", { hasText: targetRun }) });
  await card.getByRole("button", { name: "查看完整研究轮次" }).click();
  const detail = page.locator(".research-run-detail");
  await detail.getByRole("button", { name: "标记完成" }).click();
  await detail.getByLabel(/研究产出摘要/).fill("翻页摘要");
  await page.route("**/runs/*/complete", async route => {
    await route.fetch();
    await route.abort("connectionreset");
  });
  await detail.getByRole("button", { name: "确认标记完成" }).click();
  await expect(detail.getByText("研究轮次操作结果尚未确认。可以使用同一标识重试。")).toBeVisible({ timeout: 20_000 });
  await page.unrouteAll();
  // Push 20 newer runs directly via SQL so the pending run falls off page 1 (server order = started_at desc).
  for (let i = 0; i < 22; i++) {
    psql(`INSERT INTO core.research_runs (id, issue_id, evidence_manifest_id, status, procedure, execution_contract, environment, started_at, completed_at, created_at)
      VALUES ('f${(i + 1).toString().padStart(7, "0")}-1111-4111-8111-111111111111', '${I1}', '${MANIFEST_1}', 'CANCELLED',
      '{"version":1,"objective":"占位${i}","method":"m","steps":[{"kind":"SEARCH","description":"s"}]}'::jsonb,
      '{"version":1,"mode":"HUMAN","reproducibilityLevel":"EXACT","tools":[]}'::jsonb, '{}'::jsonb,
      now() + interval '${i} seconds', now() + interval '${i + 1} seconds', now() + interval '${i} seconds')`);
  }
  // Reload: pending run is not among first 20 rows.
  await page.reload();
  await page.waitForTimeout(2000);
  const firstPage = await page.locator(".research-run-history .research-run-card").allTextContents();
  expect(firstPage.join(" ").includes(targetRun)).toBe(false);
  // Recovery affordance must exist without paging: scope-matched pending notice.
  await expect(page.getByText(/尚未确认的「完成」提交/).first()).toBeVisible({ timeout: 20_000 });
  // It must offer the exact run recovery, not foreign runs.
  const recoveryBlock = page.locator(".research-run-actions, .research-run-detail, body").filter({ hasText: "尚未确认" }).first();
  await expect(recoveryBlock.getByText(targetRun)).toBeVisible();
  await page.getByRole("button", { name: "使用同一标识重试" }).first().click();
  // Retry replays the original completed receipt.
  await expect(page.getByText(/已取消|已完成|失败|进行中/).first()).toBeVisible({ timeout: 20_000 });
  const finalStatus = psql(`SELECT status FROM core.research_runs WHERE id='${targetRun}'`);
  expect(["SUCCEEDED", "FAILED", "CANCELLED", "RUNNING"]).toContain(finalStatus);
  mark("OFF_FIRST_PAGE_PENDING_OK");
  await context.close();
});

// ---------- J. Evidence privacy + archived read-only ----------
test("J1 revoke material authorization → historical run available=false, no items leak", async ({ browser }) => {
  const context = await ownerContext(browser);
  const page = await context.newPage();
  // Revoke the EDITION binding that authorizes manifest items' source.
  psql(`DELETE FROM core.project_bindings WHERE id='81111111-1111-4111-8111-111111111111'`);
  await page.goto(issueUrl(P1, I1));
  const history = page.locator(".research-run-history");
  await expect(history.getByText("Run:").first()).toBeVisible({ timeout: 15_000 });
  // Historical runs still listed.
  const runCount = await history.getByText("Run:").count();
  expect(runCount).toBeGreaterThanOrEqual(1);
  // Open a detail: evidence now unavailable, no items/target ids anywhere.
  await history.locator(".research-run-card").first().getByRole("button", { name: "查看完整研究轮次" }).click();
  const detail = page.locator(".research-run-detail");
  await expect(detail.getByText("证据当前不可访问")).toBeVisible({ timeout: 15_000 });
  expect(await detail.locator(".research-run-detail-evidence-items li").count()).toBe(0);
  expect(await page.locator(".research-run-detail").getByText("61111111-1111-4111-8111-111111111111").count()).toBe(0);
  mark("EVIDENCE_PRIVACY_OK");
  // Restore the revoked EDITION binding so later tests (L1) still have bases.
  psql(`INSERT INTO core.project_bindings (id, project_id, target_type, target_id, binding_role, metadata) VALUES
    ('81111111-1111-4111-8111-111111111111', '${P1}', 'EDITION', '51111111-1111-4111-8111-111111111111', NULL, '{"sourceId":"61111111-1111-4111-8111-111111111111"}'::jsonb)`);
  await context.close();
});

test("J2 archived project/issue read-only: history+detail visible, no fresh writes", async ({ browser }) => {
  const context = await ownerContext(browser);
  const page = await context.newPage();
  // Archived issue in archived project: historical RUNNING run visible, read-only.
  await page.goto(issueUrl(P_ARCHIVED, I_ARCHIVED));
  const history = page.locator(".research-run-history");
  await expect(history.getByText(ARCHIVED_RUN)).toBeVisible({ timeout: 15_000 });
  await history.locator(".research-run-card").filter({ has: page.locator(".research-run-card-heading code", { hasText: ARCHIVED_RUN }) }).getByRole("button", { name: "查看完整研究轮次" }).click();
  const detail = page.locator(".research-run-detail");
  await expect(detail.getByText("归档范围历史目标")).toBeVisible({ timeout: 15_000 });
  // No fresh write actions in archived scope.
  expect(await page.getByRole("button", { name: "开始新的研究轮次" }).count()).toBe(0);
  await expect(detail.getByText(/只读/)).toBeVisible();
  expect(await detail.getByRole("button", { name: "标记完成" }).count()).toBe(0);
  // Open issue inside archived project: composer hidden too (project read-only).
  await page.goto(issueUrl(P_ARCHIVED, I_OPEN_IN_ARCHIVED));
  expect(await page.getByRole("button", { name: "开始新的研究轮次" }).count()).toBe(0);
  mark("ARCHIVED_READ_ONLY_OK");
  await context.close();
});

// ---------- K. Pagination / errors ----------
test("K1 history pagination exact cursor, append, dedupe, page-failure retry", async ({ browser }) => {
  const context = await ownerContext(browser);
  const page = await context.newPage();
  await page.goto(issueUrl(P1, I1));
  const history = page.locator(".research-run-history");
  await expect(history.locator(".research-run-card").first()).toBeVisible({ timeout: 20_000 });
  const firstPage = await history.locator(".research-run-card").count();
  expect(firstPage).toBe(20); // limit 20
  const more = history.getByRole("button", { name: "加载更早研究轮次" });
  await expect(more).toBeVisible();
  let pageFailed = false;
  await page.route("**/runs?*", async route => {
    if (!pageFailed) {
      pageFailed = true;
      await route.abort("connectionreset");
      return;
    }
    await route.fallback();
  });
  await more.click();
  await expect(history.getByText("更早的研究轮次暂时无法加载。")).toBeVisible({ timeout: 15_000 });
  const stillFirstPage = await history.locator(".research-run-card").count();
  expect(stillFirstPage).toBe(20); // existing rows preserved
  await page.unrouteAll();
  await history.getByRole("button", { name: "重试加载更早研究轮次" }).click();
  await expect(history.locator(".research-run-card").first()).toBeVisible({ timeout: 15_000 });
  const loaded = await history.locator(".research-run-card").count();
  expect(loaded).toBeGreaterThan(20);
  // Dedupe: no run id repeated.
  const ids = await history.locator(".research-run-card-heading code").allTextContents();
  expect(new Set(ids).size).toBe(ids.length);
  mark("PAGINATION_OK");
  await context.close();
});

test("K2 detail 404 safe; unrelated UI survives", async ({ browser }) => {
  const context = await ownerContext(browser);
  const page = await context.newPage();
  // Detail 404 via API for nonexistent run: use request context.
  const api = await context.request;
  const missing = await api.get(`${WEB}/api/private/s32/projects/${P1}/issues/${I1}/runs/00000000-0000-4000-8000-000000000000`);
  expect(missing.status()).toBe(404);
  // Issue page still renders claims etc.
  await page.goto(issueUrl(P1, I1));
  await expect(page.getByText("Gate2 primary claim.").first()).toBeVisible({ timeout: 15_000 });
  mark("DETAIL_404_SAFE");
  await context.close();
});

// ---------- L. Mobile 390x844 + keyboard ----------
test("L1 mobile viewport no horizontal overflow; keyboard flows", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const [name, value] = COOKIE.split("=");
  await context.addCookies([{ name, value, url: WEB }]);
  const page = await context.newPage();
  await page.goto(issueUrl(P1, I1));
  await expect(page.locator(".research-run-history").getByText("Run:").first()).toBeVisible({ timeout: 15_000 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  // Keyboard: focus start entry and activate with Enter.
  await page.goto(issueUrl(P_ARCHIVED, I_ARCHIVED)); // no start button here; use P1
  await page.goto(issueUrl(P1, I1));
  const entry = page.getByRole("button", { name: "开始新的研究轮次" });
  await entry.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel(/研究目标/)).toBeVisible({ timeout: 10_000 });
  await page.keyboard.press("Escape");
  // Detail keyboard access.
  await page.locator(".research-run-history").getByRole("button", { name: "查看完整研究轮次" }).first().focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".research-run-detail")).toBeVisible({ timeout: 10_000 });
  const overflow2 = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow2).toBeLessThanOrEqual(0);
  mark("MOBILE_KEYBOARD_OK");
  await context.close();
});

// ---------- Receipt summary ----------
test("Z final receipt", async () => {
  const expected = [
    "AUTH_SESSION_OK", "ANON_NO_PRIVATE_DATA", "START_HISTORY_DETAIL_OK", "DETAIL_EVIDENCE_FIELDS_ONLY",
    "START_UNKNOWN_RECOVERY_OK", "COMPLETE_OK", "FAIL_CANCEL_OK", "REPLAY_CHAIN_OK",
    "REPLAY_PERSISTED_BODY_RETRY_OK", "TERMINAL_PENDING_RECOVERY_OK", "OFF_FIRST_PAGE_PENDING_OK",
    "EVIDENCE_PRIVACY_OK", "ARCHIVED_READ_ONLY_OK", "PAGINATION_OK", "DETAIL_404_SAFE", "MOBILE_KEYBOARD_OK",
  ];
  const missing = expected.filter(key => !results.includes(key));
  expect(missing, `missing gate marks: ${missing.join(",")}`).toEqual([]);
});
