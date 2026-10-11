// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { __resetWebAuthStoreForTests, __setWebAuthSnapshotForTests } from "../auth/session";
import { RESEARCH_RUN_ACTION_PENDING_KEY } from "./research-run-action-draft";
import { createDossierReader } from "./dossier-reader";

const P = "11111111-1111-4111-8111-111111111111";
const I = "22222222-2222-4222-8222-222222222222";
const U = "33333333-3333-4333-8333-333333333333";
const T = "2026-10-09T01:02:03.123Z";

afterEach(() => {
  window.sessionStorage.clear();
  __resetWebAuthStoreForTests();
  vi.unstubAllGlobals();
});

describe("Dossier with a pre-existing unconfirmed Run action receipt", () => {
  it("uses only GET readers and never retries, replays or clears the pending command", async () => {
    const pending = JSON.stringify({
      projectId: P, issueId: I, runId: U, action: "CANCEL", requestHash: "a".repeat(64),
      idempotencyKey: "44444444-4444-4444-8444-444444444444", createdAt: T, command: { output: null },
    });
    window.sessionStorage.setItem(RESEARCH_RUN_ACTION_PENDING_KEY, pending);
    __setWebAuthSnapshotForTests({
      status: "authenticated", user: { email: null, name: null }, csrfToken: "test-csrf-in-memory", error: null,
    });

    const methods: string[] = [];
    const paths: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      methods.push(init?.method ?? "GET");
      paths.push(url);
      const issueRoot = "/projects/" + P + "/issues/" + I;
      let body: unknown;
      if (url.endsWith(issueRoot)) {
        body = {
          project: { id: P, name: "田野研究", lifecycleState: "ACTIVE", readOnly: false },
          issue: { id: I, projectId: P, title: "研究问题", question: "何时修建？", lifecycleState: "OPEN", createdAt: T, updatedAt: T },
        };
      } else if (url.endsWith(issueRoot + "/claims")) {
        body = { claims: [] };
      } else if (url.includes(issueRoot + "/resolutions")) {
        body = {
          issue: { id: I, lifecycleState: "OPEN", currentResolutionId: null, updatedAt: T },
          currentResolution: null, resolutions: [], nextCursor: null,
        };
      } else if (url.includes(issueRoot + "/runs")) {
        body = { runs: [], nextCursor: null };
      } else {
        throw new Error("Unexpected Dossier route: " + url);
      }
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
    const reader = createDossierReader({ projectId: P, issueId: I, authGeneration: 1 });
    reader.start();
    await vi.waitFor(() => expect(reader.view().runs.coverage.exhausted).toBe(true));
    expect(paths).toHaveLength(4);
    expect(methods).toEqual(["GET", "GET", "GET", "GET"]);
    expect(paths.every(path => path.includes("/api/private/s32/"))).toBe(true);
    expect(window.sessionStorage.getItem(RESEARCH_RUN_ACTION_PENDING_KEY)).toBe(pending);
    reader.dispose();
  });
});
