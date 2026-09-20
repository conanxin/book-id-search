// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ProjectItems } from "./ProjectItems";
import { getProjectItemNote, removeProjectItem, ProjectApiError, type ProjectOverviewItem } from "./api";

vi.mock("./api", async importOriginal => ({
  ...await importOriginal<typeof import("./api")>(),
  removeProjectItem: vi.fn(),
  getProjectItemNote: vi.fn(),
}));

const item: ProjectOverviewItem = {
  bindingId: "binding",
  workId: "work",
  editionId: "edition",
  sourceId: "source",
  catalogBookId: "book/id",
  title: "北京古道考",
  publisher: "测试出版社",
  publicationDate: "2001-01-01",
  publicationDatePrecision: "YEAR",
  isbn: "9787538455250",
  addedAt: "2026-09-20T00:00:00Z",
  activityAt: "2026-09-20T08:00:00Z",
  noteSummary: {
    noteId: "note",
    currentRevisionId: "r2",
    currentRevisionNo: 2,
    excerpt: "第二版研究摘要",
    updatedAt: "2026-09-20T08:00:00Z",
  },
};

const view = (props: Partial<React.ComponentProps<typeof ProjectItems>> = {}) => <MemoryRouter><ProjectItems
  token="token"
  projectId="project"
  items={[item]}
  readOnly={false}
  {...props}
/></MemoryRouter>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(removeProjectItem).mockResolvedValue(undefined);
  vi.mocked(getProjectItemNote).mockResolvedValue({ note: null });
  vi.spyOn(window, "confirm").mockReturnValue(true);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe("project rediscover materials", () => {
  it("renders canonical fields, count and items in server-provided activity order", () => {
    const older = { ...item, bindingId: "older", title: "较早资料", activityAt: "2026-09-19T00:00:00Z", noteSummary: null };
    render(view({ items: [item, older] }));
    const cards = screen.getAllByRole("article");
    expect(within(cards[0]).getByText(item.title)).toBeTruthy();
    expect(within(cards[1]).getByText(older.title)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "研究资料（2）" })).toBeTruthy();
    expect(within(cards[0]).getByText(item.publisher!)).toBeTruthy();
    expect(within(cards[0]).getByText("2001")).toBeTruthy();
    expect(within(cards[0]).getByText(item.isbn!)).toBeTruthy();
    expect(within(cards[0]).getByRole("link", { name: "查看书目" }).getAttribute("href")).toBe("/books/book%2Fid");
  });

  it("renders Overview Note preview without prefetching the full Note", () => {
    render(view());
    expect(screen.getByText("研究笔记 · v2")).toBeTruthy();
    expect(screen.getByText("第二版研究摘要")).toBeTruthy();
    expect(screen.getByText(/更新于/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "打开笔记" })).toBeTruthy();
    expect(getProjectItemNote).not.toHaveBeenCalled();
  });

  it("shows an honest no-Note and empty-activity state", () => {
    const noNote = { ...item, noteSummary: null };
    const rendered = render(view({ items: [noNote] }));
    expect(screen.getByText("尚未写研究笔记")).toBeTruthy();
    rendered.rerender(view({ items: [] }));
    expect(screen.getByText("尚无研究活动")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "研究资料（0）" })).toBeTruthy();
  });

  it("preserves YEAR/MONTH/DAY precision and unknown dates", () => {
    render(view({ items: [
      item,
      { ...item, bindingId: "month", title: "月", publicationDate: "2001-02-01", publicationDatePrecision: "MONTH" },
      { ...item, bindingId: "day", title: "日", publicationDate: "2001-02-17", publicationDatePrecision: "DAY" },
      { ...item, bindingId: "unknown", title: "未知", publicationDate: null },
    ] }));
    expect(screen.queryByText("2001/2/1", { exact: true })).toBeNull();
    expect(screen.getByText("2001年2月", { exact: true })).toBeTruthy();
    expect(screen.getByText("2001/2/17", { exact: true })).toBeTruthy();
    expect(screen.getByText("日期未知")).toBeTruthy();
  });

  it("removes only after confirmed success and reports failures without hiding the item", async () => {
    let resolve!: () => void;
    vi.mocked(removeProjectItem).mockReturnValueOnce(new Promise(done => { resolve = done; }));
    render(view());
    await userEvent.click(screen.getByRole("button", { name: "移出项目" }));
    expect(screen.getByText(item.title)).toBeTruthy();
    expect(removeProjectItem).toHaveBeenCalledWith("token", "project", "binding", expect.any(AbortSignal));
    await act(async () => resolve());
    await waitFor(() => expect(screen.queryByText(item.title)).toBeNull());

    cleanup();
    vi.mocked(removeProjectItem).mockRejectedValueOnce(new ProjectApiError(503, "服务暂不可用"));
    render(view());
    await userEvent.click(screen.getByRole("button", { name: "移出项目" }));
    expect((await screen.findByRole("alert")).textContent).toContain("服务暂不可用");
    expect(screen.getByText(item.title)).toBeTruthy();
  });

  it("hides all material write controls for an archived Project", () => {
    render(view({ readOnly: true }));
    expect(screen.queryByRole("button", { name: "移出项目" })).toBeNull();
    expect(screen.getByRole("link", { name: "查看书目" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "打开笔记" })).toBeTruthy();
  });
});

describe("exact binding deep-link focus", () => {
  it("centers and temporarily emphasizes only the exact binding", async () => {
    vi.useFakeTimers();
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scrollIntoView });
    const other = { ...item, bindingId: "other", editionId: "binding", title: "另一本" };
    const { container } = render(view({ items: [other, item], focusedBindingId: "binding" }));
    await act(async () => {});
    expect(scrollIntoView).toHaveBeenCalledOnce();
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "center" });
    expect(container.querySelector('[data-binding-id="binding"]')?.classList.contains("research-material--focused")).toBe(true);
    expect(container.querySelector('[data-binding-id="other"]')?.classList.contains("research-material--focused")).toBe(false);
    act(() => vi.advanceTimersByTime(5000));
    expect(container.querySelector('[data-binding-id="binding"]')?.classList.contains("research-material--focused")).toBe(false);
    expect(getProjectItemNote).not.toHaveBeenCalled();
  });

  it("does not fall back to Edition or catalog identity and explains a missing binding", () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scrollIntoView });
    render(view({ focusedBindingId: item.editionId }));
    expect(screen.getByText("这项研究资料已不在当前项目中。")).toBeTruthy();
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(getProjectItemNote).not.toHaveBeenCalled();
  });
});
