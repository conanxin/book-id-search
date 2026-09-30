import { createHash } from "node:crypto";

/**
 * ResearchRun domain contracts (M3-A Gate 2, Task 1).
 *
 * Mirrors `core.research_runs` (schema unchanged): procedure /
 * execution_contract / environment / output are JSONB payloads validated
 * here BEFORE any persistence. Application layer makes `issueId` mandatory
 * even though the DB column is nullable — see application/research-runs.ts.
 */

export class InvalidResearchRunInputError extends Error {}
export class InvalidResearchRunTransitionError extends Error {}

const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

const MAX_HUMAN_STRING_BYTES = 65536;

const PROCEDURE_STEP_KINDS = [
  "SEARCH",
  "READ",
  "COMPARE",
  "FIELDWORK",
  "MAP_ANALYSIS",
  "IMAGE_ANALYSIS",
  "OTHER",
] as const;
export type ProcedureStepKind = (typeof PROCEDURE_STEP_KINDS)[number];

export const RESEARCH_RUN_STATUSES = ["RUNNING", "SUCCEEDED", "FAILED", "CANCELLED"] as const;
export type ResearchRunStatus = (typeof RESEARCH_RUN_STATUSES)[number];

export type TerminalResearchRunStatus = Exclude<ResearchRunStatus, "RUNNING">;

export type ResearchRunMode = "HUMAN" | "HUMAN_AI" | "AUTOMATED";
export type ResearchRunReproducibilityLevel = "EXACT" | "PROCEDURE" | "AUDIT";
export type ResearchRunGapStatus = "OPEN" | "BLOCKED" | "DEFERRED";

export interface ProcedureStep {
  kind: ProcedureStepKind;
  description: string;
}

export interface ResearchRunProcedure {
  version: 1;
  objective: string;
  method: string;
  steps: ProcedureStep[];
}

export interface ResearchRunTool {
  name: string;
  version: string | null;
}

export interface ResearchRunExecutionContract {
  version: 1;
  mode: ResearchRunMode;
  reproducibilityLevel: ResearchRunReproducibilityLevel;
  tools: ResearchRunTool[];
}

export interface ResearchRunGap {
  description: string;
  status: ResearchRunGapStatus;
}

export interface ResearchRunProduced {
  claimIds: string[];
  assessmentIds: string[];
  resolutionIds: string[];
  noteRevisionIds: string[];
}

export interface ResearchRunOutput {
  version: 1;
  summary: string;
  produced: ResearchRunProduced;
  gaps: ResearchRunGap[];
}

/** Plain JSON object of non-secret execution facts only. */
export type ResearchRunEnvironment = Readonly<Record<string, unknown>>;

// ---------------------------------------------------------------------------
// Shared string / object primitives
// ---------------------------------------------------------------------------

function invalid(message: string): never {
  throw new InvalidResearchRunInputError(message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Exact-key gate: unknown fields are rejected, never silently dropped. */
function requireExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || expected.some((k) => !(k in value))) {
    invalid(`${label} 字段必须恰好为：${expected.join(", ")}。`);
  }
}

/** Normalize human-authored strings: CRLF→LF, Unicode-whitespace trim, NUL/blank reject. */
function normalizeHumanString(value: unknown, label: string): string {
  if (typeof value !== "string") invalid(`${label} 必须是文本。`);
  if (value.includes("\0")) invalid(`${label} 不能包含 NUL 字符。`);
  let normalized = value.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  // Unicode whitespace trim (covers \u00A0, \u2028, ideographic space, etc.)
  normalized = normalized.replace(/^\s+|\s+$/gu, "");
  if (!normalized) invalid(`${label} 不能为空白。`);
  if (Buffer.byteLength(normalized, "utf8") > MAX_HUMAN_STRING_BYTES) {
    invalid(`${label} 超过 65536 UTF-8 字节上限。`);
  }
  return normalized;
}

function readExactVersion(value: unknown, expectedVersion: number, label: string): void {
  if (value !== expectedVersion) invalid(`${label} version 必须为 ${expectedVersion}。`);
}

/** Canonical lowercase UUID reference (input may be any UUID case). */
function readUuidReference(value: unknown, label: string): string {
  if (typeof value !== "string" || !UUID.test(value)) invalid(`${label} 必须是 UUID。`);
  return value.toLowerCase();
}

// ---------------------------------------------------------------------------
// Procedure v1
// ---------------------------------------------------------------------------

