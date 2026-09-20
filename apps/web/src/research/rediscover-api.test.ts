import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getProjectOverview,
  getResearchMemberships,
  ProjectApiError,
} from "./api";

const projectId = "11111111-1111-4111-8111-111111111111";
const bindingId = "22222222-2222-4222-8222-222222222222";
const noteId = "33333333-3333-4333-8333-333333333333";
const revisionId = "44444444-4444-4444-8444-444444444444";
const timestamp = "2026-09-20T08:00:00.000Z";

const activeMembership = {
  projectId,
  projectName: "北京古道研究",
  projectLifecycleState: "ACTIVE" as const,
  bindingId,
  hasNote: true,
  noteUpdatedAt: timestamp,
};

const overview = {
  project: {
    id: projectId,
    name: "北京古道研究",
    description: null,
    lifecycleState: "ACTIVE" as const,
    readOnly: false,
    createdAt: timestamp,
    updatedAt: timestamp,
  },
  summary: { itemCount: 1, noteCount: 1, lastActivityAt: timestamp },
  items: [{
    bindingId,
    workId: "55555555-5555-4555-8555-555555555555",
    editionId: "66666666-6666-4666-8666-666666666666",
    sourceId: "77777777-7777-4777-8777-777777777777",
    catalogBookId: "catalog-a",
    title: "北京古道考",
    publisher: "文献出版社",
    publicationDate: "2001-02-01",
    publicationDatePrecision: "MONTH" as const,
    isbn: null,
    addedAt: timestamp,
    activityAt: timestamp,
    noteSummary: {
      noteId,
      currentRevisionId: revisionId,
      currentRevisionNo: 2,
      excerpt: "R2 摘要",
      updatedAt: timestamp,
    },
  }],
};

afterEach(() => vi.unstubAllGlobals());

describe("M1-E research membership client", () => {
  it("uses the exact same-origin batch endpoint, body, auth and no-store", async () => {
    const body = { memberships: { "book-a": [activeMembership], "book-b": [] } };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(body)));
    vi.stubGlobal("fetch", fetchMock);
    const signal = new AbortController().signal;

    await expect(getResearchMemberships("secret", ["book-a", "book-b"], signal)).resolves.toEqual(body);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/private/s32/research-memberships/catalog-books",
      expect.objectContaining({
        method: "POST",
        cache: "no-store",
        signal,
        body: JSON.stringify({ bookIds: ["book-a", "book-b"] }),
        headers: expect.objectContaining({ Authorization: "Bearer secret" }),
      }),
    );
  });

  it("accepts ACTIVE and ARCHIVED memberships plus a nullable Note timestamp", async () => {
    const archived = { ...activeMembership, projectLifecycleState: "ARCHIVED" as const, hasNote: false, noteUpdatedAt: null };
    const body = { memberships: { "book-a": [activeMembership, archived] } };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body))));
    await expect(getResearchMemberships("token", ["book-a"])).resolves.toEqual(body);
  });

  it.each([
    { memberships: {} },
    { memberships: { "book-a": null } },
    { memberships: { "book-a": [{ ...activeMembership, projectLifecycleState: "DELETED" }] } },
    { memberships: { "book-a": [{ ...activeMembership, noteUpdatedAt: "not-a-date" }] } },
    { memberships: { "book-a": [{ ...activeMembership, hasNote: "yes" }] } },
  ])("rejects missing or malformed membership truth %#", async (body) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body))));
    await expect(getResearchMemberships("token", ["book-a"])).rejects.toMatchObject({ status: 502 });
  });
});

describe("M1-E Project Overview client", () => {
  it("accepts a direct Overview and preserves ARCHIVED readOnly state", async () => {
    const archived = {
      ...overview,
      project: { ...overview.project, lifecycleState: "ARCHIVED" as const, readOnly: true },
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(archived)));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getProjectOverview("secret", "project/a")).resolves.toEqual(archived);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/private/s32/projects/project%2Fa/overview",
      expect.objectContaining({ method: "GET", cache: "no-store" }),
    );
  });

  it.each([
    { overview },
    { ...overview, project: { ...overview.project, id: "not-a-uuid" } },
    { ...overview, project: { ...overview.project, lifecycleState: "ARCHIVED", readOnly: false } },
    { ...overview, summary: { ...overview.summary, itemCount: -1 } },
    { ...overview, summary: { ...overview.summary, lastActivityAt: "invalid" } },
    { ...overview, items: [{ ...overview.items[0], activityAt: "invalid" }] },
    { ...overview, items: [{ ...overview.items[0], noteSummary: { ...overview.items[0].noteSummary, currentRevisionNo: 0 } }] },
    { ...overview, items: [{ ...overview.items[0], noteSummary: { ...overview.items[0].noteSummary, excerpt: 7 } }] },
  ])("rejects malformed Overview payload %#", async (body) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body))));
    await expect(getProjectOverview("token", projectId)).rejects.toBeInstanceOf(ProjectApiError);
    await expect(getProjectOverview("token", projectId)).rejects.toMatchObject({ status: 502 });
  });
});
