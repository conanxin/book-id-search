// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { AddToProject } from "./AddToProject";
import { saveS32Token } from "./access";
import { listProjects, addCatalogBookToProject, ProjectApiError, type ResearchMembership } from "./api";
const feature = vi.hoisted(() => ({ enabled: true }));
vi.mock("./ProjectsPage", () => ({ get researchEnabled() { return feature.enabled; } }));
vi.mock("./api", async importOriginal => ({ ...await importOriginal<typeof import("./api")>(), listProjects: vi.fn(), addCatalogBookToProject: vi.fn() }));
const project = { id: "project", name: "北京古道研究", description: null, lifecycleState: "ACTIVE" as const, createdAt: "2026-09-20T00:00:00Z", updatedAt: "2026-09-20T00:00:00Z" };
const result = { promotionStatus: "created" as const, bindingStatus: "created" as const, item: { bindingId: "binding", projectId: "project", workId: "work", editionId: "edition", sourceId: "source", catalogBookId: "book", title: "北京古道考", publisher: null, publicationDate: null, publicationDatePrecision: "YEAR" as const, isbn: null, addedAt: project.createdAt } };
const existing: ResearchMembership = { projectId: project.id, projectName: project.name, projectLifecycleState: "ACTIVE", bindingId: "binding", hasNote: false, noteUpdatedAt: null };
const mount = (props: Partial<React.ComponentProps<typeof AddToProject>> = {}) => render(<MemoryRouter><AddToProject bookId="book" bookTitle="北京古道考" {...props} /></MemoryRouter>);
beforeEach(() => { vi.clearAllMocks(); feature.enabled = true; saveS32Token("token"); vi.mocked(listProjects).mockResolvedValue({ projects: [project] }); vi.mocked(addCatalogBookToProject).mockResolvedValue(result); });
afterEach(() => { cleanup(); saveS32Token(null); });
describe("Add to project", () => {
  it("renders nothing with the feature disabled", () => { feature.enabled = false; const { container } = mount(); expect(container.textContent).toBe(""); expect(listProjects).not.toHaveBeenCalled(); });
  it("without token guides to existing credentials UI, without requesting projects", async () => {
    saveS32Token(null); mount(); await userEvent.click(screen.getByRole("button", { name: "加入研究" }));
    expect(screen.getByRole("link", { name: /我的研究项目/ }).getAttribute("href")).toBe("/research/projects");
    expect(screen.queryByRole("textbox")).toBeNull(); expect(listProjects).not.toHaveBeenCalled();
  });
  it("loads on open only and guides creation for zero projects", async () => {
    vi.mocked(listProjects).mockResolvedValue({ projects: [] }); mount(); expect(listProjects).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "加入研究" }));
    expect(await screen.findByText("暂无研究项目")).toBeTruthy(); expect(screen.getByRole("link", { name: "先创建项目" }).getAttribute("href")).toBe("/research/projects");
  });
  it("sends one add, disables pending choices, and shows success only after response", async () => {
    let resolve!: (v: typeof result) => void;
    vi.mocked(addCatalogBookToProject).mockReturnValue(new Promise(r => { resolve = r; }));
    mount(); await userEvent.click(screen.getByRole("button", { name: "加入研究" }));
    const choice = await screen.findByRole("button", { name: "北京古道研究" }); await userEvent.dblClick(choice);
    expect(addCatalogBookToProject).toHaveBeenCalledTimes(1); expect((choice as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText("已加入「北京古道研究」")).toBeNull();
    await act(async () => resolve(result));
    expect(await screen.findByText("已加入「北京古道研究」")).toBeTruthy(); expect(screen.queryByRole("button", { name: "北京古道研究" })).toBeNull();
    expect(addCatalogBookToProject).toHaveBeenCalledWith("token", "project", "book", expect.any(AbortSignal));
  });
  it.each([401,403,503])("list failure %s shows safe error, no fake empty state", async status => {
    vi.mocked(listProjects).mockRejectedValue(new ProjectApiError(status, "服务暂不可用")); mount(); await userEvent.click(screen.getByRole("button", { name: "加入研究" }));
    expect((await screen.findByRole("alert")).textContent).toContain("服务暂不可用"); expect(screen.queryByText("暂无研究项目")).toBeNull();
  });
  it("failed POST keeps selector open and never displays success", async () => {
    vi.mocked(addCatalogBookToProject).mockRejectedValue(new ProjectApiError(503, "服务暂不可用")); mount();
    await userEvent.click(screen.getByRole("button", { name: "加入研究" })); await userEvent.click(await screen.findByRole("button", { name: "北京古道研究" }));
    expect((await screen.findByRole("alert")).textContent).toContain("服务暂不可用"); expect(screen.queryByText("已加入「北京古道研究」")).toBeNull(); expect(screen.getByRole("button", { name: "北京古道研究" })).toBeTruthy(); expect(addCatalogBookToProject).toHaveBeenCalledOnce();
  });
  it("unmount aborts pending list", async () => {
    vi.mocked(listProjects).mockReturnValue(new Promise(() => {})); const view = mount(); await userEvent.click(screen.getByRole("button", { name: "加入研究" }));
    const signal = vi.mocked(listProjects).mock.calls[0][1]!; view.unmount(); expect(signal.aborted).toBe(true);
  });
  it.each(["unmount", "clear token"])("%s aborts pending POST and ignores late success", async action => {
    let resolve!: (v: typeof result) => void; vi.mocked(addCatalogBookToProject).mockReturnValue(new Promise(r => { resolve = r; }));
    const added = vi.fn(); const view = mount({ onAdded: added });
    await userEvent.click(screen.getByRole("button", { name: "加入研究" })); await userEvent.click(await screen.findByRole("button", { name: "北京古道研究" }));
    const signal = vi.mocked(addCatalogBookToProject).mock.calls[0][3]!;
    if (action === "unmount") view.unmount(); else act(() => saveS32Token(null));
    expect(signal.aborted).toBe(true); await act(async () => resolve(result));
    expect(added).not.toHaveBeenCalled(); expect(screen.queryByText("已加入「北京古道研究」")).toBeNull();
  });
  it("clearing credentials clears previous success state", async () => {
    mount(); await userEvent.click(screen.getByRole("button", { name: "加入研究" })); await userEvent.click(await screen.findByRole("button", { name: "北京古道研究" }));
    await screen.findByText("已加入「北京古道研究」"); act(() => saveS32Token(null)); await waitFor(() => expect(screen.queryByText("已加入「北京古道研究」")).toBeNull());
  });
  it("can reopen and explicitly add again after success without a stuck pending state", async () => {
    mount();
    for (let i=0;i<2;i++) {
      await userEvent.click(screen.getByRole("button", { name: "加入研究" }));
      const choice = await screen.findByRole("button", { name: "北京古道研究" });
      expect((choice as HTMLButtonElement).disabled).toBe(false);
      await userEvent.click(choice); await screen.findByText("已加入「北京古道研究」");
    }
    expect(addCatalogBookToProject).toHaveBeenCalledTimes(2);
  });

  it("offers only ACTIVE projects that are not already active memberships", async () => {
    vi.mocked(listProjects).mockResolvedValue({ projects: [
      project,
      { ...project, id: "new", name: "可加入项目" },
      { ...project, id: "archived", name: "归档项目", lifecycleState: "ARCHIVED" },
    ] });
    mount({ memberships: [existing] });
    await userEvent.click(screen.getByRole("button", { name: "加入研究" }));
    expect(await screen.findByRole("button", { name: "可加入项目" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "北京古道研究" })).toBeNull();
    expect(screen.queryByRole("button", { name: "归档项目" })).toBeNull();
  });

  it("explains when every ACTIVE project already contains the book", async () => {
    mount({ memberships: [existing] });
    await userEvent.click(screen.getByRole("button", { name: "加入研究" }));
    expect(await screen.findByText("已加入全部现有研究项目")).toBeTruthy();
    expect(screen.queryByText("暂无研究项目")).toBeNull();
  });

  it("keeps POST success when membership refresh later becomes unavailable", async () => {
    const invalidate = vi.fn();
    const view = mount({ onMembershipInvalidated: invalidate, membershipState: "ready" });
    await userEvent.click(screen.getByRole("button", { name: "加入研究" }));
    await userEvent.click(await screen.findByRole("button", { name: "北京古道研究" }));
    expect(invalidate).toHaveBeenCalledOnce();
    view.rerender(<MemoryRouter><AddToProject bookId="book" bookTitle="北京古道考" onMembershipInvalidated={invalidate} membershipState="unavailable" /></MemoryRouter>);
    expect(await screen.findByText("已加入项目；研究状态暂未能重新确认。")).toBeTruthy();
  });

});
