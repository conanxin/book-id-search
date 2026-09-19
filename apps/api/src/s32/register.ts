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

export function createS32Router(deps: {
  env: NodeJS.ProcessEnv;
  getCatalogDocument: GetDocument;
}) {
  const router = Router();
  const config = readS32Config(deps.env);

  let command: ReturnType<typeof createPromoteCatalogBookCommand> | null = null;
  if (config.enabled && config.databaseUrl) {
    const pool = new Pool({ connectionString: config.databaseUrl });
    command = createPromoteCatalogBookCommand({
      reader: createMeiliCatalogBookReader(deps.getCatalogDocument),
      store: createPostgresCatalogPromotionStore(pool),
    });
  }

  router.post(
    "/promotions/catalog-book",
    createCatalogPromotionHandler({ config, command }),
  );

  return router;
}
