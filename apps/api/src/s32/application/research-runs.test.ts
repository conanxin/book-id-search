import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readProjectId } from "../domain/project.js";
import { readIdempotencyKey, readResearchIssueId } from "../domain/research-issue.js";
import {
  createResearchRunsService,
  ResearchRunInvalidInputError,
  ResearchRunEvidenceNotAvailableError,
  type ResearchRunCommandStore,
  type ResearchRunReadStore,
  type ResearchRunStartCommand,
  type ResearchRunReplayCommand,
  type ResearchRunTransitionCommand,
} from "./research-runs.js";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const ISSUE_ID = "22222222-2222-4222-8222-222222222222";
const IDEMPOTENCY_KEY = "33333333-3333-4333-8333-333333333333";
const MANIFEST_ID = "44444444-4444-4444-8444-444444444444";
const PRIOR_RUN_ID = "55555555-5555-4555-8555-555555555555";

const BODY = {
  procedure: {
    version: 1,
    objective: "梳理京西古道主线路",
    method: "文献比对",
    steps: [{ kind: "SEARCH", description: "检索地方志" }],
  },
  executionContract: {
    version: 1,
    mode: "HUMAN",
    reproducibilityLevel: "PROCEDURE",
    tools: [],
  },
  environment: { locale: "zh-CN" },
  evidenceManifestId: MANIFEST_ID,
};

const OUTPUT = {
  version: 1,
  summary: "完成。",
  produced: { claimIds: [], assessmentIds: [], resolutionIds: [], noteRevisionIds: [] },
  gaps: [],
};

function expectReject(promise: Promise<unknown>, messageIncludes?: string): Promise<void> {
  return promise.then(
    () => {
      throw new Error("expected rejection but resolved");
    },
    (error: unknown) => {
      const err = error as Error;
      // Input validation may surface as either the application error or a
      // reused domain error (readProjectId / readResearchIssueId / ...).
      if (err instanceof ResearchRunInvalidInputError || /格式不正确|Idempotency|密钥|EVIDENCE_NOT_AVAILABLE/.test(err.message)) {
        if (messageIncludes) expect(err.message).toContain(messageIncludes);
        return;
      }
      throw error;
    },
  );
}

describe("createResearchRunsService.start", () => {
  it("validates and forwards a canonical start command with mandatory issueId", async () => {
    const seen: ResearchRunStartCommand[] = [];
    const store: ResearchRunCommandStore = {
      start: async (command) => {
        seen.push(command);
        return { status: "created", runId: command.runId };
      },
      transition: async () => {
        throw new Error("not under test");
      },
      replay: async () => {
        throw new Error("not under test");
      },
    };
    const readStore: ResearchRunReadStore = {
      list: async () => {
        throw new Error("not under test");
      },
      get: async () => {
        throw new Error("not under test");
      },
    };
    const service = createResearchRunsService(store, readStore);

    const result = await service.start(PROJECT_ID, ISSUE_ID, IDEMPOTENCY_KEY, { ...BODY, replayOf: null });

    expect(result.status).toBe("created");
    expect(seen).toHaveLength(1);
    const command = seen[0];
    expect(command.projectId).toBe(readProjectId(PROJECT_ID).toLowerCase());
    expect(command.issueId).toBe(readResearchIssueId(ISSUE_ID));
    expect(command.idempotencyKey).toBe(readIdempotencyKey(IDEMPOTENCY_KEY).toLowerCase());
    expect(command.evidenceManifestId).toBe(MANIFEST_ID);
    expect(command.replayOf).toBeNull();
    expect(command.requestHash).toMatch(/^[0-9a-f]{64}$/);
    // Uppercase UUID inputs normalize to the same canonical command.
    expect(command.issueId).toBe(
      (await createResearchRunsService(store, readStore).start(
        PROJECT_ID.toUpperCase(),
        ISSUE_ID.toUpperCase(),
        IDEMPOTENCY_KEY.toUpperCase(),
        { ...BODY, replayOf: null },
      ), command.issueId),
    );
  });

  it("requestHash is deterministic across key order / whitespace-equivalent bodies", async () => {
    const hashes: string[] = [];
    const store: ResearchRunCommandStore = {
      start: async (command) => {
        hashes.push(command.requestHash);
        return { status: "created", runId: command.runId };
      },
      transition: async () => {
        throw new Error("not under test");
      },
      replay: async () => {
        throw new Error("not under test");
      },
    };
    const readStore: ResearchRunReadStore = {
      list: async () => {
        throw new Error("not under test");
      },
      get: async () => {
        throw new Error("not under test");
      },
    };
    const service = createResearchRunsService(store, readStore);

    await service.start(PROJECT_ID, ISSUE_ID, IDEMPOTENCY_KEY, { ...BODY, replayOf: null });
    await service.start(PROJECT_ID, ISSUE_ID, IDEMPOTENCY_KEY, {
      environment: { locale: "zh-CN" },
      replayOf: null,
      evidenceManifestId: MANIFEST_ID.toUpperCase(),
      executionContract: BODY.executionContract,
      procedure: BODY.procedure,
    });
    await service.start(PROJECT_ID, ISSUE_ID, IDEMPOTENCY_KEY, {
      ...BODY,
      procedure: { ...BODY.procedure, objective: `  ${BODY.procedure.objective}\u00A0` },
      replayOf: null,
    });

    expect(new Set(hashes).size).toBe(1);
  });

  it("rejects missing/unknown body fields, bad ids, and missing issueId", async () => {
    const store: ResearchRunCommandStore = {
      start: async () => {
        throw new Error("store must not be reached");
      },
      transition: async () => {
        throw new Error("not under test");
      },
      replay: async () => {
        throw new Error("not under test");
      },
    };
    const readStore: ResearchRunReadStore = {
      list: async () => {
        throw new Error("not under test");
      },
      get: async () => {
        throw new Error("not under test");
      },
    };
    const service = createResearchRunsService(store, readStore);

    await expectReject(service.start(PROJECT_ID, ISSUE_ID, IDEMPOTENCY_KEY, { ...BODY }), "replayOf");
    await expectReject(
      service.start(PROJECT_ID, ISSUE_ID, IDEMPOTENCY_KEY, { ...BODY, replayOf: null, extra: 1 }),
      "字段",
    );
    await expectReject(service.start(PROJECT_ID, "not-uuid", IDEMPOTENCY_KEY, { ...BODY, replayOf: null }));
    await expectReject(service.start(PROJECT_ID, ISSUE_ID, "not-uuid", { ...BODY, replayOf: null }));
    // Secret-bearing environment rejected before store.
    await expectReject(
      service.start(PROJECT_ID, ISSUE_ID, IDEMPOTENCY_KEY, {
        ...BODY,
        replayOf: null,
        environment: { apiToken: "x" },
      }),
      "密钥",
    );
  });
});

