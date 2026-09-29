// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

// Spies created via vi.hoisted so the mock factory below (which runs before
// any import) can hand out the exact same vi.fn instances the test asserts on.
const mocks = vi.hoisted(() => ({
  fetchWereadSummary: vi.fn(),
  fetchWereadTrends: vi.fn(),
  clearWereadStatusCache: vi.fn(),
  purgeLegacyWereadTokenStorage: vi.fn(),
  ensureAuthSessionLoaded: vi.fn(async () => {}),
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
    fetchWereadSummary: mocks.fetchWereadSummary,
    fetchWereadTrends: mocks.fetchWereadTrends,
    clearWereadStatusCache: mocks.clearWereadStatusCache,
    purgeLegacyWereadTokenStorage: mocks.purgeLegacyWereadTokenStorage,
  };
});

// Components imported AFTER the mock registry is in place.
const centerMod = await import("./WereadCenter");
const WereadCenter = centerMod.default;
const { __setWebAuthSnapshotForTests, __resetWebAuthStoreForTests } = await import("../auth/session");

const AUTHED = {
  status: "authenticated" as const,
  user: { email: "u@example.com", name: "U" },
  csrfToken: "csrf-test",
  error: null,
};
const UNAUTH = { status: "unauthenticated" as const, user: null, csrfToken: null, error: null };

const summaryBody = { ok: true, dataAvailable: true, booksCount: 12, notesCount: 34, confirmedMatchesCount: 5 };

beforeEach(() => {
  mocks.fetchWereadSummary.mockReset();
  mocks.fetchWereadTrends.mockReset();
  mocks.clearWereadStatusCache.mockClear();
  mocks.purgeLegacyWereadTokenStorage.mockClear();
});
afterEach(() => {
  cleanup();
  __resetWebAuthStoreForTests();
});

function mount() {
  return render(
    <MemoryRouter initialEntries={["/weread"]}>
      <WereadCenter />
    </MemoryRouter>,
  );
}

