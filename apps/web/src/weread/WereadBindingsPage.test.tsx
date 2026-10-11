// @vitest-environment jsdom
import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Link, MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetWebAuthStoreForTests, __setWebAuthSnapshotForTests } from "../auth/session";
import {
  getWereadBinding, listWereadBindings, searchWereadBindingCatalog, updateWereadBinding,
  WereadBindingError, type WereadBindingCatalog, type WereadBindingItem,
  type WereadBindingsResponse,
} from "../wereadBindings";
import App from "../App";
import WereadBindingsPage from "./WereadBindingsPage";

vi.mock("../auth/session", async original => ({
  ...await original<typeof import("../auth/session")>(), ensureAuthSessionLoaded: vi.fn(async () => {}),
}));
vi.mock("../wereadBindings", async original => ({
  ...await original<typeof import("../wereadBindings")>(),
  listWereadBindings: vi.fn(), getWereadBinding: vi.fn(), updateWereadBinding: vi.fn(), searchWereadBindingCatalog: vi.fn(),
}));

const A: WereadBindingCatalog = { id: "10000001_000000000001", title: "目录书甲", author: "作者甲", publisher: "出版社甲", year: 2020, isbn: "9781234567897", available: true };
const B: WereadBindingCatalog = { id: "10000002_000000000002", title: "目录书乙", author: "作者乙", publisher: "出版社乙", year: 2022, isbn: "9789876543217", available: true };
const sourceA: WereadBindingItem = { sourceKey: "a".repeat(64), title: "微信读书来源甲", author: "作者甲", isbn: A.isbn, notesCount: 27, effectiveCatalog: A, importedCatalogId: A.id, origin: "imported", revision: 0, updatedAt: null };
const sourceB: WereadBindingItem = { sourceKey: "b".repeat(64), title: "微信读书来源乙", author: "作者乙", isbn: null, notesCount: 3, effectiveCatalog: null, importedCatalogId: null, origin: "none", revision: 0, updatedAt: null };
const auth = (token = "csrf-a") => ({ status: "authenticated" as const, user: { email: "owner@example.test", name: "Owner" }, csrfToken: token, error: null });
const anonymous = { status: "unauthenticated" as const, user: null, csrfToken: null, error: null };
const response = (items: WereadBindingItem[] = [sourceA, sourceB], writable = true): WereadBindingsResponse => ({
  ok: true, items, pageInfo: { limit: 20, offset: 0, total: items.length, hasMore: false }, writable,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function LocationDisplay() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname + location.search}</output>;
}
function view(path = "/weread/bindings") {
  return <MemoryRouter initialEntries={[path]}>
    <nav><Link to={`/weread/bindings?catalogId=${A.id}`}>切换到书目甲</Link><Link to={`/weread/bindings?catalogId=${B.id}`}>切换到书目乙</Link></nav>
    <WereadBindingsPage /><LocationDisplay />
  </MemoryRouter>;
}
const sourceRow = (title = sourceA.title) => screen.getByRole("article", { name: title, exact: true });
const editor = (title = sourceA.title) => screen.getByRole("region", { name: `核对《${title}》的关联`, exact: true });
const click = (name: string, root: HTMLElement = document.body) => userEvent.click(within(root).getByRole("button", { name, exact: true }));
const disabled = (name: string, root: HTMLElement = document.body) => (within(root).getByRole("button", { name, exact: true }) as HTMLButtonElement).disabled;
const searchCatalog = async (q = "目录书乙") => {
  fireEvent.change(within(editor()).getByRole("searchbox", { name: "搜索目录书籍", exact: true }), { target: { value: q } });
  await click("搜索目录", editor());
};
const chooseB = async () => { await searchCatalog(); await click(`选择《${B.title}》`, editor()); };

