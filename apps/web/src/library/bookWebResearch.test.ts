import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetWebAuthStoreForTests, __setWebAuthSnapshotForTests } from "../auth/session";
import { bookWebResearchContent, generateBookWebResearch, type BookWebResearchInput, type BookWebResearchResponse } from "./bookWebResearch";

const A = "14000000_000000000001", B = "14000001_000000000002", QUESTION = "这本书有哪些相关研究？";
const fetchMock = vi.fn<typeof fetch>();
function login(csrfToken: string | null = "synthetic-current-csrf") {
  __setWebAuthSnapshotForTests({ status: "authenticated", user: { email: "owner@example.test", name: "合成账号" }, csrfToken, error: null });
}
function result(): BookWebResearchResponse {
  return {
    bookId: A, question: QUESTION, source: "web_research", generatedAt: "2026-10-11T12:00:00.000Z",
    draft: { title: "古道研究线索", content: "这条研究资料讨论了旅行史和地方文献之间的联系。[W1]" },
    sources: [
      { id: "W1", kind: "web", title: "某馆藏研究目录", url: "https://catalog.example.test/books/1", excerpt: "旅行史研究目录。\n与地方文献对照。", pageAge: "2025-01-01", truncated: false },
      { id: "W2", kind: "web", title: "其他搜索结果", url: "https://journal.example.test/papers/2", excerpt: "另一条搜索摘要", pageAge: null, truncated: false },
    ],
    citedSourceIds: ["W1"], search: { performed: true, queries: ["古道 旅行史 相关研究"], calls: 1 },
  };
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => { __resetWebAuthStoreForTests(); login(); fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); __resetWebAuthStoreForTests(); });

