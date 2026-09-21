import { createHash } from "node:crypto";
import {
  normalizeEvidencePreviewInput,
  type EvidenceDraftInputItem,
  type EvidenceRole,
  type EvidenceTargetType,
} from "./evidence-selection.js";

export class InvalidAssessmentInputError extends Error {}
export class InvalidAssessmentCursorError extends Error {}

export type AssessmentStance = "SUPPORTS" | "CONTRADICTS" | "INCONCLUSIVE";
export type AssessmentConfidenceLevel = "LOW" | "MEDIUM" | "HIGH";

export interface NormalizedAssessmentInput {
  stance: AssessmentStance;
  confidenceLevel: AssessmentConfidenceLevel | null;
  reasoning: string;
  expectedManifestSha256: string;
  items: EvidenceDraftInputItem[];
}

export interface AssessmentRecord {
  id: string;
  claimId: string;
  stance: AssessmentStance;
  confidenceLevel: AssessmentConfidenceLevel | null;
  actorId: string | null;
  numericScore: number | null;
  scoreKind: string | null;
  reasoning: string | null;
  createdAt: string;
}

export interface AssessmentManifestSummary {
  id: string;
  schemaVersion: 1;
  purpose: "CLAIM_ASSESSMENT";
  manifestSha256: string;
  itemCount: number;
}

export interface AssessmentSummary {
  id: string;
  stance: AssessmentStance;
  confidenceLevel: AssessmentConfidenceLevel | null;
  actorId: string | null;
  numericScore: number | null;
  scoreKind: string | null;
  reasoningExcerpt: string | null;
  createdAt: string;
  evidenceManifest: AssessmentManifestSummary;
}

export interface AssessmentManifestItem {
  ordinal: number;
  role: EvidenceRole;
  targetType: EvidenceTargetType;
  targetId: string;
  locatorType: null;
  locator: null;
  excerpt: null;
  note: string | null;
}

export interface AssessmentDetailResponse {
  claim: {
    id: string;
    statement: string;
    lifecycleState: "ACTIVE" | "ARCHIVED";
  };
  assessment: AssessmentRecord;
  evidenceManifest: {
    id: string;
    schemaVersion: 1;
    purpose: "CLAIM_ASSESSMENT";
    manifestSha256: string;
    createdAt: string;
    items: AssessmentManifestItem[];
  };
}

export interface AssessmentHistoryResponse {
  claim: {
    id: string;
    statement: string;
    lifecycleState: "ACTIVE" | "ARCHIVED";
  };
  assessments: AssessmentSummary[];
  nextCursor: string | null;
}

const uuidPattern = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const stances = new Set(["SUPPORTS", "CONTRADICTS", "INCONCLUSIVE"]);
const confidences = new Set(["LOW", "MEDIUM", "HIGH"]);

function canonicalUuid(value: string, label: string): string {
  if (!uuidPattern.test(value)) throw new InvalidAssessmentInputError(label);
  return value.toLowerCase();
}

function normalizeReasoning(value: unknown): string {
  if (typeof value !== "string") throw new InvalidAssessmentInputError("评价理由必须是文本。");
  if (value.includes("\u0000")) throw new InvalidAssessmentInputError("评价理由包含不支持的字符。");
  const normalized = value
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/^[\p{White_Space}]+|[\p{White_Space}]+$/gu, "");
  const length = Array.from(normalized).length;
  if (length < 1 || length > 8000) {
    throw new InvalidAssessmentInputError("评价理由必须是 1 至 8000 个字符的文本。");
  }
  return normalized;
}

