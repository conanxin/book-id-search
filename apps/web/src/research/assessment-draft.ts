import type {
  AssessmentConfidenceLevel,
  AssessmentStance,
  EvidenceRole,
  EvidenceTargetType,
} from "./api";

export const ASSESSMENT_PENDING_KEY = "book-id-search:s32-m2d-assessment-create-v1";

export class PendingAssessmentIntentConflictError extends Error {
  constructor() {
    super("当前提交标识与已保存的评价内容不一致。");
    this.name = "PendingAssessmentIntentConflictError";
  }
}

export interface NormalizedAssessmentBrowserCommand {
  stance: AssessmentStance;
  confidenceLevel: AssessmentConfidenceLevel | null;
  reasoning: string;
  expectedManifestSha256: string;
  items: Array<{
    role: EvidenceRole;
    targetType: EvidenceTargetType;
    targetId: string;
    note: string | null;
  }>;
}

export interface PendingAssessmentReceipt {
  projectId: string;
  issueId: string;
  claimId: string;
  requestHash: string;
  idempotencyKey: string;
  createdAt: string;
  command: NormalizedAssessmentBrowserCommand;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const stances = new Set(["SUPPORTS", "CONTRADICTS", "INCONCLUSIVE"]);
const confidences = new Set(["LOW", "MEDIUM", "HIGH"]);
const roles = new Set(["SUPPORTING", "CONTRADICTORY", "CONTEXTUAL"]);
const targetTypes = new Set(["SOURCE", "SOURCE_ASSET", "NOTE_REVISION"]);

// undefined = storage may be restored; null = explicit page-local clear tombstone.
let memoryReceipt: PendingAssessmentReceipt | null | undefined;

function canonicalUuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !uuidPattern.test(value)) throw new Error(label);
  return value.toLowerCase();
}

function normalizeReasoning(value: unknown): string {
  if (typeof value !== "string") throw new Error("评价理由必须是文本。");
  if (value.includes("\u0000")) throw new Error("评价理由包含不支持的字符。");
  const normalized = value
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/^[\p{White_Space}]+|[\p{White_Space}]+$/gu, "");
  const length = Array.from(normalized).length;
  if (length < 1 || length > 8000) throw new Error("评价理由必须是 1 至 8000 个字符的文本。");
  return normalized;
}

export function normalizeAssessmentBrowserCommand(input: unknown): NormalizedAssessmentBrowserCommand {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("评价输入格式不正确。");
  const record = input as Record<string, unknown>;
  const allowed = new Set(["stance", "confidenceLevel", "reasoning", "expectedManifestSha256", "items"]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new Error("评价输入包含不支持的字段。");
  }

  if (typeof record.stance !== "string" || !stances.has(record.stance)) throw new Error("评价立场不正确。");
  const confidence = record.confidenceLevel;
  const confidenceLevel = confidence === undefined || confidence === null
    ? null
    : typeof confidence === "string" && confidences.has(confidence)
      ? confidence as AssessmentConfidenceLevel
      : (() => { throw new Error("评价信心不正确。"); })();

  if (typeof record.expectedManifestSha256 !== "string" || !/^[0-9a-f]{64}$/.test(record.expectedManifestSha256)) {
    throw new Error("证据预览指纹不正确。");
  }
  if (!Array.isArray(record.items) || record.items.length < 1 || record.items.length > 100) {
    throw new Error("证据集必须包含 1 至 100 项。");
  }

  const seen = new Set<string>();
  const items = record.items.map(raw => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("证据条目格式不正确。");
    const item = raw as Record<string, unknown>;
    const itemKeys = new Set(["role", "targetType", "targetId", "note"]);
    for (const key of Object.keys(item)) {
      if (!itemKeys.has(key)) throw new Error("证据条目包含不支持的字段。");
    }
    if (typeof item.role !== "string" || !roles.has(item.role)) throw new Error("证据角色不正确。");
    if (typeof item.targetType !== "string" || !targetTypes.has(item.targetType)) throw new Error("证据类型不正确。");
    const targetId = canonicalUuid(item.targetId, "证据 ID 格式不正确。");
    if (item.note !== null && typeof item.note !== "string") throw new Error("证据说明格式不正确。");
    const pair = item.targetType + ":" + targetId;
    if (seen.has(pair)) throw new Error("同一证据不能重复。");
    seen.add(pair);
    return {
      role: item.role as EvidenceRole,
      targetType: item.targetType as EvidenceTargetType,
      targetId,
      note: item.note as string | null,
    };
  });

  return {
    stance: record.stance as AssessmentStance,
    confidenceLevel,
    reasoning: normalizeReasoning(record.reasoning),
    expectedManifestSha256: record.expectedManifestSha256,
    items,
  };
}

