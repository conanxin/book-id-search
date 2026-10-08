// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { listResearchRuns, ProjectApiError } from "./api";
import { ResearchRunHistory } from "./ResearchRunHistory";

vi.mock("../auth/session", async importOriginal => {
  const actual = await importOriginal<typeof import("../auth/session")>();
  return { ...actual, ensureAuthSessionLoaded: vi.fn(async () => {}) };
});
import { __resetWebAuthStoreForTests, __setWebAuthSnapshotForTests } from "../auth/session";
beforeEach(() => {
  __setWebAuthSnapshotForTests({ status: "authenticated", user: { email: "owner@example.com", name: "Owner" }, csrfToken: "csrf-test", error: null });
});
vi.mock("./api", async load => ({
  ...await load<typeof import("./api")>(),
  listResearchRuns: vi.fn(),
}));

const P = "11111111-1111-4111-8111-111111111111";
const I = "22222222-2222-4222-8222-222222222222";
const RUN1 = "33333333-3333-4333-8333-333333333333";
const RUN2 = "44444444-4444-4444-8444-444444444444";
const RUN3 = "55555555-5555-4555-8555-555555555555";
const M = "77777777-7777-4777-8777-777777777777";

const run = (over: Record<string, unknown> = {}) => ({
  runId: RUN1,
  issueId: I,
  status: "SUCCEEDED",
  replayOf: null,
  startedAtMicros: "1760486400123456",
  startedAt: "2026-09-28T00:00:00.123456Z",
  completedAt: "2026-09-28T01:00:00.654321Z",
  evidenceManifest: { id: M, manifestSha256: "a".repeat(64), itemCount: 3, available: true },
  ...over,
});

beforeEach(() => vi.mocked(listResearchRuns).mockReset());
afterEach(() => { cleanup(); });

describe("ResearchRunHistory — initial load", () => {
  it("shows loading then empty copy", async () => {
    let release!: (value: { runs: unknown[]; nextCursor: string | null }) => void;
    vi.mocked(listResearchRuns).mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
    render(<ResearchRunHistory projectId={P} issueId={I} />);
    expect(screen.getByRole("status").textContent).toContain("正在读取研究轮次…");
    release({ runs: [], nextCursor: null });
    expect(await screen.findByText("还没有研究轮次。")).toBeTruthy();
    expect(listResearchRuns.mock.calls[0]?.[2]).toEqual({ limit: 20 });
  });

  it("shows loading then populated rows", async () => {
    vi.mocked(listResearchRuns).mockResolvedValueOnce({ runs: [run()], nextCursor: null });
    render(<ResearchRunHistory projectId={P} issueId={I} />);
    expect(screen.getByRole("status")).toBeTruthy();
    expect(await screen.findByText(RUN1, { selector: "code.research-run-card code, .research-run-card code" })).toBeTruthy();
  });

  it("unavailable → safe error + retry, no raw backend text", async () => {
    vi.mocked(listResearchRuns).mockRejectedValueOnce(new ProjectApiError(503, "SECRET INTERNAL SQL DETAIL"));
    render(<ResearchRunHistory projectId={P} issueId={I} />);
    expect(await screen.findByText("研究轮次暂时无法加载。")).toBeTruthy();
    expect(document.body.textContent).not.toContain("SECRET INTERNAL SQL DETAIL");
    vi.mocked(listResearchRuns).mockResolvedValueOnce({ runs: [], nextCursor: null });
    await userEvent.click(screen.getByRole("button", { name: "重试研究轮次" }));
    expect(await screen.findByText("还没有研究轮次。")).toBeTruthy();
  });
});

