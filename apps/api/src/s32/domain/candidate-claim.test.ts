import { describe, expect, it } from "vitest";
import {
  InvalidCandidateClaimInputError,
  hashCandidateClaimCreateRequest,
  normalizeCandidateClaimStatement,
  readCandidateClaimId,
} from "./candidate-claim.js";

const projectId = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
const issueId = "BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB";

describe("candidate claim domain", () => {
  it("canonicalizes CR/LF and Unicode White_Space to one ASCII space", () => {
    expect(normalizeCandidateClaimStatement("\u0085  刘祥店\r\n在 1960 年代\t整体迁出。  \u0085"))
      .toBe("刘祥店 在 1960 年代 整体迁出。");
  });

  it("rejects NUL, blank, non-string, and more than 4000 code points", () => {
    expect(() => normalizeCandidateClaimStatement("a\u0000b")).toThrow(InvalidCandidateClaimInputError);
    expect(() => normalizeCandidateClaimStatement("\u0085 \t")).toThrow(InvalidCandidateClaimInputError);
    expect(() => normalizeCandidateClaimStatement(1)).toThrow(InvalidCandidateClaimInputError);
    expect(() => normalizeCandidateClaimStatement("𠮷".repeat(4001))).toThrow(InvalidCandidateClaimInputError);
    expect(normalizeCandidateClaimStatement("𠮷".repeat(4000))).toBe("𠮷".repeat(4000));
  });

  it("normalizes Claim IDs to lowercase UUIDs", () => {
    expect(readCandidateClaimId("CCCCCCCC-CCCC-4CCC-8CCC-CCCCCCCCCCCC"))
      .toBe("cccccccc-cccc-4ccc-8ccc-cccccccccccc");
    expect(() => readCandidateClaimId("bad")).toThrow(InvalidCandidateClaimInputError);
  });

  it("hashes lowercase Project+Issue and normalized statement in fixed key order", () => {
    const a = hashCandidateClaimCreateRequest(projectId, issueId, "\u0085 A\r\n B \u0085");
    const b = hashCandidateClaimCreateRequest(projectId.toLowerCase(), issueId.toLowerCase(), "A B");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(b);
    expect(a).not.toBe(hashCandidateClaimCreateRequest(
      projectId,
      "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      "A B",
    ));
  });
});
