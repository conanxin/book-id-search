import express from "express";
import type { AddressInfo } from "node:net";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../config.js", () => ({ readS32Config: vi.fn(() => ({ enabled: true, databaseUrl: "postgresql://x", privateToken: "t" })) }));
vi.mock("pg", () => {
  const on = vi.fn();
  return { Pool: vi.fn(function MockPool() { return { on }; }) };
});
vi.mock("../postgres/issue-resolution-command-store.js", () => ({ createPostgresIssueResolutionCommandStore: vi.fn(() => ({ marker: "resolution-command" })) }));
vi.mock("../postgres/issue-resolution-read-store.js", () => ({ createPostgresIssueResolutionReadStore: vi.fn(() => ({ marker: "resolution-read" })) }));
vi.mock("../application/issue-resolutions.js", () => ({ createIssueResolutionsService: vi.fn(() => ({ marker: "resolution-service" })) }));
const { createIssueResolutionRouter } = vi.hoisted(() => ({
  createIssueResolutionRouter: vi.fn(() => (req: express.Request, res: express.Response, next: () => void) => {
    if (/\/resolutions?(\/|$)|\/resolution-evidence-bases(\/|$)/.test(req.path)) { res.json({ route: "resolution" }); return; }
    next();
  }),
}));
vi.mock("./issue-resolution-routes.js", () => ({ createIssueResolutionRouter }));
vi.mock("../postgres/evidence-selection-store.js", () => ({ createPostgresEvidenceSelectionStore: vi.fn(() => ({ marker: "evidence-store" })) }));
vi.mock("../postgres/assessment-command-store.js", () => ({ createPostgresAssessmentCommandStore: vi.fn(() => ({ marker: "assessment-command-store" })) }));
vi.mock("../postgres/assessment-read-store.js", () => ({ createPostgresAssessmentReadStore: vi.fn(() => ({ marker: "assessment-read-store" })) }));
vi.mock("../postgres/candidate-claim-store.js", () => ({ createPostgresCandidateClaimStore: vi.fn(() => ({ marker: "claim-store" })) }));
vi.mock("../application/evidence-selection.js", async (load) => {
  const actual = await load<typeof import("../application/evidence-selection.js")>();
  return { ...actual, createEvidenceSelectionService: vi.fn(() => ({ marker: "evidence-service" })) };
});
vi.mock("../application/assessments.js", async (load) => {
  const actual = await load<typeof import("../application/assessments.js")>();
  return { ...actual, createAssessmentsService: vi.fn(() => ({ marker: "assessment-service" })) };
});
vi.mock("../application/candidate-claims.js", async (load) => {
  const actual = await load<typeof import("../application/candidate-claims.js")>();
  return { ...actual, createCandidateClaimsService: vi.fn(() => ({ marker: "claim-service" })) };
});
vi.mock("./evidence-selection-routes.js", () => ({ createEvidenceSelectionRouter: vi.fn(() => (req: unknown, res: unknown, next: () => void) => next()) }));
vi.mock("./assessment-routes.js", () => ({ createAssessmentRouter: vi.fn(() => (req: unknown, res: unknown, next: () => void) => next()) }));
vi.mock("./candidate-claim-routes.js", () => ({ createCandidateClaimRouter: vi.fn(() => (req: unknown, res: unknown, next: () => void) => next()) }));
vi.mock("./project-routes.js", () => ({ createProjectRouter: vi.fn(() => (req: unknown, res: unknown, next: () => void) => next()) }));
vi.mock("./research-issue-routes.js", () => ({ createResearchIssueRouter: vi.fn(() => (req: unknown, res: unknown, next: () => void) => next()) }));
vi.mock("./project-item-routes.js", () => ({ createProjectItemRouter: vi.fn(() => (req: unknown, res: unknown, next: () => void) => next()) }));
vi.mock("./project-item-note-routes.js", () => ({ createProjectItemNoteRouter: vi.fn(() => (req: unknown, res: unknown, next: () => void) => next()) }));
vi.mock("./project-overview-route.js", () => ({ createProjectOverviewRouter: vi.fn(() => (req: unknown, res: unknown, next: () => void) => next()) }));
vi.mock("./research-membership-route.js", () => ({ createResearchMembershipRouter: vi.fn(() => (req: unknown, res: unknown, next: () => void) => next()) }));
vi.mock("./catalog-promotion-route.js", () => ({ createCatalogPromotionHandler: vi.fn(() => (req: unknown, res: unknown, next: () => void) => next()) }));
vi.mock("../application/projects.js", () => ({ createProjectsService: vi.fn(() => ({})) }));
vi.mock("../postgres/project-store.js", () => ({ createPostgresProjectStore: vi.fn(() => ({})) }));
vi.mock("../application/project-item-notes.js", () => ({ createProjectItemNotesService: vi.fn(() => ({})) }));
vi.mock("../postgres/project-item-note-store.js", () => ({ createPostgresProjectItemNoteStore: vi.fn(() => ({})) }));
vi.mock("../application/research-memberships.js", () => ({ createResearchMembershipService: vi.fn(() => ({})) }));
vi.mock("../postgres/research-membership-store.js", () => ({ createPostgresResearchMembershipStore: vi.fn(() => ({})) }));
vi.mock("../application/project-overview.js", () => ({ createProjectOverviewService: vi.fn(() => ({})) }));
vi.mock("../postgres/project-overview-store.js", () => ({ createPostgresProjectOverviewStore: vi.fn(() => ({})) }));
vi.mock("../application/research-issues.js", () => ({ createResearchIssuesService: vi.fn(() => ({})) }));
vi.mock("../postgres/research-run-command-store.js", () => ({ createPostgresResearchRunCommandStore: vi.fn(() => ({ marker: "run-command-store" })) }));
vi.mock("../postgres/research-run-read-store.js", () => ({ createPostgresResearchRunReadStore: vi.fn(() => ({ marker: "run-read-store" })) }));
vi.mock("../application/research-runs.js", async (load) => {
  const actual = await load<typeof import("../application/research-runs.js")>();
  return { ...actual, createResearchRunsService: vi.fn(() => ({ marker: "run-service" })) };
});
const { createResearchRunRouter } = vi.hoisted(() => ({
  createResearchRunRouter: vi.fn(() => (_req: express.Request, res: express.Response) => res.json({ route: "research-run" })),
}));
vi.mock("./research-run-routes.js", () => ({ createResearchRunRouter }));
vi.mock("../postgres/research-issue-store.js", () => ({ createPostgresResearchIssueStore: vi.fn(() => ({})) }));
vi.mock("../application/promote-catalog-book.js", () => ({ createPromoteCatalogBookCommand: vi.fn(() => ({})) }));
vi.mock("../catalog/meili-catalog-book-reader.js", () => ({ createMeiliCatalogBookReader: vi.fn(() => ({})) }));
vi.mock("../postgres/catalog-promotion-store.js", () => ({ createPostgresCatalogPromotionStore: vi.fn(() => ({})) }));
vi.mock("../postgres/project-binding-store.js", () => ({ createPostgresProjectBindingStore: vi.fn(() => ({})) }));
vi.mock("../application/project-items.js", () => ({ createProjectItemsService: vi.fn(() => ({})) }));

