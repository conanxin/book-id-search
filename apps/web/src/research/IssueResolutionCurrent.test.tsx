// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { listIssueResolutions } from "./api";
import { IssueResolutionCurrent } from "./IssueResolutionCurrent";

vi.mock("./api", async load => ({
  ...await load<typeof import("./api")>(),
  listIssueResolutions: vi.fn(),
}));

const P = "11111111-1111-4111-8111-111111111111";
const I = "22222222-2222-4222-8222-222222222222";
const R1 = "33333333-3333-4333-8333-333333333333";
const R2 = "44444444-4444-4444-8444-444444444444";

beforeEach(() => {
  vi.mocked(listIssueResolutions).mockReset();
});
afterEach(() => cleanup());

describe("IssueResolutionCurrent", () => {
  it("uses authoritative currentResolution instead of the newest history row", async () => {
    vi.mocked(listIssueResolutions).mockResolvedValue({
      issue: { id: I, lifecycleState: "OPEN", currentResolutionId: R1, updatedAt: "2026-09-20T01:00:00.000Z" },
      currentResolution: {
        id: R1, issueId: I, resolutionType: "INSUFFICIENT_EVIDENCE", preferredClaimId: null,
        rationaleExcerpt: "权威当前结论", createdAt: "2026-09-20T00:00:00.000Z",
        isCurrent: true, evidenceBasisAvailable: false, evidenceManifest: null,
      },
      resolutions: [{
        id: R2, issueId: I, resolutionType: "NO_WORKING_CONCLUSION", preferredClaimId: null,
        rationaleExcerpt: "更新但不是当前", createdAt: "2026-09-21T00:00:00.000Z",
        isCurrent: false, evidenceBasisAvailable: false, evidenceManifest: null,
      }],
      nextCursor: null,
    });
    render(<IssueResolutionCurrent token="t" projectId={P} issueId={I} refreshVersion={0} />);
    expect(await screen.findByText("权威当前结论")).toBeTruthy();
    expect(screen.queryByText("更新但不是当前")).toBeNull();
    expect(listIssueResolutions).toHaveBeenCalledWith("t", P, I, { limit: 1 }, expect.any(AbortSignal));
  });

  it("renders an explicit empty current state", async () => {
    vi.mocked(listIssueResolutions).mockResolvedValue({
      issue: { id: I, lifecycleState: "OPEN", currentResolutionId: null, updatedAt: "2026-09-20T01:00:00.000Z" },
      currentResolution: null,
      resolutions: [],
      nextCursor: null,
    });
    render(<IssueResolutionCurrent token="t" projectId={P} issueId={I} refreshVersion={0} />);
    expect(await screen.findByText("尚未形成当前工作结论。")).toBeTruthy();
  });

  it("offers a safe retry when the read is unavailable", async () => {
    vi.mocked(listIssueResolutions)
      .mockRejectedValueOnce(new Error("secret"))
      .mockResolvedValueOnce({
        issue: { id: I, lifecycleState: "OPEN", currentResolutionId: null, updatedAt: "2026-09-20T01:00:00.000Z" },
        currentResolution: null, resolutions: [], nextCursor: null,
      });
    render(<IssueResolutionCurrent token="t" projectId={P} issueId={I} refreshVersion={0} />);
    expect(await screen.findByText("当前工作结论暂时无法加载。")).toBeTruthy();
    expect(document.body.textContent).not.toContain("secret");
    await userEvent.click(screen.getByRole("button", { name: "重试当前工作结论" }));
    expect(await screen.findByText("尚未形成当前工作结论。")).toBeTruthy();
  });
});
