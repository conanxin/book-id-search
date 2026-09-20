# S32-M1C Project Binding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user add one searched catalog book to one existing research project, see the canonical Edition in that project, safely repeat the action without duplication, and remove only the ProjectBinding.

**Architecture:** Keep Meilisearch as discovery and PostgreSQL as canonical truth. The browser sends only `projectId + bookId`; the API composes the existing M1-A promotion command with a new idempotent ProjectBinding store. Promotion and binding remain separate transaction boundaries so a binding failure after successful promotion is retry-safe. Project pages read canonical Work/Edition fields through `project_bindings`.

**Tech Stack:** Node.js 22+, TypeScript, Express 5, PostgreSQL 16, pg, React 19, React Router, Vite, Vitest, Docker/Compose for local disposable PG.

**Spec:** `docs/superpowers/specs/2026-09-20-s32-m1c-project-binding-design.md`

## Global Constraints

- Baseline is `main@7295af6e991e2a5b1575b8c2a0b5d3662c093b9f` after merged PR #11.
- Do not modify `db/migrations/001_s32_core_schema.sql` or the two frozen M0 SQL verification files.
- Do not add tables, columns, indexes, triggers, ORM dependencies, account/RBAC systems, or new UI frameworks.
- Bind project research material as `target_type='EDITION'`; do not add Work/Edition choice UI.
- Keep M1-A promotion semantics intact: authoritative catalog re-read, explicit promotion, no fuzzy merge, no author canonicalization.
- Keep S32 private traffic same-origin under `/api/private/s32`; do not add cross-origin `VITE_API_BASE_URL` support for S32.
- Keep `S32_FEATURES_ENABLED=false` as the default and reuse the independent S32 private token.
- Never place tokens, DB URLs, passwords, or production values in tracked source or `VITE_*`.
- Local development may write only a few explicitly selected catalog books into the existing local S32 PG volume.
- Automated integration uses a separate disposable PostgreSQL 16 database and must not touch the local trial volume.
- No production deployment, capacity cleanup, disk expansion, image publication, M1-D, or M1-E in this plan.
- Removing a project item deletes only `core.project_bindings`; canonical Work/Edition/Source/ExternalIdentity rows must remain.

## Review Focus

1. **Concurrent duplicate add:** two simultaneous requests for the same project + Edition must produce one binding and both callers must receive a valid result.
2. **Binding failure after successful promotion:** retry must reuse the existing canonical chain and then create the missing binding without duplicate canonical rows.
3. **Forged or stale identifiers:** a binding ID belonging to another project, an archived project, or a missing/inactive Edition must fail closed and never mutate unrelated rows.
4. **Malformed legacy binding metadata:** project item reads must still return canonical Edition data; missing/non-string catalog metadata must become null rather than crashing or fabricating links.
5. **Credential/UI state transitions:** no token, wrong token, cleared token, empty project list, request abort, and failed POST/DELETE must not leak secrets or leave a false “added”/“removed” state.

---

## File Structure

### Backend

- Create `apps/api/src/s32/domain/project-item.ts`  
  Defines `ProjectResearchItem`, input validators for book/binding IDs, and application errors local to project-item behavior.

- Create `apps/api/src/s32/application/project-items.ts`  
  Defines `ProjectBindingStore`, `createProjectItemsService()`, and the orchestration contract that composes Project lookup + existing M1-A promotion + binding.

- Create `apps/api/src/s32/postgres/project-binding-store.ts`  
  Owns PostgreSQL reads/writes for Edition bindings: project/edition validation, idempotent insert, list projection, and delete.

- Create `apps/api/src/s32/routes/project-item-routes.ts`  
  Owns private HTTP routes and maps application/domain errors to fixed HTTP responses.

- Modify `apps/api/src/s32/register.ts`  
  Reuses the existing Pool and M1-A promotion command; wires the project-item service/router.

- Tests next to each backend file, plus one real-PG integration test:
  - `apps/api/src/s32/domain/project-item.test.ts`
  - `apps/api/src/s32/application/project-items.test.ts`
  - `apps/api/src/s32/postgres/project-binding-store.test.ts`
  - `apps/api/src/s32/routes/project-item-routes.test.ts`
  - `apps/api/src/s32/postgres/project-binding-store.integration.test.ts`
  - `scripts/s32-m1c-integration-check.ts`

### Frontend

- Modify `apps/web/src/research/api.ts`  
  Adds typed private M1-C add/list/remove clients while preserving same-origin S32 requests.

- Create `apps/web/src/research/AddToProject.tsx`  
  Renders “加入研究”, project selector, no-token/empty-project states, and success/error state.

- Create `apps/web/src/research/ProjectItems.tsx`  
  Renders canonical project materials and removes bindings with confirmation.

- Modify `apps/web/src/research/ProjectsPage.tsx`  
  Loads `ProjectItems` on project detail only.

- Modify `apps/web/src/App.tsx`  
  Passes S32 research action into BookCard without moving domain orchestration into App.

- Extend `apps/web/src/research/research.test.tsx` and add focused component tests if the file becomes unwieldy.

### Local verification/docs

- Modify root `package.json` to add `s32:m1c:check`.
- Modify `AGENTS.md` only to advance the authorized local stage from M1-B to M1-C; keep production-write restrictions.
- Modify `docs/operations/S32_M1B_LOCAL.md` only if shared local PG startup instructions need a neutral M1-B/M1-C wording; otherwise leave it alone.
- Create `docs/operations/S32_M1C_LOCAL.md` for reproducible local acceptance.
- Modify `docs/STATUS.md` only after verified checkpoints.

---

### Task 1: Define the M1-C domain and service contracts

**Files:**
- Create: `apps/api/src/s32/domain/project-item.ts`
- Create: `apps/api/src/s32/domain/project-item.test.ts`
- Create: `apps/api/src/s32/application/project-items.ts`
- Create: `apps/api/src/s32/application/project-items.test.ts`

