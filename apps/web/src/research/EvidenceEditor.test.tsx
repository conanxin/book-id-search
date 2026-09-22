// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event";
import { EvidenceEditor } from "./EvidenceEditor";
import { listEvidenceCandidates, previewEvidenceManifest, ProjectApiError } from "./api";
import type { CandidateClaim } from "./api";

vi.mock("./api", async load => ({
  ...await load<typeof import("./api")>(),
  listEvidenceCandidates: vi.fn(),
  previewEvidenceManifest: vi.fn(),
}));

const p = "11111111-1111-4111-8111-111111111111";
const i = "22222222-2222-4222-8222-222222222222";
const claim: CandidateClaim = {
  id: "33333333-3333-4333-8333-333333333333",
  statement: "刘祥店可能在1960年代整体迁出。",
  lifecycleState: "ACTIVE",
  createdAt: "2026-09-21T00:00:00.000Z",
  updatedAt: "2026-09-21T00:00:00.000Z",
};
const source = {
  targetType: "SOURCE" as const, targetId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  materialBindingId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", materialTitle: "北京古道志",
  sourceType: "DATABASE_RECORD" as const, sourceLifecycleState: "ACTIVE" as const, observedAt: "2026-09-21T00:00:00.000Z",
};
const asset = {
  targetType: "SOURCE_ASSET" as const, targetId: "77777777-7777-4777-8777-777777777777",
  materialBindingId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", materialTitle: "北京古道志",
  sourceId: source.targetId, assetType: "DOCUMENT" as const, assetRole: "ORIGINAL" as const, storageMode: "LOCAL" as const, createdAt: "2026-09-21T00:00:00.000Z",
};
const note = {
  targetType: "NOTE_REVISION" as const, targetId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  materialBindingId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", materialTitle: "北京古道志",
  noteId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", revisionNo: 2, contentFormat: "MARKDOWN" as const, createdAt: "2026-09-21T00:00:00.000Z",
};
const previewResponse = {
  claim: { id: claim.id, statement: claim.statement },
  draft: {
    schemaVersion: 1 as const, purpose: "CLAIM_ASSESSMENT" as const, manifestSha256: "a".repeat(64),
    items: [{ ordinal: 1, role: "SUPPORTING" as const, targetType: "SOURCE" as const, targetId: source.targetId, locatorType: null, locator: null, excerpt: null, note: null }],
  },
  persisted: false as const,
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(listEvidenceCandidates).mockResolvedValue({ claim: { ...claim }, candidates: [source, asset, note] });
  vi.mocked(previewEvidenceManifest).mockResolvedValue(previewResponse);
});
afterEach(cleanup);

function show(claimOverride: Partial<CandidateClaim> = {}) {
  return render(<EvidenceEditor token="t" projectId={p} issueId={i} claim={{ ...claim, ...claimOverride }} />);
}

describe("lazy load and degradation", () => {
  it("collapsed state shows 构建证据集 and does not call candidates API", () => {
    show();
    expect(screen.getByRole("button", { name: "构建证据集" })).toBeTruthy();
    expect(listEvidenceCandidates).not.toHaveBeenCalled();
  });

  it("expanding loads only this claim's candidates", async () => {
    show();
    await userEvent.click(screen.getByRole("button", { name: "构建证据集" }));
    expect((await screen.findAllByText(/北京古道志/)).length).toBeGreaterThan(0);
    expect(listEvidenceCandidates).toHaveBeenCalledWith("t", p, i, claim.id, expect.anything());
    expect(listEvidenceCandidates).toHaveBeenCalledTimes(1);
  });

  it("candidate failure keeps the editor local unavailable with retry", async () => {
    vi.mocked(listEvidenceCandidates).mockRejectedValueOnce(new ProjectApiError(503, "SECRET"));
    show();
    await userEvent.click(screen.getByRole("button", { name: "构建证据集" }));
    expect(await screen.findByText("证据候选暂不可用。")).toBeTruthy();
    expect(screen.queryByText(/北京古道志/)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "重试证据候选" }));
    expect((await screen.findAllByText(/北京古道志/)).length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toContain("SECRET");
  });

  it("archived claim can still open the read/preview editor", async () => {
    show({ lifecycleState: "ARCHIVED" });
    await userEvent.click(screen.getByRole("button", { name: "构建证据集" }));
    expect((await screen.findAllByText(/北京古道志/)).length).toBeGreaterThan(0);
  });
});

