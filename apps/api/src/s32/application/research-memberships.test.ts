import { describe, expect, it, vi } from "vitest";
import {
  createResearchMembershipService,
  type ResearchMembershipStore,
} from "./research-memberships.js";

const a = {
  projectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  projectName: "甲项目",
  projectLifecycleState: "ACTIVE" as const,
  bindingId: "11111111-1111-4111-8111-111111111111",
  hasNote: false,
  noteUpdatedAt: null,
};
const b = {
  projectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  projectName: "乙项目",
  projectLifecycleState: "ACTIVE" as const,
  bindingId: "22222222-2222-4222-8222-222222222222",
  hasNote: true,
  noteUpdatedAt: "2026-09-20T08:00:00.000Z",
};
const archived = {
  projectId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  projectName: "旧项目",
  projectLifecycleState: "ARCHIVED" as const,
  bindingId: "33333333-3333-4333-8333-333333333333",
  hasNote: true,
  noteUpdatedAt: "2026-09-20T09:00:00.000Z",
};

function setup(rows = new Map([["book-a", [archived, a, b]]])) {
  const lookup = vi.fn(async () => rows);
  const store: ResearchMembershipStore = { lookup };
  return { service: createResearchMembershipService(store), lookup };
}

describe("research membership service", () => {
  it("returns explicit arrays for every normalized requested id and keeps empty ids explicit", async () => {
    const { service, lookup } = setup(new Map([["book-a", [a]]]));
    await expect(service.lookup({ bookIds: ["book-a", "book-b", "book-a"] })).resolves.toEqual({
      memberships: {
        "book-a": [a],
        "book-b": [],
      },
    });
    expect(lookup).toHaveBeenCalledWith(["book-a", "book-b"]);
  });

  it("sorts ACTIVE before ARCHIVED, then recent Note before null, with stable names", async () => {
    const { service } = setup();
    const result = await service.lookup({ bookIds: ["book-a"] });
    expect(result.memberships["book-a"]).toEqual([b, a, archived]);
  });

  it("returns an empty object without querying storage for an empty request", async () => {
    const { service, lookup } = setup();
    await expect(service.lookup({ bookIds: [] })).resolves.toEqual({ memberships: {} });
    expect(lookup).not.toHaveBeenCalled();
  });

  it("keeps __proto__ as an explicit serializable membership key", async () => {
    const { service } = setup(new Map());
    const result = await service.lookup({ bookIds: ["__proto__"] });

    expect(Object.hasOwn(result.memberships, "__proto__")).toBe(true);
    expect(result.memberships["__proto__"]).toEqual([]);
    expect(JSON.parse(JSON.stringify(result)).memberships["__proto__"]).toEqual([]);
  });
});
