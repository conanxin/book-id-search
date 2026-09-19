import type { Request, Response } from "express";
import {
  CanonicalStoreUnavailableError,
  CatalogBookNotFoundError,
  CatalogReadUnavailableError,
  IdentityConflictError,
  type PromotionResult,
} from "../application/promote-catalog-book.js";
import type { S32Config } from "../config.js";
import { InvalidCatalogBookError } from "../domain/catalog-promotion.js";
import { checkS32PrivateAuth } from "./private-auth.js";

export interface CatalogPromotionCommand {
  execute(input: { bookId: string }): Promise<PromotionResult>;
}

function errorBody(message: string) {
  return { error: { message } };
}

function stringHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function createCatalogPromotionHandler(deps: {
  config: S32Config;
  command: CatalogPromotionCommand | null;
}) {
  return async function catalogPromotionHandler(req: Request, res: Response) {
    const auth = checkS32PrivateAuth(
      deps.config,
      stringHeader(req.headers.authorization),
      stringHeader(req.headers["x-private-token"]),
    );
    if (!auth.ok) {
      return res.status(auth.status).json(errorBody(auth.message));
    }

    if (!deps.config.databaseUrl || !deps.command) {
      return res.status(503).json(errorBody("S32 database not configured."));
    }

    const bookId = typeof req.body?.bookId === "string" ? req.body.bookId.trim() : "";
    if (!bookId) {
      return res.status(400).json(errorBody("bookId is required."));
    }

    try {
      const result = await deps.command.execute({ bookId });
      return res.status(result.status === "created" ? 201 : 200).json(result);
    } catch (error) {
      if (error instanceof CatalogBookNotFoundError) {
        return res.status(404).json(errorBody("Catalog book not found."));
      }
      if (error instanceof InvalidCatalogBookError) {
        return res.status(422).json(errorBody("Catalog metadata is not promotable."));
      }
      if (error instanceof IdentityConflictError) {
        return res.status(409).json(errorBody("Canonical identity conflict."));
      }
      if (error instanceof CatalogReadUnavailableError) {
        return res.status(503).json(errorBody("Catalog service unavailable."));
      }
      if (error instanceof CanonicalStoreUnavailableError) {
        return res.status(503).json(errorBody("Canonical store unavailable."));
      }
      return res.status(500).json(errorBody("S32 promotion failed."));
    }
  };
}
