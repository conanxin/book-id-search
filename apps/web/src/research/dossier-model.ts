import type {
  AssessmentDetailResponse, AssessmentHistoryResponse, AssessmentManifestSummary, AssessmentSummary,
  EvidenceCandidate, EvidenceClaimContext, IssueResolutionEvidenceBasesResponse,
  CandidateClaim, IssueResolutionDetailResponse, IssueResolutionHistoryResponse,
  ProjectItemNoteRevision, ResearchRunEvidenceCompactSummary, ResearchRunEvidenceSnapshot,
  ResearchRunRecord,
  IssueResolutionSummary, ResearchIssueDetailResponse, ResearchRunDetailResponse,
  ResearchRunListResponse, ResearchRunSummary,
} from "./api";

/** Pure page-memory model. Task 3 owns API calls, AbortControllers and rendering.
 * Inputs are responses validated by api.ts; this module additionally checks the
 * requested identities and safe composition of independently authorized reads.
 * State contains internal addressing information. Render dossierView(state).
 */
export interface DossierScope {
  projectId: string;
  issueId: string;
  authGeneration: number;
}

export interface DossierResponses {
  question: ResearchIssueDetailResponse;
  claims: { claims: CandidateClaim[] };
  resolutions: IssueResolutionHistoryResponse;
  resolution: IssueResolutionDetailResponse;
  runs: ResearchRunListResponse;
  run: ResearchRunDetailResponse;
  assessments: AssessmentHistoryResponse;
  assessment: AssessmentDetailResponse;
  bases: IssueResolutionEvidenceBasesResponse;
  candidates: { claim: EvidenceClaimContext; candidates: EvidenceCandidate[] };
  revision: { revision: ProjectItemNoteRevision };
}
export type DossierRequest =
  | { kind: "question" }
  | { kind: "claims" }
  | { kind: "resolutions"; cursor: string | null }
  | { kind: "runs"; cursor: string | null }
  | { kind: "bases"; cursor: string | null }
  | { kind: "assessments"; claimId: string; cursor: string | null }
  | { kind: "assessment"; claimId: string; assessmentId: string }
  | { kind: "candidates"; claimId: string }
  | { kind: "revision"; bindingId: string; revisionId: string }
  | { kind: "resolution"; resolutionId: string }
  | { kind: "run"; runId: string };
type Kind = keyof DossierResponses;
type Response = DossierResponses[Kind];
export interface DossierReadTicket {
  scopeKey: string;
  generation: number;
  sequence: number;
  request: DossierRequest;
}
export interface DossierReadError {
  status: number | null;
  code: "REQUEST_FAILED" | "RESPONSE_MISMATCH" | "CONFLICTING_RECORD";
}
type ReadStatus = "notRequested" | "loading" | "ready" | "partial" | "error" | "unavailable";
interface Source {
  request: DossierRequest;
  data: Response | null;
  status: ReadStatus;
  error: DossierReadError | null;
  pending: DossierReadTicket | null;
  readAt: string | null;
  readSequence: number;
}
export interface DossierState {
  scope: DossierScope;
  generation: number;
  nextSequence: number;
  sources: Record<string, Source>;
  /** Read-start sequence watermarks survive fresh successes in other projections. */
  invalidated: Record<string, number>;
  missing: Record<string, number>;
  targetInvalidated: Record<string, number>;
  recordConflicts: Record<string, true>;
  current: {
    sequence: number;
    changedSequence: number;
    pointer: string | null | undefined;
    summary: IssueResolutionSummary | null;
    error: DossierReadError | null;
  };
}

function scopeKey(scope: DossierScope) {
  return JSON.stringify([scope.projectId, scope.issueId, scope.authGeneration]);
}
function sourceKey(request: DossierRequest): string {
  switch (request.kind) {
    case "resolution": return JSON.stringify([request.kind, request.resolutionId]);
    case "run": return JSON.stringify([request.kind, request.runId]);
    case "assessments": case "candidates": return JSON.stringify([request.kind, request.claimId]);
    case "assessment": return JSON.stringify([request.kind, request.claimId, request.assessmentId]);
    case "revision": return JSON.stringify([request.kind, request.bindingId, request.revisionId]);
    default: return request.kind;
  }
}
function source(state: DossierState, request: DossierRequest) { return state.sources[sourceKey(request)]; }
function response<K extends Kind>(state: DossierState, request: DossierRequest & { kind: K }): DossierResponses[K] | null {
  return (source(state, request)?.data ?? null) as DossierResponses[K] | null;
}
function cursorOf(data: Response | null): string | null {
  return data && "nextCursor" in data ? data.nextCursor : null;
}

export function createDossier(scope: DossierScope): DossierState {
  return {
    scope: { ...scope }, generation: 0, nextSequence: 1, sources: {}, invalidated: {}, missing: {}, targetInvalidated: {}, recordConflicts: {},
    current: { sequence: 0, changedSequence: 0, pointer: undefined, summary: null, error: null },
  };
}

/** Call on refresh, scope change or auth generation change before rendering.
 * All optional reads, cursor coverage, selections and private payloads are reset.
 */
export function resetDossier(state: DossierState, scope = state.scope): DossierState {
  return { ...createDossier(scope), generation: state.generation + 1, nextSequence: state.nextSequence };
}

/** A ticket describes a request; creating one performs no I/O. Null means that
 * the stream is already reading, or the requested cursor is not its next page.
 */
export function startDossierRead(state: DossierState, request: DossierRequest): { state: DossierState; ticket: DossierReadTicket | null } {
  const scopeRead = source(state, { kind: "question" });
  if (request.kind !== "question" && (!scopeRead?.data || scopeRead.error)) return { state, ticket: null };
  const previous = source(state, request);
  if (previous?.pending) return { state, ticket: null };
  if ("cursor" in request && request.cursor !== null
    && (!previous?.data || cursorOf(previous.data) !== request.cursor)) return { state, ticket: null };
  const ticket = { scopeKey: scopeKey(state.scope), generation: state.generation, sequence: state.nextSequence, request: { ...request } };
  const next = { ...state, nextSequence: state.nextSequence + 1, sources: { ...state.sources } };
  next.sources[sourceKey(request)] = {
    request: ticket.request, data: previous?.data ?? null, status: "loading", error: null,
    pending: ticket, readAt: previous?.readAt ?? null, readSequence: previous?.readSequence ?? 0,
  };
  return { state: next, ticket };
}

function accepts(state: DossierState, ticket: DossierReadTicket) {
  const pending = source(state, ticket.request)?.pending;
  return ticket.scopeKey === scopeKey(state.scope) && ticket.generation === state.generation
    && pending?.sequence === ticket.sequence && JSON.stringify(pending.request) === JSON.stringify(ticket.request);
}
function statusAfterRead(slot: Source): ReadStatus {
  if (slot.data === null) return "notRequested";
  return cursorOf(slot.data) === null ? "ready" : "partial";
}

