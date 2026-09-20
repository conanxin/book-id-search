export interface ProjectResearchItem {
  bindingId: string;
  projectId: string;
  workId: string;
  editionId: string;
  sourceId: string | null;
  catalogBookId: string | null;
  title: string;
  publisher: string | null;
  publicationDate: string | null;
  publicationDatePrecision: "YEAR" | "MONTH" | "DAY";
  isbn: string | null;
  addedAt: string;
}
export class InvalidProjectItemInputError extends Error {}

export function readCatalogBookId(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new InvalidProjectItemInputError("bookId is required.");
  return value.trim();
}
export function readBindingId(value: unknown): string {
  if (typeof value !== "string" || !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value)) {
    throw new InvalidProjectItemInputError("bindingId is invalid.");
  }
  return value;
}
