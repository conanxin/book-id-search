// @vitest-environment jsdom
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Link, MemoryRouter, Route, Routes, useParams } from "react-router-dom";
import { BookWorkspace } from "./BookWorkspace";
import { __resetWebAuthStoreForTests, __setWebAuthSnapshotForTests } from "../auth/session";
import {
  createBookNote, createBookResource, deleteBookNote, deleteBookResource, getBookNoteRevision,
  getBookWorkspace, LibraryApiError, saveBookWorkspace, updateBookNote, updateBookResource,
  type BookNote, type BookResource, type BookWorkspaceData,
} from "./api";

vi.mock("../auth/session", async importOriginal => ({ ...await importOriginal<typeof import("../auth/session")>(), ensureAuthSessionLoaded: vi.fn(async () => {}) }));
vi.mock("./api", async importOriginal => ({
  ...await importOriginal<typeof import("./api")>(),
  getBookWorkspace: vi.fn(), saveBookWorkspace: vi.fn(), createBookNote: vi.fn(), updateBookNote: vi.fn(), deleteBookNote: vi.fn(),
  getBookNoteRevision: vi.fn(), createBookResource: vi.fn(), updateBookResource: vi.fn(), deleteBookResource: vi.fn(),
}));

const time = "2026-10-11T02:00:00Z";
const auth = (csrf = "csrf-a") => ({ status: "authenticated" as const, user: { email: "owner@example.test", name: "Owner" }, csrfToken: csrf, error: null });
const note = (revisionNo = 1): BookNote => ({
  noteId: "note-a", title: "古道的阅读线索", content: `笔记正文 ${revisionNo}`, currentRevisionId: `revision-${revisionNo}`,
  revisionNo, createdAt: time, updatedAt: time,
  revisions: Array.from({ length: revisionNo }, (_, i) => ({ revisionId: `revision-${i + 1}`, revisionNo: i + 1, createdAt: time })),
});

const resource: BookResource = { resourceId: "resource-a", label: "原版扫描本", url: "https://example.test/book.pdf#page=21", format: "PDF", versionLabel: "1936 年版", notes: "原书扫描", createdAt: time, updatedAt: time };
const workspace = (overrides: Partial<BookWorkspaceData> = {}): BookWorkspaceData => ({
  bookId: "book-a", saved: false, editionId: null, introduction: "", version: 0, updatedAt: null, notes: [], resources: [], ...overrides,
});
const view = (bookId = "book-a") => <MemoryRouter><BookWorkspace bookId={bookId} /></MemoryRouter>;
const input = (label: string) => screen.getByLabelText(label) as HTMLInputElement | HTMLTextAreaElement;
const click = async (name: string) => { await act(async () => { fireEvent.click(screen.getByRole("button", { name })); }); };
const change = (label: string, value: string) => fireEvent.change(input(label), { target: { value } });
const openPreview = async (name: string) => {
  const summary = screen.getByText(name, { selector: "summary" });
  const details = summary.parentElement as HTMLDetailsElement;
  expect(details.open).toBe(false);
  expect(details.querySelector(".book-prose")).toBeNull();
  await act(async () => { fireEvent.click(summary); });
  await waitFor(() => expect(details.querySelector(".book-prose")).not.toBeNull());
  return details;
};

