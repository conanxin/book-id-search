// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { ProjectCard, ProjectDetails, ProjectWorkspace } from "./ProjectsPage";
import { createProject, listProjects, addCatalogBookToProject, listProjectItems, removeProjectItem } from "./api";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.resetModules(); });
describe("S32 access and client", () => {
  it("falls back to memory and clears it when session storage is unavailable", async () => {
    vi.stubGlobal("sessionStorage", { getItem() { throw Error(); }, setItem() { throw Error(); }, removeItem() { throw Error(); } });
    const access = await import("./access");
    expect(access.getS32Token()).toBeNull();
    access.saveS32Token(" independent-token "); expect(access.getS32Token()).toBe("independent-token");
    access.saveS32Token(null); expect(access.getS32Token()).toBeNull();
  });
  it("uses an independent storage key and does not clear WeRead", async () => {
    const values = new Map([["book-id-search:weread-private-token", "weread"]]);
    vi.stubGlobal("sessionStorage", { getItem: (k: string) => values.get(k), setItem: (k: string, v: string) => values.set(k, v), removeItem: (k: string) => values.delete(k) });
    const access = await import("./access");
    expect(access.getS32Token()).toBeNull(); access.saveS32Token("s32");
    expect(values.get(access.S32_TOKEN_KEY)).toBe("s32"); access.saveS32Token(null);
    expect(values.get("book-id-search:weread-private-token")).toBe("weread");
  });
  it("uses same-origin, no-store private requests without automatically retrying POST", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: "secret internal URL" } }), { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(createProject("private", { name: "项目", description: null })).rejects.toThrow("服务暂不可用");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]).toMatchObject(["/api/private/s32/projects", { cache: "no-store", method: "POST", headers: { Authorization: "Bearer private" } }]);
  });
  it("never turns failed/malformed list responses into an empty list", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("unavailable", { status: 503 })));
    await expect(listProjects("token")).rejects.toThrow();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 200 })));
    await expect(listProjects("token")).rejects.toThrow("响应异常");
  });
});
describe("project presentation", () => {
  const project = { id: "unique-id", name: "北京古道研究", description: "<script>alert(1)</script>\n梳理历史地图", lifecycleState: "ACTIVE" as const, createdAt: "2026-09-19T00:00:00Z", updatedAt: "2026-09-19T00:00:00Z" };
  it("links cards by identity and displays plain text, without pretend actions/counts", () => {
    const html = renderToStaticMarkup(<MemoryRouter><ProjectCard project={project} /></MemoryRouter>);
    expect(html).toContain("/research/projects/unique-id"); expect(html).toContain("北京古道研究");
    expect(html).toContain("&lt;script&gt;"); expect(html).not.toContain("<script>");
    expect(html).not.toMatch(/笔记数|资料数|加入书目|写笔记/);
  });
  it("shows purpose and dates, and handles an omitted description", () => {
    const html = renderToStaticMarkup(<ProjectDetails project={{ ...project, description: null }} />);
    expect(html).toContain("尚未填写研究目的"); expect(html).toContain("创建时间"); expect(html).toContain("更新时间");
  });
});

