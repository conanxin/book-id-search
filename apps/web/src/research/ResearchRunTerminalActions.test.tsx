// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { cancelResearchRun, completeResearchRun, failResearchRun, ProjectApiError } from "./api";
import { ResearchRunTerminalActions } from "./ResearchRunTerminalActions";
import { RESEARCH_RUN_ACTION_PENDING_KEY, resetPendingResearchRunActionReceiptMemoryForTest } from "./research-run-action-draft";

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
  completeResearchRun: vi.fn(),
  failResearchRun: vi.fn(),
  cancelResearchRun: vi.fn(),
}));

const P = "11111111-1111-4111-8111-111111111111";
const I = "22222222-2222-4222-8222-222222222222";
const RUN = "33333333-3333-4333-8333-333333333333";

beforeEach(() => {
  resetPendingResearchRunActionReceiptMemoryForTest();
  sessionStorage.clear();
  vi.mocked(completeResearchRun).mockReset();
  vi.mocked(failResearchRun).mockReset();
  vi.mocked(cancelResearchRun).mockReset();
});
afterEach(() => {
  cleanup();
  resetPendingResearchRunActionReceiptMemoryForTest();
  sessionStorage.clear();
  __resetWebAuthStoreForTests();
});

describe("ResearchRunTerminalActions — gates", () => {
  it("offers three actions for RUNNING with no pending", () => {
    render(<ResearchRunTerminalActions projectId={P} issueId={I} runId={RUN} pending={null} onCommitted={() => {}} />);
    expect(screen.getByRole("button", { name: "标记完成" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "标记失败" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "取消轮次" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "使用同一标识重试" })).toBeNull();
  });
});

describe("ResearchRunTerminalActions — FAIL / CANCEL", () => {
  it("FAIL requires confirmation then posts exactly {output:null}", async () => {
    const onCommitted = vi.fn();
    vi.mocked(failResearchRun).mockResolvedValueOnce({ status: "created", runId: RUN });
    const user = userEvent.setup();
    render(<ResearchRunTerminalActions projectId={P} issueId={I} runId={RUN} pending={null} onCommitted={onCommitted} />);
    await user.click(screen.getByRole("button", { name: "标记失败" }));
    expect(screen.getByRole("alert").textContent).toContain("不可撤销");
    expect(vi.mocked(failResearchRun)).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "确认标记失败" }));
    await waitFor(() => expect(onCommitted).toHaveBeenCalledTimes(1));
    expect(vi.mocked(failResearchRun)).toHaveBeenCalledWith(P, I, RUN, expect.any(String), null);
    expect(sessionStorage.getItem(RESEARCH_RUN_ACTION_PENDING_KEY)).toBeNull();
  });

  it("CANCEL posts {output:null} and clears receipt", async () => {
    const onCommitted = vi.fn();
    vi.mocked(cancelResearchRun).mockResolvedValueOnce({ status: "created", runId: RUN });
    const user = userEvent.setup();
    render(<ResearchRunTerminalActions projectId={P} issueId={I} runId={RUN} pending={null} onCommitted={onCommitted} />);
    await user.click(screen.getByRole("button", { name: "取消轮次" }));
    await user.click(screen.getByRole("button", { name: "确认取消轮次" }));
    await waitFor(() => expect(onCommitted).toHaveBeenCalledTimes(1));
    expect(vi.mocked(cancelResearchRun)).toHaveBeenCalledWith(P, I, RUN, expect.any(String), null);
    expect(sessionStorage.getItem(RESEARCH_RUN_ACTION_PENDING_KEY)).toBeNull();
  });
});

