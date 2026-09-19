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

export function createS32Router(deps: {
  env: NodeJS.ProcessEnv;
  getCatalogDocument: GetDocument;
}) {
  const router = Router();
  const config = readS32Config(deps.env);

  let command: ReturnType<typeof createPromoteCatalogBookCommand> | null = null;
  let projects: ProjectsService | null = null;
  if (config.enabled && config.databaseUrl) {
    const pool = new Pool({ connectionString: config.databaseUrl, connectionTimeoutMillis: 3000, query_timeout: 5000 });
    pool.on("error", () => console.warn("[s32] idle database connection unavailable"));
    projects = createProjectsService(createPostgresProjectStore(pool));
    command = createPromoteCatalogBookCommand({
      reader: createMeiliCatalogBookReader(deps.getCatalogDocument),
      store: createPostgresCatalogPromotionStore(pool),
    });
  }

  router.post(
    "/promotions/catalog-book",
    createCatalogPromotionHandler({ config, command }),
  );
  router.use("/projects", createProjectRouter(config, projects));

  return router;
}
