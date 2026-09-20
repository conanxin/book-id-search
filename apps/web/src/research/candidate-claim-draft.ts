export const CANDIDATE_CLAIM_PENDING_KEY = "book-id-search:s32-m2b-claim-create-v1";

export interface PendingCandidateClaimReceipt {
  projectId: string;
  issueId: string;
  requestHash: string;
  idempotencyKey: string;
  createdAt: string;
}

// undefined allows restoration; null is an explicit page-local clear tombstone.
let memoryReceipt: PendingCandidateClaimReceipt | null | undefined;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function normalizeCandidateClaimDraft(input: unknown): string {
  if (typeof input !== "string") throw new Error("可能答案输入不正确。");
  const statement = input.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\p{White_Space}+/gu, " ").replace(/^ +| +$/g, "");
  if (!statement || statement.includes("\0") || Array.from(statement).length > 4000) throw new Error("可能答案必须是 1 至 4000 个字符的文本。");
  return statement;
}
export async function hashCandidateClaimDraft(projectId: string, issueId: string, input: unknown): Promise<string> {
  if (!uuidPattern.test(projectId) || !uuidPattern.test(issueId)) throw new Error("项目或研究问题 ID 格式不正确。");
  const statement = normalizeCandidateClaimDraft(input);
  const payload = JSON.stringify({ projectId: projectId.toLowerCase(), issueId: issueId.toLowerCase(), statement });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

function isReceipt(value: unknown): value is PendingCandidateClaimReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  return typeof receipt.projectId === "string" && uuidPattern.test(receipt.projectId)
    && typeof receipt.issueId === "string" && uuidPattern.test(receipt.issueId)
    && typeof receipt.requestHash === "string" && /^[0-9a-f]{64}$/.test(receipt.requestHash)
    && typeof receipt.idempotencyKey === "string" && uuidPattern.test(receipt.idempotencyKey)
    && typeof receipt.createdAt === "string" && Number.isFinite(Date.parse(receipt.createdAt));
}

export function loadPendingCandidateClaimReceipt(): PendingCandidateClaimReceipt | null {
  if (memoryReceipt !== undefined) return memoryReceipt;
  try {
    const raw = sessionStorage.getItem(CANDIDATE_CLAIM_PENDING_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isReceipt(parsed)) return null;
    memoryReceipt = parsed;
    return memoryReceipt;
  } catch {
    return null;
  }
}

export function savePendingCandidateClaimReceipt(receipt: PendingCandidateClaimReceipt): void {
  if (!isReceipt(receipt)) throw new Error("Pending receipt is invalid.");
  memoryReceipt = receipt;
  try {
    sessionStorage.setItem(CANDIDATE_CLAIM_PENDING_KEY, JSON.stringify(receipt));
  } catch {
    // The in-memory receipt preserves safe retry semantics for this page lifetime.
  }
}

export function clearPendingCandidateClaimReceipt(): void {
  memoryReceipt = null;
  try {
    sessionStorage.removeItem(CANDIDATE_CLAIM_PENDING_KEY);
  } catch {
    // Memory was already cleared.
  }
}

export async function getOrCreateCandidateClaimReceipt(
  projectId: string,
  issueId: string,
  normalized: string,
  forceNew = false,
): Promise<PendingCandidateClaimReceipt> {
  const canonicalProjectId = projectId.toLowerCase();
  const canonicalIssueId = issueId.toLowerCase();
  const requestHash = await hashCandidateClaimDraft(canonicalProjectId, canonicalIssueId, normalized);
  const existing = loadPendingCandidateClaimReceipt();
  if (!forceNew && existing?.projectId === canonicalProjectId && existing.issueId === canonicalIssueId && existing.requestHash === requestHash) return existing;
  const receipt = {
    projectId: canonicalProjectId,
    issueId: canonicalIssueId,
    requestHash,
    idempotencyKey: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  };
  savePendingCandidateClaimReceipt(receipt);
  return receipt;
}
