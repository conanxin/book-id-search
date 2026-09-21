import { describe, expect, it } from "vitest";
import {
  InvalidEvidenceDraftError,
  buildEvidenceManifestDraft,
  canonicalEvidencePayload,
  normalizeEvidenceItemNote,
  normalizeEvidencePreviewInput,
  readEvidenceRole,
  readEvidenceTargetType,
  serializeCanonicalEvidencePayload,
} from "./evidence-selection";

const sourceId = "11111111-1111-4111-8111-111111111111";
const noteRevisionId = "22222222-2222-4222-8222-222222222222";
const assetId = "33333333-3333-4333-8333-333333333333";
const itemA = { role: "SUPPORTING", targetType: "SOURCE", targetId: sourceId, note: null } as const;
const itemB = { role: "CONTEXTUAL", targetType: "NOTE_REVISION", targetId: noteRevisionId, note: "why" } as const;

describe("evidence role/target/note normalization", () => {
  it("accepts only executable evidence roles and target types", () => {
    for (const role of ["SUPPORTING", "CONTRADICTORY", "CONTEXTUAL"]) {
      expect(readEvidenceRole(role)).toBe(role);
    }
    for (const bad of ["PRIMARY", "CONTROL", "SUPPORT", "supporting", "", null, 1]) {
      expect(() => readEvidenceRole(bad)).toThrow(InvalidEvidenceDraftError);
    }
    for (const target of ["SOURCE", "SOURCE_ASSET", "NOTE_REVISION"]) {
      expect(readEvidenceTargetType(target)).toBe(target);
    }
    for (const bad of ["CLAIM", "NOTE", "EDITION", "SOURCE_ASSET ", "", null, 2]) {
      expect(() => readEvidenceTargetType(bad)).toThrow(InvalidEvidenceDraftError);
    }
  });

  it("normalizes optional note without collapsing internal whitespace", () => {
    expect(normalizeEvidenceItemNote(undefined)).toBeNull();
    expect(normalizeEvidenceItemNote(null)).toBeNull();
    expect(normalizeEvidenceItemNote(" \u0085\r\n line 1\rline  2 \u0085 ")).toBe("line 1\nline  2");
    expect(normalizeEvidenceItemNote(" \t\u0085 ")).toBeNull();
    expect(() => normalizeEvidenceItemNote("a\0b")).toThrow(InvalidEvidenceDraftError);
    expect(() => normalizeEvidenceItemNote("𠮷".repeat(2001))).toThrow(InvalidEvidenceDraftError);
    expect(normalizeEvidenceItemNote("𠮷".repeat(2000))).toBe("𠮷".repeat(2000));
    expect(() => normalizeEvidenceItemNote(5)).toThrow(InvalidEvidenceDraftError);
  });
});

describe("evidence preview input shape", () => {
  it("rejects unknown fields, empty drafts, malformed UUIDs, and duplicate target pairs", () => {
    expect(() => normalizeEvidencePreviewInput({ items: [] })).toThrow(InvalidEvidenceDraftError);
    expect(() => normalizeEvidencePreviewInput(null)).toThrow(InvalidEvidenceDraftError);
    expect(() => normalizeEvidencePreviewInput({ items: "x" })).toThrow(InvalidEvidenceDraftError);
    expect(() => normalizeEvidencePreviewInput({ items: [{ role: "SUPPORTING", targetType: "SOURCE", targetId: "bad" }] })).toThrow(InvalidEvidenceDraftError);
    expect(() => normalizeEvidencePreviewInput({ items: [{ role: "SUPPORTING", targetType: "SOURCE", targetId: sourceId, extra: true }] })).toThrow(InvalidEvidenceDraftError);
    expect(() => normalizeEvidencePreviewInput({ items: [itemA], schemaVersion: 1 })).toThrow(InvalidEvidenceDraftError);
    expect(() => normalizeEvidencePreviewInput({ items: [itemA], purpose: "CLAIM_ASSESSMENT" })).toThrow(InvalidEvidenceDraftError);
    expect(() => normalizeEvidencePreviewInput({
      items: [
        { role: "SUPPORTING", targetType: "SOURCE", targetId: sourceId, note: null },
        { role: "CONTRADICTORY", targetType: "SOURCE", targetId: sourceId.toUpperCase(), note: null },
      ],
    })).toThrow(InvalidEvidenceDraftError);
    expect(() => normalizeEvidencePreviewInput({
      items: [
        { role: "SUPPORTING", targetType: "SOURCE", targetId: sourceId, note: null },
        { role: "SUPPORTING", targetType: "SOURCE", targetId: sourceId, note: null },
      ],
    })).toThrow(InvalidEvidenceDraftError);
  });

  it("normalizes UUIDs to lowercase and preserves request order with normalized notes", () => {
    const normalized = normalizeEvidencePreviewInput({
      items: [
        { role: "CONTEXTUAL", targetType: "NOTE_REVISION", targetId: noteRevisionId.toUpperCase(), note: " why " },
        { role: "SUPPORTING", targetType: "SOURCE", targetId: sourceId },
      ],
    });
    expect(normalized).toEqual([
      { role: "CONTEXTUAL", targetType: "NOTE_REVISION", targetId: noteRevisionId, note: "why" },
      { role: "SUPPORTING", targetType: "SOURCE", targetId: sourceId, note: null },
    ]);
  });

  it("allows the same target under different target types and allows missing note key", () => {
    const normalized = normalizeEvidencePreviewInput({
      items: [
        { role: "SUPPORTING", targetType: "SOURCE", targetId: sourceId },
        { role: "CONTRADICTORY", targetType: "SOURCE_ASSET", targetId: assetId },
      ],
    });
    expect(normalized).toHaveLength(2);
  });
});