import { createS32Router } from "../register.js";
import { createPostgresEvidenceSelectionStore } from "../postgres/evidence-selection-store.js";
import { createPostgresAssessmentCommandStore } from "../postgres/assessment-command-store.js";
import { createPostgresAssessmentReadStore } from "../postgres/assessment-read-store.js";
import { createPostgresCandidateClaimStore } from "../postgres/candidate-claim-store.js";
import { Pool } from "pg";
import { createEvidenceSelectionRouter } from "./evidence-selection-routes.js";
import { createAssessmentRouter } from "./assessment-routes.js";

describe("register wiring", () => {
  it("constructs evidence selection store and candidate claim store from the same Pool instance", () => {
    createS32Router({ env: {}, getCatalogDocument: vi.fn() });
    const pools = (Pool as unknown as { mock?: unknown });
    void pools;
    const evidenceArg = vi.mocked(createPostgresEvidenceSelectionStore).mock.calls[0]?.[0];
    const claimArg = vi.mocked(createPostgresCandidateClaimStore).mock.calls[0]?.[0];
    expect(evidenceArg).toBeDefined();
    expect(claimArg).toBeDefined();
    expect(evidenceArg).toBe(claimArg);
  });

  it("mounts evidence selection router", () => {
    createS32Router({ env: {}, getCatalogDocument: vi.fn() });
    expect(createEvidenceSelectionRouter).toHaveBeenCalled();
  });

  it("constructs assessment command/read stores from the same Pool and mounts the assessment router", () => {
    createS32Router({ env: {}, getCatalogDocument: vi.fn() });
    const evidenceArg = vi.mocked(createPostgresEvidenceSelectionStore).mock.calls.at(-1)?.[0];
    const commandArg = vi.mocked(createPostgresAssessmentCommandStore).mock.calls.at(-1)?.[0];
    const readArg = vi.mocked(createPostgresAssessmentReadStore).mock.calls.at(-1)?.[0];
    expect(commandArg).toBe(evidenceArg);
    expect(readArg).toBe(evidenceArg);
    expect(createAssessmentRouter).toHaveBeenCalled();
  });
});

