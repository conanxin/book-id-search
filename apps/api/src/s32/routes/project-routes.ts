import { Router, type Request, type Response } from "express";
import type { S32Config } from "../config.js";
import { ProjectStoreUnavailableError, type ProjectsService } from "../application/projects.js";
import { InvalidProjectInputError } from "../domain/project.js";
import { checkS32PrivateAuth } from "./private-auth.js";

export function createProjectRouter(config: S32Config, projects: ProjectsService | null) {
  const router = Router();
  router.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  router.use((req, res, next) => {
    const auth = checkS32PrivateAuth(config, req.get("authorization"), req.get("x-private-token"));
    if (!auth.ok) { res.status(auth.status).json({ error: { message: auth.message } }); return; }
    if (!config.databaseUrl || !projects) {
      res.status(503).json({ error: { message: "项目数据库尚未配置。" } }); return;
    }
    next();
  });

  function handle(action: (req: Request, res: Response) => Promise<void>) {
    return async (req: Request, res: Response) => {
      try { await action(req, res); }
      catch (error) {
        const status = error instanceof InvalidProjectInputError ? 400 : error instanceof ProjectStoreUnavailableError ? 503 : 500;
        const message = status === 500 ? "项目服务发生错误，请稍后再试。" : (error as Error).message;
        res.status(status).json({ error: { message } });
      }
    };
  }
  router.post("/", handle(async (req, res) => {
    res.status(201).json({ project: await projects!.create(req.body) });
  }));
  router.get("/", handle(async (_req, res) => {
    res.json({ projects: await projects!.list() });
  }));
  router.get("/:projectId", handle(async (req, res) => {
    const project = await projects!.get(req.params.projectId);
    if (!project) { res.status(404).json({ error: { message: "项目不存在。" } }); return; }
    res.json({ project });
  }));
  return router;
}
