import "dotenv/config";
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { MeiliSearch } from "meilisearch";
import { parseBookLine, type BookDocument } from "./parse-line.ts";

interface ImportOptions {
  file: string;
  limit?: number;
  batchSize: number;
  dryRun: boolean;
  resetIndex: boolean;
  report: string;
  offset: number;
  checkpoint?: string;
  resume: boolean;
  maxErrors: number;
}

interface ImportSamples {
  ok: BookDocument[];
  weak: BookDocument[];
  failed: BookDocument[];
}

interface ImportReport {
  dryRun: boolean;
  file: string;
  index: string;
  offset: number;
  limit: number | null;
  checkpointPath: string | null;
  resumedFrom: number | null;
  totalLines: number;
  imported: number;
  skipped: number;
  weakParsed: number;
  failedParsed: number;
  duplicateLikeCount: number;
  lastProcessedLine: number;
  startedAt: string;
  finishedAt: string | null;
  elapsedSeconds: number | null;
  samples: ImportSamples;
  warnings: string[];
}

interface ImportCheckpoint {
  file: string;
  index: string;
  dryRun: boolean;
  offset: number;
  limit: number | null;
  batchSize: number;
  lastProcessedLine: number;
  totalLines: number;
  imported: number;
  skipped: number;
  weakParsed: number;
  failedParsed: number;
  duplicateLikeCount: number;
  warnings: string[];
  samples: ImportSamples;
  startedAt: string;
  updatedAt: string;
}

function parseOptionalInt(value: string | undefined, label: string) {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) throw new Error(`${label} 必须是整数`);
  return parsed;
}

function parseArgs(argv: string[]): ImportOptions {
  const options: ImportOptions = {
    file: "",
    batchSize: 5000,
    dryRun: false,
    resetIndex: false,
    report: "reports/latest-import-report.json",
    offset: 0,
    resume: false,
    maxErrors: Number.POSITIVE_INFINITY
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--file") options.file = argv[++i] ?? "";
    else if (arg === "--limit") options.limit = parseOptionalInt(argv[++i], "--limit");
    else if (arg === "--batch-size") options.batchSize = parseOptionalInt(argv[++i], "--batch-size");
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--reset-index") options.resetIndex = true;
    else if (arg === "--report") options.report = argv[++i] ?? options.report;
    else if (arg === "--offset") options.offset = parseOptionalInt(argv[++i], "--offset");
    else if (arg === "--checkpoint") options.checkpoint = argv[++i] ?? "";
    else if (arg === "--resume") options.resume = true;
    else if (arg === "--max-errors") options.maxErrors = parseOptionalInt(argv[++i], "--max-errors");
    else throw new Error(`未知参数：${arg}`);
  }

  if (!Number.isFinite(options.batchSize) || options.batchSize <= 0) throw new Error("--batch-size 必须是正整数");
  if (options.limit !== undefined && (!Number.isFinite(options.limit) || options.limit <= 0)) {
    throw new Error("--limit 必须是正整数");
  }
  if (!Number.isFinite(options.offset) || options.offset < 0) throw new Error("--offset 必须是非负整数");
  if (options.maxErrors !== Number.POSITIVE_INFINITY && (!Number.isFinite(options.maxErrors) || options.maxErrors < 0)) {
    throw new Error("--max-errors 必须是非负整数");
  }
  if (options.resume && !options.checkpoint) options.checkpoint = "reports/import-checkpoint.json";
  if (!options.file && !(options.resume && options.checkpoint)) throw new Error("缺少 --file <path>");

  return options;
}

function readCheckpoint(checkpointPath: string): ImportCheckpoint | null {
  if (!existsSync(checkpointPath)) return null;
  return JSON.parse(readFileSync(checkpointPath, "utf8")) as ImportCheckpoint;
}

async function waitForTask(client: MeiliSearch, task: { taskUid?: number; uid?: number }) {
  const taskUid = task.taskUid ?? task.uid;
  if (taskUid === undefined) return;
  const result = await client.tasks.waitForTask(taskUid, { timeout: 600000 });
  if (result.status === "failed") {
    throw new Error(result.error?.message ?? `Meilisearch task ${taskUid} failed`);
  }
}