describe("explicit role selection", () => {
  async function expand() {
    show();
    await userEvent.click(screen.getByRole("button", { name: "构建证据集" }));
    await screen.findAllByText(/北京古道志/);
  }

  it("adds an item only after an explicit role action; no default role", async () => {
    await expand();
    expect(screen.queryByText("SUPPORTING")).toBeNull();
    const group = screen.getByTestId(`candidate-${source.targetId}`);
    await userEvent.click(within(group).getByRole("button", { name: "作为支持证据" }));
    expect(await screen.findByText(/已选证据/)).toBeTruthy();
    expect(screen.getByText(/SUPPORTING/)).toBeTruthy();
  });

  it("same target cannot be added twice", async () => {
    await expand();
    const group = screen.getByTestId(`candidate-${source.targetId}`);
    await userEvent.click(within(group).getByRole("button", { name: "作为支持证据" }));
    expect(within(group).queryByRole("button", { name: "作为支持证据" })).toBeNull();
  });

  it("role can be changed explicitly afterward", async () => {
    await expand();
    const group = screen.getByTestId(`candidate-${source.targetId}`);
    await userEvent.click(within(group).getByRole("button", { name: "作为支持证据" }));
    const row = screen.getByTestId(`selected-${source.targetId}`);
    await userEvent.selectOptions(within(row).getByLabelText("证据角色"), "CONTRADICTORY");
    expect((within(row).getByLabelText("证据角色") as HTMLSelectElement).value).toBe("CONTRADICTORY");
  });

  it("remove removes the item; move up/down reorders", async () => {
    await expand();
    await userEvent.click(within(screen.getByTestId(`candidate-${source.targetId}`)).getByRole("button", { name: "作为支持证据" }));
    await userEvent.click(within(screen.getByTestId(`candidate-${note.targetId}`)).getByRole("button", { name: "作为背景证据" }));
    const rowA = screen.getByTestId(`selected-${source.targetId}`);
    const rowB = screen.getByTestId(`selected-${note.targetId}`);
    await userEvent.click(within(rowB).getByRole("button", { name: "上移" }));
    const rows = screen.getAllByTestId(/^selected-/);
    expect(rows[0].getAttribute("data-testid")).toBe(`selected-${note.targetId}`);
    await userEvent.click(within(rowA).getByRole("button", { name: "移除" }));
    expect(screen.queryByTestId(`selected-${source.targetId}`)).toBeNull();
  });

  it("optional note preserves internal whitespace as typed", async () => {
    await expand();
    await userEvent.click(within(screen.getByTestId(`candidate-${source.targetId}`)).getByRole("button", { name: "作为支持证据" }));
    const box = screen.getByLabelText("证据说明") as HTMLTextAreaElement;
    await userEvent.type(box, "第一行\n第二行  保持");
    expect(box.value).toBe("第一行\n第二行  保持");
  });
});

describe("preview and invalidation", () => {
  async function selectOne() {
    show();
    await userEvent.click(screen.getByRole("button", { name: "构建证据集" }));
    await screen.findAllByText(/北京古道志/);
    await userEvent.click(within(screen.getByTestId(`candidate-${source.targetId}`)).getByRole("button", { name: "作为支持证据" }));
  }

  it("preview button disabled while draft empty", async () => {
    await selectOne();
    // draft now has 1; clear it via remove
    await userEvent.click(within(screen.getByTestId(`selected-${source.targetId}`)).getByRole("button", { name: "移除" }));
    expect(screen.queryByRole("button", { name: "预览 EvidenceManifest" })).toBeNull();
  });

  it("preview sends ordered items and displays hash + 尚未提交 + 冻结 copy", async () => {
    await selectOne();
    await userEvent.click(screen.getByRole("button", { name: "预览 EvidenceManifest" }));
    expect(await screen.findByText("尚未提交。")).toBeTruthy();
    expect(screen.getByText(/将在评价该 Claim 时冻结为 EvidenceManifest。/)).toBeTruthy();
    expect(screen.getByText(/^a{64}$/)).toBeTruthy();
    expect(vi.mocked(previewEvidenceManifest)).toHaveBeenCalledWith("t", p, i, claim.id, [
      { role: "SUPPORTING", targetType: "SOURCE", targetId: source.targetId, note: "" },
    ], expect.anything());
    expect(screen.queryByText(/manifestId/i)).toBeNull();
    expect(document.body.textContent).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}.*manifest/i);
  });

  it.each([
    ["role change", async () => {
      const row = screen.getByTestId(`selected-${source.targetId}`);
      await userEvent.selectOptions(within(row).getByLabelText("证据角色"), "CONTRADICTORY");
    }],
    ["note edit", async () => {
      await userEvent.type(screen.getByLabelText("证据说明"), "为什么");
    }],
    ["remove item", async () => {
      await userEvent.click(within(screen.getByTestId(`selected-${source.targetId}`)).getByRole("button", { name: "移除" }));
    }],
  ])("any draft mutation (%s) removes the prior preview", async (_name, mutate) => {
    await selectOne();
    await userEvent.click(screen.getByRole("button", { name: "预览 EvidenceManifest" }));
    await screen.findByText("尚未提交。");
    await mutate();
    expect(screen.queryByText("尚未提交。")).toBeNull();
    expect(screen.queryByText(/^a{64}$/)).toBeNull();
  });

  it("reorder clears the prior preview", async () => {
    show();
    await userEvent.click(screen.getByRole("button", { name: "构建证据集" }));
    await screen.findAllByText(/北京古道志/);
    await userEvent.click(within(screen.getByTestId(`candidate-${source.targetId}`)).getByRole("button", { name: "作为支持证据" }));
    await userEvent.click(within(screen.getByTestId(`candidate-${note.targetId}`)).getByRole("button", { name: "作为背景证据" }));
    await userEvent.click(screen.getByRole("button", { name: "预览 EvidenceManifest" }));
    await screen.findByText("尚未提交。");
    await userEvent.click(within(screen.getByTestId(`selected-${note.targetId}`)).getByRole("button", { name: "上移" }));
    expect(screen.queryByText("尚未提交。")).toBeNull();
  });

  it("preview failure keeps draft editable and shows safe local error", async () => {
    vi.mocked(previewEvidenceManifest).mockRejectedValueOnce(new ProjectApiError(404, "所选证据不可用于当前研究项目。", "EVIDENCE_TARGET_NOT_AVAILABLE"));
    await selectOne();
    await userEvent.click(screen.getByRole("button", { name: "预览 EvidenceManifest" }));
    expect(await screen.findByText("所选证据不可用于当前研究项目。")).toBeTruthy();
    expect(screen.getByTestId(`selected-${source.targetId}`)).toBeTruthy();
    expect(screen.getByRole("button", { name: "预览 EvidenceManifest" })).toBeTruthy();
  });
});

