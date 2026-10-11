/** One existing book, one action, at most one real model call. No content writes. */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import dotenv from "dotenv";
import { MeiliSearch } from "meilisearch";
import {
  BookAssistantError, createBookAssistantService,
  type BookAssistantAction, type BookAssistantResponse,
} from "../apps/api/src/ai/book-assistant.js";
import { chatCompletion, isAiEnabled, resolveMiniMaxConfig, type WireApi } from "../apps/api/src/ai/minimax.js";
import type { BookWorkspace } from "../apps/api/src/s32/domain/book-library.js";
import { createPostgresBookLibraryStore } from "../apps/api/src/s32/postgres/book-library-store.js";
import { createWereadBindingsService } from "../apps/api/src/weread/manual-bindings.js";
import { createPostgresWereadBindingStore } from "../apps/api/src/weread/manual-bindings-store.js";
import type { PrivateNotesData } from "../apps/api/src/weread/private-notes.js";

export interface BookAiTrialArgs {
  bookId: string;
  action: BookAssistantAction;
  question?: string;
  outDir: string;
}
export interface BookAiTrialReaders {
  getCatalogDocument(bookId: string): Promise<unknown>;
  getWorkspace(bookId: string): Promise<BookWorkspace | null>;
  loadWereadNotes(): Promise<PrivateNotesData>;
  close(): Promise<void>;
}
export type BookAiTrialStatus = "STRUCTURAL_PASS_REVIEW_PENDING" | "INSUFFICIENT_CONTEXT" | "BLOCKED_CONFIGURATION" | "FAILED";
export interface BookAiTrialReceipt {
  schema_version: 1;
  task_id: "BOOK_CENTERED_AI_LIVE_TRIAL_V1";
  mode: "REAL_PROVIDER" | "INJECTED_TEST_IO";
  book_id: string;
  action: BookAssistantAction;
  question: string | null;
  started_at: string;
  finished_at: string;
  status: BookAiTrialStatus;
  exit_code: 0 | 1 | 2;
  git: { head: string; dirty: boolean };
  configuration: { model: string | null; wire_api: WireApi | null; weread_enabled: boolean };
  blocked_fields: string[];
  source_reads: { catalog: number; workspace: number; weread: number };
  provider: { calls: number; latency_ms: number; status: "NOT_CALLED" | "OK" | "ERROR"; client_status: number | null };
  scope: {
    data: "EXISTING_CATALOG_AND_SAVED_BOOK_DATA";
    auth: "CLI_DIRECT_SERVICE_GOOGLE_HTTP_NOT_EXERCISED";
    database_access: "READ_ONLY";
    content_writes: 0;
    model_quality_review: "PENDING";
    human_review: "PENDING";
  };
  error_code: string | null;
  response: BookAssistantResponse | null;
}

export class BookAiTrialInputError extends Error {
  constructor() { super("BOOK_AI_TRIAL_INVALID_ARGUMENTS"); }
}
const invalidArgs = () => new BookAiTrialInputError();
const badText = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/** Validate completely before dotenv, filesystem, catalog, database or model IO. */
export function parseBookAiLiveTrialArgs(argv: string[]): BookAiTrialArgs {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i], value = argv[i + 1];
    if (!["--book-id", "--action", "--question", "--out-dir"].includes(name)
      || values.has(name) || value === undefined || value.startsWith("--")) throw invalidArgs();
    values.set(name, value);
  }
  const bookId = values.get("--book-id") ?? "", action = values.get("--action");
  const question = values.get("--question"), outDir = values.get("--out-dir") ?? "progress/book-ai-live";
  if (bookId.length > 128 || !/^[0-9]+_[0-9]{12}$/.test(bookId)
    || (action !== "introduction" && action !== "notes_summary" && action !== "question")
    || !outDir.trim() || badText.test(outDir)
    || (action === "question" ? !question?.trim() || question.trim().length > 1000 || badText.test(question) : question !== undefined)) throw invalidArgs();
  return { bookId, action, outDir, ...(question === undefined ? {} : { question: question.trim() }) };
}

/** Environment variables take precedence; importing this module does not load dotenv. */
export function loadBookAiTrialEnv(projectRoot: string, inherited: NodeJS.ProcessEnv = process.env) {
  const env = { ...inherited };
  const explicit = inherited.DOTENV_CONFIG_PATH;
  const loaded = dotenv.config({ path: explicit ?? path.join(projectRoot, ".env"), processEnv: env, override: false, quiet: true });
  return { env, blockedFields: explicit && loaded.error ? ["DOTENV_CONFIG_PATH"] : [] };
}

