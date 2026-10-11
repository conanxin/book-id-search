import { Router, json, type ErrorRequestHandler } from "express";
import type { S32RequestAuthorizer } from "../s32/routes/private-auth.js";
import { BookAssistantError, type BookAssistantService } from "./book-assistant.js";

/** Mount at /api/ai/books before the global parser. */
export function createBookAssistantRouter(deps: {
  service: BookAssistantService;
  requestAuthorizer?: S32RequestAuthorizer;
}) {
  const router = Router();
  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    res.vary("Cookie");
    if (!deps.requestAuthorizer) {
      res.status(503).json({ error: { code: "BOOK_AI_AUTH_UNAVAILABLE", message: "Google 登录尚未配置。" } }); return;
    }
    const auth = deps.requestAuthorizer(req);
    if (!auth.ok) {
      res.status(auth.status).json({ error: { code: "BOOK_AI_AUTH_REQUIRED", message: auth.message } }); return;
    }
    next();
  });
  router.use(json({ limit: "16kb" }));
  const invalidJson: ErrorRequestHandler = (_error, _req, res, _next) => {
    res.status(400).json({ error: { code: "BOOK_AI_INVALID_INPUT", message: "请求内容必须是有效的 JSON，且不能超过 16 KiB。" } });
  };
  router.use(invalidJson);
  router.post("/:bookId/assistant", async (req, res) => {
    try { res.json(await deps.service.generate(req.params.bookId, req.body)); }
    catch (error) {
      const safe = error instanceof BookAssistantError ? error : new BookAssistantError("BOOK_AI_UNAVAILABLE");
      res.status(safe.status).json({ error: { code: safe.code, message: safe.message } });
    }
  });
  return router;
}
