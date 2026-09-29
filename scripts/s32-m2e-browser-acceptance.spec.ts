import { randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const WEB = "http://127.0.0.1:5173";
const API = "http://127.0.0.1:3001/api/private/s32";
const TOKEN = "m2e-browser-token";
const TOKEN_KEY = "book-id-search:s32-private-token:v1";

const P1 = "11111111-1111-4111-8111-111111111111";
const PA = "13111111-1111-4111-8111-111111111111";
const I1 = "21111111-1111-4111-8111-111111111111";
const IA = "21311111-1111-4111-8111-111111111111";
const IPA = "23111111-1111-4111-8111-111111111111";
const C1 = "31111111-1111-4111-8111-111111111111";
const SRC1 = "61111111-1111-4111-8111-111111111111";

const authHeaders = {
  Authorization: `Bearer ${TOKEN}`,
  "Content-Type": "application/json",
};

function issueUrl(projectId: string, issueId: string) {
  return `${WEB}/research/projects/${projectId}/issues/${issueId}`;
}

function composer(page: Page) {
  return page.locator("section.issue-resolution-composer");
}

function currentConclusion(page: Page) {
  return page.getByLabel("当前工作结论");
}

function resolutionHistorySection(page: Page) {
  return page.getByLabel("工作结论历史");
}

async function history(request: APIRequestContext) {
  const response = await request.get(
    `${API}/projects/${P1}/issues/${I1}/resolutions?limit=50`,
    { headers: { Authorization: `Bearer ${TOKEN}` } },
  );
  expect(response.status()).toBe(200);
  return await response.json() as {
    issue: { currentResolutionId: string | null };
    currentResolution: { id: string; resolutionType: string } | null;
    resolutions: Array<{
      id: string;
      resolutionType: string;
      rationaleExcerpt: string | null;
      isCurrent: boolean;
    }>;
  };
}

async function createEvidenceBasis(request: APIRequestContext): Promise<string> {
  const items = [{
    role: "SUPPORTING",
    targetType: "SOURCE",
    targetId: SRC1,
    note: "M2-E whole-slice evidence",
  }];

  const preview = await request.post(
    `${API}/projects/${P1}/issues/${I1}/claims/${C1}/evidence-manifest-preview`,
    { headers: authHeaders, data: { items } },
  );
  expect(preview.status()).toBe(200);
  const previewBody = await preview.json() as { draft: { manifestSha256: string } };

  const assessment = await request.post(
    `${API}/projects/${P1}/issues/${I1}/claims/${C1}/assessments`,
    {
      headers: { ...authHeaders, "Idempotency-Key": randomUUID() },
      data: {
        stance: "SUPPORTS",
        confidenceLevel: "HIGH",
        reasoning: "M2-E whole-slice evidence basis.",
        expectedManifestSha256: previewBody.draft.manifestSha256,
        items,
      },
    },
  );
  expect(assessment.status()).toBe(201);

  const bases = await request.get(
    `${API}/projects/${P1}/issues/${I1}/resolution-evidence-bases?limit=20`,
    { headers: { Authorization: `Bearer ${TOKEN}` } },
  );
  expect(bases.status()).toBe(200);
  const body = await bases.json() as {
    issueId: string;
    evidenceBases: Array<{ claimId: string; manifestId: string; itemCount: number }>;
  };
  expect(body.issueId).toBe(I1);
  const basis = body.evidenceBases.find(item => item.claimId === C1 && item.itemCount === 1);
  expect(basis).toBeTruthy();
  return basis!.manifestId;
}

async function choosePreferred(page: Page, evidenceManifestId: string, rationale: string) {
  const form = composer(page);
  await form.getByRole("radio", { name: "采用一个可能答案" }).check();
  await form.getByLabel("首选可能答案").selectOption(C1);
  await form.getByLabel("证据依据（可选）").selectOption(evidenceManifestId);
  await form.getByLabel("结论理由").fill(rationale);
}

async function chooseNoConclusion(page: Page, label: "证据不足" | "暂不形成工作结论", rationale: string) {
  const form = composer(page);
  await form.getByRole("radio", { name: label }).check();
  await form.getByLabel("结论理由").fill(rationale);
}

test("M2-E whole slice: preferred resolution, pointer advance, replay, stale tab, reload, history, read-only and mobile", async ({ browser, page, request }) => {
  test.setTimeout(180_000);

  await page.addInitScript(
    ({ key, token }) => sessionStorage.setItem(key, token),
    { key: TOKEN_KEY, token: TOKEN },
  );

  const evidenceManifestId = await createEvidenceBasis(request);

  // Open two tabs before any Resolution exists so the second one carries a stale
  // expectedCurrentResolutionId=null after the first tab commits.
  const stalePage = await browser.newPage();
  await stalePage.addInitScript(
    ({ key, token }) => sessionStorage.setItem(key, token),
    { key: TOKEN_KEY, token: TOKEN },
  );

  await Promise.all([
    page.goto(issueUrl(P1, I1)),
    stalePage.goto(issueUrl(P1, I1)),
  ]);
  await expect(page.getByRole("heading", { name: "M2D Open Issue" })).toBeVisible();
  await expect(stalePage.getByRole("heading", { name: "M2D Open Issue" })).toBeVisible();
  await expect(currentConclusion(page).getByText("尚未形成当前工作结论。")).toBeVisible();

  // First preferred Resolution uses a real M2-D Assessment Manifest as evidence.
  await choosePreferred(page, evidenceManifestId, "第一条工作结论：现有证据最支持 Primary candidate。");
  await composer(page).getByRole("button", { name: "提交工作结论" }).click();
  await expect(composer(page).getByText("工作结论已成功提交。")).toBeVisible();

  let firstHistory = await history(request);
  expect(firstHistory.resolutions).toHaveLength(1);
  const firstResolutionId = firstHistory.issue.currentResolutionId;
  expect(firstResolutionId).toBeTruthy();
  expect(firstHistory.currentResolution?.id).toBe(firstResolutionId);
  expect(firstHistory.currentResolution?.resolutionType).toBe("PREFERRED_CLAIM");

  await expect(currentConclusion(page).getByText("第一条工作结论：现有证据最支持 Primary candidate。")).toBeVisible();
  await expect(currentConclusion(page).getByText("证据依据当前可用")).toBeVisible();

  // The tab opened before the first commit must lose the CAS race. The stale
  // attempt is a definite rejection and must not create a durable Resolution.
  await chooseNoConclusion(stalePage, "暂不形成工作结论", "这个 stale tab 不应成功写入。");
  await composer(stalePage).getByRole("button", { name: "提交工作结论" }).click();
  await expect(
    composer(stalePage).getByText("当前工作结论已变化，已刷新提交基线。请确认后重新提交。"),
  ).toBeVisible();
  expect((await history(request)).resolutions).toHaveLength(1);

  // Second Resolution: let the server commit, then abort the browser response.
  // Reload must restore the pending receipt and same-key retry must replay.
  let interceptedStatus = 0;
  const resolutionPost = new RegExp(
    `/api/private/s32/projects/${P1}/issues/${I1}/resolutions$`,
  );
  await page.route(resolutionPost, async route => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    const upstream = await route.fetch();
    interceptedStatus = upstream.status();
    await route.abort("failed");
  });

  await chooseNoConclusion(page, "证据不足", "第二条工作结论：当前证据仍不足。");
  await composer(page).getByRole("button", { name: "提交工作结论" }).click();
  await expect(composer(page).getByText(/工作结论提交结果尚未确认/)).toBeVisible();
  expect(interceptedStatus).toBe(201);
  await page.unroute(resolutionPost);

  await expect.poll(async () => (await history(request)).resolutions.length).toBe(2);

  await page.reload();
  await expect(composer(page).getByText("工作结论提交结果尚未确认。")).toBeVisible();
  await expect(composer(page).getByRole("button", { name: "使用同一标识重试" })).toBeVisible();

  const replayPromise = page.waitForResponse(response =>
    response.request().method() === "POST" && resolutionPost.test(response.url()),
  );
  await composer(page).getByRole("button", { name: "使用同一标识重试" }).click();
  const replay = await replayPromise;
  expect(replay.status()).toBe(200);
  expect(await replay.json()).toMatchObject({ status: "replayed" });
  await expect(composer(page).getByText("此工作结论此前已经成功提交。")).toBeVisible();

  const afterReplay = await history(request);
  expect(afterReplay.resolutions).toHaveLength(2);
  expect(afterReplay.issue.currentResolutionId).not.toBe(firstResolutionId);
  expect(afterReplay.currentResolution?.resolutionType).toBe("INSUFFICIENT_EVIDENCE");

  // Current comes from the authoritative pointer; the prior Resolution remains
  // visible as immutable history with its own frozen evidence detail.
  await expect(currentConclusion(page).getByText("证据不足")).toBeVisible();
  await expect(currentConclusion(page).getByText("第二条工作结论：当前证据仍不足。")).toBeVisible();

  const historySection = resolutionHistorySection(page);
  const historyItems = historySection.locator("ol.issue-resolution-history-list > li");
  await expect(historyItems).toHaveCount(2);

  const previous = historyItems.filter({
    hasText: "第一条工作结论：现有证据最支持 Primary candidate。",
  });
  const latest = historyItems.filter({
    hasText: "第二条工作结论：当前证据仍不足。",
  });
  await expect(previous).toHaveCount(1);
  await expect(latest).toHaveCount(1);
  await expect(previous.getByText("CURRENT")).toHaveCount(0);
  await expect(latest.getByText("CURRENT")).toBeVisible();

  await previous.getByRole("button", { name: "查看完整结论" }).click();
  const detail = previous.getByLabel("完整工作结论");
  await expect(detail.getByText("1 条冻结证据")).toBeVisible();
  await expect(detail.locator(".assessment-detail-items > li")).toHaveCount(1);
  await expect(detail.getByText("M2-E whole-slice evidence")).toBeVisible();
  await detail.getByRole("button", { name: "关闭" }).click();

  // 390x844 is the frozen mobile viewport gate. No horizontal overflow is allowed.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() =>
    page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
  ).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollHeight > window.innerHeight)).toBe(true);

  // Archived Project and archived Issue remain readable but expose no Composer.
  await page.goto(issueUrl(PA, IPA));
  await expect(page.getByRole("heading", { name: "M2D Archived Project Issue" })).toBeVisible();
  await expect(currentConclusion(page)).toBeVisible();
  await expect(resolutionHistorySection(page)).toBeVisible();
  await expect(page.getByRole("heading", { name: "形成工作结论" })).toHaveCount(0);

  await page.goto(issueUrl(P1, IA));
  await expect(page.getByRole("heading", { name: "M2D Archived Issue" })).toBeVisible();
  await expect(currentConclusion(page)).toBeVisible();
  await expect(resolutionHistorySection(page)).toBeVisible();
  await expect(page.getByRole("heading", { name: "形成工作结论" })).toHaveCount(0);

  await stalePage.close();

  console.log("M2E_FIRST_PREFERRED_RESOLUTION=PASS");
  console.log("M2E_POINTER_ADVANCE_HISTORY=PASS");
  console.log("M2E_UNKNOWN_RESULT_REPLAY=PASS");
  console.log("M2E_STALE_TAB=PASS");
  console.log("M2E_ARCHIVED_READ_ONLY=PASS");
  console.log("M2E_MOBILE_390x844=PASS");
});
