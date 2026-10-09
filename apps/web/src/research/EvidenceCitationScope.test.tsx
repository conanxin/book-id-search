// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { EvidenceCitationScope } from "./EvidenceCitationScope";
import type { AssessmentDetailResponse } from "./api";

type Items = AssessmentDetailResponse["evidenceManifest"]["items"];
const evidence: Items = [
  { ordinal: 1, role: "SUPPORTING", targetType: "SOURCE",
    targetId: "11111111-1111-4111-8111-111111111111", locatorType: null,
    locator: null, excerpt: null, note: "仅有二手说明，不是原文摘录" },
  { ordinal: 2, role: "CONTEXTUAL", targetType: "NOTE_REVISION",
    targetId: "22222222-2222-4222-8222-222222222222", locatorType: null,
    locator: null, excerpt: null, note: null },
];
afterEach(cleanup);

describe("P1-B v0.1 frozen evidence citation precision", () => {
  it("states that v1 targets are recorded objects, not source page/plate/excerpt citations", () => {
    render(<EvidenceCitationScope items={evidence} />);
    const info = screen.getByRole("note");
    expect(info.textContent).toContain("仅记录证据对象");
    expect(info.textContent).toContain("页码、图版、段落与原文摘录均未记录");
    expect(info.textContent).not.toContain("已核验原文");
    expect(info.querySelector("a")).toBeNull();
  });

  it("does not treat a free-text evidence note as verified original excerpt", () => {
    const { container } = render(<EvidenceCitationScope items={evidence.slice(0, 1)} />);
    expect(container.textContent).toContain("原文摘录均未记录");
    expect(container.textContent).not.toContain("二手说明");
    expect(container.querySelector("a")).toBeNull();
  });

  it("does not fabricate an evidence claim for an empty manifest", () => {
    const { container } = render(<EvidenceCitationScope items={[]} />);
    expect(container.textContent).toBe("");
  });
});
