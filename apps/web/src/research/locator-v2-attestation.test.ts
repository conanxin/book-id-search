import { describe, expect, it } from "vitest";
import { createLocatorReviewSession, type LocatorAttestationContext } from "./locator-v2-attestation";
import type { LocatorDraftV2 } from "./locator-v2-draft";

// Synthetic bytes and actor only; no human source-page review is asserted.
const P = "11111111-1111-4111-8111-111111111111";
const E = "22222222-2222-4222-8222-222222222222";
const S = "33333333-3333-4333-8333-333333333333";
const A = "44444444-4444-4444-8444-444444444444";
const HUMAN = "55555555-5555-4555-8555-555555555555";
const OTHER = "66666666-6666-4666-8666-666666666666";
const ABC_SHA = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const T = "2026-10-10T03:00:00.000Z";
const bytes = () => new TextEncoder().encode("abc");
const proposal = (): LocatorDraftV2 => ({ schemaVersion: 2, projectId: P, editionId: E,
  sourceId: S, sourceAssetId: A, assetSha256: ABC_SHA, kind: "PRINTED_PAGE", label: "87" });
const context = (): LocatorAttestationContext => ({ witness: {
  projectId: P, editionId: E, sourceId: S, sourceAssetId: A, assetSha256: ABC_SHA,
  sourceType: "PUBLICATION", assetRole: "ORIGINAL", access: "READABLE",
}, actor: { id: HUMAN, type: "HUMAN" }, authGeneration: 1, accessRevision: 1 });
const check = () => ({ inspectedOriginal: true, observedLabel: "87", assetPageNumber: 93, decision: "MATCHED" });
function fixture(initial = context(), draft = proposal()) {
  let current: LocatorAttestationContext | null = initial;
  let timestamp = T;
  const session = createLocatorReviewSession(draft, { currentContext: () => current, now: () => timestamp });
  return { session, draft, getContext: () => current!, setContext: (value: LocatorAttestationContext | null) => { current = value; },
    setTime: (value: string) => { timestamp = value; } };
}
async function reviewed() {
  const f = fixture();
  expect(await f.session.observeOriginal(bytes())).toEqual({ ok: true });
  expect(f.session.recordHumanCheck(check())).toEqual({ ok: true });
  return f;
}

describe("R9 actual file-byte witness", () => {
  it("computes SHA-256 from bytes, but does not infer a human page check", async () => {
    const { session } = fixture();
    expect(session.view().state).toBe("AWAITING_BYTES");
    expect(await session.observeOriginal(bytes())).toEqual({ ok: true });
    expect(session.view()).toMatchObject({ state: "AWAITING_HUMAN", bytesMatched: true, verified: false, href: null, excerpt: null });
    expect(session.view().events).toHaveLength(1);
    expect(session.view().events[0]).toMatchObject({ sequence: 1, action: "BYTES_MATCHED", recordedAt: T, actorId: HUMAN });
  });
  it("rejects different file bytes even when the caller supplied matching hash strings", async () => {
    const { session } = fixture();
    expect(await session.observeOriginal(new TextEncoder().encode("abd"))).toEqual({ ok: false, code: "BYTES_MISMATCH" });
    expect(session.view()).toMatchObject({ state: "AWAITING_BYTES", bytesMatched: false, events: [] });
    expect(await session.observeOriginal(bytes())).toEqual({ ok: true });
  });
  it("hashes an immediate copy so caller mutation cannot replace the inspected byte snapshot", async () => {
    const { session } = fixture();
    const input = bytes();
    const pending = session.observeOriginal(input);
    input.fill(0);
    expect(await pending).toEqual({ ok: true });
  });
  it("rejects empty input without logging a byte witness", async () => {
    const { session } = fixture();
    expect(await session.observeOriginal(new Uint8Array())).toEqual({ ok: false, code: "INVALID_BYTES" });
    expect(session.view().events).toEqual([]);
  });
  it("serializes concurrent reads instead of letting an older digest override a newer one", async () => {
    const { session } = fixture();
    const first = session.observeOriginal(bytes());
    expect(await session.observeOriginal(bytes())).toEqual({ ok: false, code: "INVALID_STATE" });
    expect(await first).toEqual({ ok: true });
    expect(session.view().events).toHaveLength(1);
  });
});

