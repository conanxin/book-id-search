// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { BookAiAssistant } from "./BookAiAssistant";
import { __resetWebAuthStoreForTests, __setWebAuthSnapshotForTests } from "../auth/session";
import { createBookNote, getBookWorkspace, saveBookWorkspace } from "./api";
import { generateBookAi } from "./bookAi";
import { BOOK_WEB_RESEARCH_EXCERPTS_NOTICE, bookWebResearchContent, generateBookWebResearch, type BookWebResearchResponse, type BookWebResearchSource } from "./bookWebResearch";
import { BookWebSourceReadError, bookWebSourceContent, readBookWebSource, type BookWebSourceReadResponse } from "./bookWebSourceReader";

vi.mock("../auth/session", async original => ({ ...await original<typeof import("../auth/session")>(), ensureAuthSessionLoaded: vi.fn(async () => {}) }));
vi.mock("./api", async original => ({ ...await original<typeof import("./api")>(), getBookWorkspace: vi.fn(), saveBookWorkspace: vi.fn(), createBookNote: vi.fn() }));
vi.mock("./bookAi", async original => ({ ...await original<typeof import("./bookAi")>(), generateBookAi: vi.fn() }));
vi.mock("./bookWebResearch", async original => ({ ...await original<typeof import("./bookWebResearch")>(), generateBookWebResearch: vi.fn() }));
vi.mock("./bookWebSourceReader", async original => ({ ...await original<typeof import("./bookWebSourceReader")>(), readBookWebSource: vi.fn() }));

const A = "10000001_100000000001", B = "10000002_100000000002", QUESTION = "这本书有哪些相关研究？";
const auth = (csrf = "csrf-a") => ({ status: "authenticated" as const, user: { email: "owner@example.test", name: "Owner" }, csrfToken: csrf, error: null });
const writeClipboard = vi.fn<(text: string) => Promise<void>>();
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
function answer(bookId = A, question = QUESTION): BookWebResearchResponse {
  return {
    bookId, question, mode: "source_excerpts", source: "web_research", generatedAt: "2026-11-12T12:00:00.000Z",
    draft: { title: "查到的相关资料", content: `${BOOK_WEB_RESEARCH_EXCERPTS_NOTICE}\n\n建议先查看：[W1]` },
    sources: [
      { id: "W1", kind: "web", title: "旅行史目录", url: "https://catalog.example.test/books/1", excerpt: "原始搜索节选，保持搜索时的文字。", pageAge: null, truncated: false, readToken: "A".repeat(32) },
      { id: "W2", kind: "web", title: "其他线索", url: "https://journal.example.test/research/2", excerpt: "另一条搜索节选。", pageAge: null, truncated: false, readToken: "B".repeat(32) },
    ],
    citedSourceIds: ["W1"], search: { performed: true, queries: ["旅行史 相关研究"], calls: 1 },
  };
}
function extracted(bookId = A, source: BookWebResearchSource = answer().sources[0]): BookWebSourceReadResponse {
  return {
    bookId, sourceId: source.id, requestedUrl: source.url, finalUrl: `${source.url}/readable`, title: `${source.title}正文`,
    text: "从网页取得的可读文字。\n\n<script>literal source text</script>\n**来源中的原符号**",
    contentType: "text/html", extraction: "html_readable_text", truncated: true, fetchedAt: "2026-11-12T12:01:00.000Z",
  };
}
const view = (bookId = A) => <MemoryRouter><BookAiAssistant bookId={bookId} /></MemoryRouter>;
const click = async (name: string) => { await act(async () => { fireEvent.click(screen.getByRole("button", { name, exact: true })); }); };
const question = () => screen.getByLabelText("联网研究问题") as HTMLTextAreaElement;
const reader = (id = "W1") => screen.getByRole("region", { name: `网页可读文字 ${id}`, exact: true });
async function search() {
  fireEvent.change(question(), { target: { value: QUESTION } }); await click("联网查资料");
}
async function mount() {
  const rendered = render(view()); await click("联网研究"); await search(); return rendered;
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  return { promise: new Promise<T>((yes, no) => { resolve = yes; reject = no; }), resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks(); __resetWebAuthStoreForTests(); __setWebAuthSnapshotForTests(auth());
  vi.mocked(generateBookWebResearch).mockReset().mockImplementation(async (bookId, input) => answer(bookId, input.question.trim()));
  vi.mocked(readBookWebSource).mockReset().mockImplementation(async (bookId, source) => extracted(bookId, source));
  writeClipboard.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: writeClipboard } });
});
afterEach(() => {
  cleanup(); __resetWebAuthStoreForTests();
  if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
  for (const method of [getBookWorkspace, saveBookWorkspace, createBookNote, generateBookAi]) expect(method).not.toHaveBeenCalled();
});

