import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./research.css", import.meta.url), "utf8");

describe("M2-D assessment responsive CSS contract", () => {
  it("keeps composer, history, detail, and long hashes within the Claim card", () => {
    expect(css).toMatch(/\.assessment-composer\s*\{[^}]*min-width:\s*0/s);
    expect(css).toMatch(/\.assessment-composer\s+(?:textarea|select)[^}]*width:\s*100%/s);
    expect(css).toMatch(/\.assessment-history-list\s*\{[^}]*display:\s*grid/s);
    expect(css).toMatch(/\.assessment-detail-items\s+code\s*\{[^}]*overflow-wrap:\s*anywhere/s);
    expect(css).toMatch(/\.assessment-hash\s*\{[^}]*word-break:\s*break-all/s);
  });

  it("stacks assessment controls on narrow screens", () => {
    expect(css).toMatch(/@media\s*\(max-width:\s*700px\)[\s\S]*\.assessment-composer[\s\S]*flex-direction:\s*column/);
  });
});
