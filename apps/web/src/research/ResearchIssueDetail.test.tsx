// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import {
  getResearchIssue,
  getResearchRun,
  listCandidateClaims,
  listIssueResolutionEvidenceBases,
  listIssueResolutions,
  listResearchRuns,
  startResearchRun,
  ProjectApiError,
} from "./api";
import { ResearchIssueDetail } from "./ResearchIssueDetail";

vi.mock("../auth/session", async importOriginal => {
  const actual = await importOriginal<typeof import("../auth/session")>();
  return { ...actual, ensureAuthSessionLoaded: vi.fn(async () => {}) };
});
import { __resetWebAuthStoreForTests, __setWebAuthSnapshotForTests } from "../auth/session";
function seedSession(status: "authenticated" | "unauthenticated" = "authenticated"): void {
  __setWebAuthSnapshotForTests(status === "authenticated"
    ? { status: "authenticated", user: { email: "owner@example.com", name: "Owner" }, csrfToken: "csrf-test", error: null }
    : { status: "unauthenticated", user: null, csrfToken: null, error: null });
}
vi.mock("./api", async (load) => ({
  ...(await load<typeof import("./api")>()),
  getResearchIssue: vi.fn(),
  getResearchRun: vi.fn(),
  listCandidateClaims: vi.fn(),
  listIssueResolutionEvidenceBases: vi.fn(),
  listIssueResolutions: vi.fn(),
  listResearchRuns: vi.fn(),
  startResearchRun: vi.fn(),
}));
const projectId = "11111111-1111-4111-8111-111111111111";
const issueId = "22222222-2222-4222-8222-222222222222";
const project = { id: projectId, name: "北京古道研究", lifecycleState: "ACTIVE" as const, readOnly: false };
const issue = { id: issueId, projectId, title: "刘祥店迁出时间", question: "第一行\n第二行 <script>x</script>", lifecycleState: "OPEN" as const, createdAt: "2026-09-20T00:00:00Z", updatedAt: "2026-09-20T01:00:00Z" };

beforeEach(() => { seedSession();
  vi.mocked(getResearchIssue).mockReset().mockResolvedValue({ project, issue });
  vi.mocked(getResearchRun).mockReset();
  vi.mocked(listIssueResolutionEvidenceBases).mockReset().mockResolvedValue({ issueId, evidenceBases: [], nextCursor: null });
  vi.mocked(listCandidateClaims).mockReset().mockResolvedValue({ claims: [] });
  vi.mocked(listIssueResolutionEvidenceBases).mockReset().mockResolvedValue({
    issueId,
    evidenceBases: [],
    nextCursor: null,
  });
  vi.mocked(listIssueResolutions).mockReset().mockResolvedValue({
    issue: {
      id: issueId,
      lifecycleState: "OPEN",
      currentResolutionId: null,
      updatedAt: "2026-09-20T01:00:00.000Z",
    },
    currentResolution: null,
    resolutions: [],
    nextCursor: null,
  });
  vi.mocked(listResearchRuns).mockReset().mockResolvedValue({ runs: [], nextCursor: null });
  vi.mocked(startResearchRun).mockReset();
});
afterEach(() => { __resetWebAuthStoreForTests(); cleanup(); vi.clearAllMocks(); });

