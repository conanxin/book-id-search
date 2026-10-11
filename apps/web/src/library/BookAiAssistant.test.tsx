// @vitest-environment jsdom
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { BookWorkspace } from "./BookWorkspace";
import { __resetWebAuthStoreForTests, __setWebAuthSnapshotForTests } from "../auth/session";
import { createBookNote, getBookWorkspace, LibraryApiError, saveBookWorkspace, type BookNote, type BookWorkspaceData } from "./api";
import { bookAiDraftContent, generateBookAi, type BookAiAction, type BookAiResponse } from "./bookAi";

vi.mock("../auth/session", async original => ({ ...await original<typeof import("../auth/session")>(), ensureAuthSessionLoaded: vi.fn(async () => {}) }));
vi.mock("./api", async original => ({ ...await original<typeof import("./api")>(), getBookWorkspace: vi.fn(), saveBookWorkspace: vi.fn(), createBookNote: vi.fn() }));
vi.mock("./bookAi", async original => ({ ...await original<typeof import("./bookAi")>(), generateBookAi: vi.fn() }));

const A = "10000001_100000000001", B = "10000002_100000000002";
const noteId = "11111111-1111-4111-8111-111111111111";
const revisionId = "22222222-2222-4222-8222-222222222222";
const date = "2026-10-11T04:00:00Z";
const auth = (csrf = "csrf-a") => ({ status: "authenticated" as const, user: { email: "owner@example.test", name: "Owner" }, csrfToken: csrf, error: null });
const note: BookNote = { noteId, title: "一条阅读线索", content: "我的手工笔记正文", currentRevisionId: revisionId,
  revisionNo: 1, createdAt: date, updatedAt: date, revisions: [{ revisionId, revisionNo: 1, createdAt: date }] };
const workspace = (changes: Partial<BookWorkspaceData> = {}): BookWorkspaceData => ({
  bookId: A, saved: true, editionId: "edition-a", introduction: "当前已保存的介绍", version: 2, updatedAt: date, notes: [note], resources: [], ...changes,
});
function answer(action: BookAiAction = "introduction", changes: Partial<BookAiResponse> = {}): BookAiResponse {
  const base = { contentHash: "a".repeat(64), truncated: false, revisionId: null };
  const result: BookAiResponse = {
    bookId: A, action, question: action === "question" ? "资料中有哪些古道线索？" : null,
    draft: { title: "本书阅读资料整理", content: "现有资料把旅行经验与地理线索联系起来。[S2]\n\n我的笔记提到沿着地名继续阅读。[S3]" },
    sources: [
      { ...base, id: "S1", kind: "catalog", label: "本书书目信息", excerpt: "书名：旅行与地理", href: `/books/${A}` },
      { ...base, id: "S2", kind: "introduction", label: "补充介绍 · 第 2 版", excerpt: "原样保存的介绍摘录。", href: `/books/${A}#library-introduction-heading` },
      { ...base, id: "S3", kind: "note", label: "一条阅读线索 · 第 1 版", excerpt: "我的手工笔记正文", href: `/books/${A}#book-note-${noteId}`, revisionId },
      { ...base, id: "S4", kind: "weread", label: "微信读书摘录", excerpt: "沿着旧地名寻找旅行的线索。", href: `/weread?catalogId=${A}` },
    ],
    citedSourceIds: ["S2", "S3"], context: { workspaceVersion: 2, introductionIncluded: true, notesAvailable: 1, notesIncluded: 1,
      wereadAvailable: 1, wereadIncluded: 1, wereadEnabled: true, truncated: false, sourceChars: 65 },
    source: "ai", generatedAt: date, ...changes,
  };
  result.sources = result.sources.map(source => ({ ...source, href: source.href.replace(A, result.bookId) }));
  result.context.sourceChars = result.sources.reduce((sum, source) => sum + source.excerpt.length, 0);
  return result;
}
const view = (bookId = A) => <MemoryRouter><BookWorkspace bookId={bookId} /></MemoryRouter>;
const click = async (name: string) => { await act(async () => { fireEvent.click(screen.getByRole("button", { name })); }); };
const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement | HTMLTextAreaElement;
const change = (label: string, value: string) => fireEvent.change(field(label), { target: { value } });
const deferred = <T,>() => { let resolve!: (value: T) => void; return { promise: new Promise<T>(r => { resolve = r; }), resolve }; };
const mount = async () => { const rendered = render(view()); await screen.findByRole("button", { name: "生成介绍草稿" }); return rendered; };

