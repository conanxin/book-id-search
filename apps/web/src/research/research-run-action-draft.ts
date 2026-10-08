import type { ReplayResearchRunInput, ResearchRunOutput } from "./api";

export const RESEARCH_RUN_ACTION_PENDING_KEY = "book-id-search:s32-m3a-research-run-action-v1";

export type ResearchRunAction = "COMPLETE" | "FAIL" | "CANCEL" | "REPLAY";
export const RESEARCH_RUN_ACTIONS: readonly ResearchRunAction[] = ["COMPLETE", "FAIL", "CANCEL", "REPLAY"];

export class PendingResearchRunActionIntentConflictError extends Error {
  constructor() {
    super("当前提交标识与已保存的研究轮次操作不一致。");
    this.name = "PendingResearchRunActionIntentConflictError";
  }
}

export type ResearchRunActionCommand =
  | { action: "COMPLETE"; output: ResearchRunOutput }
  | { action: "FAIL" | "CANCEL"; output: null }
  | { action: "REPLAY"; command: ReplayResearchRunInput };

/** Command stored in a receipt: the exact POST body wire shape for the action. */
export type PendingResearchRunActionCommand =
  | { output: ResearchRunOutput }
  | { output: null }
  | ReplayResearchRunInput;

export interface PendingResearchRunActionReceipt {
  projectId: string;
  issueId: string;
  runId: string;
  action: ResearchRunAction;
  requestHash: string;
  idempotencyKey: string;
  createdAt: string;
  command: PendingResearchRunActionCommand;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function canonicalUuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !uuidPattern.test(value)) throw new Error(label);
  return value.toLowerCase();
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length) return false;
  return keys.every(key => Object.hasOwn(value, key));
}

function normalizeHumanText(value: unknown, label: string, maxBytes = 65536): string {
  if (typeof value !== "string") throw new Error(`${label}必须是文本。`);
  if (value.includes("\u0000")) throw new Error(`${label}包含不支持的字符。`);
  const normalized = value
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/^[\p{White_Space}]+|[\p{White_Space}]+$/gu, "");
  const bytes = new TextEncoder().encode(normalized).length;
  if (bytes < 1 || bytes > maxBytes) throw new Error(`${label}必须在 1 至 ${maxBytes} 个 UTF-8 字节内。`);
  return normalized;
}

// ---------------------------------------------------------------- COMPLETE output parsing

const PRODUCED_KEYS = ["claimIds", "assessmentIds", "resolutionIds", "noteRevisionIds"] as const;
const GAP_STATUSES = new Set(["OPEN", "BLOCKED", "DEFERRED"]);

/** Parse a COMPLETE Output v1 from browser draft form values. Throws safe Error on violation. */
export function parseResearchRunCompleteOutput(input: unknown): ResearchRunOutput {
  if (!isPlainRecord(input) || !exactKeys(input, ["summary", "produced", "gaps"])) {
    throw new Error("研究产出输入格式不正确。");
  }
  const summary = normalizeHumanText(input.summary, "研究产出摘要");
  const producedRaw = input.produced;
  if (!isPlainRecord(producedRaw) || !exactKeys(producedRaw, PRODUCED_KEYS)) {
    throw new Error("研究产出引用输入格式不正确。");
  }
  const produced: Record<string, string[]> = {};
  for (const key of PRODUCED_KEYS) {
    const raw = producedRaw[key];
    if (typeof raw !== "string") throw new Error("研究产出引用必须是文本（每行一个 ID）。");
    const lines = raw.split("\n").map(line => line.trim()).filter(line => line.length > 0);
    const seen = new Set<string>();
    for (const line of lines) {
      const canonical = canonicalUuid(line, `研究产出 ${key} 包含格式不正确的 ID。`);
      if (seen.has(canonical)) throw new Error(`研究产出 ${key} 包含重复 ID。`);
      seen.add(canonical);
    }
    produced[key] = lines.map(line => line.toLowerCase());
  }
  const gapsRaw = input.gaps;
  if (!Array.isArray(gapsRaw)) throw new Error("研究产出缺口输入格式不正确。");
  const gaps = gapsRaw.map(gap => {
    if (!isPlainRecord(gap) || !exactKeys(gap, ["description", "status"])) {
      throw new Error("研究产出缺口输入格式不正确。");
    }
    if (typeof gap.status !== "string" || !GAP_STATUSES.has(gap.status)) throw new Error("研究产出缺口状态不正确。");
    return { description: normalizeHumanText(gap.description, "研究产出缺口描述"), status: gap.status as "OPEN" | "BLOCKED" | "DEFERRED" };
  });
  return { version: 1, summary, produced: produced as ResearchRunOutput["produced"], gaps };
}

