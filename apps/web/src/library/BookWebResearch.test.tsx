// @vitest-environment jsdom
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { BookAiAssistant } from "./BookAiAssistant";
import { __resetWebAuthStoreForTests, __setWebAuthSnapshotForTests } from "../auth/session";
import { createBookNote, getBookWorkspace, saveBookWorkspace } from "./api";
import { generateBookAi, type BookAiResponse } from "./bookAi";
import { bookWebResearchContent, bookWebSourceTextContexts, generateBookWebResearch, type BookWebResearchResponse, type BookWebResearchTextContext } from "./bookWebResearch";

vi.mock("../auth/session", async original => ({ ...await original<typeof import("../auth/session")>(), ensureAuthSessionLoaded: vi.fn(async () => {}) }));
vi.mock("./api", async original => ({ ...await original<typeof import("./api")>(), getBookWorkspace: vi.fn(), saveBookWorkspace: vi.fn(), createBookNote: vi.fn() }));
vi.mock("./bookAi", async original => ({ ...await original<typeof import("./bookAi")>(), generateBookAi: vi.fn() }));
vi.mock("./bookWebResearch", async original => ({ ...await original<typeof import("./bookWebResearch")>(), generateBookWebResearch: vi.fn() }));

const A = "10000001_100000000001", B = "10000002_100000000002", QUESTION = "这本书有哪些相关研究？";
const NOTICE = "已根据本次问题选出相关网页，以下保留搜索工具返回的来源节选。节选不等于网页或原书全文；来源之间可能有不同说法。";
const LIMITED = "本次搜索已达到上限，已保留返回的资料。可以调整问题后再查。";
const CLUES_NOTICE = "这里只展示当前标题和搜索节选中的文字线索，不确认同书、版本或资料类型，也不代表已读全文或内容可信。";
const SELECTED_ISBN_NOTICE = "所选资料尚缺可对应本书的 ISBN 线索；与本书的直接关联仍需核对。";
const UNSELECTED = "已完成网页搜索，但本次自动挑选未完成。下方保留搜索返回的资料，可以打开原链接核对或读取网页正文。";
const INSUFFICIENT = "本次已执行联网搜索，但没有选出与问题充分相关的资料。下方如有搜索结果，可以打开原链接核对，或调整问题后再查。";
const draftFor = (ids = ["W1"]) => ({ title: "查到的相关资料", content: `${NOTICE}\n\n建议先查看：${ids.map(id => `[${id}]`).join(" ")}` });
const auth = (csrf = "csrf-a") => ({ status: "authenticated" as const, user: { email: "owner@example.test", name: "Owner" }, csrfToken: csrf, error: null });
const writeClipboard = vi.fn<(text: string) => Promise<void>>();
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");

function answer(changes: Partial<BookWebResearchResponse> = {}): BookWebResearchResponse {
  return {
    bookId: A, question: QUESTION, mode: "source_excerpts", source: "web_research", generatedAt: "2026-10-11T12:00:00.000Z",
    draft: draftFor(),
    sources: [
      { id: "W1", kind: "web", title: "旅行史目录", url: "https://catalog.example.test/books/1", excerpt: "旅行史资料目录。\n与地方文献对照。", pageAge: "2025-01-01", truncated: false },
      { id: "W2", kind: "web", title: "其他研究线索", url: "https://journal.example.test/research/2", excerpt: "其他文章片段", pageAge: null, truncated: true },
    ],
    citedSourceIds: ["W1"], search: { performed: true, queries: ["旅行史 地方文献 相关研究"], calls: 1 }, ...changes,
  };
}
function unselectedAnswer(limited = true): BookWebResearchResponse {
  const value = answer({ source: "unselected_sources", citedSourceIds: [],
    draft: { title: "待核对的网页资料", content: UNSELECTED } });
  value.search.limited = limited;
  value.sources.forEach((source, index) => { source.readToken = (index ? "B" : "A").repeat(32); });
  return value;
}
function contextualAnswer(): BookWebResearchResponse {
  const value = answer(), [source, second] = value.sources;
  source.title = "《同名作品》 第2版";
  source.excerpt = "原文同时提到《另一个书名》与修訂版。\n<script>保留这些字样 😀</script>";
  source.bookClues = { isbn: "mixed", text: ["title"] };
  const item = (field: "title" | "excerpt", literal: string, kind: BookWebResearchTextContext["kind"]) => {
    const original = source[field], matchStart = original.indexOf(literal);
    return { kind, field, value: literal, matchStart, matchEnd: matchStart + literal.length,
      start: 0, end: original.length, text: original };
  };
  source.textContexts = { items: [
    item("title", "《同名作品》", "quoted_title"), item("title", "第2版", "edition_text"),
    item("excerpt", "《另一个书名》", "quoted_title"), item("excerpt", "修訂版", "edition_text"),
  ], limited: true };
  second.textContexts = { items: [], limited: false };
  value.sources.forEach((row, index) => { row.readToken = (index ? "B" : "A").repeat(32); });
  return value;
}
const view = (bookId = A) => <MemoryRouter><BookAiAssistant bookId={bookId} /></MemoryRouter>;
const click = async (name: string) => { await act(async () => { fireEvent.click(screen.getByRole("button", { name })); }); };
const field = (label: string) => screen.getByLabelText(label) as HTMLTextAreaElement;
const change = (value: string) => fireEvent.change(field("联网研究问题"), { target: { value } });
const result = () => screen.getByRole("region", { name: "联网研究结果" });
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  return { promise: new Promise<T>((yes, no) => { resolve = yes; reject = no; }), resolve, reject };
}
const mount = async () => {
  const rendered = render(view()); await screen.findByRole("button", { name: "联网研究" });
  await click("联网研究"); return rendered;
};
const search = async () => { change(QUESTION); await click("联网查资料"); };
async function useHttpResearch(first: Response | Promise<Response>) {
  const actual = await vi.importActual<typeof import("./bookWebResearch")>("./bookWebResearch");
  const transport = vi.fn<typeof fetch>()
    .mockReturnValueOnce(Promise.resolve(first))
    .mockImplementation(async () => new Response(JSON.stringify(answer()), { headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", transport);
  vi.mocked(generateBookWebResearch).mockImplementation(actual.generateBookWebResearch);
  return transport;
}
const privateEditors = () => <>
  <textarea aria-label="个人介绍草稿" defaultValue="尚未保存的个人介绍" />
  <textarea aria-label="个人笔记草稿" defaultValue="尚未保存的个人笔记" />
</>;

beforeEach(() => {
  vi.clearAllMocks(); __resetWebAuthStoreForTests(); __setWebAuthSnapshotForTests(auth());
  vi.mocked(generateBookWebResearch).mockReset().mockImplementation(async (bookId, input) => answer({ bookId, question: input.question.trim(),
    ...(input.scope ? { scope: input.scope } : {}) }));
  vi.mocked(generateBookAi).mockReset();
  writeClipboard.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: writeClipboard } });
});
afterEach(() => {
  cleanup(); vi.unstubAllGlobals(); __resetWebAuthStoreForTests();
  if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
  expect(saveBookWorkspace).not.toHaveBeenCalled();
  expect(createBookNote).not.toHaveBeenCalled();
  expect(getBookWorkspace).not.toHaveBeenCalled();
});

