import { describe, expect, it, vi } from "vitest";
import { createBookLibraryService, type BookLibraryStore } from "./book-library.js";
import { emptyBookWorkspace } from "../domain/book-library.js";
import type { CatalogBookSnapshot } from "../domain/catalog-promotion.js";

const editionId = "11111111-1111-4111-8111-111111111111", sourceId = "22222222-2222-4222-8222-222222222222";
function setup() {
  const store = {
    subject: vi.fn().mockResolvedValue(null), get: vi.fn().mockResolvedValue(null),
    list: vi.fn(), save: vi.fn(), createNote: vi.fn(), updateNote: vi.fn(), deleteNote: vi.fn(),
    getRevision: vi.fn(), createResource: vi.fn(), updateResource: vi.fn(), deleteResource: vi.fn(),
  } satisfies BookLibraryStore;
  const reader = { getById: vi.fn().mockResolvedValue({ id: "book" } as CatalogBookSnapshot) };
  const promotionCommand = { execute: vi.fn().mockResolvedValue({ status: "created", catalogBookId: "book", workId: "work", editionId, sourceId }) };
  return { store, reader, promotionCommand, service: createBookLibraryService({ store, reader, promotionCommand }) };
}

describe("Book library service with mocked persistence", () => {
  it("reads an unsaved catalog book without promotion or writes", async () => {
    const s = setup();
    expect(await s.service.get("book")).toEqual(emptyBookWorkspace("book"));
    expect(s.promotionCommand.execute).not.toHaveBeenCalled();
    expect(s.store.save).not.toHaveBeenCalled();
    s.reader.getById.mockResolvedValue(null);
    await expect(s.service.get("missing")).rejects.toMatchObject({ code: "LIBRARY_BOOK_NOT_FOUND" });
  });
  it("reads existing content without depending on a live catalog lookup", async () => {
    const s = setup(), workspace = { ...emptyBookWorkspace("book"), saved: true, editionId, version: 1 };
    s.store.get.mockResolvedValue(workspace);
    expect(await s.service.get("book")).toEqual(workspace);
    expect(s.reader.getById).not.toHaveBeenCalled();
    expect(s.promotionCommand.execute).not.toHaveBeenCalled();
  });
  it("promotes only for the first content/favorite write and never creates a project", async () => {
    const s = setup();
    await s.service.save("book", {});
    expect(s.promotionCommand.execute).toHaveBeenCalledExactlyOnceWith({ bookId: "book" });
    expect(s.store.save).toHaveBeenCalledWith({ bookId: "book", editionId, sourceId });
    s.store.subject.mockResolvedValue({ bookId: "book", editionId, sourceId });
    await s.service.createNote("book", { title: "reading", content: "one" });
    await s.service.createResource("book", { label: "PDF", url: "https://example.test/book.pdf" });
    expect(s.promotionCommand.execute).toHaveBeenCalledTimes(1);
    expect(s.store.createNote).toHaveBeenCalledWith({ bookId: "book", editionId, sourceId, title: "reading", content: "one" });
  });
  it("validates content before promotion and passes the book scope into every edit", async () => {
    const s = setup();
    await expect(s.service.createNote("book", { title: "", content: "text" })).rejects.toMatchObject({ code: "LIBRARY_INVALID_INPUT" });
    await expect(s.service.createResource("book", { label: "bad", url: "javascript:alert(1)" })).rejects.toMatchObject({ code: "LIBRARY_INVALID_INPUT" });
    expect(s.promotionCommand.execute).not.toHaveBeenCalled();
    await s.service.updateNote("book", editionId, { title: "title", content: "next", baseRevisionId: sourceId });
    expect(s.store.updateNote).toHaveBeenCalledWith({ bookId: "book", noteId: editionId, title: "title", content: "next", baseRevisionId: sourceId });
    await s.service.deleteNote("other-book", editionId);
    expect(s.store.deleteNote).toHaveBeenCalledWith({ bookId: "other-book", noteId: editionId });
    await s.service.deleteResource("other-book", sourceId);
    expect(s.store.deleteResource).toHaveBeenCalledWith({ bookId: "other-book", resourceId: sourceId });
  });
  it("refuses a catalog reader/promotion identity mismatch before library writes", async () => {
    const s = setup();
    s.reader.getById.mockResolvedValue({ id: "different" });
    await expect(s.service.get("book")).rejects.toMatchObject({ code: "LIBRARY_BOOK_NOT_FOUND" });
    s.promotionCommand.execute.mockResolvedValue({ status: "created", catalogBookId: "different", workId: "work", editionId, sourceId });
    await expect(s.service.save("book", {})).rejects.toMatchObject({ code: "LIBRARY_CATALOG_ID_MISMATCH" });
    expect(s.store.save).not.toHaveBeenCalled();
  });
});