beforeEach(() => {
  vi.clearAllMocks(); __resetWebAuthStoreForTests(); __setWebAuthSnapshotForTests(auth());
  vi.mocked(getBookWorkspace).mockImplementation(async bookId => workspace({ bookId }));
  vi.mocked(saveBookWorkspace).mockResolvedValue(workspace({ saved: true, editionId: "edition-a", version: 1, updatedAt: time }));
  vi.mocked(createBookNote).mockResolvedValue(workspace({ saved: true, notes: [note()] }));
  vi.mocked(updateBookNote).mockResolvedValue(workspace({ saved: true, notes: [note(2)] }));
  vi.mocked(deleteBookNote).mockResolvedValue(workspace({ saved: true }));
  vi.mocked(getBookNoteRevision).mockResolvedValue({ revisionId: "revision-1", revisionNo: 1, title: "早期标题", content: "早期正文", createdAt: time });
  vi.mocked(createBookResource).mockResolvedValue(workspace({ saved: true, resources: [resource] }));
  vi.mocked(updateBookResource).mockResolvedValue(workspace({ saved: true, resources: [{ ...resource, label: "订正名称" }] }));
  vi.mocked(deleteBookResource).mockResolvedValue(workspace({ saved: true }));
});
afterEach(() => { cleanup(); __resetWebAuthStoreForTests(); });

