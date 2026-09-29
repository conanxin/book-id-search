// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetWebAuthStoreForTests,
  __setWebAuthSnapshotForTests,
} from "../auth/session";
import {
  addCatalogBookToProject,
  createProject,
  createResearchIssue,
  listProjects,
  removeProjectItem,
  ProjectApiError,
} from "./api";

function seedAuthenticated(csrf: string | null = "csrf-current") {
  __setWebAuthSnapshotForTests({
    status: "authenticated",
    user: { email: "owner@example.com", name: "Owner" },
    csrfToken: csrf,
    error: null,
  });
}
function seedUnauthenticated() {
  __setWebAuthSnapshotForTests({ status: "unauthenticated", user: null, csrfToken: null, error: null });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("research api session contract (Task 8 §八)", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    __resetWebAuthStoreForTests();
  });
  afterEach(() => {
    (globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;
    vi.unstubAllGlobals();
    __resetWebAuthStoreForTests();
  });

  it("1 authenticated GET → credentials same-origin, no Authorization, no X-CSRF", async () => {
    seedAuthenticated();
    const fetchMock = vi.fn(async (_url: unknown, _init?: unknown) => jsonResponse({ projects: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await listProjects();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/private/s32/projects");
    expect(init).toMatchObject({ method: "GET", cache: "no-store", credentials: "same-origin" });
    expect(init.headers).not.toHaveProperty("Authorization");
    expect(JSON.stringify(init.headers)).not.toContain("X-CSRF-Token");
  });

  it("2 authenticated POST → X-CSRF exact current snapshot", async () => {
    seedAuthenticated("csrf-exact-1");
    const fetchMock = vi.fn(async (_url: unknown, _init?: unknown) => jsonResponse({ project: { id: "p1" } }));
    vi.stubGlobal("fetch", fetchMock);
    await createProject({ name: "n", description: null });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toMatchObject({ "X-CSRF-Token": "csrf-exact-1" });
    expect(init.credentials).toBe("same-origin");
  });

  it("3 authenticated DELETE → X-CSRF", async () => {
    seedAuthenticated("csrf-del");
    const fetchMock = vi.fn(async (_url: unknown, _init?: unknown) => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    await removeProjectItem("project", "binding");
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("DELETE");
    expect(init.headers).toMatchObject({ "X-CSRF-Token": "csrf-del" });
  });

  it("4 idempotency header and csrf coexist on POST", async () => {
    seedAuthenticated("csrf-idem");
    const fetchMock = vi.fn(async (_url: unknown, _init?: unknown) => jsonResponse({
      project: { id: "11111111-1111-4111-8111-111111111111", name: "P", lifecycleState: "ACTIVE", readOnly: false },
      issue: { id: "22222222-2222-4222-8222-222222222222", projectId: "11111111-1111-4111-8111-111111111111", title: "t", question: "q", lifecycleState: "OPEN", createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    await createResearchIssue("project", "idem-key-1", { title: "t", question: "q" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/issues");
    expect(init.headers).toMatchObject({ "X-CSRF-Token": "csrf-idem", "Idempotency-Key": "idem-key-1" });
  });

  it("5 Content-Type preserved on body requests, absent on GET", async () => {
    seedAuthenticated();
    const fetchMock = vi.fn(async (_url: unknown, _init?: unknown) => jsonResponse({ projects: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await listProjects();
    expect(JSON.stringify(fetchMock.mock.calls[0][1].headers)).not.toContain("Content-Type");
    const postMock = vi.fn(async (_url: unknown, _init?: unknown) => jsonResponse({ project: { id: "x" } }));
    vi.stubGlobal("fetch", postMock);
    await createProject({ name: "n", description: null });
    expect((postMock.mock.calls[0] as [string, RequestInit])[1].headers).toMatchObject({ "Content-Type": "application/json" });
  });

  it("6 unauthenticated → no fetch + safe ProjectApiError", async () => {
    seedUnauthenticated();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(listProjects()).rejects.toThrow("请先使用 Google 登录。");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("7 unsafe authenticated but csrf missing → no fetch", async () => {
    seedAuthenticated(null);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(createProject({ name: "n", description: null })).rejects.toThrow("登录安全校验失败");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("8 backend 401 → safe message, raw body not echoed", async () => {
    seedAuthenticated();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: { message: "SECRET-INTERNAL id_token exp" } }, 401)));
    await expect(listProjects()).rejects.toThrow("登录已失效，请重新登录。");
  });

  it("9 backend 403 → safe session-security message", async () => {
    seedAuthenticated();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: { message: "csrf mismatch SECRET" } }, 403)));
    await expect(listProjects()).rejects.toThrow("登录安全校验失败，请刷新后重试。");
  });

  it("10 backend 401 triggers one authoritative session refresh", async () => {
    seedAuthenticated();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("{}", { status: 401 }))
      .mockResolvedValueOnce(jsonResponse({ authenticated: false }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(listProjects()).rejects.toThrow();
    await new Promise(r => setTimeout(r, 20));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe("/api/auth/session");
  });

  it("11 response validation / DELETE 204 contract preserved", async () => {
    seedAuthenticated();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({}, 200)));
    await expect(removeProjectItem("p", "b")).rejects.toThrow("响应异常");
    seedAuthenticated();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
    await expect(removeProjectItem("p", "b")).resolves.toBeUndefined();
  });

  it("12 no token/session/csrf storage write across calls", async () => {
    seedAuthenticated();
    const setSpy = vi.spyOn(sessionStorage, "setItem");
    const localSpy = vi.spyOn(localStorage, "setItem");
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ projects: [] })));
    await listProjects();
    expect(setSpy).not.toHaveBeenCalled();
    expect(localSpy).not.toHaveBeenCalled();
  });
});
