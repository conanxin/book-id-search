import { assessLocatorDraftV2, parseLocatorDraftV2, type LocatorDraftV2, type LocatorWitnessV2 } from "./locator-v2-draft";

/**
 * R9 in-memory inspection workflow, not an authentication or signature service.
 * The future authorized adapter supplies actor/context/clock and must advance
 * authGeneration/accessRevision on every session or access change. Each command
 * and view rechecks that context. Previously delivered snapshots cannot be recalled.
 */
export type LocatorAttestationContext = {
  witness: LocatorWitnessV2;
  actor: { id: string; type: "HUMAN" | "AGENT" };
  authGeneration: number;
  accessRevision: number;
};
export type ReviewState = "AWAITING_BYTES" | "HASHING" | "AWAITING_HUMAN" |
  "HUMAN_MATCH_RECORDED" | "HUMAN_MISMATCH_RECORDED" | "REVOKED" | "UNAVAILABLE";
export type ReviewEvent = {
  sequence: number;
  action: "BYTES_MATCHED" | "HUMAN_MATCH_RECORDED" | "HUMAN_MISMATCH_RECORDED" | "ATTESTATION_REVOKED";
  actorId: string;
  recordedAt: string;
  subject: Readonly<LocatorDraftV2>;
  assetPageNumber: number | null;
  observedLabel: string | null;
  reason: "CORRECTION" | "WITHDRAWN" | null;
};
export type ReviewView = {
  state: ReviewState;
  locator: { kind: LocatorDraftV2["kind"]; label: string } | null;
  bytesMatched: boolean;
  events: readonly ReviewEvent[];
  verified: false;
  href: null;
  excerpt: null;
};
export type ReviewOutcome = { ok: true } | { ok: false; code: string };
export type ReviewOptions = {
  currentContext: () => LocatorAttestationContext | null;
  now: () => string;
};
export type LocatorReviewSession = {
  observeOriginal: (bytes: Uint8Array) => Promise<ReviewOutcome>;
  recordHumanCheck: (input: unknown) => ReviewOutcome;
  revoke: (input: unknown) => ReviewOutcome;
  view: () => ReviewView;
  dispose: () => void;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const fail = (code: string): ReviewOutcome => ({ ok: false, code });
const ok = (): ReviewOutcome => ({ ok: true });

function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  return Reflect.ownKeys(value).length === keys.length && keys.every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return !!descriptor && Object.hasOwn(descriptor, "value");
  });
}

/**
 * Creates a disposable review session. It computes actual SHA-256 bytes, but a
 * digest match is not source authenticity and a human report is not signed proof.
 * No PDF parsing, source URL, quotation, persistence or frozen v1 write occurs.
 */