/** Strict structural validator for an already-normalized Output v1 (receipt restore). */
export function isResearchRunCompleteOutput(value: unknown): value is ResearchRunOutput {
  if (!isPlainRecord(value) || !exactKeys(value, ["version", "summary", "produced", "gaps"])) return false;
  if (value.version !== 1 || typeof value.summary !== "string" || value.summary.length === 0) return false;
  if (value.summary.includes("\u0000")) return false;
  const produced = value.produced;
  if (!isPlainRecord(produced) || !exactKeys(produced, PRODUCED_KEYS)) return false;
  for (const key of PRODUCED_KEYS) {
    const list = produced[key];
    if (!Array.isArray(list)) return false;
    const seen = new Set<string>();
    for (const id of list) {
      if (typeof id !== "string" || !uuidPattern.test(id) || id !== id.toLowerCase()) return false;
      if (seen.has(id)) return false;
      seen.add(id);
    }
  }
  if (!Array.isArray(value.gaps)) return false;
  return value.gaps.every((gap: unknown) => {
    if (!isPlainRecord(gap) || !exactKeys(gap, ["description", "status"])) return false;
    return typeof gap.description === "string" && gap.description.length > 0
      && typeof gap.status === "string" && GAP_STATUSES.has(gap.status);
  });
}

// ---------------------------------------------------------------- REPLAY command validation

const REPLAY_KEYS = ["procedure", "executionContract", "environment", "evidenceManifestId"] as const;

/** Strict structural validator for a Replay command copied from a validated parent detail. */
export function isReplayResearchRunCommand(value: unknown): value is ReplayResearchRunInput {
  if (!isPlainRecord(value) || !exactKeys(value, REPLAY_KEYS)) return false;
  const procedure = value.procedure as Record<string, unknown> | undefined;
  if (!isPlainRecord(procedure) || !exactKeys(procedure, ["version", "objective", "method", "steps"])) return false;
  if (procedure.version !== 1 || typeof procedure.objective !== "string" || procedure.objective.length === 0) return false;
  if (typeof procedure.method !== "string" || procedure.method.length === 0) return false;
  if (!Array.isArray(procedure.steps) || procedure.steps.length < 1) return false;
  if (!procedure.steps.every((step: unknown) => {
    if (!isPlainRecord(step) || !exactKeys(step as Record<string, unknown>, ["kind", "description"])) return false;
    const record = step as Record<string, unknown>;
    return typeof record.kind === "string" && typeof record.description === "string" && record.description.length > 0;
  })) return false;
  const contract = value.executionContract as Record<string, unknown> | undefined;
  if (!isPlainRecord(contract) || !exactKeys(contract, ["version", "mode", "reproducibilityLevel", "tools"])) return false;
  if (contract.version !== 1 || typeof contract.mode !== "string" || typeof contract.reproducibilityLevel !== "string") return false;
  if (!Array.isArray(contract.tools)) return false;
  if (!contract.tools.every((tool: unknown) => {
    if (!isPlainRecord(tool) || !exactKeys(tool as Record<string, unknown>, ["name", "version"])) return false;
    const record = tool as Record<string, unknown>;
    return typeof record.name === "string" && (record.version === null || typeof record.version === "string");
  })) return false;
  const environment = value.environment;
  if (!isPlainRecord(environment)) return false;
  for (const key of Reflect.ownKeys(environment)) {
    if (typeof key !== "string") return false;
    const inner = environment[key];
    if (inner === null || typeof inner === "boolean" || typeof inner === "number" || typeof inner === "string") continue;
    if (Array.isArray(inner) || isPlainRecord(inner)) continue;
    return false;
  }
  return typeof value.evidenceManifestId === "string" && uuidPattern.test(value.evidenceManifestId) && value.evidenceManifestId === value.evidenceManifestId.toLowerCase();
}

// ---------------------------------------------------------------- receipt core

/**
 * Validate the raw wire-shape command for an action and return it unchanged
 * (receipt stores the exact body that will be POSTed).
 */
function normalizeActionCommand(action: string, command: unknown): unknown {
  if (!isRawActionCommand(action, command)) {
    if (action === "COMPLETE") throw new Error("研究产出命令格式不正确。");
    if (action === "REPLAY") throw new Error("研究轮次重放命令格式不正确。");
    throw new Error("研究轮次操作命令格式不正确。");
  }
  return command;
}

function canonicalScope(scope: { projectId: string; issueId: string; runId: string }) {
  return {
    projectId: canonicalUuid(scope.projectId, "项目 ID 格式不正确。"),
    issueId: canonicalUuid(scope.issueId, "研究问题 ID 格式不正确。"),
    runId: canonicalUuid(scope.runId, "研究轮次 ID 格式不正确。"),
  };
}

