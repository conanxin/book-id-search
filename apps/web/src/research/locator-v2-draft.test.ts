import { describe, expect, it } from "vitest";
import {
  assessLocatorDraftV2, parseLocatorDraftV2, summarizeV1EvidenceLocation,
  type LocatorDraftV2, type LocatorWitnessV2,
} from "./locator-v2-draft";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const EDITION = "22222222-2222-4222-8222-222222222222";
const SOURCE = "33333333-3333-4333-8333-333333333333";
const ASSET = "44444444-4444-4444-8444-444444444444";
const OTHER = "55555555-5555-4555-8555-555555555555";
const SHA = "a".repeat(64);
const draft: LocatorDraftV2 = {
  schemaVersion: 2,
  projectId: PROJECT,
  editionId: EDITION,
  sourceId: SOURCE,
  sourceAssetId: ASSET,
  assetSha256: SHA,
  kind: "PRINTED_PAGE",
  label: "87",
};
const witness: LocatorWitnessV2 = {
  projectId: PROJECT,
  editionId: EDITION,
  sourceId: SOURCE,
  sourceAssetId: ASSET,
  assetSha256: SHA,
  sourceType: "PUBLICATION",
  assetRole: "ORIGINAL",
  access: "READABLE",
};

describe("S32 Locator R2: strict human-proposed v2 draft shape (NOT v1 storage)", () => {
  it("parses an exact printed-page candidate without changing version identity", () => {
    expect(parseLocatorDraftV2(draft)).toEqual(draft);
  });

  it("accepts a Chinese plate label as an uninterpreted original label", () => {
    const plate = { ...draft, kind: "PLATE", label: "图版二十一" };
    expect(parseLocatorDraftV2(plate)).toEqual(plate);
  });

  it("accepts a historical Roman printed-page label, without inferring numbering", () => {
    expect(parseLocatorDraftV2({ ...draft, label: "xii" })?.label).toBe("xii");
  });

  it.each([
    ["verified flag", { verified: true }],
    ["fabricated URL", { href: "https://example.org/scan?page=87" }],
    ["claimed source quote", { excerpt: "invented source text" }],
    ["verification claim", { verification: "VERIFIED" }],
    ["extra note", { note: "user-provided text" }],
    ["synthetic bbox", { bbox: [0, 0, 1, 1] }],
    ["source locator", { locator: { page: 87 } }],
  ])("rejects unknown %s rather than silently accepting authority", (_label, addition) => {
    expect(parseLocatorDraftV2({ ...draft, ...addition })).toBeNull();
  });

  it.each([
    ["v1 data", { schemaVersion: 1 }],
    ["schema 3", { schemaVersion: 3 }],
    ["unknown kind", { kind: "PDF_PAGE" }],
    ["missing edition", { editionId: "" }],
    ["non-UUID source", { sourceId: "BOOK-123" }],
    ["absent asset", { sourceAssetId: null }],
    ["incorrect asset hash", { assetSha256: "1".repeat(63) }],
    ["uppercase hash", { assetSha256: "A".repeat(64) }],
  ])("rejects an incompatible %s", (_label, modification) => {
    expect(parseLocatorDraftV2({ ...draft, ...modification })).toBeNull();
  });

  it.each([
    ["blank", ""],
    ["space-only", " "],
    ["leading whitespace", " 87"],
    ["trailing whitespace", "87 "],
    ["newline injection", "87\n88"],
    ["HTML anchor", "<a>87</a>"],
    ["URL", "https://site.example/page/87"],
    ["directional override", "87\u202e"],
    ["excess length", "8".repeat(60)],
  ])("rejects unsafe %s page/plate labels", (_label, label) => {
    expect(parseLocatorDraftV2({ ...draft, label })).toBeNull();
  });

  it("does not accept an array or non-JSON shape as a locator draft", () => {
    expect(parseLocatorDraftV2([])).toBeNull();
    expect(parseLocatorDraftV2(null)).toBeNull();
    expect(parseLocatorDraftV2("page 87")).toBeNull();
  });
});

