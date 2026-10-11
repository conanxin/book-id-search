/** Related catalog records, with field evidence rather than inferred themes. */

export type RelatedField = "isbn" | "title" | "author" | "publisher";
export type BookRelationKind =
  | "same_isbn"
  | "same_title"
  | "title_query"
  | "same_author"
  | "author_query"
  | "same_publisher"
  | "publisher_query";

export interface BookRelation {
  kind: BookRelationKind;
  label: string;
}

/** The remaining catalog fields are preserved by the generic collector. */
export interface RelatedBookDocument {
  id: string;
  isbn?: string | null;
  title?: string | null;
  author?: string | null;
  publisher?: string | null;
}

export type RelatedBookSearcher<T extends RelatedBookDocument> = (
  query: string,
  options: { limit: number; attributesToSearchOn: RelatedField[] },
) => Promise<{ hits: T[] }>;

export interface RelatedBooksResponse<T extends RelatedBookDocument> {
  sourceBookId: string;
  /** Deduplicated candidates in this bounded sample, not an index-wide total. */
  total: number;
  items: Array<T & { relations: BookRelation[] }>;
  partial: boolean;
  /** Failed searches only; a missing source field is not a search failure. */
  unavailableFields: RelatedField[];
}

export class RelatedBooksUnavailableError extends Error {
  readonly status = 503;

  constructor() {
    super("相关图书检索暂不可用，请稍后重试。");
    this.name = "RelatedBooksUnavailableError";
  }
}

/** Only an explicit missing-document response means that the source book is absent. */
export function relatedSourceReadError(error: unknown): { status: 404 | 503; message: string } {
  const details = error && typeof error === "object" ? error as { code?: unknown; cause?: unknown } : null;
  // Meili SDK 0.52 wraps API details in cause; older adapters expose code directly.
  const cause = details?.cause && typeof details.cause === "object"
    ? details.cause as { code?: unknown } : null;
  return details?.code === "document_not_found" || cause?.code === "document_not_found"
    ? { status: 404, message: "未找到这本书。" }
    : { status: 503, message: "相关图书检索暂不可用，请稍后重试。" };
}

const FIELDS: RelatedField[] = ["isbn", "title", "author", "publisher"];
const ITEM_LIMIT = 10;
const PER_FIELD_LIMIT = 40;
const RELATIONS: BookRelation[] = [
  { kind: "same_isbn", label: "ISBN 相同" },
  { kind: "same_title", label: "书名相同" },
  { kind: "title_query", label: "书名线索" },
  { kind: "same_author", label: "作者相同" },
  { kind: "author_query", label: "作者线索" },
  { kind: "same_publisher", label: "同出版社" },
  { kind: "publisher_query", label: "出版社线索" },
];

function normalizeField(field: RelatedField, value: unknown): string {
  if (typeof value !== "string") return "";
  const normalized = value.normalize("NFKC").replace(/\s+/g, " ").trim();
  // Only formatting is removed. Do not compare ISBN to SSID/DXID, or strip
  // punctuation from titles/authors and thereby invent an exact field match.
  return field === "isbn"
    ? normalized.replace(/[\s\-‐‑‒–—−]/g, "").toUpperCase()
    : normalized.toLowerCase();
}

function relationsFor(
  sourceFields: Record<RelatedField, string>,
  book: RelatedBookDocument,
  queryFields: Set<RelatedField>,
): BookRelation[] {
  const kinds = new Set<BookRelationKind>();
  for (const field of FIELDS) {
    const exact = sourceFields[field] !== "" && sourceFields[field] === normalizeField(field, book[field]);
    if (exact) kinds.add(`same_${field}`);
    // A query hit describes how this candidate was found. It is not an
    // equality claim; only use it for fields actually searched for this ID.
    else if (field !== "isbn" && queryFields.has(field)) kinds.add(`${field}_query`);
  }
  return RELATIONS.filter(relation => kinds.has(relation.kind)).slice(0, 2).map(relation => ({ ...relation }));
}

/**
 * Search every available field independently before ranking. An author or
 * publisher sample can never prevent title candidates from being fetched.
 * All reads are bounded, and settled results retain query/rank order even
 * when the upstream requests complete in a different order.
 */
export async function collectRelatedBooks<T extends RelatedBookDocument>(
  source: T,
  search: RelatedBookSearcher<T>,
): Promise<RelatedBooksResponse<T>> {
  const sourceFields = Object.fromEntries(
    FIELDS.map(field => [field, normalizeField(field, source[field])]),
  ) as Record<RelatedField, string>;
  const queries = FIELDS.filter(field => sourceFields[field] !== "");
  const settled = await Promise.allSettled(queries.map(async field => search(sourceFields[field], {
    limit: PER_FIELD_LIMIT,
    attributesToSearchOn: [field],
  })));
  const unavailableFields = queries.filter((_field, i) => settled[i].status === "rejected");
  if (queries.length > 0 && unavailableFields.length === queries.length) {
    throw new RelatedBooksUnavailableError();
  }

  const candidates = new Map<string, { book: T; queryFields: Set<RelatedField>; order: number }>();
  settled.forEach((result, queryIndex) => {
    if (result.status !== "fulfilled") return;
    const field = queries[queryIndex];
    for (const book of result.value.hits.slice(0, PER_FIELD_LIMIT)) {
      if (!book.id || book.id === source.id) continue;
      // ISBN search may still return fuzzy hits. They do not count unless
      // the candidate's ISBN field itself equals the source ISBN.
      if (field === "isbn" && normalizeField("isbn", book.isbn) !== sourceFields.isbn) continue;
      const existing = candidates.get(book.id);
      if (existing) existing.queryFields.add(field);
      else candidates.set(book.id, { book, queryFields: new Set([field]), order: candidates.size });
    }
  });

  const ranked = [...candidates.values()].map(candidate => ({
    ...candidate,
    relations: relationsFor(sourceFields, candidate.book, candidate.queryFields),
  }));
  const priority = (relations: BookRelation[], i: number) => {
    const relation = relations[i];
    return relation ? RELATIONS.findIndex(entry => entry.kind === relation.kind) : RELATIONS.length;
  };
  ranked.sort((a, b) => (
    priority(a.relations, 0) - priority(b.relations, 0)
    || priority(a.relations, 1) - priority(b.relations, 1)
    || a.order - b.order
  ));

  return {
    sourceBookId: source.id,
    total: ranked.length,
    items: ranked.slice(0, ITEM_LIMIT).map(({ book, relations }) => ({ ...book, relations })),
    partial: unavailableFields.length > 0,
    unavailableFields,
  };
}
