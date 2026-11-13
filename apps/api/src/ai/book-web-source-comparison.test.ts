import { describe, expect, it, vi } from "vitest";
import { createBookWebSourceReader, type BookWebSourceFetcher, type BookWebSourceResponse } from "./book-web-source.js";
import { BOOK_WEB_SOURCE_EVIDENCE_LIMITS, type BookWebSourceSnapshot } from "./book-web-source-evidence.js";
import { BOOK_WEB_SOURCE_COMPARISON_LIMITS as LIMITS, BookWebSourceComparisonError,
  createBookWebSourceComparisonService } from "./book-web-source-comparison.js";
import type { chatCompletion } from "./minimax.js";

const BOOK = "10000001_000000000001", OTHER = "10000002_000000000002";
const date = "2026-11-13T08:00:00.000Z", question = "两篇资料各自记载了什么年份？";
const texts = [
  "来源甲记载 1935 年，未交代与其他年份的关系。\n" + "甲".repeat(700) + "\n\n" + "来源甲的第二段原文。\n" + "甲".repeat(700),
  "来源乙记载 1937 年，不能据此认定初版或再版关系。\n" + "乙".repeat(700) + "\n\n" + "来源乙的第二段原文。\n" + "乙".repeat(700),
  "来源丙没有解释上述年份的关系。\n" + "丙".repeat(700) + "\n\n" + "来源丙的第二段原文。\n" + "丙".repeat(700),
];
const group = (sourceKey: string, passageIds = ["P1"], insufficientEvidence = false) =>
  ({ sourceKey, passageIds, insufficientEvidence });
const completed = (value: unknown) =>
  ({ ok: true as const, model: "fixture", content: JSON.stringify(value) });
type FixtureSource = { id?: string; title?: string; url?: string; finalUrl?: string; text?: string };

async function setup(items: FixtureSource[] = [{ text: texts[0] }, { text: texts[1] }]) {
  let time = Date.parse(date);
  const now = () => new Date(time);
  const sources = items.map((item, index) => ({
    id: item.id ?? "W" + (index + 1), title: item.title ?? "合成公开来源" + (index + 1),
    url: item.url ?? "https://example.org/source" + (index + 1),
    finalUrl: item.finalUrl ?? "https://example.org/final" + (index + 1), text: item.text ?? texts[index],
  }));
  const fetchPage = vi.fn<BookWebSourceFetcher>().mockImplementation(async url => {
    const item = sources.find(source => source.url === url)!;
    return { finalUrl: item.finalUrl, contentType: "text/plain", body: Buffer.from(item.text) };
  });
  const reader = createBookWebSourceReader({ fetchPage, now });
  const reads: BookWebSourceResponse[] = [], readTokens: string[] = [];
  for (const source of sources) {
    const readToken = reader.issueToken(BOOK, source)!;
    readTokens.push(readToken);
    reads.push(await reader.read(BOOK, { sourceToken: readToken }));
  }
  const provider = vi.fn<typeof chatCompletion>().mockResolvedValue(completed({
    sources: reads.map((_read, index) => group("S" + (index + 1))),
  }));
  const getSnapshot = vi.fn(reader.getSnapshot);
  const service = createBookWebSourceComparisonService({ getSnapshot, provider, isEnabled: () => true, now });
  return { reader, reads, readTokens, sources, fetchPage, provider, getSnapshot, service, now,
    advance: (ms: number) => { time += ms; },
    body: { snapshotTokens: reads.map(read => read.snapshotToken!), question } };
}

