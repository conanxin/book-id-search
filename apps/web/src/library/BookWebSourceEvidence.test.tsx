// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { BookAiAssistant } from "./BookAiAssistant";
import { __resetWebAuthStoreForTests, __setWebAuthSnapshotForTests } from "../auth/session";
import { createBookNote, getBookWorkspace, saveBookWorkspace } from "./api";
import { generateBookAi } from "./bookAi";
import { BOOK_WEB_RESEARCH_EXCERPTS_NOTICE, generateBookWebResearch, type BookWebResearchResponse, type BookWebResearchSource } from "./bookWebResearch";
import { BookWebSourceReadError, bookWebSourceContent, readBookWebSource, type BookWebSourceReadResponse } from "./bookWebSourceReader";
import { BookWebSourceEvidenceError, bookWebSourceEvidenceContent, findBookWebSourceEvidence, type BookWebSourceEvidenceResponse } from "./bookWebSourceEvidence";

vi.mock("../auth/session", async original => ({ ...await original<typeof import("../auth/session")>(), ensureAuthSessionLoaded: vi.fn(async () => {}) }));
vi.mock("./api", async original => ({ ...await original<typeof import("./api")>(), getBookWorkspace: vi.fn(), saveBookWorkspace: vi.fn(), createBookNote: vi.fn() }));
vi.mock("./bookAi", async original => ({ ...await original<typeof import("./bookAi")>(), generateBookAi: vi.fn() }));
vi.mock("./bookWebResearch", async original => ({ ...await original<typeof import("./bookWebResearch")>(), generateBookWebResearch: vi.fn() }));
vi.mock("./bookWebSourceReader", async original => ({ ...await original<typeof import("./bookWebSourceReader")>(), readBookWebSource: vi.fn() }));
vi.mock("./bookWebSourceEvidence", async original => ({ ...await original<typeof import("./bookWebSourceEvidence")>(), findBookWebSourceEvidence: vi.fn() }));

