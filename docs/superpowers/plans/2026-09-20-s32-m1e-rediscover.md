# S32-M1E Rediscover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete M1 Rediscover so current search results automatically show canonical Project memberships, Project pages surface current Note summaries ordered by recent research, archived Projects remain fully readable but read-only, and Search deep-links back to the exact Edition ProjectBinding.

**Architecture:** Add two PostgreSQL-backed read models without adding canonical tables: a batch Search Membership projection keyed by catalog `Book.id`, and a Project Overview projection keyed by `projectId`. Keep PostgreSQL `core.*` as the only research truth, keep Meilisearch discovery-only, preserve M1-D immutable Note writes, and make the Web consume the new projections with stale-request cancellation and explicit degraded states.

**Tech Stack:** TypeScript 5.9, Node.js, Express 5, PostgreSQL 16 via `pg`, React 19, React Router 7, Vitest 4, Testing Library, pnpm 10.

**Spec:** `docs/superpowers/specs/2026-09-20-s32-m1e-rediscover-design.md`

## Global Constraints

- Baseline is `main@414ee84f260d2bfae703956cbb879fbe76ab9c27`; first execution step must fetch and record the actual main SHA before creating the feature worktree.
- Do not modify `db/migrations/001_s32_core_schema.sql`, `db/tests/001_s32_schema_assertions.sql`, or `db/tests/002_s32_negative_invariants.sql`.
- Do not add canonical tables, materialized membership caches, Meilisearch research fields, full-text/vector search, AI summaries, global dashboards, Project archive UI, or M2 Claim/Evidence work.
- Search Membership and Project Overview are private S32 APIs with existing private auth, same-origin behavior, shared PostgreSQL Pool, `Cache-Control: no-store`, fail-closed integrity handling, and generic 500 bodies.
- Membership identity truth is `BOOK_ID_SEARCH / CATALOG_DOCUMENT / Book.id` resolving to a SOURCE and then Source → Edition → Work. M1-C binding metadata remains provenance only.
- Membership accepts at most 100 non-empty string IDs, dedupes before querying, returns an explicit array for every requested ID, and never performs promotion or writes.
- Overview uses a repeatable-read read-only snapshot and a fixed number of SQL statements independent of item count.
- Project activity is `Note.updated_at` when a Note exists, otherwise Edition ProjectBinding `created_at`; sort by activity descending then binding id descending.
- Note preview is runtime-only: CRLF→LF, CR→LF, Unicode whitespace runs→one ASCII space, trim, first 240 Unicode code points, append `…` only when truncated.
- ACTIVE Projects are readable/writable; ARCHIVED Projects are readable but all M1 writes remain rejected server-side with 409 lifecycle conflict semantics.
- Search membership failure must never erase catalog results and must never be rendered as “not researched”.
- Search → Project deep-link is `/research/projects/:projectId?item=:bindingId`; no Edition/catalog fallback is allowed for a missing binding.
- Production deployment, production PostgreSQL, disk cleanup/expansion, image publishing, runtime env changes, and automatic merge are outside this plan.

## Review Focus

- A matching CATALOG_DOCUMENT identity with `target_type !== 'SOURCE'` must fail closed rather than disappear behind a SQL filter; Task 2 pins this with a store test and Task 5 pins it on real PG.
- A membership response arriving after the user changes query/page/token must be ignored; Task 7 pins this with an AbortController race test.
- ARCHIVED Projects must expose current Note/history while rejecting create/append/remove/add writes; Task 4 pins service/route behavior and Task 5 proves row preservation on real PG.
- Unicode supplementary-plane characters at the 240-code-point excerpt boundary must not be split; Task 1 pins the helper and Task 8 verifies the rendered preview.
- An add-to-project POST may succeed while the membership refresh fails; Task 7 pins “add succeeded, research status not reconfirmed” without reverting to failure.

---

### Task 1: Rediscover domain contracts and excerpt normalization

**Files:**
- Create: `apps/api/src/s32/domain/rediscover.ts`
- Create: `apps/api/src/s32/domain/rediscover.test.ts`

**Interfaces:**
- Produces: `readMembershipBookIds(input: unknown): string[]`
- Produces: `buildNoteExcerpt(content: string): string`
- Produces: `CatalogBookMembership`, `ProjectOverview`, `ProjectOverviewItem`, and `ProjectOverviewNoteSummary` types.
- Consumes: no new dependencies; use the existing domain-error pattern.

- [ ] **Step 1: Write failing input and excerpt tests**

Create tests that pin all contract boundaries:

```ts
import { describe, expect, it } from "vitest";
import {
  InvalidRediscoverInputError,
  buildNoteExcerpt,
  readMembershipBookIds,
} from "./rediscover.js";

describe("readMembershipBookIds", () => {
  it("accepts empty input and deduplicates while preserving first occurrence", () => {
    expect(readMembershipBookIds({ bookIds: [] })).toEqual([]);
    expect(readMembershipBookIds({ bookIds: ["a", "b", "a"] })).toEqual(["a", "b"]);
  });

  it.each([
    null,
    {},
    { bookIds: "a" },
    { bookIds: [""] },
    { bookIds: ["   "] },
    { bookIds: [1] },
    { bookIds: Array.from({ length: 101 }, (_, i) => `book-${i}`) },
  ])("rejects malformed input %#", (input) => {
    expect(() => readMembershipBookIds(input)).toThrow(InvalidRediscoverInputError);
  });
});

describe("buildNoteExcerpt", () => {
  it("normalizes line endings and Unicode whitespace without changing code-point semantics", () => {
    expect(buildNoteExcerpt("  A\r\n\tB\r　C  ")).toBe("A B C");
  });

  it("keeps exactly 240 code points and adds ellipsis only when truncated", () => {
    const exact = "𠀀".repeat(240);
    expect(Array.from(buildNoteExcerpt(exact))).toHaveLength(240);
    expect(buildNoteExcerpt(exact)).toBe(exact);

    const long = exact + "终";
    const excerpt = buildNoteExcerpt(long);
    expect(Array.from(excerpt.slice(0, -1))).toHaveLength(240);
    expect(excerpt.endsWith("…")).toBe(true);
  });
});
```

