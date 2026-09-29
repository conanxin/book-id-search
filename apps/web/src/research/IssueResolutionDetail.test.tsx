// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getIssueResolution, ProjectApiError } from "./api";
import { IssueResolutionDetail } from "./IssueResolutionDetail";

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
  getIssueResolution: vi.fn(),
}));

const P = "11111111-1111-4111-8111-111111111111";
const I = "22222222-2222-4222-8222-222222222222";
const R = "33333333-3333-4333-8333-333333333333";

beforeEach(() => vi.mocked(getIssueResolution).mockReset());
afterEach(() => cleanup());

describe("IssueResolutionDetail", () => {
  it("renders full rationale while keeping unavailable evidence separate", async () => {
    vi.mocked(getIssueResolution).mockResolvedValue({
      issue: { id: I, lifecycleState: "OPEN", currentResolutionId: R, updatedAt: "2026-09-20T01:00:00.000Z" },
      resolution: {
        id: R, issueId: I, resolutionType: "NO_WORKING_CONCLUSION", preferredClaimId: null,
        rationale: "完整理由\n第二行", createdAt: "2026-09-20T00:00:00.000Z", isCurrent: true,
      },
      evidenceBasisAvailable: false,
      evidenceManifest: null,
    });
    render(<IssueResolutionDetail projectId={P} issueId={I} resolutionId={R} onClose={() => {}} />);
    expect(await screen.findByText(/完整理由/)).toBeTruthy();
    expect(screen.getByText("未指定证据依据，或该证据当前不可访问。")).toBeTruthy();
    expect(screen.getByText(/当前结论/)).toBeTruthy();
  });

  it("does not expose server detail on a missing Resolution", async () => {
    vi.mocked(getIssueResolution).mockRejectedValueOnce(new ProjectApiError(404, "SECRET"));
    render(<IssueResolutionDetail projectId={P} issueId={I} resolutionId={R} onClose={() => {}} />);
    expect(await screen.findByText("该工作结论当前不可用。")).toBeTruthy();
    expect(document.body.textContent).not.toContain("SECRET");
  });

  it("lets the user close the detail", async () => {
    const onClose = vi.fn();
    vi.mocked(getIssueResolution).mockRejectedValueOnce(new Error("down"));
    render(<IssueResolutionDetail projectId={P} issueId={I} resolutionId={R} onClose={onClose} />);
    await userEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