describe("canonical serialization and hash", () => {
  it("serializes the fixed canonical payload in exact property order", () => {
    const normalized = normalizeEvidencePreviewInput({
      items: [{
        role: "SUPPORTING",
        targetType: "NOTE_REVISION",
        targetId: noteRevisionId.toUpperCase(),
        note: " why ",
      }],
    });
    const payload = canonicalEvidencePayload(normalized);
    expect(payload).toEqual({
      schemaVersion: 1,
      purpose: "CLAIM_ASSESSMENT",
      items: [{
        ordinal: 1,
        role: "SUPPORTING",
        targetType: "NOTE_REVISION",
        targetId: noteRevisionId,
        locatorType: null,
        locator: null,
        excerpt: null,
        note: "why",
      }],
    });
    expect(serializeCanonicalEvidencePayload(payload)).toBe(
      '{"schemaVersion":1,"purpose":"CLAIM_ASSESSMENT","items":[{"ordinal":1,"role":"SUPPORTING","targetType":"NOTE_REVISION","targetId":"' +
        noteRevisionId +
        '","locatorType":null,"locator":null,"excerpt":null,"note":"why"}]}',
    );
  });

  it("assigns sequential ordinals in request order", () => {
    const payload = canonicalEvidencePayload(normalizeEvidencePreviewInput({ items: [itemA, itemB] }));
    expect(payload.items.map((i) => i.ordinal)).toEqual([1, 2]);
  });

  it("hash is deterministic and changes on role/target/note/order but not external context", () => {
    const a = buildEvidenceManifestDraft(normalizeEvidencePreviewInput({ items: [itemA, itemB] }));
    const b = buildEvidenceManifestDraft(normalizeEvidencePreviewInput({ items: [itemA, itemB] }));
    expect(a.manifestSha256).toBe(b.manifestSha256);
    expect(a.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(buildEvidenceManifestDraft(normalizeEvidencePreviewInput({ items: [{ ...itemA, role: "CONTRADICTORY" }, itemB] })).manifestSha256).not.toBe(a.manifestSha256);
    expect(buildEvidenceManifestDraft(normalizeEvidencePreviewInput({ items: [{ ...itemA, targetType: "SOURCE_ASSET", targetId: assetId }, itemB] })).manifestSha256).not.toBe(a.manifestSha256);
    expect(buildEvidenceManifestDraft(normalizeEvidencePreviewInput({ items: [{ ...itemA, note: "different" }, itemB] })).manifestSha256).not.toBe(a.manifestSha256);
    expect(buildEvidenceManifestDraft(normalizeEvidencePreviewInput({ items: [itemB, itemA] })).manifestSha256).not.toBe(a.manifestSha256);
  });

  it("hash equals SHA-256 of the documented canonical bytes", async () => {
    const draft = buildEvidenceManifestDraft(normalizeEvidencePreviewInput({
      items: [{ role: "SUPPORTING", targetType: "NOTE_REVISION", targetId: noteRevisionId, note: null }],
    }));
    const { createHash } = await import("node:crypto");
    const bytes = serializeCanonicalEvidencePayload(canonicalEvidencePayload(normalizeEvidencePreviewInput({
      items: [{ role: "SUPPORTING", targetType: "NOTE_REVISION", targetId: noteRevisionId, note: null }],
    })));
    const direct = createHash("sha256").update(bytes, "utf8").digest("hex");
    expect(draft.manifestSha256).toBe(direct);
  });
});