export function readResearchRunProcedure(value: unknown): ResearchRunProcedure {
  if (!isPlainObject(value)) invalid("procedure 必须是 JSON 对象。");
  requireExactKeys(value, ["version", "objective", "method", "steps"], "procedure");
  readExactVersion(value.version, 1, "procedure");

  const objective = normalizeHumanString(value.objective, "procedure.objective");
  const method = normalizeHumanString(value.method, "procedure.method");

  if (!Array.isArray(value.steps) || value.length === 0 || value.steps.length === 0) {
    invalid("procedure.steps 必须是非空数组。");
  }
  const steps: ProcedureStep[] = value.steps.map((step, index) => {
    if (!isPlainObject(step)) invalid(`procedure.steps[${index}] 必须是对象。`);
    requireExactKeys(step, ["kind", "description"], `procedure.steps[${index}]`);
    const kind = step.kind;
    if (typeof kind !== "string" || !PROCEDURE_STEP_KINDS.includes(kind as ProcedureStepKind)) {
      invalid(`procedure.steps[${index}].kind 必须是：${PROCEDURE_STEP_KINDS.join(" | ")}。`);
    }
    const description = normalizeHumanString(step.description, `procedure.steps[${index}].description`);
    return { kind: kind as ProcedureStepKind, description };
  });

  return { version: 1, objective, method, steps };
}

// ---------------------------------------------------------------------------
// Execution contract v1
// ---------------------------------------------------------------------------

const EXECUTION_MODES = ["HUMAN", "HUMAN_AI", "AUTOMATED"] as const;
const REPRODUCIBILITY_LEVELS = ["EXACT", "PROCEDURE", "AUDIT"] as const;

export function readResearchRunExecutionContract(value: unknown): ResearchRunExecutionContract {
  if (!isPlainObject(value)) invalid("executionContract 必须是 JSON 对象。");
  requireExactKeys(value, ["version", "mode", "reproducibilityLevel", "tools"], "executionContract");
  readExactVersion(value.version, 1, "executionContract");

  const mode = value.mode;
  if (typeof mode !== "string" || !EXECUTION_MODES.includes(mode as ResearchRunMode)) {
    invalid(`executionContract.mode 必须是：${EXECUTION_MODES.join(" | ")}。`);
  }
  const reproducibilityLevel = value.reproducibilityLevel;
  if (
    typeof reproducibilityLevel !== "string" ||
    !REPRODUCIBILITY_LEVELS.includes(reproducibilityLevel as ResearchRunReproducibilityLevel)
  ) {
    invalid(`executionContract.reproducibilityLevel 必须是：${REPRODUCIBILITY_LEVELS.join(" | ")}。`);
  }

  if (!Array.isArray(value.tools)) invalid("executionContract.tools 必须是数组（可为空）。");
  const tools: ResearchRunTool[] = value.tools.map((tool, index) => {
    if (!isPlainObject(tool)) invalid(`executionContract.tools[${index}] 必须是对象。`);
    requireExactKeys(tool, ["name", "version"], `executionContract.tools[${index}]`);
    const name = normalizeHumanString(tool.name, `executionContract.tools[${index}].name`);
    let version: string | null = null;
    if (tool.version !== null) {
      version = normalizeHumanString(tool.version, `executionContract.tools[${index}].version`);
    }
    return { name, version };
  });

  return {
    version: 1,
    mode: mode as ResearchRunMode,
    reproducibilityLevel: reproducibilityLevel as ResearchRunReproducibilityLevel,
    tools,
  };
}

// ---------------------------------------------------------------------------
// Environment — plain JSON, non-secret facts only
// ---------------------------------------------------------------------------

/**
 * Substrings that mark an environment key as secret-bearing (token, secret,
 * password, cookie, authorization, database URL / private-token forms).
 * Matched case-insensitively against the full dotted key path.
 */
const SECRET_KEY_PATTERNS: readonly RegExp[] = [
  /token/i,
  /secret/i,
  /password/i,
  /cookie/i,
  /authorization/i,
  /credential/i,
  /api[-_]?key/i,
  /database[-_]?url/i,
  /db[-_]?url/i,
  /connection[-_]?string/i,
  /private[-_]?key/i,
];

function secretKeyReason(path: string): string | null {
  for (const pattern of SECRET_KEY_PATTERNS) {
    if (pattern.test(path)) return path;
  }
  return null;
}

export function readResearchRunEnvironment(value: unknown): ResearchRunEnvironment {
  if (!isPlainObject(value)) invalid("environment 必须是 JSON 对象。");

  function walk(node: unknown, path: string): void {
    if (node === null) return;
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }
    if (isPlainObject(node)) {
      for (const key of Object.keys(node)) {
        const childPath = path ? `${path}.${key}` : key;
        const offender = secretKeyReason(childPath);
        // Never include the rejected VALUE in the error — key path only.
        if (offender) {
          invalid(`environment 含有疑似密钥字段（${offender}），只允许记录非敏感执行事实。`);
        }
        walk(node[key], childPath);
      }
      return;
    }
    if (typeof node === "string" && node.includes("\0")) {
      invalid(`environment.${path} 不能包含 NUL 字符。`);
    }
  }

  walk(value, "");
  return value as ResearchRunEnvironment;
}

// ---------------------------------------------------------------------------
// Output v1
// ---------------------------------------------------------------------------

