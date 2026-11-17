import { describe, expect, it } from "vitest";
import { deriveBookWebSourceTextContexts, type BookWebSourceTextContexts } from "./book-web-source-text-context.js";

const unpaired = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
function exact(source: { title: string; excerpt: string }, result: BookWebSourceTextContexts) {
  expect(result.items.length).toBeLessThanOrEqual(8);
  for (const kind of ["quoted_title", "edition_text"]) {
    expect(result.items.filter(item => item.kind === kind).length).toBeLessThanOrEqual(4);
  }
  for (const item of result.items) {
    const raw = source[item.field];
    expect(item.value).toBe(raw.slice(item.matchStart, item.matchEnd));
    expect(item.text).toBe(raw.slice(item.start, item.end));
    expect(item.start).toBeGreaterThanOrEqual(0);
    expect(item.start).toBeLessThanOrEqual(item.matchStart);
    expect(item.matchStart).toBeLessThan(item.matchEnd);
    expect(item.matchEnd).toBeLessThanOrEqual(item.end);
    expect(item.end).toBeLessThanOrEqual(raw.length);
    expect(item.text.length).toBeLessThanOrEqual(400);
    expect(unpaired.test(item.text)).toBe(false);
  }
}

describe("literal title and edition contexts", () => {
  it("returns literal forms and exact context coordinates in field/occurrence order", () => {
    const source = { title: "《甲书》资料", excerpt: "2012年某出版社《乙书》；修订版，具体版本关系尚未核实。" };
    const result = deriveBookWebSourceTextContexts(source);
    expect(result.limited).toBe(false);
    expect(result.items.map(({ kind, field, value }) => ({ kind, field, value }))).toEqual([
      { kind: "quoted_title", field: "title", value: "《甲书》" },
      { kind: "quoted_title", field: "excerpt", value: "《乙书》" },
      { kind: "edition_text", field: "excerpt", value: "修订版" },
      { kind: "edition_text", field: "excerpt", value: "版本" },
    ]);
    exact(source, result);
  });

  it("does not produce a year, ISBN, author match, identity or semantic classification", () => {
    expect(deriveBookWebSourceTextContexts({ title: "梁思成", excerpt: "林洙著；2012年 ISBN 9787112124534 研究 书评" }))
      .toEqual({ items: [], limited: false });
  });

  it.each(["《未闭合", "未开始》", "《》", "《 \t　》", "《跨\n行》", "《跨\r行》", "《跨\u0085行》", "《跨\u2028行》"])(
    "skips incomplete, blank or multiline quoted forms: %s", excerpt => {
      expect(deriveBookWebSourceTextContexts({ title: "", excerpt })).toEqual({ items: [], limited: false });
    });

  it("skips the whole nested form without rescuing its inner pairs", () => {
    const source = { title: "", excerpt: "《外《内》外》；《后续完整题名》" };
    const result = deriveBookWebSourceTextContexts(source);
    expect(result.items.map(item => item.value)).toEqual(["《后续完整题名》"]);
    exact(source, result);
    expect(deriveBookWebSourceTextContexts({ title: "", excerpt: "《外《内》未闭合" }).items).toEqual([]);
  });

  it("never joins fields to finish a title or version marker", () => {
    expect(deriveBookWebSourceTextContexts({ title: "《前半", excerpt: "后半》" }).items).toEqual([]);
    expect(deriveBookWebSourceTextContexts({ title: "第", excerpt: "２版" }).items).toEqual([]);
  });

  it("keeps repeated identical forms as distinct positions even when contexts are identical", () => {
    const source = { title: "", excerpt: "《甲》《甲》" };
    const result = deriveBookWebSourceTextContexts(source);
    expect(result.items.map(item => [item.value, item.matchStart, item.matchEnd])).toEqual([
      ["《甲》", 0, 3], ["《甲》", 3, 6],
    ]);
    expect(result.items[0].text).toBe(result.items[1].text);
    exact(source, result);
  });

  it("preserves full-width, traditional, emoji and HTML-like text without normalization or markup", () => {
    const source = { title: "《Ａ　Ｂ》", excerpt: "《繁體😀<img src=x>》 修訂版" };
    const result = deriveBookWebSourceTextContexts(source);
    expect(result.items.map(item => item.value)).toEqual(["《Ａ　Ｂ》", "《繁體😀<img src=x>》", "修訂版"]);
    exact(source, result);
  });

  it.each(["第1版", "第１２版", "第 二 版", "第兩版", "初版", "再版", "重版", "修订版", "修訂版", "增订版", "增訂版", "版本", "版次"])(
    "recognizes an explicit edition text literally: %s", value => {
      const source = { title: "", excerpt: "原文：" + value + "，没有归并版本。" };
      const result = deriveBookWebSourceTextContexts(source);
      expect(result.items[0]).toMatchObject({ kind: "edition_text", value, matchStart: 3, matchEnd: 3 + value.length });
      exact(source, result);
    });

  it("allows a version marker inside a quoted form without treating them as alternative claims", () => {
    const source = { title: "", excerpt: "《第2版手册》" };
    const result = deriveBookWebSourceTextContexts(source);
    expect(result.items.map(item => [item.kind, item.value, item.matchStart])).toEqual([
      ["quoted_title", "《第2版手册》", 0], ["edition_text", "第2版", 1],
    ]);
    exact(source, result);
  });

  it("caps each kind across both fields and exposes omission without altering source text", () => {
    const source = { title: "《甲》《乙》初版再版", excerpt: "《丙》《丁》《戊》修订版第２版版本" };
    const before = structuredClone(source), result = deriveBookWebSourceTextContexts(source);
    expect(result.limited).toBe(true);
    expect(result.items.map(item => item.value)).toEqual(["《甲》", "《乙》", "初版", "再版", "《丙》", "《丁》", "修订版", "第２版"]);
    expect(source).toEqual(before);
    exact(source, result);
  });

  it("skips oversized whole forms rather than clipping their value into a different title", () => {
    const accepted = "《" + "甲".repeat(118) + "》", oversized = "《" + "乙".repeat(119) + "》";
    const source = { title: "", excerpt: oversized + accepted + "第" + "1".repeat(40) + "版" };
    const result = deriveBookWebSourceTextContexts(source);
    expect(result.limited).toBe(true);
    expect(result.items.map(item => item.value)).toEqual([accepted]);
    exact(source, result);
  });

  it("keeps a closed title but omits an uncertain version marker at a known truncated field end", () => {
    const source = { title: "再版", excerpt: "《完整题名》修订版" };
    const result = deriveBookWebSourceTextContexts(source, { excerpt: true });
    expect(result.items.map(item => [item.field, item.value])).toEqual([["title", "再版"], ["excerpt", "《完整题名》"]]);
    expect(result.limited).toBe(true);
    expect(deriveBookWebSourceTextContexts({ title: "", excerpt: "《完整题名》" }, { excerpt: true }).limited).toBe(false);
    exact(source, result);
  });

  it("uses bounded original windows without cutting surrogate pairs at either edge", () => {
    const excerpts = [
      "前".repeat(139) + "😀" + "中".repeat(119) + "《甲》" + "后".repeat(500),
      "前".repeat(260) + "《甲》" + "中".repeat(276) + "😀" + "后".repeat(500),
    ];
    for (const excerpt of excerpts) {
      const source = { title: "", excerpt }, result = deriveBookWebSourceTextContexts(source);
      expect(result.items).toHaveLength(1);
      expect(result.items[0].text.length).toBeLessThanOrEqual(400);
      exact(source, result);
    }
  });
});
