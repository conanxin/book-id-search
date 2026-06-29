import { describe, expect, it } from "vitest";
import { parseBookLine } from "./parse-line.ts";

describe("parseBookLine", () => {
  it("parses a normal comma-delimited record", () => {
    const book = parseBookLine("13509536,000030003051,我又回来了,（法）德比纳著；武娟译,南昌：二十一世纪出版社,2013,30,7539177470", { lineNumber: 1 });
    expect(book.id).toBe("13509536_000030003051");
    expect(book.title).toBe("我又回来了");
    expect(book.year).toBe(2013);
    expect(book.pages).toBe(30);
    expect(book.parseStatus).toBe("ok");
  });

  it("parses tab-delimited records", () => {
    const book = parseBookLine("1\t2\t标题\t作者\t北京：出版社\t2020\t123\t9780000000000", { lineNumber: 2 });
    expect(book.title).toBe("标题");
    expect(book.publisher).toBe("北京：出版社");
    expect(book.parseStatus).toBe("weak");
    expect(book.parseWarnings).toContain("tab_delimited");
  });

  it("keeps raw info and tolerates a missing isbn", () => {
    const raw = "1,2,标题,作者,北京：出版社,2020,123,";
    const book = parseBookLine(raw, { lineNumber: 3 });
    expect(book.rawInfo).toBe(raw);
    expect(book.isbn).toBe("");
    expect(book.parseWarnings).toContain("missing_isbn");
  });

  it("marks non-numeric year and pages as weak", () => {
    const book = parseBookLine("1,2,标题,作者,北京：出版社,二零二零,abc,9780000000000", { lineNumber: 4 });
    expect(book.year).toBeNull();
    expect(book.pages).toBeNull();
    expect(book.parseStatus).toBe("weak");
    expect(book.parseWarnings.some((warning) => warning.startsWith("year_non_numeric"))).toBe(true);
    expect(book.parseWarnings.some((warning) => warning.startsWith("pages_non_numeric"))).toBe(true);
  });

  it("uses a fallback id when ssid or dxid is missing", () => {
    const book = parseBookLine(",2,标题,作者,北京：出版社,2020,123,9780000000000", { lineNumber: 5 });
    expect(book.id).toBe("line_5");
    expect(book.parseWarnings).toContain("missing_ssid");
  });

  it("does not throw on malformed lines", () => {
    const book = parseBookLine("坏行", { lineNumber: 6 });
    expect(book.id).toBe("line_6");
    expect(book.parseStatus).toBe("failed");
    expect(book.rawInfo).toBe("坏行");
  });

  it("handles extra comma fields by preserving the tail columns", () => {
    const book = parseBookLine("1,2,带,逗号的标题,作者,北京：出版社,2020,123,9780000000000", { lineNumber: 7 });
    expect(book.publisher).toBe("北京：出版社");
    expect(book.year).toBe(2020);
    expect(book.pages).toBe(123);
    expect(book.parseStatus).toBe("weak");
  });

  it("keeps a quote inside an unquoted field as plain text", () => {
    const book = parseBookLine("13119151,000007871390,中华纵横获奖作品选,“中华纵横\"编委会编,北京：中国文史出版社,2004,672,750341510X", {
      lineNumber: 94681
    });
    expect(book.author).toBe("“中华纵横\"编委会编");
    expect(book.publisher).toBe("北京：中国文史出版社");
    expect(book.year).toBe(2004);
    expect(book.pages).toBe(672);
    expect(book.isbn).toBe("750341510X");
    expect(book.parseStatus).toBe("ok");
  });
});
