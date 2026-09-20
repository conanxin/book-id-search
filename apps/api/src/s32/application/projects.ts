import { randomUUID } from "node:crypto";
import { readProjectId, readProjectInput, type Project, type ProjectInput } from "../domain/project.js";

export class ProjectStoreUnavailableError extends Error {}
export interface ProjectStore {
  create(id: string, input: ProjectInput): Promise<Project>;
  list(): Promise<Project[]>;
  get(id: string): Promise<Project | null>;
}

export function createProjectsService(store: ProjectStore) {
  return {
    create(input: unknown) { return store.create(randomUUID(), readProjectInput(input)); },
    list() { return store.list(); },
    get(id: unknown) { return store.get(readProjectId(id)); },
  };
}
export type ProjectsService = ReturnType<typeof createProjectsService>;
