// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { BookDetailResearchActions } from "./BookDetailResearchActions";
import { __resetWebAuthStoreForTests, __setWebAuthSnapshotForTests, getWebAuthAuthGeneration } from "../auth/session";
import { useWebAuthSession } from "../auth/useWebAuthSession";
import { addCatalogBookToProject, getResearchMemberships, listProjects, ProjectApiError } from "./api";

vi.mock("../auth/session", async importOriginal => {
  const actual = await importOriginal<typeof import("../auth/session")>();
  return { ...actual, ensureAuthSessionLoaded: vi.fn(async () => {}) };
});
vi.mock("./ProjectsPage", () => ({ researchEnabled: true }));
vi.mock("./api", async importOriginal => ({
  ...await importOriginal<typeof import("./api")>(),
  addCatalogBookToProject: vi.fn(),
  getResearchMemberships: vi.fn(),
  listProjects: vi.fn(),
}));

const P = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const T = "2026-10-09T00:00:00Z";
const project = { id: P, name: "京西古道研究", lifecycleState: "ACTIVE" as const,
  description: null, createdAt: T, updatedAt: T };
const member = { projectId: P, projectName: project.name,
  projectLifecycleState: "ACTIVE" as const, bindingId: B, hasNote: false, noteUpdatedAt: null };
const result = { promotionStatus: "created" as const, bindingStatus: "created" as const,
  item: { bindingId: B, projectId: P, workId: "33333333-3333-4333-8333-333333333333",
    editionId: "44444444-4444-4444-8444-444444444444", sourceId: null,
    catalogBookId: "book-a", title: "京西古道考", publisher: null,
    publicationDate: null, publicationDatePrecision: "YEAR" as const, isbn: null, addedAt: T } };
const auth = (csrf: string, email = "owner@example.com") =>
  ({ status: "authenticated" as const, user: { email, name: "Owner" }, csrfToken: csrf, error: null });
function Scoped({ bookId = "book-a" }: { bookId?: string }) {
  const session = useWebAuthSession();
  const generation = getWebAuthAuthGeneration();
  return <BookDetailResearchActions key={bookId + ":" + generation + ":" + session.status}
    bookId={bookId} bookTitle="京西古道考" />;
}
const mount = (bookId = "book-a") => render(<MemoryRouter><Scoped bookId={bookId} /></MemoryRouter>);

beforeEach(() => {
  __resetWebAuthStoreForTests();
  vi.clearAllMocks();
  __setWebAuthSnapshotForTests(auth("csrf-a"));
  vi.mocked(getResearchMemberships).mockResolvedValue({ memberships: { "book-a": [] } });
  vi.mocked(listProjects).mockResolvedValue({ projects: [project] });
  vi.mocked(addCatalogBookToProject).mockResolvedValue(result);
});
afterEach(() => { cleanup(); __resetWebAuthStoreForTests(); });

