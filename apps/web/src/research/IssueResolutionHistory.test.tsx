// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { listIssueResolutions } from "./api";
import { IssueResolutionHistory } from "./IssueResolutionHistory";

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
beforeEach(() => { seedSession(); });
vi.mock("./api", async load => ({
  ...await load<typeof import("./api")>(),
  listIssueResolutions: vi.fn(),
}));

const P = "11111111-1111-4111-8111-111111111111";
const I = "22222222-2222-4222-8222-222222222222";
const R1 = "33333333-3333-4333-8333-333333333333";
const R2 = "44444444-4444-4444-8444-444444444444";

const summary = (id: string, rationaleExcerpt: string, isCurrent: boolean) => ({
  id, issueId: I, resolutionType: "INSUFFICIENT_EVIDENCE" as const, preferredClaimId: null,
  rationaleExcerpt, createdAt: isCurrent ? "2026-09-21T00:00:00.000Z" : "2026-09-20T00:00:00.000Z",
  isCurrent, evidenceBasisAvailable: false, evidenceManifest: null,
});

beforeEach(() => vi.mocked(listIssueResolutions).mockReset());
afterEach(() => cleanup());

describe("IssueResolutionHistory", () => {
  it("keeps current marking based on server summaries and appends older pages", async () => {
    vi.mocked(listIssueResolutions)
      .mockResolvedValueOnce({
        issue: { id: I, lifecycleState: "OPEN", currentResolutionId: R2, updatedAt: "2026-09-21T00:00:00.000Z" },
        currentResolution: summary(R2, "当前", true),
        resolutions: [summary(R2, "当前", true)],
        nextCursor: "older",
      })
      .mockResolvedValueOnce({
        issue: { id: I, lifecycleState: "OPEN", currentResolutionId: R2, updatedAt: "2026-09-21T00:00:00.000Z" },
        currentResolution: summary(R2, "当前", true),
        resolutions: [summary(R1, "更早", false)],
        nextCursor: null,
      });
    render(<IssueResolutionHistory projectId={P} issueId={I} refreshVersion={0} />);
    expect(await screen.findByText("当前")).toBeTruthy();
    expect(screen.getByText("CURRENT")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "加载更早工作结论" }));
    expect(await screen.findByText("更早")).toBeTruthy();
    await waitFor(() => expect(listIssueResolutions).toHaveBeenCalledTimes(2));
    expect(vi.mocked(listIssueResolutions).mock.calls[1][2]).toEqual({ limit: 20, cursor: "older" });
  });

  it("rebinds prior page current markers when a later page reports an advanced pointer", async () => {
    vi.mocked(listIssueResolutions)
      .mockResolvedValueOnce({
        issue: { id: I, lifecycleState: "OPEN", currentResolutionId: R2, updatedAt: "2026-09-21T00:00:00.000Z" },
        currentResolution: summary(R2, "原当前", true),
        resolutions: [summary(R2, "原当前", true)],
        nextCursor: "older",
      })
      .mockResolvedValueOnce({
        issue: { id: I, lifecycleState: "OPEN", currentResolutionId: R1, updatedAt: "2026-09-22T00:00:00.000Z" },
        currentResolution: summary(R1, "新当前", true),
        resolutions: [summary(R1, "新当前", true)],
        nextCursor: null,
      });
    render(<IssueResolutionHistory projectId={P} issueId={I} refreshVersion={0} />);
    expect(await screen.findByText("原当前")).toBeTruthy();
    expect(screen.getAllByText("CURRENT")).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "加载更早工作结论" }));
    expect(await screen.findByText("新当前")).toBeTruthy();
    expect(screen.getAllByText("CURRENT")).toHaveLength(1);
    expect(screen.getByText("新当前").closest("li")?.textContent).toContain("CURRENT");
    expect(screen.getByText("原当前").closest("li")?.textContent).not.toContain("CURRENT");
  });

  it("keeps initial history failure isolated and retryable", async () => {
    vi.mocked(listIssueResolutions)
      .mockRejectedValueOnce(new Error("private"))
      .mockResolvedValueOnce({
        issue: { id: I, lifecycleState: "OPEN", currentResolutionId: null, updatedAt: "2026-09-20T00:00:00.000Z" },
        currentResolution: null, resolutions: [], nextCursor: null,
      });
    render(<IssueResolutionHistory projectId={P} issueId={I} refreshVersion={0} />);
    expect(await screen.findByText("工作结论历史暂时无法加载。")).toBeTruthy();
    expect(document.body.textContent).not.toContain("private");
    await userEvent.click(screen.getByRole("button", { name: "重试工作结论历史" }));
    expect(await screen.findByText("还没有工作结论历史。")).toBeTruthy();
  });
});
