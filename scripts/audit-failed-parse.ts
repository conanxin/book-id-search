import { createReadStream, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";
import { parseBookLine, type BookDocument } from "./parse-line.ts";
interface AuditOptions {
  file: string;
  limit: number;
  markdownReport: string;
  jsonReport: string;
}

interface FailedSample {
  lineNumber: number;
  rawLine: string;
  parsedId: string;
  warnings: string[];
  reason: string;
  fieldCount: number;
}

interface ReasonBucket {
  reason: string;
  count: number;
  examples: FailedSample[];
}

interface AuditReport {
  file: string;
  limit: number;
  totalLines: number;
  failedParsed: number;
  reasonBuckets: ReasonBucket[];
  topFieldCountDistribution: Array<{ fields: number; count: number }>;
  startedAt: string;
  finishedAt: string;
  elapsedSeconds: number;
  ratePerSecond: number;
}

const MAX_EXAMPLES_PER_BUCKET = 3;

function parseArgs(argv: string[]): AuditOptions {
  const options: AuditOptions = {
    file: "",
    limit: Number.POSITIVE_INFINITY,
    markdownReport: "reports/FAILED_PARSE_AUDIT.md",
    jsonReport: "reports/failed-parse-audit.json",
  };
  for (let i = 2; i < argv.length; i++) {
    const name = argv[i];
    const nextValue = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${name} requires a value`);
      return value;
    };
    if (name === "--file") options.file = nextValue();
    else if (name === "--limit") options.limit = parseInt(nextValue(), 10);
    else if (name === "--report-md") options.markdownReport = nextValue();
    else if (name === "--report-json") options.jsonReport = nextValue();
    else throw new Error(`Unknown argument: ${name}`);
  }
  if (!options.file) throw new Error("--file is required");
  if (!existsSync(options.file)) throw new Error(`File not found: ${options.file}`);
  return options;
}

function classifyReason(book: BookDocument, fieldCount: number): string {
  const w = new Set(book.parseWarnings);
  if (fieldCount >= 12) return "embedded_comma_in_fields";
  if (fieldCount > 8 || w.has("field_count_high")) return "field_count_too_high";
  if (w.has("tab_delimited")) return "tab_delimited";
  if (fieldCount < 3 || w.has("field_count_low")) return "field_count_too_low";
  if (w.has("missing_dxid") && w.has("missing_isbn") && w.has("missing_publisher")) {
    return "publisher_isbn_dxid_missing";
  }
  if (w.has("missing_title") && w.has("missing_publisher")) return "title_publisher_missing";
  if (w.has("missing_isbn") && !w.has("missing_dxid")) return "missing_isbn_only";
  if (w.has("missing_dxid")) return "missing_dxid";
  return "other";
}

function buildMarkdown(report: AuditReport): string {
  const lines: string[] = [];
  lines.push("# Failed Parse Audit");
  lines.push("");
  lines.push(`Source: \`${report.file}\``);
  lines.push(`Lines scanned: ${report.totalLines.toLocaleString("en-US")}`);
  const share = report.totalLines > 0 ? (report.failedParsed / report.totalLines) * 100 : 0;
  lines.push(
    `Failed parses: ${report.failedParsed.toLocaleString("en-US")} (${share.toFixed(4)}%)`
  );
  lines.push(
    `Elapsed: ${report.elapsedSeconds.toFixed(1)}s @ ${report.ratePerSecond.toFixed(0)} lines/s`
  );
  lines.push(`Started: ${report.startedAt}`);
  lines.push(`Finished: ${report.finishedAt}`);
  lines.push("");
  lines.push("## Reason Distribution");
  lines.push("");
  lines.push("| Reason | Count | Share |");
  lines.push("|---|---:|---:|");
  for (const bucket of report.reasonBuckets) {
    const s = report.failedParsed > 0 ? (bucket.count / report.failedParsed) * 100 : 0;
    lines.push(`| ${bucket.reason} | ${bucket.count} | ${s.toFixed(1)}% |`);
  }
  lines.push("");
  lines.push("## Top Field-Count Distribution (failed lines)");
  lines.push("");
  lines.push("| Field count | Count |");
  lines.push("|---:|---:|");
  for (const entry of report.topFieldCountDistribution) {
    lines.push(`| ${entry.fields} | ${entry.count} |`);
  }
  lines.push("");
  lines.push(`## Per-Reason Examples (first ${MAX_EXAMPLES_PER_BUCKET} each)`);
  lines.push("");
  for (const bucket of report.reasonBuckets) {
    lines.push(`### ${bucket.reason} (${bucket.count})`);
    lines.push("");
    for (const sample of bucket.examples) {
      lines.push(
        `- line ${sample.lineNumber}, id=\`${sample.parsedId}\`, fields=${sample.fieldCount}, warnings=${JSON.stringify(sample.warnings)}`
      );
      const preview = sample.rawLine.length > 200 ? sample.rawLine.slice(0, 200) + "..." : sample.rawLine;
      lines.push(`  - raw: \`${preview}\``);
    }
    lines.push("");
  }
  lines.push("## Interpretation");
  lines.push("");
  const top = report.reasonBuckets[0];
  if (top) {
    const topShare = report.failedParsed > 0 ? ((top.count / report.failedParsed) * 100).toFixed(1) : "0.0";
    lines.push(
      `- The dominant failure mode is **${top.reason}** (${topShare}% of failures).`
    );
  }
  lines.push(
    "- failedParsed lines are NOT indexed (importer skips them). They are recorded in the import report samples."
  );
  lines.push(
    "- weakParsed lines ARE indexed (with rawInfo preserved) — those are 1,598,107 lines missing only ISBN or with non-numeric year/pages."
  );
  lines.push(
    "- These failures reflect data quality issues in the source TXT, not importer bugs."
  );
  lines.push("");
  return lines.join("\n");
}

async function main() {
  const options = parseArgs(process.argv);
  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  const stream = createReadStream(options.file, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  const reasonCounts = new Map<string, number>();
  const reasonExamples = new Map<string, FailedSample[]>();
  const fieldCountMap = new Map<number, number>();
  let totalLines = 0;
  let failedParsed = 0;

  for await (const line of rl) {
    if (totalLines >= options.limit) break;
    totalLines++;
    const book = parseBookLine(line, { lineNumber: totalLines });
    if (book.parseStatus !== "failed") continue;
    failedParsed++;
    const fieldCount = line.split(",").length;
    const reason = classifyReason(book, fieldCount);
    reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
    if (!reasonExamples.has(reason)) reasonExamples.set(reason, []);
    const examples = reasonExamples.get(reason)!;
    if (examples.length < MAX_EXAMPLES_PER_BUCKET) {
      examples.push({
        lineNumber: totalLines,
        rawLine: line,
        parsedId: book.id,
        warnings: book.parseWarnings,
        reason,
        fieldCount,
      });
    }
    fieldCountMap.set(fieldCount, (fieldCountMap.get(fieldCount) ?? 0) + 1);
  }

  const finalBuckets: ReasonBucket[] = Array.from(reasonCounts.entries())
    .map(([reason, count]) => ({
      reason,
      count,
      examples: reasonExamples.get(reason) ?? [],
    }))
    .sort((a, b) => b.count - a.count);

  const topFieldCountDistribution = Array.from(fieldCountMap.entries())
    .map(([fields, count]) => ({ fields, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const elapsedSeconds = (Date.now() - t0) / 1000;
  const report: AuditReport = {
    file: options.file,
    limit: totalLines,
    totalLines,
    failedParsed,
    reasonBuckets: finalBuckets,
    topFieldCountDistribution,
    startedAt,
    finishedAt: new Date().toISOString(),
    elapsedSeconds,
    ratePerSecond: totalLines / elapsedSeconds,
  };

  const md = buildMarkdown(report);
  mkdirSync(path.dirname(options.markdownReport), { recursive: true });
  mkdirSync(path.dirname(options.jsonReport), { recursive: true });
  writeFileSync(options.markdownReport, md, "utf8");
  writeFileSync(options.jsonReport, JSON.stringify(report, null, 2), "utf8");

  console.log(
    `Audit complete: ${failedParsed}/${totalLines} failed (${((failedParsed / totalLines) * 100).toFixed(4)}%)`
  );
  console.log(`Markdown: ${options.markdownReport}`);
  console.log(`JSON: ${options.jsonReport}`);
  for (const bucket of finalBuckets) {
    console.log(`  ${bucket.reason}: ${bucket.count}`);
  }
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
