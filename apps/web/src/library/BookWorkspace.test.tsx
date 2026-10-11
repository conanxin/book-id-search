// @vitest-environment jsdom
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
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
const click = async (name: string) => { await act(async () => { fireEvent.click(screen.getByRole("button", { name, exact: true })); }); };
const change = (label: string, value: string) => fireEvent.change(input(label), { target: { value } });

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

  it("retains a conflicted introduction and deliberately rebases it on the latest version", async () => {
    vi.mocked(getBookWorkspace).mockResolvedValueOnce(workspace({ saved: true, introduction: "已有介绍", version: 2 }))
      .mockResolvedValueOnce(workspace({ saved: true, introduction: "另一个页面的新介绍", version: 3 }));
    vi.mocked(saveBookWorkspace).mockRejectedValueOnce(new LibraryApiError(409, "介绍已变化，草稿保留"))
      .mockResolvedValueOnce(workspace({ saved: true, introduction: "我的未保存草稿", version: 4 }));
    render(view()); await screen.findByRole("button", { name: "编辑介绍" });
    await click("编辑介绍"); change("书籍介绍", "我的未保存草稿"); await click("保存介绍");
    await screen.findByRole("alert");
    expect(input("书籍介绍").value).toBe("我的未保存草稿");
    expect((screen.getByRole("button", { name: "保存介绍" }) as HTMLButtonElement).disabled).toBe(true);
    await click("读取最新介绍");
    expect(input("书籍介绍").value).toBe("我的未保存草稿");
    expect(await screen.findByText("另一个页面的新介绍")).toBeTruthy();
    await click("将我的草稿保存为新版本");
    expect(saveBookWorkspace).toHaveBeenLastCalledWith("book-a", { introduction: "我的未保存草稿", baseVersion: 3 }, expect.any(AbortSignal));
    expect(await screen.findByText("书籍介绍已保存。")).toBeTruthy();
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
    vi.mocked(getBookWorkspace).mockResolvedValue(workspace({ saved: true, notes: [note()] }));
    render(view()); await screen.findByRole("button", { name: "编辑笔记" });
    await click("编辑笔记"); change("笔记正文", "笔记正文 2"); await click("保存笔记");
    expect(updateBookNote).toHaveBeenCalledWith("book-a", "note-a", { title: "古道的阅读线索", content: "笔记正文 2", baseRevisionId: "revision-1" }, expect.any(AbortSignal));
    expect(getBookNoteRevision).not.toHaveBeenCalled();
    await click("查看历史版本（2）"); await click("第 1 版");
    const historical = await screen.findByRole("region", { name: "历史版本 1" });
    expect(historical.textContent).toContain("早期正文");
    expect(within(historical).queryByRole("textbox")).toBeNull();
    expect(screen.getByText("笔记正文 2")).toBeTruthy();
  });

  it("conflicted notes keep their drafts and update the base revision only after an explicit reload", async () => {
    vi.mocked(getBookWorkspace).mockResolvedValueOnce(workspace({ notes: [note()] }))
      .mockResolvedValueOnce(workspace({ notes: [note(3)] }));
    vi.mocked(updateBookNote).mockRejectedValueOnce(new LibraryApiError(409, "版本已更新"))
      .mockResolvedValueOnce(workspace({ notes: [{ ...note(4), content: "我的冲突草稿" }] }));
    render(view()); await screen.findByRole("button", { name: "编辑笔记" });
    await click("编辑笔记"); change("笔记正文", "我的冲突草稿"); await click("保存笔记");
    await screen.findByRole("alert"); expect(input("笔记正文").value).toBe("我的冲突草稿");
    await click("读取最新笔记"); expect(input("笔记正文").value).toBe("我的冲突草稿");
    await click("将我的草稿保存为新版本");
    expect(updateBookNote).toHaveBeenLastCalledWith("book-a", "note-a", expect.objectContaining({ content: "我的冲突草稿", baseRevisionId: "revision-3" }), expect.any(AbortSignal));
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
