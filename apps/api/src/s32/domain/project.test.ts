import { describe, expect, it } from "vitest";
import { readProjectId, readProjectInput } from "./project.js";

describe("project input", () => {
  it("trims and whitelists fields", () => {
    expect(readProjectInput({ name: " 北京古道研究 ", description: " 研究目的 ", id: "forged", metadata: { secret: 1 }, lifecycleState: "ARCHIVED" }))
      .toEqual({ name: "北京古道研究", description: "研究目的" });
  });
  it.each([undefined, null, "", "  "])("normalizes optional description %s", (description) => {
    expect(readProjectInput({ name: "项目", description }).description).toBeNull();
  });
  it.each([null, [], "x", {}, { name: " " }, { name: 1 }, { name: "a".repeat(121) }, { name: "x", description: 12 }, { name: "x", description: [] }, { name: "x", description: "a".repeat(2001) }])("rejects invalid input %j", (input) => {
    expect(() => readProjectInput(input)).toThrow();
  });
  it("counts Unicode code points, including astral characters", () => {
    expect(readProjectInput({ name: "𠮷".repeat(120), description: "📚".repeat(2000) }).name).toBe("𠮷".repeat(120));
    expect(() => readProjectInput({ name: "𠮷".repeat(121) })).toThrow();
    expect(() => readProjectInput({ name: "x", description: "📚".repeat(2001) })).toThrow();
  });
  it("validates UUID detail IDs before querying", () => {
    expect(readProjectId("12345678-1234-1234-1234-123456789ABC")).toBe("12345678-1234-1234-1234-123456789ABC");
    for (const id of [null, "", "x' OR 1=1", "12345678-1234-1234-1234-123456789ab"]) expect(() => readProjectId(id)).toThrow();
  });
});
