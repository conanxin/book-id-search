// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Link, MemoryRouter, useLocation } from "react-router-dom";
import { __resetWebAuthStoreForTests, __setWebAuthSnapshotForTests } from "./auth/session";

const mocks = vi.hoisted(() => ({
  getBook: vi.fn(),
  getRelatedBooks: vi.fn(),
  getStats: vi.fn(),
  searchBooks: vi.fn(),
  fetchWereadStatus: vi.fn(),
  feature: { enabled: true },
}));
vi.mock("./auth/session", async importOriginal => {
  const actual = await importOriginal<typeof import("./auth/session")>();
  return { ...actual, ensureAuthSessionLoaded: vi.fn(async () => {}) };
});
vi.mock("./research/ProjectsPage", () => ({
  get researchEnabled() { return mocks.feature.enabled; },
  default: () => <div>项目页</div>,
}));
vi.mock("./research/BookDetailResearchActions", () => ({
  BookDetailResearchActions: ({ bookId }: { bookId: string }) =>
    <div data-testid="detail-research-action">当前书目研究操作：{bookId}</div>,
}));
vi.mock("./research/SearchMemberships", () => ({
  useSearchMemberships: () => ({ memberships: {}, state: "unauthenticated", refresh: vi.fn() }),
  ResearchMembershipChips: () => null,
}));
vi.mock("./BookInsight", () => ({ default: () => null }));
vi.mock("./library/BookWorkspace", () => ({ BookWorkspace: ({ bookId }: { bookId: string }) => <div>本书内容：{bookId}</div> }));
vi.mock("./api", () => ({
  getBook: mocks.getBook,
  getRelatedBooks: mocks.getRelatedBooks,
  getStats: mocks.getStats,
  searchBooks: mocks.searchBooks,
  getBookInsight: vi.fn(async () => ({ hasInsight: false })),
  searchAiIntent: vi.fn(async () => ({ intent: "", keywords: [], refinements: [] })),
  getAiStatus: vi.fn(async () => ({ enabled: false })),
}));
vi.mock("./wereadPrivate", async importOriginal => {
  const actual = await importOriginal<typeof import("./wereadPrivate")>();
  return { ...actual, fetchWereadStatus: mocks.fetchWereadStatus,
    fetchWereadStatusesForBooks: vi.fn(async () => ({})),
    clearWereadStatusCache: vi.fn(),
    purgeLegacyWereadTokenStorage: vi.fn(),
  };
});
const { default: App } = await import("./App");
const book = (id: string, title: string) => ({
  id, title, author: "作者", publisher: "出版者", year: 2024,
  pages: 123, ssid: "SS", dxid: "DX", isbn: "9780000000012", rawInfo: "RAW",
  parseStatus: "ok" as const, parseWarnings: [],
});
const A = book("book-a", "图书甲");
const B = book("book-b", "图书乙");
const C = book("book-c", "图书丙");
const D = book("book-d", "图书丁");

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(finish => { resolve = finish; });
  return { promise, resolve };
}

beforeEach(() => {
  __resetWebAuthStoreForTests();
  vi.clearAllMocks();
  mocks.feature.enabled = true;
  __setWebAuthSnapshotForTests({ status: "authenticated", user: { email: "owner@example.com", name: "Owner" }, csrfToken: "route-test-csrf", error: null });
  mocks.getBook.mockReset().mockImplementation(async (id: string) => ({ item: id === "book-b" ? B : A }));
  mocks.getRelatedBooks.mockReset().mockResolvedValue({ total: 0, items: [] });
  mocks.fetchWereadStatus.mockResolvedValue({ ok: true, matched: false });
  mocks.getStats.mockResolvedValue({ numberOfDocuments: 2 });
  mocks.searchBooks.mockResolvedValue({ total: 0, page: 1, limit: 20, items: [] });
});
afterEach(() => { cleanup(); __resetWebAuthStoreForTests(); });

function CurrentLocation() {
  const location = useLocation();
  return <output aria-label="当前页面地址">{location.pathname}{location.search}{location.hash}</output>;
}
function mountAt(path = "/books/book-a") {
  return render(<MemoryRouter initialEntries={[path]}>
    <Link to="/books/book-b">切换到图书乙</Link>
    <App />
    <CurrentLocation />
  </MemoryRouter>);
}