**Interfaces:**
- Consumes:
  - `ProjectsService.get(id: unknown): Promise<Project | null>`
  - existing M1-A `CatalogPromotionCommand.execute({ bookId }): Promise<PromotionResult>`
- Produces:
  - `ProjectResearchItem`
  - `ProjectBindingStore`
  - `createProjectItemsService(deps)`
  - errors: `ProjectNotFoundError`, `ProjectNotActiveError`, `EditionNotAvailableError`, `ProjectBindingStoreUnavailableError`, `ProjectBindingNotFoundError`

- [ ] **Step 1: Write failing domain validation tests**

Create `project-item.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { readBindingId, readCatalogBookId } from "./project-item.js";

describe("M1-C identifiers", () => {
  it("trims a non-empty catalog book id", () => {
    expect(readCatalogBookId(" 13000000 ")).toBe("13000000");
  });

  it.each([undefined, null, "", "   ", 42, []])("rejects invalid catalog book id %j", (value) => {
    expect(() => readCatalogBookId(value)).toThrow("bookId");
  });

  it("accepts UUID binding ids and rejects forged ids", () => {
    expect(readBindingId("01234567-1234-4123-8123-123456789abc"))
      .toBe("01234567-1234-4123-8123-123456789abc");
    expect(() => readBindingId("x' OR 1=1")).toThrow("binding");
  });
});
```

- [ ] **Step 2: Run the domain test and verify RED**

Run:

```bash
corepack pnpm exec vitest run --maxWorkers=1 apps/api/src/s32/domain/project-item.test.ts
```

Expected: FAIL because `project-item.ts` does not exist.

- [ ] **Step 3: Add the minimal domain types and validators**

Create `project-item.ts`:

```ts
export interface ProjectResearchItem {
  bindingId: string;
  projectId: string;
  workId: string;
  editionId: string;
  sourceId: string | null;
  catalogBookId: string | null;
  title: string;
  publisher: string | null;
  publicationDate: string | null;
  publicationDatePrecision: "YEAR" | "MONTH" | "DAY";
  isbn: string | null;
  addedAt: string;
}

export class InvalidProjectItemInputError extends Error {}

const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

export function readCatalogBookId(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new InvalidProjectItemInputError("bookId is required.");
  }
  return value.trim();
}

export function readBindingId(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new InvalidProjectItemInputError("bindingId is invalid.");
  }
  return value;
}
```

- [ ] **Step 4: Run domain tests and verify GREEN**

Run the command from Step 2.

Expected: PASS.

- [ ] **Step 5: Write failing application orchestration tests**

Create `project-items.test.ts` with in-memory fakes. Pin these behaviors:

```ts
import { describe, expect, it, vi } from "vitest";
import { createProjectItemsService } from "./project-items.js";

const project = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "北京古道研究",
  description: null,
  lifecycleState: "ACTIVE" as const,
  createdAt: "2026-09-20T00:00:00.000Z",
  updatedAt: "2026-09-20T00:00:00.000Z",
};

const promotion = {
  status: "created" as const,
  workId: "22222222-2222-4222-8222-222222222222",
  editionId: "33333333-3333-4333-8333-333333333333",
  sourceId: "44444444-4444-4444-8444-444444444444",
  catalogBookId: "13000000",
};

describe("project item service", () => {
  it("checks the project before promotion, then binds the promoted Edition", async () => {
    const calls: string[] = [];
    const projects = {
      get: vi.fn(async () => { calls.push("project"); return project; }),
    };
    const promotionCommand = {
      execute: vi.fn(async () => { calls.push("promotion"); return promotion; }),
    };
    const item = { bindingId: "55555555-5555-4555-8555-555555555555" };
    const bindings = {
      addEdition: vi.fn(async () => { calls.push("binding"); return { status: "created", item }; }),
      listEditionItems: vi.fn(),
      removeEdition: vi.fn(),
    };

    const service = createProjectItemsService({ projects, promotionCommand, bindings });
    const result = await service.addCatalogBook(project.id, { bookId: "13000000" });

    expect(calls).toEqual(["project", "promotion", "binding"]);
    expect(bindings.addEdition).toHaveBeenCalledWith({
      projectId: project.id,
      workId: promotion.workId,
      editionId: promotion.editionId,
      sourceId: promotion.sourceId,
      catalogBookId: promotion.catalogBookId,
    });
    expect(result.promotionStatus).toBe("created");
    expect(result.bindingStatus).toBe("created");
  });

  it("does not promote when the project is missing or archived", async () => {
    // one case returns null, one returns lifecycleState ARCHIVED
    // in both cases assert promotionCommand.execute and bindings.addEdition were never called
  });
});
```

Also add tests for:
- `list(projectId)` checks project existence before binding read.
- `remove(projectId, bindingId)` checks project existence, validates binding id, and maps store false/not-found to `ProjectBindingNotFoundError`.
- a promotion result with `status="existing"` is propagated without changing binding semantics.

- [ ] **Step 6: Run application tests and verify RED**

```bash
corepack pnpm exec vitest run --maxWorkers=1 apps/api/src/s32/application/project-items.test.ts
```

Expected: FAIL because the service does not exist.

- [ ] **Step 7: Implement the application service and store interface**

Create `project-items.ts`:

