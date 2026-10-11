import {
  emptyBookWorkspace, LibraryError, libraryBookId, libraryUuid, readLibraryList,
  readLibraryNote, readLibraryNoteUpdate, readLibraryProfile, readLibraryResource,
  type BookNoteInput, type BookNoteRevision, type BookResourceInput, type BookWorkspace,
  type LibraryListInput, type LibraryPage, type LibraryProfileInput,
} from "../domain/book-library.js";
import type { CatalogBookReader, PromotionResult } from "./promote-catalog-book.js";

export interface LibrarySubject { bookId: string; editionId: string; sourceId: string }

export interface BookLibraryStore {
  subject(bookId: string): Promise<LibrarySubject | null>;
  list(input: LibraryListInput): Promise<LibraryPage>;
  get(bookId: string): Promise<BookWorkspace | null>;
  save(input: LibrarySubject & LibraryProfileInput): Promise<BookWorkspace>;
  createNote(input: LibrarySubject & BookNoteInput): Promise<BookWorkspace>;
  updateNote(input: { bookId: string; noteId: string; baseRevisionId: string } & BookNoteInput): Promise<BookWorkspace>;
  deleteNote(input: { bookId: string; noteId: string }): Promise<BookWorkspace>;
  getRevision(input: { bookId: string; noteId: string; revisionId: string }): Promise<BookNoteRevision>;
  createResource(input: LibrarySubject & BookResourceInput): Promise<BookWorkspace>;
  updateResource(input: { bookId: string; resourceId: string } & BookResourceInput): Promise<BookWorkspace>;
  deleteResource(input: { bookId: string; resourceId: string }): Promise<BookWorkspace>;
}

export function createBookLibraryService(deps: {
  store: BookLibraryStore;
  reader: CatalogBookReader;
  promotionCommand: { execute(input: { bookId: string }): Promise<PromotionResult> };
}) {
  async function subject(bookId: string): Promise<LibrarySubject> {
    const existing = await deps.store.subject(bookId);
    if (existing) return existing;
    const promotion = await deps.promotionCommand.execute({ bookId });
    if (promotion.catalogBookId !== bookId) throw new LibraryError("LIBRARY_CATALOG_ID_MISMATCH");
    return { bookId, editionId: promotion.editionId, sourceId: promotion.sourceId };
  }

  return {
    list(query: unknown) { return deps.store.list(readLibraryList(query)); },
    async get(id: unknown) {
      const bookId = libraryBookId(id);
      const workspace = await deps.store.get(bookId);
      if (workspace) return workspace;
      const book = await deps.reader.getById(bookId);
      if (!book || book.id !== bookId) throw new LibraryError("LIBRARY_BOOK_NOT_FOUND");
      return emptyBookWorkspace(bookId);
    },
    async save(id: unknown, body: unknown) {
      const bookId = libraryBookId(id), input = readLibraryProfile(body);
      return deps.store.save({ ...await subject(bookId), ...input });
    },
    async createNote(id: unknown, body: unknown) {
      const bookId = libraryBookId(id), input = readLibraryNote(body);
      return deps.store.createNote({ ...await subject(bookId), ...input });
    },
    updateNote(id: unknown, note: unknown, body: unknown) {
      const bookId = libraryBookId(id), noteId = libraryUuid(note), input = readLibraryNoteUpdate(body);
      return deps.store.updateNote({ bookId, noteId, ...input });
    },
    deleteNote(id: unknown, note: unknown) {
      return deps.store.deleteNote({ bookId: libraryBookId(id), noteId: libraryUuid(note) });
    },
    getRevision(id: unknown, note: unknown, revision: unknown) {
      return deps.store.getRevision({ bookId: libraryBookId(id), noteId: libraryUuid(note), revisionId: libraryUuid(revision) });
    },
    async createResource(id: unknown, body: unknown) {
      const bookId = libraryBookId(id), input = readLibraryResource(body);
      return deps.store.createResource({ ...await subject(bookId), ...input });
    },
    updateResource(id: unknown, resource: unknown, body: unknown) {
      const bookId = libraryBookId(id), resourceId = libraryUuid(resource), input = readLibraryResource(body);
      return deps.store.updateResource({ bookId, resourceId, ...input });
    },
    deleteResource(id: unknown, resource: unknown) {
      return deps.store.deleteResource({ bookId: libraryBookId(id), resourceId: libraryUuid(resource) });
    },
  };
}

export type BookLibraryService = ReturnType<typeof createBookLibraryService>;
