import type { PromotionResult } from "./promote-catalog-book.js";
import { readProjectId, type Project } from "../domain/project.js";
import {
  readBindingId,
  readCatalogBookId,
  type ProjectResearchItem,
} from "../domain/project-item.js";

export class ProjectNotFoundError extends Error {}
export class ProjectNotActiveError extends Error {}
export class EditionNotAvailableError extends Error {}
export class ProjectBindingStoreUnavailableError extends Error {}
export class ProjectBindingNotFoundError extends Error {}

export interface ProjectLookup {
  get(id: unknown): Promise<Project | null>;
}

export interface PromotionCommand {
  execute(input: { bookId: string }): Promise<PromotionResult>;
}

export interface ProjectBindingStore {
  addEdition(input: {
    projectId: string;
    workId: string;
    editionId: string;
    sourceId: string;
    catalogBookId: string;
  }): Promise<{ status: "created" | "existing"; item: ProjectResearchItem }>;

  listEditionItems(projectId: string): Promise<ProjectResearchItem[]>;

  removeEdition(input: {
    projectId: string;
    bindingId: string;
  }): Promise<boolean>;
}

export function createProjectItemsService(deps: {
  projects: ProjectLookup;
  promotionCommand: PromotionCommand;
  bindings: ProjectBindingStore;
}) {
  async function requireActiveProject(input: unknown) {
    const projectId = readProjectId(input);
    const project = await deps.projects.get(projectId);
    if (!project) throw new ProjectNotFoundError("PROJECT_NOT_FOUND");
    if (project.lifecycleState !== "ACTIVE") {
      throw new ProjectNotActiveError("PROJECT_NOT_ACTIVE");
    }
    return projectId;
  }

  return {
    async addCatalogBook(projectInput: unknown, body: unknown) {
      readProjectId(projectInput);
      const bookId = readCatalogBookId(
        body && typeof body === "object" && !Array.isArray(body)
          ? (body as Record<string, unknown>).bookId
          : undefined,
      );
      const projectId = await requireActiveProject(projectInput);
      const promotion = await deps.promotionCommand.execute({ bookId });
      const binding = await deps.bindings.addEdition({
        projectId,
        workId: promotion.workId,
        editionId: promotion.editionId,
        sourceId: promotion.sourceId,
        catalogBookId: promotion.catalogBookId,
      });
      return {
        promotionStatus: promotion.status,
        bindingStatus: binding.status,
        item: binding.item,
      };
    },

    async list(projectInput: unknown) {
      const projectId = await requireActiveProject(projectInput);
      return deps.bindings.listEditionItems(projectId);
    },

    async remove(projectInput: unknown, bindingInput: unknown) {
      readProjectId(projectInput);
      const bindingId = readBindingId(bindingInput);
      const projectId = await requireActiveProject(projectInput);
      const removed = await deps.bindings.removeEdition({ projectId, bindingId });
      if (!removed) throw new ProjectBindingNotFoundError("PROJECT_BINDING_NOT_FOUND");
    },
  };
}
export type ProjectItemsService = ReturnType<typeof createProjectItemsService>;
