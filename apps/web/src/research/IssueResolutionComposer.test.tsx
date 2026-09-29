// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  createIssueResolution,
  listCandidateClaims,
  listIssueResolutionEvidenceBases,
  listIssueResolutions,
  ProjectApiError,
} from "./api";
import { IssueResolutionComposer } from "./IssueResolutionComposer";
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
import {
  clearPendingIssueResolutionReceipt,
  getOrCreateIssueResolutionReceipt,
  loadPendingIssueResolutionReceipt,
  resetPendingIssueResolutionReceiptMemoryForTest,
} from "./issue-resolution-draft";

vi.mock("./api", async load => ({
  ...await load<typeof import("./api")>(),
  createIssueResolution: vi.fn(),
  listCandidateClaims: vi.fn(),
  listIssueResolutionEvidenceBases: vi.fn(),
  listIssueResolutions: vi.fn(),
}));

const P = "11111111-1111-4111-8111-111111111111";
const I = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const M = "44444444-4444-4444-8444-444444444444";
const R = "55555555-5555-4555-8555-555555555555";
const A = "66666666-6666-4666-8666-666666666666";

const project = { id: P, name: "研究项目", lifecycleState: "ACTIVE" as const, readOnly: false };
const issue = { id: I, projectId: P, title: "问题", question: "为什么？", lifecycleState: "OPEN" as const, createdAt: "2026-09-20T00:00:00Z", updatedAt: "2026-09-20T01:00:00Z" };
const claim = { id: C, statement: "可能答案 A", lifecycleState: "ACTIVE" as const, createdAt: "2026-09-20T00:00:00Z", updatedAt: "2026-09-20T00:00:00Z" };

beforeEach(() => { seedSession();
  vi.resetAllMocks();
  sessionStorage.clear();
  resetPendingIssueResolutionReceiptMemoryForTest();
  clearPendingIssueResolutionReceipt();
  resetPendingIssueResolutionReceiptMemoryForTest();
  vi.mocked(listIssueResolutions).mockResolvedValue({
    issue: { id: I, lifecycleState: "OPEN", currentResolutionId: null, updatedAt: "2026-09-20T01:00:00.000Z" },
    currentResolution: null,
    resolutions: [],
    nextCursor: null,
  });
  vi.mocked(listCandidateClaims).mockResolvedValue({ claims: [claim] });
  vi.mocked(listIssueResolutionEvidenceBases).mockResolvedValue({
    issueId: I,
    evidenceBases: [{
      assessmentId: A,
      claimId: C,
      claimStatementExcerpt: "可能答案 A",
      stance: "SUPPORTS",
      confidenceLevel: "HIGH",
      manifestId: M,
      manifestSha256: "a".repeat(64),
      itemCount: 2,
      assessmentCreatedAt: "2026-09-20T00:00:00.000Z",
    }],
    nextCursor: null,
  });
  vi.mocked(createIssueResolution).mockResolvedValue({ status: "created", resolutionId: R });
});
afterEach(() => { __resetWebAuthStoreForTests();
  cleanup();
  vi.restoreAllMocks();
});

function show(overrides: Partial<React.ComponentProps<typeof IssueResolutionComposer>> = {}) {
  return render(<IssueResolutionComposer project={project} issue={issue} {...overrides} />);
}

async function readyPreferred() {
  await screen.findByRole("heading", { name: "形成工作结论" });
  await waitFor(() => expect(listIssueResolutions).toHaveBeenCalledOnce());
  await userEvent.click(screen.getByRole("radio", { name: "采用一个可能答案" }));
  await userEvent.selectOptions(screen.getByLabelText("首选可能答案"), C);
  await userEvent.type(screen.getByLabelText("结论理由"), "现有证据最支持这个解释。");
}

