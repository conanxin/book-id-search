import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import {
  BOOK_WEB_SOURCE_EVIDENCE_LIMITS as LIMITS, BookWebSourceEvidenceError, type BookWebSourcePassage,
} from "./book-web-source-evidence-contract.js";
import { splitBookWebSourcePassages } from "./book-web-source-evidence.js";
import { splitBookWebSourceComparisonPassages } from "./book-web-source-comparison-passages.js";

function expectCoverage(text: string, passages = splitBookWebSourceComparisonPassages(text)): BookWebSourcePassage[] {
  expect(passages.length).toBeGreaterThan(0);
  expect(passages.length).toBeLessThanOrEqual(LIMITS.PASSAGES);
  expect(passages[0].start).toBe(0);
  expect(passages.at(-1)!.end).toBe(text.length);
  expect(passages.map(passage => passage.text).join("")).toBe(text);
  passages.forEach((passage, index) => {
    expect(passage.id).toBe("P" + (index + 1));
    expect(passage.start).toBe(index ? passages[index - 1].end : 0);
    expect(passage.end).toBeGreaterThan(passage.start);
    expect(passage.text).toBe(text.slice(passage.start, passage.end));
    expect(passage.text.length).toBe(passage.end - passage.start);
    expect(passage.text.length).toBeLessThanOrEqual(LIMITS.PASSAGE_CHARS);
    expect(passage.text).not.toMatch(/[\ud800-\udbff]$/);
    expect(passage.text).not.toMatch(/^[\udc00-\udfff]/);
  });
  return passages;
}

