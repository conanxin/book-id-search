// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AssessmentDetail } from "./AssessmentDetail";
import {
  getAssessment,
  ProjectApiError,
  type AssessmentDetailResponse,
} from "./api";

vi.mock("./api", async load => ({
  ...await load<typeof import("./api")>(),
  getAssessment: vi.fn(),
}));

const P = "11111111-1111-4111-8111-111111111111";
const I = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const A = "44444444-4444-4444-8444-444444444444";
const M = "55555555-5555-4555-8555-555555555555";
const SOURCE = "66666666-6666-4666-8666-666666666666";
const REV = "77777777-7777-4777-8777-777777777777";

const detail: AssessmentDetailResponse = {
  claim: { id: C, statement: "Candidate A", lifecycleState: "ACTIVE" },
  assessment: {
    id: A,
    claimId: C,
    stance: "SUPPORTS",
    confidenceLevel: "HIGH",
    actorId: null,
    numericScore: null,
    scoreKind: null,
    reasoning: "第一行\n第二行",
    createdAt: "2026-09-21T10:00:00.000Z",
  },
  evidenceManifest: {
    id: M,
    schemaVersion: 1,
    purpose: "CLAIM_ASSESSMENT",
    manifestSha256: "a".repeat(64),
    createdAt: "2026-09-21T10:00:00.000Z",
    items: [
      {
        ordinal: 1,
        role: "SUPPORTING",
        targetType: "SOURCE",
        targetId: SOURCE,
        locatorType: null,
        locator: null,
        excerpt: null,
        note: "来源支持",
      },
      {
        ordinal: 2,
        role: "CONTEXTUAL",
        targetType: "NOTE_REVISION",
        targetId: REV,
        locatorType: null,
        locator: null,
        excerpt: null,
        note: null,
      },
    ],
  },
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getAssessment).mockResolvedValue(detail);
});
afterEach(cleanup);

function show(overrides: Partial<React.ComponentProps<typeof AssessmentDetail>> = {}) {
  const props = {
    token: "t",
    projectId: P,
    issueId: I,
    claimId: C,
    assessmentId: A,
    onClose: vi.fn(),
    onRefreshHistory: vi.fn(),
    ...overrides,
  };
  return { props, view: render(<AssessmentDetail {...props} />) };
}

describe("assessment detail", () => {
  it("renders full reasoning and frozen evidence audit data", async () => {
    show();
    expect(await screen.findByText("完整评价")).toBeTruthy();
    expect(screen.getByText(/第一行/)).toBeTruthy();
    expect(screen.getByText(/第二行/)).toBeTruthy();
    expect(screen.getByText("SHA-256")).toBeTruthy();
    expect(screen.getByText("a".repeat(64))).toBeTruthy();
    expect(screen.getByText("SUPPORTING · SOURCE")).toBeTruthy();
    expect(screen.getByText("CONTEXTUAL · NOTE_REVISION")).toBeTruthy();
    expect(screen.getByText("来源支持")).toBeTruthy();
  });

  it("shows 未记录判断理由 for schema-valid null reasoning", async () => {
    vi.mocked(getAssessment).mockResolvedValue({
      ...detail,
      assessment: { ...detail.assessment, reasoning: null },
    });
    show();
    expect(await screen.findByText("未记录判断理由")).toBeTruthy();
  });

  it("safe 404 stays neutral, refreshes history, and does not disclose ownership", async () => {
    vi.mocked(getAssessment).mockRejectedValue(
      new ProjectApiError(404, "该评价当前不可用。", "ASSESSMENT_NOT_FOUND"),
    );
    const { props } = show();
    expect(await screen.findByText("该评价当前不可用。")).toBeTruthy();
    expect(props.onRefreshHistory).toHaveBeenCalled();
    expect(document.body.textContent).not.toMatch(/权限|其他项目|另一个项目/);
  });

  it.each([
    new ProjectApiError(500, "integrity"),
    new ProjectApiError(503, "unavailable"),
  ])("keeps the failure local and allows retry %#", async error => {
    vi.mocked(getAssessment).mockRejectedValueOnce(error).mockResolvedValueOnce(detail);
    show();
    expect(await screen.findByText("完整评价暂时无法加载。")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "重试完整评价" }));
    expect(await screen.findByText("第一行", { exact: false })).toBeTruthy();
  });
});
