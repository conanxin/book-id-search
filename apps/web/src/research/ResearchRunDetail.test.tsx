// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getResearchRun, ProjectApiError, type ResearchRunDetailResponse } from "./api";
import { ResearchRunDetail } from "./ResearchRunDetail";
import { resetPendingResearchRunActionReceiptMemoryForTest } from "./research-run-action-draft";

vi.mock("../auth/session", async importOriginal => {
  const actual = await importOriginal<typeof import("../auth/session")>();
  return { ...actual, ensureAuthSessionLoaded: vi.fn(async () => {}) };
});
import { __resetWebAuthStoreForTests, __setWebAuthSnapshotForTests } from "../auth/session";
beforeEach(() => {
  __setWebAuthSnapshotForTests({ status: "authenticated", user: { email: "owner@example.com", name: "Owner" }, csrfToken: "csrf-test", error: null });
});
vi.mock("./api", async load => ({
  ...await load<typeof import("./api")>(),
  getResearchRun: vi.fn(),
}));

const P = "11111111-1111-4111-8111-111111111111";
const I = "22222222-2222-4222-8222-222222222222";
const RUN = "33333333-3333-4333-8333-333333333333";
const PARENT = "99999999-9999-4999-8999-999999999999";
const M = "77777777-7777-4777-8777-777777777777";

const procedure = { version: 1 as const, objective: "核对版本", method: "逐页比对", steps: [{ kind: "COMPARE" as const, description: "比对正文" }, { kind: "SEARCH" as const, description: "补充检索" }] };
const contract = { version: 1 as const, mode: "HUMAN_AI" as const, reproducibilityLevel: "PROCEDURE" as const, tools: [{ name: "比对表", version: null }] };

const runningDetail = (): ResearchRunDetailResponse => ({
  run: {
    runId: RUN, projectId: P, issueId: I, status: "RUNNING", evidenceManifestId: M, replayOf: null,
    procedure, executionContract: contract, environment: { workspace: "本地" },
    output: null, knowledgeCutoff: null, startedAt: "2026-09-28T00:00:00.123Z", completedAt: null, createdAt: "2026-09-28T00:00:00.123Z",
  },
  evidenceManifest: { id: M, manifestSha256: "a".repeat(64), itemCount: 1, available: false },
  ancestors: [],
});

const succeededReplayDetail = (): ResearchRunDetailResponse => ({
  run: {
    ...runningDetail().run,
    status: "SUCCEEDED", replayOf: PARENT, completedAt: "2026-09-28T02:00:00.000Z",
    output: {
      version: 1, summary: "完成核对",
      produced: { claimIds: ["11111111-1111-4111-8111-111111111111"], assessmentIds: [], resolutionIds: [], noteRevisionIds: ["22222222-2222-4222-8222-222222222222"] },
      gaps: [{ description: "缺一版", status: "OPEN" }],
    },
  },
  evidenceManifest: {
    id: M, manifestSha256: "a".repeat(64), itemCount: 2, available: true,
    items: [
      { ordinal: 1, role: "SUPPORTING", targetType: "SOURCE", note: "卷一" },
      { ordinal: 2, role: "CONTEXTUAL", targetType: "NOTE_REVISION", note: null },
    ],
  },
  ancestors: [{
    runId: PARENT, issueId: I, status: "SUCCEEDED", replayOf: null,
    startedAtMicros: "1760400000000000", startedAt: "2026-09-27T00:00:00.000Z", completedAt: "2026-09-27T05:00:00.000Z",
    evidenceManifest: { id: M, manifestSha256: "a".repeat(64), itemCount: 3, available: false },
  }],
});

beforeEach(() => {
  resetPendingResearchRunActionReceiptMemoryForTest();
  sessionStorage.clear();
  vi.mocked(getResearchRun).mockReset();
});
afterEach(() => {
  cleanup();
  resetPendingResearchRunActionReceiptMemoryForTest();
  sessionStorage.clear();
  __resetWebAuthStoreForTests();
});

describe("ResearchRunDetail — load lifecycle", () => {
  it("loading → ready shows all core fields", async () => {
    vi.mocked(getResearchRun).mockResolvedValueOnce(runningDetail());
    render(<ResearchRunDetail projectId={P} issueId={I} runId={RUN} writeAllowed={false} onHistoryRefresh={() => {}} />);
    expect(screen.getByRole("status").textContent).toContain("正在读取");
    expect(await screen.findByText(/核对版本/)).toBeTruthy();
    expect(screen.getByText(/逐页比对/)).toBeTruthy();
    expect(screen.getByText(/比较 · 比对正文/)).toBeTruthy();
    expect(screen.getByText(/搜索 · 补充检索/)).toBeTruthy();
    expect(screen.getByText(/人机协作/)).toBeTruthy();
    expect(screen.getByText(/比对表/)).toBeTruthy();
    expect(screen.getByText(/本地/)).toBeTruthy();
    expect(screen.getByText("证据当前不可访问")).toBeTruthy();
    expect(screen.queryByText(/重放祖先链/)).toBeNull();
  });

  it("unavailable → retry succeeds", async () => {
    vi.mocked(getResearchRun).mockRejectedValueOnce(new ProjectApiError(503, "SECRET X"));
    vi.mocked(getResearchRun).mockResolvedValueOnce(runningDetail());
    const user = userEvent.setup();
    render(<ResearchRunDetail projectId={P} issueId={I} runId={RUN} writeAllowed={false} onHistoryRefresh={() => {}} />);
    expect(await screen.findByText("研究轮次详情暂时无法加载。")).toBeTruthy();
    expect(document.body.textContent).not.toContain("SECRET X");
    await user.click(screen.getByRole("button", { name: "重试读取详情" }));
    expect(await screen.findByText(/核对版本/)).toBeTruthy();
  });

  it("aborts stale GET on runId change", async () => {
    let release!: (value: ResearchRunDetailResponse) => void;
    vi.mocked(getResearchRun)
      .mockReturnValueOnce(new Promise(resolve => { release = resolve; }))
      .mockResolvedValueOnce(runningDetail());
    const { rerender } = render(<ResearchRunDetail projectId={P} issueId={I} runId={RUN} writeAllowed={false} onHistoryRefresh={() => {}} />);
    const signal = vi.mocked(getResearchRun).mock.calls[0]?.[3] as AbortSignal;
    rerender(<ResearchRunDetail projectId={P} issueId={I} runId={PARENT} writeAllowed={false} onHistoryRefresh={() => {}} />);
    expect(signal.aborted).toBe(true);
    release(runningDetail());
  });
});

