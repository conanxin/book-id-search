// @vitest-environment jsdom
import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetWebAuthStoreForTests, __setWebAuthSnapshotForTests } from "../auth/session";
import { fetchWereadBookNotes, type WereadNotesResponse, type WereadPrivateNoteItem } from "../wereadPrivate";
import { BookWereadNotes } from "./BookWereadNotes";

vi.mock("../auth/session", async original => ({ ...await original<typeof import("../auth/session")>(), ensureAuthSessionLoaded: vi.fn(async () => {}) }));
vi.mock("../wereadPrivate", async original => ({ ...await original<typeof import("../wereadPrivate")>(), fetchWereadBookNotes: vi.fn() }));

const A = "10000001_000000000001";
const B = "10000002_000000000002";
const auth = (token = "csrf-a") => ({ status: "authenticated" as const, user: { email: "owner@example.test", name: "Owner" }, csrfToken: token, error: null });
const note = (text: string, catalogId = A, type: WereadPrivateNoteItem["type"] = "highlight"): WereadPrivateNoteItem => ({
  type, text, comment: null, createdAt: "2026-10-10T10:00:00Z", updatedAt: null, matched: true, catalogId, source: "private_weread",
});
const page = (items: WereadPrivateNoteItem[] = [], offset = 0, total = items.length): WereadNotesResponse => ({
  ok: true, items, pageInfo: { limit: 20, offset, total, hasMore: offset + items.length < total },
  summary: { totalAfterFilter: total, highlights: total, thoughts: 0, reviews: 0, unknown: 0, matchedCount: total, unmatchedCount: 0 },
});
const first20 = () => Array.from({ length: 20 }, (_, i) => note(`书甲摘录 ${i + 1}`));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const view = (bookId = A) => <MemoryRouter><BookWereadNotes bookId={bookId} /></MemoryRouter>;
const click = async (name: string) => { await act(async () => { fireEvent.click(screen.getByRole("button", { name, exact: true })); }); };
const changeType = (value: string) => fireEvent.change(screen.getByRole("combobox", { name: "记录类型" }), { target: { value } });

beforeEach(() => {
  vi.resetAllMocks(); __resetWebAuthStoreForTests(); __setWebAuthSnapshotForTests(auth());
  vi.mocked(fetchWereadBookNotes).mockResolvedValue(page());
});
afterEach(() => { cleanup(); __resetWebAuthStoreForTests(); });

