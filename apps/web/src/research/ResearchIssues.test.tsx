// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { ProjectApiError, createResearchIssue, listResearchIssues } from "./api";
import { ResearchIssuesSection, useProjectResearchIssues } from "./ResearchIssues";
import { clearPendingResearchIssueReceipt, loadPendingResearchIssueReceipt } from "./research-issue-draft";

vi.mock("./api", async (load) => ({ ...(await load<typeof import("./api")>()), createResearchIssue: vi.fn(), listResearchIssues: vi.fn() }));
const projectId = "11111111-1111-4111-8111-111111111111";
const issueId = "22222222-2222-4222-8222-222222222222";
const project = { id: projectId, name: "北京古道研究", lifecycleState: "ACTIVE" as const, readOnly: false };
const issue = { id: issueId, projectId, title: "刘祥店迁出时间", question: "完整问题", lifecycleState: "OPEN" as const, createdAt: "2026-09-20T00:00:00Z", updatedAt: "2026-09-20T01:00:00Z" };
const summaries = [
  { id: issueId, projectId, title: issue.title, questionExcerpt: "<script>证据</script>", lifecycleState: "OPEN" as const, createdAt: issue.createdAt, updatedAt: issue.updatedAt },
  { id: "33333333-3333-4333-8333-333333333333", projectId, title: "已解决", questionExcerpt: "摘要", lifecycleState: "RESOLVED" as const, createdAt: issue.createdAt, updatedAt: issue.updatedAt },
  { id: "44444444-4444-4444-8444-444444444444", projectId, title: "已归档", questionExcerpt: "摘要", lifecycleState: "ARCHIVED" as const, createdAt: issue.createdAt, updatedAt: issue.updatedAt },
];

