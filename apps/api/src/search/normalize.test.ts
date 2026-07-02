import { describe, expect, it } from "vitest";
import { normalizeQuery } from "./normalize.js";

describe("normalizeQuery", () => {
  it("empty -> empty", () => {
    expect(normalizeQuery("")).toEqual({
      original: "",
      normalized: "",
      detectedType: "empty",
    });
  });

  it("bare 8-digit -> ssid", () => {
    const r = normalizeQuery("13000000");
    expect(r.detectedType).toBe("ssid");
    expect(r.normalized).toBe("13000000");
  });

  it("bare 12-digit -> dxid (preserves leading zeros)", () => {
    const r = normalizeQuery("000008232537");
    expect(r.detectedType).toBe("dxid");
    expect(r.normalized).toBe("000008232537");
  });

  it("bare 13-digit 978 -> isbn", () => {
    const r = normalizeQuery("9787538455250");
    expect(r.detectedType).toBe("isbn");
    expect(r.normalized).toBe("9787538455250");
  });

  it("hyphenated ISBN -> isbn with compact normalized", () => {
    const r = normalizeQuery("978-7-5384-5525-0");
    expect(r.detectedType).toBe("isbn");
    expect(r.normalized).toBe("9787538455250");
  });

  it("Chinese text -> text, spacing preserved", () => {
    const r = normalizeQuery("北京 旅游");
    expect(r.detectedType).toBe("text");
    expect(r.normalized).toBe("北京 旅游");
  });

  it("full-width digits -> half-width", () => {
    const r = normalizeQuery("１３００００００");
    expect(r.detectedType).toBe("ssid");
    expect(r.normalized).toBe("13000000");
  });

  // ----- S25A: labeled identifier extraction -----

  it("S25A: 'ISBN 是 978-7-5384-5525-0 的书' -> isbn with compact id", () => {
    const r = normalizeQuery("ISBN 是 978-7-5384-5525-0 的书");
    expect(r.detectedType).toBe("isbn");
    expect(r.normalized).toBe("9787538455250");
    expect(r.original).toBe("ISBN 是 978-7-5384-5525-0 的书");
  });

  it("S25A: 'ISBN: 9787538455250' -> isbn", () => {
    const r = normalizeQuery("ISBN: 9787538455250");
    expect(r.detectedType).toBe("isbn");
    expect(r.normalized).toBe("9787538455250");
  });

  it("S25A: 'ISBN 9787538455250' (no separator) -> isbn", () => {
    const r = normalizeQuery("ISBN 9787538455250");
    expect(r.detectedType).toBe("isbn");
    expect(r.normalized).toBe("9787538455250");
  });

  it("S25A: '查 ISBN 978-7-5384-5525-0' -> isbn with leading prose", () => {
    const r = normalizeQuery("查 ISBN 978-7-5384-5525-0");
    expect(r.detectedType).toBe("isbn");
    expect(r.normalized).toBe("9787538455250");
  });

  it("S25A: 'SSID 是 13000000' -> ssid", () => {
    const r = normalizeQuery("SSID 是 13000000");
    expect(r.detectedType).toBe("ssid");
    expect(r.normalized).toBe("13000000");
  });

  it("S25A: 'DXID: 000008232537' -> dxid (leading zeros preserved)", () => {
    const r = normalizeQuery("DXID: 000008232537");
    expect(r.detectedType).toBe("dxid");
    expect(r.normalized).toBe("000008232537");
  });

  it("S25A: 'DXID 是 000008232537' -> dxid (Chinese separator)", () => {
    const r = normalizeQuery("DXID 是 000008232537");
    expect(r.detectedType).toBe("dxid");
    expect(r.normalized).toBe("000008232537");
  });

  it("S25A: lowercase 'isbn: 9787538455250' -> isbn (case-insensitive)", () => {
    const r = normalizeQuery("isbn: 9787538455250");
    expect(r.detectedType).toBe("isbn");
    expect(r.normalized).toBe("9787538455250");
  });

  it("S25A: 'ISBN：9787538455250' (full-width colon) -> isbn", () => {
    const r = normalizeQuery("ISBN：9787538455250");
    expect(r.detectedType).toBe("isbn");
    expect(r.normalized).toBe("9787538455250");
  });

  // ----- Regression: unlabeled digit runs must NOT trigger extraction -----

  it("S25A: '2011 年北京旅游' stays text (no label)", () => {
    const r = normalizeQuery("2011 年北京旅游");
    expect(r.detectedType).toBe("text");
    // Year is preserved as part of the text; it does NOT get pulled
    // into the SSID/dxid/isbn path because no label is present.
    expect(r.normalized).toBe("2011 年北京旅游");
  });

  it("S25A: '256 页的小说' stays text (no label)", () => {
    const r = normalizeQuery("256 页的小说");
    expect(r.detectedType).toBe("text");
    expect(r.normalized).toBe("256 页的小说");
  });

  it("S25A: '北京2011旅游' stays text", () => {
    const r = normalizeQuery("北京2011旅游");
    expect(r.detectedType).toBe("text");
    expect(r.normalized).toBe("北京2011旅游");
  });
});
