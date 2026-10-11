import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetWebAuthStoreForTests, __setWebAuthSnapshotForTests } from "../auth/session";
import { bookAiDraftContent, generateBookAi, type BookAiInput, type BookAiResponse } from "./bookAi";

const A = "14000000_000000000001", B = "14000001_000000000002";
const NOTE = "11111111-1111-4111-8111-111111111111", REVISION = "22222222-2222-4222-8222-222222222222";
const fetchMock = vi.fn<typeof fetch>();
function login(csrfToken: string | null = "synthetic-current-csrf") {
  __setWebAuthSnapshotForTests({ status: "authenticated", user: { email: "owner@example.test", name: "合成账号" }, csrfToken, error: null });
}
function logout() {
  __setWebAuthSnapshotForTests({ status: "unauthenticated", user: null, csrfToken: null, error: null });
}
function result(action: BookAiInput["action"] = "notes_summary"): BookAiResponse {
  const sources: BookAiResponse["sources"] = [
    { id: "S1", kind: "catalog", label: "合成古道书：目录记录", excerpt: "书名：合成古道书\n作者：合成作者", href: `/books/${A}`, contentHash: "a".repeat(64), truncated: false, revisionId: null },
    { id: "S2", kind: "note", label: "踏查笔记（版本 2）", excerpt: "渡口旁有旧石阶。\n还需与地方志核对。", href: `/books/${A}#book-note-${NOTE}`, contentHash: "b".repeat(64), truncated: false, revisionId: REVISION },
  ];
  return {
    bookId: A, action, question: action === "question" ? "哪些线索需要核对？" : null,
    draft: { title: "古道阅读线索", content: "踏查记录提到渡口旧石阶，尚需与地方志核对。[S2]" },
    sources, citedSourceIds: ["S2"], source: "ai", generatedAt: "2026-10-11T04:00:00.000Z",
    context: { workspaceVersion: 3, introductionIncluded: false, notesAvailable: 1, notesIncluded: 1,
      wereadAvailable: 0, wereadIncluded: 0, wereadEnabled: true, truncated: false,
      sourceChars: sources.reduce((sum, source) => sum + source.excerpt.length, 0) },
  };
}
function json(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } }); }
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => { __resetWebAuthStoreForTests(); login(); fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); __resetWebAuthStoreForTests(); });

