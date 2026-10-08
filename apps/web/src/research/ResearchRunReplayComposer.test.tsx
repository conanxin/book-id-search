// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { listIssueResolutionEvidenceBases, replayResearchRun, ProjectApiError } from "./api";
import { ResearchRunReplayComposer } from "./ResearchRunReplayComposer";
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
  listIssueResolutionEvidenceBases: vi.fn(),
  replayResearchRun: vi.fn(),
}));

const P = "11111111-1111-4111-8111-111111111111";
const I = "22222222-2222-4222-8222-222222222222";
const RUN = "33333333-3333-4333-8333-333333333333";
const NEW_RUN = "55555555-5555-4555-8555-555555555555";
const M1 = "77777777-7777-4777-8777-777777777777";
const M2 = "88888888-8888-4888-8888-888888888888";

const procedure = { version: 1 as const, objective: "核对版本", method: "逐页比对", steps: [{ kind: "COMPARE" as const, description: "比对正文" }] };
const contract = { version: 1 as const, mode: "HUMAN_AI" as const, reproducibilityLevel: "PROCEDURE" as const, tools: [] };

const base = (manifestId: string) => ({
  assessmentId: "a1111111-1111-4111-8111-111111111111",
  claimId: "c1111111-1111-4111-8111-111111111111",
  claimStatementExcerpt: "刘祥店",
  stance: "SUPPORTS" as const,
  confidenceLevel: null,
  manifestId,
  manifestSha256: "a".repeat(64),
  itemCount: 2,
  assessmentCreatedAt: "2026-09-20T00:00:00Z",
});

beforeEach(() => {
  resetPendingResearchRunActionReceiptMemoryForTest();
  sessionStorage.clear();
  vi.mocked(listIssueResolutionEvidenceBases).mockReset().mockResolvedValue({ issueId: I, evidenceBases: [base(M1)], nextCursor: null });
  vi.mocked(replayResearchRun).mockReset();
});
afterEach(() => {
  cleanup();
  resetPendingResearchRunActionReceiptMemoryForTest();
  sessionStorage.clear();
  __resetWebAuthStoreForTests();
});

const props = {
  projectId: P, issueId: I, parentRunId: RUN,
  parentProcedure: procedure, parentContract: contract, parentEnvironment: {},
  parentManifestId: M1,
};

describe("ResearchRunReplayComposer — entry and evidence", () => {
  it("collapsed entry; opens with explanation; parent plan shown", async () => {
    const user = userEvent.setup();
    render(<ResearchRunReplayComposer {...props} pending={null} onCommitted={() => {}} />);
    await user.click(screen.getByRole("button", { name: "重放此研究轮次" }));
    expect(screen.getByText(/研究记录的重放/)).toBeTruthy();
    expect(screen.getByText("原目标：核对版本")).toBeTruthy();
    expect(screen.getByText("原方法：逐页比对")).toBeTruthy();
    expect(await screen.findByLabelText(/证据快照/)).toBeTruthy();
    // selector options only from API; no free UUID input
    const select = screen.getByLabelText(/证据快照/) as HTMLSelectElement;
    expect(Array.from(select.querySelectorAll("option")).map(option => option.value)).toEqual(["", M1]);
    expect(document.querySelector("input[placeholder*='UUID']")).toBeNull();
  });

  it("zero choices disables replay with explanation", async () => {
    vi.mocked(listIssueResolutionEvidenceBases).mockResolvedValueOnce({ issueId: I, evidenceBases: [], nextCursor: null });
    const user = userEvent.setup();
    render(<ResearchRunReplayComposer {...props} pending={null} onCommitted={() => {}} />);
    await user.click(screen.getByRole("button", { name: "重放此研究轮次" }));
    expect(await screen.findByText("还没有可用的证据快照。重放需要一个当前已授权的证据快照。")).toBeTruthy();
    const confirm = screen.queryByRole("button", { name: "确认重放" }) as HTMLButtonElement | null;
    expect(confirm === null || confirm.disabled).toBe(true);
  });

  it("paginates evidence with exact cursor and dedupes", async () => {
    vi.mocked(listIssueResolutionEvidenceBases)
      .mockResolvedValueOnce({ issueId: I, evidenceBases: [base(M1)], nextCursor: "ev-1" })
      .mockResolvedValueOnce({ issueId: I, evidenceBases: [base(M1), base(M2)], nextCursor: null });
    const user = userEvent.setup();
    render(<ResearchRunReplayComposer {...props} pending={null} onCommitted={() => {}} />);
    await user.click(screen.getByRole("button", { name: "重放此研究轮次" }));
    await user.click(await screen.findByRole("button", { name: "加载更多证据快照" }));
    const select = await waitFor(() => {
      const element = screen.getByLabelText(/证据快照/) as HTMLSelectElement;
      expect(Array.from(element.querySelectorAll("option")).map(option => option.value)).toEqual(["", M1, M2]);
      return element;
    });
    expect(select).toBeTruthy();
    expect(vi.mocked(listIssueResolutionEvidenceBases)).toHaveBeenLastCalledWith(P, I, { limit: 50, cursor: "ev-1" }, expect.anything());
  });
});