beforeEach(() => {
  vi.clearAllMocks(); __resetWebAuthStoreForTests(); __setWebAuthSnapshotForTests(auth());
  vi.mocked(getBookWorkspace).mockImplementation(async bookId => workspace({ bookId }));
  vi.mocked(generateBookAi).mockImplementation(async (bookId, input) => answer(input.action, { bookId, question: input.action === "question" ? input.question!.trim() : null }));
  vi.mocked(saveBookWorkspace).mockImplementation(async (bookId, input) => workspace({ bookId, introduction: input.introduction ?? "", version: 3 }));
  vi.mocked(createBookNote).mockImplementation(async (bookId, input) => workspace({ bookId, notes: [note, { ...note, noteId: "33333333-3333-4333-8333-333333333333", title: input.title, content: input.content }] }));
});
afterEach(() => { cleanup(); __resetWebAuthStoreForTests(); });

describe("book AI assistant", () => {
  it("does not read or generate private material before login", () => {
    __setWebAuthSnapshotForTests({ status: "unauthenticated", user: null, csrfToken: null, error: null });
    render(view());
    expect(screen.queryByRole("region", { name: "本书 AI 助手" })).toBeNull();
    expect(generateBookAi).not.toHaveBeenCalled(); expect(getBookWorkspace).not.toHaveBeenCalled();
  });

  it("opens under StrictMode without automatically generating or saving", async () => {
    render(<StrictMode>{view()}</StrictMode>);
    const panel = await screen.findByRole("region", { name: "本书 AI 助手" });
    expect(within(panel).getByLabelText("使用资料范围").textContent).toContain("已保存的补充介绍");
    expect(panel.textContent).toContain("电子版外链全文不在本次资料中");
    expect(generateBookAi).not.toHaveBeenCalled(); expect(saveBookWorkspace).not.toHaveBeenCalled(); expect(createBookNote).not.toHaveBeenCalled();
  });

  it("generates a visible editable draft with exact source excerpts, counts and current-book links", async () => {
    await mount(); await click("生成介绍草稿");
    expect(generateBookAi).toHaveBeenCalledWith(A, { action: "introduction" }, expect.any(AbortSignal));
    expect(field("AI 草稿正文").value).toBe(bookAiDraftContent(answer()));
    expect(screen.getByLabelText("本次实际使用的资料").textContent).toContain("我的笔记 1 / 1 篇");
    expect(screen.getByLabelText("本次实际使用的资料").textContent).toContain("微信读书 1 / 1 条");
    await click("查看依据 S3");
    const source = document.querySelector('[data-ai-source-id="S3"]') as HTMLElement;
    expect(source.textContent).toContain(note.content);
    expect(document.activeElement).toBe(source);
    expect(within(source).getByRole("link").getAttribute("href")).toBe(`/books/${A}#book-note-${noteId}`);
    expect(document.getElementById(`book-note-${noteId}`)?.textContent).toContain(note.content);
    expect(saveBookWorkspace).not.toHaveBeenCalled(); expect(createBookNote).not.toHaveBeenCalled();
  });

  it("renders the AI original and a live draft preview without saving or requesting more material", async () => {
    const value = answer("introduction", { draft: { title: "阅读线索", content: "## AI 阅读线索\n\n- 对照 **地名** [S3]\n\n> 回到原书核对 [S2]" } });
    vi.mocked(generateBookAi).mockResolvedValueOnce(value);
    await mount(); await click("生成介绍草稿");
    const originalSummary = screen.getByText("查看 AI 原稿", { selector: "summary" });
    const original = originalSummary.parentElement as HTMLDetailsElement;
    expect(original.open).toBe(false);
    await act(async () => { fireEvent.click(originalSummary); });
    expect(within(original).getByRole("heading", { name: "AI 阅读线索" })).toBeTruthy();
    expect(original.querySelector("strong")?.textContent).toBe("地名");
    expect(original.querySelector("blockquote")?.textContent).toContain("回到原书核对 [S2]");
    expect(within(original).queryByRole("textbox")).toBeNull();
    const summary = screen.getByText("预览草稿", { selector: "summary" });
    const preview = summary.parentElement as HTMLDetailsElement;
    expect(preview.open).toBe(false); expect(preview.querySelector(".book-prose")).toBeNull();
    await act(async () => { fireEvent.click(summary); });
    await waitFor(() => expect(preview.querySelector(".book-prose")).not.toBeNull());
    expect(within(preview).getByRole("heading", { name: "AI 阅读线索" })).toBeTruthy();
    expect(within(preview).getByRole("heading", { name: "参考资料（生成时摘录）" })).toBeTruthy();
    expect(within(preview).getAllByRole("link", { name: "查看来源" }).map(link => link.getAttribute("href")))
      .toContain(`/books/${A}#book-note-${noteId}`);
    expect(field("AI 草稿正文").value).toBe(bookAiDraftContent(value));
    const edited = "# 我的定稿\n\n[回到笔记](/books/10000001_100000000001#book-note-11111111-1111-4111-8111-111111111111)\n";
    change("AI 草稿正文", edited);
    expect(within(preview).getByRole("heading", { name: "我的定稿" })).toBeTruthy();
    expect(within(preview).queryByRole("heading", { name: "AI 阅读线索" })).toBeNull();
    expect(within(original).getByRole("heading", { name: "AI 阅读线索" })).toBeTruthy();
    expect(field("AI 草稿正文").value).toBe(edited);
    await act(async () => { fireEvent.click(summary); });
    await waitFor(() => expect(preview.querySelector(".book-prose")).toBeNull());
    expect(generateBookAi).toHaveBeenCalledTimes(1); expect(getBookWorkspace).toHaveBeenCalledTimes(1);
    expect(saveBookWorkspace).not.toHaveBeenCalled(); expect(createBookNote).not.toHaveBeenCalled();
  });

  it("saves only the edited visible introduction using the generation's captured version", async () => {
    const draft = "## 核对后的介绍\n\n经过我核对的介绍，保留 **原文重点**。\n\n[参考](https://example.test/source)\n";
    vi.mocked(getBookWorkspace).mockResolvedValue(workspace({ version: 7 }));
    await mount(); await click("生成介绍草稿");
    change("AI 草稿正文", draft);
    expect(saveBookWorkspace).not.toHaveBeenCalled();
    await click("保存为书籍介绍");
    expect(saveBookWorkspace).toHaveBeenCalledWith(A, { introduction: draft, baseVersion: 2 }, expect.any(AbortSignal));
    expect(await screen.findByText("AI 草稿已保存为书籍介绍。")).toBeTruthy();
    const introduction = screen.getByRole("region", { name: "我的补充介绍" });
    expect(within(introduction).getByRole("heading", { name: "核对后的介绍" })).toBeTruthy();
    expect(within(introduction).getByRole("link", { name: "参考" }).getAttribute("href")).toBe("https://example.test/source");
    expect(field("AI 草稿正文").value).toBe(draft);
    expect(screen.getByRole("button", { name: "保存为书籍介绍" }).matches(":disabled")).toBe(true);
    expect(createBookNote).not.toHaveBeenCalled();
  });

  it("creates one edited summary note and updates the same book's note list", async () => {
    const content = `## 核对后的摘要\n\n${bookAiDraftContent(answer("notes_summary"))}\n`;
    await mount(); await click("笔记摘要"); await click("生成笔记摘要");
    change("AI 笔记标题", "我的阅读摘要"); change("AI 草稿正文", content);
    expect(createBookNote).not.toHaveBeenCalled();
    await click("保存为新笔记");
    expect(createBookNote).toHaveBeenCalledWith(A, { title: "我的阅读摘要", content }, expect.any(AbortSignal));
    const saved = await screen.findByRole("article", { name: "笔记：我的阅读摘要" });
    expect(within(saved).getByRole("heading", { name: "核对后的摘要" })).toBeTruthy();
    expect(within(saved).getAllByRole("link", { name: "查看来源" }).map(link => link.getAttribute("href")))
      .toContain(`/books/${A}#book-note-${noteId}`);
    await click("保存为新笔记"); expect(createBookNote).toHaveBeenCalledTimes(1);
    expect(saveBookWorkspace).not.toHaveBeenCalled();
  });

  it("asks a trimmed book-specific question and keeps the actual requested question beside the result", async () => {
    await mount(); await click("资料问答"); change("想问这本书的问题", "  资料中有哪些古道线索？  ");
    await click("根据资料回答");
    expect(generateBookAi).toHaveBeenCalledWith(A, { action: "question", question: "资料中有哪些古道线索？" }, expect.any(AbortSignal));
    expect(screen.getByText("本次问题：资料中有哪些古道线索？")).toBeTruthy();
    expect(screen.getByRole("button", { name: "保存为新笔记" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "保存为书籍介绍" })).toBeNull();
  });

  it("rejects a blank question without invoking the provider", async () => {
    await mount(); await click("资料问答"); change("想问这本书的问题", "   ");
    await act(async () => { fireEvent.submit(screen.getByRole("form", { name: "根据资料回答" })); });
    expect(screen.getByRole("alert").textContent).toContain("请填写想问这本书的问题");
    expect(generateBookAi).not.toHaveBeenCalled();
  });

  it("removes a prior answer immediately when its question is edited", async () => {
    await mount(); await click("资料问答"); change("想问这本书的问题", "原来的问题"); await click("根据资料回答");
    expect(field("AI 草稿正文")).toBeTruthy();
    change("想问这本书的问题", "新的问题");
    expect(screen.queryByLabelText("AI 草稿正文")).toBeNull();
    expect(screen.queryByText("本次问题：原来的问题")).toBeNull();
    expect(screen.queryByRole("button", { name: "保存为新笔记" })).toBeNull();
  });

  it("aborts and ignores an older question when typing during generation", async () => {
    const old = deferred<BookAiResponse>(); vi.mocked(generateBookAi).mockReturnValueOnce(old.promise);
    await mount(); await click("资料问答"); change("想问这本书的问题", "旧问题"); await click("根据资料回答");
    const signal = vi.mocked(generateBookAi).mock.calls[0][2]!;
    change("想问这本书的问题", "新问题"); expect(signal.aborted).toBe(true);
    await act(async () => old.resolve(answer("question", { question: "旧问题", draft: { title: "旧答案", content: "迟到的旧问题答案" } })));
    expect(screen.queryByText("迟到的旧问题答案")).toBeNull(); expect(screen.queryByLabelText("AI 草稿正文")).toBeNull();
    await click("根据资料回答");
    expect(screen.getByText("本次问题：新问题")).toBeTruthy();
  });

  it("aborts a request on mode change and never displays a response from the old mode", async () => {
    const old = deferred<BookAiResponse>(); vi.mocked(generateBookAi).mockReturnValueOnce(old.promise);
    await mount(); await click("生成介绍草稿"); const signal = vi.mocked(generateBookAi).mock.calls[0][2]!;
    await click("笔记摘要"); expect(signal.aborted).toBe(true);
    await act(async () => old.resolve(answer("introduction", { draft: { title: "旧介绍", content: "迟到的介绍草稿" } })));
    expect(screen.queryByText("迟到的介绍草稿")).toBeNull(); expect(screen.queryByLabelText("AI 草稿正文")).toBeNull();
    expect(screen.getByRole("button", { name: "生成笔记摘要" })).toBeTruthy();
  });

  it("cancels an in-flight provider request and allows another generation", async () => {
    const old = deferred<BookAiResponse>(); vi.mocked(generateBookAi).mockReturnValueOnce(old.promise);
    await mount(); await click("生成介绍草稿"); const signal = vi.mocked(generateBookAi).mock.calls[0][2]!;
    await click("取消生成"); expect(signal.aborted).toBe(true);
    await click("生成介绍草稿"); expect(field("AI 草稿正文").value).toContain("旅行经验");
    await act(async () => old.resolve(answer("introduction", { draft: { title: "旧稿", content: "已取消的迟到草稿" } })));
    expect(field("AI 草稿正文").value).not.toContain("已取消的迟到草稿");
  });

  it("aborts and removes book A's result on switching to book B", async () => {
    const old = deferred<BookAiResponse>(); vi.mocked(generateBookAi).mockReturnValueOnce(old.promise);
    const rendered = await mount(); await click("生成介绍草稿"); const signal = vi.mocked(generateBookAi).mock.calls[0][2]!;
    rendered.rerender(view(B)); expect(signal.aborted).toBe(true);
    await screen.findByRole("button", { name: "生成介绍草稿" });
    await act(async () => old.resolve(answer("introduction", { draft: { title: "书甲结果", content: "只属于书甲的生成内容" } })));
    expect(screen.queryByLabelText("AI 草稿正文")).toBeNull();
    expect(screen.queryByText("只属于书甲的生成内容")).toBeNull();
    await click("生成介绍草稿"); expect(generateBookAi).toHaveBeenLastCalledWith(B, { action: "introduction" }, expect.any(AbortSignal));
  });

  it("removes private drafts immediately on logout and aborts any late generation", async () => {
    await mount(); await click("生成介绍草稿"); change("AI 草稿正文", "这个会话的私有草稿");
    const old = deferred<BookAiResponse>(); vi.mocked(generateBookAi).mockReturnValueOnce(old.promise);
    await click("生成介绍草稿"); const signal = vi.mocked(generateBookAi).mock.calls[1][2]!;
    act(() => __setWebAuthSnapshotForTests({ status: "signing_out", user: null, csrfToken: null, error: null }));
    expect(signal.aborted).toBe(true); expect(screen.queryByRole("region", { name: "本书 AI 助手" })).toBeNull();
    await act(async () => old.resolve(answer("introduction", { draft: { title: "旧会话", content: "迟到的旧会话正文" } })));
    expect(screen.queryByText("迟到的旧会话正文")).toBeNull();
    act(() => __setWebAuthSnapshotForTests(auth("csrf-b")));
    await screen.findByRole("button", { name: "生成介绍草稿" });
    expect(screen.queryByLabelText("AI 草稿正文")).toBeNull();
  });

  it("resets generated drafts on a mounted authenticated-session replacement", async () => {
    await mount(); await click("生成介绍草稿"); change("AI 草稿正文", "上一登录会话的草稿");
    act(() => __setWebAuthSnapshotForTests(auth("csrf-b")));
    expect(screen.queryByLabelText("AI 草稿正文")).toBeNull();
    await screen.findByRole("button", { name: "生成介绍草稿" });
    expect(screen.queryByText("上一登录会话的草稿")).toBeNull();
  });

  it("keeps a conflicted AI introduction, reads the new version and requires a deliberate retry", async () => {
    const draft = "## 我保留的 AI 编辑稿\n\n[核对来源](https://example.test/source)\n";
    const latest = "# 另一个页面保存的新介绍\n\n> 新补充的引文";
    vi.mocked(getBookWorkspace).mockResolvedValueOnce(workspace()).mockResolvedValueOnce(workspace({ version: 3, introduction: latest }));
    vi.mocked(saveBookWorkspace).mockRejectedValueOnce(new LibraryApiError(409, "介绍已在其他页面更新。"))
      .mockResolvedValueOnce(workspace({ version: 4, introduction: draft }));
    await mount(); await click("生成介绍草稿"); change("AI 草稿正文", draft);
    await click("保存为书籍介绍"); expect((screen.getByRole("button", { name: "保存为书籍介绍" }) as HTMLButtonElement).disabled).toBe(true);
    expect(field("AI 草稿正文").value).toBe(draft);
    await click("读取最新书籍介绍");
    const comparison = screen.getByText("刚读取的最新书籍介绍", { selector: "summary" }).parentElement!;
    expect(within(comparison).getByRole("heading", { name: "另一个页面保存的新介绍" })).toBeTruthy();
    expect(comparison.querySelector("blockquote")?.textContent).toContain("新补充的引文");
    expect(field("AI 草稿正文").value).toBe(draft);
    expect(saveBookWorkspace).toHaveBeenCalledTimes(1);
    await click("保存为书籍介绍");
    expect(saveBookWorkspace).toHaveBeenLastCalledWith(A, { introduction: draft, baseVersion: 3 }, expect.any(AbortSignal));
    expect(screen.getByText("AI 草稿已保存为书籍介绍。")).toBeTruthy();
  });

  it("retains an edited note after a save failure and retries without regenerating", async () => {
    vi.mocked(createBookNote).mockRejectedValueOnce(new LibraryApiError(503, "暂时无法保存"))
      .mockResolvedValueOnce(workspace({ notes: [{ ...note, title: "我的摘要", content: "保留的正文" }] }));
    await mount(); await click("笔记摘要"); await click("生成笔记摘要");
    change("AI 笔记标题", "我的摘要"); change("AI 草稿正文", "保留的正文"); await click("保存为新笔记");
    expect(screen.getByRole("alert").textContent).toBe("暂时无法保存"); expect(field("AI 草稿正文").value).toBe("保留的正文");
    await click("保存为新笔记"); expect(screen.getByText("AI 草稿已保存为新笔记。")).toBeTruthy();
    expect(generateBookAi).toHaveBeenCalledTimes(1); expect(createBookNote).toHaveBeenCalledTimes(2);
  });

  it("shows a bounded unavailable message and retries without exposing provider details", async () => {
    vi.mocked(generateBookAi).mockRejectedValueOnce(new Error("provider private payload / internal host"));
    await mount(); await click("生成介绍草稿");
    expect(screen.getByRole("alert").textContent).not.toMatch(/private|internal/);
    expect(screen.queryByLabelText("AI 草稿正文")).toBeNull();
    await click("生成介绍草稿"); expect(field("AI 草稿正文")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("does not expose a partially initialized editor when source validation rejects a draft", async () => {
    const value = answer(); value.context.sourceChars += 1;
    vi.mocked(generateBookAi).mockResolvedValueOnce(value);
    await mount(); await click("生成介绍草稿");
    expect(screen.getByRole("alert").textContent).toContain("来源异常");
    expect(screen.queryByLabelText("AI 草稿正文")).toBeNull();
    expect(screen.queryByRole("button", { name: "保存为书籍介绍" })).toBeNull();
    expect(saveBookWorkspace).not.toHaveBeenCalled();
  });

  it("shows actual source limits and keeps an insufficient-context response unsavable", async () => {
    const value = answer("notes_summary", { source: "insufficient_context", citedSourceIds: [], draft: { title: "资料不足", content: "本书尚无可整理的阅读笔记。" } });
    value.sources = [value.sources[0]];
    value.context = { ...value.context, introductionIncluded: false, notesAvailable: 0, notesIncluded: 0, wereadAvailable: 0, wereadIncluded: 0, wereadEnabled: false, sourceChars: value.sources[0].excerpt.length };
    vi.mocked(generateBookAi).mockResolvedValueOnce(value);
    await mount(); await click("笔记摘要"); await click("生成笔记摘要");
    expect(screen.getByText("本书尚无可整理的阅读笔记。")).toBeTruthy();
    expect(screen.getByText("微信读书未启用")).toBeTruthy();
    expect(screen.queryByLabelText("AI 草稿正文")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: "保存为新笔记" })).toBeNull();
    expect(createBookNote).not.toHaveBeenCalled();
  });

  it("labels partial source coverage and preserves literal source excerpts", async () => {
    const value = answer(); value.context = { ...value.context, notesAvailable: 9, notesIncluded: 1, wereadAvailable: 20, wereadIncluded: 1, truncated: true };
    value.sources[2] = { ...value.sources[2], excerpt: "<script>literal source text</script>\n原样节选", truncated: true };
    value.context.sourceChars = value.sources.reduce((sum, source) => sum + source.excerpt.length, 0);
    vi.mocked(generateBookAi).mockResolvedValueOnce(value);
    await mount(); await click("生成介绍草稿"); await click("查看依据 S3");
    expect(screen.getByText("我的笔记 1 / 9 篇")).toBeTruthy(); expect(screen.getByText("微信读书 1 / 20 条")).toBeTruthy();
    expect(screen.getByText(/本次使用了部分资料或节选/)).toBeTruthy();
    const source = document.querySelector('[data-ai-source-id="S3"]')!;
    expect(source.textContent).toContain("<script>literal source text</script>"); expect(source.querySelector("script")).toBeNull();
    expect(source.textContent).toContain("本条为节选");
  });
});
