import type { Request, RequestHandler } from "express";
import type { GoogleSessionAuthConfig } from "./config.js";
import { authorizePrivateRequest } from "./private-request-auth.js";

/** The book workspace uses the existing Google session, without legacy token login. */
export function createGoogleOwnerRequestAuthorizer(config: GoogleSessionAuthConfig) {
  return (req: Request) => {
    const result = authorizePrivateRequest({
      capability: "S32_PRIVATE",
      capabilityEnabled: true,
      googleConfig: config,
      request: {
        method: req.method,
        authorization: req.get("authorization"),
        privateToken: req.get("x-private-token"),
        cookie: req.get("cookie"),
        origin: req.get("origin"),
        csrfToken: req.get("x-csrf-token"),
      },
      legacyCheck: () => ({ ok: false, status: 401, message: "请使用 Google 登录后继续。" }),
    });
    if (result.ok) return { ok: true as const };
    return {
      ok: false as const,
      status: result.status,
      message: result.status === 403 ? "操作未完成，请刷新页面后重试。" : "请使用 Google 登录后继续。",
    };
  };
}

export function createGoogleOwnerMiddleware(config: GoogleSessionAuthConfig): RequestHandler {
  const authorize = createGoogleOwnerRequestAuthorizer(config);
  return (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.vary("Cookie");
    const result = authorize(req);
    if (!result.ok) {
      res.status(result.status).json({ error: {
        code: result.status === 403 ? "SESSION_ACTION_FORBIDDEN" : "GOOGLE_LOGIN_REQUIRED",
        message: result.message,
      } });
      return;
    }
    next();
  };
}
