import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Book } from "./api";
import {
  EDITION_COMPARE_MAX,
  EditionComparePanel,
  toggleEditionCompareSelection,
} from "./EditionCompare";

function makeBook(
  id: string,
  overrides: Partial<Book> = {}
): Book {
  return {
    id,
    ssid: `ssid-${id}`,
    dxid: `dxid-${id}`,
    title: "围城",
    author: "钱钟书",
    publisher: "漓江出版社",
    year: 1997,
    pages: 359,
    isbn: `isbn-${id}`,
    rawInfo: "",
    parseStatus: "ok",
    parseWarnings: [],
    ...overrides,
  };
}

describe("toggleEditionCompareSelection", () => {
  it("adds and removes the same book by id", () => {
    const a = makeBook("a");

    const added = toggleEditionCompareSelection([], a);
    expect(added.items.map((book) => book.id)).toEqual(["a"]);
    expect(added.limitReached).toBe(false);

    const removed = toggleEditionCompareSelection(added.items, a);
    expect(removed.items).toEqual([]);
  });

  it("caps comparison at four books", () => {
    const selected = Array.from(
      { length: EDITION_COMPARE_MAX },
      (_, i) => makeBook(String(i))
    );

    const result = toggleEditionCompareSelection(
      selected,
      makeBook("overflow")
    );

    expect(result.items).toHaveLength(EDITION_COMPARE_MAX);
    expect(result.items.map((book) => book.id)).not.toContain("overflow");
    expect(result.limitReached).toBe(true);
  });
});

describe("EditionComparePanel", () => {
  it("renders nothing with fewer than two books", () => {
    const html = renderToStaticMarkup(
      <EditionComparePanel books={[makeBook("a")]} />
    );

    expect(html).toBe("");
  });

  it("renders bibliographic differences", () => {
    const html = renderToStaticMarkup(
      <EditionComparePanel
        books={[
          makeBook("a"),
          makeBook("b", {
            publisher: "人民文学出版社",
            year: 2000,
            isbn: "702003246X",
            parseStatus: "weak",
          }),
        ]}
      />
    );

    expect(html).toContain("版本对比");
    expect(html).toContain("漓江出版社");
    expect(html).toContain("人民文学出版社");
    expect(html).toContain("1997");
    expect(html).toContain("2000");
    expect(html).toContain("ISBN");
    expect(html).toContain("SSID");
    expect(html).toContain("DXID");
    expect(html).toContain("正常");
    expect(html).toContain("弱解析");
  });

  it("renders missing values as dash", () => {
    const html = renderToStaticMarkup(
      <EditionComparePanel
        books={[
          makeBook("a"),
          makeBook("b", {
            publisher: "",
            year: null,
            pages: null,
            isbn: "",
          }),
        ]}
      />
    );

    expect(html).toContain("—");
  });
});