describe("R9 explicit human reports are not signed verified citations", () => {
  it("requires matched bytes before accepting an inspection report", () => {
    const { session } = fixture();
    expect(session.recordHumanCheck(check())).toEqual({ ok: false, code: "INVALID_STATE" });
    expect(session.view().events).toEqual([]);
  });
  it("records the trusted actor, clock, exact asset identity and reported scan-page/printed-label pair", async () => {
    const f = fixture();
    await f.session.observeOriginal(bytes());
    f.setTime("2026-10-10T03:01:00.000Z");
    expect(f.session.recordHumanCheck(check())).toEqual({ ok: true });
    const view = f.session.view();
    expect(view).toMatchObject({ state: "HUMAN_MATCH_RECORDED", verified: false, href: null, excerpt: null });
    expect(view.events[1]).toEqual({ sequence: 2, action: "HUMAN_MATCH_RECORDED", actorId: HUMAN,
      recordedAt: "2026-10-10T03:01:00.000Z", subject: proposal(), assetPageNumber: 93, observedLabel: "87", reason: null });
  });
  it("supports a plate label without turning the scan-page number into printed pagination", async () => {
    const { session } = fixture(context(), { ...proposal(), kind: "PLATE", label: "图版二十一" });
    await session.observeOriginal(bytes());
    expect(session.recordHumanCheck({ ...check(), observedLabel: "图版二十一", assetPageNumber: 120 })).toEqual({ ok: true });
    expect(session.view().events[1].subject.label).toBe("图版二十一");
    expect(session.view().events[1].assetPageNumber).toBe(120);
  });
  it("does not allow an AGENT context to issue a human inspection report", async () => {
    const c = context(); c.actor.type = "AGENT";
    const { session } = fixture(c);
    expect(await session.observeOriginal(bytes())).toEqual({ ok: true });
    expect(session.recordHumanCheck(check())).toEqual({ ok: false, code: "HUMAN_REQUIRED" });
    expect(session.view().state).toBe("AWAITING_HUMAN");
  });
  it.each([
    { inspectedOriginal: false }, { assetPageNumber: 0 }, { assetPageNumber: -1 },
    { assetPageNumber: 1.5 }, { assetPageNumber: "93" }, { decision: "VERIFIED" },
    { actorId: OTHER }, { recordedAt: T }, { verified: true }, { excerpt: "invented quote" },
  ])("rejects malformed or self-certified report fields: %j", async change => {
    const { session } = fixture(); await session.observeOriginal(bytes());
    expect(session.recordHumanCheck({ ...check(), ...change })).toEqual({ ok: false, code: "INVALID_REPORT" });
    expect(session.view().events).toHaveLength(1);
  });
  it("refuses MATCHED when the reported label differs from the original candidate", async () => {
    const { session } = fixture(); await session.observeOriginal(bytes());
    expect(session.recordHumanCheck({ ...check(), observedLabel: "88" })).toEqual({ ok: false, code: "LABEL_MISMATCH" });
  });
  it("can preserve a human mismatch instead of forcing the candidate to be accepted", async () => {
    const { session } = fixture(); await session.observeOriginal(bytes());
    expect(session.recordHumanCheck({ ...check(), decision: "NOT_MATCHED", observedLabel: "88" })).toEqual({ ok: true });
    expect(session.view().state).toBe("HUMAN_MISMATCH_RECORDED");
    expect(session.view().events[1].observedLabel).toBe("88");
  });
  it("does not silently overwrite a previously recorded inspection", async () => {
    const { session } = await reviewed();
    expect(session.recordHumanCheck(check())).toEqual({ ok: false, code: "INVALID_STATE" });
    expect(session.view().events).toHaveLength(2);
  });
  it("rejects backdated inspection time atomically", async () => {
    const f = fixture(); await f.session.observeOriginal(bytes());
    f.setTime("2026-10-10T02:00:00.000Z");
    expect(f.session.recordHumanCheck(check())).toEqual({ ok: false, code: "INVALID_TIME" });
    expect(f.session.view().events).toHaveLength(1);
  });
});

