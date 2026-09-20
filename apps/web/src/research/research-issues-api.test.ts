import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createResearchIssue,
  getResearchIssue,
  listResearchIssues,
  ProjectApiError,
} from "./api";

const projectId = "11111111-1111-4111-8111-111111111111";
const issueId = "22222222-2222-4222-8222-222222222222";
const key = "33333333-3333-4333-8333-333333333333";
const timestamp = "2026-09-20T08:00:00.000Z";
const project = { id: projectId, name: "北京古道研究", lifecycleState: "ACTIVE" as const, readOnly: false };
const issue = { id: issueId, projectId, title: "刘祥店迁出时间", question: "完整问题", lifecycleState: "OPEN" as const, createdAt: timestamp, updatedAt: timestamp };
const summary = { id: issueId, projectId, title: issue.title, questionExcerpt: "摘要", lifecycleState: "OPEN" as const, createdAt: timestamp, updatedAt: timestamp };

afterEach(() => vi.unstubAllGlobals());

describe("M2-A research issue API client", () => {
  it.each([201, 200])("creates through the same-origin endpoint and validates %s", async (status) => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ project, issue }), { status }));
    vi.stubGlobal("fetch", fetchMock);
    const signal = new AbortController().signal;
    await expect(createResearchIssue("secret", "project/a", key, { title: "normalized", question: "question", forged: true } as any, signal))
      .resolves.toEqual({ project, issue });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/private/s32/projects/project%2Fa/issues",
      expect.objectContaining({
        method: "POST",
        signal,
        cache: "no-store",
        body: JSON.stringify({ title: "normalized", question: "question" }),
        headers: {
          Authorization: "Bearer secret",
          "Content-Type": "application/json",
          "Idempotency-Key": key,
        },
      }),
    );
  });

  it("lists summaries and gets full detail with encoded paths", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ project, issues: [summary] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ project, issue })));
    vi.stubGlobal("fetch", fetchMock);
    expect(await listResearchIssues("t", "p/a")).toEqual({ project, issues: [summary] });
    expect(await getResearchIssue("t", "p/a", "i/b")).toEqual({ project, issue });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/private/s32/projects/p%2Fa/issues");
    expect(fetchMock.mock.calls[1][0]).toBe("/api/private/s32/projects/p%2Fa/issues/i%2Fb");
  });

  it.each([
    {},
    { project, issues: null },
    { project: { ...project, readOnly: true }, issues: [] },
    { project, issues: [{ ...summary, questionExcerpt: null }] },
    { project, issues: [{ ...summary, lifecycleState: "UNKNOWN" }] },
    { project, issues: [{ ...summary, updatedAt: "invalid" }] },
  ])("rejects malformed list payload %#", async (body) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body))));
    await expect(listResearchIssues("t", projectId)).rejects.toMatchObject({ status: 502 });
  });

  it.each([
    {},
    { project, issue: { ...issue, question: undefined } },
    { project, issue: { ...issue, projectId: "bad" } },
    { project, issue: { ...issue, createdAt: "bad" } },
  ])("rejects malformed detail payload %#", async (body) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body))));
    await expect(getResearchIssue("t", projectId, issueId)).rejects.toMatchObject({ status: 502 });
  });

  it.each([
    ["PROJECT_READ_ONLY", "这个项目已归档，只能查看。"],
    ["IDEMPOTENCY_CONFLICT", "创建请求标识与当前研究问题内容不一致。"],
  ])("surfaces safe typed conflict %s without reflecting private details", async (code, message) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { code, message: "SQL SECRET" } }), { status: 409 })));
    await expect(createResearchIssue("t", projectId, key, { title: "t", question: "q" }))
      .rejects.toEqual(new ProjectApiError(409, message, code));
  });
});