```ts
import type { PromotionResult } from "./promote-catalog-book.js";
import { readProjectId, type Project } from "../domain/project.js";
import {
  readBindingId,
  readCatalogBookId,
  type ProjectResearchItem,
} from "../domain/project-item.js";

export class ProjectNotFoundError extends Error {}
export class ProjectNotActiveError extends Error {}
export class EditionNotAvailableError extends Error {}
export class ProjectBindingStoreUnavailableError extends Error {}
export class ProjectBindingNotFoundError extends Error {}

export interface ProjectLookup {
  get(id: unknown): Promise<Project | null>;
}

export interface PromotionCommand {
  execute(input: { bookId: string }): Promise<PromotionResult>;
}

export interface ProjectBindingStore {
  addEdition(input: {
    projectId: string;
    workId: string;
    editionId: string;
    sourceId: string;
    catalogBookId: string;
  }): Promise<{ status: "created" | "existing"; item: ProjectResearchItem }>;

  listEditionItems(projectId: string): Promise<ProjectResearchItem[]>;

  removeEdition(input: {
    projectId: string;
    bindingId: string;
  }): Promise<boolean>;
}

export function createProjectItemsService(deps: {
  projects: ProjectLookup;
  promotionCommand: PromotionCommand;
  bindings: ProjectBindingStore;
}) {
  async function requireActiveProject(input: unknown) {
    const projectId = readProjectId(input);
    const project = await deps.projects.get(projectId);
    if (!project) throw new ProjectNotFoundError("PROJECT_NOT_FOUND");
    if (project.lifecycleState !== "ACTIVE") {
      throw new ProjectNotActiveError("PROJECT_NOT_ACTIVE");
    }
    return projectId;
  }

  return {
    async addCatalogBook(projectInput: unknown, body: unknown) {
      const projectId = await requireActiveProject(projectInput);
      const bookId = readCatalogBookId(
        body && typeof body === "object"
          ? (body as Record<string, unknown>).bookId
          : undefined,
      );
      const promotion = await deps.promotionCommand.execute({ bookId });
      const binding = await deps.bindings.addEdition({
        projectId,
        workId: promotion.workId,
        editionId: promotion.editionId,
        sourceId: promotion.sourceId,
        catalogBookId: promotion.catalogBookId,
      });
      return {
        promotionStatus: promotion.status,
        bindingStatus: binding.status,
        item: binding.item,
      };
    },

    async list(projectInput: unknown) {
      const projectId = await requireActiveProject(projectInput);
      return deps.bindings.listEditionItems(projectId);
    },

    async remove(projectInput: unknown, bindingInput: unknown) {
      const projectId = await requireActiveProject(projectInput);
      const bindingId = readBindingId(bindingInput);
      const removed = await deps.bindings.removeEdition({ projectId, bindingId });
      if (!removed) throw new ProjectBindingNotFoundError("PROJECT_BINDING_NOT_FOUND");
    },
  };
}
```

- [ ] **Step 8: Run Task 1 tests**

```bash
corepack pnpm exec vitest run --maxWorkers=1   apps/api/src/s32/domain/project-item.test.ts   apps/api/src/s32/application/project-items.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit Task 1**

```bash
git add apps/api/src/s32/domain/project-item.ts         apps/api/src/s32/domain/project-item.test.ts         apps/api/src/s32/application/project-items.ts         apps/api/src/s32/application/project-items.test.ts
git commit -m "feat(s32): define M1C project item service"
```

---

### Task 2: Implement the PostgreSQL ProjectBinding store

**Files:**
- Create: `apps/api/src/s32/postgres/project-binding-store.ts`
- Create: `apps/api/src/s32/postgres/project-binding-store.test.ts`

**Interfaces:**
- Consumes: `ProjectBindingStore` and `ProjectResearchItem` from Task 1.
- Produces: `createPostgresProjectBindingStore(pool: Pool): ProjectBindingStore`.

- [ ] **Step 1: Write failing store error-classification and projection tests**

The focused unit test should use a mocked `Pool.query` and assert:
- connection codes already handled in M1-B (`ECONNREFUSED`, `08006`, `57P01`, `53300`) map to `ProjectBindingStoreUnavailableError`;
- an unexpected SQL error is rethrown for the route layer to hide as generic 500;
- malformed metadata values produce `catalogBookId: null` / `sourceId: null`.

Example:

```ts
it("normalizes malformed legacy metadata without inventing catalog links", async () => {
  const pool = fakePoolReturning([{
    binding_id: "555...",
    project_id: "111...",
    work_id: "222...",
    edition_id: "333...",
    metadata: { catalogBookId: 42, sourceId: [] },
    title: "北京古道考",
    publisher: null,
    publication_date: null,
    publication_date_precision: "YEAR",
    isbn: null,
    created_at: new Date("2026-09-20T00:00:00Z"),
  }]);

  const store = createPostgresProjectBindingStore(pool);
  const items = await store.listEditionItems("111...");
  expect(items[0].catalogBookId).toBeNull();
  expect(items[0].sourceId).toBeNull();
});
```

- [ ] **Step 2: Run store tests and verify RED**

```bash
corepack pnpm exec vitest run --maxWorkers=1 apps/api/src/s32/postgres/project-binding-store.test.ts
```

Expected: FAIL because the store does not exist.

- [ ] **Step 3: Implement the projection query**

Use a single projection shared by add/list:

```sql
SELECT
  pb.id AS binding_id,
  pb.project_id,
  pb.metadata,
  pb.created_at,
  e.id AS edition_id,
  e.work_id,
  e.publisher,
  e.publication_date,
  e.publication_date_precision,
  e.isbn,
  w.title
FROM core.project_bindings pb
JOIN core.editions e
  ON pb.target_type = 'EDITION'
 AND e.id = pb.target_id
JOIN core.works w
  ON w.id = e.work_id
WHERE pb.project_id = $1
  AND pb.target_type = 'EDITION'
ORDER BY pb.created_at DESC, pb.id DESC
```

For a single binding, add `AND pb.id = $2`.

Map dates with:

```ts
publicationDate:
  row.publication_date instanceof Date
    ? row.publication_date.toISOString().slice(0, 10)
    : row.publication_date ?? null
```

- [ ] **Step 4: Implement idempotent Edition binding creation**

Before insertion, verify the promoted Edition exists, is ACTIVE, and belongs to the supplied Work:

```sql
SELECT id
FROM core.editions
WHERE id = $1
  AND work_id = $2
  AND lifecycle_state = 'ACTIVE'
