import { describe, expect, it } from "vitest";
import {
  InvalidResearchRunInputError,
  InvalidResearchRunTransitionError,
  canonicalResearchRunJson,
  isTerminalResearchRunStatus,
  readResearchRunEnvironment,
  readResearchRunExecutionContract,
  readResearchRunOutput,
  readResearchRunProcedure,
  sha256ResearchRunCanonical,
  validateResearchRunTransition,
} from "./research-run.js";

const VALID_PROCEDURE = {
  version: 1,
  objective: "梳理京西古道的三条主线路走向",
  method: "文献比对 + 实地复核",
  steps: [
    { kind: "SEARCH", description: "检索地方志条目" },
    { kind: "READ", description: "精读《门头沟志》相关章节" },
  ],
};

const VALID_EXECUTION = {
  version: 1,
  mode: "HUMAN_AI",
  reproducibilityLevel: "PROCEDURE",
  tools: [
    { name: "books.conanxin.com", version: null },
    { name: "postgres", version: "16" },
  ],
};

const VALID_OUTPUT = {
  version: 1,
  summary: "三条主线路走向已确认，其中一条与既有结论冲突。",
  produced: {
    claimIds: ["0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9"],
    assessmentIds: [],
    resolutionIds: [],
    noteRevisionIds: ["1a2b3c4d-5e6f-7081-9293-a4b5c6d7e8f0"],
  },
  gaps: [{ description: "王家山段缺乏可直接引用的档案原件", status: "OPEN" }],
};

function rejects(fn: () => unknown, messageIncludes?: string): void {
  try {
    fn();
    throw new Error("expected rejection but value returned");
  } catch (error) {
    const err = error as Error;
    if (err instanceof InvalidResearchRunInputError || err instanceof InvalidResearchRunTransitionError) {
      if (messageIncludes) expect(err.message).toContain(messageIncludes);
      return;
    }
    throw error;
  }
}

describe("readResearchRunProcedure", () => {
  it("accepts an exact valid Procedure v1", () => {
    const result = readResearchRunProcedure(VALID_PROCEDURE);
    expect(result.version).toBe(1);
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0]).toEqual({ kind: "SEARCH", description: "检索地方志条目" });
  });

  it("accepts every step kind", () => {
    const kinds = ["SEARCH", "READ", "COMPARE", "FIELDWORK", "MAP_ANALYSIS", "IMAGE_ANALYSIS", "OTHER"];
    const procedure = {
      ...VALID_PROCEDURE,
      steps: kinds.map((kind) => ({ kind, description: `步骤 ${kind}` })),
    };
    expect(readResearchRunProcedure(procedure).steps.map((s) => s.kind)).toEqual(kinds);
  });

  it("rejects unknown fields (exact-key parsing)", () => {
    rejects(() => readResearchRunProcedure({ ...VALID_PROCEDURE, extra: "x" }));
    rejects(() => readResearchRunProcedure({ ...VALID_PROCEDURE, steps: [{ kind: "READ", description: "d", note: 1 }] }));
  });

  it("rejects missing fields", () => {
    const { objective: _objective, ...noObjective } = VALID_PROCEDURE;
    rejects(() => readResearchRunProcedure(noObjective));
  });

  it("rejects wrong version", () => {
    rejects(() => readResearchRunProcedure({ ...VALID_PROCEDURE, version: 2 }), "version");
    rejects(() => readResearchRunProcedure({ ...VALID_PROCEDURE, version: "1" }), "version");
  });

  it("rejects malformed / blank / NUL strings and trims Unicode whitespace + CRLF", () => {
    rejects(() => readResearchRunProcedure({ ...VALID_PROCEDURE, objective: "   \u00A0" }));
    rejects(() => readResearchRunProcedure({ ...VALID_PROCEDURE, objective: "a\0b" }), "NUL");
    rejects(() => readResearchRunProcedure({ ...VALID_PROCEDURE, steps: [] }));
    rejects(() => readResearchRunProcedure({ ...VALID_PROCEDURE, steps: "not-array" }));

    const normalized = readResearchRunProcedure({
      ...VALID_PROCEDURE,
      objective: "\u3000目标\u2028",
      steps: [{ kind: "READ", description: "含\r\n回车" }],
    });
    expect(normalized.objective).toBe("目标");
    expect(normalized.steps[0].description).toBe("含\n回车");
  });

  it("rejects invalid step kind", () => {
    rejects(() => readResearchRunProcedure({ ...VALID_PROCEDURE, steps: [{ kind: "WALK", description: "d" }] }));
  });
});

