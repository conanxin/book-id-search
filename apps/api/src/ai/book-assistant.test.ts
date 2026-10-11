import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BOOK_ASSISTANT_LIMITS, createBookAssistantService, type BookAssistantSource } from "./book-assistant.js";
import type { ChatMessage } from "./minimax.js";
import { emptyBookWorkspace, type BookNote, type BookWorkspace } from "../s32/domain/book-library.js";
import { createPrivateNotesData, type PrivateNotesData } from "../weread/private-notes.js";

const A = "10000001_000000000001", B = "10000002_000000000002";
const N = "11111111-1111-4111-8111-111111111111", R = "22222222-2222-4222-8222-222222222222";
const date = "2026-10-11T04:00:00.000Z";
const catalog = { id: A, title: "运河田野调查", author: "合成作者", publisher: "测试出版社", year: 2020, pages: 300, isbn: "test-isbn",
  rawInfo: "RAW_INFO_MUST_NOT_BE_CONTEXT", providerInternal: "CATALOG_PRIVATE_METADATA" };
const bookNote: BookNote = { noteId: N, currentRevisionId: R, title: "渡口线索", content: "独立笔记记载渡口以石桥为地标。",
  revisionNo: 2, createdAt: date, updatedAt: date, revisions: [{ revisionId: R, revisionNo: 2, createdAt: date }] };
const initialWorkspace: BookWorkspace = { ...emptyBookWorkspace(A), saved: true, version: 3,
  introduction: "介绍记录本次调查关注河道和渡口。", notes: [bookNote],
  resources: [{ resourceId: "33333333-3333-4333-8333-333333333333", label: "LINK_NOT_RETRIEVED", url: "https://private-resource.example.test/book.pdf",
    format: "PDF", versionLabel: "全文", notes: "RESOURCE_COMMENT_NOT_CONTEXT", createdAt: date, updatedAt: date }] };
const initialWeread = createPrivateNotesData([
  { wereadBookId: "private-a", type: "highlight", text: "微信读书划线：桥北有渡口。", comment: "下次核对古桥", createdAt: 1700000001 },
  { wereadBookId: "private-b", type: "thought", text: "OTHER_BOOK_PRIVATE_TEXT", createdAt: 1700000002 },
  { wereadBookId: "private-unlinked", text: "UNLINKED_PRIVATE_TEXT", createdAt: 1700000003 },
], [{ wereadBookId: "private-a", catalogId: A }, { wereadBookId: "private-b", catalogId: B }]);

function providerObject(ids: string[] = ["S1"]) {
  return { title: "书籍阅读草稿", paragraphs: [{ text: "资料记载了可继续核对的田野线索。", sourceIds: ids }], insufficientEvidence: false };
}
function setup(options: { workspace?: BookWorkspace | null; weread?: PrivateNotesData; wereadEnabled?: boolean; enabled?: boolean; noStore?: boolean } = {}) {
  const getCatalogDocument = vi.fn().mockResolvedValue(catalog);
  const getWorkspace = vi.fn().mockResolvedValue(options.workspace === undefined ? structuredClone(initialWorkspace) : options.workspace);
  const loadWereadNotes = vi.fn().mockResolvedValue(options.weread ?? initialWeread);
  const chat = vi.fn(async (messages: ChatMessage[]) => {
    const payload = JSON.parse(messages.find(m => m.role === "user")!.content) as { sources: BookAssistantSource[] };
    return { ok: true as const, model: "fixture", content: JSON.stringify(providerObject(payload.sources.map(s => s.id))) };
  });
  const service = createBookAssistantService({ getCatalogDocument, getWorkspace: options.noStore ? null : getWorkspace,
    loadWereadNotes, wereadEnabled: options.wereadEnabled ?? true, isEnabled: () => options.enabled ?? true,
    chat, now: () => new Date(date) });
  return { service, getCatalogDocument, getWorkspace, loadWereadNotes, chat };
}
afterEach(() => vi.restoreAllMocks());