describe("ResearchRunTerminalActions — COMPLETE", () => {
  async function openComplete(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole("button", { name: "标记完成" }));
    await screen.findByRole("button", { name: "确认标记完成" });
  }

  it("submits a normalized Output v1 with four groups and gaps", async () => {
    const onCommitted = vi.fn();
    vi.mocked(completeResearchRun).mockResolvedValueOnce({ status: "created", runId: RUN });
    const user = userEvent.setup();
    render(<ResearchRunTerminalActions projectId={P} issueId={I} runId={RUN} pending={null} onCommitted={onCommitted} />);
    await openComplete(user);
    await user.type(screen.getByLabelText(/研究产出摘要/), "完成核对");
    await user.type(screen.getByLabelText(/可能答案 ID/), "11111111-1111-4111-8111-111111111111");
    await user.type(screen.getByLabelText(/评价 ID/), "22222222-2222-4222-8222-222222222222");
    await user.type(screen.getByLabelText(/缺口/), "缺一版::OPEN\n受阻::BLOCKED");
    await user.click(screen.getByRole("button", { name: "确认标记完成" }));
    await waitFor(() => expect(onCommitted).toHaveBeenCalledTimes(1));
    const body = vi.mocked(completeResearchRun).mock.calls[0]?.[4];
    expect(body).toMatchObject({
      version: 1,
      summary: "完成核对",
      produced: {
        claimIds: ["11111111-1111-4111-8111-111111111111"],
        assessmentIds: ["22222222-2222-4222-8222-222222222222"],
        resolutionIds: [],
        noteRevisionIds: [],
      },
      gaps: [{ description: "缺一版", status: "OPEN" }, { description: "受阻", status: "BLOCKED" }],
    });
    expect(sessionStorage.getItem(RESEARCH_RUN_ACTION_PENDING_KEY)).toBeNull();
  });

  it("rejects malformed UUID inline without calling the API", async () => {
    const user = userEvent.setup();
    render(<ResearchRunTerminalActions projectId={P} issueId={I} runId={RUN} pending={null} onCommitted={() => {}} />);
    await openComplete(user);
    await user.type(screen.getByLabelText(/研究产出摘要/), "摘要");
    await user.type(screen.getByLabelText(/可能答案 ID/), "not-a-uuid");
    await user.click(screen.getByRole("button", { name: "确认标记完成" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(vi.mocked(completeResearchRun)).not.toHaveBeenCalled();
  });
});

describe("ResearchRunTerminalActions — retry / conflict / definitive", () => {
  it("503 keeps receipt; retry reuses the exact key and command", async () => {
    vi.mocked(failResearchRun).mockRejectedValueOnce(new ProjectApiError(503, "研究执行服务暂不可用。", "RESEARCH_RUN_STORE_UNAVAILABLE"));
    const user = userEvent.setup();
    render(<ResearchRunTerminalActions projectId={P} issueId={I} runId={RUN} pending={null} onCommitted={() => {}} />);
    await user.click(screen.getByRole("button", { name: "标记失败" }));
    await user.click(screen.getByRole("button", { name: "确认标记失败" }));
    expect(await screen.findByText("研究轮次操作结果尚未确认。可以使用同一标识重试。")).toBeTruthy();
    expect(sessionStorage.getItem(RESEARCH_RUN_ACTION_PENDING_KEY)).not.toBeNull();
    const firstKey = vi.mocked(failResearchRun).mock.calls[0]?.[3];
    vi.mocked(failResearchRun).mockResolvedValueOnce({ status: "created", runId: RUN });
    await user.click(screen.getByRole("button", { name: "使用同一标识重试" }));
    await waitFor(() => expect(vi.mocked(failResearchRun)).toHaveBeenCalledTimes(2));
    expect(vi.mocked(failResearchRun).mock.calls[1]?.[3]).toBe(firstKey);
    expect(sessionStorage.getItem(RESEARCH_RUN_ACTION_PENDING_KEY)).toBeNull();
  });

  it("409 IDEMPOTENCY_CONFLICT freezes and requires explicit discard", async () => {
    vi.mocked(cancelResearchRun).mockRejectedValueOnce(new ProjectApiError(409, "提交标识与当前研究执行记录内容不一致。", "IDEMPOTENCY_CONFLICT"));
    const user = userEvent.setup();
    render(<ResearchRunTerminalActions projectId={P} issueId={I} runId={RUN} pending={null} onCommitted={() => {}} />);
    await user.click(screen.getByRole("button", { name: "取消轮次" }));
    await user.click(screen.getByRole("button", { name: "确认取消轮次" }));
    expect(await screen.findByText(/需要明确放弃后才能重新提交/)).toBeTruthy();
    expect(sessionStorage.getItem(RESEARCH_RUN_ACTION_PENDING_KEY)).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "放弃未确认提交，重新开始" }));
    expect(sessionStorage.getItem(RESEARCH_RUN_ACTION_PENDING_KEY)).toBeNull();
  });

  it("409 ALREADY_TERMINAL clears receipt, shows safe copy and reloads state", async () => {
    const onCommitted = vi.fn();
    vi.mocked(failResearchRun).mockRejectedValueOnce(new ProjectApiError(409, "该研究轮次已经处于终态。", "RESEARCH_RUN_ALREADY_TERMINAL"));
    const user = userEvent.setup();
    render(<ResearchRunTerminalActions projectId={P} issueId={I} runId={RUN} pending={null} onCommitted={onCommitted} />);
    await user.click(screen.getByRole("button", { name: "标记失败" }));
    await user.click(screen.getByRole("button", { name: "确认标记失败" }));
    await waitFor(() => expect(onCommitted).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("该研究轮次已经处于终态。")).toBeTruthy();
    expect(sessionStorage.getItem(RESEARCH_RUN_ACTION_PENDING_KEY)).toBeNull();
  });

  it("raw server secret never rendered", async () => {
    vi.mocked(failResearchRun).mockRejectedValueOnce(new ProjectApiError(500, "SECRET STACK TRACE"));
    const user = userEvent.setup();
    render(<ResearchRunTerminalActions projectId={P} issueId={I} runId={RUN} pending={null} onCommitted={() => {}} />);
    await user.click(screen.getByRole("button", { name: "标记失败" }));
    await user.click(screen.getByRole("button", { name: "确认标记失败" }));
    expect(await screen.findByText("研究轮次操作结果尚未确认。可以使用同一标识重试。")).toBeTruthy();
    expect(document.body.textContent).not.toContain("SECRET STACK TRACE");
  });
});

