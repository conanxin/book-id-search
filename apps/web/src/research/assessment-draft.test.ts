// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ASSESSMENT_PENDING_KEY,
  PendingAssessmentIntentConflictError,
  clearPendingAssessmentReceipt,
  getOrCreateAssessmentReceipt,
  hashAssessmentCommand,
  loadPendingAssessmentReceipt,
  normalizeAssessmentBrowserCommand,
  resetPendingAssessmentReceiptMemoryForTest,
} from "./assessment-draft";

const SCOPE = {
  projectId: "11111111-1111-4111-8111-111111111111",
  issueId: "22222222-2222-4222-8222-222222222222",
  claimId: "33333333-3333-4333-8333-333333333333",
};
const SOURCE = "44444444-4444-4444-8444-444444444444";

const COMMAND = {
  stance: "SUPPORTS" as const,
  confidenceLevel: null,
  reasoning: "当前证据支持。",
  expectedManifestSha256: "a".repeat(64),
  items: [{
    role: "SUPPORTING" as const,
    targetType: "SOURCE" as const,
    targetId: SOURCE,
    note: null,
  }],
};

beforeEach(() => {
  sessionStorage.clear();
  resetPendingAssessmentReceiptMemoryForTest();
});

describe("assessment browser command normalization", () => {
  it("matches server reasoning/UUID normalization and preserves evidence order", () => {
    expect(normalizeAssessmentBrowserCommand({
      ...COMMAND,
      reasoning: " \u0085\r\n第一行\r第二行  保持 \u0085 ",
      items: [{ ...COMMAND.items[0], targetId: SOURCE.toUpperCase() }],
    })).toEqual({
      ...COMMAND,
      reasoning: "第一行\n第二行  保持",
    });
  });

  it("rejects NUL, invalid stance/hash, empty reasoning, and >8000 code points", () => {
    for (const input of [
      { ...COMMAND, reasoning: "\0x" },
      { ...COMMAND, reasoning: "  " },
      { ...COMMAND, reasoning: "甲".repeat(8001) },
      { ...COMMAND, stance: "TRUE" },
      { ...COMMAND, expectedManifestSha256: "A".repeat(64) },
    ]) {
      expect(() => normalizeAssessmentBrowserCommand(input)).toThrow();
    }
  });

  it("hash is deterministic and covers judgment plus evidence order", async () => {
    const normalized = normalizeAssessmentBrowserCommand(COMMAND);
    const same = normalizeAssessmentBrowserCommand({
      ...COMMAND,
      reasoning: "  当前证据支持。\r\n",
      items: [{ ...COMMAND.items[0], targetId: SOURCE.toUpperCase() }],
    });
    expect(await hashAssessmentCommand(SCOPE, normalized)).toBe(await hashAssessmentCommand(SCOPE, same));
    expect(await hashAssessmentCommand(SCOPE, normalized)).not.toBe(
      await hashAssessmentCommand(SCOPE, { ...normalized, stance: "CONTRADICTS" }),
    );
  });
});

describe("pending Assessment receipt", () => {
  it("does not create persistence before explicit getOrCreate", () => {
    expect(loadPendingAssessmentReceipt()).toBeNull();
    expect(sessionStorage.getItem(ASSESSMENT_PENDING_KEY)).toBeNull();
  });

  it("restores exact committed intent and key after a simulated reload", async () => {
    const first = await getOrCreateAssessmentReceipt(SCOPE, COMMAND);
    expect(sessionStorage.getItem(ASSESSMENT_PENDING_KEY)).toContain(first.idempotencyKey);
    resetPendingAssessmentReceiptMemoryForTest();
    const restored = loadPendingAssessmentReceipt();
    expect(restored).toEqual(first);
    const retried = await getOrCreateAssessmentReceipt(SCOPE, COMMAND);
    expect(retried.idempotencyKey).toBe(first.idempotencyKey);
    expect(retried.command).toEqual(first.command);
  });

  it("storage write failure preserves same-page in-memory retry identity", async () => {
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    const first = await getOrCreateAssessmentReceipt(SCOPE, COMMAND);
    const second = await getOrCreateAssessmentReceipt(SCOPE, COMMAND);
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
    expect(loadPendingAssessmentReceipt()).toEqual(first);
    spy.mockRestore();
  });

  it("same scope with changed intent never silently rotates the key", async () => {
    const first = await getOrCreateAssessmentReceipt(SCOPE, COMMAND);
    await expect(getOrCreateAssessmentReceipt(SCOPE, {
      ...COMMAND,
      stance: "CONTRADICTS",
    })).rejects.toBeInstanceOf(PendingAssessmentIntentConflictError);
    expect(loadPendingAssessmentReceipt()?.idempotencyKey).toBe(first.idempotencyKey);
  });

  it("does not overwrite an unconfirmed command from another Claim scope", async () => {
    const first = await getOrCreateAssessmentReceipt(SCOPE, COMMAND);
    await expect(getOrCreateAssessmentReceipt({
      ...SCOPE,
      claimId: "55555555-5555-4555-8555-555555555555",
    }, COMMAND)).rejects.toBeInstanceOf(PendingAssessmentIntentConflictError);
    expect(loadPendingAssessmentReceipt()).toEqual(first);
  });

  it("clear creates an in-memory tombstone even when removeItem fails", async () => {
    await getOrCreateAssessmentReceipt(SCOPE, COMMAND);
    const spy = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    clearPendingAssessmentReceipt();
    expect(loadPendingAssessmentReceipt()).toBeNull();
    spy.mockRestore();
  });
});
