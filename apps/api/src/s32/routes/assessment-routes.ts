import { Router, type Request, type Response } from "express";
import type { S32Config } from "../config.js";
import { InvalidProjectInputError } from "../domain/project.js";
import { InvalidResearchIssueInputError } from "../domain/research-issue.js";
import { InvalidCandidateClaimInputError } from "../domain/candidate-claim.js";
import {
  InvalidAssessmentCursorError,
  InvalidAssessmentInputError,
} from "../domain/assessment.js";
import { InvalidEvidenceDraftError } from "../domain/evidence-selection.js";
import {
  AssessmentEvidenceTargetNotAvailableError,
  AssessmentIdempotencyConflictError,
  AssessmentIntegrityError,
  AssessmentNotFoundError,
  AssessmentScopeNotFoundError,
  AssessmentStoreUnavailableError,
  EvidencePreviewStaleError,
  ProjectReadOnlyForAssessmentError,
  ResearchIssueReadOnlyForAssessmentError,
  type AssessmentsService,
} from "../application/assessments.js";
import { checkS32PrivateAuth } from "./private-auth.js";

type ErrorBody = { message: string; code?: string };

function toHttpError(error: unknown): [number, ErrorBody] {
  if (error instanceof InvalidAssessmentCursorError) {
    return [400, { code: "ASSESSMENT_CURSOR_INVALID", message: "评价历史游标不正确。" }];
  }
  if (error instanceof InvalidEvidenceDraftError) {
    return [400, { code: "EVIDENCE_DRAFT_INVALID", message: "证据草稿输入不正确。" }];
  }
  if (
    error instanceof InvalidAssessmentInputError ||
    error instanceof InvalidProjectInputError ||
    error instanceof InvalidResearchIssueInputError ||
    error instanceof InvalidCandidateClaimInputError
  ) {
    return [400, { code: "ASSESSMENT_INVALID", message: "评价输入不正确。" }];
  }
  if (error instanceof AssessmentScopeNotFoundError) {
    return [404, { code: "PROJECT_ISSUE_OR_CLAIM_NOT_FOUND", message: "研究问题或可能答案不存在。" }];
  }
  if (error instanceof AssessmentEvidenceTargetNotAvailableError) {
    return [404, { code: "EVIDENCE_TARGET_NOT_AVAILABLE", message: "所选证据当前不可用于此研究项目。" }];
  }
  if (error instanceof AssessmentNotFoundError) {
    return [404, { code: "ASSESSMENT_NOT_FOUND", message: "该评价当前不可用。" }];
  }
  if (error instanceof ProjectReadOnlyForAssessmentError) {
    return [409, { code: "PROJECT_READ_ONLY", message: "当前研究项目已归档，不能新增评价。" }];
  }
  if (error instanceof ResearchIssueReadOnlyForAssessmentError) {
    return [409, { code: "RESEARCH_ISSUE_READ_ONLY", message: "当前研究问题已归档，不能新增评价。" }];
  }
  if (error instanceof EvidencePreviewStaleError) {
    return [409, { code: "EVIDENCE_PREVIEW_STALE", message: "证据集自上次预览后已发生变化，请重新预览。" }];
  }
  if (error instanceof AssessmentIdempotencyConflictError) {
    return [409, { code: "IDEMPOTENCY_CONFLICT", message: "提交标识与当前评价内容不一致。" }];
  }
  if (error instanceof AssessmentStoreUnavailableError) {
    return [503, { code: "ASSESSMENT_STORE_UNAVAILABLE", message: "评价服务暂不可用。" }];
  }
  if (error instanceof AssessmentIntegrityError) {
    return [500, { message: "评价数据完整性校验失败，请稍后再试。" }];
  }
  return [500, { message: "评价请求失败，请稍后再试。" }];
}

export function createAssessmentRouter(config: S32Config, assessments: AssessmentsService | null) {
  const router = Router();

  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    const auth = checkS32PrivateAuth(config, req.get("authorization"), req.get("x-private-token"));
    if (!auth.ok) {
      res.status(auth.status).json({ error: { message: auth.message } });
      return;
    }
    if (!config.databaseUrl || !assessments) {
      res.status(503).json({ error: { code: "ASSESSMENT_STORE_UNAVAILABLE", message: "评价服务尚未配置。" } });
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

  router.post(
    "/:projectId/issues/:issueId/claims/:claimId/assessments",
    handle(async (req, res) => {
      const result = await assessments!.create(
        req.params.projectId,
        req.params.issueId,
        req.params.claimId,
        req.get("Idempotency-Key"),
        req.body,
      );
      res.status(result.status === "created" ? 201 : 200).json(result);
    }),
  );

  router.get(
    "/:projectId/issues/:issueId/claims/:claimId/assessments",
    handle(async (req, res) => {
      const result = await assessments!.list(
        req.params.projectId,
        req.params.issueId,
        req.params.claimId,
        req.query,
      );
      res.status(200).json(result);
    }),
  );

  router.get(
    "/:projectId/issues/:issueId/claims/:claimId/assessments/:assessmentId",
    handle(async (req, res) => {
      const result = await assessments!.get(
        req.params.projectId,
        req.params.issueId,
        req.params.claimId,
        req.params.assessmentId,
      );
      res.status(200).json(result);
    }),
  );

  return router;
}
