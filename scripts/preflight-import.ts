import "dotenv/config";
import { execFileSync } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statfsSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

type Profile = "standard" | "compact" | "minimal";

interface ProfileEstimate {
  name: Profile;
  bytesPerDoc: number;
  description: string;
}

const PROFILE_ESTIMATES: Record<Profile, ProfileEstimate> = {
  standard: {
    name: "standard",
    bytesPerDoc: 6500,
    description: "Full features: rawInfo stored, full filters, full sorting (conservative)"
  },
  compact: {
    name: "compact",
    bytesPerDoc: 3400,
    description: "Minimal profile with rawInfo stored, minimal filters, no sorting"
  },
  minimal: {
    name: "minimal",
    bytesPerDoc: 2000,
    description: "Minimal profile WITHOUT rawInfo stored, minimal filters, no sorting"
  }
};

interface PreflightOptions {
  file: string;
  meiliDataDir: string;
  sampleLimit: number;
  estimateMultiplier: number;
  report: string;
  profile: Profile;
  estimateFromReport?: string;
  requiredFreeAfterGb: number;
}

interface DiskInfo {
  path: string;
  root: string;
  freeBytes: number;
  totalBytes: number;
}

interface ImportReportForEstimate {
  imported: number;
  rawDocumentDbSize?: number;
  meiliDataDirSize?: number;
  indexProfile?: string;
  storeRawInfo?: boolean;
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
  
  // Profile-based estimates
  profile: Profile;
  estimateFromReport: string | null;
  
  conservativeEstimateBytes: number;
  measuredProfileEstimateBytes: number;
  currentDiskFreeBytes: number;
  
  estimatedFreeAfterFullBytes: number;
  requiredFreeAfterBytes: number;
  