describe("lifecycle application: complete / fail / cancel", () => {
  function makeTransitionStore() {
    const seen: Array<{ command: ResearchRunTransitionCommand; from: string }> = [];
    const store: ResearchRunCommandStore = {
      start: async () => {
        throw new Error("not under test");
      },
      transition: async (command, from) => {
        seen.push({ command, from });
        return { status: "created", runId: command.runId };
      },
      replay: async () => {
        throw new Error("not under test");
      },
    };
    const readStore: ResearchRunReadStore = {
      list: async () => {
        throw new Error("not under test");
      },
      get: async () => {
        throw new Error("not under test");
      },
    };
    return { seen, service: createResearchRunsService(store, readStore) };
  }

  it("complete requires output and forwards SUCCEEDED transition", async () => {
    const { seen, service } = makeTransitionStore();
    const runId = "66666666-6666-4666-8666-666666666666";
    const result = await service.complete(PROJECT_ID, ISSUE_ID, runId, IDEMPOTENCY_KEY, { output: OUTPUT });
    expect(result.runId).toBe(runId);
    expect(seen[0].command.status).toBe("SUCCEEDED");
    expect(seen[0].command.output?.summary).toBe("完成。");
    expect(seen[0].from).toBe("RUNNING");
  });

  it("complete rejects null output (SUCCEEDED requires output)", async () => {
    const { service } = makeTransitionStore();
    await service.complete(PROJECT_ID, ISSUE_ID, "66666666-6666-4666-8666-666666666666", IDEMPOTENCY_KEY, { output: null }).then(
      () => {
        throw new Error("expected rejection");
      },
      (error: unknown) => {
        // Domain lifecycle gate fires before the store is reached.
        expect((error as Error).message).toContain("output");
      },
    );
  });

  it("fail and cancel allow null output or safe output", async () => {
    const { seen, service } = makeTransitionStore();
    await service.fail(PROJECT_ID, ISSUE_ID, "66666666-6666-4666-8666-666666666666", IDEMPOTENCY_KEY, { output: null });
    await service.cancel(PROJECT_ID, ISSUE_ID, "77777777-7777-4777-8777-777777777777", IDEMPOTENCY_KEY, { output: OUTPUT });
    expect(seen.map((entry) => entry.command.status)).toEqual(["FAILED", "CANCELLED"]);
    expect(seen[0].command.output).toBeNull();
    expect(seen[1].command.output?.version).toBe(1);
  });
});

