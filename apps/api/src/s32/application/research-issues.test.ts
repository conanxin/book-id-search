import { describe, expect, it, vi } from "vitest";
import {
  createResearchIssuesService,
  type ResearchIssueStore,
} from "./research-issues.js";

const projectId = "11111111-1111-4111-8111-111111111111";
const key = "22222222-2222-4222-8222-222222222222";
const issueId = "33333333-3333-4333-8333-333333333333";
const project = { id: projectId, name: "北京古道研究", lifecycleState: "ACTIVE" as const, readOnly: false };
const issue = {
  id: issueId,
  projectId,
  title: "刘祥店迁出时间",
  question: "第一行\n第二行",
  lifecycleState: "OPEN" as const,
  createdAt: "2026-09-20T00:00:00.000Z",
  updatedAt: "2026-09-20T00:00:00.000Z",
};

function fakeStore(): ResearchIssueStore {
  return {
    create: vi.fn().mockResolvedValue({ status: "created", project, issue }),
    list: vi.fn().mockResolvedValue({ project, issues: [] }),
    get: vi.fn().mockResolvedValue({ project, issue }),
  };
}

describe("research issue application service", () => {
  it("validates, normalizes, hashes and generates an issue id before create", async () => {
    const store = fakeStore();
    const service = createResearchIssuesService(store);
    await service.create(projectId.toUpperCase(), key.toUpperCase(), {
      title: " 刘祥店迁出时间 ",
      question: " 第一行\r\n第二行 ",
      forged: true,
    });

    expect(store.create).toHaveBeenCalledTimes(1);
    expect(store.create).toHaveBeenCalledWith(expect.objectContaining({
      projectId,
      idempotencyKey: key,
      issueId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      requestHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      title: "刘祥店迁出时间",
      question: "第一行\n第二行",
    }));
  });

  it.each([
    ["bad project", "bad", key, { title: "t", question: "q" }],
    ["bad key", projectId, "bad", { title: "t", question: "q" }],
    ["bad body", projectId, key, { title: "", question: "q" }],
  ])("rejects %s before store access", async (_label, projectInput, keyInput, body) => {
    const store = fakeStore();
    await expect(createResearchIssuesService(store).create(projectInput, keyInput, body)).rejects.toThrow();
    expect(store.create).not.toHaveBeenCalled();
  });

  it("validates and lowercases list and detail identifiers", async () => {
    const store = fakeStore();
    const service = createResearchIssuesService(store);
    await service.list(projectId.toUpperCase());
    await service.get(projectId.toUpperCase(), issueId.toUpperCase());
    expect(store.list).toHaveBeenCalledWith(projectId);
    expect(store.get).toHaveBeenCalledWith(projectId, issueId);
  });

  it("rejects malformed read identifiers before store access", async () => {
    const store = fakeStore();
    const service = createResearchIssuesService(store);
    await expect(service.list("bad")).rejects.toThrow();
    await expect(service.get(projectId, "bad")).rejects.toThrow();
    expect(store.list).not.toHaveBeenCalled();
    expect(store.get).not.toHaveBeenCalled();
  });

  it("uses the same hash for normalized-equivalent bodies while generating fresh issue ids", async () => {
    const store = fakeStore();
    const service = createResearchIssuesService(store);
    await service.create(projectId, key, { title: " t ", question: " q\r\n " });
    await service.create(projectId, key, { title: "t", question: "q" });
    const calls = vi.mocked(store.create).mock.calls.map(([input]) => input);
    expect(calls[0].requestHash).toBe(calls[1].requestHash);
    expect(calls[0].issueId).not.toBe(calls[1].issueId);
  });
});