describe("P1-A Book Detail route integration", () => {
  it("renders one current-edition research action after authoritative main book loads", async () => {
    mountAt();
    expect((await screen.findByTestId("detail-research-action")).textContent).toContain("book-a");
    expect(screen.getByRole("heading", { name: "图书甲" })).toBeTruthy();
    expect(mocks.getBook).toHaveBeenCalledWith("book-a");
  });

  it("does not leave Book A research action visible on route B while B is still pending", async () => {
    let finishB!: (value: { item: typeof B }) => void;
    mocks.getBook.mockImplementation((id: string) => id === "book-a"
      ? Promise.resolve({ item: A })
      : new Promise(resolve => { finishB = resolve; }));
    mountAt();
    expect((await screen.findByTestId("detail-research-action")).textContent).toContain("book-a");
    await userEvent.click(screen.getByRole("link", { name: "切换到图书乙" }));
    expect(screen.queryByText("当前书目研究操作：book-a")).toBeNull();
    await act(async () => finishB({ item: B }));
    expect((await screen.findByTestId("detail-research-action")).textContent).toContain("book-b");
    expect(screen.queryByRole("heading", { name: "图书甲" })).toBeNull();
  });

  it("shows the main book and research action when unrelated-book discovery fails", async () => {
    mocks.getRelatedBooks.mockRejectedValueOnce(new Error("auxiliary service unavailable"));
    mountAt();
    expect(await screen.findByRole("heading", { name: "图书甲" })).toBeTruthy();
    expect(screen.getByTestId("detail-research-action").textContent).toContain("book-a");
    expect(await screen.findByText(/相关图书暂时无法加载/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "重试相关图书" }));
    await waitFor(() => expect(mocks.getRelatedBooks).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("heading", { name: "图书甲" })).toBeTruthy();
  });

  it("keeps the signed-in book page readable with the research feature switched off", async () => {
    mocks.feature.enabled = false;
    mountAt();
    expect(await screen.findByRole("heading", { name: "图书甲" })).toBeTruthy();
    expect(screen.queryByTestId("detail-research-action")).toBeNull();
    expect(screen.getByText("RAW")).toBeTruthy();
  });

  it("requires Google before any detail request, then resumes the same book after sign-in", async () => {
    __setWebAuthSnapshotForTests({ status: "unauthenticated", user: null, csrfToken: null, error: null });
    mountAt();
    expect(screen.getByRole("link", { name: "使用 Google 登录" }).getAttribute("href")).toBe("/account?returnTo=%2Fbooks%2Fbook-a");
    expect(mocks.getBook).not.toHaveBeenCalled();
    expect(mocks.getRelatedBooks).not.toHaveBeenCalled();
    expect(mocks.fetchWereadStatus).not.toHaveBeenCalled();
    await act(async () => __setWebAuthSnapshotForTests({ status: "authenticated", user: { email: "owner@example.com" }, csrfToken: "new-session", error: null }));
    expect(await screen.findByRole("heading", { name: "图书甲" })).toBeTruthy();
    expect(screen.getByText("本书内容：book-a")).toBeTruthy();
    await act(async () => __setWebAuthSnapshotForTests({ status: "unauthenticated", user: null, csrfToken: null, error: null }));
    expect(screen.queryByText("本书内容：book-a")).toBeNull();
    expect(screen.queryByRole("heading", { name: "图书甲" })).toBeNull();
  });

  it("keeps the AI route through sign-in and hides the ordinary results section", async () => {
    __setWebAuthSnapshotForTests({ status: "unauthenticated", user: null, csrfToken: null, error: null });
    mountAt("/");
    await userEvent.click(screen.getByRole("tab", { name: "AI 找书" }));
    expect(screen.getByRole("link", { name: "使用 Google 登录" }).getAttribute("href")).toContain("%3Fmode%3Dai");
    expect(screen.queryByText("等待搜索")).toBeNull();
    await userEvent.click(screen.getByRole("tab", { name: "普通搜索" }));
    expect(screen.getByRole("search")).toBeTruthy();
  });

  it("preserves the content fragment in both Google login links and resumes it after sign-in", async () => {
    __setWebAuthSnapshotForTests({ status: "unauthenticated", user: null, csrfToken: null, error: null });
    const destination = "/books/book-a?from=library#book-note-note-a";
    mountAt(destination);
    const loginUrl = `/account?returnTo=${encodeURIComponent(destination)}`;
    expect(screen.getByRole("link", { name: "Google 登录", exact: true }).getAttribute("href")).toBe(loginUrl);
    expect(screen.getByRole("link", { name: "使用 Google 登录", exact: true }).getAttribute("href")).toBe(loginUrl);
    expect(mocks.getBook).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("link", { name: "使用 Google 登录", exact: true }));
    expect(await screen.findByRole("heading", { name: "账号与设置", level: 1 })).toBeTruthy();
    await act(async () => __setWebAuthSnapshotForTests({ status: "authenticated", user: { email: "owner@example.com", name: "Owner" }, csrfToken: "fragment-session", error: null }));
    expect(await screen.findByRole("heading", { name: A.title, level: 1 })).toBeTruthy();
    expect(screen.getByLabelText("当前页面地址").textContent).toBe(destination);
  });
});