describe("ResearchRunReplayComposer — submit", () => {
  it("201 created: posts parent-copied command verbatim, new run shown, receipt cleared", async () => {
    const onCommitted = vi.fn();
    vi.mocked(replayResearchRun).mockResolvedValueOnce({ status: "created", runId: NEW_RUN });
    const user = userEvent.setup();
    render(<ResearchRunReplayComposer {...props} pending={null} onCommitted={onCommitted} />);
    await user.click(screen.getByRole("button", { name: "重放此研究轮次" }));
    await user.selectOptions(await screen.findByLabelText(/证据快照/), M1);
    await user.click(screen.getByRole("button", { name: "确认重放" }));
    expect(await screen.findByText("已创建新的研究轮次：")).toBeTruthy();
    expect(document.querySelector(".research-run-success code")?.textContent).toBe(NEW_RUN);
    const call = vi.mocked(replayResearchRun).mock.calls[0];
    expect(call?.[0]).toBe(P); expect(call?.[1]).toBe(I); expect(call?.[2]).toBe(RUN);
    expect(call?.[4]).toEqual({ procedure, executionContract: contract, environment: {}, evidenceManifestId: M1 });
    expect(onCommitted).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(RESEARCH_RUN_ACTION_PENDING_KEY)).toBeNull();
  });

  it("503 keeps receipt; same-key retry resends exact persisted command (not mutable form)", async () => {
    vi.mocked(listIssueResolutionEvidenceBases).mockReset().mockResolvedValue({ issueId: I, evidenceBases: [base(M1), base(M2)], nextCursor: null });
    vi.mocked(replayResearchRun).mockRejectedValueOnce(new ProjectApiError(503, "研究执行服务暂不可用。", "RESEARCH_RUN_STORE_UNAVAILABLE"));
    const user = userEvent.setup();
    render(<ResearchRunReplayComposer {...props} pending={null} onCommitted={() => {}} />);
    await user.click(screen.getByRole("button", { name: "重放此研究轮次" }));
    await user.selectOptions(await screen.findByLabelText(/证据快照/), M1);
    await user.click(screen.getByRole("button", { name: "确认重放" }));
    expect(await screen.findByText("研究轮次重放结果尚未确认。可以使用同一标识重试。")).toBeTruthy();
    const firstKey = vi.mocked(replayResearchRun).mock.calls[0]?.[3];
    const firstBody = vi.mocked(replayResearchRun).mock.calls[0]?.[4];
    // User REALLY mutates the select to the other manifest before retry — the
    // retry must still send the persisted command (manifest M1), not M2.
    await user.selectOptions(screen.getByLabelText(/证据快照/), M2);
    vi.mocked(replayResearchRun).mockResolvedValueOnce({ status: "created", runId: NEW_RUN });
    await user.click(screen.getByRole("button", { name: "使用同一标识重试" }));
    await waitFor(() => expect(vi.mocked(replayResearchRun)).toHaveBeenCalledTimes(2));
    expect(vi.mocked(replayResearchRun).mock.calls[1]?.[3]).toBe(firstKey);
    expect(JSON.stringify(vi.mocked(replayResearchRun).mock.calls[1]?.[4])).toBe(JSON.stringify(firstBody));
  });

  it("409 conflict freezes; explicit discard clears and reloads", async () => {
    vi.mocked(replayResearchRun).mockRejectedValueOnce(new ProjectApiError(409, "提交标识与当前研究执行记录内容不一致。", "IDEMPOTENCY_CONFLICT"));
    const user = userEvent.setup();
    render(<ResearchRunReplayComposer {...props} pending={null} onCommitted={() => {}} />);
    await user.click(screen.getByRole("button", { name: "重放此研究轮次" }));
    await user.selectOptions(await screen.findByLabelText(/证据快照/), M1);
    await user.click(screen.getByRole("button", { name: "确认重放" }));
    expect(await screen.findByText(/需要明确放弃后才能重新提交/)).toBeTruthy();
    expect(sessionStorage.getItem(RESEARCH_RUN_ACTION_PENDING_KEY)).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "放弃未确认提交，重新开始" }));
    expect(sessionStorage.getItem(RESEARCH_RUN_ACTION_PENDING_KEY)).toBeNull();
    await waitFor(() => expect(vi.mocked(listIssueResolutionEvidenceBases).mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it("pending saved missing manifest remains retryable with saved option", async () => {
    const storedKey = "99999999-9999-4999-8999-999999999999";
    sessionStorage.setItem(RESEARCH_RUN_ACTION_PENDING_KEY, JSON.stringify({
      projectId: P, issueId: I, runId: RUN, action: "REPLAY",
      requestHash: "a".repeat(64), idempotencyKey: storedKey,
      createdAt: new Date().toISOString(),
      command: { procedure, executionContract: contract, environment: {}, evidenceManifestId: M2 },
    }));
    vi.mocked(replayResearchRun).mockResolvedValueOnce({ status: "created", runId: NEW_RUN });
    const user = userEvent.setup();
    render(<ResearchRunReplayComposer {...props} pending={null} onCommitted={() => {}} />);
    expect(await screen.findByText("研究轮次重放结果尚未确认。可以使用同一标识重试。")).toBeTruthy();
    await waitFor(() => {
      const select = screen.getByLabelText(/证据快照/) as HTMLSelectElement;
      expect(select.value).toBe(M2);
    });
    const select = screen.getByLabelText(/证据快照/) as HTMLSelectElement;
    expect(Array.from(select.querySelectorAll("option")).map(option => option.value)).toContain(M2);
    await user.click(screen.getByRole("button", { name: "使用同一标识重试" }));
    await waitFor(() => expect(vi.mocked(replayResearchRun)).toHaveBeenCalledTimes(1));
    expect(vi.mocked(replayResearchRun).mock.calls[0]?.[3]).toBe(storedKey);
    expect((vi.mocked(replayResearchRun).mock.calls[0]?.[4] as { evidenceManifestId: string }).evidenceManifestId).toBe(M2);
  });

  it("raw server secret never rendered", async () => {
    vi.mocked(replayResearchRun).mockRejectedValueOnce(new ProjectApiError(500, "SECRET INTERNAL"));
    const user = userEvent.setup();
    render(<ResearchRunReplayComposer {...props} pending={null} onCommitted={() => {}} />);
    await user.click(screen.getByRole("button", { name: "重放此研究轮次" }));
    await user.selectOptions(await screen.findByLabelText(/证据快照/), M1);
    await user.click(screen.getByRole("button", { name: "确认重放" }));
    expect(await screen.findByText("研究轮次重放结果尚未确认。可以使用同一标识重试。")).toBeTruthy();
    expect(document.body.textContent).not.toContain("SECRET INTERNAL");
  });
});
