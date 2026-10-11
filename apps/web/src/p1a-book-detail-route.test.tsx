// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Link, MemoryRouter } from "react-router-dom";
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

beforeEach(() => {
  __resetWebAuthStoreForTests();
  vi.clearAllMocks();
  mocks.feature.enabled = true;
  __setWebAuthSnapshotForTests({ status: "authenticated", user: { email: "owner@example.com", name: "Owner" }, csrfToken: "route-test-csrf", error: null });
  mocks.getBook.mockImplementation(async (id: string) => ({ item: id === "book-b" ? B : A }));
  mocks.getRelatedBooks.mockResolvedValue({ items: [] });
  mocks.fetchWereadStatus.mockResolvedValue({ ok: true, matched: false });
  mocks.getStats.mockResolvedValue({ numberOfDocuments: 2 });
  mocks.searchBooks.mockResolvedValue({ total: 0, page: 1, limit: 20, items: [] });
});
afterEach(() => { cleanup(); __resetWebAuthStoreForTests(); });

function mountAt(path = "/books/book-a") {
  return render(<MemoryRouter initialEntries={[path]}>
    <Link to="/books/book-b">切换到图书乙</Link>
    <App />
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
});
