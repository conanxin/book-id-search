import { Router, type Request, type Response } from "express";
import type { S32Config } from "../config.js";
import { checkS32PrivateAuth } from "./private-auth.js";
import { InvalidProjectInputError } from "../domain/project.js";
import { InvalidProjectItemInputError } from "../domain/project-item.js";
import { InvalidCatalogBookError } from "../domain/catalog-promotion.js";
import { ProjectStoreUnavailableError } from "../application/projects.js";
import { CanonicalStoreUnavailableError, CatalogBookNotFoundError, CatalogReadUnavailableError, IdentityConflictError, InvalidPromotionRequestError } from "../application/promote-catalog-book.js";
import { EditionNotAvailableError, ProjectBindingNotFoundError, ProjectBindingStoreUnavailableError, ProjectNotActiveError, ProjectNotFoundError, type ProjectItemsService } from "../application/project-items.js";

function toHttpError(error: unknown): [number, string] {
  if (error instanceof InvalidProjectInputError || error instanceof InvalidProjectItemInputError || error instanceof InvalidPromotionRequestError) return [400, "项目资料输入不正确。"];
  if (error instanceof ProjectNotFoundError) return [404, "项目不存在。"];
  if (error instanceof ProjectBindingNotFoundError) return [404, "项目资料不存在。"];
  if (error instanceof CatalogBookNotFoundError) return [404, "书目不存在。"];
  if (error instanceof ProjectNotActiveError) return [409, "项目当前不可用。"];
  if (error instanceof EditionNotAvailableError || error instanceof IdentityConflictError) return [409, "书目版本不可用或身份冲突。"];
  if (error instanceof InvalidCatalogBookError) return [422, "书目元数据无法加入研究。"];
  if (error instanceof CatalogReadUnavailableError || error instanceof CanonicalStoreUnavailableError || error instanceof ProjectStoreUnavailableError || error instanceof ProjectBindingStoreUnavailableError) return [503, "项目资料服务暂不可用。"];
  return [500, "项目资料请求失败，请稍后再试。"];
}
export function createProjectItemRouter(config: S32Config, projectItems: ProjectItemsService | null) {
  const router = Router();
  router.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  router.use((req, res, next) => {
    const auth = checkS32PrivateAuth(config, req.get("authorization"), req.get("x-private-token"));
    if (!auth.ok) { res.status(auth.status).json({ error: { message: auth.message } }); return; }
    if (!config.databaseUrl || !projectItems) { res.status(503).json({ error: { message: "项目资料数据库尚未配置。" } }); return; }
    next();
  });
  function handle(action: (req: Request, res: Response) => Promise<void>) {
    return async (req: Request, res: Response) => {
      try { await action(req, res); }
      catch (error) { const [status, message] = toHttpError(error); res.status(status).json({ error: { message } }); }
    };
  }
  router.post("/:projectId/catalog-books", handle(async (req, res) => {
    const result = await projectItems!.addCatalogBook(req.params.projectId, req.body);
    res.status(result.bindingStatus === "created" ? 201 : 200).json(result);
  }));
  router.get("/:projectId/items", handle(async (req, res) => {
    res.json({ items: await projectItems!.list(req.params.projectId) });
  }));
  router.delete("/:projectId/items/:bindingId", handle(async (req, res) => {
    await projectItems!.remove(req.params.projectId, req.params.bindingId);
    res.status(204).end();
  }));
  return router;
}