- [ ] **Step 2: Run the domain test and verify RED**

Run:

```bash
pnpm vitest run apps/api/src/s32/domain/rediscover.test.ts
```

Expected: FAIL because `rediscover.ts` does not exist.

- [ ] **Step 3: Implement the domain types and helpers**

Create `rediscover.ts` with these exact public shapes:

```ts
export class InvalidRediscoverInputError extends Error {}

export type ProjectLifecycleState = "ACTIVE" | "ARCHIVED";

export interface CatalogBookMembership {
  projectId: string;
  projectName: string;
  projectLifecycleState: ProjectLifecycleState;
  bindingId: string;
  hasNote: boolean;
  noteUpdatedAt: string | null;
}

export interface ProjectOverviewNoteSummary {
  noteId: string;
  currentRevisionId: string;
  currentRevisionNo: number;
  excerpt: string;
  updatedAt: string;
}

export interface ProjectOverviewItem {
  bindingId: string;
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
  activityAt: string;
  noteSummary: ProjectOverviewNoteSummary | null;
}

export interface ProjectOverview {
  project: {
    id: string;
    name: string;
    description: string | null;
    lifecycleState: ProjectLifecycleState;
    readOnly: boolean;
    createdAt: string;
    updatedAt: string;
  };
  summary: {
    itemCount: number;
    noteCount: number;
    lastActivityAt: string | null;
  };
  items: ProjectOverviewItem[];
}

export function readMembershipBookIds(input: unknown): string[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new InvalidRediscoverInputError("membership input must be an object");
  }
  const value = (input as Record<string, unknown>).bookIds;
  if (!Array.isArray(value) || value.length > 100) {
    throw new InvalidRediscoverInputError("bookIds must be an array of at most 100 items");
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !item.trim()) {
      throw new InvalidRediscoverInputError("bookIds must contain non-empty strings");
    }
    if (!seen.has(item)) {
      seen.add(item);
      result.push(item);
    }
  }
  return result;
}

export function buildNoteExcerpt(content: string): string {
  const normalized = content
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .replace(/\s+/gu, " ")
    .trim();
  const codePoints = Array.from(normalized);
  return codePoints.length <= 240 ? normalized : `${codePoints.slice(0, 240).join("")}…`;
}
```

- [ ] **Step 4: Run the domain test and verify GREEN**

Run:

```bash
pnpm vitest run apps/api/src/s32/domain/rediscover.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 1**

```bash
git add apps/api/src/s32/domain/rediscover.ts apps/api/src/s32/domain/rediscover.test.ts
git commit -m "feat(s32): add rediscover domain contracts"
```

---

### Task 2: Batch Search Membership read model

**Files:**
- Create: `apps/api/src/s32/application/research-memberships.ts`
- Create: `apps/api/src/s32/application/research-memberships.test.ts`
- Create: `apps/api/src/s32/postgres/research-membership-store.ts`
- Create: `apps/api/src/s32/postgres/research-membership-store.test.ts`
- Create: `apps/api/src/s32/routes/research-membership-route.ts`
- Create: `apps/api/src/s32/routes/research-membership-route.test.ts`
- Modify: `apps/api/src/s32/register.ts`

**Interfaces:**
- Consumes: `readMembershipBookIds()` and `CatalogBookMembership` from Task 1.
- Produces: `ResearchMembershipStore.lookup(bookIds: string[]): Promise<Map<string, CatalogBookMembership[]>>`.
- Produces: `createResearchMembershipService(store).lookup(input)` returning `{ memberships: Record<string, CatalogBookMembership[]> }`.
- Produces: `POST /api/private/s32/research-memberships/catalog-books`.

- [ ] **Step 1: Write failing application tests for explicit keys and stable sorting**

Use a fake store that intentionally omits one requested book and returns memberships out of order. Pin:
- every normalized request ID exists in the response;
- omitted store rows become explicit `[]`;
- ACTIVE precedes ARCHIVED;
- within lifecycle, non-null latest `noteUpdatedAt` comes first, then projectName/projectId.

Run:

```bash
pnpm vitest run apps/api/src/s32/application/research-memberships.test.ts
```

Expected: RED because the service does not exist.

- [ ] **Step 2: Implement the application service**

The public service contract must be:

```ts
export class ResearchMembershipStoreUnavailableError extends Error {}
export class ResearchMembershipIntegrityError extends Error {}

export interface ResearchMembershipStore {
  lookup(bookIds: string[]): Promise<Map<string, CatalogBookMembership[]>>;
}

