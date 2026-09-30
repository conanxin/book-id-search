import { randomUUID } from "node:crypto";
import { readProjectId } from "../domain/project.js";
import { readIdempotencyKey, readResearchIssueId } from "../domain/research-issue.js";
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
  | { kind: "ok"; value: { runs: ResearchRunRecord[]; nextCursor: string | null } };

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

export interface ResearchRunReadStore {
  list(command: ResearchRunListCommand): Promise<ResearchRunListLookup>;
  get(command: { projectId: string; issueId: string; runId: string }): Promise<ResearchRunGetLookup>;
}

export type ResearchRunGetLookup =
  | { kind: "scope-missing" }
  | { kind: "not-visible" }
  | { kind: "not-found" }
  | { kind: "ok"; value: ResearchRunRecord };

const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

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
    async complete(
      projectInput: unknown,
      issueInput: unknown,
      runInput: unknown,
      outputInput: unknown,
    ): Promise<ResearchRunCommandResult> {
      return transitionTo("SUCCEEDED", projectInput, issueInput, runInput, outputInput);
    },

    async fail(
      projectInput: unknown,
      issueInput: unknown,
      runInput: unknown,
      outputInput: unknown,
    ): Promise<ResearchRunCommandResult> {
      return transitionTo("FAILED", projectInput, issueInput, runInput, outputInput);
    },

    async cancel(
      projectInput: unknown,
      issueInput: unknown,
      runInput: unknown,
      outputInput: unknown,
    ): Promise<ResearchRunCommandResult> {
      return transitionTo("CANCELLED", projectInput, issueInput, runInput, outputInput);
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
    ): Promise<{ runs: ResearchRunRecord[]; nextCursor: string | null }> {
      const projectId = readProjectId(projectInput).toLowerCase();
      const issueId = readResearchIssueId(issueInput);
      const query = (queryInput ?? {}) as Record<string, unknown>;
      const limit = typeof query.limit === "number" && query.limit > 0 && query.limit <= 100 ? Math.floor(query.limit) : 20;
      const cursor = typeof query.cursor === "string" && query.cursor ? query.cursor : null;
      const result = await readStore.list({ projectId, issueId, limit, cursor });
      if (result.kind === "scope-missing") throw new ResearchRunInvalidInputError("PROJECT_OR_ISSUE_NOT_FOUND");
      return result.value;
    },

    async get(
      projectInput: unknown,
      issueInput: unknown,
      runInput: unknown,
    ): Promise<ResearchRunRecord> {
      const projectId = readProjectId(projectInput).toLowerCase();
      const issueId = readResearchIssueId(issueInput);
      const runId = readResearchRunId(runInput);
      const result = await readStore.get({ projectId, issueId, runId });
      if (result.kind === "scope-missing") throw new ResearchRunInvalidInputError("PROJECT_OR_ISSUE_NOT_FOUND");
      if (result.kind === "not-visible" || result.kind === "not-found") {
        throw new ResearchRunInvalidInputError("RESEARCH_RUN_NOT_FOUND");
      }
      return result.value;
    },
  };

  async function transitionTo(
    to: Extract<ResearchRunStatus, "SUCCEEDED" | "FAILED" | "CANCELLED">,
    projectInput: unknown,
    issueInput: unknown,
    runInput: unknown,
    outputInput: unknown,
    idempotencyKeyInput?: unknown,
  ): Promise<ResearchRunCommandResult> {
    const projectId = readProjectId(projectInput).toLowerCase();
    const issueId = readResearchIssueId(issueInput);
    const runId = readResearchRunId(runInput);
    const idempotencyKey = readIdempotencyKey(idempotencyKeyInput ?? randomUUID());
    const output = readOptionalOutput(outputInput);
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