export function failDossierRead(
  state: DossierState, ticket: DossierReadTicket, status: number | null,
  code: DossierReadError["code"] = "REQUEST_FAILED",
): DossierState {
  if (!accepts(state, ticket)) return state;
  if (status === 401 || status === 403 || (status === 404 && ticket.request.kind === "question")) {
    const next = resetDossier(state);
    next.sources.question = { request: { kind: "question" }, data: null, status: status === 404 ? "unavailable" : "error", error: { status, code }, pending: null, readAt: null, readSequence: 0 };
    return next;
  }
  const next = structuredClone(state);
  if (status === 404 && ticket.request.kind === "assessment") invalidateObject(next, "assessment", ticket.request.assessmentId);
  // A 404 on an already listed Run invalidates its previous positive evidence
  // availability. Older list GETs must not reintroduce that stale disclosure.
  // A transient 5xx does not revoke an independently authorized Run.
  if (status === 404 && ticket.request.kind === "run") invalidateObject(next, "run", ticket.request.runId);
  if (status === 404 && ticket.request.kind === "resolution") {
    const id = ticket.request.resolutionId;
    invalidateObject(next, "resolution", id);
    next.missing[typedKey("resolution", id)] = next.nextSequence - 1;
    for (const slot of Object.values(next.sources)) if (slot.request.kind === "resolutions" && slot.data) {
      const data = slot.data as IssueResolutionHistoryResponse;
      data.resolutions = data.resolutions.filter(row => row.id !== id);
      if (data.currentResolution?.id === id) data.currentResolution = null;
    }
    if (next.current.pointer === id) next.current = { sequence: Math.max(next.current.sequence, ticket.sequence), changedSequence: next.nextSequence - 1, pointer: undefined, summary: null, error: { status, code } };
  }
  const slot = next.sources[sourceKey(ticket.request)];
  slot.pending = null;
  slot.error = { status, code };
  slot.status = slot.data ? "partial" : "error";
  if (status === 404 && ["assessment", "resolution", "run", "revision"].includes(ticket.request.kind)) {
    slot.data = null;
    slot.status = "unavailable";
    slot.error = null;
  }
  if (ticket.request.kind === "resolutions" && ticket.request.cursor === null && ticket.sequence >= next.current.sequence) {
    next.current = { sequence: ticket.sequence, changedSequence: ticket.sequence, pointer: undefined, summary: null, error: slot.error };
  }
  return next;
}

function validateIdentity(scope: DossierScope, request: DossierRequest, value: Response) {
  switch (request.kind) {
    case "question": {
      const data = value as ResearchIssueDetailResponse;
      return data.project.id === scope.projectId && data.issue.id === scope.issueId && data.issue.projectId === scope.projectId;
    }
    case "claims": return Array.isArray((value as DossierResponses["claims"]).claims);
    case "resolutions": {
      const data = value as IssueResolutionHistoryResponse;
      const pointer = data.issue.currentResolutionId;
      return data.issue.id === scope.issueId && (pointer === null ? data.currentResolution === null
        : data.currentResolution?.id === pointer && data.currentResolution.issueId === scope.issueId && data.currentResolution.isCurrent)
        && data.resolutions.every(row => row.issueId === scope.issueId && row.isCurrent === (row.id === pointer));
    }
    case "resolution": {
      const data = value as IssueResolutionDetailResponse;
      return data.issue.id === scope.issueId && data.resolution.issueId === scope.issueId
        && data.resolution.id === request.resolutionId && data.resolution.isCurrent === (data.issue.currentResolutionId === request.resolutionId);
    }
    case "runs": return (value as ResearchRunListResponse).runs.every(row => row.issueId === scope.issueId);
    case "run": {
      const data = value as ResearchRunDetailResponse;
      return data.run.projectId === scope.projectId && data.run.issueId === scope.issueId && data.run.runId === request.runId
        && data.evidenceManifest.id === data.run.evidenceManifestId && data.ancestors.every(row => row.issueId === scope.issueId);
    }
    case "assessments": return (value as AssessmentHistoryResponse).claim.id === request.claimId;
    case "assessment": {
      const data = value as AssessmentDetailResponse;
      return data.claim.id === request.claimId && data.assessment.claimId === request.claimId && data.assessment.id === request.assessmentId;
    }
    case "bases": return (value as IssueResolutionEvidenceBasesResponse).issueId === scope.issueId;
    case "candidates": return (value as DossierResponses["candidates"]).claim.id === request.claimId;
    case "revision": return (value as DossierResponses["revision"]).revision.revisionId === request.revisionId;
  }
}

function compact(manifest: ResearchRunEvidenceCompactSummary): ResearchRunEvidenceCompactSummary {
  return { id: manifest.id, manifestSha256: manifest.manifestSha256, itemCount: manifest.itemCount, available: manifest.available };
}
function snapshot(manifest: ResearchRunEvidenceSnapshot): ResearchRunEvidenceSnapshot {
  const base = compact(manifest);
  return manifest.available ? {
    ...base, available: true,
    items: manifest.items.map(item => ({ ordinal: item.ordinal, role: item.role, targetType: item.targetType, note: item.note })),
  } : { ...base, available: false };
}
function manifestSummary(manifest: AssessmentManifestSummary): AssessmentManifestSummary {
  return { id: manifest.id, schemaVersion: manifest.schemaVersion, purpose: manifest.purpose, manifestSha256: manifest.manifestSha256, itemCount: manifest.itemCount };
}
function manifestDetail(manifest: AssessmentDetailResponse["evidenceManifest"]): AssessmentDetailResponse["evidenceManifest"] {
  return {
    id: manifest.id, schemaVersion: manifest.schemaVersion, purpose: manifest.purpose,
    manifestSha256: manifest.manifestSha256, createdAt: manifest.createdAt,
    items: manifest.items.map(item => ({ ordinal: item.ordinal, role: item.role, targetType: item.targetType, targetId: item.targetId, locatorType: null, locator: null, excerpt: null, note: item.note })),
  };
}
function resolutionSummary(row: IssueResolutionSummary): IssueResolutionSummary {
  return {
    id: row.id, issueId: row.issueId, resolutionType: row.resolutionType, preferredClaimId: row.preferredClaimId,
    rationaleExcerpt: row.rationaleExcerpt, createdAt: row.createdAt, isCurrent: row.isCurrent,
    evidenceBasisAvailable: row.evidenceBasisAvailable,
    evidenceManifest: row.evidenceBasisAvailable && row.evidenceManifest ? manifestSummary(row.evidenceManifest) : null,
  };
}
function runSummary(row: ResearchRunSummary): ResearchRunSummary {
  return {
    runId: row.runId, issueId: row.issueId, status: row.status, replayOf: row.replayOf,
    startedAtMicros: row.startedAtMicros, startedAt: row.startedAt, completedAt: row.completedAt,
    evidenceManifest: compact(row.evidenceManifest),
  };
}
function assessmentSummary(row: AssessmentSummary): AssessmentSummary {
  return {
    id: row.id, stance: row.stance, confidenceLevel: row.confidenceLevel, actorId: row.actorId,
    numericScore: row.numericScore, scoreKind: row.scoreKind, reasoningExcerpt: row.reasoningExcerpt,
    createdAt: row.createdAt, evidenceManifest: manifestSummary(row.evidenceManifest),
  };
}
function typedKey(kind: "assessment" | "resolution" | "run", id: string) { return `${kind}:${id}`; }