describe("book web research client", () => {
  it("posts only the explicit question to the selected book with session and CSRF, without a library write", async () => {
    const controller = new AbortController(); fetchMock.mockResolvedValue(json(result()));
    expect(await generateBookWebResearch(A, { question: `  ${QUESTION}  ` }, controller.signal)).toEqual(result());
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe(`/api/ai/books/${A}/research`);
    expect(options).toMatchObject({ method: "POST", credentials: "same-origin", cache: "no-store", signal: controller.signal });
    expect(JSON.parse(String(options?.body))).toEqual({ question: QUESTION });
    const headers = new Headers(options?.headers);
    expect(headers.get("x-csrf-token")).toBe("synthetic-current-csrf");
    expect(headers.has("authorization")).toBe(false);
  });

  it("requires a current Google session and CSRF before sending the question", async () => {
    __setWebAuthSnapshotForTests({ status: "unauthenticated", user: null, csrfToken: null, error: null });
    await expect(generateBookWebResearch(A, { question: QUESTION })).rejects.toMatchObject({ status: 401 });
    login(null);
    await expect(generateBookWebResearch(A, { question: QUESTION })).rejects.toMatchObject({ status: 403 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { question: "" }, { question: " " }, { question: "字".repeat(1001) },
    { question: "bad\ud800" }, { question: "bad\0" },
    { question: QUESTION, notes: "never send this" }, { question: QUESTION, sources: [] },
  ])("does not send malformed or extra personal content %#", async value => {
    await expect(generateBookWebResearch(A, value as BookWebResearchInput)).rejects.toMatchObject({ status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["", "wrong", ` ${A}`, `${A}/other`])("rejects an invalid book ID %s before fetching", async id => {
    await expect(generateBookWebResearch(id, { question: QUESTION })).rejects.toMatchObject({ status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["other book", (r: BookWebResearchResponse) => { r.bookId = B; }],
    ["other question", (r: BookWebResearchResponse) => { r.question = "different question"; }],
    ["claimed search without trace", (r: BookWebResearchResponse) => { r.search.performed = false as true; }],
    ["missing search query", (r: BookWebResearchResponse) => { r.search.queries = []; }],
    ["zero calls", (r: BookWebResearchResponse) => { r.search.calls = 0; }],
    ["made-up source", (r: BookWebResearchResponse) => { r.citedSourceIds.push("W99"); r.draft.content += "[W99]"; }],
    ["unmapped citation", (r: BookWebResearchResponse) => { r.draft.content += "[W2]"; }],
    ["missing citations", (r: BookWebResearchResponse) => { r.draft.content = "unsupported answer"; r.citedSourceIds = []; }],
    ["reused local citation", (r: BookWebResearchResponse) => { r.draft.content += "[S1]"; }],
    ["duplicate source IDs", (r: BookWebResearchResponse) => { r.sources[1].id = "W1"; }],
    ["duplicate source URLs", (r: BookWebResearchResponse) => { r.sources[1].url = r.sources[0].url; }],
    ["empty excerpt", (r: BookWebResearchResponse) => { r.sources[0].excerpt = ""; }],
    ["too much source material", (r: BookWebResearchResponse) => { r.sources = Array.from({ length: 9 }, (_, i) => ({ ...r.sources[0], id: `W${i + 1}`, url: `https://example.test/${i}`, excerpt: "x".repeat(3000) })); }],
    ["insufficient response claiming citations", (r: BookWebResearchResponse) => { r.source = "insufficient_sources"; }],
    ["invalid timestamp", (r: BookWebResearchResponse) => { r.generatedAt = "yesterday"; }],
  ])("rejects a request response containing %s", async (_name, change) => {
    const value = result(); change(value); fetchMock.mockResolvedValue(json(value));
    await expect(generateBookWebResearch(A, { question: QUESTION })).rejects.toMatchObject({ status: 502 });
  });

  it.each(["javascript:alert(1)", "/books/1", "//example.test/path", "https://user:pass@example.test/x", "https://example.test/with space", "https://example.test\\other"]) (
    "does not turn unsafe source URL %s into a citation", async url => {
      const value = result(); value.sources[0].url = url; fetchMock.mockResolvedValue(json(value));
      await expect(generateBookWebResearch(A, { question: QUESTION })).rejects.toMatchObject({ status: 502 });
    },
  );

  it("preserves repeated real searches and honest insufficient results, without inventing an answer", async () => {
    const value = result(); value.search = { performed: true, queries: ["实际搜词", "实际搜词"], calls: 2 };
    value.source = "insufficient_sources"; value.sources = []; value.citedSourceIds = [];
    value.draft = { title: "资料不足", content: "这次未找到足够的网页资料。" };
    fetchMock.mockResolvedValue(json(value));
    expect(await generateBookWebResearch(A, { question: QUESTION })).toEqual(value);
    expect(() => bookWebResearchContent(value)).toThrow("本次资料不足");
  });

  it("copies the cited real URLs, search excerpts, question and timestamp without another request", () => {
    const value = result(), copied = bookWebResearchContent(value);
    expect(copied).toContain(`问题：${QUESTION}`);
    expect(copied).toContain(value.draft.content);
    expect(copied).toContain(value.generatedAt);
    expect(copied).toContain(value.search.queries[0]);
    expect(copied).toContain("https://catalog.example.test/books/1");
    expect(copied).toContain("> 旅行史研究目录。\n> 与地方文献对照。");
    expect(copied).toContain("搜索结果节选");
    expect(copied).not.toContain("https://journal.example.test/papers/2");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rechecks actual source citations before making copied text", () => {
    const value = result(); value.citedSourceIds.push("W99"); value.draft.content += "[W99]";
    expect(() => bookWebResearchContent(value)).toThrow("来源核对未完成");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps network/provider failures to bounded errors rather than provider payloads", async () => {
    fetchMock.mockResolvedValueOnce(json({ error: { code: "BOOK_RESEARCH_SEARCH_FAILED", message: "private upstream diagnostic" } }, 502));
    await expect(generateBookWebResearch(A, { question: QUESTION })).rejects.toMatchObject({ status: 502, message: "本次搜索或来源核对未完成，请重试。", code: "BOOK_RESEARCH_SEARCH_FAILED" });
    fetchMock.mockRejectedValueOnce(new Error("private network detail"));
    await expect(generateBookWebResearch(A, { question: QUESTION })).rejects.toMatchObject({ message: "暂时无法连接联网研究服务，请重试。" });
  });

  it("does not fetch an already cancelled request", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(generateBookWebResearch(A, { question: QUESTION }, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ignores a response when the transport disregards cancellation", async () => {
    const pending = deferred<Response>(), controller = new AbortController(); fetchMock.mockReturnValue(pending.promise);
    const request = generateBookWebResearch(A, { question: QUESTION }, controller.signal);
    const rejected = expect(request).rejects.toMatchObject({ name: "AbortError" });
    controller.abort(); pending.resolve(json(result())); await rejected;
  });

  it("discards parsed content if the Google session changes during JSON decoding", async () => {
    const pending = deferred<unknown>(), decoding = deferred<void>();
    fetchMock.mockResolvedValue({ ok: true, json: () => { decoding.resolve(); return pending.promise; } } as Response);
    const request = generateBookWebResearch(A, { question: QUESTION });
    const rejected = expect(request).rejects.toMatchObject({ name: "AbortError" });
    await decoding.promise; login("replacement-csrf"); pending.resolve(result()); await rejected;
  });
});