export function createResearchMembershipService(store: ResearchMembershipStore) {
  return {
    async lookup(input: unknown) {
      const bookIds = readMembershipBookIds(input);
      const found = await store.lookup(bookIds);
      const memberships: Record<string, CatalogBookMembership[]> = {};
      for (const bookId of bookIds) {
        memberships[bookId] = [...(found.get(bookId) ?? [])].sort(compareMemberships);
      }
      return { memberships };
    },
  };
}
```

Implement `compareMemberships` with ACTIVE before ARCHIVED, `noteUpdatedAt DESC NULLS LAST`, `projectName ASC`, then `projectId ASC`.

Run the application test and require PASS.

- [ ] **Step 3: Write failing PostgreSQL store tests around identity integrity**

Use a mocked `Pool`/client as existing store unit tests do. Pin these SQL/result behaviors:
- input is passed as one array parameter, not one query per book;
- the identity query does **not** hide a matching CATALOG_DOCUMENT row with a non-SOURCE target type;
- matching non-SOURCE identity throws `ResearchMembershipIntegrityError`;
- missing Source, Edition, or Work after a matching non-retired identity throws integrity error;
- no matching identity returns no store row and is not an error;
- malformed NOTE relation or duplicate NOTE bindings for one Edition binding throws integrity error;
- store executes no INSERT/UPDATE/DELETE statements.

Run:

```bash
pnpm vitest run apps/api/src/s32/postgres/research-membership-store.test.ts
```

Expected: RED.

- [ ] **Step 4: Implement the PostgreSQL membership projection**

Use one read-only repeatable-read transaction and a fixed number of SQL statements. The identity query must start from requested IDs and load the matching external identity without filtering away bad target types:

```sql
SELECT
  requested.book_id,
  ei.target_type AS identity_target_type,
  ei.target_id AS source_id,
  s.edition_id,
  e.work_id
FROM unnest($1::text[]) AS requested(book_id)
LEFT JOIN core.external_identities ei
  ON ei.provider = 'BOOK_ID_SEARCH'
 AND ei.namespace = 'CATALOG_DOCUMENT'
 AND ei.external_id = requested.book_id
 AND ei.binding_state <> 'RETIRED'
LEFT JOIN core.sources s
  ON s.id = ei.target_id
LEFT JOIN core.editions e
  ON e.id = s.edition_id
```

For every row where `identity_target_type` is non-null:
- require `identity_target_type === "SOURCE"`;
- require sourceId, editionId, and workId;
- otherwise throw `ResearchMembershipIntegrityError`.

Load Project memberships for the resolved Edition IDs in one second query. Include all Project lifecycle states defined by M0, and load NOTE bindings by `metadata->>'subjectBindingId'`. Validate exactly zero or one NOTE/ANNOTATION relation per Edition binding, matching `subjectType=EDITION` and `subjectId=editionId`; if present require an ACTIVE PROJECT_ITEM_NOTE with a valid current revision pointer. Return only projection data and never write.

Map connection-class failures to `ResearchMembershipStoreUnavailableError`.

- [ ] **Step 5: Write and run route RED→GREEN tests**

Route behavior:

```http
POST /api/private/s32/research-memberships/catalog-books
```

Pin:
- feature disabled → 404 through existing S32 registration behavior;
- bad/missing token → existing 401/403 semantics;
- malformed body and >100 IDs → 400;
- unavailable store → 503;
- integrity error → generic 500 without SQL/token/content;
- success → 200 `{ memberships }`;
- `Cache-Control: no-store`.

Implement `createResearchMembershipRouter(config, service)`, mount it in `register.ts` at `/research-memberships`, and instantiate it from the **same** Pool created in `createS32Router`.

Run:

```bash
pnpm vitest run   apps/api/src/s32/application/research-memberships.test.ts   apps/api/src/s32/postgres/research-membership-store.test.ts   apps/api/src/s32/routes/research-membership-route.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit Task 2**

```bash
git add apps/api/src/s32/application/research-memberships.ts   apps/api/src/s32/application/research-memberships.test.ts   apps/api/src/s32/postgres/research-membership-store.ts   apps/api/src/s32/postgres/research-membership-store.test.ts   apps/api/src/s32/routes/research-membership-route.ts   apps/api/src/s32/routes/research-membership-route.test.ts   apps/api/src/s32/register.ts
git commit -m "feat(s32): add batch research membership read model"
```

---

### Task 3: Project Overview read model

**Files:**
- Create: `apps/api/src/s32/application/project-overview.ts`
- Create: `apps/api/src/s32/application/project-overview.test.ts`
- Create: `apps/api/src/s32/postgres/project-overview-store.ts`
- Create: `apps/api/src/s32/postgres/project-overview-store.test.ts`
- Create: `apps/api/src/s32/routes/project-overview-route.ts`
- Create: `apps/api/src/s32/routes/project-overview-route.test.ts`
- Modify: `apps/api/src/s32/register.ts`

**Interfaces:**
- Consumes: `readProjectId()`, `buildNoteExcerpt()`, and Project Overview types from Task 1.
- Produces: `ProjectOverviewStore.get(projectId: string): Promise<ProjectOverview | null>`.
- Produces: `createProjectOverviewService(store).get(projectId)`.
- Produces: `GET /api/private/s32/projects/:projectId/overview`.

- [ ] **Step 1: Write failing application tests**

Pin:
- malformed project ID is rejected by `readProjectId`;
- null store result becomes Project-not-found behavior at the route boundary;
- service passes normalized lowercase UUID to the store;
- returned projection is not mutated by the service.

Run:

```bash
pnpm vitest run apps/api/src/s32/application/project-overview.test.ts
```

Expected: RED.

- [ ] **Step 2: Implement the application contract**

Use:

```ts
export class ProjectOverviewStoreUnavailableError extends Error {}
export class ProjectOverviewIntegrityError extends Error {}

export interface ProjectOverviewStore {
  get(projectId: string): Promise<ProjectOverview | null>;
}

export function createProjectOverviewService(store: ProjectOverviewStore) {
  return {
    async get(projectInput: unknown) {
      const projectId = readProjectId(projectInput).toLowerCase();
      return store.get(projectId);
    },
  };
}
```

Run the application test to GREEN.

- [ ] **Step 3: Write failing store tests for fixed-query snapshot semantics**

Pin:
- transaction starts with `BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY`;
- Project query accepts ACTIVE and ARCHIVED and derives `readOnly = lifecycle_state === "ARCHIVED"`;
- item query is one statement regardless of item count;
- no Note → `noteSummary=null`, `activityAt=binding.created_at`;
- Note → excerpt from current revision, `activityAt=note.updated_at`;
- item order is activity descending, binding id descending;
- empty project → `0/0/null`;
- duplicate/malformed NOTE relation fails closed;
- current revision must belong to that Note and have valid revision number/content format/hash;
- `sourceId` and `catalogBookId` are read from Edition binding metadata only and may be null;
- no write SQL occurs.

Run:

```bash
pnpm vitest run apps/api/src/s32/postgres/project-overview-store.test.ts
```

Expected: RED.

- [ ] **Step 4: Implement the Overview store**

Use exactly two projection reads inside one read-only repeatable-read transaction:
1. Project row by id.
2. All EDITION bindings plus Work/Edition, possible NOTE binding, Note, and current revision rows.

The items query must include malformed NOTE relationships rather than filtering them away. Validate in TypeScript:
- each Edition binding has zero or one NOTE binding;
- NOTE `binding_role === "ANNOTATION"`;
- metadata matches exact subject binding/type/id;
- Note is `PROJECT_ITEM_NOTE`, lifecycle ACTIVE, and has current revision;
- current revision belongs to the Note and is MARKDOWN with valid SHA;
- current revision number is a positive safe integer.

Build `noteSummary.excerpt` only through `buildNoteExcerpt`.

Compute summary from the validated item array:

```ts
const itemCount = items.length;
const noteCount = items.filter((item) => item.noteSummary !== null).length;
const lastActivityAt = items[0]?.activityAt ?? null;
```

Map connection failures to `ProjectOverviewStoreUnavailableError`.

- [ ] **Step 5: Write and run Overview route tests**

Pin:
- `GET /:projectId/overview`;
- malformed UUID → 400;
- missing Project → 404;
- ACTIVE → 200 `readOnly:false`;
- ARCHIVED → 200 `readOnly:true`;
- unavailable store → 503;
- integrity failure → generic 500;
- auth/no-store behavior matches other private S32 routes.

Mount `createProjectOverviewRouter` under `/projects` before the generic project router.

Run:

```bash
pnpm vitest run   apps/api/src/s32/application/project-overview.test.ts   apps/api/src/s32/postgres/project-overview-store.test.ts   apps/api/src/s32/routes/project-overview-route.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit Task 3**

```bash
git add apps/api/src/s32/application/project-overview.ts   apps/api/src/s32/application/project-overview.test.ts   apps/api/src/s32/postgres/project-overview-store.ts   apps/api/src/s32/postgres/project-overview-store.test.ts   apps/api/src/s32/routes/project-overview-route.ts   apps/api/src/s32/routes/project-overview-route.test.ts   apps/api/src/s32/register.ts
git commit -m "feat(s32): add project rediscover overview"
```

---

### Task 4: Split ARCHIVED read access from write access

**Files:**
- Modify: `apps/api/src/s32/postgres/project-item-note-store.ts`
- Modify: `apps/api/src/s32/postgres/project-item-note-store.test.ts`
- Modify: `apps/api/src/s32/routes/project-item-note-routes.ts`
- Modify: `apps/api/src/s32/routes/project-item-note-routes.test.ts`
- Modify: `apps/api/src/s32/routes/project-item-routes.ts`
- Modify: `apps/api/src/s32/routes/project-item-routes.test.ts`

**Interfaces:**
- Existing M1-D read APIs gain ARCHIVED Project read access.
- Existing M1-C/M1-D write APIs remain ACTIVE-only.
- Produces consistent 409 lifecycle code `PROJECT_READ_ONLY` for write attempts against an archived Project.

- [ ] **Step 1: Add failing store tests for archived read/write split**

Refactor the note-store subject check to be driven by an explicit mode:

```ts
type SubjectAccess = "READ" | "WRITE";
```

Tests must prove:
- archived Project + active Edition + `get` succeeds;
- archived Project + active Edition + `getRevision` succeeds;
- archived Project + `create` rejects before any insert;
- archived Project + `appendRevision` rejects before any insert;
- ACTIVE behavior is unchanged;
- inactive/archived Edition remains rejected for both modes.

Run:

```bash
pnpm vitest run apps/api/src/s32/postgres/project-item-note-store.test.ts
```

Expected: RED.

- [ ] **Step 2: Implement explicit READ/WRITE subject access**

Change the helper contract to:

```ts
async function readSubject(
  client: PoolClient,
  input: SubjectInput,
  lock: boolean,
  access: SubjectAccess,
): Promise<Subject>
```

Rules:
- require the Edition binding and Edition to exist;
- require Edition lifecycle ACTIVE;
- for READ accept Project lifecycle ACTIVE or ARCHIVED;
- for WRITE require Project lifecycle ACTIVE;
- do not weaken Note lifecycle validation.

Call with READ from `get` and `getRevision`; WRITE from `create` and `appendRevision`.

Run the store test to GREEN.

- [ ] **Step 3: Pin explicit archived-write HTTP semantics**

Update route tests so archived write conflicts return:

```json
{
  "error": {
    "code": "PROJECT_READ_ONLY",
    "message": "项目已归档，只能查看研究资料和笔记。"
  }
}
```

Keep other inactive/integrity paths generic and unchanged.

For M1-C add/remove routes, map `ProjectNotActiveError` to the same 409 code/message because M0 Project lifecycle is ACTIVE/ARCHIVED only.

Run:

```bash
pnpm vitest run   apps/api/src/s32/routes/project-item-note-routes.test.ts   apps/api/src/s32/routes/project-item-routes.test.ts
```

Expected: PASS.

- [ ] **Step 4: Run the complete M1-D scoped API regression**

Run:

```bash
pnpm vitest run   apps/api/src/s32/domain/note.test.ts   apps/api/src/s32/application/project-item-notes.test.ts   apps/api/src/s32/postgres/project-item-note-store.test.ts   apps/api/src/s32/routes/project-item-note-routes.test.ts
```

Expected: PASS with no change to immutable/stale/NUL semantics.

- [ ] **Step 5: Commit Task 4**

```bash
git add apps/api/src/s32/postgres/project-item-note-store.ts   apps/api/src/s32/postgres/project-item-note-store.test.ts   apps/api/src/s32/routes/project-item-note-routes.ts   apps/api/src/s32/routes/project-item-note-routes.test.ts   apps/api/src/s32/routes/project-item-routes.ts   apps/api/src/s32/routes/project-item-routes.test.ts
git commit -m "feat(s32): allow archived project rediscovery reads"
```

---

### Task 5: Real PostgreSQL 16 proof for Rediscover and archive safety

**Files:**
- Create: `apps/api/src/s32/postgres/rediscover-store.integration.test.ts`
- Create: `scripts/s32-m1e-integration-check.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes the stores/services from Tasks 2–4.
- Produces `pnpm s32:m1e:check`.
- Uses an isolated loopback-only disposable PostgreSQL 16 database named `s32_m1e_test`.