function blockedConfiguration(env: NodeJS.ProcessEnv): string[] {
  const fields: string[] = [];
  if (env.AI_FEATURES_ENABLED?.toLowerCase() !== "true") fields.push("AI_FEATURES_ENABLED");
  if (!env.MINIMAX_API_KEY?.trim()) fields.push("MINIMAX_API_KEY");
  try {
    const url = new URL(env.S32_DATABASE_URL?.trim() ?? "");
    if (!["postgres:", "postgresql:"].includes(url.protocol)) fields.push("S32_DATABASE_URL");
  } catch { fields.push("S32_DATABASE_URL"); }
  const wire = env.MINIMAX_WIRE_API?.trim().toLowerCase();
  if (wire && !["responses", "openai_chat", "anthropic"].includes(wire)) fields.push("MINIMAX_WIRE_API");
  const model = env.MINIMAX_MODEL?.trim();
  // Model labels may be recorded; credentials and endpoint URLs may not.
  if (model && (!/^[a-zA-Z0-9._/-]{1,160}$/.test(model) || model === env.MINIMAX_API_KEY?.trim())) fields.push("MINIMAX_MODEL");
  return fields;
}

/** Existing production read adapters. No migration, promotion or write method is exposed. */
export async function openBookAiTrialReaders(env: NodeJS.ProcessEnv): Promise<BookAiTrialReaders> {
  const apiRequire = createRequire(new URL("../apps/api/package.json", import.meta.url));
  type Pool = Parameters<typeof createPostgresBookLibraryStore>[0];
  const { Pool } = apiRequire("pg") as { Pool: new (config: Record<string, unknown>) => Pool };
  const database = new URL(env.S32_DATABASE_URL!.trim());
  // URL options override Pool options in pg. Append here so an existing URL
  // cannot accidentally replace the read-only default; retain other options.
  database.searchParams.set("options", `${database.searchParams.get("options") ?? ""} -c default_transaction_read_only=on`.trim());
  const pool = new Pool({ connectionString: database.toString(), connectionTimeoutMillis: 3000, query_timeout: 5000, max: 2 });
  pool.on("error", () => {}); // Raw PG messages can contain connection details.
  const index = new MeiliSearch({ host: env.MEILI_HOST ?? "http://127.0.0.1:7700", apiKey: env.MEILI_MASTER_KEY }).index(env.MEILI_INDEX ?? "books");
  const library = createPostgresBookLibraryStore(pool);
  const storedBindings = createPostgresWereadBindingStore(pool);
  const weread = createWereadBindingsService({
    dataDir: env.WEREAD_PRIVATE_DATA_DIR ?? "/app/private-data/weread",
    getCatalogDocument: id => index.getDocument(id),
    store: { list: () => storedBindings.list(), write: async () => { throw new Error("BOOK_AI_TRIAL_READ_ONLY"); } },
  });
  return {
    getCatalogDocument: id => index.getDocument(id),
    getWorkspace: id => library.get(id), // This production method uses a READ ONLY transaction.
    loadWereadNotes: () => weread.loadNotes(),
    close: () => pool.end(),
  };
}

