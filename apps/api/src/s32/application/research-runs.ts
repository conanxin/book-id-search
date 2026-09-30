import { randomUUID } from "node:crypto";
import { readProjectId } from "../domain/project.js";
import { readIdempotencyKey, readResearchIssueId } from "../domain/research-issue.js";
import { decodeResearchRunCursor } from "../domain/research-run.js";
import {
  InvalidResearchRunInputError,
  InvalidResearchRunTransitionError,
  readResearchRunEnvironment,
  readResearchRunExecutionContract,
  readResearchRunOutput,
  readResearchRunProcedure,
  sha256ResearchRunCanonical,
  validateResearchRunTransition,
  type ResearchRunEnvironment,
  type ResearchRunExecutionContract,
  type ResearchRunOutput,
  type ResearchRunProcedure,
  type ResearchRunStatus,
} from "../domain/research-run.js";

/**
 * ResearchRun application contracts (M3-A Gate 2, Task 1).
 *
 * Interface-only layer: Task 2 implements the PostgreSQL command store,
 * Task 3 the read store. Application-level invariant: `issueId` is REQUIRED
 * (project ownership derives through Project→RESEARCH_ISSUE), even though
 * the DB column is nullable. Replay never mutates the prior terminal run —
 * it always proposes a NEW run id referencing the prior run.
 */

export class ResearchRunInvalidInputError extends Error {}
export class ResearchRunScopeNotFoundError extends Error {}
export class ResearchRunNotFoundError extends Error {}
export class ProjectReadOnlyForResearchRunError extends Error {}
export class ResearchIssueReadOnlyForResearchRunError extends Error {}
export class ResearchRunEvidenceNotAvailableError extends Error {}
export class ResearchRunAlreadyTerminalError extends Error {}
export class ResearchRunReplayInvalidError extends Error {}
export class ResearchRunIdempotencyConflictError extends Error {}
export class ResearchRunIntegrityError extends Error {}
export class ResearchRunStoreUnavailableError extends Error {}

export interface ResearchRunStartCommand {
  projectId: string;
  /** M3-A application contract: mandatory (DB column nullable ≠ optional here). */
  issueId: string;
  evidenceManifestId: string;
  runId: string;
  idempotencyKey: string;
  requestHash: string;
  procedure: ResearchRunProcedure;
  executionContract: ResearchRunExecutionContract;
  environment: ResearchRunEnvironment;
  replayOf: string | null;
}

export interface ResearchRunTransitionCommand {
  projectId: string;
  issueId: string;
  runId: string;
  status: ResearchRunStatus;
  output: ResearchRunOutput | null;
  idempotencyKey: string;
  requestHash: string;
}

export interface ResearchRunReplayCommand {
  projectId: string;
  issueId: string;
  priorRunId: string;
  evidenceManifestId: string;
  runId: string;
  idempotencyKey: string;
  requestHash: string;
  procedure: ResearchRunProcedure;
  executionContract: ResearchRunExecutionContract;
  environment: ResearchRunEnvironment;
  replayOf: string;
}

export interface ResearchRunRecord {
  runId: string;
  projectId: string;
  issueId: string;
  status: ResearchRunStatus;
  evidenceManifestId: string;
  replayOf: string | null;
  procedure: ResearchRunProcedure;
  executionContract: ResearchRunExecutionContract;
  environment: ResearchRunEnvironment;
  output: ResearchRunOutput | null;
  knowledgeCutoff: string | null;
  startedAt: string;
  completedAt: string | null;
  createdAt: string;
}

/** Compact list summary (Task 3): identity + lifecycle + immediate replayOf. */
export interface ResearchRunSummary {
  runId: string;
  issueId: string;
  status: ResearchRunStatus;
  replayOf: string | null;
  startedAtMicros: string;
  startedAt: string;
  completedAt: string | null;
  evidenceManifest: {
    id: string;
    manifestSha256: string;
    itemCount: number;
    available: boolean;
  };
}

/** Evidence snapshot view — item details only when available=true. */
export interface ResearchRunEvidenceSnapshot {
  id: string;
  manifestSha256: string;
  itemCount: number;
  available: boolean;
  items?: ReadonlyArray<{
    ordinal: number;
    role: string;
    targetType: string;
    note: string | null;
  }>;
}

