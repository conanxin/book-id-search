import { describe, expect, it } from "vitest";
import { assessBookReviewCandidate as assess } from "./book-web-review-candidate.js";

const book = { title: "置身事内：中国政府与经济发展", author: "兰小欢著；其他人主编", isbn: "9787208171336" };
const source = { title: "读《置身事内》：书评", excerpt: "兰小欢的这部作品值得讨论。" };

describe("work, document cues and edition text remain separate", () => {
  it("accepts explicit main-title compatibility plus the author responsibility segment", () => {
    expect(assess(source, book)).toEqual({
      work: { titleForm: "main_title", authorTextSeen: true, multipleQuotedTitles: false },
      genre: { reviewTextSeen: true, nonReviewTextSeen: false },
      edition: { isbnText: "not_seen" }, eligible: true,
    });
  });
  it("does not treat the editor or translator as the author", () => {
    expect(assess({ ...source, excerpt: "其他人的作品。" }, book).eligible).toBe(false);
    expect(assess({ ...source, excerpt: "译者的作品。" }, { ...book, author: "兰小欢著；译者译" }).eligible).toBe(false);
  });
  it("does not equate different quoted full subtitles or different main titles", () => {
    expect(assess({ ...source, title: "《置身事内：另一部书》书评" }, book).eligible).toBe(false);
    expect(assess({ ...source, title: "《置身事外》书评" }, book).eligible).toBe(false);
  });
  it("requires an author when only the main title is compatible", () => {
    expect(assess({ ...source, excerpt: "ISBN:9787208171336。" }, book).eligible).toBe(false);
  });
  it("does not promote an ISBN in a different work's review", () => {
    const result = assess({ title: "《其他作品》书评", excerpt: "兰小欢。ISBN:9787208171336。" }, book);
    expect(result.edition.isbnText).toBe("matched");
    expect(result.work.titleForm).toBe("not_seen");
    expect(result.eligible).toBe(false);
  });
  it.each([
    ["target", "ISBN:9787208171336。", "matched"],
    ["mixed", "ISBN:9787208171336。ISBN:9787112124534。", "mixed"],
    ["other", "ISBN:9787112124534。", "other_only"],
    ["absent", "", "not_seen"],
  ])("keeps %s ISBN text distinct from a work candidate", (_name, isbn, expected) => {
    const result = assess({ ...source, excerpt: source.excerpt + isbn }, book);
    expect(result.eligible).toBe(true);
    expect(result.edition.isbnText).toBe(expected);
  });
  it("does not claim an edition when the catalog ISBN is unavailable", () => {
    const result = assess(source, { ...book, isbn: "" });
    expect(result.eligible).toBe(true);
    expect(result.edition.isbnText).toBe("unavailable");
  });
  it.each([
    ["《置身事内》书评目录与购买信息", "兰小欢 ISBN:9787208171336。"],
    ["访谈：关于《置身事内》的书评与写作", "兰小欢回答问题。"],
    ["《置身事内》书评", "兰小欢。加入购物车。"],
    ["《置身事内》书评", "兰小欢。不是第三方书评。"],
    ["《置身事内》《其他作品》书评", "兰小欢。"],
  ])("retains ambiguous/nonreview text for manual checking: %s", (title, excerpt) => {
    expect(assess({ title, excerpt }, book).eligible).toBe(false);
  });
  it("requires visible review cues rather than inferring genre from title/author/ISBN", () => {
    const result = assess({ title: "《置身事内》", excerpt: "兰小欢 ISBN:9787208171336。" }, book);
    expect(result.work.authorTextSeen).toBe(true);
    expect(result.genre.reviewTextSeen).toBe(false);
    expect(result.eligible).toBe(false);
  });
  it("supports traditional review words without claiming translated identity equivalence", () => {
    expect(assess({ title: "讀《置身事内》書評", excerpt: "兰小欢。" }, book).eligible).toBe(true);
    expect(assess({ title: "讀《置身事內》書評", excerpt: "蘭小歡。" }, book).eligible).toBe(false);
  });
  it("does not treat a longer Chinese title as the short target work", () => {
    expect(assess({ title: "置身事内续编 书评", excerpt: "兰小欢。" }, { ...book, title: "置身事内" }).eligible).toBe(false);
  });
});

