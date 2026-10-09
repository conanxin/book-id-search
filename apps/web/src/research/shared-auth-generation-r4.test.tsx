// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import {
  __resetWebAuthStoreForTests, __setWebAuthSnapshotForTests,
} from "../auth/session";
import { getProjectOverview, getResearchIssue, listProjects, ProjectApiError } from "./api";
import type { Project, ProjectOverview, ResearchIssueDetailResponse } from "./api";

// Real ProjectWorkspace and ResearchIssueDetail render here; only unrelated
// feature children and network endpoints are stubbed to isolate route lifetime.
vi.mock("../auth/useWebAuthSession", async () => {
  const react = await import("react");
  const auth = await import("../auth/session");
  return {
    useWebAuthSession: () => react.useSyncExternalStore(
      auth.subscribeWebAuth, auth.getWebAuthSnapshot, auth.getWebAuthSnapshot,
    ),
  };
});
vi.mock("../auth/GoogleLoginPanel", () => ({ GoogleLoginPanel: () => <div>test login shell</div> }));
vi.mock("./api", async importOriginal => ({
  ...await importOriginal<typeof import("./api")>(),
  listProjects: vi.fn(),
  getProjectOverview: vi.fn(),
  getResearchIssue: vi.fn(),
}));
vi.mock("./ProjectItems", () => ({ ProjectItems: () => null }));
vi.mock("./ResearchIssues", () => ({
  ResearchIssuesSection: () => null,
  useProjectResearchIssues: () => ({
    result: { state: "loading", response: null, error: "" }, retry: () => {},
  }),
}));
vi.mock("./CandidateClaims", () => ({ CandidateClaims: () => null }));
vi.mock("./IssueResolutionComposer", () => ({ IssueResolutionComposer: () => null }));
vi.mock("./IssueResolutionCurrent", () => ({ IssueResolutionCurrent: () => null }));
vi.mock("./IssueResolutionHistory", () => ({ IssueResolutionHistory: () => null }));
vi.mock("./ResearchRunHistory", () => ({ ResearchRunHistory: () => null }));
vi.mock("./ResearchRunStartComposer", () => ({ ResearchRunStartComposer: () => null }));

const P = "11111111-1111-4111-8111-111111111111";
const I = "22222222-2222-4222-8222-222222222222";
const D = "2026-10-09T00:00:00.000Z";
const auth = (token: string, email: string) => ({
  status: "authenticated" as const,
  user: { email, name: email },
  csrfToken: token,
  error: null,
});
const project = (name: string) => ({
  id: P, name, description: "synthetic private project",
  lifecycleState: "ACTIVE", readOnly: false, createdAt: D, updatedAt: D,
} as Project);
const overview = (name: string) => ({
  project: project(name),
  summary: { itemCount: 0, noteCount: 0, lastActivityAt: null },
  items: [],
} as ProjectOverview);
const issueDetail = (name: string): ResearchIssueDetailResponse => ({
  project: { id: P, name: "Synthetic Project", lifecycleState: "ACTIVE", readOnly: false },
  issue: { id: I, projectId: P, title: name, question: "Private detail for " + name,
    lifecycleState: "OPEN", createdAt: D, updatedAt: D },
});

async function mount(path: string) {
  const { default: ProjectsPage } = await import("./ProjectsPage");
  return render(<MemoryRouter initialEntries={[path]}>
    <Routes>
      <Route path="/research/projects" element={<ProjectsPage />} />
      <Route path="/research/projects/:projectId" element={<ProjectsPage />} />
      <Route path="/research/projects/:projectId/issues/:issueId" element={<ProjectsPage />} />
    </Routes>
  </MemoryRouter>);
}
function rotateOwner() {
  // Crucially no intermediate unauthenticated render occurs.
  act(() => __setWebAuthSnapshotForTests(auth("csrf-B", "owner-b@example.com")));
}

beforeEach(() => {
  vi.resetAllMocks();
  __resetWebAuthStoreForTests();
  vi.stubEnv("VITE_S32_ENABLED", "true");
  act(() => __setWebAuthSnapshotForTests(auth("csrf-A", "owner-a@example.com")));
});
afterEach(() => {
  cleanup();
  __resetWebAuthStoreForTests();
  vi.unstubAllEnvs();
});