const A = "10000001_100000000001", B = "10000002_100000000002", QUESTION = "这本书有哪些相关研究？";
const auth = (csrf = "csrf-a") => ({ status: "authenticated" as const, user: { email: "owner@example.test", name: "Owner" }, csrfToken: csrf, error: null });
const writeClipboard = vi.fn<(text: string) => Promise<void>>();
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
function answer(bookId = A, question = QUESTION): BookWebResearchResponse {
  return {
    bookId, question, mode: "source_excerpts", source: "web_research", generatedAt: "2026-11-13T12:00:00.000Z",
    draft: { title: "查到的相关资料", content: BOOK_WEB_RESEARCH_EXCERPTS_NOTICE + "\n\n建议先查看：[W1]" },
    sources: [
      { id: "W1", kind: "web", title: "旅行史目录", url: "https://catalog.example.test/books/1", excerpt: "原始搜索节选，保持搜索时的文字。", pageAge: null, truncated: false, readToken: "A".repeat(32) },
      { id: "W2", kind: "web", title: "其他线索", url: "https://journal.example.test/research/2", excerpt: "另一条搜索节选。", pageAge: null, truncated: false, readToken: "B".repeat(32) },
    ],
    citedSourceIds: ["W1"], search: { performed: true, queries: ["旅行史 相关研究"], calls: 1 },
  };
}
function snapshot(bookId = A, source: BookWebResearchSource = answer().sources[0]): BookWebSourceReadResponse {
  return {
    bookId, sourceId: source.id, requestedUrl: source.url, finalUrl: source.url + "/readable", title: source.title + "正文",
    text: "前文仍保留在网页正文。\n\n😀关于旅行研究的原句。\n<script>literal source text</script>\n**来源中的原符号**\n\n邻近后文。",
    contentType: "text/html", extraction: "html_readable_text", truncated: true, fetchedAt: "2026-11-13T12:01:00.000Z",
    snapshotToken: "S".repeat(32),
  };
}
function evidence(read = snapshot(), question = QUESTION): BookWebSourceEvidenceResponse {
  const start = read.text.indexOf("😀"), end = read.text.indexOf("\n\n邻近");
  return {
    bookId: read.bookId, sourceId: read.sourceId, snapshotToken: read.snapshotToken!, question,
    mode: "source_passages", status: "selected", requestedUrl: read.requestedUrl, finalUrl: read.finalUrl, title: read.title,
    fetchedAt: read.fetchedAt, sourceTruncated: read.truncated,
    passages: [{ id: "P2", start, end, text: read.text.slice(start, end) }], generatedAt: "2026-11-13T12:02:00.000Z",
  };
}
const view = (bookId = A) => <MemoryRouter><BookAiAssistant bookId={bookId} /></MemoryRouter>;
const click = async (name: string) => { await act(async () => { fireEvent.click(screen.getByRole("button", { name, exact: true })); }); };
const parentQuestion = () => screen.getByLabelText("联网研究问题") as HTMLTextAreaElement;
const question = () => screen.getByLabelText("原文依据问题 W1") as HTMLTextAreaElement;
const reader = () => screen.getByRole("region", { name: "网页可读文字 W1", exact: true });
const result = () => screen.getByRole("region", { name: "原文依据 W1", exact: true });
const pageText = () => reader().querySelector(".book-web-page-text");
async function search() {
  fireEvent.change(parentQuestion(), { target: { value: QUESTION } }); await click("联网查资料");
}
async function mount() {
  const rendered = render(view()); await click("联网研究"); await search(); await click("读取网页正文 W1"); return rendered;
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  return { promise: new Promise<T>((yes, no) => { resolve = yes; reject = no; }), resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks(); __resetWebAuthStoreForTests(); __setWebAuthSnapshotForTests(auth());
  vi.mocked(generateBookWebResearch).mockReset().mockImplementation(async (bookId, input) => answer(bookId, input.question.trim()));
  vi.mocked(readBookWebSource).mockReset().mockImplementation(async (bookId, source) => snapshot(bookId, source));
  vi.mocked(findBookWebSourceEvidence).mockReset().mockImplementation(async (read, _source, question) => evidence(read, question.trim()));
  writeClipboard.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: writeClipboard } });
});
afterEach(() => {
  cleanup(); __resetWebAuthStoreForTests();
  if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
  for (const method of [getBookWorkspace, saveBookWorkspace, createBookNote, generateBookAi]) expect(method).not.toHaveBeenCalled();
});

