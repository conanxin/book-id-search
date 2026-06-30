import "dotenv/config";
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { MeiliSearch } from "meilisearch";
import { parseBookLine, type BookDocument } from "./parse-line.ts";

const DEFAULT_INDEX = process.env.MEILI_INDEX ?? "books";
const MIN_TASK_TIMEOUT_MS = 600_000;

interface ImportOptions {
  file: string;
  index: string;
  limit?: number;
  batchSize: number;
  dryRun: boolean;
  resetIndex: boolean;
  report: string;
  offset: number;
  checkpoint?: string;
  resume: boolean;
  maxErrors: number;
  waitTimeoutMs: number;
  searchRawInfo: boolean;
  benchmarkLabel?: string;
  cleanupBenchmarkIndex: boolean;
  indexWasProvided: boolean;
  batchSizeWasProvided: boolean;
  reportWasProvided: boolean;
  waitTimeoutWasProvided: boolean;
  searchRawInfoWasProvided: boolean;
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
  batchSize: number;
  waitTimeoutMs: number;
  searchRawInfo: boolean;
  benchmarkLabel: string | null;
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
  rowsPerSecond: number | null;
  meiliTaskCount: number;
  averageTaskWaitSeconds: number | null;
  totalTaskWaitSeconds: number;
  cleanupBenchmarkIndex: boolean;
  cleanupStatus: "not_requested" | "deleted" | "skipped_default_index" | "failed";
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
  waitTimeoutMs: number;
  searchRawInfo: boolean;
  benchmarkLabel: string | null;
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

interface TaskWaitStats {
  count: number;
  totalSeconds: number;
}

function parseOptionalInt(value: string | undefined, label: string) {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be an integer`);
  return parsed;
}

function parseOptionalBoolean(value: string | undefined, label: string) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new Error(`${label} must be true or false`);
}

function safeReportIndexName(indexName: string) {
  return indexName.replace(/[^a-zA-Z0-9_-]+/g, "_") || "index";
}

function splitArg(arg: string) {
  const eq = arg.indexOf("=");
  if (eq === -1) return { name: arg, inlineValue: undefined };
  return { name: arg.slice(0, eq), inlineValue: arg.slice(eq + 1) };
}

function roundSeconds(value: number) {
  return Number(value.toFixed(2));
}

function parseArgs(argv: string[]): ImportOptions {
  const options: ImportOptions = {
    file: "",
    index: DEFAULT_INDEX,
    batchSize: 5000,
    dryRun: false,
    resetIndex: false,
    report: "reports/latest-import-report.json",
    offset: 0,
    resume: false,
    maxErrors: Number.POSITIVE_INFINITY,
    waitTimeoutMs: MIN_TASK_TIMEOUT_MS,
    searchRawInfo: true,
    cleanupBenchmarkIndex: false,
    indexWasProvided: false,
    batchSizeWasProvided: false,
    reportWasProvided: false,
    waitTimeoutWasProvided: false,
    searchRawInfoWasProvided: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const { name, inlineValue } = splitArg(argv[i]);
    const nextValue = () => inlineValue ?? argv[++i] ?? "";

    if (name === "--file") options.file = nextValue();
    else if (name === "--index") {
      options.index = nextValue();
      options.indexWasProvided = true;
    } else if (name === "--limit") options.limit = parseOptionalInt(nextValue(), "--limit");
    else if (name === "--batch-size") {
      options.batchSize = parseOptionalInt(nextValue(), "--batch-size");
      options.batchSizeWasProvided = true;
    } else if (name === "--dry-run") options.dryRun = true;
    else if (name === "--reset-index") options.resetIndex = true;
    else if (name === "--report") {
      options.report = nextValue();
      options.reportWasProvided = true;
    } else if (name === "--offset") options.offset = parseOptionalInt(nextValue(), "--offset");
    else if (name === "--checkpoint") options.checkpoint = nextValue();
    else if (name === "--resume") options.resume = true;
    else if (name === "--max-errors") options.maxErrors = parseOptionalInt(nextValue(), "--max-errors");
    else if (name === "--wait-timeout-ms") {
      options.waitTimeoutMs = parseOptionalInt(nextValue(), "--wait-timeout-ms");
      options.waitTimeoutWasProvided = true;
    } else if (name === "--search-raw-info") {
      options.searchRawInfo = parseOptionalBoolean(nextValue(), "--search-raw-info");
      options.searchRawInfoWasProvided = true;
    } else if (name === "--benchmark-label") options.benchmarkLabel = nextValue();
    else if (name === "--cleanup-benchmark-index") {
      options.cleanupBenchmarkIndex = parseOptionalBoolean(nextValue(), "--cleanup-benchmark-index");
    } else throw new Error(`Unknown argument: ${argv[i]}`);
  }

  if (!options.index) throw new Error("--index must not be empty");
  if (!Number.isFinite(options.batchSize) || options.batchSize <= 0) throw new Error("--batch-size must be a positive integer");
  if (options.limit !== undefined && (!Number.isFinite(options.limit) || options.limit <= 0)) {
    throw new Error("--limit must be a positive integer");
  }
  if (!Number.isFinite(options.offset) || options.offset < 0) throw new Error("--offset must be a non-negative integer");
  if (options.maxErrors !== Number.POSITIVE_INFINITY && (!Number.isFinite(options.maxErrors) || options.maxErrors < 0)) {
    throw new Error("--max-errors must be a non-negative integer");
  }
  if (!Number.isFinite(options.waitTimeoutMs) || options.waitTimeoutMs <= 0) {
    throw new Error("--wait-timeout-ms must be a positive integer");
  }
  options.waitTimeoutMs = Math.max(options.waitTimeoutMs, MIN_TASK_TIMEOUT_MS);
  if (options.resume && !options.checkpoint) options.checkpoint = "reports/import-checkpoint.json";
  if (!options.file && !(options.resume && options.checkpoint)) throw new Error("Missing --file <path>");
  if (!options.reportWasProvided && options.index !== DEFAULT_INDEX) {
    options.report = path.join("reports", `${safeReportIndexName(options.index)}-import-report.json`);
  }

  return options;
}

function readCheckpoint(checkpointPath: string): ImportCheckpoint | null {
  if (!existsSync(checkpointPath)) return null;
  return JSON.parse(readFileSync(checkpointPath, "utf8")) as ImportCheckpoint;
}

async function waitForTask(
  client: MeiliSearch,
  task: { taskUid?: number; uid?: number },
  taskStats: TaskWaitStats,
  waitTimeoutMs: number
) {
  const taskUid = task.taskUid ?? task.uid;
  if (taskUid === undefined) return;
  const started = Date.now();
  const result = await client.tasks.waitForTask(taskUid, { timeout: waitTimeoutMs });
  taskStats.count += 1;
  taskStats.totalSeconds += (Date.now() - started) / 1000;
  if (result.status === "failed") {
    throw new Error(result.error?.message ?? `Meilisearch task ${taskUid} failed`);
  }
}

async function configureIndex(
  client: MeiliSearch,
  indexName: string,
  resetIndex: boolean,
  searchRawInfo: boolean,
  taskStats: TaskWaitStats,
  waitTimeoutMs: number
) {
  if (resetIndex) {
    try {
      await waitForTask(client, await client.deleteIndex(indexName), taskStats, waitTimeoutMs);
    } catch {
      // Missing index is fine during a reset.
    }
  }

  try {
    await waitForTask(client, await client.createIndex(indexName, { primaryKey: "id" }), taskStats, waitTimeoutMs);
  } catch {
    // Existing index is fine; settings are refreshed below.
  }

  const index = client.index<BookDocument>(indexName);
  const searchableAttributes = ["title", "author", "publisher", "isbn", "ssid", "dxid"];
  if (searchRawInfo) searchableAttributes.push("rawInfo");

  await waitForTask(
    client,
    await index.updateSettings({
      searchableAttributes,
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
    }),
    taskStats,
    waitTimeoutMs
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
  if (report.index !== DEFAULT_INDEX) return;
  if (path.normalize(reportPath) !== path.normalize(latestReportPath)) {
    writeReport(report, latestReportPath);
  }
}

function writeCheckpoint(report: ImportReport, options: ImportOptions, warnings: Set<string>) {
  if (!options.checkpoint) return;
  const checkpoint: ImportCheckpoint = {
    file: report.file,
    index: report.index,
    dryRun: report.dryRun,
    offset: report.offset,
    limit: report.limit,
    batchSize: options.batchSize,
    waitTimeoutMs: options.waitTimeoutMs,
    searchRawInfo: options.searchRawInfo,
    benchmarkLabel: options.benchmarkLabel ?? null,
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

function updateTaskMetrics(report: ImportReport, taskStats: TaskWaitStats) {
  report.meiliTaskCount = taskStats.count;
  report.totalTaskWaitSeconds = roundSeconds(taskStats.totalSeconds);
  report.averageTaskWaitSeconds = taskStats.count ? roundSeconds(taskStats.totalSeconds / taskStats.count) : null;
}

function progressLine(report: ImportReport, started: number) {
  const elapsedSeconds = Math.max((Date.now() - started) / 1000, 0.001);
  const rate = report.totalLines / elapsedSeconds;
  return `[import] index=${report.index} offset=${report.offset} processed=${report.totalLines} lastLine=${report.lastProcessedLine} imported=${report.imported} weak=${report.weakParsed} failed=${report.failedParsed} elapsed=${elapsedSeconds.toFixed(1)}s rate=${rate.toFixed(1)} lines/s`;
}

function applyResume(options: ImportOptions, checkpoint: ImportCheckpoint | null) {
  if (!options.resume) return { options, resumedFrom: null, checkpoint: null };
  if (!checkpoint) throw new Error(`Cannot resume: checkpoint does not exist: ${options.checkpoint}`);

  const nextOptions = { ...options };
  nextOptions.file = nextOptions.file || checkpoint.file;
  nextOptions.offset = checkpoint.lastProcessedLine;
  if (!options.indexWasProvided) nextOptions.index = checkpoint.index;
  if (!options.batchSizeWasProvided) nextOptions.batchSize = checkpoint.batchSize;
  if (!options.waitTimeoutWasProvided) nextOptions.waitTimeoutMs = checkpoint.waitTimeoutMs ?? nextOptions.waitTimeoutMs;
  if (!options.searchRawInfoWasProvided) nextOptions.searchRawInfo = checkpoint.searchRawInfo ?? nextOptions.searchRawInfo;
  if (!options.benchmarkLabel) nextOptions.benchmarkLabel = checkpoint.benchmarkLabel ?? undefined;

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
  if (!existsSync(options.file)) throw new Error(`File does not exist: ${options.file}`);

  const host = process.env.MEILI_HOST ?? "http://127.0.0.1:7700";
  const apiKey = process.env.MEILI_MASTER_KEY;
  const started = Date.now();
  const taskStats: TaskWaitStats = { count: 0, totalSeconds: 0 };
  const report: ImportReport = {
    dryRun: options.dryRun,
    file: options.file,
    index: options.index,
    batchSize: options.batchSize,
    waitTimeoutMs: options.waitTimeoutMs,
    searchRawInfo: options.searchRawInfo,
    benchmarkLabel: options.benchmarkLabel ?? null,
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
    rowsPerSecond: null,
    meiliTaskCount: 0,
    averageTaskWaitSeconds: null,
    totalTaskWaitSeconds: 0,
    cleanupBenchmarkIndex: options.cleanupBenchmarkIndex,
    cleanupStatus: options.cleanupBenchmarkIndex ? "failed" : "not_requested",
    samples: resumed.checkpoint?.samples ?? { ok: [], weak: [], failed: [] },
    warnings: resumed.checkpoint?.warnings ?? []
  };

  const warningSet = new Set<string>(report.warnings);
  const seenIds = new Set<string>();
  const batch: BookDocument[] = [];
  const client = options.dryRun ? null : new MeiliSearch({ host, apiKey });
  const index = client
    ? await configureIndex(client, options.index, options.resetIndex && !options.resume, options.searchRawInfo, taskStats, options.waitTimeoutMs)
    : null;

  async function flushBatch() {
    if (!batch.length) return;
    if (index && client) {
      await waitForTask(client, await index.addDocuments(batch, { primaryKey: "id" }), taskStats, options.waitTimeoutMs);
    }
    report.imported += batch.length;
    batch.length = 0;
    updateTaskMetrics(report, taskStats);
    writeCheckpoint(report, options, warningSet);
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
      writeCheckpoint(report, options, warningSet);
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
      throw new Error(`failedParsed=${report.failedParsed} exceeds --max-errors=${options.maxErrors}`);
    }

    batch.push(book);
    if (batch.length >= options.batchSize) await flushBatch();

    if (processedThisRun % 10000 === 0) {
      console.log(progressLine(report, started));
    }
  }

  await flushBatch();

  if (client && options.cleanupBenchmarkIndex) {
    if (options.index === DEFAULT_INDEX) {
      report.cleanupStatus = "skipped_default_index";
    } else {
      await waitForTask(client, await client.deleteIndex(options.index), taskStats, options.waitTimeoutMs);
      report.cleanupStatus = "deleted";
    }
  }

  const finished = Date.now();
  report.finishedAt = new Date(finished).toISOString();
  report.elapsedSeconds = roundSeconds((finished - started) / 1000);
  report.rowsPerSecond = report.elapsedSeconds ? Number((report.imported / report.elapsedSeconds).toFixed(2)) : null;
  report.warnings = [...warningSet].sort();
  updateTaskMetrics(report, taskStats);
  writeCheckpoint(report, options, warningSet);
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
