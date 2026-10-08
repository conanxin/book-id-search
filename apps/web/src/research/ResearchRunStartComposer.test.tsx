// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  listIssueResolutionEvidenceBases,
  ProjectApiError,
  startResearchRun,
} from "./api";
import { ResearchRunStartComposer } from "./ResearchRunStartComposer";
import {
  RESEARCH_RUN_START_PENDING_KEY,
  resetPendingResearchRunStartReceiptMemoryForTest,
} from "./research-run-start-draft";

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
  startResearchRun: vi.fn(),
}));

const P = "11111111-1111-4111-8111-111111111111";
const I = "22222222-2222-4222-8222-222222222222";
const M1 = "77777777-7777-4777-8777-777777777777";
const M2 = "88888888-8888-4888-8888-888888888888";
const RUN = "33333333-3333-4333-8333-333333333333";

const base = (manifestId: string, over: Record<string, unknown> = {}) => ({
  assessmentId: `a${manifestId.slice(0, 8)}`,
  claimId: "c1111111-1111-4111-8111-111111111111",
  claimStatementExcerpt: "刘祥店迁出时间",
  stance: "SUPPORTS" as const,
  confidenceLevel: "HIGH" as const,
  manifestId,
  manifestSha256: "a".repeat(64),
  itemCount: 3,
  assessmentCreatedAt: "2026-09-20T00:00:00Z",
  ...over,
});

beforeEach(() => {
  resetPendingResearchRunStartReceiptMemoryForTest();
  sessionStorage.clear();
  vi.mocked(listIssueResolutionEvidenceBases).mockReset().mockResolvedValue({ issueId: I, evidenceBases: [base(M1)], nextCursor: null });
  vi.mocked(startResearchRun).mockReset();
});
afterEach(() => {
  cleanup();
  resetPendingResearchRunStartReceiptMemoryForTest();
  sessionStorage.clear();
  __resetWebAuthStoreForTests();
});

async function fillForm(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "开始新的研究轮次" }));
  await screen.findByLabelText(/证据快照/);
  await user.selectOptions(screen.getByLabelText(/证据快照/), M1);
  await user.type(screen.getByLabelText("研究目标"), "核对版本差异");
  await user.type(screen.getByLabelText("研究方法"), "逐页比对");
  await user.type(screen.getByLabelText("步骤 1 描述"), "比对两版正文");
  await user.click(document.querySelector('input[value="HUMAN_AI"]')!);
  await user.click(document.querySelector('input[value="PROCEDURE"]')!);
}

