import { describe, expect, it, vi } from "vitest";
import {
  EvidenceSelectionScopeNotFoundError,
  EvidenceTargetNotAvailableError,
  createEvidenceSelectionService,
  type EvidenceSelectionStore,
} from "./evidence-selection";
import { InvalidEvidenceDraftError } from "../domain/evidence-selection";
import { InvalidProjectInputError } from "../domain/project";
import { InvalidResearchIssueInputError } from "../domain/research-issue";
import { InvalidCandidateClaimInputError } from "../domain/candidate-claim";

const p = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const i = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const c = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const src = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const claim = { id: c, statement: "刘祥店可能在1960年代整体迁出。", lifecycleState: "ACTIVE" as const };

function makeStore(overrides: Partial<EvidenceSelectionStore> = {}): EvidenceSelectionStore & {
  candidates: ReturnType<typeof vi.fn>;
  authorizePreview: ReturnType<typeof vi.fn>;
} {
  return {
    candidates: vi.fn(async () => ({ claim, candidates: [] })),
    authorizePreview: vi.fn(async () => ({ claim })),
    ...overrides,
  } as never;
}

describe("candidates", () => {
  it("canonicalizes ids to lowercase before store access", async () => {
    const store = makeStore();
    const service = createEvidenceSelectionService(store);
    await service.candidates(p.toUpperCase(), i.toUpperCase(), c.toUpperCase());
    expect(store.candidates).toHaveBeenCalledWith({ projectId: p, issueId: i, claimId: c });
  });

  it("malformed ids never call the store", async () => {
    const store = makeStore();
    const service = createEvidenceSelectionService(store);
    await expect(service.candidates("bad", i, c)).rejects.toThrow(InvalidProjectInputError);
    await expect(service.candidates(p, "bad", c)).rejects.toThrow(InvalidResearchIssueInputError);
    await expect(service.candidates(p, i, "bad")).rejects.toThrow(InvalidCandidateClaimInputError);
    expect(store.candidates).not.toHaveBeenCalled();
  });

  it("passes through the store result", async () => {
    const candidates = [{ targetType: "SOURCE" as const, targetId: src }];
    const store = makeStore({ candidates: vi.fn(async () => ({ claim, candidates: candidates as never })) });
    const service = createEvidenceSelectionService(store);
    await expect(service.candidates(p, i, c)).resolves.toEqual({ claim, candidates });
  });
});

describe("preview", () => {
  const body = { items: [{ role: "SUPPORTING", targetType: "SOURCE", targetId: src, note: null }] };

  it("normalizes body before authorization and hashes only after authorization", async () => {
    const store = makeStore();
    const service = createEvidenceSelectionService(store);
    const result = await service.preview(p, i, c, { items: [{ role: "SUPPORTING", targetType: "SOURCE", targetId: src.toUpperCase(), note: "  x  " }] });
    expect(store.authorizePreview).toHaveBeenCalledTimes(1);
    const arg = (store.authorizePreview as ReturnType<typeof vi.fn>).mock.calls[0][0] as { items: { targetId: string; note: string | null }[] };
    expect(arg.items[0].targetId).toBe(src);
    expect(arg.items[0].note).toBe("x");
    expect(result.persisted).toBe(false);
    expect(result.claim).toEqual({ id: claim.id, statement: claim.statement });
    expect(result.draft.schemaVersion).toBe(1);
    expect(result.draft.purpose).toBe("CLAIM_ASSESSMENT");
    expect(result.draft.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.draft.items[0]).toMatchObject({ ordinal: 1, role: "SUPPORTING", targetType: "SOURCE", targetId: src, note: "x", locatorType: null, locator: null, excerpt: null });
  });

  it("malformed body never calls the store", async () => {
    const store = makeStore();
    const service = createEvidenceSelectionService(store);
    await expect(service.preview(p, i, c, { items: [] })).rejects.toThrow(InvalidEvidenceDraftError);
    await expect(service.preview(p, i, c, { items: [{ role: "BAD", targetType: "SOURCE", targetId: src }] })).rejects.toThrow(InvalidEvidenceDraftError);
    expect(store.authorizePreview).not.toHaveBeenCalled();
  });

  it("null authorization becomes EvidenceSelectionScopeNotFoundError", async () => {
    const store = makeStore({ authorizePreview: vi.fn(async () => null) });
    const service = createEvidenceSelectionService(store);
    await expect(service.preview(p, i, c, body)).rejects.toThrow(EvidenceSelectionScopeNotFoundError);
  });

  it("response claim exposes only id and statement", async () => {
    const store = makeStore();
    const service = createEvidenceSelectionService(store);
    const result = await service.preview(p, i, c, body);
    expect(Object.keys(result.claim).sort()).toEqual(["id", "statement"]);
  });

  it("persisted is literal false", async () => {
    const store = makeStore();
    const service = createEvidenceSelectionService(store);
    const result = await service.preview(p, i, c, body);
    expect(result.persisted).toBe(false);
    expect(result.persisted).not.toBeTruthy();
  });
});

describe("service generates no identifiers", () => {
  it("never calls randomUUID or touches idempotency", async () => {
    const crypto = await import("node:crypto");
    const randomUUID = vi.fn(crypto.randomUUID);
    vi.doMock("node:crypto", async () => {
      const actual = await vi.importActual<typeof import("node:crypto")>("node:crypto");
      return { ...actual, randomUUID };
    });
    try {
      const { createEvidenceSelectionService: freshCreate } = await import("./evidence-selection");
      const store = makeStore();
      const service = freshCreate(store);
      await service.candidates(p, i, c);
      await service.preview(p, i, c, { items: [{ role: "SUPPORTING", targetType: "SOURCE", targetId: src, note: null }] });
      expect(randomUUID).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock("node:crypto");
    }
  });

  it("EvidenceTargetNotAvailableError is exported and distinct", () => {
    expect(new EvidenceTargetNotAvailableError("x")).toBeInstanceOf(Error);
    expect(new EvidenceTargetNotAvailableError("x")).not.toBeInstanceOf(EvidenceSelectionScopeNotFoundError);
  });
});
