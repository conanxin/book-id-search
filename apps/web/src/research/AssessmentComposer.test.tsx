// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AssessmentComposer } from "./AssessmentComposer";
import {
  ProjectApiError,
  createAssessment,
  type AssessmentCreateResponse,
} from "./api";
import {
  clearPendingAssessmentReceipt,
  getOrCreateAssessmentReceipt,
  loadPendingAssessmentReceipt,
  resetPendingAssessmentReceiptMemoryForTest,
} from "./assessment-draft";
import type { CurrentEvidencePreview } from "./EvidenceEditor";

vi.mock("./api", async load => ({
  ...await load<typeof import("./api")>(),
  createAssessment: vi.fn(),
}));

const P = "11111111-1111-4111-8111-111111111111";
const I = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const A = "44444444-4444-4444-8444-444444444444";
const M = "55555555-5555-4555-8555-555555555555";
const SOURCE = "66666666-6666-4666-8666-666666666666";

const PREVIEW: CurrentEvidencePreview = {
  draftVersion: 1,
  manifestSha256: "a".repeat(64),
  items: [{
    role: "SUPPORTING",
    targetType: "SOURCE",
    targetId: SOURCE,
    note: null,
  }],
};

const CREATED: AssessmentCreateResponse = {
  status: "created",
  visible: true,
  assessment: {
    id: A,
    claimId: C,
    stance: "SUPPORTS",
    confidenceLevel: null,
    actorId: null,
    numericScore: null,
    scoreKind: null,
    reasoning: "当前证据支持。",
    createdAt: "2026-09-21T00:00:00.000Z",
  },
  evidenceManifest: {
    id: M,
    schemaVersion: 1,
    purpose: "CLAIM_ASSESSMENT",
    manifestSha256: PREVIEW.manifestSha256,
    itemCount: 1,
  },
};

beforeEach(() => {
  vi.resetAllMocks();
  sessionStorage.clear();
  resetPendingAssessmentReceiptMemoryForTest();
  clearPendingAssessmentReceipt();
  resetPendingAssessmentReceiptMemoryForTest();
  vi.mocked(createAssessment).mockResolvedValue(CREATED);
});
afterEach(cleanup);

function show(overrides: Partial<React.ComponentProps<typeof AssessmentComposer>> = {}) {
  const props: React.ComponentProps<typeof AssessmentComposer> = {
    token: "t",
    projectId: P,
    issueId: I,
    claimId: C,
    preview: PREVIEW,
    writeAllowed: true,
    integrityBlocked: false,
    onCommitted: vi.fn(),
    onNeedsEvidenceRefresh: vi.fn(),
    onPreviewInvalidated: vi.fn(),
    ...overrides,
  };
  return { ...render(<AssessmentComposer {...props} />), props };
}

async function fillReady() {
  await userEvent.click(screen.getByRole("radio", { name: "支持" }));
  await userEvent.type(screen.getByLabelText("判断理由"), "当前证据支持。");
}

