import { Router, json, type ErrorRequestHandler, type Request, type Response } from "express";
import type { BookLibraryService } from "../application/book-library.js";
import {
  CanonicalStoreUnavailableError, CatalogBookNotFoundError, CatalogReadUnavailableError,
  IdentityConflictError, InvalidPromotionRequestError,
} from "../application/promote-catalog-book.js";
import { InvalidCatalogBookError } from "../domain/catalog-promotion.js";
import { LibraryError } from "../domain/book-library.js";
import type { S32Config } from "../config.js";
import type { S32RequestAuthorizer } from "./private-auth.js";

const messages: Record<string, [number, string]> = {
  LIBRARY_INVALID_INPUT: [400, "输入不正确，请检查必填项和内容长度。"],
  LIBRARY_INVALID_JSON: [400, "请求内容必须是有效的 JSON，且不能超过 512 KiB。"],
  LIBRARY_BOOK_NOT_FOUND: [404, "这本书不存在。"],
  LIBRARY_NOTE_NOT_FOUND: [404, "这本书的笔记不存在。"],
  LIBRARY_RESOURCE_NOT_FOUND: [404, "这本书的电子版本不存在。"],
  LIBRARY_REVISION_NOT_FOUND: [404, "笔记版本不存在。"],
  LIBRARY_STALE_VERSION: [409, "书籍介绍已更新，请重新加载后再保存当前草稿。"],
  LIBRARY_STALE_NOTE_REVISION: [409, "笔记已更新，请重新加载后再保存当前草稿。"],
  LIBRARY_BOOK_READ_ONLY: [409, "这本书当前只能查看。"],
  LIBRARY_CATALOG_ID_MISMATCH: [409, "书目关联已变化，请重新打开这本书。"],
  LIBRARY_UNAVAILABLE: [503, "书籍内容服务暂不可用，请稍后再试。"],
  LIBRARY_REQUEST_FAILED: [500, "书籍内容请求失败，请稍后再试。"],
};

function errorResponse(res: Response, code: string) {
  const [status, message] = messages[code] ?? messages.LIBRARY_REQUEST_FAILED;
  res.status(status).json({ error: { code: messages[code] ? code : "LIBRARY_REQUEST_FAILED", message } });
}

function authRouter(config: S32Config, authorizer?: S32RequestAuthorizer) {
  const router = Router();
  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (!config.enabled) { res.status(404).json({ error: { code: "NOT_FOUND", message: "Not Found" } }); return; }
    // Deliberately no legacy-token fallback. Production injects the strict
    // Google owner + origin/CSRF authorizer, independently of research routes.
    if (!authorizer) {
      res.status(503).json({ error: { code: "LIBRARY_AUTH_UNAVAILABLE", message: "Google 登录尚未配置。" } }); return;
    }
    const auth = authorizer(req);
    if (!auth.ok) { res.status(auth.status).json({ error: { code: "LIBRARY_AUTH_REQUIRED", message: auth.message } }); return; }
    next();
  });
  return router;
}

export function createBookLibraryBodyParser(config: S32Config, authorizer?: S32RequestAuthorizer) {
  const router = authRouter(config, authorizer);
  router.use(json({ limit: "512kb" }));
  const badJson: ErrorRequestHandler = (_error, _req, res, _next) => { errorResponse(res, "LIBRARY_INVALID_JSON"); };
  router.use(badJson);
  return router;
}

function errorCode(error: unknown): string {
  if (error instanceof LibraryError) return error.code;
  if (error instanceof CatalogBookNotFoundError) return "LIBRARY_BOOK_NOT_FOUND";
  if (error instanceof CatalogReadUnavailableError || error instanceof CanonicalStoreUnavailableError) return "LIBRARY_UNAVAILABLE";
  if (error instanceof IdentityConflictError) return "LIBRARY_CATALOG_ID_MISMATCH";
  if (error instanceof InvalidPromotionRequestError || error instanceof InvalidCatalogBookError) return "LIBRARY_INVALID_INPUT";
  return "LIBRARY_REQUEST_FAILED";
}

export function createBookLibraryRouter(config: S32Config, library: BookLibraryService | null, authorizer?: S32RequestAuthorizer) {
  const router = createBookLibraryBodyParser(config, authorizer);
  router.use((_req, res, next) => {
    if (!config.databaseUrl || !library) { errorResponse(res, "LIBRARY_UNAVAILABLE"); return; }
    next();
  });
  const handle = (action: (req: Request, res: Response) => Promise<void>) => async (req: Request, res: Response) => {
    try { await action(req, res); }
    catch (error) { errorResponse(res, errorCode(error)); }
  };
  router.get("/", handle(async (req, res) => { res.json(await library!.list(req.query)); }));
  router.get("/books/:bookId", handle(async (req, res) => { res.json({ item: await library!.get(req.params.bookId) }); }));
  router.put("/books/:bookId", handle(async (req, res) => { res.json({ item: await library!.save(req.params.bookId, req.body) }); }));
  router.post("/books/:bookId/notes", handle(async (req, res) => {
    res.status(201).json({ item: await library!.createNote(req.params.bookId, req.body) });
  }));
  router.put("/books/:bookId/notes/:noteId", handle(async (req, res) => {
    res.json({ item: await library!.updateNote(req.params.bookId, req.params.noteId, req.body) });
  }));
  router.delete("/books/:bookId/notes/:noteId", handle(async (req, res) => {
    res.json({ item: await library!.deleteNote(req.params.bookId, req.params.noteId) });
  }));
  router.get("/books/:bookId/notes/:noteId/revisions/:revisionId", handle(async (req, res) => {
    res.json({ item: await library!.getRevision(req.params.bookId, req.params.noteId, req.params.revisionId) });
  }));
  router.post("/books/:bookId/resources", handle(async (req, res) => {
    res.status(201).json({ item: await library!.createResource(req.params.bookId, req.body) });
  }));
  router.put("/books/:bookId/resources/:resourceId", handle(async (req, res) => {
    res.json({ item: await library!.updateResource(req.params.bookId, req.params.resourceId, req.body) });
  }));
  router.delete("/books/:bookId/resources/:resourceId", handle(async (req, res) => {
    res.json({ item: await library!.deleteResource(req.params.bookId, req.params.resourceId) });
  }));
  return router;
}
