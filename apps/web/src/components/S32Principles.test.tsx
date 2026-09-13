import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const componentPath = resolve(__dirname, "S32Principles.tsx");
const appPath = resolve(__dirname, "..", "App.tsx");

const componentSrc = existsSync(componentPath)
  ? readFileSync(componentPath, "utf8")
  : "";

const appSrc = readFileSync(appPath, "utf8");

describe("S32Principles public architecture note", () => {
  it("App.tsx mounts S32Principles exactly once", () => {
    expect(appSrc).toContain(
      'import S32Principles from "./components/S32Principles";',
    );

    const mounts = appSrc.match(/<S32Principles\s*\/>/g) ?? [];
    expect(mounts).toHaveLength(1);
  });

  it("uses a native details element and is collapsed by default", () => {
    expect(componentSrc).toContain(
      '<details className="s32-principles__details">',
    );
    expect(componentSrc).toContain(
      '<summary className="s32-principles__summary">',
    );
    expect(componentSrc).not.toMatch(/<details[^>]*\bopen\b/);
  });

  it("publishes the approved S32 title and implementation boundary", () => {
    expect(componentSrc).toContain(
      "S32｜个人阅读知识层设计原则",
    );
    expect(componentSrc).toContain(
      "设计状态：原则已确认，功能将按阶段逐步实现。",
    );
  });

  it("contains exactly Principles 01 through 10", () => {
    const ids =
      componentSrc.match(/id:\s*"(?:0[1-9]|10)"/g) ?? [];

    expect(ids).toHaveLength(10);

    for (const id of [
      "01",
      "02",
      "03",
      "04",
      "05",
      "06",
      "07",
      "08",
      "09",
      "10",
    ]) {
      expect(componentSrc).toContain(
        `id: "${id}"`
      );
    }
  });

  it("keeps the approved technical distinctions visible", () => {
    const required = [
      "Work ≠ Edition ≠ CatalogRecord",
      "Reading ≠ ReadingSession",
      "Highlight ≠ Note ≠ AIArtifact",
      "Provider → Source → SourceAsset / SourceBinding",
      "Locator + Anchor",
      "Match ≠ Resolve ≠ Merge",
      "Structural Relation ≠ Semantic Relation",
      "Ownership / Visibility / Access Scope / Rights / Derivation",
      "Current State + Append-only History",
      "ImportBatch / RawRecord / Idempotent Ingestion",
    ];

    for (const text of required) {
      expect(componentSrc).toContain(
        text
      );
    }
  });

  it("does not use raw HTML injection or private browser data", () => {
    expect(componentSrc).not.toContain(
      "dangerouslySetInnerHTML",
    );
    expect(componentSrc).not.toContain(
      "localStorage",
    );
    expect(componentSrc).not.toContain(
      "sessionStorage",
    );
    expect(componentSrc).not.toContain(
      "fetch(",
    );
  });
});