```

If absent, throw `EditionNotAvailableError`.

Insert:

```sql
INSERT INTO core.project_bindings (
  id, project_id, target_type, target_id, binding_role, metadata
)
VALUES ($1, $2, 'EDITION', $3, NULL, $4::jsonb)
ON CONFLICT (project_id, target_type, target_id)
DO NOTHING
RETURNING id
```

Metadata must be exactly:

```ts
{
  addedVia: "BOOK_ID_SEARCH_CATALOG",
  catalogBookId: input.catalogBookId,
  sourceId: input.sourceId,
}
```

If `RETURNING` is empty, load the existing binding by `project_id + target_type + target_id` and return `status: "existing"` without updating metadata.

- [ ] **Step 5: Implement safe removal**

Use:

```sql
DELETE FROM core.project_bindings
WHERE id = $1
  AND project_id = $2
  AND target_type = 'EDITION'
RETURNING id
```

Return `rowCount === 1`.

Do not issue any delete against Work/Edition/Source/ExternalIdentity.

- [ ] **Step 6: Run store tests**

Run the command from Step 2.

Expected: PASS.

- [ ] **Step 7: Commit Task 2**

```bash
git add apps/api/src/s32/postgres/project-binding-store.ts         apps/api/src/s32/postgres/project-binding-store.test.ts
git commit -m "feat(s32): add idempotent project binding store"
```

---

### Task 3: Add the private M1-C HTTP routes and register them

**Files:**
- Create: `apps/api/src/s32/routes/project-item-routes.ts`
- Create: `apps/api/src/s32/routes/project-item-routes.test.ts`
- Modify: `apps/api/src/s32/register.ts`

**Interfaces:**
- Consumes:
  - `checkS32PrivateAuth()`
  - `createProjectItemsService()`
  - existing M1-A error classes
  - Task 2 store
- Produces:
  - `createProjectItemRouter(config, projectItems)`
  - routes:
    - `POST /projects/:projectId/catalog-books`
    - `GET /projects/:projectId/items`
    - `DELETE /projects/:projectId/items/:bindingId`

- [ ] **Step 1: Write failing auth/error/status tests**

Create a small Express app mounting the router. Verify all three endpoints for:
- disabled = 404;
- token unconfigured = 503;
- missing = 401;
- wrong = 403;
- DB/service missing = 503;
- auth failure calls none of the project/service/promotion fakes.

Add exact mapping tests:

```ts
it("returns 201/200 from bindingStatus and never exposes internal errors", async () => {
  // created -> 201
  // existing -> 200
  // unexpected Error("postgresql://secret...") -> 500 body must not contain secret
});
```

Also test:
- invalid project UUID = 400;
- blank bookId = 400;
- project missing = 404;
- inactive project = 409;
- catalog missing = 404;
- invalid catalog metadata = 422, matching M1-A;
- identity conflict = 409;
- catalog unavailable = 503;
- canonical store unavailable = 503;
- project binding store unavailable = 503;
- delete missing/not-owned = 404;
- delete success = 204 with empty body.

- [ ] **Step 2: Run route tests and verify RED**

```bash
corepack pnpm exec vitest run --maxWorkers=1 apps/api/src/s32/routes/project-item-routes.test.ts
```

Expected: FAIL because the router does not exist.

- [ ] **Step 3: Implement router middleware and fixed error mapping**

Use the same auth ordering as M1-B:

```ts
router.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

router.use((req, res, next) => {
  const auth = checkS32PrivateAuth(
    config,
    req.get("authorization"),
    req.get("x-private-token"),
  );
  if (!auth.ok) {
    res.status(auth.status).json({ error: { message: auth.message } });
    return;
  }
  if (!config.databaseUrl || !projectItems) {
    res.status(503).json({ error: { message: "项目资料数据库尚未配置。" } });
    return;
  }
  next();
});
```

Create one `toHttpError(error)` function inside the route file; return only fixed public messages.

- [ ] **Step 4: Implement the three route handlers**

```ts
router.post("/:projectId/catalog-books", handle(async (req, res) => {
  const result = await projectItems!.addCatalogBook(req.params.projectId, req.body);
  res.status(result.bindingStatus === "created" ? 201 : 200).json(result);
}));

router.get("/:projectId/items", handle(async (req, res) => {
  res.json({ items: await projectItems!.list(req.params.projectId) });
}));

router.delete("/:projectId/items/:bindingId", handle(async (req, res) => {
  await projectItems!.remove(req.params.projectId, req.params.bindingId);
  res.status(204).end();
}));
```

- [ ] **Step 5: Wire one shared Pool in `register.ts`**

Keep one Pool when S32 is enabled/configured. Reuse:
- existing `projects`;
- existing `command` promotion command;
- new `createPostgresProjectBindingStore(pool)`.

Do not create a second Pool.

Target assembly:

```ts
let projectItems: ProjectItemsService | null = null;

if (config.enabled && config.databaseUrl) {
  const pool = new Pool(...);
  const projectStore = createPostgresProjectStore(pool);
  projects = createProjectsService(projectStore);

  command = createPromoteCatalogBookCommand({
    reader: createMeiliCatalogBookReader(deps.getCatalogDocument),
    store: createPostgresCatalogPromotionStore(pool),
  });

  projectItems = createProjectItemsService({
    projects,
    promotionCommand: command,
    bindings: createPostgresProjectBindingStore(pool),
  });
}