beforeEach(() => {
  vi.resetAllMocks();
  sessionStorage.clear(); clearPendingResearchIssueReceipt();
  vi.mocked(listResearchIssues).mockResolvedValue({ project, issues: summaries });
  vi.mocked(createResearchIssue).mockResolvedValue({ project, issue });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

function Location() { return <span data-testid="location">{useLocation().pathname}</span>; }
function mount(response = { project, issues: summaries }) {
  return render(<MemoryRouter><ResearchIssuesSection token="token" projectId={projectId} result={{ state: "ready", response, error: "" }} retry={vi.fn()} /><Location /></MemoryRouter>);
}

describe("Research Issues UI", () => {
  it("preserves server order, renders plain text, and hides create for archived projects", () => {
    const { container, rerender } = mount();
    expect(screen.getAllByRole("heading", { level: 3 }).map((node) => node.textContent)).toEqual(["刘祥店迁出时间", "已解决", "已归档"]);
    expect(container.textContent).toContain("<script>证据</script>");
    expect(container.querySelector("script")).toBeNull();
    expect(screen.getByRole("button", { name: "新建研究问题" })).toBeTruthy();
    rerender(<MemoryRouter><ResearchIssuesSection token="token" projectId={projectId} result={{ state: "ready", response: { project: { ...project, lifecycleState: "ARCHIVED", readOnly: true }, issues: summaries }, error: "" }} retry={vi.fn()} /></MemoryRouter>);
    expect(screen.queryByRole("button", { name: "新建研究问题" })).toBeNull();
  });

  it("distinguishes confirmed empty from unavailable and retries only Issues", async () => {
    const retry = vi.fn();
    const { rerender } = render(<MemoryRouter><ResearchIssuesSection token="t" projectId={projectId} result={{ state: "ready", response: { project, issues: [] }, error: "" }} retry={retry} /></MemoryRouter>);
    expect(screen.getByText("还没有研究问题")).toBeTruthy();
    rerender(<MemoryRouter><ResearchIssuesSection token="t" projectId={projectId} result={{ state: "unavailable", response: null, error: "研究问题暂不可用。" }} retry={retry} /></MemoryRouter>);
    expect(screen.queryByText("还没有研究问题")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "重试研究问题" }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it("creates once, clears the receipt, and navigates to exact detail", async () => {
    mount();
    await userEvent.click(screen.getByRole("button", { name: "新建研究问题" }));
    await userEvent.type(screen.getByLabelText("问题标题"), " 刘祥店迁出时间 ");
    await userEvent.type(screen.getByRole("textbox", { name: "研究问题" }), " 完整问题 ");
    await userEvent.dblClick(screen.getByRole("button", { name: "创建研究问题" }));
    await waitFor(() => expect(createResearchIssue).toHaveBeenCalledOnce());
    expect(vi.mocked(createResearchIssue).mock.calls[0][4]).toBeInstanceOf(AbortSignal);
    expect((await screen.findByTestId("location")).textContent).toBe(`/research/projects/${projectId}/issues/${issueId}`);
    expect(loadPendingResearchIssueReceipt()).toBeNull();
  });

  it("keeps an outcome-unknown receipt and reuses its key on unchanged retry", async () => {
    vi.mocked(createResearchIssue).mockRejectedValueOnce(new ProjectApiError(503, "暂不可用")).mockResolvedValueOnce({ project, issue });
    mount();
    await userEvent.click(screen.getByRole("button", { name: "新建研究问题" }));
    await userEvent.type(screen.getByLabelText("问题标题"), "标题");
    await userEvent.type(screen.getByRole("textbox", { name: "研究问题" }), "问题");
    await userEvent.click(screen.getByRole("button", { name: "创建研究问题" }));
    expect(await screen.findByText(/结果尚未确认/)).toBeTruthy();
    const titleInput = screen.getByLabelText("问题标题") as HTMLInputElement;
    const questionInput = screen.getByRole("textbox", { name: "研究问题" }) as HTMLTextAreaElement;
    expect(titleInput.disabled).toBe(true);
    expect(questionInput.disabled).toBe(true);
    await userEvent.type(titleInput, "changed");
    await userEvent.type(questionInput, "changed");
    expect(titleInput.value).toBe("标题");
    expect(questionInput.value).toBe("问题");
    const firstKey = vi.mocked(createResearchIssue).mock.calls[0][2];
    expect(loadPendingResearchIssueReceipt()?.idempotencyKey).toBe(firstKey);
    await userEvent.click(screen.getByRole("button", { name: "使用同一标识重试" }));
    await waitFor(() => expect(createResearchIssue).toHaveBeenCalledTimes(2));
    expect(vi.mocked(createResearchIssue).mock.calls[1][2]).toBe(firstKey);
    expect(vi.mocked(createResearchIssue).mock.calls[1][3]).toEqual(vi.mocked(createResearchIssue).mock.calls[0][3]);
  });

  it("requires an explicit new submission after idempotency conflict", async () => {
    vi.mocked(createResearchIssue).mockRejectedValueOnce(new ProjectApiError(409, "冲突", "IDEMPOTENCY_CONFLICT")).mockResolvedValueOnce({ project, issue });
    mount();
    await userEvent.click(screen.getByRole("button", { name: "新建研究问题" }));
    await userEvent.type(screen.getByLabelText("问题标题"), "标题");
    await userEvent.type(screen.getByRole("textbox", { name: "研究问题" }), "问题");
    await userEvent.click(screen.getByRole("button", { name: "创建研究问题" }));
    const firstKey = vi.mocked(createResearchIssue).mock.calls[0][2];
    expect(await screen.findByText(/创建请求标识/)).toBeTruthy();
    expect(createResearchIssue).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole("button", { name: "作为新的研究问题重新提交" }));
    await waitFor(() => expect(createResearchIssue).toHaveBeenCalledTimes(2));
    expect(vi.mocked(createResearchIssue).mock.calls[1][2]).not.toBe(firstKey);
  });
});

describe("useProjectResearchIssues", () => {
  function Probe({ token = "token", id = projectId }: { token?: string; id?: string }) {
    const { result, retry } = useProjectResearchIssues(token, id);
    return <><span>{result.state}</span><button onClick={retry}>retry</button></>;
  }
  it("loads once, treats failures as unavailable, and retries exactly once", async () => {
    vi.mocked(listResearchIssues).mockRejectedValueOnce(new ProjectApiError(503, "down")).mockResolvedValueOnce({ project, issues: [] });
    render(<Probe />);
    expect(await screen.findByText("unavailable")).toBeTruthy();
    expect(listResearchIssues).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole("button", { name: "retry" }));
    expect(await screen.findByText("ready")).toBeTruthy();
    expect(listResearchIssues).toHaveBeenCalledTimes(2);
  });
});