describe("R4 shared Research auth-generation private-state lifetime", () => {
  it("discards the previous owner's project list on auth-to-auth rotation", async () => {
    vi.mocked(listProjects)
      .mockResolvedValueOnce({ projects: [project("Owner A list-only title")] })
      .mockResolvedValueOnce({ projects: [project("Owner B list-only title")] });
    const { container } = await mount("/research/projects");
    expect(await screen.findByText("Owner A list-only title")).toBeTruthy();

    rotateOwner();
    expect(screen.queryByText("Owner A list-only title")).toBeNull();
    expect(await screen.findByText("Owner B list-only title")).toBeTruthy();
    expect(listProjects).toHaveBeenCalledTimes(2);
    expect(container.innerHTML).not.toContain("csrf-A");
    expect(container.innerHTML).not.toContain("csrf-B");
  });

  it("invalidates an already displayed project overview without changing its route", async () => {
    vi.mocked(getProjectOverview)
      .mockResolvedValueOnce(overview("Owner A overview-only title"))
      .mockResolvedValueOnce(overview("Owner B overview-only title"));
    await mount("/research/projects/" + P);
    expect(await screen.findByRole("heading", { name: "Owner A overview-only title" })).toBeTruthy();

    rotateOwner();
    expect(screen.queryByRole("heading", { name: "Owner A overview-only title" })).toBeNull();
    expect(await screen.findByRole("heading", { name: "Owner B overview-only title" })).toBeTruthy();
    expect(getProjectOverview).toHaveBeenCalledTimes(2);
  });

  it("invalidates an Issue detail and its private question on auth-to-auth rotation", async () => {
    vi.mocked(getResearchIssue)
      .mockResolvedValueOnce(issueDetail("Owner A issue-only title"))
      .mockResolvedValueOnce(issueDetail("Owner B issue-only title"));
    await mount("/research/projects/" + P + "/issues/" + I);
    expect(await screen.findByRole("heading", { name: "Owner A issue-only title" })).toBeTruthy();

    rotateOwner();
    expect(screen.queryByText("Private detail for Owner A issue-only title")).toBeNull();
    expect(await screen.findByRole("heading", { name: "Owner B issue-only title" })).toBeTruthy();
    expect(getResearchIssue).toHaveBeenCalledTimes(2);
  });

  it("invalidates a pending old-owner project list read even if the backend finishes late", async () => {
    let resolveOld!: (value: { projects: Project[] }) => void;
    let oldSignal: AbortSignal | undefined;
    vi.mocked(listProjects)
      .mockImplementationOnce(signal => {
        oldSignal = signal;
        return new Promise(resolve => { resolveOld = resolve; });
      })
      .mockResolvedValueOnce({ projects: [project("Owner B fresh project")] });
    await mount("/research/projects");
    await waitFor(() => expect(oldSignal).toBeDefined());

    rotateOwner();
    expect(oldSignal?.aborted).toBe(true);
    expect(await screen.findByText("Owner B fresh project")).toBeTruthy();
    await act(async () => { resolveOld({ projects: [project("Owner A delayed private project")] }); });
    expect(screen.queryByText("Owner A delayed private project")).toBeNull();
  });

  it("does not preserve previous Owner's Issue detail when new Owner is denied", async () => {
    vi.mocked(getResearchIssue)
      .mockResolvedValueOnce(issueDetail("Owner A denied-later Issue"))
      .mockRejectedValueOnce(new ProjectApiError(404, "not available"));
    await mount("/research/projects/" + P + "/issues/" + I);
    expect(await screen.findByText("Private detail for Owner A denied-later Issue")).toBeTruthy();

    rotateOwner();
    expect(screen.queryByText("Private detail for Owner A denied-later Issue")).toBeNull();
    expect((await screen.findByRole("alert")).textContent).toContain("研究问题不存在，或不属于当前项目");
    expect(getResearchIssue).toHaveBeenCalledTimes(2);
  });
});