describe("Issue Resolution Composer", () => {
  it("uses the authoritative current pointer and supports preferred Claim + optional evidence basis", async () => {
    vi.mocked(listIssueResolutions).mockResolvedValue({
      issue: { id: I, lifecycleState: "RESOLVED", currentResolutionId: R, updatedAt: "2026-09-20T01:00:00.000Z" },
      currentResolution: null,
      resolutions: [],
      nextCursor: null,
    });
    show();
    await readyPreferred();
    await userEvent.selectOptions(screen.getByLabelText("证据依据（可选）"), M);
    await userEvent.click(screen.getByRole("button", { name: "提交工作结论" }));
    await screen.findByText("工作结论已成功提交。");
    const call = vi.mocked(createIssueResolution).mock.calls[0];
    expect(call[3]).toEqual({
      expectedCurrentResolutionId: R,
      resolutionType: "PREFERRED_CLAIM",
      preferredClaimId: C,
      rationale: "现有证据最支持这个解释。",
      evidenceManifestId: M,
    });
    expect(loadPendingIssueResolutionReceipt()).toBeNull();
  });

  it.each([
    ["证据不足", "INSUFFICIENT_EVIDENCE"],
    ["暂不形成工作结论", "NO_WORKING_CONCLUSION"],
  ] as const)("submits %s without a preferred Claim", async (label, resolutionType) => {
    show();
    await waitFor(() => {
      expect(listIssueResolutions).toHaveBeenCalledOnce();
      expect(listCandidateClaims).toHaveBeenCalledOnce();
      expect(listIssueResolutionEvidenceBases).toHaveBeenCalledOnce();
    });
    await userEvent.click(screen.getByRole("radio", { name: label }));
    await userEvent.type(screen.getByLabelText("结论理由"), "目前不选择任何候选。");
    await userEvent.click(screen.getByRole("button", { name: "提交工作结论" }));
    await screen.findByText("工作结论已成功提交。");
    expect(vi.mocked(createIssueResolution).mock.calls[0][3]).toMatchObject({
      resolutionType,
      preferredClaimId: null,
    });
  });

  it("freezes unknown result and retries the exact same key/body", async () => {
    vi.mocked(createIssueResolution)
      .mockRejectedValueOnce(new TypeError("network"))
      .mockResolvedValueOnce({ status: "replayed", resolutionId: R });
    show();
    await readyPreferred();
    await userEvent.click(screen.getByRole("button", { name: "提交工作结论" }));
    const retry = await screen.findByRole("button", { name: "使用同一标识重试" });
    expect((screen.getByLabelText("结论理由") as HTMLTextAreaElement).disabled).toBe(true);
    expect(loadPendingIssueResolutionReceipt()).not.toBeNull();
    await userEvent.click(retry);
    await screen.findByText("此工作结论此前已经成功提交。");
    const calls = vi.mocked(createIssueResolution).mock.calls;
    expect(calls[1][2]).toBe(calls[0][2]);
    expect(calls[1][3]).toEqual(calls[0][3]);
  });

  it("restores a matching pending receipt and retries without silently rotating its key", async () => {
    const receipt = await getOrCreateIssueResolutionReceipt({ projectId: P, issueId: I }, {
      expectedCurrentResolutionId: null,
      resolutionType: "INSUFFICIENT_EVIDENCE",
      preferredClaimId: null,
      rationale: "冻结的理由。",
      evidenceManifestId: null,
    });
    resetPendingIssueResolutionReceiptMemoryForTest();
    show();
    expect(await screen.findByText("工作结论提交结果尚未确认。")).toBeTruthy();
    expect((screen.getByLabelText("结论理由") as HTMLTextAreaElement).value).toBe("冻结的理由。");
    await userEvent.click(screen.getByRole("button", { name: "使用同一标识重试" }));
    expect(vi.mocked(createIssueResolution).mock.calls[0][2]).toBe(receipt.idempotencyKey);
    expect(vi.mocked(createIssueResolution).mock.calls[0][3]).toEqual(receipt.command);
  });

  it.each([
    [400, "ISSUE_RESOLUTION_INVALID"],
    [404, "PROJECT_OR_ISSUE_NOT_FOUND"],
    [404, "PREFERRED_CLAIM_NOT_AVAILABLE"],
    [404, "EVIDENCE_MANIFEST_NOT_AVAILABLE"],
    [409, "PROJECT_READ_ONLY"],
    [409, "RESEARCH_ISSUE_READ_ONLY"],
  ] as const)("clears pending receipt on definite rejection %s %s", async (status, code) => {
    vi.mocked(createIssueResolution).mockRejectedValueOnce(
      new ProjectApiError(status, "明确拒绝", code),
    );
    show();
    await readyPreferred();
    await userEvent.click(screen.getByRole("button", { name: "提交工作结论" }));
    expect(await screen.findByText("明确拒绝")).toBeTruthy();
    expect(loadPendingIssueResolutionReceipt()).toBeNull();
  });

  it("clears stale receipt and refreshes authoritative pointer before another submit", async () => {
    vi.mocked(createIssueResolution).mockRejectedValueOnce(
      new ProjectApiError(409, "stale", "ISSUE_RESOLUTION_STALE"),
    );
    show();
    await readyPreferred();
    await userEvent.click(screen.getByRole("button", { name: "提交工作结论" }));
    expect(await screen.findByText("当前工作结论已变化，已刷新提交基线。请确认后重新提交。")).toBeTruthy();
    expect(loadPendingIssueResolutionReceipt()).toBeNull();
    await waitFor(() => expect(listIssueResolutions).toHaveBeenCalledTimes(2));
  });

  it("keeps an unknown pending command retryable even when option loading later fails", async () => {
    const receipt = await getOrCreateIssueResolutionReceipt({ projectId: P, issueId: I }, {
      expectedCurrentResolutionId: null,
      resolutionType: "PREFERRED_CLAIM",
      preferredClaimId: C,
      rationale: "冻结。",
      evidenceManifestId: M,
    });
    resetPendingIssueResolutionReceiptMemoryForTest();
    vi.mocked(listCandidateClaims).mockRejectedValue(new Error("down"));
    show();
    expect(await screen.findByText("工作结论提交结果尚未确认。")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "使用同一标识重试" }));
    expect(vi.mocked(createIssueResolution).mock.calls[0][2]).toBe(receipt.idempotencyKey);
  });

  it("is hidden for new writes when project or issue is archived", () => {
    const first = render(<IssueResolutionComposer project={{ ...project, readOnly: true, lifecycleState: "ARCHIVED" }} issue={issue} />);
    expect(screen.queryByRole("heading", { name: "形成工作结论" })).toBeNull();
    first.unmount();
    render(<IssueResolutionComposer project={project} issue={{ ...issue, lifecycleState: "ARCHIVED" }} />);
    expect(screen.queryByRole("heading", { name: "形成工作结论" })).toBeNull();
  });
});
