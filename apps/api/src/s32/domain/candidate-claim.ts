import { createHash } from "node:crypto";
import { readProjectId } from "./project.js";
import { readResearchIssueId } from "./research-issue.js";

export class InvalidCandidateClaimInputError extends Error {}
export type CandidateClaimLifecycle = "ACTIVE" | "ARCHIVED";

export interface CandidateClaim {
  id: string;
  statement: string;
  lifecycleState: CandidateClaimLifecycle;
  createdAt: string;
  updatedAt: string;
}

const uuidPattern = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

export function normalizeCandidateClaimStatement(value: unknown): string {
  if (typeof value !== "string") throw new InvalidCandidateClaimInputError("可能答案必须是文本。");
  if (value.includes("\u0000")) throw new InvalidCandidateClaimInputError("可能答案包含不支持的字符。");
  const normalized = value
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\p{White_Space}+/gu, " ")
    .replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");
  const length = Array.from(normalized).length;
  if (length < 1 || length > 4000) {
    throw new InvalidCandidateClaimInputError("可能答案必须是 1 至 4000 个字符的文本。");
  }
  return normalized;
}

export function readCandidateClaimId(value: unknown): string {
  if (typeof value !== "string" || !uuidPattern.test(value)) {
    throw new InvalidCandidateClaimInputError("Claim ID 格式不正确。");
  }
  return value.toLowerCase();
}

export function hashCandidateClaimCreateRequest(projectId: string, issueId: string, statement: string): string {
  const payload = JSON.stringify({
    projectId: readProjectId(projectId).toLowerCase(),
    issueId: readResearchIssueId(issueId),
    statement: normalizeCandidateClaimStatement(statement),
  });
  return createHash("sha256").update(payload, "utf8").digest("hex");
}