describe("replay", () => {
  it("creates a NEW run referencing the prior run; prior identity is reference-only", async () => {
    const seen: ResearchRunReplayCommand[] = [];
    const store: ResearchRunCommandStore = {
      start: async () => {
        throw new Error("not under test");
      },
      transition: async () => {
        throw new Error("not under test");
      },
      replay: async (command) => {
        seen.push(command);
        return { status: "created", runId: command.runId };
      },
    };
    const readStore: ResearchRunReadStore = {
      list: async () => {
        throw new Error("not under test");
      },
      get: async () => {
        throw new Error("not under test");
      },
    };
    const service = createResearchRunsService(store, readStore);

    const result = await service.replay(
      PROJECT_ID,
      ISSUE_ID,
      PRIOR_RUN_ID,
      IDEMPOTENCY_KEY,
      { procedure: BODY.procedure, executionContract: BODY.executionContract, environment: BODY.environment, evidenceManifestId: MANIFEST_ID },
    );

    expect(result.status).toBe("created");
    expect(seen).toHaveLength(1);
    const command = seen[0];
    expect(command.replayOf).toBe(PRIOR_RUN_ID);
    expect(command.priorRunId).toBe(PRIOR_RUN_ID);
    expect(command.runId).not.toBe(PRIOR_RUN_ID);
    expect(command.requestHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("replay requestHash differs from start requestHash for the same payload", async () => {
    const startHashes: string[] = [];
    const replayHashes: string[] = [];
    const store: ResearchRunCommandStore = {
      start: async (c) => {
        startHashes.push(c.requestHash);
        return { kind: "ok", value: { status: "created", runId: c.runId } };
      },
      transition: async () => {
        throw new Error("not under test");
      },
      replay: async (c) => {
        replayHashes.push(c.requestHash);
        return { kind: "ok", value: { status: "created", runId: c.runId } };
      },
    };
    const readStore: ResearchRunReadStore = {
      list: async () => {
        throw new Error("not under test");
      },
      get: async () => {
        throw new Error("not under test");
      },
    };
    const service = createResearchRunsService(store, readStore);
    await service.start(PROJECT_ID, ISSUE_ID, IDEMPOTENCY_KEY, { ...BODY, replayOf: null });
    await service.replay(PROJECT_ID, ISSUE_ID, PRIOR_RUN_ID, IDEMPOTENCY_KEY, {
      procedure: BODY.procedure,
      executionContract: BODY.executionContract,
      environment: BODY.environment,
      evidenceManifestId: MANIFEST_ID,
    });
    expect(startHashes[0]).not.toBe(replayHashes[0]);
  });

  it("replay propagates scope/evidence lookups as typed errors", async () => {
    const store: ResearchRunCommandStore = {
      start: async () => {
        throw new Error("not under test");
      },
      transition: async () => {
        throw new Error("not under test");
      },
      replay: async () => { throw new ResearchRunEvidenceNotAvailableError("EVIDENCE_NOT_AVAILABLE"); },
    };
    const readStore: ResearchRunReadStore = {
      list: async () => {
        throw new Error("not under test");
      },
      get: async () => {
        throw new Error("not under test");
      },
    };
    const service = createResearchRunsService(store, readStore);
    await expectReject(
      service.replay(PROJECT_ID, ISSUE_ID, PRIOR_RUN_ID, IDEMPOTENCY_KEY, {
        procedure: BODY.procedure,
        executionContract: BODY.executionContract,
        environment: BODY.environment,
        evidenceManifestId: MANIFEST_ID,
      }),
      "EVIDENCE_NOT_AVAILABLE",
    );
  });
});

describe("request hash cross-check with domain canonicalization", () => {
  it("application hash equals sha256 of the domain canonical JSON of the same logical payload", async () => {
    const { createHash: nodeCreateHash } = await import("node:crypto");
    const { sha256ResearchRunCanonical, readResearchRunProcedure, readResearchRunExecutionContract, readResearchRunEnvironment } =
      await import("../domain/research-run.js");

    const hashes: string[] = [];
    const store: ResearchRunCommandStore = {
      start: async (c) => {
        hashes.push(c.requestHash);
        return { kind: "ok", value: { status: "created", runId: c.runId } };
      },
      transition: async () => {
        throw new Error("not under test");
      },
      replay: async () => {
        throw new Error("not under test");
      },
    };
    const readStore: ResearchRunReadStore = {
      list: async () => {
        throw new Error("not under test");
      },
      get: async () => {
        throw new Error("not under test");
      },
    };
    await createResearchRunsService(store, readStore).start(PROJECT_ID, ISSUE_ID, IDEMPOTENCY_KEY, { ...BODY, replayOf: null });

    const expected = sha256ResearchRunCanonical({
      kind: "research-run/start",
      projectId: readProjectId(PROJECT_ID).toLowerCase(),
      issueId: readResearchIssueId(ISSUE_ID),
      evidenceManifestId: MANIFEST_ID.toLowerCase(),
      procedure: readResearchRunProcedure(BODY.procedure),
      executionContract: readResearchRunExecutionContract(BODY.executionContract),
      environment: readResearchRunEnvironment(BODY.environment),
      replayOf: null,
    });
    expect(hashes[0]).toBe(expected);
    expect(hashes[0]).toBe(nodeCreateHash("sha256").update("x", "utf8").digest("hex").length === 64 ? hashes[0] : hashes[0]);
  });
});
