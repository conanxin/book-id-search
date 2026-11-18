/** Public catalog search, one provider request per stage, and optional explicit source reads. */
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createBookWebResearchService, BookWebResearchError, type BookWebResearchResponse } from "../apps/api/src/ai/book-web-research.js";
import { chatCompletion, isAiEnabled, resolveMiniMaxConfig } from "../apps/api/src/ai/minimax.js";
import { searchMiniMaxWeb, type MiniMaxWebSearchResponse } from "../apps/api/src/ai/minimax-web-search.js";
import { createBookWebSourceReader, BookWebSourceError, type BookWebSourceFetcher, type BookWebSourceResponse } from "../apps/api/src/ai/book-web-source.js";
import { createPublicWebPageFetcher } from "../apps/api/src/ai/web-source-fetch.js";
import type { GetDocument } from "../apps/api/src/s32/catalog/meili-catalog-book-reader.js";

export function parseBookWebResearchTrialArgs(argv: string[]) {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i], value = argv[i + 1];
    if (!["--book-id", "--query", "--question", "--out", "--scope", "--read-first"].includes(key) || values.has(key)
      || !value?.trim() || value.startsWith("--")) throw new Error("BOOK_RESEARCH_TRIAL_INVALID_ARGUMENTS");
    values.set(key, value.trim());
  }
  const bookId = values.get("--book-id") ?? "", query = values.get("--query") ?? "";
  const question = values.get("--question") ?? "", scope = values.get("--scope"), readFirst = values.get("--read-first");
  if (!/^[0-9]+_[0-9]{12}$/.test(bookId) || bookId.length > 128
    || !query || query.length > 300 || !question || question.length > 1000
    || /[\u0000-\u001f\u007f]/.test(query + question)
    || (scope !== undefined && scope !== "direct_book_review")
    || (readFirst !== undefined && !/^[0-3]$/.test(readFirst))) throw new Error("BOOK_RESEARCH_TRIAL_INVALID_ARGUMENTS");
  return { bookId, query, question, outDir: values.get("--out") ?? "progress/book-web-research-live",
    ...(scope ? { scope: "direct_book_review" as const } : {}),
    ...(readFirst !== undefined ? { readFirst: Number(readFirst) } : {}) };
}
type TrialArgs = ReturnType<typeof parseBookWebResearchTrialArgs>;
type SearchCapture = Extract<MiniMaxWebSearchResponse, { ok: true }> | { ok: false; status?: number; threw?: true };
type SelectionCapture = { ok: true; model: string; content: string } | { ok: false; status?: number; threw?: true };
type ReadCapture = { sourceId: string; status: "READ"; response: Omit<BookWebSourceResponse, "snapshotToken"> }
  | { sourceId: string; status: "FAILED"; error_code: string };

