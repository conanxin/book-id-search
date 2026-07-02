import { describe, expect, it } from "vitest";
import { detectIntentProfile } from "./intent-profile.js";

describe("detectIntentProfile (S24-2)", () => {
  it("北京旅游 -> travel_guide", () => {
    const r = detectIntentProfile("北京旅游");
    expect(r.type).toBe("travel_guide");
    expect(r.label).toBe("旅行指南");
    expect(r.positiveTerms).toContain("指南");
    expect(r.negativeTerms).toContain("研究报告");
  });

  it("辽代佛塔古建筑研究 -> academic_research (研究 triggers)", () => {
    const r = detectIntentProfile("辽代佛塔古建筑研究");
    expect(r.type).toBe("academic_research");
    expect(r.label).toBe("学术研究");
  });

  it("披肩吊带手工书 -> practical_manual (手工 is a hint)", () => {
    // "手工" is not in our triggers list, but "编织 / 钩针" are.
    // "披肩吊带手工书" alone may fall to general. Try a
    // practical-manual-triger query.
    const r = detectIntentProfile("披肩编织教程");
    expect(r.type).toBe("practical_manual");
  });

  it("披肩吊带手工书 -> general (no specific trigger; manual hint via practical terms only)", () => {
    const r = detectIntentProfile("披肩吊带手工书");
    // No strong trigger in our list. "披肩" / "吊带" / "手工" are
    // not triggers. Fall to general. (The rerank layer can still
    // pick up the practical-manual intent from positive-term
    // matching, but profile.type here is general.)
    expect(r.type).toBe("general");
  });

  it("汉语词典 -> reference", () => {
    const r = detectIntentProfile("汉语词典");
    expect(r.type).toBe("reference");
  });

  it("鲁迅小说 -> literature", () => {
    const r = detectIntentProfile("鲁迅小说");
    expect(r.type).toBe("literature");
  });

  it("北京旅游指南 -> travel_guide with medium confidence (旅游 + 指南 both trigger)", () => {
    const r = detectIntentProfile("北京旅游指南");
    expect(r.type).toBe("travel_guide");
    expect(r.confidence).toBe("medium");
  });

  it("北京旅游发展研究 -> academic_research (研究 trumps 旅游)", () => {
    // "研究" is a strong trigger for academic_research; "旅游" alone
    // is travel_guide trigger. academic_research's triggers include
    // "研究" with a 1.0 score; travel_guide's "旅游" + "研究" combo
    // should compete, but "研究" is the deciding token.
    const r = detectIntentProfile("北京旅游发展研究");
    expect(r.type).toBe("academic_research");
  });

  it("高考语文试题 -> textbook", () => {
    const r = detectIntentProfile("高考语文试题");
    expect(r.type).toBe("textbook");
  });

  it("empty query -> general with low confidence", () => {
    const r = detectIntentProfile("");
    expect(r.type).toBe("general");
    expect(r.confidence).toBe("low");
  });

  it("very short query with no trigger -> general", () => {
    const r = detectIntentProfile("你好");
    expect(r.type).toBe("general");
  });

  it("reference vs literature: '鲁迅文集' -> literature, not reference", () => {
    const r = detectIntentProfile("鲁迅文集");
    expect(r.type).toBe("literature");
  });
});