/** Test seams replace only IO. Production source collection and parsing always run. */
export async function runBookAiLiveTrial(args: BookAiTrialArgs, deps: {
  env: NodeJS.ProcessEnv;
  git: BookAiTrialReceipt["git"];
  blockedFields?: string[];
  openReaders?: (env: NodeJS.ProcessEnv) => Promise<BookAiTrialReaders>;
  chat?: typeof chatCompletion;
  now?: () => Date;
}): Promise<BookAiTrialReceipt> {
  const validated = parseBookAiLiveTrialArgs(["--book-id", args.bookId, "--action", args.action,
    ...(args.question === undefined ? [] : ["--question", args.question]), "--out-dir", args.outDir]);
  const now = deps.now ?? (() => new Date());
  const receipt: BookAiTrialReceipt = {
    schema_version: 1, task_id: "BOOK_CENTERED_AI_LIVE_TRIAL_V1", mode: deps.chat || deps.openReaders ? "INJECTED_TEST_IO" : "REAL_PROVIDER",
    book_id: validated.bookId, action: validated.action, question: validated.question ?? null,
    started_at: now().toISOString(), finished_at: "", status: "BLOCKED_CONFIGURATION", exit_code: 2,
    git: { ...deps.git }, configuration: { model: null, wire_api: null, weread_enabled: deps.env.WEREAD_OVERLAY_ENABLED === "true" },
    blocked_fields: [...new Set([...(deps.blockedFields ?? []), ...blockedConfiguration(deps.env)])],
    source_reads: { catalog: 0, workspace: 0, weread: 0 },
    provider: { calls: 0, latency_ms: 0, status: "NOT_CALLED", client_status: null },
    scope: { data: "EXISTING_CATALOG_AND_SAVED_BOOK_DATA", auth: "CLI_DIRECT_SERVICE_GOOGLE_HTTP_NOT_EXERCISED",
      database_access: "READ_ONLY", content_writes: 0, model_quality_review: "PENDING", human_review: "PENDING" },
    error_code: null, response: null,
  };
  if (receipt.blocked_fields.length) {
    receipt.finished_at = now().toISOString();
    return receipt;
  }
  const config = resolveMiniMaxConfig(deps.env)!;
  receipt.configuration.model = config.model;
  receipt.configuration.wire_api = config.wireApi;
  let readers: BookAiTrialReaders | undefined;
  try {
    readers = await (deps.openReaders ?? openBookAiTrialReaders)(deps.env);
    const source = readers;
    const service = createBookAssistantService({
      getCatalogDocument: id => { receipt.source_reads.catalog++; return source.getCatalogDocument(id); },
      getWorkspace: id => { receipt.source_reads.workspace++; return source.getWorkspace(id); },
      loadWereadNotes: () => { receipt.source_reads.weread++; return source.loadWereadNotes(); },
      wereadEnabled: receipt.configuration.weread_enabled, isEnabled: () => isAiEnabled(deps.env), now,
      chat: async (messages, options) => {
        if (receipt.provider.calls !== 0) throw new Error("BOOK_AI_TRIAL_PROVIDER_CALL_LIMIT");
        receipt.provider.calls++;
        receipt.provider.status = "ERROR";
        const start = performance.now();
        try {
          const result = await (deps.chat ?? chatCompletion)(messages, { ...options, config });
          receipt.provider.status = result.ok ? "OK" : "ERROR";
          // The client also synthesizes 502/504 for network errors and timeouts.
          receipt.provider.client_status = !result.ok && Number.isInteger(result.status) && result.status >= 100 && result.status <= 599 ? result.status : null;
          return result;
        } finally { receipt.provider.latency_ms = Math.max(0, Math.round(performance.now() - start)); }
      },
    });
    receipt.response = await service.generate(validated.bookId, { action: validated.action,
      ...(validated.question === undefined ? {} : { question: validated.question }) });
    receipt.status = receipt.response.source === "ai" ? "STRUCTURAL_PASS_REVIEW_PENDING" : "INSUFFICIENT_CONTEXT";
    receipt.exit_code = 0;
  } catch (error) {
    receipt.status = "FAILED";
    receipt.exit_code = 1;
    receipt.error_code = error instanceof BookAssistantError ? error.code : "BOOK_AI_TRIAL_FAILED";
  } finally {
    try { await readers?.close(); }
    catch { receipt.status = "FAILED"; receipt.exit_code = 1; receipt.error_code = "BOOK_AI_TRIAL_CLOSE_FAILED"; }
    receipt.finished_at = now().toISOString();
  }
  return receipt;
}