describe("submit gate", () => {
  it("requires current preview + stance + valid reasoning, but confidence is optional", async () => {
    show();
    const submit = screen.getByRole("button", { name: "提交评价" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    await userEvent.click(screen.getByRole("radio", { name: "支持" }));
    expect(submit.disabled).toBe(true);
    await userEvent.type(screen.getByLabelText("判断理由"), "当前证据支持。");
    expect(submit.disabled).toBe(false);
    expect((screen.getByLabelText("信心") as HTMLSelectElement).value).toBe("");
  });

  it("assessment field changes do not invalidate the evidence preview", async () => {
    const onPreviewInvalidated = vi.fn();
    show({ onPreviewInvalidated });
    await fillReady();
    await userEvent.selectOptions(screen.getByLabelText("信心"), "HIGH");
    await userEvent.clear(screen.getByLabelText("判断理由"));
    await userEvent.type(screen.getByLabelText("判断理由"), "新的判断。");
    expect(onPreviewInvalidated).not.toHaveBeenCalled();
  });

  it("does not expose a new-submit form without a preview or when integrity is blocked", () => {
    const first = show({ preview: null });
    expect(screen.queryByRole("button", { name: "提交评价" })).toBeNull();
    first.unmount();
    show({ integrityBlocked: true });
    expect((screen.getByRole("button", { name: "提交评价" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("评价历史存在数据完整性问题，暂时不能提交新的评价。")).toBeTruthy();
  });
});

describe("pending committed intent", () => {
  it.each([
    new TypeError("network"),
    new ProjectApiError(503, "评价服务暂不可用。", "ASSESSMENT_STORE_UNAVAILABLE"),
  ])("freezes the command and retries the exact same key/body after %#", async error => {
    vi.mocked(createAssessment).mockRejectedValueOnce(error).mockResolvedValueOnce(CREATED);
    show();
    await fillReady();
    await userEvent.click(screen.getByRole("button", { name: "提交评价" }));
    const retry = await screen.findByRole("button", { name: "使用同一标识重试" });
    expect((screen.getByLabelText("判断理由") as HTMLTextAreaElement).disabled).toBe(true);
    expect(loadPendingAssessmentReceipt()).not.toBeNull();

    await userEvent.click(retry);
    const calls = vi.mocked(createAssessment).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[1][4]).toBe(calls[0][4]);
    expect(calls[1][5]).toEqual(calls[0][5]);
  });

  it("restores a matching pending command on reload and can retry without a current preview", async () => {
    const receipt = await getOrCreateAssessmentReceipt({ projectId: P, issueId: I, claimId: C }, {
      stance: "SUPPORTS",
      confidenceLevel: "MEDIUM",
      reasoning: "冻结的判断。",
      expectedManifestSha256: PREVIEW.manifestSha256,
      items: PREVIEW.items,
    });
    resetPendingAssessmentReceiptMemoryForTest();
    show({ preview: null });
    expect(await screen.findByText("评价提交结果尚未确认。")).toBeTruthy();
    expect((screen.getByLabelText("判断理由") as HTMLTextAreaElement).value).toBe("冻结的判断。");
    await userEvent.click(screen.getByRole("button", { name: "使用同一标识重试" }));
    expect(vi.mocked(createAssessment).mock.calls[0][4]).toBe(receipt.idempotencyKey);
    expect(vi.mocked(createAssessment).mock.calls[0][5]).toEqual(receipt.command);
  });

  it("requires explicit discard when another committed intent already owns the pending receipt", async () => {
    await getOrCreateAssessmentReceipt({
      projectId: P,
      issueId: I,
      claimId: "77777777-7777-4777-8777-777777777777",
    }, {
      stance: "SUPPORTS",
      confidenceLevel: null,
      reasoning: "other claim",
      expectedManifestSha256: PREVIEW.manifestSha256,
      items: PREVIEW.items,
    });
    show();
    await fillReady();
    await userEvent.click(screen.getByRole("button", { name: "提交评价" }));
    expect(await screen.findByText(/已有另一条评价提交尚未确认/)).toBeTruthy();
    expect(createAssessment).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "放弃未确认提交，重新开始" })).toBeTruthy();
  });
});

describe("known POST failures", () => {
  it("stale preview clears receipt, preserves judgment fields, and asks parent to invalidate preview", async () => {
    vi.mocked(createAssessment).mockRejectedValueOnce(
      new ProjectApiError(409, "证据集自上次预览后已发生变化，请重新预览。", "EVIDENCE_PREVIEW_STALE"),
    );
    const onPreviewInvalidated = vi.fn();
    show({ onPreviewInvalidated });
    await fillReady();
    await userEvent.selectOptions(screen.getByLabelText("信心"), "HIGH");
    await userEvent.click(screen.getByRole("button", { name: "提交评价" }));
    expect(await screen.findByText("证据集自上次预览后已发生变化，请重新预览。")).toBeTruthy();
    expect(loadPendingAssessmentReceipt()).toBeNull();
    expect((screen.getByRole("radio", { name: "支持" }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("信心") as HTMLSelectElement).value).toBe("HIGH");
    expect((screen.getByLabelText("判断理由") as HTMLTextAreaElement).value).toBe("当前证据支持。");
    expect(onPreviewInvalidated).toHaveBeenCalledTimes(1);
  });

  it("unavailable evidence clears receipt and requests candidate refresh", async () => {
    vi.mocked(createAssessment).mockRejectedValueOnce(
      new ProjectApiError(404, "所选证据当前不可用于此研究项目。", "EVIDENCE_TARGET_NOT_AVAILABLE"),
    );
    const onNeedsEvidenceRefresh = vi.fn();
    show({ onNeedsEvidenceRefresh });
    await fillReady();
    await userEvent.click(screen.getByRole("button", { name: "提交评价" }));
    expect(await screen.findByText("所选证据当前不可用于此研究项目。")).toBeTruthy();
    expect(loadPendingAssessmentReceipt()).toBeNull();
    expect(onNeedsEvidenceRefresh).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["PROJECT_READ_ONLY", "当前研究项目已归档，不能新增评价。"],
    ["RESEARCH_ISSUE_READ_ONLY", "当前研究问题已归档，不能新增评价。"],
  ])("read-only failure %s clears receipt and disables further new submission", async (code, message) => {
    vi.mocked(createAssessment).mockRejectedValueOnce(new ProjectApiError(409, message, code));
    show();
    await fillReady();
    await userEvent.click(screen.getByRole("button", { name: "提交评价" }));
    expect(await screen.findByText(message)).toBeTruthy();
    expect(loadPendingAssessmentReceipt()).toBeNull();
    expect(screen.queryByRole("button", { name: "提交评价" })).toBeNull();
  });
});

describe("successful create/replay", () => {
  it("clears receipt and delegates canonical history refresh through onCommitted", async () => {
    const onCommitted = vi.fn();
    show({ onCommitted });
    await fillReady();
    await userEvent.click(screen.getByRole("button", { name: "提交评价" }));
    expect(await screen.findByText("评价已成功提交。")).toBeTruthy();
    expect(loadPendingAssessmentReceipt()).toBeNull();
    expect(onCommitted).toHaveBeenCalledWith(CREATED);
    expect((screen.getByLabelText("判断理由") as HTMLTextAreaElement).value).toBe("");
  });

  it("visible=false replay confirms prior success without displaying protected content", async () => {
    vi.mocked(createAssessment).mockResolvedValueOnce({
      status: "replayed",
      visible: false,
      assessmentId: A,
    });
    show();
    await fillReady();
    await userEvent.click(screen.getByRole("button", { name: "提交评价" }));
    expect(await screen.findByText("此评价此前已经成功提交，但当前不可显示其详细内容。")).toBeTruthy();
    expect(document.body.textContent).not.toContain("because");
  });
});
