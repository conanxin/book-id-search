import { describe, expect, it, vi } from "vitest";
import {
  collectRelatedBooks,
  RelatedBooksUnavailableError,
  relatedSourceReadError,
  type RelatedBookDocument,
  type RelatedBookSearcher,
  type RelatedField,
} from "./related-books.js";

type Book = RelatedBookDocument & { ssid?: string; dxid?: string; rawInfo?: string };
const source: Book = {
  id: "source",
  isbn: "978-7-100-00001-1",
  title: "中国古代旅行之研究",
  author: "江绍原",
  publisher: "中华书局",
};

function makeSearch(hits: Partial<Record<RelatedField, Book[]>>): RelatedBookSearcher<Book> {
  return vi.fn(async (_query, options) => ({ hits: hits[options.attributesToSearchOn[0]] ?? [] }));
}

describe("related source reads", () => {
  it("reports an explicitly missing source document from the current Meili SDK", () => {
    const error = new Error("upstream diagnostic", { cause: { code: "document_not_found" } });
    expect(relatedSourceReadError(error)).toEqual({ status: 404, message: "未找到这本书。" });
  });

  it("retains missing-document compatibility with older adapters", () => {
    expect(relatedSourceReadError({ code: "document_not_found" })).toEqual({ status: 404, message: "未找到这本书。" });
  });

  it("does not claim a missing book for network, index or unknown failures", () => {
    for (const error of [
      new Error("upstream timeout"),
      { cause: { code: "index_not_found" } },
      { code: "ECONNREFUSED", message: "private transport details" },
      null,
    ]) {
      expect(relatedSourceReadError(error)).toEqual({ status: 503, message: "相关图书检索暂不可用，请稍后重试。" });
    }
  });
});

