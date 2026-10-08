import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./research.css", import.meta.url), "utf8");
const apiSource = readFileSync(new URL("./api.ts", import.meta.url), "utf8");

describe("Gate 3 ResearchRun history CSS contract", () => {
  it("keeps run cards and UUID code wraps mobile-safe with scoped classes", () => {
    expect(css).toMatch(/\.research-run-history\s*\{[^}]*min-width:\s*0/s);
    expect(css).toMatch(/\.research-run-history-list\s*\{[^}]*display:\s*grid/s);
    expect(css).toMatch(/\.research-run-card\s*\{[^}]*min-width:\s*0/s);
    expect(css).toMatch(/\.research-run-card\s+code\s*\{[^}]*overflow-wrap:\s*anywhere/s);
    expect(css).toMatch(/\.research-run-card\s+code\s*\{[^}]*word-break:\s*break-all/s);
    expect(css).toMatch(/\.research-run-replay\s+code/s);
    for (const status of ["running", "succeeded", "failed", "cancelled"]) {
      expect(css).toMatch(new RegExp(`\\.research-run-status--${status}\\s*\\{`));
    }
  });

  it("keeps status readable without color via text labels (component copy contract)", () => {
    // Status classes only adjust color; the Chinese label itself lives in the component.
    // Guard against accidental display:none or icon-only status.
    expect(css).not.toMatch(/\.research-run-status\s*\{[^}]*display:\s*none/s);
  });
});

describe("Gate 3 production source hygiene", () => {
  it("carries no dormant debug probe in research api source", () => {
    expect(apiSource).not.toContain("VV_DEBUG");
    expect(apiSource).not.toContain("DBG reached lineage");
    expect(apiSource).not.toMatch(/process\.env\.[A-Z_]*DEBUG/);
  });
});