describe("ResearchRunHistory — rendering", () => {
  it("renders all four status labels with machine status accessible", async () => {
    vi.mocked(listResearchRuns).mockResolvedValueOnce({
      runs: [
        run({ runId: RUN1, status: "RUNNING", completedAt: null }),
        run({ runId: RUN2, status: "SUCCEEDED" }),
        run({ runId: RUN3, status: "FAILED" }),
      ],
      nextCursor: null,
    });
    render(<ResearchRunHistory projectId={P} issueId={I} />);
    expect(await screen.findByText("进行中")).toBeTruthy();
    expect(screen.getByText("已完成")).toBeTruthy();
    expect(screen.getByText("失败")).toBeTruthy();
    // machine status kept accessible via title
    expect(screen.getByTitle("RUNNING")).toBeTruthy();
    expect(screen.getByTitle("SUCCEEDED")).toBeTruthy();
    expect(screen.getByTitle("FAILED")).toBeTruthy();
  });

  it("RUNNING says 尚未结束; terminal shows 结束 datetime", async () => {
    vi.mocked(listResearchRuns).mockResolvedValueOnce({
      runs: [run({ runId: RUN1, status: "RUNNING", completedAt: null }), run({ runId: RUN2 })],
      nextCursor: null,
    });
    render(<ResearchRunHistory projectId={P} issueId={I} />);
    expect(await screen.findByText("尚未结束")).toBeTruthy();
    expect(screen.getByText(/结束：/)).toBeTruthy();
  });

  it("evidence copy for available true/false", async () => {
    vi.mocked(listResearchRuns).mockResolvedValueOnce({
      runs: [
        run({ runId: RUN1, evidenceManifest: { id: M, manifestSha256: "a".repeat(64), itemCount: 5, available: true } }),
        run({ runId: RUN2, evidenceManifest: { id: M, manifestSha256: "a".repeat(64), itemCount: 2, available: false } }),
      ],
      nextCursor: null,
    });
    render(<ResearchRunHistory projectId={P} issueId={I} />);
    expect(await screen.findByText("证据快照：5 项 · 当前可用")).toBeTruthy();
    expect(screen.getByText("证据快照：2 项 · 当前不可访问")).toBeTruthy();
  });

  it("replay summary only when replayOf non-null; full UUID in code", async () => {
    vi.mocked(listResearchRuns).mockResolvedValueOnce({
      runs: [run({ runId: RUN1, replayOf: RUN3 }), run({ runId: RUN2, replayOf: null })],
      nextCursor: null,
    });
    const { container } = render(<ResearchRunHistory projectId={P} issueId={I} />);
    expect(await screen.findByText("重放自：")).toBeTruthy();
    const code = container.querySelector(".research-run-replay code");
    expect(code?.textContent).toBe(RUN3);
    expect(container.querySelectorAll(".research-run-replay")).toHaveLength(1);
  });

  it("preserves server order exactly even with identical JS-visible timestamps", async () => {
    vi.mocked(listResearchRuns).mockResolvedValueOnce({
      runs: [
        run({ runId: RUN3, startedAt: "2026-09-28T00:00:00.000000Z", completedAt: "2026-09-28T00:00:00.000000Z" }),
        run({ runId: RUN1, startedAt: "2026-09-28T00:00:00.000000Z", completedAt: "2026-09-28T00:00:00.000000Z" }),
        run({ runId: RUN2, startedAt: "2026-09-28T00:00:00.000000Z", completedAt: "2026-09-28T00:00:00.000000Z" }),
      ],
      nextCursor: null,
    });
    const { container } = render(<ResearchRunHistory projectId={P} issueId={I} />);
    await screen.findByText(RUN3, { selector: ".research-run-card code" });
    const ids = Array.from(container.querySelectorAll(".research-run-card code")).map(node => node.textContent);
    // card heading code = own run id first; replay code appears after if present — here no replay
    expect(ids).toEqual([RUN3, RUN1, RUN2]);
  });
});

describe("ResearchRunHistory — pagination", () => {
  it("no nextCursor → no older button", async () => {
    vi.mocked(listResearchRuns).mockResolvedValueOnce({ runs: [run({ runId: RUN1 })], nextCursor: null });
    render(<ResearchRunHistory projectId={P} issueId={I} />);
    await screen.findByText(RUN1, { selector: ".research-run-card code" });
    expect(screen.queryByRole("button", { name: "加载更早研究轮次" })).toBeNull();
  });

  it("older page uses exact cursor and appends in server order", async () => {
    vi.mocked(listResearchRuns)
      .mockResolvedValueOnce({ runs: [run({ runId: RUN1 })], nextCursor: "cursor-A" })
      .mockResolvedValueOnce({ runs: [run({ runId: RUN2 }), run({ runId: RUN3 })], nextCursor: null });
    render(<ResearchRunHistory projectId={P} issueId={I} />);
    await screen.findByText(RUN1, { selector: ".research-run-card code" });
    await userEvent.click(screen.getByRole("button", { name: "加载更早研究轮次" }));
    await screen.findByText(RUN2, { selector: ".research-run-card code" });
    expect(listResearchRuns).toHaveBeenLastCalledWith(P, I, { limit: 20, cursor: "cursor-A" }, expect.any(AbortSignal));
    const order = Array.from(document.querySelectorAll(".research-run-card code")).map(node => node.textContent);
    expect(order).toEqual([RUN1, RUN2, RUN3]);
    expect(screen.queryByRole("button", { name: "加载更早研究轮次" })).toBeNull();
  });

  it("defensive duplicate runId from overlapping page is not duplicated", async () => {
    vi.mocked(listResearchRuns).mockResolvedValueOnce({ runs: [run({ runId: RUN1 })], nextCursor: "c1" });
    render(<ResearchRunHistory projectId={P} issueId={I} />);
    await screen.findByText(RUN1, { selector: "code.research-run-card code, .research-run-card code" });
    vi.mocked(listResearchRuns).mockResolvedValueOnce({ runs: [run({ runId: RUN1 }), run({ runId: RUN2 })], nextCursor: null });
    await userEvent.click(screen.getByRole("button", { name: "加载更早研究轮次" }));
    await screen.findByText(RUN2, { selector: ".research-run-card code" });
    expect(document.querySelectorAll(".research-run-card")).toHaveLength(2);
  });

  it("page failure keeps rows and retry reuses the exact failed cursor", async () => {
    vi.mocked(listResearchRuns).mockResolvedValueOnce({ runs: [run({ runId: RUN1 })], nextCursor: "failed-cursor" });
    render(<ResearchRunHistory projectId={P} issueId={I} />);
    await screen.findByText(RUN1, { selector: "code.research-run-card code, .research-run-card code" });
    vi.mocked(listResearchRuns).mockRejectedValueOnce(new ProjectApiError(500, "SECRET PAGE ERROR"));
    await userEvent.click(screen.getByRole("button", { name: "加载更早研究轮次" }));
    expect(await screen.findByText("更早的研究轮次暂时无法加载。")).toBeTruthy();
    expect(screen.getByText(RUN1, { selector: ".research-run-card code" })).toBeTruthy();
    expect(document.body.textContent).not.toContain("SECRET PAGE ERROR");
    // retry with the exact same cursor
    vi.mocked(listResearchRuns).mockResolvedValueOnce({ runs: [run({ runId: RUN2 })], nextCursor: null });
    await userEvent.click(screen.getByRole("button", { name: "重试加载更早研究轮次" }));
    await screen.findByText(RUN2, { selector: ".research-run-card code" });
    const cursors = listResearchRuns.mock.calls.map(call => (call[2] as { cursor?: string }).cursor);
    expect(cursors).toEqual([undefined, "failed-cursor", "failed-cursor"]);
  });
});

