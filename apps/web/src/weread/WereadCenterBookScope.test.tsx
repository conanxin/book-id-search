// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { Link, MemoryRouter, useLocation } from "react-router-dom";
import type { WereadNotesResponse, WereadPrivateNoteItem } from "../wereadPrivate";

const mocks = vi.hoisted(() => ({
  fetchWereadSummary: vi.fn(),
  fetchWereadTrends: vi.fn(),
  fetchWereadNotes: vi.fn(),
  fetchWereadBookNotes: vi.fn(),
  ensureAuthSessionLoaded: vi.fn(async () => {}),
}));

vi.mock("../auth/session", async (importOriginal) => ({
  ...await importOriginal<typeof import("../auth/session")>(),
  ensureAuthSessionLoaded: mocks.ensureAuthSessionLoaded,
}));
vi.mock("../auth/GoogleLoginPanel", () => ({ GoogleLoginPanel: () => <div>Google 登录入口</div> }));
vi.mock("../wereadPrivate", async (importOriginal) => ({
  ...await importOriginal<typeof import("../wereadPrivate")>(),
  fetchWereadSummary: mocks.fetchWereadSummary,
  fetchWereadTrends: mocks.fetchWereadTrends,
  fetchWereadNotes: mocks.fetchWereadNotes,
  fetchWereadBookNotes: mocks.fetchWereadBookNotes,
}));
vi.mock("./BookNotesExportButton", () => ({
  default: ({ catalogId }: { catalogId: string }) => <button data-catalog-export={catalogId}>导出本书全部笔记</button>,
}));
// The AI service is not called. This child holds temporary state and publishes
// the same theme callback as the real panel, so remount/overlay isolation is observable.
vi.mock("./NotesAiSummary", async () => {
  const { useState } = await import("react");
  return {
    default: ({ onSummaryChange }: { onSummaryChange: (value: unknown) => void }) => {
      const [ready, setReady] = useState(false);
      return <div>
        <button onClick={() => {
          setReady(true);
          onSummaryChange({
            summary: { overview: "合成概述", themes: [{ title: "前书临时主题", summary: "合成" }], keyPoints: [], questions: [], readingDirections: [] },
            itemsUsed: 1,
          });
        }}>生成合成主题</button>
        {ready ? <p>仅前书的临时 AI 内容</p> : null}
      </div>;
    },
  };
});
vi.mock("./ReadingMapDashboard", () => ({
  default: ({ sessionThemeOverlay }: { sessionThemeOverlay: unknown }) => <output data-testid="map-overlay">{JSON.stringify(sessionThemeOverlay)}</output>,
}));

const { default: WereadCenter } = await import("./WereadCenter");
const { default: NotesLibrary } = await import("./NotesLibrary");
const { __setWebAuthSnapshotForTests, __resetWebAuthStoreForTests } = await import("../auth/session");

const BOOK_A = "13000000_000000000001";
const BOOK_B = "13000000_000000000002";
const AUTHED = { status: "authenticated" as const, user: { email: "reader@example.com", name: "Reader" }, csrfToken: "synthetic-session-a", error: null };

function note(catalogId: string | null, text: string, matched = true): WereadPrivateNoteItem {
  return { catalogId, text, matched, type: "highlight", comment: null, createdAt: "2026-10-10T00:00:00Z", updatedAt: null, source: "private_weread" };
}

