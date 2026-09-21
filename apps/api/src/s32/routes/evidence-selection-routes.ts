import { Router, type Request, type Response } from "express";
import type { S32Config } from "../config.js";
import { InvalidProjectInputError } from "../domain/project.js";
import { InvalidResearchIssueInputError } from "../domain/research-issue.js";
import { InvalidCandidateClaimInputError } from "../domain/candidate-claim.js";
import { InvalidEvidenceDraftError } from "../domain/evidence-selection.js";
import {
  EvidenceSelectionScopeNotFoundError,
  EvidenceTargetNotAvailableError,
  EvidenceSelectionIntegrityError,
  EvidenceSelectionStoreUnavailableError,
  type EvidenceSelectionService,
} from "../application/evidence-selection.js";
import { checkS32PrivateAuth } from "./private-auth.js";

function toHttpError(error: unknown): [number, { message: string; code?: string }] {
  if (error instanceof InvalidEvidenceDraftError) {
    return [400, { code: "EVIDENCE_DRAFT_INVALID", message: "证据草稿输入不正确。" }];
  }
  if (error instanceof InvalidProjectInputError || error instanceof InvalidResearchIssueInputError || error instanceof InvalidCandidateClaimInputError) {
    return [400, { code: "EVIDENCE_DRAFT_INVALID", message: "证据草稿输入不正确。" }];
  }
  if (error instanceof EvidenceSelectionScopeNotFoundError) {
    return [404, { code: "PROJECT_ISSUE_OR_CLAIM_NOT_FOUND", message: "研究问题或可能答案不存在。" }];
  }
  if (error instanceof EvidenceTargetNotAvailableError) {
    return [404, { code: "EVIDENCE_TARGET_NOT_AVAILABLE", message: "所选证据不可用于当前研究项目。" }];
  }
  if (error instanceof EvidenceSelectionStoreUnavailableError) {
    return [503, { message: "证据选择服务暂不可用。" }];
  }
  return [500, { message: "证据选择请求失败，请稍后再试。" }];
}

export function createEvidenceSelectionRouter(config: S32Config, evidence: EvidenceSelectionService | null) {
  const router = Router();
  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    const auth = checkS32PrivateAuth(config, req.get("authorization"), req.get("x-private-token"));
    if (!auth.ok) {
      res.status(auth.status).json({ error: { message: auth.message } });
      return;
    }
    if (!config.databaseUrl || !evidence) {
      res.status(503).json({ error: { message: "证据选择服务尚未配置。" } });
      return;
    }
    next();
  });

  function handle(action: (req: Request, res: Response) => Promise<void>) {
    return async (req: Request, res: Response) => {
      try {
        await action(req, res);
      } catch (error) {
        const [status, body] = toHttpError(error);
        res.status(status).json({ error: body });
      }
    };
  }

  router.get("/:projectId/issues/:issueId/claims/:claimId/evidence-candidates", handle(async (req, res) => {
    const result = await evidence!.candidates(req.params.projectId, req.params.issueId, req.params.claimId);
    if (!result) {
      res.status(404).json({ error: { code: "PROJECT_ISSUE_OR_CLAIM_NOT_FOUND", message: "研究问题或可能答案不存在。" } });
      return;
    }
    res.json(result);
  }));

  router.post("/:projectId/issues/:issueId/claims/:claimId/evidence-manifest-preview", handle(async (req, res) => {
    const result = await evidence!.preview(req.params.projectId, req.params.issueId, req.params.claimId, req.body);
    res.status(200).json(result);
  }));

  return router;
}
