// @vitest-environment jsdom
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { BookAiAssistant } from "./BookAiAssistant";
import { __resetWebAuthStoreForTests, __setWebAuthSnapshotForTests } from "../auth/session";
import { createBookNote, getBookWorkspace, saveBookWorkspace } from "./api";
import { generateBookAi } from "./bookAi";
import { BOOK_WEB_RESEARCH_EXCERPTS_NOTICE, generateBookWebResearch, type BookWebResearchResponse, type BookWebResearchSource } from "./bookWebResearch";
import { BookWebSourceReadError, readBookWebSource, type BookWebSourceReadResponse } from "./bookWebSourceReader";
import { findBookWebSourceEvidence } from "./bookWebSourceEvidence";
import {
  BookWebSourceComparisonError, bookWebSourceComparisonContent, findBookWebSourceComparison,
  type BookWebSourceComparisonResponse,
} from "./bookWebSourceComparison";

vi.mock("../auth/session", async original => ({ ...await original<typeof import("../auth/session")>(), ensureAuthSessionLoaded: vi.fn(async () => {}) }));
vi.mock("./api", async original => ({ ...await original<typeof import("./api")>(), getBookWorkspace: vi.fn(), saveBookWorkspace: vi.fn(), createBookNote: vi.fn() }));
vi.mock("./bookAi", async original => ({ ...await original<typeof import("./bookAi")>(), generateBookAi: vi.fn() }));
vi.mock("./bookWebResearch", async original => ({ ...await original<typeof import("./bookWebResearch")>(), generateBookWebResearch: vi.fn() }));
vi.mock("./bookWebSourceReader", async original => ({ ...await original<typeof import("./bookWebSourceReader")>(), readBookWebSource: vi.fn() }));
vi.mock("./bookWebSourceEvidence", async original => ({ ...await original<typeof import("./bookWebSourceEvidence")>(), findBookWebSourceEvidence: vi.fn() }));
vi.mock("./bookWebSourceComparison", async original => ({ ...await original<typeof import("./bookWebSourceComparison")>(), findBookWebSourceComparison: vi.fn() }));