export interface ResearchRunDetail {
  run: ResearchRunRecord;
  evidenceManifest: ResearchRunEvidenceSnapshot;
  /** Ancestor lineage (prior → prior's prior …), oldest-first order. */
  ancestors: ResearchRunSummary[];
}

export type ResearchRunCommandResult =
  | { status: "created"; runId: string }
  | { status: "replayed"; runId: string };

export interface ResearchRunListCommand {
  projectId: string;
  issueId: string;
  limit: number;
  cursor: string | null;
}

export type ResearchRunListLookup =
  | { kind: "scope-missing" }
  | { kind: "ok"; value: { runs: ResearchRunSummary[]; nextCursor: string | null } };

/**
 * Command store surface for Task 2. All failure modes throw typed errors
 * (scope/read-only/not-found/evidence/terminal/replay/idempotency/integrity/
 * unavailable); only success returns a command result.
 */
export interface ResearchRunCommandStore {
  start(command: ResearchRunStartCommand): Promise<ResearchRunCommandResult>;
  transition(command: ResearchRunTransitionCommand, from: ResearchRunStatus): Promise<ResearchRunCommandResult>;
  replay(command: ResearchRunReplayCommand): Promise<ResearchRunCommandResult>;
}

export interface ResearchRunGetCommand {
  projectId: string;
  issueId: string;
  runId: string;
}

export interface ResearchRunReadStore {
  list(command: ResearchRunListCommand): Promise<ResearchRunListLookup>;
  get(command: ResearchRunGetCommand): Promise<ResearchRunGetLookup>;
}

export type ResearchRunGetLookup =
  | { kind: "scope-missing" }
  | { kind: "not-visible" }
  | { kind: "not-found" }
  | { kind: "ok"; value: ResearchRunDetail };

const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

/**
 * Strict list-query parser (Task 3): malformed explicit limit/cursor reject
 * instead of silently defaulting. Valid shapes: {} | {limit:1..100} |
 * {cursor:ResearchRunCursorToken}. Unknown keys reject.
 */
export function parseResearchRunListQuery(queryInput: unknown): { limit: number; cursor: string | null } {
  if (queryInput === undefined || queryInput === null) return { limit: 20, cursor: null };
  if (typeof queryInput !== "object" || Array.isArray(queryInput)) {
    throw new ResearchRunInvalidInputError("查询参数必须是对象。");
  }
  const query = queryInput as Record<string, unknown>;
  const keys = Object.keys(query);
  if (keys.some(key => key !== "limit" && key !== "cursor")) {
    throw new ResearchRunInvalidInputError("查询参数只允许 limit 与 cursor。");
  }
  let limit = 20;
  if (query.limit !== undefined) {
    // HTTP query strings arrive as text; accept exact integer strings or numbers.
    const raw = typeof query.limit === "string" ? query.limit.trim() : query.limit;
    const parsedLimit = typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : raw;
    if (typeof parsedLimit !== "number" || !Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) {
      throw new ResearchRunInvalidInputError("limit 必须是 1..100 的整数。");
    }
    limit = parsedLimit;
  }
  let cursor: string | null = null;
  if (query.cursor !== undefined) {
    if (typeof query.cursor !== "string" || !query.cursor) {
      throw new ResearchRunInvalidInputError("cursor 必须是非空字符串。");
    }
    // Reject malformed cursors eagerly via the domain decoder.
    decodeResearchRunCursor(query.cursor);
    cursor = query.cursor;
  }
  return { limit, cursor };
}

function readEvidenceManifestId(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new ResearchRunInvalidInputError("evidenceManifestId 必须是 UUID。");
  }
  return value.toLowerCase();
}

function readResearchRunId(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new ResearchRunInvalidInputError("ResearchRun ID 必须是 UUID。");
  }
  return value.toLowerCase();
}

function readOptionalOutput(value: unknown): ResearchRunOutput | null {
  if (value === null || value === undefined) return null;
  return readResearchRunOutput(value);
}

