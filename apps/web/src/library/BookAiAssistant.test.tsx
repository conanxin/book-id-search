// @vitest-environment jsdom
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { BookAiAssistant } from "./BookAiAssistant";
import { __resetWebAuthStoreForTests, __setWebAuthSnapshotForTests } from "../auth/session";
import { createBookNote, getBookWorkspace, saveBookWorkspace } from "./api";
import { BookAiError, bookAiDraftContent, generateBookAi, type BookAiAction, type BookAiResponse } from "./bookAi";

vi.mock("../auth/session", async original => ({ ...await original<typeof import("../auth/session")>(), ensureAuthSessionLoaded: vi.fn(async () => {}) }));
vi.mock("./api", async original => ({ ...await original<typeof import("./api")>(), getBookWorkspace: vi.fn(), saveBookWorkspace: vi.fn(), createBookNote: vi.fn() }));
vi.mock("./bookAi", async original => ({ ...await original<typeof import("./bookAi")>(), generateBookAi: vi.fn() }));

const A = "10000001_100000000001", B = "10000002_100000000002";
const noteId = "11111111-1111-4111-8111-111111111111";
const revisionId = "22222222-2222-4222-8222-222222222222";
const date = "2026-10-11T04:00:00Z";
const auth = (csrf = "csrf-a") => ({ status: "authenticated" as const, user: { email: "owner@example.test", name: "Owner" }, csrfToken: csrf, error: null });
const writeClipboard = vi.fn<(text: string) => Promise<void>>();
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");

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
const view = (bookId = A) => <MemoryRouter><BookAiAssistant bookId={bookId} /></MemoryRouter>;
const click = async (name: string) => { await act(async () => { fireEvent.click(screen.getByRole("button", { name })); }); };
const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement | HTMLTextAreaElement;
const change = (label: string, value: string) => fireEvent.change(field(label), { target: { value } });
const result = () => screen.getByRole("region", { name: "AI 参考结果" });
const deferred = <T,>() => {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  return { promise: new Promise<T>((yes, no) => { resolve = yes; reject = no; }), resolve, reject };
};
const mount = async () => { const rendered = render(view()); await screen.findByRole("button", { name: "生成参考介绍" }); return rendered; };
const denyClipboard = () => writeClipboard.mockRejectedValue(new DOMException("Clipboard unavailable", "NotAllowedError"));

beforeEach(() => {
  vi.clearAllMocks(); __resetWebAuthStoreForTests(); __setWebAuthSnapshotForTests(auth());
  vi.mocked(generateBookAi).mockReset().mockImplementation(async (bookId, input) => answer(input.action, { bookId, question: input.action === "question" ? input.question!.trim() : null }));
  writeClipboard.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: writeClipboard } });
});
afterEach(() => {
  cleanup(); __resetWebAuthStoreForTests();
  if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
  // All assistant actions stay separate from the user's introduction and notes.
  expect(saveBookWorkspace).not.toHaveBeenCalled();
  expect(createBookNote).not.toHaveBeenCalled();
  expect(getBookWorkspace).not.toHaveBeenCalled();
});

