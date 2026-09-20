import { randomUUID } from "node:crypto";
import { readProjectId } from "../domain/project.js";
import {
  hashResearchIssueCreateRequest,
  readIdempotencyKey,
  readResearchIssueId,
  readResearchIssueInput,
  type ResearchIssue,
  type ResearchIssueProjectContext,
  type ResearchIssueSummary,
} from "../domain/research-issue.js";

export class ProjectReadOnlyError extends Error {}
export class ResearchIssueNotFoundError extends Error {}
export class ResearchIssueIntegrityError extends Error {}
export class ResearchIssueStoreUnavailableError extends Error {}
export class IdempotencyConflictError extends Error {}

export interface ResearchIssueStore {
  create(input: {
    projectId: string;
    issueId: string;
    idempotencyKey: string;
    requestHash: string;
    title: string;
    question: string;
  }): Promise<{
    status: "created" | "replayed";
    project: ResearchIssueProjectContext;
    issue: ResearchIssue;
  }>;
  list(projectId: string): Promise<{
    project: ResearchIssueProjectContext;
    issues: ResearchIssueSummary[];
  } | null>;
  get(projectId: string, issueId: string): Promise<{
    project: ResearchIssueProjectContext;
    issue: ResearchIssue;
  } | null>;
}

export function createResearchIssuesService(store: ResearchIssueStore) {
  return {
    async create(projectInput: unknown, keyInput: unknown, body: unknown) {
      const projectId = readProjectId(projectInput).toLowerCase();
      const idempotencyKey = readIdempotencyKey(keyInput);
      const input = readResearchIssueInput(body);
      return store.create({
        projectId,
        issueId: randomUUID(),
        idempotencyKey,
        requestHash: hashResearchIssueCreateRequest(projectId, input),
        ...input,
      });
    },
    async list(projectInput: unknown) {
      return store.list(readProjectId(projectInput).toLowerCase());
    },
    async get(projectInput: unknown, issueInput: unknown) {
      return store.get(
        readProjectId(projectInput).toLowerCase(),
        readResearchIssueId(issueInput),
      );
    },
  };
}

export type ResearchIssuesService = ReturnType<typeof createResearchIssuesService>;