describe("original webpage evidence in the read-only research sidebar", () => {
  it("defaults to the research question and runs only once per explicit submit for selected and other sources", async () => {
    await mount();
    expect(question().value).toBe(QUESTION); expect(findBookWebSourceEvidence).not.toHaveBeenCalled();
    fireEvent.change(question(), { target: { value: "  关于旅行的原句？  " } });
    expect(findBookWebSourceEvidence).not.toHaveBeenCalled();
    await click("查找原文依据 W1");
    expect(findBookWebSourceEvidence).toHaveBeenCalledOnce();
    expect(findBookWebSourceEvidence).toHaveBeenCalledWith(snapshot(), answer().sources[0], "关于旅行的原句？", expect.any(AbortSignal));
    expect(result().textContent).toContain("AI 选中的原文片段");
    expect(question().value).toBe("  关于旅行的原句？  ");
    await click("查看网页依据 W1"); await click("读取网页正文 W2");
    expect((screen.getByLabelText("原文依据问题 W2") as HTMLTextAreaElement).value).toBe(QUESTION);
    expect(findBookWebSourceEvidence).toHaveBeenCalledOnce();
  });

  it("shows exact plain text with source and time, locates the slice with its neighbours, and copies only quotes plus provenance", async () => {
    render(<><textarea aria-label="我的手工介绍" defaultValue="尚未保存的介绍" /><textarea aria-label="我的手工笔记" defaultValue="尚未保存的笔记" />{view()}</>);
    await click("联网研究"); await search(); await click("读取网页正文 W1"); await click("查找原文依据 W1");
    const selected = result(), passage = selected.querySelector('[data-evidence-passage-id="P2"]');
    expect(passage?.querySelector("blockquote")?.textContent).toBe(evidence().passages[0].text);
    expect(selected.querySelector("script")).toBeNull(); expect(selected.querySelector("strong")).toBeNull();
    expect(within(selected).getByRole("link", { name: "查看原文依据网页 W1" }).getAttribute("href")).toBe(snapshot().finalUrl);
    expect(selected.textContent).toContain(snapshot().fetchedAt);
    expect(selected.textContent).toContain("本次网页提取已截短");
    const locate = screen.getByRole("button", { name: "在网页正文中定位 P2 W1" });
    act(() => locate.focus()); await click("在网页正文中定位 P2 W1");
    const mark = pageText()?.querySelector('[data-web-source-highlight="P2"]');
    expect(mark?.textContent).toBe(evidence().passages[0].text);
    expect(pageText()?.textContent).toBe(snapshot().text);
    expect(pageText()?.className).toContain("is-expanded");
    expect(document.activeElement).toBe(mark);
    await click("收起网页文字 W1");
    act(() => locate.focus()); await click("在网页正文中定位 P2 W1");
    expect(pageText()?.className).toContain("is-expanded");
    expect(document.activeElement).toBe(mark);
    await click("复制原文依据与来源 W1");
    expect(writeClipboard).toHaveBeenLastCalledWith(bookWebSourceEvidenceContent(evidence(), snapshot(), answer().sources[0]));
    const copied = writeClipboard.mock.calls[0][0];
    expect(copied).not.toContain(snapshot().snapshotToken); expect(copied).not.toContain(answer().sources[0].readToken);
    expect(copied).not.toContain("尚未保存");
    expect((screen.getByLabelText("我的手工介绍") as HTMLTextAreaElement).value).toBe("尚未保存的介绍");
    expect((screen.getByLabelText("我的手工笔记") as HTMLTextAreaElement).value).toBe("尚未保存的笔记");
    expect(screen.queryByRole("button", { name: /保存为书籍介绍|保存为新笔记/ })).toBeNull();
    expect(document.querySelector('[data-web-excerpt-source-id="W1"] > blockquote')?.textContent).toBe(answer().sources[0].excerpt);
  });

  it("keeps body and excerpt after a model error, and retries only when requested", async () => {
    vi.mocked(findBookWebSourceEvidence).mockRejectedValueOnce(new BookWebSourceEvidenceError(504, "本次查找原文依据超时，已读网页文字仍保留，可重试。"));
    await mount(); await click("查找原文依据 W1");
    expect(screen.getByRole("alert").textContent).toContain("超时");
    expect(pageText()?.textContent).toBe(snapshot().text);
    expect(document.querySelector('[data-web-excerpt-source-id="W1"] > blockquote')?.textContent).toBe(answer().sources[0].excerpt);
    expect(findBookWebSourceEvidence).toHaveBeenCalledOnce();
    await click("查找原文依据 W1");
    expect(result()).toBeTruthy(); expect(findBookWebSourceEvidence).toHaveBeenCalledTimes(2);
    expect(readBookWebSource).toHaveBeenCalledOnce();
  });

  it("shows insufficient evidence without making up an answer", async () => {
    vi.mocked(findBookWebSourceEvidence).mockResolvedValue({ ...evidence(), status: "insufficient_evidence", passages: [] });
    await mount(); await click("查找原文依据 W1");
    expect(result().textContent).toContain("未找到足够相关的原文");
    expect(result().querySelector("blockquote")).toBeNull();
    expect(screen.queryByRole("button", { name: "复制原文依据与来源 W1" })).toBeNull();
    expect(pageText()?.textContent).toBe(snapshot().text);
  });

  it("rechecks exact offsets and identity even if a client returns a forged quote", async () => {
    vi.mocked(findBookWebSourceEvidence).mockResolvedValue({ ...evidence(), passages: [{ ...evidence().passages[0], text: "模型改写的一句话" }] });
    await mount(); await click("查找原文依据 W1");
    expect(screen.getByRole("alert").textContent).toContain("片段与当前网页不一致");
    expect(screen.queryByRole("region", { name: "原文依据 W1", exact: true })).toBeNull();
    expect(pageText()?.textContent).toBe(snapshot().text);
    expect(writeClipboard).not.toHaveBeenCalled();
  });

  it.each(["cancel", "evidence-question", "clear", "clear-source", "reread", "question", "scope", "book", "session", "logout", "research"])(
    "aborts and discards a late result after %s", async next => {
      const pending = deferred<BookWebSourceEvidenceResponse>();
      vi.mocked(findBookWebSourceEvidence).mockReturnValueOnce(pending.promise);
      const rendered = await mount(); await click("查找原文依据 W1");
      const signal = vi.mocked(findBookWebSourceEvidence).mock.calls[0][3]!;
      if (next === "cancel") await click("取消查找原文依据 W1");
      else if (next === "evidence-question") fireEvent.change(question(), { target: { value: "另一个问题" } });
      else if (next === "clear") await click("清除结果");
      else if (next === "clear-source") await click("清除网页正文 W1");
      else if (next === "reread") await click("重新读取网页正文 W1");
      else if (next === "question") fireEvent.change(parentQuestion(), { target: { value: "换个研究问题" } });
      else if (next === "scope") { await click("本书资料"); await click("联网研究"); }
      else if (next === "book") rendered.rerender(view(B));
      else if (next === "session") act(() => __setWebAuthSnapshotForTests(auth("csrf-b")));
      else if (next === "logout") act(() => __setWebAuthSnapshotForTests({ status: "unauthenticated", user: null, csrfToken: null, error: null }));
      else await click("联网查资料");
      expect(signal.aborted).toBe(true);
      await act(async () => pending.resolve(evidence()));
      expect(screen.queryByRole("region", { name: "原文依据 W1", exact: true })).toBeNull();
      expect(document.querySelector("[data-web-source-highlight]")).toBeNull();
      expect(screen.queryByLabelText("可复制的原文依据 W1")).toBeNull();
    },
  );

  it("clears an old selection on question edit and never lets its late request replace the next question", async () => {
    const pending = deferred<BookWebSourceEvidenceResponse>();
    vi.mocked(findBookWebSourceEvidence).mockReturnValueOnce(pending.promise);
    await mount(); await click("查找原文依据 W1");
    fireEvent.change(question(), { target: { value: "新问题" } }); await click("查找原文依据 W1");
    await act(async () => pending.resolve(evidence()));
    expect(result().textContent).toContain("新问题");
    expect(result().textContent).not.toContain(QUESTION);
    await click("在网页正文中定位 P2 W1");
    await click("清除原文依据 W1");
    expect(screen.queryByRole("region", { name: "原文依据 W1", exact: true })).toBeNull();
    expect(document.querySelector("[data-web-source-highlight]")).toBeNull();
    expect(pageText()?.textContent).toBe(snapshot().text);
  });

  it("keeps the previous body if re-reading fails, but clears its evidence and does not rerun the model", async () => {
    await mount(); await click("查找原文依据 W1");
    vi.mocked(readBookWebSource).mockRejectedValueOnce(new BookWebSourceReadError(502, "暂时无法读取这个网页，可重试或打开原网页。"));
    await click("重新读取网页正文 W1");
    expect(pageText()?.textContent).toBe(snapshot().text);
    expect(reader().textContent).toContain("仍保留上次成功读取");
    expect(screen.queryByRole("region", { name: "原文依据 W1", exact: true })).toBeNull();
    expect(findBookWebSourceEvidence).toHaveBeenCalledOnce();
    expect(question().value).toBe(QUESTION);
  });

  it("offers an explicit reread for expired snapshots and legacy read responses without auto fetching", async () => {
    vi.mocked(findBookWebSourceEvidence).mockRejectedValueOnce(new BookWebSourceEvidenceError(410, "本次已读网页已过期，请重新读取网页正文后再查找原文依据。", "BOOK_EVIDENCE_EXPIRED"));
    await mount(); await click("查找原文依据 W1");
    expect(screen.getByRole("alert").textContent).toContain("重新读取网页正文");
    expect(readBookWebSource).toHaveBeenCalledOnce();
    vi.mocked(readBookWebSource).mockResolvedValueOnce({ ...snapshot(), snapshotToken: undefined });
    await click("重新读取网页正文 W1");
    expect(screen.queryByLabelText("原文依据问题 W1")).toBeNull();
    expect(reader().textContent).toContain("本次读取尚不支持查找原文依据");
    expect(pageText()?.textContent).toBe(snapshot().text);
    await click("复制网页文字与来源 W1");
    expect(writeClipboard).toHaveBeenLastCalledWith(bookWebSourceContent(snapshot(), answer().sources[0]));
    expect(readBookWebSource).toHaveBeenCalledTimes(2); expect(findBookWebSourceEvidence).toHaveBeenCalledOnce();
  });

  it.each(["missing", "denied"])("provides a read-only copy fallback when clipboard is %s", async mode => {
    if (mode === "missing") Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    else writeClipboard.mockRejectedValue(new DOMException("Denied", "NotAllowedError"));
    await mount(); await click("查找原文依据 W1"); await click("复制原文依据与来源 W1");
    const fallback = screen.getByLabelText("可复制的原文依据 W1") as HTMLTextAreaElement;
    expect(fallback.readOnly).toBe(true);
    expect(fallback.value).toBe(bookWebSourceEvidenceContent(evidence(), snapshot(), answer().sources[0]));
    expect(fallback.value).not.toContain(snapshot().snapshotToken);
  });

  it("keeps manual-editor focus and unsaved text when selection or clipboard failure completes late", async () => {
    const pendingFind = deferred<BookWebSourceEvidenceResponse>(), pendingCopy = deferred<void>();
    vi.mocked(findBookWebSourceEvidence).mockReturnValueOnce(pendingFind.promise); writeClipboard.mockReturnValueOnce(pendingCopy.promise);
    render(<><textarea aria-label="我的手工编辑" defaultValue="尚未保存的编辑" />{view()}</>);
    await click("联网研究"); await search(); await click("读取网页正文 W1");
    act(() => screen.getByRole("button", { name: "查找原文依据 W1" }).focus()); await click("查找原文依据 W1");
    const editor = screen.getByLabelText("我的手工编辑") as HTMLTextAreaElement; act(() => editor.focus());
    await act(async () => pendingFind.resolve(evidence())); expect(document.activeElement).toBe(editor);
    act(() => screen.getByRole("button", { name: "复制原文依据与来源 W1" }).focus()); await click("复制原文依据与来源 W1");
    act(() => editor.focus()); await act(async () => pendingCopy.reject(new DOMException("Denied", "NotAllowedError")));
    expect(screen.getByLabelText("可复制的原文依据 W1")).toBeTruthy();
    expect(document.activeElement).toBe(editor); expect(editor.value).toBe("尚未保存的编辑");
  });

  it.each(["clear", "question", "reread", "research"])("discards late clipboard failure after %s", async next => {
    const pending = deferred<void>(); writeClipboard.mockReturnValueOnce(pending.promise);
    await mount(); await click("查找原文依据 W1"); await click("复制原文依据与来源 W1");
    if (next === "clear") await click("清除原文依据 W1");
    else if (next === "question") fireEvent.change(question(), { target: { value: "新问题" } });
    else if (next === "reread") await click("重新读取网页正文 W1");
    else await click("联网查资料");
    await act(async () => pending.reject(new DOMException("Denied", "NotAllowedError")));
    expect(screen.queryByLabelText("可复制的原文依据 W1")).toBeNull();
    expect(screen.queryByText("已复制原文片段、来源与读取时间。")).toBeNull();
  });

  it("retains selected passages when the mobile sidebar closes and reopens without extra calls", async () => {
    await mount(); await click("打开 AI 助手"); await click("查找原文依据 W1");
    await click("关闭 AI 助手"); await click("打开 AI 助手");
    expect(result()).toBeTruthy(); expect(findBookWebSourceEvidence).toHaveBeenCalledOnce();
    expect(readBookWebSource).toHaveBeenCalledOnce();
  });
});
