// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RESEARCH_RUN_START_PENDING_KEY,
  PendingResearchRunStartIntentConflictError,
  clearPendingResearchRunStartReceipt,
  getOrCreateResearchRunStartReceipt,
  hashResearchRunStartCommand,
  loadPendingResearchRunStartReceipt,
  normalizeResearchRunStartBrowserCommand,
  resetPendingResearchRunStartReceiptMemoryForTest,
} from "./research-run-start-draft";

const P = "11111111-1111-4111-8111-111111111111";
const I = "22222222-2222-4222-8222-222222222222";
const M = "77777777-7777-4777-8777-777777777777";

const command = (over: Record<string, unknown> = {}) => ({
  procedure: {
    version: 1,
    objective: "核对版本差异",
    method: "逐页比对",
    steps: [{ kind: "COMPARE", description: "比对两版正文" }],
  },
  executionContract: {
    version: 1,
    mode: "HUMAN_AI",
    reproducibilityLevel: "PROCEDURE",
    tools: [{ name: "比对表", version: null }],
  },
  environment: {},
  evidenceManifestId: M,
  replayOf: null,
  ...over,
});

beforeEach(() => {
  resetPendingResearchRunStartReceiptMemoryForTest();
  sessionStorage.clear();
});
afterEach(() => {
  resetPendingResearchRunStartReceiptMemoryForTest();
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe("normalizeResearchRunStartBrowserCommand", () => {
  it("normalizes a valid full command", () => {
    expect(normalizeResearchRunStartBrowserCommand(command())).toEqual(command());
  });

  it("accepts all 7 step kinds", () => {
    for (const kind of ["SEARCH", "READ", "COMPARE", "FIELDWORK", "MAP_ANALYSIS", "IMAGE_ANALYSIS", "OTHER"]) {
      const input = command({ procedure: { version: 1, objective: "o", method: "m", steps: [{ kind, description: "d" }] } });
      expect(normalizeResearchRunStartBrowserCommand(input).procedure.steps[0].kind).toBe(kind);
    }
  });

  it.each([
    ["HUMAN", "EXACT"], ["HUMAN_AI", "PROCEDURE"], ["AUTOMATED", "AUDIT"],
    ["HUMAN", "PROCEDURE"], ["HUMAN_AI", "AUDIT"], ["AUTOMATED", "EXACT"],
  ] as const)("accepts mode %s with repro %s", (mode, repro) => {
    const input = command({ executionContract: { version: 1, mode, reproducibilityLevel: repro, tools: [] } });
    const normalized = normalizeResearchRunStartBrowserCommand(input);
    expect(normalized.executionContract.mode).toBe(mode);
    expect(normalized.executionContract.reproducibilityLevel).toBe(repro);
  });

  it("normalizes CRLF/CR to LF and trims Unicode whitespace", () => {
    const input = command({
      procedure: {
        version: 1,
        objective: "　目标\r\nline\u00A0",
        method: "\u3000方法\r",
        steps: [{ kind: "READ", description: " desc " }],
      },
    });
    const normalized = normalizeResearchRunStartBrowserCommand(input);
    expect(normalized.procedure.objective).toBe("目标\nline");
    expect(normalized.procedure.method).toBe("方法");
    expect(normalized.procedure.steps[0].description).toBe("desc");
  });

  it("rejects NUL and blank human strings", () => {
    expect(() => normalizeResearchRunStartBrowserCommand(command({ procedure: { version: 1, objective: "a\u0000b", method: "m", steps: [{ kind: "READ", description: "d" }] } }))).toThrow();
    expect(() => normalizeResearchRunStartBrowserCommand(command({ procedure: { version: 1, objective: "  ", method: "m", steps: [{ kind: "READ", description: "d" }] } }))).toThrow();
    expect(() => normalizeResearchRunStartBrowserCommand(command({ procedure: { version: 1, objective: "o", method: "", steps: [{ kind: "READ", description: "d" }] } }))).toThrow();
    expect(() => normalizeResearchRunStartBrowserCommand(command({ procedure: { version: 1, objective: "o", method: "m", steps: [{ kind: "READ", description: "　" }] } }))).toThrow();
  });

  it("rejects invalid/extra/symbol/prototype fields and non-plain roots", () => {
    expect(() => normalizeResearchRunStartBrowserCommand({ ...command(), extra: 1 })).toThrow();
    expect(() => normalizeResearchRunStartBrowserCommand({ ...command(), procedure: { ...command().procedure, extra: 1 } })).toThrow();
    expect(() => normalizeResearchRunStartBrowserCommand({ ...command(), executionContract: { ...command().executionContract, mode: "MIXED" } })).toThrow();
    expect(() => normalizeResearchRunStartBrowserCommand({ ...command(), executionContract: { ...command().executionContract, reproducibilityLevel: "BEST_EFFORT" } })).toThrow();
    const withSymbol = { ...command() };
    (withSymbol as Record<symbol, unknown>)[Symbol("x")] = 1;
    expect(() => normalizeResearchRunStartBrowserCommand(withSymbol)).toThrow();
    expect(() => normalizeResearchRunStartBrowserCommand(null)).toThrow();
    expect(() => normalizeResearchRunStartBrowserCommand([command()])).toThrow();
    const nullProto = Object.create(null);
    Object.assign(nullProto, command());
    expect(() => normalizeResearchRunStartBrowserCommand(nullProto)).not.toThrow(); // plain-null proto accepted
  });

  it("rejects invalid UUID and wrong-version values", () => {
    expect(() => normalizeResearchRunStartBrowserCommand(command({ evidenceManifestId: "NOT-A-UUID" }))).toThrow();
    expect(() => normalizeResearchRunStartBrowserCommand(command({ evidenceManifestId: M.toUpperCase() }))).not.toThrow();
    expect(normalizeResearchRunStartBrowserCommand(command({ evidenceManifestId: M.toUpperCase() })).evidenceManifestId).toBe(M);
    expect(() => normalizeResearchRunStartBrowserCommand(command({ procedure: { ...command().procedure, version: 2 } }))).toThrow();
    expect(() => normalizeResearchRunStartBrowserCommand(command({ executionContract: { ...command().executionContract, version: 0 } }))).toThrow();
  });

  it("rejects empty steps and non-array steps", () => {
    expect(() => normalizeResearchRunStartBrowserCommand(command({ procedure: { version: 1, objective: "o", method: "m", steps: [] } }))).toThrow();
    expect(() => normalizeResearchRunStartBrowserCommand(command({ procedure: { version: 1, objective: "o", method: "m", steps: "step" } }))).toThrow();
  });

  it("allows empty tools and null version; rejects blank tool names", () => {
    const empty = normalizeResearchRunStartBrowserCommand(command({ executionContract: { version: 1, mode: "HUMAN", reproducibilityLevel: "AUDIT", tools: [] } }));
    expect(empty.executionContract.tools).toEqual([]);
    const withVersion = normalizeResearchRunStartBrowserCommand(command({ executionContract: { version: 1, mode: "HUMAN", reproducibilityLevel: "AUDIT", tools: [{ name: "工具", version: null }] } }));
    expect(withVersion.executionContract.tools[0].version).toBeNull();
    expect(() => normalizeResearchRunStartBrowserCommand(command({ executionContract: { version: 1, mode: "HUMAN", reproducibilityLevel: "AUDIT", tools: [{ name: " ", version: null }] } }))).toThrow();
  });

  it("fixes environment to {} and replayOf to null; any other shape rejected", () => {
    expect(normalizeResearchRunStartBrowserCommand(command()).environment).toEqual({});
    expect(normalizeResearchRunStartBrowserCommand(command()).replayOf).toBeNull();
    expect(() => normalizeResearchRunStartBrowserCommand(command({ replayOf: M }))).toThrow();
    expect(() => normalizeResearchRunStartBrowserCommand(command({ environment: { a: 1 } }))).toThrow();
  });

  it("enforces the server-aligned 65536 UTF-8 byte limit", () => {
    const long = "字".repeat(33000); // 99000 bytes > 65536
    expect(() => normalizeResearchRunStartBrowserCommand(command({ procedure: { version: 1, objective: long, method: "m", steps: [{ kind: "READ", description: "d" }] } }))).toThrow();
    const within = "a".repeat(65536); // exactly 65536 bytes ascii — ok
    expect(normalizeResearchRunStartBrowserCommand(command({ procedure: { version: 1, objective: within, method: "m", steps: [{ kind: "READ", description: "d" }] } })).procedure.objective).toHaveLength(65536);
  });
});

describe("hashResearchRunStartCommand", () => {
  it("equivalent intents hash identically", async () => {
    const a = await hashResearchRunStartCommand({ projectId: P, issueId: I }, command());
    const b = await hashResearchRunStartCommand({ projectId: P.toUpperCase(), issueId: I.toUpperCase() }, command());
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("step/tool order, manifest, mode, repro and scope each change the hash", async () => {
    const base = await hashResearchRunStartCommand({ projectId: P, issueId: I }, command());
    const variants = [
      command({ procedure: { version: 1, objective: "o", method: "m", steps: [{ kind: "READ", description: "a" }, { kind: "READ", description: "b" }] } }),
      command({ procedure: { version: 1, objective: "核对版本差异", method: "逐页比对", steps: [{ kind: "COMPARE", description: "比对两版正文" }, { kind: "SEARCH", description: "补充检索" }] } }),
      command({ executionContract: { version: 1, mode: "HUMAN", reproducibilityLevel: "PROCEDURE", tools: [{ name: "比对表", version: null }] } }),
      command({ executionContract: { version: 1, mode: "HUMAN_AI", reproducibilityLevel: "EXACT", tools: [{ name: "比对表", version: null }] } }),
      command({ evidenceManifestId: "88888888-8888-4888-8888-888888888888" }),
      command({ procedure: { version: 1, objective: "不同目标", method: "逐页比对", steps: [{ kind: "COMPARE", description: "比对两版正文" }] } }),
    ];
    for (const variant of variants) {
      // rebuild consistent base fields where variant replaced whole sub-objects
      const candidate = variant.procedure.objective === "o" ? command({ procedure: variant.procedure, executionContract: command().executionContract }) : variant;
      const hash = await hashResearchRunStartCommand({ projectId: P, issueId: I }, candidate);
      expect(hash).not.toBe(base);
    }
    const otherScope = await hashResearchRunStartCommand({ projectId: "99999999-9999-4999-8999-999999999999", issueId: I }, command());
    expect(otherScope).not.toBe(base);
  });
});

describe("pending receipt lifecycle", () => {
  it("persists nothing before explicit submit", () => {
    expect(loadPendingResearchRunStartReceipt()).toBeNull();
    expect(sessionStorage.getItem(RESEARCH_RUN_START_PENDING_KEY)).toBeNull();
  });

  it("creates and reloads the exact command and key", async () => {
    const created = await getOrCreateResearchRunStartReceipt({ projectId: P, issueId: I }, command());
    expect(created.command).toEqual(command());
    expect(created.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    resetPendingResearchRunStartReceiptMemoryForTest();
    const reloaded = loadPendingResearchRunStartReceipt();
    expect(reloaded?.idempotencyKey).toBe(created.idempotencyKey);
    expect(reloaded?.command).toEqual(created.command);
  });

  it("same intent returns the same receipt without rotating the key", async () => {
    const first = await getOrCreateResearchRunStartReceipt({ projectId: P, issueId: I }, command());
    const second = await getOrCreateResearchRunStartReceipt({ projectId: P, issueId: I }, command());
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
  });

  it("changed intent or scope raises explicit conflict", async () => {
    await getOrCreateResearchRunStartReceipt({ projectId: P, issueId: I }, command());
    await expect(getOrCreateResearchRunStartReceipt({ projectId: P, issueId: I }, command({ evidenceManifestId: "88888888-8888-4888-8888-888888888888" })))
      .rejects.toBeInstanceOf(PendingResearchRunStartIntentConflictError);
    await expect(getOrCreateResearchRunStartReceipt({ projectId: "99999999-9999-4999-8999-999999999999", issueId: I }, command()))
      .rejects.toBeInstanceOf(PendingResearchRunStartIntentConflictError);
  });

  it("rejects malformed receipts with extra fields like token", () => {
    sessionStorage.setItem(RESEARCH_RUN_START_PENDING_KEY, JSON.stringify({
      projectId: P, issueId: I, requestHash: "a".repeat(64),
      idempotencyKey: "99999999-9999-4999-8999-999999999999",
      createdAt: new Date().toISOString(),
      command: command(), token: "SECRET",
    }));
    expect(loadPendingResearchRunStartReceipt()).toBeNull();
  });

  it("stored hash tampering is not trusted (submit fails closed)", async () => {
    const created = await getOrCreateResearchRunStartReceipt({ projectId: P, issueId: I }, command());
    const tampered = { ...created, requestHash: "0".repeat(64) };
    sessionStorage.setItem(RESEARCH_RUN_START_PENDING_KEY, JSON.stringify(tampered));
    resetPendingResearchRunStartReceiptMemoryForTest();
    // load ignores nothing structural, but re-submit detects hash mismatch → conflict (fail closed, no silent rotation)
    await expect(getOrCreateResearchRunStartReceipt({ projectId: P, issueId: I }, command()))
      .rejects.toBeInstanceOf(PendingResearchRunStartIntentConflictError);
  });

  it("storage-write failure keeps the same-page key", async () => {
    const original = sessionStorage.setItem.bind(sessionStorage);
    vi.spyOn(sessionStorage, "setItem").mockImplementation(() => { throw new Error("quota"); });
    const created = await getOrCreateResearchRunStartReceipt({ projectId: P, issueId: I }, command());
    expect(created.command).toEqual(command());
    const inMemory = loadPendingResearchRunStartReceipt();
    expect(inMemory?.idempotencyKey).toBe(created.idempotencyKey);
    void original;
  });

  it("clear tombstone survives storage-remove failure", async () => {
    await getOrCreateResearchRunStartReceipt({ projectId: P, issueId: I }, command());
    vi.spyOn(sessionStorage, "removeItem").mockImplementation(() => { throw new Error("locked"); });
    clearPendingResearchRunStartReceipt();
    expect(loadPendingResearchRunStartReceipt()).toBeNull();
    // even if stale storage is later readable, tombstone wins for this page
    sessionStorage.setItem(RESEARCH_RUN_START_PENDING_KEY, JSON.stringify({
      projectId: P, issueId: I, requestHash: "a".repeat(64),
      idempotencyKey: "99999999-9999-4999-8999-999999999999",
      createdAt: new Date().toISOString(), command: command(),
    }));
    expect(loadPendingResearchRunStartReceipt()).toBeNull();
  });
});
