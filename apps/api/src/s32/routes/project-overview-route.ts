import { Router } from "express";
import type { S32Config } from "../config.js";
import { InvalidProjectInputError } from "../domain/project.js";
import {
  ProjectOverviewIntegrityError,
  ProjectOverviewStoreUnavailableError,
  type ProjectOverviewService,
} from "../application/project-overview.js";
import { checkS32PrivateAuth } from "./private-auth.js";

function toHttpError(error: unknown): [number, string] {
  if (error instanceof InvalidProjectInputError) return [400, "项目 ID 格式不正确。"];
  if (error instanceof ProjectOverviewStoreUnavailableError) return [503, "项目研究概览暂不可用。"];
  if (error instanceof ProjectOverviewIntegrityError) return [500, "项目研究概览请求失败，请稍后再试。"];
  return [500, "项目研究概览请求失败，请稍后再试。"];
}

export function createProjectOverviewRouter(
  config: S32Config,
  overview: ProjectOverviewService | null,
) {
  const router = Router();

  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    const auth = checkS32PrivateAuth(
      config,
      req.get("authorization"),
      req.get("x-private-token"),
    );
    if (!auth.ok) {
      res.status(auth.status).json({ error: { message: auth.message } });
      return;
    }
    if (!config.databaseUrl || !overview) {
      res.status(503).json({ error: { message: "项目研究概览数据库尚未配置。" } });
      return;
    }
    next();
  });

  router.get("/:projectId/overview", async (req, res) => {
    try {
      const result = await overview!.get(req.params.projectId);
      if (!result) {
        res.status(404).json({ error: { message: "项目不存在。" } });
        return;
      }
      res.json(result);
    } catch (error) {
      const [status, message] = toHttpError(error);
      res.status(status).json({ error: { message } });
    }
  });

  return router;
}
