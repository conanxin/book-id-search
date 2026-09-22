import { randomUUID } from "node:crypto";
import { readProjectId } from "../domain/project.js";
import { readResearchIssueId, readIdempotencyKey } from "../domain/research-issue.js";
import { readCandidateClaimId } from "../domain/candidate-claim.js";
import {
  hashAssessmentCreateRequest,
  normalizeAssessmentCreateInput,
  readAssessmentHistoryQuery,
  readAssessmentId,
  type AssessmentCursor,
  type AssessmentDetailResponse,
  type AssessmentHistoryResponse,
  type AssessmentManifestSummary,
  type AssessmentRecord,
  type NormalizedAssessmentInput,
} from "../domain/assessment.js";

export class AssessmentScopeNotFoundError extends Error {}
export class AssessmentNotFoundError extends Error {}
export class AssessmentIntegrityError extends Error {}
export class AssessmentStoreUnavailableError extends Error {}
export class AssessmentEvidenceTargetNotAvailableError extends Error {}
export class EvidencePreviewStaleError extends Error {}
export class ProjectReadOnlyForAssessmentError extends Error {}
export class ResearchIssueReadOnlyForAssessmentError extends Error {}
export class AssessmentIdempotencyConflictError extends Error {}

export interface AssessmentCreateCommand extends NormalizedAssessmentInput {
  projectId: string;
  issueId: string;
  claimId: string;
  assessmentId: string;
  manifestId: string;
  manifestItemIds: string[];
  idempotencyKey: string;
  requestHash: string;
}

export type AssessmentCommandResult =
  | {
      status: "created";
      assessment: AssessmentRecord;
      evidenceManifest: AssessmentManifestSummary;
    }
  | {
      status: "replayed";
      assessmentId: string;
    };

export interface AssessmentCommandStore {
  create(input: AssessmentCreateCommand): Promise<AssessmentCommandResult>;
}

export interface AssessmentListCommand {
  projectId: string;
  issueId: string;
  claimId: string;
  limit: number;
  cursor: AssessmentCursor | null;
}

export interface AssessmentGetCommand {
  projectId: string;
  issueId: string;
  claimId: string;
  assessmentId: string;
}

export type AssessmentHistoryLookup =
  | { kind: "scope-missing" }
  | { kind: "ok"; value: AssessmentHistoryResponse };

export type AssessmentDetailLookup =
  | { kind: "scope-missing" }
  | { kind: "not-visible" }
  | { kind: "ok"; value: AssessmentDetailResponse };

export interface AssessmentReadStore {
  list(input: AssessmentListCommand): Promise<AssessmentHistoryLookup>;
  get(input: AssessmentGetCommand): Promise<AssessmentDetailLookup>;
}

export type AssessmentCreateResult =
  | {
      status: "created" | "replayed";
      visible: true;
      assessment: AssessmentRecord;
      evidenceManifest: AssessmentManifestSummary;
    }
  | {
      status: "replayed";
      visible: false;
      assessmentId: string;
    };

export function createAssessmentsService(
  commandStore: AssessmentCommandStore,
  readStore: AssessmentReadStore,
) {
  return {
    async create(
      projectInput: unknown,
      issueInput: unknown,
      claimInput: unknown,
      keyInput: unknown,
      body: unknown,
    ): Promise<AssessmentCreateResult> {
      const projectId = readProjectId(projectInput).toLowerCase();
      const issueId = readResearchIssueId(issueInput);
      const claimId = readCandidateClaimId(claimInput);
      const idempotencyKey = readIdempotencyKey(keyInput);
      const normalized = normalizeAssessmentCreateInput(body);
      const command: AssessmentCreateCommand = {
        projectId,
        issueId,
        claimId,
        assessmentId: randomUUID(),
        manifestId: randomUUID(),
        manifestItemIds: normalized.items.map(() => randomUUID()),
        idempotencyKey,
        requestHash: hashAssessmentCreateRequest(projectId, issueId, claimId, normalized),
        ...normalized,
      };

      const result = await commandStore.create(command);
      if (result.status === "created") {
        return {
          status: "created",
          visible: true,
          assessment: result.assessment,
          evidenceManifest: result.evidenceManifest,
        };
      }

      const lookup = await readStore.get({
        projectId,
        issueId,
        claimId,
        assessmentId: result.assessmentId,
      });
      if (lookup.kind !== "ok") {
        return {
          status: "replayed",
          visible: false,
          assessmentId: result.assessmentId,
        };
      }
      return {
        status: "replayed",
        visible: true,
        assessment: lookup.value.assessment,
        evidenceManifest: {
          id: lookup.value.evidenceManifest.id,
          schemaVersion: 1,
          purpose: "CLAIM_ASSESSMENT",
          manifestSha256: lookup.value.evidenceManifest.manifestSha256,
          itemCount: lookup.value.evidenceManifest.items.length,
        },
      };
    },

    async list(
      projectInput: unknown,
      issueInput: unknown,
      claimInput: unknown,
      queryInput: unknown,
    ): Promise<AssessmentHistoryResponse> {
      const projectId = readProjectId(projectInput).toLowerCase();
      const issueId = readResearchIssueId(issueInput);
      const claimId = readCandidateClaimId(claimInput);
      const query = readAssessmentHistoryQuery(queryInput);
      const result = await readStore.list({ projectId, issueId, claimId, ...query });
      if (result.kind === "scope-missing") {
        throw new AssessmentScopeNotFoundError("PROJECT_ISSUE_OR_CLAIM_NOT_FOUND");
      }
      return result.value;
    },

    async get(
      projectInput: unknown,
      issueInput: unknown,
      claimInput: unknown,
      assessmentInput: unknown,
    ): Promise<AssessmentDetailResponse> {
      const projectId = readProjectId(projectInput).toLowerCase();
      const issueId = readResearchIssueId(issueInput);
      const claimId = readCandidateClaimId(claimInput);
      const assessmentId = readAssessmentId(assessmentInput);
      const result = await readStore.get({ projectId, issueId, claimId, assessmentId });
      if (result.kind === "scope-missing") {
        throw new AssessmentScopeNotFoundError("PROJECT_ISSUE_OR_CLAIM_NOT_FOUND");
      }
      if (result.kind === "not-visible") {
        throw new AssessmentNotFoundError("ASSESSMENT_NOT_FOUND");
      }
      return result.value;
    },
  };
}

export type AssessmentsService = ReturnType<typeof createAssessmentsService>;
