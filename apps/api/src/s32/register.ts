import { createProjectItemsService, type ProjectItemsService } from "./application/project-items.js";
import { createPostgresProjectBindingStore } from "./postgres/project-binding-store.js";
import { createProjectItemRouter } from "./routes/project-item-routes.js";
import { Router } from "express";
import { Pool } from "pg";
import { createPromoteCatalogBookCommand } from "./application/promote-catalog-book.js";
import {
  createMeiliCatalogBookReader,
  type GetDocument,
} from "./catalog/meili-catalog-book-reader.js";
import { readS32Config } from "./config.js";
import { createPostgresCatalogPromotionStore } from "./postgres/catalog-promotion-store.js";
import { createCatalogPromotionHandler } from "./routes/catalog-promotion-route.js";
import { createProjectsService, type ProjectsService } from "./application/projects.js";
import { createPostgresProjectStore } from "./postgres/project-store.js";
import { createProjectRouter } from "./routes/project-routes.js";
import { createProjectItemNotesService, type ProjectItemNotesService } from "./application/project-item-notes.js";
import { createPostgresProjectItemNoteStore } from "./postgres/project-item-note-store.js";
import { createProjectItemNoteRouter } from "./routes/project-item-note-routes.js";
import { createResearchMembershipService, type ResearchMembershipService } from "./application/research-memberships.js";
import { createPostgresResearchMembershipStore } from "./postgres/research-membership-store.js";
import { createResearchMembershipRouter } from "./routes/research-membership-route.js";
import { createProjectOverviewService, type ProjectOverviewService } from "./application/project-overview.js";
import { createPostgresProjectOverviewStore } from "./postgres/project-overview-store.js";
import { createProjectOverviewRouter } from "./routes/project-overview-route.js";

export function createS32Router(deps: {
  env: NodeJS.ProcessEnv;
  getCatalogDocument: GetDocument;
}) {
  const router = Router();
  const config = readS32Config(deps.env);

  let command: ReturnType<typeof createPromoteCatalogBookCommand> | null = null;
  let projects: ProjectsService | null = null;
  let projectItems: ProjectItemsService | null = null;
  let projectItemNotes: ProjectItemNotesService | null = null;
  let researchMemberships: ResearchMembershipService | null = null;
  let projectOverview: ProjectOverviewService | null = null;
  if (config.enabled && config.databaseUrl) {
    const pool = new Pool({ connectionString: config.databaseUrl, connectionTimeoutMillis: 3000, query_timeout: 5000 });
    pool.on("error", () => console.warn("[s32] idle database connection unavailable"));
    projects = createProjectsService(createPostgresProjectStore(pool));
    projectItemNotes = createProjectItemNotesService(createPostgresProjectItemNoteStore(pool));
    researchMemberships = createResearchMembershipService(createPostgresResearchMembershipStore(pool));
    projectOverview = createProjectOverviewService(createPostgresProjectOverviewStore(pool));
    command = createPromoteCatalogBookCommand({
      reader: createMeiliCatalogBookReader(deps.getCatalogDocument),
      store: createPostgresCatalogPromotionStore(pool),
    });
    projectItems = createProjectItemsService({ projects, promotionCommand: command, bindings: createPostgresProjectBindingStore(pool) });
  }

  router.post(
    "/promotions/catalog-book",
    createCatalogPromotionHandler({ config, command }),
  );
  router.use("/research-memberships", createResearchMembershipRouter(config, researchMemberships));
  router.use("/projects", createProjectOverviewRouter(config, projectOverview));
  router.use("/projects", createProjectItemNoteRouter(config, projectItemNotes));
  router.use("/projects", createProjectItemRouter(config, projectItems));
  router.use("/projects", createProjectRouter(config, projects));

  return router;
}
