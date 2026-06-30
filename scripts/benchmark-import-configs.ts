import "dotenv/config";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { MeiliSearch } from "meilisearch";

interface BenchmarkOptions {
  file: string;
  keepIndexes: boolean;
  limit?: number;
  perConfigTimeoutMs: number;
  meiliDataDir: string;
}

interface BenchmarkConfig {
  label: string;
  index: string;
  requestedLimit: number;
  limit: number;
  batchSize: number;
  searchRawInfo: boolean;
}

interface BenchmarkResult {
  label: string;
  index: string;
  requestedLimit: number;
  limit: number;
  batchSize: number;
  searchRawInfo: boolean;
  status: "PASS" | "FAIL" | "TIMEOUT";
  elapsedSeconds: number | null;
  rowsPerSecond: number | null;
  imported: number | null;
  weakParsed: number | null;
  failedParsed: number | null;
  meiliTaskCount: number | null;
  totalTaskWaitSeconds: number | null;
  averageTaskWaitSeconds: number | null;
  dataDirBytesBefore: number | null;
  dataDirBytesAfter: number | null;
  dataDirDeltaBytes: number | null;
  verifiedDocumentCount: number | null;
  reportPath: string;
  error: string | null;
}

interface BookHit {
  id: string;
  ssid: string;
  dxid: string;
  title: string;
  author: string;
  publisher: string;
  isbn: string;
  rawInfo: string;
}

function parseIntArg(value: string | undefined, label: string) {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function splitArg(arg: string) {
  const eq = arg.indexOf("=");
  if (eq === -1) return { name: arg, inlineValue: undefined };
  return { name: arg.slice(0, eq), inlineValue: arg.slice(eq + 1) };
}

function parseArgs(argv: string[]): BenchmarkOptions {
  const options: BenchmarkOptions = {
    file: "",
    keepIndexes: false,
    perConfigTimeoutMs: 900_000,
    meiliDataDir: process.env.MEILI_DATA_DIR ?? "H:\\book-id-search\\meili_data"
  };

  for (let i = 0; i < argv.length; i += 1) {
    const { name, inlineValue } = splitArg(argv[i]);
    const nextValue = () => inlineValue ?? argv[++i] ?? "";
    if (name === "--file") options.file = nextValue();
    else if (name === "--keep-indexes") options.keepIndexes = true;
    else if (name === "--limit") options.limit = parseIntArg(nextValue(), "--limit");
    else if (name === "--per-config-timeout-ms") options.perConfigTimeoutMs = parseIntArg(nextValue(), "--per-config-timeout-ms");
    else if (name === "--meili-data-dir") options.meiliDataDir = nextValue();
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }

  if (!options.file) throw new Error("Missing --file <path>");
  if (!existsSync(options.file)) throw new Error(`File does not exist: ${options.file}`);
  return options;
}

function dirSizeBytes(target: string): number | null {
  if (!existsSync(target)) return null;
  let total = 0;
  const stack = [target];
  while (stack.length) {
    const current = stack.pop();
    if (!current) continue;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(fullPath);
      else if (entry.isFile()) total += statSync(fullPath).size;
    }
  }
  return total;
}

function formatBytes(bytes: number | null) {
  if (bytes === null) return "n/a";
  const gib = bytes / 1024 / 1024 / 1024;
  if (gib >= 1) return `${gib.toFixed(2)} GiB`;
  const mib = bytes / 1024 / 1024;
  return `${mib.toFixed(2)} MiB`;
}

function shouldDowngradeDefaultLimit() {
  const s13Report = path.join("reports", "REAL_500K_IMPORT_REPORT.md");
  if (!existsSync(s13Report)) return { downgrade: false, reason: null as string | null };
  const body = readFileSync(s13Report, "utf8");
  if (/4\.43|15963|31\./.test(body)) {
    return {
      downgrade: true,
      reason: "S13 500k import was slow enough that three 50k benchmark runs could take too long on this machine."
    };
  }
  return { downgrade: false, reason: null as string | null };
}