- [ ] **Step 1: Write the real-PG integration suite**

Use the existing M1-C/M1-D fixture pattern to create real Project/Promotion/Binding/Note data. Cover at least these cases in one file:

```text
A. request [known, unknown, duplicate] → known memberships + explicit unknown [] at service layer
B. same Edition in two Projects → two memberships
C. ACTIVE + ARCHIVED Projects returned distinctly
D. current Note presence updates hasNote/noteUpdatedAt
E. non-SOURCE CATALOG_DOCUMENT identity → integrity failure
F. broken Source→Edition→Work chain → integrity failure
G. malformed or duplicate NOTE binding → integrity failure
H. Overview empty Project → 0/0/null
I. Overview item without Note → activityAt=addedAt
J. Overview current Note → excerpt/current revision/activityAt
K. Overview ordering recent activity then binding id
L. archived GET Note/current revision/history succeeds
M. archived add/create/append/remove all return/throw lifecycle conflict and row counts stay unchanged
N. no unrelated core/ops/derived writes
```

Use direct SQL only to create corruption/archive fixtures; product paths should create normal data.

- [ ] **Step 2: Create the disposable PG16 runner**

Mirror the M1-D safety controls:
- unique container name;
- owner label `book-id-search.s32-m1e-run=<name>`;
- `--rm`, 512 MiB memory, tmpfs PG data;
- random password;
- loopback random port only;
- apply only `db/migrations/001_s32_core_schema.sql`;
- export `S32_M1E_TEST_DATABASE_URL`;
- always verify owner label before force-removal.

The runner must execute:

```bash
vitest run --maxWorkers=1 apps/api/src/s32/postgres/rediscover-store.integration.test.ts
```

and print:

```text
S32_M1E_REAL_PG=PASS
DISPOSABLE_TEST_CONTAINER_REMOVED=YES
```

- [ ] **Step 3: Add the package script and verify RED→GREEN**

Add:

```json
"s32:m1e:check": "tsx scripts/s32-m1e-integration-check.ts"
```

Run:

```bash
pnpm s32:m1e:check
```

Expected: PASS and disposable container removed.

- [ ] **Step 4: Verify frozen SQL is unchanged**

Run:

```bash
git diff 414ee84f260d2bfae703956cbb879fbe76ab9c27 --   db/migrations/001_s32_core_schema.sql   db/tests/001_s32_schema_assertions.sql   db/tests/002_s32_negative_invariants.sql
```

Expected: no output.

- [ ] **Step 5: Commit Task 5**

```bash
git add apps/api/src/s32/postgres/rediscover-store.integration.test.ts   scripts/s32-m1e-integration-check.ts package.json
git commit -m "test(s32): prove M1E rediscover on postgres 16"
```

---

### Task 6: Typed Web API clients for Membership and Overview

**Files:**
- Modify: `apps/web/src/research/api.ts`
- Create: `apps/web/src/research/rediscover-api.test.ts`

**Interfaces:**
- Produces: `ResearchMembership`, `MembershipResponse`, `ProjectOverview`, and Overview item/note-summary Web types.
- Produces: `getResearchMemberships(token, bookIds, signal?)`.
- Produces: `getProjectOverview(token, projectId, signal?)`.
- Existing Project/Note client functions retain their signatures.

