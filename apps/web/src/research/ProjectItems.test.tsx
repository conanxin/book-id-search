// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ProjectItems } from "./ProjectItems";
import { listProjectItems, removeProjectItem, getProjectItemNote, ProjectApiError } from "./api";
vi.mock("./api", async importOriginal => ({ ...await importOriginal<typeof import("./api")>(), listProjectItems: vi.fn(), removeProjectItem: vi.fn(), getProjectItemNote: vi.fn() }));
const item = { bindingId: "binding", projectId: "project", workId: "work", editionId: "edition", sourceId: "source", catalogBookId: "book/id", title: "北京古道考", publisher: "测试出版社", publicationDate: "2001-01-01", publicationDatePrecision: "YEAR" as const, isbn: "9787538455250", addedAt: "2026-09-20T00:00:00Z" };
const view = (token = "token", projectId = "project") => <MemoryRouter><ProjectItems token={token} projectId={projectId} /></MemoryRouter>;
beforeEach(() => { vi.clearAllMocks(); vi.mocked(listProjectItems).mockResolvedValue({ items: [item] }); vi.mocked(removeProjectItem).mockResolvedValue(undefined); vi.spyOn(window, "confirm").mockReturnValue(true); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
describe("project materials", () => {
  it("shows loading, then canonical fields, real count and encoded catalog link", async () => {
    render(view()); expect(screen.getByRole("status").textContent).toContain("读取");
    await screen.findByText(item.title); expect(screen.getByText(item.publisher)).toBeTruthy(); expect(screen.getByText("2001")).toBeTruthy(); expect(screen.getByText(item.isbn)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "研究资料（1）" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "查看书目" }).getAttribute("href")).toBe("/books/book%2Fid");
  });
  it("shows honest empty state", async () => {
    vi.mocked(listProjectItems).mockResolvedValue({ items: [] }); render(view());
    await screen.findByText("还没有研究资料"); expect(screen.getByRole("heading", { name: "研究资料（0）" })).toBeTruthy();
  });
  it("shows MONTH precision without inventing the placeholder day", async () => {
    vi.mocked(listProjectItems).mockResolvedValue({ items: [{ ...item, publicationDate: "2001-02-01", publicationDatePrecision: "MONTH" }] });
    render(view()); await screen.findByText(item.title);
    expect.soft(screen.queryByText("2001/2/1", { exact: true })).toBeNull();
    expect(screen.getByText("2001年2月", { exact: true })).toBeTruthy();
  });
  it("shows the complete actual date for DAY precision", async () => {
    vi.mocked(listProjectItems).mockResolvedValue({ items: [{ ...item, publicationDate: "2001-02-17", publicationDatePrecision: "DAY" }] });
    render(view()); await screen.findByText(item.title);
    expect(screen.getByText("2001/2/17", { exact: true })).toBeTruthy();
  });
  it("legacy missing catalog/date has no fake link", async () => {
    vi.mocked(listProjectItems).mockResolvedValue({ items: [{ ...item, catalogBookId: null, sourceId: null, publicationDate: null }] }); render(view());
    await screen.findByText(item.title); expect(screen.queryByRole("link", { name: "查看书目" })).toBeNull(); expect(screen.getByText("日期未知")).toBeTruthy();
  });
  it("failed load is an error, never an empty success", async () => {
    vi.mocked(listProjectItems).mockRejectedValue(new ProjectApiError(503, "服务暂不可用")); render(view());
    expect((await screen.findByRole("alert")).textContent).toContain("服务暂不可用"); expect(screen.queryByText("还没有研究资料")).toBeNull(); expect(screen.queryByRole("heading", { name: "研究资料（0）" })).toBeNull();
  });
  it("cancel does not delete", async () => {
    vi.mocked(window.confirm).mockReturnValue(false); render(view()); await screen.findByText(item.title);
    await userEvent.click(screen.getByRole("button", { name: "移出项目" })); expect(window.confirm).toHaveBeenCalledOnce(); expect(removeProjectItem).not.toHaveBeenCalled(); expect(screen.getByText(item.title)).toBeTruthy();
  });
  it("confirmed delete runs once, preserves pending item, removes only that item after success", async () => {
    vi.mocked(listProjectItems).mockResolvedValue({ items: [item, { ...item, bindingId: "other", title: "另一本书" }] });
    let resolve!: () => void; vi.mocked(removeProjectItem).mockReturnValue(new Promise(r => { resolve = r; }));
    render(view()); const title = await screen.findByText(item.title); const card = title.closest("article")!;
    await userEvent.dblClick(within(card).getByRole("button", { name: "移出项目" })); expect(removeProjectItem).toHaveBeenCalledOnce(); expect(screen.getByText(item.title)).toBeTruthy();
    expect(removeProjectItem).toHaveBeenCalledWith("token", "project", "binding", expect.any(AbortSignal));
    await act(async () => resolve()); await waitFor(() => expect(screen.queryByText(item.title)).toBeNull());
    expect(screen.getByText("另一本书")).toBeTruthy(); expect(screen.getByRole("heading", { name: "研究资料（1）" })).toBeTruthy();
  });
  it("failed delete keeps the item and count", async () => {
    vi.mocked(removeProjectItem).mockRejectedValue(new ProjectApiError(503, "服务暂不可用")); render(view()); await screen.findByText(item.title);
    await userEvent.click(screen.getByRole("button", { name: "移出项目" })); expect((await screen.findByRole("alert")).textContent).toContain("服务暂不可用"); expect(screen.getByText(item.title)).toBeTruthy(); expect(screen.getByRole("heading", { name: "研究资料（1）" })).toBeTruthy();
  });
  it.each(["token", "project"])("%s changes abort old load and discard stale response", async change => {
    let resolve!: (v: { items: typeof item[] }) => void; vi.mocked(listProjectItems).mockReturnValueOnce(new Promise(r => { resolve = r; })).mockResolvedValueOnce({ items: [] });
    const rendered = render(view()); const signal = vi.mocked(listProjectItems).mock.calls[0][2]!;
    rendered.rerender(view(change === "token" ? "next" : "token", change === "project" ? "next-project" : "project"));
    expect(signal.aborted).toBe(true); await screen.findByText("还没有研究资料"); await act(async () => resolve({ items: [item] })); expect(screen.queryByText(item.title)).toBeNull();
  });
  it("unmount aborts pending delete", async () => {
    vi.mocked(removeProjectItem).mockReturnValue(new Promise(() => {})); const rendered = render(view()); await screen.findByText(item.title);
    await userEvent.click(screen.getByRole("button", { name: "移出项目" })); const signal = vi.mocked(removeProjectItem).mock.calls[0][3]!; rendered.unmount(); expect(signal.aborted).toBe(true);
  });
});