export async function hashResearchRunActionIntent(
  scope: { projectId: string; issueId: string; runId: string },
  action: ResearchRunAction,
  command: unknown,
): Promise<string> {
  const canonical = canonicalScope(scope);
  const payload = JSON.stringify({
    projectId: canonical.projectId,
    issueId: canonical.issueId,
    runId: canonical.runId,
    action,
    command,
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

// undefined = storage may be restored; null = explicit page-local clear tombstone.
let memoryReceipt: PendingResearchRunActionReceipt | null | undefined;

/** Validate the raw wire-shape command stored in a receipt (per-action exact keys). */
function isRawActionCommand(action: string, command: unknown): boolean {
  if (!isPlainRecord(command)) return false;
  if (action === "COMPLETE") return exactKeys(command, ["output"]) && isResearchRunCompleteOutput(command.output);
  if (action === "FAIL" || action === "CANCEL") return exactKeys(command, ["output"]) && command.output === null;
  if (action === "REPLAY") return isReplayResearchRunCommand(command);
  return false;
}

function isReceipt(value: unknown): value is PendingResearchRunActionReceipt {
  if (!isPlainRecord(value)) return false;
  const allowed = new Set(["projectId", "issueId", "runId", "action", "requestHash", "idempotencyKey", "createdAt", "command"]);
  if (Reflect.ownKeys(value).some(key => typeof key !== "string" || !allowed.has(key))) return false;
  if (
    typeof value.projectId !== "string" || !uuidPattern.test(value.projectId) || value.projectId !== value.projectId.toLowerCase() ||
    typeof value.issueId !== "string" || !uuidPattern.test(value.issueId) || value.issueId !== value.issueId.toLowerCase() ||
    typeof value.runId !== "string" || !uuidPattern.test(value.runId) || value.runId !== value.runId.toLowerCase() ||
    typeof value.action !== "string" || !RESEARCH_RUN_ACTIONS.includes(value.action as ResearchRunAction) ||
    typeof value.requestHash !== "string" || !/^[0-9a-f]{64}$/.test(value.requestHash) ||
    typeof value.idempotencyKey !== "string" || !uuidPattern.test(value.idempotencyKey) ||
    !isCanonicalTimestamp(value.createdAt)
  ) {
    return false;
  }
  return isRawActionCommand(value.action, value.command);
}

export function loadPendingResearchRunActionReceipt(): PendingResearchRunActionReceipt | null {
  if (memoryReceipt !== undefined) return memoryReceipt;
  try {
    const raw = sessionStorage.getItem(RESEARCH_RUN_ACTION_PENDING_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isReceipt(parsed)) return null;
    memoryReceipt = parsed;
    return memoryReceipt;
  } catch {
    return null;
  }
}

function savePendingResearchRunActionReceipt(receipt: PendingResearchRunActionReceipt): void {
  if (!isReceipt(receipt)) throw new Error("Pending ResearchRun action receipt is invalid.");
  memoryReceipt = receipt;
  try {
    sessionStorage.setItem(RESEARCH_RUN_ACTION_PENDING_KEY, JSON.stringify(receipt));
  } catch {
    // In-memory receipt remains authoritative for this page lifetime.
  }
}

export function clearPendingResearchRunActionReceipt(): void {
  memoryReceipt = null;
  try {
    sessionStorage.removeItem(RESEARCH_RUN_ACTION_PENDING_KEY);
  } catch {
    // Explicit memory tombstone already prevents stale storage restoration.
  }
}

/**
 * One pending action at a time. A pending action on another Run/another
 * intent is a conflict — never silently rotate.
 */
export async function getOrCreateResearchRunActionReceipt(
  scope: { projectId: string; issueId: string; runId: string },
  action: ResearchRunAction,
  commandInput: unknown,
): Promise<PendingResearchRunActionReceipt> {
  const canonical = canonicalScope(scope);
  const command = normalizeActionCommand(action, commandInput);
  const requestHash = await hashResearchRunActionIntent(canonical, action, command);
  const existing = loadPendingResearchRunActionReceipt();

  if (existing) {
    const storedHash = await hashResearchRunActionIntent(
      { projectId: existing.projectId, issueId: existing.issueId, runId: existing.runId },
      existing.action,
      existing.command,
    );
    if (storedHash !== existing.requestHash) {
      throw new PendingResearchRunActionIntentConflictError();
    }
    const sameScope =
      existing.projectId === canonical.projectId &&
      existing.issueId === canonical.issueId &&
      existing.runId === canonical.runId &&
      existing.action === action;
    if (sameScope && existing.requestHash === requestHash) return existing;
    throw new PendingResearchRunActionIntentConflictError();
  }

  const receipt: PendingResearchRunActionReceipt = {
    ...canonical,
    action,
    requestHash,
    idempotencyKey: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    command: command as PendingResearchRunActionCommand,
  };
  savePendingResearchRunActionReceipt(receipt);
  return receipt;
}

export function resetPendingResearchRunActionReceiptMemoryForTest(): void {
  memoryReceipt = undefined;
}
