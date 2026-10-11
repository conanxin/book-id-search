import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chatCompletion, type ChatMessage } from "../apps/api/src/ai/minimax.js";
import { emptyBookWorkspace, type BookWorkspace } from "../apps/api/src/s32/domain/book-library.js";
import { createPrivateNotesData } from "../apps/api/src/weread/private-notes.js";
import {
  assertBookAiTrialOutputIgnored, loadBookAiTrialEnv, parseBookAiLiveTrialArgs, renderBookAiTrialReview, runBookAiLiveTrial,
  type BookAiTrialArgs,
} from "./book-ai-live-trial.js";

const A = "10000001_000000000001", B = "10000002_000000000002";
const noteId = "11111111-1111-4111-8111-111111111111", revisionId = "22222222-2222-4222-8222-222222222222";
const date = "2026-10-11T05:00:00.000Z";
const git = { head: "a".repeat(40), dirty: true };
const env = {
  AI_FEATURES_ENABLED: "true", MINIMAX_API_KEY: "TEST_KEY_NOT_A_REAL_CREDENTIAL",
  MINIMAX_MODEL: "MiniMax-M3", MINIMAX_WIRE_API: "responses",
  MINIMAX_BASE_URL: "https://model.example.invalid/v1",
  S32_DATABASE_URL: "postgresql://test:TEST_PASSWORD@database.example.invalid/book_test",
  WEREAD_OVERLAY_ENABLED: "true",
};
const args: BookAiTrialArgs = { bookId: A, action: "introduction", outDir: "progress/book-ai-live" };
const initialWorkspace: BookWorkspace = { ...emptyBookWorkspace(A), introduction: "本书介绍关注运河沿岸的田野线索。", version: 2,
  notes: [{ noteId, currentRevisionId: revisionId, revisionNo: 1, title: "渡口", content: "笔记中写明桥北有渡口。",
    createdAt: date, updatedAt: date, revisions: [{ revisionId, revisionNo: 1, createdAt: date }] }],
  resources: [{ resourceId: noteId, label: "电子版", url: "https://ebook.example.invalid/NOT_FETCHED.pdf", format: "PDF",
    versionLabel: "", notes: "RESOURCE_NOT_CONTEXT", createdAt: date, updatedAt: date }] };

function readers(workspace: BookWorkspace = structuredClone(initialWorkspace)) {
  return {
    getCatalogDocument: vi.fn(async () => ({ id: A, title: "运河调查", author: "合成作者", rawInfo: "RAW_INFO_NOT_CONTEXT" })),
    getWorkspace: vi.fn(async () => workspace),
    loadWereadNotes: vi.fn(async () => createPrivateNotesData([
      { wereadBookId: "test-a", type: "highlight", text: "同书划线记载古桥。" },
      { wereadBookId: "test-b", type: "thought", text: "OTHER_BOOK_MUST_NOT_APPEAR" },
    ], [{ wereadBookId: "test-a", catalogId: A }, { wereadBookId: "test-b", catalogId: B }])),
    close: vi.fn(async () => {}),
  };
}
const now = () => new Date(date);
const provider = (content: string) => vi.fn(async () => ({ ok: true as const, content, model: "test" }));
afterEach(() => vi.restoreAllMocks());

