import { CatalogReadUnavailableError, type CatalogBookReader } from "../application/promote-catalog-book.js";
import type { CatalogBookSnapshot } from "../domain/catalog-promotion.js";

export type GetDocument = (id: string) => Promise<unknown>;

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asParseStatus(value: unknown): CatalogBookSnapshot["parseStatus"] {
  return value === "ok" || value === "weak" || value === "failed" ? value : "failed";
}

function asWarnings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function createMeiliCatalogBookReader(getDocument: GetDocument): CatalogBookReader {
  return {
    async getById(id: string): Promise<CatalogBookSnapshot | null> {
      let raw: unknown;
      try {
        raw = await getDocument(id);
      } catch (error) {
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          (error as { code?: unknown }).code === "document_not_found"
        ) {
          return null;
        }
        throw new CatalogReadUnavailableError("CATALOG_READ_UNAVAILABLE");
      }

      if (!raw || typeof raw !== "object") {
        throw new CatalogReadUnavailableError("CATALOG_DOCUMENT_MALFORMED");
      }

      const record = raw as Record<string, unknown>;
      const documentId = asString(record.id).trim();
      if (!documentId) {
        throw new CatalogReadUnavailableError("CATALOG_DOCUMENT_MALFORMED");
      }

      return {
        id: documentId,
        ssid: asString(record.ssid),
        dxid: asString(record.dxid),
        title: asString(record.title),
        author: asString(record.author),
        publisher: asString(record.publisher),
        year: asNullableNumber(record.year),
        pages: asNullableNumber(record.pages),
        isbn: asString(record.isbn),
        rawInfo: asString(record.rawInfo),
        parseStatus: asParseStatus(record.parseStatus),
        parseWarnings: asWarnings(record.parseWarnings),
      };
    },
  };
}
