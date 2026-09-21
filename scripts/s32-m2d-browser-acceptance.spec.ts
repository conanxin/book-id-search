import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const WEB = "http://127.0.0.1:5173";
const API = "http://127.0.0.1:3001/api/private/s32";
const TOKEN = "m2d-browser-token";
const TOKEN_KEY = "book-id-search:s32-private-token:v1";

const P1 = "11111111-1111-4111-8111-111111111111";
const PA = "13111111-1111-4111-8111-111111111111";
const I1 = "21111111-1111-4111-8111-111111111111";
const IA = "21311111-1111-4111-8111-111111111111";
const IPA = "23111111-1111-4111-8111-111111111111";
const C1 = "31111111-1111-4111-8111-111111111111";
const C_ARCHIVED = "31211111-1111-4111-8111-111111111111";
const SRC1 = "61111111-1111-4111-8111-111111111111";
const ASSET1 = "71111111-1111-4111-8111-111111111111";
const EB1 = "81111111-1111-4111-8111-111111111111";
const ED1 = "51111111-1111-4111-8111-111111111111";
const REV2 = "a1211111-1111-4111-8111-111111111111";

const authHeaders = {
  Authorization: `Bearer ${TOKEN}`,
  "Content-Type": "application/json",
};

function issueUrl(projectId: string, issueId: string) {
  return `${WEB}/research/projects/${projectId}/issues/${issueId}`;
}

function claimCard(page: Page, statement: string) {
  return page.locator("article.research-card").filter({ hasText: statement }).first();
}

function extraAssetId(n: number): string {
  const h8 = n.toString(16).padStart(8, "0");
  const h12 = n.toString(16).padStart(12, "0");
  return `${h8}-2222-4222-8222-${h12}`;
}

function psql(sql: string) {
  const container = process.env.M2D_BROWSER_CONTAINER;
  if (!container) throw new Error("M2D_BROWSER_CONTAINER is required");
  return execFileSync(
    "docker",
    [
      "--host", "unix:///var/run/docker.sock",
      "exec", "-i", container,
      "psql", "-X", "-U", "s32browser", "-d", "s32_m2d_browser",
      "-v", "ON_ERROR_STOP=1", "-Atc", sql,
    ],
    { encoding: "utf8" },
  ).trim();
}

async function history(
  request: APIRequestContext,
  projectId = P1,
  issueId = I1,
  claimId = C1,
) {
  const response = await request.get(
    `${API}/projects/${projectId}/issues/${issueId}/claims/${claimId}/assessments?limit=50`,
    { headers: { Authorization: `Bearer ${TOKEN}` } },
  );
  expect(response.status()).toBe(200);
  return await response.json() as {
    assessments: Array<{ id: string; evidenceManifest: { itemCount: number } }>;
  };
}

async function selectSourceAndCurrentNote(page: Page, statement = "Primary candidate.") {
  const card = claimCard(page, statement);
  await card.getByRole("button", { name: "构建证据集" }).click();
  await card.getByTestId(`candidate-${SRC1}`).getByRole("button", { name: "作为支持证据" }).click();
  await card.getByTestId(`candidate-${REV2}`).getByRole("button", { name: "作为背景证据" }).click();
  await card.getByRole("button", { name: "预览 EvidenceManifest" }).click();
  await expect(card.getByText("尚未提交。")).toBeVisible();
  await expect(card.locator(".evidence-preview code")).toHaveText(/^[0-9a-f]{64}$/);
  return card;
}

async function submitAssessment(
  card: ReturnType<typeof claimCard>,
  reasoning: string,
  stance: "支持" | "反驳" | "尚不能判断" = "支持",
) {
  await card.getByRole("radio", { name: stance }).check();
  await card.getByLabel("信心").selectOption("HIGH");
  await card.getByLabel("判断理由").fill(reasoning);
  await card.getByRole("button", { name: "提交评价" }).click();
}

