import { createHash } from "node:crypto";
import type { AssessmentDetailResponse, AssessmentManifestSummary } from "./assessment.js";
import type { ResearchIssueLifecycle } from "./research-issue.js";

export class InvalidIssueResolutionInputError extends Error {}
export class InvalidIssueResolutionCursorError extends Error {}

export type IssueResolutionType = "PREFERRED_CLAIM" | "INSUFFICIENT_EVIDENCE" | "NO_WORKING_CONCLUSION";

export interface NormalizedIssueResolutionInput {
  expectedCurrentResolutionId: string | null;
  resolutionType: IssueResolutionType;
  preferredClaimId: string | null;
  rationale: string;
  evidenceManifestId: string | null;
}

/** Canonical persisted row; transport DTOs omit the raw evidence reference. */
export interface IssueResolutionRecord {
  id: string;
  issueId: string;
  resolutionType: IssueResolutionType;
  preferredClaimId: string | null;
  rationale: string | null;
  evidenceManifestId: string | null;
  createdAt: string;
}

export interface IssueResolutionIssueState {
  id: string;
  lifecycleState: ResearchIssueLifecycle;
  /** Authoritative research_issues.current_resolution_id, never history[0].id. */
  currentResolutionId: string | null;
  updatedAt: string;
}

type VisibleEvidence<T> =
  | { evidenceBasisAvailable: true; evidenceManifest: T }
  | { evidenceBasisAvailable: false; evidenceManifest: null };

export type IssueResolutionSummary = Omit<IssueResolutionRecord, "rationale" | "evidenceManifestId"> & {
  rationaleExcerpt: string | null;
  isCurrent: boolean;
} & VisibleEvidence<AssessmentManifestSummary>;

export type IssueResolutionDetailResponse = {
  issue: IssueResolutionIssueState;
  resolution: Omit<IssueResolutionRecord, "evidenceManifestId"> & { isCurrent: boolean };
} & VisibleEvidence<AssessmentDetailResponse["evidenceManifest"]>;

export interface CurrentWorkingConclusion {
  issue: IssueResolutionIssueState;
  /** Exact pointer-selected row, loaded separately even when outside the page. */
  currentResolution: IssueResolutionSummary | null;
}

export interface IssueResolutionHistoryResponse extends CurrentWorkingConclusion {
  /** History sorted by created_at DESC, id DESC; order does not define current. */
  resolutions: IssueResolutionSummary[];
  nextCursor: string | null;
}

const uuidPattern = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const resolutionTypes = new Set(["PREFERRED_CLAIM", "INSUFFICIENT_EVIDENCE", "NO_WORKING_CONCLUSION"]);

function isUuid(value: unknown): value is string {
  return typeof value === "string" && value.length === 36 && uuidPattern.test(value);
}

function canonicalUuid(value: unknown): string {
  if (!isUuid(value)) throw new InvalidIssueResolutionInputError("工作结论引用 ID 格式不正确。");
  return value.toLowerCase();
}

function nullableUuid(value: unknown): string | null {
  return value === null ? null : canonicalUuid(value);
}

function strictRecord(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new InvalidIssueResolutionInputError("工作结论输入必须是对象。");
  }
  if (Reflect.ownKeys(value).some(key => typeof key !== "string" || !allowed.includes(key))) {
    throw new InvalidIssueResolutionInputError("工作结论输入包含不支持的字段。");
  }
  return value as Record<string, unknown>;
}

function normalizeRationale(value: unknown): string {
  if (typeof value !== "string" || value.includes("\u0000")) {
    throw new InvalidIssueResolutionInputError("工作结论理由必须是不含空字符的文本。");
  }
  const rationale = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
    .replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");
  const length = Array.from(rationale).length;
  if (length < 1 || length > 8000) {
    throw new InvalidIssueResolutionInputError("工作结论理由必须是 1 至 8000 个字符的文本。");
  }
  return rationale;
}

