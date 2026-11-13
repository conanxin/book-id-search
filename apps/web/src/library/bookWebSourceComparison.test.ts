import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetWebAuthStoreForTests, __setWebAuthSnapshotForTests, ensureAuthSessionLoaded } from "../auth/session";
import {
  assertBookWebSourceComparisonResponse, bookWebSourceComparisonContent, findBookWebSourceComparison,
  type BookWebSourceComparisonResponse, type BookWebSourceComparisonSelection,
} from "./bookWebSourceComparison";

vi.mock("../auth/session", async original => ({ ...await original<typeof import("../auth/session")>(), ensureAuthSessionLoaded: vi.fn(async () => {}) }));

const A = "14000000_000000000001", B = "14000001_000000000002", QUESTION = "这些来源对出版年份分别怎么说？";
const GENERATED = "2026-11-13T12:02:00.000Z";
function entry(n: number, text = "前文。\n\n😀原文记载" + (n === 1 ? "1935年初版" : "最早于1937年出版") + "。\n<script>字面标记</script>\n\n后文。"): BookWebSourceComparisonSelection {
  const source = { id: "W" + n, kind: "web" as const, title: "来源 " + n, url: "https://catalog.example.test/" + n,
    excerpt: "搜索节选", pageAge: null, truncated: false, readToken: String.fromCharCode(64 + n).repeat(32) };
  return { source, snapshot: {
    bookId: A, sourceId: source.id, requestedUrl: source.url, finalUrl: source.url + "/readable", title: "正文 " + n,
    text, contentType: "text/html", extraction: "html_readable_text", truncated: n === 2,
    fetchedAt: "2026-11-13T12:00:00.000Z", snapshotToken: String.fromCharCode(96 + n).repeat(32),
  } };
}
function response(selections = [entry(1), entry(2)], question = QUESTION): BookWebSourceComparisonResponse {
  return { bookId: A, question, mode: "source_comparison", generatedAt: GENERATED,
    sources: selections.map(({ source, snapshot }) => {
      const start = snapshot.text.indexOf("😀"), end = snapshot.text.indexOf("\n\n后文");
      return { bookId: A, sourceId: source.id, snapshotToken: snapshot.snapshotToken!, question,
        mode: "source_passages", status: "selected", requestedUrl: snapshot.requestedUrl, finalUrl: snapshot.finalUrl,
        title: snapshot.title, fetchedAt: snapshot.fetchedAt, sourceTruncated: snapshot.truncated, generatedAt: GENERATED,
        passages: start >= 0 && end > start ? [{ id: "P2", start, end, text: snapshot.text.slice(start, end) }]
          : [{ id: "P1", start: 0, end: 1, text: snapshot.text.slice(0, 1) }],
      };
    }) };
}
const fetchMock = vi.fn<typeof fetch>();
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
function login(csrfToken: string | null = "csrf-current") {
  __setWebAuthSnapshotForTests({ status: "authenticated", user: { email: "owner@example.test", name: "Owner" }, csrfToken, error: null });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>(done => { resolve = done; }), resolve };
}
beforeEach(() => {
  vi.clearAllMocks(); __resetWebAuthStoreForTests(); login(); fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); __resetWebAuthStoreForTests(); });