describe("readResearchRunExecutionContract", () => {
  it("accepts every mode × reproducibility level with nullable tool versions", () => {
    for (const mode of ["HUMAN", "HUMAN_AI", "AUTOMATED"] as const) {
      for (const reproducibilityLevel of ["EXACT", "PROCEDURE", "AUDIT"] as const) {
        const result = readResearchRunExecutionContract({
          version: 1,
          mode,
          reproducibilityLevel,
          tools: [{ name: `t-${mode}`, version: null }],
        });
        expect(result.mode).toBe(mode);
        expect(result.reproducibilityLevel).toBe(reproducibilityLevel);
        expect(result.tools[0].version).toBeNull();
      }
    }
  });

  it("rejects unknown fields, wrong version, bad enums, malformed tools", () => {
    rejects(() => readResearchRunExecutionContract({ ...VALID_EXECUTION, extra: true }));
    rejects(() => readResearchRunExecutionContract({ ...VALID_EXECUTION, version: 3 }), "version");
    rejects(() => readResearchRunExecutionContract({ ...VALID_EXECUTION, mode: "ROBOT" }));
    rejects(() => readResearchRunExecutionContract({ ...VALID_EXECUTION, reproducibilityLevel: "BEST_EFFORT" }));
    rejects(() => readResearchRunExecutionContract({ ...VALID_EXECUTION, tools: [{ name: "x" }] }));
    rejects(() => readResearchRunExecutionContract({ ...VALID_EXECUTION, tools: [{ name: "x", version: 1 }] }));
    rejects(() => readResearchRunExecutionContract({ ...VALID_EXECUTION, tools: "none" }));
  });
});

describe("readResearchRunEnvironment — secret-key rejection", () => {
  it("accepts plain non-secret facts", () => {
    const env = readResearchRunEnvironment({
      locale: "zh-CN",
      timezone: "Asia/Shanghai",
      duration: { planningMinutes: 30 },
      searchQueries: [{ service: "meili", firstN: 20 }],
    });
    expect(env.locale).toBe("zh-CN");
  });

  it("rejects secret-bearing keys at top level, nested objects and arrays", () => {
    rejects(() => readResearchRunEnvironment({ apiToken: "x" }));
    rejects(() => readResearchRunEnvironment({ session: { secret: "x" } }));
    rejects(() => readResearchRunEnvironment({ notes: [{ userPassword: "x" }] }));
    rejects(() => readResearchRunEnvironment({ DATABASE_URL: "postgres://..." }));
    rejects(() => readResearchRunEnvironment({ nested: { deep: { authorizationHeader: "Bearer x" } } }));
    rejects(() => readResearchRunEnvironment({ privateKeyPem: "-----BEGIN..." }));
    rejects(() => readResearchRunEnvironment({ db_url: "postgres://..." }));
  });

  it("never includes the rejected value in the error message", () => {
    try {
      readResearchRunEnvironment({ superSecretValue: "LEAKED-VALUE-ABC" });
      throw new Error("expected rejection");
    } catch (error) {
      const err = error as Error;
      expect(err.message).toContain("superSecretValue");
      expect(err.message).not.toContain("LEAKED-VALUE-ABC");
    }
  });

  it("rejects NUL strings and non-object roots", () => {
    rejects(() => readResearchRunEnvironment({ note: "a\0b" }), "NUL");
    rejects(() => readResearchRunEnvironment("string"));
    rejects(() => readResearchRunEnvironment([1, 2]));
  });
});

describe("readResearchRunOutput", () => {
  it("accepts a valid Output v1 with empty arrays and gaps", () => {
    const result = readResearchRunOutput({
      version: 1,
      summary: "无产出。",
      produced: { claimIds: [], assessmentIds: [], resolutionIds: [], noteRevisionIds: [] },
      gaps: [],
    });
    expect(result.produced.claimIds).toEqual([]);
  });

  it("rejects malformed produced UUIDs", () => {
    const base = { ...VALID_OUTPUT };
    rejects(() =>
      readResearchRunOutput({
        ...base,
        produced: { ...base.produced, claimIds: ["not-a-uuid"] },
      }),
    );
    rejects(() =>
      readResearchRunOutput({
        ...base,
        produced: { ...base.produced, noteRevisionIds: [42] },
      }),
    );
  });

  it("normalizes UUID case to lowercase canonical", () => {
    const result = readResearchRunOutput({
      ...VALID_OUTPUT,
      produced: {
        ...VALID_OUTPUT.produced,
        assessmentIds: ["0A1B2C3D-4E5F-6071-8293-A4B5C6D7E8F9"],
      },
    });
    expect(result.produced.assessmentIds[0]).toBe("0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9");
  });

  it("rejects duplicate IDs within each produced array (case-insensitive)", () => {
    const dup = ["0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9", "0A1B2C3D-4E5F-6071-8293-A4B5C6D7E8F9"];
    rejects(() => readResearchRunOutput({ ...VALID_OUTPUT, produced: { ...VALID_OUTPUT.produced, claimIds: dup } }), "重复");
    // Same ID across DIFFERENT arrays is fine — only within-array duplicates reject.
    expect(() =>
      readResearchRunOutput({
        ...VALID_OUTPUT,
        produced: {
          ...VALID_OUTPUT.produced,
          claimIds: ["0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9"],
          assessmentIds: ["0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9"],
        },
      }),
    ).not.toThrow();
  });

  it("enforces gap status strictness", () => {
    rejects(() => readResearchRunOutput({ ...VALID_OUTPUT, gaps: [{ description: "g", status: "MAYBE" }] }));
    expect(readResearchRunOutput({ ...VALID_OUTPUT, gaps: [{ description: "g", status: "DEFERRED" }] }).gaps[0].status).toBe("DEFERRED");
  });

  it("rejects unknown fields and wrong version", () => {
    rejects(() => readResearchRunOutput({ ...VALID_OUTPUT, extra: 1 }));
    rejects(() => readResearchRunOutput({ ...VALID_OUTPUT, version: 0 }), "version");
  });
});

