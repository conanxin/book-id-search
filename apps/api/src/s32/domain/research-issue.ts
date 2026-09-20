import { createHash } from "node:crypto";
import { readProjectId } from "./project.js";

export class InvalidResearchIssueInputError extends Error {}
export class InvalidIdempotencyKeyError extends Error {}

export type ResearchIssueLifecycle = "OPEN" | "RESOLVED" | "ARCHIVED";

export interface ResearchIssueProjectContext {
  id: string;
  name: string;
  lifecycleState: "ACTIVE" | "ARCHIVED";
  readOnly: boolean;
}

export interface ResearchIssue {
  id: string;
  projectId: string;
  title: string;
  question: string;
  lifecycleState: ResearchIssueLifecycle;
  createdAt: string;
  updatedAt: string;
}

export interface ResearchIssueSummary {
  id: string;
  projectId: string;
  title: string;
  questionExcerpt: string;
  lifecycleState: ResearchIssueLifecycle;
  createdAt: string;
  updatedAt: string;
}

export interface ResearchIssueInput {
  title: string;
  question: string;
}

const uuidPattern = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

export function readResearchIssueInput(value: unknown): ResearchIssueInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidResearchIssueInputError("研究问题输入必须是对象。");
  }

  const { title: rawTitle, question: rawQuestion } = value as Record<string, unknown>;
  if (typeof rawTitle !== "string" || typeof rawQuestion !== "string") {
    throw new InvalidResearchIssueInputError("标题和问题必须是文本。");
  }

  const title = rawTitle.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");
  const question = rawQuestion.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");
  if (!title || title.includes("\r") || title.includes("\n") || Array.from(title).length > 160) {
    throw new InvalidResearchIssueInputError("标题必须是 1 至 160 个字符的单行文本。");
  }
  if (!question || Array.from(question).length > 4000) {
    throw new InvalidResearchIssueInputError("问题必须是 1 至 4000 个字符的文本。");
  }
  return { title, question };
}

export function readResearchIssueId(value: unknown): string {
  if (typeof value !== "string" || !uuidPattern.test(value)) {
    throw new InvalidResearchIssueInputError("研究问题 ID 格式不正确。");
  }
  return value.toLowerCase();
}

export function readIdempotencyKey(value: unknown): string {
  if (typeof value !== "string" || !uuidPattern.test(value)) {
    throw new InvalidIdempotencyKeyError("Idempotency-Key 必须是 UUID。");
  }
  return value.toLowerCase();
}

export function buildResearchIssueQuestionExcerpt(question: string): string {
  const compact = question.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\p{White_Space}+/gu, " ").replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");
  const codePoints = Array.from(compact);
  return codePoints.length > 160 ? `${codePoints.slice(0, 160).join("")}…` : compact;
}

export function hashResearchIssueCreateRequest(projectId: string, input: ResearchIssueInput): string {
  const normalized = readResearchIssueInput(input);
  const payload = JSON.stringify({
    projectId: readProjectId(projectId).toLowerCase(),
    title: normalized.title,
    question: normalized.question,
  });
  return createHash("sha256").update(payload, "utf8").digest("hex");
}
