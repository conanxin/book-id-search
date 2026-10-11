// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { getBook, searchAiIntent, searchBooks } from "./api";
import { __resetWebAuthStoreForTests, __setWebAuthSnapshotForTests } from "./auth/session";

afterEach(() => { vi.unstubAllGlobals(); __resetWebAuthStoreForTests(); });

describe("catalog and AI session transport", () => {
  it("keeps search same-origin and anonymous without a CSRF header", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ items: [], total: 0, page: 1, limit: 20 })));
    vi.stubGlobal("fetch", fetcher);
    await searchBooks("古道", 1);
    const [url, options] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/search?q=%E5%8F%A4%E9%81%93&page=1&limit=20");
    expect(options.credentials).toBe("same-origin");
    expect(new Headers(options.headers).has("x-csrf-token")).toBe(false);
  });

  it("uses the live Google session CSRF for AI POST while preserving JSON headers", async () => {
    __setWebAuthSnapshotForTests({ status: "authenticated", user: { email: "owner@example.test" }, csrfToken: "current-session-csrf", error: null });
    const fetcher = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetcher);
    await searchAiIntent("寻找古道研究资料");
    const [url, options] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/ai/search-intent");
    expect(options.method).toBe("POST");
    expect(options.credentials).toBe("same-origin");
    expect(new Headers(options.headers).get("x-csrf-token")).toBe("current-session-csrf");
    expect(new Headers(options.headers).get("content-type")).toBe("application/json");
    expect(JSON.parse(String(options.body))).toEqual({ query: "寻找古道研究资料" });
  });

  it("returns the authentication error from a protected detail request", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: "请使用 Google 登录后继续。" } }), { status: 401 })));
    await expect(getBook("book-a")).rejects.toThrow("请使用 Google 登录后继续。");
  });
});