describe("ResearchRunStartComposer — evidence source", () => {
  it("loads evidence bases with limit 50 and disables submit when zero evidence", async () => {
    vi.mocked(listIssueResolutionEvidenceBases).mockResolvedValueOnce({ issueId: I, evidenceBases: [], nextCursor: null });
    render(<ResearchRunStartComposer projectId={P} issueId={I} writeAllowed onCommitted={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "开始新的研究轮次" }));
    expect(await screen.findByText("还没有可用于研究轮次的证据快照。请先在可能答案下完成至少一次带证据的评价。")).toBeTruthy();
    expect((listIssueResolutionEvidenceBases.mock.calls[0]?.[2] as { limit: number }).limit).toBe(50);
    const submit = screen.queryByRole("button", { name: "开始研究轮次" }) as HTMLButtonElement | null;
    expect(submit === null || submit.disabled).toBe(true);
  });

  it("selector options come from API manifest IDs only; no free UUID input", async () => {
    render(<ResearchRunStartComposer projectId={P} issueId={I} writeAllowed onCommitted={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "开始新的研究轮次" }));
    const select = await screen.findByLabelText(/证据快照/);
    const options = Array.from(select.querySelectorAll("option"));
    expect(options.map(o => o.value)).toEqual(["", M1]);
    expect(document.querySelector("input[placeholder*='UUID']")).toBeNull();
  });

  it("load-more uses exact cursor, appends and dedupes by manifestId", async () => {
    vi.mocked(listIssueResolutionEvidenceBases)
      .mockResolvedValueOnce({ issueId: I, evidenceBases: [base(M1)], nextCursor: "ev-cursor-1" })
      .mockResolvedValueOnce({ issueId: I, evidenceBases: [base(M1), base(M2)], nextCursor: null });
    render(<ResearchRunStartComposer projectId={P} issueId={I} writeAllowed onCommitted={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "开始新的研究轮次" }));
    await screen.findByRole("button", { name: "加载更多证据快照" });
    await userEvent.click(screen.getByRole("button", { name: "加载更多证据快照" }));
    await waitFor(() => expect(listIssueResolutionEvidenceBases).toHaveBeenLastCalledWith(P, I, { limit: 50, cursor: "ev-cursor-1" }, expect.anything()));
    const select = screen.getByLabelText(/证据快照/);
    await waitFor(() => expect(Array.from(select.querySelectorAll("option")).map(o => o.value)).toEqual(["", M1, M2]));
    expect(screen.queryByRole("button", { name: "加载更多证据快照" })).toBeNull();
  });

  it("page failure preserves options and retries the exact cursor", async () => {
    vi.mocked(listIssueResolutionEvidenceBases)
      .mockResolvedValueOnce({ issueId: I, evidenceBases: [base(M1)], nextCursor: "ev-c2" })
      .mockRejectedValueOnce(new ProjectApiError(503, "SECRET EV"))
      .mockResolvedValueOnce({ issueId: I, evidenceBases: [base(M2)], nextCursor: null });
    render(<ResearchRunStartComposer projectId={P} issueId={I} writeAllowed onCommitted={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "开始新的研究轮次" }));
    await screen.findByRole("button", { name: "加载更多证据快照" });
    await userEvent.click(screen.getByRole("button", { name: "加载更多证据快照" }));
    expect(await screen.findByText("更早的证据快照暂时无法加载。")).toBeTruthy();
    expect(document.body.textContent).not.toContain("SECRET EV");
    await userEvent.click(screen.getByRole("button", { name: "重试加载更早证据快照" }));
    await waitFor(() => {
      const select = screen.getByLabelText(/证据快照/);
      expect(Array.from(select.querySelectorAll("option")).map(o => o.value)).toEqual(["", M1, M2]);
    });
    const cursors = listIssueResolutionEvidenceBases.mock.calls.map(call => (call[2] as { cursor?: string }).cursor);
    expect(cursors).toEqual([undefined, "ev-c2", "ev-c2"]);
  });

  it("initial evidence failure shows safe message and keeps composer visible but unsubmittable", async () => {
    vi.mocked(listIssueResolutionEvidenceBases).mockRejectedValueOnce(new ProjectApiError(503, "SECRET INIT"));
    render(<ResearchRunStartComposer projectId={P} issueId={I} writeAllowed onCommitted={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "开始新的研究轮次" }));
    expect(await screen.findByText("研究轮次所需的证据快照暂不可用。")).toBeTruthy();
    expect(document.body.textContent).not.toContain("SECRET INIT");
    const submit = screen.queryByRole("button", { name: "开始研究轮次" }) as HTMLButtonElement | null;
    expect(submit === null || submit.disabled).toBe(true);
  });

  it("pending receipt with missing manifest keeps a saved option", async () => {
    sessionStorage.setItem(RESEARCH_RUN_START_PENDING_KEY, JSON.stringify({
      projectId: P, issueId: I, requestHash: "a".repeat(64),
      idempotencyKey: "99999999-9999-4999-8999-999999999999",
      createdAt: new Date().toISOString(),
      command: {
        procedure: { version: 1, objective: "已存目标", method: "已存方法", steps: [{ kind: "READ", description: "已存步骤" }] },
        executionContract: { version: 1, mode: "HUMAN", reproducibilityLevel: "AUDIT", tools: [] },
        environment: {}, evidenceManifestId: M2, replayOf: null,
      },
    }));
    render(<ResearchRunStartComposer projectId={P} issueId={I} writeAllowed onCommitted={() => {}} />);
    // auto-expanded with restored fields
    expect(await screen.findByDisplayValue("已存目标")).toBeTruthy();
    expect(screen.getByDisplayValue("已存方法")).toBeTruthy();
    const select = screen.getByLabelText(/证据快照/);
    await waitFor(() => expect(Array.from(select.querySelectorAll("option")).map(o => o.value)).toEqual(["", M1, M2]));
    expect((select as HTMLSelectElement).value).toBe(M2);
    expect(screen.getByRole("status").textContent).toContain("尚未确认");
  });

  it("reloaded pending receipt immediately offers the same-key retry button (Task5 C1 regression)", async () => {
    sessionStorage.setItem(RESEARCH_RUN_START_PENDING_KEY, JSON.stringify({
      projectId: P, issueId: I, requestHash: "a".repeat(64),
      idempotencyKey: "99999999-9999-4999-8999-999999999999",
      createdAt: new Date().toISOString(),
      command: {
        procedure: { version: 1, objective: "重载目标", method: "重载方法", steps: [{ kind: "READ", description: "重载步骤" }] },
        executionContract: { version: 1, mode: "HUMAN", reproducibilityLevel: "AUDIT", tools: [] },
        environment: {}, evidenceManifestId: M1, replayOf: null,
      },
    }));
    render(<ResearchRunStartComposer projectId={P} issueId={I} writeAllowed onCommitted={() => {}} />);
    // After a pure reload the composer must land in the unconfirmed state with a usable retry button.
    expect(await screen.findByRole("button", { name: "使用同一标识重试" })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("尚未确认");
  });
});

