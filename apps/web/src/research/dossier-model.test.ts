import { describe, expect, it } from "vitest";
import type {
  AssessmentDetailResponse, AssessmentHistoryResponse, AssessmentSummary,
  IssueResolutionDetailResponse, IssueResolutionHistoryResponse, IssueResolutionSummary,
  IssueResolutionEvidenceBasesResponse,
  ResearchIssueDetailResponse, ResearchRunDetailResponse, ResearchRunSummary,
} from "./api";
import {
  createDossier, startDossierRead, receiveDossierRead, failDossierRead,
  resetDossier, dossierView, dossierProducedRequest,
} from "./dossier-model";

const P = "11111111-1111-4111-8111-111111111111";
const I = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const R = "44444444-4444-4444-8444-444444444444";
const R2 = "55555555-5555-4555-8555-555555555555";
const U = "66666666-6666-4666-8666-666666666666";
const U2 = "77777777-7777-4777-8777-777777777777";
const M = "88888888-8888-4888-8888-888888888888";
const T = "2026-10-09T01:02:03.123Z";
const MICROS = "1791507723123987";
const HASH = "a".repeat(64);
const A = "99999999-9999-4999-8999-999999999999";
const TARGET = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NOTE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const BINDING = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SCOPE = { projectId: P, issueId: I, authGeneration: 1 };

const question = (): ResearchIssueDetailResponse => ({
  project: { id: P, name: "版本考证", lifecycleState: "ACTIVE", readOnly: false },
  issue: { id: I, projectId: P, title: "版本差异", question: "两个版本为何不同？", lifecycleState: "OPEN", createdAt: T, updatedAt: T },
});
const resolution = (over: Partial<IssueResolutionSummary> = {}): IssueResolutionSummary => ({
  id: R, issueId: I, resolutionType: "PREFERRED_CLAIM", preferredClaimId: C,
  rationaleExcerpt: "现有材料倾向候选答案", createdAt: T, isCurrent: true,
  evidenceBasisAvailable: false, evidenceManifest: null, ...over,
});
const resolutions = (current: IssueResolutionSummary | null, rows: IssueResolutionSummary[] = [], nextCursor: string | null = null): IssueResolutionHistoryResponse => ({
  issue: { id: I, lifecycleState: "OPEN", currentResolutionId: current?.id ?? null, updatedAt: T },
  currentResolution: current, resolutions: rows, nextCursor,
});
const resolutionDetail = (id = R, pointer: string | null = id): IssueResolutionDetailResponse => ({
  issue: { id: I, lifecycleState: "OPEN", currentResolutionId: pointer, updatedAt: T },
  resolution: { id, issueId: I, resolutionType: "PREFERRED_CLAIM", preferredClaimId: C, rationale: "完整的工作理由", createdAt: T, isCurrent: id === pointer },
  evidenceBasisAvailable: false, evidenceManifest: null,
});
const run = (over: Partial<ResearchRunSummary> = {}): ResearchRunSummary => ({
  runId: U, issueId: I, status: "RUNNING", replayOf: null, startedAtMicros: MICROS,
  startedAt: T, completedAt: null,
  evidenceManifest: { id: M, manifestSha256: HASH, itemCount: 1, available: true }, ...over,
});
const runDetail = (summary = run()): ResearchRunDetailResponse => ({
  run: {
    runId: summary.runId, projectId: P, issueId: I, status: summary.status,
    evidenceManifestId: M, replayOf: null,
    procedure: { version: 1, objective: "比较版本", method: "逐页比对", steps: [{ kind: "COMPARE", description: "比较正文" }] },
    executionContract: { version: 1, mode: "HUMAN", reproducibilityLevel: "AUDIT", tools: [] },
    environment: {}, output: summary.status === "RUNNING" ? null : { version: 1, summary: "完成比对", produced: { claimIds: [], assessmentIds: [], resolutionIds: [], noteRevisionIds: [] }, gaps: [] },
    knowledgeCutoff: null, startedAt: summary.startedAt, completedAt: summary.completedAt, createdAt: T,
  },
  evidenceManifest: { ...summary.evidenceManifest, available: true, items: [{ ordinal: 1, role: "CONTEXTUAL", targetType: "SOURCE", note: null }] },
  ancestors: [],
});

function read(state: ReturnType<typeof createDossier>, request: Parameters<typeof startDossierRead>[1], response: unknown) {
  const started = startDossierRead(state, request);
  expect(started.ticket).not.toBeNull();
  return receiveDossierRead(started.state, started.ticket!, response as never, T);
}
function ready() { return read(createDossier(SCOPE), { kind: "question" }, question()); }

const manifest = () => ({ id: M, schemaVersion: 1 as const, purpose: "CLAIM_ASSESSMENT" as const, manifestSha256: HASH, itemCount: 1 });
const assessment = (over: Partial<AssessmentSummary> = {}): AssessmentSummary => ({
  id: A, stance: "INCONCLUSIVE", confidenceLevel: null, actorId: TARGET, numericScore: null,
  scoreKind: null, reasoningExcerpt: "ASSESSMENT_PRIVATE_REASON", createdAt: T, evidenceManifest: manifest(), ...over,
});
const assessmentHistory = (rows = [assessment()], claimId = C, nextCursor: string | null = null): AssessmentHistoryResponse => ({
  claim: { id: claimId, statement: "候选答案", lifecycleState: "ACTIVE" }, assessments: rows, nextCursor,
});
const assessmentDetail = (): AssessmentDetailResponse => ({
  claim: { id: C, statement: "候选答案", lifecycleState: "ACTIVE" },
  assessment: { id: A, claimId: C, stance: "INCONCLUSIVE", confidenceLevel: null, actorId: TARGET, numericScore: null, scoreKind: null, reasoning: "ASSESSMENT_PRIVATE_REASON", createdAt: T },
  evidenceManifest: { id: M, schemaVersion: 1, purpose: "CLAIM_ASSESSMENT", manifestSha256: HASH, createdAt: T, items: [{ ordinal: 1, role: "CONTEXTUAL", targetType: "NOTE_REVISION", targetId: TARGET, locatorType: null, locator: null, excerpt: null, note: null }] },
});
const bases = (nextCursor: string | null = null): IssueResolutionEvidenceBasesResponse => ({
  issueId: I, evidenceBases: [{ assessmentId: A, claimId: C, claimStatementExcerpt: "候选答案", stance: "INCONCLUSIVE", confidenceLevel: null, manifestId: M, manifestSha256: HASH, itemCount: 1, assessmentCreatedAt: T }], nextCursor,
});
const outputRun = () => {
  const detail = runDetail(run({ status: "SUCCEEDED", completedAt: T }));
  detail.run.output!.produced = { claimIds: [C], assessmentIds: [A], resolutionIds: [R], noteRevisionIds: [TARGET] };
  return detail;
};