describe("book-scoped assistant, server material and reference contract", () => {
  it("reads current saved sources and effective exact-book notes, returning server-generated links, revisions and excerpt hashes", async () => {
    const s = setup();
    const result = await s.service.generate(A, { action: "question", question: "  渡口线索是什么？  " });
    expect(result).toMatchObject({ bookId: A, action: "question", question: "渡口线索是什么？", generatedAt: date, source: "ai",
      context: { workspaceVersion: 3, introductionIncluded: true, notesAvailable: 1, notesIncluded: 1,
        wereadAvailable: 1, wereadIncluded: 1, wereadEnabled: true, truncated: false } });
    expect(result.sources.map(source => source.kind)).toEqual(["catalog", "introduction", "note", "weread"]);
    expect(result.sources.map(source => source.id)).toEqual(["S1", "S2", "S3", "S4"]);
    expect(result.sources.map(source => source.href)).toEqual([
      `/books/${A}`, `/books/${A}#library-introduction-heading`, `/books/${A}#book-note-${N}`, `/weread?catalogId=${A}`,
    ]);
    expect(result.sources.map(source => source.revisionId)).toEqual([null, null, R, null]);
    expect(result.sources[2].label).toContain("第 2 版");
    expect(result.sources[2].excerpt).toBe(bookNote.content);
    for (const source of result.sources) expect(source.contentHash).toBe(createHash("sha256").update(source.excerpt, "utf8").digest("hex"));
    expect(result.context.sourceChars).toBe(result.sources.reduce((sum, source) => sum + source.excerpt.length, 0));
    expect(result.citedSourceIds).toEqual(["S1", "S2", "S3", "S4"]);
    expect(result.draft.content).toBe("资料记载了可继续核对的田野线索。 [S1] [S2] [S3] [S4]");
    const messages = s.chat.mock.calls[0][0];
    const provider = JSON.parse(messages[1].content);
    expect(Object.keys(provider)).toEqual(["action", "question", "coverage", "sources"]);
    expect(Object.keys(provider.sources[0])).toEqual(["id", "kind", "label", "excerpt", "truncated"]);
    expect(provider.coverage).toEqual({ introductionIncluded: true, notesAvailable: 1, notesIncluded: 1,
      wereadAvailable: 1, wereadIncluded: 1, wereadEnabled: true, truncated: false });
    expect(JSON.stringify(messages)).not.toMatch(/private-a|private-b|private-unlinked|OTHER_BOOK_PRIVATE_TEXT|UNLINKED_PRIVATE_TEXT|RAW_INFO|CATALOG_PRIVATE|LINK_NOT|RESOURCE_COMMENT|private-resource|revisionId|contentHash/);
    expect(s.getWorkspace).toHaveBeenCalledWith(A);
    expect(s.chat).toHaveBeenCalledOnce();
    // Only the provider is injectable: no resource fetch, promotion or write
    // operation is exposed to this read-only service.
    expect(s.getCatalogDocument).toHaveBeenCalledOnce();
  });

  it("reloads saved text and effective links for each call without stale assistant caching", async () => {
    const s = setup();
    await s.service.generate(A, { action: "notes_summary" });
    s.getWorkspace.mockResolvedValueOnce({ ...initialWorkspace, introduction: "新介绍", version: 4,
      notes: [{ ...bookNote, content: "新修订内容", revisionNo: 3, currentRevisionId: N }] });
    s.loadWereadNotes.mockResolvedValueOnce(createPrivateNotesData(initialWeread.notes,
      [{ wereadBookId: "private-b", catalogId: A }]));
    const result = await s.service.generate(A, { action: "notes_summary" });
    expect(result.context.workspaceVersion).toBe(4);
    expect(result.sources.find(source => source.kind === "note")).toMatchObject({ excerpt: "新修订内容", revisionId: N });
    expect(result.sources.find(source => source.kind === "weread")?.excerpt).toContain("OTHER_BOOK_PRIVATE_TEXT");
    expect(JSON.stringify(s.chat.mock.calls[1])).not.toContain("桥北有渡口");
  });

  it("uses catalog-only introductions and questions without fabricating a saved workspace or reading disabled WeRead", async () => {
    const s = setup({ workspace: null, wereadEnabled: false });
    s.loadWereadNotes.mockRejectedValue(new Error("must not read disabled data"));
    for (const body of [{ action: "introduction" }, { action: "question", question: "出版信息是什么？" }]) {
      const result = await s.service.generate(A, body);
      expect(result.sources).toHaveLength(1);
      expect(result.context).toMatchObject({ workspaceVersion: 0, introductionIncluded: false,
        notesAvailable: 0, notesIncluded: 0, wereadEnabled: false, wereadAvailable: 0, wereadIncluded: 0 });
    }
    expect(s.loadWereadNotes).not.toHaveBeenCalled();
    expect(s.chat.mock.calls[0][0][0].content).toContain("只有书目时整理可确认的书目资料");
    expect(s.chat.mock.calls[0][0][0].content).toContain("没有图书全文或电子版外链内容");
  });

  it("returns an explicit unsaveable no-notes result without calling the provider", async () => {
    const cases = [
      setup({ workspace: { ...initialWorkspace, notes: [] }, wereadEnabled: false }),
      setup({ workspace: { ...initialWorkspace, notes: [{ ...bookNote, content: "\u0001" }] },
        weread: createPrivateNotesData([{ wereadBookId: "private-a", type: "thought", text: "\u0000", comment: "\u0001" }],
          [{ wereadBookId: "private-a", catalogId: A }]) }),
    ];
    for (const s of cases) {
      const result = await s.service.generate(A, { action: "notes_summary" });
      expect(result).toMatchObject({ source: "insufficient_context", citedSourceIds: [], question: null });
      expect(result.context.notesIncluded + result.context.wereadIncluded).toBe(0);
      expect(result.draft.content).toContain("还没有可供整理");
      expect(s.chat).not.toHaveBeenCalled();
    }
  });

  it("accepts honest model insufficiency only as an empty evidence-free result", async () => {
    const s = setup();
    s.chat.mockResolvedValueOnce({ ok: true, model: "fixture", content: JSON.stringify({ title: "资料不足", paragraphs: [], insufficientEvidence: true }) });
    const result = await s.service.generate(A, { action: "question", question: "作者出生地点是什么？" });
    expect(result.source).toBe("insufficient_context");
    expect(result.citedSourceIds).toEqual([]);
    expect(result.draft.content).toContain("不足以支持");
  });

  it("caps newest notes and WeRead with separate budgets and exact count/truncation reporting", async () => {
    const notes = Array.from({ length: 12 }, (_, i) => ({ ...bookNote, noteId: `${String(i + 1).padStart(8, "0")}-1111-4111-8111-111111111111`,
      title: `笔记 ${i}`, content: `NOTE_${i}_` + "长篇内容😀".repeat(5000), updatedAt: `2026-10-${String(i + 1).padStart(2, "0")}T00:00:00.000Z` }));
    const weread = createPrivateNotesData(Array.from({ length: 20 }, (_, i) => ({ wereadBookId: "private-a", type: "highlight",
      text: `WEREAD_${i}_` + "划线😀".repeat(5000), createdAt: 1700000000 + i })), [{ wereadBookId: "private-a", catalogId: A }]);
    const s = setup({ workspace: { ...initialWorkspace, introduction: "长介绍😀".repeat(5000), notes }, weread });
    const result = await s.service.generate(A, { action: "notes_summary" });
    expect(result.sources).toHaveLength(BOOK_ASSISTANT_LIMITS.SOURCES);
    expect(result.context).toMatchObject({ notesAvailable: 12, notesIncluded: 8, wereadAvailable: 20, wereadIncluded: 14, truncated: true });
    expect(result.context.sourceChars).toBeLessThanOrEqual(24_000);
    expect(result.sources.every(source => source.excerpt.length > 0 && source.excerpt.length <= 4000)).toBe(true);
    expect(result.sources.filter(source => source.kind === "note")[0].excerpt).toMatch(/^NOTE_11_/);
    expect(result.sources.filter(source => source.kind === "weread")[0].excerpt).toMatch(/^原文：WEREAD_19_/);
    expect(result.sources.filter(source => source.kind === "note").every(source => source.truncated)).toBe(true);
    expect(result.sources.filter(source => source.kind === "weread").every(source => source.truncated)).toBe(true);
    const delivered = JSON.parse(s.chat.mock.calls[0][0][1].content);
    expect(delivered.coverage).toMatchObject({ notesAvailable: 12, notesIncluded: 8,
      wereadAvailable: 20, wereadIncluded: 14, truncated: true });
    expect(delivered.sources.filter((source: BookAssistantSource) => source.kind === "note" || source.kind === "weread")
      .every((source: BookAssistantSource) => source.truncated)).toBe(true);
    expect(JSON.stringify(result)).not.toContain("NOTE_0_");
    for (const source of result.sources) expect(source.excerpt).not.toMatch(/[\ud800-\udbff]$/);
  });

  it("normalizes unsupported imported characters and never cuts valid emoji in half", async () => {
    const s = setup({ workspace: { ...initialWorkspace, introduction: " \u0000历史\ud800\r\n资料 " },
      weread: createPrivateNotesData([{ wereadBookId: "private-a", text: "a\udc00b\u0000c" }], [{ wereadBookId: "private-a", catalogId: A }]) });
    const result = await s.service.generate(A, { action: "introduction" });
    expect(result.sources.find(source => source.kind === "introduction")?.excerpt).toBe("历史\ufffd\n资料");
    expect(result.sources.find(source => source.kind === "weread")?.excerpt).toBe("原文：a\ufffdbc");
  });
});