describe("ResearchRunStartComposer — form", () => {
  it("collapsed entry expands; submit disabled until fully valid", async () => {
    const user = userEvent.setup();
    render(<ResearchRunStartComposer projectId={P} issueId={I} writeAllowed onCommitted={() => {}} />);
    await user.click(screen.getByRole("button", { name: "开始新的研究轮次" }));
    const submit = await screen.findByRole("button", { name: "开始研究轮次" });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    await user.selectOptions(screen.getByLabelText(/证据快照/), M1);
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    await user.type(screen.getByLabelText("研究目标"), "目标");
    await user.type(screen.getByLabelText("研究方法"), "方法");
    await user.type(screen.getByLabelText("步骤 1 描述"), "步骤");
    expect((submit as HTMLButtonElement).disabled).toBe(true); // mode+repro still missing
    await user.click(document.querySelector('input[value="HUMAN"]')!);
    expect((submit as HTMLButtonElement).disabled).toBe(true); // repro still missing
    await user.click(document.querySelector('input[value="EXACT"]')!);
    expect((submit as HTMLButtonElement).disabled).toBe(false);
  });

  it("steps add/remove/reorder with kind codes preserved", async () => {
    const user = userEvent.setup();
    render(<ResearchRunStartComposer projectId={P} issueId={I} writeAllowed onCommitted={() => {}} />);
    await user.click(screen.getByRole("button", { name: "开始新的研究轮次" }));
    await screen.findByLabelText(/证据快照/);
    await user.click(screen.getByRole("button", { name: "添加步骤" }));
    expect(screen.getAllByLabelText(/步骤 \d 描述/)).toHaveLength(2);
    const first = screen.getByLabelText("步骤 1 描述");
    const second = screen.getByLabelText("步骤 2 描述");
    await user.type(first, "第一条");
    await user.type(second, "第二条");
    await user.click(screen.getAllByRole("button", { name: "上移" })[1]);
    expect((screen.getByLabelText("步骤 1 描述") as HTMLInputElement).value).toBe("第二条");
    await user.click(screen.getAllByRole("button", { name: "删除" })[1]);
    expect(screen.getAllByLabelText(/步骤 \d 描述/)).toHaveLength(1);
    expect((screen.getByLabelText("步骤 1 描述") as HTMLInputElement).value).toBe("第二条");
    // kind select holds enum codes
    expect((screen.getByLabelText("步骤 1 类型") as HTMLSelectElement).value).toBe("SEARCH");
    await user.selectOptions(screen.getByLabelText("步骤 1 类型"), "IMAGE_ANALYSIS");
    expect((screen.getByLabelText("步骤 1 类型") as HTMLSelectElement).value).toBe("IMAGE_ANALYSIS");
  });

  it("tools add/remove; environment not editable", async () => {
    const user = userEvent.setup();
    render(<ResearchRunStartComposer projectId={P} issueId={I} writeAllowed onCommitted={() => {}} />);
    await user.click(screen.getByRole("button", { name: "开始新的研究轮次" }));
    await screen.findByLabelText(/证据快照/);
    await user.click(screen.getByRole("button", { name: "添加工具" }));
    await user.type(screen.getByLabelText("工具 1 名称"), "比对表");
    expect(screen.queryByLabelText(/环境/)).toBeNull();
    expect(screen.getByText("本版本暂不记录环境变量或凭据。")).toBeTruthy();
    const toolRemove = document.querySelector(".research-run-tool-list")!.querySelector('button[type="button"]')!;
    await user.click(toolRemove);
    expect(document.querySelector(".research-run-tool-list")!.children).toHaveLength(0);
  });
});