function invalidateRelatedTargets(state: DossierState, kind: "assessment" | "resolution" | "run", id: string, incomingManifestIds: string[]) {
  const manifests = new Set<string>(incomingManifestIds);
  if (kind === "assessment") {
    for (const { data } of retained(state, "assessments")) for (const row of data.assessments) if (row.id === id) manifests.add(row.evidenceManifest.id);
    for (const { data } of retained(state, "assessment")) if (data.assessment.id === id) manifests.add(data.evidenceManifest.id);
    for (const { data } of retained(state, "bases")) for (const row of data.evidenceBases) if (row.assessmentId === id) manifests.add(row.manifestId);
  } else if (kind === "resolution") {
    if (state.current.summary?.id === id && state.current.summary.evidenceManifest) manifests.add(state.current.summary.evidenceManifest.id);
    for (const { data } of retained(state, "resolutions")) for (const row of data.resolutions) if (row.id === id && row.evidenceManifest) manifests.add(row.evidenceManifest.id);
    for (const { data } of retained(state, "resolution")) if (data.resolution.id === id && data.evidenceManifest) manifests.add(data.evidenceManifest.id);
  } else {
    for (const { data } of retained(state, "runs")) for (const row of data.runs) if (row.runId === id) manifests.add(row.evidenceManifest.id);
    for (const { data } of retained(state, "run")) {
      if (data.run.runId === id) manifests.add(data.evidenceManifest.id);
      for (const row of data.ancestors) if (row.runId === id) manifests.add(row.evidenceManifest.id);
    }
  }
  const targets = new Set<string>();
  for (const { data } of [...retained(state, "assessment"), ...retained(state, "resolution")]) {
    if (data.evidenceManifest && manifests.has(data.evidenceManifest.id)) {
      for (const item of data.evidenceManifest.items) targets.add(`${item.targetType}:${item.targetId}`);
    }
  }
  for (const key of targets) state.targetInvalidated[key] = state.nextSequence - 1;
  for (const slot of Object.values(state.sources)) {
    if (slot.request.kind === "candidates" && slot.data) {
      const data = slot.data as DossierResponses["candidates"];
      data.candidates = data.candidates.filter(row => !targets.has(`${row.targetType}:${row.targetId}`));
    }
    if (slot.request.kind === "revision" && targets.has(`NOTE_REVISION:${slot.request.revisionId}`)) {
      slot.data = null; slot.pending = null; slot.error = null; slot.status = "notRequested"; slot.readAt = null;
    }
  }
}

/** Invalidation only: never copy richer evidence between readers sharing a manifest. */
function invalidateObject(state: DossierState, kind: "assessment" | "resolution" | "run", id: string, incomingManifestIds: string[] = []) {
  invalidateRelatedTargets(state, kind, id, incomingManifestIds);
  state.invalidated[typedKey(kind, id)] = state.nextSequence - 1;
  const maskResolution = (row: IssueResolutionSummary) => row.id === id && kind === "resolution"
    ? { ...row, evidenceBasisAvailable: false, evidenceManifest: null } : row;
  const maskRun = (row: ResearchRunSummary) => row.runId === id && kind === "run"
    ? { ...row, evidenceManifest: { ...compact(row.evidenceManifest), available: false } } : row;
  for (const slot of Object.values(state.sources)) {
    if (!slot.data) continue;
    switch (slot.request.kind) {
      case "assessments": {
        const data = slot.data as AssessmentHistoryResponse;
        if (kind === "assessment") data.assessments = data.assessments.filter(row => row.id !== id);
        break;
      }
      case "bases": {
        const data = slot.data as IssueResolutionEvidenceBasesResponse;
        if (kind === "assessment") data.evidenceBases = data.evidenceBases.filter(row => row.assessmentId !== id);
        break;
      }
      case "assessment":
        if (kind === "assessment" && slot.request.assessmentId === id) { slot.data = null; slot.pending = null; slot.status = "unavailable"; slot.error = null; }
        break;
      case "resolutions": {
        const data = slot.data as IssueResolutionHistoryResponse;
        data.resolutions = data.resolutions.map(maskResolution);
        if (data.currentResolution) data.currentResolution = maskResolution(data.currentResolution);
        break;
      }
      case "resolution": {
        const data = slot.data as IssueResolutionDetailResponse;
        if (kind === "resolution" && data.resolution.id === id) {
          data.evidenceBasisAvailable = false; data.evidenceManifest = null;
        }
        break;
      }
      case "runs": {
        const data = slot.data as ResearchRunListResponse;
        data.runs = data.runs.map(maskRun);
        break;
      }
      case "run": {
        const data = slot.data as ResearchRunDetailResponse;
        if (kind === "run" && data.run.runId === id) data.evidenceManifest = { ...compact(data.evidenceManifest), available: false };
        data.ancestors = data.ancestors.map(maskRun);
        break;
      }
    }
  }
  if (state.current.summary) state.current.summary = maskResolution(state.current.summary);
}

function observeNegativeEvidence(state: DossierState, request: DossierRequest, value: Response) {
  if (request.kind === "resolutions") {
    const data = value as IssueResolutionHistoryResponse;
    for (const row of [...data.resolutions, ...(data.currentResolution ? [data.currentResolution] : [])]) {
      if (!row.evidenceBasisAvailable) invalidateObject(state, "resolution", row.id);
    }
  } else if (request.kind === "resolution") {
    const data = value as IssueResolutionDetailResponse;
    if (!data.evidenceBasisAvailable) invalidateObject(state, "resolution", data.resolution.id);
  } else if (request.kind === "runs") {
    for (const row of (value as ResearchRunListResponse).runs) if (!row.evidenceManifest.available) invalidateObject(state, "run", row.runId, [row.evidenceManifest.id]);
  } else if (request.kind === "run") {
    const data = value as ResearchRunDetailResponse;
    if (!data.evidenceManifest.available) invalidateObject(state, "run", data.run.runId, [data.evidenceManifest.id]);
    for (const row of data.ancestors) if (!row.evidenceManifest.available) invalidateObject(state, "run", row.runId, [row.evidenceManifest.id]);
  }
}

