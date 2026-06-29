import { createReadStream, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { parseBookLine, type BookDocument } from "./parse-line.ts";

interface AuditOptions {
  file: string;
  limit: number;
  markdownReport: string;
  jsonReport: string;
}

interface WeakSample {
  lineNumber: number;
  id: string;
  title: string;
  warnings: string[];
  rawInfo: string;
}

interface AuditReport {
  file: string;
  limit: number;
  totalLines: number;
  okParsed: number;
  weakParsed: number;
  failedParsed: number;
  missingTitle: number;
  missingAuthor: number;
  missingPublisher: number;
  missingYear: number;
  missingPages: number;
  missingIsbn: number;
  missingSsid: number;
  missingDxid: number;
  reasonCounts: Record<string, number>;
  weakSamples: WeakSample[];
  startedAt: string;
  finishedAt: string;
  elapsedSeconds: number;
}

function parseArgs(argv: string[]): AuditOptions {
  const options: AuditOptions = {
    file: "",
    limit: 100000,
    markdownReport: "reports/PARSE_QUALITY_AUDIT.md",
    jsonReport: "reports/parse-quality-audit.json"
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--file") options.file = argv[++i] ?? "";
    else if (arg === "--limit") options.limit = Number.parseInt(argv[++i] ?? "", 10);
    else if (arg === "--report") options.markdownReport = argv[++i] ?? options.markdownReport;
    else if (arg === "--json-report") options.jsonReport = argv[++i] ?? options.jsonReport;
    else throw new Error(`未知参数：${arg}`);
  }

  if (!options.file) throw new Error("缺少 --file <path>");
  if (!Number.isFinite(options.limit) || options.limit <= 0) throw new Error("--limit 必须是正整数");
  return options;
}

function reasonKey(warning: string) {
  return warning.split(":")[0] || warning;
}

function increment(map: Record<string, number>, key: string) {
  map[key] = (map[key] ?? 0) + 1;
}

function hasWarning(book: BookDocument, key: string) {
  return book.parseWarnings.some((warning) => reasonKey(warning) === key);
}

function writeReports(report: AuditReport, options: AuditOptions) {
  mkdirSync(path.dirname(options.jsonReport), { recursive: true });
  mkdirSync(path.dirname(options.markdownReport), { recursive: true });
  writeFileSync(options.jsonReport, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  const weakRate = report.totalLines ? ((report.weakParsed / report.totalLines) * 100).toFixed(2) : "0.00";
  const failedRate = report.totalLines ? ((report.failedParsed / report.totalLines) * 100).toFixed(2) : "0.00";
  const reasons = Object.entries(report.reasonCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => `| ${reason} | ${count} |`)
    .join("\n");
  const samples = report.weakSamples
    .map(
      (sample) =>
        `| ${sample.lineNumber} | ${sample.id} | ${sample.title || "未命名"} | ${sample.warnings.join(", ")} | ${sample.rawInfo.replace(/\|/g, "\\|")} |`
    )
    .join("\n");

  const markdown = `# 解析质量审计

## 摘要

- 文件：\`${report.file}\`
- 抽样上限：${report.limit}
- 实际读取：${report.totalLines}
- okParsed：${report.okParsed}
- weakParsed：${report.weakParsed} (${weakRate}%)
- failedParsed：${report.failedParsed} (${failedRate}%)
- elapsedSeconds：${report.elapsedSeconds}

## 缺失字段统计

| 字段 | 行数 |
| --- | ---: |
| missingTitle | ${report.missingTitle} |
| missingAuthor | ${report.missingAuthor} |
| missingPublisher | ${report.missingPublisher} |
| missingYear | ${report.missingYear} |
| missingPages | ${report.missingPages} |
| missingIsbn | ${report.missingIsbn} |
| missingSsid | ${report.missingSsid} |
| missingDxid | ${report.missingDxid} |

## 弱解析原因分类

| 原因 | 行数 |
| --- | ---: |
${reasons || "| 无 | 0 |"}

## 弱解析样例

| 行号 | id | 标题 | warnings | rawInfo |
| ---: | --- | --- | --- | --- |
${samples || "| - | - | - | - | - |"}

## 判断

弱解析主要用于提示字段缺失或非标准行，导入脚本仍保留 \`rawInfo\`，不会丢失原始记录。
`;
  writeFileSync(options.markdownReport, markdown, "utf8");
}

export async function runAudit(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const started = Date.now();
  const report: AuditReport = {
    file: options.file,
    limit: options.limit,
    totalLines: 0,
    okParsed: 0,
    weakParsed: 0,
    failedParsed: 0,
    missingTitle: 0,
    missingAuthor: 0,
    missingPublisher: 0,
    missingYear: 0,
    missingPages: 0,
    missingIsbn: 0,
    missingSsid: 0,
    missingDxid: 0,
    reasonCounts: {},
    weakSamples: [],
    startedAt: new Date(started).toISOString(),
    finishedAt: "",
    elapsedSeconds: 0
  };

  const rl = createInterface({
    input: createReadStream(options.file, { encoding: "utf8" }),
    crlfDelay: Infinity
  });

  for await (const line of rl) {
    if (report.totalLines >= options.limit) break;
    report.totalLines += 1;
    const book = parseBookLine(line, { lineNumber: report.totalLines });

    if (book.parseStatus === "ok") report.okParsed += 1;
    if (book.parseStatus === "weak") report.weakParsed += 1;
    if (book.parseStatus === "failed") report.failedParsed += 1;

    if (!book.title || hasWarning(book, "missing_title")) report.missingTitle += 1;
    if (!book.author || hasWarning(book, "missing_author")) report.missingAuthor += 1;
    if (!book.publisher || hasWarning(book, "missing_publisher")) report.missingPublisher += 1;
    if (book.year === null || hasWarning(book, "missing_year")) report.missingYear += 1;
    if (book.pages === null || hasWarning(book, "missing_pages")) report.missingPages += 1;
    if (!book.isbn || hasWarning(book, "missing_isbn")) report.missingIsbn += 1;
    if (!book.ssid || hasWarning(book, "missing_ssid")) report.missingSsid += 1;
    if (!book.dxid || hasWarning(book, "missing_dxid")) report.missingDxid += 1;

    if (book.parseStatus !== "ok") {
      for (const warning of book.parseWarnings) increment(report.reasonCounts, reasonKey(warning));
      if (report.weakSamples.length < 50) {
        report.weakSamples.push({
          lineNumber: report.totalLines,
          id: book.id,
          title: book.title,
          warnings: book.parseWarnings,
          rawInfo: book.rawInfo
        });
      }
    }

    if (report.totalLines % 10000 === 0) {
      console.log(`[audit] lines=${report.totalLines} ok=${report.okParsed} weak=${report.weakParsed} failed=${report.failedParsed}`);
    }
  }

  const finished = Date.now();
  report.finishedAt = new Date(finished).toISOString();
  report.elapsedSeconds = Number(((finished - started) / 1000).toFixed(2));
  writeReports(report, options);
  console.log(`[audit] report written: ${options.markdownReport}`);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runAudit().catch((error) => {
    console.error(`[audit] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
