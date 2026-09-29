import { Router, type Response } from "express";
import { createResearchV0Service, ResearchV0Error, type ResearchV0Service } from "./service.js";
import type { CatalogAdapter, ResearchIntent } from "./types.js";

function statusFor(code: ResearchV0Error["code"]): number {
  switch (code) {
    case "SOURCE_NOT_FOUND":
    case "SKILL_NOT_FOUND":
      return 404;
    case "TECHNICAL_CAPABILITY_MISSING":
    case "INSUFFICIENT_EVIDENCE":
      return 422;
    case "POLICY_DENIED":
    case "ENTITLEMENT_MISSING":
      return 403;
  }
}

function sendError(res: Response, error: unknown) {
  if (error instanceof ResearchV0Error) {
    res.status(statusFor(error.code)).json({
      status: "error",
      error: {
        code: error.code,
        message: error.message,
      },
    });
    return;
  }
  res.status(500).json({
    status: "error",
    error: {
      code: "INTERNAL_ERROR",
      message: "research-v0 request failed",
    },
  });
}

export function createResearchV0Router(deps: {
  catalog: CatalogAdapter;
  service?: ResearchV0Service;
}) {
  const router = Router();
  const service = deps.service ?? createResearchV0Service({ catalog: deps.catalog });

  router.get("/status", (_req, res) => {
    res.json({
      status: "ok",
      runtime: "research-v0.1",
      persistence: "memory",
      false_closure_protection: true,
    });
  });

  router.get("/skills", (_req, res) => {
    res.json({ skills: service.listSkills() });
  });

  router.get("/skills/:skillId", (req, res) => {
    const skill = service.getSkill(req.params.skillId);
    if (!skill) {
      res.status(404).json({ status: "error", error: { code: "SKILL_NOT_FOUND" } });
      return;
    }
    res.json({ skill });
  });

  router.get("/sources/:sourceId", async (req, res) => {
    try {
      res.json({ source: await service.getSource(req.params.sourceId) });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post("/sources/search", async (req, res) => {
    const query = typeof req.body?.query === "string" ? req.body.query.trim() : "";
    if (!query) {
      res.status(400).json({ status: "error", error: { code: "INVALID_QUERY" } });
      return;
    }
    const limit = Number.isFinite(req.body?.limit) ? Number(req.body.limit) : 20;
    try {
      res.json({ sources: await service.searchSources(query, limit) });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post("/evidence/retrieve", async (req, res) => {
    const sourceId = typeof req.body?.source_id === "string" ? req.body.source_id : "";
    const query = typeof req.body?.query === "string" ? req.body.query : "";
    if (!sourceId || !query) {
      res.status(400).json({ status: "error", error: { code: "INVALID_REQUEST" } });
      return;
    }

    try {
      const evidence = await service.retrieveEvidence({
        source_id: sourceId,
        query,
        purpose: typeof req.body?.purpose === "string" ? req.body.purpose : undefined,
        execution_surface:
          typeof req.body?.execution_surface === "string" ? req.body.execution_surface : undefined,
      });
      res.json({ evidence });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post("/bundles", async (req, res) => {
    const question = typeof req.body?.question === "string" ? req.body.question.trim() : "";
    const intent = req.body?.intent as ResearchIntent | undefined;
    if (!question || !intent) {
      res.status(400).json({ status: "error", error: { code: "INVALID_REQUEST" } });
      return;
    }

    try {
      const bundle = await service.buildBundle({
        question,
        intent,
        skill_id: typeof req.body?.skill_id === "string" ? req.body.skill_id : undefined,
        candidate_source_ids: Array.isArray(req.body?.candidate_source_ids)
          ? req.body.candidate_source_ids.filter((item: unknown): item is string => typeof item === "string")
          : undefined,
      });
      res.status(201).json({ bundle });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get("/bundles/:bundleId", (req, res) => {
    const bundle = service.getBundle(req.params.bundleId);
    if (!bundle) {
      res.status(404).json({ status: "error", error: { code: "BUNDLE_NOT_FOUND" } });
      return;
    }
    res.json({ bundle });
  });

  return router;
}