describe("Book-centered related discovery", () => {
  it("shows an independent loading state, then a truthful empty result without blocking the main book", async () => {
    const related = deferred<{ total: number; items: typeof B[] }>();
    mocks.getRelatedBooks.mockReturnValue(related.promise);
    mountAt();
    expect(await screen.findByRole("heading", { name: A.title })).toBeTruthy();
    const section = screen.getByRole("region", { name: "相关图书" });
    expect(within(section).getByText("正在寻找相关图书…")).toBeTruthy();
    expect(section.getAttribute("aria-busy")).toBe("true");
    expect(within(section).queryByText(/没有找到可展示/)).toBeNull();
    expect(within(section).queryByText(/暂无相关/)).toBeNull();
    await act(async () => related.resolve({ total: 0, items: [] }));
    expect(within(section).getByText(/当前目录字段没有找到可展示的相关图书/)).toBeTruthy();
    expect(section.getAttribute("aria-busy")).toBe("false");
  });

  it("places directory relation reasons on the matching book link and reports only the displayed count", async () => {
    mocks.getRelatedBooks.mockResolvedValue({
      sourceBookId: A.id, total: 37, partial: false, unavailableFields: [],
      items: [
        { ...B, relations: [{ kind: "same_author", label: "作者相同" }, { kind: "same_publisher", label: "同出版社" }] },
        { ...C, relations: [{ kind: "title_query", label: "书名线索" }] },
      ],
    });
    mountAt();
    const link = await screen.findByRole("link", { name: `查看 ${B.title} 详情` });
    expect(link.getAttribute("href")).toBe("/books/book-b");
    expect(within(link).getByText("作者相同")).toBeTruthy();
    expect(within(link).getByText("同出版社")).toBeTruthy();
    expect(within(link).queryByText("书名线索")).toBeNull();
    const section = screen.getByRole("region", { name: "相关图书" });
    expect(within(section).getByText("本次展示 2 本")).toBeTruthy();
    expect(within(section).queryByText(/37/)).toBeNull();
    expect(section.querySelector(".match-badge")).toBeNull();
    expect(within(section).getByText(/版本和内容关系仍需核对/)).toBeTruthy();
    await userEvent.click(link);
    expect(await screen.findByRole("heading", { name: B.title, level: 1 })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: A.title, level: 1 })).toBeNull();
  });

  it("renders older API cards without inventing relation metadata from their matching fields", async () => {
    mocks.getRelatedBooks.mockResolvedValue({ total: 1, items: [B] });
    mountAt();
    const link = await screen.findByRole("link", { name: `查看 ${B.title} 详情` });
    expect(link.getAttribute("href")).toBe("/books/book-b");
    expect(within(link).queryByRole("list", { name: "与本书的关联线索" })).toBeNull();
    expect(within(link).queryByText("作者相同")).toBeNull();
    expect(within(link).queryByText("同出版社")).toBeNull();
  });

  it("keeps partial results readable while retrying and replaces them with the completed response", async () => {
    const retry = deferred<{ sourceBookId: string; total: number; items: typeof C[]; partial: boolean; unavailableFields: string[] }>();
    mocks.getRelatedBooks.mockResolvedValueOnce({
      sourceBookId: A.id, total: 1, items: [B], partial: true, unavailableFields: ["author", "publisher"],
    }).mockReturnValueOnce(retry.promise);
    mountAt();
    expect(await screen.findByRole("link", { name: `查看 ${B.title} 详情` })).toBeTruthy();
    expect(screen.getByText(/作者、出版社线索暂时无法查询/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "重试相关图书" }));
    expect(screen.getByRole("link", { name: `查看 ${B.title} 详情` })).toBeTruthy();
    expect(screen.getByText("正在重新查找相关图书…")).toBeTruthy();
    expect((screen.getByRole("button", { name: "重试相关图书" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => retry.resolve({ sourceBookId: A.id, total: 1, items: [C], partial: false, unavailableFields: [] }));
    expect(screen.getByRole("link", { name: `查看 ${C.title} 详情` })).toBeTruthy();
    expect(screen.queryByRole("link", { name: `查看 ${B.title} 详情` })).toBeNull();
    expect(screen.queryByText(/线索暂时无法查询/)).toBeNull();
    expect(screen.queryByRole("button", { name: "重试相关图书" })).toBeNull();
  });

  it("does not describe a partial empty result as a completed search with no related books", async () => {
    mocks.getRelatedBooks.mockResolvedValue({ sourceBookId: A.id, total: 0, items: [], partial: true, unavailableFields: ["title"] });
    mountAt();
    expect(await screen.findByText(/书名线索暂时无法查询/)).toBeTruthy();
    expect(screen.getByText(/暂未取得可展示的图书，请重试/)).toBeTruthy();
    expect(screen.queryByText(/当前目录字段没有找到可展示的相关图书/)).toBeNull();
    expect(screen.getByRole("button", { name: "重试相关图书" })).toBeTruthy();
  });

  it("drops a delayed previous-book result after navigating to another book", async () => {
    const old = deferred<{ sourceBookId: string; total: number; items: typeof C[] }>();
    mocks.getRelatedBooks.mockImplementation((id: string) => id === A.id ? old.promise : Promise.resolve({ sourceBookId: B.id, total: 1, items: [D] }));
    mountAt();
    await waitFor(() => expect(mocks.getRelatedBooks).toHaveBeenCalledWith(A.id, { signal: expect.any(AbortSignal) }));
    const previousSignal = mocks.getRelatedBooks.mock.calls[0][1].signal as AbortSignal;
    await userEvent.click(screen.getByRole("link", { name: "切换到图书乙" }));
    expect(await screen.findByRole("link", { name: `查看 ${D.title} 详情` })).toBeTruthy();
    expect(previousSignal.aborted).toBe(true);
    await act(async () => old.resolve({ sourceBookId: A.id, total: 1, items: [C] }));
    expect(screen.queryByRole("link", { name: `查看 ${C.title} 详情` })).toBeNull();
    expect(screen.getByRole("link", { name: `查看 ${D.title} 详情` })).toBeTruthy();
  });

  it("drops a delayed old-session result even when the book stays the same", async () => {
    const old = deferred<{ sourceBookId: string; total: number; items: typeof C[] }>();
    mocks.getRelatedBooks.mockReturnValueOnce(old.promise).mockResolvedValueOnce({ sourceBookId: A.id, total: 1, items: [D] });
    mountAt();
    await waitFor(() => expect(mocks.getRelatedBooks).toHaveBeenCalledTimes(1));
    const previousSignal = mocks.getRelatedBooks.mock.calls[0][1].signal as AbortSignal;
    await act(async () => __setWebAuthSnapshotForTests({ status: "authenticated", user: { email: "new@example.com", name: "New" }, csrfToken: "new-generation", error: null }));
    expect(await screen.findByRole("link", { name: `查看 ${D.title} 详情` })).toBeTruthy();
    expect(previousSignal.aborted).toBe(true);
    await act(async () => old.resolve({ sourceBookId: A.id, total: 1, items: [C] }));
    expect(screen.queryByRole("link", { name: `查看 ${C.title} 详情` })).toBeNull();
    expect(screen.getByRole("link", { name: `查看 ${D.title} 详情` })).toBeTruthy();
  });

  it("rejects relation metadata for a different source book", async () => {
    mocks.getRelatedBooks.mockResolvedValue({ sourceBookId: B.id, total: 1, items: [C], partial: false, unavailableFields: [] });
    mountAt();
    expect(await screen.findByText(/相关图书暂时无法加载/)).toBeTruthy();
    expect(screen.queryByRole("link", { name: `查看 ${C.title} 详情` })).toBeNull();
    expect(screen.getByRole("heading", { name: A.title, level: 1 })).toBeTruthy();
  });

  it("keeps ordinary anonymous search match badges and does not treat them as book relations", async () => {
    __setWebAuthSnapshotForTests({ status: "unauthenticated", user: null, csrfToken: null, error: null });
    mocks.searchBooks.mockResolvedValue({ total: 1, page: 1, limit: 20, items: [{
      ...B, match: { type: "exact_isbn", label: "ISBN 精确匹配", score: 100, fields: ["isbn"] },
      relations: [{ kind: "same_author", label: "作者相同" }],
    }] });
    mountAt("/?q=9780000000012");
    const link = await screen.findByRole("link", { name: `查看 ${B.title} 详情` });
    expect(within(link).getByText("ISBN 精确匹配")).toBeTruthy();
    expect(within(link).queryByRole("list", { name: "与本书的关联线索" })).toBeNull();
    expect(link.closest(".book-card--exact")).toBeTruthy();
    expect(mocks.getRelatedBooks).not.toHaveBeenCalled();
  });
});