describe("S32 Locator R2: authorized witness is not a verified quotation", () => {
  it("produces ONLY a pending-human-verification locator without links or excerpts", () => {
    expect(assessLocatorDraftV2(draft, witness)).toEqual({
      status: "PENDING_HUMAN_VERIFICATION",
      reason: null,
      locator: { kind: "PRINTED_PAGE", label: "87" },
      verified: false,
      href: null,
      excerpt: null,
    });
  });

  it("does not manufacture a verified plate quote or an asset URL", () => {
    const review = assessLocatorDraftV2({ ...draft, kind: "PLATE", label: "图版二十一" }, witness);
    expect(review).toMatchObject({ status: "PENDING_HUMAN_VERIFICATION", verified: false, href: null, excerpt: null });
    expect(review.locator).toEqual({ kind: "PLATE", label: "图版二十一" });
    expect(JSON.stringify(review)).not.toContain(ASSET);
    expect(JSON.stringify(review)).not.toContain(SHA);
  });

  it("fails closed without an independently authorized source witness", () => {
    const result = assessLocatorDraftV2(draft, null);
    expect(result).toMatchObject({ status: "UNAVAILABLE", reason: "NO_AUTHORIZED_WITNESS", locator: null, verified: false });
    expect(JSON.stringify(result)).not.toContain(EDITION);
    expect(JSON.stringify(result)).not.toContain(ASSET);
  });

  it.each(["DENIED", "REVOKED", "UNKNOWN"] as const)(
    "does not expose previously entered locator after source access is %s", access => {
      const result = assessLocatorDraftV2(draft, { ...witness, access });
      expect(result).toMatchObject({ status: "UNAVAILABLE", locator: null, href: null, excerpt: null });
      expect(JSON.stringify(result)).not.toContain("87");
    },
  );

  it.each([
    ["different project", { projectId: OTHER }],
    ["different Edition", { editionId: OTHER }],
    ["different Source", { sourceId: OTHER }],
    ["different SourceAsset", { sourceAssetId: OTHER }],
  ])("rejects cross-identity %s, without returning the attempted source ID", (_label, change) => {
    const result = assessLocatorDraftV2(draft, { ...witness, ...change });
    expect(result).toMatchObject({ status: "IDENTITY_CONFLICT", reason: "IDENTITY_MISMATCH", locator: null });
    expect(JSON.stringify(result)).not.toContain(OTHER);
    expect(JSON.stringify(result)).not.toContain("87");
  });

  it("does not reuse a locator against different original-file bytes", () => {
    const result = assessLocatorDraftV2(draft, { ...witness, assetSha256: "b".repeat(64) });
    expect(result).toMatchObject({ status: "IDENTITY_CONFLICT", reason: "HASH_MISMATCH", locator: null });
  });

  it.each([
    ["Source has no fixed edition", { editionId: null }],
    ["remote asset has no known checksum", { assetSha256: null }],
    ["derived rather than original asset", { assetRole: "DERIVED" }],
    ["non-publication Source", { sourceType: "OTHER" }],
  ])("requires an original edition-bound witness: %s", (_label, change) => {
    expect(assessLocatorDraftV2(draft, { ...witness, ...change } as LocatorWitnessV2)).toMatchObject({
      status: "UNAVAILABLE", reason: "SOURCE_UNSUPPORTED", locator: null,
    });
  });

  it("rejects self-certified or altered v2 payload before consulting the witness", () => {
    const result = assessLocatorDraftV2({ ...draft, verified: true, href: "/private/asset" }, witness);
    expect(result).toMatchObject({ status: "INVALID", reason: "INVALID_SHAPE", locator: null, verified: false });
  });

  it("does not mutate deeply frozen caller inputs or a former witness", () => {
    Object.freeze(draft);
    Object.freeze(witness);
    expect(assessLocatorDraftV2(draft, witness).status).toBe("PENDING_HUMAN_VERIFICATION");
    expect(draft.label).toBe("87");
    expect(witness.assetSha256).toBe(SHA);
  });
});

describe("S32 v1 frozen EvidenceManifest remains distinct from R2 draft locators", () => {
  it("shows legacy null page/plate/quote as NOT_RECORDED, never auto-upgrades them", () => {
    expect(summarizeV1EvidenceLocation([{
      ordinal: 1, targetType: "SOURCE_ASSET", targetId: ASSET,
      locatorType: null, locator: null, excerpt: null, note: "Researcher annotation, not original quotation",
    }])).toBe("NOT_RECORDED");
  });

  it("treats empty legacy evidence as NO_EVIDENCE, not a confirmed missing page", () => {
    expect(summarizeV1EvidenceLocation([])).toBe("NO_EVIDENCE");
  });

  it("refuses unexpected populated legacy location fields, not reinterpreting them as v2", () => {
    expect(summarizeV1EvidenceLocation([{
      locatorType: "PRINTED_PAGE", locator: { page: 87 }, excerpt: "citation",
    }])).toBe("UNSUPPORTED");
  });

  it("refuses malformed legacy input without constructing a phantom locator", () => {
    expect(summarizeV1EvidenceLocation(null)).toBe("UNSUPPORTED");
    expect(summarizeV1EvidenceLocation([{ locatorType: null, locator: null }])).toBe("UNSUPPORTED");
  });
});