describe("no persistence", () => {
  it("never writes sessionStorage/localStorage during selection and preview", async () => {
    const sessionSet = vi.fn();
    const localSet = vi.fn();
    vi.stubGlobal("sessionStorage", { ...sessionStorage, setItem: sessionSet });
    vi.stubGlobal("localStorage", { ...localStorage, setItem: localSet });
    show();
    await userEvent.click(screen.getByRole("button", { name: "构建证据集" }));
    await screen.findAllByText(/北京古道志/);
    await userEvent.click(within(screen.getByTestId(`candidate-${source.targetId}`)).getByRole("button", { name: "作为支持证据" }));
    await userEvent.type(screen.getByLabelText("证据说明"), "note");
    await userEvent.click(screen.getByRole("button", { name: "预览 EvidenceManifest" }));
    await screen.findByText("尚未提交。");
    expect(sessionSet).not.toHaveBeenCalled();
    expect(localSet).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("unmount discards the draft (page-local memory only)", async () => {
    const view = show();
    await userEvent.click(screen.getByRole("button", { name: "构建证据集" }));
    await screen.findAllByText(/北京古道志/);
    await userEvent.click(within(screen.getByTestId(`candidate-${source.targetId}`)).getByRole("button", { name: "作为支持证据" }));
    expect(screen.getByTestId(`selected-${source.targetId}`)).toBeTruthy();
    view.unmount();
    const second = show();
    await userEvent.click(screen.getByRole("button", { name: "构建证据集" }));
    await screen.findAllByText(/北京古道志/);
    expect(screen.queryByTestId(`selected-${source.targetId}`)).toBeNull();
    second.unmount();
  });
});


describe("in-flight preview stale response guard (Finding 3)", () => {
  it("does not restore stale preview hash after draft changes while request is in flight", async () => {
    show();
    await userEvent.click(screen.getByRole("button", { name: "构建证据集" }));
    await screen.findAllByText(/北京古道志/);
    await userEvent.click(within(screen.getByTestId(`candidate-${source.targetId}`)).getByRole("button", { name: "作为支持证据" }));

    let resolveOld!: (value: typeof previewResponse) => void;
    const oldHash = "1".repeat(64);
    const oldResponse = { ...previewResponse, draft: { ...previewResponse.draft, manifestSha256: oldHash } };
    vi.mocked(previewEvidenceManifest).mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve; }));

    await userEvent.click(screen.getByRole("button", { name: "预览 EvidenceManifest" }));
    expect(await screen.findByText("正在生成预览…")).toBeTruthy();

    // Mutate draft while old request is still pending.
    await userEvent.type(screen.getByLabelText("证据说明"), "stale guard");

    // Now resolve the OLD request — its hash must NOT be displayed and 尚未提交 must not appear.
    resolveOld!(oldResponse);
    // flush microtasks + React effects
    await waitFor(() => {
      expect(screen.queryByText(new RegExp(`^${oldHash}$`))).toBeNull();
      expect(screen.queryByText("尚未提交。")).toBeNull();
    });
  });

  it("does not surface stale preview error after draft changes while request is in flight", async () => {
    show();
    await userEvent.click(screen.getByRole("button", { name: "构建证据集" }));
    await screen.findAllByText(/北京古道志/);
    await userEvent.click(within(screen.getByTestId(`candidate-${source.targetId}`)).getByRole("button", { name: "作为支持证据" }));

    let rejectOld!: (reason: unknown) => void;
    vi.mocked(previewEvidenceManifest).mockReturnValueOnce(new Promise((_, reject) => { rejectOld = reject; }));

    await userEvent.click(screen.getByRole("button", { name: "预览 EvidenceManifest" }));
    expect(await screen.findByText("正在生成预览…")).toBeTruthy();

    // Mutate draft while old request is still pending.
    await userEvent.type(screen.getByLabelText("证据说明"), "stale error guard");

    // Reject the OLD request — its error message must NOT be displayed.
    rejectOld!(new ProjectApiError(503, "stale secret"));
    await waitFor(() => {
      expect(screen.queryByText("stale secret")).toBeNull();
      // Match only the preview-error alert role/region, not free text inside textareas.
      expect(screen.queryByText(/证据预览暂不可用|网络异常，请稍后重试/)).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
    });
  });
});


