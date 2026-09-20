import { describe, expect, it } from "vitest";
import { InvalidNoteInputError, normalizeNoteContent, readRevisionId, sha256NoteContent } from "./note.js";

describe("note content", () => {
  it("normalizes CRLF and bare CR without trimming user whitespace", () => {
    expect(normalizeNoteContent("  第一行\r\n第二行\r第三行  \n")).toBe("  第一行\n第二行\n第三行  \n");
  });
  it("rejects NUL content as invalid input before it can be hashed or stored", () => {
    expect(() => normalizeNoteContent("text\u0000more")).toThrow(InvalidNoteInputError);
  });
  it.each([undefined, null, "", " \r\n \t ", 7, [], {}])("rejects blank or non-string %j", value => {
    expect(() => normalizeNoteContent(value)).toThrow("content");
  });
  it("accepts exactly 65536 ASCII bytes and rejects 65537", () => {
    expect(normalizeNoteContent("a".repeat(65536))).toHaveLength(65536);
    expect(() => normalizeNoteContent("a".repeat(65537))).toThrow("65536");
  });
  it("counts multibyte UTF-8 bytes rather than characters", () => {
    expect(normalizeNoteContent("汉".repeat(21845) + "a")).toBe("汉".repeat(21845) + "a");
    expect(normalizeNoteContent("😀".repeat(16384))).toBe("😀".repeat(16384));
    expect(() => normalizeNoteContent("汉".repeat(21846))).toThrow("65536");
    expect(() => normalizeNoteContent("😀".repeat(16384) + "a")).toThrow("65536");
  });
  it("measures normalized bytes, not the larger CRLF input", () => {
    expect(normalizeNoteContent("a\r\n".repeat(32768))).toBe("a\n".repeat(32768));
  });
  it("hashes the exact normalized content as deterministic lowercase SHA256", () => {
    expect(sha256NoteContent("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256NoteContent(normalizeNoteContent("a\r\nb\rc"))).toBe(sha256NoteContent("a\nb\nc"));
    expect(sha256NoteContent(" a ")).not.toBe(sha256NoteContent("a"));
    expect(sha256NoteContent("研究\n  ")).toMatch(/^[0-9a-f]{64}$/);
  });
  it("canonicalizes equivalent UUID case", () => {
    expect(readRevisionId("01234567-ABCD-4123-8123-123456789ABC")).toBe("01234567-abcd-4123-8123-123456789abc");
  });
  it.each([undefined, null, "not-a-uuid", "' OR true;--", " 01234567-1234-4123-8123-123456789abc", []])("rejects forged revision %j", value => {
    expect(() => readRevisionId(value)).toThrow("revision");
  });
});