describe("M1-E Project Workspace", () => {
  const projectId = "11111111-1111-4111-8111-111111111111";
  const overview = {
    project: { id: projectId, name: "北京古道研究", description: "梳理路线", lifecycleState: "ACTIVE" as const, readOnly: false, createdAt: "2026-09-19T00:00:00Z", updatedAt: "2026-09-20T00:00:00Z" },
    summary: { itemCount: 1, noteCount: 1, lastActivityAt: "2026-09-20T08:00:00Z" },
    items: [{ bindingId: "22222222-2222-4222-8222-222222222222", workId: "33333333-3333-4333-8333-333333333333", editionId: "44444444-4444-4444-8444-444444444444", sourceId: "55555555-5555-4555-8555-555555555555", catalogBookId: "catalog", title: "北京古道考", publisher: null, publicationDate: null, publicationDatePrecision: "YEAR" as const, isbn: null, addedAt: "2026-09-20T00:00:00Z", activityAt: "2026-09-20T08:00:00Z", noteSummary: { noteId: "66666666-6666-4666-8666-666666666666", currentRevisionId: "77777777-7777-4777-8777-777777777777", currentRevisionNo: 2, excerpt: "R2", updatedAt: "2026-09-20T08:00:00Z" } }],
  };

  it("loads one direct Overview instead of separate Project and items requests", async () => {
    const fetchMock = vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith("/issues") ? { project: { id: projectId, name: "北京古道研究", lifecycleState: "ACTIVE", readOnly: false }, issues: [] } : overview)));
    vi.stubGlobal("fetch", fetchMock);
    render(<MemoryRouter initialEntries={[`/research/projects/${projectId}?item=${overview.items[0].bindingId}`]}><ProjectWorkspace token="token" projectId={projectId} /></MemoryRouter>);
    expect(await screen.findByRole("heading", { name: "北京古道研究" })).toBeTruthy();
    expect(document.querySelector(".research-overview-summary")?.textContent).toContain("资料1");
    expect(document.querySelector(".research-overview-summary")?.textContent).toContain("笔记1");
    expect(document.querySelector(".research-overview-summary")?.textContent).toContain("最近活动");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledWith(`/api/private/s32/projects/${projectId}/overview`, expect.objectContaining({ cache: "no-store" }));
  });

  it("shows archived read-only identity from the Overview", async () => {
    const archived = { ...overview, project: { ...overview.project, lifecycleState: "ARCHIVED" as const, readOnly: true } };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith("/issues") ? { project: { id: projectId, name: "北京古道研究", lifecycleState: "ARCHIVED", readOnly: true }, issues: [] } : archived))));
    render(<MemoryRouter><ProjectWorkspace token="token" projectId={projectId} /></MemoryRouter>);
    expect(await screen.findByText("已归档 · 只读")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("研究笔记 · v2")).toBeTruthy());
  });
});

describe("M1-C same-origin client", () => {
  const item = { bindingId: "binding", projectId: "project", workId: "work", editionId: "edition", sourceId: "source", catalogBookId: "catalog", title: "北京古道考", publisher: null, publicationDate: null, publicationDatePrecision: "YEAR", isbn: null, addedAt: "2026-09-20T00:00:00Z" };
  it("uses same-origin no-store add/list/remove and only sends bookId", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ promotionStatus: "created", bindingStatus: "created", item }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [item] })))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await addCatalogBookToProject("token", "project", "catalog")).toMatchObject({ item });
    expect(await listProjectItems("token", "project")).toEqual({ items: [item] });
    await expect(removeProjectItem("token", "project", "binding")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0]).toMatchObject(["/api/private/s32/projects/project/catalog-books", { method: "POST", cache: "no-store", body: '{"bookId":"catalog"}', headers: { Authorization: "Bearer token" } }]);
    expect(fetchMock.mock.calls[1]).toMatchObject(["/api/private/s32/projects/project/items", { method: "GET", cache: "no-store" }]);
    expect(fetchMock.mock.calls[2]).toMatchObject(["/api/private/s32/projects/project/items/binding", { method: "DELETE", cache: "no-store" }]);
  });
  it.each([409,503])("does not retry or reflect server details on %s", async status => {
    const f = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ error: { message: "SECRET" } }), { status })); vi.stubGlobal("fetch", f);
    await expect(addCatalogBookToProject("token", "project", "catalog")).rejects.toThrow(status === 409 ? "冲突" : "服务暂不可用");
    expect(f).toHaveBeenCalledOnce();
    await expect(removeProjectItem("token", "project", "binding")).rejects.not.toThrow("SECRET"); expect(f).toHaveBeenCalledTimes(2);
  });
  it.each([{}, { items: {} }, { items: [null] }])("rejects malformed item lists %j", async body => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body))));
    await expect(listProjectItems("token", "project")).rejects.toThrow("响应异常");
  });
  it("rejects a fake successful add or delete response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ item: {} }))));
    await expect(addCatalogBookToProject("token", "project", "catalog")).rejects.toThrow("响应异常");
    await expect(removeProjectItem("token", "project", "binding")).rejects.toThrow("响应异常");
  });
  it("encodes path segments and passes abort signals", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ items: [] }))); vi.stubGlobal("fetch", f);
    const signal = new AbortController().signal; await listProjectItems("token", "a/b", signal);
    expect(f).toHaveBeenCalledWith("/api/private/s32/projects/a%2Fb/items", expect.objectContaining({ signal }));
  });
});