describe("multiple source evidence uses one complete selection operation", () => {
  it("returns separate exact 1935/1937 source text and provenance in request order with one provider call", async () => {
    const s = await setup();
    s.provider.mockResolvedValueOnce(completed({ sources: [group("S2", ["P2", "P1"]), group("S1", ["P2", "P1"])] }));
    const result = await s.service.compare(BOOK, { ...s.body, question: "  " + question + "  " });
    expect(Object.keys(result).sort()).toEqual(["bookId", "generatedAt", "mode", "question", "sources"]);
    expect(result).toMatchObject({ bookId: BOOK, question, mode: "source_comparison", generatedAt: date });
    expect(result.sources).toHaveLength(2);
    result.sources.forEach((source, index) => {
      const read = s.reads[index];
      expect(source).toMatchObject({ bookId: BOOK, sourceId: read.sourceId, snapshotToken: read.snapshotToken, question,
        mode: "source_passages", status: "selected", requestedUrl: read.requestedUrl, finalUrl: read.finalUrl,
        title: read.title, fetchedAt: read.fetchedAt, sourceTruncated: false, generatedAt: result.generatedAt });
      expect(source.passages.map(p => p.id)).toEqual(["P1", "P2"]);
      for (const passage of source.passages) expect(passage.text).toBe(read.text.slice(passage.start, passage.end));
    });
    expect(result.sources[0].passages[0].text).toContain("1935");
    expect(result.sources[1].passages[0].text).toContain("1937");
    expect(s.fetchPage).toHaveBeenCalledTimes(2);
    expect(s.provider).toHaveBeenCalledOnce();
    expect(s.getSnapshot.mock.calls).toEqual(s.body.snapshotTokens.map(token => [BOOK, token]));
    expect(s.provider.mock.calls[0][1]).toMatchObject({ temperature: 0.2, maxTokens: 1024,
      timeoutMs: 60_000, requireCompleted: true });
    const payload = JSON.parse(s.provider.mock.calls[0][0][1].content);
    expect(Object.keys(payload).sort()).toEqual(["question", "sources"]);
    payload.sources.forEach((source: { sourceKey: string; title: string; sourceTruncated: boolean;
      passages: { id: string; text: string }[] }, index: number) => {
      expect(Object.keys(source).sort()).toEqual(["passages", "sourceKey", "sourceTruncated", "title"]);
      expect(source.sourceKey).toBe("S" + (index + 1));
      expect(source.passages.map(p => p.text).join("")).toBe(s.reads[index].text);
    });
    const sent = JSON.stringify(s.provider.mock.calls);
    for (const token of [...s.body.snapshotTokens, ...s.readTokens]) expect(sent).not.toContain(token);
    expect(Object.keys(result)).not.toContain("answer");
    expect(result.sources.every(source => !("answer" in source) && !("comparison" in source))).toBe(true);
  });

  it("keeps explicit token order rather than sorting source IDs and supports six passages across three sources", async () => {
    const s = await setup(texts.map(text => ({ text })));
    const tokens = [s.body.snapshotTokens[2], s.body.snapshotTokens[0], s.body.snapshotTokens[1]];
    s.provider.mockResolvedValueOnce(completed({
      sources: [group("S3", ["P2", "P1"]), group("S1", ["P2", "P1"]), group("S2", ["P2", "P1"])],
    }));
    const result = await s.service.compare(BOOK, { ...s.body, snapshotTokens: tokens });
    expect(result.sources.map(source => source.sourceId)).toEqual(["W3", "W1", "W2"]);
    expect(result.sources.map(source => source.snapshotToken)).toEqual(tokens);
    expect(result.sources.flatMap(source => source.passages)).toHaveLength(6);
    expect(result.sources.every(source => source.passages.length === 2 && source.generatedAt === result.generatedAt)).toBe(true);
    expect(s.provider).toHaveBeenCalledOnce();
    expect(s.fetchPage).toHaveBeenCalledTimes(3);
  });

  it.each([false, true])("preserves every source when allInsufficient=%s", async allInsufficient => {
    const s = await setup();
    s.provider.mockResolvedValueOnce(completed({ sources: [
      group("S2", [], true), allInsufficient ? group("S1", [], true) : group("S1"),
    ] }));
    const result = await s.service.compare(BOOK, s.body);
    expect(result.sources.map(source => source.sourceId)).toEqual(["W1", "W2"]);
    expect(result.sources[0].status).toBe(allInsufficient ? "insufficient_evidence" : "selected");
    expect(result.sources[1]).toMatchObject({ status: "insufficient_evidence", passages: [],
      title: s.reads[1].title, finalUrl: s.reads[1].finalUrl, snapshotToken: s.reads[1].snapshotToken });
    if (allInsufficient) expect(result.sources.flatMap(source => source.passages)).toEqual([]);
    expect(s.provider).toHaveBeenCalledOnce();
  });

  it("restores numeric passage order within each source without sharing IDs between sources", async () => {
    const s = await setup([{ text: "甲".repeat(14_000) }, { text: "乙".repeat(14_000) }]);
    s.provider.mockResolvedValueOnce(completed({ sources: [group("S1", ["P10", "P2"]), group("S2", ["P10", "P2"])] }));
    const result = await s.service.compare(BOOK, s.body);
    for (const source of result.sources) expect(source.passages.map(p => p.id)).toEqual(["P2", "P10"]);
    expect(result.sources[0].passages[0].text).not.toBe(result.sources[1].passages[0].text);
  });

  it("preserves UTF-16 slices and actual per-source truncation", async () => {
    const s = await setup([
      { text: "甲".repeat(1199) + "😀" + "甲".repeat(28_801) },
      { text: "乙".repeat(1199) + "😀" + "乙".repeat(1500) },
    ]);
    s.provider.mockResolvedValueOnce(completed({ sources: [group("S1", ["P1", "P2"]), group("S2", ["P1", "P2"])] }));
    const result = await s.service.compare(BOOK, s.body);
    expect(result.sources.map(source => source.sourceTruncated)).toEqual([true, false]);
    const payload = JSON.parse(s.provider.mock.calls[0][0][1].content);
    expect(payload.sources.map((source: { sourceTruncated: boolean }) => source.sourceTruncated)).toEqual([true, false]);
    result.sources.forEach((source, index) => {
      expect(source.passages[0].end).toBe(1199);
      expect(source.passages[1].text.startsWith("😀")).toBe(true);
      for (const p of source.passages) {
        expect(p.text).toBe(s.reads[index].text.slice(p.start, p.end));
        expect(p.text).not.toMatch(/[\ud800-\udbff]$/);
        expect(p.text).not.toMatch(/^[\udc00-\udfff]/);
      }
    });
  });

  it("sends both complete 30,000-character texts at the exact total limit, including their tails", async () => {
    const s = await setup([
      { text: "甲".repeat(29_990) + "A_TAIL_001" },
      { text: "乙".repeat(29_990) + "B_TAIL_001" },
    ]);
    expect(s.reads.reduce((sum, source) => sum + source.text.length, 0)).toBe(LIMITS.TOTAL_TEXT_CHARS);
    await s.service.compare(BOOK, s.body);
    const payload = JSON.parse(s.provider.mock.calls[0][0][1].content);
    payload.sources.forEach((source: { passages: { text: string }[] }, index: number) => {
      expect(source.passages.map(p => p.text).join("")).toBe(s.reads[index].text);
      expect(source.passages.at(-1)!.text).toContain(index ? "B_TAIL_001" : "A_TAIL_001");
    });
    expect(s.provider).toHaveBeenCalledOnce();
  });

  it("rejects 60,001 characters without trimming, silently losing a source or calling a provider", async () => {
    const s = await setup([{ text: "甲".repeat(20_000) }, { text: "乙".repeat(20_000) }, { text: "丙".repeat(20_001) }]);
    await expect(s.service.compare(BOOK, s.body)).rejects.toEqual(new BookWebSourceComparisonError("BOOK_COMPARISON_TEXT_LIMIT"));
    expect(s.provider).not.toHaveBeenCalled();
    expect(s.fetchPage).toHaveBeenCalledTimes(3);
    expect(s.reads.map(source => source.text.length)).toEqual([20_000, 20_000, 20_001]);
  });
});