import { readS32Config } from "../config.js";
import { createPostgresIssueResolutionCommandStore } from "../postgres/issue-resolution-command-store.js";
import { createPostgresIssueResolutionReadStore } from "../postgres/issue-resolution-read-store.js";
import { createIssueResolutionsService } from "../application/issue-resolutions.js";
import { createProjectRouter } from "./project-routes.js";
import { createPostgresResearchRunCommandStore } from "../postgres/research-run-command-store.js";
import { createPostgresResearchRunReadStore } from "../postgres/research-run-read-store.js";
import { createResearchRunsService } from "../application/research-runs.js";

beforeEach(() => { vi.clearAllMocks(); });

describe("Issue Resolution registration", () => {
  it("constructs command/read stores with the one shared Pool and passes their exact instances to service/router", () => {
    createS32Router({ env: {}, getCatalogDocument: vi.fn() });
    expect(Pool).toHaveBeenCalledOnce();
    expect(createPostgresIssueResolutionCommandStore).toHaveBeenCalledOnce();
    expect(createPostgresIssueResolutionReadStore).toHaveBeenCalledOnce();
    const pool = vi.mocked(createPostgresEvidenceSelectionStore).mock.calls[0][0];
    expect(createPostgresIssueResolutionCommandStore).toHaveBeenCalledWith(pool);
    expect(createPostgresIssueResolutionReadStore).toHaveBeenCalledWith(pool);
    expect(createPostgresAssessmentCommandStore).toHaveBeenCalledWith(pool);
    expect(createPostgresAssessmentReadStore).toHaveBeenCalledWith(pool);
    expect(createPostgresCandidateClaimStore).toHaveBeenCalledWith(pool);
    const command = vi.mocked(createPostgresIssueResolutionCommandStore).mock.results[0].value;
    const read = vi.mocked(createPostgresIssueResolutionReadStore).mock.results[0].value;
    expect(createIssueResolutionsService).toHaveBeenCalledExactlyOnceWith(command, read);
    expect(createIssueResolutionRouter).toHaveBeenCalledExactlyOnceWith(
      vi.mocked(readS32Config).mock.results[0].value,
      vi.mocked(createIssueResolutionsService).mock.results[0].value,
      undefined,
    );
  });

  it.each([
    { name: "disabled", enabled: false, databaseUrl: "postgresql://x" },
    { name: "no database", enabled: true, databaseUrl: null },
  ])("$name still mounts the router with null service without constructing a Pool", options => {
    const config = { enabled: options.enabled, databaseUrl: options.databaseUrl, privateToken: "t" };
    vi.mocked(readS32Config).mockReturnValueOnce(config);
    createS32Router({ env: {}, getCatalogDocument: vi.fn() });
    expect(createIssueResolutionRouter).toHaveBeenCalledExactlyOnceWith(config, null, undefined);
    expect(Pool).not.toHaveBeenCalled();
    expect(createPostgresIssueResolutionCommandStore).not.toHaveBeenCalled();
    expect(createPostgresIssueResolutionReadStore).not.toHaveBeenCalled();
    expect(createIssueResolutionsService).not.toHaveBeenCalled();
  });

  it.each([
    { method: "POST", suffix: "resolutions" },
    { method: "GET", suffix: "resolutions" },
    { method: "GET", suffix: "resolutions/resolution-id" },
    { method: "GET", suffix: "resolution-evidence-bases" },
  ])("mounts $method $suffix before generic project routes", async ({ method, suffix }) => {
    const generic = express.Router();
    generic.use((_req, res) => { res.status(418).json({ route: "generic" }); });
    vi.mocked(createProjectRouter).mockReturnValueOnce(generic);
    const app = express();
    app.use("/api/private/s32", createS32Router({ env: {}, getCatalogDocument: vi.fn() }));
    const server = app.listen(0, "127.0.0.1");
    try {
      await new Promise<void>(resolve => server.once("listening", resolve));
      const port = (server.address() as AddressInfo).port;
      const res = await fetch(`http://127.0.0.1:${port}/api/private/s32/projects/project-id/issues/issue-id/${suffix}`, { method });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ route: "resolution" });
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});


describe("ResearchRun registration", () => {
  it("constructs command/read stores with the one shared Pool and passes their exact instances to service/router", () => {
    createS32Router({ env: {}, getCatalogDocument: vi.fn() });
    expect(Pool).toHaveBeenCalledOnce();
    expect(createPostgresResearchRunCommandStore).toHaveBeenCalledOnce();
    expect(createPostgresResearchRunReadStore).toHaveBeenCalledOnce();
    const pool = vi.mocked(createPostgresEvidenceSelectionStore).mock.calls[0][0];
    expect(createPostgresResearchRunCommandStore).toHaveBeenCalledWith(pool);
    expect(createPostgresResearchRunReadStore).toHaveBeenCalledWith(pool);
    const command = vi.mocked(createPostgresResearchRunCommandStore).mock.results[0].value;
    const read = vi.mocked(createPostgresResearchRunReadStore).mock.results[0].value;
    expect(createResearchRunsService).toHaveBeenCalledExactlyOnceWith(command, read);
    expect(createResearchRunRouter).toHaveBeenCalledExactlyOnceWith(
      vi.mocked(readS32Config).mock.results[0].value,
      vi.mocked(createResearchRunsService).mock.results[0].value,
      undefined,
    );
  });

  it.each([
    { name: "disabled", enabled: false, databaseUrl: "postgresql://x" },
    { name: "no database", enabled: true, databaseUrl: null },
  ])("$name still mounts the router with null service without constructing a Pool", options => {
    const config = { enabled: options.enabled, databaseUrl: options.databaseUrl, privateToken: "t" };
    vi.mocked(readS32Config).mockReturnValueOnce(config);
    createS32Router({ env: {}, getCatalogDocument: vi.fn() });
    expect(createResearchRunRouter).toHaveBeenCalledExactlyOnceWith(config, null, undefined);
    expect(Pool).not.toHaveBeenCalled();
    expect(createPostgresResearchRunCommandStore).not.toHaveBeenCalled();
    expect(createPostgresResearchRunReadStore).not.toHaveBeenCalled();
    expect(createResearchRunsService).not.toHaveBeenCalled();
  });

  it.each([
    { method: "POST", suffix: "runs" },
    { method: "GET", suffix: "runs" },
    { method: "GET", suffix: "runs/run-id" },
    { method: "POST", suffix: "runs/run-id/complete" },
    { method: "POST", suffix: "runs/run-id/fail" },
    { method: "POST", suffix: "runs/run-id/cancel" },
    { method: "POST", suffix: "runs/run-id/replay" },
  ])("mounts $method $suffix before generic project routes", async ({ method, suffix }) => {
    const generic = express.Router();
    generic.use((_req, res) => { res.status(418).json({ route: "generic" }); });
    vi.mocked(createProjectRouter).mockReturnValueOnce(generic);
    const app = express();
    app.use("/api/private/s32", createS32Router({ env: {}, getCatalogDocument: vi.fn() }));
    const server = app.listen(0, "127.0.0.1");
    try {
      await new Promise<void>(resolve => server.once("listening", resolve));
      const port = (server.address() as AddressInfo).port;
      const res = await fetch(`http://127.0.0.1:${port}/api/private/s32/projects/project-id/issues/issue-id/${suffix}`, { method });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ route: "research-run" });
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});
