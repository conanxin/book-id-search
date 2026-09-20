import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { createPostgresProjectBindingStore } from "./project-binding-store.js";
import { EditionNotAvailableError, ProjectBindingStoreUnavailableError, ProjectNotActiveError, ProjectNotFoundError } from "../application/project-items.js";
import { ProjectItemHasNoteError } from "../application/project-item-notes.js";
const row = { binding_id: "binding", project_id: "project", work_id: "work", edition_id: "edition", title: "北京古道考", publisher: "出版社", publication_date: "2001-02-03", publication_date_precision: "DAY", isbn: "isbn", created_at: new Date("2026-09-20T00:00:00Z"), metadata: { catalogBookId: "book", sourceId: "source" } };
const input = { projectId: "project", workId: "work", editionId: "edition", sourceId: "source", catalogBookId: "book" };
function fake(options: { project?: object | null; edition?: boolean; duplicate?: boolean; error?: unknown; metadata?: unknown; removed?: boolean; hasNote?: boolean; deleteError?: Error } = {}) {
  const query = vi.fn(async (sql: string) => {
    if (options.error) throw options.error;
    if (sql.startsWith("SELECT lifecycle_state")) return { rows: options.project === null ? [] : [options.project ?? { lifecycle_state: "ACTIVE" }] };
    if (sql.startsWith("SELECT id FROM core.editions")) return { rows: options.edition === false ? [] : [{ id: "edition" }] };
    if (sql.startsWith("SELECT id FROM core.project_bindings")) return { rows: options.removed === false ? [] : [{ id: "binding" }] };
    if (sql.startsWith("SELECT 1 FROM core.project_bindings")) return { rows: options.hasNote ? [{ exists: 1 }] : [] };
    if (sql.startsWith("INSERT")) return { rows: options.duplicate ? [] : [{ id: "binding" }] };
    if (sql.startsWith("DELETE") && options.deleteError) throw options.deleteError;
    if (sql.startsWith("DELETE")) return { rows: [], rowCount: options.removed === false ? 0 : 1 };
    return { rows: [{ ...row, metadata: Object.hasOwn(options, "metadata") ? options.metadata : row.metadata }] };
  });
  const release = vi.fn(); const pool = { query, connect: vi.fn(async () => ({ query, release })) };
  return { store: createPostgresProjectBindingStore(pool as unknown as Pool), query, release };
}
describe("Postgres project binding store", () => {
  it.each(["ECONNREFUSED", "08006", "57P01", "53300"])("classifies unavailable %s", async code => {
    const s = fake({ error: Object.assign(new Error("secret"), { code }) });
    await expect(s.store.listEditionItems("project")).rejects.toBeInstanceOf(ProjectBindingStoreUnavailableError);
  });
  it("preserves unexpected SQL errors for generic route handling", async () => {
    const error = Object.assign(new Error("secret sql"), { code: "42601" });
    await expect(fake({ error }).store.listEditionItems("project")).rejects.toBe(error);
  });
  it.each([null, [], "wrong", {}, { catalogBookId: 42, sourceId: [] }, { catalogBookId: "  ", sourceId: "" }])("tolerates legacy metadata %j", async metadata => {
    const items = await fake({ metadata }).store.listEditionItems("project");
    expect(items[0]).toMatchObject({ title: "北京古道考", catalogBookId: null, sourceId: null, publicationDate: "2001-02-03" });
  });
  it("projects canonical fields and keeps a stable Edition-only list", async () => {
    const s = fake(); expect(await s.store.listEditionItems("project")).toEqual([{ bindingId: "binding", projectId: "project", workId: "work", editionId: "edition", title: "北京古道考", publisher: "出版社", publicationDate: "2001-02-03", publicationDatePrecision: "DAY", isbn: "isbn", addedAt: "2026-09-20T00:00:00.000Z", catalogBookId: "book", sourceId: "source" }]);
    expect(s.query.mock.calls[0][0]).toMatch(/pb.created_at DESC, pb.id DESC/);
  });
  it.each([false, true])("inserts or reuses binding without replacing metadata: duplicate=%s", async duplicate => {
    const s = fake({ duplicate }); const result = await s.store.addEdition(input);
    expect(result.status).toBe(duplicate ? "existing" : "created"); expect(result.item.bindingId).toBe("binding");
    const call = s.query.mock.calls.find(([sql]) => sql.startsWith("INSERT"))!;
    expect(call[0]).toMatch(/DO NOTHING/); expect(call[0]).not.toMatch(/DO UPDATE/);
    const args = (call as unknown as [string, unknown[]])[1];
    expect(JSON.parse(args[3] as string)).toEqual({ addedVia: "BOOK_ID_SEARCH_CATALOG", catalogBookId: "book", sourceId: "source" });
    expect(s.release).toHaveBeenCalledOnce();
  });
  it.each([[{ project: null }, ProjectNotFoundError], [{ project: { lifecycle_state: "ARCHIVED" } }, ProjectNotActiveError], [{ edition: false }, EditionNotAvailableError]] as const)("fails before insert for missing/inactive parent %j", async (options, error) => {
    const s = fake(options); await expect(s.store.addEdition(input)).rejects.toBeInstanceOf(error);
    expect(s.query.mock.calls.some(([sql]) => sql.startsWith("INSERT"))).toBe(false); expect(s.release).toHaveBeenCalledOnce();
  });
  it.each([true, false])("removes only owned Edition binding, found=%s", async removed => {
    const s = fake({ removed }); expect(await s.store.removeEdition({ projectId: "project", bindingId: "binding" })).toBe(removed);
    expect(s.query.mock.calls[0][0]).toBe("BEGIN");
    expect(s.query).toHaveBeenCalledWith(expect.stringMatching(/SELECT id FROM core.project_bindings[\s\S]*id = \$1[\s\S]*project_id = \$2[\s\S]*target_type = 'EDITION'[\s\S]*FOR UPDATE/), ["binding", "project"]);
    if (removed) expect(s.query).toHaveBeenCalledWith(expect.stringMatching(/DELETE FROM core.project_bindings[\s\S]*id = \$1[\s\S]*project_id = \$2[\s\S]*target_type = 'EDITION'/), ["binding", "project"]);
    else expect(s.query.mock.calls.some(([sql]) => sql.startsWith("DELETE"))).toBe(false);
    expect(s.query.mock.calls.at(-1)![0]).toBe("COMMIT"); expect(s.release).toHaveBeenCalledOnce();
  });
  it("rejects removal when any NOTE binding references the canonical locked subject id", async () => {
    const s = fake({ hasNote: true });
    await expect(s.store.removeEdition({ projectId: "project", bindingId: "BINDING" })).rejects.toBeInstanceOf(ProjectItemHasNoteError);
    expect(s.query).toHaveBeenCalledWith(expect.stringMatching(/SELECT 1 FROM core.project_bindings[\s\S]*target_type = 'NOTE'[\s\S]*subjectBindingId/), ["project", "binding"]);
    expect(s.query.mock.calls.some(([sql]) => sql.startsWith("DELETE"))).toBe(false);
    expect(s.query).toHaveBeenCalledWith("ROLLBACK"); expect(s.release).toHaveBeenCalledOnce();
  });
  it.each(["ECONNRESET", "42601"])("rolls back delete failure with safe classification %s", async code => {
    const error = Object.assign(new Error("private SQL"), { code }); const s = fake({ deleteError: error });
    const operation = s.store.removeEdition({ projectId: "project", bindingId: "binding" });
    if (code === "ECONNRESET") await expect(operation).rejects.toBeInstanceOf(ProjectBindingStoreUnavailableError);
    else await expect(operation).rejects.toBe(error);
    expect(s.query).toHaveBeenCalledWith("ROLLBACK"); expect(s.release).toHaveBeenCalledOnce();
  });
});