function maskOlderDisclosure(state: DossierState, ticket: DossierReadTicket, value: Response): Response | null {
  const stale = (kind: "assessment" | "resolution" | "run", id: string) => ticket.sequence <= (state.invalidated[typedKey(kind, id)] ?? 0);
  const resolution = (row: IssueResolutionSummary) => stale("resolution", row.id) ? { ...row, evidenceBasisAvailable: false, evidenceManifest: null } : row;
  const run = (row: ResearchRunSummary) => stale("run", row.runId) ? { ...row, evidenceManifest: { ...compact(row.evidenceManifest), available: false } } : row;
  switch (ticket.request.kind) {
    case "assessments": {
      const data = value as AssessmentHistoryResponse;
      return { ...data, assessments: data.assessments.filter(row => !stale("assessment", row.id)) };
    }
    case "assessment": return stale("assessment", (value as AssessmentDetailResponse).assessment.id) ? null : value;
    case "bases": {
      const data = value as IssueResolutionEvidenceBasesResponse;
      return { ...data, evidenceBases: data.evidenceBases.filter(row => !stale("assessment", row.assessmentId)) };
    }
    case "resolutions": {
      const data = value as IssueResolutionHistoryResponse;
      const missing = (id: string) => ticket.sequence <= (state.missing[typedKey("resolution", id)] ?? 0);
      return { ...data, currentResolution: data.currentResolution && !missing(data.currentResolution.id) ? resolution(data.currentResolution) : null, resolutions: data.resolutions.filter(row => !missing(row.id)).map(resolution) };
    }
    case "resolution": {
      const data = value as IssueResolutionDetailResponse;
      return stale("resolution", data.resolution.id) ? { ...data, evidenceBasisAvailable: false, evidenceManifest: null } : data;
    }
    case "runs": return { ...(value as ResearchRunListResponse), runs: (value as ResearchRunListResponse).runs.map(run) };
    case "run": {
      const data = value as ResearchRunDetailResponse;
      return { ...data, evidenceManifest: stale("run", data.run.runId) ? { ...compact(data.evidenceManifest), available: false } : data.evidenceManifest, ancestors: data.ancestors.map(run) };
    }
    case "candidates": {
      const data = value as DossierResponses["candidates"];
      return { ...data, candidates: data.candidates.filter(row => ticket.sequence > (state.targetInvalidated[`${row.targetType}:${row.targetId}`] ?? 0)) };
    }
    case "revision": return ticket.sequence <= (state.targetInvalidated[`NOTE_REVISION:${(value as DossierResponses["revision"]).revision.revisionId}`] ?? 0) ? null : value;
    default: return value;
  }
}

class RecordConflict extends Error {
  constructor(readonly recordKey?: string) { super("Conflicting immutable record"); }
}
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => sameValue(value, b[index]));
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && sameValue(left[key], right[key]));
}
function sameFields<T>(a: T, b: T, keys: readonly (keyof T)[]) {
  return keys.every(key => sameValue(a[key], b[key]));
}
function sameResolution(a: IssueResolutionSummary, b: IssueResolutionSummary) {
  return sameFields(a, b, ["id", "issueId", "resolutionType", "preferredClaimId", "rationaleExcerpt", "createdAt"])
    && (!a.evidenceManifest || !b.evidenceManifest || sameFields(a.evidenceManifest, b.evidenceManifest, ["id", "manifestSha256", "itemCount"]));
}
function compatibleResolutionSummaryDetail(summary: IssueResolutionSummary, detail: IssueResolutionDetailResponse) {
  return sameFields<Pick<IssueResolutionSummary, "id" | "issueId" | "resolutionType" | "preferredClaimId" | "createdAt">>(summary, detail.resolution, ["id", "issueId", "resolutionType", "preferredClaimId", "createdAt"])
    && (!summary.evidenceManifest || !detail.evidenceManifest || sameFields(summary.evidenceManifest,
      { ...summary.evidenceManifest, id: detail.evidenceManifest.id, manifestSha256: detail.evidenceManifest.manifestSha256, itemCount: detail.evidenceManifest.items.length }, ["id", "manifestSha256", "itemCount"]));
}
function checkResolutionDetail(state: DossierState, detail: IssueResolutionDetailResponse) {
  const previous = response(state, { kind: "resolution", resolutionId: detail.resolution.id });
  if (previous && (!sameFields(previous.resolution, detail.resolution, ["id", "issueId", "resolutionType", "preferredClaimId", "rationale", "createdAt"])
    || (previous.evidenceManifest && detail.evidenceManifest && !sameValue(previous.evidenceManifest, detail.evidenceManifest)))) throw new RecordConflict();
  const summaries = [...(response(state, { kind: "resolutions", cursor: null })?.resolutions ?? []), ...(state.current.summary ? [state.current.summary] : [])];
  for (const row of summaries) if (row.id === detail.resolution.id
    && !compatibleResolutionSummaryDetail(row, detail)) throw new RecordConflict();
}
function checkResolutionSummary(state: DossierState, summary: IssueResolutionSummary) {
  for (const { data } of retained(state, "resolution")) {
    if (data.resolution.id !== summary.id) continue;
    if (!compatibleResolutionSummaryDetail(summary, data)) throw new RecordConflict();
  }
}