describe("M2-D preview handoff", () => {
  it("emits the server-authoritative current preview and invalidates it on evidence mutation", async () => {
    const onPreviewChange = vi.fn();
    render(
      <EvidenceEditor
        token="t"
        projectId={p}
        issueId={i}
        claim={claim}
        onPreviewChange={onPreviewChange}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "构建证据集" }));
    await screen.findAllByText(/北京古道志/);
    await userEvent.click(
      within(screen.getByTestId(`candidate-${source.targetId}`))
        .getByRole("button", { name: "作为支持证据" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "预览 EvidenceManifest" }));
    await screen.findByText("尚未提交。");
    expect(onPreviewChange).toHaveBeenLastCalledWith({
      draftVersion: expect.any(Number),
      manifestSha256: "a".repeat(64),
      items: [{
        role: "SUPPORTING",
        targetType: "SOURCE",
        targetId: source.targetId,
        note: null,
      }],
    });

    await userEvent.type(screen.getByLabelText("证据说明"), "改变证据说明");
    expect(onPreviewChange).toHaveBeenLastCalledWith(null);
    expect(screen.queryByText("尚未提交。")).toBeNull();
  });

  it("prevents selecting a 101st evidence item in the browser", async () => {
    const candidates = Array.from({ length: 101 }, (_, n) => ({
      ...source,
      targetId: `${(n + 1).toString(16).padStart(8, "0")}-0000-4000-8000-${(n + 1).toString(16).padStart(12, "0")}`,
      materialTitle: `资料 ${n + 1}`,
    }));
    vi.mocked(listEvidenceCandidates).mockResolvedValueOnce({
      claim: { ...claim },
      candidates,
    });
    render(<EvidenceEditor token="t" projectId={p} issueId={i} claim={claim} />);
    await userEvent.click(screen.getByRole("button", { name: "构建证据集" }));
    await screen.findByText(/资料 101/);

    for (let n = 0; n < 100; n += 1) {
      await userEvent.click(
        within(screen.getByTestId(`candidate-${candidates[n].targetId}`))
          .getByRole("button", { name: "作为支持证据" }),
      );
    }

    expect(screen.getByText("最多选择 100 项证据。")).toBeTruthy();
    const finalCandidate = screen.getByTestId(`candidate-${candidates[100].targetId}`);
    expect(
      (within(finalCandidate).getByRole("button", { name: "作为支持证据" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  }, 20_000);
});


describe("external preview reset after committed Assessment", () => {
  it("invalidates the preview but preserves the selected evidence draft for re-preview", async () => {
    const onPreviewChange = vi.fn();
    const view = render(
      <EvidenceEditor
        token="t"
        projectId={p}
        issueId={i}
        claim={claim}
        onPreviewChange={onPreviewChange}
        previewResetVersion={0}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "构建证据集" }));
    await screen.findAllByText(/北京古道志/);
    await userEvent.click(
      within(screen.getByTestId(`candidate-${source.targetId}`))
        .getByRole("button", { name: "作为支持证据" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "预览 EvidenceManifest" }));
    await screen.findByText("尚未提交。");

    view.rerender(
      <EvidenceEditor
        token="t"
        projectId={p}
        issueId={i}
        claim={claim}
        onPreviewChange={onPreviewChange}
        previewResetVersion={1}
      />,
    );

    await waitFor(() => expect(screen.queryByText("尚未提交。")).toBeNull());
    expect(screen.getByTestId(`selected-${source.targetId}`)).toBeTruthy();
    expect(screen.getByRole("button", { name: "预览 EvidenceManifest" })).toBeTruthy();
    expect(onPreviewChange).toHaveBeenLastCalledWith(null);
  });
});
