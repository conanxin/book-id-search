import { spawn, type ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, expect, type Browser } from "@playwright/test";

const ROOT = process.cwd();
const TARGET = "http://127.0.0.1:5173/locator-pilot.html";
const OUTPUT = resolve(ROOT, "test-results/s32-r10-local-locator-pilot.png");
let vite: ChildProcess | null = null;
let browser: Browser | null = null;

async function waitForDevPage(): Promise<void> {
  for (let i = 0; i < 80; i++) {
    if (vite?.exitCode !== null) throw new Error("R10_VITE_EXITED_PREMATURELY");
    try {
      const response = await fetch(TARGET, { signal: AbortSignal.timeout(1200) });
      if (response.ok && (await response.text()).includes("locator-pilot-main.tsx")) return;
    } catch { /* wait for the local dev server to be ready */ }
    await delay(200);
  }
  throw new Error("R10_VITE_START_TIMEOUT");
}

async function run() {
  const runner = spawn(
    "pnpm", ["exec", "vite", "--host", "127.0.0.1", "--port", "5173", "--strictPort"],
    { cwd: resolve(ROOT, "apps/web"), env: { ...process.env, BROWSER: "none" },
      detached: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  vite = runner;
  let log = "";
  runner.stdout?.on("data", chunk => { log += String(chunk).slice(-2000); });
  runner.stderr?.on("data", chunk => { log += String(chunk).slice(-2000); });
  runner.on("error", error => { console.error("R10_VITE_SPAWN_ERROR", error.message); });

  await waitForDevPage().catch(error => {
    console.error("R10_VITE_LOG_TAIL", log.slice(-4000));
    throw error;
  });
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1170, height: 850 } });
  const inappropriateRequests: string[] = [];
  page.on("request", request => {
    const url = request.url();
    if (/\/api\//.test(url) || /^https?:\/\//.test(url) && !url.startsWith("http://127.0.0.1:5173/")) {
      inappropriateRequests.push(url);
    }
  });

  await page.goto(TARGET, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "本地文件页码核对实验室" })).toBeVisible();
  await expect(page.getByText(/不连接研究项目、不上传、不保存文件/)).toBeVisible();
  const synthetic = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n", "utf8");
  await page.getByLabel("本地文件（PDF 或图片）").setInputFiles({
    name: "synthetic-only.pdf", mimeType: "application/pdf", buffer: synthetic,
  });
  await page.getByLabel("书上印刷页码或图版号").fill("87");
  await page.getByLabel("我理解这是未认证来源的本地演示，不会保存文件").check();
  await page.getByRole("button", { name: "开始本地核对" }).click();
  await expect(page.getByText("文件摘要已计算，等待人工核对")).toBeVisible({ timeout: 15000 });
  await expect(page.getByText(/文件摘要由所选文件计算，不能独立证明版本和来源/)).toBeVisible();
  await page.getByLabel("扫描文件页序（从 1 开始）").fill("93");
  await page.getByLabel("我已亲自查看本地文件相应页面").check();
  await page.getByRole("button", { name: "记录匹配" }).click();
  await expect(page.getByText("人工报告已记录：匹配（非认证引文）")).toBeVisible();
  await expect(page.getByText("书上页码：87")).toBeVisible();
  await expect(page.getByText("扫描页序：93")).toBeVisible();
  await expect(page.getByText(/报告匹配/)).toBeVisible();
  await expect(page.getByText(/原文核实状态：未独立核实/)).toBeVisible();

  await mkdir(resolve(ROOT, "test-results"), { recursive: true });
  await page.screenshot({ path: OUTPUT, fullPage: true });
  await page.getByRole("button", { name: "撤销报告" }).click();
  await expect(page.getByText("报告已撤销，不可在本会话中恢复")).toBeVisible();
  await expect(page.getByText(/撤销记录/)).toBeVisible();

  await page.getByRole("button", { name: "清空并重新开始" }).click();
  await expect(page.getByText("选择文件后才能开始新会话")).toBeVisible();
  await expect(page.getByText(/报告匹配/)).toHaveCount(0);
  await page.getByLabel("本地文件（PDF 或图片）").setInputFiles({
    name: "synthetic-only.pdf", mimeType: "application/pdf", buffer: synthetic,
  });
  await page.getByLabel("我理解这是未认证来源的本地演示，不会保存文件").check();
  await page.getByRole("button", { name: "开始本地核对" }).click();
  await expect(page.getByText("文件摘要已计算，等待人工核对")).toBeVisible();
  await page.getByLabel("实际看到的页码或图版号").fill("88");
  await page.getByLabel("我已亲自查看本地文件相应页面").check();
  await page.getByRole("button", { name: "记录不匹配" }).click();
  await expect(page.getByText("人工报告已记录：不匹配")).toBeVisible();
  await expect(page.getByText("观察到的标签：88")).toBeVisible();

  if (inappropriateRequests.length) {
    throw new Error("R10_BACKEND_OR_EXTERNAL_REQUEST_DETECTED:" + inappropriateRequests.join(","));
  }
  console.log("R10_REAL_CHROMIUM_USER_JOURNEY=PASS");
  console.log("R10_LOCAL_FILE_ONLY=YES");
  console.log("R10_REMOTE_OR_API_REQUESTS=0");
  console.log("R10_VERIFIED_CITATION_GENERATED=NO");
}

try {
  await run();
} catch (error) {
  console.error("R10_BROWSER_ACCEPTANCE_FAIL", error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  if (vite?.pid) {
    try { process.kill(-vite.pid, "SIGTERM"); } catch { vite.kill("SIGTERM"); }
    console.log("R10_LOCAL_VITE_STOP_REQUESTED=YES");
  }
}
