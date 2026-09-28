import { existsSync } from "node:fs";
import { describe, expect, expectTypeOf, it } from "vitest";
import type * as Domain from "./issue-resolution.js";

// Missing module is an assertion-level RED, not a test collection/import error.
const modulePath = "./issue-resolution.js";
const api = existsSync(new URL("./issue-resolution.ts", import.meta.url))
  ? await import(modulePath) as typeof Domain : {} as typeof Domain;
function fn<K extends keyof typeof Domain>(name: K): typeof Domain[K] {
  expect(api[name], `missing domain contract: ${name}`).toBeTypeOf("function");
  return api[name];
}
const normalize = (value: unknown) => fn("normalizeIssueResolutionCreateInput")(value);
const hash = (project: string, issue: string, value: Domain.NormalizedIssueResolutionInput) =>
  fn("hashIssueResolutionCreateRequest")(project, issue, value);
const encode = (value: Domain.IssueResolutionCursor) => fn("encodeIssueResolutionCursor")(value);
const decode = (value: string) => fn("decodeIssueResolutionCursor")(value);
const query = (value: unknown) => fn("readIssueResolutionHistoryQuery")(value);
const P = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const I = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const M = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const R = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const NEWER = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const BASE = { expectedCurrentResolutionId: null, resolutionType: "PREFERRED_CLAIM", preferredClaimId: C, rationale: "第一行\n第二行  保持", evidenceManifestId: null };
const token = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const KEY = { v: 2, createdAtMicros: "1790000000123456", id: R };

describe("IssueResolution strict create contract", () => {
  it("normalizes UUIDs, Unicode edge whitespace and CRLF/CR without changing internal text", () => {
    expect(normalize({ ...BASE, expectedCurrentResolutionId: R.toUpperCase(), preferredClaimId: C.toUpperCase(), evidenceManifestId: M.toUpperCase(), rationale: "\u0085\u3000\r\n第一行\r第二行  保持\r\n\u0085 " })).toEqual({ ...BASE, expectedCurrentResolutionId: R, evidenceManifestId: M });
  });
  it.each(["INSUFFICIENT_EVIDENCE", "NO_WORKING_CONCLUSION"])("accepts %s only with null preferred Claim", resolutionType => {
    expect(normalize({ ...BASE, resolutionType, preferredClaimId: null })).toEqual({ ...BASE, resolutionType, preferredClaimId: null });
    expect(() => normalize({ ...BASE, resolutionType })).toThrow(fn("InvalidIssueResolutionInputError"));
  });
  it.each([null, undefined, [], "x", 1, new Date(), Object.create({ ...BASE })])("rejects non-record or inherited command %#", input => {
    expect(() => normalize(input)).toThrow(fn("InvalidIssueResolutionInputError"));
  });
  it.each(["actorId", "id", "createdAt", "isCurrent", "supersedesResolutionId", "projectId", "issueId", "items", "extra"])("rejects unknown command key %s", key => {
    expect(() => normalize({ ...BASE, [key]: "x" })).toThrow(fn("InvalidIssueResolutionInputError"));
  });
  it("rejects non-enumerable and symbol extra keys too", () => {
    for (const value of [Object.defineProperty({ ...BASE }, "extra", { value: true }), { ...BASE, [Symbol("extra")]: true }]) {
      expect(() => normalize(value)).toThrow(fn("InvalidIssueResolutionInputError"));
    }
  });
  it.each(["expectedCurrentResolutionId", "preferredClaimId", "resolutionType", "rationale"])("requires explicit field %s", field => {
    const value: Record<string, unknown> = { ...BASE }; delete value[field];
    expect(() => normalize(value)).toThrow(fn("InvalidIssueResolutionInputError"));
  });
  it.each([undefined, null, false, "preferred_claim", "INCONCLUSIVE", "", "PREFERRED_CLAIM "])("rejects invalid resolution type %#", resolutionType => {
    expect(() => normalize({ ...BASE, resolutionType })).toThrow(fn("InvalidIssueResolutionInputError"));
  });
  it.each([null, undefined, "", "bad-uuid", 1, {}, ` ${C}`, `${C}\n`])("requires a UUID for preferred Claim %#", preferredClaimId => {
    expect(() => normalize({ ...BASE, preferredClaimId })).toThrow(fn("InvalidIssueResolutionInputError"));
  });
  it.each(["expectedCurrentResolutionId", "evidenceManifestId"])("rejects malformed optional-reference values in %s", field => {
    for (const value of ["", "not-uuid", 123, [], {}, ` ${R}`, `${R}\n`]) {
      expect(() => normalize({ ...BASE, [field]: value })).toThrow(fn("InvalidIssueResolutionInputError"));
    }
  });
  it("accepts null pointer and omitted/null/undefined evidence Manifest as canonical null", () => {
    const { evidenceManifestId: _, ...withoutEvidence } = BASE;
    for (const value of [withoutEvidence, { ...BASE, evidenceManifestId: undefined }, BASE]) expect(normalize(value)).toEqual(BASE);
    expect(() => normalize({ ...BASE, expectedCurrentResolutionId: undefined })).toThrow(fn("InvalidIssueResolutionInputError"));
  });
  it.each([undefined, null, 1, {}, "", "\u0085 \t\r\n\u3000", "\0valid", "valid\0"])("rejects invalid rationale %#", rationale => {
    expect(() => normalize({ ...BASE, rationale })).toThrow(fn("InvalidIssueResolutionInputError"));
  });
  it.each([1, 8000])("accepts %s Unicode code points including supplementary characters", count => {
    expect(normalize({ ...BASE, rationale: ` \u0085${"𠮷".repeat(count)}\r\n` }).rationale).toBe("𠮷".repeat(count));
  });
  it("rejects 8001 code points after normalization", () => {
    expect(() => normalize({ ...BASE, rationale: "𠮷".repeat(8001) })).toThrow(fn("InvalidIssueResolutionInputError"));
  });
  it("does not mutate its input and preserves internal Unicode whitespace", () => {
    const input = Object.freeze({ ...BASE, rationale: " a\u0085\t  b\r\nc " });
    expect(normalize(input).rationale).toBe("a\u0085\t  b\nc");
    expect(input.rationale).toBe(" a\u0085\t  b\r\nc ");
  });
  it("canonicalizes a Resolution ID and rejects invalid IDs", () => {
    expect(fn("readIssueResolutionId")(R.toUpperCase())).toBe(R);
    for (const value of [null, undefined, 1, "", "bad", `${R}\n`]) expect(() => fn("readIssueResolutionId")(value)).toThrow(fn("InvalidIssueResolutionInputError"));
  });
});