async function configureIndex(client: MeiliSearch, indexName: string, resetIndex: boolean) {
  if (resetIndex) {
    try {
      await waitForTask(client, await client.deleteIndex(indexName));
    } catch {
      // Missing index is fine during a reset.
    }
  }

  try {
    await waitForTask(client, await client.createIndex(indexName, { primaryKey: "id" }));
  } catch {
    // Existing index is fine; settings are refreshed below.
  }

  const index = client.index<BookDocument>(indexName);
  await waitForTask(
    client,
    await index.updateSettings({
      searchableAttributes: ["title", "author", "publisher", "isbn", "ssid", "dxid", "rawInfo"],
      displayedAttributes: [
        "id",
        "ssid",
        "dxid",
        "title",
        "author",
        "publisher",
        "year",
        "pages",
        "isbn",
        "rawInfo",
        "parseStatus",
        "parseWarnings"
      ],
      filterableAttributes: ["year", "publisher", "parseStatus"],
      sortableAttributes: ["year"],
      rankingRules: ["words", "typo", "proximity", "attribute", "sort", "exactness"]
    })
  );
  return index;
}

function addSample(samples: ImportSamples, book: BookDocument) {
  const bucket = samples[book.parseStatus];
  if (bucket.length < 5) bucket.push(book);
}

