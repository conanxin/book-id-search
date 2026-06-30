import "dotenv/config";
import { execFileSync } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statfsSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

interface PreflightOptions {
  file: string;
  meiliDataDir: string;
  sampleLimit: number;
  estimateMultiplier: number;
  report: string;
}

interface DiskInfo {
  path: string;
  root: string;
  freeBytes: number;
  totalBytes: number;
}

interface PreflightReport {
  status: "READY" | "BLOCKED";
  file: string;
  fileSizeBytes: number;
  estimatedTotalLines: number;
  sampleLimit: number;
  sampleLines: number;
  averageBytesPerLine: number;
  meiliDataDir: string;
  txtDisk: DiskInfo;
  meiliDisk: DiskInfo;
  baselineImported: number | null;
  baselineIndexBytes: number | null;
  estimateMultiplier: number;
  estimatedFullIndexBytes: number;
  requiredFreeBytes: number;
  reasons: string[];
  recommendations: string[];
  generatedAt: string;
}

function parseArgs(argv: string[]): PreflightOptions {
  const options: PreflightOptions = {
    file: "",
    meiliDataDir: process.env.MEILI_DATA_DIR || inferRunningMeiliDataDir() || "meili_data",
    sampleLimit: 100000,
    estimateMultiplier: 1.5,
    report: "reports/full-import-preflight.json"
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--file") options.file = argv[++i] ?? "";
    else if (arg === "--meili-data-dir") options.meiliDataDir = argv[++i] ?? options.meiliDataDir;
    else if (arg === "--sample-limit") options.sampleLimit = Number.parseInt(argv[++i] ?? "", 10);
    else if (arg === "--estimate-multiplier") options.estimateMultiplier = Number.parseFloat(argv[++i] ?? "");
    else if (arg === "--report") options.report = argv[++i] ?? options.report;
    else throw new Error(`未知参数：${arg}`);
  }

  if (!options.file) throw new Error("缺少 --file <path>");
  if (!Number.isFinite(options.sampleLimit) || options.sampleLimit <= 0) throw new Error("--sample-limit 必须是正整数");
  if (!Number.isFinite(options.estimateMultiplier) || options.estimateMultiplier <= 0) {
    throw new Error("--estimate-multiplier 必须是正数");
  }
  return options;
}

function inferRunningMeiliDataDir() {
  if (process.platform !== "win32") return null;
  try {
    const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const commandLine = execFileSync(
      powershell,
      [
        "-NoProfile",
        "-Command",
        "Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'meilisearch*' } | Select-Object -First 1 -ExpandProperty CommandLine"
      ],
      { encoding: "utf8", timeout: 5000 }
    ).trim();
    const match = commandLine.match(/--db-path\s+(?:"([^"]+)"|(\S+))/);
    return match?.[1] || match?.[2] || null;
  } catch {
    return null;
  }
}

