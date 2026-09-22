// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AssessmentHistory } from "./AssessmentHistory";
import {
  listAssessments,
  ProjectApiError,
  type AssessmentHistoryResponse,
  type AssessmentSummary,
} from "./api";

vi.mock("./api", async load => ({
  ...await load<typeof import("./api")>(),
  listAssessments: vi.fn(),
}));

const P = "11111111-1111-4111-8111-111111111111";
const I = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const A1 = "44444444-4444-4444-8444-444444444444";
const A2 = "55555555-5555-4555-8555-555555555555";
const claim = { id: C, statement: "Candidate A", lifecycleState: "ACTIVE" as const };

const summary = (id = A1, excerpt: string | null = "第一组影像支持该判断。"): AssessmentSummary => ({
  id,
  stance: "SUPPORTS",
  confidenceLevel: "HIGH",
  actorId: null,
  numericScore: null,
  scoreKind: null,
  reasoningExcerpt: excerpt,
  createdAt: id === A1 ? "2026-09-21T10:00:00.000Z" : "2026-09-20T10:00:00.000Z",
  evidenceManifest: {
    id: id === A1
      ? "66666666-6666-4666-8666-666666666666"
      : "77777777-7777-4777-8777-777777777777",
    schemaVersion: 1,
    purpose: "CLAIM_ASSESSMENT",
    manifestSha256: (id === A1 ? "a" : "b").repeat(64),
    itemCount: id === A1 ? 3 : 2,
  },
});

const response = (
  assessments: AssessmentSummary[],
  nextCursor: string | null = null,
): AssessmentHistoryResponse => ({ claim, assessments, nextCursor });

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(listAssessments).mockResolvedValue(response([]));
});
afterEach(cleanup);

function show(overrides: Partial<React.ComponentProps<typeof AssessmentHistory>> = {}) {
  const props = {
    token: "t",
    projectId: P,
    issueId: I,
    claimId: C,
    refreshVersion: 0,
    onIntegrityBlocked: vi.fn(),
    onOpenDetail: vi.fn(),
    ...overrides,
  };
  return { props, view: render(<AssessmentHistory {...props} />) };
}

describe("assessment history", () => {
  it("uses privacy-safe empty copy without claiming global absence", async () => {
    show();
    expect(await screen.findByText("当前没有可显示的评价记录。")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/从未评价|没有任何评价/);
  });

  it("labels only the newest visible row as 最近一次评价 and opens detail", async () => {
    vi.mocked(listAssessments).mockResolvedValue(response([summary(A1), summary(A2)]));
    const { props } = show();
    expect(await screen.findByText("最近一次评价")).toBeTruthy();
    expect(screen.getByText("SUPPORTS · HIGH")).toBeTruthy();
    expect(screen.getByText("3 条证据")).toBeTruthy();
    expect(screen.getByText("第一组影像支持该判断。")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/current|final|preferred|真相/i);
    const buttons = screen.getAllByRole("button", { name: "查看完整评价" });
    await userEvent.click(buttons[0]);
    expect(props.onOpenDetail).toHaveBeenCalledWith(A1);
  });

  it("keeps loaded rows when loading an older page fails", async () => {
    vi.mocked(listAssessments)
      .mockResolvedValueOnce(response([summary(A1)], "cursor-1"))
      .mockRejectedValueOnce(new ProjectApiError(503, "暂不可用", "ASSESSMENT_STORE_UNAVAILABLE"));
    show();
    await screen.findByText("第一组影像支持该判断。");
    await userEvent.click(screen.getByRole("button", { name: "加载更早评价" }));
    expect(await screen.findByText("更早的评价暂时无法加载。")).toBeTruthy();
    expect(screen.getByText("第一组影像支持该判断。")).toBeTruthy();
    expect(screen.getByRole("button", { name: "重试加载更早评价" })).toBeTruthy();
  });

  it("preserves loaded rows and offers explicit reload after invalid cursor", async () => {
    vi.mocked(listAssessments)
      .mockResolvedValueOnce(response([summary(A1)], "cursor-1"))
      .mockRejectedValueOnce(new ProjectApiError(400, "游标无效", "ASSESSMENT_CURSOR_INVALID"));
    show();
    await screen.findByText("第一组影像支持该判断。");
    await userEvent.click(screen.getByRole("button", { name: "加载更早评价" }));
    expect(await screen.findByRole("button", { name: "重新加载评价历史" })).toBeTruthy();
    expect(screen.getByText("第一组影像支持该判断。")).toBeTruthy();
  });

  it("reports integrity failure to the claim card but ordinary 503 only degrades locally", async () => {
    const onIntegrityBlocked = vi.fn();
    vi.mocked(listAssessments).mockRejectedValueOnce(new ProjectApiError(500, "integrity"));
    const first = show({ onIntegrityBlocked });
    expect(await screen.findByText("评价历史存在数据完整性问题。")).toBeTruthy();
    await waitFor(() => expect(onIntegrityBlocked).toHaveBeenLastCalledWith(true));
    first.view.unmount();

    vi.mocked(listAssessments).mockRejectedValueOnce(new ProjectApiError(503, "unavailable"));
    show({ onIntegrityBlocked });
    expect(await screen.findByText("评价历史暂时无法加载。")).toBeTruthy();
    expect(onIntegrityBlocked).toHaveBeenLastCalledWith(false);
  });
});
