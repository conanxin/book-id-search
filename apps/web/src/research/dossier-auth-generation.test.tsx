// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { __resetWebAuthStoreForTests, __setWebAuthSnapshotForTests } from "../auth/session";

vi.mock("../auth/useWebAuthSession", async () => {
  const react = await import("react");
  const auth = await import("../auth/session");
  return {
    useWebAuthSession: () => react.useSyncExternalStore(auth.subscribeWebAuth, auth.getWebAuthSnapshot, auth.getWebAuthSnapshot),
  };
});
vi.mock("../auth/GoogleLoginPanel", () => ({ GoogleLoginPanel: () => <div>测试 Owner 登录外壳</div> }));
vi.mock("./ResearchDossierPage", () => ({
  ResearchDossierPage: ({ projectId, issueId, authGeneration }: { projectId: string; issueId: string; authGeneration?: number }) =>
    <div data-testid="dossier-auth-scope" data-generation={authGeneration}>{projectId}:{issueId}</div>,
}));

const P = "11111111-1111-4111-8111-111111111111";
const I = "22222222-2222-4222-8222-222222222222";
const auth = (csrfToken: string, email = "owner@example.com") => ({
  status: "authenticated" as const,
  user: { email, name: "Owner" },
  csrfToken,
  error: null,
});

afterEach(() => {
  cleanup();
  __resetWebAuthStoreForTests();
  vi.unstubAllEnvs();
});

describe("Gate 5 Dossier auth-generation isolation", () => {
  it("remounts private view after an authenticated-to-authenticated session rotation", async () => {
    __resetWebAuthStoreForTests();
    vi.stubEnv("VITE_S32_ENABLED", "true");
    const { default: ProjectsPage } = await import("./ProjectsPage");
    act(() => __setWebAuthSnapshotForTests(auth("csrf-alpha")));
    const { container } = render(<MemoryRouter initialEntries={["/research/projects/" + P + "/issues/" + I + "/dossier"]}>
      <Routes><Route path="/research/projects/:projectId/issues/:issueId/dossier" element={<ProjectsPage dossier />} /></Routes>
    </MemoryRouter>);
    const initial = await screen.findByTestId("dossier-auth-scope");
    const generation1 = initial.getAttribute("data-generation");
    expect(generation1).toBeTruthy();

    // No unauthenticated intermediate state; csrf cookie/session rotated.
    act(() => __setWebAuthSnapshotForTests(auth("csrf-beta")));
    const generation2 = (await screen.findByTestId("dossier-auth-scope")).getAttribute("data-generation");
    expect(generation2).not.toBe(generation1);
    expect(container.innerHTML).not.toContain("csrf-alpha");
    expect(container.innerHTML).not.toContain("csrf-beta");

    act(() => __setWebAuthSnapshotForTests(auth("csrf-gamma", "another-owner@example.com")));
    const generation3 = screen.getByTestId("dossier-auth-scope").getAttribute("data-generation");
    expect(generation3).not.toBe(generation2);
  });

  it("clears the private view immediately on sign-out and only restores with a fresh generation", async () => {
    __resetWebAuthStoreForTests();
    vi.stubEnv("VITE_S32_ENABLED", "true");
    const { default: ProjectsPage } = await import("./ProjectsPage");
    act(() => __setWebAuthSnapshotForTests(auth("csrf-before")));
    render(<MemoryRouter initialEntries={["/research/projects/" + P + "/issues/" + I + "/dossier"]}>
      <Routes><Route path="/research/projects/:projectId/issues/:issueId/dossier" element={<ProjectsPage dossier />} /></Routes>
    </MemoryRouter>);
    const previous = screen.getByTestId("dossier-auth-scope").getAttribute("data-generation");
    act(() => __setWebAuthSnapshotForTests({ status: "unauthenticated", user: null, csrfToken: null, error: null }));
    expect(screen.queryByTestId("dossier-auth-scope")).toBeNull();
    act(() => __setWebAuthSnapshotForTests(auth("csrf-after")));
    expect(screen.getByTestId("dossier-auth-scope").getAttribute("data-generation")).not.toBe(previous);
  });
});
