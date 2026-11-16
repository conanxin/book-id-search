import { describe, expect, it } from "vitest";
import { deriveBookWebSourceClues } from "./book-web-source-clues.js";

const target = "9787112124534", other = "9787515318561";
const book = { title: "梁思成", author: "林洙著；杨永生主编", isbn: target };
const clues = (excerpt: string, isbn = target, title = "") =>
  deriveBookWebSourceClues({ ...book, isbn }, { title, excerpt });

describe("literal book clues from visible source text", () => {
  it.each([
    ["ISBN 978-7-112-12453-4", "matched"],
    ["目录号 9787112124534。", "matched"],
    ["ISBN 9787112124534；ISBN 9787515318561", "mixed"],
    ["ISBN 9787515318561", "other_only"],
    ["这篇文章未提供 ISBN。", "not_seen"],
  ] as const)("distinguishes visible ISBN text: %s", (excerpt, isbn) => {
    expect(clues(excerpt)).toEqual({ isbn, text: [] });
  });

  it("normalizes labelled catalog values, full-width text, hyphens, whitespace and X case", () => {
    for (const catalogIsbn of [target, "ISBN: 978-7-112-12453-4", "ＩＳＢＮ－１３：９７８－７－１１２－１２４５３－４"]) {
      expect(clues("ＩＳＢＮ：９７８‐７‐１１２‐１２４５３‐４", catalogIsbn).isbn).toBe("matched");
    }
    expect(clues("ISBN-10: 0 8044 2957 X", "isbn-10: 0-8044-2957-x").isbn).toBe("matched");
  });

  it("deduplicates repeated target text and does not join runs across a processed label", () => {
    expect(clues(`${target}；ISBN ${target}`, target, `ISBN-13: ${target}`).isbn).toBe("matched");
    expect(clues(`${target} ISBN ${other}；9791234567890`).isbn).toBe("mixed");
  });

  it("does not validate checksums or convert ISBN-10 and ISBN-13", () => {
    expect(clues("ISBN 9787112124530", "9787112124530").isbn).toBe("matched");
    expect(clues("ISBN 7112124530").isbn).toBe("other_only");
    expect(clues(`ISBN ${target}`, "7112124530").isbn).toBe("other_only");
  });

  it("requires an immediate label for ten digits and does not inherit it across a list", () => {
    expect(clues("SSID 13078447，DXID 000008311397，7112124530").isbn).toBe("not_seen");
    expect(clues("ISBN: 7112124530", "7112124530").isbn).toBe("matched");
    expect(clues(`ISBN ${target},7112124530`).isbn).toBe("matched");
    expect(clues(`ISBN ${target},${other}`).isbn).toBe("mixed");
  });

  it("honors explicit ISBN-10/13 lengths without a bare-number bypass", () => {
    expect(clues("ISBN-13: 7112124530", "7112124530").isbn).toBe("not_seen");
    expect(clues(`ISBN-10: ${target}`).isbn).toBe("not_seen");
    expect(clues(`ISBN ${target}`, "ISBN-13: 7112124530").isbn).toBe("unavailable");
    expect(clues(`ISBN ${target}`, `ISBN-10: ${target}`).isbn).toBe("unavailable");
  });

  it("never extracts an ISBN substring from a longer numeric or Latin identifier", () => {
    for (const text of [
      `1${target}`, `${target}0`, `1 ${target}`, `${target}-0`,
      `A${target}`, `${target}A`, `_${target}`, `${target}_`,
      `ISBN 1${target}`, `ISBN ${target}0`, `ISBN ${target}A`,
      `١${target}`, `${target}١`, `١ ${target}`, `${target}-١`, `ISBN-13: ${target}١`,
    ]) {
      expect(clues(text).isbn, text).toBe("not_seen");
    }
    expect(clues(`ISBN${target}`).isbn).toBe("matched");
  });

  it("requires exactly one recognizable catalog value without extracting arbitrary text", () => {
    for (const isbn of ["", " ", "test-isbn", "978123", `旧版 ${target}`, `ISBN ${target}（精装）`,
      `${target};${other}`, `${target} ${other}`, `${target},${target}`]) {
      expect(clues(`ISBN ${target}`, isbn).isbn, isbn).toBe("unavailable");
    }
  });

  it("does not concatenate title and excerpt to create ISBN, title or author clues", () => {
    expect(clues("124534", target, "ISBN 9787112").isbn).toBe("not_seen");
    expect(deriveBookWebSourceClues(book, { title: "梁思", excerpt: "成 林洙著；杨永生主" }).text).toEqual([]);
    expect(deriveBookWebSourceClues(book, { title: "林洙著；", excerpt: "杨永生主编" }).text).toEqual([]);
  });

  it("reports a person-name occurrence in a different book only as literal title text", () => {
    expect(clues(`《大拙至美：梁思成最美的文字建筑》书评，ISBN ${other}`))
      .toEqual({ isbn: "other_only", text: ["title"] });
  });

  it("keeps the full author field and fixed title/author order without inferring roles", () => {
    expect(clues("梁思成，林洙，杨永生")).toEqual({ isbn: "not_seen", text: ["title"] });
    expect(clues("林洙著；杨永生主编，梁思成，梁思成")).toEqual({ isbn: "not_seen", text: ["title", "author"] });
    expect(deriveBookWebSourceClues({ title: " ", author: "", isbn: target }, { title: "anything", excerpt: "anything" }).text).toEqual([]);
  });

  it("normalizes complete text and respects Latin word boundaries", () => {
    const latin = { title: "It", author: "John Doe", isbn: target };
    expect(deriveBookWebSourceClues(latin, { title: "（ＩＴ）", excerpt: "Ｊｏｈｎ　 \n Ｄｏｅ" }).text).toEqual(["title", "author"]);
    for (const text of ["within", "items", "wit", "IT_edition", "7It", "ÉIt"]) {
      expect(deriveBookWebSourceClues(latin, { title: text, excerpt: "John Doer" }).text, text).toEqual([]);
    }
    expect(deriveBookWebSourceClues({ ...latin, author: "John" }, { title: "", excerpt: "JohnDoe" }).text).toEqual([]);
  });

  it("does not certify a candidate at a truncated field end without changing visible text", () => {
    const source = { title: "ordinary title", excerpt: `ISBN ${target}` };
    expect(deriveBookWebSourceClues(book, source).isbn).toBe("matched");
    expect(deriveBookWebSourceClues(book, source, { excerpt: true }).isbn).toBe("not_seen");
    expect(deriveBookWebSourceClues(book, { ...source, excerpt: `ISBN ${target} - ` }, { excerpt: true }).isbn).toBe("not_seen");
    expect(deriveBookWebSourceClues(book, { ...source, excerpt: `ISBN ${target}；后文` }, { excerpt: true }).isbn).toBe("matched");
    expect(deriveBookWebSourceClues(book, { title: target, excerpt: "other text" }, { title: true }).isbn).toBe("not_seen");
    expect(deriveBookWebSourceClues(book, source, { title: true }).isbn).toBe("matched");
    const latin = { ...book, title: "It", author: "John Doe" };
    expect(deriveBookWebSourceClues(latin, { title: "It", excerpt: "John Doe" }, { title: true, excerpt: true }).text).toEqual([]);
  });

  it("checks non-CJK word boundaries by Unicode code point while keeping CJK literal matches", () => {
    const cyrillic = { ...book, author: "Иван" };
    expect(deriveBookWebSourceClues(cyrillic, { title: "", excerpt: "Иванов" }).text).toEqual([]);
    expect(deriveBookWebSourceClues(cyrillic, { title: "", excerpt: "（Иван）" }).text).toEqual(["author"]);
    const astral = { ...book, title: "It", author: "𐐀" };
    expect(deriveBookWebSourceClues(astral, { title: "𐐀It", excerpt: "𐐀𐐁" }).text).toEqual([]);
    expect(deriveBookWebSourceClues(astral, { title: "It𐐀", excerpt: "𐐁𐐀" }).text).toEqual([]);
    expect(deriveBookWebSourceClues(astral, { title: "It", excerpt: "（𐐀）" }).text).toEqual(["title", "author"]);
    expect(deriveBookWebSourceClues({ ...book, author: "林洙" }, { title: "中国建筑名师：梁思成", excerpt: "作者林洙著" }).text)
      .toEqual(["title", "author"]);
  });
});
