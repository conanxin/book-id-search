import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

function searchFixture(tmpDir: string) {
  writeFixture(tmpDir, "snapshots/latest/weread-notes.snapshot.json", [
    {
      wereadBookId: "wb1",
      noteId: "wb1_5_1003-2852",
      type: "highlight",
      chapterTitle: "第七章 私有章节标题",
      text: "这是一段关于建筑学的划线",
      comment: "佛塔的造型很有趣",
      createdAt: "1700000000",
      updatedAt: null,
    },
    {
      wereadBookId: "wb1",
      noteId: "wb1_5_9999-0001",
      type: "highlight",
      chapterTitle: "第七章",
      text: "另一段没有命中词的文字",
      comment: "建筑之美在于结构",
      createdAt: "1700000100",
      updatedAt: null,
    },
    {
      wereadBookId: "wb2",
      noteId: "wb2_1_1-2",
      type: "thought",
      chapterTitle: null,
      text: "想到旅行与建筑的关系",
      comment: "无关评论",
      createdAt: "1700000200",
      updatedAt: null,
    },
    {
      wereadBookId: "wb3",
      noteId: "wb3_1_1-2",
      type: "highlight",
      chapterTitle: null,
      text: "佛学与禅修",
      comment: null,
      createdAt: "1700000300",
      updatedAt: null,
    },
    {
      wereadBookId: "wb4",
      noteId: "wb4_1_1-2",
      type: "highlight",
      chapterTitle: null,
      text: "建筑 ARCHITECTURE 英文",
      comment: "ARCHITECTURE 评论",
      createdAt: "1700000400",
      updatedAt: null,
    },
  ]);
  writeFixture(tmpDir, "derived/latest/weread-matches.confirmed.json", [
    { wereadBookId: "wb1", catalogId: "13000000_000008232537" },
    { wereadBookId: "wb2", catalogId: "13000000_000008232538" },
    { wereadBookId: "wb3", catalogId: "13000000_000008232539" },
  ]);
  return loadPrivateNotesData(tmpDir);
}