describe("read-only webpage text in the research sidebar", () => {
  it("reads only on explicit action and offers one reader per selected or unselected source", async () => {
    await mount();
    expect(readBookWebSource).not.toHaveBeenCalled();
    expect(screen.queryByRole("region", { name: "网页可读文字 W1" })).toBeNull();
    await click("查看网页依据 W1");
    expect(screen.getAllByRole("button", { name: "读取网页正文 W1", exact: true })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "读取网页正文 W2", exact: true })).toHaveLength(1);
    await click("读取网页正文 W2");
    expect(readBookWebSource).toHaveBeenCalledWith(A, answer().sources[1], expect.any(AbortSignal));
    expect(reader("W2").textContent).toContain("已提取网页文字");
    expect(screen.queryByRole("region", { name: "网页可读文字 W1" })).toBeNull();
  });

  it("keeps old search sources without tokens usable as excerpts", async () => {
    const old = answer(); old.sources.forEach(source => { delete source.readToken; });
    vi.mocked(generateBookWebResearch).mockResolvedValue(old);
    await mount();
    expect(screen.queryByRole("button", { name: /读取网页正文/ })).toBeNull();
    expect(screen.getByRole("region", { name: "联网研究结果" }).textContent).toContain(old.sources[0].excerpt);
    await click("复制结果与来源");
    expect(writeClipboard).toHaveBeenCalledWith(bookWebResearchContent(old));
  });

  it("shows literal extracted text, preserves the search snapshot and copies each separately", async () => {
    render(<><textarea aria-label="我的手工介绍" defaultValue="我的介绍原文" /><textarea aria-label="我的手工笔记" defaultValue="我的笔记原文" />{view()}</>);
    await click("联网研究"); await search(); await click("读取网页正文 W1");
    const body = reader();
    expect(body.querySelector("blockquote")?.textContent).toBe(extracted().text);
    expect(body.querySelector("script")).toBeNull(); expect(body.querySelector("strong")).toBeNull();
    expect(body.textContent).toContain("网页可读文字（自动提取）");
    expect(body.textContent).toContain("本次提取已截短");
    expect(body.querySelector("time")?.dateTime).toBe(extracted().fetchedAt);
    expect(within(body).getByRole("link", { name: "查看已读取网页 W1" }).getAttribute("href")).toBe(extracted().finalUrl);
    await click("展开网页文字 W1");
    expect(screen.getByRole("button", { name: "收起网页文字 W1" }).getAttribute("aria-expanded")).toBe("true");
    await click("复制网页文字与来源 W1");
    expect(writeClipboard).toHaveBeenLastCalledWith(bookWebSourceContent(extracted(), answer().sources[0]));
    await click("复制结果与来源");
    expect(writeClipboard).toHaveBeenLastCalledWith(bookWebResearchContent(answer()));
    expect(writeClipboard.mock.calls[1][0]).not.toContain(extracted().text);
    expect(document.querySelector('[data-web-excerpt-source-id="W1"] > blockquote')?.textContent).toBe(answer().sources[0].excerpt);
    expect((screen.getByLabelText("我的手工介绍") as HTMLTextAreaElement).value).toBe("我的介绍原文");
    expect((screen.getByLabelText("我的手工笔记") as HTMLTextAreaElement).value).toBe("我的笔记原文");
    expect(screen.queryByRole("button", { name: /保存为书籍介绍|保存为新笔记/ })).toBeNull();
  });

  it("keeps the excerpt on read failure and retries only when requested", async () => {
    vi.mocked(readBookWebSource).mockRejectedValueOnce(new BookWebSourceReadError(415, "暂不支持读取这类链接，请打开原网页查看。", "BOOK_SOURCE_UNSUPPORTED"));
    await mount(); await click("读取网页正文 W1");
    expect(screen.getByRole("alert").textContent).toContain("暂不支持读取这类链接");
    expect(document.querySelector('[data-web-excerpt-source-id="W1"] > blockquote')?.textContent).toBe(answer().sources[0].excerpt);
    expect(screen.queryByRole("region", { name: "网页可读文字 W1" })).toBeNull();
    expect(readBookWebSource).toHaveBeenCalledOnce();
    await click("读取网页正文 W1");
    expect(readBookWebSource).toHaveBeenCalledTimes(2); expect(reader()).toBeTruthy();
  });

  it("rechecks source identity before rendering even if a read client returns the wrong source", async () => {
    vi.mocked(readBookWebSource).mockResolvedValue({ ...extracted(), sourceId: "W2" });
    await mount(); await click("读取网页正文 W1");
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "网页可读文字 W1" })).toBeNull();
  });

  it.each(["cancel", "clear", "question", "scope", "book", "session", "logout", "research"])("cancels and discards a late read after %s", async next => {
    const pending = deferred<BookWebSourceReadResponse>(); vi.mocked(readBookWebSource).mockReturnValueOnce(pending.promise);
    const rendered = await mount(); await click("读取网页正文 W1");
    const signal = vi.mocked(readBookWebSource).mock.calls[0][2]!;
    if (next === "cancel") await click("取消读取网页 W1");
    else if (next === "clear") await click("清除结果");
    else if (next === "question") fireEvent.change(question(), { target: { value: "换个问题" } });
    else if (next === "scope") { await click("本书资料"); await click("联网研究"); }
    else if (next === "book") rendered.rerender(view(B));
    else if (next === "session") act(() => __setWebAuthSnapshotForTests(auth("csrf-b")));
    else if (next === "logout") act(() => __setWebAuthSnapshotForTests({ status: "unauthenticated", user: null, csrfToken: null, error: null }));
    else await click("联网查资料");
    expect(signal.aborted).toBe(true);
    await act(async () => pending.resolve(extracted()));
    expect(screen.queryByRole("region", { name: "网页可读文字 W1" })).toBeNull();
    expect(screen.queryByText("已复制网页文字、来源与读取时间。")).toBeNull();
  });

  it("does not reuse an already extracted W1 when the same search is repeated", async () => {
    await mount(); await click("读取网页正文 W1"); expect(reader()).toBeTruthy();
    await click("联网查资料");
    expect(screen.queryByRole("region", { name: "网页可读文字 W1" })).toBeNull();
    expect(screen.getByRole("button", { name: "读取网页正文 W1" })).toBeTruthy();
    expect(readBookWebSource).toHaveBeenCalledOnce();
  });

  it("does not let a cancelled read replace a later successful read", async () => {
    const pending = deferred<BookWebSourceReadResponse>(); vi.mocked(readBookWebSource).mockReturnValueOnce(pending.promise);
    await mount(); await click("读取网页正文 W1"); await click("取消读取网页 W1"); await click("读取网页正文 W1");
    await act(async () => pending.resolve({ ...extracted(), text: "旧请求的文字" }));
    expect(reader().querySelector("blockquote")?.textContent).toBe(extracted().text);
  });

  it("retains extracted text through mobile close and reopen without another read", async () => {
    await mount(); await click("打开 AI 助手"); await click("读取网页正文 W1");
    await click("关闭 AI 助手"); await click("打开 AI 助手");
    expect(reader()).toBeTruthy(); expect(readBookWebSource).toHaveBeenCalledOnce();
  });

  it.each(["missing", "denied"])("offers a read-only copy fallback when the clipboard is %s", async mode => {
    if (mode === "missing") Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    else writeClipboard.mockRejectedValue(new DOMException("Denied", "NotAllowedError"));
    await mount(); await click("读取网页正文 W1"); await click("复制网页文字与来源 W1");
    const fallback = screen.getByLabelText("可复制的网页文字 W1") as HTMLTextAreaElement;
    expect(fallback.readOnly).toBe(true);
    expect(fallback.value).toBe(bookWebSourceContent(extracted(), answer().sources[0]));
  });

  it("leaves manual-editor focus in place when a read or clipboard denial arrives late", async () => {
    const pendingRead = deferred<BookWebSourceReadResponse>(), pendingCopy = deferred<void>();
    vi.mocked(readBookWebSource).mockReturnValueOnce(pendingRead.promise); writeClipboard.mockReturnValueOnce(pendingCopy.promise);
    render(<><textarea aria-label="我的手工编辑" defaultValue="正在写笔记" />{view()}</>);
    await click("联网研究"); await search();
    act(() => screen.getByRole("button", { name: "读取网页正文 W1" }).focus()); await click("读取网页正文 W1");
    const editor = screen.getByLabelText("我的手工编辑") as HTMLTextAreaElement; act(() => editor.focus());
    await act(async () => pendingRead.resolve(extracted()));
    expect(document.activeElement).toBe(editor);
    act(() => screen.getByRole("button", { name: "复制网页文字与来源 W1" }).focus()); await click("复制网页文字与来源 W1");
    act(() => editor.focus()); await act(async () => pendingCopy.reject(new DOMException("Denied", "NotAllowedError")));
    expect((screen.getByLabelText("可复制的网页文字 W1") as HTMLTextAreaElement).readOnly).toBe(true);
    expect(document.activeElement).toBe(editor); expect(editor.value).toBe("正在写笔记");
  });

  it.each(["clear", "question", "scope", "research"])("discards a late clipboard failure after %s", async next => {
    const pending = deferred<void>(); writeClipboard.mockReturnValueOnce(pending.promise);
    await mount(); await click("读取网页正文 W1"); await click("复制网页文字与来源 W1");
    if (next === "clear") await click("清除结果");
    else if (next === "question") fireEvent.change(question(), { target: { value: "新问题" } });
    else if (next === "scope") { await click("本书资料"); await click("联网研究"); }
    else await click("联网查资料");
    await act(async () => pending.reject(new DOMException("Denied", "NotAllowedError")));
    expect(screen.queryByLabelText("可复制的网页文字 W1")).toBeNull();
  });
});