describe("book AI client", () => {
  it("generates for one explicit book with current Google CSRF, and performs no library write", async () => {
    const controller = new AbortController();
    fetchMock.mockResolvedValue(json(result()));
    expect(await generateBookAi(A, { action: "notes_summary" }, controller.signal)).toEqual(result());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe(`/api/ai/books/${A}/assistant`);
    expect(options).toMatchObject({ method: "POST", credentials: "same-origin", cache: "no-store", signal: controller.signal });
    expect(JSON.parse(String(options?.body))).toEqual({ action: "notes_summary" });
    const headers = new Headers(options?.headers);
    expect(headers.get("x-csrf-token")).toBe("synthetic-current-csrf");
    expect(headers.has("authorization")).toBe(false);
  });

  it("requires both a Google session and a CSRF token before generating", async () => {
    logout();
    await expect(generateBookAi(A, { action: "introduction" })).rejects.toMatchObject({ status: 401 });
    login(null);
    await expect(generateBookAi(A, { action: "introduction" })).rejects.toMatchObject({ status: 403 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("normalizes the question once and binds the response to that same question", async () => {
    fetchMock.mockResolvedValue(json(result("question")));
    const answer = await generateBookAi(A, { action: "question", question: "  哪些线索需要核对？  " });
    expect(answer.question).toBe("哪些线索需要核对？");
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ action: "question", question: "哪些线索需要核对？" });
  });

  it.each(["", "wrong", ` ${A}`, `${A}/other`])("does not turn invalid book %j into another scope", async id => {
    await expect(generateBookAi(id, { action: "introduction" })).rejects.toMatchObject({ status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { action: "question", question: "" }, { action: "question", question: "字".repeat(1001) },
    { action: "question", question: "不合法\ud800" }, { action: "question", question: "不合法\0" },
    { action: "introduction", question: "偷偷换任务" }, { action: "notes_summary", question: undefined },
    { action: "notes_summary", sources: [{ text: "客户端伪造资料" }] }, { action: "other" },
  ])("rejects malformed or client-injected generation input %#", async value => {
    await expect(generateBookAi(A, value as BookAiInput)).rejects.toMatchObject({ status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["other book", (r: BookAiResponse) => { r.bookId = B; }],
    ["different action", (r: BookAiResponse) => { r.action = "introduction"; }],
    ["unexpected question", (r: BookAiResponse) => { r.question = "另一问题"; }],
    ["external source URL", (r: BookAiResponse) => { r.sources[1].href = "https://example.test/unverified"; }],
    ["other book source", (r: BookAiResponse) => { r.sources[1].href = `/books/${B}#book-note-${NOTE}`; }],
    ["invented citation", (r: BookAiResponse) => { r.draft.content += "[S99]"; r.citedSourceIds.push("S99"); }],
    ["unmapped paragraph citation", (r: BookAiResponse) => { r.draft.content += "[S1]"; }],
    ["uncited answer", (r: BookAiResponse) => { r.draft.content = "无来源的回答"; r.citedSourceIds = []; }],
    ["duplicate source identity", (r: BookAiResponse) => { r.sources[1].id = "S1"; }],
    ["missing note revision", (r: BookAiResponse) => { r.sources[1].revisionId = null; }],
    ["claimed full context", (r: BookAiResponse) => { r.context.notesAvailable = 8; }],
    ["wrong source counts", (r: BookAiResponse) => { r.context.notesIncluded = 2; }],
  ])("rejects a response containing %s", async (_label, change) => {
    const value = result(); change(value);
    fetchMock.mockResolvedValue(json(value));
    await expect(generateBookAi(A, { action: "notes_summary" })).rejects.toMatchObject({ status: 502 });
  });

  it("accepts an honestly bounded selection and an explicitly disabled WeRead source", async () => {
    const value = result();
    value.context.notesAvailable = 20; value.context.truncated = true; value.context.wereadEnabled = false;
    fetchMock.mockResolvedValue(json(value));
    expect((await generateBookAi(A, { action: "notes_summary" })).context).toMatchObject({ notesAvailable: 20, notesIncluded: 1, truncated: true, wereadEnabled: false });
  });

  it("returns insufficient context without converting it into a savable AI draft", async () => {
    const value = result(); value.source = "insufficient_context";
    value.sources = value.sources.slice(0, 1); value.citedSourceIds = [];
    value.draft.content = "尚无可整理的本书笔记，请先补充资料。";
    value.context.notesAvailable = 0; value.context.notesIncluded = 0;
    value.context.sourceChars = value.sources[0].excerpt.length;
    fetchMock.mockResolvedValue(json(value));
    const answer = await generateBookAi(A, { action: "notes_summary" });
    expect(answer.source).toBe("insufficient_context");
    expect(() => bookAiDraftContent(answer)).toThrow("请先补充本书资料");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the actual cited source snapshot inside the visible editable body before saving", () => {
    const value = result("question");
    const content = bookAiDraftContent(value);
    expect(content).toContain("问题：哪些线索需要核对？");
    expect(content).toContain(value.draft.content);
    expect(content).toContain("[S2] 踏查笔记（版本 2）");
    expect(content).toContain(`[查看来源](/books/${A}#book-note-${NOTE})`);
    expect(content).toContain("> 渡口旁有旧石阶。\n> 还需与地方志核对。");
    expect(content).not.toContain("[S1] 合成古道书");
    expect(content).toContain(value.generatedAt);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not expose provider or network error bodies", async () => {
    fetchMock.mockResolvedValueOnce(json({ error: { code: "BOOK_AI_PROVIDER_FAILED", message: "upstream sensitive detail" } }, 502));
    await expect(generateBookAi(A, { action: "introduction" })).rejects.toMatchObject({ status: 502, message: "AI 返回的内容或来源异常，请重新生成。" });
    fetchMock.mockRejectedValueOnce(new Error("sensitive network detail"));
    await expect(generateBookAi(A, { action: "introduction" })).rejects.toMatchObject({ message: "暂时无法连接 AI 服务，请重试。" });
    fetchMock.mockResolvedValueOnce(json({ error: { code: "BOOK_AI_DISABLED", message: "internal configuration" } }, 503));
    await expect(generateBookAi(A, { action: "introduction" })).rejects.toMatchObject({ status: 503, message: "本书 AI 助手尚未启用，现有介绍和笔记仍可编辑。" });
  });

  it("does not fetch for a request cancelled before generation", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(generateBookAi(A, { action: "notes_summary" }, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("discards a late generation response even when transport ignores cancellation", async () => {
    const pending = deferred<Response>(), controller = new AbortController();
    fetchMock.mockReturnValue(pending.promise);
    const read = generateBookAi(A, { action: "notes_summary" }, controller.signal);
    const rejected = expect(read).rejects.toMatchObject({ name: "AbortError" });
    controller.abort(); pending.resolve(json(result()));
    await rejected;
  });

  it("discards decoded private content after logout or replacement of the session", async () => {
    const pending = deferred<unknown>(), decoded = deferred<void>();
    fetchMock.mockResolvedValue({ ok: true, json: () => { decoded.resolve(); return pending.promise; } } as Response);
    const read = generateBookAi(A, { action: "notes_summary" });
    const rejected = expect(read).rejects.toMatchObject({ name: "AbortError" });
    await decoded.promise; logout(); login("new-session-csrf"); pending.resolve(result());
    await rejected;
  });
});
