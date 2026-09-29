import type {
  CreateIssueResolutionInput,
  IssueResolutionType,
} from "./api";

export const ISSUE_RESOLUTION_PENDING_KEY = "book-id-search:s32-m2e-issue-resolution-create-v1";

export class PendingIssueResolutionIntentConflictError extends Error {
  constructor() {
    super("当前提交标识与已保存的工作结论内容不一致。");
    this.name = "PendingIssueResolutionIntentConflictError";
  }
}

export type NormalizedIssueResolutionBrowserCommand = CreateIssueResolutionInput;

export interface PendingIssueResolutionReceipt {
  projectId: string;
  issueId: string;
  requestHash: string;
  idempotencyKey: string;
  createdAt: string;
  command: NormalizedIssueResolutionBrowserCommand;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const resolutionTypes = new Set<IssueResolutionType>([
  "PREFERRED_CLAIM",
  "INSUFFICIENT_EVIDENCE",
  "NO_WORKING_CONCLUSION",
]);

// undefined = storage may be restored; null = explicit page-local clear tombstone.
let memoryReceipt: PendingIssueResolutionReceipt | null | undefined;

function canonicalUuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !uuidPattern.test(value)) throw new Error(label);
  return value.toLowerCase();
}

function nullableUuid(value: unknown, label: string): string | null {
  return value === null ? null : canonicalUuid(value, label);
}

function normalizeRationale(value: unknown): string {
  if (typeof value !== "string") throw new Error("工作结论理由必须是文本。");
  if (value.includes("\u0000")) throw new Error("工作结论理由包含不支持的字符。");
  const normalized = value
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/^[\p{White_Space}]+|[\p{White_Space}]+$/gu, "");
  const length = Array.from(normalized).length;
  if (length < 1 || length > 8000) throw new Error("工作结论理由必须是 1 至 8000 个字符的文本。");
  return normalized;
}

export function normalizeIssueResolutionBrowserCommand(
  input: unknown,
): NormalizedIssueResolutionBrowserCommand {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("工作结论输入格式不正确。");
  }
  const record = input as Record<string, unknown>;
  const allowed = new Set([
    "expectedCurrentResolutionId",
    "resolutionType",
    "preferredClaimId",
    "rationale",
    "evidenceManifestId",
  ]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new Error("工作结论输入包含不支持的字段。");
  }
  for (const key of [
    "expectedCurrentResolutionId",
    "resolutionType",
    "preferredClaimId",
    "rationale",
  ]) {
    if (!Object.hasOwn(record, key)) throw new Error("工作结论输入缺少必填字段。");
  }

  if (typeof record.resolutionType !== "string" || !resolutionTypes.has(record.resolutionType as IssueResolutionType)) {
    throw new Error("工作结论类型不正确。");
  }
  const resolutionType = record.resolutionType as IssueResolutionType;
  const expectedCurrentResolutionId = nullableUuid(
    record.expectedCurrentResolutionId,
    "当前工作结论 ID 格式不正确。",
  );
  const preferredClaimId = nullableUuid(
    record.preferredClaimId,
    "首选可能答案 ID 格式不正确。",
  );
  if ((resolutionType === "PREFERRED_CLAIM") !== (preferredClaimId !== null)) {
    throw new Error("工作结论类型与首选可能答案不一致。");
  }

  return {
    expectedCurrentResolutionId,
    resolutionType,
    preferredClaimId,
    rationale: normalizeRationale(record.rationale),
    evidenceManifestId: record.evidenceManifestId === undefined
      ? null
      : nullableUuid(record.evidenceManifestId, "证据依据 ID 格式不正确。"),
  };
}

function canonicalScope(scope: { projectId: string; issueId: string }) {
  return {
    projectId: canonicalUuid(scope.projectId, "项目 ID 格式不正确。"),
    issueId: canonicalUuid(scope.issueId, "研究问题 ID 格式不正确。"),
  };
}

