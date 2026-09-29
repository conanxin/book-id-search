// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ISSUE_RESOLUTION_PENDING_KEY,
  PendingIssueResolutionIntentConflictError,
  clearPendingIssueResolutionReceipt,
  getOrCreateIssueResolutionReceipt,
  hashIssueResolutionCommand,
  loadPendingIssueResolutionReceipt,
  normalizeIssueResolutionBrowserCommand,
  resetPendingIssueResolutionReceiptMemoryForTest,
} from "./issue-resolution-draft";

const SCOPE = {
  projectId: "11111111-1111-4111-8111-111111111111",
  issueId: "22222222-2222-4222-8222-222222222222",
};
const CLAIM = "33333333-3333-4333-8333-333333333333";
const MANIFEST = "44444444-4444-4444-8444-444444444444";
const CURRENT = "55555555-5555-4555-8555-555555555555";

const COMMAND = {
  expectedCurrentResolutionId: null,
  resolutionType: "PREFERRED_CLAIM" as const,
  preferredClaimId: CLAIM,
  rationale: "第一行\n第二行  保持",
  evidenceManifestId: null,
};

beforeEach(() => {
  sessionStorage.clear();
  resetPendingIssueResolutionReceiptMemoryForTest();
});

describe("Issue Resolution browser command normalization", () => {
  it("matches server UUID/rationale normalization and defaults omitted evidence to null", () => {
    expect(normalizeIssueResolutionBrowserCommand({
      expectedCurrentResolutionId: CURRENT.toUpperCase(),
      resolutionType: "PREFERRED_CLAIM",
      preferredClaimId: CLAIM.toUpperCase(),
      rationale: " \u0085\u3000\r\n第一行\r第二行  保持\r\n\u0085 ",
    })).toEqual({
      ...COMMAND,
      expectedCurrentResolutionId: CURRENT,
    });

    expect(normalizeIssueResolutionBrowserCommand({
      ...COMMAND,
      evidenceManifestId: MANIFEST.toUpperCase(),
    })).toEqual({
      ...COMMAND,
      evidenceManifestId: MANIFEST,
    });
  });

  it("rejects unsupported fields, invalid UUIDs/types, NUL, empty/oversized rationale, and preferred-claim mismatches", () => {
    for (const input of [
      { ...COMMAND, extra: true },
      { ...COMMAND, expectedCurrentResolutionId: "bad" },
      { ...COMMAND, evidenceManifestId: "bad" },
      { ...COMMAND, resolutionType: "UNKNOWN" },
      { ...COMMAND, rationale: "\0x" },
      { ...COMMAND, rationale: "  " },
      { ...COMMAND, rationale: "甲".repeat(8001) },
      { ...COMMAND, resolutionType: "PREFERRED_CLAIM", preferredClaimId: null },
      { ...COMMAND, resolutionType: "INSUFFICIENT_EVIDENCE", preferredClaimId: CLAIM },
      { resolutionType: "NO_WORKING_CONCLUSION", preferredClaimId: null, rationale: "x" },
    ]) {
      expect(() => normalizeIssueResolutionBrowserCommand(input)).toThrow();
    }
  });

  it("accepts non-preferred conclusion types only with null preferredClaimId", () => {
    for (const resolutionType of ["INSUFFICIENT_EVIDENCE", "NO_WORKING_CONCLUSION"] as const) {
      expect(normalizeIssueResolutionBrowserCommand({
        ...COMMAND,
        resolutionType,
        preferredClaimId: null,
      })).toEqual({
        ...COMMAND,
        resolutionType,
        preferredClaimId: null,
      });
    }
  });
});