describe("WereadCenter Google session integration (Task 9 §十)", () => {
  it("15 logged-out → Google login area", async () => {
    __setWebAuthSnapshotForTests(UNAUTH);
    mount();
    expect(await screen.findByTestId("google-login-panel")).toBeTruthy();
    expect(screen.queryByTestId("weread-kpi-grid")).toBeNull();
  });

  it("16 old private-token input/copy absent (logged-out)", async () => {
    __setWebAuthSnapshotForTests(UNAUTH);
    mount();
    await screen.findByTestId("google-login-panel");
    const text = document.body.textContent ?? "";
    expect(text).not.toContain("private token");
    expect(text).not.toContain("输入 private token");
    expect(text).not.toContain("sessionStorage");
    expect(screen.queryByTestId("weread-token-form")).toBeNull();
    expect(screen.queryByLabelText("private token")).toBeNull();
  });

  it("16b old private-token copy absent (authenticated too)", async () => {
    __setWebAuthSnapshotForTests(AUTHED);
    mocks.fetchWereadSummary.mockResolvedValue(summaryBody as never);
    mocks.fetchWereadTrends.mockResolvedValue({ ok: true } as never);
    mount();
    await screen.findByTestId("weread-kpi-grid");
    const text = document.body.textContent ?? "";
    expect(text).not.toContain("private token");
    expect(text).not.toContain("清除 token");
    expect(text).not.toContain("Token 只保存在");
  });

  it("17 authenticated → summary load", async () => {
    __setWebAuthSnapshotForTests(AUTHED);
    mocks.fetchWereadSummary.mockResolvedValue(summaryBody as never);
    mount();
    expect(await screen.findByTestId("weread-kpi-grid")).toBeTruthy();
    expect(mocks.fetchWereadSummary).toHaveBeenCalledTimes(1);
  });

  it("18 authenticated summary called with no token argument", async () => {
    __setWebAuthSnapshotForTests(AUTHED);
    mocks.fetchWereadSummary.mockResolvedValue(summaryBody as never);
    mount();
    await screen.findByTestId("weread-kpi-grid");
    // zero arguments — the token parameter no longer exists; the network-level
    // no-Authorization contract lives in wereadPrivateSession §1/§14.
    expect(mocks.fetchWereadSummary).toHaveBeenCalledWith();
  });

  it("19 trends load session-based", async () => {
    __setWebAuthSnapshotForTests(AUTHED);
    mocks.fetchWereadSummary.mockResolvedValue(summaryBody as never);
    mocks.fetchWereadTrends.mockResolvedValue({ ok: true } as never);
    mount();
    await screen.findByTestId("weread-kpi-grid");
    await waitFor(() => expect(mocks.fetchWereadTrends).toHaveBeenCalledTimes(1));
    expect(mocks.fetchWereadTrends).toHaveBeenCalledWith();
  });

  it("20 unauthenticated transition → private dashboards cleared, cache cleared", async () => {
    __setWebAuthSnapshotForTests(AUTHED);
    mocks.fetchWereadSummary.mockResolvedValue(summaryBody as never);
    mocks.fetchWereadTrends.mockResolvedValue({ ok: true } as never);
    mount();
    await screen.findByTestId("weread-kpi-grid");
    // logout
    __setWebAuthSnapshotForTests(UNAUTH);
    await waitFor(() => expect(screen.queryByTestId("weread-kpi-grid")).toBeNull());
    expect(screen.getByTestId("google-login-panel")).toBeTruthy();
    expect(mocks.clearWereadStatusCache).toHaveBeenCalled();
    expect(screen.queryByTestId("weread-panel-notes")).toBeNull();
  });

  it("21 summary not ok → error state, no private workspace", async () => {
    __setWebAuthSnapshotForTests(AUTHED);
    mocks.fetchWereadSummary.mockResolvedValue({ ok: false } as never);
    mount();
    await waitFor(() => expect(screen.getByTestId("weread-session-status")).toBeTruthy());
    expect(screen.queryByTestId("weread-kpi-grid")).toBeNull();
    expect(screen.queryByTestId("weread-workspace-tabs")).toBeNull();
  });

  it("21b summary rejects with 401 → disabled state, safe copy, no workspace", async () => {
    __setWebAuthSnapshotForTests(AUTHED);
    const { WereadPrivateError } = await import("../wereadPrivate");
    mocks.fetchWereadSummary.mockRejectedValue(new WereadPrivateError(401, "登录已失效，请重新登录。"));
    mount();
    await waitFor(() => expect(screen.getByTestId("weread-session-status")).toBeTruthy());
    await screen.findByText("登录已失效，请重新登录");
    expect(screen.queryByTestId("weread-kpi-grid")).toBeNull();
  });

  it("22 refresh action works without token", async () => {
    __setWebAuthSnapshotForTests(AUTHED);
    mocks.fetchWereadSummary.mockResolvedValue(summaryBody as never);
    mocks.fetchWereadTrends.mockResolvedValue({ ok: true } as never);
    mount();
    await screen.findByTestId("weread-kpi-grid");
    const refresh = screen.getByRole("button", { name: /刷新数据/ });
    await userEvent.click(refresh);
    await waitFor(() => expect(mocks.fetchWereadSummary.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it("23 no password input anywhere; one-time legacy purge on mount", async () => {
    __setWebAuthSnapshotForTests(AUTHED);
    mocks.fetchWereadSummary.mockResolvedValue(summaryBody as never);
    mocks.fetchWereadTrends.mockResolvedValue({ ok: true } as never);
    mount();
    await screen.findByTestId("weread-kpi-grid");
    expect(mocks.purgeLegacyWereadTokenStorage).toHaveBeenCalled();
    expect(document.querySelector('input[type="password"]')).toBeNull();
  });
});
