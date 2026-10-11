// @vitest-environment jsdom
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { BookAiAssistant } from "./BookAiAssistant";
import { __resetWebAuthStoreForTests, __setWebAuthSnapshotForTests } from "../auth/session";
import { createBookNote, getBookWorkspace, saveBookWorkspace } from "./api";
import { generateBookAi, type BookAiResponse } from "./bookAi";
import { bookWebResearchContent, generateBookWebResearch, type BookWebResearchResponse } from "./bookWebResearch";

vi.mock("../auth/session", async original => ({ ...await original<typeof import("../auth/session")>(), ensureAuthSessionLoaded: vi.fn(async () => {}) }));
vi.mock("./api", async original => ({ ...await original<typeof import("./api")>(), getBookWorkspace: vi.fn(), saveBookWorkspace: vi.fn(), createBookNote: vi.fn() }));
vi.mock("./bookAi", async original => ({ ...await original<typeof import("./bookAi")>(), generateBookAi: vi.fn() }));
vi.mock("./bookWebResearch", async original => ({ ...await original<typeof import("./bookWebResearch")>(), generateBookWebResearch: vi.fn() }));

const A = "10000001_100000000001", B = "10000002_100000000002", QUESTION = "这本书有哪些相关研究？";
const NOTICE = "已根据本次问题选出相关网页，以下保留搜索工具返回的来源节选。节选不等于网页或原书全文；来源之间可能有不同说法。";
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

beforeEach(() => {
  vi.clearAllMocks(); __resetWebAuthStoreForTests(); __setWebAuthSnapshotForTests(auth());
  vi.mocked(generateBookWebResearch).mockReset().mockImplementation(async (bookId, input) => answer({ bookId, question: input.question.trim() }));
  vi.mocked(generateBookAi).mockReset();
  writeClipboard.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: writeClipboard } });
});
afterEach(() => {
  cleanup(); __resetWebAuthStoreForTests();
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

  it("shows insufficient evidence with search terms and available excerpts, without a copyable answer", async () => {
    vi.mocked(generateBookWebResearch).mockResolvedValueOnce(answer({ source: "insufficient_sources", citedSourceIds: [], draft: { title: "查到的相关资料", content: INSUFFICIENT } }));
    await mount(); await search();
    expect(screen.getByText(INSUFFICIENT)).toBeTruthy();
    expect(screen.getByLabelText("本次实际搜索词")).toBeTruthy();
    expect(document.querySelectorAll("[data-web-source-id]")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "复制结果与来源" })).toBeNull();
    await click("清除结果");
    expect(screen.queryByLabelText("本次实际搜索词")).toBeNull();
    expect(document.querySelector("[data-web-source-id]")).toBeNull();
  });

  it("does not render or copy a successful answer with an unverified citation", async () => {
    const value = answer(); value.draft.content += "[W99]";
    vi.mocked(generateBookWebResearch).mockResolvedValueOnce(value);
    await mount(); await search();
    expect(screen.getByRole("alert").textContent).toContain("来源核对未完成");
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
    expect(screen.getByRole("alert").textContent).toContain("来源核对未完成");
    expect(screen.queryByRole("region", { name: "联网研究结果" })).toBeNull();
    expect(document.querySelector("[data-web-source-id]")).toBeNull();
    expect(writeClipboard).not.toHaveBeenCalled();
  });

  it("shows a bounded error and allows an explicit fresh request", async () => {
    vi.mocked(generateBookWebResearch).mockRejectedValueOnce(new Error("private provider payload"));
    await mount(); await search();
    expect(screen.getByRole("alert").textContent).toBe("暂时无法完成研究，请重试。");
    await click("联网查资料"); expect(screen.queryByRole("alert")).toBeNull();
    expect(result()).toBeTruthy(); expect(generateBookWebResearch).toHaveBeenCalledTimes(2);
  });
});
