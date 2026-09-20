export const RESEARCH_ISSUE_PENDING_KEY = "book-id-search:s32-m2a-issue-create-v1";

export interface ResearchIssueDraft {
  title: string;
  question: string;
}

export interface PendingResearchIssueReceipt {
  projectId: string;
  requestHash: string;
  idempotencyKey: string;
  createdAt: string;
}

let memoryReceipt: PendingResearchIssueReceipt | null = null;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function normalizeResearchIssueDraft(input: unknown): ResearchIssueDraft {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("研究问题输入不正确。");
  const { title: rawTitle, question: rawQuestion } = input as Record<string, unknown>;
  if (typeof rawTitle !== "string" || typeof rawQuestion !== "string") throw new Error("研究问题输入不正确。");
  const title = rawTitle.trim();
  const question = rawQuestion.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!title || title.includes("\r") || title.includes("\n") || Array.from(title).length > 160) {
    throw new Error("标题必须是 1 至 160 个字符的单行文本。");
  }
  if (!question || Array.from(question).length > 4000) throw new Error("问题必须是 1 至 4000 个字符的文本。");
  return { title, question };
}

export async function hashResearchIssueDraft(projectId: string, normalized: ResearchIssueDraft): Promise<string> {
  if (!uuidPattern.test(projectId)) throw new Error("项目 ID 格式不正确。");
  const draft = normalizeResearchIssueDraft(normalized);
  const payload = JSON.stringify({ projectId: projectId.toLowerCase(), title: draft.title, question: draft.question });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isReceipt(value: unknown): value is PendingResearchIssueReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  return typeof receipt.projectId === "string" && uuidPattern.test(receipt.projectId)
    && typeof receipt.requestHash === "string" && /^[0-9a-f]{64}$/.test(receipt.requestHash)
    && typeof receipt.idempotencyKey === "string" && uuidPattern.test(receipt.idempotencyKey)
    && typeof receipt.createdAt === "string" && Number.isFinite(Date.parse(receipt.createdAt));
}

export function loadPendingResearchIssueReceipt(): PendingResearchIssueReceipt | null {
  let raw: string | null;
  try {
    raw = sessionStorage.getItem(RESEARCH_ISSUE_PENDING_KEY);
  } catch {
    return memoryReceipt;
  }
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isReceipt(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function savePendingResearchIssueReceipt(receipt: PendingResearchIssueReceipt): void {
  if (!isReceipt(receipt)) throw new Error("Pending receipt is invalid.");
  memoryReceipt = receipt;
  try {
    sessionStorage.setItem(RESEARCH_ISSUE_PENDING_KEY, JSON.stringify(receipt));
  } catch {
    // The in-memory receipt preserves safe retry semantics for this page lifetime.
  }
}

export function clearPendingResearchIssueReceipt(): void {
  memoryReceipt = null;
  try {
    sessionStorage.removeItem(RESEARCH_ISSUE_PENDING_KEY);
  } catch {
    // Memory was already cleared.
  }
}

export async function getOrCreateResearchIssueReceipt(
  projectId: string,
  normalized: ResearchIssueDraft,
  forceNew = false,
): Promise<PendingResearchIssueReceipt> {
  const canonicalProjectId = projectId.toLowerCase();
  const requestHash = await hashResearchIssueDraft(canonicalProjectId, normalized);
  const existing = loadPendingResearchIssueReceipt();
  if (!forceNew && existing?.projectId === canonicalProjectId && existing.requestHash === requestHash) return existing;
  const receipt = {
    projectId: canonicalProjectId,
    requestHash,
    idempotencyKey: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  };
  savePendingResearchIssueReceipt(receipt);
  return receipt;
}
