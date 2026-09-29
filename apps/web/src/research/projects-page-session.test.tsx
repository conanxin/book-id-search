// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.stubEnv("VITE_S32_ENABLED", "true");
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { __resetWebAuthStoreForTests, __setWebAuthSnapshotForTests } from "../auth/session";

vi.mock("../auth/session", async importOriginal => {
  const actual = await importOriginal<typeof import("../auth/session")>();
  return { ...actual, ensureAuthSessionLoaded: vi.fn(async () => {}) };
});
vi.mock("../auth/GoogleLoginPanel", () => ({ GoogleLoginPanel: () => <div data-testid="google-login-panel" /> }));
vi.mock("./api", async importOriginal => ({
  ...await importOriginal<typeof import("./api")>(),
  listProjects: vi.fn(),
  createProject: vi.fn(),
  getProjectOverview: vi.fn(),
  listResearchIssues: vi.fn(),
}));

// Dynamic imports AFTER mocks + env stub so the real ProjectsPage evaluates with
// VITE_S32_ENABLED=true and the mocked api/session modules.
// Sequential imports: ./api first so the vi.mock factory is fully materialized
// before ProjectsPage's module graph resolves its ./api binding.
const apiMod = await import("./api");
const pageMod = await import("./ProjectsPage");
const ProjectsPage = pageMod.default;
const ProjectWorkspace = pageMod.ProjectWorkspace;
// Access mocks through the live module namespace; destructured bindings captured a
// pre-factory snapshot in some orderings and silently bypassed the vi.fn mocks.
const api = apiMod as typeof import("./api");



const project = { id: "11111111-1111-4111-8111-111111111111", name: "北京古道研究", description: null, lifecycleState: "ACTIVE" as const, readOnly: false, createdAt: "2026-09-19T00:00:00Z", updatedAt: "2026-09-19T00:00:00Z" };

function seed(status: "authenticated" | "unauthenticated" | "disabled" | "unavailable" | "error" = "authenticated"): void {
  __setWebAuthSnapshotForTests(status === "authenticated"
    ? { status: "authenticated", user: { email: "owner@example.com", name: "Owner" }, csrfToken: "csrf-test", error: null }
    : { status, user: null, csrfToken: null, error: status === "error" ? "登录状态异常" : null });
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function mount(path = "/research/projects") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/research/projects" element={<ProjectsPage />} />
        <Route path="/research/projects/:projectId" element={<ProjectsPage />} />
        <Route path="/research/projects/:projectId/issues/:issueId" element={<ProjectsPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("ProjectsPage session integration (Task 8 §九)", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    seed("authenticated");
    vi.mocked(api.listProjects).mockResolvedValue({ projects: [project] });
    vi.mocked(api.getProjectOverview).mockResolvedValue({
      project, summary: { itemCount: 0, noteCount: 0, lastActivityAt: "2026-09-19T00:00:00Z" }, items: [],
    } as never);
    vi.mocked(api.listResearchIssues).mockResolvedValue({
      project: { id: project.id, name: project.name, lifecycleState: "ACTIVE", readOnly: false }, issues: [],
    } as never);
  });
  afterEach(() => {
    cleanup();
    __resetWebAuthStoreForTests();
    (globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;
    vi.unstubAllGlobals();
  });

  it("13 logged-out → Google login area present, no private workspace", async () => {
    seed("unauthenticated");
    mount();
    expect(await screen.findByTestId("google-login-panel")).toBeTruthy();
    expect(screen.queryByText("我的项目")).toBeNull();
    expect(api.listProjects).not.toHaveBeenCalled();
  });

  it("14 old S32 credential UI copy is gone", () => {
    seed("authenticated");
    mount();
    expect(document.body.textContent).not.toContain("研究项目访问凭据");
    expect(document.body.textContent).not.toContain("输入独立的 S32 访问凭据");
    expect(document.body.textContent).not.toContain("清除访问凭据");
    expect(document.body.textContent).not.toContain("凭据仅在当前浏览器会话中使用");
  });

  it("15 authenticated → ProjectWorkspace list loads", async () => {
    mount();
    expect(await screen.findByText("北京古道研究", {}, { timeout: 3000 })).toBeTruthy();
    expect(api.listProjects).toHaveBeenCalledWith(expect.any(AbortSignal));
  });

  it("16 authenticated workspace list request goes through the session client (credentials/no-Authorization fixed in session-api §1)", async () => {
    render(<MemoryRouter><ProjectWorkspace /></MemoryRouter>);
    await screen.findByText("北京古道研究");
    expect(api.listProjects).toHaveBeenCalled();
  });

  it("17 create project POST carries current snapshot CSRF (network level)", async () => {
    const fetchMock = vi.fn(async (_url: unknown, _init?: unknown) => jsonResponse({ project }));
    vi.stubGlobal("fetch", fetchMock);
    const realApi = await vi.importActual<typeof import("./api")>("./api");
    await expect(realApi.createProject({ name: "n", description: null })).resolves.toBeDefined();
    const post = fetchMock.mock.calls.find(c => (c[1] as RequestInit).method === "POST")!;
    expect((post[1] as RequestInit).headers).toMatchObject({ "X-CSRF-Token": "csrf-test" });
    expect((post[1] as RequestInit).credentials).toBe("same-origin");
  });

  it("18 session → unauthenticated immediately unmounts private workspace", async () => {
    mount();
    expect(await screen.findByText("北京古道研究")).toBeTruthy();
    act(() => seed("unauthenticated"));
    await waitFor(() => expect(screen.queryByText("北京古道研究")).toBeNull());
    expect(screen.getByTestId("google-login-panel")).toBeTruthy();
  });

  it("19 researchEnabled=false → no private API request", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_S32_ENABLED", "false");
    const freshApi = await import("./api");
    const listProjectsFresh = vi.mocked(freshApi.listProjects);
    listProjectsFresh.mockClear();
    listProjectsFresh.mockResolvedValue({ projects: [] });
    const { default: ProjectsPageFresh } = await import("./ProjectsPage");
    cleanup();
    render(<MemoryRouter initialEntries={["/research/projects"]}><ProjectsPageFresh /></MemoryRouter>);
    expect(await screen.findByText("研究项目功能尚未开启。")).toBeTruthy();
    expect(listProjectsFresh).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
    vi.stubEnv("VITE_S32_ENABLED", "true");
    // restore the module graph the other tests captured at load time
    vi.resetModules();
    vi.doUnmock("./ProjectsPage");
  });

  it.each(["disabled", "unavailable", "error"] as const)("20 auth %s → no private workspace", (status) => {
    seed(status);
    mount();
    expect(screen.queryByText("我的项目")).toBeNull();
    expect(api.listProjects).not.toHaveBeenCalled();
  });

  it("21 authenticated project detail + issue detail stay navigable", async () => {
    const issueId = "22222222-2222-4222-8222-222222222222";
    vi.mocked(api.listResearchIssues).mockResolvedValue({
      project: { id: project.id, name: project.name, lifecycleState: "ACTIVE", readOnly: false },
      issues: [],
    } as never);
    // detail workspace (project route) loads overview + issues
    mount(`/research/projects/${project.id}`);
    expect(await screen.findByRole("heading", { name: "北京古道研究" }, { timeout: 3000 })).toBeTruthy();
    // detail route: overview + issue chain both load through the session api
    expect(api.getProjectOverview).toHaveBeenCalledWith(project.id, expect.any(AbortSignal));
    expect(api.listResearchIssues).toHaveBeenCalledWith(project.id, expect.any(AbortSignal));
  });
});
