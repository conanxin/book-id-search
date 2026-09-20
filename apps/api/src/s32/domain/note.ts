import { createHash } from "node:crypto";

export class InvalidNoteInputError extends Error {}
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const MAX_NOTE_BYTES = 65536;

export interface ProjectItemNoteRevisionSummary {
  revisionId: string;
  revisionNo: number;
  createdAt: string;
}
export interface ProjectItemNoteRevision extends ProjectItemNoteRevisionSummary {
  contentFormat: "MARKDOWN";
  content: string;
  contentSha256: string;
}
export interface ProjectItemNote {
  noteId: string;
  projectId: string;
  subjectBindingId: string;
  subjectId: string;
  createdAt: string;
  updatedAt: string;
  currentRevision: ProjectItemNoteRevision;
  revisions: ProjectItemNoteRevisionSummary[];
}

export function normalizeNoteContent(value: unknown): string {
  if (typeof value !== "string") throw new InvalidNoteInputError("content must be text.");
  const normalized = value.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  if (!normalized.trim()) throw new InvalidNoteInputError("content must not be blank.");
  if (Buffer.byteLength(normalized, "utf8") > MAX_NOTE_BYTES) {
    throw new InvalidNoteInputError("content exceeds 65536 UTF-8 bytes.");
  }
  return normalized;
}
export function sha256NoteContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}
export function readRevisionId(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new InvalidNoteInputError("revisionId is invalid.");
  return value.toLowerCase();
}
