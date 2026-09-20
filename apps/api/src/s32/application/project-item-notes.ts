import { readProjectId } from "../domain/project.js";
import { readBindingId } from "../domain/project-item.js";
import { InvalidNoteInputError, normalizeNoteContent, readRevisionId, sha256NoteContent, type ProjectItemNote, type ProjectItemNoteRevision } from "../domain/note.js";

export class ProjectItemNotFoundError extends Error {}
export class ProjectItemInactiveError extends Error {}
export class ProjectItemNoteAlreadyExistsError extends Error {}
export class ProjectItemNoteNotFoundError extends Error {}
export class ProjectItemNoteRevisionNotFoundError extends Error {}
export class StaleNoteRevisionError extends Error {}
export class ProjectItemNoteStoreUnavailableError extends Error {}
export class ProjectItemHasNoteError extends Error {}

export interface ProjectItemNoteStore {
  get(input: { projectId: string; bindingId: string }): Promise<ProjectItemNote | null>;
  create(input: { projectId: string; bindingId: string; content: string; contentSha256: string }): Promise<ProjectItemNote>;
  appendRevision(input: { projectId: string; bindingId: string; baseRevisionId: string; content: string; contentSha256: string }): Promise<ProjectItemNote>;
  getRevision(input: { projectId: string; bindingId: string; revisionId: string }): Promise<ProjectItemNoteRevision>;
}

function subject(projectId: unknown, bindingId: unknown) {
  return { projectId: readProjectId(projectId).toLowerCase(), bindingId: readBindingId(bindingId).toLowerCase() };
}
function readBody(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new InvalidNoteInputError("Note input must be an object.");
  return input as Record<string, unknown>;
}
function contentInput(body: Record<string, unknown>) {
  const content = normalizeNoteContent(body.content);
  return { content, contentSha256: sha256NoteContent(content) };
}
export function createProjectItemNotesService(store: ProjectItemNoteStore) {
  return {
    async get(projectId: unknown, bindingId: unknown) {
      return store.get(subject(projectId, bindingId));
    },
    async create(projectId: unknown, bindingId: unknown, input: unknown) {
      const ids = subject(projectId, bindingId);
      return store.create({ ...ids, ...contentInput(readBody(input)) });
    },
    async append(projectId: unknown, bindingId: unknown, input: unknown) {
      const ids = subject(projectId, bindingId);
      const body = readBody(input);
      const baseRevisionId = readRevisionId(body.baseRevisionId);
      return store.appendRevision({ ...ids, baseRevisionId, ...contentInput(body) });
    },
    async getRevision(projectId: unknown, bindingId: unknown, revisionId: unknown) {
      return store.getRevision({ ...subject(projectId, bindingId), revisionId: readRevisionId(revisionId) });
    },
  };
}
export type ProjectItemNotesService = ReturnType<typeof createProjectItemNotesService>;