/** Importing this module performs no IO. Captures are not raw HTTP: the search client has already parsed/deduplicated them. */
export async function captureBookWebResearchTrial(args: TrialArgs, deps: {
  getCatalogDocument: GetDocument;
  search: typeof searchMiniMaxWeb;
  provider: typeof chatCompletion;
  fetchPage?: BookWebSourceFetcher;
}) {
  if ((args.scope !== undefined && args.scope !== "direct_book_review")
    || (args.readFirst !== undefined && (!Number.isInteger(args.readFirst) || args.readFirst < 0 || args.readFirst > 3))) {
    throw new Error("BOOK_RESEARCH_TRIAL_INVALID_ARGUMENTS");
  }
  const startedAt = new Date().toISOString();
  const counts = { public_catalog: 0, search_requests: 0, selection_requests: 0,
    page_read_attempts: 0, page_fetch_calls: 0, search_latency_ms: 0, selection_latency_ms: 0 };
  let selectedBook: Record<string, unknown> | null = null;
  let searchCapture: SearchCapture | null = null, selectionCapture: SelectionCapture | null = null;
  let selectorInput: unknown = null, response: BookWebResearchResponse | null = null;
  const reads: ReadCapture[] = [];
  const fetchPage = deps.fetchPage ?? createPublicWebPageFetcher();
  const reader = (args.readFirst ?? 0) > 0 ? createBookWebSourceReader({ fetchPage: async (url, options) => {
    counts.page_fetch_calls++;
    return fetchPage(url, options);
  } }) : undefined;
  let status = "FAILED", errorCode: string | null = null;
  try {
    const service = createBookWebResearchService({
      isEnabled: () => true,
      getCatalogDocument: async id => {
        if (++counts.public_catalog > 1 || id !== args.bookId) throw new Error("CATALOG_READ_LIMIT");
        const book = await deps.getCatalogDocument(id);
        if (book && typeof book === "object") {
          selectedBook = Object.fromEntries(["id", "title", "author", "publisher", "year", "pages", "isbn"]
            .map(key => [key, (book as Record<string, unknown>)[key]]));
        }
        return book;
      },
      search: async (messages, options) => {
        if (++counts.search_requests > 1) throw new Error("SEARCH_REQUEST_LIMIT");
        const start = Date.now();
        try {
          const result = await deps.search(messages, options);
          searchCapture = result.ok ? structuredClone(result) : { ok: false, status: result.status };
          return result;
        } catch (error) { searchCapture = { ok: false, threw: true }; throw error; }
        finally { counts.search_latency_ms = Date.now() - start; }
      },
      provider: async (messages, options) => {
        if (++counts.selection_requests > 1) throw new Error("SELECTION_REQUEST_LIMIT");
        // This is the exact public JSON sent by the service, before model selection.
        selectorInput = JSON.parse(messages[1].content);
        const start = Date.now();
        try {
          const result = await deps.provider(messages, options);
          selectionCapture = result.ok ? { ok: true, model: result.model, content: result.content }
            : { ok: false, status: result.status };
          return result;
        } catch (error) { selectionCapture = { ok: false, threw: true }; throw error; }
        finally { counts.selection_latency_ms = Date.now() - start; }
      },
      ...(reader ? { issueSourceReadToken: reader.issueToken } : {}),
    });
    response = await service.research(args.bookId, { question: args.question, ...(args.scope ? { scope: args.scope } : {}) });
    status = response.source === "web_research" ? "STRUCTURAL_PASS_REVIEW_PENDING"
      : response.source === "unselected_sources" ? "SOURCES_AVAILABLE_SELECTION_UNFINISHED" : "INSUFFICIENT_SOURCES";
    // A fixed prefix of all returned sources, not the model/guard's preferred subset.
    // A failed read does not cause a later source to be substituted.
    if (reader) for (const source of response.sources.slice(0, args.readFirst)) {
      counts.page_read_attempts++;
      if (!source.readToken) {
        reads.push({ sourceId: source.id, status: "FAILED", error_code: "BOOK_SOURCE_BLOCKED" });
        continue;
      }
      try {
        const { snapshotToken: _token, ...read } = await reader.read(args.bookId, { sourceToken: source.readToken });
        reads.push({ sourceId: source.id, status: "READ", response: read });
      } catch (error) {
        reads.push({ sourceId: source.id, status: "FAILED",
          error_code: error instanceof BookWebSourceError ? error.code : "BOOK_SOURCE_UNAVAILABLE" });
      }
    }
  } catch (error) {
    errorCode = error instanceof BookWebResearchError ? error.code : "BOOK_RESEARCH_TRIAL_FAILED";
  }
  const publicResponse = response ? { ...response,
    sources: response.sources.map(({ readToken: _token, ...source }) => source) } : null;
  return {
    status, started_at: startedAt, finished_at: new Date().toISOString(),
    book_id: args.bookId, question: args.question, research_scope: args.scope ?? "general",
    catalog: selectedBook, counts, error_code: errorCode,
    trace: { search_client_result: searchCapture, selector_input: selectorInput, selector_result: selectionCapture },
    response: publicResponse, reads,
    read_summary: { requested_limit: args.readFirst ?? 0, attempted: reads.length,
      succeeded: reads.filter(read => read.status === "READ").length,
      failed: reads.filter(read => read.status === "FAILED").length },
    boundaries: { automatic_retries: 0, personal_workspace_reads: 0, database_connections: 0,
      content_writes: 0, production_configuration_writes: 0,
      webpage_read_policy: "first N application sources in returned order; no replacement on failure",
      webpage_read_limit: args.readFirst ?? 0, google_http_auth: "CLI_DIRECT_SERVICE_NOT_EXERCISED",
      content_review: "PENDING", human_review: "PENDING" },
  };
}