describe("P1-A Book Detail owner-only research conversion", () => {
  it("does not read private projects while anonymous; offers the existing login route", async () => {
    act(() => __setWebAuthSnapshotForTests({ status: "unauthenticated", user: null, csrfToken: null, error: null }));
    mount();
    expect(screen.getByRole("heading", { name: "本书的研究操作" })).toBeTruthy();
    expect(getResearchMemberships).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "加入研究" }));
    expect(screen.getByRole("link", { name: "私人研究空间" }).getAttribute("href")).toBe("/research/projects");
    expect(listProjects).not.toHaveBeenCalled();
  });

  it("reads the current book once and shows exact existing binding links", async () => {
    vi.mocked(getResearchMemberships).mockResolvedValue({ memberships: { "book-a": [member] } });
    mount();
    const chip = await screen.findByRole("link", { name: "京西古道研究" });
    expect(chip.getAttribute("href")).toBe(`/research/projects/${P}?item=${B}`);
    expect(getResearchMemberships).toHaveBeenCalledWith(["book-a"], expect.any(AbortSignal));
    expect(listProjects).not.toHaveBeenCalled();
    expect(addCatalogBookToProject).not.toHaveBeenCalled();
  });

  it("links to authoritative created binding immediately on successful POST, without auto-navigation", async () => {
    let finish!: (value: typeof result) => void;
    vi.mocked(addCatalogBookToProject).mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const view = mount();
    await waitFor(() => expect(getResearchMemberships).toHaveBeenCalledOnce());
    await userEvent.click(screen.getByRole("button", { name: "加入研究" }));
    await userEvent.dblClick(await screen.findByRole("button", { name: project.name }));
    expect(addCatalogBookToProject).toHaveBeenCalledOnce();
    expect(screen.queryByRole("link", { name: "查看这本书在项目中的资料" })).toBeNull();
    await act(async () => finish(result));
    const link = await screen.findByRole("link", { name: "查看这本书在项目中的资料" });
    expect(link.getAttribute("href")).toBe(`/research/projects/${P}?item=${B}`);
    expect(view.container.querySelector("section[aria-label='本书的研究操作']")).toBeTruthy();
  });

  it("keeps confirmed created binding link even when membership revalidation fails", async () => {
    vi.mocked(getResearchMemberships)
      .mockResolvedValueOnce({ memberships: { "book-a": [] } })
      .mockRejectedValueOnce(new ProjectApiError(503, "network"));
    mount();
    await screen.findByRole("button", { name: "加入研究" });
    await userEvent.click(screen.getByRole("button", { name: "加入研究" }));
    await userEvent.click(await screen.findByRole("button", { name: project.name }));
    expect((await screen.findByRole("link", { name: "查看这本书在项目中的资料" })).getAttribute("href"))
      .toBe(`/research/projects/${P}?item=${B}`);
    expect(await screen.findByText("研究状态暂不可用")).toBeTruthy();
    expect(screen.getByRole("link", { name: "查看这本书在项目中的资料" })).toBeTruthy();
  });

  it("clears private chips and last successful binding immediately on same-status Owner rotation", async () => {
    vi.mocked(getResearchMemberships).mockResolvedValueOnce({ memberships: { "book-a": [] } })
      .mockResolvedValueOnce({ memberships: { "book-a": [] } });
    mount();
    await userEvent.click(screen.getByRole("button", { name: "加入研究" }));
    await userEvent.click(await screen.findByRole("button", { name: project.name }));
    expect(await screen.findByRole("link", { name: "查看这本书在项目中的资料" })).toBeTruthy();
    act(() => __setWebAuthSnapshotForTests(auth("csrf-b", "another-owner@example.com")));
    expect(screen.queryByRole("link", { name: "查看这本书在项目中的资料" })).toBeNull();
    expect(screen.queryByText("已加入「京西古道研究」")).toBeNull();
    await waitFor(() => expect(getResearchMemberships).toHaveBeenCalledTimes(3));
  });

  it("clears late pending binding state on different book and refuses cross-book links", async () => {
    let finish!: (value: typeof result) => void;
    vi.mocked(addCatalogBookToProject).mockReturnValue(new Promise(resolve => { finish = resolve; }));
    vi.mocked(getResearchMemberships).mockResolvedValue({ memberships: { "book-a": [], "book-b": [] } });
    const view = mount();
    await userEvent.click(screen.getByRole("button", { name: "加入研究" }));
    await userEvent.click(await screen.findByRole("button", { name: project.name }));
    const signal = vi.mocked(addCatalogBookToProject).mock.calls[0][2]!;
    view.rerender(<MemoryRouter><Scoped bookId="book-b" /></MemoryRouter>);
    expect(signal.aborted).toBe(true);
    await act(async () => finish(result));
    expect(screen.queryByRole("link", { name: "查看这本书在项目中的资料" })).toBeNull();
    expect(addCatalogBookToProject).toHaveBeenCalledWith(P, "book-a", expect.any(AbortSignal));
  });

  it("does not treat a prototype-inherited entry as an actual membership", async () => {
    vi.mocked(getResearchMemberships).mockResolvedValue({ memberships: Object.create(null) });
    mount("__proto__");
    await screen.findByRole("heading", { name: "本书的研究操作" });
    expect(screen.queryByRole("link", { name: project.name })).toBeNull();
  });

  it("does not fabricate a successful project link when add returns a server error", async () => {
    vi.mocked(addCatalogBookToProject).mockRejectedValue(new ProjectApiError(503, "项目资料服务暂不可用。"));
    mount();
    await userEvent.click(screen.getByRole("button", { name: "加入研究" }));
    await userEvent.click(await screen.findByRole("button", { name: project.name }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "查看这本书在项目中的资料" })).toBeNull();
  });
});
