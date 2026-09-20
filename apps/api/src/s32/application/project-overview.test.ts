import { describe, expect, it, vi } from "vitest";
import {
  createProjectOverviewService,
  type ProjectOverviewStore,
} from "./project-overview.js";
import { InvalidProjectInputError } from "../domain/project.js";
import type { ProjectOverview } from "../domain/rediscover.js";

const projectId = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
const overview: ProjectOverview = {
  project: {
    id: projectId.toLowerCase(),
    name: "北京古道研究",
    description: null,
    lifecycleState: "ACTIVE",
    readOnly: false,
    createdAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-20T00:00:00.000Z",
  },
  summary: { itemCount: 0, noteCount: 0, lastActivityAt: null },
  items: [],
};

describe("project overview service", () => {
  it("normalizes a valid project UUID before storage", async () => {
    const get = vi.fn(async () => overview);
    const store: ProjectOverviewStore = { get };
    const service = createProjectOverviewService(store);
    await expect(service.get(projectId)).resolves.toBe(overview);
    expect(get).toHaveBeenCalledWith(projectId.toLowerCase());
  });

  it("returns null unchanged for a missing project", async () => {
    const get = vi.fn(async () => null);
    const service = createProjectOverviewService({ get });
    await expect(service.get(projectId)).resolves.toBeNull();
  });

  it("rejects malformed project ids before storage", async () => {
    const get = vi.fn();
    const service = createProjectOverviewService({ get });
    await expect(service.get("not-a-uuid")).rejects.toBeInstanceOf(InvalidProjectInputError);
    expect(get).not.toHaveBeenCalled();
  });
});
