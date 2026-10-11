// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ResearchDossierPage } from "./ResearchDossierPage";
import { useResearchDossier } from "./useResearchDossier";
import { createDossier, dossierView, receiveDossierRead, startDossierRead, type DossierRequest, type DossierState } from "./dossier-model";

vi.mock("./useResearchDossier", () => ({ useResearchDossier: vi.fn() }));
const P = "11111111-1111-4111-8111-111111111111";
const I = "22222222-2222-4222-8222-222222222222";
const R = "33333333-3333-4333-8333-333333333333";
const U = "44444444-4444-4444-8444-444444444444";
const M = "55555555-5555-4555-8555-555555555555";
const T = "2026-10-09T01:02:03.123Z";
const read = vi.fn().mockResolvedValue(true);
const refresh = vi.fn();

function accept(state: DossierState, request: DossierRequest, data: unknown): DossierState {
  const started = startDossierRead(state, request);
  if (!started.ticket) throw Error("The request did not start");
  return receiveDossierRead(started.state, started.ticket, data as never, T);
}
function prepare(nextCursor: string | null = null) {
  let state = createDossier({ projectId: P, issueId: I, authGeneration: 1 });
  state = accept(state, { kind: "question" }, {
    project: { id: P, name: "古建筑研究", lifecycleState: "ACTIVE", readOnly: false },
    issue: { id: I, projectId: P, title: "城楼建造年代", question: "城楼最初修于何年？", lifecycleState: "OPEN", createdAt: T, updatedAt: T },
  });
  state = accept(state, { kind: "claims" }, { claims: [] });
  state = accept(state, { kind: "resolutions", cursor: null }, {
    issue: { id: I, lifecycleState: "OPEN", currentResolutionId: R, updatedAt: T },
    currentResolution: {
      id: R, issueId: I, resolutionType: "INSUFFICIENT_EVIDENCE", preferredClaimId: null,
      rationaleExcerpt: "现有碑刻材料不足", createdAt: T, isCurrent: true, evidenceBasisAvailable: false, evidenceManifest: null,
    },
    resolutions: [], nextCursor,
  });
  state = accept(state, { kind: "runs", cursor: null }, {
    runs: [{
      runId: U, issueId: I, status: "RUNNING", replayOf: null,
      startedAtMicros: "1791507723123456", startedAt: T, completedAt: null,
      evidenceManifest: { id: M, manifestSha256: "a".repeat(64), itemCount: 1, available: false },
    }],
    nextCursor: null,
  });
  return dossierView(state);
}
function show(nextCursor: string | null = null) {
  vi.mocked(useResearchDossier).mockReturnValue({ view: prepare(nextCursor), read, refresh });
  return render(<MemoryRouter><ResearchDossierPage projectId={P} issueId={I} /></MemoryRouter>);
}
afterEach(() => {
  cleanup();
  read.mockClear();
  refresh.mockClear();
  vi.mocked(useResearchDossier).mockReset();
});

describe("Research Dossier read-only rendering", () => {
  it("shows independent Current even when current Resolution is outside the history page", async () => {
    show();
    expect(screen.getByRole("heading", { name: "城楼建造年代" })).toBeTruthy();
    expect(screen.getByText("城楼最初修于何年？")).toBeTruthy();
    expect(screen.getByText("现有碑刻材料不足")).toBeTruthy();
    expect(screen.getByText("尚无已记录工作结论。")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "读取完整理由" }));
    expect(read).toHaveBeenCalledWith({ kind: "resolution", resolutionId: R });
  });

  it("contains no Run mutation actions and never invents a merged precise timeline", () => {
    show();
    expect(screen.getByText(/D01-A：两条时间线分别保留来源顺序/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /完成研究轮次|取消研究轮次|重放研究轮次|提交工作结论/ })).toBeNull();
    expect(screen.getByRole("link", { name: "返回研究问题" }).getAttribute("href")).toContain("/issues/" + I);
    expect(screen.getByRole("button", { name: "只读查看轮次详情" })).toBeTruthy();
  });

  it("passes the original opaque Resolution cursor without deriving a new one", async () => {
    show("opaque_%2B/%3D");
    await userEvent.click(screen.getByRole("button", { name: "加载更多" }));
    expect(read).toHaveBeenCalledWith({ kind: "resolutions", cursor: "opaque_%2B/%3D" });
  });

  it("distinguishes project material links from verified original page or plate citations", () => {
    const view = prepare();
    const projectItem = "88888888-8888-4888-8888-888888888888";
    vi.mocked(useResearchDossier).mockReturnValue({
      view: { ...view, references: [{
        origin: "assessment", recordId: R, targetType: "SOURCE",
        targetId: R, manifestId: M, manifestSha256: "a".repeat(64),
        materialTitle: "古道地方志来源对象", href: `/research/projects/${P}?item=${projectItem}`,
      }] },
      read, refresh,
    });
    render(<MemoryRouter><ResearchDossierPage projectId={P} issueId={I} /></MemoryRouter>);
    expect(screen.getByText(/项目资料链接不等于原文页码、图版或段落定位/)).toBeTruthy();
    const link = screen.getByRole("link", { name: "查看项目资料：古道地方志来源对象" });
    expect(link.getAttribute("href")).toBe(`/research/projects/${P}?item=${projectItem}`);
    expect(screen.queryByRole("link", { name: /已核实的引用|原文第/ })).toBeNull();
    expect(screen.getByText(/证据对象及项目资料可追溯，不表示已核实原书页码/)).toBeTruthy();
  });

  it("whole-page refresh never submits a Run or a Resolution", async () => {
    show();
    await userEvent.click(screen.getByRole("button", { name: "刷新整个档案" }));
    expect(refresh).toHaveBeenCalledOnce();
    expect(read).not.toHaveBeenCalled();
  });
});