describe("book WeRead records", () => {
  it("loads only after Google sign-in and clears the list immediately on sign-out", async () => {
    __setWebAuthSnapshotForTests({ status: "unauthenticated", user: null, csrfToken: null, error: null });
    vi.mocked(fetchWereadBookNotes).mockResolvedValue(page([note("登录后的本书摘录")]));
    render(view());
    expect(fetchWereadBookNotes).not.toHaveBeenCalled();
    expect(screen.queryByRole("region", { name: "微信读书记录" })).toBeNull();
    act(() => __setWebAuthSnapshotForTests(auth()));
    await screen.findByText("登录后的本书摘录");
    act(() => __setWebAuthSnapshotForTests({ status: "signing_out", user: null, csrfToken: null, error: null }));
    expect(screen.queryByText("登录后的本书摘录")).toBeNull();
    expect(screen.queryByRole("region", { name: "微信读书记录" })).toBeNull();
  });

  it("shows imported text and comments, preserves legitimate duplicates, and paginates within the same book", async () => {
    const first = first20();
    first[0] = { ...note("重复摘录"), comment: "我的补充想法" };
    vi.mocked(fetchWereadBookNotes).mockResolvedValueOnce(page(first, 0, 21)).mockResolvedValueOnce(page([note("重复摘录")], 20, 21));
    render(view());
    await screen.findByText("我的补充想法");
    const region = screen.getByRole("region", { name: "微信读书记录" });
    expect(within(region).getAllByRole("article")).toHaveLength(20);
    expect(within(region).getAllByText("微信读书 · 已导入")).toHaveLength(20);
    expect(screen.getByRole("link", { name: "在微信读书中心查看本书记录" }).getAttribute("href")).toBe(`/weread?catalogId=${A}`);
    expect(fetchWereadBookNotes).toHaveBeenLastCalledWith(A, { type: "all", days: "all", sort: "newest", limit: 20, offset: 0 }, { signal: expect.any(AbortSignal) });
    await click("加载更多");
    expect(fetchWereadBookNotes).toHaveBeenLastCalledWith(A, expect.objectContaining({ offset: 20, limit: 20, type: "all" }), { signal: expect.any(AbortSignal) });
    expect(within(region).getAllByRole("article")).toHaveLength(21);
    expect(within(region).getAllByText("重复摘录")).toHaveLength(2);
    expect(screen.getByText("已显示 21 条 / 当前筛选共 21 条")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "加载更多" })).toBeNull();
  });

  it("aborts an old page and removes its list synchronously when switching record type", async () => {
    const older = deferred<WereadNotesResponse>();
    vi.mocked(fetchWereadBookNotes).mockResolvedValueOnce(page(first20(), 0, 21)).mockReturnValueOnce(older.promise)
      .mockResolvedValueOnce(page([note("这本书的书评", A, "review")]));
    render(view()); await screen.findByText("书甲摘录 1"); await click("加载更多");
    const oldSignal = vi.mocked(fetchWereadBookNotes).mock.calls[1][2]?.signal;
    changeType("review");
    expect(screen.queryByText("书甲摘录 1")).toBeNull();
    expect(oldSignal?.aborted).toBe(true);
    await screen.findByText("这本书的书评");
    expect(fetchWereadBookNotes).toHaveBeenLastCalledWith(A, expect.objectContaining({ type: "review", offset: 0 }), { signal: expect.any(AbortSignal) });
    await act(async () => older.resolve(page([note("迟到的旧筛选结果")], 20, 21)));
    expect(screen.queryByText("迟到的旧筛选结果")).toBeNull();
    expect(screen.getAllByRole("article")).toHaveLength(1);
  });

  it("ignores an old book response even when the transport does not honour cancellation", async () => {
    const older = deferred<WereadNotesResponse>();
    vi.mocked(fetchWereadBookNotes).mockReturnValueOnce(older.promise).mockResolvedValueOnce(page([note("只属于书乙", B)]));
    const { rerender } = render(view());
    const oldSignal = vi.mocked(fetchWereadBookNotes).mock.calls[0][2]?.signal;
    rerender(view(B));
    expect(oldSignal?.aborted).toBe(true);
    await screen.findByText("只属于书乙");
    await act(async () => older.resolve(page([note("迟到的书甲正文")])));
    expect(screen.queryByText("迟到的书甲正文")).toBeNull();
    expect(screen.getByRole("link", { name: "在微信读书中心查看本书记录" }).getAttribute("href")).toBe(`/weread?catalogId=${B}`);
  });

  it("discards a response from a previous authenticated session generation", async () => {
    const older = deferred<WereadNotesResponse>();
    vi.mocked(fetchWereadBookNotes).mockReturnValueOnce(older.promise).mockResolvedValueOnce(page([note("当前会话记录")]));
    render(view());
    const oldSignal = vi.mocked(fetchWereadBookNotes).mock.calls[0][2]?.signal;
    act(() => __setWebAuthSnapshotForTests(auth("csrf-b")));
    await screen.findByText("当前会话记录");
    expect(oldSignal?.aborted).toBe(true);
    await act(async () => older.resolve(page([note("上一会话记录")])));
    expect(screen.queryByText("上一会话记录")).toBeNull();
  });

  it("does not turn invalid or missing book identifiers into unscoped requests", () => {
    const { rerender } = render(view("not-a-catalog-id"));
    expect(screen.getByText("本条书目暂不支持微信读书记录关联。")).toBeTruthy();
    expect(fetchWereadBookNotes).not.toHaveBeenCalled();
    rerender(view(""));
    expect(fetchWereadBookNotes).not.toHaveBeenCalled();
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("distinguishes a failed read from an empty result and retries without echoing a response body", async () => {
    vi.mocked(fetchWereadBookNotes).mockRejectedValueOnce(new Error("private response text must not appear")).mockResolvedValueOnce(page());
    render(view()); await screen.findByRole("alert");
    expect(screen.queryByText(/private response/)).toBeNull();
    expect(screen.queryByText(/本书暂无/)).toBeNull();
    await click("重试读取记录");
    expect(await screen.findByText(/本书暂无已关联的微信读书记录/)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    changeType("thought");
    expect(await screen.findByText(/本书暂无此类微信读书记录/)).toBeTruthy();
  });

  it("keeps an already verified page on a load-more failure and retries the same next offset", async () => {
    vi.mocked(fetchWereadBookNotes).mockResolvedValueOnce(page(first20(), 0, 21)).mockRejectedValueOnce(new Error("unavailable"))
      .mockResolvedValueOnce(page([note("重试后的最后一条")], 20, 21));
    render(view()); await screen.findByText("书甲摘录 1"); await click("加载更多");
    await screen.findByRole("alert");
    expect(screen.getAllByRole("article")).toHaveLength(20);
    await click("重试读取记录");
    expect(fetchWereadBookNotes).toHaveBeenLastCalledWith(A, expect.objectContaining({ offset: 20 }), { signal: expect.any(AbortSignal) });
    expect(await screen.findByText("重试后的最后一条")).toBeTruthy();
    expect(screen.getAllByRole("article")).toHaveLength(21);
  });

  it("finishes its initial read under StrictMode after the first effect is cancelled", async () => {
    vi.mocked(fetchWereadBookNotes).mockResolvedValue(page([{ ...note(""), comment: "只有想法的记录" }]));
    render(<StrictMode>{view()}</StrictMode>);
    expect(await screen.findByText("只有想法的记录")).toBeTruthy();
    expect(screen.getAllByRole("article")).toHaveLength(1);
    expect(vi.mocked(fetchWereadBookNotes).mock.calls[0][2]?.signal?.aborted).toBe(true);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
