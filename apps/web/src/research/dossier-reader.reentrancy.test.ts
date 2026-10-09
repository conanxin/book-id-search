import { describe, expect, it } from "vitest";
import { createDossierReader, type DossierFetcher } from "./dossier-reader";
import type { DossierRequest, DossierResponses } from "./dossier-model";

const P = "11111111-1111-4111-8111-111111111111";
const I = "22222222-2222-4222-8222-222222222222";
const T = "2026-10-09T01:02:03.123Z";
type Payload = DossierResponses[keyof DossierResponses];
const scope = { projectId: P, issueId: I, authGeneration: 1 };
const question = (): DossierResponses["question"] => ({
  project: { id: P, name: "审阅", lifecycleState: "ACTIVE", readOnly: false },
  issue: { id: I, projectId: P, title: "审阅问题", question: "是否有竞态？", lifecycleState: "OPEN", createdAt: T, updatedAt: T },
});
interface Call {
  kind: DossierRequest["kind"];
  signal: AbortSignal;
  resolve(data: Payload): void;
}
async function flush() {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

describe("Dossier reader PR review: synchronous subscriber re-entrancy", () => {
  it("still respects the concurrency=1 cap when a subscriber enqueues a read on a loading notification", async () => {
    const calls: Call[] = [];
    let inFlight = 0, maxInFlight = 0;
    const fetcher: DossierFetcher = (_scope, request, signal) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return new Promise<Payload>(resolve => { calls.push({ kind: request.kind, signal, resolve }); })
        .finally(() => { inFlight -= 1; });
    };
    const reader = createDossierReader(scope, fetcher, 1);
    let triggered = false;
    reader.subscribe(view => {
      if (view.runs.coverage.status === "loading" && !triggered) {
        triggered = true;
        void reader.read({ kind: "bases", cursor: null });
      }
    });
    reader.start();
    calls[0].resolve(question());
    await flush();
    expect(calls[1]?.kind).toBe("claims");
    calls[1].resolve({ claims: [] });
    await flush();
    expect(calls[2]?.kind).toBe("resolutions");
    calls[2].resolve({
      issue: { id: I, lifecycleState: "OPEN", currentResolutionId: null, updatedAt: T },
      currentResolution: null, resolutions: [], nextCursor: null,
    });
    await flush();
    expect(triggered).toBe(true);
    expect(calls[3]?.kind).toBe("runs");
    expect(maxInFlight).toBe(1);
    reader.dispose();
    for (const call of calls) if (!call.signal.aborted) call.resolve({ runs: [], nextCursor: null });
  });

  it("does not dispatch an already invalidated read when a subscriber refreshes during its loading notification", async () => {
    const calls: Call[] = [];
    const fetcher: DossierFetcher = (_scope, request, signal) =>
      new Promise<Payload>(resolve => { calls.push({ kind: request.kind, signal, resolve }); });
    const reader = createDossierReader(scope, fetcher, 1);
    let triggered = false;
    reader.subscribe(view => {
      if (view.claims.coverage.status === "loading" && !triggered) {
        triggered = true;
        reader.refresh();
      }
    });
    reader.start();
    calls[0].resolve(question());
    await flush();
    expect(triggered).toBe(true);
    const staleClaims = calls.filter(call => call.kind === "claims");
    expect(staleClaims, "a cancelled synchronous read should not dispatch network traffic").toHaveLength(0);
    expect(calls.filter(call => call.kind === "question")).toHaveLength(2);
    reader.dispose();
  });
});