beforeEach(() => {
  vi.clearAllMocks(); __resetWebAuthStoreForTests(); __setWebAuthSnapshotForTests(auth());
  vi.mocked(listWereadBindings).mockReset().mockResolvedValue(response());
  vi.mocked(getWereadBinding).mockReset().mockResolvedValue(sourceA);
  vi.mocked(searchWereadBindingCatalog).mockReset().mockResolvedValue({ items: [B], total: 1, page: 1, limit: 10 });
  vi.mocked(updateWereadBinding).mockReset().mockImplementation(async (key, body) => {
    const initial = key === sourceA.sourceKey ? sourceA : sourceB;
    const saved: WereadBindingItem = {
      ...initial, revision: body.expectedRevision + 1, updatedAt: "2026-10-11T00:00:00Z",
      origin: body.action === "bind" ? "manual" : body.action === "unbind" ? "unlinked" : initial.importedCatalogId ? "imported" : "none",
      effectiveCatalog: body.action === "bind" ? (body.catalogId === A.id ? A : B) : body.action === "unbind" ? null : initial.importedCatalogId ? A : null,
    };
    vi.mocked(listWereadBindings).mockResolvedValue(response([saved]));
    return saved;
  });
});
afterEach(() => { cleanup(); __resetWebAuthStoreForTests(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("WeRead manual binding management", () => {
  it("protects the actual route with Google sign-in and resumes the full requested scope", async () => {
    __setWebAuthSnapshotForTests(anonymous);
    const fetchSpy = vi.fn(); vi.stubGlobal("fetch", fetchSpy);
    const path = `/weread/bindings?catalogId=${A.id}&status=matched`;
    render(<MemoryRouter initialEntries={[path]}><App /></MemoryRouter>);
    expect(screen.getByRole("heading", { name: "登录后，继续整理这本书与阅读资料", level: 1 })).toBeTruthy();
    expect(screen.getByRole("link", { name: "使用 Google 登录", exact: true }).getAttribute("href")).toBe(`/account?returnTo=${encodeURIComponent(path)}`);
    expect(listWereadBindings).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    act(() => __setWebAuthSnapshotForTests(auth()));
    await screen.findByRole("article", { name: sourceA.title, exact: true });
    expect(listWereadBindings).toHaveBeenCalledWith(expect.objectContaining({ catalogId: A.id, status: "matched" }), { signal: expect.any(AbortSignal) });
  });

  it.each(["", "not-a-book", `${A.id}&catalogId=${B.id}`, `${A.id}&catalogId=${A.id}`])(
    "does not turn an explicit invalid scope into all sources (%s)", async value => {
      render(view(`/weread/bindings?catalogId=${value}`));
      expect(screen.getByRole("heading", { name: "书目筛选无效" })).toBeTruthy();
      expect(listWereadBindings).not.toHaveBeenCalled();
      await click("清除本书筛选，查看全部来源书");
      await screen.findByRole("article", { name: sourceA.title, exact: true });
      expect(Object.hasOwn(vi.mocked(listWereadBindings).mock.calls[0][0]!, "catalogId")).toBe(false);
      expect(screen.getByTestId("location").textContent).toBe("/weread/bindings");
    },
  );

  it("preserves book scope through search, status and pagination, and clears it explicitly", async () => {
    vi.mocked(listWereadBindings).mockImplementation(async query => ({
      ...response([sourceA]), pageInfo: { limit: 20, offset: query?.offset ?? 0, total: 21, hasMore: !query?.offset },
    }));
    render(view(`/weread/bindings?catalogId=${A.id}&q=甲&status=matched`));
    await screen.findByRole("article", { name: sourceA.title, exact: true });
    expect(screen.getByRole("region", { name: "本书关联范围" }).textContent).toContain(A.id);
    expect(screen.getByRole("link", { name: "返回书籍详情" }).getAttribute("href")).toBe(`/books/${A.id}`);
    await click("下一页", screen.getByRole("navigation", { name: "来源书分页" }));
    await waitFor(() => expect(listWereadBindings).toHaveBeenLastCalledWith({ q: "甲", status: "matched", catalogId: A.id, limit: 20, offset: 20 }, { signal: expect.any(AbortSignal) }));
    fireEvent.change(screen.getByRole("searchbox", { name: "查找微信读书来源书" }), { target: { value: "作者甲" } });
    await click("查找来源书");
    await waitFor(() => expect(listWereadBindings).toHaveBeenLastCalledWith(expect.objectContaining({ q: "作者甲", catalogId: A.id, status: "matched", offset: 0 }), { signal: expect.any(AbortSignal) }));
    fireEvent.change(screen.getByRole("combobox", { name: "关联状态" }), { target: { value: "manual" } });
    await waitFor(() => expect(listWereadBindings).toHaveBeenLastCalledWith(expect.objectContaining({ q: "作者甲", catalogId: A.id, status: "manual", offset: 0 }), { signal: expect.any(AbortSignal) }));
    await click("清除本书筛选，查看全部来源书");
    await waitFor(() => expect(listWereadBindings).toHaveBeenLastCalledWith({ q: "作者甲", status: "manual", limit: 20, offset: 0 }, { signal: expect.any(AbortSignal) }));
    expect(screen.queryByRole("region", { name: "本书关联范围" })).toBeNull();
  });

  it("shows read-only source metadata with every write entry disabled", async () => {
    vi.mocked(listWereadBindings).mockResolvedValue(response([sourceA, sourceB], false));
    render(view()); await screen.findByRole("article", { name: sourceA.title, exact: true });
    expect(disabled("确认现有关联", sourceRow())).toBe(true);
    expect(disabled("更换关联", sourceRow())).toBe(true);
    expect(disabled("解除关联", sourceRow())).toBe(true);
    expect(disabled("关联目录书籍", sourceRow(sourceB.title))).toBe(true);
    expect(screen.getByText(/当前来源书可以查看，关联设置暂时无法保存/)).toBeTruthy();
    expect(updateWereadBinding).not.toHaveBeenCalled();
  });

  it("requires an explicit confirmation when keeping the current imported target", async () => {
    render(view()); await screen.findByRole("article", { name: sourceA.title, exact: true });
    await click("确认现有关联", sourceRow());
    expect(within(editor()).getByText("准备关联的目录书籍")).toBeTruthy();
    expect(document.activeElement).toBe(within(editor()).getByRole("heading", { name: `核对《${sourceA.title}》的关联`, level: 2 }));
    expect(updateWereadBinding).not.toHaveBeenCalled();
    expect(searchWereadBindingCatalog).not.toHaveBeenCalled();
    await click("确认关联", editor());
    expect(updateWereadBinding).toHaveBeenCalledWith(sourceA.sourceKey, { action: "bind", catalogId: A.id, expectedRevision: 0 }, { signal: expect.any(AbortSignal) });
    await screen.findByText(`《${sourceA.title}》的关联已保存。`);
    expect(within(sourceRow()).getByText("手动确认")).toBeTruthy();
    expect(screen.queryByRole("region", { name: `核对《${sourceA.title}》的关联` })).toBeNull();
  });

  it("searches public catalog metadata, compares versions, and saves only the selected target", async () => {
    render(view()); await screen.findByRole("article", { name: sourceA.title, exact: true });
    await click("更换关联", sourceRow());
    await chooseB();
    expect(searchWereadBindingCatalog).toHaveBeenCalledWith("目录书乙", 1, 10, { signal: expect.any(AbortSignal) });
    expect(within(within(editor()).getByRole("article", { name: `目录候选：${B.title}` })).getByText(/出版社乙 · 2022/)).toBeTruthy();
    expect(updateWereadBinding).not.toHaveBeenCalled();
    await click("确认更换", editor());
    expect(updateWereadBinding).toHaveBeenCalledWith(sourceA.sourceKey, { action: "bind", catalogId: B.id, expectedRevision: 0 }, { signal: expect.any(AbortSignal) });
    await screen.findByText(`《${sourceA.title}》的关联已保存。`);
    expect(within(sourceRow()).getByRole("link", { name: B.title, exact: true }).getAttribute("href")).toBe(`/books/${B.id}`);
    expect(within(sourceRow()).queryByRole("link", { name: A.title, exact: true })).toBeNull();
  });

  it("keeps unlink and restore as separate confirmed actions without a catalogId in either write", async () => {
    render(view()); await screen.findByRole("article", { name: sourceA.title, exact: true });
    await click("解除关联", sourceRow());
    expect(updateWereadBinding).not.toHaveBeenCalled();
    expect(within(editor()).getByText(/已导入的划线、想法和书评会保留/)).toBeTruthy();
    await click("确认解除", editor());
    expect(updateWereadBinding).toHaveBeenLastCalledWith(sourceA.sourceKey, { action: "unbind", expectedRevision: 0 }, { signal: expect.any(AbortSignal) });
    await screen.findByText("已手动解除，后续导入不会自动恢复。");
    expect(within(sourceRow()).queryByRole("link", { name: A.title, exact: true })).toBeNull();
    await click("恢复导入匹配", sourceRow());
    expect(updateWereadBinding).toHaveBeenCalledTimes(1);
    expect(within(editor()).getByRole("link", { name: "查看导入匹配的目录书籍" }).getAttribute("href")).toBe(`/books/${A.id}`);
    await click("确认恢复", editor());
    expect(updateWereadBinding).toHaveBeenLastCalledWith(sourceA.sourceKey, { action: "restore", expectedRevision: 1 }, { signal: expect.any(AbortSignal) });
    await screen.findByText(`《${sourceA.title}》已恢复使用导入匹配。`);
    expect(within(sourceRow()).getByText("导入匹配")).toBeTruthy();
  });

  it("preserves a chosen target after a failed save and never displays the raw failure", async () => {
    vi.mocked(updateWereadBinding).mockRejectedValueOnce(new Error("private database failure payload"));
    render(view()); await screen.findByRole("article", { name: sourceA.title, exact: true });
    await click("更换关联", sourceRow()); await chooseB(); await click("确认更换", editor());
    expect(await within(editor()).findByRole("alert")).toBeTruthy();
    expect(within(editor()).getByText(/将微信读书来源《微信读书来源甲》关联到《目录书乙》/)).toBeTruthy();
    expect(within(sourceRow()).getByText("导入匹配")).toBeTruthy();
    expect(screen.queryByText(/private database/)).toBeNull();
    expect(screen.queryByText(/的关联已保存/)).toBeNull();
    expect(disabled("确认更换", editor())).toBe(false);
    await click("确认更换", editor());
    expect(updateWereadBinding).toHaveBeenCalledTimes(2);
    await screen.findByText(`《${sourceA.title}》的关联已保存。`);
  });

  it("keeps the candidate across a conflict and requires rereading then a second explicit confirmation", async () => {
    vi.mocked(updateWereadBinding).mockRejectedValueOnce(new WereadBindingError(409, "conflict"));
    const latest: WereadBindingItem = { ...sourceA, origin: "unlinked", effectiveCatalog: null, revision: 4 };
    vi.mocked(getWereadBinding).mockResolvedValue(latest);
    render(view()); await screen.findByRole("article", { name: sourceA.title, exact: true });
    await click("更换关联", sourceRow()); await chooseB(); await click("确认更换", editor());
    expect(await within(editor()).findByText(/当前候选已保留，请先读取最新关联/)).toBeTruthy();
    expect(disabled("确认更换", editor())).toBe(true);
    expect(getWereadBinding).not.toHaveBeenCalled();
    vi.mocked(listWereadBindings).mockResolvedValue(response([])); // The source may leave the active filter after another page changes it.
    await click("读取最新关联", editor());
    await within(editor()).findByText(/已读取最新关联/);
    expect(getWereadBinding).toHaveBeenCalledWith(sourceA.sourceKey, { signal: expect.any(AbortSignal) });
    expect(within(editor()).getByText("当前未关联目录书籍。")).toBeTruthy();
    expect(within(editor()).getByText(/将微信读书来源《微信读书来源甲》关联到《目录书乙》/)).toBeTruthy();
    expect(updateWereadBinding).toHaveBeenCalledTimes(1);
    await click("确认关联", editor());
    expect(updateWereadBinding).toHaveBeenLastCalledWith(sourceA.sourceKey, { action: "bind", catalogId: B.id, expectedRevision: 4 }, { signal: expect.any(AbortSignal) });
    await screen.findByText(`《${sourceA.title}》的关联已保存。`);
  });

  it("cancels catalog search when the draft changes and does not reuse a late query for pagination", async () => {
    const older = deferred<Awaited<ReturnType<typeof searchWereadBindingCatalog>>>();
    vi.mocked(searchWereadBindingCatalog).mockReturnValueOnce(older.promise)
      .mockResolvedValueOnce({ items: [B], total: 11, page: 1, limit: 10 })
      .mockResolvedValueOnce({ items: [A], total: 11, page: 2, limit: 10 });
    render(view()); await screen.findByRole("article", { name: sourceA.title, exact: true });
    await click("更换关联", sourceRow()); await searchCatalog("旧搜索");
    const olderSignal = vi.mocked(searchWereadBindingCatalog).mock.calls[0][3]?.signal;
    fireEvent.change(within(editor()).getByRole("searchbox", { name: "搜索目录书籍" }), { target: { value: "新搜索" } });
    expect(olderSignal?.aborted).toBe(true);
    await click("搜索目录", editor());
    await within(editor()).findByRole("button", { name: `选择《${B.title}》` });
    await act(async () => older.resolve({ items: [{ ...A, title: "迟到的旧目录候选" }], total: 99, page: 1, limit: 10 }));
    expect(screen.queryByText("迟到的旧目录候选")).toBeNull();
    await click("下一页", within(editor()).getByRole("navigation", { name: "目录候选分页" }));
    expect(searchWereadBindingCatalog).toHaveBeenLastCalledWith("新搜索", 2, 10, { signal: expect.any(AbortSignal) });
    await within(editor()).findByRole("button", { name: `选择《${A.title}》` });
  });

  it("cancels and hides an old source editor when another source is opened", async () => {
    const older = deferred<Awaited<ReturnType<typeof searchWereadBindingCatalog>>>();
    vi.mocked(searchWereadBindingCatalog).mockReturnValueOnce(older.promise);
    render(view()); await screen.findByRole("article", { name: sourceA.title, exact: true });
    await click("更换关联", sourceRow()); await searchCatalog("前一本候选");
    const oldSignal = vi.mocked(searchWereadBindingCatalog).mock.calls[0][3]?.signal;
    await click("关联目录书籍", sourceRow(sourceB.title));
    expect(oldSignal?.aborted).toBe(true);
    expect(screen.queryByRole("region", { name: `核对《${sourceA.title}》的关联` })).toBeNull();
    await act(async () => older.resolve({ items: [{ ...A, title: "旧来源的搜索结果" }], total: 1, page: 1, limit: 10 }));
    expect(screen.queryByText("旧来源的搜索结果")).toBeNull();
    expect(within(editor(sourceB.title)).queryByText("准备关联的目录书籍")).toBeNull();
    expect(disabled("确认关联", editor(sourceB.title))).toBe(true);
  });

  it("aborts an in-flight mutation on book-scope change and ignores a transport that still resolves", async () => {
    const older = deferred<WereadBindingItem>();
    vi.mocked(updateWereadBinding).mockReturnValueOnce(older.promise);
    vi.mocked(listWereadBindings).mockResolvedValueOnce(response([sourceA])).mockResolvedValueOnce(response([sourceB]));
    render(view(`/weread/bindings?catalogId=${A.id}`)); await screen.findByRole("article", { name: sourceA.title, exact: true });
    await click("确认现有关联", sourceRow()); await click("确认关联", editor());
    const oldSignal = vi.mocked(updateWereadBinding).mock.calls[0][2]?.signal;
    await userEvent.click(screen.getByRole("link", { name: "切换到书目乙" }));
    expect(oldSignal?.aborted).toBe(true);
    expect(screen.queryByRole("article", { name: sourceA.title, exact: true })).toBeNull();
    expect(screen.queryByRole("region", { name: `核对《${sourceA.title}》的关联` })).toBeNull();
    await screen.findByRole("article", { name: sourceB.title, exact: true });
    await act(async () => older.resolve({ ...sourceA, origin: "manual", revision: 1 }));
    expect(screen.queryByText(`《${sourceA.title}》的关联已保存。`)).toBeNull();
    expect(listWereadBindings).toHaveBeenCalledTimes(2);
  });

  it("removes old source data and cancels requests during logout and authenticated session rotation", async () => {
    const oldSearch = deferred<Awaited<ReturnType<typeof searchWereadBindingCatalog>>>();
    vi.mocked(searchWereadBindingCatalog).mockReturnValueOnce(oldSearch.promise);
    render(view()); await screen.findByRole("article", { name: sourceA.title, exact: true });
    await click("更换关联", sourceRow()); await searchCatalog("私有候选");
    const searchSignal = vi.mocked(searchWereadBindingCatalog).mock.calls[0][3]?.signal;
    act(() => __setWebAuthSnapshotForTests(anonymous));
    expect(searchSignal?.aborted).toBe(true);
    expect(screen.queryByRole("article")).toBeNull();
    expect(screen.queryByText(sourceA.title)).toBeNull();
    await act(async () => oldSearch.resolve({ items: [B], total: 1, page: 1, limit: 10 }));
    expect(screen.queryByText(B.title)).toBeNull();

    const oldList = deferred<WereadBindingsResponse>();
    vi.mocked(listWereadBindings).mockReturnValueOnce(oldList.promise).mockResolvedValueOnce(response([sourceB]));
    act(() => __setWebAuthSnapshotForTests(auth("csrf-b")));
    const oldSignal = vi.mocked(listWereadBindings).mock.calls.at(-1)?.[1]?.signal;
    act(() => __setWebAuthSnapshotForTests(auth("csrf-c")));
    expect(oldSignal?.aborted).toBe(true);
    await screen.findByRole("article", { name: sourceB.title, exact: true });
    await act(async () => oldList.resolve(response([sourceA])));
    expect(screen.queryByRole("article", { name: sourceA.title, exact: true })).toBeNull();
  });

  it("completes the initial list under StrictMode after its first request is cancelled", async () => {
    render(<StrictMode>{view()}</StrictMode>);
    await screen.findByRole("article", { name: sourceA.title, exact: true });
    expect(vi.mocked(listWereadBindings).mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(screen.getAllByRole("article")).toHaveLength(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