const A = "10000001_100000000001", B = "10000002_100000000002", QUESTION = "这些来源对出版年份分别怎么说？";
const auth = (csrf = "csrf-a") => ({ status: "authenticated" as const, user: { email: "owner@example.test", name: "Owner" }, csrfToken: csrf, error: null });
const writeClipboard = vi.fn<(text: string) => Promise<void>>();
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
function answer(bookId = A, question = QUESTION): BookWebResearchResponse {
  const citedSourceIds = ["W1", "W2", "W3"];
  return {
    bookId, question, mode: "source_excerpts", source: "web_research", generatedAt: "2026-11-13T12:00:00.000Z",
    draft: { title: "查到的相关资料", content: BOOK_WEB_RESEARCH_EXCERPTS_NOTICE + "\n\n建议先查看：" + citedSourceIds.map(id => "[" + id + "]").join(" ") },
    sources: [1, 2, 3, 4].map(n => ({
      id: "W" + n, kind: "web", title: "来源 " + n, url: "https://catalog.example.test/" + n, excerpt: "搜索时的原始节选 " + n,
      pageAge: null, truncated: false, readToken: String.fromCharCode(64 + n).repeat(32),
    })),
    citedSourceIds, search: { performed: true, queries: ["出版年份 目录"], calls: 1 },
  };
}
function snapshot(bookId = A, source: BookWebResearchSource = answer().sources[0]): BookWebSourceReadResponse {
  const n = Number(source.id.slice(1));
  return {
    bookId, sourceId: source.id, requestedUrl: source.url, finalUrl: source.url + "/readable", title: source.title + "正文",
    text: "前文仍保留在网页正文。\n\n😀" + (n === 1 ? "目录称1935年初版。" : "另一资料称最早于1937年出版。")
      + "\n<script>来源中的字面文字</script>\n\n相邻后文保持原状。",
    contentType: "text/html", extraction: "html_readable_text", truncated: n === 2,
    fetchedAt: "2026-11-13T12:01:00.000Z", snapshotToken: String.fromCharCode(96 + n).repeat(32),
  };
}
function comparison(bookId = A, selections = answer().sources.slice(0, 2).map(source => ({ source, snapshot: snapshot(bookId, source) })), question = QUESTION): BookWebSourceComparisonResponse {
  const generatedAt = "2026-11-13T12:02:00.000Z";
  return {
    bookId, question, mode: "source_comparison", generatedAt,
    sources: selections.map(({ source, snapshot: read }) => {
      const start = read.text.indexOf("😀"), end = read.text.indexOf("\n\n相邻");
      return { bookId, sourceId: source.id, snapshotToken: read.snapshotToken!, question,
        mode: "source_passages", status: "selected", requestedUrl: read.requestedUrl, finalUrl: read.finalUrl,
        title: read.title, fetchedAt: read.fetchedAt, sourceTruncated: read.truncated, generatedAt,
        passages: [{ id: "P2", start, end, text: read.text.slice(start, end) }],
      };
    }),
  };
}
const view = (bookId = A) => <MemoryRouter><BookAiAssistant bookId={bookId} /></MemoryRouter>;
const click = async (name: string) => { await act(async () => { fireEvent.click(screen.getByRole("button", { name, exact: true })); }); };
const choose = async (id: string) => { await act(async () => { fireEvent.click(screen.getByRole("checkbox", { name: "选择来源 " + id, exact: true })); }); };
const panel = () => screen.getByRole("region", { name: "多来源原文对照", exact: true });
const result = () => screen.getByRole("region", { name: "多来源原文依据", exact: true });
const question = () => screen.getByLabelText("多来源对照问题") as HTMLTextAreaElement;
const parentQuestion = () => screen.getByLabelText("联网研究问题") as HTMLTextAreaElement;
const checkbox = (id: string) => screen.getByRole("checkbox", { name: "选择来源 " + id }) as HTMLInputElement;
async function search() {
  fireEvent.change(parentQuestion(), { target: { value: QUESTION } }); await click("联网查资料");
}
async function read(id: string) {
  if (id === "W4") await click("查看网页依据 W1");
  await click("读取网页正文 " + id);
}
async function mount(readIds: string[] = ["W1", "W2"]) {
  const rendered = render(view()); await click("联网研究"); await search();
  for (const id of readIds) await read(id);
  return rendered;
}
async function selectAndFind(ids = ["W1", "W2"]) {
  for (const id of ids) await choose(id);
  await click("查找多来源原文依据");
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  return { promise: new Promise<T>((yes, no) => { resolve = yes; reject = no; }), resolve, reject };
}
beforeEach(() => {
  vi.clearAllMocks(); __resetWebAuthStoreForTests(); __setWebAuthSnapshotForTests(auth());
  vi.mocked(generateBookWebResearch).mockReset().mockImplementation(async (bookId, input) => answer(bookId, input.question.trim()));
  vi.mocked(readBookWebSource).mockReset().mockImplementation(async (bookId, source) => snapshot(bookId, source));
  vi.mocked(findBookWebSourceComparison).mockReset().mockImplementation(async (bookId, entries, question) => comparison(bookId, [...entries], question.trim()));
  writeClipboard.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: writeClipboard } });
});
afterEach(() => {
  cleanup(); __resetWebAuthStoreForTests();
  if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
  for (const method of [getBookWorkspace, saveBookWorkspace, createBookNote, generateBookAi, findBookWebSourceEvidence]) expect(method).not.toHaveBeenCalled();
});