describe("Dossier scope and independent coverage", () => {
  it("distinguishes an unread source from a successfully read empty visible stream", () => {
    const initial = ready();
    expect(dossierView(initial).runs.coverage).toMatchObject({ status: "notRequested", loadedCount: 0, exhausted: false });
    const state = read(initial, { kind: "runs", cursor: null }, { runs: [], nextCursor: null });
    expect(dossierView(state).runs.coverage).toMatchObject({ status: "ready", loadedCount: 0, nextCursor: null, exhausted: true });
    expect(dossierView(state).resolutions.coverage.exhausted).toBe(false);
  });

  it("retains accepted rows and the exact cursor after a later-page error", () => {
    const cursor = "opaque-v1_+/=cursor";
    let state = read(ready(), { kind: "runs", cursor: null }, { runs: [run()], nextCursor: cursor });
    const pending = startDossierRead(state, { kind: "runs", cursor });
    state = failDossierRead(pending.state, pending.ticket!, 503);
    expect(dossierView(state).runs).toMatchObject({ rows: [{ runId: U }], coverage: { status: "partial", loadedCount: 1, nextCursor: cursor, exhausted: false }, error: { status: 503 } });
    expect(startDossierRead(state, { kind: "runs", cursor: "invented" }).ticket).toBeNull();
    expect(startDossierRead(state, { kind: "runs", cursor }).ticket?.request).toEqual({ kind: "runs", cursor });
  });

  it("ignores reads from a prior scope, auth generation or explicit whole-page refresh", () => {
    const pending = startDossierRead(ready(), { kind: "runs", cursor: null });
    for (const scope of [SCOPE, { ...SCOPE, issueId: R2 }, { ...SCOPE, authGeneration: 2 }]) {
      const reset = resetDossier(pending.state, scope);
      expect(receiveDossierRead(reset, pending.ticket!, { runs: [run()], nextCursor: null }, T)).toEqual(reset);
      expect(dossierView(reset).question.status).toBe("notRequested");
      expect(dossierView(reset).runs.rows).toEqual([]);
    }
  });

  it("rejects a well-shaped foreign Issue response without exposing its content", () => {
    const foreign = question();
    foreign.issue.id = R2;
    foreign.issue.question = "FOREIGN_PRIVATE_QUESTION";
    const state = read(createDossier(SCOPE), { kind: "question" }, foreign);
    expect(dossierView(state).question).toMatchObject({ status: "error", error: { status: 502 } });
    expect(JSON.stringify(dossierView(state))).not.toContain("FOREIGN_PRIVATE_QUESTION");
  });
});

describe("Dossier Current pointer authority", () => {
  it("uses the separately returned Current even when it is outside the history page", () => {
    let state = read(ready(), { kind: "resolutions", cursor: null }, resolutions(resolution(), [resolution({ id: R2, isCurrent: false })]));
    state = read(state, { kind: "runs", cursor: null }, { runs: [run({ status: "SUCCEEDED", completedAt: "2026-10-10T00:00:00.000Z" })], nextCursor: null });
    expect(dossierView(state).current).toMatchObject({ status: "recorded", summary: { id: R } });
    expect(dossierView(state).resolutions.rows.map(row => row.id)).toEqual([R2]);
  });

  it("distinguishes no pointer from an explicit NO_WORKING_CONCLUSION record", () => {
    const empty = read(ready(), { kind: "resolutions", cursor: null }, resolutions(null));
    expect(dossierView(empty).current).toEqual({ status: "none" });
    const explicit = read(ready(), { kind: "resolutions", cursor: null }, resolutions(resolution({ resolutionType: "NO_WORKING_CONCLUSION", preferredClaimId: null })));
    expect(dossierView(explicit).current).toMatchObject({ status: "recorded", summary: { resolutionType: "NO_WORKING_CONCLUSION" } });
  });

  it("treats a mismatched Current pointer/summary pair as an error, not no conclusion", () => {
    const response = resolutions(resolution());
    response.issue.currentResolutionId = R2;
    const state = read(ready(), { kind: "resolutions", cursor: null }, response);
    expect(dossierView(state).current).toMatchObject({ status: "error", error: { status: 502 } });
    expect(dossierView(state).resolutions.rows).toEqual([]);
  });

  it("invalidates Current after a detail observes a changed pointer at the same displayed time", () => {
    let state = read(ready(), { kind: "resolutions", cursor: null }, resolutions(resolution(), [resolution()]));
    state = read(state, { kind: "resolution", resolutionId: R }, resolutionDetail(R, R2));
    expect(dossierView(state).current).toEqual({ status: "changed", reconciliationRequired: true });
    expect(dossierView(state).resolutions.rows[0].isCurrent).toBe(false);
    state = read(state, { kind: "resolutions", cursor: null }, resolutions(resolution({ id: R2 }), [resolution({ isCurrent: false })]));
    expect(dossierView(state).current).toMatchObject({ status: "recorded", summary: { id: R2 } });
  });

  it("rejects a well-shaped detail for a different requested Resolution", () => {
    let state = read(ready(), { kind: "resolutions", cursor: null }, resolutions(resolution()));
    state = read(state, { kind: "resolution", resolutionId: R }, resolutionDetail(R2));
    expect(dossierView(state).current).toMatchObject({ status: "recorded", summary: { id: R }, detail: { status: "error", error: { status: 502 } } });
  });

  it("preserves authorized archived scope and its Current while always read-only", () => {
    const response = question();
    response.project = { ...response.project, lifecycleState: "ARCHIVED", readOnly: true };
    response.issue.lifecycleState = "ARCHIVED";
    let state = read(createDossier(SCOPE), { kind: "question" }, response);
    state = read(state, { kind: "resolutions", cursor: null }, resolutions(resolution()));
    expect(dossierView(state)).toMatchObject({ readOnly: true, current: { status: "recorded", summary: { id: R } } });
  });
});