export async function hashIssueResolutionCommand(
  scope: { projectId: string; issueId: string },
  command: NormalizedIssueResolutionBrowserCommand,
): Promise<string> {
  const canonical = canonicalScope(scope);
  const normalized = normalizeIssueResolutionBrowserCommand(command);
  const payload = JSON.stringify({
    projectId: canonical.projectId,
    issueId: canonical.issueId,
    expectedCurrentResolutionId: normalized.expectedCurrentResolutionId,
    resolutionType: normalized.resolutionType,
    preferredClaimId: normalized.preferredClaimId,
    rationale: normalized.rationale,
    evidenceManifestId: normalized.evidenceManifestId,
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

function isReceipt(value: unknown): value is PendingIssueResolutionReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  if (
    typeof receipt.projectId !== "string" ||
    typeof receipt.issueId !== "string" ||
    !uuidPattern.test(receipt.projectId) ||
    !uuidPattern.test(receipt.issueId) ||
    receipt.projectId !== receipt.projectId.toLowerCase() ||
    receipt.issueId !== receipt.issueId.toLowerCase() ||
    typeof receipt.requestHash !== "string" ||
    !/^[0-9a-f]{64}$/.test(receipt.requestHash) ||
    typeof receipt.idempotencyKey !== "string" ||
    !uuidPattern.test(receipt.idempotencyKey) ||
    typeof receipt.createdAt !== "string" ||
    !Number.isFinite(Date.parse(receipt.createdAt))
  ) {
    return false;
  }
  try {
    const normalized = normalizeIssueResolutionBrowserCommand(receipt.command);
    return JSON.stringify(normalized) === JSON.stringify(receipt.command);
  } catch {
    return false;
  }
}

export function loadPendingIssueResolutionReceipt(): PendingIssueResolutionReceipt | null {
  if (memoryReceipt !== undefined) return memoryReceipt;
  try {
    const raw = sessionStorage.getItem(ISSUE_RESOLUTION_PENDING_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isReceipt(parsed)) return null;
    memoryReceipt = parsed;
    return memoryReceipt;
  } catch {
    return null;
  }
}

function savePendingIssueResolutionReceipt(receipt: PendingIssueResolutionReceipt): void {
  if (!isReceipt(receipt)) throw new Error("Pending Issue Resolution receipt is invalid.");
  memoryReceipt = receipt;
  try {
    sessionStorage.setItem(ISSUE_RESOLUTION_PENDING_KEY, JSON.stringify(receipt));
  } catch {
    // In-memory receipt remains authoritative for this page lifetime.
  }
}

export function clearPendingIssueResolutionReceipt(): void {
  memoryReceipt = null;
  try {
    sessionStorage.removeItem(ISSUE_RESOLUTION_PENDING_KEY);
  } catch {
    // Explicit memory tombstone already prevents stale storage restoration.
  }
}

export async function getOrCreateIssueResolutionReceipt(
  scope: { projectId: string; issueId: string },
  commandInput: unknown,
): Promise<PendingIssueResolutionReceipt> {
  const canonical = canonicalScope(scope);
  const command = normalizeIssueResolutionBrowserCommand(commandInput);
  const requestHash = await hashIssueResolutionCommand(canonical, command);
  const existing = loadPendingIssueResolutionReceipt();

  if (existing) {
    const sameScope =
      existing.projectId === canonical.projectId &&
      existing.issueId === canonical.issueId;
    if (sameScope && existing.requestHash === requestHash) return existing;
    throw new PendingIssueResolutionIntentConflictError();
  }

  const receipt: PendingIssueResolutionReceipt = {
    ...canonical,
    requestHash,
    idempotencyKey: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    command,
  };
  savePendingIssueResolutionReceipt(receipt);
  return receipt;
}

export function resetPendingIssueResolutionReceiptMemoryForTest(): void {
  memoryReceipt = undefined;
}
