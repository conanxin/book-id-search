import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearWereadStatusCache,
  clearWereadToken,
  fetchWereadAiSummary,
  fetchWereadNotes,
  fetchWereadStatusesForBooks,
  fetchWereadStatus,
  fetchWereadSummary,
  getWereadToken,
  saveWereadToken,
} from "./wereadPrivate";

const TOKEN_KEY = "book-id-search:weread-private-token";

class MemoryStorage implements Storage {
  private data = new Map<string, string>();

  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.data.set(key, String(value));
  }

  removeItem(key: string): void {
    this.data.delete(key);
  }

  clear(): void {
    this.data.clear();
  }

  key(index: number): string | null {
    return [...this.data.keys()][index] ?? null;
  }

  get length(): number {
    return this.data.size;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).sessionStorage = new MemoryStorage();

describe("wereadPrivate", () => {
  const originalFetch = globalThis.fetch;
  const fetchMock = vi.fn(async () => new Response("{}"));
  const TOKEN = "book-id-search:weread-private-token";

  beforeEach(() => {
    (globalThis as unknown as { sessionStorage: Storage }).sessionStorage.clear();
    clearWereadStatusCache();
    clearWereadToken();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    (globalThis as unknown as { sessionStorage: Storage }).sessionStorage.clear();
    clearWereadStatusCache();
    clearWereadToken();
    globalThis.fetch = originalFetch;
  });

  it("token save/load/clear use sessionStorage", () => {
    expect(getWereadToken()).toBeNull();
    saveWereadToken("secret");
    expect(getWereadToken()).toBe("secret");
    expect(sessionStorage.getItem(TOKEN_KEY)).toBe("secret");
    clearWereadToken();
    expect(getWereadToken()).toBeNull();
    expect(sessionStorage.getItem(TOKEN_KEY)).toBeNull();
  });

  it("fetchWereadSummary sends Authorization header", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          dataAvailable: true,
          booksCount: 1,
          notesCount: 2,
          confirmedMatchesCount: 3,
          confirmedWithNotesCount: 1,
          confirmedWithHighlightsCount: 2,
          totalConfirmedNoteRecords: 5,
        })
      )
    );
    await fetchWereadSummary("my-token");
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const [url, init] = call;
    expect(url).toContain("/private/weread/summary");
    expect(init?.headers).toMatchObject({ Authorization: "Bearer my-token" });
  });

  it("fetchWereadStatus sends Authorization header", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          matched: true,
          catalogId: "13000000_000000000001",
        })
      )
    );
    await fetchWereadStatus("my-token", "13000000_000000000001");
    const call2 = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const [url, init] = call2;
    expect(url).toContain("/private/weread/status?catalogId=13000000_000000000001");
    expect(init?.headers).toMatchObject({ Authorization: "Bearer my-token" });
  });

  it("401 does not leak token in thrown error", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        statusText: "Unauthorized",
      })
    );
    await expect(fetchWereadSummary("my-token")).rejects.toThrow("unauthorized");
  });

  it("fetchWereadStatusesForBooks uses batch endpoint and deduplicates", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          results: {
            "13000000_000000000001": {
              matched: true,
              catalogId: "13000000_000000000001",
              weread: {
                readingStatus: "finished",
                progress: 100,
                noteCount: 1,
                highlightCount: 2,
                matchedRecordsCount: 1,
                notesSummary: {
                  total: 3,
                  highlights: 2,
                  thoughts: 0,
                  reviews: 0,
                  unknown: 1,
                  hasNotes: true,
                },
                matchMethod: "isbn",
                matchConfidence: "high",
                decisionSource: "auto",
              },
            },
          },
        })
      )
    );
    const r1 = await fetchWereadStatusesForBooks("tok", [
      "13000000_000000000001",
      "13000000_000000000001",
    ]);
    const r2 = await fetchWereadStatusesForBooks("tok", ["13000000_000000000001"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const [url, init] = call;
    expect(url).toContain("/private/weread/status/batch");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer tok",
      "Content-Type": "application/json",
    });
    const body = JSON.parse(init?.body as string);
    expect(body.catalogIds).toEqual(["13000000_000000000001"]);
    expect(r1["13000000_000000000001"]).toBe(r2["13000000_000000000001"]);
  });

  it("fetchWereadStatusesForBooks falls back to single status when batch returns 404", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Not Found" }), { status: 404 })
    );
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          matched: true,
          catalogId: "13000000_000000000001",
        })
      )
    );
    const result = await fetchWereadStatusesForBooks("tok", ["13000000_000000000001"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const batchCall = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const singleCall = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(batchCall[0]).toContain("/private/weread/status/batch");
    expect(singleCall[0]).toContain("/private/weread/status?catalogId=13000000_000000000001");
    expect(result["13000000_000000000001"].matched).toBe(true);
  });

  it("batch 401 throws without leaking token", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "Invalid token." }), { status: 403 })
    );
    await expect(fetchWereadStatusesForBooks("leaked-token", ["13000000_000000000001"])).rejects.toThrow(
      "Invalid token."
    );
  });

  it("response type does not contain private fields", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          matched: true,
          catalogId: "13000000_000000000001",
          weread: {
            readingStatus: "finished",
            progress: 100,
            noteCount: 5,
            highlightCount: 3,
            matchMethod: "isbn",
            matchConfidence: "high",
            decisionSource: "auto",
          },
        })
      )
    );
    const res = await fetchWereadStatus("tok", "13000000_000000000001");
    const json = JSON.stringify(res);
    expect(json).not.toContain("wereadBookId");
    expect(json).not.toContain("noteId");
    expect(json).not.toContain("highlightId");
    expect(json).not.toContain("title");
    expect(json).not.toContain("text");
    expect(json).not.toContain("comment");
    expect(json).toContain("matched");
    expect(json).toContain("readingStatus");
  });
});

