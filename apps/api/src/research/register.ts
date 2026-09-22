// P9-A Research Runtime — isolated Express router under /api/research/v0.
// Typed errors: SOURCE_NOT_FOUND / POLICY_NOT_FOUND / SKILL_NOT_FOUND plus
// the six policy deny reasons. Never collapsed into plain 404 text.

import { Router, type Request, type Response } from "express";
import { resolveEffectiveCapability } from "./policy.js";
import {
  getPolicy,
  getSkill,
  getSource,
  listSkills,
  listSources,
} from "./registry.js";
import type { ResearchErrorCode } from "./types.js";

const STATUS_BY_ERROR: Record<ResearchErrorCode, number> = {
  SOURCE_NOT_FOUND: 404,
  POLICY_NOT_FOUND: 404,
  SKILL_NOT_FOUND: 404,
  TECHNICAL_CAPABILITY_MISSING: 403,
  POLICY_DENIED: 403,
  ENTITLEMENT_MISSING: 403,
  ENTITLEMENT_EXPIRED: 403,
  SURFACE_NOT_ALLOWED: 403,
  PURPOSE_NOT_ALLOWED: 403,
};

function typedError(res: Response, code: ResearchErrorCode, message: string): void {
  res.status(STATUS_BY_ERROR[code]).json({ error: { code, message } });
}

function isResearchErrorCode(value: unknown): value is ResearchErrorCode {
  return typeof value === "string" && Object.hasOwn(STATUS_BY_ERROR, value);
}

// Validate the resolve request body; returns an error string or null.
function validateResolveBody(
  body: unknown,
): { sourceId: string; action: string; surface: string; purpose: string; at: string } | { error: string } {
  if (typeof body !== "object" || body === null) return { error: "请求体必须是 JSON 对象。" };
  const b = body as Record<string, unknown>;
  for (const key of ["sourceId", "action", "surface", "purpose", "at"] as const) {
    if (typeof b[key] !== "string" || (b[key] as string).length === 0) {
      return { error: `字段 ${key} 必须是非空字符串。` };
    }
  }
  return {
    sourceId: b.sourceId as string,
    action: b.action as string,
    surface: b.surface as string,
    purpose: b.purpose as string,
    at: b.at as string,
  };
}

export function createResearchRouter(): Router {
  const router = Router();

  router.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", runtime: "research", version: "v0.1" });
  });

  router.get("/sources/:sourceId", (req: Request, res: Response) => {
    const sourceId = typeof req.params.sourceId === "string" ? req.params.sourceId : req.params.sourceId[0];
    const source = getSource(sourceId);
    if (!source) {
      typedError(res, "SOURCE_NOT_FOUND", `来源不存在：${sourceId}`);
      return;
    }
    // The four axes stay independently visible in the response.
    res.json({ source });
  });

  router.get("/skills", (_req: Request, res: Response) => {
    res.json({ skills: listSkills() });
  });

  router.get("/skills/:skillId", (req: Request, res: Response) => {
    const skillId = typeof req.params.skillId === "string" ? req.params.skillId : req.params.skillId[0];
    const skill = getSkill(skillId);
    if (!skill) {
      typedError(res, "SKILL_NOT_FOUND", `技能不存在：${skillId}`);
      return;
    }
    res.json({ skill });
  });

  router.post("/capabilities/resolve", (req: Request, res: Response) => {
    const parsed = validateResolveBody(req.body);
    if ("error" in parsed) {
      res.status(400).json({ error: { code: "INVALID_REQUEST", message: parsed.error } });
      return;
    }
    const source = getSource(parsed.sourceId);
    if (!source) {
      typedError(res, "SOURCE_NOT_FOUND", `来源不存在：${parsed.sourceId}`);
      return;
    }
    if (!getPolicy(source.policyRef.policyId)) {
      typedError(res, "POLICY_NOT_FOUND", `策略不存在：${source.policyRef.policyId}`);
      return;
    }
    const resolution = resolveEffectiveCapability({
      source,
      policy: getPolicy(source.policyRef.policyId),
      request: {
        sourceId: parsed.sourceId,
        action: parsed.action,
        surface: parsed.surface,
        purpose: parsed.purpose,
        at: parsed.at,
      },
    });
    res.status(resolution.allowed ? 200 : 403).json({ resolution });
  });

  // Non-research-runtime errors keep Express defaults; typed errors above
  // are the contract.
  router.use((_req: Request, res: Response) => {
    res.status(404).json({ error: { code: "ROUTE_NOT_FOUND", message: "研究运行时路由不存在。" } });
  });

  return router;
}