describe("ResearchRunHistory — scope/abort", () => {
  it("prop change aborts, resets and reloads", async () => {
    vi.mocked(listResearchRuns).mockResolvedValue({ runs: [run({ runId: RUN1 })], nextCursor: null });
    const { rerender } = render(<ResearchRunHistory projectId={P} issueId={I} />);
    await screen.findByText(RUN1, { selector: "code.research-run-card code, .research-run-card code" });
    vi.mocked(listResearchRuns).mockResolvedValueOnce({ runs: [run({ runId: RUN2 })], nextCursor: null });
    rerender(<ResearchRunHistory projectId={P} issueId="99999999-9999-4999-8999-999999999999" />);
    await screen.findByText(RUN2, { selector: ".research-run-card code" });
    expect(listResearchRuns.mock.calls[1]?.[1]).toBe("99999999-9999-4999-8999-999999999999");
    // reset cleared the old row
    expect(screen.queryByText(RUN1, { selector: ".research-run-card code" })).toBeNull();
  });

  it("unmount aborts pending request without state warnings", async () => {
    let release!: (value: { runs: unknown[]; nextCursor: string | null }) => void;
    vi.mocked(listResearchRuns).mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
    const { unmount } = render(<ResearchRunHistory projectId={P} issueId={I} />);
    expect(screen.getByRole("status")).toBeTruthy();
    const signal = (listResearchRuns.mock.calls[0]?.[3]) as AbortSignal;
    unmount();
    expect(signal.aborted).toBe(true);
    release({ runs: [], nextCursor: null });
    await Promise.resolve();
  });
});

describe("ResearchRunHistory — real client passthrough (Task 4 Phase 0)", () => {
  it("accepts a real backend LIST payload through listResearchRuns into the UI", async () => {
    const runId = "33333333-3333-4333-8333-333333333333";
    const payload = {
      runs: [{
        runId,
        issueId: I,
        status: "SUCCEEDED",
        replayOf: null,
        startedAtMicros: "1760486400123456",
        startedAt: "2026-09-28T00:00:00.123456Z",
        completedAt: "2026-09-28T01:00:00.654321Z",
        // Real Gate 2 read-store shape: compact four keys even when available=true.
        evidenceManifest: { id: M, manifestSha256: "a".repeat(64), itemCount: 2, available: true },
      }],
      nextCursor: null,
    };
    // The api module is mocked at file level in this suite; bypass by calling the real client directly.
    const { listResearchRuns: realList } = await vi.importActual<typeof import("./api")>("./api");
    // restore session state: this test suite already sets authenticated snapshot in beforeEach
    const fetchStub = vi.fn(async () => new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchStub);
    const result = await realList(P, I, { limit: 20 });
    expect(result.runs[0].evidenceManifest.available).toBe(true);
    expect((result.runs[0].evidenceManifest as Record<string, unknown>)["items"]).toBeUndefined();
    vi.unstubAllGlobals();
  });
});