function formatBytes(bytes: number) {
  const gib = bytes / 1024 / 1024 / 1024;
  if (gib >= 1) return `${gib.toFixed(2)} GiB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

function nearestExistingPath(targetPath: string) {
  let current = path.resolve(targetPath);
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return parent;
    current = parent;
  }
  return current;
}

function diskInfo(targetPath: string): DiskInfo {
  const existing = nearestExistingPath(targetPath);
  const stats = statfsSync(existing);
  return {
    path: path.resolve(targetPath),
    root: path.parse(path.resolve(existing)).root,
    freeBytes: Number(stats.bavail) * Number(stats.bsize),
    totalBytes: Number(stats.blocks) * Number(stats.bsize)
  };
}

async function estimateLines(file: string, sampleLimit: number) {
  let lines = 0;
  let bytes = 0;
  const rl = createInterface({
    input: createReadStream(file, { encoding: "utf8" }),
    crlfDelay: Infinity
  });
  for await (const line of rl) {
    lines += 1;
    bytes += Buffer.byteLength(`${line}\n`, "utf8");
    if (lines >= sampleLimit) break;
  }
  if (!lines) return { estimatedTotalLines: 0, sampleLines: 0, averageBytesPerLine: 0 };
  const fileSizeBytes = statSync(file).size;
  const averageBytesPerLine = bytes / lines;
  return {
    estimatedTotalLines: Math.round(fileSizeBytes / averageBytesPerLine),
    sampleLines: lines,
    averageBytesPerLine
  };
}

function readLatestImportReport() {
  const reportPath = "reports/latest-import-report.json";
  if (!existsSync(reportPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(reportPath, "utf8")) as { imported?: number };
    return raw.imported && raw.imported > 0 ? raw : null;
  } catch {
    return null;
  }
}

function readKnownBaselineFromMarkdown() {
  const reportPath = "reports/REAL_DATA_IMPORT_REPORT.md";
  if (!existsSync(reportPath)) return null;
  const text = readFileSync(reportPath, "utf8");
  const sizeMatch = text.match(/Meilisearch 数据目录约 ([\d.]+) MiB/);
  const importedMatches = [...text.matchAll(/imported：(\d+)/g)].map((match) => Number.parseInt(match[1], 10));
  if (!sizeMatch) return null;
  return {
    imported: importedMatches.length ? Math.max(...importedMatches) : 100000,
    indexBytes: Number.parseFloat(sizeMatch[1]) * 1024 * 1024
  };
}

function directorySizeBytes(targetPath: string) {
  if (!existsSync(targetPath)) return null;
  const stack = [targetPath];
  let total = 0;
  while (stack.length) {
    const current = stack.pop()!;
    const stat = statSync(current);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(current)) stack.push(path.join(current, entry));
    } else {
      total += stat.size;
    }
  }
  return total;
}

function markdownPathForReport(reportPath: string) {
  const normalized = path.normalize(reportPath);
  if (normalized === path.normalize("reports/full-import-preflight.json")) {
    return "reports/FULL_IMPORT_PREFLIGHT.md";
  }

  const parsed = path.parse(reportPath);
  const base = parsed.name
    .replace(/^full-import-preflight/i, "FULL_IMPORT_PREFLIGHT")
    .replace(/-/g, "_")
    .toUpperCase();
  return path.join(parsed.dir || "reports", `${base}.md`);
}

function writeReports(report: PreflightReport, reportPath: string) {
  mkdirSync("reports", { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const markdown = `# 全量导入前置检查

## 结论

- 状态：${report.status}
- 文件：\`${report.file}\`
- 文件大小：${formatBytes(report.fileSizeBytes)}
- 估算总行数：${report.estimatedTotalLines.toLocaleString()}
- Meilisearch 数据目录：\`${report.meiliDataDir}\`

## 空间估算

- 基线导入行数：${report.baselineImported ?? "未知"}
- 基线索引体积：${report.baselineIndexBytes ? formatBytes(report.baselineIndexBytes) : "未知，使用保守估算"}
- 估算倍率：${report.estimateMultiplier}
- 估算全量索引体积：${formatBytes(report.estimatedFullIndexBytes)}
- 建议可用空间：${formatBytes(report.requiredFreeBytes)}
- TXT 所在盘剩余：${formatBytes(report.txtDisk.freeBytes)}
- Meilisearch 数据盘剩余：${formatBytes(report.meiliDisk.freeBytes)}

## 原因

${report.reasons.map((reason) => `- ${reason}`).join("\n") || "- 无"}

## 建议

${report.recommendations.map((item) => `- ${item}`).join("\n")}
`;
  writeFileSync(markdownPathForReport(reportPath), markdown, "utf8");
}

