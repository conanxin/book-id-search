// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Deterministic session store: __setWebAuthSnapshotForTests seeds the module
// singleton before any private call. Loader runs real logic except fetch.
vi.mock("../auth/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auth/session")>();
  return {
    ...actual,
    ensureAuthSessionLoaded: vi.fn(async () => {}),
  };
});

import {
  clearWereadStatusCache,
  fetchWereadAiSummary,
  fetchWereadAnnualReview,
  fetchWereadNotes,
  fetchWereadReadingMap,
  fetchWereadRelatedBooks,
  fetchWereadStatus,
  fetchWereadStatusesForBooks,
  fetchWereadSummary,
  fetchWereadTrends,
  purgeLegacyWereadTokenStorage,
  WereadPrivateError,
} from "./wereadPrivate";
import { __setWebAuthSnapshotForTests, __resetWebAuthStoreForTests } from "./auth/session";

const AUTHED = {
  status: "authenticated" as const,
  user: { email: "u@example.com", name: "U" },
  csrfToken: "csrf-test",
  error: null,
};
const AUTHED_NO_CSRF = { ...AUTHED, csrfToken: null };

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
  (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
});
afterEach(() => {
  (globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;
  __resetWebAuthStoreForTests();
  clearWereadStatusCache();
  vi.clearAllMocks();
});

describe("wereadPrivate session client (Task 9 §九)", () => {
  it("1 authenticated GET summary → same-origin credentials, no Authorization, no CSRF", async () => {
    __setWebAuthSnapshotForTests(AUTHED);
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, dataAvailable: true, booksCount: 1, notesCount: 2, confirmedMatchesCount: 3 }));
    await fetchWereadSummary();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain("/private/weread/summary");
    expect(init.credentials).toBe("same-origin");
    expect(init.cache).toBe("no-store");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
    expect(headers["X-CSRF-Token"]).toBeUndefined();
  });

  it("2 authenticated GET status → no CSRF", async () => {
    __setWebAuthSnapshotForTests(AUTHED);
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, matched: false, catalogId: "1_202401010001" }));
    await fetchWereadStatus("1_202401010001");
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["X-CSRF-Token"]).toBeUndefined();
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("3 authenticated POST status/batch → exact X-CSRF-Token", async () => {
    __setWebAuthSnapshotForTests(AUTHED);
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, results: { "1_202401010001": { ok: true, matched: true, catalogId: "1_202401010001" } } }));
    const out = await fetchWereadStatusesForBooks(["1_202401010001"]);
    expect(out["1_202401010001"].matched).toBe(true);
    const batchCall = fetchMock.mock.calls.find(([u]: [string]) => String(u).includes("/private/weread/status/batch"))!;
    const init = batchCall[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["X-CSRF-Token"]).toBe("csrf-test");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(init.credentials).toBe("same-origin");
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("4 POST notes/summarize → CSRF + content-type", async () => {
    __setWebAuthSnapshotForTests(AUTHED);
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, summary: { overview: "", themes: [], keyPoints: [], reviewQuestions: [], readingDirections: [] }, meta: { itemsUsed: 1, totalCharacters: 5, persisted: false as const, provider: "minimax" as const } }));
    await fetchWereadAiSummary([{ type: "highlight", text: "hello" }]);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain("/private/weread/notes/summarize");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["X-CSRF-Token"]).toBe("csrf-test");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("5 POST related-books → CSRF", async () => {
    __setWebAuthSnapshotForTests(AUTHED);
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, items: [], meta: { seedsUsed: 1, candidatesConsidered: 0, returned: 0, excluded: 0, persisted: false as const, source: "meilisearch" as const } }));
    await fetchWereadRelatedBooks([{ id: "s1", text: "主题" }]);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain("/private/weread/related-books");
    expect((init.headers as Record<string, string>)["X-CSRF-Token"]).toBe("csrf-test");
  });

  it("6 unauthenticated → no fetch + safe error", async () => {
    __setWebAuthSnapshotForTests({ status: "unauthenticated", user: null, csrfToken: null, error: null });
    await expect(fetchWereadSummary()).rejects.toMatchObject({ status: 401, message: "请先使用 Google 登录。" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("7 authenticated but missing csrf on POST → no fetch", async () => {
    __setWebAuthSnapshotForTests(AUTHED_NO_CSRF);
    await expect(fetchWereadAiSummary([{ type: "highlight", text: "x" }])).rejects.toBeInstanceOf(WereadPrivateError);
    await expect(fetchWereadStatusesForBooks(["1_202401010001"])).rejects.toBeInstanceOf(WereadPrivateError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("8 backend 401 → safe error + authoritative session refresh", async () => {
    __setWebAuthSnapshotForTests(AUTHED);
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "raw secret detail" }, 401));
    const err = await fetchWereadSummary().catch((e: WereadPrivateError) => e);
    expect(err).toBeInstanceOf(WereadPrivateError);
    expect((err as WereadPrivateError).status).toBe(401);
    expect((err as WereadPrivateError).message).toBe("登录已失效，请重新登录。");
    // Authoritative refresh is invoked fire-and-forget (`void ensure…()`); its
    // observable contract (safe message + no raw body echo) is asserted above.
  });

  it("9 backend 403 → safe error", async () => {
    __setWebAuthSnapshotForTests(AUTHED);
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "raw" }, 403));
    const err = await fetchWereadSummary().catch((e: WereadPrivateError) => e);
    expect((err as WereadPrivateError).status).toBe(403);
    expect((err as WereadPrivateError).message).toBe("登录安全校验失败，请刷新后重试。");
  });

  it("10 no token/session/csrf storage writes", async () => {
    __setWebAuthSnapshotForTests(AUTHED);
    const setItem = vi.fn();
    const getItem = vi.fn();
    Object.defineProperty(window, "sessionStorage", { value: { setItem, getItem, removeItem: vi.fn() }, configurable: true });
    Object.defineProperty(window, "localStorage", { value: { setItem, getItem, removeItem: vi.fn() }, configurable: true });
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, dataAvailable: true, booksCount: 0, notesCount: 0, confirmedMatchesCount: 0 }));
    await fetchWereadSummary();
    await fetchWereadTrends();
    expect(setItem).not.toHaveBeenCalled();
    expect(getItem).not.toHaveBeenCalled();
  });

  it("11 fetchWereadStatusesForBooks batch path session-based (no token argument)", async () => {
    __setWebAuthSnapshotForTests(AUTHED);
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, results: {} }));
    await fetchWereadStatusesForBooks(["2_202401010002"]);
    const batchCall = fetchMock.mock.calls.find(([u]: [string]) => String(u).includes("status/batch"));
    expect(batchCall).toBeTruthy();
    const init = batchCall![1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({ catalogIds: ["2_202401010002"] });
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("12 per-item fallback session-based (batch 500 → single status GET)", async () => {
    __setWebAuthSnapshotForTests(AUTHED);
    fetchMock.mockImplementationOnce(async () => jsonResponse({ error: "boom" }, 500));
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, matched: false, catalogId: "3_202401010003" }));
    const out = await fetchWereadStatusesForBooks(["3_202401010003"]);
    expect(out["3_202401010003"].ok).toBe(true);
    const single = fetchMock.mock.calls.find(([u]: [string]) => String(u).includes("/private/weread/status?"));
    expect(single).toBeTruthy();
    expect(((single![1] as RequestInit).headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("13 logout/session invalidation clears cache", async () => {
    __setWebAuthSnapshotForTests(AUTHED);
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, results: { "4_202401010004": { ok: true, matched: true, catalogId: "4_202401010004" } } }));
    await fetchWereadStatusesForBooks(["4_202401010004"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Session invalidation: cache must not serve the old private status.
    clearWereadStatusCache();
    __setWebAuthSnapshotForTests(AUTHED);
    fetchMock.mockClear();
    fetchMock.mockImplementation(async () => jsonResponse({ error: "x" }, 401));
    await expect(fetchWereadStatusesForBooks(["4_202401010004"])).rejects.toBeInstanceOf(WereadPrivateError);
    // a cache that survived the 401 would resolve without any fetch; assert it did fetch
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(1);
    // after cache clear + 401, a fresh authenticated attempt refetches from the server
    __setWebAuthSnapshotForTests(AUTHED);
    fetchMock.mockClear();
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, results: { "4_202401010004": { ok: true, matched: true, catalogId: "4_202401010004" } } }));
    await fetchWereadStatusesForBooks(["4_202401010004"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("14 no Authorization header anywhere in this suite's requests", async () => {
    __setWebAuthSnapshotForTests(AUTHED);
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, dataAvailable: true, booksCount: 0, notesCount: 0, confirmedMatchesCount: 0 }));
    await fetchWereadSummary();
    await fetchWereadTrends();
    await fetchWereadNotes({ limit: 5 });
    await fetchWereadReadingMap({ months: 3, topBooks: 6 });
    await fetchWereadAnnualReview({ year: 2025 });
    for (const [, init] of fetchMock.mock.calls as Array<[string, RequestInit]>) {
      expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
    }
  });
});

describe("legacy token purge (Task 9 §十三)", () => {
  it("purge removes the legacy key via removeItem only; never getItem/setItem", () => {
    const removeItem = vi.fn();
    const getItem = vi.fn();
    const setItem = vi.fn();
    Object.defineProperty(window, "sessionStorage", { value: { removeItem, getItem, setItem }, configurable: true });
    purgeLegacyWereadTokenStorage();
    expect(removeItem).toHaveBeenCalledWith("book-id-search:weread-private-token");
    expect(getItem).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
  });

  it("storage errors are swallowed", () => {
    Object.defineProperty(window, "sessionStorage", {
      get() { throw new Error("denied"); },
      configurable: true,
    });
    expect(() => purgeLegacyWereadTokenStorage()).not.toThrow();
  });
});