describe("R9 revocation, historical snapshots and auth-generation isolation", () => {
  it("appends revocation without rewriting the old report, and never revives it", async () => {
    const { session } = await reviewed(); const previous = session.view();
    expect(session.revoke({ reason: "CORRECTION" })).toEqual({ ok: true });
    const current = session.view();
    expect(current).toMatchObject({ state: "REVOKED", bytesMatched: false, verified: false });
    expect(current.events.map(e => e.action)).toEqual(["BYTES_MATCHED", "HUMAN_MATCH_RECORDED", "ATTESTATION_REVOKED"]);
    expect(previous.events).toHaveLength(2);
    expect(current.events[2].reason).toBe("CORRECTION");
    expect(session.recordHumanCheck(check())).toEqual({ ok: false, code: "INVALID_STATE" });
    expect(await session.observeOriginal(bytes())).toEqual({ ok: false, code: "INVALID_STATE" });
  });
  it("does not expose mutable references to the private event history", async () => {
    const { session } = await reviewed(); const snapshot = session.view();
    expect(Object.isFrozen(snapshot.events)).toBe(true);
    expect(Object.isFrozen(snapshot.events[1])).toBe(true);
    expect(Object.isFrozen(snapshot.events[1].subject)).toBe(true);
    expect(session.view().events[1].subject).toEqual(proposal());
  });
  it("rejects arbitrary revocation payloads without overwriting an inspection", async () => {
    const { session } = await reviewed();
    expect(session.revoke({ reason: "WITHDRAWN", excerpt: "private" })).toEqual({ ok: false, code: "INVALID_REVOCATION" });
    expect(session.view().state).toBe("HUMAN_MATCH_RECORDED");
  });
  it.each(["DENIED", "REVOKED", "UNKNOWN"] as const)("redacts the entire private projection when source access is %s", async access => {
    const f = await reviewed(); const old = f.getContext();
    f.setContext({ ...old, witness: { ...old.witness, access } });
    const view = f.session.view();
    expect(view).toMatchObject({ state: "UNAVAILABLE", locator: null, bytesMatched: false, events: [] });
    expect(JSON.stringify(view)).not.toContain(HUMAN);
    expect(JSON.stringify(view)).not.toContain("87");
    f.setContext(old);
    expect(f.session.view().state).toBe("UNAVAILABLE");
  });
  it.each(["actor", "authGeneration", "accessRevision", "assetSha256"] as const)("invalidates old records when %s changes", async field => {
    const f = await reviewed(); const c = structuredClone(f.getContext());
    if (field === "actor") c.actor.id = OTHER;
    else if (field === "assetSha256") c.witness.assetSha256 = "b".repeat(64);
    else c[field] += 1;
    f.setContext(c);
    expect(f.session.view()).toMatchObject({ state: "UNAVAILABLE", events: [], locator: null });
  });
  it("does not commit a digest after scope changes while Web Crypto is pending", async () => {
    const f = fixture(); const pending = f.session.observeOriginal(bytes());
    f.setContext(null);
    expect(await pending).toEqual({ ok: false, code: "UNAVAILABLE" });
    expect(f.session.view().events).toEqual([]);
  });
  it("disposes a pending byte read and denies all later writes", async () => {
    const { session } = fixture(); const pending = session.observeOriginal(bytes()); session.dispose();
    expect(await pending).toEqual({ ok: false, code: "UNAVAILABLE" });
    expect(session.recordHumanCheck(check())).toEqual({ ok: false, code: "UNAVAILABLE" });
    expect(session.view().events).toEqual([]);
  });
  it("fails closed when the context provider throws", () => {
    const session = createLocatorReviewSession(proposal(), { currentContext: () => { throw Error("private access unavailable"); }, now: () => T });
    expect(session.view()).toMatchObject({ state: "UNAVAILABLE", events: [], locator: null });
  });
  it("refuses an invalid initial draft rather than upgrading the frozen v1 contract", () => {
    expect(() => createLocatorReviewSession({ ...proposal(), schemaVersion: 1 }, { currentContext: context, now: () => T })).toThrow("INVALID_LOCATOR_DRAFT");
  });
});