describe("book web research sidebar", () => {
  it("requires login and does not search just by opening a scope or choosing an example", async () => {
    __setWebAuthSnapshotForTests({ status: "unauthenticated", user: null, csrfToken: null, error: null });
    const rendered = render(<StrictMode>{view()}</StrictMode>);
    expect(screen.queryByRole("complementary")).toBeNull();
    act(() => __setWebAuthSnapshotForTests(auth()));
    expect(screen.getByRole("button", { name: "本书资料" }).getAttribute("aria-pressed")).toBe("true");
    await click("联网研究");
    expect(screen.getByRole("button", { name: "联网研究" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByRole("button", { name: "生成参考介绍" })).toBeNull();
    expect(screen.getByLabelText("联网研究资料范围").textContent).toContain("公开的书目信息");
    expect(screen.getByLabelText("联网研究资料范围").textContent).toContain("搜索节选不等于网页全文");
    await click("相关研究");
    expect(field("联网研究问题").value).toContain("研究文章和书评");
    expect(field("联网研究问题").maxLength).toBe(1000);
    expect(generateBookWebResearch).not.toHaveBeenCalled();
    expect(generateBookAi).not.toHaveBeenCalled();
    rendered.unmount();
  });

  it("shows the selected original excerpt with actual queries and inspectable real URLs", async () => {
    await mount(); await search();
    expect(generateBookWebResearch).toHaveBeenCalledWith(A, { question: QUESTION }, expect.any(AbortSignal));
    const chosen = result().querySelector('[data-web-excerpt-source-id="W1"]')!;
    expect(chosen.querySelector("blockquote")?.textContent).toBe(answer().sources[0].excerpt);
    expect(chosen.getAttribute("data-book-clues")).toBe("legacy");
    expect(within(chosen as HTMLElement).getByLabelText("本书书目线索 W1").textContent).toBe("书目线索未核对");
    expect(screen.getByLabelText("书目线索核对范围").textContent).toBe(CLUES_NOTICE);
    expect(screen.queryByText(SELECTED_ISBN_NOTICE)).toBeNull();
    expect(result().textContent).toContain(NOTICE);
    expect(result().querySelector(".book-prose")).toBeNull();
    expect(within(result()).getByRole("link", { name: "打开所选网页 [W1] 旅行史目录", exact: true }).getAttribute("href")).toBe(answer().sources[0].url);
    expect(result().querySelector('[data-web-excerpt-source-id="W2"]')).toBeNull();
    expect(within(result()).queryByRole("textbox")).toBeNull();
    expect(screen.getByLabelText("本次实际搜索词").textContent).toBe("旅行史 地方文献 相关研究");
    expect(screen.getByRole("heading", { name: "查到的相关资料" })).toBeTruthy();
    await click("查看网页依据 W1");
    const source = document.querySelector('[data-web-source-id="W1"]') as HTMLElement;
    const link = within(source).getByRole("link", { name: "[W1] 旅行史目录" });
    expect(link.getAttribute("href")).toBe("https://catalog.example.test/books/1");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(source.textContent).toContain("页面时间：2025-01-01");
    expect(source.textContent).toContain("搜索结果节选");
    expect(source.textContent).toContain("旅行史资料目录。\n与地方文献对照。");
    expect(source.closest("details")?.open).toBe(true);
    expect(document.activeElement).toBe(source);
    expect(screen.queryByRole("button", { name: /保存为书籍介绍|保存为新笔记/ })).toBeNull();
    expect(generateBookAi).not.toHaveBeenCalled();
  });

  it("retains the result through the mobile close control without searching again", async () => {
    await mount(); await click("打开 AI 助手"); await search(); await click("关闭 AI 助手");
    expect(screen.getByRole("button", { name: "打开 AI 助手" }).getAttribute("aria-expanded")).toBe("false");
    await click("打开 AI 助手"); expect(result().textContent).toContain("旅行史资料目录");
    expect(generateBookWebResearch).toHaveBeenCalledOnce();
  });

  it("copies the answer and cited webpage snapshots without changing the manual editor", async () => {
    render(<><textarea aria-label="我的手工编辑" defaultValue="我的原文保持不变" />{view()}</>);
    await click("联网研究"); await search(); await click("复制结果与来源");
    expect(writeClipboard).toHaveBeenCalledWith(bookWebResearchContent(answer()));
    expect(field("我的手工编辑").value).toBe("我的原文保持不变");
    expect(writeClipboard.mock.calls[0][0]).toContain(CLUES_NOTICE);
    expect(writeClipboard.mock.calls[0][0]).toContain("书目线索未核对");
    expect(screen.getByText("已复制所选节选与网页来源。")).toBeTruthy();
    expect(generateBookWebResearch).toHaveBeenCalledOnce();
  });

  it("keeps focus in a manual editor when a pending research finishes", async () => {
    const pending = deferred<BookWebResearchResponse>(); vi.mocked(generateBookWebResearch).mockReturnValueOnce(pending.promise);
    render(<><textarea aria-label="我的手工编辑" defaultValue="正在补充" />{view()}</>);
    await click("联网研究"); change(QUESTION);
    act(() => screen.getByRole("button", { name: "联网查资料" }).focus()); await click("联网查资料");
    act(() => field("我的手工编辑").focus());
    await act(async () => pending.resolve(answer()));
    expect(result()).toBeTruthy(); expect(document.activeElement).toBe(field("我的手工编辑"));
    expect(field("我的手工编辑").value).toBe("正在补充");
  });

  it.each(["missing", "denied"])("offers read-only manual copying when clipboard is %s", async state => {
    if (state === "missing") Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    else writeClipboard.mockRejectedValue(new DOMException("Denied", "NotAllowedError"));
    await mount(); await search(); await click("复制结果与来源");
    const fallback = field("可复制的研究结果");
    expect(fallback.readOnly).toBe(true);
    expect(fallback.value).toBe(bookWebResearchContent(answer()));
    expect(fallback.value).toContain("https://catalog.example.test/books/1");
    expect(result()).toBeTruthy();
  });

  it("does not steal editor focus when clipboard permission is denied late", async () => {
    const pending = deferred<void>(); writeClipboard.mockReturnValueOnce(pending.promise);
    render(<><textarea aria-label="我的手工编辑" defaultValue="正在写笔记" />{view()}</>);
    await click("联网研究"); await search();
    act(() => screen.getByRole("button", { name: "复制结果与来源" }).focus()); await click("复制结果与来源");
    act(() => field("我的手工编辑").focus());
    await act(async () => pending.reject(new DOMException("Denied", "NotAllowedError")));
    expect(field("可复制的研究结果").readOnly).toBe(true);
    expect(document.activeElement).toBe(field("我的手工编辑"));
  });

  it.each(["clear", "question", "scope"])("isolates pending clipboard state after %s", async next => {
    const pending = deferred<void>(); writeClipboard.mockReturnValueOnce(pending.promise);
    await mount(); await search(); await click("复制结果与来源");
    if (next === "clear") await click("清除结果");
    else if (next === "question") change("改了问题");
    else { await click("本书资料"); await click("联网研究"); }
    await act(async () => pending.reject(new DOMException("Denied", "NotAllowedError")));
    expect(screen.queryByLabelText("可复制的研究结果")).toBeNull();
    expect(screen.queryByRole("region", { name: "联网研究结果" })).toBeNull();
  });

  it("clears the answer, sources, search terms and fallback on question change", async () => {
    writeClipboard.mockRejectedValue(new DOMException("Denied", "NotAllowedError"));
    await mount(); await search(); await click("查看网页依据 W1"); await click("复制结果与来源");
    change("新的研究问题");
    expect(screen.queryByRole("region", { name: "联网研究结果" })).toBeNull();
    expect(screen.queryByLabelText("本次实际搜索词")).toBeNull();
    expect(screen.queryByLabelText("可复制的研究结果")).toBeNull();
    expect(document.querySelector("[data-web-source-id]")).toBeNull();
  });

  it.each(["cancel", "question", "scope"])("aborts and discards a late result after %s", async next => {
    const pending = deferred<BookWebResearchResponse>(); vi.mocked(generateBookWebResearch).mockReturnValueOnce(pending.promise);
    await mount(); await search(); const signal = vi.mocked(generateBookWebResearch).mock.calls[0][2]!;
    if (next === "cancel") await click("取消研究");
    else if (next === "question") change("新的研究问题");
    else { await click("本书资料"); await click("联网研究"); }
    expect(signal.aborted).toBe(true);
    await act(async () => pending.resolve(answer()));
    expect(screen.queryByRole("region", { name: "联网研究结果" })).toBeNull();
    expect(screen.getByRole("button", { name: "联网查资料" }).matches(":disabled")).toBe(false);
  });

  it("aborts the local material task when switching to internet research", async () => {
    const pending = deferred<BookAiResponse>(); vi.mocked(generateBookAi).mockReturnValueOnce(pending.promise);
    render(view()); await click("生成参考介绍");
    const signal = vi.mocked(generateBookAi).mock.calls[0][2]!;
    await click("联网研究"); expect(signal.aborted).toBe(true);
    await act(async () => pending.reject(new Error("late local error")));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(generateBookWebResearch).not.toHaveBeenCalled();
  });

  it("keeps a newer result if an older cancelled research returns late", async () => {
    const pending = deferred<BookWebResearchResponse>(); vi.mocked(generateBookWebResearch).mockReturnValueOnce(pending.promise);
    await mount(); await search(); await click("取消研究");
    await click("联网查资料"); expect(result().textContent).toContain("旅行史资料目录");
    const old = answer(); old.sources[0].excerpt = "迟到的搜索内容。";
    await act(async () => pending.resolve(old));
    expect(result().textContent).not.toContain("迟到的搜索内容");
  });

  it.each(["book", "session", "logout"])("removes research state and aborts pending work on %s change", async next => {
    const pending = deferred<BookWebResearchResponse>(); vi.mocked(generateBookWebResearch).mockReturnValueOnce(pending.promise);
    const rendered = await mount(); await search(); const signal = vi.mocked(generateBookWebResearch).mock.calls[0][2]!;
    if (next === "book") rendered.rerender(view(B));
    else if (next === "session") act(() => __setWebAuthSnapshotForTests(auth("csrf-b")));
    else act(() => __setWebAuthSnapshotForTests({ status: "unauthenticated", user: null, csrfToken: null, error: null }));
    expect(signal.aborted).toBe(true);
    await act(async () => pending.resolve(answer()));
    expect(screen.queryByRole("region", { name: "联网研究结果" })).toBeNull();
    expect(screen.queryByLabelText("联网研究问题")).toBeNull();
    if (next !== "logout") {
      await click("联网研究"); expect(field("联网研究问题").value).toBe("");
      expect(generateBookWebResearch).toHaveBeenCalledOnce();
    }
  });

  it("rejects blank questions locally without triggering any search", async () => {
    await mount(); change("   ");
    await act(async () => { fireEvent.submit(screen.getByRole("form", { name: "联网查资料" })); });
    expect(screen.getByRole("alert").textContent).toContain("请填写想研究的问题");
    expect(generateBookWebResearch).not.toHaveBeenCalled();
  });

  it("shows insufficient evidence and lets the user copy available original sources", async () => {
    vi.mocked(generateBookWebResearch).mockResolvedValueOnce(answer({ source: "insufficient_sources", citedSourceIds: [], draft: { title: "查到的相关资料", content: INSUFFICIENT } }));
    await mount(); await search();
    expect(screen.getByText(INSUFFICIENT)).toBeTruthy();
    expect(screen.getByLabelText("本次实际搜索词")).toBeTruthy();
    expect(document.querySelectorAll("[data-web-source-id]")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "复制结果与来源" })).toBeNull();
    await click("复制现有来源");
    const copied = writeClipboard.mock.calls[0][0];
    expect(copied).toContain("# 本次搜索资料不足");
    expect(copied).toContain(INSUFFICIENT);
    expect(copied).toContain(CLUES_NOTICE);
    for (const source of answer().sources) {
      expect(copied).toContain(source.title); expect(copied).toContain(source.url); expect(copied).toContain(source.excerpt);
    }
    expect(copied).not.toContain("建议先查看");
    expect(screen.getByText("已复制现有网页来源与资料不足说明。")).toBeTruthy();
    expect(generateBookWebResearch).toHaveBeenCalledOnce();
    await click("清除结果");
    expect(screen.queryByLabelText("本次实际搜索词")).toBeNull();
    expect(document.querySelector("[data-web-source-id]")).toBeNull();
  });

  it("does not render or copy a successful answer with an unverified citation", async () => {
    const value = answer(); value.draft.content += "[W99]";
    vi.mocked(generateBookWebResearch).mockResolvedValueOnce(value);
    await mount(); await search();
    expect(screen.getByRole("alert").textContent).toContain("返回的研究资料未通过核对");
    expect(screen.queryByRole("region", { name: "联网研究结果" })).toBeNull();
    expect(writeClipboard).not.toHaveBeenCalled();
  });

  it("keeps excerpts as literal text and labels snippets that were shortened", async () => {
    const value = answer(); value.sources[0].excerpt = "<script>literal</script>\n网页片段";
    vi.mocked(generateBookWebResearch).mockResolvedValueOnce(value);
    await mount(); await search(); await click("查看网页依据 W1");
    const source = document.querySelector('[data-web-source-id="W1"]')!;
    expect(source.textContent).toContain("<script>literal</script>");
    expect(source.querySelector("script")).toBeNull();
    expect(screen.getByText("本条搜索节选已截短，可打开网页进一步核对。")).toBeTruthy();
  });

  it("keeps the full literal excerpt in the DOM and clipboard while its preview expands or collapses", async () => {
    const value = answer();
    value.sources[0].excerpt = "**原文中的符号**\n<script>来源原文</script>\n" + "完整搜索原文：初版时间仍需核对。".repeat(60);
    vi.mocked(generateBookWebResearch).mockResolvedValueOnce(value);
    await mount(); await search();
    const chosen = result().querySelector('[data-web-excerpt-source-id="W1"]')!;
    const quote = chosen.querySelector("blockquote")!;
    expect(quote.textContent).toBe(value.sources[0].excerpt);
    expect(quote.querySelector("strong, script")).toBeNull();
    const expand = within(chosen as HTMLElement).getByRole("button", { name: "展开完整搜索节选" });
    expect(expand.getAttribute("aria-expanded")).toBe("false");
    expect(expand.getAttribute("aria-controls")).toBe(quote.id);
    await act(async () => { fireEvent.click(expand); });
    expect(quote.classList.contains("is-expanded")).toBe(true);
    expect(quote.textContent).toBe(value.sources[0].excerpt);
    await click("收起搜索节选");
    expect(quote.classList.contains("is-expanded")).toBe(false);
    expect(quote.textContent).toBe(value.sources[0].excerpt);
    await click("复制结果与来源");
    expect(writeClipboard.mock.calls[0][0]).toContain(value.sources[0].excerpt);
  });

  it("preserves the chosen source order without combining conflicting original claims", async () => {
    const value = answer({ citedSourceIds: ["W2", "W1"], draft: draftFor(["W2", "W1"]) });
    value.sources[0].excerpt = "1935 年初版。";
    value.sources[1].excerpt = "最早于 1937 年出版。";
    vi.mocked(generateBookWebResearch).mockResolvedValueOnce(value);
    await mount(); await search();
    const cards = Array.from(result().querySelectorAll("[data-web-excerpt-source-id]"));
    expect(cards.map(card => card.getAttribute("data-web-excerpt-source-id"))).toEqual(["W2", "W1"]);
    expect(cards.map(card => card.querySelector("blockquote")?.textContent)).toEqual(["最早于 1937 年出版。", "1935 年初版。"]);
    expect(result().textContent).not.toContain("1937 年再版");
    expect(document.querySelectorAll("[data-web-source-id]")).toHaveLength(2);
    await click("复制结果与来源");
    const copied = writeClipboard.mock.calls[0][0];
    expect(copied.indexOf("最早于 1937 年出版。")).toBeLessThan(copied.indexOf("1935 年初版。"));
    expect(copied).not.toContain("1937 年再版");
  });

  it.each(["missing mode", "unknown mode", "free facts", "old insufficient"])("rejects %s before showing an excerpt-mode result", async changed => {
    const value = answer();
    if (changed === "missing mode") delete (value as Partial<BookWebResearchResponse>).mode;
    else if (changed === "unknown mode") Object.assign(value, { mode: "generated_answer" });
    else if (changed === "free facts") value.draft.content = "AI 把不同年份解释为再版。[W1]";
    else {
      value.source = "insufficient_sources"; value.citedSourceIds = [];
      value.draft = { title: "查到的相关资料", content: INSUFFICIENT };
      delete (value as Partial<BookWebResearchResponse>).mode;
    }
    vi.mocked(generateBookWebResearch).mockResolvedValueOnce(value);
    await mount(); await search();
    expect(screen.getByRole("alert").textContent).toContain("返回的研究资料未通过核对");
    expect(screen.queryByRole("region", { name: "联网研究结果" })).toBeNull();
    expect(document.querySelector("[data-web-source-id]")).toBeNull();
    expect(writeClipboard).not.toHaveBeenCalled();
  });


  it.each([undefined, false, true])("shows the search limit notice only for limited=%s while retaining source cards", async limited => {
    const value = answer();
    if (limited !== undefined) value.search.limited = limited;
    vi.mocked(generateBookWebResearch).mockResolvedValueOnce(value);
    render(<>{privateEditors()}{view()}</>);
    await click("联网研究"); await search();
    if (limited === true) expect(screen.getByText(LIMITED).getAttribute("role")).toBe("status");
    else expect(screen.queryByText(LIMITED)).toBeNull();
    expect(result().querySelector('[data-web-excerpt-source-id="W1"] blockquote')?.textContent).toBe(value.sources[0].excerpt);
    expect(field("联网研究问题").value).toBe(QUESTION);
    expect(field("个人介绍草稿").value).toBe("尚未保存的个人介绍");
    expect(field("个人笔记草稿").value).toBe("尚未保存的个人笔记");
    await click("复制结果与来源");
    if (limited === true) expect(writeClipboard.mock.calls[0][0]).toContain(LIMITED);
    else expect(writeClipboard.mock.calls[0][0]).not.toContain(LIMITED);
    expect(generateBookWebResearch).toHaveBeenCalledOnce();
    change("新的问题");
    expect(screen.queryByText(LIMITED)).toBeNull();
    expect(screen.queryByRole("region", { name: "联网研究结果" })).toBeNull();
    expect(generateBookWebResearch).toHaveBeenCalledOnce();
  });

  it("shows a limited but genuinely insufficient result without a failure or invented card", async () => {
    vi.mocked(generateBookWebResearch).mockResolvedValueOnce(answer({
      source: "insufficient_sources", sources: [], citedSourceIds: [],
      draft: { title: "查到的相关资料", content: INSUFFICIENT },
      search: { performed: true, queries: ["已完成的实际查询"], calls: 1, limited: true },
    }));
    await mount(); await search();
    expect(screen.getByText(LIMITED)).toBeTruthy();
    expect(screen.getByText(INSUFFICIENT)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "复制现有来源" })).toBeNull();
    expect(screen.queryByRole("button", { name: "复制结果与来源" })).toBeNull();
    expect(screen.queryByText(SELECTED_ISBN_NOTICE)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("region", { name: "联网研究结果" })).toBeNull();
    expect(generateBookWebResearch).toHaveBeenCalledOnce();
  });

  it("rejects a malformed limit flag before rendering any cards or limit notice", async () => {
    const value = answer(); Object.assign(value.search, { limited: "true" });
    vi.mocked(generateBookWebResearch).mockResolvedValueOnce(value);
    await mount(); await search();
    expect(screen.getByRole("alert").textContent).toBe("返回的研究资料未通过核对，请重新查询。");
    expect(screen.queryByText(LIMITED)).toBeNull();
    expect(screen.queryByRole("region", { name: "联网研究结果" })).toBeNull();
    expect(generateBookWebResearch).toHaveBeenCalledOnce();
  });

  it.each([
    ["BOOK_RESEARCH_SEARCH_FAILED", "本次网页搜索未完成，请稍后重试。"],
    ["BOOK_RESEARCH_SELECTION_FAILED", "网页搜索已完成，但来源挑选未完成，请重试。"],
    ["BOOK_RESEARCH_UNKNOWN", "本次搜索或来源核对未完成，请重试。"],
  ])("preserves the question and private drafts through %s and an explicit retry", async (code, message) => {
    const transport = await useHttpResearch(new Response(JSON.stringify({
      error: { code, message: "private upstream detail must never be rendered" },
    }), { status: 502 }));
    render(<>{privateEditors()}{view()}</>);
    await click("联网研究"); await search();
    expect(screen.getByRole("alert").textContent).toBe(message);
    expect(document.body.textContent).not.toContain("private upstream detail");
    expect(field("联网研究问题").value).toBe(QUESTION);
    expect(field("个人介绍草稿").value).toBe("尚未保存的个人介绍");
    expect(field("个人笔记草稿").value).toBe("尚未保存的个人笔记");
    expect(screen.getByRole("button", { name: "联网查资料" }).matches(":disabled")).toBe(false);
    expect(transport).toHaveBeenCalledOnce();
    expect(generateBookWebResearch).toHaveBeenCalledOnce();
    await click("联网查资料");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(result()).toBeTruthy();
    expect(transport).toHaveBeenCalledTimes(2);
    expect(field("联网研究问题").value).toBe(QUESTION);
    expect(field("个人介绍草稿").value).toBe("尚未保存的个人介绍");
    expect(field("个人笔记草稿").value).toBe("尚未保存的个人笔记");
  });

  it("reports malformed HTTP 200 as a response problem, preserving the question until explicit retry", async () => {
    const transport = await useHttpResearch(new Response("<html>private response detail</html>", { status: 200 }));
    await mount(); await search();
    expect(screen.getByRole("alert").textContent).toBe("返回的研究资料未通过核对，请重新查询。");
    expect(document.body.textContent).not.toContain("private response detail");
    expect(field("联网研究问题").value).toBe(QUESTION);
    expect(transport).toHaveBeenCalledOnce();
    await click("联网查资料");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(result()).toBeTruthy();
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it.each(["cancel", "question", "session"])("discards a late typed HTTP failure after %s without changing private drafts", async next => {
    const pending = deferred<Response>();
    const transport = await useHttpResearch(pending.promise);
    render(<>{privateEditors()}{view()}</>);
    await click("联网研究"); await search();
    const signal = transport.mock.calls[0][1]?.signal as AbortSignal;
    if (next === "cancel") await click("取消研究");
    else if (next === "question") change("改后的问题");
    else act(() => __setWebAuthSnapshotForTests(auth("changed-csrf")));
    expect(signal.aborted).toBe(true);
    await act(async () => pending.resolve(new Response(JSON.stringify({
      error: { code: "BOOK_RESEARCH_SEARCH_FAILED", message: "late private payload" },
    }), { status: 502 })));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("region", { name: "联网研究结果" })).toBeNull();
    expect(field("个人介绍草稿").value).toBe("尚未保存的个人介绍");
    expect(field("个人笔记草稿").value).toBe("尚未保存的个人笔记");
    if (next === "question") expect(field("联网研究问题").value).toBe("改后的问题");
    expect(transport).toHaveBeenCalledOnce();
  });


  it("shows every unselected source directly, copies all original snippets and still permits an explicit webpage read", async () => {
    const value = unselectedAnswer();
    value.sources[0].bookClues = { isbn: "not_seen", text: ["title"] };
    value.sources[1].bookClues = { isbn: "other_only", text: ["author"] };
    vi.mocked(generateBookWebResearch).mockResolvedValueOnce(value);
    const source = value.sources[1];
    const readBody = {
      bookId: A, sourceId: source.id, requestedUrl: source.url, finalUrl: source.url,
      title: source.title, text: "第二个来源中实际读取的完整网页正文。",
      contentType: "text/plain", extraction: "plain_text", truncated: false,
      fetchedAt: "2026-11-13T08:00:00.000Z", snapshotToken: "C".repeat(32),
    };
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(readBody)));
    vi.stubGlobal("fetch", transport);
    render(<>{privateEditors()}{view()}</>);
    await click("联网研究"); await search();
    const available = screen.getByRole("region", { name: "待核对的网页资料", exact: true });
    expect(screen.getByRole("heading", { name: "待核对的网页资料", exact: true })).toBeTruthy();
    expect(screen.getByText("未自动挑选")).toBeTruthy();
    expect(screen.getByText(UNSELECTED)).toBeTruthy();
    expect(screen.getByText(LIMITED)).toBeTruthy();
    expect(screen.getByLabelText("书目线索核对范围").textContent).toBe(CLUES_NOTICE);
    expect(screen.queryByText(SELECTED_ISBN_NOTICE)).toBeNull();
    expect(screen.queryByRole("heading", { name: "本次搜索资料不足" })).toBeNull();
    expect(screen.queryByLabelText("AI 选中的网页资料")).toBeNull();
    expect(screen.queryByText("已选中")).toBeNull();
    expect(screen.queryByText(NOTICE)).toBeNull();
    const cards = Array.from(available.querySelectorAll("[data-web-source-id]"));
    expect(cards.map(card => card.getAttribute("data-web-source-id"))).toEqual(["W1", "W2"]);
    expect(document.querySelectorAll("[data-web-source-id]")).toHaveLength(2);
    for (const [index, card] of cards.entries()) {
      expect(card.closest("details")).toBeNull();
      expect(card.getAttribute("data-book-clues")).toBe(value.sources[index].bookClues!.isbn);
      expect(card.querySelector("blockquote")?.textContent).toBe(value.sources[index].excerpt);
      expect(within(card as HTMLElement).getByRole("link", { name: "[" + value.sources[index].id + "] " + value.sources[index].title }).getAttribute("href")).toBe(value.sources[index].url);
      expect(within(card as HTMLElement).getByRole("button", { name: "读取网页正文 " + value.sources[index].id }).matches(":disabled")).toBe(false);
    }
    expect(transport).not.toHaveBeenCalled();
    expect(generateBookWebResearch).toHaveBeenCalledOnce();
    await click("复制结果与来源");
    const copied = writeClipboard.mock.calls[0][0];
    expect(copied).toContain(UNSELECTED); expect(copied).toContain(LIMITED);
    expect(copied).toContain(CLUES_NOTICE);
    expect(copied).toContain("未见本书 ISBN；出现书名文字");
    expect(copied).toContain("只看到其他 ISBN；出现作者文字");
    for (const item of value.sources) {
      expect(copied).toContain(item.title); expect(copied).toContain(item.url); expect(copied).toContain(item.excerpt);
      expect(copied).not.toContain(item.readToken);
    }
    expect(copied).not.toContain("建议先查看");
    expect(screen.getByText("已复制待核对的网页资料与出处。")).toBeTruthy();
    await click("读取网页正文 W2");
    expect(screen.getByRole("region", { name: "网页可读文字 W2" }).textContent).toContain(readBody.text);
    expect(screen.getByRole("checkbox", { name: "选择来源 W2" })).toBeTruthy();
    expect(transport).toHaveBeenCalledOnce();
    expect(transport.mock.calls[0][0]).toBe("/api/ai/books/" + A + "/research/source");
    expect(JSON.parse(String(transport.mock.calls[0][1]?.body))).toEqual({ sourceToken: source.readToken });
    expect(generateBookWebResearch).toHaveBeenCalledOnce();
    expect(field("联网研究问题").value).toBe(QUESTION);
    expect(field("个人介绍草稿").value).toBe("尚未保存的个人介绍");
    expect(field("个人笔记草稿").value).toBe("尚未保存的个人笔记");
  });

  it("offers all unselected source text for manual copying without auto-retrying selection", async () => {
    const value = unselectedAnswer(false);
    vi.mocked(generateBookWebResearch).mockResolvedValueOnce(value);
    writeClipboard.mockRejectedValue(new Error("clipboard denied"));
    await mount(); await search(); await click("复制结果与来源");
    const copied = field("可复制的研究结果");
    expect(copied.readOnly).toBe(true);
    expect(copied.value).toContain(UNSELECTED);
    expect(copied.value).not.toContain(LIMITED);
    for (const source of value.sources) expect(copied.value).toContain(source.excerpt);
    expect(generateBookWebResearch).toHaveBeenCalledOnce();
  });

  it.each(["empty", "ids", "title", "content"])("rejects a malformed unselected result (%s) without exposing usable fallback cards", async bad => {
    const value = unselectedAnswer();
    if (bad === "empty") value.sources = [];
    else if (bad === "ids") value.citedSourceIds = ["W3", "W6"];
    else if (bad === "title") value.draft.title = "查到的相关资料";
    else value.draft.content = "模型自写的结论。";
    vi.mocked(generateBookWebResearch).mockResolvedValueOnce(value);
    await mount(); await search();
    expect(screen.getByRole("alert").textContent).toBe("返回的研究资料未通过核对，请重新查询。");
    expect(screen.queryByRole("region", { name: "待核对的网页资料" })).toBeNull();
    expect(screen.queryByRole("button", { name: "复制结果与来源" })).toBeNull();
    expect(document.querySelector("[data-web-source-id]")).toBeNull();
    expect(generateBookWebResearch).toHaveBeenCalledOnce();
  });

  it("clears unselected cards and a late clipboard fallback when the question changes", async () => {
    const pending = deferred<void>();
    vi.mocked(generateBookWebResearch).mockResolvedValueOnce(unselectedAnswer());
    writeClipboard.mockReturnValueOnce(pending.promise);
    await mount(); await search(); await click("复制结果与来源");
    change("另一个问题");
    await act(async () => pending.reject(new Error("late clipboard")));
    expect(screen.queryByRole("region", { name: "待核对的网页资料" })).toBeNull();
    expect(screen.queryByLabelText("可复制的研究结果")).toBeNull();
    expect(screen.queryByText(LIMITED)).toBeNull();
    expect(generateBookWebResearch).toHaveBeenCalledOnce();
  });

  it("shows a bounded error and allows an explicit fresh request", async () => {
    vi.mocked(generateBookWebResearch).mockRejectedValueOnce(new Error("private provider payload"));
    await mount(); await search();
    expect(screen.getByRole("alert").textContent).toBe("暂时无法完成研究，请重试。");
    await click("联网查资料"); expect(screen.queryByRole("alert")).toBeNull();
    expect(result()).toBeTruthy(); expect(generateBookWebResearch).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["matched", ["title", "author"], "出现本书 ISBN；出现书名文字；出现作者文字"],
    ["mixed", [], "本书与其他 ISBN 同时出现"],
    ["other_only", ["title"], "只看到其他 ISBN；出现书名文字"],
    ["not_seen", ["author"], "未见本书 ISBN；出现作者文字"],
    ["unavailable", [], "本书 ISBN 无法用于比对"],
  ] as const)("shows the same %s clues in selected and all-source cards without changing the excerpt", async (isbn, text, label) => {
    const value = answer();
    value.sources[0].bookClues = { isbn, text: [...text] };
    value.sources[0].excerpt = "这是一段原始搜索节选。\n不能由书目文字推断全文内容。";
    vi.mocked(generateBookWebResearch).mockResolvedValueOnce(value);
    await mount(); await search();
    const chosen = result().querySelector('[data-web-excerpt-source-id="W1"]') as HTMLElement;
    expect(chosen.getAttribute("data-book-clues")).toBe(isbn);
    expect(within(chosen).getByLabelText("本书书目线索 W1").textContent).toBe("书目线索：" + label);
    expect(chosen.querySelector("blockquote")?.textContent).toBe(value.sources[0].excerpt);
    expect(screen.getByLabelText("书目线索核对范围").textContent).toBe(CLUES_NOTICE);
    await click("查看网页依据 W1");
    const complete = document.querySelector('[data-web-source-id="W1"]') as HTMLElement;
    expect(complete.getAttribute("data-book-clues")).toBe(isbn);
    expect(within(complete).getByLabelText("本书书目线索 W1").textContent).toBe("书目线索：" + label);
    expect(complete.querySelector("blockquote")?.textContent).toBe(value.sources[0].excerpt);
    expect(document.activeElement).toBe(complete);
    expect(document.querySelector('[data-web-source-id="W2"]')?.getAttribute("data-book-clues")).toBe("legacy");
    await click("复制结果与来源");
    expect(writeClipboard.mock.calls[0][0]).toContain("书目线索：" + label);
    expect(writeClipboard.mock.calls[0][0]).toContain(CLUES_NOTICE);
    expect(writeClipboard.mock.calls[0][0]).toContain(value.sources[0].excerpt);
    expect(generateBookWebResearch).toHaveBeenCalledOnce();
  });

  it("keeps selected sources and their order while clearly showing their missing ISBN clues", async () => {
    const value = answer({ citedSourceIds: ["W2", "W1"], draft: draftFor(["W2", "W1"]) });
    value.sources[0].bookClues = { isbn: "not_seen", text: ["title", "author"] };
    value.sources[1].bookClues = { isbn: "other_only", text: ["author"] };
    vi.mocked(generateBookWebResearch).mockResolvedValueOnce(value);
    render(<>{privateEditors()}{view()}</>);
    await click("联网研究"); await search();
    expect(screen.getByText(SELECTED_ISBN_NOTICE).getAttribute("role")).toBe("status");
    expect(screen.getByRole("heading", { name: "查到的相关资料" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "本次搜索资料不足" })).toBeNull();
    const cards = Array.from(result().querySelectorAll("[data-web-excerpt-source-id]"));
    expect(cards.map(card => card.getAttribute("data-web-excerpt-source-id"))).toEqual(["W2", "W1"]);
    expect(cards.map(card => card.querySelector("blockquote")?.textContent)).toEqual([value.sources[1].excerpt, value.sources[0].excerpt]);
    await click("复制结果与来源");
    expect(writeClipboard.mock.calls[0][0]).toContain(SELECTED_ISBN_NOTICE);
    expect(field("个人介绍草稿").value).toBe("尚未保存的个人介绍");
    expect(field("个人笔记草稿").value).toBe("尚未保存的个人笔记");
    change("新的问题");
    expect(screen.queryByText(SELECTED_ISBN_NOTICE)).toBeNull();
    expect(screen.queryByLabelText("书目线索核对范围")).toBeNull();
    expect(document.querySelector("[data-book-clues]")).toBeNull();
    expect(generateBookWebResearch).toHaveBeenCalledOnce();
  });

  it.each([undefined, "matched", "mixed"] as const)("does not claim missing selected ISBN clues when one source is %s", async isbn => {
    const value = answer({ citedSourceIds: ["W2", "W1"], draft: draftFor(["W2", "W1"]) });
    if (isbn) value.sources[0].bookClues = { isbn, text: [] };
    value.sources[1].bookClues = { isbn: "not_seen", text: [] };
    vi.mocked(generateBookWebResearch).mockResolvedValueOnce(value);
    await mount(); await search();
    expect(screen.queryByText(SELECTED_ISBN_NOTICE)).toBeNull();
    expect(result().querySelectorAll("[data-web-excerpt-source-id]")).toHaveLength(2);
    await click("复制结果与来源");
    expect(writeClipboard.mock.calls[0][0]).not.toContain(SELECTED_ISBN_NOTICE);
    if (!isbn) expect(writeClipboard.mock.calls[0][0]).toContain("书目线索未核对");
  });

  it.each([
    { isbn: "matched", text: ["author", "title"] },
    { isbn: "matched", text: [], contentVerified: true },
  ])("rejects malformed book-clue metadata before exposing cards or a copy action %#", async bookClues => {
    const value = answer();
    Object.assign(value.sources[0], { bookClues });
    vi.mocked(generateBookWebResearch).mockResolvedValueOnce(value);
    await mount(); await search();
    expect(screen.getByRole("alert").textContent).toBe("返回的研究资料未通过核对，请重新查询。");
    expect(document.querySelector("[data-book-clues]")).toBeNull();
    expect(screen.queryByLabelText("书目线索核对范围")).toBeNull();
    expect(screen.queryByRole("button", { name: "复制结果与来源" })).toBeNull();
    expect(screen.queryByRole("button", { name: "复制现有来源" })).toBeNull();
    expect(generateBookWebResearch).toHaveBeenCalledOnce();
  });

  it("retains read and comparison registration for insufficient sources and offers manual source copying", async () => {
    const value = unselectedAnswer();
    value.source = "insufficient_sources";
    value.draft = { title: "查到的相关资料", content: INSUFFICIENT };
    value.sources[0].bookClues = { isbn: "not_seen", text: ["author"] };
    vi.mocked(generateBookWebResearch).mockResolvedValueOnce(value);
    const source = value.sources[0];
    const readBody = {
      bookId: A, sourceId: source.id, requestedUrl: source.url, finalUrl: source.url,
      title: source.title, text: "这段可读网页正文仍然可以人工核对。",
      contentType: "text/plain", extraction: "plain_text", truncated: false,
      fetchedAt: "2026-11-16T08:00:00.000Z", snapshotToken: "C".repeat(32),
    };
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(readBody)));
    vi.stubGlobal("fetch", transport);
    writeClipboard.mockRejectedValueOnce(new Error("clipboard denied"));
    render(<>{privateEditors()}{view()}</>);
    await click("联网研究"); await search();
    expect(screen.getByRole("heading", { name: "本次搜索资料不足" })).toBeTruthy();
    expect(screen.queryByText(SELECTED_ISBN_NOTICE)).toBeNull();
    expect(transport).not.toHaveBeenCalled();
    await click("复制现有来源");
    const copied = field("可复制的研究结果");
    expect(copied.readOnly).toBe(true);
    expect(copied.value).toContain(INSUFFICIENT);
    expect(copied.value).toContain(CLUES_NOTICE);
    expect(copied.value).toContain(LIMITED);
    expect(copied.value).toContain("未见本书 ISBN；出现作者文字");
    expect(copied.value).toContain("书目线索未核对");
    for (const item of value.sources) expect(copied.value).toContain(item.excerpt);
    await act(async () => { fireEvent.click(screen.getByText("查看本次网页来源（2）")); });
    await click("读取网页正文 W1");
    expect(screen.getByRole("region", { name: "网页可读文字 W1" }).textContent).toContain(readBody.text);
    expect(screen.getByRole("checkbox", { name: "选择来源 W1" })).toBeTruthy();
    expect(transport).toHaveBeenCalledOnce();
    expect(JSON.parse(String(transport.mock.calls[0][1]?.body))).toEqual({ sourceToken: source.readToken });
    expect(field("个人介绍草稿").value).toBe("尚未保存的个人介绍");
    expect(field("个人笔记草稿").value).toBe("尚未保存的个人笔记");
    expect(field("联网研究问题").value).toBe(QUESTION);
    expect(generateBookWebResearch).toHaveBeenCalledOnce();
  });


  it("shows the same original literal contexts in selected and all-source cards without extra requests or editable-content changes", async () => {
    const value = contextualAnswer(), source = value.sources[0], before = JSON.stringify(value);
    vi.mocked(generateBookWebResearch).mockResolvedValueOnce(value);
    const transport = vi.fn<typeof fetch>(); vi.stubGlobal("fetch", transport);
    render(<>{privateEditors()}{view()}</>);
    await click("联网研究"); await search(); await click("查看网页依据 W1");
    const cards = [
      result().querySelector('[data-web-excerpt-source-id="W1"]') as HTMLElement,
      document.querySelector('[data-web-source-id="W1"]') as HTMLElement,
    ];
    for (const card of cards) {
      expect(card.querySelector("blockquote")?.textContent).toBe(source.excerpt);
      const contexts = within(card).getByLabelText("书目文字上下文 W1");
      expect(contexts.getAttribute("data-source-text-contexts")).toBe("available");
      const summary = within(contexts).getByText("查看书目文字上下文 W1", { exact: true });
      expect(summary.tagName).toBe("SUMMARY");
      await act(async () => { fireEvent.click(summary); });
      expect(contexts.textContent).toContain("书名号中的文字（标题中的文字）：《同名作品》");
      expect(contexts.textContent).toContain("版本字样（搜索节选中的文字）：修訂版");
      for (const item of bookWebSourceTextContexts(source)!.items) {
        const id = source.id + ":" + item.field + ":" + item.matchStart + ":" + item.matchEnd + ":" + item.kind;
        const row = contexts.querySelector('[data-text-context-id="' + id + '"]') as HTMLElement;
        expect(row.getAttribute("data-text-context-kind")).toBe(item.kind);
        expect(row.querySelector("blockquote")?.textContent).toBe(item.text);
      }
      expect(contexts.textContent).toContain("部分字样未列出，请结合标题和完整节选核对。");
      expect(contexts.querySelector("script")).toBeNull();
      expect(contexts.querySelector("img")).toBeNull();
    }
    expect(screen.getByLabelText("书目线索核对范围").textContent).toBe(CLUES_NOTICE);
    const other = document.querySelector('[data-web-source-id="W2"]') as HTMLElement;
    expect(within(other).getByLabelText("书目文字上下文 W2").getAttribute("data-source-text-contexts")).toBe("empty");
    expect(other.textContent).toContain("当前没有可展示的书名号或版本字样上下文。");
    expect(document.querySelector("[data-source-assessment]")).toBeNull();
    expect(screen.queryByText("AI 资料判断（待核对）")).toBeNull();
    await click("复制结果与来源");
    const copied = writeClipboard.mock.calls[0][0];
    expect(copied).toContain("书名号中的文字（标题中的文字）：《同名作品》");
    expect(copied).toContain(source.excerpt); expect(copied).toContain(source.url);
    expect(copied).not.toContain(value.sources[1].url);
    expect(copied).not.toContain(source.readToken);
    expect(copied).not.toContain("与本书关系：");
    expect(field("个人介绍草稿").value).toBe("尚未保存的个人介绍");
    expect(field("个人笔记草稿").value).toBe("尚未保存的个人笔记");
    expect(JSON.stringify(value)).toBe(before);
    expect(generateBookWebResearch).toHaveBeenCalledOnce();
    expect(transport).not.toHaveBeenCalled();
  });

  it("keeps legacy context absence distinct from a valid empty block without assigning a source relationship", async () => {
    const value = answer({ citedSourceIds: ["W2", "W1"], draft: draftFor(["W2", "W1"]) });
    value.sources[0].bookClues = { isbn: "matched", text: ["title"] };
    value.sources[1].textContexts = { items: [], limited: true };
    vi.mocked(generateBookWebResearch).mockResolvedValueOnce(value);
    await mount(); await search();
    const first = result().querySelector('[data-web-excerpt-source-id="W1"]') as HTMLElement;
    const second = result().querySelector('[data-web-excerpt-source-id="W2"]') as HTMLElement;
    expect(within(first).getByLabelText("书目文字上下文 W1").getAttribute("data-source-text-contexts")).toBe("unavailable");
    expect(first.textContent).toContain("本次未提供可用的文字上下文。");
    expect(within(second).getByLabelText("书目文字上下文 W2").getAttribute("data-source-text-contexts")).toBe("empty");
    expect(second.textContent).toContain("当前没有可展示的书名号或版本字样上下文。");
    expect(second.textContent).toContain("部分字样未列出，请结合标题和完整节选核对。");
    expect(first.querySelector("summary")).toBeNull();
    expect(second.querySelector("summary")).toBeNull();
    expect(screen.queryByText("尚未判断")).toBeNull();
    await click("复制结果与来源");
    const copied = writeClipboard.mock.calls[0][0];
    expect(copied).toContain("本次未提供可用的文字上下文。");
    expect(copied).toContain("当前没有可展示的书名号或版本字样上下文。");
    expect(copied.indexOf(value.sources[1].url)).toBeLessThan(copied.indexOf(value.sources[0].url));
  });

  it("drops a forged optional context block without discarding the selected source or copying model judgments", async () => {
    const value = contextualAnswer(), source = value.sources[0];
    const forged = bookWebSourceTextContexts(source)!; forged.items[0].text = "FORGED_CONTEXT";
    Object.assign(value, { assessments: [{ sourceId: "W1", relationship: "other_book", materialType: "review", explanation: "FORGED_JUDGEMENT" }] });
    const before = JSON.stringify(value);
    vi.mocked(generateBookWebResearch).mockResolvedValueOnce(value);
    writeClipboard.mockRejectedValueOnce(new Error("clipboard denied"));
    await mount(); await search(); await click("查看网页依据 W1");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(result().querySelectorAll("[data-web-excerpt-source-id]")).toHaveLength(1);
    for (const card of [
      result().querySelector('[data-web-excerpt-source-id="W1"]') as HTMLElement,
      document.querySelector('[data-web-source-id="W1"]') as HTMLElement,
    ]) {
      expect(card.querySelector("blockquote")?.textContent).toBe(source.excerpt);
      expect(within(card).getByLabelText("书目文字上下文 W1").getAttribute("data-source-text-contexts")).toBe("unavailable");
      expect(card.querySelector("[data-text-context-id]")).toBeNull();
    }
    expect(screen.getByRole("button", { name: "读取网页正文 W1" }).hasAttribute("disabled")).toBe(false);
    expect(document.body.textContent).not.toContain("FORGED_CONTEXT");
    expect(document.body.textContent).not.toContain("FORGED_JUDGEMENT");
    await click("复制结果与来源");
    const copied = field("可复制的研究结果").value;
    expect(copied).toContain(source.excerpt); expect(copied).toContain(source.url);
    expect(copied).toContain("本次未提供可用的文字上下文。");
    expect(copied).not.toContain("FORGED_CONTEXT"); expect(copied).not.toContain("FORGED_JUDGEMENT");
    expect(JSON.stringify(value)).toBe(before);
  });

  it("does not reset an explicitly read source or its comparison selection when text contexts are expanded or copied", async () => {
    const value = contextualAnswer(), source = value.sources[0];
    vi.mocked(generateBookWebResearch).mockResolvedValueOnce(value);
    const readBody = {
      bookId: A, sourceId: source.id, requestedUrl: source.url, finalUrl: source.url,
      title: source.title, text: "已读取的网页文字与文字线索展示分开保留。",
      contentType: "text/plain", extraction: "plain_text", truncated: false,
      fetchedAt: "2026-11-17T08:00:00.000Z", snapshotToken: "C".repeat(32),
    };
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(readBody)));
    vi.stubGlobal("fetch", transport);
    render(<>{privateEditors()}{view()}</>);
    await click("联网研究"); await search(); await click("读取网页正文 W1");
    const reader = screen.getByRole("region", { name: "网页可读文字 W1" });
    const selected = screen.getByRole("checkbox", { name: "选择来源 W1" }) as HTMLInputElement;
    await act(async () => { fireEvent.click(selected); });
    expect(selected.checked).toBe(true);
    const card = result().querySelector('[data-web-excerpt-source-id="W1"]') as HTMLElement;
    const summary = within(card).getByText("查看书目文字上下文 W1", { exact: true });
    await act(async () => { fireEvent.click(summary); });
    await click("复制结果与来源");
    expect(screen.getByRole("region", { name: "网页可读文字 W1" })).toBe(reader);
    expect(screen.getByRole("checkbox", { name: "选择来源 W1" })).toBe(selected);
    expect(selected.checked).toBe(true);
    expect(reader.textContent).toContain(readBody.text);
    expect(transport).toHaveBeenCalledOnce();
    expect(JSON.parse(String(transport.mock.calls[0][1]?.body))).toEqual({ sourceToken: source.readToken });
    expect(field("个人介绍草稿").value).toBe("尚未保存的个人介绍");
    expect(field("个人笔记草稿").value).toBe("尚未保存的个人笔记");
    expect(generateBookWebResearch).toHaveBeenCalledOnce();
  });

  it.each(["unselected_sources", "insufficient_sources"] as const)("shows and copies objective contexts for %s without inventing a selection", async kind => {
    const value = contextualAnswer();
    value.source = kind; value.citedSourceIds = [];
    value.draft = kind === "unselected_sources"
      ? { title: "待核对的网页资料", content: UNSELECTED } : { title: "查到的相关资料", content: INSUFFICIENT };
    vi.mocked(generateBookWebResearch).mockResolvedValueOnce(value);
    await mount(); await search();
    if (kind === "insufficient_sources") await act(async () => { fireEvent.click(screen.getByText("查看本次网页来源（2）")); });
    expect(document.querySelector("[data-web-excerpt-source-id]")).toBeNull();
    const card = document.querySelector('[data-web-source-id="W1"]') as HTMLElement;
    expect(card.querySelector("blockquote")?.textContent).toBe(value.sources[0].excerpt);
    expect(within(card).getByLabelText("书目文字上下文 W1").getAttribute("data-source-text-contexts")).toBe("available");
    await click(kind === "insufficient_sources" ? "复制现有来源" : "复制结果与来源");
    const copied = writeClipboard.mock.calls[0][0];
    for (const source of value.sources) {
      expect(copied).toContain(source.url); expect(copied).toContain(source.excerpt);
      expect(copied).not.toContain(source.readToken);
    }
    expect(copied).toContain("书名号中的文字（标题中的文字）：《同名作品》");
    expect(copied).not.toContain("建议先查看");
    expect(generateBookWebResearch).toHaveBeenCalledOnce();
  });

  it("fills the book-review preset without claiming classification or starting a request", async () => {
    await mount(); await click("本书书评");
    const question = "查找直接评论这本书的书评或研究，并提供可核对的网页来源。";
    expect(field("联网研究问题").value).toBe(question);
    expect(document.activeElement).toBe(field("联网研究问题"));
    expect(generateBookWebResearch).not.toHaveBeenCalled();
    await click("联网查资料");
    expect(generateBookWebResearch).toHaveBeenCalledOnce();
    expect(vi.mocked(generateBookWebResearch).mock.calls[0][1]).toEqual({ question, scope: "direct_book_review" });
  });

});