describe("comparison validates the whole source set before provider work", () => {
  it("rejects bad counts, tokens, questions and client-supplied material", async () => {
    const s = await setup();
    const tokens = s.body.snapshotTokens;
    for (const body of [null, [], {}, { ...s.body, snapshotTokens: [] }, { ...s.body, snapshotTokens: tokens.slice(0, 1) },
      { ...s.body, snapshotTokens: [...tokens, "a".repeat(32), "b".repeat(32)] },
      { ...s.body, snapshotTokens: [tokens[0], tokens[0]] }, { ...s.body, snapshotTokens: [tokens[0], "bad"] },
      { ...s.body, snapshotTokens: [tokens[0], 1] }, { ...s.body, snapshotTokens: tokens.join(",") },
      { ...s.body, question: "" }, { ...s.body, question: " \n " }, { ...s.body, question: "x".repeat(1001) },
      { ...s.body, question: "\ud800" }, { ...s.body, question: "x\0" }, { ...s.body, text: "CLIENT_TEXT" },
      { ...s.body, url: "https://example.org/injected" }, { ...s.body, sources: [] },
      { ...s.body, snapshotToken: tokens[0] }]) {
      await expect(s.service.compare(BOOK, body)).rejects.toEqual(new BookWebSourceComparisonError("BOOK_COMPARISON_INVALID_INPUT"));
    }
    await expect(s.service.compare("bad-book", s.body)).rejects.toMatchObject({ code: "BOOK_COMPARISON_INVALID_INPUT" });
    expect(s.provider).not.toHaveBeenCalled();
    expect(s.getSnapshot).not.toHaveBeenCalled();
    expect(s.fetchPage).toHaveBeenCalledTimes(2);
  });

  it("accepts an exactly 1,000-character trimmed question", async () => {
    const s = await setup();
    expect((await s.service.compare(BOOK, { ...s.body, question: "  " + "问".repeat(1000) + "\n" })).question).toHaveLength(1000);
    expect(s.provider).toHaveBeenCalledOnce();
  });

  it("rejects two separately read snapshots with the same source ID", async () => {
    const s = await setup([{ id: "W1" }, { id: "W1" }]);
    expect(new Set(s.body.snapshotTokens).size).toBe(2);
    expect(new Set(s.reads.map(source => source.finalUrl)).size).toBe(2);
    await expect(s.service.compare(BOOK, s.body)).rejects.toEqual(new BookWebSourceComparisonError("BOOK_COMPARISON_INVALID_INPUT"));
    expect(s.provider).not.toHaveBeenCalled();
  });

  it("rejects distinct source IDs that resolve to the same normalized webpage", async () => {
    const s = await setup([
      { finalUrl: "https://EXAMPLE.org:443/shared#first" },
      { finalUrl: "https://example.org/shared#second" },
    ]);
    expect(new Set(s.body.snapshotTokens).size).toBe(2);
    await expect(s.service.compare(BOOK, s.body)).rejects.toMatchObject({ code: "BOOK_COMPARISON_INVALID_INPUT" });
    expect(s.provider).not.toHaveBeenCalled();
  });

  it.each([
    ["https://example.org/Page", "https://example.org/page"],
    ["https://example.org/page", "https://example.org/page/"],
    ["https://example.org/page?q=first", "https://example.org/page?q=second"],
  ])("does not collapse distinct URL path or query semantics: %s / %s", async (first, second) => {
    const s = await setup([{ finalUrl: first }, { finalUrl: second }]);
    expect((await s.service.compare(BOOK, s.body)).sources.map(source => source.finalUrl)).toEqual([first, second]);
    expect(s.provider).toHaveBeenCalledOnce();
  });

  it("fails the whole selection when a later token is expired, while preserving a valid captured source", async () => {
    const s = await setup();
    s.advance(BOOK_WEB_SOURCE_EVIDENCE_LIMITS.SNAPSHOT_TTL_MS - 1);
    const fresh = await s.reader.read(BOOK, { sourceToken: s.readTokens[1] });
    s.advance(1);
    await expect(s.service.compare(BOOK, { ...s.body,
      snapshotTokens: [fresh.snapshotToken, s.reads[0].snapshotToken] })).rejects.toMatchObject({ code: "BOOK_COMPARISON_EXPIRED" });
    expect(s.getSnapshot).toHaveBeenCalledTimes(2);
    expect(s.provider).not.toHaveBeenCalled();
    expect(s.reader.getSnapshot(BOOK, fresh.snapshotToken).text).toBe(fresh.text);
  });

  it("rejects cross-book and missing snapshots without another read or provider request", async () => {
    const s = await setup();
    await expect(s.service.compare(OTHER, s.body)).rejects.toMatchObject({ code: "BOOK_COMPARISON_INVALID_INPUT" });
    await expect(s.service.compare(BOOK, { ...s.body,
      snapshotTokens: [s.body.snapshotTokens[0], "a".repeat(32)] })).rejects.toMatchObject({ code: "BOOK_COMPARISON_EXPIRED" });
    expect(s.provider).not.toHaveBeenCalled();
    expect(s.fetchPage).toHaveBeenCalledTimes(2);
  });

  it("finishes against all captured immutable snapshots when TTL expires during the provider call", async () => {
    const s = await setup();
    s.provider.mockImplementationOnce(async () => {
      s.advance(BOOK_WEB_SOURCE_EVIDENCE_LIMITS.SNAPSHOT_TTL_MS);
      return completed({ sources: [group("S1"), group("S2")] });
    });
    const result = await s.service.compare(BOOK, s.body);
    result.sources.forEach((source, index) => {
      const p = source.passages[0];
      expect(p.text).toBe(s.reads[index].text.slice(p.start, p.end));
      expect(() => s.reader.getSnapshot(BOOK, source.snapshotToken)).toThrow();
    });
    expect(s.getSnapshot).toHaveBeenCalledTimes(2);
    expect(s.provider).toHaveBeenCalledOnce();
  });
});