function fenced(text: string): string {
  const fence = "`".repeat(Math.max(3, ...Array.from(text.matchAll(/`+/g), match => match[0].length + 1)));
  return `${fence}text\n${text}\n${fence}`;
}
export function renderBookAiTrialReview(receipt: BookAiTrialReceipt): string {
  const lines = ["# 本书 AI 实测审阅", "", `- 状态：${receipt.status}；执行方式：${receipt.mode}`,
    `- 操作：${receipt.action}；书目：${receipt.book_id}`,
    `- 代码：${receipt.git.head}；工作区有改动：${receipt.git.dirty ? "是" : "否"}`,
    `- 模型：${receipt.configuration.model ?? "未调用"}；协议：${receipt.configuration.wire_api ?? "未调用"}`,
    `- 模型调用：${receipt.provider.calls}；耗时：${receipt.provider.latency_ms} ms；传输：${receipt.provider.status}`,
    "- 调用方式：CLI 直接使用生产服务；本次未核验 Google 登录、HTTP 接口或浏览器。",
    "- 数据库只读；未保存介绍、笔记或关联；电子版外链内容未读取。",
    "- 模型质量审阅：PENDING；真人确认：PENDING。结构通过不代表回答内容已经审阅。", ""];
  if (receipt.blocked_fields.length) lines.push("## 配置待补齐", "", ...receipt.blocked_fields.map(field => `- ${field}`), "");
  if (receipt.error_code) lines.push(`错误代码：${receipt.error_code}`, "");
  if (receipt.question) lines.push("## 问题", "", fenced(receipt.question), "");
  const response = receipt.response;
  if (response) {
    const c = response.context;
    lines.push("## 本次资料范围", "", `个人笔记 ${c.notesIncluded}/${c.notesAvailable}；微信读书 ${c.wereadIncluded}/${c.wereadAvailable}（功能${c.wereadEnabled ? "已启用" : "未启用"}）；来源字符 ${c.sourceChars}；有节选或未采用记录：${c.truncated ? "是" : "否"}。`,
      "微信读书数量仅反映当前实际读取的快照与有效关联；零条不代表相关资料已经完整导入。", "",
      "## 草稿", "", fenced(`${response.draft.title}\n\n${response.draft.content}`), "", "## 来源摘录", "");
    for (const source of response.sources) lines.push(fenced(`[${source.id}] ${source.label}\n类型：${source.kind}；已引用：${response.citedSourceIds.includes(source.id) ? "是" : "否"}\n来源：${source.href}\n\n${source.excerpt}`), "");
  }
  lines.push("## 人工审阅（待回填）", "", "- 是否符合本书和本次问题：PENDING", "- 引用是否确实支持对应说法：PENDING", "- 是否混淆笔记观点与原书内容：PENDING", "- 是否需要调整提示词或补充资料：PENDING", "- 审阅人／时间／结论：PENDING", "");
  return lines.join("\n");
}

const exec = promisify(execFile);
export async function assertBookAiTrialOutputIgnored(projectRoot: string, destination: string): Promise<void> {
  // Check both actual nested files: a top-level pattern such as reports/*.json
  // does not protect a timestamped subdirectory or the Markdown review.
  await Promise.all(["receipt.json", "review.md"].map(filename => exec("git",
    ["check-ignore", "--quiet", "--", path.relative(projectRoot, path.join(destination, filename))], { cwd: projectRoot })));
}

export async function bookAiLiveTrialMain(argv = process.argv.slice(2)): Promise<number> {
  let args: BookAiTrialArgs;
  try { args = parseBookAiLiveTrialArgs(argv); }
  catch {
    console.error(JSON.stringify({ status: "INVALID_ARGUMENTS", code: "BOOK_AI_TRIAL_INVALID_ARGUMENTS", provider_calls: 0 }));
    return 2;
  }
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  try {
    const outDir = path.resolve(projectRoot, args.outDir), relative = path.relative(projectRoot, outDir);
    if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) throw new Error("UNIGNORED_OUTPUT");
    const [{ stdout: head }, { stdout: changed }] = await Promise.all([
      exec("git", ["rev-parse", "--verify", "HEAD"], { cwd: projectRoot }),
      exec("git", ["status", "--porcelain=v1", "--untracked-files=normal"], { cwd: projectRoot }),
    ]);
    if (!/^[a-f0-9]{40,64}$/.test(head.trim())) throw new Error("GIT_IDENTITY_MISSING");
    const { env, blockedFields } = loadBookAiTrialEnv(projectRoot);
    await mkdir(outDir, { recursive: true });
    const prefix = `${new Date().toISOString().replace(/[:.]/g, "-")}_${args.bookId}_${args.action}_`;
    const destination = await mkdtemp(path.join(outDir, prefix));
    await assertBookAiTrialOutputIgnored(projectRoot, destination);
    const receipt = await runBookAiLiveTrial(args, { env, blockedFields, git: { head: head.trim(), dirty: Boolean(changed.trim()) } });
    await writeFile(path.join(destination, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await writeFile(path.join(destination, "review.md"), renderBookAiTrialReview(receipt), { encoding: "utf8", flag: "wx" });
    console.log(JSON.stringify({ status: receipt.status, provider_calls: receipt.provider.calls,
      blocked_fields: receipt.blocked_fields, error_code: receipt.error_code,
      receipt: path.join(destination, "receipt.json"), review: path.join(destination, "review.md") }));
    return receipt.exit_code;
  } catch {
    // No raw exception, DSN, endpoint, key or model response goes to stdout.
    console.error(JSON.stringify({ status: "FAILED", code: "BOOK_AI_TRIAL_LOCAL_IO_FAILED" }));
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await bookAiLiveTrialMain();
}