- [ ] **Step 1: Write failing runtime-validation tests**

Mock `fetch` and pin:
- membership POST path is `/api/private/s32/research-memberships/catalog-books`;
- request body is exactly `{ bookIds }`;
- response requires every requested key to exist and each value to be an array of valid memberships;
- ACTIVE/ARCHIVED are the only lifecycle values accepted;
- `noteUpdatedAt` is null or parseable date;
- malformed/missing membership key produces `ProjectApiError(502)`;
- Overview requires valid Project, summary, stable item shape, activity timestamps, and valid optional Note summary;
- archived Overview preserves `readOnly:true`;
- existing Note/project APIs still use the same auth/no-store request path.

Run:

```bash
pnpm vitest run apps/web/src/research/rediscover-api.test.ts
```

Expected: RED.

- [ ] **Step 2: Generalize the private S32 request root without changing existing callers’ behavior**

Change the internal root from a Projects-only constant to:

```ts
const S32_ROOT = "/api/private/s32";
```

Use absolute S32-relative paths such as:
- `/projects`
- `/projects/:id`
- `/research-memberships/catalog-books`

Keep `Authorization: Bearer`, `cache:"no-store"`, abort signal handling, status/error-code mapping, and DELETE 204 validation.

- [ ] **Step 3: Add exact client contracts**

Add:

```ts
export interface ResearchMembership {
  projectId: string;
  projectName: string;
  projectLifecycleState: "ACTIVE" | "ARCHIVED";
  bindingId: string;
  hasNote: boolean;
  noteUpdatedAt: string | null;
}

export type MembershipResponse = {
  memberships: Record<string, ResearchMembership[]>;
};

export const getResearchMemberships = (
  token: string,
  bookIds: string[],
  signal?: AbortSignal,
) => request<MembershipResponse>(
  token,
  "/research-memberships/catalog-books",
  { method: "POST", input: { bookIds }, signal },
  body => isMembershipResponse(body, bookIds),
);

export const getProjectOverview = (
  token: string,
  projectId: string,
  signal?: AbortSignal,
) => request<{ overview: ProjectOverview }>(
  token,
  `/projects/${encodeURIComponent(projectId)}/overview`,
  { signal },
  body => isProjectOverview(body.overview),
);
```

The runtime validators must fail closed rather than coerce malformed server payloads.

- [ ] **Step 4: Run Web API tests and existing Note API tests**

Run:

```bash
pnpm vitest run   apps/web/src/research/rediscover-api.test.ts   apps/web/src/research/note-api.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 6**

```bash
git add apps/web/src/research/api.ts apps/web/src/research/rediscover-api.test.ts
git commit -m "feat(web): add rediscover API clients"
```

---

### Task 7: Automatic Search membership, Project chips, and add refresh

**Files:**
- Create: `apps/web/src/research/SearchMemberships.tsx`
- Create: `apps/web/src/research/SearchMemberships.test.tsx`
- Modify: `apps/web/src/research/AddToProject.tsx`
- Modify: `apps/web/src/research/AddToProject.test.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/research/research.css`

**Interfaces:**
- Consumes: `useS32Token()`, `getResearchMemberships()`, and `ResearchMembership`.
- Produces: `useSearchMemberships(bookIds: string[])` returning `{ state, memberships, refresh }`.
- Produces: `ResearchMembershipChips` for one BookCard.
- `AddToProject` gains `memberships?: ResearchMembership[]` and `onMembershipInvalidated?: () => void`.

- [ ] **Step 1: Write hook/component tests before implementation**

Pin these states:
- no token → no request, `state="no-token"`;
- stable non-empty book IDs → exactly one batch request;
- duplicate book IDs are sent once;
- query/page result change aborts old request and late old resolution cannot overwrite new state;
- token change aborts old request;
- 401/403 → `auth-error`;
- 500/503/502 payload error → `unavailable`, never empty/ready;
- ACTIVE chips use “已在研究” and link to exact `?item=bindingId`;
- ARCHIVED chips use “曾用于研究”;
- ACTIVE shows first 2 and ARCHIVED first 1 before +N expansion;
- `refresh()` reruns exactly one current-page batch.

Run:

```bash
pnpm vitest run apps/web/src/research/SearchMemberships.test.tsx
```

Expected: RED.

- [ ] **Step 2: Implement centralized membership state**

Use one AbortController owned by the SearchPage-level hook. State must be:

```ts
type MembershipLoadState = "no-token" | "loading" | "ready" | "auth-error" | "unavailable";
```

The hook must:
- derive the request key from token + ordered unique current-page IDs + refresh version;
- clear stale memberships before a new request;
- abort in cleanup;
- ignore `AbortError`;
- convert 401/403 to auth-error and all other failures to unavailable;
- never synthesize `[]` on a failed request.

- [ ] **Step 3: Implement Project chips and degraded copy**

Render:
- ready + ACTIVE → “已在研究” chips;
- ready + ARCHIVED → “曾用于研究” chips;
- auth-error → “研究项目访问凭据已失效，请重新设置。”;
- unavailable → “研究状态暂不可用”;
- loading → compact “正在确认研究状态…”;
- no-token → no membership request/status copy beyond the existing AddToProject credential flow.

Chip href must be:

```ts
`/research/projects/${membership.projectId}?item=${encodeURIComponent(membership.bindingId)}`
```

- [ ] **Step 4: Make AddToProject membership-aware and test the refresh boundary**

Filter project choices by:
- lifecycle ACTIVE;
- not already present in `memberships` with lifecycle ACTIVE.

If zero ACTIVE candidates remain because every ACTIVE Project is already a membership, show:

```text
已加入全部现有研究项目
```

After successful `addCatalogBookToProject`:
1. retain the successful add acknowledgement;
2. call `onMembershipInvalidated`;
3. do not locally append a chip.

Add a test where POST resolves successfully and the subsequent membership refresh rejects. Expected UI:
- add remains successful;
- Search research state becomes unavailable;
- copy says “已加入项目；研究状态暂未能重新确认。”;
- no fake Project chip is fabricated.

- [ ] **Step 5: Integrate the hook once in SearchPage and pass projection state into BookCard**

In `SearchPage`:
- collect IDs from `data?.items ?? []`;
- invoke the hook once;
- pass each BookCard only its own membership array plus global state and refresh callback.

BookCard must not call the membership API.

Keep public Meili search loading/error independent: membership failure must not clear `data.items`.

- [ ] **Step 6: Run Search/Add tests**

Run:

```bash
pnpm vitest run   apps/web/src/research/SearchMemberships.test.tsx   apps/web/src/research/AddToProject.test.tsx   apps/web/src/research/research.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Commit Task 7**