export function readResearchRunOutput(value: unknown): ResearchRunOutput {
  if (!isPlainObject(value)) invalid("output 必须是 JSON 对象。");
  requireExactKeys(value, ["version", "summary", "produced", "gaps"], "output");
  readExactVersion(value.version, 1, "output");

  const summary = normalizeHumanString(value.summary, "output.summary");

  const producedInput = value.produced;
  if (!isPlainObject(producedInput)) invalid("output.produced 必须是 JSON 对象。");
  requireExactKeys(producedInput, ["claimIds", "assessmentIds", "resolutionIds", "noteRevisionIds"], "output.produced");

  const produced: ResearchRunProduced = {
    claimIds: readUniqueUuidList(producedInput.claimIds, "output.produced.claimIds"),
    assessmentIds: readUniqueUuidList(producedInput.assessmentIds, "output.produced.assessmentIds"),
    resolutionIds: readUniqueUuidList(producedInput.resolutionIds, "output.produced.resolutionIds"),
    noteRevisionIds: readUniqueUuidList(producedInput.noteRevisionIds, "output.produced.noteRevisionIds"),
  };

  if (!Array.isArray(value.gaps)) invalid("output.gaps 必须是数组（可为空）。");
  const gaps: ResearchRunGap[] = value.gaps.map((gap, index) => {
    if (!isPlainObject(gap)) invalid(`output.gaps[${index}] 必须是对象。`);
    requireExactKeys(gap, ["description", "status"], `output.gaps[${index}]`);
    const description = normalizeHumanString(gap.description, `output.gaps[${index}].description`);
    const status = gap.status;
    if (typeof status !== "string" || !["OPEN", "BLOCKED", "DEFERRED"].includes(status)) {
      invalid(`output.gaps[${index}].status 必须是：OPEN | BLOCKED | DEFERRED。`);
    }
    return { description, status: status as ResearchRunGapStatus };
  });

  return { version: 1, summary, produced, gaps };
}

function readUniqueUuidList(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) invalid(`${label} 必须是数组。`);
  const ids = value.map((item) => readUuidReference(item, `${label} 条目`));
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) invalid(`${label} 含有重复 ID（${id}）。`);
    seen.add(id);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export function isTerminalResearchRunStatus(status: ResearchRunStatus): status is TerminalResearchRunStatus {
  return status === "SUCCEEDED" || status === "FAILED" || status === "CANCELLED";
}

/**
 * Validate a lifecycle transition. terminal → anything is forbidden;
 * RUNNING → SUCCEEDED requires output v1; RUNNING → FAILED/CANCELLED allows
 * null output or a safe output v1.
 */
export function validateResearchRunTransition(
  from: ResearchRunStatus,
  to: ResearchRunStatus,
  output: ResearchRunOutput | null,
): void {
  if (!RESEARCH_RUN_STATUSES.includes(from) || !RESEARCH_RUN_STATUSES.includes(to)) {
    throw new InvalidResearchRunTransitionError("未知状态。");
  }
  if (isTerminalResearchRunStatus(from)) {
    throw new InvalidResearchRunTransitionError(
      `终态 ${from} 不可再变更（terminal → terminal / terminal → RUNNING 均禁止）。`,
    );
  }
  if (from === "RUNNING" && to === "RUNNING") {
    throw new InvalidResearchRunTransitionError("RUNNING → RUNNING 不是有效变更。");
  }
  if (to === "SUCCEEDED" && output === null) {
    throw new InvalidResearchRunTransitionError("SUCCEEDED 必须提供 output。");
  }
}

// ---------------------------------------------------------------------------
// Canonical JSON + request hashing
// ---------------------------------------------------------------------------

/**
 * Deterministic canonical JSON: object keys sorted recursively, no whitespace,
 * UTF-8. Arrays keep order (order is meaningful for steps/tools; produced ID
 * lists are already uniqueness-checked).
 */
export function canonicalResearchRunJson(value: unknown): string {
  function encode(node: unknown): string {
    if (node === null) return "null";
    if (typeof node === "string") return JSON.stringify(node);
    if (typeof node === "number") {
      if (!Number.isFinite(node)) throw new InvalidResearchRunInputError("canonical JSON 不支持非有限数字。");
      return JSON.stringify(node);
    }
    if (typeof node === "boolean") return node ? "true" : "false";
    if (Array.isArray(node)) return `[${node.map(encode).join(",")}]`;
    if (isPlainObject(node)) {
      const keys = Object.keys(node).sort();
      return `{${keys.map((key) => `${JSON.stringify(key)}:${encode(node[key])}`).join(",")}}`;
    }
    throw new InvalidResearchRunInputError("canonical JSON 不支持 undefined/function/bigint。");
  }
  return encode(value);
}

export function sha256ResearchRunCanonical(value: unknown): string {
  return createHash("sha256").update(canonicalResearchRunJson(value), "utf8").digest("hex");
}
