// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const mocks = vi.hoisted(() => ({
  fetchWereadStatusesForBooks: vi.fn(),
  fetchWereadStatus: vi.fn(),
  clearWereadStatusCache: vi.fn(),
  purgeLegacyWereadTokenStorage: vi.fn(),
  ensureAuthSessionLoaded: vi.fn(async () => {}),
  getStats: vi.fn(),
  getBook: vi.fn(),
  getRelatedBooks: vi.fn(),
  search: vi.fn(),
  useSearchMemberships: vi.fn(() => ({ memberships: [], state: "idle" as const })),
}));

vi.mock("../auth/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auth/session")>();
  return { ...actual, ensureAuthSessionLoaded: mocks.ensureAuthSessionLoaded };
});
vi.mock("../auth/GoogleLoginPanel", () => ({
  GoogleLoginPanel: () => <div data-testid="google-login-panel" />,
}));
vi.mock("../wereadPrivate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../wereadPrivate")>();
  return {
    ...actual,
    fetchWereadStatusesForBooks: mocks.fetchWereadStatusesForBooks,
    fetchWereadStatus: mocks.fetchWereadStatus,
    clearWereadStatusCache: mocks.clearWereadStatusCache,
    purgeLegacyWereadTokenStorage: mocks.purgeLegacyWereadTokenStorage,
  };
});
vi.mock("../api", () => ({
  searchBooks: mocks.search,
  searchAiIntent: vi.fn(async () => ({ intent: "", keywords: [], refinements: [] })),
  getAiStatus: vi.fn(async () => ({ enabled: false })),
  getBookInsight: vi.fn(async () => ({ hasInsight: false })),
  getBook: mocks.getBook,
  getRelatedBooks: mocks.getRelatedBooks,
  getStats: mocks.getStats,
}));
vi.mock("../research/SearchMemberships", () => ({
  useSearchMemberships: mocks.useSearchMemberships,
  ResearchMembershipChips: () => null,
}));

const appMod = await import("../App");
const App = appMod.default;
const { __setWebAuthSnapshotForTests, __resetWebAuthStoreForTests } = await import("../auth/session");

const AUTHED = {
  status: "authenticated" as const,
  user: { email: "u@example.com", name: "U" },
  csrfToken: "csrf-test",
  error: null,
};
const UNAUTH = { status: "unauthenticated" as const, user: null, csrfToken: null, error: null };

const book = {
  id: "1_202401010001",
  ssid: "SS1",
  dxid: "DX1",
  title: "测试书",
  author: "作者",
  publisher: "P",
  year: 2024,
  pages: 100,
  isbn: "978-0000000000",
  rawInfo: "",
  parseStatus: "ok" as const,
  parseWarnings: [],
};
const searchResponse = { total: 1, page: 1, limit: 10, items: [book] };

beforeEach(() => {
  mocks.fetchWereadStatusesForBooks.mockReset().mockResolvedValue({});
  mocks.fetchWereadStatus.mockReset().mockResolvedValue({ ok: true, matched: true, catalogId: book.id });
  mocks.clearWereadStatusCache.mockClear();
  mocks.purgeLegacyWereadTokenStorage.mockClear();
  mocks.getStats.mockReset().mockResolvedValue({ numberOfDocuments: 1, indexName: "i", isIndexing: false });
  mocks.search.mockReset().mockResolvedValue(searchResponse);
  mocks.getBook.mockReset().mockResolvedValue({ item: book });
  mocks.getRelatedBooks.mockReset().mockResolvedValue({ items: [] });
});
afterEach(() => {
  cleanup();
  __resetWebAuthStoreForTests();
});

// App renders its own <Routes>; a bare MemoryRouter wrapper is all it needs.
function mountAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

describe("SearchPage WeRead session proof (Task 9 §十一)", () => {
  it("24 unauthenticated → no private status request, no stale badges", async () => {
    __setWebAuthSnapshotForTests(UNAUTH);
    mountAt("/?q=测试");
    await waitFor(() => expect(mocks.search).toHaveBeenCalledTimes(1));
    // wait for any would-be status effect to settle
    await new Promise((r) => setTimeout(r, 300));
    expect(mocks.fetchWereadStatusesForBooks).not.toHaveBeenCalled();
    expect(mocks.clearWereadStatusCache).toHaveBeenCalled();
  });

  it("25 authenticated → batch status request using session (no token argument)", async () => {
    __setWebAuthSnapshotForTests(AUTHED);
    mountAt("/?q=测试");
    await waitFor(() => expect(mocks.fetchWereadStatusesForBooks).toHaveBeenCalledTimes(1));
    // called with only the ids array — no token
    const args = mocks.fetchWereadStatusesForBooks.mock.calls[0];
    expect(args.length).toBe(1);
    expect(Array.isArray(args[0])).toBe(true);
  });

  it("26 logout transition clears status badges/cache", async () => {
    __setWebAuthSnapshotForTests(AUTHED);
    mocks.fetchWereadStatusesForBooks.mockResolvedValue({
      [book.id]: { ok: true, matched: true, catalogId: book.id, weread: { readingStatus: "Reading" } },
    });
    mountAt("/?q=测试");
    await waitFor(() => expect(mocks.fetchWereadStatusesForBooks).toHaveBeenCalledTimes(1));
    // logout
    mocks.fetchWereadStatusesForBooks.mockClear();
    mocks.clearWereadStatusCache.mockClear();
    __setWebAuthSnapshotForTests(UNAUTH);
    await waitFor(() => expect(mocks.clearWereadStatusCache).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 100));
    expect(mocks.fetchWereadStatusesForBooks).not.toHaveBeenCalled();
  });
});

describe("DetailPage WeRead session proof (Task 9 §十一)", () => {
  it("27 authenticated → status request using session (no token argument)", async () => {
    __setWebAuthSnapshotForTests(AUTHED);
    mountAt(`/books/${book.id}`);
    await waitFor(() => expect(mocks.fetchWereadStatus).toHaveBeenCalledTimes(1));
    expect(mocks.fetchWereadStatus.mock.calls[0].length).toBe(1);
    expect(mocks.fetchWereadStatus.mock.calls[0][0]).toBe(book.id);
  });

  it("28 unauthenticated → no private status request", async () => {
    __setWebAuthSnapshotForTests(UNAUTH);
    mountAt(`/books/${book.id}`);
    await waitFor(() => expect(screen.getByText("测试书")).toBeTruthy());
    await new Promise((r) => setTimeout(r, 150));
    expect(mocks.fetchWereadStatus).not.toHaveBeenCalled();
    expect(mocks.clearWereadStatusCache).toHaveBeenCalled();
  });
});