describe("book workspace", () => {
  it("makes no private request before login and removes all content on logout", async () => {
    __setWebAuthSnapshotForTests({ status: "unauthenticated", user: null, csrfToken: null, error: null });
    render(view());
    expect(getBookWorkspace).not.toHaveBeenCalled();
    act(() => __setWebAuthSnapshotForTests(auth()));
    await screen.findByRole("button", { name: "补充介绍" });
    await click("补充介绍"); change("书籍介绍", "只属于当前账号的草稿");
    act(() => __setWebAuthSnapshotForTests({ status: "signing_out", user: null, csrfToken: null, error: null }));
    expect(screen.queryByLabelText("书籍介绍")).toBeNull();
    expect(screen.queryByText("只属于当前账号的草稿")).toBeNull();
  });

  it("initial reading works under React StrictMode and never creates a book merely by opening it", async () => {
    render(<StrictMode>{view()}</StrictMode>);
    expect(await screen.findByRole("button", { name: "加入我的书籍" })).toBeTruthy();
    expect(saveBookWorkspace).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("offers retry after a failed read without displaying a false empty editor", async () => {
    vi.mocked(getBookWorkspace).mockRejectedValueOnce(new LibraryApiError(503, "书籍内容服务暂不可用"));
    render(view());
    await screen.findByRole("alert");
    expect(screen.queryByRole("button", { name: "补充介绍" })).toBeNull();
    await click("重新读取");
    expect(await screen.findByRole("button", { name: "补充介绍" })).toBeTruthy();
  });

  it("saves a book with an empty PUT and changes to the saved link only after success", async () => {
    let finish!: (value: BookWorkspaceData) => void;
    vi.mocked(saveBookWorkspace).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    render(view()); await screen.findByRole("button", { name: "加入我的书籍" });
    await click("加入我的书籍");
    expect(screen.queryByRole("link", { name: "已在我的书籍中" })).toBeNull();
    expect(saveBookWorkspace).toHaveBeenCalledWith("book-a", {}, expect.any(AbortSignal));
    await act(async () => finish(workspace({ saved: true })));
    expect(screen.getByRole("link", { name: "已在我的书籍中" }).getAttribute("href")).toBe("/library");
  });

  it("reads saved introductions and notes as prose while keeping resource remarks literal", async () => {
    const introduction = "# 阅读路线\n\n- **旅行**经验\n- 地理线索\n\n> 一句原书摘录\n\n[查看笔记](/books/book-a#book-note-note-a)";
    const content = "## 我的观察\n\n先看*版本*，再核对地名。\n\n[原书页面](https://example.test/book.pdf#page=21)";
    vi.mocked(getBookWorkspace).mockResolvedValue(workspace({ saved: true, introduction,
      notes: [{ ...note(), content }], resources: [{ ...resource, notes: "**来源备注** [纸本](https://example.test/raw)" }],
    }));
    render(view());
    const intro = await screen.findByRole("region", { name: "我的补充介绍" });
    expect(within(intro).getByRole("heading", { name: "阅读路线" })).toBeTruthy();
    expect(within(intro).getAllByRole("listitem")).toHaveLength(2);
    expect(intro.querySelector("strong")?.textContent).toBe("旅行");
    expect(intro.querySelector("blockquote")?.textContent).toContain("一句原书摘录");
    expect(within(intro).getByRole("link", { name: "查看笔记" }).getAttribute("href")).toBe("/books/book-a#book-note-note-a");
    expect(within(intro).getByRole("heading", { name: "我的补充介绍" }).id).toBe("library-introduction-heading");
    const article = screen.getByRole("article", { name: "笔记：古道的阅读线索" });
    expect(article.id).toBe("book-note-note-a");
    expect(within(article).getByRole("heading", { name: "我的观察" })).toBeTruthy();
    expect(article.querySelector("em")?.textContent).toBe("版本");
    expect(within(article).getByRole("link", { name: "原书页面" }).getAttribute("href")).toBe(resource.url);
    const version = screen.getByRole("article", { name: "电子版本：原版扫描本" });
    expect(version.textContent).toContain("**来源备注** [纸本](https://example.test/raw)");
    expect(within(version).queryByRole("link", { name: "纸本" })).toBeNull();
    expect(saveBookWorkspace).not.toHaveBeenCalled(); expect(createBookNote).not.toHaveBeenCalled();
  });

  it("retains a conflicted introduction and deliberately rebases it on the latest version", async () => {
    const original = "# 已有介绍\n\n原来的一段文字。";
    const draft = "## 我的未保存草稿\n\n- 保留 **重点**\n\n[原书](https://example.test/book.pdf)\n";
    const latest = "# 另一个页面的新介绍\n\n> 新增的版本说明";
    vi.mocked(getBookWorkspace).mockResolvedValueOnce(workspace({ saved: true, introduction: original, version: 2 }))
      .mockResolvedValueOnce(workspace({ saved: true, introduction: latest, version: 3 }));
    vi.mocked(saveBookWorkspace).mockRejectedValueOnce(new LibraryApiError(409, "介绍已变化，草稿保留"))
      .mockResolvedValueOnce(workspace({ saved: true, introduction: draft, version: 4 }));
    render(view()); await screen.findByRole("button", { name: "编辑介绍" });
    await click("编辑介绍"); expect(input("书籍介绍").value).toBe(original);
    change("书籍介绍", draft);
    const preview = await openPreview("预览介绍");
    expect(within(preview).getByRole("heading", { name: "我的未保存草稿" })).toBeTruthy();
    expect(within(preview).getByRole("link", { name: "原书" }).getAttribute("href")).toBe("https://example.test/book.pdf");
    expect(getBookWorkspace).toHaveBeenCalledTimes(1); expect(saveBookWorkspace).not.toHaveBeenCalled();
    expect(input("书籍介绍").value).toBe(draft);
    await click("保存介绍");
    await screen.findByRole("alert");
    expect(input("书籍介绍").value).toBe(draft);
    expect((screen.getByRole("button", { name: "保存介绍" }) as HTMLButtonElement).disabled).toBe(true);
    await click("读取最新介绍");
    expect(input("书籍介绍").value).toBe(draft);
    const comparison = screen.getByText("刚读取的最新介绍", { selector: "summary" }).parentElement!;
    expect(within(comparison).getByRole("heading", { name: "另一个页面的新介绍" })).toBeTruthy();
    expect(comparison.querySelector("blockquote")?.textContent).toContain("新增的版本说明");
    await click("将我的草稿保存为新版本");
    expect(saveBookWorkspace).toHaveBeenLastCalledWith("book-a", { introduction: draft, baseVersion: 3 }, expect.any(AbortSignal));
    expect(await screen.findByText("书籍介绍已保存。")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "我的未保存草稿" })).toBeTruthy();
  });

  it("previews a new note without writing and saves its exact Markdown only on submit", async () => {
    const content = "# 踏查记录\n\n1. 核对地名\n2. 回到原书\n\n> 待下次实地确认\n";
    render(view()); await screen.findByRole("button", { name: "写一篇笔记" }); await click("写一篇笔记");
    change("笔记标题", "现场笔记"); change("笔记正文", content);
    const preview = await openPreview("预览笔记");
    expect(within(preview).getByRole("heading", { name: "踏查记录" })).toBeTruthy();
    expect(preview.querySelectorAll("ol > li")).toHaveLength(2);
    expect(preview.querySelector("blockquote")?.textContent).toContain("待下次实地确认");
    expect(input("笔记正文").value).toBe(content);
    expect(getBookWorkspace).toHaveBeenCalledTimes(1); expect(createBookNote).not.toHaveBeenCalled();
    expect(updateBookNote).not.toHaveBeenCalled(); expect(saveBookWorkspace).not.toHaveBeenCalled();
    const edited = `${content}\n**仍待核对**`;
    change("笔记正文", edited);
    expect(preview.querySelector("strong")?.textContent).toBe("仍待核对");
    vi.mocked(createBookNote).mockResolvedValueOnce(workspace({ saved: true, notes: [{ ...note(), title: "现场笔记", content: edited }] }));
    await click("保存笔记");
    expect(createBookNote).toHaveBeenCalledWith("book-a", { title: "现场笔记", content: edited }, expect.any(AbortSignal));
    await click("编辑笔记");
    expect((screen.getByText("预览笔记", { selector: "summary" }).parentElement as HTMLDetailsElement).open).toBe(false);
  });

  it("preserves a failed new note, then saves it without creating another workspace", async () => {
    vi.mocked(createBookNote).mockRejectedValueOnce(new LibraryApiError(503, "暂时不能保存")).mockResolvedValueOnce(workspace({ saved: true, notes: [note()] }));
    render(view()); await screen.findByRole("button", { name: "写一篇笔记" }); await click("写一篇笔记");
    change("笔记标题", "古道的阅读线索"); change("笔记正文", "笔记正文 1");
    await click("保存笔记"); await screen.findByRole("alert");
    expect(input("笔记正文").value).toBe("笔记正文 1");
    expect(screen.queryByText("笔记已保存。")).toBeNull();
    await click("保存笔记");
    expect(await screen.findByRole("article", { name: "笔记：古道的阅读线索" })).toBeTruthy();
    expect(createBookNote).toHaveBeenLastCalledWith("book-a", { title: "古道的阅读线索", content: "笔记正文 1" }, expect.any(AbortSignal));
    expect(saveBookWorkspace).not.toHaveBeenCalled();
  });

  it("edits a note using its original revision and reads history separately", async () => {
    const original = "# 第一版观察\n\n[查看来源](https://example.test/source)";
    const edited = "## 第二版观察\n\n- 新的地名线索\n\n> 保留原句\n";
    vi.mocked(getBookWorkspace).mockResolvedValue(workspace({ saved: true, notes: [{ ...note(), content: original }] }));
    vi.mocked(updateBookNote).mockResolvedValueOnce(workspace({ saved: true, notes: [{ ...note(2), content: edited }] }));
    vi.mocked(getBookNoteRevision).mockResolvedValueOnce({ revisionId: "revision-1", revisionNo: 1, title: "早期标题", content: original, createdAt: time });
    render(view()); await screen.findByRole("button", { name: "编辑笔记" });
    await click("编辑笔记"); expect(input("笔记正文").value).toBe(original);
    change("笔记正文", edited); await click("保存笔记");
    expect(updateBookNote).toHaveBeenCalledWith("book-a", "note-a", { title: "古道的阅读线索", content: edited, baseRevisionId: "revision-1" }, expect.any(AbortSignal));
    expect(getBookNoteRevision).not.toHaveBeenCalled();
    await click("查看历史版本（2）"); await click("第 1 版");
    const historical = await screen.findByRole("region", { name: "历史版本 1" });
    expect(within(historical).getByRole("heading", { name: "第一版观察" })).toBeTruthy();
    expect(within(historical).getByRole("link", { name: "查看来源" }).getAttribute("href")).toBe("https://example.test/source");
    expect(within(historical).queryByRole("textbox")).toBeNull();
    expect(screen.getByRole("heading", { name: "第二版观察" })).toBeTruthy();
    expect(updateBookNote).toHaveBeenCalledTimes(1); expect(createBookNote).not.toHaveBeenCalled();
  });

  it("conflicted notes keep their drafts and update the base revision only after an explicit reload", async () => {
    const draft = "## 我的冲突草稿\n\n[对照资料](https://example.test/compare)\n";
    const latest = "# 最新笔记内容\n\n> 新版引文";
    vi.mocked(getBookWorkspace).mockResolvedValueOnce(workspace({ notes: [note()] }))
      .mockResolvedValueOnce(workspace({ notes: [{ ...note(3), content: latest }] }));
    vi.mocked(updateBookNote).mockRejectedValueOnce(new LibraryApiError(409, "版本已更新"))
      .mockResolvedValueOnce(workspace({ notes: [{ ...note(4), content: draft }] }));
    render(view()); await screen.findByRole("button", { name: "编辑笔记" });
    await click("编辑笔记"); change("笔记正文", draft); await click("保存笔记");
    await screen.findByRole("alert"); expect(input("笔记正文").value).toBe(draft);
    await click("读取最新笔记"); expect(input("笔记正文").value).toBe(draft);
    const comparison = screen.getByText("刚读取的最新笔记：古道的阅读线索", { selector: "summary" }).parentElement!;
    expect(within(comparison).getByRole("heading", { name: "最新笔记内容" })).toBeTruthy();
    expect(comparison.querySelector("blockquote")?.textContent).toContain("新版引文");
    await click("将我的草稿保存为新版本");
    expect(updateBookNote).toHaveBeenLastCalledWith("book-a", "note-a", expect.objectContaining({ content: draft, baseRevisionId: "revision-3" }), expect.any(AbortSignal));
  });

  it("deletes a note only after its local confirmation and an acknowledged server response", async () => {
    vi.mocked(getBookWorkspace).mockResolvedValue(workspace({ notes: [note()] }));
    render(view()); await screen.findByRole("button", { name: "删除笔记" }); await click("删除笔记");
    expect(deleteBookNote).not.toHaveBeenCalled();
    await click("确认删除笔记");
    expect(deleteBookNote).toHaveBeenCalledWith("book-a", "note-a", expect.any(AbortSignal));
    expect(screen.queryByRole("article", { name: "笔记：古道的阅读线索" })).toBeNull();
  });

  it("rejects unsafe electronic links and saves a usable external link without uploading bytes", async () => {
    render(view()); await screen.findByRole("button", { name: "添加电子版链接" }); await click("添加电子版链接");
    change("资源名称", "原版扫描本"); change("电子版链接", "javascript:alert(1)");
    await act(async () => { fireEvent.submit(screen.getByRole("form", { name: "添加电子版本" })); });
    expect(createBookResource).not.toHaveBeenCalled();
    expect(input("电子版链接").value).toBe("javascript:alert(1)");
    expect(screen.getByRole("alert").textContent).toContain("https://");
    change("电子版链接", resource.url); change("版本说明（可选）", resource.versionLabel); change("来源与备注（可选）", resource.notes);
    await click("保存电子版链接");
    const link = await screen.findByRole("link", { name: "打开电子版本 ↗" });
    expect(link.getAttribute("href")).toBe(resource.url);
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(createBookResource).toHaveBeenCalledWith("book-a", { label: resource.label, url: resource.url, format: "PDF", versionLabel: resource.versionLabel, notes: resource.notes }, expect.any(AbortSignal));
    expect(document.querySelector('input[type="file"]')).toBeNull();
  });

  it("edits and removes electronic version registrations", async () => {
    vi.mocked(getBookWorkspace).mockResolvedValue(workspace({ resources: [resource] }));
    render(view()); await screen.findByRole("button", { name: "编辑链接" }); await click("编辑链接");
    change("资源名称", "订正名称"); await click("保存电子版链接");
    expect(updateBookResource).toHaveBeenCalledWith("book-a", "resource-a", expect.objectContaining({ label: "订正名称", url: resource.url }), expect.any(AbortSignal));
    await click("移除链接"); expect(deleteBookResource).not.toHaveBeenCalled(); await click("确认移除链接");
    expect(deleteBookResource).toHaveBeenCalledWith("book-a", "resource-a", expect.any(AbortSignal));
    expect(screen.queryByRole("link", { name: "打开电子版本 ↗" })).toBeNull();
  });

  it("aborts a pending write and prevents its response from entering the next book", async () => {
    let finish!: (value: BookWorkspaceData) => void;
    vi.mocked(saveBookWorkspace).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const rendered = render(view()); await screen.findByRole("button", { name: "补充介绍" }); await click("补充介绍");
    change("书籍介绍", "旧书的保密介绍"); await click("保存介绍");
    const signal = vi.mocked(saveBookWorkspace).mock.calls[0][2]!;
    rendered.rerender(view("book-b"));
    expect(signal.aborted).toBe(true); expect(screen.queryByLabelText("书籍介绍")).toBeNull();
    await screen.findByRole("button", { name: "补充介绍" });
    await act(async () => finish(workspace({ introduction: "旧书的保密介绍", saved: true })));
    expect(screen.queryByText("旧书的保密介绍")).toBeNull();
    expect(screen.queryByText("书籍介绍已保存。")).toBeNull();
    expect(getBookWorkspace).toHaveBeenLastCalledWith("book-b", expect.any(AbortSignal));
  });

  it("a new auth generation clears unsaved content even for the same book", async () => {
    render(view()); await screen.findByRole("button", { name: "写一篇笔记" }); await click("写一篇笔记");
    change("笔记标题", "旧会话草稿");
    act(() => __setWebAuthSnapshotForTests(auth("csrf-b")));
    expect(screen.queryByLabelText("笔记标题")).toBeNull();
    await screen.findByRole("button", { name: "写一篇笔记" }); await click("写一篇笔记");
    expect(input("笔记标题").value).toBe("");
  });
});