describe("private-notes-search S27D", () => {
  let tmpDir = "";
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "weread-private-notes-search-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // 1. q filters by text
  it("q filters notes by text substring (Chinese)", () => {
    const data = searchFixture(tmpDir);
    const r = queryPrivateNotes(data, {
      type: "all", days: "all", matchedOnly: false, limit: 100, offset: 0, sort: "newest",
      q: "佛塔",
    } as WereadNotesQuery);
    expect(r.items.length).toBe(1);
    expect(r.items[0].text).toContain("建筑学");
    expect(r.searchInfo?.enabled).toBe(true);
    expect(r.searchInfo?.matchedCount).toBe(1);
  });

  // 2. q filters by comment
  it("q filters notes by comment substring when text misses", () => {
    const data = searchFixture(tmpDir);
    const r = queryPrivateNotes(data, {
      type: "all", days: "all", matchedOnly: false, limit: 100, offset: 0, sort: "newest",
      q: "结构",
    } as WereadNotesQuery);
    expect(r.items.length).toBe(1);
    expect(r.items[0].comment).toContain("结构");
  });

  // 3. multi-term OR
  it("q multi-term OR matches any term", () => {
    const data = searchFixture(tmpDir);
    const r = queryPrivateNotes(data, {
      type: "all", days: "all", matchedOnly: false, limit: 100, offset: 0, sort: "newest",
      q: "佛塔 禅修",
    } as WereadNotesQuery);
    const texts = r.items.map((i) => i.text);
    expect(texts.some((t) => t.includes("佛塔") || t.includes("禅修"))).toBe(true);
    // every returned item must mention at least one of the two terms
    for (const it of r.items) {
      const ok = (it.text.includes("佛塔") || it.text.includes("禅修")
        || (it.comment ?? "").includes("佛塔") || (it.comment ?? "").includes("禅修"));
      expect(ok).toBe(true);
    }
    expect(r.searchInfo?.termsCount).toBe(2);
  });

  // 4. case-insensitive
  it("q is case-insensitive (English)", () => {
    const data = searchFixture(tmpDir);
    const upper = queryPrivateNotes(data, {
      type: "all", days: "all", matchedOnly: false, limit: 100, offset: 0, sort: "newest",
      q: "ARCHITECTURE",
    } as WereadNotesQuery);
    const lower = queryPrivateNotes(data, {
      type: "all", days: "all", matchedOnly: false, limit: 100, offset: 0, sort: "newest",
      q: "architecture",
    } as WereadNotesQuery);
    expect(upper.items.length).toBe(1);
    expect(lower.items.length).toBe(1);
    expect(lower.items[0].text).toBe(upper.items[0].text);
  });

  // 5. q + type filter
  it("q composes with type filter", () => {
    const data = searchFixture(tmpDir);
    const r = queryPrivateNotes(data, {
      type: "thought", days: "all", matchedOnly: false, limit: 100, offset: 0, sort: "newest",
      q: "建筑",
    } as WereadNotesQuery);
    expect(r.items.length).toBe(1);
    expect(r.items[0].type).toBe("thought");
    expect(r.items[0].text).toContain("建筑");
  });

  // 6. q + matchedOnly
  it("q composes with matchedOnly filter", () => {
    const data = searchFixture(tmpDir);
    const r = queryPrivateNotes(data, {
      type: "all", days: "all", matchedOnly: true, limit: 100, offset: 0, sort: "newest",
      q: "佛塔",
    } as WereadNotesQuery);
    expect(r.items.length).toBe(1);
    expect(r.items[0].matched).toBe(true);
    expect(r.items[0].catalogId).toBe("13000000_000008232537");
  });

  // 7. normalize trims q and empty disables search
  it("normalizeNotesQuery trims q and drops empty", () => {
    const a = normalizeNotesQuery({ type: "all", days: "all", matchedOnly: false, limit: 10, offset: 0, sort: "newest", q: "   " });
    expect(a.q).toBeUndefined();
    const b = normalizeNotesQuery({ type: "all", days: "all", matchedOnly: false, limit: 10, offset: 0, sort: "newest", q: "  hello  " });
    expect(b.q).toBe("hello");
  });

  // 8. q > 100: route layer is gatekeeper; normalize is permissive
  it("q > 100 passes normalize (route layer enforces cap)", () => {
    const long = "x".repeat(101);
    const n = normalizeNotesQuery({ type: "all", days: "all", matchedOnly: false, limit: 10, offset: 0, sort: "newest", q: long });
    // normalize intentionally does not enforce the cap; the route layer does.
    expect(n.q?.length).toBe(101);
  });

  // 9. searchInfo does not contain raw query or terms
  it("searchInfo does not echo raw query or terms", () => {
    const data = searchFixture(tmpDir);
    const r = queryPrivateNotes(data, {
      type: "all", days: "all", matchedOnly: false, limit: 100, offset: 0, sort: "newest",
      q: "佛塔 禅修",
    } as WereadNotesQuery);
    // The privacy contract is specifically about searchInfo: it must not echo
    // the raw query or the per-term list. (Note bodies themselves legitimately
    // contain the matched terms — that's what matched them.)
    expect(r.searchInfo).toBeDefined();
    const searchInfoKeys = Object.keys(r.searchInfo ?? {}).sort();
    expect(searchInfoKeys).toEqual(["enabled", "matchedCount", "queryLength", "termsCount"]);
    // searchInfo must not contain any raw-q or per-term field.
    const siJson = JSON.stringify(r.searchInfo);
    expect(siJson).not.toContain("佛塔");
    expect(siJson).not.toContain("禅修");
    expect(siJson).not.toContain("ARCHITECTURE");
    expect(r.searchInfo?.queryLength).toBe("佛塔 禅修".length);
    expect(r.searchInfo?.termsCount).toBe(2);
    expect(r.searchInfo?.enabled).toBe(true);
    expect(r.searchInfo?.matchedCount).toBe(r.items.length);
  });

  // 10. response still excludes forbidden IDs even with q set
  it("response excludes wereadBookId/noteId/highlightId/chapterTitle/title/author when q set", () => {
    const data = searchFixture(tmpDir);
    const r = queryPrivateNotes(data, {
      type: "all", days: "all", matchedOnly: false, limit: 100, offset: 0, sort: "newest",
      q: "佛塔",
    } as WereadNotesQuery);
    const serialised = JSON.stringify(r);
    for (const k of FORBIDDEN_KEYS) {
      expect(serialised.includes(`"${k}"`)).toBe(false);
    }
    // Raw fixture internal IDs also must not leak
    expect(serialised).not.toContain("wb1_5_1003-2852");
    expect(serialised).not.toContain("第七章 私有章节标题");
  });

  // 11. no console logging of query/text
  it("queryPrivateNotes does not log query text or note text", () => {
    const data = searchFixture(tmpDir);
    const origLog = console.log;
    const origWarn = console.warn;
    const origError = console.error;
    const calls: string[] = [];
    console.log = (...args: unknown[]) => { calls.push(args.map(String).join(" ")); };
    console.warn = (...args: unknown[]) => { calls.push(args.map(String).join(" ")); };
    console.error = (...args: unknown[]) => { calls.push(args.map(String).join(" ")); };
    try {
      queryPrivateNotes(data, {
        type: "all", days: "all", matchedOnly: false, limit: 100, offset: 0, sort: "newest",
        q: "佛塔 禅修",
      } as WereadNotesQuery);
    } finally {
      console.log = origLog;
      console.warn = origWarn;
      console.error = origError;
    }
    const combined = calls.join("\n");
    expect(combined).not.toContain("佛塔");
    expect(combined).not.toContain("禅修");
    expect(combined).not.toContain("建筑学");
  });
});