describe("fetchWereadNotes", () => {
  const originalFetch = globalThis.fetch;
  const fetchMock = vi.fn(async () => new Response("{}"));

  beforeEach(() => {
    (globalThis as unknown as { sessionStorage: Storage }).sessionStorage.clear();
    clearWereadStatusCache();
    clearWereadToken();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          items: [],
          pageInfo: { limit: 50, offset: 0, total: 0, hasMore: false },
          summary: {
            totalAfterFilter: 0,
            highlights: 0,
            thoughts: 0,
            reviews: 0,
            unknown: 0,
            matchedCount: 0,
            unmatchedCount: 0,
          },
        })
      )
    );
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    (globalThis as unknown as { sessionStorage: Storage }).sessionStorage.clear();
    clearWereadStatusCache();
    clearWereadToken();
    globalThis.fetch = originalFetch;
  });

  it("builds URL with all query params and Authorization header", async () => {
    await fetchWereadNotes("my-token", {
      type: "highlight",
      days: "30",
      matchedOnly: true,
      hasComment: false,
      limit: 25,
      offset: 10,
      sort: "oldest",
    });
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const [url, init] = call;
    expect(url).toContain("/private/weread/notes");
    expect(url).toContain("type=highlight");
    expect(url).toContain("days=30");
    expect(url).toContain("matchedOnly=true");
    expect(url).toContain("hasComment=false");
    expect(url).toContain("limit=25");
    expect(url).toContain("offset=10");
    expect(url).toContain("sort=oldest");
    expect(init?.headers).toMatchObject({ Authorization: "Bearer my-token" });
  });

  it("returns parsed items from response", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          items: [
            {
              type: "highlight",
              text: "示例划线",
              comment: null,
              createdAt: "2026-07-04T00:00:00.000Z",
              updatedAt: null,
              matched: true,
              catalogId: "13000000_000000000001",
              source: "private_weread",
            },
          ],
          pageInfo: { limit: 50, offset: 0, total: 1, hasMore: false },
          summary: {
            totalAfterFilter: 1,
            highlights: 1,
            thoughts: 0,
            reviews: 0,
            unknown: 0,
            matchedCount: 1,
            unmatchedCount: 0,
          },
        })
      )
    );
    const res = await fetchWereadNotes("my-token");
    expect(res.ok).toBe(true);
    expect(res.items.length).toBe(1);
    expect(res.items[0].text).toBe("示例划线");
    expect(res.items[0].matched).toBe(true);
    expect(res.summary.highlights).toBe(1);
  });

  it("401 does not leak token in thrown error", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 })
    );
    await expect(fetchWereadNotes("secret-token", { limit: 1 })).rejects.toThrow("unauthorized");
    // Ensure error message does not contain the token
    try {
      await fetchWereadNotes("secret-token", { limit: 1 });
    } catch (e) {
      expect(String(e)).not.toContain("secret-token");
    }
  });

  it("does not write to localStorage", async () => {
    const localStorageSet = vi.fn();
    Object.defineProperty(globalThis, "localStorage", {
      value: { setItem: localStorageSet, getItem: () => null, removeItem: () => undefined, clear: () => undefined, key: () => null, length: 0 },
      configurable: true,
    });
    await fetchWereadNotes("tok");
    expect(localStorageSet).not.toHaveBeenCalled();
  });

  // ---- S27D: full-text search client tests ----

  it("sends q param when present and non-empty", async () => {
    await fetchWereadNotes("my-token", { q: "佛塔" });
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const [url] = call;
    expect(url).toContain("/private/weread/notes");
    expect(url).toMatch(/[?&]q=/);
    expect(url).toContain("q=" + encodeURIComponent("佛塔"));
  });

  it("trims q before sending", async () => {
    await fetchWereadNotes("my-token", { q: "  hello  " });
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const [url] = call;
    expect(url).toContain("q=" + encodeURIComponent("hello"));
  });

  it("omits q param when empty or whitespace-only", async () => {
    await fetchWereadNotes("my-token", { q: "" });
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const [url] = call;
    expect(url).not.toContain("q=");
    // Second case: all-whitespace
    fetchMock.mockClear();
    await fetchWereadNotes("my-token", { q: "   " });
    const url2 = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[0];
    expect(url2).not.toContain("q=");
  });

  it("401 with q still does not leak token or q", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 })
    );
    try {
      await fetchWereadNotes("secret-token", { q: "private-thing" });
      throw new Error("should have thrown");
    } catch (e) {
      const s = String(e);
      expect(s).not.toContain("secret-token");
      expect(s).not.toContain("private-thing");
    }
  });

  it("returned object includes searchInfo if present", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          items: [],
          pageInfo: { limit: 50, offset: 0, total: 0, hasMore: false },
          summary: {
            totalAfterFilter: 0, highlights: 0, thoughts: 0, reviews: 0, unknown: 0,
            matchedCount: 0, unmatchedCount: 0,
          },
          searchInfo: { enabled: true, queryLength: 5, termsCount: 1, matchedCount: 0 },
        })
      )
    );
    const res = await fetchWereadNotes("tok", { q: "hello" });
    expect(res.searchInfo).toBeDefined();
    expect(res.searchInfo?.enabled).toBe(true);
    expect(res.searchInfo?.queryLength).toBe(5);
    expect(res.searchInfo?.termsCount).toBe(1);
    expect(res.searchInfo?.matchedCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// S27E — fetchWereadAiSummary (own fetchMock scope)
// ---------------------------------------------------------------------------

describe("fetchWereadAiSummary (S27E)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const TOKEN = "token-for-ai-summary";

  beforeEach(() => {
    fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          ok: true,
          summary: {
            overview: "合成概览文本。",
            themes: [{ title: "主题一", summary: "主题摘要。", evidenceCount: 1 }],
            keyPoints: ["观点 A"],
            reviewQuestions: [],
            readingDirections: [],
          },
          meta: { itemsUsed: 1, totalCharacters: 5, persisted: false, provider: "minimax" },
        })
      )
    );
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends POST with Content-Type: application/json and Authorization header", async () => {
    await fetchWereadAiSummary(TOKEN, [
      { type: "highlight", text: "合成测试材料：隐私边界。" },
    ]);
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const [url, init] = call;
    expect(init?.method).toBe("POST");
    expect(url).toContain("/private/weread/notes/summarize");
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer token-for-ai-summary",
      "Content-Type": "application/json",
    });
  });

  it("only sends { type, text, comment } — no q / catalogId / matched / IDs / dates / title / author", async () => {
    await fetchWereadAiSummary(TOKEN, [
      {
        type: "highlight",
        text: "合成测试材料：边界检查。",
        comment: null,
        // The client must drop these even if a caller mistakenly attaches them.
        q: "secret-query",
        catalogId: "123_000000000001",
        wereadBookId: "secret-book",
        noteId: "secret-note",
        matched: true,
        title: "secret-title",
        author: "secret-author",
        createdAt: "2026-01-01T00:00:00.000Z",
      } as unknown as Parameters<typeof fetchWereadAiSummary>[1][number],
    ]);
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(call[1].body as string);
    expect(Object.keys(body)).toEqual(["items"]);
    const item = body.items[0];
    expect(Object.keys(item).sort()).toEqual(["comment", "text", "type"]);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("secret-query");
    expect(serialized).not.toContain("secret-title");
    expect(serialized).not.toContain("secret-author");
    expect(serialized).not.toContain("secret-book");
    expect(serialized).not.toContain("secret-note");
    expect(serialized).not.toContain("123_000000000001");
    expect(serialized).not.toContain("matched");
    expect(serialized).not.toContain("createdAt");
  });

  it("401 does not leak the token in the thrown error message", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 })
    );
    await expect(
      fetchWereadAiSummary("leaked-token", [{ type: "highlight", text: "合成测试：鉴权失败。" }])
    ).rejects.toThrow("unauthorized");
    try {
      await fetchWereadAiSummary("leaked-token", [{ type: "highlight", text: "合成测试：鉴权失败。" }]);
    } catch (e) {
      expect(String(e)).not.toContain("leaked-token");
    }
  });

  it("429 / 502 / 503 / 504 surface as plain Error messages without token leakage", async () => {
    for (const status of [429, 502, 503, 504] as const) {
      fetchMock.mockReset();
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ error: `provider-failure-${status}` }), { status })
      );
      await expect(
        fetchWereadAiSummary(TOKEN, [{ type: "highlight", text: "合成测试：限流。" }])
      ).rejects.toThrow(`provider-failure-${status}`);
    }
  });

  it("drops items where text AND comment are both empty after the rebuild", async () => {
    await fetchWereadAiSummary(TOKEN, [
      { type: "highlight", text: "保留的合成笔记。", comment: null },
      { type: "thought", text: "", comment: "" },
      { type: "review", text: "", comment: null },
    ]);
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(call[1].body as string);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].text).toBe("保留的合成笔记。");
  });

  it("normalizes an invalid type to 'unknown'", async () => {
    await fetchWereadAiSummary(TOKEN, [
      { type: "garbage" as unknown as "highlight", text: "类型归一化。", comment: null },
    ]);
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(call[1].body as string);
    expect(body.items[0].type).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// S27F — catalogId filter + fetchAllWereadBookNotes
// ---------------------------------------------------------------------------

describe("wereadPrivate S27F catalogId + per-book pagination", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const TOKEN = "token-for-s27f";

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function makeNote(i: number, catalogId: string) {
    return {
      type: "highlight",
      text: `s27f-${i}-body`,
      comment: i % 2 === 0 ? `s27f-${i}-thought` : null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: null,
      matched: true,
      catalogId,
      source: "private_weread" as const,
    };
  }

  it("fetchWereadNotes forwards a valid catalogId query param", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          items: [],
          pageInfo: { limit: 50, offset: 0, total: 0, hasMore: false },
          summary: { totalAfterFilter: 0, highlights: 0, thoughts: 0, reviews: 0, unknown: 0, matchedCount: 0, unmatchedCount: 0 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    await fetchWereadNotes(TOKEN, { catalogId: "13000000_000000000001" });
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toContain("catalogId=13000000_000000000001");
  });

  it("fetchWereadNotes does NOT forward a malformed catalogId", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          items: [],
          pageInfo: { limit: 50, offset: 0, total: 0, hasMore: false },
          summary: { totalAfterFilter: 0, highlights: 0, thoughts: 0, reviews: 0, unknown: 0, matchedCount: 0, unmatchedCount: 0 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    await fetchWereadNotes(TOKEN, { catalogId: "garbage" });
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).not.toContain("catalogId=");
  });

  it("fetchWereadNotes trims whitespace before sending catalogId", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          items: [],
          pageInfo: { limit: 50, offset: 0, total: 0, hasMore: false },
          summary: { totalAfterFilter: 0, highlights: 0, thoughts: 0, reviews: 0, unknown: 0, matchedCount: 0, unmatchedCount: 0 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    await fetchWereadNotes(TOKEN, { catalogId: "  13000000_000000000001  " });
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toContain("catalogId=13000000_000000000001");
  });

  it("fetchAllWereadBookNotes aggregates two pages then stops at hasMore=false", async () => {
    const CATALOG = "13000000_000000000001";
    const page1 = Array.from({ length: 3 }, (_, i) => makeNote(i + 1, CATALOG));
    const page2 = Array.from({ length: 2 }, (_, i) => makeNote(i + 4, CATALOG));
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            items: page1,
            pageInfo: { limit: 3, offset: 0, total: 5, hasMore: true },
            summary: { totalAfterFilter: 5, highlights: 3, thoughts: 0, reviews: 0, unknown: 0, matchedCount: 5, unmatchedCount: 0 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            items: page2,
            pageInfo: { limit: 3, offset: 3, total: 5, hasMore: false },
            summary: { totalAfterFilter: 5, highlights: 5, thoughts: 0, reviews: 0, unknown: 0, matchedCount: 5, unmatchedCount: 0 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );
    const result = await (
      await import("./wereadPrivate")
    ).fetchAllWereadBookNotes(TOKEN, CATALOG, { pageSize: 3 });
    expect(result.items).toHaveLength(5);
    expect(result.truncated).toBe(false);
    expect(result.total).toBe(5);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // both pages carry catalogId
    for (const call of fetchMock.mock.calls) {
      expect((call as unknown as [string, RequestInit])[0]).toContain(`catalogId=${CATALOG}`);
    }
  });

  it("fetchAllWereadBookNotes stops on empty page (defensive infinite-loop guard)", async () => {
    const CATALOG = "13000000_000000000002";
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          items: [],
          pageInfo: { limit: 50, offset: 0, total: 0, hasMore: true },
          summary: { totalAfterFilter: 0, highlights: 0, thoughts: 0, reviews: 0, unknown: 0, matchedCount: 0, unmatchedCount: 0 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    const result = await (
      await import("./wereadPrivate")
    ).fetchAllWereadBookNotes(TOKEN, CATALOG, { pageSize: 50 });
    expect(result.items).toHaveLength(0);
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it("fetchAllWereadBookNotes caps at MAX_PAGES (20) even with hasMore=true", async () => {
    const CATALOG = "13000000_000000000003";
    const page = Array.from({ length: 10 }, (_, i) => makeNote(i + 1, CATALOG));
    fetchMock.mockImplementation(
      () =>
        new Response(
          JSON.stringify({
            ok: true,
            items: page,
            pageInfo: { limit: 10, offset: 0, total: 9999, hasMore: true },
            summary: { totalAfterFilter: 9999, highlights: 10, thoughts: 0, reviews: 0, unknown: 0, matchedCount: 9999, unmatchedCount: 0 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
    );
    const result = await (
      await import("./wereadPrivate")
    ).fetchAllWereadBookNotes(TOKEN, CATALOG, { pageSize: 10, maxItems: 5000 });
    expect(fetchMock.mock.calls.length).toBe(20);
    expect(result.truncated).toBe(true);
  });

  it("fetchAllWereadBookNotes marks truncated when maxItems reached", async () => {
    const CATALOG = "13000000_000000000004";
    const page = Array.from({ length: 4 }, (_, i) => makeNote(i + 1, CATALOG));
    fetchMock.mockImplementation(
      () =>
        new Response(
          JSON.stringify({
            ok: true,
            items: page,
            pageInfo: { limit: 4, offset: 0, total: 9999, hasMore: true },
            summary: { totalAfterFilter: 9999, highlights: 4, thoughts: 0, reviews: 0, unknown: 0, matchedCount: 9999, unmatchedCount: 0 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
    );
    const result = await (
      await import("./wereadPrivate")
    ).fetchAllWereadBookNotes(TOKEN, CATALOG, { pageSize: 4, maxItems: 6 });
    expect(result.items).toHaveLength(6);
    expect(result.truncated).toBe(true);
  });

  it("fetchAllWereadBookNotes rejects malformed catalogId", async () => {
    await expect(
      (await import("./wereadPrivate")).fetchAllWereadBookNotes(TOKEN, "garbage-id")
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetchAllWereadBookNotes aborts on pre-aborted signal", async () => {
    const ctl = new AbortController();
    ctl.abort();
    await expect(
      (await import("./wereadPrivate")).fetchAllWereadBookNotes(TOKEN, "13000000_000000000005", { signal: ctl.signal })
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("401 error message does not include token", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error: "认证失败" }), { status: 401, headers: { "Content-Type": "application/json" } })
    );
    await expect(
      (await import("./wereadPrivate")).fetchAllWereadBookNotes(TOKEN, "13000000_000000000006")
    ).rejects.toThrow(/认证失败/);
    const err = await (await import("./wereadPrivate")).fetchAllWereadBookNotes(
      TOKEN,
      "13000000_000000000007"
    ).catch((e: Error) => e);
    // Confirm error class doesn't include token
    if (err instanceof Error) {
      expect(err.message.includes(TOKEN)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// S27G — fetchWereadRelatedBooks
// ---------------------------------------------------------------------------
describe("fetchWereadRelatedBooks (S27G)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const TOKEN = "token-for-s27g";

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          items: [],
          meta: {
            seedsUsed: 1,
            candidatesConsidered: 0,
            returned: 0,
            excluded: 0,
            persisted: false,
            source: "meilisearch",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POST + Content-Type / auth header / payload shape", async () => {
    await (
      await import("./wereadPrivate")
    ).fetchWereadRelatedBooks(TOKEN, [
      { id: "theme-0", text: "合成主题" },
    ]);
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const [url, init] = call;
    expect(init?.method).toBe("POST");
    expect(url).toContain("/private/weread/related-books");
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer token-for-s27g",
      "Content-Type": "application/json",
    });
    const body = JSON.parse(init.body as string);
    expect(Object.keys(body).sort()).toEqual(["excludeCatalogIds", "limit", "seeds"]);
  });

  it("does not send overview / keyPoints / notes / q / token / private IDs", async () => {
    await (
      await import("./wereadPrivate")
    ).fetchWereadRelatedBooks(
      TOKEN,
      [
        {
          id: "theme-0",
          text: "合成主题",
          // These fields must NEVER appear in the JSON body.
          overview: "LEAK_OVERVIEW",
          keyPoints: ["LEAK_KEYPOINT"],
          question: "LEAK_QUESTION",
          noteText: "LEAK_NOTE_TEXT",
          q: "LEAK_Q",
          token: "LEAK_TOKEN",
          wereadBookId: "LEAK_WBID",
          noteId: "LEAK_NID",
          chapterTitle: "LEAK_CHAPTER",
        } as unknown as import("./wereadPrivate").WereadRelatedBookSeed,
      ],
      ["13000000_000000000001"]
    );
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const init = call[1];
    const body = JSON.parse(init.body as string);
    expect(Object.keys(body.seeds[0]).sort()).toEqual(["id", "text"]);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("LEAK_OVERVIEW");
    expect(serialized).not.toContain("LEAK_KEYPOINT");
    expect(serialized).not.toContain("LEAK_NOTE_TEXT");
    expect(serialized).not.toContain("LEAK_Q");
    expect(serialized).not.toContain("LEAK_TOKEN");
    expect(serialized).not.toContain("LEAK_WBID");
    expect(serialized).not.toContain("LEAK_NID");
    expect(serialized).not.toContain("LEAK_CHAPTER");
  });

  it("supports AbortSignal — passes the signal to fetch", async () => {
    const ctl = new AbortController();
    await (
      await import("./wereadPrivate")
    ).fetchWereadRelatedBooks(
      TOKEN,
      [{ id: "theme-0", text: "合成主题" }],
      [],
      ctl.signal
    );
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[1].signal).toBe(ctl.signal);
  });

  it("returns meta in the response", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          items: [{ catalogId: "13000000_000000000001", title: "x", matchedSeedIds: ["theme-0"] }],
          meta: { seedsUsed: 1, candidatesConsidered: 1, returned: 1, excluded: 0, persisted: false, source: "meilisearch" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    const out = await (
      await import("./wereadPrivate")
    ).fetchWereadRelatedBooks(TOKEN, [{ id: "theme-0", text: "合成主题" }]);
    expect(out.meta.persisted).toBe(false);
    expect(out.meta.source).toBe("meilisearch");
  });

  it("error responses surface generic messages without token / seed text leak", async () => {
    for (const status of [401, 403, 429, 500] as const) {
      fetchMock.mockReset();
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ error: `generic-${status}` }), { status })
      );
      try {
        await (
          await import("./wereadPrivate")
        ).fetchWereadRelatedBooks(TOKEN, [
          { id: "theme-0", text: "合成主题-LEAK" },
        ]);
        throw new Error("expected-reject");
      } catch (e) {
        if (e instanceof Error && e.message === "expected-reject") {
          throw new Error("did not throw");
        }
        const msg = (e as Error).message;
        expect(msg).toContain(`generic-${status}`);
        expect(msg).not.toContain("token-for-s27g");
        expect(msg).not.toContain("合成主题-LEAK");
      }
    }
  });

  it("excludes malformed catalog ids from excludeCatalogIds", async () => {
    await (
      await import("./wereadPrivate")
    ).fetchWereadRelatedBooks(
      TOKEN,
      [{ id: "theme-0", text: "合成主题" }],
      ["bad", 1, null, "13000000_000000000099", "13000000_000000000099"]
    );
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(call[1].body as string);
    expect(body.excludeCatalogIds).toEqual(["13000000_000000000099"]);
  });

  it("dedupes duplicate seeds by text and caps to 6", async () => {
    await (
      await import("./wereadPrivate")
    ).fetchWereadRelatedBooks(TOKEN, [
      { id: "a", text: "重复主题" },
      { id: "b", text: "  重复主题  " },
      { id: "c", text: "另一主题" },
      { id: "d", text: "X1" },
      { id: "e", text: "X2" },
      { id: "f", text: "X3" },
      { id: "g", text: "X4" },
      { id: "h", text: "X5" },
    ]);
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(call[1].body as string);
    // The dedupe map collapses the first two into one.
    // Then plus 3 unique themes = 4 seeds. The rest are dropped by cap (6).
    expect(body.seeds.length).toBeLessThanOrEqual(6);
    expect(body.seeds[0].id).toBe("a");
  });

  it("rejects when seeds array is empty after sanitization", async () => {
    await expect(
      (
        await import("./wereadPrivate")
      ).fetchWereadRelatedBooks(TOKEN, [], [], undefined)
    ).rejects.toThrow();
  });
});

// S27H — fetchWereadReadingMap
describe("fetchWereadReadingMap (S27H)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const TOKEN = "token-for-s27h";

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          overview: {
            booksCount: 0,
            notesCount: 0,
            matchedCatalogsCount: 0,
            matchedNoteRecordsCount: 0,
            firstNoteAt: null,
            lastNoteAt: null,
            activeMonths: 0,
            currentStreakMonths: 0,
            longestStreakMonths: 0,
          },
          timeline: [],
          books: [],
          links: [],
          meta: {
            monthsRequested: 24,
            monthsReturned: 24,
            topBooksRequested: 12,
            topBooksReturned: 0,
            linksReturned: 0,
            persisted: false,
            source: "private_snapshot+public_catalog",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses default months=24 and topBooks=12 when no options provided", async () => {
    await (
      await import("./wereadPrivate")
    ).fetchWereadReadingMap(TOKEN);
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toContain("/private/weread/reading-map");
    expect(call[0]).toContain("months=24");
    expect(call[0]).toContain("topBooks=12");
    expect((call[1].method ?? "GET").toUpperCase()).toBe("GET");
  });

  it("attaches months and topBooks options", async () => {
    await (
      await import("./wereadPrivate")
    ).fetchWereadReadingMap(TOKEN, { months: 12, topBooks: 18 });
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toContain("months=12");
    expect(call[0]).toContain("topBooks=18");
  });

  it("sends the Bearer Authorization header", async () => {
    await (
      await import("./wereadPrivate")
    ).fetchWereadReadingMap(TOKEN);
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const headers = call[1].headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("forwards the AbortSignal to fetch", async () => {
    const controller = new AbortController();
    await (
      await import("./wereadPrivate")
    ).fetchWereadReadingMap(TOKEN, { signal: controller.signal });
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[1].signal).toBe(controller.signal);
  });

  it("returns a friendly error for 401/403/500 responses", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Invalid token." }), { status: 403 })
    );
    await expect(
      (await import("./wereadPrivate")).fetchWereadReadingMap(TOKEN)
    ).rejects.toThrow(/token|认证/i);

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "阅读地图生成失败。" }), { status: 500 })
    );
    await expect(
      (await import("./wereadPrivate")).fetchWereadReadingMap(TOKEN)
    ).rejects.toThrow(/阅读地图/);

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Missing token." }), { status: 401 })
    );
    await expect(
      (await import("./wereadPrivate")).fetchWereadReadingMap(TOKEN)
    ).rejects.toThrow(/token|认证/i);
  });

  it("returns the parsed response shape on success", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          overview: {
            booksCount: 5,
            notesCount: 10,
            matchedCatalogsCount: 5,
            matchedNoteRecordsCount: 8,
            firstNoteAt: "2026-01-01T00:00:00.000Z",
            lastNoteAt: "2026-07-01T00:00:00.000Z",
            activeMonths: 7,
            currentStreakMonths: 7,
            longestStreakMonths: 7,
          },
          timeline: [
            {
              month: "2026-07",
              total: 1,
              highlights: 1,
              thoughts: 0,
              reviews: 0,
              unknown: 0,
              matched: 1,
            },
          ],
          books: [],
          links: [],
          meta: {
            monthsRequested: 24,
            monthsReturned: 24,
            topBooksRequested: 12,
            topBooksReturned: 0,
            linksReturned: 0,
            persisted: false,
            source: "private_snapshot+public_catalog",
          },
        }),
        { status: 200 }
      )
    );
    const resp = await (
      await import("./wereadPrivate")
    ).fetchWereadReadingMap(TOKEN, { months: 6 });
    expect(resp.ok).toBe(true);
    expect(resp.overview.activeMonths).toBe(7);
    expect(resp.meta.persisted).toBe(false);
    expect(resp.meta.source).toBe("private_snapshot+public_catalog");
  });

  it("never logs or echoes the token / catalogIds / response body", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          overview: {
            booksCount: 0,
            notesCount: 0,
            matchedCatalogsCount: 0,
            matchedNoteRecordsCount: 0,
            firstNoteAt: null,
            lastNoteAt: null,
            activeMonths: 0,
            currentStreakMonths: 0,
            longestStreakMonths: 0,
          },
          timeline: [],
          books: [],
          links: [],
          meta: {
            monthsRequested: 24,
            monthsReturned: 24,
            topBooksRequested: 12,
            topBooksReturned: 0,
            linksReturned: 0,
            persisted: false,
            source: "private_snapshot+public_catalog",
          },
        }),
        { status: 200 }
      )
    );
    const resp = await (
      await import("./wereadPrivate")
    ).fetchWereadReadingMap(TOKEN);
    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errSpy).not.toHaveBeenCalled();
    expect(resp).toBeDefined();
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errSpy.mockRestore();
  });
});