describe("comparison rejects incomplete or generated model answers", () => {
  it.each([
    null, [], {}, { sources: null }, { sources: [] }, { sources: [group("S1")] },
    { sources: [group("S1"), group("S2"), group("S3")] },
    { sources: [group("S1"), group("S1")] }, { sources: [group("S1"), group("S3")] },
    { sources: [group("S1"), { ...group("S2"), sourceKey: 2 }] },
    { sources: [group("S1"), { passageIds: ["P1"], insufficientEvidence: false }] },
    { sources: [group("S1"), { sourceKey: "S2", passageIds: ["P1"] }] },
    { sources: [group("S1"), { ...group("S2"), insufficientEvidence: "false" }] },
    { sources: [group("S1"), group("S2", [], false)] },
    { sources: [group("S1"), group("S2", ["P1"], true)] },
    { sources: [group("S1"), group("S2", ["P1", "P1"])] },
    { sources: [group("S1"), group("S2", ["P1", "P2", "P3"])] },
    { sources: [group("S1"), group("S2", ["P99"])] },
    { sources: [group("S1"), { ...group("S2"), passageIds: [1] }] },
    { sources: [group("S1"), group("S2", ["S1/P1"])] },
    { sources: [group("S1"), group("S2")], answer: "1935年初版，1937年再版" },
    { sources: [group("S1"), group("S2")], agreement: "这些来源达成共识" },
    { sources: [group("S1"), { ...group("S2"), title: "MODEL_WRITTEN_TITLE" }] },
    { sources: [group("S1"), { ...group("S2"), text: "MODEL_WRITTEN_QUOTE" }] },
  ])("rejects the whole malformed selection %#", async value => {
    const s = await setup();
    s.provider.mockResolvedValueOnce(completed(value));
    await expect(s.service.compare(BOOK, s.body)).rejects.toEqual(new BookWebSourceComparisonError("BOOK_COMPARISON_INVALID_OUTPUT"));
    expect(s.provider).toHaveBeenCalledOnce();
  });

  it("does not let a source use an ID that only exists in a different source", async () => {
    const s = await setup([{ text: texts[0] }, { text: "只有一个短片段。" }]);
    s.provider.mockResolvedValueOnce(completed({ sources: [group("S1", ["P2"]), group("S2", ["P2"])] }));
    await expect(s.service.compare(BOOK, s.body)).rejects.toMatchObject({ code: "BOOK_COMPARISON_INVALID_OUTPUT" });
    expect(s.provider).toHaveBeenCalledOnce();
  });

  it.each(["not JSON", '{"sources":[', "\u0060\u0060\u0060json\n{}\n\u0060\u0060\u0060", "x".repeat(2001)])(
    "rejects invalid, incomplete or oversized JSON text %#", async content => {
      const s = await setup();
      s.provider.mockResolvedValueOnce({ ok: true, model: "fixture", content });
      await expect(s.service.compare(BOOK, s.body)).rejects.toMatchObject({ code: "BOOK_COMPARISON_INVALID_OUTPUT" });
    });
});

