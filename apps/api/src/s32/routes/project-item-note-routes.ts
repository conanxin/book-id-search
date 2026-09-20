import { Router, json, type ErrorRequestHandler, type Request, type Response } from "express";
import type { S32Config } from "../config.js";
import { checkS32PrivateAuth } from "./private-auth.js";
import { InvalidNoteInputError } from "../domain/note.js";
import { InvalidProjectInputError } from "../domain/project.js";
import { InvalidProjectItemInputError } from "../domain/project-item.js";
import {
  ProjectItemInactiveError, ProjectItemNotFoundError, ProjectItemNoteAlreadyExistsError,
  ProjectItemNoteNotFoundError, ProjectItemNoteRevisionNotFoundError,
  ProjectItemNoteStoreUnavailableError, StaleNoteRevisionError, type ProjectItemNotesService,
} from "../application/project-item-notes.js";

const invalidInput = { code: "NOTE_INVALID_INPUT", message: "笔记输入不正确，正文不能为空且不能超过 65536 UTF-8 字节。" };

function privateRouter(config: S32Config) {
  const router = Router();
  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    const auth = checkS32PrivateAuth(config, req.get("authorization"), req.get("x-private-token"));
    if (!auth.ok) { res.status(auth.status).json({ error: { message: auth.message } }); return; }
    next();
  });
  return router;
}

// Scope the larger transport limit to Note requests. Escaped JSON can be six
// times larger than the normalized UTF-8 content checked by the application.
export function createProjectItemNoteBodyParser(config: S32Config) {
  const router = privateRouter(config);
  router.use(json({ limit: "512kb" }));
  const invalidJson: ErrorRequestHandler = (_error, _req, res, _next) => {
    res.status(400).json({ error: invalidInput });
  };
  router.use(invalidJson);
  return router;
}

function toHttpError(error: unknown): [number, { message: string; code?: string }] {
  if (error instanceof InvalidNoteInputError || error instanceof InvalidProjectInputError || error instanceof InvalidProjectItemInputError) return [400, invalidInput];
  if (error instanceof ProjectItemNotFoundError) return [404, { message: "项目资料不存在。" }];
  if (error instanceof ProjectItemNoteNotFoundError) return [404, { message: "研究笔记不存在。" }];
  if (error instanceof ProjectItemNoteRevisionNotFoundError) return [404, { message: "笔记版本不存在。" }];
  if (error instanceof ProjectItemInactiveError) return [409, { message: "项目资料或笔记当前不可用。" }];
  if (error instanceof ProjectItemNoteAlreadyExistsError) return [409, { code: "NOTE_ALREADY_EXISTS", message: "这项资料已有研究笔记，请重新加载。" }];
  if (error instanceof StaleNoteRevisionError) return [409, { code: "STALE_NOTE_REVISION", message: "笔记已经发生变化。请重新加载最新版本后，再决定如何处理当前草稿。" }];
  if (error instanceof ProjectItemNoteStoreUnavailableError) return [503, { message: "研究笔记服务暂不可用。" }];
  return [500, { message: "研究笔记请求失败，请稍后再试。" }];
}

export function createProjectItemNoteRouter(config: S32Config, notes: ProjectItemNotesService | null) {
  const router = privateRouter(config);
  router.use((_req, res, next) => {
    if (!config.databaseUrl || !notes) { res.status(503).json({ error: { message: "研究笔记数据库尚未配置。" } }); return; }
    next();
  });
  function handle(action: (req: Request, res: Response) => Promise<void>) {
    return async (req: Request, res: Response) => {
      try { await action(req, res); }
      catch (error) { const [status, body] = toHttpError(error); res.status(status).json({ error: body }); }
    };
  }
  const path = "/:projectId/items/:bindingId/note";
  router.get(path, handle(async (req, res) => {
    res.json({ note: await notes!.get(req.params.projectId, req.params.bindingId) });
  }));
  router.post(path, handle(async (req, res) => {
    res.status(201).json({ note: await notes!.create(req.params.projectId, req.params.bindingId, req.body) });
  }));
  router.post(`${path}/revisions`, handle(async (req, res) => {
    res.status(201).json({ note: await notes!.append(req.params.projectId, req.params.bindingId, req.body) });
  }));
  router.get(`${path}/revisions/:revisionId`, handle(async (req, res) => {
    res.json({ revision: await notes!.getRevision(req.params.projectId, req.params.bindingId, req.params.revisionId) });
  }));
  return router;
}