export function normalizeAssessmentCreateInput(value: unknown): NormalizedAssessmentInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidAssessmentInputError("评价输入格式不正确。");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(["stance", "confidenceLevel", "reasoning", "expectedManifestSha256", "items"]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new InvalidAssessmentInputError("评价输入包含不支持的字段。");
  }

  if (typeof record.stance !== "string" || !stances.has(record.stance)) {
    throw new InvalidAssessmentInputError("评价立场不正确。");
  }
  const confidenceRaw = record.confidenceLevel;
  const confidenceLevel = confidenceRaw === undefined || confidenceRaw === null
    ? null
    : typeof confidenceRaw === "string" && confidences.has(confidenceRaw)
      ? confidenceRaw as AssessmentConfidenceLevel
      : (() => { throw new InvalidAssessmentInputError("评价信心不正确。"); })();

  if (typeof record.expectedManifestSha256 !== "string" || !/^[0-9a-f]{64}$/.test(record.expectedManifestSha256)) {
    throw new InvalidAssessmentInputError("证据预览指纹不正确。");
  }

  let items: EvidenceDraftInputItem[];
  try {
    items = normalizeEvidencePreviewInput({ items: record.items });
  } catch (error) {
    throw error;
  }

  return {
    stance: record.stance as AssessmentStance,
    confidenceLevel,
    reasoning: normalizeReasoning(record.reasoning),
    expectedManifestSha256: record.expectedManifestSha256,
    items,
  };
}

export function hashAssessmentCreateRequest(
  projectId: string,
  issueId: string,
  claimId: string,
  input: NormalizedAssessmentInput,
): string {
  const payload = JSON.stringify({
    projectId: canonicalUuid(projectId, "项目 ID 格式不正确。"),
    issueId: canonicalUuid(issueId, "研究问题 ID 格式不正确。"),
    claimId: canonicalUuid(claimId, "可能答案 ID 格式不正确。"),
    stance: input.stance,
    confidenceLevel: input.confidenceLevel,
    reasoning: input.reasoning,
    expectedManifestSha256: input.expectedManifestSha256,
    items: input.items,
  });
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

export interface AssessmentCursor {
  createdAt: string;
  id: string;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

export function encodeAssessmentCursor(cursor: AssessmentCursor): string {
  if (!validTimestamp(cursor.createdAt) || !uuidPattern.test(cursor.id)) {
    throw new InvalidAssessmentCursorError("评价历史游标不正确。");
  }
  return Buffer.from(JSON.stringify({
    v: 1,
    createdAt: cursor.createdAt,
    id: cursor.id.toLowerCase(),
  }), "utf8").toString("base64url");
}

export function decodeAssessmentCursor(value: string): AssessmentCursor {
  if (typeof value !== "string" || !value) {
    throw new InvalidAssessmentCursorError("评价历史游标不正确。");
  }
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(decoded);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("shape");
    const record = parsed as Record<string, unknown>;
    if (
      Object.keys(record).length !== 3 ||
      record.v !== 1 ||
      !validTimestamp(record.createdAt) ||
      typeof record.id !== "string" ||
      !uuidPattern.test(record.id)
    ) {
      throw new Error("shape");
    }
    return { createdAt: record.createdAt, id: record.id.toLowerCase() };
  } catch {
    throw new InvalidAssessmentCursorError("评价历史游标不正确。");
  }
}

export function readAssessmentHistoryQuery(value: unknown): {
  limit: number;
  cursor: AssessmentCursor | null;
} {
  if (value === undefined || value === null) return { limit: 20, cursor: null };
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidAssessmentInputError("评价历史查询不正确。");
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!["limit", "cursor"].includes(key)) throw new InvalidAssessmentInputError("评价历史查询包含不支持的字段。");
  }

  let limit = 20;
  if (record.limit !== undefined) {
    if (typeof record.limit !== "string" || !/^[0-9]+$/.test(record.limit)) {
      throw new InvalidAssessmentInputError("评价历史数量不正确。");
    }
    limit = Number(record.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      throw new InvalidAssessmentInputError("评价历史数量必须是 1 至 50。");
    }
  }

  let cursor: AssessmentCursor | null = null;
  if (record.cursor !== undefined) {
    if (typeof record.cursor !== "string") throw new InvalidAssessmentCursorError("评价历史游标不正确。");
    cursor = decodeAssessmentCursor(record.cursor);
  }
  return { limit, cursor };
}

export function readAssessmentId(value: unknown): string {
  if (typeof value !== "string" || !uuidPattern.test(value)) {
    throw new InvalidAssessmentInputError("评价 ID 格式不正确。");
  }
  return value.toLowerCase();
}