describe("comparison keeps errors and cancellation bounded", () => {
  it("does not start snapshot or provider work when disabled", async () => {
    const s = await setup();
    const disabled = createBookWebSourceComparisonService({ getSnapshot: s.getSnapshot, provider: s.provider, isEnabled: () => false });
    await expect(disabled.compare(BOOK, s.body)).rejects.toMatchObject({ code: "BOOK_COMPARISON_UNAVAILABLE" });
    expect(s.getSnapshot).not.toHaveBeenCalled();
    expect(s.provider).not.toHaveBeenCalled();
  });

  it("maps unexpected snapshot failures or mismatched captured identities without exposing their contents", async () => {
    const s = await setup();
    s.getSnapshot.mockImplementationOnce(() => { throw new Error("PRIVATE_DATABASE_TOKEN"); });
    await expect(s.service.compare(BOOK, s.body)).rejects.toEqual(new BookWebSourceComparisonError("BOOK_COMPARISON_UNAVAILABLE"));
    const snapshot = s.reader.getSnapshot(BOOK, s.reads[0].snapshotToken);
    for (const mismatch of [{ ...snapshot, bookId: OTHER }, { ...snapshot, snapshotToken: "x".repeat(32) }]) {
      s.getSnapshot.mockReturnValueOnce(mismatch as BookWebSourceSnapshot);
      await expect(s.service.compare(BOOK, s.body)).rejects.toEqual(new BookWebSourceComparisonError("BOOK_COMPARISON_UNAVAILABLE"));
    }
    expect(s.provider).not.toHaveBeenCalled();
  });

  it.each([401, 429, 502, 503, 504])("maps provider status %i without leaking its body or retrying", async status => {
    const s = await setup();
    s.provider.mockResolvedValueOnce({ ok: false, status, error: "PRIVATE_PROVIDER_RESPONSE" });
    await expect(s.service.compare(BOOK, s.body)).rejects.toEqual(new BookWebSourceComparisonError(
      status === 504 ? "BOOK_COMPARISON_TIMEOUT" : "BOOK_COMPARISON_UNAVAILABLE"));
    expect(s.provider).toHaveBeenCalledOnce();
  });

  it("hides a thrown provider error", async () => {
    const s = await setup();
    s.provider.mockRejectedValueOnce(new Error("PRIVATE_PROVIDER_PROMPT"));
    await expect(s.service.compare(BOOK, s.body)).rejects.toEqual(new BookWebSourceComparisonError("BOOK_COMPARISON_UNAVAILABLE"));
    expect(s.provider).toHaveBeenCalledOnce();
  });

  it("honors early cancellation and rejects a late success after cancellation", async () => {
    const s = await setup();
    const early = new AbortController(); early.abort();
    await expect(s.service.compare(BOOK, s.body, { signal: early.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(s.getSnapshot).not.toHaveBeenCalled();
    expect(s.provider).not.toHaveBeenCalled();
    const late = new AbortController();
    s.provider.mockImplementationOnce(async () => {
      late.abort();
      return completed({ sources: [group("S1"), group("S2")] });
    });
    await expect(s.service.compare(BOOK, s.body, { signal: late.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(s.provider).toHaveBeenCalledOnce();
    expect(s.provider.mock.calls[0][1]?.signal).toBe(late.signal);
  });
});