export async function runPreflight(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const reasons: string[] = [];
  const recommendations = [
    "最低测试配置：2 核 4GB / 80GB SSD。",
    "推荐全量配置：4 核 8GB / 160GB SSD。",
    "更稳配置：4 核 16GB / 200GB SSD。",
    "先导入 500000 行，再导入 1000000 行，确认空间和耗时后再跑全量。",
    "将 Meilisearch 数据目录放在容量充足的 SSD 数据盘，不建议放在空间很小的系统盘。"
  ];

  if (!existsSync(options.file)) {
    reasons.push(`TXT 文件不存在：${options.file}`);
    const emptyDisk = diskInfo(process.cwd());
    const report: PreflightReport = {
      status: "BLOCKED",
      file: options.file,
      fileSizeBytes: 0,
      estimatedTotalLines: 0,
      sampleLimit: options.sampleLimit,
      sampleLines: 0,
      averageBytesPerLine: 0,
      meiliDataDir: options.meiliDataDir,
      txtDisk: emptyDisk,
      meiliDisk: diskInfo(options.meiliDataDir),
      baselineImported: null,
      baselineIndexBytes: null,
      estimateMultiplier: options.estimateMultiplier,
      estimatedFullIndexBytes: 0,
      requiredFreeBytes: 0,
      reasons,
      recommendations,
      generatedAt: new Date().toISOString()
    };
    writeReports(report, options.report);
    console.log(`[preflight] ${report.status}: ${reasons.join("; ")}`);
    return report;
  }

  const fileSizeBytes = statSync(options.file).size;
  const estimate = await estimateLines(options.file, options.sampleLimit);
  const txtDisk = diskInfo(options.file);
  const meiliDisk = diskInfo(options.meiliDataDir);
  const latest = readLatestImportReport();
  const markdownBaseline = readKnownBaselineFromMarkdown();
  const currentDataSize = directorySizeBytes(options.meiliDataDir);
  const latestImported = latest?.imported ?? null;
  const baselineImported =
    latestImported && latestImported >= 100000 ? latestImported : markdownBaseline?.imported ?? latestImported ?? null;
  const baselineIndexCandidates = [markdownBaseline?.indexBytes, currentDataSize].filter(
    (value): value is number => typeof value === "number" && value > 0
  );
  const baselineIndexBytes = baselineIndexCandidates.length ? Math.max(...baselineIndexCandidates) : null;
  const fallbackBytesPerDoc = 6500;
  const bytesPerDoc =
    baselineImported && baselineIndexBytes ? baselineIndexBytes / baselineImported : fallbackBytesPerDoc;
  const estimatedFullIndexBytes = Math.ceil(bytesPerDoc * estimate.estimatedTotalLines * options.estimateMultiplier);
  const requiredFreeBytes = Math.ceil(estimatedFullIndexBytes + fileSizeBytes * 0.2);

  if (meiliDisk.freeBytes < requiredFreeBytes) {
    reasons.push(
      `Meilisearch 数据目录所在盘可用空间 ${formatBytes(meiliDisk.freeBytes)} 小于建议空间 ${formatBytes(requiredFreeBytes)}`
    );
  }
  if (estimate.estimatedTotalLines <= 0) reasons.push("无法估算 TXT 行数");
  if (!baselineImported) reasons.push("缺少可用的 latest-import-report.json 基线，已使用保守估算");

  const report: PreflightReport = {
    status: reasons.some((reason) => reason.includes("小于建议空间") || reason.includes("不存在")) ? "BLOCKED" : "READY",
    file: options.file,
    fileSizeBytes,
    estimatedTotalLines: estimate.estimatedTotalLines,
    sampleLimit: options.sampleLimit,
    sampleLines: estimate.sampleLines,
    averageBytesPerLine: Number(estimate.averageBytesPerLine.toFixed(2)),
    meiliDataDir: options.meiliDataDir,
    txtDisk,
    meiliDisk,
    baselineImported,
    baselineIndexBytes,
    estimateMultiplier: options.estimateMultiplier,
    estimatedFullIndexBytes,
    requiredFreeBytes,
    reasons,
    recommendations,
    generatedAt: new Date().toISOString()
  };

  writeReports(report, options.report);
  console.log(`[preflight] ${report.status}: estimatedFullIndex=${formatBytes(report.estimatedFullIndexBytes)} free=${formatBytes(report.meiliDisk.freeBytes)}`);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runPreflight().catch((error) => {
    console.error(`[preflight] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