// Comparable facts are internal only; this never enriches a source projection.
type AssessmentFact = Pick<AssessmentSummary, "id" | "stance" | "confidenceLevel" | "createdAt"> & {
  claimId: string; manifestId: string; manifestSha256: string; itemCount: number;
  actorId?: string | null; numericScore?: number | null; scoreKind?: string | null;
};
function assessmentFacts(request: DossierRequest, value: Response): AssessmentFact[] {
  if (request.kind === "assessment") {
    const data = value as AssessmentDetailResponse;
    return [{ ...data.assessment, manifestId: data.evidenceManifest.id, manifestSha256: data.evidenceManifest.manifestSha256, itemCount: data.evidenceManifest.items.length }];
  }
  if (request.kind === "assessments") {
    const data = value as AssessmentHistoryResponse;
    return data.assessments.map(row => ({ ...row, claimId: data.claim.id, manifestId: row.evidenceManifest.id, manifestSha256: row.evidenceManifest.manifestSha256, itemCount: row.evidenceManifest.itemCount }));
  }
  if (request.kind === "bases") return (value as IssueResolutionEvidenceBasesResponse).evidenceBases.map(row => ({
    id: row.assessmentId, claimId: row.claimId, stance: row.stance, confidenceLevel: row.confidenceLevel, createdAt: row.assessmentCreatedAt,
    manifestId: row.manifestId, manifestSha256: row.manifestSha256, itemCount: row.itemCount,
  }));
  return [];
}
function checkAssessmentFacts(state: DossierState, request: DossierRequest, value: Response) {
  const incoming = assessmentFacts(request, value);
  if (incoming.length === 0) return;
  const known = Object.values(state.sources).flatMap(slot => slot.data ? assessmentFacts(slot.request, slot.data) : []);
  for (const row of incoming) for (const prior of known) if (prior.id === row.id) {
    if (!sameFields(prior, row, ["id", "claimId", "stance", "confidenceLevel", "createdAt", "manifestId", "manifestSha256", "itemCount"])
      || ["actorId", "numericScore", "scoreKind"].some(key => Object.hasOwn(prior, key) && Object.hasOwn(row, key) && !sameValue(prior[key as keyof AssessmentFact], row[key as keyof AssessmentFact]))) {
      throw new RecordConflict(typedKey("assessment", row.id));
    }
  }
}
function sameRun(a: ResearchRunSummary, b: ResearchRunSummary) {
  return sameFields(a, b, ["runId", "issueId", "replayOf", "startedAt", "startedAtMicros"])
    && sameFields(a.evidenceManifest, b.evidenceManifest, ["id", "manifestSha256", "itemCount"])
    && (a.status === "RUNNING" || (a.status === b.status && a.completedAt === b.completedAt));
}

type RunLifecycle = Pick<ResearchRunRecord, "runId" | "issueId" | "replayOf" | "startedAt" | "status" | "completedAt">;
function sameRunLifecycle(a: RunLifecycle, b: RunLifecycle) {
  return sameFields(a, b, ["runId", "issueId", "replayOf", "startedAt"])
    && (a.status === "RUNNING" || (a.status === b.status && a.completedAt === b.completedAt));
}
function reconcileRun(state: DossierState, incoming: ResearchRunSummary | ResearchRunDetailResponse) {
  const detail = "run" in incoming ? incoming : null;
  const row = detail ? detail.run : incoming as ResearchRunSummary;
  const manifest = incoming.evidenceManifest;
  for (const slot of Object.values(state.sources)) {
    if (!slot.data) continue;
    const updateSummary = (prior: ResearchRunSummary) => {
      if (prior.runId !== row.runId) return prior;
      if (!sameRunLifecycle(prior, row) || (!detail && prior.startedAtMicros !== (row as ResearchRunSummary).startedAtMicros)
        || !sameFields(prior.evidenceManifest, manifest, ["id", "manifestSha256", "itemCount"])) throw new RecordConflict();
      return { ...prior, status: row.status, completedAt: row.completedAt };
    };
    if (slot.request.kind === "runs") {
      const data = slot.data as ResearchRunListResponse;
      data.runs = data.runs.map(updateSummary);
    }
    if (slot.request.kind === "run") {
      const data = slot.data as ResearchRunDetailResponse;
      data.ancestors = data.ancestors.map(updateSummary);
      if (data.run.runId !== row.runId) continue;
      if (!sameRunLifecycle(data.run, row) || !sameFields(data.evidenceManifest, manifest, ["id", "manifestSha256", "itemCount"])) throw new RecordConflict();
      if (detail && (!sameFields(data.run, detail.run, ["projectId", "evidenceManifestId", "procedure", "executionContract", "environment", "knowledgeCutoff", "createdAt"])
        || (data.run.status !== "RUNNING" && !sameValue(data.run.output, detail.run.output))
        || (data.evidenceManifest.available && detail.evidenceManifest.available && !sameValue(data.evidenceManifest.items, detail.evidenceManifest.items)))) throw new RecordConflict();
      // A terminal summary cannot supply the separately authorized output detail.
      if (!detail && data.run.status !== row.status) { slot.data = null; slot.status = "notRequested"; slot.readAt = null; }
    }
  }
}

/** Deduplicate within one typed stream without re-sorting server keyset order.
 * Conflicts throw before any state or cursor is committed.
 */
function mergeRows<T>(old: T[], incoming: T[], id: (row: T) => string, compatible: (a: T, b: T) => boolean, append: boolean): T[] {
  const known = new Map(old.map(row => [id(row), row]));
  const rows = append ? [...old] : [];
  const positions = new Map(rows.map((row, index) => [id(row), index]));
  for (const row of incoming) {
    const key = id(row);
    const prior = known.get(key);
    if (prior && !compatible(prior, row)) throw new RecordConflict();
    known.set(key, row);
    const position = positions.get(key);
    if (position === undefined) { positions.set(key, rows.length); rows.push(row); }
    else rows[position] = row;
  }
  return rows;
}

