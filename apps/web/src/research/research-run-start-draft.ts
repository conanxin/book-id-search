import type {
  StartResearchRunInput,
} from "./api";

export const RESEARCH_RUN_START_PENDING_KEY = "book-id-search:s32-m3a-research-run-start-v1";

export class PendingResearchRunStartIntentConflictError extends Error {
  constructor() {
    super("当前提交标识与已保存的研究轮次内容不一致。");
    this.name = "PendingResearchRunStartIntentConflictError";
  }
}

export type NormalizedResearchRunStartBrowserCommand = StartResearchRunInput;

export interface PendingResearchRunStartReceipt {
  projectId: string;
  issueId: string;
  requestHash: string;
  idempotencyKey: string;
  createdAt: string;
  command: NormalizedResearchRunStartBrowserCommand;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

export const RESEARCH_RUN_STEP_KINDS = [
  "SEARCH", "READ", "COMPARE", "FIELDWORK", "MAP_ANALYSIS", "IMAGE_ANALYSIS", "OTHER",
] as const;
export const RESEARCH_RUN_MODES = ["HUMAN", "HUMAN_AI", "AUTOMATED"] as const;
export const RESEARCH_RUN_REPRO_LEVELS = ["EXACT", "PROCEDURE", "AUDIT"] as const;

const stepKinds = new Set<string>(RESEARCH_RUN_STEP_KINDS);
const modes = new Set<string>(RESEARCH_RUN_MODES);
const reproLevels = new Set<string>(RESEARCH_RUN_REPRO_LEVELS);

// undefined = storage may be restored; null = explicit page-local clear tombstone.
let memoryReceipt: PendingResearchRunStartReceipt | null | undefined;

function canonicalUuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !uuidPattern.test(value)) throw new Error(label);
  return value.toLowerCase();
}

