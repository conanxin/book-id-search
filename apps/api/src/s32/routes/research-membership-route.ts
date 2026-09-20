import { Router, type Request, type Response } from "express";
import type { S32Config } from "../config.js";
import { InvalidRediscoverInputError } from "../domain/rediscover.js";
import {
  ResearchMembershipIntegrityError,
  ResearchMembershipStoreUnavailableError,
  type ResearchMembershipService,
} from "../application/research-memberships.js";
import { checkS32PrivateAuth } from "./private-auth.js";

function toHttpError(error: unknown): [number, string] {
  if (error instanceof InvalidRediscoverInputError) {
    return [400, "研究状态查询输入不正确。"];
  }
  if (error instanceof ResearchMembershipStoreUnavailableError) {
    return [503, "研究状态服务暂不可用。"];
  }
  if (error instanceof ResearchMembershipIntegrityError) {
    return [500, "研究状态请求失败，请稍后再试。"];
  }
  return [500, "研究状态请求失败，请稍后再试。"];
}

export function createResearchMembershipRouter(
  config: S32Config,
  memberships: ResearchMembershipService | null,
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
    if (!config.databaseUrl || !memberships) {
      res.status(503).json({ error: { message: "研究状态数据库尚未配置。" } });
      return;
    }
    next();
  });

  router.post("/catalog-books", async (req: Request, res: Response) => {
    try {
      res.json(await memberships!.lookup(req.body));
    } catch (error) {
      const [status, message] = toHttpError(error);
      res.status(status).json({ error: { message } });
    }
  });

  return router;
}
