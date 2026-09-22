// @vitest-environment jsdom
// PR18 review finding 3 regression: after the server answers 409
// EVIDENCE_PREVIEW_STALE, the previously visible preview hash ("尚未提交。"
// + SHA-256) must disappear from the real EvidenceEditor DOM, while the
// selected evidence and judgment fields stay usable. This test intentionally
// does NOT mock EvidenceEditor: it exercises the CandidateClaims +
// EvidenceEditor + AssessmentComposer wiring.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CandidateClaims } from "./CandidateClaims";
import {
  createAssessment,
  listAssessments,
  listCandidateClaims,
  listEvidenceCandidates,
  previewEvidenceManifest,
  ProjectApiError,
  type ResearchIssue,
  type ResearchIssueProjectContext,
} from "./api";
import { clearPendingCandidateClaimReceipt } from "./candidate-claim-draft";
import { clearPendingAssessmentReceipt } from "./assessment-draft";

vi.mock("./api", async load => ({
  ...await load<typeof import("./api")>(),
  listCandidateClaims: vi.fn(),
  createAssessment: vi.fn(),
  listAssessments: vi.fn(),
  listEvidenceCandidates: vi.fn(),
  previewEvidenceManifest: vi.fn(),
}));

const project: ResearchIssueProjectContext = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Project",
  lifecycleState: "ACTIVE",
  readOnly: false,
};
const issue: ResearchIssue = {
  id: "22222222-2222-4222-8222-222222222222",
  projectId: project.id,
  title: "Question",
  question: "When?",
  lifecycleState: "OPEN",
  createdAt: "2026-09-21T00:00:00.000Z",
  updatedAt: "2026-09-21T00:00:00.000Z",
};
const claim = {
  id: "33333333-3333-4333-8333-333333333333",
  statement: "Candidate A",
  lifecycleState: "ACTIVE" as const,
  createdAt: issue.createdAt,
  updatedAt: issue.updatedAt,
};
const sourceCandidate = {
  targetType: "SOURCE" as const,
  targetId: "66666666-6666-4666-8666-666666666666",
  materialBindingId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  materialTitle: "北京古道志",
  sourceType: "DATABASE_RECORD" as const,
  sourceLifecycleState: "ACTIVE" as const,
  observedAt: "2026-09-21T00:00:00.000Z",
};
const emptyHistory = {
  claim: { id: claim.id, statement: claim.statement, lifecycleState: "ACTIVE" as const },
  assessments: [] as never[],
  nextCursor: null,
};
const previewResponse = {
  claim: { id: claim.id, statement: claim.statement },
  draft: {
    schemaVersion: 1 as const,
    purpose: "CLAIM_ASSESSMENT" as const,
    manifestSha256: "a".repeat(64),
    items: [{
      ordinal: 1,
      role: "SUPPORTING" as const,
      targetType: "SOURCE" as const,
      targetId: sourceCandidate.targetId,
      locatorType: null,
      locator: null,
      excerpt: null,
      note: null,
    }],
  },
  persisted: false as const,
};

beforeEach(() => {
  vi.resetAllMocks();
  clearPendingCandidateClaimReceipt();
  clearPendingAssessmentReceipt();
  vi.mocked(listCandidateClaims).mockResolvedValue({ claims: [claim] });
  vi.mocked(listAssessments).mockResolvedValue(emptyHistory);
  vi.mocked(listEvidenceCandidates).mockResolvedValue({
    claim: { ...claim },
    candidates: [sourceCandidate],
  });
  vi.mocked(previewEvidenceManifest).mockResolvedValue(previewResponse);
});
afterEach(cleanup);

function show() {
  return render(<CandidateClaims token="t" project={project} issue={issue} />);
}