describe("English evidence and cut boundaries", () => {
  const english = { title: "Seeing Like a State", author: "James C. Scott", isbn: "9780300078152" };
  it.each([
    ["SEEING LIKE A STATE: Book Review", "James C. Scott."],
    ["Seeing Like a State", "James C. Scott. Review by A Reader."],
  ])("accepts visible English review cues: %s", (title, excerpt) => {
    expect(assess({ title, excerpt }, english).eligible).toBe(true);
  });
  it("does not match a partial author or a title within another word", () => {
    expect(assess({ title: "Seeing Like a State: review", excerpt: "James C. Scotton." }, english).eligible).toBe(false);
    expect(assess({ title: "Seeing Like a Statesman: review", excerpt: "James C. Scott." }, english).eligible).toBe(false);
  });
  it("does not mistake the target title's Interview for the page genre", () => {
    expect(assess({ title: "Interview with the Vampire: a review", excerpt: "Anne Rice." },
      { title: "Interview with the Vampire", author: "Anne Rice", isbn: "" }).eligible).toBe(true);
  });
  it("does not use a review word inside the book title as a genre cue", () => {
    expect(assess({ title: "The Book Review", excerpt: "A Writer." },
      { title: "The Book Review", author: "A Writer", isbn: "" }).eligible).toBe(false);
  });
  it("does not accept customer reviews as independent commentary", () => {
    expect(assess({ title: english.title, excerpt: "James C. Scott. Customer reviews. Book review." }, english).eligible).toBe(false);
  });
  it("rejects a cut headline and does not complete an author at a cut excerpt end", () => {
    const text = { title: english.title + ": review", excerpt: english.author };
    expect(assess(text, english, { title: true }).eligible).toBe(false);
    expect(assess(text, english, { excerpt: true }).eligible).toBe(false);
    expect(assess({ ...text, excerpt: english.author + ". More text" }, english, { excerpt: true }).eligible).toBe(true);
  });
  it("uses exact field cuts and treats an unknown aggregate cut conservatively", () => {
    const text = { title: english.title + ": review", excerpt: english.author + ".", truncated: true };
    expect(assess(text, english).eligible).toBe(false);
    expect(assess(text, english, { title: false, excerpt: false }).eligible).toBe(true);
  });
  it("does not use a URL or mutate the source to invent evidence", () => {
    const text = { title: english.title, excerpt: "James C. Scott.", url: "https://reviews.example/book-review" };
    const before = JSON.stringify(text);
    expect(assess(text, english).eligible).toBe(false);
    expect(JSON.stringify(text)).toBe(before);
  });
});


describe("pre-freeze review counterexamples", () => {
  it.each(["读《置身事内 书评", "《另一本《置身事内》》书评", "置身事内》书评"])(
    "does not reinterpret ambiguous book brackets: %s", title => {
      expect(assess({ title, excerpt: "兰小欢。" }, book).eligible).toBe(false);
    });
  it("does not ignore a conflicting unquoted subtitle", () => {
    expect(assess({ title: "置身事内：另一部书 书评", excerpt: "兰小欢。" }, book).eligible).toBe(false);
  });
  it("does not complete a genre token at a cut excerpt end", () => {
    expect(assess({ title: "Seeing Like a State", excerpt: "James C. Scott. Book review" },
      { title: "Seeing Like a State", author: "James C. Scott", isbn: "" }, { excerpt: true }).eligible).toBe(false);
  });
  it.each(["主编：其他人", "译者：其他人", "Edited by Alice", "Translated by Alice"])(
    "does not promote a prefixed non-author role: %s", credit => {
      expect(assess({ ...source, excerpt: credit }, { ...book, author: "兰小欢著；" + credit }).eligible).toBe(false);
    });
  it("masks punctuation-equivalent book words before genre detection", () => {
    expect(assess({ title: "The Book—Review", excerpt: "A Writer." },
      { title: "The Book Review", author: "A Writer", isbn: "" }).eligible).toBe(false);
  });
});


describe("catalog language is not article genre", () => {
  const identity = { title: "梁思成", author: "林洙著；杨永生主编", isbn: "9787112124534" };
  it("does not turn a synopsis describing the book's commentary into a review cue", () => {
    const result = assess({ title: "梁思成", excerpt: "林洙。ISBN:9787112124534。本书对建筑作品及著作作出客观评述。" }, identity);
    expect(result.genre.reviewTextSeen).toBe(false);
    expect(result.eligible).toBe(false);
  });
  it("keeps a catalog's rating and inventory sections out of review candidates", () => {
    const result = assess({ title: "梁思成", excerpt: "林洙。ISBN:9787112124534。本书书评与口碑。好评率100%。库存信息。" }, identity);
    expect(result.genre.nonReviewTextSeen).toBe(true);
    expect(result.eligible).toBe(false);
  });
});