function benchmarkConfigs(limit: number): BenchmarkConfig[] {
  return [
    {
      label: "baseline-small",
      index: "books_bench_baseline",
      requestedLimit: 50_000,
      limit,
      batchSize: 5000,
      searchRawInfo: true
    },
    {
      label: "compact-search",
      index: "books_bench_compact",
      requestedLimit: 50_000,
      limit,
      batchSize: 10_000,
      searchRawInfo: false
    },
    {
      label: "larger-batch",
      index: "books_bench_large_batch",
      requestedLimit: 50_000,
      limit,
      batchSize: 20_000,
      searchRawInfo: false
    }
  ];
}

function runImportProcess(args: string[], timeoutMs: number) {
  return new Promise<{ timedOut: boolean; code: number | null; output: string }>((resolve) => {
    const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
    const child = spawn(command, ["exec", "tsx", "scripts/import-books.ts", ...args], {
      cwd: process.cwd(),
      env: process.env,
      shell: process.platform === "win32"
    });
    let output = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve({ timedOut: true, code: null, output });
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      const text = String(chunk);
      output += text;
      process.stdout.write(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = String(chunk);
      output += text;
      process.stderr.write(text);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ timedOut: false, code: 1, output: `${output}\n${error.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ timedOut: false, code, output });
    });
  });
}

async function waitDeleteIndex(client: MeiliSearch, indexName: string) {
  try {
    const task = await client.deleteIndex(indexName);
    const uid = (task as { taskUid?: number; uid?: number }).taskUid ?? (task as { taskUid?: number; uid?: number }).uid;
    if (uid !== undefined) await client.tasks.waitForTask(uid, { timeout: 600_000 });
    return "deleted";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function verifyCount(client: MeiliSearch, indexName: string) {
  const stats = await client.index(indexName).getStats();
  return stats.numberOfDocuments;
}

function readImportReport(reportPath: string): Record<string, unknown> | null {
  if (!existsSync(reportPath)) return null;
  return JSON.parse(readFileSync(reportPath, "utf8")) as Record<string, unknown>;
}

async function runBenchmark(config: BenchmarkConfig, options: BenchmarkOptions, client: MeiliSearch): Promise<BenchmarkResult> {
  const reportPath = path.join("reports", `import-benchmark-${config.label}.json`);
  const before = dirSizeBytes(options.meiliDataDir);
  const args = [
    "--file",
    options.file,
    "--index",
    config.index,
    "--limit",
    String(config.limit),
    "--batch-size",
    String(config.batchSize),
    "--search-raw-info",
    String(config.searchRawInfo),
    "--wait-timeout-ms",
    "600000",
    "--reset-index",
    "--benchmark-label",
    config.label,
    "--report",
    reportPath
  ];

  const processResult = await runImportProcess(args, options.perConfigTimeoutMs);
  const after = dirSizeBytes(options.meiliDataDir);
  const report = readImportReport(reportPath);
  let verifiedDocumentCount: number | null = null;
  let error: string | null = null;

  if (!processResult.timedOut && processResult.code === 0) {
    try {
      verifiedDocumentCount = await verifyCount(client, config.index);
    } catch (verifyError) {
      error = verifyError instanceof Error ? verifyError.message : String(verifyError);
    }
  } else if (processResult.timedOut) {
    error = `Timed out after ${options.perConfigTimeoutMs} ms`;
  } else {
    error = processResult.output.split(/\r?\n/).filter(Boolean).slice(-5).join("\n") || `import exited with code ${processResult.code}`;
  }

  return {
    label: config.label,
    index: config.index,
    requestedLimit: config.requestedLimit,
    limit: config.limit,
    batchSize: config.batchSize,
    searchRawInfo: config.searchRawInfo,
    status: processResult.timedOut ? "TIMEOUT" : processResult.code === 0 && verifiedDocumentCount === config.limit ? "PASS" : "FAIL",
    elapsedSeconds: typeof report?.elapsedSeconds === "number" ? report.elapsedSeconds : null,
    rowsPerSecond: typeof report?.rowsPerSecond === "number" ? report.rowsPerSecond : null,
    imported: typeof report?.imported === "number" ? report.imported : null,
    weakParsed: typeof report?.weakParsed === "number" ? report.weakParsed : null,
    failedParsed: typeof report?.failedParsed === "number" ? report.failedParsed : null,
    meiliTaskCount: typeof report?.meiliTaskCount === "number" ? report.meiliTaskCount : null,
    totalTaskWaitSeconds: typeof report?.totalTaskWaitSeconds === "number" ? report.totalTaskWaitSeconds : null,
    averageTaskWaitSeconds: typeof report?.averageTaskWaitSeconds === "number" ? report.averageTaskWaitSeconds : null,
    dataDirBytesBefore: before,
    dataDirBytesAfter: after,
    dataDirDeltaBytes: before !== null && after !== null ? after - before : null,
    verifiedDocumentCount,
    reportPath,
    error
  };
}

function cleanField(value: string | undefined) {
  return (value ?? "").trim();
}

function titleQuery(title: string) {
  return cleanField(title).slice(0, 12);
}

function publisherQuery(publisher: string) {
  return cleanField(publisher).replace(/^.*[：:]/, "").slice(0, 12);
}

function findRawOnlyCandidate(book: BookHit) {
  const known = [book.ssid, book.dxid, book.title, book.author, book.publisher, book.isbn, publisherQuery(book.publisher)]
    .filter(Boolean)
    .join(" ");
  const tokens = book.rawInfo
    .split(/[\s,，;；:：()（）《》\t]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3)
    .filter((token) => !/^[0-9Xx-]+$/.test(token))
    .filter((token) => !known.includes(token));
  return tokens[0] ?? null;
}

async function compareRawInfoSearch(client: MeiliSearch, trueIndex: string, falseIndex: string) {
  const rawIndex = client.index<BookHit>(trueIndex);
  const compactIndex = client.index<BookHit>(falseIndex);
  const seed = await rawIndex.search("", { limit: 100 });
  const book =
    seed.hits.find((hit) => hit.ssid && hit.dxid && hit.isbn && hit.title && hit.author && hit.publisher) ??
    seed.hits.find((hit) => hit.ssid && hit.dxid && hit.title && hit.author && hit.publisher);
  if (!book) {
    return {
      status: "SKIPPED",
      reason: "No comparable sample was found in benchmark index.",
      sample: null,
      checks: []
    };
  }

  const rawOnly = findRawOnlyCandidate(book);
  const checks = [
    { label: "SSID", query: book.ssid, required: true },
    { label: "DXID", query: book.dxid, required: true },
    ...(book.isbn ? [{ label: "ISBN", query: book.isbn, required: true }] : []),
    { label: "title", query: titleQuery(book.title), required: true },
    ...(book.author ? [{ label: "author", query: cleanField(book.author).slice(0, 12), required: true }] : []),
    ...(book.publisher ? [{ label: "publisher", query: publisherQuery(book.publisher), required: true }] : []),
    ...(rawOnly ? [{ label: "rawInfo-only", query: rawOnly, required: false }] : [])
  ].filter((check) => check.query);

  const results = [];
  for (const check of checks) {
    const [rawResult, compactResult] = await Promise.all([
      rawIndex.search(check.query, { limit: 10 }),
      compactIndex.search(check.query, { limit: 10 })
    ]);
    results.push({
      ...check,
      rawInfoSearchHits: rawResult.hits.length,
      compactSearchHits: compactResult.hits.length,
      rawInfoSearchContainsSample: rawResult.hits.some((hit) => hit.id === book.id),
      compactSearchContainsSample: compactResult.hits.some((hit) => hit.id === book.id)
    });
  }

  const standardChecksPass = results.filter((result) => result.required).every((result) => result.compactSearchHits > 0);
  return {
    status: standardChecksPass ? "PASS" : "FAIL",
    reason: standardChecksPass
      ? "Standard fields still match when rawInfo is not searchable."
      : "At least one standard field did not match in compact-search.",
    sample: {
      id: book.id,
      ssid: book.ssid,
      dxid: book.dxid,
      title: book.title,
      author: book.author,
      publisher: book.publisher,
      isbn: book.isbn,
      rawInfoOnlyCandidate: rawOnly
    },
    checks: results
  };
}

function markdownBenchmarkReport(payload: {
  startedAt: string;
  finishedAt: string;
  downgradeReason: string | null;
  meiliDataDir: string;
  keepIndexes: boolean;
  cleanupResults: Record<string, string>;
  results: BenchmarkResult[];
}) {
  const lines = [
    "# Import Performance Benchmark",
    "",
    `- Started: ${payload.startedAt}`,
    `- Finished: ${payload.finishedAt}`,
    `- Meilisearch data dir: \`${payload.meiliDataDir}\``,
    `- Benchmark indexes kept: ${payload.keepIndexes ? "yes" : "no"}`,
    `- Limit downgrade: ${payload.downgradeReason ?? "not applied"}`,
    "",
    "| config | index | requested | effective | batch | rawInfo searchable | status | elapsed | rows/sec | task wait | size delta | docs |",
    "| --- | --- | ---: | ---: | ---: | --- | --- | ---: | ---: | ---: | ---: | ---: |"
  ];

  for (const result of payload.results) {
    lines.push(
      `| ${result.label} | ${result.index} | ${result.requestedLimit} | ${result.limit} | ${result.batchSize} | ${String(result.searchRawInfo)} | ${result.status} | ${result.elapsedSeconds ?? "n/a"} | ${result.rowsPerSecond ?? "n/a"} | ${result.totalTaskWaitSeconds ?? "n/a"} | ${formatBytes(result.dataDirDeltaBytes)} | ${result.verifiedDocumentCount ?? "n/a"} |`
    );
  }

  lines.push("", "## Cleanup");
  if (Object.keys(payload.cleanupResults).length === 0) lines.push("- Benchmark indexes were kept.");
  else {
    for (const [index, status] of Object.entries(payload.cleanupResults)) lines.push(`- ${index}: ${status}`);
  }

  const passed = payload.results.filter((result) => result.status === "PASS");
  const best = passed
    .filter((result) => result.rowsPerSecond !== null)
    .sort((a, b) => (b.rowsPerSecond ?? 0) - (a.rowsPerSecond ?? 0))[0];
  lines.push("", "## Recommendation");
  if (best) {
    lines.push(
      `- Fastest successful config: \`${best.label}\` (${best.rowsPerSecond} rows/sec, batch size ${best.batchSize}, searchRawInfo=${best.searchRawInfo}).`
    );
    if (!best.searchRawInfo) {
      lines.push("- Production should prefer `--search-raw-info false` if search quality comparison also passes.");
    }
  } else {
    lines.push("- No benchmark config completed successfully; keep current import settings until a smaller benchmark passes.");
  }

  return `${lines.join("\n")}\n`;
}

function markdownSearchQualityReport(payload: Awaited<ReturnType<typeof compareRawInfoSearch>>) {
  const lines = [
    "# Search Quality RawInfo Comparison",
    "",
    `- Status: ${payload.status}`,
    `- Reason: ${payload.reason}`,
    ""
  ];

  if (payload.sample) {
    lines.push("## Sample", "");
    lines.push(`- id: \`${payload.sample.id}\``);
    lines.push(`- SSID: \`${payload.sample.ssid}\``);
    lines.push(`- DXID: \`${payload.sample.dxid}\``);
    lines.push(`- title: ${payload.sample.title}`);
    lines.push(`- author: ${payload.sample.author}`);
    lines.push(`- publisher: ${payload.sample.publisher}`);
    lines.push(`- ISBN: \`${payload.sample.isbn}\``);
    lines.push(`- rawInfo-only candidate: ${payload.sample.rawInfoOnlyCandidate ? `\`${payload.sample.rawInfoOnlyCandidate}\`` : "not found"}`);
    lines.push("");
  }

  lines.push("| query type | query | required | rawInfo=true hits | rawInfo=false hits | rawInfo=true sample | rawInfo=false sample |");
  lines.push("| --- | --- | --- | ---: | ---: | --- | --- |");
  for (const check of payload.checks) {
    lines.push(
      `| ${check.label} | \`${check.query}\` | ${check.required ? "yes" : "no"} | ${check.rawInfoSearchHits} | ${check.compactSearchHits} | ${check.rawInfoSearchContainsSample ? "yes" : "no"} | ${check.compactSearchContainsSample ? "yes" : "no"} |`
    );
  }

  lines.push("", "## Conclusion");
  if (payload.status === "PASS") {
    lines.push("- SSID / DXID / ISBN / title / author / publisher remain searchable without rawInfo.");
    lines.push("- If only rawInfo-only fragments stop matching, that is an acceptable production tradeoff for faster indexing and smaller search surface.");
  } else {
    lines.push("- Keep rawInfo searchable until the failing standard-field query is understood.");
  }

  return `${lines.join("\n")}\n`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  mkdirSync("reports", { recursive: true });

  const host = process.env.MEILI_HOST ?? "http://127.0.0.1:7700";
  const apiKey = process.env.MEILI_MASTER_KEY;
  const client = new MeiliSearch({ host, apiKey });
  await client.health();

  const downgrade = shouldDowngradeDefaultLimit();
  const effectiveLimit = options.limit ?? (downgrade.downgrade ? 20_000 : 50_000);
  const configs = benchmarkConfigs(effectiveLimit);
  const startedAt = new Date().toISOString();
  const results: BenchmarkResult[] = [];

  for (const config of configs) {
    console.log(`[benchmark] running ${config.label} index=${config.index} limit=${config.limit} batch=${config.batchSize} rawInfo=${config.searchRawInfo}`);
    results.push(await runBenchmark(config, options, client));
  }

  const qualityResult =
    results.find((result) => result.index === "books_bench_baseline" && result.status === "PASS") &&
    results.find((result) => result.index === "books_bench_compact" && result.status === "PASS")
      ? await compareRawInfoSearch(client, "books_bench_baseline", "books_bench_compact")
      : {
          status: "SKIPPED" as const,
          reason: "Baseline or compact benchmark did not complete.",
          sample: null,
          checks: []
        };

  const cleanupResults: Record<string, string> = {};
  if (!options.keepIndexes) {
    for (const config of configs) cleanupResults[config.index] = await waitDeleteIndex(client, config.index);
  }

  const finishedAt = new Date().toISOString();
  const payload = {
    startedAt,
    finishedAt,
    file: options.file,
    meiliDataDir: options.meiliDataDir,
    host,
    keepIndexes: options.keepIndexes,
    downgradeReason: downgrade.downgrade ? downgrade.reason : null,
    results,
    cleanupResults,
    searchQuality: qualityResult
  };

  writeFileSync(path.join("reports", "import-performance-benchmark.json"), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  writeFileSync(
    path.join("reports", "IMPORT_PERFORMANCE_BENCHMARK.md"),
    markdownBenchmarkReport({ ...payload, downgradeReason: payload.downgradeReason }),
    "utf8"
  );
  writeFileSync(path.join("reports", "SEARCH_QUALITY_RAWINFO_COMPARISON.md"), markdownSearchQualityReport(qualityResult), "utf8");
  console.log("[benchmark] reports written");
}

main().catch((error) => {
  console.error(`[benchmark] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