async function buildPreview() {
  await screen.findByText("Candidate A");
  await userEvent.click(screen.getByRole("button", { name: "构建证据集" }));
  const addSupporting = await screen.findByRole("button", { name: "作为支持证据" });
  await userEvent.click(addSupporting);
  await userEvent.click(screen.getByRole("button", { name: "预览 EvidenceManifest" }));
  expect(await screen.findByText("尚未提交。")).toBeTruthy();
  const sha = await screen.findByText(/^a{64}$/);
  expect(sha).toBeTruthy();
}

it("409 stale clears the visible old hash/preview while keeping selected evidence and judgment fields", async () => {
  vi.mocked(createAssessment).mockRejectedValueOnce(
    new ProjectApiError(409, "证据预览已过期，请重新预览。", "EVIDENCE_PREVIEW_STALE"),
  );
  show();
  await buildPreview();

  await userEvent.click(screen.getByLabelText("支持"));
  await userEvent.type(screen.getByLabelText("判断理由"), "当前证据支持。");
  await userEvent.click(screen.getByRole("button", { name: "提交评价" }));

  // The composer drops the pending receipt and the parent handoff on stale.
  await waitFor(() => expect(screen.queryByRole("heading", { name: "评价这个 Claim" })).toBeNull());

  // The old preview hash must be gone from the real EvidenceEditor DOM
  // (internal reset lands one effect tick after the composer unmounts).
  await waitFor(() => expect(screen.queryByText("尚未提交。")).toBeNull());
  expect(screen.queryByText(/^a{64}$/)).toBeNull();

  // Selected evidence must remain (已选), not reset.
  expect(screen.getByText("已选")).toBeTruthy();

  // Re-preview works and restores a current hash.
  await userEvent.click(screen.getByRole("button", { name: "预览 EvidenceManifest" }));
  expect(await screen.findByText("尚未提交。")).toBeTruthy();
  expect(screen.getByText(/^a{64}$/)).toBeTruthy();

  // Judgment fields are preserved after re-preview (composer not remounted).
  expect((screen.getByLabelText("支持") as HTMLInputElement).checked).toBe(true);
  expect((screen.getByLabelText("判断理由") as HTMLTextAreaElement).value).toBe("当前证据支持。");
});

it("keeps the same selected evidence after stale rejection so a retry commit can succeed", async () => {
  vi.mocked(createAssessment)
    .mockRejectedValueOnce(new ProjectApiError(409, "证据预览已过期，请重新预览。", "EVIDENCE_PREVIEW_STALE"))
    .mockResolvedValueOnce({
      status: "created",
      visible: true,
      assessment: {
        id: "44444444-4444-4444-8444-444444444444",
        claimId: claim.id,
        stance: "SUPPORTS",
        confidenceLevel: null,
        actorId: null,
        numericScore: null,
        scoreKind: null,
        reasoning: "当前证据支持。",
        createdAt: "2026-09-21T10:00:00.000Z",
      },
      evidenceManifest: {
        id: "55555555-5555-4555-8555-555555555555",
        schemaVersion: 1,
        purpose: "CLAIM_ASSESSMENT",
        manifestSha256: "a".repeat(64),
        itemCount: 1,
      },
    });
  show();
  await buildPreview();

  await userEvent.click(screen.getByLabelText("支持"));
  await userEvent.type(screen.getByLabelText("判断理由"), "当前证据支持。");
  await userEvent.click(screen.getByRole("button", { name: "提交评价" }));
  await waitFor(() => expect(screen.queryByRole("heading", { name: "评价这个 Claim" })).toBeNull());
  await waitFor(() => expect(screen.queryByText("尚未提交。")).toBeNull());

  // Re-preview from preserved evidence, then commit succeeds.
  await userEvent.click(screen.getByRole("button", { name: "预览 EvidenceManifest" }));
  expect(await screen.findByText("尚未提交。")).toBeTruthy();
  await userEvent.click(screen.getByLabelText("支持"));
  await userEvent.click(screen.getByRole("button", { name: "提交评价" }));
  expect(await screen.findByText("评价已成功提交。")).toBeTruthy();
  expect(createAssessment).toHaveBeenCalledTimes(2);
});