```bash
git add apps/web/src/research/SearchMemberships.tsx   apps/web/src/research/SearchMemberships.test.tsx   apps/web/src/research/AddToProject.tsx   apps/web/src/research/AddToProject.test.tsx   apps/web/src/App.tsx   apps/web/src/research/research.css
git commit -m "feat(web): surface project memberships in search"
```

---

### Task 8: Project Overview UI, Note previews, deep-link focus, and archived read-only mode

**Files:**
- Modify: `apps/web/src/research/ProjectsPage.tsx`
- Modify: `apps/web/src/research/ProjectItems.tsx`
- Modify: `apps/web/src/research/ProjectItems.test.tsx`
- Modify: `apps/web/src/research/ProjectItemNote.tsx`
- Modify: `apps/web/src/research/ProjectItemNote.test.tsx`
- Modify: `apps/web/src/research/research.test.tsx`
- Modify: `apps/web/src/research/research.css`

**Interfaces:**
- Consumes: `getProjectOverview()` and its projection from Task 6.
- `ProjectItemNotePanel` gains `readOnly: boolean`.
- Project detail route consumes optional `item` query param as exact Edition ProjectBinding locator.

- [ ] **Step 1: Write failing Project Overview rendering tests**

Pin:
- Project detail loads `getProjectOverview` rather than separately fetching Project + items;
- header shows `itemCount`, `noteCount`, and last activity;
- zero items shows “尚无研究活动”;
- items appear in server-provided recent-research order;
- Note summary shows `研究笔记 · vN`, updated time, and server excerpt;
- no Note shows “尚未写研究笔记”;
- archived header shows “已归档 · 只读”.

Run:

```bash
pnpm vitest run apps/web/src/research/ProjectItems.test.tsx apps/web/src/research/research.test.tsx
```

Expected: RED.

- [ ] **Step 2: Convert Project detail loading to Overview**

For a detail route, `ProjectWorkspace` should perform one `getProjectOverview(token, projectId, signal)` request and render its Project + summary + item projection. Keep Project list/create behavior unchanged.

Do not add Overview summary to Project list cards in M1-E.

- [ ] **Step 3: Render Note preview and recent activity from Overview**

Each item card renders:
- canonical title/publisher/publication date/ISBN;
- `addedAt`;
- if `noteSummary !== null`: current version number, `updatedAt`, excerpt, and an “打开笔记” affordance;
- otherwise “尚未写研究笔记”.

Do not fetch full Note until the user opens the existing Note panel.

- [ ] **Step 4: Write failing read-only Note panel tests**

For `readOnly=true`:
- opening an existing Note still calls GET and displays current content/history;
- Edit button is absent;
- create form is never offered for no-Note;
- no POST Note or POST Revision can be triggered;
- history version GET remains available.

Run:

```bash
pnpm vitest run apps/web/src/research/ProjectItemNote.test.tsx
```

Expected: RED.

- [ ] **Step 5: Implement Note panel read-only behavior and archived material controls**

Add `readOnly` to the panel key/props. For archived Project:
- hide/disable “移出项目”;
- hide “写笔记”/Edit/Save affordances;
- keep “查看书目”, current Note read, and revision history.

The backend remains authoritative; the UI restriction is not the security boundary.

- [ ] **Step 6: Write and implement bindingId deep-link focus tests**

Use `useSearchParams` in the detail route. Pin:
- exact existing `item` finds only matching `bindingId`;
- call `scrollIntoView({ block: "center" })`;
- apply a focus CSS class and remove only the visual emphasis after about 5 seconds;
- keep the query parameter in the URL;
- do not auto-open Note or enter edit mode;
- missing binding renders “这项研究资料已不在当前项目中。”;
- no Edition/catalog fallback occurs.

Use a map of item refs keyed by bindingId rather than querying by title text.

- [ ] **Step 7: Add responsive/focus styles**

Add CSS classes for:
- ACTIVE/ARCHIVED membership chips;
- read-only badge;
- Note excerpt;
- focused material card.

At 390 px, cards/chips/buttons must wrap without horizontal overflow.

- [ ] **Step 8: Run the complete research Web suite**

Run:

```bash
pnpm vitest run apps/web/src/research
```

Expected: PASS.

- [ ] **Step 9: Commit Task 8**