  decisionForFull: "SAFE" | "RISKY" | "BLOCKED";
  
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
    report: "reports/full-import-preflight.json",
    profile: "standard",
    requiredFreeAfterGb: 15
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--file") options.file = argv[++i] ?? "";
    else if (arg === "--meili-data-dir") options.meiliDataDir = argv[++i] ?? options.meiliDataDir;
    else if (arg === "--sample-limit") options.sampleLimit = Number.parseInt(argv[++i] ?? "", 10);
    else if (arg === "--estimate-multiplier") options.estimateMultiplier = Number.parseFloat(argv[++i] ?? "");
    else if (arg === "--report") options.report = argv[++i] ?? options.report;
    else if (arg === "--profile") {
      const value = argv[++i];
      if (value !== "standard" && value !== "compact" && value !== "minimal") {
        throw new Error("--profile must be standard, compact, or minimal");
      }
      options.profile = value;
    }
    else if (arg === "--estimate-from-report") options.estimateFromReport = argv[++i];
    else if (arg === "--required-free-after-gb") options.requiredFreeAfterGb = Number.parseFloat(argv[++i] ?? "");
    else throw new Error(`未知参数：${arg}`);
  }

  if (!options.file) throw new Error("缺少 --file <path>");
  if (!Number.isFinite(options.sampleLimit) || options.sampleLimit <= 0) throw new Error("--sample-limit 必须是正整数");
  if (!Number.isFinite(options.estimateMultiplier) || options.estimateMultiplier <= 0) {
    throw new Error("--estimate-multiplier 必须是正数");
  }
  if (!Number.isFinite(options.requiredFreeAfterGb) || options.requiredFreeAfterGb < 0) {
    throw new Error("--required-free-after-gb 必须是非负数");
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

function readImportReportForEstimate(reportPath: string): ImportReportForEstimate | null {
  if (!existsSync(reportPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(reportPath, "utf8")) as {
      imported?: number;
      rawDocumentDbSize?: number;
      indexProfile?: string;
      storeRawInfo?: boolean;
    };
    if (!raw.imported || raw.imported <= 0) return null;
    return {
      imported: raw.imported,
      rawDocumentDbSize: raw.rawDocumentDbSize,
      indexProfile: raw.indexProfile,
      storeRawInfo: raw.storeRawInfo
    };
  } catch {
    return null;
  }
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
- 使用 Profile：${report.profile}
- 基于报告估算：${report.estimateFromReport || "否"}

## 空间估算

### Profile 实测估算
| 项目 | 数值 |
|------|------|
| 保守估算（standard） | ${formatBytes(report.conservativeEstimateBytes)} |
| 实测 Profile 估算 | ${formatBytes(report.measuredProfileEstimateBytes)} |
| 当前磁盘剩余 | ${formatBytes(report.currentDiskFreeBytes)} |
| 导入后估算剩余 | ${formatBytes(report.estimatedFreeAfterFullBytes)} |
| 要求导入后剩余 | ${formatBytes(report.requiredFreeAfterBytes)} |
| **全量决策** | **${report.decisionForFull}** |

### 基线信息
- 基线导入行数：${report.baselineImported ?? "未知"}
- 基线索引体积：${report.baselineIndexBytes ? formatBytes(report.baselineIndexBytes) : "未知，使用保守估算"}
- 估算倍率：${report.estimateMultiplier}
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
    `使用 profile: ${options.profile}`,
    `目标：导入后剩余 >= ${options.requiredFreeAfterGb} GiB`,
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
      profile: options.profile,
      estimateFromReport: options.estimateFromReport ?? null,
      conservativeEstimateBytes: 0,
      measuredProfileEstimateBytes: 0,
      currentDiskFreeBytes: 0,
      estimatedFreeAfterFullBytes: 0,
      requiredFreeAfterBytes: options.requiredFreeAfterGb * 1024 * 1024 * 1024,
      decisionForFull: "BLOCKED",
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
  const reportForEstimate = options.estimateFromReport
    ? readImportReportForEstimate(options.estimateFromReport)
    : null;
  
  const latestImported = latest?.imported ?? null;
  const baselineImported =
    latestImported && latestImported >= 100000 ? latestImported : markdownBaseline?.imported ?? latestImported ?? null;
  const baselineIndexCandidates = [markdownBaseline?.indexBytes, currentDataSize].filter(
    (value): value is number => typeof value === "number" && value > 0
  );
  const baselineIndexBytes = baselineIndexCandidates.length ? Math.max(...baselineIndexCandidates) : null;
  
  // Conservative estimate (standard profile)
  const fallbackBytesPerDoc = PROFILE_ESTIMATES.standard.bytesPerDoc;
  const bytesPerDoc =
    baselineImported && baselineIndexBytes ? baselineIndexBytes / baselineImported : fallbackBytesPerDoc;
  const conservativeEstimateBytes = Math.ceil(bytesPerDoc * estimate.estimatedTotalLines * options.estimateMultiplier);
  
  // Measured profile estimate
  let measuredProfileEstimateBytes: number;
  if (reportForEstimate && reportForEstimate.imported > 0) {
    // Use report-based calculation
    const sampleSize = reportForEstimate.rawDocumentDbSize ?? 0;
    const scaleFactor = estimate.estimatedTotalLines / reportForEstimate.imported;
    measuredProfileEstimateBytes = Math.ceil(sampleSize * scaleFactor * options.estimateMultiplier);
    reasons.push(`使用报告 ${options.estimateFromReport} 进行估算: ${reportForEstimate.imported} 行基线`);
  } else {
    // Use profile table lookup
    measuredProfileEstimateBytes = Math.ceil(
      PROFILE_ESTIMATES[options.profile].bytesPerDoc * estimate.estimatedTotalLines * options.estimateMultiplier
    );
    reasons.push(`使用 profile ${options.profile} 预设值估算: ${PROFILE_ESTIMATES[options.profile].bytesPerDoc} 字节/文档`);
  }
  
  // Calculate free space after full import
  const currentDiskFreeBytes = meiliDisk.freeBytes;
  const currentIndexOverhead = currentDataSize ?? 0;
  const estimatedFreeAfterFullBytes = currentDiskFreeBytes - currentIndexOverhead + measuredProfileEstimateBytes < currentDiskFreeBytes
    ? currentDiskFreeBytes - measuredProfileEstimateBytes
    : currentDiskFreeBytes + currentIndexOverhead - measuredProfileEstimateBytes;
  
  const requiredFreeAfterBytes = options.requiredFreeAfterGb * 1024 * 1024 * 1024;
  
  // Decision for full import
  let decisionForFull: "SAFE" | "RISKY" | "BLOCKED";
  if (estimatedFreeAfterFullBytes >= requiredFreeAfterBytes * 1.2) {
    decisionForFull = "SAFE";
  } else if (estimatedFreeAfterFullBytes >= requiredFreeAfterBytes) {
    decisionForFull = "RISKY";
  } else {
    decisionForFull = "BLOCKED";
  }
  
  const requiredFreeBytes = Math.ceil(measuredProfileEstimateBytes + fileSizeBytes * 0.2);

  if (meiliDisk.freeBytes < requiredFreeBytes) {
    reasons.push(
      `Meilisearch 数据目录所在盘可用空间 ${formatBytes(meiliDisk.freeBytes)} 小于建议空间 ${formatBytes(requiredFreeBytes)}`
    );
  }
  if (estimate.estimatedTotalLines <= 0) reasons.push("无法估算 TXT 行数");
  if (!baselineImported) reasons.push("缺少可用的 latest-import-report.json 基线，已使用保守估算");
  if (decisionForFull === "BLOCKED") {
    reasons.push(`导入后剩余空间 ${formatBytes(estimatedFreeAfterFullBytes)} 小于要求的 ${formatBytes(requiredFreeAfterBytes)}`);
  }

  const report: PreflightReport = {
    status: reasons.some((reason) => reason.includes("小于") || reason.includes("不存在")) ? "BLOCKED" : "READY",
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
    profile: options.profile,
    estimateFromReport: options.estimateFromReport ?? null,
    conservativeEstimateBytes,
    measuredProfileEstimateBytes,
    currentDiskFreeBytes,
    estimatedFreeAfterFullBytes: Math.max(0, estimatedFreeAfterFullBytes),
    requiredFreeAfterBytes,
    decisionForFull,
    requiredFreeBytes,
    reasons,
    recommendations,
    generatedAt: new Date().toISOString()
  };

  writeReports(report, options.report);
  console.log(`[preflight] ${report.status}: profile=${options.profile} measured=${formatBytes(report.measuredProfileEstimateBytes)} freeAfter=${formatBytes(report.estimatedFreeAfterFullBytes)} decision=${report.decisionForFull}`);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runPreflight().catch((error) => {
    console.error(`[preflight] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