function writeReport(report: ImportReport, reportPath: string) {
  mkdirSync(path.dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function writePrimaryAndLatestReports(report: ImportReport, reportPath: string) {
  writeReport(report, reportPath);
  const latestReportPath = path.join("reports", "latest-import-report.json");
  if (path.normalize(reportPath) !== path.normalize(latestReportPath)) {
    writeReport(report, latestReportPath);
  }
}

function writeCheckpoint(report: ImportReport, options: ImportOptions, indexName: string, warnings: Set<string>) {
  if (!options.checkpoint) return;
  const checkpoint: ImportCheckpoint = {
    file: report.file,
    index: indexName,
    dryRun: report.dryRun,
    offset: report.offset,
    limit: report.limit,
    batchSize: options.batchSize,
    lastProcessedLine: report.lastProcessedLine,
    totalLines: report.totalLines,
    imported: report.imported,
    skipped: report.skipped,
    weakParsed: report.weakParsed,
    failedParsed: report.failedParsed,
    duplicateLikeCount: report.duplicateLikeCount,
    warnings: [...warnings].sort(),
    samples: report.samples,
    startedAt: report.startedAt,
    updatedAt: new Date().toISOString()
  };
  mkdirSync(path.dirname(options.checkpoint), { recursive: true });
  writeFileSync(options.checkpoint, `${JSON.stringify(checkpoint, null, 2)}\n`, "utf8");
}

function progressLine(report: ImportReport, started: number) {
  const elapsedSeconds = Math.max((Date.now() - started) / 1000, 0.001);
  const rate = report.totalLines / elapsedSeconds;
  return `[import] offset=${report.offset} processed=${report.totalLines} lastLine=${report.lastProcessedLine} imported=${report.imported} weak=${report.weakParsed} failed=${report.failedParsed} elapsed=${elapsedSeconds.toFixed(1)}s rate=${rate.toFixed(1)} lines/s`;
}

function applyResume(options: ImportOptions, checkpoint: ImportCheckpoint | null) {
  if (!options.resume) return { options, resumedFrom: null, checkpoint: null };
  if (!checkpoint) throw new Error(`无法 resume：checkpoint 不存在：${options.checkpoint}`);

  const nextOptions = { ...options };
  nextOptions.file = nextOptions.file || checkpoint.file;
  nextOptions.offset = checkpoint.lastProcessedLine;
  nextOptions.batchSize = options.batchSize || checkpoint.batchSize;

  const originalTarget = checkpoint.limit === null ? null : checkpoint.offset + checkpoint.limit;
  if (options.limit === undefined && originalTarget !== null) {
    nextOptions.limit = Math.max(originalTarget - checkpoint.lastProcessedLine, 0);
  }

  return { options: nextOptions, resumedFrom: checkpoint.lastProcessedLine, checkpoint };
}

export async function runImport(argv = process.argv.slice(2)) {
  const parsedOptions = parseArgs(argv);
  const loadedCheckpoint = parsedOptions.resume && parsedOptions.checkpoint ? readCheckpoint(parsedOptions.checkpoint) : null;
  const resumed = applyResume(parsedOptions, loadedCheckpoint);
  const options = resumed.options;
  if (!existsSync(options.file)) throw new Error(`文件不存在：${options.file}`);

  const host = process.env.MEILI_HOST ?? "http://127.0.0.1:7700";
  const apiKey = process.env.MEILI_MASTER_KEY;
  const indexName = process.env.MEILI_INDEX ?? "books";
  const started = Date.now();
  const report: ImportReport = {
    dryRun: options.dryRun,
    file: options.file,
    index: indexName,
    offset: options.offset,
    limit: options.limit ?? null,
    checkpointPath: options.checkpoint ?? null,
    resumedFrom: resumed.resumedFrom,
    totalLines: resumed.checkpoint?.totalLines ?? 0,
    imported: resumed.checkpoint?.imported ?? 0,
    skipped: resumed.checkpoint?.skipped ?? 0,
    weakParsed: resumed.checkpoint?.weakParsed ?? 0,
    failedParsed: resumed.checkpoint?.failedParsed ?? 0,
    duplicateLikeCount: resumed.checkpoint?.duplicateLikeCount ?? 0,
    lastProcessedLine: options.offset,
    startedAt: resumed.checkpoint?.startedAt ?? new Date(started).toISOString(),
    finishedAt: null,
    elapsedSeconds: null,
    samples: resumed.checkpoint?.samples ?? { ok: [], weak: [], failed: [] },
    warnings: resumed.checkpoint?.warnings ?? []
  };

  const warningSet = new Set<string>(report.warnings);
  const seenIds = new Set<string>();
  const batch: BookDocument[] = [];
  const client = options.dryRun ? null : new MeiliSearch({ host, apiKey });
  const index = client ? await configureIndex(client, indexName, options.resetIndex && !options.resume) : null;

  async function flushBatch() {
    if (!batch.length) return;
    if (index && client) {
      await waitForTask(client, await index.addDocuments(batch, { primaryKey: "id" }));
    }
    report.imported += batch.length;
    batch.length = 0;
    writeCheckpoint(report, options, indexName, warningSet);
  }

  const input = createReadStream(options.file, { encoding: "utf8" });
  const rl = createInterface({ input, crlfDelay: Infinity });
  let absoluteLine = 0;
  let processedThisRun = 0;

  for await (const line of rl) {
    absoluteLine += 1;
    if (absoluteLine <= options.offset) continue;
    if (options.limit !== undefined && processedThisRun >= options.limit) break;

    processedThisRun += 1;
    report.totalLines += 1;
    report.lastProcessedLine = absoluteLine;

    if (!line.trim()) {
      report.skipped += 1;
      writeCheckpoint(report, options, indexName, warningSet);
      continue;
    }

    const book = parseBookLine(line, { lineNumber: absoluteLine });
    if (seenIds.has(book.id)) report.duplicateLikeCount += 1;
    seenIds.add(book.id);

    if (book.parseStatus === "weak") report.weakParsed += 1;
    if (book.parseStatus === "failed") report.failedParsed += 1;
    for (const warning of book.parseWarnings) warningSet.add(warning);
    addSample(report.samples, book);

    if (Number.isFinite(options.maxErrors) && report.failedParsed > options.maxErrors) {
      throw new Error(`failedParsed=${report.failedParsed} 已超过 --max-errors=${options.maxErrors}`);
    }

    batch.push(book);
    if (batch.length >= options.batchSize) await flushBatch();

    if (processedThisRun % 10000 === 0) {
      console.log(progressLine(report, started));
    }
  }

  await flushBatch();
  const finished = Date.now();
  report.finishedAt = new Date(finished).toISOString();
  report.elapsedSeconds = Number(((finished - started) / 1000).toFixed(2));
  report.warnings = [...warningSet].sort();
  writeCheckpoint(report, options, indexName, warningSet);
  writePrimaryAndLatestReports(report, options.report);
  console.log(progressLine(report, started));
  console.log(`[import] report written: ${options.report}`);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runImport().catch((error) => {
    console.error(`[import] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
