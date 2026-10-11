// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { LibraryPage } from "./LibraryPage";
import { __resetWebAuthStoreForTests, __setWebAuthSnapshotForTests } from "../auth/session";
import { LibraryApiError, listLibrary, type LibraryItem, type LibraryResult } from "./api";

vi.mock("../auth/session", async importOriginal => ({ ...await importOriginal<typeof import("../auth/session")>(), ensureAuthSessionLoaded: vi.fn(async () => {}) }));
vi.mock("./api", async importOriginal => ({ ...await importOriginal<typeof import("./api")>(), listLibrary: vi.fn() }));

const item: LibraryItem = { bookId: "book-a", editionId: "edition-a", title: "中国古代旅行之研究", author: "江绍原", publisher: "出版社", year: "1936", introductionExcerpt: "与古代旅行相关的资料和笔记", noteCount: 2, resourceCount: 1, updatedAt: "2026-10-11T02:00:00Z" };
const result = (overrides: Partial<LibraryResult> = {}): LibraryResult => ({ items: [item], total: 1, page: 1, limit: 24, ...overrides });
const auth = (csrf = "csrf-a") => ({ status: "authenticated" as const, user: { email: "owner@example.test", name: "Owner" }, csrfToken: csrf, error: null });
function Navigation() {
  const location = useLocation(); const navigate = useNavigate();
  return <><output aria-label="当前地址">{location.pathname}{location.search}{location.hash}</output><button onClick={() => navigate(-1)}>浏览器后退</button></>;
}
const view = (entry = "/library") => <MemoryRouter initialEntries={[entry]}><LibraryPage /><Navigation /></MemoryRouter>;
async function click(name: string) { await act(async () => { fireEvent.click(screen.getByRole("button", { name, exact: true })); }); }

beforeEach(() => {
  vi.clearAllMocks(); __resetWebAuthStoreForTests(); __setWebAuthSnapshotForTests(auth());
  vi.mocked(listLibrary).mockResolvedValue(result());
});
afterEach(() => { cleanup(); __resetWebAuthStoreForTests(); });