describe("D01-A source-ordered factual chronology", () => {
  it("retains server order across overlapping same-millisecond pages without sorting by ID", () => {
    let state = read(ready(), { kind: "resolutions", cursor: null }, resolutions(resolution(), [resolution({ id: R2, isCurrent: false }), resolution()], "r-page-2"));
    state = read(state, { kind: "resolutions", cursor: "r-page-2" }, resolutions(resolution(), [resolution(), resolution({ id: U, isCurrent: false })]));
    expect(dossierView(state).resolutions.rows.map(row => row.id)).toEqual([R2, R, U]);
    expect(dossierView(state).whatChanged.resolutionEvents.map(event => event.id)).toEqual([`resolution:${R2}:recorded`, `resolution:${R}:recorded`, `resolution:${U}:recorded`]);
    expect(dossierView(state).resolutions.coverage.loadedCount).toBe(3);
  });

  it("atomically rejects conflicting immutable content without advancing a cursor", () => {
    let state = read(ready(), { kind: "resolutions", cursor: null }, resolutions(resolution(), [resolution()], "r-page-2"));
    state = read(state, { kind: "resolutions", cursor: "r-page-2" }, resolutions(resolution(), [resolution({ rationaleExcerpt: "conflicting" })]));
    expect(dossierView(state).resolutions).toMatchObject({ rows: [{ rationaleExcerpt: "现有材料倾向候选答案" }], coverage: { status: "partial", loadedCount: 1, nextCursor: "r-page-2" }, error: { code: "CONFLICTING_RECORD" } });
  });

  it("keeps actual microseconds and termination inside start-ordered Run cards", () => {
    let state = read(ready(), { kind: "resolutions", cursor: null }, resolutions(resolution({ id: U }), [resolution({ id: U })]));
    state = read(state, { kind: "runs", cursor: null }, { runs: [run(), run({ runId: U2, startedAtMicros: "1791507723123123", status: "SUCCEEDED", completedAt: "2026-10-11T00:00:00.000Z" })], nextCursor: "more" });
    const changes = dossierView(state).whatChanged;
    expect(changes).toMatchObject({ policy: "D01-A", crossStreamOrder: "UNRESOLVED" });
    expect(changes.runCards.map(card => card.runId)).toEqual([U, U2]);
    expect(changes.runCards[0].started).toMatchObject({ id: `run:${U}:started`, startedAtMicros: MICROS });
    expect(changes.runCards[0].terminated).toBeNull();
    expect(changes.runCards[1].terminated).toMatchObject({ type: "RUN_TERMINATED", status: "SUCCEEDED", at: "2026-10-11T00:00:00.000Z" });
    expect(changes.resolutionEvents[0]).not.toHaveProperty("createdAtMicros");
    expect(changes).not.toHaveProperty("events");
    expect(changes.coverage.runs.exhausted).toBe(false);
  });

  it.each(["SUCCEEDED", "FAILED", "CANCELLED"] as const)("updates RUNNING to %s at its original position without duplicate events", status => {
    let state = read(ready(), { kind: "runs", cursor: null }, { runs: [run()], nextCursor: "page2" });
    state = read(state, { kind: "runs", cursor: "page2" }, { runs: [run({ status, completedAt: T })], nextCursor: null });
    const cards = dossierView(state).whatChanged.runCards;
    expect(cards).toHaveLength(1);
    expect(cards[0].started.id).toBe(`run:${U}:started`);
    expect(cards[0].terminated).toMatchObject({ id: `run:${U}:terminated`, status });
  });

  it("rejects a terminal Run changing its recorded terminal result", () => {
    let state = read(ready(), { kind: "runs", cursor: null }, { runs: [run({ status: "FAILED", completedAt: T })], nextCursor: "page2" });
    state = read(state, { kind: "runs", cursor: "page2" }, { runs: [run({ status: "SUCCEEDED", completedAt: T })], nextCursor: null });
    expect(dossierView(state).runs).toMatchObject({ rows: [{ status: "FAILED" }], error: { code: "CONFLICTING_RECORD" } });
  });

  it("never inserts root details or ancestors into loaded Issue history", () => {
    const detail = runDetail();
    const ancestor = run({ runId: U2, status: "SUCCEEDED", completedAt: T });
    detail.run.replayOf = U2;
    detail.ancestors = [ancestor];
    const state = read(ready(), { kind: "run", runId: U }, detail);
    expect(dossierView(state).runs.coverage).toMatchObject({ loadedCount: 0, exhausted: false });
    expect(dossierView(state).whatChanged.runCards).toEqual([]);
  });
});

describe("Dossier evidence disclosure and negative-read invalidation", () => {
  it("keeps A/R detail targets separate from a same-manifest Run snapshot and compact lists", () => {
    let state = read(ready(), { kind: "assessments", claimId: C, cursor: null }, assessmentHistory());
    state = read(state, { kind: "assessment", claimId: C, assessmentId: A }, assessmentDetail());
    state = read(state, { kind: "runs", cursor: null }, { runs: [run()], nextCursor: null });
    const richRun = runDetail();
    Object.assign(richRun.evidenceManifest, { targetId: "INJECTED_TARGET" });
    if (richRun.evidenceManifest.available) Object.assign(richRun.evidenceManifest.items[0], { targetId: TARGET, locator: "INJECTED_LOCATOR" });
    state = read(state, { kind: "run", runId: U }, richRun);
    const view = dossierView(state);
    expect(Object.keys(view.runs.rows[0].evidenceManifest).sort()).toEqual(["available", "id", "itemCount", "manifestSha256"]);
    expect(Object.keys(view.runDetails[0].evidenceManifest).sort()).toEqual(["available", "id", "itemCount", "items", "manifestSha256"]);
    expect(JSON.stringify(view.runDetails[0])).not.toContain(TARGET);
    expect(JSON.stringify(view.runDetails[0])).not.toContain("INJECTED_");
    expect(view.assessmentDetails[0].evidenceManifest.items[0].targetId).toBe(TARGET);
    expect(Object.keys(view.assessments[0].rows[0].evidenceManifest).sort()).toEqual(["id", "itemCount", "manifestSha256", "purpose", "schemaVersion"]);
    expect(Object.keys(view.assessmentDetails[0].evidenceManifest).sort()).toEqual(["createdAt", "id", "items", "manifestSha256", "purpose", "schemaVersion"]);
  });

  it("removes all same-Assessment summaries, details, basis rows and references after its detail 404", () => {
    let state = read(ready(), { kind: "assessments", claimId: C, cursor: null }, assessmentHistory());
    state = read(state, { kind: "assessment", claimId: C, assessmentId: A }, assessmentDetail());
    state = read(state, { kind: "bases", cursor: null }, bases());
    state = read(state, { kind: "run", runId: U }, outputRun());
    const pending = startDossierRead(state, { kind: "assessment", claimId: C, assessmentId: A });
    state = failDossierRead(pending.state, pending.ticket!, 404);
    const view = dossierView(state);
    expect(view.assessments[0].rows).toEqual([]);
    expect(view.assessments[0].coverage.loadedCount).toBe(0);
    expect(view.assessmentDetails).toEqual([]);
    expect(view.evidenceBases.rows).toEqual([]);
    expect(view.runDetails[0].producedReferences.find(ref => ref.kind === "assessment")).toEqual({ kind: "assessment", ordinal: 1, status: "unavailable" });
    expect(JSON.stringify(view)).not.toContain(A);
    expect(JSON.stringify(view)).not.toContain("ASSESSMENT_PRIVATE_REASON");
    expect(JSON.stringify(view)).not.toContain(TARGET);
  });

  it("cannot revive an Assessment with a read begun before invalidation; fresh summary restores only its own projection", () => {
    let state = read(ready(), { kind: "assessments", claimId: C, cursor: null }, assessmentHistory());
    state = read(state, { kind: "assessment", claimId: C, assessmentId: A }, assessmentDetail());
    const oldList = startDossierRead(state, { kind: "assessments", claimId: C, cursor: null });
    const negative = startDossierRead(oldList.state, { kind: "assessment", claimId: C, assessmentId: A });
    state = failDossierRead(negative.state, negative.ticket!, 404);
    state = receiveDossierRead(state, oldList.ticket!, assessmentHistory(), T);
    expect(dossierView(state).assessments[0].rows).toEqual([]);
    state = read(state, { kind: "assessments", claimId: C, cursor: null }, assessmentHistory());
    expect(dossierView(state).assessments[0].rows).toHaveLength(1);
    expect(dossierView(state).assessmentDetails).toEqual([]);
    state = read(state, { kind: "assessment", claimId: C, assessmentId: A }, assessmentDetail());
    expect(dossierView(state).assessmentDetails).toHaveLength(1);
  });

  it("clears a Resolution manifest in Current, History and detail while preserving its conclusion and rationale", () => {
    const visible = resolution({ evidenceBasisAvailable: true, evidenceManifest: manifest() });
    let state = read(ready(), { kind: "resolutions", cursor: null }, resolutions(visible, [visible]));
    const detail = { ...resolutionDetail(), evidenceBasisAvailable: true, evidenceManifest: assessmentDetail().evidenceManifest };
    state = read(state, { kind: "resolution", resolutionId: R }, detail);
    const oldPage = startDossierRead(state, { kind: "resolutions", cursor: null });
    state = read(oldPage.state, { kind: "resolution", resolutionId: R }, resolutionDetail());
    state = receiveDossierRead(state, oldPage.ticket!, resolutions(visible, [visible]), T);
    const view = dossierView(state);
    expect(view.current).toMatchObject({ status: "recorded", summary: { id: R, evidenceBasisAvailable: false, evidenceManifest: null }, detail: { data: { resolution: { rationale: "完整的工作理由" }, evidenceManifest: null } } });
    expect(view.resolutions.rows[0].evidenceManifest).toBeNull();
    expect(JSON.stringify(view)).not.toContain(HASH);
    expect(JSON.stringify(view)).not.toContain(TARGET);
  });

  it("keeps a Run's compact fingerprint but removes old root items after an unavailable list read", () => {
    let state = read(ready(), { kind: "runs", cursor: null }, { runs: [run()], nextCursor: null });
    state = read(state, { kind: "run", runId: U }, runDetail());
    const oldDetail = startDossierRead(state, { kind: "run", runId: U });
    const unavailable = run({ evidenceManifest: { id: M, manifestSha256: HASH, itemCount: 1, available: false } });
    state = read(oldDetail.state, { kind: "runs", cursor: null }, { runs: [unavailable], nextCursor: null });
    state = receiveDossierRead(state, oldDetail.ticket!, runDetail(), T);
    expect(dossierView(state).runDetails[0].evidenceManifest).toEqual({ id: M, manifestSha256: HASH, itemCount: 1, available: false });
    state = read(state, { kind: "runs", cursor: null }, { runs: [run()], nextCursor: null });
    expect(dossierView(state).runDetails[0].evidenceManifest).not.toHaveProperty("items");
    state = read(state, { kind: "run", runId: U }, runDetail());
    expect(dossierView(state).runDetails[0].evidenceManifest).toHaveProperty("items");
    expect(dossierView(state).runs.rows[0].evidenceManifest).not.toHaveProperty("items");
  });

  it("does not confuse matching UUIDs in Assessment and Run object types", () => {
    let state = read(ready(), { kind: "assessments", claimId: C, cursor: null }, assessmentHistory([assessment({ id: U })]));
    state = read(state, { kind: "runs", cursor: null }, { runs: [run()], nextCursor: null });
    const pending = startDossierRead(state, { kind: "assessment", claimId: C, assessmentId: U });
    state = failDossierRead(pending.state, pending.ticket!, 404);
    expect(dossierView(state).assessments[0].rows).toEqual([]);
    expect(dossierView(state).runs.rows).toHaveLength(1);
  });

  it.each([500, 502, 503, null])("preserves a Run list when detail fails with %s and does not call it empty", status => {
    let state = read(ready(), { kind: "runs", cursor: null }, { runs: [run()], nextCursor: null });
    const pending = startDossierRead(state, { kind: "run", runId: U });
    state = failDossierRead(pending.state, pending.ticket!, status);
    expect(dossierView(state).runs.rows).toHaveLength(1);
    expect(dossierView(state).runDetails).toEqual([]);
    expect(dossierView(state).reads.find(row => row.kind === "run")).toMatchObject({ status: "error", error: { status } });
  });
});

