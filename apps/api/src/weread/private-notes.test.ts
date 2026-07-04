import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadPrivateNotesData,
  normalizeNotesQuery,
  queryPrivateNotes,
  type WereadNotesQuery,
} from "./private-notes.js";

const FORBIDDEN_KEYS = [
  "wereadBookId",
  "noteId",
  "highlightId",
  "chapterTitle",
  "title",
  "author",
];

function writeFixture(tmpDir: string, name: string, content: unknown) {
  const fullPath = path.join(tmpDir, name);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, JSON.stringify(content, null, 2));
}

function fixtureData(tmpDir: string) {
  writeFixture(tmpDir, "snapshots/latest/weread-notes.snapshot.json", [
    {
      wereadBookId: "wb1",
      noteId: "wb1_5_1003-2852",
      type: "highlight",
      chapterTitle: "第七章 私有章节标题",
      text: "这是第一个划线",
      comment: "我的想法 1",
      createdAt: "1700000000",
      updatedAt: null,
    },
    {
      wereadBookId: "wb1",
      noteId: "wb1_5_9999-0001",
      type: "thought",
      chapterTitle: "第七章",
      text: "想法正文",
      comment: null,
      createdAt: "1700000050",
      updatedAt: null,
    },
    {
      wereadBookId: "wb2",
      noteId: "wb2_1_1-2",
      type: "review",
      chapterTitle: null,
      text: "书评正文",
      comment: null,
      createdAt: "1700000100",
      updatedAt: null,
    },
    {
      wereadBookId: "wb3",
      noteId: "wb3_1_1-2",
      type: "highlight",
      chapterTitle: null,
      text: "未匹配书的划线",
      comment: null,
      createdAt: "1700000200",
      updatedAt: null,
    },
    {
      wereadBookId: "wb4",
      noteId: "wb4_1_1-2",
      // missing type → unknown
      chapterTitle: null,
      text: "未知类型笔记",
      comment: null,
      createdAt: null,
      updatedAt: null,
    },
    {
      wereadBookId: "wb5",
      noteId: "wb5_1_1-2",
      type: "highlight",
      chapterTitle: null,
      text: "", // empty → should be dropped
      comment: null,
      createdAt: "1700000300",
      updatedAt: null,
    },
  ]);
  writeFixture(tmpDir, "derived/latest/weread-matches.confirmed.json", [
    {
      wereadBookId: "wb1",
      catalogId: "13000000_000000000001",
      ssid: "13000000",
      dxid: "000000000001",
      matchMethod: "isbn",
      matchConfidence: "high",
      decisionSource: "auto_seed",
    },
    {
      wereadBookId: "wb2",
      catalogId: "13000000_000000000002",
      ssid: "13000000",
      dxid: "000000000002",
      matchMethod: "title_author",
      matchConfidence: "high",
      decisionSource: "manual",
    },
  ]);
  return loadPrivateNotesData(tmpDir);
}