function normalizeHumanText(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label}必须是文本。`);
  if (value.includes("\u0000")) throw new Error(`${label}包含不支持的字符。`);
  const normalized = value
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/^[\p{White_Space}]+|[\p{White_Space}]+$/gu, "");
  const bytes = new TextEncoder().encode(normalized).length;
  if (bytes < 1 || bytes > 65536) throw new Error(`${label}必须是 1 至 65536 个 UTF-8 字节内的文本。`);
  return normalized;
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

function normalizeSteps(value: unknown): StartResearchRunInput["procedure"]["steps"] {
  if (!Array.isArray(value) || value.length < 1) throw new Error("研究步骤至少需要一条。");
  return value.map(step => {
    if (!isPlainRecord(step) || !exactKeys(step, ["kind", "description"])) {
      throw new Error("研究步骤输入格式不正确。");
    }
    if (typeof step.kind !== "string" || !stepKinds.has(step.kind)) {
      throw new Error("研究步骤类型不正确。");
    }
    return {
      kind: step.kind as StartResearchRunInput["procedure"]["steps"][number]["kind"],
      description: normalizeHumanText(step.description, "研究步骤描述"),
    };
  });
}

function normalizeTools(value: unknown): StartResearchRunInput["executionContract"]["tools"] {
  if (!Array.isArray(value)) throw new Error("工具列表格式不正确。");
  return value.map(tool => {
    if (!isPlainRecord(tool) || !exactKeys(tool, ["name", "version"])) {
      throw new Error("工具输入格式不正确。");
    }
    return {
      name: normalizeHumanText(tool.name, "工具名称"),
      version: tool.version === null ? null : normalizeHumanText(tool.version, "工具版本"),
    };
  });
}

export function normalizeResearchRunStartBrowserCommand(
  input: unknown,
): NormalizedResearchRunStartBrowserCommand {
  const root = input;
  if (!isPlainRecord(root) || !exactKeys(root, ["procedure", "executionContract", "environment", "evidenceManifestId", "replayOf"])) {
    throw new Error("研究轮次输入格式不正确。");
  }
  const procedure = root.procedure;
  if (!isPlainRecord(procedure) || !exactKeys(procedure, ["version", "objective", "method", "steps"])) {
    throw new Error("研究方案输入格式不正确。");
  }
  if (procedure.version !== 1) throw new Error("研究方案版本不正确。");
  const contract = root.executionContract;
  if (!isPlainRecord(contract) || !exactKeys(contract, ["version", "mode", "reproducibilityLevel", "tools"])) {
    throw new Error("执行契约输入格式不正确。");
  }
  if (contract.version !== 1) throw new Error("执行契约版本不正确。");
  if (typeof contract.mode !== "string" || !modes.has(contract.mode)) throw new Error("执行模式不正确。");
  if (typeof contract.reproducibilityLevel !== "string" || !reproLevels.has(contract.reproducibilityLevel)) throw new Error("可复现等级不正确。");
  // Gate 3 v0.1: environment is fixed {} — any other shape is not part of this task's intent.
  if (!isPlainRecord(root.environment) || Reflect.ownKeys(root.environment).length !== 0) {
    throw new Error("研究轮次输入包含不支持的环境字段。");
  }
  if (root.replayOf !== null) throw new Error("研究轮次起始提交不支持重放引用。");
  return {
    procedure: {
      version: 1,
      objective: normalizeHumanText(procedure.objective, "研究目标"),
      method: normalizeHumanText(procedure.method, "研究方法"),
      steps: normalizeSteps(procedure.steps),
    },
    executionContract: {
      version: 1,
      mode: contract.mode as StartResearchRunInput["executionContract"]["mode"],
      reproducibilityLevel: contract.reproducibilityLevel as StartResearchRunInput["executionContract"]["reproducibilityLevel"],
      tools: normalizeTools(contract.tools),
    },
    environment: {},
    evidenceManifestId: canonicalUuid(root.evidenceManifestId, "证据快照 ID 格式不正确。"),
    replayOf: null,
  };
}

function canonicalScope(scope: { projectId: string; issueId: string }) {
  return {
    projectId: canonicalUuid(scope.projectId, "项目 ID 格式不正确。"),
    issueId: canonicalUuid(scope.issueId, "研究问题 ID 格式不正确。"),
  };
}

export async function hashResearchRunStartCommand(
  scope: { projectId: string; issueId: string },
  command: NormalizedResearchRunStartBrowserCommand,
): Promise<string> {
  const canonical = canonicalScope(scope);
  const normalized = normalizeResearchRunStartBrowserCommand(command);
  const payload = JSON.stringify({
    projectId: canonical.projectId,
    issueId: canonical.issueId,
    command: normalized,
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

function isReceipt(value: unknown): value is PendingResearchRunStartReceipt {
  if (!isPlainRecord(value)) return false;
  const allowed = new Set(["projectId", "issueId", "requestHash", "idempotencyKey", "createdAt", "command"]);
  if (Reflect.ownKeys(value).some(key => typeof key !== "string" || !allowed.has(key))) return false;
  if (
    typeof value.projectId !== "string" ||
    typeof value.issueId !== "string" ||
    !uuidPattern.test(value.projectId) ||
    !uuidPattern.test(value.issueId) ||
    value.projectId !== value.projectId.toLowerCase() ||
    value.issueId !== value.issueId.toLowerCase() ||
    typeof value.requestHash !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.requestHash) ||
    typeof value.idempotencyKey !== "string" ||
    !uuidPattern.test(value.idempotencyKey) ||
    !isCanonicalTimestamp(value.createdAt)
  ) {
    return false;
  }
  try {
    const normalized = normalizeResearchRunStartBrowserCommand(value.command);
    return JSON.stringify(normalized) === JSON.stringify(value.command);
  } catch {
    return false;
  }
}

export function loadPendingResearchRunStartReceipt(): PendingResearchRunStartReceipt | null {
  if (memoryReceipt !== undefined) return memoryReceipt;
  try {
    const raw = sessionStorage.getItem(RESEARCH_RUN_START_PENDING_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isReceipt(parsed)) return null;
    memoryReceipt = parsed;
    return memoryReceipt;
  } catch {
    return null;
  }
}

function savePendingResearchRunStartReceipt(receipt: PendingResearchRunStartReceipt): void {
  if (!isReceipt(receipt)) throw new Error("Pending ResearchRun start receipt is invalid.");
  memoryReceipt = receipt;
  try {
    sessionStorage.setItem(RESEARCH_RUN_START_PENDING_KEY, JSON.stringify(receipt));
  } catch {
    // In-memory receipt remains authoritative for this page lifetime.
  }
}

export function clearPendingResearchRunStartReceipt(): void {
  memoryReceipt = null;
  try {
    sessionStorage.removeItem(RESEARCH_RUN_START_PENDING_KEY);
  } catch {
    // Explicit memory tombstone already prevents stale storage restoration.
  }
}

export async function getOrCreateResearchRunStartReceipt(
  scope: { projectId: string; issueId: string },
  commandInput: unknown,
): Promise<PendingResearchRunStartReceipt> {
  const canonical = canonicalScope(scope);
  const command = normalizeResearchRunStartBrowserCommand(commandInput);
  const requestHash = await hashResearchRunStartCommand(canonical, command);
  const existing = loadPendingResearchRunStartReceipt();

  if (existing) {
    const storedHash = await hashResearchRunStartCommand(
      { projectId: existing.projectId, issueId: existing.issueId },
      existing.command,
    );
    if (storedHash !== existing.requestHash) {
      throw new PendingResearchRunStartIntentConflictError();
    }
    const sameScope =
      existing.projectId === canonical.projectId &&
      existing.issueId === canonical.issueId;
    if (sameScope && existing.requestHash === requestHash) return existing;
    throw new PendingResearchRunStartIntentConflictError();
  }

  const receipt: PendingResearchRunStartReceipt = {
    ...canonical,
    requestHash,
    idempotencyKey: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    command,
  };
  savePendingResearchRunStartReceipt(receipt);
  return receipt;
}

export function resetPendingResearchRunStartReceiptMemoryForTest(): void {
  memoryReceipt = undefined;
}
