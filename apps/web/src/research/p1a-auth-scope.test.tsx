// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { AddToProject } from "./AddToProject";
import { ResearchMembershipChips, useSearchMemberships } from "./SearchMemberships";
import { __resetWebAuthStoreForTests, __setWebAuthSnapshotForTests } from "../auth/session";
import { addCatalogBookToProject, getResearchMemberships, listProjects } from "./api";

vi.mock("../auth/session", async importOriginal => {
  const actual = await importOriginal<typeof import("../auth/session")>();
  return { ...actual, ensureAuthSessionLoaded: vi.fn(async () => {}) };
});
vi.mock("./api", async importOriginal => ({
  ...await importOriginal<typeof import("./api")>(),
  addCatalogBookToProject: vi.fn(),
  getResearchMemberships: vi.fn(),
  listProjects: vi.fn(),
}));
vi.mock("./ProjectsPage", () => ({ researchEnabled: true }));

const PID = "11111111-1111-4111-8111-111111111111";
const BID = "22222222-2222-4222-8222-222222222222";
const auth = (csrf: string, email: string) => ({
  status: "authenticated" as const,
  user: { email, name: email },
  csrfToken: csrf,
  error: null,
});
const project = { id: PID, name: "旧 Owner 的私人项目", description: null, lifecycleState: "ACTIVE" as const,
  createdAt: "2026-10-09T01:00:00Z", updatedAt: "2026-10-09T01:00:00Z" };
const membership = { projectId: PID, projectName: project.name, projectLifecycleState: "ACTIVE" as const,
  bindingId: BID, hasNote: false, noteUpdatedAt: null };
const addResult = { promotionStatus: "created" as const, bindingStatus: "created" as const,
  item: { bindingId: BID, projectId: PID, workId: "33333333-3333-4333-8333-333333333333",
    editionId: "44444444-4444-4444-8444-444444444444", sourceId: null,
    catalogBookId: "book-a", title: "测试书", publisher: null, publicationDate: null,
    publicationDatePrecision: "YEAR" as const, isbn: null, addedAt: project.createdAt } };

function MembershipHarness() {
  const view = useSearchMemberships(["book-a"]);
  return <ResearchMembershipChips state={view.state} memberships={view.memberships["book-a"] ?? []} />;
}

beforeEach(() => {
  __resetWebAuthStoreForTests();
  vi.clearAllMocks();
  __setWebAuthSnapshotForTests(auth("csrf-owner-one", "owner-one@example.com"));
  vi.mocked(listProjects).mockResolvedValue({ projects: [project] });
  vi.mocked(addCatalogBookToProject).mockResolvedValue(addResult);
});
afterEach(() => { cleanup(); __resetWebAuthStoreForTests(); });

describe("P1-A auth scope RED regression", () => {
  it("hides the old Owner's private project chips immediately on authenticated-to-authenticated session rotation", async () => {
    vi.mocked(getResearchMemberships).mockResolvedValueOnce({ memberships: { "book-a": [membership] } })
      .mockResolvedValueOnce({ memberships: { "book-a": [] } });
    render(<MemoryRouter><MembershipHarness /></MemoryRouter>);
    expect(await screen.findByRole("link", { name: project.name })).toBeTruthy();
    act(() => __setWebAuthSnapshotForTests(auth("csrf-owner-two", "owner-two@example.com")));
    expect(screen.queryByRole("link", { name: project.name })).toBeNull();
    await waitFor(() => expect(getResearchMemberships).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(project.name)).toBeNull();
  });

  it("discards an old Owner's successful add receipt and project selector on same-status credential rotation", async () => {
    render(<MemoryRouter><AddToProject bookId="book-a" bookTitle="测试书" /></MemoryRouter>);
    await userEvent.click(screen.getByRole("button", { name: "加入研究" }));
    await userEvent.click(await screen.findByRole("button", { name: project.name }));
    expect(await screen.findByText("已加入「旧 Owner 的私人项目」")).toBeTruthy();
    act(() => __setWebAuthSnapshotForTests(auth("csrf-owner-two", "owner-two@example.com")));
    expect(screen.queryByText("已加入「旧 Owner 的私人项目」")).toBeNull();
  });
});
