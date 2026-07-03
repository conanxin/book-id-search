import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearWereadStatusCache,
  clearWereadToken,
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