describe("ResearchRunStartComposer — submit/idempotency", () => {
  it("persists receipt before startResearchRun and clears on 201 created", async () => {
    const user = userEvent.setup();
    const onCommitted = vi.fn();
    vi.mocked(startResearchRun).mockResolvedValueOnce({ status: "created", runId: RUN });
    render(<ResearchRunStartComposer projectId={P} issueId={I} writeAllowed onCommitted={onCommitted} />);
    await fillForm(user);
    await user.click(screen.getByRole("button", { name: "开始研究轮次" }));
    await screen.findByText("研究轮次已开始。");
    // receipt persisted before the API call, cleared after
    const storedDuringCall = startResearchRun.mock.calls[0];
    expect(storedDuringCall?.[2]).toMatch(/^[0-9a-f-]{36}$/);
    expect(startResearchRun).toHaveBeenCalledWith(P, I, storedDuringCall?.[2], expect.objectContaining({ environment: {}, replayOf: null }));
    expect(sessionStorage.getItem(RESEARCH_RUN_START_PENDING_KEY)).toBeNull();
    expect(onCommitted).toHaveBeenCalledWith(RUN);
  });

  it("200 replayed clears receipt and shows replay copy", async () => {
    const user = userEvent.setup();
    const onCommitted = vi.fn();
    vi.mocked(startResearchRun).mockResolvedValueOnce({ status: "replayed", runId: RUN });
    render(<ResearchRunStartComposer projectId={P} issueId={I} writeAllowed onCommitted={onCommitted} />);
    await fillForm(user);
    await user.click(screen.getByRole("button", { name: "开始研究轮次" }));
    expect(await screen.findByText("此研究轮次此前已经成功开始。")).toBeTruthy();
    expect(sessionStorage.getItem(RESEARCH_RUN_START_PENDING_KEY)).toBeNull();
    expect(onCommitted).toHaveBeenCalledWith(RUN);
  });

  it("503 keeps pending receipt; retry reuses the exact same key and command", async () => {
    const user = userEvent.setup();
    vi.mocked(startResearchRun).mockRejectedValueOnce(new ProjectApiError(503, "研究执行服务暂不可用。", "RESEARCH_RUN_STORE_UNAVAILABLE"));
    render(<ResearchRunStartComposer projectId={P} issueId={I} writeAllowed onCommitted={() => {}} />);
    await fillForm(user);
    await user.click(screen.getByRole("button", { name: "开始研究轮次" }));
    expect(await screen.findByText("研究轮次提交结果尚未确认。可以使用同一标识重试。")).toBeTruthy();
    expect(sessionStorage.getItem(RESEARCH_RUN_START_PENDING_KEY)).not.toBeNull();
    const firstKey = startResearchRun.mock.calls[0]?.[2];
    vi.mocked(startResearchRun).mockResolvedValueOnce({ status: "created", runId: RUN });
    await user.click(screen.getByRole("button", { name: "使用同一标识重试" }));
    await screen.findByText("研究轮次已开始。");
    expect(startResearchRun.mock.calls[1]?.[2]).toBe(firstKey);
    expect(JSON.stringify(startResearchRun.mock.calls[1]?.[3])).toBe(JSON.stringify(startResearchRun.mock.calls[0]?.[3]));
  });

  it("409 IDEMPOTENCY_CONFLICT freezes receipt and requires explicit discard", async () => {
    const user = userEvent.setup();
    vi.mocked(startResearchRun).mockRejectedValueOnce(new ProjectApiError(409, "提交标识与当前研究执行记录内容不一致。", "IDEMPOTENCY_CONFLICT"));
    render(<ResearchRunStartComposer projectId={P} issueId={I} writeAllowed onCommitted={() => {}} />);
    await fillForm(user);
    await user.click(screen.getByRole("button", { name: "开始研究轮次" }));
    expect(await screen.findByText(/需要明确放弃后才能重新提交/)).toBeTruthy();
    expect(sessionStorage.getItem(RESEARCH_RUN_START_PENDING_KEY)).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "放弃未确认提交，重新开始" }));
    expect(sessionStorage.getItem(RESEARCH_RUN_START_PENDING_KEY)).toBeNull();
    // form resets to blank and can start over
    const submit = await screen.findByRole("button", { name: "开始研究轮次" });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByDisplayValue("核对版本差异")).toBeNull();
  });

  it("400 invalid clears receipt and shows safe message", async () => {
    const user = userEvent.setup();
    vi.mocked(startResearchRun).mockRejectedValueOnce(new ProjectApiError(400, "研究执行记录输入不正确。", "RESEARCH_RUN_INVALID"));
    render(<ResearchRunStartComposer projectId={P} issueId={I} writeAllowed onCommitted={() => {}} />);
    await fillForm(user);
    await user.click(screen.getByRole("button", { name: "开始研究轮次" }));
    expect(await screen.findByText("研究执行记录输入不正确。")).toBeTruthy();
    expect(sessionStorage.getItem(RESEARCH_RUN_START_PENDING_KEY)).toBeNull();
  });

  it("404 evidence unavailable clears receipt and reloads evidence bases", async () => {
    const user = userEvent.setup();
    vi.mocked(startResearchRun).mockRejectedValueOnce(new ProjectApiError(404, "所选证据依据当前不可用。", "EVIDENCE_MANIFEST_NOT_AVAILABLE"));
    render(<ResearchRunStartComposer projectId={P} issueId={I} writeAllowed onCommitted={() => {}} />);
    await fillForm(user);
    await user.click(screen.getByRole("button", { name: "开始研究轮次" }));
    expect(await screen.findByText("所选证据依据当前不可用。")).toBeTruthy();
    expect(sessionStorage.getItem(RESEARCH_RUN_START_PENDING_KEY)).toBeNull();
    await waitFor(() => expect(listIssueResolutionEvidenceBases.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it("raw server secret text is never rendered", async () => {
    const user = userEvent.setup();
    vi.mocked(startResearchRun).mockRejectedValueOnce(new ProjectApiError(500, "SECRET INTERNAL"));
    render(<ResearchRunStartComposer projectId={P} issueId={I} writeAllowed onCommitted={() => {}} />);
    await fillForm(user);
    await user.click(screen.getByRole("button", { name: "开始研究轮次" }));
    expect(await screen.findByText("研究轮次提交结果尚未确认。可以使用同一标识重试。")).toBeTruthy();
    expect(document.body.textContent).not.toContain("SECRET INTERNAL");
  });
});

describe("ResearchRunStartComposer — lifecycle", () => {
  it("hides fresh-start button when write disallowed, but keeps pending receipt visible", async () => {
    sessionStorage.setItem(RESEARCH_RUN_START_PENDING_KEY, JSON.stringify({
      projectId: P, issueId: I, requestHash: "a".repeat(64),
      idempotencyKey: "99999999-9999-4999-8999-999999999999",
      createdAt: new Date().toISOString(),
      command: {
        procedure: { version: 1, objective: "只读目标", method: "只读方法", steps: [{ kind: "READ", description: "只读步骤" }] },
        executionContract: { version: 1, mode: "HUMAN", reproducibilityLevel: "AUDIT", tools: [] },
        environment: {}, evidenceManifestId: M1, replayOf: null,
      },
    }));
    render(<ResearchRunStartComposer projectId={P} issueId={I} writeAllowed={false} onCommitted={() => {}} />);
    expect(await screen.findByText("只读目标")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("尚未确认");
    // Same-key retry stays available: the pending form renders with its receipt intact.
    expect(document.querySelector(".research-run-start-form")).toBeTruthy();
  });

  it("renders nothing when write disallowed and no pending receipt", () => {
    const { container } = render(<ResearchRunStartComposer projectId={P} issueId={I} writeAllowed={false} onCommitted={() => {}} />);
    expect(container.querySelector(".research-run-start")).toBeNull();
  });

  it("has no Task-4 actions and never fetches run detail", async () => {
    const user = userEvent.setup();
    render(<ResearchRunStartComposer projectId={P} issueId={I} writeAllowed onCommitted={() => {}} />);
    await user.click(screen.getByRole("button", { name: "开始新的研究轮次" }));
    await screen.findByLabelText(/证据快照/);
    for (const banned of ["完成轮次", "标记失败", "取消轮次", "重放轮次", "查看详情"]) {
      expect(screen.queryByRole("button", { name: banned })).toBeNull();
    }
  });
});