export function receiveDossierRead(
  state: DossierState, ticket: DossierReadTicket, value: Response, readAt: string,
): DossierState {
  if (!accepts(state, ticket)) return state;
  const request = ticket.request;
  try {
    if (!validateIdentity(state.scope, request, value)) return failDossierRead(state, ticket, 502, "RESPONSE_MISMATCH");
    const next = structuredClone(state);
    observeNegativeEvidence(next, request, value);
    const slot = next.sources[sourceKey(request)];
    const data = maskOlderDisclosure(next, ticket, structuredClone(value));
    if (data === null) { slot.pending = null; slot.status = "unavailable"; return next; }
    if (request.kind === "run") {
      for (const ancestor of (data as ResearchRunDetailResponse).ancestors) reconcileRun(next, ancestor);
      reconcileRun(next, data as ResearchRunDetailResponse);
    }
    checkAssessmentFacts(next, request, data);
    if (request.kind === "assessment") {
      const detail = data as AssessmentDetailResponse;
      const prior = response(next, request);
      if (prior && (!sameValue(prior.assessment, detail.assessment) || !sameValue(prior.evidenceManifest, detail.evidenceManifest))) throw new RecordConflict();
    }
    if (request.kind === "resolutions") {
      const page = data as IssueResolutionHistoryResponse;
      const prior = response(next, { kind: "resolutions", cursor: null });
      page.resolutions = mergeRows(prior?.resolutions ?? [], page.resolutions, row => row.id, sameResolution, request.cursor !== null);
      for (const row of [...page.resolutions, ...(page.currentResolution ? [page.currentResolution] : [])]) checkResolutionSummary(next, row);
      if (page.currentResolution) {
        const summary = page.currentResolution;
        for (const row of [...page.resolutions, ...(next.current.summary ? [next.current.summary] : [])]) {
          if (row.id === summary.id && !sameResolution(row, summary)) throw new RecordConflict();
        }
      }
      if (ticket.sequence >= state.current.sequence) next.current = {
        sequence: ticket.sequence, changedSequence: page.issue.currentResolutionId === state.current.pointer ? state.current.changedSequence : ticket.sequence,
        pointer: page.issue.currentResolutionId, summary: page.currentResolution, error: null,
      };
    } else if (request.kind === "resolution") {
      const detail = data as IssueResolutionDetailResponse;
      checkResolutionDetail(next, detail);
      const pointer = detail.issue.currentResolutionId;
      if (ticket.sequence >= state.current.sequence) next.current = {
        sequence: ticket.sequence, changedSequence: pointer === state.current.pointer ? state.current.changedSequence : ticket.sequence, pointer,
        summary: pointer === state.current.pointer ? next.current.summary : null, error: null,
      };
    } else if (request.kind === "runs") {
      const page = data as ResearchRunListResponse;
      const prior = response(next, { kind: "runs", cursor: null });
      page.runs = mergeRows(prior?.runs ?? [], page.runs, row => row.runId, sameRun, request.cursor !== null);
      for (const row of (data as ResearchRunListResponse).runs) reconcileRun(next, row);
    } else if (request.kind === "assessments") {
      const page = data as AssessmentHistoryResponse;
      const prior = response(next, request);
      page.assessments = mergeRows(prior?.assessments ?? [], page.assessments, row => row.id,
        (a, b) => sameFields(a, b, ["id", "stance", "confidenceLevel", "actorId", "numericScore", "scoreKind", "reasoningExcerpt", "createdAt", "evidenceManifest"]), request.cursor !== null);
    } else if (request.kind === "bases") {
      const page = data as IssueResolutionEvidenceBasesResponse;
      const prior = response(next, request);
      page.evidenceBases = mergeRows(prior?.evidenceBases ?? [], page.evidenceBases, row => row.assessmentId,
        (a, b) => sameFields(a, b, ["assessmentId", "claimId", "stance", "confidenceLevel", "manifestId", "manifestSha256", "itemCount", "assessmentCreatedAt"]), request.cursor !== null);
    }
    slot.data = data;
    slot.pending = null;
    slot.error = null;
    slot.status = statusAfterRead(slot);
    slot.readAt = readAt;
    slot.readSequence = ticket.sequence;
    return next;
  } catch (error) {
    if (error instanceof RecordConflict) {
      // Reject the conflicting page atomically, but never discard a valid,
      // narrower disclosure observed in that same response.
      const restricted = structuredClone(state);
      observeNegativeEvidence(restricted, request, value);
      if (error.recordKey) restricted.recordConflicts[error.recordKey] = true;
      return failDossierRead(restricted, ticket, 502, "CONFLICTING_RECORD");
    }
    return failDossierRead(state, ticket, 502, "RESPONSE_MISMATCH");
  }
}

function section<K extends Kind>(state: DossierState, request: DossierRequest & { kind: K }) {
  const slot = source(state, request);
  return { status: slot?.status ?? "notRequested", data: (slot?.data ?? null) as DossierResponses[K] | null, error: slot?.error ?? null, readAt: slot?.readAt ?? null };
}
function collection<T>(state: DossierState, request: DossierRequest, rows: T[]) {
  const slot = source(state, request);
  return {
    rows, error: slot?.error ?? null,
    coverage: {
      scopeKey: scopeKey(state.scope), readGeneration: state.generation,
      status: slot?.status ?? "notRequested", loadedCount: rows.length,
      nextCursor: cursorOf(slot?.data ?? null),
      exhausted: !!slot?.data && slot.error === null && slot.pending === null && cursorOf(slot.data) === null,
      readAt: slot?.readAt ?? null,
    },
  };
}
type CurrentView =
  | { status: "notRequested" | "loading" | "none" }
  | { status: "error"; error: DossierReadError }
  | { status: "changed"; reconciliationRequired: true }
  | { status: "recorded"; summary: IssueResolutionSummary; detail: ReturnType<typeof section<"resolution">> };

function currentView(state: DossierState): CurrentView {
  const current = state.current;
  if (current.error) return { status: "error", error: { ...current.error } };
  if (current.pointer === undefined) {
    return { status: source(state, { kind: "resolutions", cursor: null })?.pending ? "loading" : "notRequested" };
  }
  if (current.pointer === null) return { status: "none" };
  if (!current.summary) return { status: "changed", reconciliationRequired: true };
  return {
    status: "recorded", summary: resolutionSummary({ ...current.summary, isCurrent: true }),
    detail: resolutionSection(state, current.pointer),
  };
}

function resolutionSection(state: DossierState, resolutionId: string) {
  const result = section(state, { kind: "resolution", resolutionId });
  const slot = source(state, { kind: "resolution", resolutionId });
  if (result.data && (result.data.issue.currentResolutionId !== state.current.pointer || (slot?.readSequence ?? 0) < state.current.changedSequence)) {
    return { ...result, status: slot?.pending ? "loading" as const : slot?.error ? "error" as const : "notRequested" as const, data: null, readAt: null };
  }
  return { ...result, data: result.data ? projectResolutionDetail(state, result.data, slot?.readSequence ?? 0) : null };
}
function projectResolutionDetail(state: DossierState, data: IssueResolutionDetailResponse, readSequence: number): IssueResolutionDetailResponse {
  const row = data.resolution;
  return {
    issue: { id: data.issue.id, lifecycleState: data.issue.lifecycleState, currentResolutionId: data.issue.currentResolutionId, updatedAt: data.issue.updatedAt },
    resolution: { id: row.id, issueId: row.issueId, resolutionType: row.resolutionType, preferredClaimId: row.preferredClaimId, rationale: row.rationale, createdAt: row.createdAt, isCurrent: row.id === state.current.pointer && data.issue.currentResolutionId === row.id && readSequence >= state.current.changedSequence },
    evidenceBasisAvailable: data.evidenceBasisAvailable,
    evidenceManifest: data.evidenceBasisAvailable && data.evidenceManifest ? manifestDetail(data.evidenceManifest) : null,
  };
}
function loaded<K extends Kind>(state: DossierState, kind: K) {
  return retained(state, kind).filter(({ slot }) => !slot.error);
}
function retained<K extends Kind>(state: DossierState, kind: K) {
  return Object.values(state.sources).filter(slot => slot.request.kind === kind && slot.data)
    .map(slot => ({ slot, data: slot.data as DossierResponses[K] }));
}
function assessmentMappings(state: DossierState, assessmentId: string) {
  const claims = new Set<string>();
  for (const { data } of loaded(state, "bases")) for (const row of data.evidenceBases) if (row.assessmentId === assessmentId) claims.add(row.claimId);
  for (const { data } of loaded(state, "assessments")) if (data.assessments.some(row => row.id === assessmentId)) claims.add(data.claim.id);
  for (const { data } of loaded(state, "assessment")) if (data.assessment.id === assessmentId) claims.add(data.assessment.claimId);
  return [...claims];
}
function candidatesFor(state: DossierState, targetType: EvidenceCandidate["targetType"], targetId: string) {
  return loaded(state, "candidates").flatMap(({ data }) => data.candidates)
    .filter(candidate => candidate.targetType === targetType && candidate.targetId === targetId);
}
type ProducedKind = "claim" | "assessment" | "resolution" | "noteRevision";
/** Internal request addressing for an explicit produced-reference selection.
 * Missing mapping stays unresolved. This function never scans Claims or fetches.
 */
