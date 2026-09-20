import { describe, expect, it } from "vitest";
import { CatalogReadUnavailableError } from "../application/promote-catalog-book.js";
import { createMeiliCatalogBookReader } from "./meili-catalog-book-reader.js";

const doc = {
  id: "123_202601010001",
  ssid: "S1",
  dxid: "D1",
  title: "Book",
  author: "Author",
  publisher: "Press",
  year: 1986,
  pages: 200,
  isbn: "9787538455250",
  rawInfo: "raw",
  parseStatus: "ok",
  parseWarnings: [],
};

describe("createMeiliCatalogBookReader", () => {
  it("returns the catalog snapshot for a valid document", async () => {
    const reader = createMeiliCatalogBookReader(async () => doc);
    await expect(reader.getById(doc.id)).resolves.toEqual(doc);
  });

  it("returns null only for Meili document_not_found", async () => {
    const reader = createMeiliCatalogBookReader(async () => {
      throw { code: "document_not_found" };
    });
    await expect(reader.getById("missing")).resolves.toBeNull();
  });

  it("recognizes document_not_found in the current Meili SDK error cause", async () => {
    const reader = createMeiliCatalogBookReader(async () => {
      throw new Error("MeiliSearchApiError", { cause: { code: "document_not_found" } });
    });
    await expect(reader.getById("missing")).resolves.toBeNull();
  });

  it("does not treat an unavailable index as a missing book", async () => {
    const reader = createMeiliCatalogBookReader(async () => {
      throw new Error("MeiliSearchApiError", { cause: { code: "index_not_found" } });
    });
    await expect(reader.getById("missing")).rejects.toBeInstanceOf(CatalogReadUnavailableError);
  });

  it("classifies other lookup failures as CatalogReadUnavailableError", async () => {
    const reader = createMeiliCatalogBookReader(async () => {
      throw new Error("upstream unavailable");
    });
    await expect(reader.getById("x")).rejects.toBeInstanceOf(CatalogReadUnavailableError);
  });

  it("rejects malformed documents without a non-empty string id", async () => {
    const reader = createMeiliCatalogBookReader(async () => ({ ...doc, id: " " }));
    await expect(reader.getById("x")).rejects.toBeInstanceOf(CatalogReadUnavailableError);
  });

  it("coerces optional source fields conservatively", async () => {
    const reader = createMeiliCatalogBookReader(async () => ({
      id: "abc",
      title: "Book",
      year: "1986",
      pages: undefined,
      parseStatus: "unknown",
      parseWarnings: ["a", 2],
    }));
    await expect(reader.getById("abc")).resolves.toEqual({
      id: "abc",
      ssid: "",
      dxid: "",
      title: "Book",
      author: "",
      publisher: "",
      year: null,
      pages: null,
      isbn: "",
      rawInfo: "",
      parseStatus: "failed",
      parseWarnings: ["a"],
    });
  });
});