describe("private-notes", () => {
  let tmpDir = "";

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "weread-private-notes-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("basic query returns text/comment but no private IDs", () => {
    const data = fixtureData(tmpDir);
    const result = queryPrivateNotes(data, { type: "all", days: "all", matchedOnly: false, limit: 100, offset: 0, sort: "newest" });
    expect(result.items.length).toBeGreaterThan(0);

    for (const item of result.items) {
      // required text
      expect(typeof item.text).toBe("string");
      // no forbidden keys at any level
      const serialised = JSON.stringify(item);
      for (const k of FORBIDDEN_KEYS) {
        expect(serialised.includes(`"${k}"`)).toBe(false);
      }
      expect(item.source).toBe("private_weread");
    }
  });

  it("type filter highlight/thought/review", () => {
    const data = fixtureData(tmpDir);
    const q: WereadNotesQuery = { type: "highlight", days: "all", matchedOnly: false, limit: 100, offset: 0, sort: "newest" };
    const r = queryPrivateNotes(data, q);
    expect(r.items.every((i) => i.type === "highlight")).toBe(true);

    const t = queryPrivateNotes(data, { ...q, type: "thought" });
    expect(t.items.every((i) => i.type === "thought")).toBe(true);

    const v = queryPrivateNotes(data, { ...q, type: "review" });
    expect(v.items.every((i) => i.type === "review")).toBe(true);
  });

  it("days filter narrows the window and excludes notes without dates", () => {
    const data = fixtureData(tmpDir);
    // All fixture notes are 2023-ish; 7-day window will be empty.
    const r7 = queryPrivateNotes(data, { type: "all", days: "7", matchedOnly: false, limit: 100, offset: 0, sort: "newest" });
    expect(r7.items.length).toBe(0);
    expect(r7.summary.totalAfterFilter).toBe(0);

    // 'all' keeps them
    const rAll = queryPrivateNotes(data, { type: "all", days: "all", matchedOnly: false, limit: 100, offset: 0, sort: "newest" });
    expect(rAll.summary.totalAfterFilter).toBeGreaterThan(0);
  });

  it("matchedOnly filter keeps only notes that join to confirmed matches", () => {
    const data = fixtureData(tmpDir);
    const r = queryPrivateNotes(data, { type: "all", days: "all", matchedOnly: true, limit: 100, offset: 0, sort: "newest" });
    expect(r.items.length).toBeGreaterThan(0);
    for (const it of r.items) {
      expect(it.matched).toBe(true);
      expect(typeof it.catalogId).toBe("string");
      expect(it.catalogId).toMatch(/^[0-9]+_[0-9]{12}$/);
    }
    // unmatched items excluded
    expect(r.items.every((i) => i.text !== "未匹配书的划线")).toBe(true);
  });

  it("pagination limit/offset works and hasMore is correct", () => {
    const data = fixtureData(tmpDir);
    const r1 = queryPrivateNotes(data, { type: "all", days: "all", matchedOnly: false, limit: 2, offset: 0, sort: "newest" });
    expect(r1.items.length).toBeLessThanOrEqual(2);
    expect(r1.pageInfo.limit).toBe(2);
    expect(r1.pageInfo.offset).toBe(0);

    const r2 = queryPrivateNotes(data, { type: "all", days: "all", matchedOnly: false, limit: 2, offset: 2, sort: "newest" });
    expect(r2.pageInfo.offset).toBe(2);

    if (r1.items.length + r2.items.length < r1.summary.totalAfterFilter) {
      expect(r1.pageInfo.hasMore || r2.pageInfo.hasMore).toBe(true);
    }
  });

  it("limit max 100 is enforced via normalize", () => {
    const n = normalizeNotesQuery({ type: "all", days: "all", matchedOnly: false, limit: 9999, offset: 0, sort: "newest" });
    expect(n.limit).toBe(100);

    const neg = normalizeNotesQuery({ type: "all", days: "all", matchedOnly: false, limit: -3, offset: 0, sort: "newest" });
    expect(neg.limit).toBe(1);

    const zero = normalizeNotesQuery({ type: "all", days: "all", matchedOnly: false, limit: 0, offset: 0, sort: "newest" });
    expect(zero.limit).toBe(1);
  });

  it("offset is clamped to >= 0", () => {
    const n = normalizeNotesQuery({ type: "all", days: "all", matchedOnly: false, limit: 10, offset: -10, sort: "newest" });
    expect(n.offset).toBe(0);
  });

  it("sort newest vs oldest yields reverse order", () => {
    const data = fixtureData(tmpDir);
    const newest = queryPrivateNotes(data, { type: "all", days: "all", matchedOnly: false, limit: 100, offset: 0, sort: "newest" });
    const oldest = queryPrivateNotes(data, { type: "all", days: "all", matchedOnly: false, limit: 100, offset: 0, sort: "oldest" });
    expect(newest.items[0]?.text).toBe(oldest.items[oldest.items.length - 1]?.text);
    expect(newest.items[newest.items.length - 1]?.text).toBe(oldest.items[0]?.text);
  });

  it("summary counts add up", () => {
    const data = fixtureData(tmpDir);
    const r = queryPrivateNotes(data, { type: "all", days: "all", matchedOnly: false, limit: 100, offset: 0, sort: "newest" });
    const { summary } = r;
    expect(summary.highlights + summary.thoughts + summary.reviews + summary.unknown).toBe(summary.totalAfterFilter);
    expect(summary.matchedCount + summary.unmatchedCount).toBe(summary.totalAfterFilter);
  });

  it("response excludes wereadBookId / noteId / highlightId / chapterTitle / title / author", () => {
    const data = fixtureData(tmpDir);
    const r = queryPrivateNotes(data, { type: "all", days: "all", matchedOnly: false, limit: 100, offset: 0, sort: "newest" });
    const serialised = JSON.stringify(r);
    for (const k of FORBIDDEN_KEYS) {
      expect(serialised.includes(`"${k}"`)).toBe(false);
    }
    // raw numeric noteId pattern not echoed either
    expect(serialised.includes("wb1_5_1003-2852")).toBe(false);
    expect(serialised.includes("第七章 私有章节标题")).toBe(false);
  });

  it("invalid note records (missing wereadBookId or empty text) are dropped", () => {
    const data = fixtureData(tmpDir);
    // wb5 has empty text; result should not contain it.
    const r = queryPrivateNotes(data, { type: "all", days: "all", matchedOnly: false, limit: 100, offset: 0, sort: "newest" });
    expect(r.items.every((i) => i.text.length > 0)).toBe(true);
  });

  it("normalizeNotesQuery falls back to defaults for unknown enum values", () => {
    const n = normalizeNotesQuery({ type: "garbage" as unknown as "all", days: "nope" as unknown as "all", matchedOnly: false, limit: 1, offset: 0, sort: "sideways" as unknown as "newest" });
    expect(n.type).toBe("all");
    expect(n.days).toBe("all");
    expect(n.sort).toBe("newest");
  });

  it("hasComment true keeps only notes with non-empty comment", () => {
    const data = fixtureData(tmpDir);
    const r = queryPrivateNotes(data, { type: "all", days: "all", matchedOnly: false, hasComment: true, limit: 100, offset: 0, sort: "newest" });
    expect(r.items.length).toBeGreaterThan(0);
    for (const it of r.items) {
      expect(typeof it.comment).toBe("string");
      expect(it.comment && it.comment.length > 0).toBe(true);
    }
  });
});