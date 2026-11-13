import { describe, expect, it, vi } from "vitest";
import { createBookWebSourceReader, type BookWebSourceFetcher } from "./book-web-source.js";
import {
  BOOK_WEB_SOURCE_EVIDENCE_LIMITS as LIMITS, BookWebSourceEvidenceError,
  createBookWebSourceEvidenceService, splitBookWebSourcePassages,
} from "./book-web-source-evidence.js";
import type { chatCompletion } from "./minimax.js";

const BOOK = "10000001_000000000001", OTHER = "10000002_000000000002";
const source = { id: "W1", title: "公开网页来源", url: "https://example.org/source" };
const date = "2026-11-13T08:00:00.000Z";
const question = "资料中出现了哪些出版年份？";
const content = "资料甲记载 1935 年。\n" + "甲".repeat(700) + "\n\n"
  + "资料乙记载 1937 年，未说明二者的版本关系。\n" + "乙".repeat(700);
const completed = (value: unknown = { passageIds: ["P1"], insufficientEvidence: false }) =>
  ({ ok: true as const, model: "fixture", content: JSON.stringify(value) });
async function setup(text = content) {
  let time = Date.parse(date);
  const now = () => new Date(time);
  const fetchPage = vi.fn<BookWebSourceFetcher>().mockResolvedValue({
    finalUrl: source.url + "/final", contentType: "text/plain", body: Buffer.from(text),
  });
  const reader = createBookWebSourceReader({ fetchPage, now });
  const readToken = reader.issueToken(BOOK, source)!;
  const read = await reader.read(BOOK, { sourceToken: readToken });
  const provider = vi.fn<typeof chatCompletion>().mockResolvedValue(completed());
  const getSnapshot = vi.fn(reader.getSnapshot);
  const service = createBookWebSourceEvidenceService({ getSnapshot, provider, isEnabled: () => true, now });
  return { reader, read, readToken, fetchPage, provider, getSnapshot, service, now,
    advance: (ms: number) => { time += ms; }, body: { snapshotToken: read.snapshotToken!, question } };
}

function expectExactCoverage(text: string) {
  const passages = splitBookWebSourcePassages(text);
  expect(passages.length).toBeLessThanOrEqual(LIMITS.PASSAGES);
  expect(passages[0].start).toBe(0);
  expect(passages.at(-1)!.end).toBe(text.length);
  expect(passages.map(p => p.text).join("")).toBe(text);
  passages.forEach((p, index) => {
    expect(p.id).toBe("P" + (index + 1));
    expect(p.start).toBe(index ? passages[index - 1].end : 0);
    expect(p.end).toBeGreaterThan(p.start);
    expect(p.text).toBe(text.slice(p.start, p.end));
    expect(p.text.length).toBe(p.end - p.start);
    expect(p.text.length).toBeLessThanOrEqual(LIMITS.PASSAGE_CHARS);
    expect(p.text).not.toMatch(/[\ud800-\udbff]$/);
    expect(p.text).not.toMatch(/^[\udc00-\udfff]/);
  });
  return passages;
}

describe("exact source passage coverage", () => {
  it("covers the whole 30,000-unit source, including its final marker, without separators", () => {
    const text = "字".repeat(29_990) + "TAIL_CHECK";
    expect(text).toHaveLength(30_000);
    const passages = expectExactCoverage(text);
    expect(passages.at(-1)!.text).toContain("TAIL_CHECK");
  });

  it.each([599, 600, 1199, 1200])("preserves UTF-16 offsets around a paragraph ending at %i", end => {
    const text = "甲".repeat(end - 2) + "\n\n" + "乙".repeat(1800);
    const passages = expectExactCoverage(text);
    if (end >= 600 && end <= 1200) expect(passages[0].end).toBe(end);
    else expect(passages[0].end).toBe(1200);
  });

  it("prefers a complete paragraph boundary over a later sentence and preserves whitespace", () => {
    const text = "  " + "甲".repeat(650) + "\n\n" + "乙".repeat(200) + "。" + "丙".repeat(900) + " \n";
    const passages = expectExactCoverage(text);
    expect(passages[0].text).toBe("  " + "甲".repeat(650) + "\n\n");
    expect(passages.at(-1)!.text).toMatch(/ \n$/);
  });

  it("uses a later sentence boundary and otherwise avoids splitting an emoji surrogate pair", () => {
    const sentence = "甲".repeat(800) + "。”\n" + "乙".repeat(1600);
    expect(expectExactCoverage(sentence)[0].end).toBe(803);
    const emoji = "甲".repeat(1199) + "😀" + "乙".repeat(1500);
    const pieces = expectExactCoverage(emoji);
    expect(pieces[0].end).toBe(1199);
    expect(pieces[1].text.startsWith("😀")).toBe(true);
  });
});

