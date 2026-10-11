import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetWebAuthStoreForTests, __setWebAuthSnapshotForTests, ensureAuthSessionLoaded,
} from "../auth/session";
import {
  createBookNote, deleteBookResource, getBookWorkspace, listLibrary, safeResourceUrl,
  saveBookWorkspace, updateBookNote, type BookWorkspaceData,
} from "./api";

vi.mock("../auth/session", async importOriginal => ({
  ...await importOriginal<typeof import("../auth/session")>(),
  ensureAuthSessionLoaded: vi.fn(async () => {}),
}));

const now = "2026-10-11T02:00:00Z";
const auth = (csrf = "csrf-a") => ({ status: "authenticated" as const, user: { email: "owner@example.test", name: "Owner" }, csrfToken: csrf, error: null });
const workspace = (bookId = "book/a"): BookWorkspaceData => ({
  bookId, saved: true, editionId: "edition-a", introduction: "介绍", version: 2,
  updatedAt: now, notes: [], resources: [],
});
const fetcher = vi.fn<typeof fetch>();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const listItem = { bookId: "book/a", editionId: "edition-a", title: "书名", author: null, publisher: null, year: null,
  introductionExcerpt: "原介绍", noteCount: 1, resourceCount: 0, updatedAt: now };

beforeEach(() => {
  vi.clearAllMocks();
  __resetWebAuthStoreForTests();
  __setWebAuthSnapshotForTests(auth());
  vi.stubGlobal("fetch", fetcher);
  fetcher.mockResolvedValue(json({ item: workspace() }));
});
afterEach(() => { vi.unstubAllGlobals(); __resetWebAuthStoreForTests(); });