describe("Research Issue detail", () => {
  it("loads dedicated Issue detail and keeps Resolution views at Issue level", { timeout: 30000 }, async () => {
    const { container } = render(<MemoryRouter><ResearchIssueDetail projectId={projectId} issueId={issueId} /></MemoryRouter>);
    expect(screen.getByRole("status").textContent).toContain("正在读取研究问题");
    expect(await screen.findByRole("heading", { name: issue.title })).toBeTruthy();
    expect(getResearchIssue).toHaveBeenCalledOnce();
    expect(container.querySelector(".research-issue-question")?.textContent).toBe(issue.question);
    expect(container.querySelector("script")).toBeNull();
    expect(await screen.findByText("尚未形成当前工作结论。")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "可能答案" })).toBeTruthy();
    expect(await screen.findByText("还没有可能答案。")).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "形成工作结论" })).toBeTruthy();
    expect(await screen.findByText("还没有工作结论历史。")).toBeTruthy();

    const current = container.querySelector(".issue-resolution-current");
    const claims = container.querySelector(".research-candidate-claims");
    const composer = container.querySelector(".issue-resolution-composer");
    const history = container.querySelector(".issue-resolution-history");
    const startComposer = container.querySelector(".research-run-start");
    const runs = container.querySelector(".research-run-history");
    const back = screen.getByRole("link", { name: "返回项目资料" });
    expect(current && claims && composer && history && startComposer && runs).toBeTruthy();
    expect(current!.compareDocumentPosition(claims!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(claims!.compareDocumentPosition(composer!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(composer!.compareDocumentPosition(history!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(history!.compareDocumentPosition(startComposer!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(startComposer!.compareDocumentPosition(runs!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(runs!.compareDocumentPosition(back) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(await screen.findByText("还没有研究轮次。")).toBeTruthy();
    const firstCall = listResearchRuns.mock.calls[0];
    expect(firstCall?.[0]).toBe(projectId);
    expect(firstCall?.[1]).toBe(issueId);
    expect(firstCall?.[2]).toEqual({ limit: 20 });

    expect(screen.getByRole("link", { name: /北京古道研究/ }).getAttribute("href")).toBe(`/research/projects/${projectId}`);
    await waitFor(() => expect(document.title).toBe(`${issue.title} · BOOK-ID-SEARCH`));
  });

  it("keeps archived details readable", async () => {
    vi.mocked(getResearchIssue).mockResolvedValue({ project: { ...project, lifecycleState: "ARCHIVED", readOnly: true }, issue });
    render(<MemoryRouter><ResearchIssueDetail projectId={projectId} issueId={issueId} /></MemoryRouter>);
    expect(await screen.findByText("已归档 · 只读")).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "当前工作结论" })).toBeTruthy();
  });

  it.each([
    [404, "研究问题不存在，或不属于当前项目。"],
    [500, "研究问题暂不可用。"],
    [503, "研究问题暂不可用。"],
  ])("shows safe retryable error for %s", async (status, copy) => {
    vi.mocked(getResearchIssue).mockRejectedValueOnce(new ProjectApiError(status, "SECRET OWNER")).mockResolvedValueOnce({ project, issue });
    render(<MemoryRouter><ResearchIssueDetail projectId={projectId} issueId={issueId} /></MemoryRouter>);
    expect(await screen.findByText(copy)).toBeTruthy();
    expect(document.body.textContent).not.toContain("SECRET OWNER");
    await userEvent.click(screen.getByRole("button", { name: "重试研究问题" }));
    await waitFor(() => expect(getResearchIssue).toHaveBeenCalledTimes(2));
  });
});

it("keeps Issue visible and retries Claims independently", async () => {
 vi.mocked(listCandidateClaims).mockRejectedValueOnce(new ProjectApiError(503,"SECRET")).mockResolvedValueOnce({claims:[]});
 render(<MemoryRouter><ResearchIssueDetail projectId={projectId} issueId={issueId}/></MemoryRouter>);
 expect(await screen.findByRole("heading",{name:issue.title})).toBeTruthy();
 expect(await screen.findByText("可能答案暂不可用。")).toBeTruthy();
 expect(document.body.textContent).not.toContain("SECRET");
 await userEvent.click(screen.getByRole("button",{name:"重试可能答案"}));
 expect(await screen.findByText("还没有可能答案。")).toBeTruthy();
 expect(getResearchIssue).toHaveBeenCalledOnce();
});

describe("Research Issue detail — ResearchRun history integration (Gate 3 Task 2)", () => {
  it("still mounts and reads ResearchRun history on archived Project/Issue", async () => {
    vi.mocked(getResearchIssue).mockResolvedValue({ project: { ...project, lifecycleState: "ARCHIVED", readOnly: true }, issue: { ...issue, lifecycleState: "ARCHIVED" } });
    render(<MemoryRouter><ResearchIssueDetail projectId={projectId} issueId={issueId} /></MemoryRouter>);
    expect(await screen.findByRole("heading", { name: "研究轮次" })).toBeTruthy();
    await waitFor(() => expect(listResearchRuns.mock.calls[0]?.[2]).toEqual({ limit: 20 }));
  });

  it("ResearchRun history failure does NOT hide Issue, Claims or Resolution sections", async () => {
    vi.mocked(listResearchRuns).mockRejectedValueOnce(new ProjectApiError(503, "SECRET RUN DETAIL"));
    render(<MemoryRouter><ResearchIssueDetail projectId={projectId} issueId={issueId} /></MemoryRouter>);
    expect(await screen.findByRole("heading", { name: issue.title })).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "可能答案" })).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "工作结论历史" })).toBeTruthy();
    expect(await screen.findByText("研究轮次暂时无法加载。")).toBeTruthy();
    expect(document.body.textContent).not.toContain("SECRET RUN DETAIL");
    await userEvent.click(screen.getByRole("button", { name: "重试研究轮次" }));
    await waitFor(() => expect(listResearchRuns).toHaveBeenCalledTimes(2));
  });

  it("offers fresh START (Task 3) but no Task-4 lifecycle actions and never fetches run detail", async () => {
    vi.mocked(listResearchRuns).mockResolvedValue({ runs: [], nextCursor: null });
    render(<MemoryRouter><ResearchIssueDetail projectId={projectId} issueId={issueId} /></MemoryRouter>);
    expect(await screen.findByRole("button", { name: "开始新的研究轮次" })).toBeTruthy();
    for (const banned of ["完成轮次", "标记失败", "取消轮次", "重放轮次", "查看详情"]) {
      expect(screen.queryByRole("button", { name: banned })).toBeNull();
    }
    expect(getResearchRun).not.toHaveBeenCalled();
  });
});

