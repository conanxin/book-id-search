import { Router, json, type ErrorRequestHandler, type Request, type Response } from "express";
import type { S32RequestAuthorizer } from "../s32/routes/private-auth.js";
import { WereadBindingError, type WereadBindingsService } from "./manual-bindings.js";

export function createWereadBindingsRouter(deps: {
  service: WereadBindingsService;
  requestAuthorizer?: S32RequestAuthorizer;
  enabled?: boolean;
}) {
  const router = Router();
  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    res.vary("Cookie");
    if (deps.enabled === false) { res.status(404).json({ ok: false, error: { code: "NOT_FOUND", message: "Not Found" } }); return; }
    if (!deps.requestAuthorizer) {
      res.status(503).json({ ok: false, error: { code: "WEREAD_BINDING_AUTH_UNAVAILABLE", message: "Google 登录尚未配置。" } }); return;
    }
    const auth = deps.requestAuthorizer(req);
    if (!auth.ok) {
      res.status(auth.status).json({ ok: false, error: { code: "WEREAD_BINDING_AUTH_REQUIRED", message: auth.message } }); return;
    }
    next();
  });
  // This router mounts before the global parser: auth and a small bounded
  // payload apply even to malformed/oversized requests.
  router.use(json({ limit: "16kb" }));
  const invalidJson: ErrorRequestHandler = (_error, _req, res, _next) => {
    res.status(400).json({ ok: false, error: { code: "WEREAD_BINDING_INVALID_INPUT", message: "请求内容必须是有效的 JSON，且不能超过 16 KiB。" } });
  };
  router.use(invalidJson);
  const handle = (action: (req: Request, res: Response) => Promise<void>) => async (req: Request, res: Response) => {
    try { await action(req, res); }
    catch (error) {
      const safe = error instanceof WereadBindingError ? error : new WereadBindingError("WEREAD_BINDING_UNAVAILABLE");
      res.status(safe.status).json({ ok: false, error: { code: safe.code, message: safe.message } });
    }
  };
  router.get("/", handle(async (req, res) => { res.json({ ok: true, ...await deps.service.list(req.query) }); }));
  router.get("/:sourceKey", handle(async (req, res) => {
    res.json({ ok: true, item: await deps.service.get(req.params.sourceKey), writable: deps.service.writable });
  }));
  router.put("/:sourceKey", handle(async (req, res) => {
    res.json({ ok: true, item: await deps.service.update(req.params.sourceKey, req.body), writable: true });
  }));
  return router;
}