describe("Dossier independently authorized produced references", () => {
  it("does not expose raw produced identities through output, keys or unverified links", () => {
    const state = read(ready(), { kind: "run", runId: U }, outputRun());
    const view = dossierView(state);
    expect(view.runDetails[0].run.output).toEqual({ version: 1, summary: "完成比对", gaps: [] });
    expect(view.runDetails[0].producedReferences).toEqual([
      { kind: "claim", ordinal: 1, status: "unresolved" },
      { kind: "assessment", ordinal: 1, status: "unresolved" },
      { kind: "resolution", ordinal: 1, status: "unresolved" },
      { kind: "noteRevision", ordinal: 1, status: "unresolved" },
    ]);
    for (const id of [C, A, R, TARGET]) expect(JSON.stringify(view)).not.toContain(id);
  });

  it("keeps missing Assessment mappings unresolved even after the visible basis stream is exhausted", () => {
    for (const cursor of ["more", null]) {
      let state = read(ready(), { kind: "run", runId: U }, outputRun());
      state = read(state, { kind: "bases", cursor: null }, { issueId: I, evidenceBases: [], nextCursor: cursor });
      expect(dossierView(state).runDetails[0].producedReferences[1]).toEqual({ kind: "assessment", ordinal: 1, status: "unresolved" });
    }
  });

  it("requires the Assessment's own successful detail even after an authorized A-to-C mapping is known", () => {
    let state = read(ready(), { kind: "run", runId: U }, outputRun());
    state = read(state, { kind: "bases", cursor: null }, bases());
    expect(dossierView(state).runDetails[0].producedReferences[1].status).toBe("unresolved");
    const pending = startDossierRead(state, { kind: "assessment", claimId: C, assessmentId: A });
    expect(dossierView(pending.state).runDetails[0].producedReferences[1]).toEqual({ kind: "assessment", ordinal: 1, status: "loading" });
    state = receiveDossierRead(pending.state, pending.ticket!, assessmentDetail(), T);
    expect(dossierView(state).runDetails[0].producedReferences[1]).toMatchObject({ kind: "assessment", status: "resolved", id: A, claimId: C });
  });

  it.each([404, 503, 500, 502, null])("distinguishes a produced target failure %s without exposing the target", status => {
    let state = read(ready(), { kind: "run", runId: U }, outputRun());
    state = read(state, { kind: "bases", cursor: null }, bases());
    const pending = startDossierRead(state, { kind: "assessment", claimId: C, assessmentId: A });
    state = failDossierRead(pending.state, pending.ticket!, status);
    const ref = dossierView(state).runDetails[0].producedReferences[1];
    expect(ref.status).toBe(status === 404 ? "unavailable" : "error");
    expect(ref).not.toHaveProperty("id");
    expect(ref).not.toHaveProperty("href");
    if (status !== 404) expect(ref).toMatchObject({ error: { status } });
  });

  it("rejects a conflicting Assessment-to-Claim mapping rather than choosing one", () => {
    let state = read(ready(), { kind: "run", runId: U }, outputRun());
    state = read(state, { kind: "bases", cursor: null }, bases());
    state = read(state, { kind: "assessments", claimId: R2, cursor: null }, assessmentHistory([assessment()], R2));
    expect(dossierView(state).runDetails[0].producedReferences[1]).toMatchObject({ status: "error", error: { code: "CONFLICTING_RECORD" } });
  });

  it("uses only the exact authorized historical NoteRevision and an existing binding route", () => {
    let state = read(ready(), { kind: "run", runId: U }, outputRun());
    state = read(state, { kind: "candidates", claimId: C }, {
      claim: { id: C, statement: "候选答案", lifecycleState: "ACTIVE" },
      candidates: [{ targetType: "NOTE_REVISION", targetId: TARGET, materialBindingId: BINDING, materialTitle: "史料", noteId: NOTE, revisionNo: 2, contentFormat: "MARKDOWN", createdAt: T }],
    });
    state = read(state, { kind: "revision", bindingId: BINDING, revisionId: TARGET }, { revision: { revisionId: TARGET, revisionNo: 2, createdAt: T, contentFormat: "MARKDOWN", content: "历史正文", contentSha256: HASH } });
    expect(dossierView(state).runDetails[0].producedReferences[3]).toMatchObject({ status: "resolved", id: TARGET, revisionNo: 2, href: `/research/projects/${P}?item=${BINDING}` });
    expect(dossierView(state).runDetails[0].producedReferences[3]).not.toHaveProperty("stablePermalink");
  });

  it("rejects a different requested Run or NoteRevision even when the response shape is valid", () => {
    let state = read(ready(), { kind: "run", runId: U2 }, outputRun());
    expect(dossierView(state).runDetails).toEqual([]);
    expect(dossierView(state).reads.find(row => row.kind === "run")).toMatchObject({ error: { status: 502 } });
    state = read(state, { kind: "revision", bindingId: BINDING, revisionId: TARGET }, { revision: { revisionId: R, revisionNo: 3, createdAt: T, contentFormat: "MARKDOWN", content: "NEWER_PRIVATE_CONTENT", contentSha256: HASH } });
    expect(JSON.stringify(dossierView(state))).not.toContain("NEWER_PRIVATE_CONTENT");
  });
});

