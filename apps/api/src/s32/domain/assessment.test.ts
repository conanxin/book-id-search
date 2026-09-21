import { describe, expect, it } from "vitest";
import {
  InvalidAssessmentCursorError,
  InvalidAssessmentInputError,
  decodeAssessmentCursor,
  encodeAssessmentCursor,
  hashAssessmentCreateRequest,
  normalizeAssessmentCreateInput,
  readAssessmentHistoryQuery,
} from "./assessment.js";

const P = "11111111-1111-4111-8111-111111111111";
const I = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const SOURCE = "44444444-4444-4444-8444-444444444444";

const BASE = {
  stance: "SUPPORTS",
  confidenceLevel: null,
  reasoning: "当前证据支持。",
  expectedManifestSha256: "a".repeat(64),
  items: [{
    role: "SUPPORTING",
    targetType: "SOURCE",
    targetId: SOURCE,
    note: null,
  }],
};

describe("assessment create normalization", () => {
  it.each(["SUPPORTS", "CONTRADICTS", "INCONCLUSIVE"])("accepts stance %s", stance => {
    const normalized = normalizeAssessmentCreateInput({
      ...BASE,
      stance,
      reasoning: " \u0085\r\n第一行\r第二行  保持 \u0085 ",
    });
    expect(normalized.reasoning).toBe("第一行\n第二行  保持");
  });

  it.each([undefined, null, "LOW", "MEDIUM", "HIGH"])("accepts confidence %s", confidenceLevel => {
    expect(normalizeAssessmentCreateInput({ ...BASE, confidenceLevel }).confidenceLevel)
      .toBe(confidenceLevel ?? null);
  });

  it("rejects NUL, empty, and >8000-code-point reasoning but accepts exactly 8000", () => {
    for (const reasoning of ["\0x", " \t\u0085 ", "甲".repeat(8001)]) {
      expect(() => normalizeAssessmentCreateInput({ ...BASE, reasoning }))
        .toThrow(InvalidAssessmentInputError);
    }
    expect(normalizeAssessmentCreateInput({ ...BASE, reasoning: "𠮷".repeat(8000) }).reasoning)
      .toBe("𠮷".repeat(8000));
  });

  it("rejects unknown top-level fields, malformed hashes, and invalid evidence", () => {
    expect(() => normalizeAssessmentCreateInput({ ...BASE, actorId: P }))
      .toThrow(InvalidAssessmentInputError);
    expect(() => normalizeAssessmentCreateInput({ ...BASE, expectedManifestSha256: "A".repeat(64) }))
      .toThrow(InvalidAssessmentInputError);
    expect(() => normalizeAssessmentCreateInput({ ...BASE, items: [] }))
      .toThrow();
    expect(() => normalizeAssessmentCreateInput({ ...BASE, items: [{ ...BASE.items[0], extra: true }] }))
      .toThrow();
  });

  it("normalizes evidence UUIDs through the shared M2-C contract", () => {
    const normalized = normalizeAssessmentCreateInput({
      ...BASE,
      items: [{ ...BASE.items[0], targetId: SOURCE.toUpperCase(), note: " why " }],
    });
    expect(normalized.items).toEqual([{
      role: "SUPPORTING",
      targetType: "SOURCE",
      targetId: SOURCE,
      note: "why",
    }]);
  });
});

describe("assessment request hash", () => {
  it("is deterministic after normalization and changes for every meaningful command field", () => {
    const base = normalizeAssessmentCreateInput(BASE);
    expect(hashAssessmentCreateRequest(P, I, C, base))
      .toBe(hashAssessmentCreateRequest(P.toUpperCase(), I.toUpperCase(), C.toUpperCase(), base));

    const variants = [
      { ...BASE, stance: "CONTRADICTS" },
      { ...BASE, confidenceLevel: "HIGH" },
      { ...BASE, reasoning: "different" },
      { ...BASE, expectedManifestSha256: "b".repeat(64) },
      { ...BASE, items: [{ ...BASE.items[0], role: "CONTEXTUAL" }] },
      { ...BASE, items: [{ ...BASE.items[0], note: "note" }] },
    ];
    for (const variant of variants) {
      expect(hashAssessmentCreateRequest(P, I, C, normalizeAssessmentCreateInput(variant)))
        .not.toBe(hashAssessmentCreateRequest(P, I, C, base));
    }
  });

  it("treats canonical-equivalent reasoning/evidence IDs as the same command", () => {
    const a = normalizeAssessmentCreateInput(BASE);
    const b = normalizeAssessmentCreateInput({
      ...BASE,
      reasoning: "  当前证据支持。 \r\n",
      items: [{ ...BASE.items[0], targetId: SOURCE.toUpperCase() }],
    });
    expect(hashAssessmentCreateRequest(P, I, C, a)).toBe(hashAssessmentCreateRequest(P, I, C, b));
  });
});

describe("assessment history query", () => {
  it("round-trips a versioned opaque cursor and defaults limit to 20", () => {
    const cursor = encodeAssessmentCursor({
      createdAt: "2026-09-21T00:00:00.000Z",
      id: C,
    });
    expect(decodeAssessmentCursor(cursor)).toEqual({
      createdAt: "2026-09-21T00:00:00.000Z",
      id: C,
    });
    expect(readAssessmentHistoryQuery({ cursor })).toEqual({
      limit: 20,
      cursor: { createdAt: "2026-09-21T00:00:00.000Z", id: C },
    });
  });

  it("accepts limit 1..50 and rejects larger/invalid limits without clamping", () => {
    expect(readAssessmentHistoryQuery({ limit: "1" }).limit).toBe(1);
    expect(readAssessmentHistoryQuery({ limit: "50" }).limit).toBe(50);
    for (const limit of ["0", "51", "x", ["20"]]) {
      expect(() => readAssessmentHistoryQuery({ limit })).toThrow(InvalidAssessmentInputError);
    }
  });

  it("rejects malformed/tampered/unknown-version cursor and unknown query fields", () => {
    const cursor = encodeAssessmentCursor({ createdAt: "2026-09-21T00:00:00.000Z", id: C });
    expect(() => readAssessmentHistoryQuery({ cursor: cursor + "x" }))
      .toThrow(InvalidAssessmentCursorError);
    const unsupported = Buffer.from(JSON.stringify({
      v: 2,
      createdAt: "2026-09-21T00:00:00.000Z",
      id: C,
    }), "utf8").toString("base64url");
    expect(() => decodeAssessmentCursor(unsupported)).toThrow(InvalidAssessmentCursorError);
    expect(() => readAssessmentHistoryQuery({ extra: "x" })).toThrow(InvalidAssessmentInputError);
  });
});