```bash
git add apps/web/src/research/ProjectsPage.tsx   apps/web/src/research/ProjectItems.tsx   apps/web/src/research/ProjectItems.test.tsx   apps/web/src/research/ProjectItemNote.tsx   apps/web/src/research/ProjectItemNote.test.tsx   apps/web/src/research/research.test.tsx   apps/web/src/research/research.css
git commit -m "feat(web): add project rediscover overview"
```

---

### Task 9: Full scoped verification, browser acceptance, documentation, and one PR

**Files:**
- Modify: `docs/STATUS.md`
- Do not modify production compose/env/runtime files.

**Interfaces:**
- Produces one M1-E PR from the feature branch.
- Produces local verification receipts and browser evidence outside committed product source where the repo already ignores such artifacts.
- Leaves production unchanged and M2 not started.

- [ ] **Step 1: Run the complete S32 API scoped suite**

Run:

```bash
pnpm vitest run apps/api/src/s32
```

Record exact PASS/FAIL/SKIP counts. Do not relabel pre-existing unrelated failures as green.

- [ ] **Step 2: Run real PostgreSQL verification**

Run:

```bash
pnpm s32:m1e:check
```

Expected:
- `S32_M1E_REAL_PG=PASS`
- `DISPOSABLE_TEST_CONTAINER_REMOVED=YES`.

- [ ] **Step 3: Run Web research and existing search regression suites**

Run:

```bash
pnpm vitest run apps/web/src/research
pnpm vitest run apps/web/src
```

Record exact counts separately so research-specific evidence is not hidden by the broad suite.

- [ ] **Step 4: Build both products and check whitespace**

Run:

```bash
pnpm --filter @book-id-search/api build
pnpm --filter @book-id-search/web build
git diff --check
```

Expected: all PASS. Preserve any existing non-fatal Web bundle warning as a warning, not a failure.

- [ ] **Step 5: Re-run frozen schema guards**

Run:

```bash
pnpm s32:schema:static
git diff 414ee84f260d2bfae703956cbb879fbe76ab9c27 --   db/migrations/001_s32_core_schema.sql   db/tests/001_s32_schema_assertions.sql   db/tests/002_s32_negative_invariants.sql
```

Expected: static schema test PASS and diff empty.

- [ ] **Step 6: Execute real browser ACTIVE Rediscover acceptance**

With local Meili/search + local API/Web + the disposable/preserved **development** PG, prove:

```text
Search a real catalog book
→ add to “北京古道研究”
→ automatic membership refresh shows [北京古道研究]
→ open Project and create R1, then R2
→ return to Search and search the same book again
→ one automatic batch membership request shows the Project chip
→ click chip
→ URL has ?item=<exact bindingId>
→ exact card scrolls/highlights, Note is not auto-opened
→ card shows current v2, excerpt, updated time
→ open Note and read current R2 plus immutable R1 history
→ restart local API/PG while preserving the development volume
→ membership, Overview, current Note, and history are recovered from PostgreSQL
```

Capture screenshots/receipts under the established ignored Codex artifact/log path, not in the product commit.

- [ ] **Step 7: Execute real browser ARCHIVED Rediscover acceptance**

Archive only the dedicated test Project through direct development fixture SQL. Prove:

```text
Search the same book
→ chip moves to “曾用于研究”
→ click archived Project
→ “已归档 · 只读”
→ Overview/current Note/history remain readable
→ add/create/edit/remove controls are unavailable
→ direct API write attempts return 409 PROJECT_READ_ONLY
→ database row counts/content remain unchanged
```

Do not add archive/unarchive product UI.

- [ ] **Step 8: Run the broad repository test once and classify existing failures**

Run:

```bash
pnpm test
```

If the already-known unrelated failures/import error remain, record their exact count and unchanged provenance. Do not expand M1-E scope to fix unrelated suites unless M1-E changed the failing code/path.

- [ ] **Step 9: Update STATUS with an evidence boundary**

Record:
- source baseline and tested commit;
- scoped API/Web counts;
- real PG result;
- browser ACTIVE/ARCHIVED acceptance;
- build/diff/schema results;
- broad-suite known failures separately;
- `PRODUCTION_CHANGED=NO`;
- `PRODUCTION_DEPLOYED=NO`;
- `M2_STARTED=NO`.

- [ ] **Step 10: Commit final documentation**

```bash
git add docs/STATUS.md
git commit -m "docs(s32): record M1E verification"
```

- [ ] **Step 11: Open exactly one M1-E pull request**

PR title:

```text
feat(s32): complete M1 rediscover
```

PR body must list:
- baseline SHA;
- tested product commit;
- final head if docs-only commits followed;
- exact test/build/PG/browser evidence;
- known unrelated whole-suite failures separately;
- frozen SQL unchanged;
- production unchanged;
- M2 not started.

Do not merge the PR in this task.

- [ ] **Step 12: Synchronize the checkpoint**

Update:
- GitHub Issue #2 with the implementation/verification checkpoint;
- canonical M1-E Notion design page with a short implementation checkpoint;
- M1 overall page and project overview page.

Then read them back and verify the PR number/head/tested commit/state are consistent.

Final implementation checkpoint before code review must be:

```text
M1_E_IMPLEMENTATION=COMPLETE_ON_BRANCH
M1_E_PR=OPEN
M1_E_MERGED=NO
PRODUCTION_CHANGED=NO
PRODUCTION_DEPLOYED=NO
M2_STARTED=NO
NEXT_ACTION=REVIEW_M1_E_PR
```
