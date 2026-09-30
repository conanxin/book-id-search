import { json, Router, type Request, type Response, type ErrorRequestHandler } from "express";
import type { S32Config } from "../config.js";
import { InvalidProjectInputError } from "../domain/project.js";
import { InvalidIdempotencyKeyError, InvalidResearchIssueInputError } from "../domain/research-issue.js";
import { InvalidResearchRunInputError, InvalidResearchRunTransitionError, InvalidResearchRunCursorError } from "../domain/research-run.js";
import {
  ProjectReadOnlyForResearchRunError,
  ResearchIssueReadOnlyForResearchRunError,
  ResearchRunAlreadyTerminalError,
  ResearchRunEvidenceNotAvailableError,
  ResearchRunIdempotencyConflictError,
  ResearchRunIntegrityError,
  ResearchRunInvalidInputError,
  ResearchRunNotFoundError,
  ResearchRunReplayInvalidError,
  ResearchRunScopeNotFoundError,
  ResearchRunStoreUnavailableError,
  type ResearchRunsService,
} from "../application/research-runs.js";
import { authorizeS32RouteRequest, type S32RequestAuthorizer } from "./private-auth.js";

type ErrorBody = { message: string; code?: string };
const invalidInput = { code: "RESEARCH_RUN_INVALID", message: "研究执行输入不正确。" };

/** Raw POST path shapes owned by the ResearchRun pre-parser (auth-first). */
const PRE_PARSER_PATH = /^\/[^/]+\/issues\/[^/]+\/runs\/?$/i;
const PRE_PARSER_TRANSITION_PATH = /^\/[^/]+\/issues\/[^/]+\/runs\/[^/]+\/(complete|fail|cancel|replay)\/?$/i;

function authenticate(
  config: S32Config,
  req: Request,
  res: Response,
  requestAuthorizer?: S32RequestAuthorizer,
): boolean {
  res.set("Cache-Control", "no-store");
  const auth = authorizeS32RouteRequest(config, req, requestAuthorizer);
  if (!auth.ok) {
    res.status(auth.status).json({ error: { message: auth.message } });
    return false;
  }
  return true;
}

/**
 * Mount BEFORE global express.json. Authenticates FIRST (legacy bearer or
 * Google session incl. Origin/CSRF through the shared authorizer), then
 * parses a bounded 256kb JSON body. Malformed/oversized bodies can never
 * bypass auth; unauthenticated malformed JSON gets the auth error, not 400.
 */