test("M2-D real Firefox acceptance: create, recover, audit, privacy, lifecycle, mobile", async ({ page, request }) => {
  test.setTimeout(180_000);

  await page.addInitScript(
    ({ key, token }) => sessionStorage.setItem(key, token),
    { key: TOKEN_KEY, token: TOKEN },
  );

  await page.goto(issueUrl(P1, I1));
  await expect(page.getByRole("heading", { name: "M2D Open Issue" })).toBeVisible();

  // Happy path: current evidence candidate -> Preview -> Assessment -> History -> Detail.
  const primary = await selectSourceAndCurrentNote(page);
  await primary.getByRole("radio", { name: "支持" }).check();
  await primary.getByLabel("信心").selectOption("MEDIUM");
  await primary.getByLabel("判断理由").fill("第一行\n第二行  保持");

  // Assessment-only mutation does not invalidate the evidence Preview.
  await primary.getByLabel("信心").selectOption("HIGH");
  await expect(primary.getByText("尚未提交。")).toBeVisible();

  // Evidence mutation invalidates Preview, but the Assessment draft survives and
  // is restored when the user previews the changed evidence set again.
  await primary.getByLabel("证据说明").first().fill("浏览器验收说明");
  await expect(primary.getByText("尚未提交。")).toHaveCount(0);
  await primary.getByRole("button", { name: "预览 EvidenceManifest" }).click();
  await expect(primary.getByText("尚未提交。")).toBeVisible();
  await expect(primary.getByRole("radio", { name: "支持" })).toBeChecked();
  await expect(primary.getByLabel("信心")).toHaveValue("HIGH");
  await expect(primary.getByLabel("判断理由")).toHaveValue("第一行\n第二行  保持");

  await primary.getByRole("button", { name: "提交评价" }).click();
  await expect(primary.getByText("评价已成功提交。")).toBeVisible();
  await expect(primary.getByText("最近一次评价")).toBeVisible();
  await primary.getByRole("button", { name: "查看完整评价" }).first().click();
  await expect(primary.getByRole("heading", { name: "完整评价" })).toBeVisible();
  await expect(primary.getByText("第一行\n第二行  保持")).toBeVisible();
  await expect(primary.locator(".assessment-detail-items > li")).toHaveCount(2);
  await primary.getByRole("button", { name: "关闭" }).click();

  // Response-unknown: server commits, browser receives a network failure, reload
  // restores the frozen committed intent, and same-key retry replays exactly once.
  const beforeUnknown = (await history(request)).assessments.length;
  let interceptedStatus = 0;
  const assessmentPost = new RegExp(
    `/api/private/s32/projects/${P1}/issues/${I1}/claims/${C1}/assessments$`,
  );
  await page.route(assessmentPost, async route => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    const upstream = await route.fetch();
    interceptedStatus = upstream.status();
    await route.abort("failed");
  });

  await submitAssessment(primary, "网络结果未知后的第二次评价", "反驳");
  await expect(primary.getByText(/评价提交结果尚未确认/)).toBeVisible();
  expect(interceptedStatus).toBe(201);
  await page.unroute(assessmentPost);

  await page.reload();
  const reloadedPrimary = claimCard(page, "Primary candidate.");
  await expect(reloadedPrimary.getByRole("button", { name: "使用同一标识重试" })).toBeVisible();
  await reloadedPrimary.getByRole("button", { name: "使用同一标识重试" }).click();
  await expect(reloadedPrimary.getByText("此评价此前已经成功提交。")).toBeVisible();
  await expect.poll(async () => (await history(request)).assessments.length).toBe(beforeUnknown + 1);

  // Build a 100-item Manifest through the real private API. The fixture contains
  // exactly 100 authorized SourceAssets for the primary Source.
  const hundredAssetIds = [
    ASSET1,
    ...Array.from({ length: 99 }, (_, index) => extraAssetId(index + 1)),
  ];
  const hundredItems = hundredAssetIds.map(targetId => ({
    role: "SUPPORTING",
    targetType: "SOURCE_ASSET",
    targetId,
    note: null,
  }));

  const preview = await request.post(
    `${API}/projects/${P1}/issues/${I1}/claims/${C1}/evidence-manifest-preview`,
    { headers: authHeaders, data: { items: hundredItems } },
  );
  expect(preview.status()).toBe(200);
  const previewBody = await preview.json() as { draft: { manifestSha256: string } };

  const createHundred = await request.post(
    `${API}/projects/${P1}/issues/${I1}/claims/${C1}/assessments`,
    {
      headers: { ...authHeaders, "Idempotency-Key": randomUUID() },
      data: {
        stance: "SUPPORTS",
        confidenceLevel: "HIGH",
        reasoning: "100-item browser acceptance assessment.",
        expectedManifestSha256: previewBody.draft.manifestSha256,
        items: hundredItems,
      },
    },
  );
  expect(createHundred.status()).toBe(201);

  await page.reload();
  const hundredPrimary = claimCard(page, "Primary candidate.");
  await expect(hundredPrimary.getByText("100 条证据").first()).toBeVisible();
  await hundredPrimary.getByRole("button", { name: "查看完整评价" }).first().click();
  await expect(hundredPrimary.locator(".assessment-detail-items > li")).toHaveCount(100);
  await expect(hundredPrimary.locator(".assessment-hash")).toHaveText(/^[0-9a-f]{64}$/);

  // Mobile gate while the largest legal detail is visible.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() =>
    page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
  ).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollHeight > window.innerHeight)).toBe(true);

  // Visibility drift: history can become stale between summary and detail.
  await hundredPrimary.getByRole("button", { name: "关闭" }).click();
  psql(`DELETE FROM core.project_bindings WHERE id='${EB1}'`);
  await hundredPrimary.getByRole("button", { name: "查看完整评价" }).first().click();
  await expect(hundredPrimary.getByText("该评价当前不可用。")).toBeVisible();
  await expect(page.getByText(/权限|其他项目/)).toHaveCount(0);
  await expect(hundredPrimary.getByText("当前没有可显示的评价记录。")).toBeVisible();

  psql(`
    INSERT INTO core.project_bindings
      (id,project_id,target_type,target_id,binding_role,metadata)
    VALUES
      ('${EB1}','${P1}','EDITION','${ED1}',NULL,
       '{"sourceId":"${SRC1}"}'::jsonb)
  `);

  // Archived Project and archived Issue remain readable, but cannot create.
  await page.goto(issueUrl(PA, IPA));
  const archivedProjectCard = claimCard(page, "Archived project candidate.");
  await expect(archivedProjectCard.getByText("当前没有可显示的评价记录。")).toBeVisible();
  await expect(archivedProjectCard.getByRole("button", { name: "提交评价" })).toHaveCount(0);

  await page.goto(issueUrl(P1, IA));
  const archivedIssueCard = claimCard(page, "Archived issue candidate.");
  await expect(archivedIssueCard.getByText("当前没有可显示的评价记录。")).toBeVisible();
  await expect(archivedIssueCard.getByRole("button", { name: "提交评价" })).toHaveCount(0);

  // An archived Claim is still assessable when Project/Issue are writable.
  await page.goto(issueUrl(P1, I1));
  const archivedClaim = await selectSourceAndCurrentNote(page, "Archived candidate in active issue.");
  await expect(archivedClaim.getByRole("button", { name: "提交评价" })).toBeVisible();
});
