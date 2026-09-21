import { describe, expect, it, vi } from "vitest";

vi.mock("../config.js", () => ({ readS32Config: vi.fn(() => ({ enabled: true, databaseUrl: "postgresql://x", privateToken: "t" })) }));
vi.mock("pg", () => {
  const on = vi.fn();
  class MockPool {
    on = on;
    constructor(options: unknown) { void options; }
  }
  return { Pool: MockPool };
});
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
