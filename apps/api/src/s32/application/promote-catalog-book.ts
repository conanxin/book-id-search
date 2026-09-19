import {
  mapCatalogBookToPromotion,
  type CatalogBookSnapshot,
  type PromotionCandidate,
} from "../domain/catalog-promotion.js";

export interface CatalogBookReader {
  getById(id: string): Promise<CatalogBookSnapshot | null>;
}

export interface PromotionResult {
  status: "created" | "existing";
  workId: string;
  editionId: string;
  sourceId: string;
  catalogBookId: string;
}

export interface CatalogPromotionStore {
  promote(candidate: PromotionCandidate): Promise<PromotionResult>;
}

class PromotionError extends Error {
  constructor(
    public readonly code: string,
    message = code,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidPromotionRequestError extends PromotionError {}
export class CatalogBookNotFoundError extends PromotionError {}
export class CatalogReadUnavailableError extends PromotionError {}
export class IdentityConflictError extends PromotionError {}
export class CanonicalStoreUnavailableError extends PromotionError {}

export function createPromoteCatalogBookCommand(deps: {
  reader: CatalogBookReader;
  store: CatalogPromotionStore;
  now?: () => Date;
}): {
  execute(input: { bookId: string }): Promise<PromotionResult>;
} {
  const now = deps.now ?? (() => new Date());

  return {
    async execute(input: { bookId: string }): Promise<PromotionResult> {
      const bookId = typeof input?.bookId === "string" ? input.bookId.trim() : "";
      if (!bookId) {
        throw new InvalidPromotionRequestError("BOOK_ID_REQUIRED");
      }

      const book = await deps.reader.getById(bookId);
      if (!book) {
        throw new CatalogBookNotFoundError("CATALOG_BOOK_NOT_FOUND");
      }

      const candidate = mapCatalogBookToPromotion(book, now().toISOString());
      return deps.store.promote(candidate);
    },
  };
}
