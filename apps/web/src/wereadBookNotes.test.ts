import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetWebAuthStoreForTests, __setWebAuthSnapshotForTests } from "./auth/session";
import {
  fetchAllWereadBookNotes,
  fetchWereadBookNotes,
  fetchWereadNotes,
  isValidWereadCatalogId,
  type WereadNotesPageInfo,
  type WereadNotesQuery,
  type WereadNotesRequestOptions,
  type WereadPrivateNoteItem,
} from "./wereadPrivate";

const BOOK_A = "13000000_000000000001";
const BOOK_B = "13000000_000000000002";
const fetchMock = vi.fn<typeof fetch>();

function note(catalogId = BOOK_A): WereadPrivateNoteItem {
  return { type: "highlight", text: "合成划线", comment: "合成想法", createdAt: null,
    updatedAt: null, matched: true, catalogId, source: "private_weread" };
}

function page(items: unknown[] = [], pageInfo: Partial<WereadNotesPageInfo> = {}): Response {
  return new Response(JSON.stringify({
    ok: true, items,
    pageInfo: { limit: 20, offset: 0, total: items.length, hasMore: false, ...pageInfo },
    summary: { totalAfterFilter: items.length, highlights: items.length, thoughts: 0,
      reviews: 0, unknown: 0, matchedCount: items.length, unmatchedCount: 0 },
  }), { headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  __resetWebAuthStoreForTests();
  __setWebAuthSnapshotForTests({ status: "authenticated", user: { name: "Synthetic owner" },
    csrfToken: "synthetic-csrf", error: null });
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  __resetWebAuthStoreForTests();
});

describe("book-scoped WeRead notes", () => {
  it("validates trimmed public catalog ids against the notes API format and length", () => {
    expect(isValidWereadCatalogId(BOOK_A)).toBe(true);
    expect(isValidWereadCatalogId(`  ${BOOK_A}\n`)).toBe(true);
    expect(isValidWereadCatalogId(`${"1".repeat(115)}_000000000001`)).toBe(true);
    for (const invalid of ["", "  ", "private-book-name", "1_123", "1_000000000001?other=1",
      `${"1".repeat(116)}_000000000001`, undefined, null, 123, [BOOK_A]]) {
      expect(isValidWereadCatalogId(invalid)).toBe(false);
    }
  });

  it("rejects explicit empty, malformed and non-string ids before any fetch", async () => {
    for (const invalid of ["", " \n ", "private-book-name", undefined, null, 123, [BOOK_A]]) {
      await expect(fetchWereadNotes({ catalogId: invalid as string })).rejects.toMatchObject({
        status: 400, message: "书目编号格式不正确。",
      });
      await expect(fetchWereadBookNotes(invalid as string)).rejects.toMatchObject({ status: 400 });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserves the center's unscoped query and existing cookie authentication", async () => {
    fetchMock.mockResolvedValueOnce(page([note(BOOK_A), note(BOOK_B)]));
    const result = await fetchWereadNotes({ type: "highlight", matchedOnly: false, limit: 20 });
    expect(result.items).toHaveLength(2);
    const [url, init] = fetchMock.mock.calls[0];
    const params = new URL(String(url)).searchParams;
    expect(params.has("catalogId")).toBe(false);
    expect(params.get("matchedOnly")).toBe("false");
    expect(params.get("type")).toBe("highlight");
    expect(init).toMatchObject({ credentials: "same-origin", cache: "no-store" });
    expect(new Headers(init?.headers).has("Authorization")).toBe(false);
  });

  it("forces the requested book and matched records even when extra query keys arrive at runtime", async () => {
    fetchMock.mockResolvedValueOnce(page([note()]));
    const query: WereadNotesQuery = { catalogId: BOOK_B, matchedOnly: false, type: "thought",
      days: "30", hasComment: true, sort: "oldest", q: " 合成查询 ", limit: 10, offset: 20 };
    await fetchWereadBookNotes(` ${BOOK_A} `, query);
    const params = new URL(String(fetchMock.mock.calls[0][0])).searchParams;
    expect(Object.fromEntries(params)).toEqual({ catalogId: BOOK_A, matchedOnly: "true",
      type: "thought", days: "30", hasComment: "true", sort: "oldest", q: "合成查询", limit: "10", offset: "20" });
  });

  it("defaults single-book queries to all days and keeps legitimate duplicate excerpts", async () => {
    fetchMock.mockResolvedValueOnce(page([note(), note()]));
    const result = await fetchWereadBookNotes(BOOK_A);
    const params = new URL(String(fetchMock.mock.calls[0][0])).searchParams;
    expect(params.get("days")).toBe("all");
    expect(params.get("matchedOnly")).toBe("true");
    expect(result.items).toHaveLength(2);
  });

  it.each([
    ["another book", { ...note(BOOK_B), text: "OTHER_BOOK_PRIVATE_BODY" }],
    ["unmatched item", { ...note(), matched: false }],
    ["missing binding", { ...note(), catalogId: null }],
    ["invalid item", null],
  ])("rejects the entire page when it contains %s", async (_name, invalid) => {
    fetchMock.mockResolvedValueOnce(page([note(), invalid]));
    await expect(fetchWereadBookNotes(BOOK_A)).rejects.toMatchObject({
      status: 502, message: "微信读书记录与当前书目不一致，请重试。",
    });
  });

  it("rejects unusable response envelopes without displaying the response body", async () => {
    for (const body of [null, { ok: false, error: "PRIVATE_BODY" }, { ok: true, items: null },
      { ok: true, items: [], pageInfo: null, summary: {} }]) {
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body)));
      await expect(fetchWereadBookNotes(BOOK_A)).rejects.toMatchObject({
        status: 502, message: "微信读书记录暂时无法读取，请稍后重试。",
      });
    }
  });

  it("keeps every export page scoped and passes the same cancellation signal to each request", async () => {
    const controller = new AbortController();
    fetchMock.mockResolvedValueOnce(page([note(), note()], { limit: 2, total: 3, hasMore: true }))
      .mockResolvedValueOnce(page([note()], { limit: 2, offset: 2, total: 3 }));
    const result = await fetchAllWereadBookNotes(BOOK_A, { pageSize: 2, signal: controller.signal });
    expect(result).toMatchObject({ total: 3, truncated: false });
    expect(result.items).toHaveLength(3);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fetchMock.mock.calls.forEach(([url, init], index) => {
      const params = new URL(String(url)).searchParams;
      expect(params.get("catalogId")).toBe(BOOK_A);
      expect(params.get("matchedOnly")).toBe("true");
      expect(params.get("offset")).toBe(String(index * 2));
      expect(params.get("limit")).toBe("2");
      expect(init?.signal).toBe(controller.signal);
    });
  });

  it("rejects an export if a later page belongs to another book", async () => {
    fetchMock.mockResolvedValueOnce(page([note()], { limit: 1, total: 2, hasMore: true }))
      .mockResolvedValueOnce(page([note(BOOK_B)], { limit: 1, offset: 1, total: 2 }));
    await expect(fetchAllWereadBookNotes(BOOK_A, { pageSize: 1 })).rejects.toMatchObject({ status: 502 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not expose server errors or network messages containing private content", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "PRIVATE_BODY_AND_QUERY" }), { status: 503 }));
    await expect(fetchWereadNotes({ q: "PRIVATE_QUERY" })).rejects.toMatchObject({
      status: 503, message: "微信读书记录暂时无法读取，请稍后重试。",
    });
    fetchMock.mockRejectedValueOnce(new Error("request to PRIVATE_QUERY failed"));
    await expect(fetchWereadBookNotes(BOOK_A)).rejects.toMatchObject({
      status: 502, message: "微信读书记录暂时无法读取，请稍后重试。",
    });
  });
});

const requests: Array<[string, (options: WereadNotesRequestOptions) => Promise<unknown>]> = [
  ["center", options => fetchWereadNotes({}, options)],
  ["single book", options => fetchWereadBookNotes(BOOK_A, {}, options)],
  ["export", options => fetchAllWereadBookNotes(BOOK_A, options)],
];

describe.each(requests)("%s request cancellation", (_name, request) => {
  it("does not fetch when cancelled before the request", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(request({ signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("cancels the active fetch rather than waiting for the next page", async () => {
    const controller = new AbortController();
    fetchMock.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }));
    const pending = request({ signal: controller.signal });
    const rejection = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]?.signal).toBe(controller.signal);
    controller.abort();
    await rejection;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

it("preserves cancellation while a successful response body is still being read", async () => {
  const controller = new AbortController();
  const response = page([note()]);
  const readBody = vi.spyOn(response, "json").mockImplementation(() => new Promise((_resolve, reject) => {
    controller.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  }));
  fetchMock.mockResolvedValueOnce(response);
  const pending = fetchWereadBookNotes(BOOK_A, {}, { signal: controller.signal });
  const rejection = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  await vi.waitFor(() => expect(readBody).toHaveBeenCalledTimes(1));
  controller.abort();
  await rejection;
});
