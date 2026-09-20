import { readProjectId } from "../domain/project.js";
import type { ProjectOverview } from "../domain/rediscover.js";

export class ProjectOverviewStoreUnavailableError extends Error {}
export class ProjectOverviewIntegrityError extends Error {}

export interface ProjectOverviewStore {
  get(projectId: string): Promise<ProjectOverview | null>;
}

export function createProjectOverviewService(store: ProjectOverviewStore) {
  return {
    async get(projectInput: unknown) {
      const projectId = readProjectId(projectInput).toLowerCase();
      return store.get(projectId);
    },
  };
}

export type ProjectOverviewService = ReturnType<typeof createProjectOverviewService>;
