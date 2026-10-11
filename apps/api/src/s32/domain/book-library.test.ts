import { describe, expect, it } from "vitest";
import { LibraryError, libraryBookId, libraryUuid, readLibraryList, readLibraryNote, readLibraryProfile, readLibraryResource } from "./book-library.js";

describe("Book library input", () => {
  it("accepts 50,000-character Chinese content and normalizes line endings without trimming notes", () => {
    expect(readLibraryProfile({ introduction: "汉".repeat(50_000), baseVersion: 0 }).introduction).toHaveLength(50_000);
    expect(readLibraryNote({ title: " 标题 ", content: "  一\r\n二\r三  " })).toEqual({ title: "标题", content: "  一\n二\n三  " });
    expect(readLibraryProfile({})).toEqual({});
    expect(readLibraryProfile({ introduction: "" })).toEqual({ introduction: "", baseVersion: 0 });
  });
  it.each([
    null, [], { introduction: 12 }, { introduction: "x".repeat(50_001) },
    { introduction: "\0" }, { introduction: "\ud800" }, { introduction: "\udc00" },
    { introduction: "ok", baseVersion: -1 }, { introduction: "ok", baseVersion: "1" },
  ])("rejects invalid profile %j", input => { expect(() => readLibraryProfile(input)).toThrow(LibraryError); });
  it.each([
    { title: "", content: "text" }, { title: "  ", content: "text" },
    { title: "x".repeat(201), content: "text" }, { title: "title", content: " \n " },
    { title: "title", content: "x".repeat(50_001) },
  ])("rejects invalid note %j", input => { expect(() => readLibraryNote(input)).toThrow(LibraryError); });
  it("accepts registered http/https links without interpreting or retrieving the file", () => {
    expect(readLibraryResource({ label: "文字版", url: " https://example.test/book?key=1#p2 ", format: "未知格式", notes: "提取说明" })).toEqual({
      label: "文字版", url: "https://example.test/book?key=1#p2", format: "未知格式", versionLabel: "", notes: "提取说明",
    });
    expect(readLibraryResource({ label: "网页", url: "http://example.test" }).format).toBe("");
  });
  it.each(["javascript:alert(1)", "data:text/plain,x", "file:///tmp/a.pdf", "/relative.pdf", "ftp://example.test/a", "https://example.test/\na"])("rejects unsafe or malformed URL %s", url => {
    expect(() => readLibraryResource({ label: "资源", url })).toThrow(LibraryError);
  });
  it("limits resource metadata and parses deterministic pagination/filter values", () => {
    expect(() => readLibraryResource({ label: "资源", url: `https://example.test/${"x".repeat(4_000)}` })).toThrow(LibraryError);
    expect(() => readLibraryResource({ label: "资源", url: "https://example.test", notes: "x".repeat(4_001) })).toThrow(LibraryError);
    expect(readLibraryList({})).toEqual({ page: 1, limit: 24, q: "", filter: "all" });
    expect(readLibraryList({ page: "2", limit: "100", q: " 古道 ", filter: "notes" })).toEqual({ page: 2, limit: 100, q: "古道", filter: "notes" });
    for (const query of [{ page: "-1" }, { page: "1.5" }, { limit: "101" }, { limit: [] }, { q: [] }, { filter: "other" }]) expect(() => readLibraryList(query)).toThrow(LibraryError);
  });
  it("validates route identities without requiring catalog document IDs to be UUIDs", () => {
    expect(libraryBookId(" catalog-document-1 ")).toBe("catalog-document-1");
    expect(libraryUuid("AAAAAAAA-AAAA-4AAA-AAAA-AAAAAAAAAAAA")).toBe("aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa");
    for (const id of ["", " ", "x".repeat(501), "\0"]) expect(() => libraryBookId(id)).toThrow(LibraryError);
    expect(() => libraryUuid("foreign-note")).toThrow(LibraryError);
  });
});