describe("book library private API", () => {
  it("never sends anonymous reads or writes", async () => {
    __setWebAuthSnapshotForTests({ status: "unauthenticated", user: null, csrfToken: null, error: null });
    await expect(getBookWorkspace("book/a")).rejects.toMatchObject({ status: 401 });
    await expect(saveBookWorkspace("book/a", {})).rejects.toMatchObject({ status: 401 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("uses same-origin credentials and CSRF on mutations, including DELETE", async () => {
    await saveBookWorkspace("book/a", { introduction: "新介绍", baseVersion: 2 });
    expect(fetcher).toHaveBeenLastCalledWith("/api/private/s32/library/books/book%2Fa", expect.objectContaining({
      method: "PUT", credentials: "same-origin", cache: "no-store",
      headers: { "content-type": "application/json", "x-csrf-token": "csrf-a" },
      body: JSON.stringify({ introduction: "新介绍", baseVersion: 2 }),
    }));
    fetcher.mockResolvedValueOnce(json({ item: workspace() }));
    await deleteBookResource("book/a", "resource/b");
    expect(fetcher).toHaveBeenLastCalledWith("/api/private/s32/library/books/book%2Fa/resources/resource%2Fb", expect.objectContaining({
      method: "DELETE", credentials: "same-origin", headers: { "x-csrf-token": "csrf-a" },
    }));
  });

  it("refuses an unsafe method without an in-memory token", async () => {
    __setWebAuthSnapshotForTests({ ...auth(), csrfToken: null });
    await expect(createBookNote("book/a", { title: "一", content: "二" })).rejects.toMatchObject({ status: 403 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("passes the original note revision in the update body", async () => {
    await updateBookNote("book/a", "note-1", { title: "标题", content: "正文", baseRevisionId: "revision-2" });
    expect(fetcher).toHaveBeenLastCalledWith(expect.stringContaining("/notes/note-1"), expect.objectContaining({
      method: "PUT", body: JSON.stringify({ title: "标题", content: "正文", baseRevisionId: "revision-2" }),
    }));
  });

  it("encodes list search, filter and pagination", async () => {
    fetcher.mockResolvedValueOnce(json({ items: [], page: 3, limit: 24, total: 0 }));
    await listLibrary({ page: 3, q: "北京 & 古道", filter: "notes" });
    const [path, options] = fetcher.mock.calls[0];
    const parsed = new URL(String(path), "https://books.example.test");
    expect(parsed.searchParams.get("q")).toBe("北京 & 古道");
    expect(parsed.searchParams.get("page")).toBe("3");
    expect(parsed.searchParams.get("filter")).toBe("notes");
    expect(options).toMatchObject({ method: "GET", credentials: "same-origin", headers: {} });
  });

  it("accepts optional legacy search metadata and both current content match kinds", async () => {
    for (const searchMatch of [undefined, null, { kind: "introduction", excerpt: "介绍中的古道" },
      { kind: "note", noteId: "note/a", noteTitle: "我的古道记录", excerpt: `…${"𠮷".repeat(240)}…` }]) {
      const entry = { ...listItem, ...(searchMatch === undefined ? {} : { searchMatch }) };
      fetcher.mockResolvedValueOnce(json({ items: [entry], page: 1, limit: 24, total: 1 }));
      expect((await listLibrary({ page: 1, q: "古道" })).items[0]).toEqual(entry);
    }
  });

  it("rejects malformed match metadata instead of presenting it as a valid content hit", async () => {
    for (const searchMatch of [
      { kind: "note", excerpt: "正文", noteTitle: "缺少编号" },
      { kind: "note", excerpt: "正文", noteId: "note-a", noteTitle: 7 },
      { kind: "introduction", excerpt: ["错误类型"] },
      { kind: "weread", excerpt: "不属于这个搜索范围" },
      { kind: "introduction", excerpt: "𠮷".repeat(243) },
    ]) {
      fetcher.mockResolvedValueOnce(json({ items: [{ ...listItem, searchMatch }], page: 1, limit: 24, total: 1 }));
      await expect(listLibrary({ page: 1, q: "正文" })).rejects.toMatchObject({ status: 502 });
    }
  });

  it("rejects a valid workspace returned for the wrong book", async () => {
    fetcher.mockResolvedValueOnce(json({ item: workspace("another-book") }));
    await expect(getBookWorkspace("book/a")).rejects.toMatchObject({ status: 502 });
  });

  it("does not accept a malformed success body as an empty personal book", async () => {
    fetcher.mockResolvedValueOnce(json({ item: { bookId: "book/a", saved: false } }));
    await expect(getBookWorkspace("book/a")).rejects.toMatchObject({ status: 502 });
  });

  it("uses a safe conflict message and preserves the error code", async () => {
    fetcher.mockResolvedValueOnce(json({ error: { code: "STALE_LIBRARY_VERSION", message: "database connection private detail" } }, 409));
    await expect(saveBookWorkspace("book/a", { introduction: "草稿", baseVersion: 0 })).rejects.toMatchObject({
      status: 409, code: "STALE_LIBRARY_VERSION", message: "内容已在其他页面发生变化。你的草稿已保留，请读取最新内容后再保存。",
    });
  });

  it("discards a late response after account generation changes", async () => {
    let finish!: (response: Response) => void;
    fetcher.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const pending = getBookWorkspace("book/a");
    __setWebAuthSnapshotForTests(auth("csrf-b"));
    finish(json({ item: workspace() }));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("does not let an old 401 refresh or overwrite a new session", async () => {
    let finish!: (response: Response) => void;
    fetcher.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const pending = getBookWorkspace("book/a");
    __setWebAuthSnapshotForTests(auth("csrf-b"));
    finish(json({ error: { code: "UNAUTHORIZED" } }, 401));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(ensureAuthSessionLoaded).not.toHaveBeenCalled();
  });

  it("resynchronizes an expired current session once", async () => {
    fetcher.mockResolvedValueOnce(json({ error: { code: "UNAUTHORIZED" } }, 401));
    await expect(getBookWorkspace("book/a")).rejects.toMatchObject({ status: 401 });
    expect(ensureAuthSessionLoaded).toHaveBeenCalledOnce();
  });
});

describe("electronic edition links", () => {
  it.each(["javascript:alert(1)", "data:text/html,hello", "file:///tmp/book.pdf", "/book.pdf", "ftp://example.test/book.pdf"])("does not render %s as an external resource", value => {
    expect(safeResourceUrl(value)).toBeNull();
  });
  it("accepts full HTTP(S) links and preserves their query and fragment", () => {
    expect(safeResourceUrl(" https://example.test/book.pdf?download=1#page=21 ")).toBe("https://example.test/book.pdf?download=1#page=21");
    expect(safeResourceUrl("http://example.test/book.epub")).toBe("http://example.test/book.epub");
  });
});