router.use("/projects", createProjectRouter(config, projects));
router.use("/projects", createProjectItemRouter(config, projectItems));
```

Mount route order must not shadow `/:projectId` from the existing Project router. If Express ordering causes `GET /:projectId` to swallow `/:projectId/items`, mount the item router before the generic project-detail router, or move all project routes under one parent router while preserving existing URLs. Pin the chosen order with an HTTP test.

- [ ] **Step 6: Run route + existing M1-A/M1-B HTTP tests**

```bash
corepack pnpm exec vitest run --maxWorkers=1   apps/api/src/s32/routes/catalog-promotion-route.test.ts   apps/api/src/s32/routes/project-routes.test.ts   apps/api/src/s32/routes/project-item-routes.test.ts
```

Expected: PASS.

- [ ] **Step 7: Build the API**

```bash
corepack pnpm --filter @book-id-search/api build
```

Expected: exit 0.

- [ ] **Step 8: Commit Task 3**

```bash
git add apps/api/src/s32/routes/project-item-routes.ts         apps/api/src/s32/routes/project-item-routes.test.ts         apps/api/src/s32/register.ts
git commit -m "feat(s32): expose private project item API"
```

---

### Task 4: Prove M1-A + M1-C together on real PostgreSQL 16

**Files:**
- Create: `apps/api/src/s32/postgres/project-binding-store.integration.test.ts`
- Create: `scripts/s32-m1c-integration-check.ts`
- Modify: root `package.json`

**Interfaces:**
- Consumes: unchanged M0 migration, real promotion store, project store, project binding store.
- Produces: `pnpm s32:m1c:check`.

- [ ] **Step 1: Add the root script first**

```json
"s32:m1c:check": "tsx scripts/s32-m1c-integration-check.ts"
```

- [ ] **Step 2: Write the real-PG integration test**

The test must read only `S32_M1C_TEST_DATABASE_URL`; never fall back to development or production URLs.

Guard:

```ts
const databaseUrl = process.env.S32_M1C_TEST_DATABASE_URL;
const parsed = databaseUrl ? new URL(databaseUrl) : null;
if (parsed && (
  parsed.hostname !== "127.0.0.1" ||
  parsed.pathname !== "/s32_m1c_test"
)) {
  throw new Error("M1C integration requires isolated s32_m1c_test");
}
```

Build a deterministic `CatalogBookReader` returning one test book; do not require Meilisearch.

Inside one integration test:

1. insert ACTIVE Project A and ACTIVE Project B;
2. call add to Project A once → created;
3. count Work/Edition/Source/ExternalIdentity/ProjectBinding;
4. call same add again → existing; counts unchanged;
5. execute two concurrent add calls to Project B; assert only one Project B binding exists;
6. list A, verify stable canonical projection and metadata-derived catalogBookId;
7. delete A binding;
8. assert A binding gone;
9. assert Work/Edition/Source/ExternalIdentity counts unchanged;
10. verify no Note/Claim/ResearchIssue rows were created.

- [ ] **Step 3: Add the retry-after-binding-failure proof**

Use a wrapper binding store that throws once *after promotion has completed* and succeeds on retry:

```ts
let failOnce = true;
const flakyBindings = {
  ...realBindings,
  async addEdition(input) {
    if (failOnce) {
      failOnce = false;
      throw new ProjectBindingStoreUnavailableError("simulated");
    }
    return realBindings.addEdition(input);
  },
};
```

Assert:
- first request rejects at binding stage;
- canonical row counts equal one chain;
- retry returns `promotionStatus="existing"`, `bindingStatus="created"`;
- canonical counts remain unchanged.

- [ ] **Step 4: Write the disposable PG runner**

Follow `scripts/s32-m1b-integration-check.ts`:
- unique container name;
- `postgres:16-alpine`;
- tmpfs data;
- random loopback host port;
- random password;
- apply unchanged migration using `psql -v ON_ERROR_STOP=1`;
- run only the M1-C integration test with `--maxWorkers=1`;
- ownership label check before cleanup;
- always remove own container.

Use a distinct label:
`book-id-search.s32-m1c-run=<container-name>`.

- [ ] **Step 5: Run the M1-C real-PG check**

```bash
corepack pnpm s32:m1c:check
```

Expected:
- integration test PASS;
- `S32_M1C_REAL_PG=PASS`;
- `DISPOSABLE_TEST_CONTAINER_REMOVED=YES`.

- [ ] **Step 6: Re-run scoped backend tests**

```bash
corepack pnpm exec vitest run --maxWorkers=1   apps/api/src/s32   scripts/s32-schema-contract.test.ts   --exclude '**/*.integration.test.ts'
```

Expected: PASS; real-PG tests skipped/excluded here, not double-counted.

- [ ] **Step 7: Commit Task 4**

```bash
git add apps/api/src/s32/postgres/project-binding-store.integration.test.ts         scripts/s32-m1c-integration-check.ts package.json
git commit -m "test(s32): verify M1C against PostgreSQL"
```

---

### Task 5: Add typed private M1-C web API clients

**Files:**
- Modify: `apps/web/src/research/api.ts`
- Test: `apps/web/src/research/research.test.tsx`

**Interfaces:**
- Produces:
  - `ProjectResearchItem`
  - `addCatalogBookToProject(token, projectId, bookId, signal?)`
  - `listProjectItems(token, projectId, signal?)`
  - `removeProjectItem(token, projectId, bindingId, signal?)`

- [ ] **Step 1: Write failing client tests**

Extend the existing private client tests:

```ts
it("uses same-origin no-store M1-C requests and does not retry writes", async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({
      promotionStatus: "created",
      bindingStatus: "created",
      item,
    }), { status: 201 }))
    .mockResolvedValueOnce(new Response(null, { status: 204 }));

  vi.stubGlobal("fetch", fetchMock);

  await addCatalogBookToProject("token", projectId, "13000000");
  await removeProjectItem("token", projectId, bindingId);

  expect(fetchMock).toHaveBeenNthCalledWith(
    1,
    `/api/private/s32/projects/${projectId}/catalog-books`,
    expect.objectContaining({ method: "POST", cache: "no-store" }),
  );
  expect(fetchMock).toHaveBeenNthCalledWith(
    2,
    `/api/private/s32/projects/${projectId}/items/${bindingId}`,
    expect.objectContaining({ method: "DELETE", cache: "no-store" }),
  );
});
```

Also test:
- 409 renders a user-safe “冲突” message;
- malformed 200 list without `items` rejects;
- 204 delete does not attempt JSON parsing;
- 503 body does not reflect server detail.

- [ ] **Step 2: Run web client tests and verify RED**

```bash
corepack pnpm exec vitest run --maxWorkers=1 apps/web/src/research/research.test.tsx
```

Expected: FAIL until functions exist.

- [ ] **Step 3: Refactor the private request helper only as far as needed**

Keep same-origin root:

```ts
const S32_PROJECTS_ROOT = "/api/private/s32/projects";
```

Add:

```ts
export interface ProjectResearchItem {
  bindingId: string;
  projectId: string;
  workId: string;
  editionId: string;
  sourceId: string | null;
  catalogBookId: string | null;
  title: string;
  publisher: string | null;
  publicationDate: string | null;
  publicationDatePrecision: "YEAR" | "MONTH" | "DAY";
  isbn: string | null;
  addedAt: string;
}

