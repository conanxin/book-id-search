/** One public book, one actual web search and at most one source-ID selection. */
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createBookWebResearchService, type BookWebResearchResponse } from "../apps/api/src/ai/book-web-research.js";
import { chatCompletion, isAiEnabled, resolveMiniMaxConfig } from "../apps/api/src/ai/minimax.js";
import { searchMiniMaxWeb } from "../apps/api/src/ai/minimax-web-search.js";

export function parseBookWebResearchTrialArgs(argv: string[]) {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i], value = argv[i + 1];
    if (!["--book-id", "--query", "--question", "--out"].includes(key) || values.has(key)
      || !value?.trim() || value.startsWith("--")) throw new Error("BOOK_RESEARCH_TRIAL_INVALID_ARGUMENTS");
    values.set(key, value.trim());
  }
  const bookId = values.get("--book-id") ?? "", query = values.get("--query") ?? "";
  const question = values.get("--question") ?? "";
  if (!/^[0-9]+_[0-9]{12}$/.test(bookId) || bookId.length > 128
    || !query || query.length > 300 || !question || question.length > 1000
    || /[\u0000-\u001f\u007f]/.test(`${query}${question}`)) throw new Error("BOOK_RESEARCH_TRIAL_INVALID_ARGUMENTS");
  return { bookId, query, question, outDir: values.get("--out") ?? "progress/book-web-research-live" };
}

async function main(argv: string[]) {
  let args: ReturnType<typeof parseBookWebResearchTrialArgs>;
  try { args = parseBookWebResearchTrialArgs(argv); }
  catch { console.error("BOOK_RESEARCH_TRIAL_INVALID_ARGUMENTS"); return 2; }
  const startedAt = new Date().toISOString();
  const config = resolveMiniMaxConfig();
  const git = {
    head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    dirty: execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim().length > 0,
  };
  let catalogReads = 0, searchRequests = 0, selectionRequests = 0;
  let searchLatencyMs = 0, selectionLatencyMs = 0;
  let response: BookWebResearchResponse | null = null;
  let status = "FAILED", errorCode: string | null = null, exitCode = 1;
  let selectedBook: Record<string, unknown> | null = null;
  try {
    if (!config || !isAiEnabled() || config.wireApi !== "anthropic") {
      status = "BLOCKED_CONFIGURATION"; errorCode = "BOOK_RESEARCH_UNAVAILABLE"; exitCode = 2;
    } else {
      const service = createBookWebResearchService({
        isEnabled: () => true,
        getCatalogDocument: async id => {
          if (++catalogReads > 1 || id !== args.bookId) throw new Error("CATALOG_READ_LIMIT");
          const url = new URL("https://books.conanxin.com/api/search");
          url.searchParams.set("q", args.query); url.searchParams.set("page", "1"); url.searchParams.set("limit", "20");
          const found = await fetch(url, { signal: AbortSignal.timeout(20_000) });
          if (!found.ok) throw new Error("PUBLIC_CATALOG_UNAVAILABLE");
          const data: unknown = await found.json();
          const items = data && typeof data === "object" && "items" in data ? data.items : null;
          const book = Array.isArray(items) ? items.find(item => item && typeof item === "object" && item.id === id) : null;
          if (!book) throw new Error("PUBLIC_CATALOG_EXACT_ID_NOT_FOUND");
          selectedBook = Object.fromEntries(["id", "title", "author", "publisher", "year", "pages", "isbn"].map(key => [key, book[key]]));
          return book;
        },
        search: async (messages, options) => {
          if (++searchRequests > 1) throw new Error("SEARCH_REQUEST_LIMIT");
          const start = Date.now();
          try { return await searchMiniMaxWeb(messages, { ...options, config }); }
          finally { searchLatencyMs = Date.now() - start; }
        },
        provider: async (messages, options) => {
          if (++selectionRequests > 1) throw new Error("SELECTION_REQUEST_LIMIT");
          const start = Date.now();
          try { return await chatCompletion(messages, { ...options, config }); }
          finally { selectionLatencyMs = Date.now() - start; }
        },
      });
      response = await service.research(args.bookId, { question: args.question });
      status = response.source === "web_research" ? "STRUCTURAL_PASS_REVIEW_PENDING" : "INSUFFICIENT_SOURCES";
      exitCode = response.source === "web_research" ? 0 : 1;
    }
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : null;
    errorCode = typeof code === "string" && /^BOOK_RESEARCH_[A-Z_]+$/.test(code) ? code : "BOOK_RESEARCH_TRIAL_FAILED";
  }
  const receipt = {
    task_id: "BOOK_AI_WEB_RESEARCH_V1", mode: "REAL_PROVIDER", status, git,
    started_at: startedAt, finished_at: new Date().toISOString(),
    book_id: args.bookId, question: args.question, catalog: selectedBook,
    configuration: { model: config?.model ?? null, wire_api: config?.wireApi ?? null },
    source_reads: { public_catalog: catalogReads, personal_workspace: 0, weread: 0, ebook: 0 },
    provider: { search_requests: searchRequests, selection_requests: selectionRequests, search_latency_ms: searchLatencyMs, selection_latency_ms: selectionLatencyMs },
    scope: { database_connections: 0, content_writes: 0, production_configuration_writes: 0,
      webpage_fulltext: "NOT_FETCHED", google_http_auth: "CLI_DIRECT_SERVICE_NOT_EXERCISED",
      content_review: "PENDING", human_review: "PENDING" },
    error_code: errorCode, response,
  };
  const base = path.resolve(args.outDir);
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(path.join(base, `${startedAt.replace(/[:.]/g, "-")}-`));
  const receiptPath = path.join(directory, "receipt.json");
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ status, receipt: receiptPath, search_requests: searchRequests,
    selection_requests: selectionRequests, sources: response?.sources.length ?? 0, mode: response?.mode ?? null, error_code: errorCode }));
  return exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(() => {
    console.error("BOOK_RESEARCH_TRIAL_RECEIPT_FAILED"); process.exitCode = 1;
  });
}
