import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetWebAuthStoreForTests, __setWebAuthSnapshotForTests } from "../auth/session";
import { bookWebResearchContent, bookWebSourceTextContexts, generateBookWebResearch, type BookWebResearchInput, type BookWebResearchResponse, type BookWebResearchSource, type BookWebResearchTextContext, type BookWebResearchTextContexts } from "./bookWebResearch";

const A = "14000000_000000000001", B = "14000001_000000000002", QUESTION = "这本书有哪些相关研究？";
const NOTICE = "已根据本次问题选出相关网页，以下保留搜索工具返回的来源节选。节选不等于网页或原书全文；来源之间可能有不同说法。";
const CLUES_NOTICE = "这里只展示当前标题和搜索节选中的文字线索，不确认同书、版本或资料类型，也不代表已读全文或内容可信。";
const SELECTED_ISBN_NOTICE = "所选资料尚缺可对应本书的 ISBN 线索；与本书的直接关联仍需核对。";
const UNSELECTED = "已完成网页搜索，但本次自动挑选未完成。下方保留搜索返回的资料，可以打开原链接核对或读取网页正文。";
const INSUFFICIENT = "本次已执行联网搜索，但没有选出与问题充分相关的资料。下方如有搜索结果，可以打开原链接核对，或调整问题后再查。";
const draftFor = (ids = ["W1"]) => ({ title: "查到的相关资料", content: `${NOTICE}\n\n建议先查看：${ids.map(id => `[${id}]`).join(" ")}` });
const fetchMock = vi.fn<typeof fetch>();
function login(csrfToken: string | null = "synthetic-current-csrf") {
  __setWebAuthSnapshotForTests({ status: "authenticated", user: { email: "owner@example.test", name: "合成账号" }, csrfToken, error: null });
}
function result(): BookWebResearchResponse {
  return {
    bookId: A, question: QUESTION, mode: "source_excerpts", source: "web_research", generatedAt: "2026-10-11T12:00:00.000Z",
    draft: draftFor(),
    sources: [
      { id: "W1", kind: "web", title: "某馆藏研究目录", url: "https://catalog.example.test/books/1", excerpt: "旅行史研究目录。\n与地方文献对照。", pageAge: "2025-01-01", truncated: false },
      { id: "W2", kind: "web", title: "其他搜索结果", url: "https://journal.example.test/papers/2", excerpt: "另一条搜索摘要", pageAge: null, truncated: false },
    ],
    citedSourceIds: ["W1"], search: { performed: true, queries: ["古道 旅行史 相关研究"], calls: 1 },
  };
}
function unselected(limited?: boolean): BookWebResearchResponse {
  const value = result();
  value.source = "unselected_sources"; value.citedSourceIds = [];
  value.draft = { title: "待核对的网页资料", content: UNSELECTED };
  value.sources.forEach((source, index) => { source.readToken = (index ? "B" : "A").repeat(32); });
  if (limited !== undefined) value.search.limited = limited;
  return value;
}
function textContext(source: BookWebResearchSource, field: "title" | "excerpt", value: string,
  kind: BookWebResearchTextContext["kind"], from = 0): BookWebResearchTextContext {
  const original = source[field], matchStart = original.indexOf(value, from);
  return { kind, field, value, matchStart, matchEnd: matchStart + value.length, start: 0, end: original.length, text: original };
}
function contextualResult(): BookWebResearchResponse {
  const value = result(), [first, second] = value.sources;
  first.title = "《旅行史》 第２版";
  first.excerpt = "另见《书名相同》与《另一本》，其中写着修訂版。\n  <script>保留原文与空白 😀</script>";
  first.bookClues = { isbn: "not_seen", text: ["title"] };
  first.textContexts = { items: [
    textContext(first, "title", "《旅行史》", "quoted_title"),
    textContext(first, "title", "第２版", "edition_text"),
    textContext(first, "excerpt", "《书名相同》", "quoted_title"),
    textContext(first, "excerpt", "《另一本》", "quoted_title"),
    textContext(first, "excerpt", "修訂版", "edition_text"),
  ], limited: false };
  second.title = "《未选书名》";
  second.excerpt = "这里写着再版，来源仍需人工核对。";
  second.textContexts = { items: [
    textContext(second, "title", "《未选书名》", "quoted_title"),
    textContext(second, "excerpt", "再版", "edition_text"),
  ], limited: false };
  value.sources.forEach((source, index) => { source.readToken = (index ? "B" : "A").repeat(32); });
  return value;
}
const contextsOf = (source: BookWebResearchSource) => source.textContexts as BookWebResearchTextContexts;
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

  it("accepts optional source read tokens without adding them to the copied search snapshot", async () => {
    const value = result(); value.sources[0].readToken = "A".repeat(32);
    fetchMock.mockResolvedValue(json(value));
    expect(await generateBookWebResearch(A, { question: QUESTION })).toEqual(value);
    expect(bookWebResearchContent(value)).not.toContain(value.sources[0].readToken);
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
    ["missing mode from an older response", (r: BookWebResearchResponse) => { delete (r as Partial<BookWebResearchResponse>).mode; }],
    ["unsupported research mode", (r: BookWebResearchResponse) => { Object.assign(r, { mode: "synthesis" }); }],
    ["free-form facts despite excerpt mode", (r: BookWebResearchResponse) => { r.draft.content = "模型推断本书版本相同。[W1]"; }],
    ["invented result title", (r: BookWebResearchResponse) => { r.draft.title = "模型推断的版本关系"; }],
    ["more than four selected sources", (r: BookWebResearchResponse) => {
      r.sources = Array.from({ length: 5 }, (_, i) => ({ ...r.sources[0], id: `W${i + 1}`, url: `https://example.test/${i}` }));
      r.citedSourceIds = r.sources.map(source => source.id); r.draft = draftFor(r.citedSourceIds);
    }],
    ["claimed search without trace", (r: BookWebResearchResponse) => { r.search.performed = false as true; }],
    ["missing search query", (r: BookWebResearchResponse) => { r.search.queries = []; }],
    ["zero calls", (r: BookWebResearchResponse) => { r.search.calls = 0; }],
    ["search calls without their queries", (r: BookWebResearchResponse) => { r.search.calls = 2; }],
    ["made-up source", (r: BookWebResearchResponse) => { r.citedSourceIds.push("W99"); r.draft.content += "[W99]"; }],
    ["unmapped citation", (r: BookWebResearchResponse) => { r.draft.content += "[W2]"; }],
    ["missing citations", (r: BookWebResearchResponse) => { r.draft.content = "unsupported answer"; r.citedSourceIds = []; }],
    ["reused local citation", (r: BookWebResearchResponse) => { r.draft.content += "[S1]"; }],
    ["duplicate source IDs", (r: BookWebResearchResponse) => { r.sources[1].id = "W1"; }],
    ["duplicate source URLs", (r: BookWebResearchResponse) => { r.sources[1].url = r.sources[0].url; }],
    ["empty excerpt", (r: BookWebResearchResponse) => { r.sources[0].excerpt = ""; }],
    ["malformed source read token", (r: BookWebResearchResponse) => { r.sources[0].readToken = "not-a-source-token"; }],
    ["too much source material", (r: BookWebResearchResponse) => { r.sources = Array.from({ length: 9 }, (_, i) => ({ ...r.sources[0], id: `W${i + 1}`, url: `https://example.test/${i}`, excerpt: "x".repeat(3000) })); }],
    ["insufficient response claiming citations", (r: BookWebResearchResponse) => { r.source = "insufficient_sources"; }],
    ["invalid timestamp", (r: BookWebResearchResponse) => { r.generatedAt = "yesterday"; }],
  ])("rejects a request response containing %s", async (_name, change) => {
    const value = result(); change(value); fetchMock.mockResolvedValue(json(value));
    await expect(generateBookWebResearch(A, { question: QUESTION })).rejects.toMatchObject({ status: 502, code: "BOOK_RESEARCH_CLIENT_INVALID_RESPONSE" });
  });

  it.each(["javascript:alert(1)", "/books/1", "//example.test/path", "https://user:pass@example.test/x", "https://example.test/with space", "https://example.test\\other"]) (
    "does not turn unsafe source URL %s into a citation", async url => {
      const value = result(); value.sources[0].url = url; fetchMock.mockResolvedValue(json(value));
      await expect(generateBookWebResearch(A, { question: QUESTION })).rejects.toMatchObject({ status: 502, code: "BOOK_RESEARCH_CLIENT_INVALID_RESPONSE" });
    },
  );

  it("preserves repeated real searches and honest insufficient results, without inventing an answer", async () => {
    const value = result(); value.search = { performed: true, queries: ["实际搜词", "实际搜词"], calls: 2 };
    value.source = "insufficient_sources"; value.sources = []; value.citedSourceIds = [];
    value.draft = { title: "查到的相关资料", content: INSUFFICIENT };
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
    expect(copied).toContain("旅行史研究目录。\n与地方文献对照。");
    expect(copied).toContain("搜索结果节选");
    expect(copied).not.toContain("https://journal.example.test/papers/2");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rechecks actual source citations before making copied text", () => {
    const value = result(); value.citedSourceIds.push("W99"); value.draft.content += "[W99]";
    expect(() => bookWebResearchContent(value)).toThrow("返回的研究资料未通过核对");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("copies selected sources in chosen order and preserves their complete literal excerpts", () => {
    const value = result(); value.citedSourceIds = ["W2", "W1"]; value.draft = draftFor(value.citedSourceIds);
    value.sources[0].excerpt = "原文标题\r\n**这是来源中的原文符号**\n" + "完整来源节选。".repeat(100);
    const copied = bookWebResearchContent(value);
    expect(copied).toContain(value.sources[0].excerpt);
    expect(copied.indexOf(value.sources[1].url)).toBeLessThan(copied.indexOf(value.sources[0].url));
    expect(copied).toContain(NOTICE);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects old or fabricated excerpt mode before copying any generated facts", () => {
    const old = result(); delete (old as Partial<BookWebResearchResponse>).mode;
    expect(() => bookWebResearchContent(old)).toThrow("返回的研究资料未通过核对");
    const forged = result(); forged.draft.content = "两个出版社属于同一版本。[W1]";
    expect(() => bookWebResearchContent(forged)).toThrow("返回的研究资料未通过核对");
  });

  it("maps network/provider failures to bounded errors rather than provider payloads", async () => {
    fetchMock.mockResolvedValueOnce(json({ error: { code: "BOOK_RESEARCH_SEARCH_FAILED", message: "private upstream diagnostic" } }, 502));
    await expect(generateBookWebResearch(A, { question: QUESTION })).rejects.toMatchObject({ status: 502, message: "本次网页搜索未完成，请稍后重试。", code: "BOOK_RESEARCH_SEARCH_FAILED" });
    fetchMock.mockRejectedValueOnce(new Error("private network detail"));
    await expect(generateBookWebResearch(A, { question: QUESTION })).rejects.toMatchObject({ message: "暂时无法连接联网研究服务，请重试。" });
  });


  it.each([undefined, false, true])("accepts optional limited=%s and preserves its meaning in copied results", async limited => {
    const value = result();
    if (limited !== undefined) value.search.limited = limited;
    fetchMock.mockResolvedValue(json(value));
    expect(await generateBookWebResearch(A, { question: QUESTION })).toEqual(value);
    const copied = bookWebResearchContent(value);
    const notice = "本次搜索已达到上限，已保留返回的资料。可以调整问题后再查。";
    if (limited === true) expect(copied).toContain(notice);
    else expect(copied).not.toContain(notice);
    expect(copied).toContain(value.sources[0].excerpt);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([null, "true", "false", 0, 1, {}, []])("rejects a non-boolean search limit flag %# as a local response mismatch", async limited => {
    const value = result(); Object.assign(value.search, { limited });
    fetchMock.mockResolvedValue(json(value));
    await expect(generateBookWebResearch(A, { question: QUESTION })).rejects.toMatchObject({
      status: 502, code: "BOOK_RESEARCH_CLIENT_INVALID_RESPONSE", message: "返回的研究资料未通过核对，请重新查询。",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([
    [502, "BOOK_RESEARCH_SEARCH_FAILED", "本次网页搜索未完成，请稍后重试。"],
    [502, "BOOK_RESEARCH_INVALID_RESPONSE", "本次来源挑选结果未通过核对，请重新查询。"],
    [502, "BOOK_RESEARCH_SELECTION_FAILED", "网页搜索已完成，但来源挑选未完成，请重试。"],
    [504, "BOOK_RESEARCH_SEARCH_TIMEOUT", "本次网页搜索超时，请稍后重试。"],
    [504, "BOOK_RESEARCH_SELECTION_TIMEOUT", "网页搜索已完成，但来源挑选超时，请重试。"],
    [429, "BOOK_RESEARCH_SEARCH_RATE_LIMITED", "网页搜索请求较多，请稍后重试。"],
    [429, "BOOK_RESEARCH_SELECTION_RATE_LIMITED", "来源挑选请求较多，请稍后重试。"],
    [503, "BOOK_RESEARCH_UNAVAILABLE", "联网研究暂不可用，请稍后重试。"],
  ] as const)("maps %s/%s to a bounded stage-specific message without retrying", async (status, code, message) => {
    fetchMock.mockResolvedValue(json({ error: { code, message: "private upstream detail" } }, status));
    await expect(generateBookWebResearch(A, { question: QUESTION })).rejects.toMatchObject({ status, code, message });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([
    [502, "BOOK_RESEARCH_UNKNOWN", "本次搜索或来源核对未完成，请重试。"],
    [502, "BOOK_RESEARCH_SEARCH_TIMEOUT", "本次搜索或来源核对未完成，请重试。"],
    [502, "BOOK_RESEARCH_CLIENT_INVALID_RESPONSE", "本次搜索或来源核对未完成，请重试。"],
    [504, "BOOK_RESEARCH_SEARCH_FAILED", "本次研究超时，请稍后重试。"],
    [500, "BOOK_RESEARCH_SELECTION_FAILED", "暂时无法完成研究，请稍后重试。"],
  ] as const)("keeps unknown or mismatched %s/%s errors safe", async (status, code, message) => {
    fetchMock.mockResolvedValue(json({ error: { code, message: "<script>private upstream detail</script>" } }, status));
    await expect(generateBookWebResearch(A, { question: QUESTION })).rejects.toMatchObject({ status, code, message });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("keeps a non-JSON gateway 502 generic and distinguishes malformed HTTP 200 content", async () => {
    fetchMock.mockResolvedValueOnce(new Response("<html>private gateway detail</html>", { status: 502 }));
    await expect(generateBookWebResearch(A, { question: QUESTION })).rejects.toMatchObject({
      status: 502, code: undefined, message: "本次搜索或来源核对未完成，请重试。",
    });
    fetchMock.mockResolvedValueOnce(new Response("<html>private gateway detail</html>", { status: 200 }));
    await expect(generateBookWebResearch(A, { question: QUESTION })).rejects.toMatchObject({
      status: 502, code: "BOOK_RESEARCH_CLIENT_INVALID_RESPONSE", message: "返回的研究资料未通过核对，请重新查询。",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });


  it.each([undefined, false, true])("accepts unselected original sources and copies every source without invented recommendations (limited=%s)", async limited => {
    const value = unselected(limited);
    fetchMock.mockResolvedValue(json(value));
    expect(await generateBookWebResearch(A, { question: QUESTION })).toEqual(value);
    const copied = bookWebResearchContent(value);
    expect(copied).toContain("# 待核对的网页资料");
    expect(copied).toContain(UNSELECTED);
    expect(copied).toContain(QUESTION);
    expect(copied).toContain(value.generatedAt);
    expect(copied).not.toContain("建议先查看");
    for (const source of value.sources) {
      expect(copied).toContain(source.title);
      expect(copied).toContain(source.url);
      expect(copied).toContain(source.excerpt);
      expect(copied).not.toContain(source.readToken);
    }
    expect(copied.indexOf(value.sources[0].url)).toBeLessThan(copied.indexOf(value.sources[1].url));
    const notice = "本次搜索已达到上限，已保留返回的资料。可以调整问题后再查。";
    if (limited) expect(copied).toContain(notice);
    else expect(copied).not.toContain(notice);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([
    ["no sources", (value: BookWebResearchResponse) => { value.sources = []; }],
    ["claimed selected ID", (value: BookWebResearchResponse) => { value.citedSourceIds = ["W1"]; }],
    ["invented selected ID", (value: BookWebResearchResponse) => { value.citedSourceIds = ["W99"]; }],
    ["old selected title", (value: BookWebResearchResponse) => { value.draft.title = "查到的相关资料"; }],
    ["generated title", (value: BookWebResearchResponse) => { value.draft.title = "AI 已推荐的资料"; }],
    ["insufficient text", (value: BookWebResearchResponse) => { value.draft.content = INSUFFICIENT; }],
    ["invented fallback text", (value: BookWebResearchResponse) => { value.draft.content = "AI 已确认本书版本相同。"; }],
    ["unsupported source", (value: BookWebResearchResponse) => { Object.assign(value, { source: "partial_answer" }); }],
    ["unselected text labelled selected", (value: BookWebResearchResponse) => { value.source = "web_research"; }],
    ["unselected text labelled insufficient", (value: BookWebResearchResponse) => { value.source = "insufficient_sources"; }],
    ["duplicate URL", (value: BookWebResearchResponse) => { value.sources[1].url = value.sources[0].url; }],
    ["malformed limit", (value: BookWebResearchResponse) => { Object.assign(value.search, { limited: "true" }); }],
    ["missing completed trace", (value: BookWebResearchResponse) => { value.search.queries = []; value.search.calls = 0; }],
  ] as const)("rejects unselected results with %s before rendering or copying", async (_label, change) => {
    const value = unselected(true); change(value);
    fetchMock.mockResolvedValue(json(value));
    await expect(generateBookWebResearch(A, { question: QUESTION })).rejects.toMatchObject({
      status: 502, code: "BOOK_RESEARCH_CLIENT_INVALID_RESPONSE",
    });
    expect(() => bookWebResearchContent(value)).toThrow("返回的研究资料未通过核对");
    expect(fetchMock).toHaveBeenCalledOnce();
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

  it.each([
    ["matched", ["title", "author"], "出现本书 ISBN；出现书名文字；出现作者文字"],
    ["mixed", [], "本书与其他 ISBN 同时出现"],
    ["other_only", ["title"], "只看到其他 ISBN；出现书名文字"],
    ["not_seen", ["author"], "未见本书 ISBN；出现作者文字"],
    ["unavailable", [], "本书 ISBN 无法用于比对"],
  ] as const)("accepts and copies the bounded visible book clues for %s", async (isbn, text, label) => {
    const value = result();
    value.sources[0].bookClues = { isbn, text: [...text] };
    value.sources[0].readToken = "A".repeat(32);
    fetchMock.mockResolvedValue(json(value));
    expect(await generateBookWebResearch(A, { question: QUESTION })).toEqual(value);
    const copied = bookWebResearchContent(value);
    expect(copied).toContain("书目线索：" + label);
    expect(copied).toContain(CLUES_NOTICE);
    expect(copied).toContain(value.sources[0].excerpt);
    expect(copied).not.toContain(value.sources[0].readToken);
    expect(copied).not.toContain("已核实本书");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([
    ["null", null],
    ["array", []],
    ["missing isbn", { text: [] }],
    ["missing text", { isbn: "matched" }],
    ["unknown isbn", { isbn: "verified", text: [] }],
    ["non-string isbn", { isbn: true, text: [] }],
    ["inherited label name", { isbn: "toString", text: [] }],
    ["text string", { isbn: "matched", text: "title" }],
    ["unknown text", { isbn: "matched", text: ["publisher"] }],
    ["duplicate title", { isbn: "matched", text: ["title", "title"] }],
    ["duplicate author", { isbn: "matched", text: ["author", "author"] }],
    ["reversed text", { isbn: "matched", text: ["author", "title"] }],
    ["too much text", { isbn: "matched", text: ["title", "author", "title"] }],
    ["extra judgement", { isbn: "matched", text: [], review: "This content is verified." }],
  ])("rejects malformed book clues (%s) before rendering or copying", async (_label, bookClues) => {
    const value = result();
    Object.assign(value.sources[0], { bookClues });
    fetchMock.mockResolvedValue(json(value));
    await expect(generateBookWebResearch(A, { question: QUESTION })).rejects.toMatchObject({
      status: 502, code: "BOOK_RESEARCH_CLIENT_INVALID_RESPONSE",
    });
    expect(() => bookWebResearchContent(value)).toThrow("返回的研究资料未通过核对");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("keeps old responses explicitly unchecked even when an excerpt contains an ISBN", async () => {
    const value = result();
    value.sources[0].excerpt = "ISBN 9787112124534 出现在原始搜索节选中。";
    fetchMock.mockResolvedValue(json(value));
    expect(await generateBookWebResearch(A, { question: QUESTION })).toEqual(value);
    const copied = bookWebResearchContent(value);
    expect(copied).toContain("书目线索未核对");
    expect(copied).toContain(CLUES_NOTICE);
    expect(copied).toContain(value.sources[0].excerpt);
    expect(copied).not.toContain("出现本书 ISBN");
    expect(copied).not.toContain(SELECTED_ISBN_NOTICE);
  });

  it.each([
    ["known missing clues", "not_seen", "other_only", ["W2", "W1"], true],
    ["matched among selected", "matched", "not_seen", ["W2", "W1"], false],
    ["mixed among selected", "mixed", "not_seen", ["W2", "W1"], false],
    ["legacy among selected", undefined, "not_seen", ["W2", "W1"], false],
    ["unavailable among selected", "unavailable", "not_seen", ["W2", "W1"], true],
    ["unselected match", "matched", "not_seen", ["W2"], true],
    ["unselected legacy", undefined, "not_seen", ["W2"], true],
  ] as const)("copies the selected ISBN notice only when justified by %s", (_name, first, second, ids, expected) => {
    const value = result();
    if (first) value.sources[0].bookClues = { isbn: first, text: [] };
    value.sources[1].bookClues = { isbn: second, text: [] };
    value.citedSourceIds = [...ids]; value.draft = draftFor(value.citedSourceIds);
    const copied = bookWebResearchContent(value);
    expect(copied.includes(SELECTED_ISBN_NOTICE)).toBe(expected);
    expect(copied).toContain(CLUES_NOTICE);
    if (ids.length === 2) expect(copied.indexOf(value.sources[1].url)).toBeLessThan(copied.indexOf(value.sources[0].url));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("copies all available insufficient sources with their uncertainty and the fixed insufficient notice", async () => {
    const value = unselected(true);
    value.source = "insufficient_sources";
    value.draft = { title: "查到的相关资料", content: INSUFFICIENT };
    value.sources[0].bookClues = { isbn: "other_only", text: ["author"] };
    fetchMock.mockResolvedValue(json(value));
    expect(await generateBookWebResearch(A, { question: QUESTION })).toEqual(value);
    const copied = bookWebResearchContent(value);
    expect(copied).toContain("# 本次搜索资料不足");
    expect(copied).toContain(INSUFFICIENT);
    expect(copied).toContain(CLUES_NOTICE);
    expect(copied).toContain("只看到其他 ISBN；出现作者文字");
    expect(copied).toContain("书目线索未核对");
    expect(copied).toContain("本次搜索已达到上限，已保留返回的资料。可以调整问题后再查。");
    expect(copied).not.toContain("建议先查看");
    expect(copied).not.toContain(SELECTED_ISBN_NOTICE);
    for (const source of value.sources) {
      expect(copied).toContain(source.title);
      expect(copied).toContain(source.url);
      expect(copied).toContain(source.excerpt);
      expect(copied).not.toContain(source.readToken);
    }
    expect(copied.indexOf(value.sources[0].url)).toBeLessThan(copied.indexOf(value.sources[1].url));
  });

  it("copies unselected clues without implying that any sources were selected", () => {
    const value = unselected();
    value.sources.forEach(source => { source.bookClues = { isbn: "not_seen", text: [] }; });
    const copied = bookWebResearchContent(value);
    expect(copied).toContain(UNSELECTED);
    expect(copied).toContain(CLUES_NOTICE);
    expect(copied.match(/书目线索：未见本书 ISBN/g)).toHaveLength(2);
    expect(copied).not.toContain(SELECTED_ISBN_NOTICE);
    expect(copied).not.toContain("建议先查看");
  });


  it("copies only selected literal contexts, preserving field order, original whitespace and provenance", async () => {
    const value = contextualResult(), before = JSON.stringify(value), source = value.sources[0];
    fetchMock.mockResolvedValue(json(value));
    expect(await generateBookWebResearch(A, { question: QUESTION })).toEqual(value);
    const contexts = bookWebSourceTextContexts(source)!;
    expect(contexts.items.map(item => [item.field, item.value])).toEqual([
      ["title", "《旅行史》"], ["title", "第２版"], ["excerpt", "《书名相同》"],
      ["excerpt", "《另一本》"], ["excerpt", "修訂版"],
    ]);
    const copied = bookWebResearchContent(value);
    for (const item of contexts.items) expect(copied).toContain(item.text);
    expect(copied).toContain("书名号中的文字（标题中的文字）：《旅行史》");
    expect(copied).toContain("版本字样（搜索节选中的文字）：修訂版");
    expect(copied).toContain(source.excerpt); expect(copied).toContain(source.url);
    expect(copied).toContain(CLUES_NOTICE);
    expect(copied).not.toContain(value.sources[1].url);
    expect(copied).not.toContain("《未选书名》");
    expect(copied).not.toContain(source.readToken);
    expect(copied).not.toContain("AI 资料判断");
    expect(copied).not.toContain("与本书关系：");
    expect(JSON.stringify(value)).toBe(before);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("retains repeated top-level occurrences after a closed nested span and editions inside quoted titles", () => {
    const value = contextualResult(), source = value.sources[0];
    source.title = "《第2版》";
    source.excerpt = "《外《内》外》；《同名》之后又出现《同名》，只能按原文核对。";
    source.textContexts = { items: [
      textContext(source, "title", "《第2版》", "quoted_title"),
      textContext(source, "title", "第2版", "edition_text"),
      textContext(source, "excerpt", "《同名》", "quoted_title"),
      textContext(source, "excerpt", "《同名》", "quoted_title", source.excerpt.indexOf("《同名》") + 1),
    ], limited: false };
    const contexts = bookWebSourceTextContexts(source)!;
    expect(contexts.items).toHaveLength(4);
    expect(contexts.items[2].value).toBe(contexts.items[3].value);
    expect(contexts.items[2].matchStart).toBeLessThan(contexts.items[3].matchStart);
    expect(bookWebResearchContent(value).match(/书名号中的文字（搜索节选中的文字）：《同名》/g)).toHaveLength(2);
  });

  it.each(["第 ２ 版", "第\t十二\t版", "第两百版", "第兩百版", "初版", "再版", "重版", "修订版", "修訂版", "增订版", "增訂版", "版本", "版次"])("keeps the exact edition spelling %s", edition => {
    const value = contextualResult(), source = value.sources[0];
    source.excerpt = "原文：" + edition + "，文字本身不确认版本。";
    source.textContexts = { items: [textContext(source, "excerpt", edition, "edition_text")], limited: false };
    expect(bookWebSourceTextContexts(source)?.items[0].value).toBe(edition);
    expect(bookWebResearchContent(value)).toContain("版本字样（搜索节选中的文字）：" + edition);
  });

  it.each([false, true])("distinguishes an empty literal-context block (limited=%s) from an older response", limited => {
    const value = result(), source = value.sources[0];
    expect(bookWebSourceTextContexts(source)).toBeUndefined();
    expect(bookWebResearchContent(value)).toContain("本次未提供可用的文字上下文。");
    source.textContexts = { items: [], limited };
    expect(bookWebSourceTextContexts(source)).toEqual({ items: [], limited });
    const copied = bookWebResearchContent(value);
    expect(copied).toContain("当前没有可展示的书名号或版本字样上下文。");
    expect(copied).not.toContain("本次未提供可用的文字上下文。");
    expect(copied.includes("部分字样未列出，请结合标题和完整节选核对。")).toBe(limited);
  });

  it.each(["unselected_sources", "insufficient_sources"] as const)("retains literal contexts for every available %s source", sourceKind => {
    const value = contextualResult();
    value.source = sourceKind; value.citedSourceIds = [];
    value.draft = sourceKind === "unselected_sources"
      ? { title: "待核对的网页资料", content: UNSELECTED } : { title: "查到的相关资料", content: INSUFFICIENT };
    contextsOf(value.sources[1]).limited = true;
    const copied = bookWebResearchContent(value);
    for (const source of value.sources) {
      expect(copied).toContain(source.url); expect(copied).toContain(source.excerpt);
      expect(copied).not.toContain(source.readToken);
    }
    expect(copied).toContain("书名号中的文字（标题中的文字）：《未选书名》");
    expect(copied).toContain("部分字样未列出，请结合标题和完整节选核对。");
    expect(copied).not.toContain("建议先查看");
  });

  it.each([
    ["null block", (source: BookWebResearchSource) => { source.textContexts = null; }],
    ["array block", (source: BookWebResearchSource) => { source.textContexts = []; }],
    ["missing limited", (source: BookWebResearchSource) => { source.textContexts = { items: contextsOf(source).items }; }],
    ["non-boolean limited", (source: BookWebResearchSource) => { Object.assign(contextsOf(source), { limited: 1 }); }],
    ["free-form block claim", (source: BookWebResearchSource) => { Object.assign(contextsOf(source), { interpretation: "FORGED_JUDGEMENT" }); }],
    ["non-array items", (source: BookWebResearchSource) => { Object.assign(contextsOf(source), { items: {} }); }],
    ["unknown kind", (source: BookWebResearchSource) => { Object.assign(contextsOf(source).items[0], { kind: "same_book" }); }],
    ["unknown field", (source: BookWebResearchSource) => { Object.assign(contextsOf(source).items[0], { field: "url" }); }],
    ["free-form item claim", (source: BookWebResearchSource) => { Object.assign(contextsOf(source).items[0], { relationship: "same_book" }); }],
    ["forged original text", (source: BookWebResearchSource) => { contextsOf(source).items[0].text = "FORGED_JUDGEMENT"; }],
    ["forged literal", (source: BookWebResearchSource) => { contextsOf(source).items[0].value = "《FORGED_JUDGEMENT》"; }],
    ["cross-source context", (source: BookWebResearchSource) => { contextsOf(source).items[0] = textContext(contextualResult().sources[1], "title", "《未选书名》", "quoted_title"); }],
    ["fractional position", (source: BookWebResearchSource) => { contextsOf(source).items[0].matchStart = 0.5; }],
    ["negative context", (source: BookWebResearchSource) => { contextsOf(source).items[0].start = -1; }],
    ["out-of-range context", (source: BookWebResearchSource) => { contextsOf(source).items[0].end = source.title.length + 1; }],
    ["empty match", (source: BookWebResearchSource) => { contextsOf(source).items[0].matchEnd = 0; }],
    ["match outside context", (source: BookWebResearchSource) => { contextsOf(source).items[0].start = 1; contextsOf(source).items[0].text = source.title.slice(1); }],
    ["duplicate occurrence", (source: BookWebResearchSource) => { contextsOf(source).items.splice(1, 0, { ...contextsOf(source).items[0] }); }],
    ["reversed fields", (source: BookWebResearchSource) => { contextsOf(source).items.reverse(); }],
    ["reversed positions", (source: BookWebResearchSource) => { const items = contextsOf(source).items; [items[2], items[3]] = [items[3], items[2]]; }],
    ["more than four quoted titles", (source: BookWebResearchSource) => {
      source.title = "《一》《二》《三》《四》《五》";
      source.textContexts = { items: ["《一》", "《二》", "《三》", "《四》", "《五》"].map(value => textContext(source, "title", value, "quoted_title")), limited: true };
    }],
    ["context over 400 UTF-16 units", (source: BookWebResearchSource) => {
      source.excerpt = "《书名》" + "字".repeat(400);
      source.textContexts = { items: [textContext(source, "excerpt", "《书名》", "quoted_title")], limited: false };
    }],
    ["inner title inside a nested source span", (source: BookWebResearchSource) => {
      source.excerpt = "《外《内》外》";
      source.textContexts = { items: [{ kind: "quoted_title", field: "excerpt", value: "《内》",
        matchStart: 2, matchEnd: 5, start: 0, end: 7, text: source.excerpt }], limited: false };
    }],
    ["split surrogate context", (source: BookWebResearchSource) => {
      source.excerpt = "😀《书名》";
      const item = textContext(source, "excerpt", "《书名》", "quoted_title"); item.start = 1; item.text = source.excerpt.slice(1);
      source.textContexts = { items: [item], limited: false };
    }],
    ["normalized but not original edition", (source: BookWebResearchSource) => { contextsOf(source).items[1].value = "第2版"; }],
  ] as const)("drops only a malformed text-context block (%s), preserving source selection and input", async (_label, corrupt) => {
    const value = contextualResult(), source = value.sources[0];
    corrupt(source); const before = JSON.stringify(value);
    expect(bookWebSourceTextContexts(source)).toBeUndefined();
    fetchMock.mockResolvedValue(json(value));
    const received = await generateBookWebResearch(A, { question: QUESTION });
    expect(received.source).toBe("web_research"); expect(received.citedSourceIds).toEqual(["W1"]);
    expect(received.sources[0].excerpt).toBe(source.excerpt); expect(received.sources[0].readToken).toBe(source.readToken);
    expect(bookWebSourceTextContexts(received.sources[0])).toBeUndefined();
    const copied = bookWebResearchContent(value);
    expect(copied).toContain("本次未提供可用的文字上下文。");
    expect(copied).toContain(source.excerpt); expect(copied).toContain(source.url);
    expect(copied).not.toContain("书名号中的文字");
    expect(copied).not.toContain("FORGED_JUDGEMENT");
    expect(JSON.stringify(value)).toBe(before);
  });

  it.each([
    ["quoted_title", "《》"], ["quoted_title", "《 \t 》"], ["quoted_title", "《跨\n行》"],
    ["quoted_title", "《跨\u0085行》"], ["quoted_title", "《跨\u2028行》"], ["quoted_title", "《外《内》层》"], ["quoted_title", "《未闭合"],
    ["quoted_title", "《" + "长".repeat(119) + "》"],
    ["edition_text", "全新版本"], ["edition_text", "第2\n版"],
    ["edition_text", "第" + "2".repeat(39) + "版"],
  ] as const)("does not promote unsupported %s text into a literal clue", (kind, literal) => {
    const value = contextualResult(), source = value.sources[0];
    source.excerpt = "原文中出现：" + literal + "，仍保留原始节选。";
    source.textContexts = { items: [textContext(source, "excerpt", literal, kind)], limited: true };
    expect(bookWebSourceTextContexts(source)).toBeUndefined();
    const copied = bookWebResearchContent(value);
    expect(copied).toContain(source.excerpt);
    expect(copied).not.toContain("书名号中的文字");
    expect(copied).not.toContain("版本字样（搜索节选中的文字）：");
  });

  it("never consumes obsolete model relationship metadata in a source snapshot", () => {
    const value = result();
    Object.assign(value, { assessments: [{ sourceId: "W1", relationship: "other_book", materialType: "review", explanation: "FORGED_JUDGEMENT" }] });
    const copied = bookWebResearchContent(value);
    expect(copied).toContain(value.sources[0].excerpt);
    expect(copied).not.toContain("FORGED_JUDGEMENT");
    expect(copied).not.toContain("AI 资料判断");
    expect(copied).not.toContain("与本书关系：");
  });

});

describe("strict direct-book-review transport", () => {
  it("posts explicit scope only when requested and rejects a mismatched response", async () => {
    const scoped = { ...result(), scope: "direct_book_review" as const };
    fetchMock.mockResolvedValueOnce(json(scoped));
    const output = await generateBookWebResearch(A, { question: QUESTION, scope: "direct_book_review" });
    expect(output.scope).toBe("direct_book_review");
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ question: QUESTION, scope: "direct_book_review" });
    fetchMock.mockResolvedValueOnce(json(result()));
    await expect(generateBookWebResearch(A, { question: QUESTION, scope: "direct_book_review" }))
      .rejects.toMatchObject({ status: 502, code: "BOOK_RESEARCH_CLIENT_INVALID_RESPONSE" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("strict review clipboard regression", () => {
  it.each(["web_research", "insufficient_sources", "unselected_sources"] as const)(
    "copies a valid strict response for %s with its scope notice", source => {
      const value = source === "unselected_sources" ? unselected() : result();
      value.scope = "direct_book_review";
      value.sources[0].bookClues = { isbn: "matched", text: ["title", "author"] };
      if (source === "insufficient_sources") {
        value.source = source; value.citedSourceIds = [];
        value.draft = { title: "查到的相关资料", content: INSUFFICIENT };
      }
      const copied = bookWebResearchContent(value);
      expect(copied).toContain("严格本书书评");
      expect(copied).toContain("具体版本需另行核对，即使出现本书 ISBN 也不等于版本已确认");
      expect(copied).toContain(value.sources[0].excerpt);
      expect(copied).toContain(value.sources[0].url);
      expect(copied).not.toContain("readToken");
    });
  it("still rejects an unknown scope when copying", () => {
    const value = result();
    Object.assign(value, { scope: "untrusted_scope" });
    expect(() => bookWebResearchContent(value)).toThrow();
  });
});