describe("Issue Resolution canonical browser request hash", () => {
  it("hashes equivalent normalized commands identically", async () => {
    const a = normalizeIssueResolutionBrowserCommand({
      ...COMMAND,
      expectedCurrentResolutionId: CURRENT,
      evidenceManifestId: MANIFEST,
    });
    const b = normalizeIssueResolutionBrowserCommand({
      rationale: " \u0085第一行\r\n第二行  保持\r",
      evidenceManifestId: MANIFEST.toUpperCase(),
      preferredClaimId: CLAIM.toUpperCase(),
      resolutionType: "PREFERRED_CLAIM",
      expectedCurrentResolutionId: CURRENT.toUpperCase(),
    });
    expect(await hashIssueResolutionCommand({
      projectId: SCOPE.projectId.toUpperCase(),
      issueId: SCOPE.issueId.toUpperCase(),
    }, b)).toBe(await hashIssueResolutionCommand(SCOPE, a));
    expect(await hashIssueResolutionCommand(SCOPE, a)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("covers scope and every meaningful command field", async () => {
    const base = normalizeIssueResolutionBrowserCommand(COMMAND);
    const original = await hashIssueResolutionCommand(SCOPE, base);
    const otherProject = { ...SCOPE, projectId: MANIFEST };
    const otherIssue = { ...SCOPE, issueId: MANIFEST };
    expect(await hashIssueResolutionCommand(otherProject, base)).not.toBe(original);
    expect(await hashIssueResolutionCommand(otherIssue, base)).not.toBe(original);
    for (const changed of [
      { ...base, expectedCurrentResolutionId: CURRENT },
      { ...base, preferredClaimId: CURRENT },
      { ...base, rationale: "different" },
      { ...base, evidenceManifestId: MANIFEST },
      { ...base, resolutionType: "INSUFFICIENT_EVIDENCE" as const, preferredClaimId: null },
    ]) {
      expect(await hashIssueResolutionCommand(SCOPE, changed)).not.toBe(original);
    }
  });
});

describe("pending Issue Resolution receipt", () => {
  it("does not persist anything before explicit getOrCreate", () => {
    expect(loadPendingIssueResolutionReceipt()).toBeNull();
    expect(sessionStorage.getItem(ISSUE_RESOLUTION_PENDING_KEY)).toBeNull();
  });

  it("restores the exact normalized intent and idempotency key after a simulated reload", async () => {
    const first = await getOrCreateIssueResolutionReceipt(SCOPE, {
      ...COMMAND,
      rationale: "  第一行\r\n第二行  保持  ",
    });
    expect(first.command).toEqual(COMMAND);
    expect(sessionStorage.getItem(ISSUE_RESOLUTION_PENDING_KEY)).toContain(first.idempotencyKey);
    resetPendingIssueResolutionReceiptMemoryForTest();
    expect(loadPendingIssueResolutionReceipt()).toEqual(first);
    const retried = await getOrCreateIssueResolutionReceipt(SCOPE, COMMAND);
    expect(retried).toEqual(first);
  });

  it("keeps same-page retry identity when storage writes fail", async () => {
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    const first = await getOrCreateIssueResolutionReceipt(SCOPE, COMMAND);
    const second = await getOrCreateIssueResolutionReceipt(SCOPE, COMMAND);
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
    expect(loadPendingIssueResolutionReceipt()).toEqual(first);
    spy.mockRestore();
  });

  it("never silently rotates the key for changed intent or another Issue scope", async () => {
    const first = await getOrCreateIssueResolutionReceipt(SCOPE, COMMAND);
    await expect(getOrCreateIssueResolutionReceipt(SCOPE, {
      ...COMMAND,
      rationale: "changed",
    })).rejects.toBeInstanceOf(PendingIssueResolutionIntentConflictError);
    await expect(getOrCreateIssueResolutionReceipt({
      ...SCOPE,
      issueId: MANIFEST,
    }, COMMAND)).rejects.toBeInstanceOf(PendingIssueResolutionIntentConflictError);
    expect(loadPendingIssueResolutionReceipt()).toEqual(first);
  });

  it("ignores malformed persisted receipts instead of restoring an unsafe key", () => {
    sessionStorage.setItem(ISSUE_RESOLUTION_PENDING_KEY, JSON.stringify({
      ...SCOPE,
      requestHash: "bad",
      idempotencyKey: CURRENT,
      createdAt: new Date().toISOString(),
      command: COMMAND,
    }));
    expect(loadPendingIssueResolutionReceipt()).toBeNull();
  });

  it("clear creates an in-memory tombstone even if removeItem fails", async () => {
    await getOrCreateIssueResolutionReceipt(SCOPE, COMMAND);
    const spy = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    clearPendingIssueResolutionReceipt();
    expect(loadPendingIssueResolutionReceipt()).toBeNull();
    spy.mockRestore();
  });
});