describe("Dossier acceptance and cross-projection reconciliation", () => {
  it("updates an already loaded Run from an authorized terminal ancestor without changing source coverage", () => {
    let state = read(ready(), { kind: "runs", cursor: null }, { runs: [run()], nextCursor: "same-cursor" });
    const child = runDetail(run({ runId: U2 }));
    child.run.replayOf = U;
    child.ancestors = [run({ status: "SUCCEEDED", completedAt: T })];
    state = read(state, { kind: "run", runId: U2 }, child);
    const view = dossierView(state);
    expect(view.runs.rows).toEqual([run({ status: "SUCCEEDED", completedAt: T })]);
    expect(view.runs.coverage).toMatchObject({ loadedCount: 1, nextCursor: "same-cursor", exhausted: false });
    expect(view.whatChanged.runCards[0].terminated).toMatchObject({ status: "SUCCEEDED", at: T });
  });

  it.each([true, false])("rejects conflicting Assessment basis/detail facts in either read order (basis first=%s)", basisFirst => {
    const conflicting = bases();
    conflicting.evidenceBases[0].confidenceLevel = "HIGH";
    let state = ready();
    if (basisFirst) {
      state = read(state, { kind: "bases", cursor: null }, conflicting);
      state = read(state, { kind: "assessment", claimId: C, assessmentId: A }, assessmentDetail());
    } else {
      state = read(state, { kind: "assessment", claimId: C, assessmentId: A }, assessmentDetail());
      state = read(state, { kind: "bases", cursor: null }, conflicting);
    }
    expect(dossierView(state).reads.find(slot => slot.kind === (basisFirst ? "assessment" : "bases"))).toMatchObject({ error: { code: "CONFLICTING_RECORD" } });
  });

  it.each([true, false])("rejects conflicting Resolution manifest fingerprints in either read order (summary first=%s)", summaryFirst => {
    const summary = resolution({ evidenceBasisAvailable: true, evidenceManifest: { ...manifest(), manifestSha256: "b".repeat(64) } });
    const detail = { ...resolutionDetail(), evidenceBasisAvailable: true, evidenceManifest: assessmentDetail().evidenceManifest };
    let state = ready();
    if (summaryFirst) {
      state = read(state, { kind: "resolutions", cursor: null }, resolutions(summary));
      state = read(state, { kind: "resolution", resolutionId: R }, detail);
    } else {
      state = read(state, { kind: "resolution", resolutionId: R }, detail);
      state = read(state, { kind: "resolutions", cursor: null }, resolutions(summary));
    }
    expect(dossierView(state).reads.find(slot => slot.kind === (summaryFirst ? "resolution" : "resolutions"))).toMatchObject({ error: { code: "CONFLICTING_RECORD" } });
  });

  it("gates historical NoteRevision evidence navigation on the exact successful revision reader", () => {
    let state = read(ready(), { kind: "assessment", claimId: C, assessmentId: A }, assessmentDetail());
    state = read(state, { kind: "candidates", claimId: C }, {
      claim: { id: C, statement: "候选答案", lifecycleState: "ACTIVE" },
      candidates: [{ targetType: "NOTE_REVISION", targetId: TARGET, materialBindingId: BINDING, materialTitle: "史料", noteId: NOTE, revisionNo: 2, contentFormat: "MARKDOWN", createdAt: T }],
    });
    expect(dossierView(state).references[0]).not.toHaveProperty("href");
    const pending = startDossierRead(state, { kind: "revision", bindingId: BINDING, revisionId: TARGET });
    expect(dossierView(pending.state).references[0]).not.toHaveProperty("href");
    state = receiveDossierRead(pending.state, pending.ticket!, { revision: { revisionId: TARGET, revisionNo: 2, createdAt: T, contentFormat: "MARKDOWN", content: "历史正文", contentSha256: HASH } }, T);
    expect(dossierView(state).references[0]).toMatchObject({ href: `/research/projects/${P}?item=${BINDING}` });
    const retry = startDossierRead(state, { kind: "revision", bindingId: BINDING, revisionId: TARGET });
    state = failDossierRead(retry.state, retry.ticket!, 503);
    expect(dossierView(state).references[0]).not.toHaveProperty("href");
  });

  it("keeps pointer acceptance monotonic when an older Current detail returns 404", () => {
    let state = read(ready(), { kind: "resolutions", cursor: null }, resolutions(resolution(), [resolution(), resolution({ id: R2, isCurrent: false })]));
    const olderR = startDossierRead(state, { kind: "resolution", resolutionId: R });
    const olderR2 = startDossierRead(olderR.state, { kind: "resolution", resolutionId: R2 });
    state = read(olderR2.state, { kind: "resolutions", cursor: null }, resolutions(resolution(), [resolution(), resolution({ id: R2, isCurrent: false })]));
    state = failDossierRead(state, olderR.ticket!, 404);
    state = receiveDossierRead(state, olderR2.ticket!, resolutionDetail(R2, R2), T);
    expect(dossierView(state).current).toMatchObject({ status: "error", error: { status: 404 } });
    expect(dossierView(state).resolutions.rows[0].isCurrent).toBe(false);
  });

  it("keeps stale Current detail hidden during retry and after retry failure, including the shared detail projection", () => {
    let state = read(ready(), { kind: "resolutions", cursor: null }, resolutions(resolution()));
    state = read(state, { kind: "resolution", resolutionId: R }, resolutionDetail());
    state = read(state, { kind: "resolutions", cursor: null }, resolutions(resolution({ id: R2 })));
    state = read(state, { kind: "resolutions", cursor: null }, resolutions(resolution()));
    expect(dossierView(state).resolutionDetails[0].resolution.isCurrent).toBe(false);
    const pending = startDossierRead(state, { kind: "resolution", resolutionId: R });
    expect(dossierView(pending.state).current).toMatchObject({ detail: { status: "loading", data: null } });
    state = failDossierRead(pending.state, pending.ticket!, 503);
    expect(dossierView(state).current).toMatchObject({ detail: { error: { status: 503 }, data: null } });
  });

  it.each(["status", "microseconds"] as const)("rejects contradictory ancestor %s against an already loaded Run", changed => {
    const prior = run({ status: "FAILED", completedAt: T });
    let state = read(ready(), { kind: "runs", cursor: null }, { runs: [prior], nextCursor: null });
    const child = runDetail(run({ runId: U2 }));
    child.run.replayOf = U;
    child.ancestors = [changed === "status" ? { ...prior, status: "SUCCEEDED" } : { ...prior, startedAtMicros: "1791507723123123" }];
    state = read(state, { kind: "run", runId: U2 }, child);
    expect(dossierView(state).runDetails).toEqual([]);
    expect(dossierView(state).reads.find(slot => slot.kind === "run")).toMatchObject({ error: { code: "CONFLICTING_RECORD" } });
    expect(dossierView(state).runs.rows[0].status).toBe("FAILED");
  });

  it("rejects changed frozen Run snapshot items under the same fingerprint", () => {
    let state = read(ready(), { kind: "run", runId: U }, runDetail());
    const changed = runDetail();
    if (changed.evidenceManifest.available) changed.evidenceManifest.items[0].note = "ALTERED_FROZEN_ITEM";
    state = read(state, { kind: "run", runId: U }, changed);
    expect(dossierView(state).reads.find(slot => slot.kind === "run")).toMatchObject({ error: { code: "CONFLICTING_RECORD" } });
    expect(JSON.stringify(dossierView(state))).not.toContain("ALTERED_FROZEN_ITEM");
  });

  it("rejects a Resolution summary that contradicts a previously read detail", () => {
    let state = read(ready(), { kind: "resolution", resolutionId: R }, resolutionDetail());
    state = read(state, { kind: "resolutions", cursor: null }, resolutions(resolution({ preferredClaimId: R2 })));
    expect(dossierView(state).resolutions.error).toMatchObject({ code: "CONFLICTING_RECORD" });
    expect(dossierView(state).current.status).toBe("error");
  });

  it.each([true, false])("rejects conflicting Assessment summary/detail facts in either read order (summary first=%s)", summaryFirst => {
    const conflicting = assessmentHistory([assessment({ stance: "SUPPORTS" })]);
    let state = ready();
    if (summaryFirst) {
      state = read(state, { kind: "assessments", claimId: C, cursor: null }, conflicting);
      state = read(state, { kind: "assessment", claimId: C, assessmentId: A }, assessmentDetail());
    } else {
      state = read(state, { kind: "assessment", claimId: C, assessmentId: A }, assessmentDetail());
      state = read(state, { kind: "assessments", claimId: C, cursor: null }, conflicting);
    }
    expect(dossierView(state).reads.find(slot => slot.kind === (summaryFirst ? "assessment" : "assessments"))).toMatchObject({ error: { code: "CONFLICTING_RECORD" } });
  });

  it.each([false, true])("invalidates known target caches on the very first unavailable Run read (retained Assessment error=%s)", retainedError => {
    let state = read(ready(), { kind: "assessment", claimId: C, assessmentId: A }, assessmentDetail());
    const candidates = { claim: { id: C, statement: "候选答案", lifecycleState: "ACTIVE" as const }, candidates: [{ targetType: "NOTE_REVISION" as const, targetId: TARGET, materialBindingId: BINDING, materialTitle: "史料", noteId: NOTE, revisionNo: 2, contentFormat: "MARKDOWN" as const, createdAt: T }] };
    state = read(state, { kind: "candidates", claimId: C }, candidates);
    state = read(state, { kind: "revision", bindingId: BINDING, revisionId: TARGET }, { revision: { revisionId: TARGET, revisionNo: 2, createdAt: T, contentFormat: "MARKDOWN", content: "历史正文", contentSha256: HASH } });
    if (retainedError) {
      const failed = startDossierRead(state, { kind: "assessment", claimId: C, assessmentId: A });
      state = failDossierRead(failed.state, failed.ticket!, 503);
    }
    const oldCandidates = startDossierRead(state, { kind: "candidates", claimId: C });
    const unavailable = outputRun();
    unavailable.evidenceManifest = { id: M, manifestSha256: HASH, itemCount: 1, available: false };
    state = read(oldCandidates.state, { kind: "run", runId: U }, unavailable);
    state = receiveDossierRead(state, oldCandidates.ticket!, candidates, T);
    const view = dossierView(state);
    expect(view.runDetails[0].producedReferences[3].status).toBe("unresolved");
    expect(JSON.stringify(view)).not.toContain(BINDING);
  });

  it("does not reuse old Current detail after the pointer moves away and back", () => {
    let state = read(ready(), { kind: "resolutions", cursor: null }, resolutions(resolution()));
    state = read(state, { kind: "resolution", resolutionId: R }, resolutionDetail());
    state = read(state, { kind: "resolutions", cursor: null }, resolutions(resolution({ id: R2 })));
    state = read(state, { kind: "resolutions", cursor: null }, resolutions(resolution()));
    expect(dossierView(state).current).toMatchObject({ status: "recorded", summary: { id: R }, detail: { status: "notRequested", data: null } });
    state = read(state, { kind: "resolution", resolutionId: R }, resolutionDetail());
    expect(dossierView(state).current).toMatchObject({ detail: { status: "ready", data: { resolution: { id: R } } } });
  });

  it("rejects inconsistent immutable content between Current and its duplicate history row", () => {
    const state = read(ready(), { kind: "resolutions", cursor: null }, resolutions(resolution(), [resolution({ rationaleExcerpt: "DIFFERENT_CURRENT_REASON" })]));
    expect(dossierView(state).resolutions.error).toMatchObject({ code: "CONFLICTING_RECORD" });
    expect(dossierView(state).current).toMatchObject({ status: "error" });
  });

  it.each(["assessment", "resolution"] as const)("rejects changed frozen reasoning in repeated %s detail", kind => {
    let state = ready();
    if (kind === "assessment") {
      state = read(state, { kind, claimId: C, assessmentId: A }, assessmentDetail());
      const altered = assessmentDetail();
      altered.assessment.reasoning = "ALTERED_FROZEN_REASON";
      state = read(state, { kind, claimId: C, assessmentId: A }, altered);
    } else {
      state = read(state, { kind, resolutionId: R }, resolutionDetail());
      const altered = resolutionDetail();
      altered.resolution.rationale = "ALTERED_FROZEN_REASON";
      state = read(state, { kind, resolutionId: R }, altered);
    }
    expect(dossierView(state).reads.find(slot => slot.kind === kind)).toMatchObject({ error: { code: "CONFLICTING_RECORD" } });
    expect(JSON.stringify(dossierView(state))).not.toContain("ALTERED_FROZEN_REASON");
  });

  it("retains a newly observed evidence restriction even when another row makes the page conflict", () => {
    const visible = resolution({ evidenceBasisAvailable: true, evidenceManifest: manifest() });
    let state = read(ready(), { kind: "resolutions", cursor: null }, resolutions(visible, [visible, resolution({ id: R2, isCurrent: false })], "next"));
    state = read(state, { kind: "resolutions", cursor: "next" }, resolutions(resolution(), [resolution({ id: R2, isCurrent: false, rationaleExcerpt: "CONFLICT" })]));
    const view = dossierView(state);
    expect(view.resolutions).toMatchObject({ error: { code: "CONFLICTING_RECORD" }, coverage: { nextCursor: "next", loadedCount: 2 } });
    expect(view.resolutions.rows[0].evidenceManifest).toBeNull();
    expect(JSON.stringify(view)).not.toContain(HASH);
  });

  it("does not expose newly added source fields through the read-only projection", () => {
    const summary = resolution({ evidenceBasisAvailable: true, evidenceManifest: manifest() });
    Object.assign(summary, { evidenceManifestId: "UNEXPECTED_MANIFEST_ID" });
    const state = read(ready(), { kind: "resolutions", cursor: null }, resolutions(summary, [summary]));
    expect(JSON.stringify(dossierView(state))).not.toContain("UNEXPECTED_MANIFEST_ID");
    expect(dossierView(state).references).toEqual([]);
  });

  it("requires an accepted Issue scope before starting dependent reads", () => {
    const state = createDossier(SCOPE);
    expect(startDossierRead(state, { kind: "claims" }).ticket).toBeNull();
    expect(startDossierRead(state, { kind: "run", runId: U }).ticket).toBeNull();
    expect(startDossierRead(state, { kind: "question" }).ticket).not.toBeNull();
  });

  it.each([401, 403])("clears all private projections and outstanding tickets after session failure %s", status => {
    let state = read(ready(), { kind: "run", runId: U }, outputRun());
    const oldRuns = startDossierRead(state, { kind: "runs", cursor: null });
    const denied = startDossierRead(oldRuns.state, { kind: "claims" });
    state = failDossierRead(denied.state, denied.ticket!, status);
    const after = receiveDossierRead(state, oldRuns.ticket!, { runs: [run()], nextCursor: null }, T);
    expect(dossierView(after).runDetails).toEqual([]);
    expect(dossierView(after).runs.rows).toEqual([]);
    expect(dossierView(after).question.data).toBeNull();
    expect(JSON.stringify(dossierView(after))).not.toContain("比较版本");
  });

  it("clears the dossier after a scope 404 and does not accept older optional reads", () => {
    let state = read(ready(), { kind: "assessments", claimId: C, cursor: null }, assessmentHistory());
    const detail = startDossierRead(state, { kind: "assessment", claimId: C, assessmentId: A });
    const missing = startDossierRead(detail.state, { kind: "question" });
    state = failDossierRead(missing.state, missing.ticket!, 404);
    state = receiveDossierRead(state, detail.ticket!, assessmentDetail(), T);
    expect(dossierView(state).question).toMatchObject({ status: "unavailable", data: null });
    expect(dossierView(state).assessments).toEqual([]);
    expect(dossierView(state).assessmentDetails).toEqual([]);
  });

  it("does not let an older page pointer overwrite a newer independently accepted Current", () => {
    let state = read(ready(), { kind: "resolutions", cursor: null }, resolutions(resolution(), [resolution()], "page2"));
    const olderPage = startDossierRead(state, { kind: "resolutions", cursor: "page2" });
    state = read(olderPage.state, { kind: "resolution", resolutionId: R }, resolutionDetail(R, R2));
    state = receiveDossierRead(state, olderPage.ticket!, resolutions(resolution(), [resolution()]), T);
    expect(dossierView(state).current).toEqual({ status: "changed", reconciliationRequired: true });
    expect(dossierView(state).resolutions.rows.every(row => !row.isCurrent)).toBe(true);
  });

  it("does not keep a Current summary when that Resolution's own detail becomes unavailable", () => {
    let state = read(ready(), { kind: "resolutions", cursor: null }, resolutions(resolution(), [resolution(), resolution({ id: R2, isCurrent: false })]));
    const missing = startDossierRead(state, { kind: "resolution", resolutionId: R });
    state = failDossierRead(missing.state, missing.ticket!, 404);
    expect(dossierView(state).current).toMatchObject({ status: "error", error: { status: 404 } });
    expect(dossierView(state).resolutions.rows.map(row => row.id)).toEqual([R2]);
    expect(dossierView(state).resolutions.rows[0].isCurrent).toBe(false);
  });

  it("uses fresh terminal Run detail metadata without losing list microseconds or inserting ancestry", () => {
    let state = read(ready(), { kind: "runs", cursor: null }, { runs: [run()], nextCursor: "more" });
    state = read(state, { kind: "run", runId: U }, runDetail(run({ status: "SUCCEEDED", completedAt: T })));
    expect(dossierView(state).runs.rows[0]).toMatchObject({ status: "SUCCEEDED", startedAtMicros: MICROS, completedAt: T });
    expect(dossierView(state).whatChanged.runCards[0].terminated).toMatchObject({ status: "SUCCEEDED" });
    expect(dossierView(state).runs.coverage).toMatchObject({ loadedCount: 1, nextCursor: "more" });
  });

  it("rejects conflicting immutable Run detail identity against its already-read summary", () => {
    let state = read(ready(), { kind: "runs", cursor: null }, { runs: [run()], nextCursor: null });
    const conflicting = runDetail();
    conflicting.run.startedAt = "2026-10-01T00:00:00.000Z";
    state = read(state, { kind: "run", runId: U }, conflicting);
    expect(dossierView(state).runDetails).toEqual([]);
    expect(dossierView(state).reads.find(slot => slot.kind === "run")).toMatchObject({ error: { code: "CONFLICTING_RECORD" } });
  });

  it("rejects a changed terminal detail output instead of silently overwriting the frozen record", () => {
    let state = read(ready(), { kind: "run", runId: U }, outputRun());
    const changed = outputRun();
    changed.run.output!.summary = "ALTERED_TERMINAL_OUTPUT";
    state = read(state, { kind: "run", runId: U }, changed);
    expect(dossierView(state).reads.find(slot => slot.kind === "run")).toMatchObject({ error: { code: "CONFLICTING_RECORD" } });
    expect(JSON.stringify(dossierView(state))).not.toContain("ALTERED_TERMINAL_OUTPUT");
  });

  it("accepts equivalent immutable manifests independently of JSON property order", () => {
    let state = read(ready(), { kind: "assessments", claimId: C, cursor: null }, assessmentHistory([assessment()], C, "page2"));
    const reordered = assessment();
    reordered.evidenceManifest = { purpose: "CLAIM_ASSESSMENT", itemCount: 1, manifestSha256: HASH, schemaVersion: 1, id: M };
    state = read(state, { kind: "assessments", claimId: C, cursor: "page2" }, assessmentHistory([reordered]));
    expect(dossierView(state).assessments[0]).toMatchObject({ error: null, coverage: { loadedCount: 1, exhausted: true } });
  });

  it("keeps independent per-Claim cursors and never starts optional fanout itself", () => {
    let state = read(ready(), { kind: "assessments", claimId: C, cursor: null }, assessmentHistory([assessment()], C, "claim1-page2"));
    state = read(state, { kind: "assessments", claimId: R2, cursor: null }, assessmentHistory([assessment({ id: R })], R2, "claim2-page2"));
    expect(dossierView(state).assessments.map(history => history.coverage.nextCursor)).toEqual(["claim1-page2", "claim2-page2"]);
    expect(startDossierRead(state, { kind: "assessments", claimId: C, cursor: "claim2-page2" }).ticket).toBeNull();
    expect(dossierView(state).reads.map(slot => slot.kind)).toEqual(["question", "assessments", "assessments"]);
  });

  it("resolves a produced request only from authorized mapping and never guesses a Claim ID", () => {
    let state = read(ready(), { kind: "run", runId: U }, outputRun());
    expect(dossierProducedRequest(state, U, "assessment", 1)).toBeNull();
    state = read(state, { kind: "bases", cursor: null }, bases());
    expect(dossierProducedRequest(state, U, "assessment", 1)).toEqual({ kind: "assessment", claimId: C, assessmentId: A });
    expect(dossierProducedRequest(state, U, "assessment", 2)).toBeNull();
    expect(dossierProducedRequest(state, U, "noteRevision", 1)).toBeNull();
    expect(dossierProducedRequest(state, U, "resolution", 1)).toEqual({ kind: "resolution", resolutionId: R });
  });

  it("invalidates related binding/revision caches and in-flight enrichment without hiding separately authorized records", () => {
    let state = read(ready(), { kind: "assessment", claimId: C, assessmentId: A }, assessmentDetail());
    state = read(state, { kind: "resolution", resolutionId: R }, { ...resolutionDetail(), evidenceBasisAvailable: true, evidenceManifest: assessmentDetail().evidenceManifest });
    state = read(state, { kind: "run", runId: U }, outputRun());
    const candidates = { claim: { id: C, statement: "候选答案", lifecycleState: "ACTIVE" as const }, candidates: [{ targetType: "NOTE_REVISION" as const, targetId: TARGET, materialBindingId: BINDING, materialTitle: "史料", noteId: NOTE, revisionNo: 2, contentFormat: "MARKDOWN" as const, createdAt: T }] };
    state = read(state, { kind: "candidates", claimId: C }, candidates);
    state = read(state, { kind: "revision", bindingId: BINDING, revisionId: TARGET }, { revision: { revisionId: TARGET, revisionNo: 2, createdAt: T, contentFormat: "MARKDOWN", content: "历史正文", contentSha256: HASH } });
    const oldCandidates = startDossierRead(state, { kind: "candidates", claimId: C });
    const denied = startDossierRead(oldCandidates.state, { kind: "assessment", claimId: C, assessmentId: A });
    state = failDossierRead(denied.state, denied.ticket!, 404);
    state = receiveDossierRead(state, oldCandidates.ticket!, candidates, T);
    const view = dossierView(state);
    expect(view.runDetails[0].producedReferences[3].status).toBe("unresolved");
    expect(JSON.stringify(view)).not.toContain(BINDING);
    expect(view.resolutionDetails[0].evidenceManifest?.items[0].targetId).toBe(TARGET);
    expect(view.references[0]).not.toHaveProperty("href");
  });

  it("does not mutate deeply frozen inputs and resets every optional projection on refresh", () => {
    function freeze<T>(value: T): T {
      if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
      return value;
    }
    const initial = freeze(ready());
    const payload = freeze(assessmentHistory());
    let state = read(initial, { kind: "assessments", claimId: C, cursor: null }, payload);
    state = read(state, { kind: "assessment", claimId: C, assessmentId: A }, freeze(assessmentDetail()));
    state = read(state, { kind: "bases", cursor: null }, bases());
    expect(dossierView(initial).assessments).toEqual([]);
    const view = dossierView(resetDossier(freeze(state)));
    expect(view.assessments).toEqual([]);
    expect(view.assessmentDetails).toEqual([]);
    expect(view.references).toEqual([]);
    expect(view.evidenceBases.coverage).toMatchObject({ status: "notRequested", loadedCount: 0, nextCursor: null, exhausted: false });
  });
});

