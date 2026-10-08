import {
  getResearchIssue, listCandidateClaims, listIssueResolutions, getIssueResolution,
  listIssueResolutionEvidenceBases, listAssessments, getAssessment, listResearchRuns,
  getResearchRun, listEvidenceCandidates, getProjectItemNoteRevision, ProjectApiError,
} from "./api";
import {
  createDossier, resetDossier, startDossierRead, receiveDossierRead, failDossierRead,
  dossierView, type DossierRequest, type DossierResponses, type DossierScope,
} from "./dossier-model";

/** Only GET readers belong here. Never import Run command/receipt components. */
export type DossierView = ReturnType<typeof dossierView>;
export type DossierFetcher = (
  scope: DossierScope, request: DossierRequest, signal: AbortSignal,
) => Promise<DossierResponses[keyof DossierResponses]>;

export async function readDossierFromApi(
  scope: DossierScope, request: DossierRequest, signal: AbortSignal,
): Promise<DossierResponses[keyof DossierResponses]> {
  const p = scope.projectId;
  const i = scope.issueId;
  switch (request.kind) {
    case "question": return getResearchIssue(p, i, signal);
    case "claims": return listCandidateClaims(p, i, signal);
    case "resolutions": return listIssueResolutions(p, i, { limit: 20, cursor: request.cursor }, signal);
    case "resolution": return getIssueResolution(p, i, request.resolutionId, signal);
    case "runs": return listResearchRuns(p, i, { limit: 20, cursor: request.cursor }, signal);
    case "run": return getResearchRun(p, i, request.runId, signal);
    case "bases": return listIssueResolutionEvidenceBases(p, i, { limit: 20, cursor: request.cursor }, signal);
    case "assessments": return listAssessments(p, i, request.claimId, { limit: 20, cursor: request.cursor }, signal);
    case "assessment": return getAssessment(p, i, request.claimId, request.assessmentId, signal);
    case "candidates": return listEvidenceCandidates(p, i, request.claimId, signal);
    case "revision": return getProjectItemNoteRevision(p, request.bindingId, request.revisionId, signal);
  }
}

type Listener = (view: DossierView) => void;
interface ReadJob {
  request: DossierRequest;
  key: string;
  stream: string;
  epoch: number;
  resolve: (success: boolean) => void;
}
interface ActiveRead {
  controller: AbortController;
  job: ReadJob;
}
export interface DossierReader {
  view(): DossierView;
  subscribe(listener: Listener): () => void;
  start(): void;
  read(request: DossierRequest): Promise<boolean>;
  refresh(): void;
  changeScope(scope: DossierScope): void;
  dispose(): void;
}

const DEFAULT_MAX_CONCURRENCY = 4;
function jobKey(request: DossierRequest): string { return JSON.stringify(request); }
function streamKey(request: DossierRequest): string {
  switch (request.kind) {
    case "assessments": return JSON.stringify(["assessments", request.claimId]);
    case "assessment": return JSON.stringify(["assessment", request.claimId, request.assessmentId]);
    case "candidates": return JSON.stringify(["candidates", request.claimId]);
    case "resolution": return JSON.stringify(["resolution", request.resolutionId]);
    case "run": return JSON.stringify(["run", request.runId]);
    case "revision": return JSON.stringify(["revision", request.bindingId, request.revisionId]);
    default: return request.kind;
  }
}

/**
 * A scoped, bounded, cancellable read-only adapter over the pure Dossier model.
 * All subscribed values come exclusively from dossierView, never internal state.
 */
