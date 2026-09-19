import { describe, expect, it } from "vitest";
import {
  InvalidCatalogBookError,
  mapCatalogBookToPromotion,
  normalizePromotionIsbn,
  type CatalogBookSnapshot,
} from "./catalog-promotion.js";

function book(overrides: Partial<CatalogBookSnapshot> = {}): CatalogBookSnapshot {
  return {
    id: "123_202601010001",
    ssid: "SSID-1",
    dxid: "DXID-1",
    title: "  Test Book  ",
    author: "Author A / Author B",
    publisher: " Test Press ",
    year: 1986,
    pages: 320,
    isbn: "978-7-5384-5525-0",
    rawInfo: "raw source line",
    parseStatus: "weak",
    parseWarnings: ["warning-a"],
    ...overrides,
  };
}

describe("normalizePromotionIsbn", () => {
  it("normalizes structural ISBN-13 and ISBN-10", () => {
    expect(normalizePromotionIsbn("978-7-5384-5525-0")).toBe("9787538455250");
    expect(normalizePromotionIsbn("0-306-40615-2")).toBe("0306406152");
    expect(normalizePromotionIsbn("0-8044-2957-X")).toBe("080442957X");
  });

  it("returns null for structurally invalid ISBN values", () => {
    expect(normalizePromotionIsbn("1234")).toBeNull();
    expect(normalizePromotionIsbn("978-ABC")).toBeNull();
    expect(normalizePromotionIsbn("")).toBeNull();
  });
});

describe("mapCatalogBookToPromotion", () => {
  it("maps a complete catalog book into Work, Edition, Source and identities", () => {
    const result = mapCatalogBookToPromotion(book(), "2026-09-19T10:00:00.000Z");

    expect(result.catalogBookId).toBe("123_202601010001");
    expect(result.work).toEqual({
      workType: "BOOK",
      title: "Test Book",
      titleStatus: "KNOWN",
    });
    expect(result.edition).toEqual({
      editionType: "BOOK_EDITION",
      publisher: "Test Press",
      publicationDate: "1986-01-01",
      publicationDatePrecision: "YEAR",
      isbn: "9787538455250",
    });
    expect(result.source.sourceType).toBe("DATABASE_RECORD");
    expect(result.source.observedAt).toBe("2026-09-19T10:00:00.000Z");
    expect(result.secondaryIdentities).toEqual([
      { namespace: "SSID", externalId: "SSID-1" },
      { namespace: "DXID", externalId: "DXID-1" },
    ]);
  });

  it("rejects a blank catalog title", () => {
    expect(() => mapCatalogBookToPromotion(book({ title: "   " }), "2026-09-19T10:00:00.000Z"))
      .toThrowError(new InvalidCatalogBookError("CATALOG_TITLE_MISSING"));
  });

  it("maps blank publisher to null", () => {
    expect(mapCatalogBookToPromotion(book({ publisher: "  " }), "2026-09-19T10:00:00.000Z").edition.publisher)
      .toBeNull();
  });

  it("maps missing or invalid year to null publicationDate", () => {
    for (const year of [null, 0, 10000, 1986.5] as Array<number | null>) {
      const mapped = mapCatalogBookToPromotion(book({ year }), "2026-09-19T10:00:00.000Z");
      expect(mapped.edition.publicationDate).toBeNull();
      expect(mapped.edition.publicationDatePrecision).toBe("YEAR");
    }
  });

  it("omits blank SSID and DXID identities", () => {
    expect(mapCatalogBookToPromotion(book({ ssid: " ", dxid: "" }), "2026-09-19T10:00:00.000Z").secondaryIdentities)
      .toEqual([]);
  });

  it("preserves ambiguous catalog provenance under Source metadata", () => {
    const input = book();
    const mapped = mapCatalogBookToPromotion(input, "2026-09-19T10:00:00.000Z");
    expect(mapped.source.metadata).toEqual({
      provider: "BOOK_ID_SEARCH",
      catalogDocument: input,
    });
    expect(JSON.stringify(mapped)).not.toContain('"actorId"');
    expect(JSON.stringify(mapped)).not.toContain('"contributionType"');
  });
});