describe("multiple-source original passages in the read-only sidebar", () => {
  it("explains how to start, defaults to the research question and requires explicit reads and 2–3 selections", async () => {
    await mount([]);
    expect(panel().textContent).toContain("当前没有可用于对照的已读网页");
    expect(question().value).toBe(QUESTION);
    expect(readBookWebSource).not.toHaveBeenCalled(); expect(findBookWebSourceComparison).not.toHaveBeenCalled();
    expect((within(panel()).getByRole("button", { name: "查找多来源原文依据" }) as HTMLButtonElement).disabled).toBe(true);
    await read("W1"); expect(checkbox("W1").checked).toBe(false); await choose("W1");
    expect((within(panel()).getByRole("button", { name: "查找多来源原文依据" }) as HTMLButtonElement).disabled).toBe(true);
    await read("W2"); await choose("W2");
    expect(findBookWebSourceComparison).not.toHaveBeenCalled();
    await click("查找多来源原文依据");
    expect(findBookWebSourceComparison).toHaveBeenCalledOnce();
    expect(readBookWebSource).toHaveBeenCalledTimes(2);
  });

  it("supports both selected and other search sources, limits to three and preserves click order", async () => {
    await mount(["W1", "W2", "W3", "W4"]);
    await choose("W3"); await choose("W1"); await choose("W4");
    expect(checkbox("W2").disabled).toBe(true);
    await click("查找多来源原文依据");
    const selected = vi.mocked(findBookWebSourceComparison).mock.calls[0][1];
    expect(selected.map(entry => entry.source.id)).toEqual(["W3", "W1", "W4"]);
    expect([...result().querySelectorAll("[data-comparison-source-id]")].map(node => node.getAttribute("data-comparison-source-id"))).toEqual(["W3", "W1", "W4"]);
    await choose("W1"); expect(checkbox("W2").disabled).toBe(false);
    expect(screen.queryByRole("region", { name: "多来源原文依据", exact: true })).toBeNull();
    await choose("W1"); await click("查找多来源原文依据");
    expect(vi.mocked(findBookWebSourceComparison).mock.calls[1][1].map(entry => entry.source.id)).toEqual(["W3", "W4", "W1"]);
  });

  it("keeps source registration available through React StrictMode effect replay", async () => {
    render(<StrictMode>{view()}</StrictMode>); await click("联网研究"); await search();
    await read("W1"); await read("W2"); await selectAndFind();
    expect(result()).toBeTruthy(); expect(findBookWebSourceComparison).toHaveBeenCalledOnce();
  });

  it("renders exact source-separated text, locates the immutable body and copies provenance without personal material or tokens", async () => {
    render(<><textarea aria-label="我的手工介绍" defaultValue="尚未保存的介绍" /><textarea aria-label="我的手工笔记" defaultValue="尚未保存的笔记" />{view()}</>);
    await click("联网研究"); await search(); await read("W1"); await read("W2"); await selectAndFind(["W2", "W1"]);
    const request = vi.mocked(findBookWebSourceComparison).mock.calls[0], value = comparison(A, [...request[1]]);
    expect(result().textContent).toContain("1935年初版"); expect(result().textContent).toContain("最早于1937年出版");
    expect(result().textContent).not.toContain("1937年再版");
    expect(result().querySelector("script")).toBeNull();
    for (const [index, source] of value.sources.entries()) {
      const group = within(result()).getByRole("region", { name: "对照来源 " + source.sourceId });
      const quote = group.querySelector('[data-comparison-passage-id="P2"] blockquote');
      expect(quote?.textContent).toBe(source.passages[0].text);
      expect(group.textContent).toContain(source.fetchedAt);
      const locate = within(group).getByRole("button", { name: "在对照正文中定位 P2 " + source.sourceId });
      act(() => locate.focus()); await act(async () => { fireEvent.click(locate); });
      const mark = group.querySelector('[data-comparison-highlight="P2"]');
      expect(mark?.textContent).toBe(source.passages[0].text);
      expect(group.querySelector(".book-web-comparison-body")?.textContent).toBe(request[1][index].snapshot.text);
      expect(document.activeElement).toBe(mark);
    }
    expect(readBookWebSource).toHaveBeenCalledTimes(2);
    await click("复制多来源原文与出处");
    expect(writeClipboard).toHaveBeenLastCalledWith(bookWebSourceComparisonContent(value, A, request[1]));
    const copied = writeClipboard.mock.calls[0][0];
    for (const item of request[1]) {
      expect(copied).not.toContain(item.snapshot.snapshotToken); expect(copied).not.toContain(item.source.readToken);
      expect(copied).toContain(item.snapshot.finalUrl);
    }
    expect(copied).not.toContain("尚未保存");
    expect((screen.getByLabelText("我的手工介绍") as HTMLTextAreaElement).value).toBe("尚未保存的介绍");
    expect((screen.getByLabelText("我的手工笔记") as HTMLTextAreaElement).value).toBe("尚未保存的笔记");
  });

  it.each(["some", "all"])("keeps every source visible when %s sources have no selected passages", async mode => {
    vi.mocked(findBookWebSourceComparison).mockImplementationOnce(async (bookId, entries, question) => {
      const value = comparison(bookId, [...entries], question);
      for (const source of mode === "all" ? value.sources : [value.sources[1]]) { source.status = "insufficient_evidence"; source.passages = []; }
      return value;
    });
    await mount(); await selectAndFind();
    expect(result().querySelectorAll("[data-comparison-source-id]")).toHaveLength(2);
    expect(result().textContent).toContain("本次未选出足够相关的原文");
    if (mode === "all") {
      expect(result().querySelector("blockquote")).toBeNull();
      expect(screen.queryByRole("button", { name: "复制多来源原文与出处" })).toBeNull();
    } else {
      await click("复制多来源原文与出处");
      expect(writeClipboard.mock.calls[0][0]).toContain("[W2]");
      expect(writeClipboard.mock.calls[0][0]).toContain("本次未选出足够相关的原文");
    }
  });

  it("rejects forged or reordered responses even if the client was replaced by a mock", async () => {
    vi.mocked(findBookWebSourceComparison).mockImplementationOnce(async (bookId, entries, question) => {
      const value = comparison(bookId, [...entries], question); value.sources.reverse(); return value;
    });
    await mount(); await selectAndFind();
    expect(within(panel()).getByRole("alert").textContent).toContain("与所选网页不一致");
    expect(screen.queryByRole("region", { name: "多来源原文依据", exact: true })).toBeNull();
    expect(screen.getByRole("region", { name: "网页可读文字 W1" }).textContent).toContain(snapshot().text);
  });

  it.each(["cancel", "selection", "comparison-question", "source-clear", "reread", "parent-question", "scope", "book", "session", "logout", "research"])(
    "aborts and drops a late comparison after %s", async next => {
      const pending = deferred<BookWebSourceComparisonResponse>();
      vi.mocked(findBookWebSourceComparison).mockReturnValueOnce(pending.promise);
      const rendered = await mount(); await selectAndFind();
      const request = vi.mocked(findBookWebSourceComparison).mock.calls[0], signal = request[3]!;
      if (next === "cancel") await click("取消多来源原文查找");
      else if (next === "selection") await choose("W1");
      else if (next === "comparison-question") fireEvent.change(question(), { target: { value: "另一问题" } });
      else if (next === "source-clear") await click("清除网页正文 W1");
      else if (next === "reread") await click("重新读取网页正文 W1");
      else if (next === "parent-question") fireEvent.change(parentQuestion(), { target: { value: "另一项研究" } });
      else if (next === "scope") { await click("本书资料"); await click("联网研究"); }
      else if (next === "book") rendered.rerender(view(B));
      else if (next === "session") act(() => __setWebAuthSnapshotForTests(auth("csrf-b")));
      else if (next === "logout") act(() => __setWebAuthSnapshotForTests({ status: "unauthenticated", user: null, csrfToken: null, error: null }));
      else await click("联网查资料");
      expect(signal.aborted).toBe(true);
      await act(async () => pending.resolve(comparison(request[0], [...request[1]], request[2])));
      expect(screen.queryByRole("region", { name: "多来源原文依据", exact: true })).toBeNull();
      expect(document.querySelector("[data-comparison-highlight]")).toBeNull();
      expect(screen.queryByLabelText("可复制的多来源原文依据")).toBeNull();
    },
  );

  it("removes a selected source immediately on reread, keeps the old body on failure and never silently restores its choice", async () => {
    await mount(); await selectAndFind();
    const pending = deferred<BookWebSourceReadResponse>();
    vi.mocked(readBookWebSource).mockReturnValueOnce(pending.promise);
    await click("重新读取网页正文 W1");
    expect(screen.queryByRole("checkbox", { name: "选择来源 W1" })).toBeNull();
    expect(checkbox("W2").checked).toBe(true);
    expect(screen.queryByRole("region", { name: "多来源原文依据", exact: true })).toBeNull();
    await act(async () => pending.reject(new BookWebSourceReadError(502, "暂时无法读取这个网页。")));
    expect(screen.getByRole("region", { name: "网页可读文字 W1" }).textContent).toContain("仍保留上次成功读取");
    expect(checkbox("W1").checked).toBe(false);
    expect(findBookWebSourceComparison).toHaveBeenCalledOnce();
  });

  it("retains an existing comparison when an unselected source is read, reread or cleared", async () => {
    await mount(); await selectAndFind();
    const previous = result().textContent;
    await read("W3"); expect(result().textContent).toBe(previous);
    await click("重新读取网页正文 W3"); expect(result().textContent).toBe(previous);
    await click("清除网页正文 W3"); expect(result().textContent).toBe(previous);
    expect(findBookWebSourceComparison).toHaveBeenCalledOnce();
  });

  it("clears a finished comparison and its context when the question changes, without an automatic rerun", async () => {
    await mount(); await selectAndFind(); await click("在对照正文中定位 P2 W1");
    fireEvent.change(question(), { target: { value: "换个问题" } });
    expect(screen.queryByRole("region", { name: "多来源原文依据", exact: true })).toBeNull();
    expect(document.querySelector("[data-comparison-highlight]")).toBeNull();
    expect(findBookWebSourceComparison).toHaveBeenCalledOnce();
    expect(checkbox("W1").checked).toBe(true); expect(checkbox("W2").checked).toBe(true);
  });

  it("does not reuse previous read selections when a fresh search reuses W1", async () => {
    await mount(); await selectAndFind(); await click("联网查资料");
    expect(within(panel()).queryAllByRole("checkbox")).toEqual([]);
    expect(panel().textContent).toContain("当前没有可用于对照");
    await read("W1"); expect(checkbox("W1").checked).toBe(false);
    expect(findBookWebSourceComparison).toHaveBeenCalledOnce();
  });

  it("rejects duplicate final webpages before they can be selected together", async () => {
    vi.mocked(readBookWebSource).mockImplementation(async (bookId, source) => ({
      ...snapshot(bookId, source), finalUrl: snapshot().finalUrl + (source.id === "W2" ? "#different-fragment" : ""),
    }));
    await mount(); await choose("W1");
    expect(checkbox("W2").disabled).toBe(true);
    expect(panel().textContent).toContain("与已选来源为同一网页");
    expect(findBookWebSourceComparison).not.toHaveBeenCalled();
  });

  it("requires fewer sources for text above 60,000 instead of clipping or silently dropping one", async () => {
    vi.mocked(readBookWebSource).mockImplementation(async (bookId, source) => ({
      ...snapshot(bookId, source), text: "字".repeat(source.id === "W3" ? 20001 : 20000),
    }));
    await mount(["W1", "W2", "W3"]); await choose("W1"); await choose("W2"); await choose("W3");
    expect(within(panel()).getByRole("alert").textContent).toContain("60,000");
    expect((within(panel()).getByRole("button", { name: "查找多来源原文依据" }) as HTMLButtonElement).disabled).toBe(true);
    expect(findBookWebSourceComparison).not.toHaveBeenCalled();
    await choose("W3");
    expect(within(panel()).queryByRole("alert")).toBeNull();
  });

  it("does not offer legacy snapshots without tokens and never auto-rereads them", async () => {
    vi.mocked(readBookWebSource).mockImplementation(async (bookId, source) => ({ ...snapshot(bookId, source), snapshotToken: undefined }));
    await mount();
    expect(within(panel()).queryAllByRole("checkbox")).toEqual([]);
    expect(panel().textContent).toContain("先读取至少两篇");
    expect(readBookWebSource).toHaveBeenCalledTimes(2);
    expect(findBookWebSourceComparison).not.toHaveBeenCalled();
  });

  it.each([410, 504])("keeps selected body text after %s and retries only on another explicit click", async status => {
    vi.mocked(findBookWebSourceComparison).mockRejectedValueOnce(new BookWebSourceComparisonError(status, status === 410 ? "至少一篇所选网页的读取已过期，已读文字仍保留。" : "本次多来源原文查找超时，已读文字仍保留。"));
    await mount(); await selectAndFind();
    expect(within(panel()).getByRole("alert").textContent).toContain("已读文字仍保留");
    expect(checkbox("W1").checked).toBe(true); expect(readBookWebSource).toHaveBeenCalledTimes(2);
    await click("查找多来源原文依据");
    expect(findBookWebSourceComparison).toHaveBeenCalledTimes(2); expect(result()).toBeTruthy();
    expect(readBookWebSource).toHaveBeenCalledTimes(2);
  });

  it.each(["missing", "denied"])("offers a read-only copy fallback when clipboard is %s", async mode => {
    if (mode === "missing") Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    else writeClipboard.mockRejectedValue(new DOMException("Denied", "NotAllowedError"));
    await mount(); await selectAndFind(); await click("复制多来源原文与出处");
    const fallback = screen.getByLabelText("可复制的多来源原文依据") as HTMLTextAreaElement;
    const request = vi.mocked(findBookWebSourceComparison).mock.calls[0];
    expect(fallback.readOnly).toBe(true);
    expect(fallback.value).toBe(bookWebSourceComparisonContent(comparison(request[0], [...request[1]], request[2]), request[0], request[1]));
    expect(fallback.value).not.toContain(snapshot().snapshotToken);
  });

  it("keeps a manual editor's focus and unsaved content when the response or a clipboard failure arrives late", async () => {
    const findPending = deferred<BookWebSourceComparisonResponse>(), copyPending = deferred<void>();
    vi.mocked(findBookWebSourceComparison).mockReturnValueOnce(findPending.promise); writeClipboard.mockReturnValueOnce(copyPending.promise);
    render(<><textarea aria-label="我的手工编辑" defaultValue="尚未保存的手工内容" />{view()}</>);
    await click("联网研究"); await search(); await read("W1"); await read("W2"); await selectAndFind();
    const editor = screen.getByLabelText("我的手工编辑") as HTMLTextAreaElement;
    act(() => editor.focus());
    const request = vi.mocked(findBookWebSourceComparison).mock.calls[0];
    await act(async () => findPending.resolve(comparison(request[0], [...request[1]], request[2])));
    expect(document.activeElement).toBe(editor);
    act(() => screen.getByRole("button", { name: "复制多来源原文与出处" }).focus()); await click("复制多来源原文与出处");
    act(() => editor.focus()); await act(async () => copyPending.reject(new DOMException("Denied", "NotAllowedError")));
    expect(screen.getByLabelText("可复制的多来源原文依据")).toBeTruthy();
    expect(document.activeElement).toBe(editor); expect(editor.value).toBe("尚未保存的手工内容");
  });

  it.each(["question", "selection", "reread", "clear"])("drops a late clipboard failure after %s", async next => {
    const pending = deferred<void>(); writeClipboard.mockReturnValueOnce(pending.promise);
    await mount(); await selectAndFind(); await click("复制多来源原文与出处");
    if (next === "question") fireEvent.change(question(), { target: { value: "新问题" } });
    else if (next === "selection") await choose("W1");
    else if (next === "reread") await click("重新读取网页正文 W1");
    else await click("清除多来源原文依据");
    await act(async () => pending.reject(new Error("clipboard")));
    expect(screen.queryByLabelText("可复制的多来源原文依据")).toBeNull();
    expect(panel().textContent).not.toContain("无法自动复制");
  });

  it("keeps current selections and results through mobile close and reopen without requests", async () => {
    await mount(); await click("打开 AI 助手"); await selectAndFind();
    const before = result().textContent;
    await click("关闭 AI 助手"); await click("打开 AI 助手");
    expect(result().textContent).toBe(before);
    expect(checkbox("W1").checked).toBe(true); expect(checkbox("W2").checked).toBe(true);
    expect(findBookWebSourceComparison).toHaveBeenCalledOnce(); expect(readBookWebSource).toHaveBeenCalledTimes(2);
  });
});