describe("my books collection", () => {
  it("shows persisted book summaries and the same detail links as search", async () => {
    render(view());
    const link = await screen.findByRole("link", { name: item.title });
    expect(link.getAttribute("href")).toBe("/books/book-a");
    expect(screen.getByText("2 篇笔记")).toBeTruthy();
    expect(screen.getByText("1 个电子版本")).toBeTruthy();
    expect(screen.getByText(item.introductionExcerpt)).toBeTruthy();
    expect(listLibrary).toHaveBeenCalledWith({ page: 1, limit: 24, q: "", filter: "all" }, expect.any(AbortSignal));
    fireEvent.change(screen.getByLabelText("在我的书籍中查找"), { target: { value: "旅行" } });
    await click("查找");
    expect(await screen.findByText(item.introductionExcerpt)).toBeTruthy();
    expect(screen.queryByRole("link", { name: "查看这篇笔记" })).toBeNull();
    expect(screen.queryByRole("link", { name: "查看介绍" })).toBeNull();
  });

  it("shows the matching note excerpt and constructs a local link from the book and note ids", async () => {
    vi.mocked(listLibrary).mockResolvedValue(result({ items: [{ ...item, bookId: "book/a", searchMatch: {
      kind: "note", noteId: "note/a", noteTitle: "山口与古道的考察笔记", excerpt: "…山口附近保留了旧路，需要核对地方志。",
    } }] }));
    render(view("/library?q=山口&filter=notes"));
    const link = await screen.findByRole("link", { name: "查看这篇笔记", exact: true });
    expect(screen.getByText("笔记命中")).toBeTruthy();
    expect(screen.getByText("山口与古道的考察笔记")).toBeTruthy();
    expect(screen.getByText("…山口附近保留了旧路，需要核对地方志。")).toBeTruthy();
    expect(screen.queryByText(item.introductionExcerpt)).toBeNull();
    expect(link.getAttribute("href")).toBe("/books/book%2Fa#book-note-note%2Fa");
    await act(async () => { fireEvent.click(link); });
    expect(screen.getByLabelText("当前地址").textContent).toBe("/books/book%2Fa#book-note-note%2Fa");
    await click("浏览器后退");
    expect(screen.getByLabelText("当前地址").textContent).toBe("/library?q=山口&filter=notes");
  });

  it("shows an introduction hit with its exact excerpt and a direct introduction link", async () => {
    vi.mocked(listLibrary).mockResolvedValue(result({ items: [{ ...item, searchMatch: {
      kind: "introduction", excerpt: `…介绍后半部分谈及沿途驿站和道路。
第二行仍作为纯文本展示。`,
    } }] }));
    render(view("/library?q=驿站"));
    const link = await screen.findByRole("link", { name: "查看介绍", exact: true });
    expect(screen.getByText("介绍命中")).toBeTruthy();
    expect(link.getAttribute("href")).toBe("/books/book-a#library-introduction-heading");
    expect(screen.getByText(/介绍后半部分谈及沿途驿站和道路/).textContent).toContain("第二行仍作为纯文本展示。");
    expect(screen.queryByRole("link", { name: "查看这篇笔记" })).toBeNull();
  });

  it("does not query before login and immediately removes cards on logout", async () => {
    __setWebAuthSnapshotForTests({ status: "unauthenticated", user: null, csrfToken: null, error: null });
    render(view()); expect(listLibrary).not.toHaveBeenCalled();
    act(() => __setWebAuthSnapshotForTests(auth())); await screen.findByRole("link", { name: item.title });
    act(() => __setWebAuthSnapshotForTests({ status: "signing_out", user: null, csrfToken: null, error: null }));
    expect(screen.queryByRole("link", { name: item.title })).toBeNull();
  });

  it("encodes filters in navigation, resets page for a search, and supports browser back", async () => {
    vi.mocked(listLibrary).mockImplementation(async input => result({ page: input.page, total: 50 }));
    render(view("/library?page=2&filter=notes")); await screen.findByRole("link", { name: item.title });
    fireEvent.change(screen.getByLabelText("在我的书籍中查找"), { target: { value: "旅行" } });
    await click("查找");
    await waitFor(() => expect(listLibrary).toHaveBeenLastCalledWith({ page: 1, limit: 24, q: "旅行", filter: "notes" }, expect.any(AbortSignal)));
    expect(screen.getByLabelText("当前地址").textContent).toContain("filter=notes");
    expect(screen.getByLabelText("当前地址").textContent).not.toContain("page=2");
    await click("浏览器后退");
    await waitFor(() => expect(listLibrary).toHaveBeenLastCalledWith({ page: 2, limit: 24, q: "", filter: "notes" }, expect.any(AbortSignal)));
    expect((screen.getByLabelText("在我的书籍中查找") as HTMLInputElement).value).toBe("");
  });

  it("paginates without losing current search and content filter", async () => {
    vi.mocked(listLibrary).mockImplementation(async input => result({ page: input.page, total: 49 }));
    render(view("/library?q=古道&filter=resources")); await screen.findByRole("button", { name: "下一页" });
    await click("下一页");
    await waitFor(() => expect(listLibrary).toHaveBeenLastCalledWith({ page: 2, limit: 24, q: "古道", filter: "resources" }, expect.any(AbortSignal)));
    expect(await screen.findByText("第 2 / 3 页")).toBeTruthy();
  });

  it("hides stale results as soon as a filter changes and ignores the old result", async () => {
    let finish!: (value: LibraryResult) => void;
    vi.mocked(listLibrary).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }))
      .mockResolvedValueOnce(result({ items: [{ ...item, bookId: "notes-book", title: "有笔记的新结果" }] }));
    render(view()); await waitFor(() => expect(listLibrary).toHaveBeenCalledOnce());
    const signal = vi.mocked(listLibrary).mock.calls[0][1]!;
    fireEvent.change(screen.getByLabelText("内容筛选"), { target: { value: "notes" } });
    expect(signal.aborted).toBe(true);
    await screen.findByRole("link", { name: "有笔记的新结果" });
    await act(async () => finish(result()));
    expect(screen.queryByRole("link", { name: item.title })).toBeNull();
  });

  it("distinguishes a failed read from an empty collection and retries", async () => {
    vi.mocked(listLibrary).mockRejectedValueOnce(new LibraryApiError(503, "书籍服务暂不可用")).mockResolvedValueOnce(result({ items: [], total: 0 }));
    render(view()); await screen.findByRole("alert");
    expect(screen.queryByText("从一本想继续读的书开始")).toBeNull();
    await click("重新读取书籍");
    expect(await screen.findByRole("link", { name: "去搜一本书" })).toBeTruthy();
  });

  it("offers the first page when deletions leave an old page empty", async () => {
    vi.mocked(listLibrary).mockResolvedValueOnce(result({ items: [], total: 1, page: 2 }));
    render(view("/library?page=2")); await screen.findByRole("button", { name: "返回第一页" });
    await click("返回第一页");
    await waitFor(() => expect(listLibrary).toHaveBeenLastCalledWith({ page: 1, limit: 24, q: "", filter: "all" }, expect.any(AbortSignal)));
  });

  it("clears current account results while a new auth generation loads", async () => {
    render(view()); await screen.findByRole("link", { name: item.title });
    let finish!: (value: LibraryResult) => void;
    vi.mocked(listLibrary).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    act(() => __setWebAuthSnapshotForTests(auth("csrf-b")));
    expect(screen.queryByRole("link", { name: item.title })).toBeNull();
    await act(async () => finish(result({ items: [], total: 0 })));
    expect(await screen.findByRole("link", { name: "去搜一本书" })).toBeTruthy();
  });
});