describe("one-action real-provider CLI, with explicit injected test IO", () => {
  it("validates all arguments before IO and trims only the question", () => {
    expect(parseBookAiLiveTrialArgs(["--book-id", A, "--action", "question", "--question", "  渡口在哪里？  "]))
      .toEqual({ ...args, action: "question", question: "渡口在哪里？" });
    for (const bad of [[], ["--book-id", "some-book", "--action", "introduction"],
      ["--book-id", A, "--action", "question"], ["--book-id", A, "--action", "question", "--question", "x".repeat(1001)],
      ["--book-id", A, "--action", "introduction", "--question", "不能注入"],
      ["--book-id", A, "--action", "introduction", "--action", "notes_summary"],
      ["--book-id", A, "--action", "introduction", "--sources", "FORGED_SOURCE"]]) {
      expect(() => parseBookAiLiveTrialArgs(bad)).toThrow("BOOK_AI_TRIAL_INVALID_ARGUMENTS");
    }
  });

  it.each(["AI_FEATURES_ENABLED", "MINIMAX_API_KEY", "S32_DATABASE_URL"] as const)("blocks missing %s before opening any data or model connection", async field => {
    const openReaders = vi.fn(async () => readers()), chat = provider("UNUSED");
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network"));
    const result = await runBookAiLiveTrial(args, { env: { ...env, [field]: "" }, git, now, openReaders, chat });
    expect(result).toMatchObject({ status: "BLOCKED_CONFIGURATION", exit_code: 2, blocked_fields: [field],
      mode: "INJECTED_TEST_IO", source_reads: { catalog: 0, workspace: 0, weread: 0 }, provider: { calls: 0, status: "NOT_CALLED" }, response: null });
    expect(openReaders).not.toHaveBeenCalled();
    expect(chat).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toMatch(/TEST_KEY|TEST_PASSWORD|example\.invalid/);
  });

  it("loads an explicit dotenv path without overwriting inherited values or process.env", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "book-ai-env-test-"));
    try {
      const filename = path.join(dir, "trial.env");
      await writeFile(filename, "MINIMAX_MODEL=FROM_FILE\nAI_FEATURES_ENABLED=true\n");
      const loaded = loadBookAiTrialEnv(dir, { DOTENV_CONFIG_PATH: filename, MINIMAX_MODEL: "INHERITED" });
      expect(loaded.env).toMatchObject({ MINIMAX_MODEL: "INHERITED", AI_FEATURES_ENABLED: "true" });
      expect(loaded.blockedFields).toEqual([]);
      expect(loadBookAiTrialEnv(dir, { DOTENV_CONFIG_PATH: path.join(dir, "absent.env") }).blockedFields).toEqual(["DOTENV_CONFIG_PATH"]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("requires both actual nested report files to be ignored before any live trial", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "book-ai-output-test-"));
    try {
      execFileSync("git", ["init", "--quiet", dir]);
      await writeFile(path.join(dir, ".gitignore"), "progress/\nreports/*.json\njson-only/**/receipt.json\n");
      await expect(assertBookAiTrialOutputIgnored(dir, path.join(dir, "reports", "run"))).rejects.toThrow();
      await expect(assertBookAiTrialOutputIgnored(dir, path.join(dir, "json-only", "run"))).rejects.toThrow();
      await expect(assertBookAiTrialOutputIgnored(dir, path.join(dir, "progress", "run"))).resolves.toBeUndefined();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("runs the production collector, actual MiniMax wire parser and citation parser once without saving", async () => {
    const workspace = structuredClone(initialWorkspace), before = JSON.stringify(workspace), source = readers(workspace);
    const wireFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { model: string; input: ChatMessage[] };
      expect(request.model).toBe(env.MINIMAX_MODEL);
      const prompt = JSON.parse(request.input.find(message => message.role === "user")!.content);
      expect(prompt.sources.map((s: { kind: string }) => s.kind)).toEqual(["catalog", "introduction", "note", "weread"]);
      expect(JSON.stringify(prompt)).not.toMatch(/OTHER_BOOK|NOT_FETCHED|RESOURCE_NOT|RAW_INFO_NOT/);
      return new Response(JSON.stringify({ output_text: JSON.stringify({ title: "田野线索草稿",
        paragraphs: [{ text: "已有资料提到了桥北渡口。", sourceIds: ["S3", "S4"] }], insufficientEvidence: false }) }),
      { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const chat: typeof chatCompletion = (messages, options) => chatCompletion(messages, { ...options, fetchImpl: wireFetch });
    const result = await runBookAiLiveTrial(args, { env, git, now, openReaders: async () => source, chat });
    expect(result).toMatchObject({ mode: "INJECTED_TEST_IO", status: "STRUCTURAL_PASS_REVIEW_PENDING", exit_code: 0,
      git, configuration: { model: env.MINIMAX_MODEL, wire_api: "responses", weread_enabled: true },
      source_reads: { catalog: 1, workspace: 1, weread: 1 }, provider: { calls: 1, status: "OK", client_status: null },
      scope: { content_writes: 0, human_review: "PENDING", model_quality_review: "PENDING", auth: "CLI_DIRECT_SERVICE_GOOGLE_HTTP_NOT_EXERCISED" },
      response: { draft: { content: "已有资料提到了桥北渡口。 [S3] [S4]" }, citedSourceIds: ["S3", "S4"] } });
    expect(result.response?.sources[2]).toMatchObject({ revisionId, excerpt: workspace.notes[0].content });
    expect(result.response?.sources.every(s => /^[a-f0-9]{64}$/.test(s.contentHash))).toBe(true);
    expect(wireFetch).toHaveBeenCalledOnce();
    expect(wireFetch.mock.calls[0][0]).toBe(`${env.MINIMAX_BASE_URL}/responses`);
    expect(JSON.stringify(workspace)).toBe(before);
    expect(source.close).toHaveBeenCalledOnce();
    const review = renderBookAiTrialReview(result);
    expect(review).toContain("真人确认：PENDING");
    expect(review).toContain(workspace.notes[0].content);
    expect(review).toContain("INJECTED_TEST_IO");
    expect(JSON.stringify(result) + review).not.toMatch(/TEST_KEY|TEST_PASSWORD|model\.example/);
  });

  it("records no-material insufficiency without invoking a model or inventing a PASS", async () => {
    const source = readers(emptyBookWorkspace(A)), chat = provider("UNUSED");
    const result = await runBookAiLiveTrial({ ...args, action: "notes_summary" },
      { env: { ...env, WEREAD_OVERLAY_ENABLED: "false" }, git, now, openReaders: async () => source, chat });
    expect(result).toMatchObject({ status: "INSUFFICIENT_CONTEXT", exit_code: 0, provider: { calls: 0, status: "NOT_CALLED" },
      response: { source: "insufficient_context", citedSourceIds: [] } });
    expect(chat).not.toHaveBeenCalled();
    expect(source.loadWereadNotes).not.toHaveBeenCalled();
    expect(source.close).toHaveBeenCalledOnce();
  });

  it("records a model's insufficient-evidence answer with one call, still pending review", async () => {
    const result = await runBookAiLiveTrial({ ...args, action: "question", question: "材料没有记载的问题？" }, { env, git, now,
      openReaders: async () => readers(), chat: provider(JSON.stringify({ title: "资料不足", paragraphs: [], insufficientEvidence: true })) });
    expect(result).toMatchObject({ status: "INSUFFICIENT_CONTEXT", exit_code: 0, provider: { calls: 1, status: "OK" }, scope: { human_review: "PENDING" } });
  });

  it("reports provider failure without retrying, switching wire, or exposing a raw error", async () => {
    const source = readers(), chat = vi.fn(async () => ({ ok: false as const, status: 401, error: `${env.MINIMAX_API_KEY} ${env.S32_DATABASE_URL}` }));
    const result = await runBookAiLiveTrial(args, { env, git, now, openReaders: async () => source, chat });
    expect(result).toMatchObject({ status: "FAILED", exit_code: 1, error_code: "BOOK_AI_PROVIDER_FAILED", provider: { calls: 1, status: "ERROR", client_status: 401 } });
    expect(JSON.stringify(result)).not.toMatch(/TEST_KEY|TEST_PASSWORD|example\.invalid/);
    expect(chat).toHaveBeenCalledOnce();
    expect(source.close).toHaveBeenCalledOnce();
  });

  it("rejects an invented citation even when the model transport succeeded", async () => {
    const result = await runBookAiLiveTrial(args, { env, git, now, openReaders: async () => readers(),
      chat: provider(JSON.stringify({ title: "无效引用", paragraphs: [{ text: "某项说法。", sourceIds: ["S99"] }], insufficientEvidence: false })) });
    expect(result).toMatchObject({ status: "FAILED", exit_code: 1, error_code: "BOOK_AI_INVALID_RESPONSE", provider: { calls: 1, status: "OK" }, response: null });
  });

  it("closes a failed source read without a model call or leaking a connection string", async () => {
    const source = readers(), chat = provider("UNUSED");
    source.getWorkspace.mockRejectedValueOnce(new Error(env.S32_DATABASE_URL));
    const result = await runBookAiLiveTrial(args, { env, git, now, openReaders: async () => source, chat });
    expect(result).toMatchObject({ status: "FAILED", exit_code: 1, error_code: "BOOK_AI_UNAVAILABLE", provider: { calls: 0 } });
    expect(JSON.stringify(result)).not.toContain("TEST_PASSWORD");
    expect(chat).not.toHaveBeenCalled();
    expect(source.close).toHaveBeenCalledOnce();
  });
});
