import { describe, expect, it, vi } from "vitest";
import {
  CatalogBookNotFoundError,
  CatalogReadUnavailableError,
  InvalidPromotionRequestError,
  createPromoteCatalogBookCommand,
  type CatalogBookReader,
  type CatalogPromotionStore,
  type PromotionResult,
} from "./promote-catalog-book.js";
import { InvalidCatalogBookError, type CatalogBookSnapshot } from "../domain/catalog-promotion.js";

function validBook(overrides: Partial<CatalogBookSnapshot> = {}): CatalogBookSnapshot {
  return {
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
    ...overrides,
  };
}

const result: PromotionResult = {
  status: "created",
  workId: "work-1",
  editionId: "edition-1",
  sourceId: "source-1",
  catalogBookId: "123_202601010001",
};

describe("createPromoteCatalogBookCommand", () => {
  it("rejects blank bookId before calling the reader", async () => {
    const reader: CatalogBookReader = { getById: vi.fn() };
    const store: CatalogPromotionStore = { promote: vi.fn() };
    const command = createPromoteCatalogBookCommand({ reader, store });

    await expect(command.execute({ bookId: "   " })).rejects.toBeInstanceOf(InvalidPromotionRequestError);
    expect(reader.getById).not.toHaveBeenCalled();
    expect(store.promote).not.toHaveBeenCalled();
  });

  it("reports a missing catalog book", async () => {
    const reader: CatalogBookReader = { getById: vi.fn().mockResolvedValue(null) };
    const store: CatalogPromotionStore = { promote: vi.fn() };
    const command = createPromoteCatalogBookCommand({ reader, store });

    await expect(command.execute({ bookId: "missing" })).rejects.toBeInstanceOf(CatalogBookNotFoundError);
    expect(store.promote).not.toHaveBeenCalled();
  });

  it("propagates catalog unavailability", async () => {
    const reader: CatalogBookReader = {
      getById: vi.fn().mockRejectedValue(new CatalogReadUnavailableError("CATALOG_UNAVAILABLE")),
    };
    const store: CatalogPromotionStore = { promote: vi.fn() };
    const command = createPromoteCatalogBookCommand({ reader, store });

    await expect(command.execute({ bookId: "x" })).rejects.toBeInstanceOf(CatalogReadUnavailableError);
  });

  it("rejects an invalid catalog title before calling the store", async () => {
    const reader: CatalogBookReader = { getById: vi.fn().mockResolvedValue(validBook({ title: " " })) };
    const store: CatalogPromotionStore = { promote: vi.fn() };
    const command = createPromoteCatalogBookCommand({ reader, store });

    await expect(command.execute({ bookId: "x" })).rejects.toBeInstanceOf(InvalidCatalogBookError);
    expect(store.promote).not.toHaveBeenCalled();
  });

  it("maps the authoritative catalog row and returns the store result", async () => {
    const reader: CatalogBookReader = { getById: vi.fn().mockResolvedValue(validBook()) };
    const store: CatalogPromotionStore = { promote: vi.fn().mockResolvedValue(result) };
    const command = createPromoteCatalogBookCommand({
      reader,
      store,
      now: () => new Date("2026-09-19T10:00:00.000Z"),
    });

    await expect(command.execute({ bookId: " 123_202601010001 " })).resolves.toEqual(result);
    expect(reader.getById).toHaveBeenCalledWith("123_202601010001");
    expect(store.promote).toHaveBeenCalledTimes(1);
    const candidate = vi.mocked(store.promote).mock.calls[0]![0];
    expect(candidate.work.title).toBe("Book");
    expect(candidate.source.observedAt).toBe("2026-09-19T10:00:00.000Z");
  });

  it("accepts only bookId as command input and ignores no caller metadata because none exists", async () => {
    const reader: CatalogBookReader = { getById: vi.fn().mockResolvedValue(validBook({ title: "Authoritative" })) };
    const store: CatalogPromotionStore = { promote: vi.fn().mockResolvedValue(result) };
    const command = createPromoteCatalogBookCommand({ reader, store });

    const hostile = { bookId: "123_202601010001", title: "Attacker", publisher: "Attacker Press" };
    await command.execute(hostile);
    const candidate = vi.mocked(store.promote).mock.calls[0]![0];
    expect(candidate.work.title).toBe("Authoritative");
    expect(JSON.stringify(candidate)).not.toContain("Attacker");
  });
});
