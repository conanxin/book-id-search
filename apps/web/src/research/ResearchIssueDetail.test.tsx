// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import {
  getResearchIssue,
  listCandidateClaims,
  listIssueResolutionEvidenceBases,
  listIssueResolutions,
  ProjectApiError,
} from "./api";
import { ResearchIssueDetail } from "./ResearchIssueDetail";

vi.mock("./api", async (load) => ({
  ...(await load<typeof import("./api")>()),
  getResearchIssue: vi.fn(),
  listCandidateClaims: vi.fn(),
  listIssueResolutionEvidenceBases: vi.fn(),
  listIssueResolutions: vi.fn(),
}));
const projectId = "11111111-1111-4111-8111-111111111111";
const issueId = "22222222-2222-4222-8222-222222222222";
const project = { id: projectId, name: "北京古道研究", lifecycleState: "ACTIVE" as const, readOnly: false };
const issue = { id: issueId, projectId, title: "刘祥店迁出时间", question: "第一行\n第二行 <script>x</script>", lifecycleState: "OPEN" as const, createdAt: "2026-09-20T00:00:00Z", updatedAt: "2026-09-20T01:00:00Z" };

beforeEach(() => {
  vi.mocked(getResearchIssue).mockReset().mockResolvedValue({ project, issue });
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
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("Research Issue detail", () => {
  it("loads dedicated Issue detail and keeps Resolution views at Issue level", async () => {
    const { container } = render(<MemoryRouter><ResearchIssueDetail token="token" projectId={projectId} issueId={issueId} /></MemoryRouter>);
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
    expect(current && claims && composer && history).toBeTruthy();
    expect(current!.compareDocumentPosition(claims!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(claims!.compareDocumentPosition(composer!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(composer!.compareDocumentPosition(history!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    expect(screen.getByRole("link", { name: /北京古道研究/ }).getAttribute("href")).toBe(`/research/projects/${projectId}`);
    await waitFor(() => expect(document.title).toBe(`${issue.title} · BOOK-ID-SEARCH`));
  });

  it("keeps archived details readable", async () => {
    vi.mocked(getResearchIssue).mockResolvedValue({ project: { ...project, lifecycleState: "ARCHIVED", readOnly: true }, issue });
    render(<MemoryRouter><ResearchIssueDetail token="token" projectId={projectId} issueId={issueId} /></MemoryRouter>);
    expect(await screen.findByText("已归档 · 只读")).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "当前工作结论" })).toBeTruthy();
  });

  it.each([
    [404, "研究问题不存在，或不属于当前项目。"],
    [500, "研究问题暂不可用。"],
    [503, "研究问题暂不可用。"],
  ])("shows safe retryable error for %s", async (status, copy) => {
    vi.mocked(getResearchIssue).mockRejectedValueOnce(new ProjectApiError(status, "SECRET OWNER")).mockResolvedValueOnce({ project, issue });
    render(<MemoryRouter><ResearchIssueDetail token="token" projectId={projectId} issueId={issueId} /></MemoryRouter>);
    expect(await screen.findByText(copy)).toBeTruthy();
    expect(document.body.textContent).not.toContain("SECRET OWNER");
    await userEvent.click(screen.getByRole("button", { name: "重试研究问题" }));
    await waitFor(() => expect(getResearchIssue).toHaveBeenCalledTimes(2));
  });
});

it("keeps Issue visible and retries Claims independently", async () => {
 vi.mocked(listCandidateClaims).mockRejectedValueOnce(new ProjectApiError(503,"SECRET")).mockResolvedValueOnce({claims:[]});
 render(<MemoryRouter><ResearchIssueDetail token="t" projectId={projectId} issueId={issueId}/></MemoryRouter>);
 expect(await screen.findByRole("heading",{name:issue.title})).toBeTruthy();
 expect(await screen.findByText("可能答案暂不可用。")).toBeTruthy();
 expect(document.body.textContent).not.toContain("SECRET");
 await userEvent.click(screen.getByRole("button",{name:"重试可能答案"}));
 expect(await screen.findByText("还没有可能答案。")).toBeTruthy();
 expect(getResearchIssue).toHaveBeenCalledOnce();
});
