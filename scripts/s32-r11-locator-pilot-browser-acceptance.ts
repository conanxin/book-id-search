import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, expect, type Browser, type Page } from "@playwright/test";

// This runner simulates UI reports. Its checkbox clicks are NOT human attestation.
const ROOT = process.cwd();
const TARGET = "http://127.0.0.1:5173/locator-pilot.html";
const OUTPUT = resolve(ROOT, "test-results/s32-r11");
const LIMIT = 20 * 1024 * 1024;
const MASON_SHA = "70dd12a76e637abb0030c797b0bf03e2210bf07ebf6ca92c9ad5d36388505036";
const sourcePath = process.env.S32_R11_SOURCE_PDF;
const plateImagePath = process.env.S32_R11_PLATE_IMAGE;
const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
let server: ChildProcess | null = null;
let browser: Browser | null = null;
const receipt: Record<string, unknown> = {
  task_id: "S32_R11_REAL_SOURCE_LOCAL_PILOT_VALIDATION",
  human_attestation: "NONE_AUTOMATED_UI_SIMULATION",
  source_authentication: "NONE",
  pdf_inline_visual: "NOT_VERIFIED_BY_HEADLESS_RUNNER",
  real_source_trial: "NOT_RUN",
};

async function startServer() {
  const webRequire = createRequire(resolve(ROOT, "apps/web/package.json"));
  const viteEntry = resolve(dirname(webRequire.resolve("vite/package.json")), "bin/vite.js");
  server = spawn(process.execPath, [viteEntry, "--host", "127.0.0.1", "--port", "5173", "--strictPort"], {
    cwd: resolve(ROOT, "apps/web"), stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  let ready = false;
  let spawnError: Error | null = null;
  server.on("error", error => { spawnError = error; });
  server.stdout?.on("data", chunk => {
    logs = (logs + String(chunk)).slice(-4000);
    ready ||= logs.includes("Local:");
  });
  server.stderr?.on("data", chunk => { logs = (logs + String(chunk)).slice(-4000); });
  for (let i = 0; i < 80; i++) {
    if (spawnError) throw spawnError;
    if (server.exitCode !== null) throw new Error("R11_VITE_EXITED: " + logs);
    // A responding port alone is not proof that this runner owns that server.
    if (!ready) { await delay(200); continue; }
    try {
      const response = await fetch(TARGET, { signal: AbortSignal.timeout(1000) });
      if (response.ok && (await response.text()).includes("locator-pilot-main.tsx")) return;
    } catch { /* local startup only */ }
    await delay(200);
  }
  throw new Error("R11_VITE_START_TIMEOUT: " + logs);
}

async function prepare(page: Page, file: { name: string; mimeType: string; buffer: Buffer }, kind: string, label: string) {
  await page.getByRole("button", { name: "清空并重新开始" }).click();
  await page.getByLabel("本地文件（PDF 或图片）").setInputFiles(file);
  await page.getByLabel("定位类型").selectOption(kind);
  await page.getByLabel("书上印刷页码或图版号").fill(label);
  await page.getByLabel("我理解这是未认证来源的本地演示，不会保存文件").check();
  await page.getByRole("button", { name: "开始本地核对" }).click();
  await expect(page.getByText("文件摘要已计算，等待人工核对")).toBeVisible({ timeout: 15000 });
}

async function report(page: Page, scan: number, matched: boolean, observed?: string) {
  await page.getByLabel("扫描文件页序（从 1 开始）").fill(String(scan));
  if (observed) await page.getByLabel("实际看到的页码或图版号").fill(observed);
  // A simulated local demo actor, never an assertion that a person reviewed the source.
  await page.getByLabel("我已亲自查看本地文件相应页面").check();
  await page.getByRole("button", { name: matched ? "记录匹配" : "记录不匹配" }).click();
}

async function main() {
  const bytes = sourcePath ? await readFile(sourcePath) : pixel;
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (sourcePath && hash !== MASON_SHA) throw new Error("R11_SOURCE_DIFFERS_FROM_OBSERVED_MASON_SAMPLE");
  receipt.source_kind = sourcePath ? "OFFICIAL_MASON_PDF_DOWNLOADED_SEPARATELY" : "SYNTHETIC_PNG";
  receipt.source_bytes = bytes.length;
  receipt.source_sha256 = hash;
  const file = { name: sourcePath ? basename(sourcePath) : "synthetic-pixel.png", mimeType: sourcePath ? "application/pdf" : "image/png", buffer: bytes };
  const printedLabel = sourcePath ? "208" : "SYNTHETIC A";
  const printedScan = sourcePath ? 21 : 1;
  const otherLabel = sourcePath ? "209" : "SYNTHETIC B";
  const otherScan = sourcePath ? 24 : 1;
  const plateLabel = sourcePath ? "PLATE 1" : "SYNTHETIC PLATE";
  const plateScan = sourcePath ? 22 : 1;
  await mkdir(OUTPUT, { recursive: true });
  await startServer();
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1170, height: 900 } });
  const externalRequests: string[] = [];
  page.on("request", request => {
    const url = request.url();
    if (/\/api\//.test(url) || (/^https?:\/\//.test(url) && !url.startsWith("http://127.0.0.1:5173/"))) externalRequests.push(url);
  });
  await page.goto(TARGET);
  await prepare(page, file, "PRINTED_PAGE", printedLabel);
  await expect(page.getByText(hash, { exact: true })).toBeVisible();
  await expect(page.getByLabel("本地文件预览")).toBeVisible();
  await report(page, printedScan, true);
  await expect(page.getByText("书上页码：" + printedLabel, { exact: true })).toBeVisible();
  await expect(page.getByText("扫描页序：" + printedScan, { exact: true })).toBeVisible();
  await page.screenshot({ path: resolve(OUTPUT, "printed-page-report.png"), fullPage: true });
  await page.getByRole("button", { name: "撤销报告" }).click();
  await expect(page.getByText("报告已撤销，不可在本会话中恢复")).toBeVisible();
  await prepare(page, file, "PRINTED_PAGE", printedLabel);
  await report(page, otherScan, false, otherLabel);
  await expect(page.getByText("观察到的标签：" + otherLabel, { exact: true })).toBeVisible();
  await expect(page.getByText("扫描页序：" + otherScan, { exact: true })).toBeVisible();
  receipt.printed_page_report_and_withdrawal = "PASS";
  receipt.mismatch_report = "PASS";

  await prepare(page, file, "PLATE", plateLabel);
  await report(page, plateScan, true);
  await expect(page.getByText("图版号：" + plateLabel, { exact: true })).toBeVisible();
  await expect(page.getByText("扫描页序：" + plateScan, { exact: true })).toBeVisible();
  await expect(page.getByText(/^书上页码：/)).toHaveCount(0);
  await page.screenshot({ path: resolve(OUTPUT, "plate-report.png"), fullPage: true });
  await page.getByRole("button", { name: "撤销报告" }).click();
  await expect(page.getByText("报告已撤销，不可在本会话中恢复")).toBeVisible();
  await expect(page.getByText(/撤销记录/)).toBeVisible();
  await expect(page.getByText("图版号：" + plateLabel, { exact: true })).toBeVisible();
  receipt.plate_report_and_withdrawal = "PASS";

  // Test the rendered derivative separately: PDF scan-page 22 must never be
  // reported as page 22 of a one-image file with a different byte identity.
  if (plateImagePath || !sourcePath) {
    const plate = plateImagePath ? { name: "derived-plate-1.png", mimeType: "image/png", buffer: await readFile(plateImagePath) } : file;
    await prepare(page, plate, "PLATE", plateLabel);
    await expect.poll(() => page.getByAltText("本地选择的图片预览").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
    receipt.image_preview_pixels = "PASS";
    receipt.plate_image_sha256 = createHash("sha256").update(plate.buffer).digest("hex");
    await page.screenshot({ path: resolve(OUTPUT, "separate-image-preview.png"), fullPage: true });
  }

  const boundary = Buffer.alloc(LIMIT);
  pixel.copy(boundary);
  await prepare(page, { name: "synthetic-exact-20MiB.png", mimeType: "image/png", buffer: boundary }, "PRINTED_PAGE", "87");
  await expect(page.getByText(createHash("sha256").update(boundary).digest("hex"), { exact: true })).toBeVisible();
  receipt.exact_20mib = "PASS";
  await page.evaluate(() => {
    const spy = { objectUrls: 0, arrayBuffers: 0 };
    (window as unknown as { r11SelectionSpy: typeof spy }).r11SelectionSpy = spy;
    const create = URL.createObjectURL;
    URL.createObjectURL = (...args) => { spy.objectUrls++; return create(...args); };
    const read = File.prototype.arrayBuffer;
    File.prototype.arrayBuffer = function () { spy.arrayBuffers++; return read.call(this); };
  });
  for (const size of [LIMIT + 1, 0]) {
    await page.getByLabel("本地文件（PDF 或图片）").setInputFiles({ name: "synthetic-rejected.png", mimeType: "image/png", buffer: Buffer.alloc(size) });
    await expect(page.getByRole("alert")).toContainText(size ? "文件超过 20 MiB" : "请选择非空");
    await expect(page.getByLabel("本地文件预览")).toHaveCount(0);
    await expect(page.getByLabel("定位报告")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "开始本地核对" })).toBeDisabled();
  }
  expect(await page.evaluate(() => (window as unknown as { r11SelectionSpy: unknown }).r11SelectionSpy)).toEqual({ objectUrls: 0, arrayBuffers: 0 });
  receipt.rejected_size_preview_and_reads = "PASS";
  await page.close();
  expect(externalRequests).toEqual([]);
  receipt.remote_or_api_requests = externalRequests.length;
  if (sourcePath) receipt.real_source_trial = "PASS_BYTES_AND_SIMULATED_UI_PDF_INLINE_VISUAL_PENDING";
}

async function cleanup() {
  try {
    await browser?.close();
  } finally {
    const child = server;
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<boolean>(resolveExit => child.once("exit", () => resolveExit(true)));
      child.kill("SIGTERM");
      let stopped = await Promise.race([exited, delay(3000).then(() => false)]);
      if (!stopped) {
        child.kill("SIGKILL");
        stopped = await Promise.race([exited, delay(3000).then(() => false)]);
      }
      if (!stopped) throw new Error("R11_LOCAL_VITE_STOP_FAILED");
    }
    receipt.local_vite_stopped = true;
  }
}

try {
  await main();
} catch (error) {
  receipt.status = "FAIL";
  receipt.error = error instanceof Error ? error.message : String(error);
  console.error("R11_BROWSER_ACCEPTANCE_FAIL", error);
  process.exitCode = 1;
} finally {
  try {
    await cleanup();
  } catch (error) {
    receipt.status = "FAIL";
    receipt.cleanup_error = error instanceof Error ? error.message : String(error);
    process.exitCode = 1;
  }
  receipt.status ??= "PASS";
  await mkdir(OUTPUT, { recursive: true });
  await writeFile(resolve(OUTPUT, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  console.log(JSON.stringify(receipt, null, 2));
}