describe("multiple webpage original-evidence client", () => {
  it.each([2, 3])("posts only %s tokens in selected order and one trimmed question", async count => {
    const selections = [entry(3), entry(1), entry(2)].slice(0, count), expected = response(selections);
    fetchMock.mockResolvedValue(json(expected));
    const controller = new AbortController();
    expect(await findBookWebSourceComparison(A, selections, " " + QUESTION + "\n", controller.signal)).toEqual(expected);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/ai/books/" + A + "/research/sources/evidence");
    expect(options).toMatchObject({ method: "POST", credentials: "same-origin", cache: "no-store", signal: controller.signal });
    expect(new Headers(options?.headers).get("x-csrf-token")).toBe("csrf-current");
    expect(JSON.parse(String(options?.body))).toEqual({ snapshotTokens: selections.map(item => item.snapshot.snapshotToken), question: QUESTION });
    for (const { source, snapshot } of selections) {
      expect(String(options?.body)).not.toContain(snapshot.text);
      expect(String(options?.body)).not.toContain(source.url);
      expect(String(options?.body)).not.toContain(source.readToken);
    }
  });

  it.each([0, 1, 4])("rejects a selection of %s sources before fetching", async count => {
    await expect(findBookWebSourceComparison(A, Array.from({ length: count }, (_, i) => entry(i + 1)), QUESTION)).rejects.toMatchObject({ status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each(["", " ", "字".repeat(1001), "bad\ud800", "bad\0"])("rejects malformed questions (%#)", async question => {
    await expect(findBookWebSourceComparison(A, [entry(1), entry(2)], question)).rejects.toMatchObject({ status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each(["token", "source", "final-url", "fragment-url", "cross-book", "legacy"])("rejects %s inputs before fetching", async changed => {
    const selections = [entry(1), entry(2)];
    if (changed === "token") selections[1].snapshot.snapshotToken = selections[0].snapshot.snapshotToken;
    if (changed === "source") {
      selections[1].source.id = selections[0].source.id;
      selections[1].snapshot.sourceId = selections[0].source.id;
    }
    if (changed === "final-url") selections[1].snapshot.finalUrl = selections[0].snapshot.finalUrl;
    if (changed === "fragment-url") selections[1].snapshot.finalUrl = selections[0].snapshot.finalUrl + "#another";
    if (changed === "cross-book") selections[1].snapshot.bookId = B;
    if (changed === "legacy") delete selections[1].snapshot.snapshotToken;
    await expect(findBookWebSourceComparison(A, selections, QUESTION)).rejects.toMatchObject({ status: 400, code: "BOOK_COMPARISON_INVALID_INPUT" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("preserves query, path case and trailing-slash distinctions", async () => {
    for (const finalUrl of ["https://catalog.example.test/1/Readable", "https://catalog.example.test/1/readable/", "https://catalog.example.test/1/readable?q=2"]) {
      const selections = [entry(1), { ...entry(2), snapshot: { ...entry(2).snapshot, finalUrl } }];
      fetchMock.mockResolvedValueOnce(json(response(selections)));
      await expect(findBookWebSourceComparison(A, selections, QUESTION)).resolves.toMatchObject({ mode: "source_comparison" });
    }
  });
  it("accepts exactly 60,000 UTF-16 units and rejects excess text without silently truncating sources", async () => {
    const selections = [entry(1, "字".repeat(30000)), entry(2, "文".repeat(30000))];
    fetchMock.mockResolvedValueOnce(json(response(selections)));
    await expect(findBookWebSourceComparison(A, selections, QUESTION)).resolves.toMatchObject({ sources: expect.any(Array) });
    fetchMock.mockClear();
    await expect(findBookWebSourceComparison(A, [entry(1, "字".repeat(20000)), entry(2, "文".repeat(20000)), entry(3, "句".repeat(20001))], QUESTION))
      .rejects.toMatchObject({ status: 400, code: "BOOK_COMPARISON_TEXT_LIMIT" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["outer-book", "question", "mode", "time", "free-answer", "missing-source", "extra-source", "reversed", "duplicate", "source-time"])(
    "rejects a response with %s", async changed => {
      const value = response();
      if (changed === "outer-book") value.bookId = B;
      if (changed === "question") value.question = "另一问题";
      if (changed === "mode") (value as unknown as Record<string, unknown>).mode = "synthesis";
      if (changed === "time") value.generatedAt = "yesterday";
      if (changed === "free-answer") Object.assign(value, { answer: "1937年再版" });
      if (changed === "missing-source") value.sources.pop();
      if (changed === "extra-source") value.sources.push(value.sources[0]);
      if (changed === "reversed") value.sources.reverse();
      if (changed === "duplicate") value.sources[1] = value.sources[0];
      if (changed === "source-time") value.sources[1].generatedAt = "2026-11-13T12:03:00.000Z";
      fetchMock.mockResolvedValueOnce(json(value));
      await expect(findBookWebSourceComparison(A, [entry(1), entry(2)], QUESTION))
        .rejects.toMatchObject({ status: 502, code: "BOOK_COMPARISON_INVALID_OUTPUT" });
    },
  );
  it.each(["wrong-token", "wrong-text", "wrong-offset", "split-unicode", "three-passages", "free-source-field"])(
    "rejects an individual source with %s, including a three-passage response valid for the single-source endpoint", changed => {
      const value = response(), source = value.sources[1], selections = [entry(1), entry(2)];
      if (changed === "wrong-token") source.snapshotToken = "Z".repeat(32);
      if (changed === "wrong-text") source.passages[0].text = "1937年再版";
      if (changed === "wrong-offset") source.passages[0].start += 2;
      if (changed === "split-unicode") { source.passages[0].start += 1; source.passages[0].text = selections[1].snapshot.text.slice(source.passages[0].start, source.passages[0].end); }
      if (changed === "three-passages") source.passages = [0, 1, 2].map(i => ({ id: "P" + (i + 1), start: i, end: i + 1, text: selections[1].snapshot.text.slice(i, i + 1) }));
      if (changed === "free-source-field") Object.assign(source, { conclusion: "可确定首次出版年份" });
      expect(() => assertBookWebSourceComparisonResponse(value, A, selections, QUESTION)).toThrow(expect.objectContaining({ code: "BOOK_COMPARISON_INVALID_OUTPUT" }));
    },
  );

  it.each(["some", "all"])("retains %s insufficient groups and copies the absence without inventing a conclusion", async mode => {
    const value = response(), selections = [entry(1), entry(2)];
    for (const source of mode === "all" ? value.sources : [value.sources[1]]) {
      source.status = "insufficient_evidence"; source.passages = [];
    }
    fetchMock.mockResolvedValueOnce(json(value));
    expect(await findBookWebSourceComparison(A, selections, QUESTION)).toEqual(value);
    const copied = bookWebSourceComparisonContent(value, A, selections);
    expect(copied).toContain("[W1]"); expect(copied).toContain("[W2]");
    expect(copied).toContain("本次未选出足够相关的原文");
    expect(copied).not.toContain("1937年再版");
  });
  it("copies each exact quote with its own provenance and without capability tokens", () => {
    const selections = [entry(2), entry(1)], value = response(selections);
    const copied = bookWebSourceComparisonContent(value, A, selections);
    expect(copied.indexOf("[W2]")).toBeLessThan(copied.indexOf("[W1]"));
    expect(copied).toContain("1935年初版"); expect(copied).toContain("最早于1937年出版");
    expect(copied).not.toContain("1937年再版");
    for (const [index, { source, snapshot }] of selections.entries()) {
      expect(copied).toContain(value.sources[index].passages[0].text);
      expect(copied).toContain(snapshot.requestedUrl); expect(copied).toContain(snapshot.finalUrl);
      expect(copied).toContain(snapshot.fetchedAt); expect(copied).toContain("[" + source.id + " / P2]");
      expect(copied).not.toContain(snapshot.snapshotToken); expect(copied).not.toContain(source.readToken);
    }
    expect(copied).toContain("已截短");
    value.sources[0].passages[0].text = "改写";
    expect(() => bookWebSourceComparisonContent(value, A, selections)).toThrow();
  });

  it("requires authentication and CSRF before fetching", async () => {
    __setWebAuthSnapshotForTests({ status: "unauthenticated", user: null, csrfToken: null, error: null });
    await expect(findBookWebSourceComparison(A, [entry(1), entry(2)], QUESTION)).rejects.toMatchObject({ status: 401 });
    login(null);
    await expect(findBookWebSourceComparison(A, [entry(1), entry(2)], QUESTION)).rejects.toMatchObject({ status: 403 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each([
    [400, "BOOK_COMPARISON_INVALID_INPUT", "请选择"], [400, "BOOK_COMPARISON_TEXT_LIMIT", "60,000"],
    [410, "BOOK_COMPARISON_EXPIRED", "至少一篇"], [502, "BOOK_COMPARISON_INVALID_OUTPUT", "不一致"],
    [503, "BOOK_COMPARISON_UNAVAILABLE", "已读网页文字仍保留"], [504, "BOOK_COMPARISON_TIMEOUT", "超时"],
  ])("maps %s %s to a fixed message without retrying", async (status, code, message) => {
    fetchMock.mockResolvedValueOnce(json({ error: { code, message: "private provider diagnostic" } }, status));
    await expect(findBookWebSourceComparison(A, [entry(1), entry(2)], QUESTION))
      .rejects.toMatchObject({ status, message: expect.stringContaining(message) });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it("refreshes an expired session without surfacing diagnostics", async () => {
    fetchMock.mockResolvedValueOnce(json({ error: { code: "AUTH", message: "upstream private" } }, 401));
    await expect(findBookWebSourceComparison(A, [entry(1), entry(2)], QUESTION)).rejects.toMatchObject({ status: 401 });
    expect(ensureAuthSessionLoaded).toHaveBeenCalledOnce();
  });
  it("honors pre-abort and rejects cancellation/session changes while JSON decoding is pending", async () => {
    const cancelled = new AbortController(); cancelled.abort();
    await expect(findBookWebSourceComparison(A, [entry(1), entry(2)], QUESTION, cancelled.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).not.toHaveBeenCalled();
    for (const change of ["cancel", "session"]) {
      const decoded = deferred<unknown>(), controller = new AbortController();
      fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: () => decoded.promise } as Response);
      const pending = findBookWebSourceComparison(A, [entry(1), entry(2)], QUESTION, controller.signal);
      await Promise.resolve();
      if (change === "cancel") controller.abort(); else login("csrf-new");
      decoded.resolve(response());
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    }
  });
});