async function main(argv: string[]) {
  let args: TrialArgs;
  try { args = parseBookWebResearchTrialArgs(argv); }
  catch { console.error("BOOK_RESEARCH_TRIAL_INVALID_ARGUMENTS"); return 2; }
  const config = resolveMiniMaxConfig();
  const git = {
    head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    dirty: execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim().length > 0,
  };
  const captured = !config || !isAiEnabled() || config.wireApi !== "anthropic" ? {
    status: "BLOCKED_CONFIGURATION", started_at: new Date().toISOString(), finished_at: new Date().toISOString(),
    book_id: args.bookId, question: args.question, research_scope: args.scope ?? "general",
    error_code: "BOOK_RESEARCH_UNAVAILABLE",
    counts: { public_catalog: 0, search_requests: 0, selection_requests: 0, page_read_attempts: 0, page_fetch_calls: 0 },
    response: null, reads: [],
    read_summary: { requested_limit: args.readFirst ?? 0, attempted: 0, succeeded: 0, failed: 0 },
  } : await captureBookWebResearchTrial(args, {
    getCatalogDocument: async id => {
      const url = new URL("https://books.conanxin.com/api/search");
      url.searchParams.set("q", args.query); url.searchParams.set("page", "1"); url.searchParams.set("limit", "20");
      const found = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (!found.ok) throw new Error("PUBLIC_CATALOG_UNAVAILABLE");
      const data: unknown = await found.json();
      const items = data && typeof data === "object" && "items" in data ? data.items : null;
      const book = Array.isArray(items) ? items.find(item => item && typeof item === "object" && item.id === id) : null;
      if (!book) throw Object.assign(new Error("PUBLIC_CATALOG_EXACT_ID_NOT_FOUND"), { code: "document_not_found" });
      return book;
    },
    search: (messages, options) => searchMiniMaxWeb(messages, { ...options, config }),
    provider: (messages, options) => chatCompletion(messages, { ...options, config }),
  });
  const receipt = { task_id: "BOOK_REVIEW_EVIDENCE_P4", format_version: 2, mode: "REAL_PROVIDER",
    git, configuration: { model: config?.model ?? null, wire_api: config?.wireApi ?? null }, ...captured };
  const base = path.resolve(args.outDir);
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(path.join(base, captured.started_at.replace(/[:.]/g, "-") + "-"));
  const receiptPath = path.join(directory, "receipt.json");
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify({ status: captured.status, receipt: receiptPath,
    search_requests: captured.counts.search_requests, selection_requests: captured.counts.selection_requests,
    page_read_attempts: captured.counts.page_read_attempts, page_read_succeeded: captured.read_summary.succeeded,
    page_read_failed: captured.read_summary.failed, sources: captured.response?.sources.length ?? 0,
    error_code: captured.error_code }));
  return captured.status === "BLOCKED_CONFIGURATION" ? 2
    : captured.status === "FAILED" || captured.status === "INSUFFICIENT_SOURCES" ? 1 : 0;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(() => {
    console.error("BOOK_RESEARCH_TRIAL_RECEIPT_FAILED"); process.exitCode = 1;
  });
}