describe("Research Issue detail — ResearchRun start composer integration (Gate 3 Task 3)", () => {
  it("archived page keeps History but shows no fresh-start action", async () => {
    vi.mocked(getResearchIssue).mockResolvedValue({ project: { ...project, lifecycleState: "ARCHIVED", readOnly: true }, issue: { ...issue, lifecycleState: "ARCHIVED" } });
    render(<MemoryRouter><ResearchIssueDetail projectId={projectId} issueId={issueId} /></MemoryRouter>);
    expect(await screen.findByRole("heading", { name: "研究轮次" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "开始新的研究轮次" })).toBeNull();
  });

  it("successful START increments runVersion and re-fetches History", async () => {
    const runId = "33333333-3333-4333-8333-333333333333";
    const manifestId = "77777777-7777-4777-8777-777777777777";
    vi.mocked(listIssueResolutionEvidenceBases).mockResolvedValue({
      issueId,
      evidenceBases: [{
        assessmentId: "a1111111-1111-4111-8111-111111111111",
        claimId: "c1111111-1111-4111-8111-111111111111",
        claimStatementExcerpt: "刘祥店",
        stance: "SUPPORTS" as const,
        confidenceLevel: null,
        manifestId,
        manifestSha256: "a".repeat(64),
        itemCount: 1,
        assessmentCreatedAt: "2026-09-20T00:00:00Z",
      }],
      nextCursor: null,
    });
    vi.mocked(listResearchRuns)
      .mockResolvedValueOnce({ runs: [], nextCursor: null })
      .mockResolvedValueOnce({ runs: [], nextCursor: null });
    vi.mocked(startResearchRun).mockResolvedValue({ status: "created", runId });

    render(<MemoryRouter><ResearchIssueDetail projectId={projectId} issueId={issueId} /></MemoryRouter>);
    await screen.findByRole("heading", { name: "研究轮次" });
    await waitFor(() => expect(listResearchRuns).toHaveBeenCalledTimes(1));

    const user = (await import("@testing-library/user-event")).default.setup();
    await user.click(screen.getByRole("button", { name: "开始新的研究轮次" }));
    await screen.findByLabelText(/证据快照/);
    await user.selectOptions(screen.getByLabelText(/证据快照/), manifestId);
    await user.type(screen.getByLabelText("研究目标"), "目标");
    await user.type(screen.getByLabelText("研究方法"), "方法");
    await user.type(screen.getByLabelText("步骤 1 描述"), "步骤");
    await user.click(document.querySelector('input[value="HUMAN"]')!);
    await user.click(document.querySelector('input[value="AUDIT"]')!);
    await user.click(screen.getByRole("button", { name: "开始研究轮次" }));
    expect(await screen.findByText("研究轮次已开始。")).toBeTruthy();
    await waitFor(() => expect(listResearchRuns).toHaveBeenCalledTimes(2));
  });
});
