import { describe, expect, it, vi } from "vitest";
import { createProjectItemNotesService, type ProjectItemNoteStore } from "./project-item-notes.js";
import { sha256NoteContent } from "../domain/note.js";

const projectId = "11111111-abcd-4111-8111-111111111111";
const bindingId = "22222222-abcd-4222-8222-222222222222";
const revisionId = "33333333-abcd-4333-8333-333333333333";
function fake() {
  const store = { get: vi.fn<ProjectItemNoteStore["get"]>().mockResolvedValue(null), create: vi.fn<ProjectItemNoteStore["create"]>(), appendRevision: vi.fn<ProjectItemNoteStore["appendRevision"]>(), getRevision: vi.fn<ProjectItemNoteStore["getRevision"]>() };
  return { store, service: createProjectItemNotesService(store) };
}
describe("project item notes service", () => {
  it("normalizes content before create and passes the exact saved-content hash", async () => {
    const { store, service } = fake();
    await service.create(projectId, bindingId, { content: " a\r\nb\rc " });
    expect(store.create).toHaveBeenCalledWith({ projectId, bindingId, content: " a\nb\nc ", contentSha256: sha256NoteContent(" a\nb\nc ") });
  });
  it("validates append base and normalizes without trimming", async () => {
    const { store, service } = fake();
    await service.append(projectId, bindingId, { baseRevisionId: revisionId, content: "a\r\nb  " });
    expect(store.appendRevision).toHaveBeenCalledWith({ projectId, bindingId, baseRevisionId: revisionId, content: "a\nb  ", contentSha256: sha256NoteContent("a\nb  ") });
  });
  it("canonicalizes UUID casing for subject association and stale-base equality", async () => {
    const { store, service } = fake();
    await service.append(projectId.toUpperCase(), bindingId.toUpperCase(), { baseRevisionId: revisionId.toUpperCase(), content: "draft" });
    expect(store.appendRevision).toHaveBeenCalledWith(expect.objectContaining({ projectId, bindingId, baseRevisionId: revisionId }));
  });
  it("reads nullable current and owned revision with validated identifiers", async () => {
    const { store, service } = fake();
    expect(await service.get(projectId, bindingId)).toBeNull();
    await service.getRevision(projectId, bindingId, revisionId);
    expect(store.get).toHaveBeenCalledWith({ projectId, bindingId });
    expect(store.getRevision).toHaveBeenCalledWith({ projectId, bindingId, revisionId });
  });
  it.each(["get", "create", "append", "getRevision"] as const)("%s rejects forged subject ids before store access", async method => {
    const { store, service } = fake();
    const third = method === "getRevision" ? revisionId : { baseRevisionId: revisionId, content: "valid" };
    for (const ids of [["forged", bindingId], [projectId, "forged"]]) {
      await expect((service[method] as (...args: unknown[]) => Promise<unknown>)(...ids, third)).rejects.toThrow();
    }
    for (const fn of Object.values(store)) expect(fn).not.toHaveBeenCalled();
  });
  it.each([null, [], "body", {}, { content: " \r\n " }, { content: "汉".repeat(21846) }])("rejects invalid create body before store %j", async body => {
    const { store, service } = fake();
    await expect(service.create(projectId, bindingId, body)).rejects.toThrow();
    expect(store.create).not.toHaveBeenCalled();
  });
  it.each([null, {}, { baseRevisionId: "forged", content: "text" }, { baseRevisionId: revisionId, content: "" }])("rejects invalid append body before store %j", async body => {
    const { store, service } = fake();
    await expect(service.append(projectId, bindingId, body)).rejects.toThrow();
    expect(store.appendRevision).not.toHaveBeenCalled();
  });
  it("rejects forged historical revision id before store", async () => {
    const { store, service } = fake();
    await expect(service.getRevision(projectId, bindingId, "forged")).rejects.toThrow();
    expect(store.getRevision).not.toHaveBeenCalled();
  });
  it.each(["get", "create", "append", "getRevision"] as const)("%s preserves store errors for safe route mapping", async method => {
    const { store, service } = fake(); const error = new Error("store failure");
    for (const fn of Object.values(store)) fn.mockRejectedValue(error);
    const third = method === "getRevision" ? revisionId : { baseRevisionId: revisionId, content: "valid" };
    await expect((service[method] as (...args: unknown[]) => Promise<unknown>)(projectId, bindingId, third)).rejects.toBe(error);
  });
});