describe("comparison-only paragraph candidates preserve the complete source", () => {
  it("keeps short prose separate from adjacent metadata without changing single-source splitting", () => {
    const paragraphs = ["技术工作涉及协作和反复试验。\n\n", "行业环境不断变化，需要持续调整。\n\n", "其它图书\n\n", "另一书名\n\n", "售价 20 元"];
    const text = paragraphs.join("");
    expect(expectCoverage(text).map(passage => passage.text)).toEqual(paragraphs);
    expect(splitBookWebSourcePassages(text)).toEqual([{ id: "P1", start: 0, end: text.length, text }]);
  });

  it("preserves LF/CRLF blank lines and all leading, internal and trailing whitespace", () => {
    const paragraphs = [" \r\n\r\n  第一段😀。 \r\n \t\r\n", "第二段。\n\n\n", "尾段。\t \r\n"];
    expect(expectCoverage(paragraphs.join("")).map(passage => passage.text)).toEqual(paragraphs);
  });

  it.each([1, 63, 64])("does not merge %i natural paragraphs while they fit the candidate budget", count => {
    const paragraphs = Array.from({ length: count }, (_, index) => "段落 " + index + "\n\n");
    expect(expectCoverage(paragraphs.join("")).map(passage => passage.text)).toEqual(paragraphs);
  });

  it("keeps substantive paragraphs separate when 68 blocks need only four short adjacent merges", () => {
    const before = Array.from({ length: 39 }, (_, index) => "字段 " + index + "\n\n");
    const prose = [
      "这段正文描述工程师在团队中协作完成技术工作的过程。".repeat(8) + "\n\n",
      "这段正文补充对技术工作的现场观察。".repeat(4) + "\n\n",
      "行业环境要求公司持续适应变化，并反复检验新技术。".repeat(10) + "\n\n",
      "这段正文保留作者对上述描述的限定。".repeat(5) + "\n\n",
    ];
    const after = Array.from({ length: 25 }, (_, index) => "条目 " + index + "\n\n");
    const text = [...before, ...prose, ...after].join("");
    const passages = expectCoverage(text);
    expect(passages).toHaveLength(64);
    for (const paragraph of prose) {
      const start = text.indexOf(paragraph);
      expect(passages).toContainEqual({ id: expect.any(String), start, end: start + paragraph.length, text: paragraph });
    }
  });

  it("ignores obsolete heap pairs whose surviving right node has grown", () => {
    const sizes = [6, 3, 3, 4, 5, ...Array<number>(61).fill(100)];
    const text = sizes.map((size, index) => String.fromCharCode(65 + index % 26).repeat(size - 2) + "\n\n").join("");
    const passages = expectCoverage(text);
    expect(passages).toHaveLength(64);
    // B+C first; stale A+B still names live neighbours but no longer has its old size.
    // The next shortest valid merge is D+E, not A+(B+C).
    expect(passages.slice(0, 3).map(({ start, end }) => [start, end])).toEqual([[0, 6], [6, 12], [12, 21]]);
  });

  it("breaks equal-length merge ties by original position and skips removed neighbours", () => {
    const text = "x\n\n".repeat(66);
    const passages = expectCoverage(text);
    expect(passages).toHaveLength(64);
    expect(passages.slice(0, 3).map(({ start, end }) => [start, end])).toEqual([[0, 6], [6, 12], [12, 15]]);
    expect(splitBookWebSourceComparisonPassages(text)).toEqual(passages);
  });

  it("merges near the maximum source size without crossing the 1,200-unit passage limit", () => {
    const text = ("字".repeat(448) + "\n\n").repeat(66);
    expect(text).toHaveLength(29_700);
    const passages = expectCoverage(text);
    expect(passages).toHaveLength(64);
    expect(passages.slice(0, 2).map(passage => passage.text.length)).toEqual([900, 900]);
  });

  it("uses existing sentence boundaries inside a long natural paragraph with original offsets", () => {
    const prefix = "题名\n\n", paragraph = "甲".repeat(800) + "。”\n" + "乙".repeat(1600);
    const text = prefix + paragraph + "\n\n页尾";
    const passages = expectCoverage(text);
    expect(passages[0].text).toBe(prefix);
    expect(passages[1].start).toBe(prefix.length);
    expect(passages[1].end).toBe(prefix.length + 803);
    expect(passages.at(-1)!.text).toBe("页尾");
  });

  it.each([1198, 1199, 1200])("keeps surrogate pairs intact near a long-paragraph boundary at %i", offset => {
    const prefix = "标题😀\n\n";
    const text = prefix + "甲".repeat(offset) + "😀" + "乙".repeat(1800) + "\n\n尾段😀";
    const passages = expectCoverage(text);
    expect(passages[0].text).toBe(prefix);
    if (offset === 1199) {
      expect(passages[1].end).toBe(prefix.length + 1199);
      expect(passages[2].text.startsWith("😀")).toBe(true);
    }
  });

  it("covers a full 30,000-unit paragraph including the final marker", () => {
    const text = "字".repeat(29_990) + "TAIL_CHECK";
    const passages = expectCoverage(text);
    expect(passages.at(-1)!.text).toContain("TAIL_CHECK");
    expect(passages).toEqual(splitBookWebSourcePassages(text));
  });

  it("retains a whitespace-only final slice when exact coverage needs one", () => {
    const text = "字".repeat(1199) + "\n\n \t ";
    expectCoverage(text);
  });

  it.each(["", " \n\t ", "字".repeat(30_001), "\ud800", "A\udc00"])("rejects malformed or oversized source text %#", text => {
    expect(() => splitBookWebSourceComparisonPassages(text)).toThrow(new BookWebSourceEvidenceError("BOOK_EVIDENCE_INVALID_OUTPUT"));
  });

  it.each([
    { label: "10,000 tiny paragraphs", text: "x\n\n".repeat(10_000) },
    { label: "7,500 emoji paragraphs", text: "😀\n\n".repeat(7_500) },
  ])("bounds heap work for $label at the 30,000-unit limit", ({ label, text }) => {
    expect(text).toHaveLength(30_000);
    const started = performance.now();
    const passages = splitBookWebSourceComparisonPassages(text);
    const elapsed = performance.now() - started;
    expectCoverage(text, passages);
    expect(passages).toHaveLength(64);
    expect(elapsed).toBeLessThan(2000);
    console.info(JSON.stringify({ comparisonPassageStress: label, characters: text.length, candidates: passages.length,
      elapsed_ms: Number(elapsed.toFixed(3)) }));
  });
});
