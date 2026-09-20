// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { saveS32Token } from "./access";
import { getResearchMemberships, ProjectApiError, type ResearchMembership } from "./api";
import { ResearchMembershipChips, useSearchMemberships } from "./SearchMemberships";

vi.mock("./api", async importOriginal => ({
  ...await importOriginal<typeof import("./api")>(),
  getResearchMemberships: vi.fn(),
}));

const membership = (index: number, lifecycle: "ACTIVE" | "ARCHIVED" = "ACTIVE"): ResearchMembership => ({
  projectId: `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`,
  projectName: `项目${index}`,
  projectLifecycleState: lifecycle,
  bindingId: `22222222-2222-4222-8222-${String(index).padStart(12, "0")}`,
  hasNote: index % 2 === 0,
  noteUpdatedAt: null,
});

function Harness({ bookIds }: { bookIds: string[] }) {
  const result = useSearchMemberships(bookIds);
  return <>
    <output data-testid="state">{result.state}</output>
    <output data-testid="memberships">{JSON.stringify(result.memberships)}</output>
    <button type="button" onClick={result.refresh}>refresh</button>
  </>;
}

beforeEach(() => {
  vi.clearAllMocks();
  saveS32Token("token");
  vi.mocked(getResearchMemberships).mockResolvedValue({ memberships: {} });
});
afterEach(() => { cleanup(); saveS32Token(null); });

describe("useSearchMemberships", () => {
  it("does not request without a token", async () => {
    saveS32Token(null);
    render(<Harness bookIds={["book-a"]} />);
    expect(screen.getByTestId("state").textContent).toBe("no-token");
    expect(getResearchMemberships).not.toHaveBeenCalled();
  });

  it("runs one batch for ordered unique current-page IDs", async () => {
    vi.mocked(getResearchMemberships).mockResolvedValue({ memberships: { "book-a": [], "book-b": [] } });
    render(<Harness bookIds={["book-a", "book-a", "book-b"]} />);
    await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("ready"));
    expect(getResearchMemberships).toHaveBeenCalledOnce();
    expect(getResearchMemberships).toHaveBeenCalledWith("token", ["book-a", "book-b"], expect.any(AbortSignal));
  });

  it("aborts a changed result request and ignores its late response", async () => {
    let resolveOld!: (value: { memberships: Record<string, ResearchMembership[]> }) => void;
    vi.mocked(getResearchMemberships)
      .mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve; }))
      .mockResolvedValueOnce({ memberships: { "book-b": [membership(2)] } });
    const view = render(<Harness bookIds={["book-a"]} />);
    const oldSignal = vi.mocked(getResearchMemberships).mock.calls[0][2]!;
    view.rerender(<Harness bookIds={["book-b"]} />);
    expect(oldSignal.aborted).toBe(true);
    await waitFor(() => expect(screen.getByTestId("memberships").textContent).toContain("项目2"));
    await act(async () => resolveOld({ memberships: { "book-a": [membership(1)] } }));
    expect(screen.getByTestId("memberships").textContent).not.toContain("项目1");
  });

  it("aborts on token change and uses the new token", async () => {
    vi.mocked(getResearchMemberships).mockReturnValue(new Promise(() => {}));
    render(<Harness bookIds={["book-a"]} />);
    const oldSignal = vi.mocked(getResearchMemberships).mock.calls[0][2]!;
    act(() => saveS32Token("next-token"));
    await waitFor(() => expect(getResearchMemberships).toHaveBeenCalledTimes(2));
    expect(oldSignal.aborted).toBe(true);
    expect(getResearchMemberships).toHaveBeenLastCalledWith("next-token", ["book-a"], expect.any(AbortSignal));
  });

  it.each([401, 403])("maps %s to auth-error", async status => {
    vi.mocked(getResearchMemberships).mockRejectedValue(new ProjectApiError(status, "denied"));
    render(<Harness bookIds={["book-a"]} />);
    await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("auth-error"));
    expect(screen.getByTestId("memberships").textContent).toBe("{}");
  });

  it.each([500, 502, 503])("maps %s to unavailable without inventing empty truth", async status => {
    vi.mocked(getResearchMemberships).mockRejectedValue(new ProjectApiError(status, "failed"));
    render(<Harness bookIds={["book-a"]} />);
    await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("unavailable"));
    expect(screen.getByTestId("memberships").textContent).toBe("{}");
  });

  it("refreshes the current page in one batch", async () => {
    vi.mocked(getResearchMemberships).mockResolvedValue({ memberships: { "book-a": [] } });
    render(<Harness bookIds={["book-a", "book-a"]} />);
    await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("ready"));
    await userEvent.click(screen.getByRole("button", { name: "refresh" }));
    await waitFor(() => expect(getResearchMemberships).toHaveBeenCalledTimes(2));
    expect(getResearchMemberships).toHaveBeenLastCalledWith("token", ["book-a"], expect.any(AbortSignal));
  });
});

describe("ResearchMembershipChips", () => {
  it("links ACTIVE and ARCHIVED chips to the exact binding deep link", () => {
    render(<MemoryRouter><ResearchMembershipChips state="ready" memberships={[membership(1), membership(2, "ARCHIVED")]} /></MemoryRouter>);
    expect(screen.getByText("已在研究")).toBeTruthy();
    expect(screen.getByText("曾用于研究")).toBeTruthy();
    expect(screen.getByRole("link", { name: "项目1" }).getAttribute("href")).toBe(`/research/projects/${membership(1).projectId}?item=${encodeURIComponent(membership(1).bindingId)}`);
    expect(screen.getByRole("link", { name: "项目2" }).getAttribute("href")).toBe(`/research/projects/${membership(2).projectId}?item=${encodeURIComponent(membership(2).bindingId)}`);
  });

  it("shows two ACTIVE and one ARCHIVED chip before explicit expansion", async () => {
    render(<MemoryRouter><ResearchMembershipChips state="ready" memberships={[
      membership(1), membership(2), membership(3), membership(4, "ARCHIVED"), membership(5, "ARCHIVED"),
    ]} /></MemoryRouter>);
    expect(screen.getByRole("link", { name: "项目1" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "项目2" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "项目3" })).toBeNull();
    expect(screen.getByRole("link", { name: "项目4" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "项目5" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "展开其余 2 个项目" }));
    expect(screen.getByRole("link", { name: "项目3" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "项目5" })).toBeTruthy();
  });

  it.each([
    ["loading", "正在确认研究状态…"],
    ["auth-error", "研究项目访问凭据已失效，请重新设置。"],
    ["unavailable", "研究状态暂不可用"],
  ] as const)("renders the %s degraded state", (state, copy) => {
    render(<MemoryRouter><ResearchMembershipChips state={state} memberships={[]} /></MemoryRouter>);
    expect(screen.getByText(copy)).toBeTruthy();
  });

  it("renders no membership status without a token", () => {
    const { container } = render(<MemoryRouter><ResearchMembershipChips state="no-token" memberships={[]} /></MemoryRouter>);
    expect(container.textContent).toBe("");
  });
});