export function createResearchRunsService(
  commandStore: ResearchRunCommandStore,
  readStore: ResearchRunReadStore,
) {
  return {
    /** START → RUNNING. `issueId` mandatory; `replayOf` optional reference. */
    async start(
      projectInput: unknown,
      issueInput: unknown,
      idempotencyKeyInput: unknown,
      body: unknown,
    ): Promise<ResearchRunCommandResult> {
      const projectId = readProjectId(projectInput).toLowerCase();
      const issueId = readResearchIssueId(issueInput);
      const idempotencyKey = readIdempotencyKey(idempotencyKeyInput);

      if (body === null || typeof body !== "object" || Array.isArray(body)) {
        throw new ResearchRunInvalidInputError("请求体必须是 JSON 对象。");
      }
      const record = body as Record<string, unknown>;
      const expected = ["procedure", "executionContract", "environment", "evidenceManifestId", "replayOf"];
      const actual = Object.keys(record).sort();
      const expectedSorted = [...expected].sort();
      if (actual.length !== expectedSorted.length || expectedSorted.some((k) => !(k in record))) {
        throw new ResearchRunInvalidInputError(`start 字段必须恰好为：${expectedSorted.join(", ")}。`);
      }

      const procedure = readResearchRunProcedure(record.procedure);
      const executionContract = readResearchRunExecutionContract(record.executionContract);
      const environment = readResearchRunEnvironment(record.environment);
      const evidenceManifestId = readEvidenceManifestId(record.evidenceManifestId);
      const replayOf = record.replayOf === null ? null : readResearchRunId(record.replayOf);

      const requestHash = sha256ResearchRunCanonical({
        kind: "research-run/start",
        projectId,
        issueId,
        evidenceManifestId,
        procedure,
        executionContract,
        environment,
        replayOf,
      });

      const result = await commandStore.start({
        projectId,
        issueId,
        evidenceManifestId,
        runId: randomUUID(),
        idempotencyKey,
        requestHash,
        procedure,
        executionContract,
        environment,
        replayOf,
      });
      return result;
    },

    /** RUNNING → SUCCEEDED (output required) | FAILED/CANCELLED (output nullable). */
    /** Transition body: strict exact key set {output}; unknown/missing keys reject. */
    async complete(
      projectInput: unknown,
      issueInput: unknown,
      runInput: unknown,
      idempotencyKeyInput: unknown,
      bodyInput: unknown,
    ): Promise<ResearchRunCommandResult> {
      return transitionTo("SUCCEEDED", projectInput, issueInput, runInput, idempotencyKeyInput, bodyInput);
    },

    async fail(
      projectInput: unknown,
      issueInput: unknown,
      runInput: unknown,
      idempotencyKeyInput: unknown,
      bodyInput: unknown,
    ): Promise<ResearchRunCommandResult> {
      return transitionTo("FAILED", projectInput, issueInput, runInput, idempotencyKeyInput, bodyInput);
    },

    async cancel(
      projectInput: unknown,
      issueInput: unknown,
      runInput: unknown,
      idempotencyKeyInput: unknown,
      bodyInput: unknown,
    ): Promise<ResearchRunCommandResult> {
      return transitionTo("CANCELLED", projectInput, issueInput, runInput, idempotencyKeyInput, bodyInput);
    },

    /**
     * REPLAY: always a NEW run; the prior run is passed as an immutable
     * reference (replayOf) and is never mutated by the replay command.
     */
    async replay(
      projectInput: unknown,
      issueInput: unknown,
      priorRunInput: unknown,
      idempotencyKeyInput: unknown,
      body: unknown,
    ): Promise<ResearchRunCommandResult> {
      const projectId = readProjectId(projectInput).toLowerCase();
      const issueId = readResearchIssueId(issueInput);
      const priorRunId = readResearchRunId(priorRunInput);
      const idempotencyKey = readIdempotencyKey(idempotencyKeyInput);

      if (body === null || typeof body !== "object" || Array.isArray(body)) {
        throw new ResearchRunInvalidInputError("请求体必须是 JSON 对象。");
      }
      const record = body as Record<string, unknown>;
      const expected = ["procedure", "executionContract", "environment", "evidenceManifestId"];
      const actual = Object.keys(record).sort();
      const expectedSorted = [...expected].sort();
      if (actual.length !== expectedSorted.length || expectedSorted.some((k) => !(k in record))) {
        throw new ResearchRunInvalidInputError(`replay 字段必须恰好为：${expectedSorted.join(", ")}。`);
      }

      const procedure = readResearchRunProcedure(record.procedure);
      const executionContract = readResearchRunExecutionContract(record.executionContract);
      const environment = readResearchRunEnvironment(record.environment);
      const evidenceManifestId = readEvidenceManifestId(record.evidenceManifestId);

      const requestHash = sha256ResearchRunCanonical({
        kind: "research-run/replay",
        projectId,
        issueId,
        priorRunId,
        evidenceManifestId,
        procedure,
        executionContract,
        environment,
      });

      const result = await commandStore.replay({
        projectId,
        issueId,
        priorRunId,
        evidenceManifestId,
        runId: randomUUID(),
        idempotencyKey,
        requestHash,
        procedure,
        executionContract,
        environment,
        replayOf: priorRunId,
      });
      return result;
    },

    async list(
      projectInput: unknown,
      issueInput: unknown,
      queryInput: unknown,
    ): Promise<{ runs: ResearchRunSummary[]; nextCursor: string | null }> {
      const projectId = readProjectId(projectInput).toLowerCase();
      const issueId = readResearchIssueId(issueInput);
      const { limit, cursor } = parseResearchRunListQuery(queryInput);
      const result = await readStore.list({ projectId, issueId, limit, cursor });
      if (result.kind === "scope-missing") throw new ResearchRunScopeNotFoundError("PROJECT_OR_ISSUE_NOT_FOUND");
      return result.value;
    },

    async get(
      projectInput: unknown,
      issueInput: unknown,
      runInput: unknown,
    ): Promise<ResearchRunDetail> {
      const projectId = readProjectId(projectInput).toLowerCase();
      const issueId = readResearchIssueId(issueInput);
      const runId = readResearchRunId(runInput);
      const result = await readStore.get({ projectId, issueId, runId });
      if (result.kind === "scope-missing") throw new ResearchRunScopeNotFoundError("PROJECT_OR_ISSUE_NOT_FOUND");
      if (result.kind === "not-visible" || result.kind === "not-found") {
        throw new ResearchRunNotFoundError("RESEARCH_RUN_NOT_FOUND");
      }
      return result.value;
    },
  };

  async function transitionTo(
    to: Extract<ResearchRunStatus, "SUCCEEDED" | "FAILED" | "CANCELLED">,
    projectInput: unknown,
    issueInput: unknown,
    runInput: unknown,
    idempotencyKeyInput: unknown,
    bodyInput: unknown,
  ): Promise<ResearchRunCommandResult> {
    const projectId = readProjectId(projectInput).toLowerCase();
    const issueId = readResearchIssueId(issueInput);
    const runId = readResearchRunId(runInput);
    const idempotencyKey = readIdempotencyKey(idempotencyKeyInput);
    if (bodyInput === null || typeof bodyInput !== "object" || Array.isArray(bodyInput)) {
      throw new ResearchRunInvalidInputError("transition 请求体必须是 JSON 对象。");
    }
    const record = bodyInput as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length !== 1 || keys[0] !== "output") {
      throw new ResearchRunInvalidInputError("transition 请求体字段必须恰好为：output。");
    }
    const output = readOptionalOutput(record.output);
    // Domain lifecycle gate throws InvalidResearchRunTransitionError for
    // invalid output shape relative to target status (e.g. SUCCEEDED + null).
    validateResearchRunTransition("RUNNING", to, output);
    const requestHash = sha256ResearchRunCanonical({
      kind: `research-run/${to.toLowerCase()}`,
      projectId,
      issueId,
      runId,
      output,
    });
    return commandStore.transition(
      { projectId, issueId, runId, status: to, output, idempotencyKey, requestHash },
      "RUNNING",
    );
  }
}

export { InvalidResearchRunInputError, InvalidResearchRunTransitionError };

export type ResearchRunsService = ReturnType<typeof createResearchRunsService>;
