import { describe, expect, it } from "vitest";
import { readBindingId, readCatalogBookId } from "./project-item.js";

describe("M1-C identifiers", () => {
  it("trims a non-empty catalog book id", () => {
    expect(readCatalogBookId(" 13000000 ")).toBe("13000000");
  });
  it.each([undefined, null, "", "   ", 42, []])("rejects invalid book id %j", value => {
    expect(() => readCatalogBookId(value)).toThrow("bookId");
  });
  it("accepts UUID binding IDs", () => {
    expect(readBindingId("01234567-1234-4123-8123-123456789abc")).toBe("01234567-1234-4123-8123-123456789abc");
  });
  it.each([undefined, null, 42, "", "x' OR 1=1"])('rejects invalid binding %j', value => {
    expect(() => readBindingId(value)).toThrow("binding");
  });
});