function canonicalScope(scope: { projectId: string; issueId: string; claimId: string }) {
  return {
    projectId: canonicalUuid(scope.projectId, "项目 ID 格式不正确。"),
    issueId: canonicalUuid(scope.issueId, "研究问题 ID 格式不正确。"),
    claimId: canonicalUuid(scope.claimId, "可能答案 ID 格式不正确。"),
  };
}

export async function hashAssessmentCommand(
  scope: { projectId: string; issueId: string; claimId: string },
  command: NormalizedAssessmentBrowserCommand,
): Promise<string> {
  const canonical = canonicalScope(scope);
  const normalized = normalizeAssessmentBrowserCommand(command);
  const payload = JSON.stringify({
    ...canonical,
    stance: normalized.stance,
    confidenceLevel: normalized.confidenceLevel,
    reasoning: normalized.reasoning,
    expectedManifestSha256: normalized.expectedManifestSha256,
    items: normalized.items,
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

function isReceipt(value: unknown): value is PendingAssessmentReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  if (
    typeof receipt.projectId !== "string" ||
    typeof receipt.issueId !== "string" ||
    typeof receipt.claimId !== "string" ||
    !uuidPattern.test(receipt.projectId) ||
    !uuidPattern.test(receipt.issueId) ||
    !uuidPattern.test(receipt.claimId) ||
    receipt.projectId !== receipt.projectId.toLowerCase() ||
    receipt.issueId !== receipt.issueId.toLowerCase() ||
    receipt.claimId !== receipt.claimId.toLowerCase() ||
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
    const normalized = normalizeAssessmentBrowserCommand(receipt.command);
    return JSON.stringify(normalized) === JSON.stringify(receipt.command);
  } catch {
    return false;
  }
}

export function loadPendingAssessmentReceipt(): PendingAssessmentReceipt | null {
  if (memoryReceipt !== undefined) return memoryReceipt;
  try {
    const raw = sessionStorage.getItem(ASSESSMENT_PENDING_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isReceipt(parsed)) return null;
    memoryReceipt = parsed;
    return memoryReceipt;
  } catch {
    return null;
  }
}

function savePendingAssessmentReceipt(receipt: PendingAssessmentReceipt): void {
  if (!isReceipt(receipt)) throw new Error("Pending Assessment receipt is invalid.");
  memoryReceipt = receipt;
  try {
    sessionStorage.setItem(ASSESSMENT_PENDING_KEY, JSON.stringify(receipt));
  } catch {
    // In-memory receipt remains authoritative for this page lifetime.
  }
}

export function clearPendingAssessmentReceipt(): void {
  memoryReceipt = null;
  try {
    sessionStorage.removeItem(ASSESSMENT_PENDING_KEY);
  } catch {
    // Explicit memory tombstone already prevents stale storage restoration.
  }
}

export async function getOrCreateAssessmentReceipt(
  scope: { projectId: string; issueId: string; claimId: string },
  commandInput: unknown,
): Promise<PendingAssessmentReceipt> {
  const canonical = canonicalScope(scope);
  const command = normalizeAssessmentBrowserCommand(commandInput);
  const requestHash = await hashAssessmentCommand(canonical, command);
  const existing = loadPendingAssessmentReceipt();

  if (existing) {
    const sameScope =
      existing.projectId === canonical.projectId &&
      existing.issueId === canonical.issueId &&
      existing.claimId === canonical.claimId;
    if (sameScope && existing.requestHash === requestHash) return existing;
    throw new PendingAssessmentIntentConflictError();
  }

  const receipt: PendingAssessmentReceipt = {
    ...canonical,
    requestHash,
    idempotencyKey: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    command,
  };
  savePendingAssessmentReceipt(receipt);
  return receipt;
}

export function resetPendingAssessmentReceiptMemoryForTest(): void {
  memoryReceipt = undefined;
}