describe("IssueResolution canonical request hash", () => {
  it("hashes equivalent commands identically including all UUID case and normalized rationale", () => {
    const a = normalize({ ...BASE, expectedCurrentResolutionId: R, evidenceManifestId: M });
    const b = normalize({ rationale: " \u0085第一行\r\n第二行  保持\r", evidenceManifestId: M.toUpperCase(), preferredClaimId: C.toUpperCase(), resolutionType: "PREFERRED_CLAIM", expectedCurrentResolutionId: R.toUpperCase() });
    expect(hash(P.toUpperCase(), I.toUpperCase(), b)).toBe(hash(P, I, a));
    expect(hash(P, I, a)).toMatch(/^[0-9a-f]{64}$/);
  });
  it("changes for each meaningful command field, including references versus null", () => {
    const a = normalize(BASE), original = hash(P, I, a);
    expect(hash(M, I, a)).not.toBe(original);
    expect(hash(P, M, a)).not.toBe(original);
    for (const change of [{ expectedCurrentResolutionId: R }, { preferredClaimId: R }, { rationale: "different" }, { evidenceManifestId: M }]) expect(hash(P, I, normalize({ ...BASE, ...change }))).not.toBe(original);
    const insufficient = normalize({ ...BASE, resolutionType: "INSUFFICIENT_EVIDENCE", preferredClaimId: null });
    const noConclusion = normalize({ ...insufficient, resolutionType: "NO_WORKING_CONCLUSION" });
    expect(hash(P, I, insufficient)).not.toBe(original);
    expect(hash(P, I, noConclusion)).not.toBe(hash(P, I, insufficient));
  });
  it("rejects invalid scope UUIDs and does not hash an invalid command", () => {
    const input = normalize(BASE);
    expect(() => hash("bad", I, input)).toThrow(fn("InvalidIssueResolutionInputError"));
    expect(() => hash(P, "bad", input)).toThrow(fn("InvalidIssueResolutionInputError"));
    expect(() => hash(P, I, { ...input, rationale: " " })).toThrow(fn("InvalidIssueResolutionInputError"));
  });
});

