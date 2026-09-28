import { json, Router, type Request, type Response, type ErrorRequestHandler } from "express";
import type { S32Config } from "../config.js";
import { InvalidProjectInputError } from "../domain/project.js";
import { InvalidIdempotencyKeyError, InvalidResearchIssueInputError } from "../domain/research-issue.js";
import { InvalidIssueResolutionCursorError, InvalidIssueResolutionInputError } from "../domain/issue-resolution.js";
import {
  IssueResolutionScopeNotFoundError,
  IssueResolutionNotFoundError,
  IssueResolutionInvalidPreferredClaimError,
  IssueResolutionEvidenceNotAvailableError,
  IssueResolutionStaleError,
  IssueResolutionIdempotencyConflictError,
  ProjectReadOnlyForResolutionError,
  ResearchIssueReadOnlyForResolutionError,
  IssueResolutionIntegrityError,
  IssueResolutionStoreUnavailableError,
  type IssueResolutionsService,
} from "../application/issue-resolutions.js";
import { checkS32PrivateAuth } from "./private-auth.js";

type ErrorBody = { message: string; code?: string };
const invalidInput = { code: "ISSUE_RESOLUTION_INVALID", message: "工作结论输入不正确。" };

function authenticate(config: S32Config, req: Request, res: Response): boolean {
  res.set("Cache-Control", "no-store");
  const auth = checkS32PrivateAuth(config, req.get("authorization"), req.get("x-private-token"));
  if (!auth.ok) {
    res.status(auth.status).json({ error: { message: auth.message } });
    return false;
  }
  return true;
}

/** Mount before global express.json; leave sibling routes and methods untouched. */
export function createIssueResolutionBodyParser(config: S32Config) {
  const router = Router();
  const parse = json({ limit: "256kb" });
  router.use((req, res, next) => {
    // Raw path match: Express parameter decoding must not precede authentication.
    if (req.method !== "POST" || !/^\/[^/]+\/issues\/[^/]+\/resolutions\/?$/i.test(req.path)) {
      next();
      return;
    }
    if (!authenticate(config, req, res)) return;
    parse(req, res, error => {
      if (error) {
        res.status(400).json({ error: invalidInput });
        return;
      }
      next();
    });
  });
  return router;
}

function toHttpError(error: unknown): [number, ErrorBody] {
  if (
    error instanceof InvalidProjectInputError ||
    error instanceof InvalidResearchIssueInputError ||
    error instanceof InvalidIdempotencyKeyError ||
    error instanceof InvalidIssueResolutionInputError ||
    error instanceof InvalidIssueResolutionCursorError
  ) {
    return [400, invalidInput];
  }
  if (error instanceof IssueResolutionScopeNotFoundError) {
    return [404, { code: "PROJECT_OR_ISSUE_NOT_FOUND", message: "研究项目或研究问题不存在。" }];
  }
  if (error instanceof IssueResolutionNotFoundError) {
    return [404, { code: "ISSUE_RESOLUTION_NOT_FOUND", message: "该工作结论当前不可用。" }];
  }
  if (error instanceof IssueResolutionInvalidPreferredClaimError) {
    return [404, { code: "PREFERRED_CLAIM_NOT_AVAILABLE", message: "所选可能答案当前不可用。" }];
  }
  if (error instanceof IssueResolutionEvidenceNotAvailableError) {
    return [404, { code: "EVIDENCE_MANIFEST_NOT_AVAILABLE", message: "所选证据依据当前不可用。" }];
  }
  if (error instanceof ProjectReadOnlyForResolutionError) {
    return [409, { code: "PROJECT_READ_ONLY", message: "当前研究项目已归档，不能新增工作结论。" }];
  }
  if (error instanceof ResearchIssueReadOnlyForResolutionError) {
    return [409, { code: "RESEARCH_ISSUE_READ_ONLY", message: "当前研究问题已归档，不能新增工作结论。" }];
  }
  if (error instanceof IssueResolutionStaleError) {
    return [409, { code: "ISSUE_RESOLUTION_STALE", message: "当前工作结论已发生变化，请刷新后再提交。" }];
  }
  if (error instanceof IssueResolutionIdempotencyConflictError) {
    return [409, { code: "IDEMPOTENCY_CONFLICT", message: "提交标识与当前工作结论内容不一致。" }];
  }
  if (error instanceof IssueResolutionStoreUnavailableError) {
    return [503, { code: "ISSUE_RESOLUTION_STORE_UNAVAILABLE", message: "工作结论服务暂不可用。" }];
  }
  if (error instanceof IssueResolutionIntegrityError) {
    return [500, { message: "工作结论数据完整性校验失败，请稍后再试。" }];
  }
  return [500, { message: "工作结论请求失败，请稍后再试。" }];
}

export function createIssueResolutionRouter(config: S32Config, issueResolutions: IssueResolutionsService | null) {
  const router = Router();

  // Authenticate before Express decodes any path parameter, including malformed IDs.
  router.use((req, res, next) => {
    if (!authenticate(config, req, res)) return;
    next();
  });

  // Only Resolution requests consume this service's configuration gate.
  router.use([
    "/:projectId/issues/:issueId/resolutions",
    "/:projectId/issues/:issueId/resolution-evidence-bases",
  ], (_req, res, next) => {
    if (!config.databaseUrl || !issueResolutions) {
      res.status(503).json({ error: { code: "ISSUE_RESOLUTION_STORE_UNAVAILABLE", message: "工作结论服务尚未配置。" } });
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
    "/:projectId/issues/:issueId/resolutions",
    handle(async (req, res) => {
      const result = await issueResolutions!.create(
        req.params.projectId, req.params.issueId, req.get("Idempotency-Key"), req.body,
      );
      res.status(result.status === "created" ? 201 : 200).json(result);
    }),
  );
  router.get(
    "/:projectId/issues/:issueId/resolutions",
    handle(async (req, res) => {
      const result = await issueResolutions!.list(req.params.projectId, req.params.issueId, req.query);
      res.status(200).json(result);
    }),
  );
  router.get(
    "/:projectId/issues/:issueId/resolutions/:resolutionId",
    handle(async (req, res) => {
      const result = await issueResolutions!.get(req.params.projectId, req.params.issueId, req.params.resolutionId);
      res.status(200).json(result);
    }),
  );
  router.get(
    "/:projectId/issues/:issueId/resolution-evidence-bases",
    handle(async (req, res) => {
      const result = await issueResolutions!.listEvidenceBases(req.params.projectId, req.params.issueId, req.query);
      res.status(200).json(result);
    }),
  );

  // Routing errors occur before an endpoint's async handler can catch them.
  const pathError: ErrorRequestHandler = (error, _req, res, _next) => {
    const [status, body] = toHttpError(
      error instanceof URIError ? new InvalidIssueResolutionInputError() : error,
    );
    res.status(status).json({ error: body });
  };
  router.use(pathError);

  return router;
}