function response(items: WereadPrivateNoteItem[], options: { offset?: number; hasMore?: boolean } = {}): WereadNotesResponse {
  return {
    ok: true, items,
    pageInfo: { limit: 20, offset: options.offset ?? 0, total: options.hasMore ? 21 : items.length, hasMore: options.hasMore ?? false },
    summary: { totalAfterFilter: items.length, highlights: items.length, thoughts: 0, reviews: 0, unknown: 0, matchedCount: items.filter((item) => item.matched).length, unmatchedCount: items.filter((item) => !item.matched).length },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function LocationDisplay() {
  const location = useLocation();
  return <output data-testid="current-location">{location.pathname + location.search}</output>;
}

function mount(path = `/weread?catalogId=${BOOK_A}`) {
  return render(<MemoryRouter initialEntries={[path]}>
    <nav>
      <Link to={`/weread?catalogId=${BOOK_A}`}>切换到书目 A</Link>
      <Link to={`/weread?catalogId=${BOOK_B}`}>切换到书目 B</Link>
    </nav>
    <WereadCenter />
    <LocationDisplay />
  </MemoryRouter>);
}

beforeEach(() => {
  vi.clearAllMocks();
  __setWebAuthSnapshotForTests(AUTHED);
  mocks.fetchWereadSummary.mockReset().mockResolvedValue({ ok: true, dataAvailable: true, booksCount: 2, notesCount: 3, confirmedMatchesCount: 2 });
  mocks.fetchWereadTrends.mockReset().mockResolvedValue({ ok: true });
  mocks.fetchWereadNotes.mockReset().mockResolvedValue(response([]));
  mocks.fetchWereadBookNotes.mockReset().mockResolvedValue(response([note(BOOK_A, "书 A 的已确认划线")]));
});

afterEach(() => {
  cleanup();
  __resetWebAuthStoreForTests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("WeRead book scope and navigation", () => {
  it("keeps the explicit book scope visible and links back to that book", async () => {
    mount();
    expect(screen.getByRole("heading", { name: "本书笔记" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "返回书籍详情" }).getAttribute("href")).toBe(`/books/${BOOK_A}`);
    expect(screen.getByText(/本书范围仅作用于笔记/)).toBeTruthy();
    await screen.findByText("书 A 的已确认划线");
    expect(mocks.fetchWereadBookNotes).toHaveBeenCalledTimes(1);
    expect(mocks.fetchWereadBookNotes).toHaveBeenCalledWith(BOOK_A, expect.objectContaining({ days: "all", offset: 0 }), { signal: expect.any(AbortSignal) });
    expect(mocks.fetchWereadNotes).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: "查看书籍详情" }).getAttribute("href")).toBe(`/books/${BOOK_A}`);
    expect((screen.getByRole("combobox", { name: "匹配筛选" }) as HTMLSelectElement).disabled).toBe(true);
  });

  it.each(["", "not-a-book", `${BOOK_A}&catalogId=${BOOK_B}`, `${BOOK_A}&catalogId=${BOOK_A}`])(
    "fails closed for an empty, malformed or repeated scope (%s) until explicitly cleared", async (value) => {
      const user = userEvent.setup();
      mount(`/weread?catalogId=${value}&view=notes`);
      await screen.findByTestId("weread-kpi-grid");
      expect(screen.getByRole("heading", { name: "书目筛选无效" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "加载笔记" })).toBeNull();
      expect(mocks.fetchWereadNotes).not.toHaveBeenCalled();
      expect(mocks.fetchWereadBookNotes).not.toHaveBeenCalled();
      await user.click(screen.getByRole("button", { name: "清除本书筛选，查看全部笔记" }));
      expect(screen.getByTestId("current-location").textContent).toBe("/weread?view=notes");
      expect(mocks.fetchWereadNotes).not.toHaveBeenCalled();
      await user.click(screen.getByRole("button", { name: "加载笔记", exact: true }));
      await waitFor(() => expect(mocks.fetchWereadNotes).toHaveBeenCalledTimes(1));
      expect(Object.prototype.hasOwnProperty.call(mocks.fetchWereadNotes.mock.calls[0][0], "catalogId")).toBe(false);
    },
  );

  it("only offers book navigation and per-book export for confirmed, valid identifiers", async () => {
    mocks.fetchWereadNotes.mockResolvedValue(response([
      note(BOOK_A, "确认书目"), note(BOOK_B, "未确认书目", false),
      note("../../account", "非法书目标识"), note(null, "没有书目", false),
    ]));
    const user = userEvent.setup();
    mount("/weread");
    const load = await screen.findByRole("button", { name: "加载笔记", exact: true });
    expect(mocks.fetchWereadNotes).not.toHaveBeenCalled();
    await user.click(load);
    await screen.findByText("确认书目");
    const links = screen.getAllByRole("link", { name: "查看书籍详情" });
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute("href")).toBe(`/books/${BOOK_A}`);
    expect(screen.getAllByRole("button", { name: "导出本书全部笔记" })).toHaveLength(1);
  });

  it("sends a newly submitted search immediately, preserves its scope through filters and paging, and clears q correctly", async () => {
    const user = userEvent.setup();
    mocks.fetchWereadBookNotes.mockResolvedValue(response([note(BOOK_A, "当前结果")], { hasMore: true }));
    mount();
    await screen.findByText("当前结果");
    const search = await screen.findByRole("searchbox", { name: "搜索笔记" });
    await user.type(search, "  新的   搜索词  {Enter}");
    await screen.findByText("当前结果");
    expect(mocks.fetchWereadBookNotes.mock.calls[1][1].q).toBe("新的 搜索词");
    await user.selectOptions(screen.getByRole("combobox", { name: "时间范围" }), "30");
    expect(screen.queryByText("当前结果")).toBeNull();
    expect(screen.queryByRole("button", { name: "加载更多" })).toBeNull();
    expect((screen.getByRole("button", { name: "导出 Markdown" }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: "加载笔记", exact: true }));
    await screen.findByText("当前结果");
    expect(mocks.fetchWereadBookNotes.mock.calls.at(-1)?.[1]).toMatchObject({ q: "新的 搜索词", days: "30", offset: 0 });
    await user.click(screen.getByRole("button", { name: "加载更多" }));
    await waitFor(() => expect(mocks.fetchWereadBookNotes).toHaveBeenCalledTimes(4));
    expect(mocks.fetchWereadBookNotes.mock.calls[3][1]).toMatchObject({ q: "新的 搜索词", days: "30", offset: 20 });
    expect(mocks.fetchWereadBookNotes.mock.calls.every(([id]) => id === BOOK_A)).toBe(true);
    await waitFor(() => expect((screen.getByRole("button", { name: "清除搜索" }) as HTMLButtonElement).disabled).toBe(false));
    await user.click(screen.getByRole("button", { name: "清除搜索" }));
    await waitFor(() => expect(mocks.fetchWereadBookNotes).toHaveBeenCalledTimes(5));
    expect(mocks.fetchWereadBookNotes.mock.calls[4][1].q).toBeUndefined();
    expect(mocks.fetchWereadNotes).not.toHaveBeenCalled();
  });

  it("aborts an old filter request and ignores its late response after another filter loads", async () => {
    const pending = deferred<WereadNotesResponse>();
    mocks.fetchWereadBookNotes.mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(response([note(BOOK_A, "新筛选结果")]));
    const user = userEvent.setup();
    mount();
    await waitFor(() => expect(mocks.fetchWereadBookNotes).toHaveBeenCalledTimes(1));
    const oldSignal = mocks.fetchWereadBookNotes.mock.calls[0][2].signal as AbortSignal;
    await user.selectOptions(screen.getByRole("combobox", { name: "笔记类型" }), "review");
    expect(oldSignal.aborted).toBe(true);
    await user.click(screen.getByRole("button", { name: "加载笔记", exact: true }));
    await screen.findByText("新筛选结果");
    await act(async () => { pending.resolve(response([note(BOOK_A, "过时筛选结果")])); });
    expect(screen.queryByText("过时筛选结果")).toBeNull();
    expect(screen.getByText("新筛选结果")).toBeTruthy();
  });

  it("aborts a previous book request and never adds its late rows to the next book", async () => {
    const pending = deferred<WereadNotesResponse>();
    mocks.fetchWereadBookNotes.mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(response([note(BOOK_B, "书 B 的记录")]));
    const user = userEvent.setup();
    mount();
    await waitFor(() => expect(mocks.fetchWereadBookNotes).toHaveBeenCalledTimes(1));
    const oldSignal = mocks.fetchWereadBookNotes.mock.calls[0][2].signal as AbortSignal;
    await user.click(screen.getByRole("link", { name: "切换到书目 B" }));
    expect(oldSignal.aborted).toBe(true);
    await screen.findByText("书 B 的记录");
    await act(async () => { pending.resolve(response([note(BOOK_A, "迟到的书 A 记录")])); });
    expect(screen.queryByText("迟到的书 A 记录")).toBeNull();
    expect(screen.getByText("书 B 的记录")).toBeTruthy();
    expect(mocks.fetchWereadBookNotes.mock.calls[1][0]).toBe(BOOK_B);
  });

  it("clears loaded rows, search input, temporary AI and the reading-map overlay when the book changes", async () => {
    const user = userEvent.setup();
    const nextBook = deferred<WereadNotesResponse>();
    mocks.fetchWereadBookNotes.mockResolvedValueOnce(response([note(BOOK_A, "书 A 的已确认划线")]))
      .mockReturnValueOnce(nextBook.promise);
    mount();
    await screen.findByText("书 A 的已确认划线");
    await user.click(screen.getByRole("button", { name: "生成合成主题" }));
    await user.type(screen.getByRole("searchbox", { name: "搜索笔记" }), "前书输入");
    await user.click(screen.getByRole("tab", { name: "个人阅读地图" }));
    expect(screen.getByTestId("map-overlay").textContent).toContain("前书临时主题");
    await user.click(screen.getByRole("link", { name: "切换到书目 B" }));
    expect(screen.queryByText("书 A 的已确认划线")).toBeNull();
    expect(screen.queryByText("仅前书的临时 AI 内容")).toBeNull();
    expect((screen.getByRole("searchbox", { name: "搜索笔记" }) as HTMLInputElement).value).toBe("");
    expect(screen.getByTestId("map-overlay").textContent).not.toContain("前书临时主题");
    // Catalog IDs come from loaded notes, not the route. Clear A immediately,
    // then populate B only after its independently controlled request finishes.
    expect(screen.queryByText("书 B 的记录")).toBeNull();
    expect(mocks.fetchWereadBookNotes).toHaveBeenLastCalledWith(BOOK_B, expect.objectContaining({ offset: 0, q: undefined }), { signal: expect.any(AbortSignal) });
    expect(JSON.parse(screen.getByTestId("map-overlay").textContent ?? "{}")).toEqual({ enabled: false, catalogIds: [], themes: [], notesUsed: 0 });
    await act(async () => { nextBook.resolve(response([note(BOOK_B, "书 B 的记录")])); });
    await screen.findByText("书 B 的记录");
    expect(JSON.parse(screen.getByTestId("map-overlay").textContent ?? "{}")).toEqual({ enabled: false, catalogIds: [BOOK_B], themes: [], notesUsed: 1 });
  });

  it("retains the book scope in a downloaded Markdown file and its filename", async () => {
    const blobs: Blob[] = [];
    vi.stubGlobal("URL", class extends URL {
      static createObjectURL(blob: Blob) { blobs.push(blob); return "blob:synthetic-export"; }
      static revokeObjectURL() {}
    });
    const downloads: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function () { downloads.push(this.download); });
    const user = userEvent.setup();
    mount();
    await screen.findByText("书 A 的已确认划线");
    await user.click(screen.getByRole("button", { name: "导出 Markdown" }));
    expect(blobs).toHaveLength(1);
    const exported = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(blobs[0]);
    });
    expect(exported).toContain(`书目范围: 本书 (${BOOK_A})`);
    expect(exported).toContain(`/books/${BOOK_A}`);
    expect(exported).toContain("书 A 的已确认划线");
    expect(exported).not.toContain(BOOK_B);
    expect(downloads[0]).toContain(BOOK_A);
  });

  it("clears private rows and aborts pending work when the authenticated session changes", async () => {
    const pending = deferred<WereadNotesResponse>();
    mocks.fetchWereadBookNotes.mockResolvedValueOnce(response([note(BOOK_A, "上一会话笔记")], { hasMore: true }))
      .mockReturnValueOnce(pending.promise);
    const user = userEvent.setup();
    mount();
    await screen.findByText("上一会话笔记");
    await user.click(screen.getByRole("button", { name: "加载更多" }));
    const oldSignal = mocks.fetchWereadBookNotes.mock.calls[1][2].signal as AbortSignal;
    act(() => __setWebAuthSnapshotForTests({ ...AUTHED, csrfToken: "synthetic-session-b" }));
    expect(oldSignal.aborted).toBe(true);
    expect(screen.queryByText("上一会话笔记")).toBeNull();
    await act(async () => { pending.resolve(response([note(BOOK_A, "上一会话迟到笔记")])); });
    expect(screen.queryByText("上一会话迟到笔记")).toBeNull();
    act(() => __setWebAuthSnapshotForTests({ status: "unauthenticated", user: null, csrfToken: null, error: null }));
    expect(screen.queryByTestId("weread-panel-notes")).toBeNull();
    expect(screen.queryByRole("button", { name: "加载笔记" })).toBeNull();
  });

  it("replaces the aborted StrictMode first-page request without displaying its late result", async () => {
    const pending = deferred<WereadNotesResponse>();
    mocks.fetchWereadBookNotes.mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(response([note(BOOK_A, "有效自动首批")]));
    render(<StrictMode><MemoryRouter><NotesLibrary scope={{ kind: "book", catalogId: BOOK_A }} /></MemoryRouter></StrictMode>);
    await screen.findByText("有效自动首批");
    expect(mocks.fetchWereadBookNotes).toHaveBeenCalledTimes(2);
    expect((mocks.fetchWereadBookNotes.mock.calls[0][2].signal as AbortSignal).aborted).toBe(true);
    expect(mocks.fetchWereadBookNotes.mock.calls[1][1]).toMatchObject({ limit: 20, offset: 0, days: "all" });
    await act(async () => { pending.resolve(response([note(BOOK_A, "StrictMode 过时首批")])); });
    expect(screen.queryByText("StrictMode 过时首批")).toBeNull();
    expect(screen.getByText("有效自动首批")).toBeTruthy();
    expect(mocks.fetchWereadNotes).not.toHaveBeenCalled();
  });
});