export function createDossierReader(
  scope: DossierScope, fetcher: DossierFetcher = readDossierFromApi, concurrency = DEFAULT_MAX_CONCURRENCY,
): DossierReader {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) {
    throw new Error("Dossier concurrency must be an integer from 1 to 4.");
  }
  let model = createDossier(scope);
  let projection = dossierView(model);
  let epoch = 0;
  let booted = false;
  let closed = false;
  const listeners = new Set<Listener>();
  const pending: ReadJob[] = [];
  const active = new Map<string, ActiveRead>();
  const activeStreams = new Set<string>();
  const busyKeys = new Set<string>();

  function publish(): void {
    if (closed) return;
    projection = dossierView(model);
    for (const listener of listeners) listener(projection);
  }
  function cancelOutstanding(): void {
    epoch += 1;
    for (const item of pending.splice(0)) item.resolve(false);
    for (const item of active.values()) {
      item.controller.abort();
      item.job.resolve(false);
    }
    active.clear();
    activeStreams.clear();
    busyKeys.clear();
  }
  function pump(): void {
    if (closed) return;
    while (active.size < concurrency) {
      const index = pending.findIndex(job => !activeStreams.has(job.stream));
      if (index === -1) return;
      const job = pending.splice(index, 1)[0];
      if (job.epoch !== epoch) {
        busyKeys.delete(job.key);
        job.resolve(false);
        continue;
      }
      const started = startDossierRead(model, job.request);
      if (!started.ticket) {
        busyKeys.delete(job.key);
        job.resolve(false);
        continue;
      }
      model = started.state;
      publish();
      const controller = new AbortController();
      active.set(job.key, { controller, job });
      activeStreams.add(job.stream);
      const ticket = started.ticket;
      const requestEpoch = epoch;
      void fetcher({ ...model.scope }, job.request, controller.signal)
        .then(value => {
          if (closed || controller.signal.aborted || requestEpoch !== epoch) return false;
          model = receiveDossierRead(model, ticket, value, new Date().toISOString());
          publish();
          const outcome = dossierView(model);
          // The model can reject an inconsistent success as a 502 without throwing.
          if (job.request.kind === "question") return outcome.question.status === "ready";
          const matchingRead = outcome.reads.some(read => read.kind === job.request.kind && read.status !== "error" && read.status !== "unavailable");
          return matchingRead;
        })
        .catch(error => {
          if (closed || controller.signal.aborted || requestEpoch !== epoch) return false;
          const status = error instanceof ProjectApiError ? error.status : null;
          model = failDossierRead(model, ticket, status);
          if (status === 401 || status === 403) {
            // Invalidate all peer requests immediately after authentication loss.
            cancelOutstanding();
          }
          publish();
          return false;
        })
        .then(ok => job.resolve(ok))
        .finally(() => {
          if (closed || requestEpoch !== epoch) return;
          active.delete(job.key);
          activeStreams.delete(job.stream);
          busyKeys.delete(job.key);
          pump();
        });
    }
  }
  function read(request: DossierRequest): Promise<boolean> {
    if (closed) return Promise.resolve(false);
    const key = jobKey(request);
    if (busyKeys.has(key)) return Promise.resolve(false);
    // Never enqueue dependent reads before the authoritative Issue scope is ready.
    if (request.kind !== "question" && projection.question.status !== "ready") return Promise.resolve(false);
    busyKeys.add(key);
    return new Promise(resolve => {
      pending.push({ request, key, stream: streamKey(request), epoch, resolve });
      pump();
    });
  }
  function start(): void {
    if (closed || booted) return;
    booted = true;
    const bootEpoch = epoch;
    void read({ kind: "question" }).then(ok => {
      if (!ok || closed || bootEpoch !== epoch) return;
      // Exactly four initial domain reads: scope, then three independent sections.
      void read({ kind: "claims" });
      void read({ kind: "resolutions", cursor: null });
      void read({ kind: "runs", cursor: null });
    });
  }
  function changeScope(next: DossierScope): void {
    if (closed) return;
    cancelOutstanding();
    model = resetDossier(model, next);
    booted = false;
    publish();
    start();
  }
  function refresh(): void {
    if (closed) return;
    cancelOutstanding();
    model = resetDossier(model);
    booted = false;
    publish();
    start();
  }
  return {
    view: () => projection,
    subscribe: listener => {
      if (!closed) listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start, read, refresh, changeScope,
    dispose: () => {
      if (closed) return;
      cancelOutstanding();
      closed = true;
      listeners.clear();
      // Release any retained Issue data as soon as the reader is disposed.
      model = resetDossier(model);
      projection = dossierView(model);
    },
  };
}