export async function addCatalogBookToProject(
  token: string,
  projectId: string,
  bookId: string,
  signal?: AbortSignal,
) { /* POST once, no retry */ }

export async function listProjectItems(
  token: string,
  projectId: string,
  signal?: AbortSignal,
) { /* GET items */ }

export async function removeProjectItem(
  token: string,
  projectId: string,
  bindingId: string,
  signal?: AbortSignal,
) { /* DELETE; accept 204 */ }
```

Do not import public `API_BASE` from `apps/web/src/api.ts`.

- [ ] **Step 4: Run research client tests**

Expected: PASS.

- [ ] **Step 5: Commit Task 5**

```bash
git add apps/web/src/research/api.ts apps/web/src/research/research.test.tsx
git commit -m "feat(s32): add private project item web client"
```

---

### Task 6: Add “加入研究” project selector on search results

**Files:**
- Create: `apps/web/src/research/AddToProject.tsx`
- Create: `apps/web/src/research/AddToProject.test.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/research/research.css`

**Interfaces:**
- Consumes:
  - `researchEnabled`
  - `useS32Token()`
  - `listProjects()`
  - `addCatalogBookToProject()`
  - catalog `Book.id`
- Produces:
  - `AddToProject({ bookId, bookTitle, onAdded? })`

- [ ] **Step 1: Write failing component tests for the Review Focus states**

Use React Testing Library already present in the web package.

Tests must cover:
- feature disabled → component renders nothing;
- no token → button opens guidance with link to `/research/projects`, no duplicate credential input;
- token + zero projects → “暂无研究项目” + create-project link;
- token + projects → selector lists projects;
- clicking one project sends exactly one POST;
- POST pending disables project choices;
- success shows `已加入「北京古道研究」`;
- failed POST keeps selector open and shows safe error;
- unmount aborts in-flight list/add request without false success.

Example:

```tsx
it("adds one book to one selected project exactly once", async () => {
  vi.mocked(listProjects).mockResolvedValue({ projects: [project] });
  vi.mocked(addCatalogBookToProject).mockResolvedValue({
    promotionStatus: "created",
    bindingStatus: "created",
    item,
  });

  render(
    <MemoryRouter>
      <AddToProject bookId="13000000" bookTitle="北京古道考" />
    </MemoryRouter>,
  );

  await user.click(screen.getByRole("button", { name: "加入研究" }));
  await user.click(await screen.findByRole("button", { name: /北京古道研究/ }));

  expect(addCatalogBookToProject).toHaveBeenCalledTimes(1);
  expect(await screen.findByText("已加入「北京古道研究」")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run component test and verify RED**

```bash
corepack pnpm exec vitest run --maxWorkers=1 apps/web/src/research/AddToProject.test.tsx
```

Expected: FAIL because component does not exist.

- [ ] **Step 3: Implement `AddToProject`**

Behavior:
- primary button text `加入研究`;
- lightweight popover/panel, not a global modal framework;
- reads token from existing `useS32Token()`;
- project list is fetched on opening, not for every BookCard render;
- one `AbortController` for the open panel lifecycle;
- no automatic retry of POST;
- after success, local component state may show “已加入研究” for this page session only.

Do not prefetch project membership for every search result.

- [ ] **Step 4: Wire BookCard without moving S32 logic into App**

Change `BookCard` props minimally:

```ts
function BookCard({ book, query, weread, compareSelected, onToggleCompare }: ...) {
  // ...
  return (
    <article ...>
      ...
      {researchEnabled ? (
        <AddToProject bookId={book.id} bookTitle={book.title || "未命名图书"} />
      ) : null}
    </article>
  );
}
```

The component itself owns S32 token/project state.

Also allow related-book cards on the detail page to use the same action because they reuse BookCard.

- [ ] **Step 5: Add focused CSS**

Add only namespaced classes such as:
- `.research-add`
- `.research-add-panel`
- `.research-project-choice`
- `.research-add-success`

Verify no global button/input selector changes.

- [ ] **Step 6: Run component + existing search presentation tests**

```bash
corepack pnpm exec vitest run --maxWorkers=1   apps/web/src/research/AddToProject.test.tsx   apps/web/src/research/research.test.tsx   apps/web/src/EditionCompare.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Build Web**

```bash
corepack pnpm --filter @book-id-search/web build
```

Expected: exit 0; existing bundle-size warning may remain but must be reported rather than treated as a failure.

- [ ] **Step 8: Commit Task 6**

```bash
git add apps/web/src/research/AddToProject.tsx         apps/web/src/research/AddToProject.test.tsx         apps/web/src/research/research.css         apps/web/src/App.tsx
git commit -m "feat(s32): add research project selector to books"
```

---

### Task 7: Show and remove research material on the Project detail page

**Files:**
- Create: `apps/web/src/research/ProjectItems.tsx`
- Create: `apps/web/src/research/ProjectItems.test.tsx`
- Modify: `apps/web/src/research/ProjectsPage.tsx`
- Modify: `apps/web/src/research/research.css`

**Interfaces:**
- Consumes:
  - `listProjectItems()`
  - `removeProjectItem()`
  - existing S32 token
  - current `projectId`
- Produces:
  - `ProjectItems({ token, projectId })`

- [ ] **Step 1: Write failing presentation and remove tests**

Cover:
- loading;
- empty state says “还没有研究资料”;
- canonical title/publisher/year/ISBN display;
- `catalogBookId !== null` → link to `/books/:catalogBookId`;
- missing catalogBookId → no fake link;
- count reflects actual item array length;
- remove asks for confirmation;
- cancelling confirmation performs no DELETE;
- confirmed DELETE runs once and removes only that item in UI after 204;
- failed DELETE keeps the item and shows an error;
- token/project change aborts previous load.

Example:

```tsx
it("removes only after confirmation and keeps the item on failure", async () => {
  vi.spyOn(window, "confirm").mockReturnValue(true);
  vi.mocked(listProjectItems).mockResolvedValue({ items: [item] });
  vi.mocked(removeProjectItem).mockRejectedValue(new Error("服务暂不可用"));

  render(<ProjectItems token="token" projectId={projectId} />);

  await screen.findByText(item.title);
  await user.click(screen.getByRole("button", { name: "移出项目" }));

  expect(removeProjectItem).toHaveBeenCalledTimes(1);
  expect(await screen.findByText(item.title)).toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent("服务暂不可用");
});
```

- [ ] **Step 2: Run test and verify RED**

```bash
corepack pnpm exec vitest run --maxWorkers=1 apps/web/src/research/ProjectItems.test.tsx
```

Expected: FAIL because component does not exist.

- [ ] **Step 3: Implement `ProjectItems`**

Use:
- one load AbortController per `token + projectId + reloadVersion`;
- local `items`, `loading`, `error`, `removingId`;
- no optimistic delete before server 204;
- after successful delete, filter the returned binding id locally.

Date display:
- `YEAR` precision → show four-digit year only;
- otherwise show locale date;
- null → “日期未知”.

- [ ] **Step 4: Integrate into Project detail**

In `ProjectWorkspace`, when `projectId` and the project itself loaded successfully:

```tsx
<>
  <ProjectDetails project={project} />
  <ProjectItems token={token} projectId={project.id} />
</>
```

Do not load project items on the project-list route.

- [ ] **Step 5: Run Project UI tests**

```bash
corepack pnpm exec vitest run --maxWorkers=1   apps/web/src/research/ProjectItems.test.tsx   apps/web/src/research/research.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Check 390px layout through the browser acceptance task later**

Do not add a separate mobile architecture. Ensure CSS uses wrapping/grid rules rather than fixed widths.

- [ ] **Step 7: Commit Task 7**

```bash
git add apps/web/src/research/ProjectItems.tsx         apps/web/src/research/ProjectItems.test.tsx         apps/web/src/research/ProjectsPage.tsx         apps/web/src/research/research.css
git commit -m "feat(s32): show project research material"
```

---

### Task 8: Run the complete scoped verification and local browser acceptance

**Files:**
- Create: `docs/operations/S32_M1C_LOCAL.md`
- Modify: `AGENTS.md`
- Modify: `docs/STATUS.md` only after evidence exists.

**Interfaces:**
- Produces the final `tested_commit` and reproducible evidence for the PR.

- [ ] **Step 1: Update AGENTS stage boundary before final verification**

Replace the M1-B-only authorization line with a precise M1-C line:

```text
Current authorized local stage is M1-C: explicit catalog-book promotion into one existing Project as an idempotent EDITION ProjectBinding, project-item list, and binding removal. Keep M0 migration/frozen SQL unchanged. No M1-D/E or production changes are authorized.
```

Keep all existing production authorization restrictions.

- [ ] **Step 2: Write the local M1-C runbook**

`docs/operations/S32_M1C_LOCAL.md` must document:
- prerequisite M1-B local PG volume and ignored `.env.s32.local`;
- Meili must be available for a *real browser add*, because M1-A rereads the actual catalog;
- API/Web start commands;
- `pnpm s32:m1c:check` uses a disposable PG and deterministic fake catalog, not the trial volume;
- never use `down -v`;
- exact browser acceptance sequence;
- evidence/log directory under ignored `logs/s32-m1c/`.

- [ ] **Step 3: Run scoped backend unit/static tests**

```bash
corepack pnpm exec vitest run --maxWorkers=1   apps/api/src/s32   scripts/s32-schema-contract.test.ts   --exclude '**/*.integration.test.ts'
```

Expected: 0 failures. Record the exact test/file counts; do not reuse historical numbers.

- [ ] **Step 4: Run real PostgreSQL M1-C integration**

```bash
corepack pnpm s32:m1c:check
```

Expected: PASS and disposable container removed.

- [ ] **Step 5: Run affected search/Web regressions**

At minimum:

```bash
corepack pnpm exec vitest run --maxWorkers=1   apps/api/src/search   apps/api/src/handle-search.test.ts   apps/web/src/EditionCompare.test.tsx   apps/web/src/research
```

Expected: 0 failures.

- [ ] **Step 6: Build both applications**

```bash
corepack pnpm --filter @book-id-search/api build
corepack pnpm --filter @book-id-search/web build
```

Expected: exit 0 / exit 0.

- [ ] **Step 7: Prove frozen database files did not change**

Run:

```bash
git diff main...HEAD --   db/migrations/001_s32_core_schema.sql   db/tests/001_s32_schema_assertions.sql   db/tests/001_s32_schema_negative_tests.sql   pnpm-lock.yaml
```

Expected: empty output. If the repository uses different exact names for either frozen SQL test file, resolve them from git and record the actual paths before executing; do not silently skip them.

- [ ] **Step 8: Run the real local browser acceptance**

Use the existing persistent development PG and actual local Meili catalog.

Create/use project “北京古道研究”.

Perform and record:

```text
1. Open / and search a real catalog book.
2. Click 加入研究.
3. Select 北京古道研究.
4. Observe successful add.
5. Open /research/projects/<projectId>.
6. Confirm the book appears under 研究资料.
7. Refresh and confirm it remains.
8. Return to search and add the same book again.
9. Confirm project still has exactly one item for that Edition.
10. Restart API and development PG while preserving the volume.
11. Reopen project and confirm the item remains.
12. Remove the item and confirm it disappears.
13. Query the private API or local SQL and confirm the promoted Work/Edition/Source/ExternalIdentity still exist.
14. Repeat visual check at 390px width.
```

Capture:
- one screenshot of project selector;
- one project-detail screenshot with the item;
- one mobile-width screenshot;
- one post-restart screenshot;
- one post-remove canonical-preservation receipt (text log is enough).

Keep screenshots/logs outside tracked source, e.g. `/home/conanxin/codex-artifacts/s32-m1c/` and `logs/s32-m1c/`.

- [ ] **Step 9: Exercise browser failure states without destroying trial data**

At least:
- wrong S32 token;
- empty project list can be tested with a disposable/temporary UI mock only if no separate clean trial DB exists; do not erase the real trial project;
- catalog book 404 using a controlled API request;
- DB 503 by temporarily stopping only the local development PG, then starting it again;
- repeat add;
- cancel remove;
- unknown binding delete through API.

Record which checks were browser vs HTTP-only.

- [ ] **Step 10: Run `git diff --check`**

```bash
git diff --check main...HEAD
```

Expected: no output, exit 0.

- [ ] **Step 11: Commit verified code/docs**

Only after Steps 3–10 are complete:

```bash
git add AGENTS.md docs/operations/S32_M1C_LOCAL.md docs/STATUS.md         apps/api apps/web package.json scripts
git status --short
git commit -m "docs(s32): record M1C local verification"
```

If verification reveals a product fix, make that fix in a separate code commit, rerun the affected checks, then record the *actual* final tested commit. Do not call an untested docs-follow-up the image/runtime source commit.

---

### Task 9: Push one review PR and synchronize GitHub + Notion

**Files:**
- No product changes unless review evidence reveals a real defect.
- Update `docs/STATUS.md` only with exact final receipts if needed.

**Interfaces:**
- Produces one M1-C PR, one `tested_commit`, GitHub Issue #2 checkpoint, and matching Notion M1-C status.

- [ ] **Step 1: Confirm the branch is based on the actual latest main**

Before push:

```bash
git fetch origin
git merge-base --is-ancestor 7295af6e991e2a5b1575b8c2a0b5d3662c093b9f HEAD
git status --short
```

Expected:
- ancestor check exit 0;
- worktree clean before opening PR.

If remote main moved for unrelated work, compare before rebasing; do not blindly reset.

- [ ] **Step 2: Push the feature branch**

Recommended branch:

```text
feat/s32-m1c-project-binding
```

Push:

```bash
git push -u origin feat/s32-m1c-project-binding
```

- [ ] **Step 3: Open one PR against main**

PR body must state separately:

```text
task_id=S32_M1C_PROJECT_BINDING_R1
tested_commit=<actual SHA>
IMPLEMENTED=YES
TESTED=<exact scoped result>
COMMITTED=YES
PUSHED=YES
MERGED=NO
DEPLOYED=NO
PRODUCTION_CHANGED=NO
M1_D_STARTED=NO
```

Include:
- exact test commands and counts;
- real-PG result;
- browser acceptance result;
- frozen SQL diff result;
- NOT_RUN items;
- artifact paths;
- no production deployment.

- [ ] **Step 4: Update GitHub Issue #2 once**

Add only the phase checkpoint:
- PR link;
- tested commit;
- scoped verification;
- notable NOT_RUN;
- production unchanged;
- next gate = PR review.

Do not paste raw logs.

- [ ] **Step 5: Update the existing Notion M1-C page and project overview**

Use the same:
- `task_id`;
- `tested_commit`;
- PR URL;
- state labels.

Notion should record:
- what the user can now do;
- evidence summary;
- unresolved limitations;
- next gate.

Do not create a second M1-C canonical page.

- [ ] **Step 6: Read back both synchronization targets**

Verify GitHub Issue #2 and both Notion pages contain the same:
- task id;
- tested commit;
- PR link;
- merged/deployed flags.

If one side fails, mark only that side `PENDING`; do not claim dual-sync completion.

- [ ] **Step 7: Stop at review gate**

Final state before human review:

```text
M1_C_IMPLEMENTATION=COMPLETE_ON_BRANCH
M1_C_VERIFICATION=PASS_SCOPED
M1_C_PR=OPEN
M1_C_MERGED=NO
PRODUCTION_CHANGED=NO
M1_D_STARTED=NO
```

Do not merge the PR, deploy, clean production disk, or start M1-D without a new explicit decision.

---

## Self-Review Result

### Spec coverage

Covered:
- Search result “加入研究” and project selector → Task 6.
- no-token / empty-project states → Task 6.
- backend composition of M1-A promotion + Edition ProjectBinding → Tasks 1–3.
- separate promotion/binding transaction boundaries and retry safety → Tasks 1, 4.
- binding idempotency/concurrency → Tasks 2, 4.
- canonical Project detail projection → Tasks 2, 7.
- remove only ProjectBinding → Tasks 2, 4, 7.
- private auth/error semantics → Task 3.
- same-origin private client → Task 5.
- local persistent trial data + disposable test PG → Tasks 4, 8.
- browser acceptance including restart/retry/remove/mobile → Task 8.
- GitHub/Notion synchronized evidence → Task 9.
- no schema change / no M1-D/E / no production → Global Constraints + Tasks 8–9.

No uncovered spec requirement found.

### Placeholder scan

No `TBD`, `TODO`, “implement later”, unspecified “handle errors”, or “write tests for above” steps remain. Every code-producing task has concrete interfaces, test cases, commands, and expected results.

### Type consistency

Checked:
- `ProjectResearchItem` fields match API DTO and web DTO.
- `addEdition()`, `listEditionItems()`, `removeEdition()` are used consistently from store → service → route.
- `promotionStatus` comes from existing M1-A `PromotionResult.status`.
- `bindingStatus` is independent and comes from the binding store.
- remove uses `projectId + bindingId`, never Edition id.
- catalog navigation uses nullable `catalogBookId`.

### Review Focus coverage

1. Concurrent duplicate add → Task 4 real-PG concurrency case.
2. Binding failure after successful promotion → Task 4 flaky-store retry case.
3. Forged/stale identifiers → Tasks 1–3 route/application tests.
4. Malformed legacy binding metadata → Task 2 projection unit test.
5. Credential/UI state transitions → Tasks 5–7 component/client tests and Task 8 browser checks.