describe("R4 Run 404 invalidates stale evidence availability", () => {
  it("no longer calls a previously loaded Run's evidence currently available after its detail 404", () => {
    const opaqueCursor = "opaque-next-page_+/=";
    let state = read(ready(), { kind: "runs", cursor: null }, {
      runs: [run()], nextCursor: opaqueCursor,
    });
    state = read(state, { kind: "run", runId: U }, runDetail());
    const pending = startDossierRead(state, { kind: "run", runId: U });
    expect(pending.ticket).not.toBeNull();
    state = failDossierRead(pending.state, pending.ticket!, 404);

    const view = dossierView(state);
    expect(view.runDetails).toEqual([]);
    expect(view.runs.rows[0].evidenceManifest.available).toBe(false);
    expect(view.runs.coverage.nextCursor).toBe(opaqueCursor);
    expect(view.runs.rows[0].runId).toBe(U);
  });

  it("cannot resurrect old positive evidence availability from a list GET started before a Run detail 404", () => {
    let state = read(ready(), { kind: "runs", cursor: null }, {
      runs: [run()], nextCursor: null,
    });
    const olderList = startDossierRead(state, { kind: "runs", cursor: null });
    const detail = startDossierRead(olderList.state, { kind: "run", runId: U });
    expect(olderList.ticket).not.toBeNull();
    expect(detail.ticket).not.toBeNull();
    state = failDossierRead(detail.state, detail.ticket!, 404);
    state = receiveDossierRead(state, olderList.ticket!, {
      runs: [run()], nextCursor: null,
    }, T);
    expect(dossierView(state).runs.rows[0].evidenceManifest.available).toBe(false);
    expect(dossierView(state).runDetails).toEqual([]);
  });

  it("does not interpret a Run detail 503 as proof of revoked evidence", () => {
    let state = read(ready(), { kind: "runs", cursor: null }, {
      runs: [run()], nextCursor: null,
    });
    const pending = startDossierRead(state, { kind: "run", runId: U });
    state = failDossierRead(pending.state, pending.ticket!, 503);
    const view = dossierView(state);
    expect(view.runs.rows[0].evidenceManifest.available).toBe(true);
    expect(view.runDetails).toEqual([]);
    expect(view.reads.find(row => row.kind === "run")).toMatchObject({
      error: { status: 503 },
    });
  });
});