describe("explicit strict direct-book-review UI mode", () => {
  it("marks only the selected strict preset, sends one scoped request, and clears the mode when manually edited", async () => {
    await mount();
    await click("本书书评");
    expect(field("联网研究问题").value).toContain("直接评论这本书");
    expect(screen.getByText(/严格本书书评：仅推荐能在搜索节选中/)).toBeTruthy();
    expect(generateBookWebResearch).not.toHaveBeenCalled();
    await click("联网查资料");
    expect(generateBookWebResearch).toHaveBeenCalledExactlyOnceWith(A,
      { question: "查找直接评论这本书的书评或研究，并提供可核对的网页来源。", scope: "direct_book_review" },
      expect.any(AbortSignal));
    expect(screen.getAllByText(/严格本书书评：仅推荐能在搜索节选中/).length).toBeGreaterThan(0);
    change("改为研究作者生平");
    expect(screen.queryByText(/严格本书书评：仅推荐能在搜索节选中/)).toBeNull();
    expect(generateBookWebResearch).toHaveBeenCalledOnce();
  });
});

describe("strict review sidebar copying", () => {
  it.each(["web_research", "insufficient_sources", "unselected_sources"] as const)(
    "copies %s in strict mode without clearing sources or private drafts", async kind => {
      const value = answer({ scope: "direct_book_review", question: "查找直接评论这本书的书评或研究，并提供可核对的网页来源。" });
      if (kind === "insufficient_sources") Object.assign(value, { source: kind, citedSourceIds: [], draft: { title: "查到的相关资料", content: INSUFFICIENT } });
      if (kind === "unselected_sources") Object.assign(value, { source: kind, citedSourceIds: [], draft: { title: "待核对的网页资料", content: UNSELECTED } });
      vi.mocked(generateBookWebResearch).mockResolvedValueOnce(value);
      render(<>{privateEditors()}{view()}</>);
      await click("联网研究"); await click("本书书评"); await click("联网查资料");
      await click(kind === "insufficient_sources" ? "复制现有来源" : "复制结果与来源");
      expect(writeClipboard).toHaveBeenCalledOnce();
      expect(writeClipboard.mock.calls[0][0]).toContain("严格本书书评");
      expect(writeClipboard.mock.calls[0][0]).toContain(value.sources[0].excerpt);
      expect(field("个人介绍草稿").value).toBe("尚未保存的个人介绍");
      expect(field("个人笔记草稿").value).toBe("尚未保存的个人笔记");
      expect(screen.queryByRole("alert")).toBeNull();
      expect(generateBookWebResearch).toHaveBeenCalledOnce();
    });
});
