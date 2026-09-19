export interface CatalogBookSnapshot {
  id: string;
  ssid: string;
  dxid: string;
  title: string;
  author: string;
  publisher: string;
  year: number | null;
  pages: number | null;
  isbn: string;
  rawInfo: string;
  parseStatus: "ok" | "weak" | "failed";
  parseWarnings: string[];
}

export interface PromotionCandidate {
  catalogBookId: string;
  work: {
    workType: "BOOK";
    title: string;
    titleStatus: "KNOWN";
  };
  edition: {
    editionType: "BOOK_EDITION";
    publisher: string | null;
    publicationDate: string | null;
    publicationDatePrecision: "YEAR";
    isbn: string | null;
  };
  source: {
    sourceType: "DATABASE_RECORD";
    observedAt: string;
    metadata: {
      provider: "BOOK_ID_SEARCH";
      catalogDocument: CatalogBookSnapshot;
    };
  };
  secondaryIdentities: Array<{
    namespace: "SSID" | "DXID";
    externalId: string;
  }>;
}

export class InvalidCatalogBookError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "InvalidCatalogBookError";
  }
}

export function normalizePromotionIsbn(value: string): string | null {
  const normalized = value.replace(/[\s-]+/g, "").toUpperCase();
  if (/^[0-9]{13}$/.test(normalized)) return normalized;
  if (/^[0-9]{9}[0-9X]$/.test(normalized)) return normalized;
  return null;
}

function publicationDateFromYear(year: number | null): string | null {
  if (year === null || !Number.isInteger(year) || year < 1 || year > 9999) return null;
  return `${String(year).padStart(4, "0")}-01-01`;
}

export function mapCatalogBookToPromotion(
  book: CatalogBookSnapshot,
  observedAt: string,
): PromotionCandidate {
  const title = book.title.trim();
  if (!title) {
    throw new InvalidCatalogBookError("CATALOG_TITLE_MISSING");
  }

  const publisher = book.publisher.trim() || null;
  const secondaryIdentities: PromotionCandidate["secondaryIdentities"] = [];
  const ssid = book.ssid.trim();
  const dxid = book.dxid.trim();
  if (ssid) secondaryIdentities.push({ namespace: "SSID", externalId: ssid });
  if (dxid) secondaryIdentities.push({ namespace: "DXID", externalId: dxid });

  return {
    catalogBookId: book.id.trim(),
    work: {
      workType: "BOOK",
      title,
      titleStatus: "KNOWN",
    },
    edition: {
      editionType: "BOOK_EDITION",
      publisher,
      publicationDate: publicationDateFromYear(book.year),
      publicationDatePrecision: "YEAR",
      isbn: normalizePromotionIsbn(book.isbn),
    },
    source: {
      sourceType: "DATABASE_RECORD",
      observedAt,
      metadata: {
        provider: "BOOK_ID_SEARCH",
        catalogDocument: book,
      },
    },
    secondaryIdentities,
  };
}