describe("ResearchRunDetail — content rendering", () => {
  it("terminal replay detail: output, produced groups, gaps, ancestors oldest-first, evidence items", async () => {
    vi.mocked(getResearchRun).mockResolvedValueOnce(succeededReplayDetail());
    render(<ResearchRunDetail projectId={P} issueId={I} runId={RUN} writeAllowed={false} onHistoryRefresh={() => {}} />);
    expect(await screen.findByText(/完成核对/)).toBeTruthy();
    expect(screen.getByText(/可能答案：/)).toBeTruthy();
    expect(screen.getByText(/笔记版本：/)).toBeTruthy();
    expect(screen.getByText(/缺一版（未解决）/)).toBeTruthy();
    expect(screen.getByText(/重放祖先链（最早在前）/)).toBeTruthy();
    expect(document.querySelector(".research-run-detail-ancestors code")?.textContent).toBe(PARENT);
    // evidence items show authorized fields only; no targetId anywhere
    expect(screen.getByText(/#1/)).toBeTruthy();
    expect(screen.getByText(/支持/)).toBeTruthy();
    expect(screen.getByText(/卷一/)).toBeTruthy();
    expect(document.body.textContent).not.toContain("targetId");
    expect(screen.getByText("重放自：")).toBeTruthy();
  });

  it("available=true evidence renders item rows; RUNNING shows no final output block", async () => {
    const detail = runningDetail();
    detail.evidenceManifest = {
      id: M, manifestSha256: "a".repeat(64), itemCount: 1, available: true,
      items: [{ ordinal: 1, role: "CONTRADICTORY", targetType: "SOURCE_ASSET", note: null }],
    };
    vi.mocked(getResearchRun).mockResolvedValueOnce(detail);
    render(<ResearchRunDetail projectId={P} issueId={I} runId={RUN} writeAllowed={false} onHistoryRefresh={() => {}} />);
    expect(await screen.findByText(/#1/)).toBeTruthy();
    expect(screen.getByText(/反对/)).toBeTruthy();
    expect(screen.getByText(/来源资产/)).toBeTruthy();
    expect(screen.getByText("研究仍在进行中，尚无最终产出。")).toBeTruthy();
    expect(screen.queryByText("研究产出")).toBeNull();
  });
});

describe("ResearchRunDetail — action gating", () => {
  it("RUNNING + writeAllowed shows terminal actions; not writable shows read-only note; pending allows actions", async () => {
    vi.mocked(getResearchRun).mockResolvedValue(runningDetail());
    const { rerender } = render(<ResearchRunDetail projectId={P} issueId={I} runId={RUN} writeAllowed onHistoryRefresh={() => {}} />);
    expect(await screen.findByRole("button", { name: "标记完成" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "标记失败" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "取消轮次" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "重放此研究轮次" })).toBeNull();

    rerender(<ResearchRunDetail projectId={P} issueId={I} runId={RUN} writeAllowed={false} onHistoryRefresh={() => {}} />);
    await screen.findByText("当前范围只读，无法执行研究轮次终态操作。");
    expect(screen.queryByRole("button", { name: "标记完成" })).toBeNull();
  });

  it("terminal run shows Replay, no terminal actions", async () => {
    vi.mocked(getResearchRun).mockResolvedValueOnce(succeededReplayDetail());
    render(<ResearchRunDetail projectId={P} issueId={I} runId={RUN} writeAllowed onHistoryRefresh={() => {}} />);
    expect(await screen.findByRole("button", { name: "重放此研究轮次" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "标记完成" })).toBeNull();
    expect(screen.queryByRole("button", { name: "标记失败" })).toBeNull();
    expect(screen.queryByRole("button", { name: "取消轮次" })).toBeNull();
  });

  it("archived scope (writeAllowed=false) keeps detail readable without actions", async () => {
    vi.mocked(getResearchRun).mockResolvedValueOnce(succeededReplayDetail());
    render(<ResearchRunDetail projectId={P} issueId={I} runId={RUN} writeAllowed={false} onHistoryRefresh={() => {}} />);
    expect(await screen.findByText(/完成核对/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "重放此研究轮次" })).toBeNull();
  });
});
