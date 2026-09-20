import {IdempotencyConflictError,ProjectReadOnlyError} from "../application/research-issues.js";
import {InvalidCandidateClaimInputError} from "../domain/candidate-claim.js";
import { Router, type Request, type Response } from "express";
import type { S32Config } from "../config.js";
import { InvalidProjectInputError } from "../domain/project.js";
import { InvalidIdempotencyKeyError, InvalidResearchIssueInputError } from "../domain/research-issue.js";
import {
  ResearchIssueReadOnlyError,
  CandidateClaimIntegrityError,
  CandidateClaimScopeNotFoundError,
  CandidateClaimStoreUnavailableError,
  type CandidateClaimsService,
} from "../application/candidate-claims.js";
import { checkS32PrivateAuth } from "./private-auth.js";

function toHttpError(error: unknown): [number, { message: string; code?: string }] {
  if (error instanceof InvalidCandidateClaimInputError || error instanceof InvalidProjectInputError || error instanceof InvalidResearchIssueInputError || error instanceof InvalidIdempotencyKeyError) {
    return [400, { code: "CLAIM_INVALID_INPUT", message: "可能答案输入不正确。" }];
  }
  if (error instanceof ResearchIssueReadOnlyError) return [409, { code: "RESEARCH_ISSUE_READ_ONLY", message: "这个研究问题已经只读，不能添加新的可能答案。" }];
  if (error instanceof ProjectReadOnlyError) {
    return [409, { code: "PROJECT_READ_ONLY", message: "项目已归档，只能查看研究内容。" }];
  }
  if (error instanceof IdempotencyConflictError) {
    return [409, { code: "IDEMPOTENCY_CONFLICT", message: "创建请求标识与当前可能答案内容不一致。" }];
  }
  if (error instanceof CandidateClaimScopeNotFoundError) return [404, { code: "PROJECT_OR_ISSUE_NOT_FOUND", message: "项目或研究问题不存在。" }];
  if (error instanceof CandidateClaimStoreUnavailableError) return [503, { message: "可能答案服务暂不可用。" }];
  if (error instanceof CandidateClaimIntegrityError) return [500, { message: "可能答案请求失败，请稍后再试。" }];
  return [500, { message: "可能答案请求失败，请稍后再试。" }];
}

export function createCandidateClaimRouter(config: S32Config, issues: CandidateClaimsService | null) {
  const router = Router();
  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    const auth = checkS32PrivateAuth(config, req.get("authorization"), req.get("x-private-token"));
    if (!auth.ok) {
      res.status(auth.status).json({ error: { message: auth.message } });
      return;
    }
    if (!config.databaseUrl || !issues) {
      res.status(503).json({ error: { message: "研究问题数据库尚未配置。" } });
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

  router.post("/:projectId/issues/:issueId/claims", handle(async (req,res)=>{
    const result=await issues!.create(req.params.projectId,req.params.issueId,req.get("idempotency-key"),req.body);
    res.status(result.status==="created"?201:200).json({claim:result.claim});
  }));
  router.get("/:projectId/issues/:issueId/claims", handle(async(req,res)=>{
    const result=await issues!.list(req.params.projectId,req.params.issueId);
    if(!result){res.status(404).json({error:{code:"PROJECT_OR_ISSUE_NOT_FOUND",message:"项目或研究问题不存在。"}});return;}
    res.json(result);
  }));
  return router;
}