describe("lifecycle", () => {
  it("SUCCEEDED requires output; FAILED/CANCELLED allow null or safe output", () => {
    const output = readResearchRunOutput(VALID_OUTPUT);
    expect(() => validateResearchRunTransition("RUNNING", "SUCCEEDED", output)).not.toThrow();
    expect(() => validateResearchRunTransition("RUNNING", "FAILED", null)).not.toThrow();
    expect(() => validateResearchRunTransition("RUNNING", "CANCELLED", null)).not.toThrow();
    expect(() => validateResearchRunTransition("RUNNING", "FAILED", output)).not.toThrow();
    rejects(() => validateResearchRunTransition("RUNNING", "SUCCEEDED", null), "output");
  });

  it("terminal → anything is forbidden", () => {
    for (const terminal of ["SUCCEEDED", "FAILED", "CANCELLED"] as const) {
      for (const to of ["RUNNING", "SUCCEEDED", "FAILED", "CANCELLED"] as const) {
        rejects(() => validateResearchRunTransition(terminal, to, null), "终态");
      }
    }
  });

  it("isTerminalResearchRunStatus classification", () => {
    expect(isTerminalResearchRunStatus("RUNNING")).toBe(false);
    expect(isTerminalResearchRunStatus("SUCCEEDED")).toBe(true);
    expect(isTerminalResearchRunStatus("FAILED")).toBe(true);
    expect(isTerminalResearchRunStatus("CANCELLED")).toBe(true);
  });
});

describe("canonical JSON + SHA-256 request hashing", () => {
  it("is deterministic across key insertion order and equivalent normalized input", () => {
    const a = readResearchRunProcedure(VALID_PROCEDURE);
    const b = readResearchRunProcedure({
      steps: [...VALID_PROCEDURE.steps].reverse().map((s) => ({ description: s.description, kind: s.kind })),
      method: VALID_PROCEDURE.method,
      objective: VALID_PROCEDURE.objective,
      version: 1,
    });
    expect(a.steps.map((s) => s.kind)).toEqual(["SEARCH", "READ"]);
    expect(b.steps.map((s) => s.kind)).toEqual(["READ", "SEARCH"]);
    // Different step ORDER is a meaningful difference → different hash.
    expect(sha256ResearchRunCanonical(a)).not.toBe(sha256ResearchRunCanonical(b));

    const c = readResearchRunProcedure({ ...VALID_PROCEDURE, objective: `  ${VALID_PROCEDURE.objective}\u00A0` });
    expect(sha256ResearchRunCanonical(c)).toBe(sha256ResearchRunCanonical(a));
  });

  it("sorts object keys recursively; arrays keep order", () => {
    expect(canonicalResearchRunJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
    expect(canonicalResearchRunJson([3, 1, 2])).toBe("[3,1,2]");
    expect(canonicalResearchRunJson(null)).toBe("null");
    expect(canonicalResearchRunJson("é\n")).toBe('"é\\n"');
  });

  it("hash changes on meaningful input difference", () => {
    const a = readResearchRunProcedure(VALID_PROCEDURE);
    const b = readResearchRunProcedure({ ...VALID_PROCEDURE, method: "不同方法" });
    expect(sha256ResearchRunCanonical(a)).not.toBe(sha256ResearchRunCanonical(b));
  });

  it("rejects non-finite numbers and unsupported values", () => {
    rejects(() => canonicalResearchRunJson({ x: Number.NaN }));
    rejects(() => canonicalResearchRunJson({ x: undefined as unknown as number }));
  });
});