describe("collectRelatedBooks", () => {
  it("samples the title independently when author and publisher each fill ten slots", async () => {
    const authors = Array.from({ length: 10 }, (_, i) => ({ id: `author-${i}`, author: source.author }));
    const publishers = Array.from({ length: 10 }, (_, i) => ({ id: `publisher-${i}`, publisher: source.publisher }));
    const search = makeSearch({
      author: authors,
      publisher: publishers,
      title: [{ id: "title-match", title: "中国古代旅行研究资料" }],
    });
    const response = await collectRelatedBooks(source, search);

    expect(search).toHaveBeenCalledTimes(4);
    for (const field of ["isbn", "title", "author", "publisher"] as const) {
      expect(search).toHaveBeenCalledWith(expect.any(String), { limit: 40, attributesToSearchOn: [field] });
    }
    expect(response.items).toHaveLength(10);
    expect(response.items[0]).toMatchObject({ id: "title-match", relations: [{ kind: "title_query", label: "书名线索" }] });
    expect(response.total).toBe(21);
    expect(response.partial).toBe(false);
    expect(response.sourceBookId).toBe(source.id);
  });

  it("uses ISBN equality only, never equal SSID/DXID or a fuzzy ISBN hit", async () => {
    const isbnOnly: Book = { id: "source", isbn: source.isbn };
    const search = makeSearch({ isbn: [
      { id: "same-isbn", isbn: "９７８ ７１００ ００００１１" },
      { id: "ssid-only", ssid: "9787100000011", isbn: "different" },
      { id: "dxid-only", dxid: "9787100000011" },
      { id: "fuzzy-isbn", isbn: "9787100000012" },
    ] });
    const response = await collectRelatedBooks(isbnOnly, search);

    expect(search).toHaveBeenCalledExactlyOnceWith("9787100000011", { limit: 40, attributesToSearchOn: ["isbn"] });
    expect(response.items).toEqual([
      { id: "same-isbn", isbn: "９７８ ７１００ ００００１１", relations: [{ kind: "same_isbn", label: "ISBN 相同" }] },
    ]);
  });

  it("compares nonempty full fields after width, case and whitespace normalization", async () => {
    const normalizedSource: Book = { id: "source", title: "  Ａ Book  ", author: "  Jane   Doe ", publisher: "ＰＲＥＳＳ" };
    const search = makeSearch({
      title: [{ id: "same-title", title: "a  book", rawInfo: "preserved" }],
      author: [{ id: "same-author", author: "jane doe" }],
      publisher: [{ id: "same-publisher", publisher: "press" }],
    });
    const response = await collectRelatedBooks(normalizedSource, search);

    expect(response.items.map(book => book.relations)).toEqual([
      [{ kind: "same_title", label: "书名相同" }],
      [{ kind: "same_author", label: "作者相同" }],
      [{ kind: "same_publisher", label: "同出版社" }],
    ]);
    expect(response.items[0].rawInfo).toBe("preserved");
  });

  it("labels fuzzy field searches as clues and does not infer unqueried clues", async () => {
    const response = await collectRelatedBooks(source, makeSearch({
      title: [{ id: "partial-title", title: "中国古代旅行之研究续编" }],
      author: [{ id: "partial-author", author: "江绍原著；其他人编", title: "其他书名", publisher: "其他出版社" }],
      publisher: [{ id: "partial-publisher", publisher: "中华书局资料编印部" }],
    }));

    expect(response.items.map(book => book.relations)).toEqual([
      [{ kind: "title_query", label: "书名线索" }],
      [{ kind: "author_query", label: "作者线索" }],
      [{ kind: "publisher_query", label: "出版社线索" }],
    ]);
  });

  it("keeps at most two strongest genuine reasons and merges duplicate IDs", async () => {
    const exact = { ...source, id: "exact" };
    const titleAuthor = { id: "title-author", title: "相关书名", author: source.author, publisher: source.publisher };
    const response = await collectRelatedBooks(source, makeSearch({
      isbn: [source, exact, exact],
      title: [source, exact, titleAuthor],
      author: [exact, titleAuthor],
      publisher: [source, exact, titleAuthor],
    }));

    expect(response.total).toBe(2);
    expect(response.items.map(book => [book.id, book.relations.map(relation => relation.kind)])).toEqual([
      ["exact", ["same_isbn", "same_title"]],
      ["title-author", ["title_query", "same_author"]],
    ]);
    expect(exact).not.toHaveProperty("relations");
  });

  it("keeps field and hit order stable when requests finish in reverse order", async () => {
    const resolvers = new Map<RelatedField, (value: { hits: Book[] }) => void>();
    const search: RelatedBookSearcher<Book> = (_query, options) => new Promise(resolve => {
      resolvers.set(options.attributesToSearchOn[0], resolve);
    });
    const pending = collectRelatedBooks(source, search);
    resolvers.get("publisher")!({ hits: [{ id: "publisher-first", publisher: source.publisher }] });
    resolvers.get("author")!({ hits: [{ id: "author-first", author: source.author }] });
    resolvers.get("title")!({ hits: [
      { id: "title-first", title: "题名线索甲" },
      { id: "title-second", title: "题名线索乙" },
    ] });
    resolvers.get("isbn")!({ hits: [] });

    expect((await pending).items.map(book => book.id)).toEqual([
      "title-first", "title-second", "author-first", "publisher-first",
    ]);
  });

  it("bounds each source sample and returns at most ten without an index-wide total", async () => {
    const hits = Array.from({ length: 60 }, (_, i) => ({ id: `sample-${i}`, title: "旅行史资料" }));
    const response = await collectRelatedBooks({ id: "source", title: source.title }, makeSearch({ title: hits }));

    expect(response.total).toBe(40);
    expect(response.items.map(book => book.id)).toEqual(hits.slice(0, 10).map(book => book.id));
  });

  it("does not issue empty queries or count missing fields as failures", async () => {
    const search = makeSearch({});
    const emptySource: Book = { id: "source", title: "  \t", author: null, isbn: " - ‑  " };
    expect(await collectRelatedBooks(emptySource, search)).toEqual({
      sourceBookId: "source", total: 0, items: [], partial: false, unavailableFields: [],
    });
    expect(search).not.toHaveBeenCalled();
  });

  it("returns an ordinary empty result when all searches succeed with no other books", async () => {
    const response = await collectRelatedBooks(source, makeSearch({ title: [source] }));
    expect(response).toEqual({ sourceBookId: "source", total: 0, items: [], partial: false, unavailableFields: [] });
  });

  it("retains other candidates and exact metadata evidence when some searches fail", async () => {
    const search: RelatedBookSearcher<Book> = async (_query, options) => {
      if (options.attributesToSearchOn[0] !== "author") throw new Error("upstream unavailable");
      return { hits: [{ id: "kept", title: source.title, author: source.author }] };
    };
    const response = await collectRelatedBooks(source, search);

    expect(response.partial).toBe(true);
    expect(response.unavailableFields).toEqual(["isbn", "title", "publisher"]);
    expect(response.items).toEqual([{
      id: "kept", title: source.title, author: source.author,
      relations: [{ kind: "same_title", label: "书名相同" }, { kind: "same_author", label: "作者相同" }],
    }]);
  });

  it("distinguishes a partial empty sample from total search unavailability", async () => {
    const search: RelatedBookSearcher<Book> = async (_query, options) => {
      if (options.attributesToSearchOn[0] === "title") throw new Error("title unavailable");
      return { hits: [] };
    };
    expect(await collectRelatedBooks(source, search)).toEqual({
      sourceBookId: source.id, total: 0, items: [], partial: true, unavailableFields: ["title"],
    });
  });

  it("reports 503 when all actual searches reject, including synchronous adapters", async () => {
    const search = vi.fn(() => { throw new Error("upstream detail must not escape"); });
    const result = collectRelatedBooks({ id: "source", title: "旅行", author: "作者" }, search);

    await expect(result).rejects.toBeInstanceOf(RelatedBooksUnavailableError);
    await expect(result).rejects.toMatchObject({ status: 503, message: "相关图书检索暂不可用，请稍后重试。" });
    expect(search).toHaveBeenCalledTimes(2);
  });
});