describe("IssueResolution microsecond cursor and history query", () => {
  it("retains the final microseconds and values beyond Number.MAX_SAFE_INTEGER without Date coercion", () => {
    for (const micros of ["0", "1790000000123456", "1790000000123457", "999999999999999999"]) {
      const cursor = { createdAtMicros: micros, id: R };
      expect(decode(encode(cursor))).toEqual(cursor);
    }
    expect(encode({ createdAtMicros: "1790000000123456", id: R })).not.toBe(encode({ createdAtMicros: "1790000000123457", id: R }));
  });
  it("encodes lowercase UUID with canonical v2 JSON and no padding", () => {
    const encoded = encode({ createdAtMicros: KEY.createdAtMicros, id: R.toUpperCase() });
    expect(Buffer.from(encoded, "base64url").toString()).toBe('{"v":2,"createdAtMicros":"1790000000123456","id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"}');
    expect(encoded).not.toContain("=");
    expect(decode(encoded).id).toBe(R);
  });
  it.each(["", "01", "-1", "+1", "1.1", "1e6", " 1", "1\n", "9999999999999999999", 1790000000123456, null])("rejects invalid epoch microseconds %#", micros => {
    expect(() => encode({ createdAtMicros: micros as string, id: R })).toThrow(fn("InvalidIssueResolutionCursorError"));
    expect(() => decode(token({ ...KEY, createdAtMicros: micros }))).toThrow(fn("InvalidIssueResolutionCursorError"));
  });
  it("rejects malformed UUIDs on both cursor boundaries", () => {
    for (const id of ["bad", `${R}\n`, 1, null]) {
      expect(() => encode({ createdAtMicros: KEY.createdAtMicros, id: id as string })).toThrow(fn("InvalidIssueResolutionCursorError"));
      expect(() => decode(token({ ...KEY, id }))).toThrow(fn("InvalidIssueResolutionCursorError"));
    }
  });
  it("rejects malformed, tampered, noncanonical and unknown-version tokens", () => {
    for (const value of ["", "%%%", token(KEY)+"x", token(KEY)+"=", " "+token(KEY), token({ ...KEY, v: 1 }), token({ ...KEY, id: R.toUpperCase() }), token({ ...KEY, extra: true }), token({ id: R, createdAtMicros: KEY.createdAtMicros, v: 2 }), token(null), token([]), token("string"), Buffer.from('{ "v":2,"createdAtMicros":"1790000000123456","id":"'+R+'"}').toString('base64url')]) {
      expect(() => decode(value)).toThrow(fn("InvalidIssueResolutionCursorError"));
    }
  });
  it.each([undefined, null, {}])("defaults history to limit20/null cursor %#", value => {
    expect(query(value)).toEqual({ limit: 20, cursor: null });
  });
  it.each(["1", "20", "50"])("accepts limit %s and microsecond cursor", limit => {
    expect(query({ limit, cursor: token(KEY) })).toEqual({ limit: Number(limit), cursor: { createdAtMicros: KEY.createdAtMicros, id: R } });
  });
  it.each(["0", "51", "-1", "1.5", "1e1", "", " 20", "20\n", 20, null, ["20"]])("rejects invalid history limit %# without clamping", limit => {
    expect(() => query({ limit })).toThrow(fn("InvalidIssueResolutionInputError"));
  });
  it("rejects unknown history keys, nonobjects and nonstring cursor", () => {
    for (const value of [{ offset: "0" }, { order: "asc" }, [], "x"]) expect(() => query(value)).toThrow(fn("InvalidIssueResolutionInputError"));
    for (const cursor of [null, 1, [], {}]) expect(() => query({ cursor })).toThrow(fn("InvalidIssueResolutionCursorError"));
  });
});

describe("schema-compatible read DTO and authoritative pointer", () => {
  it("allows historical null rationale in records/detail while write input remains non-null", () => {
    expectTypeOf<Domain.IssueResolutionRecord["rationale"]>().toEqualTypeOf<string | null>();
    expectTypeOf<Domain.NormalizedIssueResolutionInput["rationale"]>().toEqualTypeOf<string>();
    const record: Domain.IssueResolutionRecord = { id: R, issueId: I, resolutionType: "PREFERRED_CLAIM", preferredClaimId: C, rationale: null, evidenceManifestId: null, createdAt: "2026-09-28T00:00:00.123456Z" };
    const detail: Domain.IssueResolutionDetailResponse = { issue: { id: I, lifecycleState: "OPEN", currentResolutionId: R, updatedAt: record.createdAt }, resolution: { id: R, issueId: I, resolutionType: "PREFERRED_CLAIM", preferredClaimId: C, rationale: null, createdAt: record.createdAt, isCurrent: true }, evidenceBasisAvailable: false, evidenceManifest: null };
    expect(detail.resolution.rationale).toBeNull();
    expect(() => normalize({ ...BASE, rationale: record.rationale })).toThrow(fn("InvalidIssueResolutionInputError"));
  });
  it("uses the authoritative pointer even when the newer history page omits the current row", () => {
    const summary: Domain.IssueResolutionSummary = { id: R, issueId: I, resolutionType: "PREFERRED_CLAIM", preferredClaimId: C, rationaleExcerpt: null, createdAt: "2026-09-28T00:00:00.123456Z", isCurrent: true, evidenceBasisAvailable: false, evidenceManifest: null };
    const history: Domain.IssueResolutionHistoryResponse = { issue: { id: I, lifecycleState: "RESOLVED", currentResolutionId: R, updatedAt: summary.createdAt }, currentResolution: summary, resolutions: [{ ...summary, id: NEWER, createdAt: "2026-09-28T00:00:01.000000Z", isCurrent: false }], nextCursor: null };
    const current: Domain.CurrentWorkingConclusion = history;
    expect(current.currentResolution?.id).toBe(current.issue.currentResolutionId);
    expect(fn("isCurrentIssueResolution")(history.resolutions[0]!.id, history.issue.currentResolutionId)).toBe(false);
    expect(fn("isCurrentIssueResolution")(R, history.issue.currentResolutionId)).toBe(true);
    expect(fn("isCurrentIssueResolution")(NEWER, null)).toBe(false);
    expect(fn("isCurrentIssueResolution")(R.toUpperCase(), R)).toBe(true);
  });
});