it("does not prefetch Notes; removal409 retains both material and its open Note", async () => {
  const revision = { revisionId: "r1", revisionNo: 1, contentFormat: "MARKDOWN" as const, content: "保留的研究笔记", contentSha256: "a".repeat(64), createdAt: item.addedAt };
  vi.mocked(getProjectItemNote).mockResolvedValue({note: {noteId:"note",projectId:item.projectId,subjectBindingId:item.bindingId,subjectId:item.editionId,createdAt:item.addedAt,updatedAt:item.addedAt,currentRevision:revision,revisions:[revision]}});
  vi.mocked(removeProjectItem).mockRejectedValue(new ProjectApiError(409,"这项资料已有研究笔记，暂不能直接移出项目。","PROJECT_ITEM_HAS_NOTE"));
  render(view()); await screen.findByText(item.title); expect(getProjectItemNote).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button",{name:"研究笔记"})); await screen.findByText("保留的研究笔记");
  await userEvent.click(screen.getByRole("button",{name:"移出项目"}));
  expect((await screen.findByRole("alert")).textContent).toBe("这项资料已有研究笔记，暂不能直接移出项目。");
  expect(screen.getByText("保留的研究笔记")).toBeTruthy(); expect(screen.getByText(item.title)).toBeTruthy(); expect(getProjectItemNote).toHaveBeenCalledOnce();
});