export function dossierProducedRequest(state: DossierState, runId: string, kind: ProducedKind, ordinal: number): DossierRequest | null {
  const slot = source(state, { kind: "run", runId });
  if (!slot?.data || slot.error || !Number.isInteger(ordinal) || ordinal < 1) return null;
  const output = (slot.data as ResearchRunDetailResponse).run.output;
  if (!output) return null;
  const ids = { claim: output.produced.claimIds, assessment: output.produced.assessmentIds, resolution: output.produced.resolutionIds, noteRevision: output.produced.noteRevisionIds }[kind];
  const id = ids[ordinal - 1];
  if (!id) return null;
  if (kind === "claim") return { kind: "claims" };
  if (kind === "resolution") return { kind: "resolution", resolutionId: id };
  if (kind === "assessment") {
    const claims = assessmentMappings(state, id);
    return claims.length === 1 ? { kind: "assessment", claimId: claims[0], assessmentId: id } : null;
  }
  const mappings = candidatesFor(state, "NOTE_REVISION", id) as Extract<EvidenceCandidate, { targetType: "NOTE_REVISION" }>[];
  const mapping = mappings[0];
  return mapping && mappings.every(row => sameFields(row, mapping, ["noteId", "materialBindingId", "revisionNo"]))
    ? { kind: "revision", bindingId: mapping.materialBindingId, revisionId: id } : null;
}
export type DossierProducedReference =
  | { kind: ProducedKind; ordinal: number; status: "unresolved" | "loading" | "unavailable" }
  | { kind: ProducedKind; ordinal: number; status: "error"; error: DossierReadError }
  | { kind: ProducedKind; ordinal: number; status: "resolved"; id: string; claimId?: string; revisionNo?: number; href?: string };

function producedReference(state: DossierState, kind: ProducedKind, ordinal: number, id: string): DossierProducedReference {
  const base = { kind, ordinal };
  const unresolved = (): DossierProducedReference => ({ ...base, status: "unresolved" });
  const conflict = (): DossierProducedReference => ({ ...base, status: "error", error: { status: 502, code: "CONFLICTING_RECORD" } });
  if (kind === "assessment" && state.recordConflicts[typedKey("assessment", id)]) return conflict();
  let slot: Source | undefined;
  let claimId: string | undefined;
  let revision: Extract<EvidenceCandidate, { targetType: "NOTE_REVISION" }> | undefined;
  if (kind === "claim") slot = source(state, { kind: "claims" });
  if (kind === "resolution") slot = source(state, { kind: "resolution", resolutionId: id });
  if (kind === "assessment") {
    const claims = assessmentMappings(state, id);
    if (claims.length > 1) return conflict();
    claimId = claims[0];
    slot = claimId ? source(state, { kind: "assessment", claimId, assessmentId: id })
      : Object.values(state.sources).find(candidate => candidate.request.kind === "assessment" && candidate.request.assessmentId === id);
  }
  if (kind === "noteRevision") {
    const mappings = candidatesFor(state, "NOTE_REVISION", id) as Extract<EvidenceCandidate, { targetType: "NOTE_REVISION" }>[];
    revision = mappings[0];
    if (!revision) return unresolved();
    if (mappings.some(mapping => !sameFields(mapping, revision!, ["noteId", "materialBindingId", "revisionNo"]))) return conflict();
    slot = source(state, { kind: "revision", bindingId: revision.materialBindingId, revisionId: id });
  }
  if (slot?.pending) return { ...base, status: "loading" };
  if (slot?.status === "unavailable") return { ...base, status: "unavailable" };
  if (slot?.error) return { ...base, status: "error", error: { ...slot.error } };
  if (!slot?.data) return unresolved();
  if (kind === "claim") return (slot.data as DossierResponses["claims"]).claims.some(row => row.id === id)
    ? { ...base, status: "resolved", id } : unresolved();
  if (kind === "assessment") return claimId
    ? { ...base, status: "resolved", id, claimId } : unresolved();
  if (kind === "noteRevision" && revision) {
    if ((slot.data as DossierResponses["revision"]).revision.revisionNo !== revision.revisionNo) return conflict();
    return { ...base, status: "resolved", id, revisionNo: revision.revisionNo, href: `/research/projects/${encodeURIComponent(state.scope.projectId)}?item=${encodeURIComponent(revision.materialBindingId)}` };
  }
  return { ...base, status: "resolved", id };
}

function projectRunDetail(state: DossierState, data: ResearchRunDetailResponse) {
  const row = data.run;
  const refs: DossierProducedReference[] = [];
  if (row.output) {
    for (const [kind, ids] of [
      ["claim", row.output.produced.claimIds], ["assessment", row.output.produced.assessmentIds],
      ["resolution", row.output.produced.resolutionIds], ["noteRevision", row.output.produced.noteRevisionIds],
    ] as const) ids.forEach((id, index) => refs.push(producedReference(state, kind, index + 1, id)));
  }
  return {
    run: {
      runId: row.runId, projectId: row.projectId, issueId: row.issueId, status: row.status,
      evidenceManifestId: row.evidenceManifestId, replayOf: row.replayOf,
      procedure: { version: row.procedure.version, objective: row.procedure.objective, method: row.procedure.method, steps: row.procedure.steps.map(step => ({ kind: step.kind, description: step.description })) },
      executionContract: { version: row.executionContract.version, mode: row.executionContract.mode, reproducibilityLevel: row.executionContract.reproducibilityLevel, tools: row.executionContract.tools.map(tool => ({ name: tool.name, version: tool.version })) },
      environment: structuredClone(row.environment), knowledgeCutoff: row.knowledgeCutoff,
      output: row.output ? { version: row.output.version, summary: row.output.summary, gaps: row.output.gaps.map(gap => ({ description: gap.description, status: gap.status })) } : null,
      startedAt: row.startedAt, completedAt: row.completedAt, createdAt: row.createdAt,
    },
    evidenceManifest: snapshot(data.evidenceManifest), ancestors: data.ancestors.map(runSummary), producedReferences: refs,
  };
}