describe("ResearchRunTerminalActions — pending restore", () => {
  it("restores a scope-matched pending FAIL and retries the exact persisted command", async () => {
    const storedKey = "99999999-9999-4999-8999-999999999999";
    sessionStorage.setItem(RESEARCH_RUN_ACTION_PENDING_KEY, JSON.stringify({
      projectId: P, issueId: I, runId: RUN, action: "FAIL",
      requestHash: "a".repeat(64), idempotencyKey: storedKey,
      createdAt: new Date().toISOString(),
      command: { output: null },
    }));
    vi.mocked(failResearchRun).mockResolvedValueOnce({ status: "replayed", runId: RUN });
    const user = userEvent.setup();
    render(<ResearchRunTerminalActions projectId={P} issueId={I} runId={RUN} pending={null} onCommitted={() => {}} />);
    expect(await screen.findByText(/尚未确认的「失败」提交/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "使用同一标识重试" }));
    await waitFor(() => expect(vi.mocked(failResearchRun)).toHaveBeenCalledTimes(1));
    expect(vi.mocked(failResearchRun).mock.calls[0]?.[3]).toBe(storedKey);
    expect(vi.mocked(failResearchRun).mock.calls[0]?.[4]).toBeNull();
    expect(sessionStorage.getItem(RESEARCH_RUN_ACTION_PENDING_KEY)).toBeNull();
  });

  it("pending on another Run is surfaced but not usable from this Run's actions", () => {
    sessionStorage.setItem(RESEARCH_RUN_ACTION_PENDING_KEY, JSON.stringify({
      projectId: P, issueId: I, runId: "44444444-4444-4444-8444-444444444444", action: "FAIL",
      requestHash: "a".repeat(64), idempotencyKey: "99999999-9999-4999-8999-999999999999",
      createdAt: new Date().toISOString(),
      command: { output: null },
    }));
    render(<ResearchRunTerminalActions projectId={P} issueId={I} runId={RUN} pending={null} onCommitted={() => {}} />);
    // no retry offered for THIS run (receipt belongs to another run)
    expect(screen.queryByRole("button", { name: "使用同一标识重试" })).toBeNull();
    expect(screen.getByRole("button", { name: "标记完成" })).toBeTruthy();
  });
});