export function normalizeIssueResolutionCreateInput(value: unknown): NormalizedIssueResolutionInput {
  const record = strictRecord(value, ["expectedCurrentResolutionId", "resolutionType", "preferredClaimId", "rationale", "evidenceManifestId"]);
  for (const key of ["expectedCurrentResolutionId", "resolutionType", "preferredClaimId", "rationale"]) {
    if (!Object.hasOwn(record, key)) throw new InvalidIssueResolutionInputError("工作结论输入缺少必填字段。");
  }
  if (typeof record.resolutionType !== "string" || !resolutionTypes.has(record.resolutionType)) {
    throw new InvalidIssueResolutionInputError("工作结论类型不正确。");
  }
  const preferredClaimId = nullableUuid(record.preferredClaimId);
  if ((record.resolutionType === "PREFERRED_CLAIM") !== (preferredClaimId !== null)) {
    throw new InvalidIssueResolutionInputError("工作结论类型与首选可能答案不一致。");
  }
  return {
    expectedCurrentResolutionId: nullableUuid(record.expectedCurrentResolutionId),
    resolutionType: record.resolutionType as IssueResolutionType,
    preferredClaimId,
    rationale: normalizeRationale(record.rationale),
    evidenceManifestId: record.evidenceManifestId === undefined ? null : nullableUuid(record.evidenceManifestId),
  };
}

export function readIssueResolutionId(value: unknown): string {
  return canonicalUuid(value);
}

/** Scope ownership is checked by the later store; this helper only defines current. */
export function isCurrentIssueResolution(resolutionId: string, currentResolutionId: string | null): boolean {
  return canonicalUuid(resolutionId) === nullableUuid(currentResolutionId);
}

export function hashIssueResolutionCreateRequest(projectId: string, issueId: string, input: NormalizedIssueResolutionInput): string {
  const normalized = normalizeIssueResolutionCreateInput(input);
  const payload = JSON.stringify({
    projectId: canonicalUuid(projectId),
    issueId: canonicalUuid(issueId),
    expectedCurrentResolutionId: normalized.expectedCurrentResolutionId,
    resolutionType: normalized.resolutionType,
    preferredClaimId: normalized.preferredClaimId,
    rationale: normalized.rationale,
    evidenceManifestId: normalized.evidenceManifestId,
  });
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

export interface IssueResolutionCursor {
  /** Canonical non-negative epoch microseconds (up to 18 digits), never JS Date/Number. */
  createdAtMicros: string;
  id: string;
}

function validCreatedAtMicros(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && /^(?:0|[1-9][0-9]{0,17})$/.test(value);
}

export function encodeIssueResolutionCursor(cursor: IssueResolutionCursor): string {
  if (!validCreatedAtMicros(cursor.createdAtMicros) || !isUuid(cursor.id)) {
    throw new InvalidIssueResolutionCursorError("工作结论历史游标不正确。");
  }
  return Buffer.from(JSON.stringify({ v: 2, createdAtMicros: cursor.createdAtMicros, id: cursor.id.toLowerCase() }), "utf8").toString("base64url");
}

export function decodeIssueResolutionCursor(value: string): IssueResolutionCursor {
  try {
    if (typeof value !== "string" || !value) throw new Error("empty");
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("shape");
    const record = parsed as Record<string, unknown>;
    if (Object.keys(record).length !== 3 || record.v !== 2 || !validCreatedAtMicros(record.createdAtMicros) || !isUuid(record.id)) throw new Error("shape");
    const cursor = { createdAtMicros: record.createdAtMicros, id: record.id };
    // Reject noncanonical base64/JSON/UUID spelling, not just invalid JSON.
    if (encodeIssueResolutionCursor(cursor) !== value) throw new Error("noncanonical");
    return cursor;
  } catch {
    throw new InvalidIssueResolutionCursorError("工作结论历史游标不正确。");
  }
}

export function readIssueResolutionHistoryQuery(value: unknown): { limit: number; cursor: IssueResolutionCursor | null } {
  if (value === undefined || value === null) return { limit: 20, cursor: null };
  const record = strictRecord(value, ["limit", "cursor"]);
  let limit = 20;
  if (record.limit !== undefined) {
    if (typeof record.limit !== "string" || record.limit.trim() !== record.limit || !/^[0-9]+$/.test(record.limit)) throw new InvalidIssueResolutionInputError("工作结论历史数量不正确。");
    limit = Number(record.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new InvalidIssueResolutionInputError("工作结论历史数量必须是 1 至 50。");
  }
  let cursor: IssueResolutionCursor | null = null;
  if (record.cursor !== undefined) {
    if (typeof record.cursor !== "string") throw new InvalidIssueResolutionCursorError("工作结论历史游标不正确。");
    cursor = decodeIssueResolutionCursor(record.cursor);
  }
  return { limit, cursor };
}