describe("book assistant input and failure boundaries", () => {
  it.each([
    ["bad-id", { action: "introduction" }], [A, null], [A, []], [A, {}],
    [A, { action: "summary" }], [A, { action: "introduction", question: "unused" }],
    [A, { action: "introduction", sources: [{ text: "CLIENT_MATERIAL" }] }],
    [A, { action: "question" }], [A, { action: "question", question: "  " }],
    [A, { action: "question", question: "x".repeat(1001) }],
    [A, { action: "question", question: "a\u0000b" }], [A, { action: "question", question: "a\ud800b" }],
  ])("rejects invalid input before any data or model access %#", async (id, body) => {
    const s = setup();
    await expect(s.service.generate(id, body)).rejects.toMatchObject({ code: "BOOK_AI_INVALID_INPUT", status: 400 });
    expect(s.getCatalogDocument).not.toHaveBeenCalled(); expect(s.getWorkspace).not.toHaveBeenCalled();
    expect(s.loadWereadNotes).not.toHaveBeenCalled(); expect(s.chat).not.toHaveBeenCalled();
  });

  it("accepts a trimmed 1000-character question", async () => {
    const s = setup();
    expect((await s.service.generate(A, { action: "question", question: ` ${"问".repeat(1000)} ` })).question).toHaveLength(1000);
  });

  it.each([[{ noStore: true }, "BOOK_AI_UNAVAILABLE"], [{ enabled: false }, "BOOK_AI_DISABLED"]] as const)("requires storage and enabled AI before reading sources %#", async (options, code) => {
    const s = setup(options);
    await expect(s.service.generate(A, { action: "introduction" })).rejects.toMatchObject({ code, status: 503 });
    expect(s.getCatalogDocument).not.toHaveBeenCalled(); expect(s.chat).not.toHaveBeenCalled();
  });

  it("distinguishes a missing catalog from a failed or mismatched catalog without reading unrelated workspace", async () => {
    const s = setup();
    s.getCatalogDocument.mockRejectedValueOnce({ code: "document_not_found" });
    await expect(s.service.generate(A, { action: "introduction" })).rejects.toMatchObject({ code: "BOOK_AI_BOOK_NOT_FOUND", status: 404 });
    s.getCatalogDocument.mockResolvedValueOnce({ ...catalog, id: B });
    await expect(s.service.generate(A, { action: "introduction" })).rejects.toMatchObject({ code: "BOOK_AI_UNAVAILABLE" });
    s.getCatalogDocument.mockRejectedValueOnce(new Error("catalog key secret"));
    await expect(s.service.generate(A, { action: "introduction" })).rejects.toMatchObject({ code: "BOOK_AI_UNAVAILABLE" });
    expect(s.getWorkspace).not.toHaveBeenCalled(); expect(s.chat).not.toHaveBeenCalled();
  });

  it.each(["workspace", "weread", "wrong_workspace"])("fails closed on configured %s read failure, with no partial model call", async target => {
    const s = setup();
    if (target === "workspace") s.getWorkspace.mockRejectedValueOnce(new Error("private SQL SELECT"));
    else if (target === "weread") s.loadWereadNotes.mockRejectedValueOnce(new Error("private imported file"));
    else s.getWorkspace.mockResolvedValueOnce({ ...initialWorkspace, bookId: B });
    await expect(s.service.generate(A, { action: "notes_summary" })).rejects.toMatchObject({ code: "BOOK_AI_UNAVAILABLE", status: 503 });
    expect(s.chat).not.toHaveBeenCalled();
  });

  it.each([
    "not json", "```json\n{}\n```", JSON.stringify([]), JSON.stringify({}),
    JSON.stringify({ ...providerObject(), title: "x".repeat(161) }),
    JSON.stringify({ ...providerObject(), href: "https://untrusted.test" }),
    JSON.stringify({ ...providerObject(["S999"]) }),
    JSON.stringify({ ...providerObject([]) }),
    JSON.stringify({ ...providerObject(), insufficientEvidence: true }),
    JSON.stringify({ ...providerObject(), paragraphs: [] }),
    JSON.stringify({ ...providerObject(), paragraphs: [{ text: "胡乱插入 [S99]", sourceIds: ["S1"] }] }),
    JSON.stringify({ ...providerObject(), paragraphs: [{ text: "\ud800", sourceIds: ["S1"] }] }),
    JSON.stringify({ ...providerObject(), paragraphs: [{ text: "x".repeat(4001), sourceIds: ["S1"] }] }),
    JSON.stringify({ ...providerObject(), paragraphs: Array.from({ length: 4 }, () => ({ text: "x".repeat(3999), sourceIds: ["S1"] })) }),
  ])("rejects malformed or ungrounded provider output without exposing raw content %#", async content => {
    const s = setup();
    s.chat.mockResolvedValueOnce({ ok: true, model: "fixture", content });
    await expect(s.service.generate(A, { action: "introduction" })).rejects.toMatchObject({ code: "BOOK_AI_INVALID_RESPONSE", status: 502 });
  });

  it("deduplicates valid citations without accepting unknown references", async () => {
    const s = setup();
    s.chat.mockResolvedValueOnce({ ok: true, model: "fixture", content: JSON.stringify(providerObject(["S2", "S1", "S2"])) });
    const result = await s.service.generate(A, { action: "introduction" });
    expect(result.citedSourceIds).toEqual(["S2", "S1"]);
    expect(result.draft.content).toMatch(/\[S2\] \[S1\]$/);
  });

  it("maps thrown and rejected provider failures to a fixed error", async () => {
    const s = setup();
    s.chat.mockRejectedValueOnce(new Error("Bearer secret-token private prompt"));
    await expect(s.service.generate(A, { action: "introduction" })).rejects.toMatchObject({ code: "BOOK_AI_PROVIDER_FAILED", status: 502,
      message: "AI 暂未完成生成，请稍后重试。" });
    s.chat.mockResolvedValueOnce({ ok: false, error: "private provider reply", status: 429 } as never);
    await expect(s.service.generate(A, { action: "introduction" })).rejects.toMatchObject({ code: "BOOK_AI_PROVIDER_FAILED", status: 502 });
  });
});