describe("bounded immutable successfully-read snapshots", () => {
  it("creates a fresh token on each read and never changes a previous snapshot or shares a writable object", async () => {
    const s = await setup("旧网页原文。");
    expect(s.read.snapshotToken).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(s.read.snapshotToken).not.toBe(s.readToken);
    const first = s.reader.getSnapshot(BOOK, s.read.snapshotToken);
    expect(Object.isFrozen(first)).toBe(true);
    s.read.text = "CLIENT_REPLACEMENT";
    expect(Reflect.set(first, "text", "CACHE_REPLACEMENT")).toBe(false);
    s.fetchPage.mockResolvedValueOnce({ finalUrl: source.url, contentType: "text/plain", body: Buffer.from("新网页原文。") });
    const next = await s.reader.read(BOOK, { sourceToken: s.readToken });
    expect(next.snapshotToken).not.toBe(s.read.snapshotToken);
    expect(s.reader.getSnapshot(BOOK, s.read.snapshotToken).text).toBe("旧网页原文。");
    expect(s.reader.getSnapshot(BOOK, next.snapshotToken).text).toBe("新网页原文。");
    expect(s.provider).not.toHaveBeenCalled();
  });

  it("binds snapshots to the book, expires at the exact TTL, and rejects a read grant as a snapshot", async () => {
    const s = await setup();
    expect(() => s.reader.getSnapshot(OTHER, s.read.snapshotToken)).toThrowError(new BookWebSourceEvidenceError("BOOK_EVIDENCE_INVALID_INPUT"));
    expect(() => s.reader.getSnapshot(BOOK, s.readToken)).toThrowError(new BookWebSourceEvidenceError("BOOK_EVIDENCE_EXPIRED"));
    expect(() => s.reader.getSnapshot(BOOK, "bad")).toThrowError(new BookWebSourceEvidenceError("BOOK_EVIDENCE_INVALID_INPUT"));
    s.advance(LIMITS.SNAPSHOT_TTL_MS - 1);
    expect(s.reader.getSnapshot(BOOK, s.read.snapshotToken).text).toBe(s.read.text);
    s.advance(1);
    expect(() => s.reader.getSnapshot(BOOK, s.read.snapshotToken)).toThrowError(new BookWebSourceEvidenceError("BOOK_EVIDENCE_EXPIRED"));
  });

  it("keeps at most 32 snapshots; failed and cancelled reads do not evict successful snapshots", async () => {
    const s = await setup("成功读取的资料。");
    for (let i = 1; i < LIMITS.SNAPSHOTS; i++) await s.reader.read(BOOK, { sourceToken: s.readToken });
    s.fetchPage.mockRejectedValueOnce(new Error("SOURCE_FAILURE"));
    await expect(s.reader.read(BOOK, { sourceToken: s.readToken })).rejects.toMatchObject({ code: "BOOK_SOURCE_UNAVAILABLE" });
    const cancelled = new AbortController();
    s.fetchPage.mockImplementationOnce(async () => {
      cancelled.abort();
      return { finalUrl: source.url, contentType: "text/plain", body: Buffer.from("迟到的文字") };
    });
    await expect(s.reader.read(BOOK, { sourceToken: s.readToken }, { signal: cancelled.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(s.reader.getSnapshot(BOOK, s.read.snapshotToken).text).toBe(s.read.text);
    await s.reader.read(BOOK, { sourceToken: s.readToken });
    expect(() => s.reader.getSnapshot(BOOK, s.read.snapshotToken)).toThrowError(new BookWebSourceEvidenceError("BOOK_EVIDENCE_EXPIRED"));
  });
});

describe("source evidence selects immutable server passages only", () => {
  it("returns exact source slices and provenance with one model call, no second fetch, and no generated factual prose", async () => {
    const s = await setup();
    s.provider.mockResolvedValueOnce(completed({ passageIds: ["P2", "P1"], insufficientEvidence: false }));
    const result = await s.service.find(BOOK, { ...s.body, question: "  " + question + "  " });
    expect(result).toMatchObject({ bookId: BOOK, sourceId: "W1", snapshotToken: s.read.snapshotToken, question,
      mode: "source_passages", status: "selected", requestedUrl: source.url, finalUrl: source.url + "/final",
      title: source.title, fetchedAt: date, generatedAt: date, sourceTruncated: false });
    expect(result.passages.map(p => p.id)).toEqual(["P1", "P2"]);
    for (const p of result.passages) expect(p.text).toBe(s.read.text.slice(p.start, p.end));
    expect(s.fetchPage).toHaveBeenCalledOnce();
    expect(s.provider).toHaveBeenCalledOnce();
    expect(s.getSnapshot).toHaveBeenCalledExactlyOnceWith(BOOK, s.read.snapshotToken);
    expect(s.provider.mock.calls[0][1]).toMatchObject({ temperature: 0.2, maxTokens: 1024,
      timeoutMs: 60_000, requireCompleted: true });
    const payload = JSON.parse(s.provider.mock.calls[0][0][1].content);
    expect(Object.keys(payload).sort()).toEqual(["passages", "question", "source"]);
    expect(payload.passages.map((p: { text: string }) => p.text).join("")).toBe(s.read.text);
    expect(JSON.stringify(s.provider.mock.calls)).not.toContain(s.read.snapshotToken);
    expect(JSON.stringify(s.provider.mock.calls)).not.toContain(s.readToken);
    expect(JSON.stringify(result)).not.toContain("初版之后再版");
  });

  it("restores numeric source order for P2 and P10 instead of lexicographic ID order", async () => {
    const s = await setup("甲".repeat(14_000));
    s.provider.mockResolvedValueOnce(completed({ passageIds: ["P10", "P2"], insufficientEvidence: false }));
    const result = await s.service.find(BOOK, s.body);
    expect(result.passages.map(p => p.id)).toEqual(["P2", "P10"]);
    expect(result.passages[0].end).toBeLessThanOrEqual(result.passages[1].start);
  });

  it("reports insufficient evidence as an empty selection without inventing an answer", async () => {
    const s = await setup();
    s.provider.mockResolvedValueOnce(completed({ passageIds: [], insufficientEvidence: true }));
    expect(await s.service.find(BOOK, s.body)).toMatchObject({ status: "insufficient_evidence", passages: [], question });
    expect(s.fetchPage).toHaveBeenCalledOnce();
    expect(s.provider).toHaveBeenCalledOnce();
  });

  it("carries the actual read truncation into selection inputs and outputs", async () => {
    const s = await setup("甲".repeat(30_001));
    expect(s.read.truncated).toBe(true);
    const result = await s.service.find(BOOK, s.body);
    expect(result.sourceTruncated).toBe(true);
    expect(JSON.parse(s.provider.mock.calls[0][0][1].content).source.sourceTruncated).toBe(true);
  });

  it.each([
    null, [], {}, { passageIds: [], insufficientEvidence: false },
    { passageIds: ["P1"], insufficientEvidence: true },
    { passageIds: ["P1", "P1"], insufficientEvidence: false },
    { passageIds: ["P64"], insufficientEvidence: false },
    { passageIds: ["P1", "P2", "P3", "P4", "P5"], insufficientEvidence: false },
    { passageIds: [1], insufficientEvidence: false },
    { passageIds: ["P1"], insufficientEvidence: "false" },
    { passageIds: ["P1"], insufficientEvidence: false, answer: "1935年初版之后再版于1937年" },
    { passageIds: ["P1"], insufficientEvidence: false, title: "MODEL_WRITTEN_TITLE" },
  ])("rejects malformed or free-synthesis model output %#", async value => {
    const s = await setup();
    s.provider.mockResolvedValueOnce(completed(value));
    await expect(s.service.find(BOOK, s.body)).rejects.toEqual(new BookWebSourceEvidenceError("BOOK_EVIDENCE_INVALID_OUTPUT"));
    expect(s.provider).toHaveBeenCalledOnce();
  });

  it.each(["not JSON", '{"passageIds":["P1"]', "\u0060\u0060\u0060json\n{}\n\u0060\u0060\u0060", "X".repeat(2001)])("rejects non-completed JSON text %#", async content => {
    const s = await setup();
    s.provider.mockResolvedValueOnce({ ok: true, model: "fixture", content });
    await expect(s.service.find(BOOK, s.body)).rejects.toMatchObject({ code: "BOOK_EVIDENCE_INVALID_OUTPUT" });
  });

  it("rejects client-supplied text, URL, passages, malformed questions and cross-book tokens before a model call", async () => {
    const s = await setup();
    for (const body of [null, [], {}, { ...s.body, text: "CLIENT_TEXT" }, { ...s.body, url: source.url },
      { ...s.body, passages: [{ id: "P1", text: "CLIENT_TEXT" }] }, { ...s.body, question: "" },
      { ...s.body, question: "x".repeat(1001) }, { ...s.body, question: "\ud800" }, { ...s.body, question: "x\0" },
      { ...s.body, snapshotToken: "bad" }]) {
      await expect(s.service.find(BOOK, body)).rejects.toMatchObject({ code: "BOOK_EVIDENCE_INVALID_INPUT" });
    }
    await expect(s.service.find(OTHER, s.body)).rejects.toMatchObject({ code: "BOOK_EVIDENCE_INVALID_INPUT" });
    await expect(s.service.find("bad-book", s.body)).rejects.toMatchObject({ code: "BOOK_EVIDENCE_INVALID_INPUT" });
    await expect(s.service.find(BOOK, { ...s.body, snapshotToken: "a".repeat(32) })).rejects.toMatchObject({ code: "BOOK_EVIDENCE_EXPIRED" });
    expect(s.provider).not.toHaveBeenCalled();
    expect(s.fetchPage).toHaveBeenCalledOnce();
  });

  it("does not call a model when disabled or expose unexpected snapshot/provider errors", async () => {
    const s = await setup();
    const disabled = createBookWebSourceEvidenceService({ getSnapshot: s.getSnapshot, provider: s.provider, isEnabled: () => false });
    await expect(disabled.find(BOOK, s.body)).rejects.toEqual(new BookWebSourceEvidenceError("BOOK_EVIDENCE_UNAVAILABLE"));
    expect(s.provider).not.toHaveBeenCalled();
    s.getSnapshot.mockImplementationOnce(() => { throw new Error("PRIVATE_DATABASE_TOKEN"); });
    await expect(s.service.find(BOOK, s.body)).rejects.toEqual(new BookWebSourceEvidenceError("BOOK_EVIDENCE_UNAVAILABLE"));
    expect(s.provider).not.toHaveBeenCalled();
    s.provider.mockRejectedValueOnce(new Error("PRIVATE_PROVIDER_PROMPT"));
    await expect(s.service.find(BOOK, s.body)).rejects.toEqual(new BookWebSourceEvidenceError("BOOK_EVIDENCE_UNAVAILABLE"));
    expect(s.provider).toHaveBeenCalledOnce();
  });

  it.each([401, 429, 502, 503, 504])("maps provider status %i without returning provider text or retrying", async status => {
    const s = await setup();
    s.provider.mockResolvedValueOnce({ ok: false, status, error: "PRIVATE_PROVIDER_BODY" });
    await expect(s.service.find(BOOK, s.body)).rejects.toEqual(new BookWebSourceEvidenceError(
      status === 504 ? "BOOK_EVIDENCE_TIMEOUT" : "BOOK_EVIDENCE_UNAVAILABLE"));
    expect(s.provider).toHaveBeenCalledOnce();
  });

  it("cancels before calling the provider and rejects a late successful response after cancellation", async () => {
    const s = await setup();
    const before = new AbortController();
    before.abort();
    await expect(s.service.find(BOOK, s.body, { signal: before.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(s.provider).not.toHaveBeenCalled();
    const during = new AbortController();
    s.provider.mockImplementationOnce(async () => { during.abort(); return completed(); });
    await expect(s.service.find(BOOK, s.body, { signal: during.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(s.provider).toHaveBeenCalledOnce();
  });

  it("finishes against the captured snapshot if its TTL elapses during the provider call", async () => {
    const s = await setup();
    s.provider.mockImplementationOnce(async () => { s.advance(LIMITS.SNAPSHOT_TTL_MS); return completed(); });
    const result = await s.service.find(BOOK, s.body);
    expect(result.passages[0].text).toBe(s.read.text.slice(result.passages[0].start, result.passages[0].end));
    expect(s.getSnapshot).toHaveBeenCalledOnce();
    expect(() => s.reader.getSnapshot(BOOK, s.read.snapshotToken)).toThrowError(new BookWebSourceEvidenceError("BOOK_EVIDENCE_EXPIRED"));
  });
});