export function createLocatorReviewSession(proposal: unknown, options: ReviewOptions): LocatorReviewSession {
  const parsed = parseLocatorDraftV2(proposal);
  if (!parsed) throw new TypeError("INVALID_LOCATOR_DRAFT");
  const subject = Object.freeze(parsed);
  let state: ReviewState = "AWAITING_BYTES";
  let events: ReviewEvent[] = [];
  let bytesMatched = false;
  let closed = false;

  function contextSnapshot(): { key: string; actorId: string; human: boolean } | null {
    try {
      const c = options.currentContext();
      if (!c || !c.actor || typeof c.actor.id !== "string" || !UUID.test(c.actor.id) ||
          (c.actor.type !== "HUMAN" && c.actor.type !== "AGENT") ||
          !Number.isSafeInteger(c.authGeneration) || c.authGeneration < 1 ||
          !Number.isSafeInteger(c.accessRevision) || c.accessRevision < 1 ||
          assessLocatorDraftV2(subject, c.witness).status !== "PENDING_HUMAN_VERIFICATION") return null;
      // R8 has validated all witness identities; take values, not caller references.
      const w = c.witness;
      const actorId = c.actor.id.toLowerCase();
      return { actorId, human: c.actor.type === "HUMAN", key: JSON.stringify([
        actorId, c.actor.type, c.authGeneration, c.accessRevision,
        w.projectId.toLowerCase(), w.editionId!.toLowerCase(), w.sourceId.toLowerCase(),
        w.sourceAssetId.toLowerCase(), w.assetSha256, w.sourceType, w.assetRole, w.access,
      ]) };
    } catch { return null; }
  }
  const bound = contextSnapshot();
  function invalidate(): void {
    closed = true;
    state = "UNAVAILABLE";
    bytesMatched = false;
    events = [];
  }
  function current(): ReturnType<typeof contextSnapshot> {
    if (closed) return null;
    const c = contextSnapshot();
    if (!bound || !c || bound.key !== c.key) { invalidate(); return null; }
    return c;
  }
  if (!bound) invalidate();

  function append(
    action: ReviewEvent["action"], assetPageNumber: number | null = null,
    observedLabel: string | null = null, reason: ReviewEvent["reason"] = null,
  ): ReviewOutcome {
    let recordedAt: string;
    try {
      recordedAt = options.now();
      const ms = Date.parse(recordedAt);
      if (typeof recordedAt !== "string" || !UTC.test(recordedAt) || !Number.isFinite(ms) ||
          new Date(ms).toISOString() !== recordedAt ||
          (events.length > 0 && ms < Date.parse(events[events.length - 1].recordedAt))) return fail("INVALID_TIME");
    } catch { return fail("INVALID_TIME"); }
    // Recheck after calling the external clock and before committing the event.
    const c = current();
    if (!c) return fail("UNAVAILABLE");
    events = [...events, Object.freeze({ sequence: events.length + 1, action, actorId: c.actorId,
      recordedAt, subject, assetPageNumber, observedLabel, reason })];
    return ok();
  }

  async function observeOriginal(bytes: Uint8Array): Promise<ReviewOutcome> {
    if (!current()) return fail("UNAVAILABLE");
    if (state !== "AWAITING_BYTES") return fail("INVALID_STATE");
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) return fail("INVALID_BYTES");
    state = "HASHING";
    let digest: string;
    try {
      // Copy before yielding: caller mutation cannot alter the byte witness.
      const snapshot = new Uint8Array(bytes);
      const hashed = await globalThis.crypto.subtle.digest("SHA-256", snapshot);
      digest = Array.from(new Uint8Array(hashed), n => n.toString(16).padStart(2, "0")).join("");
    } catch {
      if (!current()) return fail("UNAVAILABLE");
      state = "AWAITING_BYTES";
      return fail("HASH_UNAVAILABLE");
    }
    if (!current()) return fail("UNAVAILABLE");
    if (digest !== subject.assetSha256) { state = "AWAITING_BYTES"; return fail("BYTES_MISMATCH"); }
    const committed = append("BYTES_MATCHED");
    if (committed.ok) { state = "AWAITING_HUMAN"; bytesMatched = true; }
    else if (!closed) state = "AWAITING_BYTES";
    return committed;
  }

  function recordHumanCheck(input: unknown): ReviewOutcome {
    const c = current();
    if (!c) return fail("UNAVAILABLE");
    if (state !== "AWAITING_HUMAN") return fail("INVALID_STATE");
    if (!c.human) return fail("HUMAN_REQUIRED");
    if (!exactRecord(input, ["inspectedOriginal", "observedLabel", "assetPageNumber", "decision"]) ||
        input.inspectedOriginal !== true || typeof input.assetPageNumber !== "number" ||
        !Number.isSafeInteger(input.assetPageNumber) || input.assetPageNumber < 1 ||
        (input.decision !== "MATCHED" && input.decision !== "NOT_MATCHED") ||
        typeof input.observedLabel !== "string" ||
        !parseLocatorDraftV2({ ...subject, label: input.observedLabel })) return fail("INVALID_REPORT");
    if (input.decision === "MATCHED" && input.observedLabel !== subject.label) return fail("LABEL_MISMATCH");
    const next = input.decision === "MATCHED" ? "HUMAN_MATCH_RECORDED" : "HUMAN_MISMATCH_RECORDED";
    const committed = append(next, input.assetPageNumber, input.observedLabel);
    if (committed.ok) state = next;
    return committed;
  }

  function revoke(input: unknown): ReviewOutcome {
    const c = current();
    if (!c) return fail("UNAVAILABLE");
    if (!c.human) return fail("HUMAN_REQUIRED");
    if (state !== "HUMAN_MATCH_RECORDED" && state !== "HUMAN_MISMATCH_RECORDED") return fail("INVALID_STATE");
    if (!exactRecord(input, ["reason"]) || (input.reason !== "CORRECTION" && input.reason !== "WITHDRAWN")) return fail("INVALID_REVOCATION");
    const committed = append("ATTESTATION_REVOKED", null, null, input.reason);
    if (committed.ok) { state = "REVOKED"; bytesMatched = false; }
    else invalidate(); // An unrecordable withdrawal must never leave an active report.
    return committed;
  }

  function view(): ReviewView {
    const accessible = !!current();
    return Object.freeze({ state, locator: accessible ? Object.freeze({ kind: subject.kind, label: subject.label }) : null,
      bytesMatched, events: Object.freeze([...events]), verified: false, href: null, excerpt: null });
  }
  return { observeOriginal, recordHumanCheck, revoke, view, dispose: invalidate };
}