describe("book AI read-only sidebar", () => {
  it("does not read or generate private material before login", () => {
    __setWebAuthSnapshotForTests({ status: "unauthenticated", user: null, csrfToken: null, error: null });
    render(view());
    expect(screen.queryByRole("complementary", { name: "本书 AI 助手" })).toBeNull();
    expect(generateBookAi).not.toHaveBeenCalled();
  });

  it("opens an aside under StrictMode without automatically generating", async () => {
    render(<StrictMode>{view()}</StrictMode>);
    const panel = await screen.findByRole("complementary", { name: "本书 AI 助手" });
    expect(panel.tagName).toBe("ASIDE");
    expect(within(panel).getByLabelText("使用资料范围").textContent).toContain("已保存的补充介绍");
    expect(panel.textContent).toContain("电子版外链全文不在本次资料中");
    expect(within(panel).getByRole("button", { name: "参考介绍" }).getAttribute("aria-pressed")).toBe("true");
    expect(within(panel).getByRole("button", { name: "笔记摘要" })).toBeTruthy();
    expect(within(panel).getByRole("button", { name: "资料问答" })).toBeTruthy();
    expect(generateBookAi).not.toHaveBeenCalled();
  });

  it("provides an accessible mobile open and close control without clearing its reference result", async () => {
    await mount();
    const open = screen.getByRole("button", { name: "打开 AI 助手" });
    expect(open.getAttribute("aria-expanded")).toBe("false");
    const target = open.getAttribute("aria-controls");
    expect(target).toBeTruthy();
    expect(document.getElementById(target!)).not.toBeNull();
    await click("打开 AI 助手");
    const close = screen.getByRole("button", { name: "关闭 AI 助手" });
    expect(close.getAttribute("aria-expanded")).toBe("true");
    expect(close.getAttribute("aria-controls")).toBe(target);
    await click("生成参考介绍");
    await click("关闭 AI 助手");
    expect(screen.getByRole("button", { name: "打开 AI 助手" }).getAttribute("aria-expanded")).toBe("false");
    await click("打开 AI 助手");
    expect(result().textContent).toContain("旅行经验");
    expect(generateBookAi).toHaveBeenCalledTimes(1);
  });

  it("generates a read-only result with exact source excerpts, counts and current-book links", async () => {
    await mount(); await click("生成参考介绍");
    expect(generateBookAi).toHaveBeenCalledWith(A, { action: "introduction" }, expect.any(AbortSignal));
    expect(result().textContent).toContain("现有资料把旅行经验与地理线索联系起来。[S2]");
    expect(result().textContent).toContain("我的笔记提到沿着地名继续阅读。[S3]");
    expect(screen.queryByLabelText("AI 草稿正文")).toBeNull();
    expect(screen.queryByLabelText("AI 笔记标题")).toBeNull();
    expect(screen.queryByRole("form", { name: "保存 AI 草稿" })).toBeNull();
    expect(screen.queryByRole("button", { name: /保存为书籍介绍|保存为新笔记|读取最新书籍介绍/ })).toBeNull();
    expect(screen.getByLabelText("本次实际使用的资料").textContent).toContain("我的笔记 1 / 1 篇");
    expect(screen.getByLabelText("本次实际使用的资料").textContent).toContain("微信读书 1 / 1 条");
    await click("查看依据 S3");
    const source = document.querySelector('[data-ai-source-id="S3"]') as HTMLElement;
    expect(source.textContent).toContain("我的手工笔记正文");
    expect(document.activeElement).toBe(source);
    expect(within(source).getByRole("link").getAttribute("href")).toBe(`/books/${A}#book-note-${noteId}`);
    expect(source.closest("details")?.open).toBe(true);
    expect(generateBookAi).toHaveBeenCalledTimes(1);
  });

  it("renders the returned Markdown as prose without a draft editor or a second preview", async () => {
    const value = answer("introduction", { draft: { title: "阅读线索", content: "## AI 阅读线索\n\n- 对照 **地名** [S3]\n\n> 回到原书核对 [S2]" } });
    vi.mocked(generateBookAi).mockResolvedValueOnce(value);
    await mount(); await click("生成参考介绍");
    const reference = result();
    expect(within(reference).getByRole("heading", { name: "AI 阅读线索" })).toBeTruthy();
    expect(reference.querySelector("strong")?.textContent).toBe("地名");
    expect(reference.querySelector("blockquote")?.textContent).toContain("回到原书核对 [S2]");
    expect(reference.querySelector(".book-prose")).not.toBeNull();
    expect(reference.querySelector('[contenteditable="true"]')).toBeNull();
    expect(within(reference).queryByRole("textbox")).toBeNull();
    expect(screen.queryByText("预览草稿", { selector: "summary" })).toBeNull();
    expect(screen.queryByText("查看 AI 原稿", { selector: "summary" })).toBeNull();
    expect(generateBookAi).toHaveBeenCalledTimes(1);
  });

  it("keeps focus in the user's editor when a reference request finishes after they leave the sidebar", async () => {
    const pending = deferred<BookAiResponse>(); vi.mocked(generateBookAi).mockReturnValueOnce(pending.promise);
    render(<><textarea aria-label="我的手工编辑" defaultValue="我正在补充的介绍" />{view()}</>);
    const generate = await screen.findByRole("button", { name: "生成参考介绍" });
    act(() => generate.focus());
    await click("生成参考介绍");
    const editor = field("我的手工编辑");
    act(() => editor.focus());
    await act(async () => pending.resolve(answer()));
    expect(result().textContent).toContain("旅行经验");
    expect(document.activeElement).toBe(editor);
    expect(editor.value).toBe("我正在补充的介绍");
  });

  it.each([
    ["introduction", "参考介绍", "生成参考介绍"],
    ["notes_summary", "笔记摘要", "生成笔记摘要"],
    ["question", "资料问答", "根据资料回答"],
  ] as const)("copies the %s result and its captured sources without saving it", async (action, mode, generate) => {
    await mount(); await click(mode);
    if (action === "question") change("想问这本书的问题", "资料中有哪些古道线索？");
    await click(generate);
    expect(writeClipboard).not.toHaveBeenCalled();
    await click("复制结果与来源");
    expect(writeClipboard).toHaveBeenCalledOnce();
    expect(writeClipboard).toHaveBeenCalledWith(bookAiDraftContent(answer(action)));
    expect(screen.queryByLabelText("可复制的 AI 结果")).toBeNull();
    expect(screen.queryByLabelText("AI 草稿正文")).toBeNull();
    expect(screen.queryByLabelText("AI 笔记标题")).toBeNull();
    expect(screen.queryByRole("button", { name: /保存为书籍介绍|保存为新笔记/ })).toBeNull();
    expect(generateBookAi).toHaveBeenCalledTimes(1);
  });

  it("offers the same result and sources in a read-only field when copying is denied", async () => {
    denyClipboard();
    await mount(); await click("生成参考介绍"); await click("复制结果与来源");
    const fallback = screen.getByRole("textbox", { name: "可复制的 AI 结果" }) as HTMLTextAreaElement;
    expect(fallback.readOnly).toBe(true);
    expect(fallback.value).toBe(bookAiDraftContent(answer()));
    expect(fallback.value).toContain("参考资料（生成时摘录）");
    expect(fallback.value).toContain(`/books/${A}#book-note-${noteId}`);
    expect(result().textContent).toContain("旅行经验");
    expect(generateBookAi).toHaveBeenCalledTimes(1);
  });

  it("keeps focus in the user's editor when a pending clipboard request is denied", async () => {
    const pending = deferred<void>(); writeClipboard.mockReturnValueOnce(pending.promise);
    render(<><textarea aria-label="我的手工编辑" defaultValue="我正在写的笔记" />{view()}</>);
    await screen.findByRole("button", { name: "生成参考介绍" });
    await click("生成参考介绍");
    const copy = screen.getByRole("button", { name: "复制结果与来源" });
    act(() => copy.focus());
    await click("复制结果与来源");
    const editor = field("我的手工编辑");
    act(() => editor.focus());
    await act(async () => pending.reject(new DOMException("Clipboard unavailable", "NotAllowedError")));
    const fallback = screen.getByRole("textbox", { name: "可复制的 AI 结果" }) as HTMLTextAreaElement;
    expect(fallback.readOnly).toBe(true);
    expect(fallback.value).toBe(bookAiDraftContent(answer()));
    expect(document.activeElement).toBe(editor);
    expect(editor.value).toBe("我正在写的笔记");
  });

  it("offers manual copying when the browser has no clipboard API", async () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    await mount(); await click("生成参考介绍"); await click("复制结果与来源");
    const fallback = screen.getByRole("textbox", { name: "可复制的 AI 结果" }) as HTMLTextAreaElement;
    expect(fallback.readOnly).toBe(true);
    expect(fallback.value).toBe(bookAiDraftContent(answer()));
    expect(writeClipboard).not.toHaveBeenCalled();
  });

  it("clears the reference result, source details and manual-copy text without another request", async () => {
    denyClipboard();
    await mount(); await click("生成参考介绍"); await click("查看依据 S3"); await click("复制结果与来源");
    await click("清除结果");
    expect(screen.queryByRole("region", { name: "AI 参考结果" })).toBeNull();
    expect(document.querySelector("[data-ai-source-id]")).toBeNull();
    expect(screen.queryByLabelText("可复制的 AI 结果")).toBeNull();
    expect(screen.queryByRole("button", { name: "复制结果与来源" })).toBeNull();
    expect(screen.getByRole("button", { name: "生成参考介绍" }).matches(":disabled")).toBe(false);
    expect(generateBookAi).toHaveBeenCalledTimes(1);
    expect(writeClipboard).toHaveBeenCalledOnce();
  });

  it.each(["清除结果", "生成参考介绍"])("does not revive old copy text after %s when clipboard permission fails late", async nextAction => {
    const pending = deferred<void>(); writeClipboard.mockReturnValueOnce(pending.promise);
    await mount(); await click("生成参考介绍"); await click("复制结果与来源");
    await click(nextAction);
    await act(async () => pending.reject(new DOMException("Clipboard unavailable", "NotAllowedError")));
    expect(screen.queryByLabelText("可复制的 AI 结果")).toBeNull();
    if (nextAction === "清除结果") expect(screen.queryByRole("region", { name: "AI 参考结果" })).toBeNull();
    else expect(result().textContent).toContain("旅行经验");
  });

  it("replaces only the transient result when generating again", async () => {
    denyClipboard();
    await mount(); await click("生成参考介绍"); await click("复制结果与来源");
    const next = deferred<BookAiResponse>(); vi.mocked(generateBookAi).mockReturnValueOnce(next.promise);
    await click("生成参考介绍");
    expect(screen.queryByRole("region", { name: "AI 参考结果" })).toBeNull();
    expect(screen.queryByLabelText("可复制的 AI 结果")).toBeNull();
    expect(document.querySelector("[data-ai-source-id]")).toBeNull();
    await act(async () => next.resolve(answer("introduction", { draft: { title: "新参考", content: "新一轮整理的阅读线索。[S2] [S3]" } })));
    expect(result().textContent).toContain("新一轮整理的阅读线索");
    expect(result().textContent).not.toContain("现有资料把旅行经验");
    expect(generateBookAi).toHaveBeenCalledTimes(2);
    expect(writeClipboard).toHaveBeenCalledOnce();
  });

  it("asks a trimmed book-specific question and keeps the actual question beside the result", async () => {
    await mount(); await click("资料问答"); change("想问这本书的问题", "  资料中有哪些古道线索？  ");
    await click("根据资料回答");
    expect(generateBookAi).toHaveBeenCalledWith(A, { action: "question", question: "资料中有哪些古道线索？" }, expect.any(AbortSignal));
    expect(screen.getByText("本次问题：资料中有哪些古道线索？")).toBeTruthy();
    expect(within(result()).queryByRole("textbox")).toBeNull();
    expect(screen.getByRole("button", { name: "复制结果与来源" })).toBeTruthy();
  });

  it("rejects a blank question without invoking the provider", async () => {
    await mount(); await click("资料问答"); change("想问这本书的问题", "   ");
    await act(async () => { fireEvent.submit(screen.getByRole("form", { name: "根据资料回答" })); });
    expect(screen.getByRole("alert").textContent).toContain("请填写想问这本书的问题");
    expect(generateBookAi).not.toHaveBeenCalled();
  });

  it("removes the previous answer and manual-copy text immediately when its question is edited", async () => {
    denyClipboard();
    await mount(); await click("资料问答"); change("想问这本书的问题", "原来的问题"); await click("根据资料回答");
    await click("复制结果与来源");
    change("想问这本书的问题", "新的问题");
    expect(screen.queryByRole("region", { name: "AI 参考结果" })).toBeNull();
    expect(screen.queryByLabelText("可复制的 AI 结果")).toBeNull();
    expect(screen.queryByText("本次问题：原来的问题")).toBeNull();
    expect(screen.queryByRole("button", { name: "复制结果与来源" })).toBeNull();
  });

  it("aborts and ignores an older question when typing during generation", async () => {
    const old = deferred<BookAiResponse>(); vi.mocked(generateBookAi).mockReturnValueOnce(old.promise);
    await mount(); await click("资料问答"); change("想问这本书的问题", "旧问题"); await click("根据资料回答");
    const signal = vi.mocked(generateBookAi).mock.calls[0][2]!;
    change("想问这本书的问题", "新问题"); expect(signal.aborted).toBe(true);
    await act(async () => old.resolve(answer("question", { question: "旧问题", draft: { title: "旧答案", content: "迟到的旧问题答案。[S2] [S3]" } })));
    expect(screen.queryByText(/迟到的旧问题答案/)).toBeNull();
    expect(screen.queryByRole("region", { name: "AI 参考结果" })).toBeNull();
    await click("根据资料回答");
    expect(screen.getByText("本次问题：新问题")).toBeTruthy();
  });

  it("aborts a request on mode change and ignores a response from the old mode", async () => {
    const old = deferred<BookAiResponse>(); vi.mocked(generateBookAi).mockReturnValueOnce(old.promise);
    await mount(); await click("生成参考介绍"); const signal = vi.mocked(generateBookAi).mock.calls[0][2]!;
    await click("笔记摘要"); expect(signal.aborted).toBe(true);
    await act(async () => old.resolve(answer("introduction", { draft: { title: "旧介绍", content: "迟到的介绍结果。[S2] [S3]" } })));
    expect(screen.queryByText(/迟到的介绍结果/)).toBeNull();
    expect(screen.queryByRole("region", { name: "AI 参考结果" })).toBeNull();
    expect(screen.getByRole("button", { name: "生成笔记摘要" })).toBeTruthy();
  });

  it("does not revive results or manual-copy text when returning to a prior mode", async () => {
    denyClipboard();
    await mount(); await click("生成参考介绍"); await click("复制结果与来源");
    await click("笔记摘要"); await click("参考介绍");
    expect(screen.queryByRole("region", { name: "AI 参考结果" })).toBeNull();
    expect(screen.queryByLabelText("可复制的 AI 结果")).toBeNull();
    expect(generateBookAi).toHaveBeenCalledTimes(1);
  });

  it("cancels an in-flight request and keeps a newer generation when the old response arrives", async () => {
    const old = deferred<BookAiResponse>(); vi.mocked(generateBookAi).mockReturnValueOnce(old.promise);
    await mount(); await click("生成参考介绍"); const signal = vi.mocked(generateBookAi).mock.calls[0][2]!;
    await click("取消生成"); expect(signal.aborted).toBe(true);
    await click("生成参考介绍"); expect(result().textContent).toContain("旅行经验");
    await act(async () => old.resolve(answer("introduction", { draft: { title: "旧稿", content: "已取消的迟到结果。[S2] [S3]" } })));
    expect(result().textContent).not.toContain("已取消的迟到结果");
    expect(result().textContent).toContain("旅行经验");
  });

  it("aborts and ignores book A's response when switching to book B", async () => {
    const old = deferred<BookAiResponse>(); vi.mocked(generateBookAi).mockReturnValueOnce(old.promise);
    const rendered = await mount(); await click("生成参考介绍"); const signal = vi.mocked(generateBookAi).mock.calls[0][2]!;
    rendered.rerender(view(B)); expect(signal.aborted).toBe(true);
    await act(async () => old.resolve(answer("introduction", { draft: { title: "书甲结果", content: "只属于书甲的生成内容。[S2] [S3]" } })));
    expect(screen.queryByRole("region", { name: "AI 参考结果" })).toBeNull();
    expect(screen.queryByText(/只属于书甲的生成内容/)).toBeNull();
    await click("生成参考介绍"); expect(generateBookAi).toHaveBeenLastCalledWith(B, { action: "introduction" }, expect.any(AbortSignal));
    await click("查看依据 S3");
    const source = document.querySelector('[data-ai-source-id="S3"]') as HTMLElement;
    expect(within(source).getByRole("link").getAttribute("href")).toBe(`/books/${B}#book-note-${noteId}`);
  });

  it("removes generated results and manual-copy text when changing books", async () => {
    denyClipboard();
    const rendered = await mount(); await click("生成参考介绍"); await click("复制结果与来源");
    rendered.rerender(view(B));
    expect(screen.queryByRole("region", { name: "AI 参考结果" })).toBeNull();
    expect(screen.queryByLabelText("可复制的 AI 结果")).toBeNull();
    expect(document.querySelector("[data-ai-source-id]")).toBeNull();
    expect(generateBookAi).toHaveBeenCalledTimes(1);
  });

  it("removes private results on logout and aborts a subsequent session's late request", async () => {
    denyClipboard();
    await mount(); await click("生成参考介绍"); await click("复制结果与来源");
    act(() => __setWebAuthSnapshotForTests({ status: "signing_out", user: null, csrfToken: null, error: null }));
    expect(screen.queryByRole("complementary", { name: "本书 AI 助手" })).toBeNull();
    expect(screen.queryByLabelText("可复制的 AI 结果")).toBeNull();
    act(() => __setWebAuthSnapshotForTests(auth("csrf-b")));
    expect(screen.queryByRole("region", { name: "AI 参考结果" })).toBeNull();
    const old = deferred<BookAiResponse>(); vi.mocked(generateBookAi).mockReturnValueOnce(old.promise);
    await click("生成参考介绍"); const signal = vi.mocked(generateBookAi).mock.calls[1][2]!;
    act(() => __setWebAuthSnapshotForTests({ status: "unauthenticated", user: null, csrfToken: null, error: null }));
    expect(signal.aborted).toBe(true);
    await act(async () => old.resolve(answer("introduction", { draft: { title: "旧会话", content: "迟到的旧会话正文。[S2] [S3]" } })));
    expect(screen.queryByText(/迟到的旧会话正文/)).toBeNull();
  });

  it("clears private results when the authenticated session is replaced without unmounting", async () => {
    denyClipboard();
    await mount(); await click("生成参考介绍"); await click("复制结果与来源");
    act(() => __setWebAuthSnapshotForTests(auth("csrf-b")));
    expect(screen.queryByRole("region", { name: "AI 参考结果" })).toBeNull();
    expect(screen.queryByLabelText("可复制的 AI 结果")).toBeNull();
    expect(screen.getByRole("button", { name: "生成参考介绍" })).toBeTruthy();
    expect(generateBookAi).toHaveBeenCalledTimes(1);
  });

  it("aborts a pending request on authenticated-session replacement", async () => {
    const old = deferred<BookAiResponse>(); vi.mocked(generateBookAi).mockReturnValueOnce(old.promise);
    await mount(); await click("生成参考介绍"); const signal = vi.mocked(generateBookAi).mock.calls[0][2]!;
    act(() => __setWebAuthSnapshotForTests(auth("csrf-b")));
    expect(signal.aborted).toBe(true);
    await act(async () => old.resolve(answer()));
    expect(screen.queryByRole("region", { name: "AI 参考结果" })).toBeNull();
  });

  it("does not expose or copy a partially validated result", async () => {
    const value = answer(); value.context.sourceChars += 1;
    vi.mocked(generateBookAi).mockResolvedValueOnce(value);
    await mount(); await click("生成参考介绍");
    expect(screen.getByRole("alert").textContent).toContain("来源异常");
    expect(screen.queryByRole("region", { name: "AI 参考结果" })).toBeNull();
    expect(screen.queryByRole("button", { name: "复制结果与来源" })).toBeNull();
    expect(writeClipboard).not.toHaveBeenCalled();
  });

  it.each([
    [new BookAiError(503, "本书 AI 助手暂不可用，请稍后重试。"), "本书 AI 助手暂不可用"],
    [new Error("provider private payload / internal host"), "暂时无法生成，请重试。"],
  ] as const)("shows a bounded error and permits a fresh request (%s)", async (error, message) => {
    vi.mocked(generateBookAi).mockRejectedValueOnce(error);
    await mount(); await click("生成参考介绍");
    expect(screen.getByRole("alert").textContent).toContain(message);
    expect(screen.getByRole("alert").textContent).not.toMatch(/private|internal/);
    expect(screen.queryByRole("region", { name: "AI 参考结果" })).toBeNull();
    await click("生成参考介绍");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(result().textContent).toContain("旅行经验");
  });

  it("shows actual source limits without offering an insufficient-context answer for copying", async () => {
    const value = answer("notes_summary", { source: "insufficient_context", citedSourceIds: [], draft: { title: "资料不足", content: "本书尚无可整理的阅读笔记。" } });
    value.sources = [value.sources[0]];
    value.context = { ...value.context, introductionIncluded: false, notesAvailable: 0, notesIncluded: 0, wereadAvailable: 0, wereadIncluded: 0, wereadEnabled: false, sourceChars: value.sources[0].excerpt.length };
    vi.mocked(generateBookAi).mockResolvedValueOnce(value);
    await mount(); await click("笔记摘要"); await click("生成笔记摘要");
    expect(screen.getByText("本书尚无可整理的阅读笔记。")).toBeTruthy();
    expect(screen.getByText("微信读书未启用")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: "复制结果与来源" })).toBeNull();
    expect(screen.queryByLabelText("AI 草稿正文")).toBeNull();
    expect(writeClipboard).not.toHaveBeenCalled();
  });

  it("labels partial coverage and preserves source excerpts as literal text", async () => {
    const value = answer(); value.context = { ...value.context, notesAvailable: 9, notesIncluded: 1, wereadAvailable: 20, wereadIncluded: 1, truncated: true };
    value.sources[2] = { ...value.sources[2], excerpt: "<script>literal source text</script>\n原样节选", truncated: true };
    value.context.sourceChars = value.sources.reduce((sum, source) => sum + source.excerpt.length, 0);
    vi.mocked(generateBookAi).mockResolvedValueOnce(value);
    await mount(); await click("生成参考介绍"); await click("查看依据 S3");
    expect(screen.getByText("我的笔记 1 / 9 篇")).toBeTruthy(); expect(screen.getByText("微信读书 1 / 20 条")).toBeTruthy();
    expect(screen.getByText(/本次使用了部分资料或节选/)).toBeTruthy();
    const source = document.querySelector('[data-ai-source-id="S3"]')!;
    expect(source.textContent).toContain("<script>literal source text</script>"); expect(source.querySelector("script")).toBeNull();
    expect(source.textContent).toContain("本条为节选");
  });
});
