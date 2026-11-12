import { describe, expect, it, vi } from "vitest";
import { BOOK_WEB_SOURCE_LIMITS as LIMITS, BookWebSourceError, createBookWebSourceReader,
  type BookWebSourceFetcher, type BookWebSourcePage } from "./book-web-source.js";

const BOOK = "10000001_000000000001", OTHER = "10000002_000000000002";
const source = { id: "W1", title: "搜索来源标题", url: "https://example.org/book?q=1" };
const htmlPage = (html: string): BookWebSourcePage => ({ finalUrl: "https://example.org/book/full",
  contentType: "text/html", body: Buffer.from(html), charset: "utf-8" });
const setup = (page = htmlPage("<main><p>网页正文</p></main>")) => {
  const fetchPage = vi.fn<BookWebSourceFetcher>().mockResolvedValue(page);
  const reader = createBookWebSourceReader({ fetchPage });
  return { reader, fetchPage, token: reader.issueToken(BOOK, source)! };
};

describe("read-only book web source grants and extraction", () => {
  it("reads only the server-snapshotted source, returns provenance, and removes HTML/active/navigation/hidden content", async () => {
    const { reader, fetchPage, token } = setup(htmlPage(`<!doctype html><html><head><title>网页 &amp; 正文标题</title>
      <script>PRIVATE_SCRIPT</script><style>PRIVATE_STYLE</style></head><body><nav>PRIVATE_NAV</nav>
      <main><h1>书籍资料</h1><p>第一段 &amp; 原文。</p><p>第二段<br>下一行。</p>
      <iframe src="https://private.invalid/">PRIVATE_FRAME</iframe><p hidden>PRIVATE_HIDDEN</p>
      <p aria-hidden="true">PRIVATE_ARIA</p><p style="display: none">PRIVATE_STYLE_HIDDEN</p>
      <form>PRIVATE_FORM</form><script>PRIVATE_SCRIPT_2</script></main><footer>PRIVATE_FOOTER</footer></body></html>`));
    const controller = new AbortController();
    const result = await reader.read(BOOK, { sourceToken: token }, { signal: controller.signal });
    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(fetchPage).toHaveBeenCalledExactlyOnceWith(source.url, { signal: controller.signal });
    expect(result).toMatchObject({ bookId: BOOK, sourceId: "W1", requestedUrl: source.url,
      finalUrl: "https://example.org/book/full", title: "网页 & 正文标题", contentType: "text/html",
      extraction: "html_readable_text", truncated: false });
    expect(result.text).toContain("第一段 & 原文。"); expect(result.text).toContain("第二段\n下一行。");
    expect(result.text).not.toMatch(/PRIVATE_|<|>/); expect(Number.isFinite(Date.parse(result.fetchedAt))).toBe(true);
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it("supports plain text, source-title fallback and explicit safe truncation", async () => {
    const { reader, token } = setup({ finalUrl: source.url, contentType: "text/plain",
      body: Buffer.from("字".repeat(LIMITS.TEXT_CHARS - 1) + "📚之后") });
    const result = await reader.read(BOOK, { sourceToken: token });
    expect(result).toMatchObject({ title: source.title, contentType: "text/plain", extraction: "plain_text", truncated: true });
    expect(result.text).toHaveLength(LIMITS.TEXT_CHARS - 1);
    expect(result.text).not.toMatch(/[\ud800-\udbff]$/);
  });

  it("decodes a declared Chinese encoding without replacing source content", async () => {
    const { reader, token } = setup({ finalUrl: source.url, contentType: "text/plain", charset: "gb18030",
      body: Uint8Array.from([0xd6, 0xd0, 0xce, 0xc4]) });
    expect((await reader.read(BOOK, { sourceToken: token })).text).toBe("中文");
  });

  it("rejects arbitrary URLs/fields, malformed and cross-book grants before any fetch", async () => {
    const { reader, fetchPage, token } = setup();
    for (const body of [null, [], {}, { url: source.url }, { sourceToken: token, url: source.url },
      { sourceToken: "short" }, { sourceToken: "!".repeat(32) }]) {
      await expect(reader.read(BOOK, body)).rejects.toMatchObject({ code: "BOOK_SOURCE_INVALID_INPUT" });
    }
    await expect(reader.read(OTHER, { sourceToken: token })).rejects.toMatchObject({ code: "BOOK_SOURCE_INVALID_INPUT" });
    await expect(reader.read("bad-id", { sourceToken: token })).rejects.toMatchObject({ code: "BOOK_SOURCE_INVALID_INPUT" });
    await expect(reader.read(BOOK, { sourceToken: "a".repeat(32) })).rejects.toMatchObject({ code: "BOOK_SOURCE_EXPIRED" });
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it("expires grants after 30 minutes and evicts oldest grants at the bound", async () => {
    let time = 1000;
    const fetchPage = vi.fn<BookWebSourceFetcher>();
    const reader = createBookWebSourceReader({ fetchPage, now: () => new Date(time) });
    const token = reader.issueToken(BOOK, source)!;
    time += LIMITS.TOKEN_TTL_MS;
    await expect(reader.read(BOOK, { sourceToken: token })).rejects.toMatchObject({ code: "BOOK_SOURCE_EXPIRED" });
    const oldest = reader.issueToken(BOOK, source)!;
    for (let i = 0; i < LIMITS.TOKENS; i++) reader.issueToken(BOOK, source);
    await expect(reader.read(BOOK, { sourceToken: oldest })).rejects.toMatchObject({ code: "BOOK_SOURCE_EXPIRED" });
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it("does not grant a private/static unsafe URL, preserving the surrounding search", () => {
    const { reader } = setup();
    for (const url of ["http://127.1/", "http://169.254.169.254/", "https://example.org:8080/", "https://user:pw@example.org/"]) {
      expect(reader.issueToken(BOOK, { ...source, url })).toBeUndefined();
    }
  });

  it("rejects empty script-only content, oversized bodies, unsupported encodings and disguised PDF", async () => {
    for (const [page, code] of [
      [htmlPage("<script>document.write('not fetched')</script>"), "BOOK_SOURCE_UNREADABLE"],
      [htmlPage(" "), "BOOK_SOURCE_UNREADABLE"],
      [htmlPage("%PDF-1.7\nnot HTML"), "BOOK_SOURCE_UNSUPPORTED"],
      [{ ...htmlPage("text"), charset: "unknown-encoding" }, "BOOK_SOURCE_UNSUPPORTED"],
      [{ ...htmlPage("text"), body: Buffer.alloc(LIMITS.BODY_BYTES + 1) }, "BOOK_SOURCE_TOO_LARGE"],
    ] as const) {
      const { reader, token } = setup(page);
      await expect(reader.read(BOOK, { sourceToken: token })).rejects.toMatchObject({ code });
    }
  });

  it("preserves controlled errors, hides unexpected details and discards late results after cancel", async () => {
    const { reader, fetchPage, token } = setup();
    fetchPage.mockRejectedValueOnce(new Error("PRIVATE_CREDENTIAL SQL internal host"));
    await expect(reader.read(BOOK, { sourceToken: token })).rejects.toEqual(new BookWebSourceError("BOOK_SOURCE_UNAVAILABLE"));
    fetchPage.mockRejectedValueOnce(new BookWebSourceError("BOOK_SOURCE_TIMEOUT"));
    await expect(reader.read(BOOK, { sourceToken: token })).rejects.toMatchObject({ code: "BOOK_SOURCE_TIMEOUT" });
    const controller = new AbortController();
    fetchPage.mockImplementationOnce(async () => { controller.abort(); return htmlPage("<main>late</main>"); });
    await expect(reader.read(BOOK, { sourceToken: token }, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    const calls = fetchPage.mock.calls.length;
    await expect(reader.read(BOOK, { sourceToken: token }, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchPage).toHaveBeenCalledTimes(calls);
  });
});