export function createResearchRunBodyParser(config: S32Config, requestAuthorizer?: S32RequestAuthorizer) {
  const router = Router();
  const parse = json({ limit: "256kb" });
  router.use((req, res, next) => {
    // Raw path match: Express parameter decoding must not precede authentication.
    if (req.method !== "POST"
      || (!PRE_PARSER_PATH.test(req.path) && !PRE_PARSER_TRANSITION_PATH.test(req.path))) {
      next();
      return;
    }
    if (!authenticate(config, req, res, requestAuthorizer)) return;
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
    error instanceof InvalidResearchRunInputError ||
    error instanceof InvalidResearchRunTransitionError ||
    error instanceof InvalidResearchRunCursorError ||
    error instanceof ResearchRunInvalidInputError
  ) {
    return [400, invalidInput];
  }
  if (error instanceof ResearchRunScopeNotFoundError) {
    return [404, { code: "PROJECT_OR_ISSUE_NOT_FOUND", message: "研究项目或研究问题不存在。" }];
  }
  if (error instanceof ResearchRunNotFoundError) {
    return [404, { code: "RESEARCH_RUN_NOT_FOUND", message: "该研究执行当前不可用。" }];
  }
  if (error instanceof ResearchRunEvidenceNotAvailableError) {
    return [404, { code: "EVIDENCE_MANIFEST_NOT_AVAILABLE", message: "所选证据清单当前不可用。" }];
  }
  if (error instanceof ProjectReadOnlyForResearchRunError) {
    return [409, { code: "PROJECT_READ_ONLY", message: "当前研究项目已归档，不能新增研究执行。" }];
  }
  if (error instanceof ResearchIssueReadOnlyForResearchRunError) {
    return [409, { code: "RESEARCH_ISSUE_READ_ONLY", message: "当前研究问题已归档，不能新增研究执行。" }];
  }
  if (error instanceof ResearchRunAlreadyTerminalError) {
    return [409, { code: "RESEARCH_RUN_ALREADY_TERMINAL", message: "该研究执行已结束，状态不可再变更。" }];
  }
  if (error instanceof ResearchRunReplayInvalidError) {
    return [409, { code: "RESEARCH_RUN_REPLAY_INVALID", message: "该研究执行当前不能重放。" }];
  }
  if (error instanceof ResearchRunIdempotencyConflictError) {
    return [409, { code: "IDEMPOTENCY_CONFLICT", message: "提交标识与当前研究执行内容不一致。" }];
  }
  if (error instanceof ResearchRunStoreUnavailableError) {
    return [503, { code: "RESEARCH_RUN_STORE_UNAVAILABLE", message: "研究执行服务暂不可用。" }];
  }
  if (error instanceof ResearchRunIntegrityError) {
    return [500, { message: "研究执行数据完整性校验失败，请稍后再试。" }];
  }
  return [500, { message: "研究执行请求失败，请稍后再试。" }];
}

export function createResearchRunRouter(config: S32Config, researchRuns: ResearchRunsService | null, requestAuthorizer?: S32RequestAuthorizer) {
  const router = Router();

  // Authenticate before Express decodes any path parameter, including malformed IDs.
  router.use((req, res, next) => {
    if (!authenticate(config, req, res, requestAuthorizer)) return;
    next();
  });

  // Only ResearchRun requests consume this service's configuration gate.
  router.use("/:projectId/issues/:issueId/runs", (_req, res, next) => {
    if (!config.databaseUrl || !researchRuns) {
      res.status(503).json({ error: { code: "RESEARCH_RUN_STORE_UNAVAILABLE", message: "研究执行服务尚未配置。" } });
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
    "/:projectId/issues/:issueId/runs",
    handle(async (req, res) => {
      const result = await researchRuns!.start(
        req.params.projectId, req.params.issueId, req.get("Idempotency-Key"), req.body,
      );
      res.status(result.status === "created" ? 201 : 200).json(result);
    }),
  );
  router.get(
    "/:projectId/issues/:issueId/runs",
    handle(async (req, res) => {
      const result = await researchRuns!.list(req.params.projectId, req.params.issueId, req.query);
      res.status(200).json(result);
    }),
  );
  router.get(
    "/:projectId/issues/:issueId/runs/:runId",
    handle(async (req, res) => {
      const result = await researchRuns!.get(req.params.projectId, req.params.issueId, req.params.runId);
      res.status(200).json(result);
    }),
  );
  router.post(
    "/:projectId/issues/:issueId/runs/:runId/complete",
    handle(async (req, res) => {
      const result = await researchRuns!.complete(
        req.params.projectId, req.params.issueId, req.params.runId, req.get("Idempotency-Key"), req.body,
      );
      res.status(200).json(result);
    }),
  );
  router.post(
    "/:projectId/issues/:issueId/runs/:runId/fail",
    handle(async (req, res) => {
      const result = await researchRuns!.fail(
        req.params.projectId, req.params.issueId, req.params.runId, req.get("Idempotency-Key"), req.body,
      );
      res.status(200).json(result);
    }),
  );
  router.post(
    "/:projectId/issues/:issueId/runs/:runId/cancel",
    handle(async (req, res) => {
      const result = await researchRuns!.cancel(
        req.params.projectId, req.params.issueId, req.params.runId, req.get("Idempotency-Key"), req.body,
      );
      res.status(200).json(result);
    }),
  );
  router.post(
    "/:projectId/issues/:issueId/runs/:runId/replay",
    handle(async (req, res) => {
      const result = await researchRuns!.replay(
        req.params.projectId, req.params.issueId, req.params.runId, req.get("Idempotency-Key"), req.body,
      );
      res.status(result.status === "created" ? 201 : 200).json(result);
    }),
  );

  // Routing errors occur before an endpoint's async handler can catch them.
  const pathError: ErrorRequestHandler = (error, _req, res, _next) => {
    const [status, body] = toHttpError(
      error instanceof URIError ? new ResearchRunInvalidInputError() : error,
    );
    res.status(status).json({ error: body });
  };
  router.use(pathError);

  return router;
}
