export class InvalidRediscoverInputError extends Error {}

export type ProjectLifecycleState = "ACTIVE" | "ARCHIVED";

export interface CatalogBookMembership {
  projectId: string;
  projectName: string;
  projectLifecycleState: ProjectLifecycleState;
  bindingId: string;
  hasNote: boolean;
  noteUpdatedAt: string | null;
}

export interface ProjectOverviewNoteSummary {
  noteId: string;
  currentRevisionId: string;
  currentRevisionNo: number;
  excerpt: string;
  updatedAt: string;
}

export interface ProjectOverviewItem {
  bindingId: string;
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
  activityAt: string;
  noteSummary: ProjectOverviewNoteSummary | null;
}

export interface ProjectOverview {
  project: {
    id: string;
    name: string;
    description: string | null;
    lifecycleState: ProjectLifecycleState;
    readOnly: boolean;
    createdAt: string;
    updatedAt: string;
  };
  summary: {
    itemCount: number;
    noteCount: number;
    lastActivityAt: string | null;
  };
  items: ProjectOverviewItem[];
}

export function readMembershipBookIds(input: unknown): string[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new InvalidRediscoverInputError("membership input must be an object");
  }
  const value = (input as Record<string, unknown>).bookIds;
  if (!Array.isArray(value) || value.length > 100) {
    throw new InvalidRediscoverInputError("bookIds must be an array of at most 100 items");
  }

  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !item.trim()) {
      throw new InvalidRediscoverInputError("bookIds must contain non-empty strings");
    }
    if (!seen.has(item)) {
      seen.add(item);
      result.push(item);
    }
  }
  return result;
}

export function buildNoteExcerpt(content: string): string {
  const normalized = content
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .replace(/\s+/gu, " ")
    .trim();
  const codePoints = Array.from(normalized);
  return codePoints.length <= 240 ? normalized : `${codePoints.slice(0, 240).join("")}…`;
}
