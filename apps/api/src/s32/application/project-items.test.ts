import { describe, expect, it, vi } from "vitest";
import { createProjectItemsService, ProjectNotFoundError, ProjectNotActiveError, ProjectBindingNotFoundError } from "./project-items.js";
import type { ProjectResearchItem } from "../domain/project-item.js";
const projectId = "11111111-1111-4111-8111-111111111111";
const bindingId = "55555555-5555-4555-8555-555555555555";
const project = { id: projectId, name: "北京古道研究", description: null, lifecycleState: "ACTIVE" as const, createdAt: "2026-09-20T00:00:00Z", updatedAt: "2026-09-20T00:00:00Z" };
const promotion = { status: "created" as const, workId: "22222222-2222-4222-8222-222222222222", editionId: "33333333-3333-4333-8333-333333333333", sourceId: "44444444-4444-4444-8444-444444444444", catalogBookId: "13000000" };
const item: ProjectResearchItem = { ...promotion, bindingId, projectId, title: "北京古道考", publisher: null, publicationDate: null, publicationDatePrecision: "YEAR", isbn: null, addedAt: project.createdAt };
function setup() {
  const calls: string[] = [];
  const projects = { get: vi.fn(async (): Promise<typeof project | null> => { calls.push("project"); return project; }) };
  const promotionCommand = { execute: vi.fn(async () => { calls.push("promotion"); return promotion; }) };
  const bindings = {
    addEdition: vi.fn(async () => { calls.push("binding"); return { status: "created" as const, item }; }),
    listEditionItems: vi.fn(async () => [item]), removeEdition: vi.fn(async () => true),
  };
  return { service: createProjectItemsService({ projects, promotionCommand, bindings }), calls, projects, promotionCommand, bindings };
}
describe("project item service", () => {
  it("checks project before promotion and binds only server canonical IDs", async () => {
    const s = setup();
    const result = await s.service.addCatalogBook(projectId, { bookId: " 13000000 ", editionId: "forged" });
    expect(s.calls).toEqual(["project", "promotion", "binding"]);
    expect(s.promotionCommand.execute).toHaveBeenCalledWith({ bookId: "13000000" });
    const { status: _, ...ids } = promotion;
    expect(s.bindings.addEdition).toHaveBeenCalledWith({ projectId, ...ids });
    expect(result).toEqual({ promotionStatus: "created", bindingStatus: "created", item });
  });
  it.each([null, { ...project, lifecycleState: "ARCHIVED" }])("blocks all operations for missing/inactive project %j", async value => {
    const s = setup(); s.projects.get.mockResolvedValue(value as typeof project);
    const error = value ? ProjectNotActiveError : ProjectNotFoundError;
    await expect(s.service.addCatalogBook(projectId, { bookId: "13000000" })).rejects.toBeInstanceOf(error);
    await expect(s.service.list(projectId)).rejects.toBeInstanceOf(error);
    await expect(s.service.remove(projectId, bindingId)).rejects.toBeInstanceOf(error);
    expect(s.promotionCommand.execute).not.toHaveBeenCalled();
    Object.values(s.bindings).forEach(fn => expect(fn).not.toHaveBeenCalled());
  });
  it.each([undefined, null, [], {}, { bookId: " " }, { bookId: 4 }])("rejects malformed body before lookup %j", async body => {
    const s = setup(); await expect(s.service.addCatalogBook(projectId, body)).rejects.toThrow();
    expect(s.projects.get).not.toHaveBeenCalled(); expect(s.promotionCommand.execute).not.toHaveBeenCalled();
  });
  it("validates identifiers before store access", async () => {
    const s = setup();
    await expect(s.service.addCatalogBook("bad", { bookId: "13000000" })).rejects.toThrow();
    await expect(s.service.list("bad")).rejects.toThrow();
    await expect(s.service.remove(projectId, "bad")).rejects.toThrow();
    expect(s.projects.get).not.toHaveBeenCalled();
  });
  it("returns canonical items after checking the project", async () => {
    const s = setup(); expect(await s.service.list(projectId)).toEqual([item]);
    expect(s.bindings.listEditionItems).toHaveBeenCalledWith(projectId);
  });
  it("removes by project and binding only; missing returns explicit error", async () => {
    const s = setup(); await s.service.remove(projectId, bindingId);
    expect(s.bindings.removeEdition).toHaveBeenCalledWith({ projectId, bindingId });
    s.bindings.removeEdition.mockResolvedValue(false);
    await expect(s.service.remove(projectId, bindingId)).rejects.toBeInstanceOf(ProjectBindingNotFoundError);
  });
  it("keeps promotion and binding statuses independent", async () => {
    const s = setup(); s.promotionCommand.execute.mockResolvedValue({ ...promotion, status: "existing" } as typeof promotion);
    expect(await s.service.addCatalogBook(projectId, { bookId: "13000000" })).toMatchObject({ promotionStatus: "existing", bindingStatus: "created" });
  });
});
