import { randomUUID } from "node:crypto";
import { readProjectId } from "../domain/project.js";
import { readIdempotencyKey, readResearchIssueId } from "../domain/research-issue.js";
import type { AssessmentConfidenceLevel, AssessmentStance } from "../domain/assessment.js";
import {
  hashIssueResolutionCreateRequest,
  normalizeIssueResolutionCreateInput,
  readIssueResolutionHistoryQuery,
  readIssueResolutionId,
  type IssueResolutionCursor,
  type IssueResolutionDetailResponse,
  type IssueResolutionHistoryResponse,
  type NormalizedIssueResolutionInput,
} from "../domain/issue-resolution.js";

export class IssueResolutionScopeNotFoundError extends Error {}
export class IssueResolutionNotFoundError extends Error {}
export class IssueResolutionInvalidPreferredClaimError extends Error {}
export class IssueResolutionEvidenceNotAvailableError extends Error {}
export class IssueResolutionStaleError extends Error {}
export class IssueResolutionIdempotencyConflictError extends Error {}
export class ProjectReadOnlyForResolutionError extends Error {}
export class ResearchIssueReadOnlyForResolutionError extends Error {}
export class IssueResolutionIntegrityError extends Error {}
export class IssueResolutionStoreUnavailableError extends Error {}

export interface IssueResolutionCreateCommand extends NormalizedIssueResolutionInput {
  projectId: string;
  issueId: string;
  resolutionId: string;
  idempotencyKey: string;
  requestHash: string;
}

/** The store returns the original canonical ID on replay, not the proposed ID. */
export type IssueResolutionCommandResult =
  | { status: "created"; resolutionId: string }
  | { status: "replayed"; resolutionId: string };

export interface IssueResolutionCommandStore {
  create(command: IssueResolutionCreateCommand): Promise<IssueResolutionCommandResult>;
}

export interface IssueResolutionListCommand {
  projectId: string;
  issueId: string;
  limit: number;
  cursor: IssueResolutionCursor | null;
}

export interface IssueResolutionGetCommand {
  projectId: string;
  issueId: string;
  resolutionId: string;
}

export type IssueResolutionHistoryLookup =
  | { kind: "scope-missing" }
  | { kind: "ok"; value: IssueResolutionHistoryResponse };

export type IssueResolutionDetailLookup =
  | { kind: "scope-missing" }
  | { kind: "not-visible" }
  | { kind: "not-found" }
  | { kind: "ok"; value: IssueResolutionDetailResponse };

export interface IssueResolutionEvidenceBasisSummary {
  assessmentId: string;
  claimId: string;
  claimStatementExcerpt: string;
  stance: AssessmentStance;
  confidenceLevel: AssessmentConfidenceLevel | null;
  manifestId: string;
  manifestSha256: string;
  itemCount: number;
  assessmentCreatedAt: string;
}

export interface IssueResolutionEvidenceBasesResponse {
  /** Canonical Issue scope so clients can bind the page to the requested Issue. */
  issueId: string;
  evidenceBases: IssueResolutionEvidenceBasisSummary[];
  nextCursor: string | null;
}

export type IssueResolutionEvidenceBasesLookup =
  | { kind: "scope-missing" }
  | { kind: "ok"; value: IssueResolutionEvidenceBasesResponse };

export interface IssueResolutionReadStore {
  list(command: IssueResolutionListCommand): Promise<IssueResolutionHistoryLookup>;
  get(command: IssueResolutionGetCommand): Promise<IssueResolutionDetailLookup>;
  /** Same microsecond keyset shape; for evidence bases, cursor.id is assessmentId. */
  listEvidenceBases(command: IssueResolutionListCommand): Promise<IssueResolutionEvidenceBasesLookup>;
}

export function createIssueResolutionsService(
  commandStore: IssueResolutionCommandStore,
  readStore: IssueResolutionReadStore,
) {
  return {
    async create(
      projectInput: unknown,
      issueInput: unknown,
      idempotencyKeyInput: unknown,
      body: unknown,
    ): Promise<IssueResolutionCommandResult> {
      const projectId = readProjectId(projectInput).toLowerCase();
      const issueId = readResearchIssueId(issueInput);
      const idempotencyKey = readIdempotencyKey(idempotencyKeyInput);
      const normalized = normalizeIssueResolutionCreateInput(body);
      const requestHash = hashIssueResolutionCreateRequest(projectId, issueId, normalized);
      const command: IssueResolutionCreateCommand = {
        projectId,
        issueId,
        resolutionId: randomUUID(),
        idempotencyKey,
        requestHash,
        ...normalized,
      };
      return commandStore.create(command);
    },

    async list(projectInput: unknown, issueInput: unknown, queryInput: unknown): Promise<IssueResolutionHistoryResponse> {
      const projectId = readProjectId(projectInput).toLowerCase();
      const issueId = readResearchIssueId(issueInput);
      const query = readIssueResolutionHistoryQuery(queryInput);
      const result = await readStore.list({ projectId, issueId, ...query });
      if (result.kind === "scope-missing") {
        throw new IssueResolutionScopeNotFoundError("PROJECT_OR_ISSUE_NOT_FOUND");
      }
      return result.value;
    },

    async get(projectInput: unknown, issueInput: unknown, resolutionInput: unknown): Promise<IssueResolutionDetailResponse> {
      const projectId = readProjectId(projectInput).toLowerCase();
      const issueId = readResearchIssueId(issueInput);
      const resolutionId = readIssueResolutionId(resolutionInput);
      const result = await readStore.get({ projectId, issueId, resolutionId });
      if (result.kind === "scope-missing") {
        throw new IssueResolutionScopeNotFoundError("PROJECT_OR_ISSUE_NOT_FOUND");
      }
      if (result.kind === "not-visible" || result.kind === "not-found") {
        throw new IssueResolutionNotFoundError("ISSUE_RESOLUTION_NOT_FOUND");
      }
      return result.value;
    },

    async listEvidenceBases(projectInput: unknown, issueInput: unknown, queryInput: unknown): Promise<IssueResolutionEvidenceBasesResponse> {
      const projectId = readProjectId(projectInput).toLowerCase();
      const issueId = readResearchIssueId(issueInput);
      const query = readIssueResolutionHistoryQuery(queryInput);
      const result = await readStore.listEvidenceBases({ projectId, issueId, ...query });
      if (result.kind === "scope-missing") {
        throw new IssueResolutionScopeNotFoundError("PROJECT_OR_ISSUE_NOT_FOUND");
      }
      return result.value;
    },
  };
}

export type IssueResolutionsService = ReturnType<typeof createIssueResolutionsService>;