export type DossierEvidence =
  | { origin: "assessment"; surface: "summary"; recordId: string; manifest: AssessmentManifestSummary }
  | { origin: "assessment"; surface: "detail"; recordId: string; manifest: AssessmentDetailResponse["evidenceManifest"] }
  | { origin: "resolution"; surface: "summary"; recordId: string; manifest: AssessmentManifestSummary | null }
  | { origin: "resolution"; surface: "detail"; recordId: string; manifest: AssessmentDetailResponse["evidenceManifest"] | null }
  | { origin: "run"; surface: "summary" | "ancestor"; recordId: string; manifest: ResearchRunEvidenceCompactSummary }
  | { origin: "run"; surface: "detail"; recordId: string; manifest: ResearchRunEvidenceSnapshot };

function evidenceReferences(state: DossierState, evidence: DossierEvidence[]) {
  return evidence.flatMap(group => {
    if (group.origin === "run" || group.surface !== "detail" || !group.manifest) return [];
    return group.manifest.items.map(item => {
      const mappings = candidatesFor(state, item.targetType, item.targetId);
      const mapping = mappings[0];
      const uniqueBinding = mapping && mappings.every(candidate => candidate.materialBindingId === mapping.materialBindingId);
      const revision = item.targetType === "NOTE_REVISION" ? producedReference(state, "noteRevision", 1, item.targetId) : null;
      const href = uniqueBinding && (revision === null || revision.status === "resolved")
        ? `/research/projects/${encodeURIComponent(state.scope.projectId)}?item=${encodeURIComponent(mapping.materialBindingId)}` : undefined;
      return {
        origin: group.origin, recordId: group.recordId, targetType: item.targetType, targetId: item.targetId,
        manifestId: group.manifest!.id, manifestSha256: group.manifest!.manifestSha256,
        ...(href ? { materialTitle: mapping!.materialTitle, href } : {}),
      };
    });
  });
}

/** D01-A deliberately has no merged event array or timestamp comparator. */
export function dossierView(state: DossierState) {
  const resolutions = collection(state, { kind: "resolutions", cursor: null },
    (response(state, { kind: "resolutions", cursor: null })?.resolutions ?? []).map(row => resolutionSummary({ ...row, isCurrent: row.id === state.current.pointer })));
  const runs = collection(state, { kind: "runs", cursor: null }, (response(state, { kind: "runs", cursor: null })?.runs ?? []).map(runSummary));
  const assessments = Object.values(state.sources).filter(slot => slot.request.kind === "assessments").map(slot => ({
    claimId: (slot.request as Extract<DossierRequest, { kind: "assessments" }>).claimId,
    ...collection(state, slot.request, (slot.data as AssessmentHistoryResponse | null)?.assessments.map(assessmentSummary) ?? []),
  }));
  const assessmentDetails = loaded(state, "assessment").map(({ data }) => ({
    claim: { ...data.claim },
    assessment: { id: data.assessment.id, claimId: data.assessment.claimId, stance: data.assessment.stance, confidenceLevel: data.assessment.confidenceLevel, actorId: data.assessment.actorId, numericScore: data.assessment.numericScore, scoreKind: data.assessment.scoreKind, reasoning: data.assessment.reasoning, createdAt: data.assessment.createdAt },
    evidenceManifest: manifestDetail(data.evidenceManifest),
  }));
  const resolutionDetails = loaded(state, "resolution").map(({ slot, data }) => projectResolutionDetail(state, data, slot.readSequence));
  const runDetails = loaded(state, "run").map(({ data }) => projectRunDetail(state, data));
  const evidence: DossierEvidence[] = [];
  for (const history of assessments) for (const row of history.rows) evidence.push({ origin: "assessment", surface: "summary", recordId: row.id, manifest: row.evidenceManifest });
  for (const data of assessmentDetails) evidence.push({ origin: "assessment", surface: "detail", recordId: data.assessment.id, manifest: data.evidenceManifest });
  const conclusionRows = [...resolutions.rows];
  if (state.current.summary && !conclusionRows.some(row => row.id === state.current.summary!.id)) conclusionRows.push(resolutionSummary(state.current.summary));
  for (const row of conclusionRows) evidence.push({ origin: "resolution", surface: "summary", recordId: row.id, manifest: row.evidenceManifest });
  for (const data of resolutionDetails) evidence.push({ origin: "resolution", surface: "detail", recordId: data.resolution.id, manifest: data.evidenceManifest });
  for (const row of runs.rows) evidence.push({ origin: "run", surface: "summary", recordId: row.runId, manifest: row.evidenceManifest });
  for (const data of runDetails) {
    evidence.push({ origin: "run", surface: "detail", recordId: data.run.runId, manifest: data.evidenceManifest });
    for (const row of data.ancestors) evidence.push({ origin: "run", surface: "ancestor", recordId: row.runId, manifest: row.evidenceManifest });
  }
  return {
    readOnly: true as const,
    question: section(state, { kind: "question" }),
    current: currentView(state),
    claims: collection(state, { kind: "claims" }, response(state, { kind: "claims" })?.claims ?? []),
    resolutions, runs,
    evidenceBases: collection(state, { kind: "bases", cursor: null }, response(state, { kind: "bases", cursor: null })?.evidenceBases ?? []),
    assessments, assessmentDetails, resolutionDetails, runDetails, evidence,
    references: evidenceReferences(state, evidence),
    reads: Object.values(state.sources).map((slot, handle) => ({ handle, kind: slot.request.kind, status: slot.status, error: slot.error ? { ...slot.error } : null, readAt: slot.readAt })),
    whatChanged: {
      policy: "D01-A" as const, crossStreamOrder: "UNRESOLVED" as const,
      resolutionEvents: resolutions.rows.map(row => ({ id: `resolution:${row.id}:recorded`, type: "RESOLUTION_RECORDED" as const, resolutionId: row.id, at: row.createdAt })),
      runCards: runs.rows.map(row => ({
        runId: row.runId, replayOf: row.replayOf,
        started: { id: `run:${row.runId}:started`, type: "RUN_STARTED" as const, at: row.startedAt, startedAtMicros: row.startedAtMicros },
        terminated: row.status !== "RUNNING" && row.completedAt !== null
          ? { id: `run:${row.runId}:terminated`, type: "RUN_TERMINATED" as const, status: row.status, at: row.completedAt } : null,
      })),
      coverage: { resolutions: resolutions.coverage, runs: runs.coverage },
    },
  };
}