function AnchoredBook() {
  const { bookId = "book-a" } = useParams();
  return <BookWorkspace bookId={bookId} />;
}
function anchoredView(entry = "/books/book-a#book-note-note-a") {
  return <MemoryRouter initialEntries={[entry]}>
    <Routes><Route path="/books/:bookId" element={<AnchoredBook />} /></Routes>
    <Link to="#library-introduction-heading">定位介绍</Link>
    <Link to="#book-note-note-b">定位第二篇笔记</Link>
    <Link to="/books/book-b#book-note-note-a">切换书籍</Link>
  </MemoryRouter>;
}

describe("book content anchors", () => {
  const scroll = vi.fn();
  const originalScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scroll });
  });
  afterEach(() => {
    if (originalScroll) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", originalScroll);
    else delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
    window.history.replaceState({}, "", "/");
  });

  it("waits for the workspace, focuses the requested note once, and does not jump again after a save", async () => {
    let finish!: (value: BookWorkspaceData) => void;
    vi.mocked(getBookWorkspace).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const rendered = render(anchoredView());
    expect(scroll).not.toHaveBeenCalled();
    expect(screen.queryByRole("article", { name: "笔记：古道的阅读线索" })).toBeNull();
    await act(async () => finish(workspace({ introduction: "原介绍", notes: [note()] })));
    const target = screen.getByRole("article", { name: "笔记：古道的阅读线索" });
    expect(document.activeElement).toBe(target);
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(scroll.mock.instances[0]).toBe(target);
    rendered.rerender(anchoredView());
    expect(scroll).toHaveBeenCalledTimes(1);
    vi.mocked(saveBookWorkspace).mockResolvedValueOnce(workspace({ introduction: "更新后的介绍", notes: [note()], version: 1 }));
    await click("编辑介绍"); change("书籍介绍", "更新后的介绍"); await click("保存介绍");
    expect(await screen.findByText("书籍介绍已保存。")).toBeTruthy();
    expect(scroll).toHaveBeenCalledTimes(1);
  });

  it("handles a different fragment in the same book without refetching its workspace", async () => {
    const second = { ...note(), noteId: "note-b", title: "第二篇笔记" };
    vi.mocked(getBookWorkspace).mockResolvedValue(workspace({ introduction: "介绍", notes: [note(), second] }));
    render(anchoredView("/books/book-a#library-introduction-heading"));
    const heading = await screen.findByRole("heading", { name: "我的补充介绍" });
    expect(document.activeElement).toBe(heading);
    await act(async () => { fireEvent.click(screen.getByRole("link", { name: "定位第二篇笔记" })); });
    expect(document.activeElement).toBe(screen.getByRole("article", { name: "笔记：第二篇笔记" }));
    await act(async () => { fireEvent.click(screen.getByRole("link", { name: "定位介绍" })); });
    expect(document.activeElement).toBe(heading);
    expect(scroll).toHaveBeenCalledTimes(3);
    expect(getBookWorkspace).toHaveBeenCalledTimes(1);
    await act(async () => {
      window.history.replaceState({}, "", "/books/book-a#book-note-note-b");
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(document.activeElement).toBe(screen.getByRole("article", { name: "笔记：第二篇笔记" }));
    expect(scroll).toHaveBeenCalledTimes(4);
  });

  it("explains missing or invalid note targets without focusing an unrelated element", async () => {
    const unrelated = document.createElement("article");
    unrelated.id = "book-note-elsewhere"; unrelated.tabIndex = -1;
    document.body.append(unrelated);
    try {
      render(anchoredView("/books/book-a#book-note-elsewhere"));
      expect(await screen.findByText(/这篇笔记已不在当前书籍中/)).toBeTruthy();
      expect(document.activeElement).not.toBe(unrelated);
      expect(scroll).not.toHaveBeenCalled();
      await act(async () => {
        window.history.replaceState({}, "", "/books/book-a#book-note-%E0%A4%A");
        window.dispatchEvent(new HashChangeEvent("hashchange"));
      });
      expect(screen.getByText(/这篇笔记的定位地址无效/)).toBeTruthy();
      expect(scroll).not.toHaveBeenCalled();
    } finally { unrelated.remove(); }
  });

  it("never focuses an old book note after a delayed workspace resolves", async () => {
    let finish!: (value: BookWorkspaceData) => void;
    vi.mocked(getBookWorkspace).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    render(anchoredView());
    await act(async () => { fireEvent.click(screen.getByRole("link", { name: "切换书籍" })); });
    expect(await screen.findByText(/这篇笔记已不在当前书籍中/)).toBeTruthy();
    await act(async () => finish(workspace({ notes: [note()] })));
    expect(screen.queryByRole("article", { name: "笔记：古道的阅读线索" })).toBeNull();
    expect(scroll).not.toHaveBeenCalled();
    expect(getBookWorkspace).toHaveBeenLastCalledWith("book-b", expect.any(AbortSignal));
  });

  it("never focuses a late note from a previous Google session", async () => {
    let finish!: (value: BookWorkspaceData) => void;
    vi.mocked(getBookWorkspace).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    render(anchoredView());
    act(() => __setWebAuthSnapshotForTests(auth("csrf-b")));
    expect(await screen.findByText(/这篇笔记已不在当前书籍中/)).toBeTruthy();
    await act(async () => finish(workspace({ notes: [note()] })));
    expect(screen.queryByRole("article", { name: "笔记：古道的阅读线索" })).toBeNull();
    expect(scroll).not.toHaveBeenCalled();
  });
});
