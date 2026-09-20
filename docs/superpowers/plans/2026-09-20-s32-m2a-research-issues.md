# S32 M2-A Research Issues Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Project-owned Research Issues with strict single-owner integrity, atomic/idempotent creation, independent Project-page loading, and a dedicated Issue Detail route.

**Architecture:** M2-A is a new S32 bounded context that uses the already-frozen `core.research_issues`, `core.project_bindings`, and `ops.idempotency_keys` tables. API reads use independent repeatable-read/read-only projections; create uses one transaction that serializes an Idempotency-Key, creates the Issue + owner binding atomically, and replays completed creates from canonical truth. The Web app loads Issues independently from M1-E Project Overview, keeps only a hashed pending-create receipt in sessionStorage, and navigates to a dedicated Issue Detail after confirmed create/replay.

**Tech Stack:** TypeScript 5.9, Express, PostgreSQL 16 / `pg`, React, React Router, Vitest, Testing Library, pnpm 10.33.

**Spec:** `docs/superpowers/specs/2026-09-20-s32-m2a-research-issues-design.md` at approved commit `35f3b422ad46972d0af8fcbd95e0d8d7d26b508e`.

## Global Constraints

- Source baseline at planning time: `main@4204815f8a550ad8ce9fa0ab7bdf4afe486f1e56`. At execution time fetch origin and record the actual main; do not blindly reset if main moved.
- M0 frozen SQL must remain byte-for-byte unchanged:
  - `db/migrations/001_s32_core_schema.sql`
  - `db/tests/001_s32_schema_assertions.sql`
  - `db/tests/002_s32_negative_invariants.sql`
- No schema migration. Use existing `core.research_issues`, `core.project_bindings`, and `ops.idempotency_keys`.
- Research Issue is Project-required and single-owner: exactly one global `ProjectBinding(target_type='RESEARCH_ISSUE')`.
- M2-A creates only `OPEN` Issues with `current_resolution_id=NULL`.
- Archived Project list/detail stay readable; genuinely new create returns 409 `PROJECT_READ_ONLY`.
- A previously completed same-key/same-hash create replays with HTTP 200 even if the Project is now archived.
- Same Idempotency-Key + different normalized payload returns 409 `IDEMPOTENCY_CONFLICT`; never silently mint a new key server-side or client-side.
- List/detail fail closed on orphan, multi-owner, dangling binding, malformed owner binding, or malformed Issue canonical data.
- Wrong-Project access to an otherwise valid Issue returns 404 without disclosing the owner Project.
- Issue list/detail are independent from M1-E Project Overview; one endpoint failing must not erase the other panel.
- Issue question card excerpt is runtime-only, max 160 Unicode code points, with `…` iff truncated.
- Private S32 auth and `Cache-Control: no-store` remain mandatory.
- No Claim, Evidence, Assessment, Resolution, ResearchRun, lifecycle mutation, Issue edit/delete/move/share, global Issue search, Issue↔Material direct binding, AI features, M2-B, production deploy, or production PostgreSQL changes.
- One implementation PR only. Do not merge in this plan.

## Review Focus

1. **Outcome-unknown create followed by Project archive:** same key/hash must replay the already-created Issue with 200; only a truly new reservation is blocked by `PROJECT_READ_ONLY`. Task 3 and Task 5 pin this.
2. **Same-key concurrency:** two concurrent requests must return the same Issue and grow the database by exactly one Issue, one owner binding, and one completed idempotency row. Task 5 pins this on real PostgreSQL 16.
3. **Dangling/ambiguous ownership:** a Project binding whose target Issue is missing, an orphan Issue, or a multi-owner Issue must fail closed rather than disappear from a list or become a false 404. Tasks 3 and 5 pin this.
4. **Independent Project-page degradation:** Issues 500/503 cannot hide valid Materials and Overview failure cannot hide valid Issues; only a confirmed `issues:[]` is empty. Task 7 pins this.
5. **Unicode + pending receipt boundaries:** title/question normalization, supplementary-plane 160/161 excerpt boundaries, and changed normalized payload vs same payload receipt reuse must not duplicate or corrupt an Issue. Tasks 1 and 6 pin this.

---

### Task 1: Research Issue domain contracts, normalization, excerpt, and request hash

**Files:**
- Create: `apps/api/src/s32/domain/research-issue.ts`
- Create: `apps/api/src/s32/domain/research-issue.test.ts`

**Interfaces:**
- Consumes: `readProjectId(id: unknown): string` from `domain/project.ts`.
- Produces:
  - `ResearchIssueLifecycle = "OPEN" | "RESOLVED" | "ARCHIVED"`
  - `ResearchIssueProjectContext`
  - `ResearchIssue`
  - `ResearchIssueSummary`
  - `ResearchIssueInput`
  - `InvalidResearchIssueInputError`
  - `InvalidIdempotencyKeyError`
  - `readResearchIssueInput(value: unknown): ResearchIssueInput`
  - `readResearchIssueId(value: unknown): string`
  - `readIdempotencyKey(value: unknown): string`
  - `buildResearchIssueQuestionExcerpt(question: string): string`
  - `hashResearchIssueCreateRequest(projectId: string, input: ResearchIssueInput): string`

- [ ] **Step 1: Write RED tests for canonical input**

Add tests that require:

```ts
expect(readResearchIssueInput({
  title: "  刘祥店迁出时间  ",
  question: "  第一行\r\n第二行\r第三行  ",
})).toEqual({
  title: "刘祥店迁出时间",
  question: "第一行\n第二行\n第三行",
});
```

Also require rejection of:
- non-object input;
- blank title/question;
- title containing `\r` or `\n`;
- title >160 Unicode code points;
- question >4000 Unicode code points;
- supplementary-plane characters counted as one code point.

- [ ] **Step 2: Run the domain test and verify RED**

Run:

```bash
pnpm vitest run apps/api/src/s32/domain/research-issue.test.ts
```

Expected: FAIL because the module/functions do not exist.

- [ ] **Step 3: Write RED tests for IDs, idempotency key, excerpt, and stable hash**

Pin:

```ts
expect(readResearchIssueId("AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"))
  .toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");

expect(readIdempotencyKey("BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB"))
  .toBe("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
```

Reject malformed UUIDs.

Excerpt cases:

```ts
expect(buildResearchIssueQuestionExcerpt("  第一行\r\n\t第二行  "))
  .toBe("第一行 第二行");

const exact = "𠮷".repeat(160);
expect(buildResearchIssueQuestionExcerpt(exact)).toBe(exact);
expect(buildResearchIssueQuestionExcerpt(exact + "甲"))
  .toBe(exact + "…");
```

Hash pin:

```ts
const input = readResearchIssueInput({
  title: " 刘祥店迁出时间 ",
  question: " 第一行\r\n第二行 ",
});
const hashA = hashResearchIssueCreateRequest(
  "11111111-1111-4111-8111-111111111111",
  input,
);
const hashB = hashResearchIssueCreateRequest(
  "11111111-1111-4111-8111-111111111111",
  { title: "刘祥店迁出时间", question: "第一行\n第二行" },
);
expect(hashA).toBe(hashB);
expect(hashA).toMatch(/^[0-9a-f]{64}$/);
```

- [ ] **Step 4: Implement the minimal domain module**

Use `node:crypto` for the server hash:

```ts
import { createHash } from "node:crypto";
import { readProjectId } from "./project.js";

export class InvalidResearchIssueInputError extends Error {}
export class InvalidIdempotencyKeyError extends Error {}

export type ResearchIssueLifecycle = "OPEN" | "RESOLVED" | "ARCHIVED";

export interface ResearchIssueProjectContext {
  id: string;
  name: string;
  lifecycleState: "ACTIVE" | "ARCHIVED";
  readOnly: boolean;
}

export interface ResearchIssue {
  id: string;
  projectId: string;
  title: string;
  question: string;
  lifecycleState: ResearchIssueLifecycle;
  createdAt: string;
  updatedAt: string;
}

export interface ResearchIssueSummary {
  id: string;
  projectId: string;
  title: string;
  questionExcerpt: string;
  lifecycleState: ResearchIssueLifecycle;
  createdAt: string;
  updatedAt: string;
}

export interface ResearchIssueInput {
  title: string;
  question: string;
}
```

Implement:
- title trim + single-line + code-point limit;
- question CRLF/CR normalization + trim + code-point limit;
- UUID lower-casing;
- excerpt with `/\s+/gu` and `Array.from`;
- canonical fixed-order hash payload:

```ts
const payload = JSON.stringify({
  projectId: readProjectId(projectId).toLowerCase(),
  title: input.title,
  question: input.question,
});
return createHash("sha256").update(payload, "utf8").digest("hex");
```

- [ ] **Step 5: Run domain tests GREEN**

Run the Task 1 test command again.

Expected: all Task 1 tests PASS.

- [ ] **Step 6: Commit Task 1**

```bash
git add apps/api/src/s32/domain/research-issue.ts apps/api/src/s32/domain/research-issue.test.ts
git commit -m "feat(s32): define research issue domain"
```

---

### Task 2: Research Issue application service and error contracts

**Files:**
- Create: `apps/api/src/s32/application/research-issues.ts`
- Create: `apps/api/src/s32/application/research-issues.test.ts`

**Interfaces:**
- Consumes Task 1 domain functions/types.
- Produces:
  - `ProjectReadOnlyError`
  - `ResearchIssueNotFoundError`
  - `ResearchIssueIntegrityError`
  - `ResearchIssueStoreUnavailableError`
  - `IdempotencyConflictError`
  - `ResearchIssueStore`
  - `createResearchIssuesService(store: ResearchIssueStore)`
  - service methods:
    - `create(projectId, idempotencyKey, body)`
    - `list(projectId)`
    - `get(projectId, issueId)`

Store contract:

```ts
export interface ResearchIssueStore {
  create(input: {
    projectId: string;
    issueId: string;
    idempotencyKey: string;
    requestHash: string;
    title: string;
    question: string;
  }): Promise<{
    status: "created" | "replayed";
    project: ResearchIssueProjectContext;
    issue: ResearchIssue;
  }>;

  list(projectId: string): Promise<{
    project: ResearchIssueProjectContext;
    issues: ResearchIssueSummary[];
  } | null>;

  get(projectId: string, issueId: string): Promise<{
    project: ResearchIssueProjectContext;
    issue: ResearchIssue;
  } | null>;
}
```

- [ ] **Step 1: Write RED application tests**

Use a fake `ResearchIssueStore` and assert:

```ts
await service.create(
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  { title: " 刘祥店迁出时间 ", question: " 第一行\r\n第二行 " },
);
```

calls store.create with:
- lowercase Project/key UUIDs;
- a generated Issue UUID;
- normalized title/question;
- 64-char deterministic requestHash.

Also test:
- malformed Project ID rejected before store;
- malformed idempotency key rejected before store;
- invalid body rejected before store;
- list lowercases/validates Project ID;
- get validates/lowers both IDs;
- same normalized body yields the same request hash but a fresh `issueId` only matters when the store is actually creating a new reservation.

- [ ] **Step 2: Verify RED**

Run:

```bash
pnpm vitest run apps/api/src/s32/application/research-issues.test.ts
```

Expected: FAIL because application module does not exist.

- [ ] **Step 3: Implement the application service**

Generate `issueId = randomUUID()` in the service, not the route.

Use Task 1 normalization/hash before calling the store:

```ts
async create(projectInput: unknown, keyInput: unknown, body: unknown) {
  const projectId = readProjectId(projectInput).toLowerCase();
  const idempotencyKey = readIdempotencyKey(keyInput);
  const input = readResearchIssueInput(body);
  return store.create({
    projectId,
    issueId: randomUUID(),
    idempotencyKey,
    requestHash: hashResearchIssueCreateRequest(projectId, input),
    ...input,
  });
}
```

Do not content-deduplicate title/question.

- [ ] **Step 4: Run application tests GREEN**

Expected: all Task 2 tests PASS.

- [ ] **Step 5: Commit Task 2**

```bash
git add apps/api/src/s32/application/research-issues.ts apps/api/src/s32/application/research-issues.test.ts
git commit -m "feat(s32): add research issue application service"
```

---

### Task 3: PostgreSQL Research Issue store — reads, single-owner integrity, and atomic idempotent create

**Files:**
- Create: `apps/api/src/s32/postgres/research-issue-store.ts`
- Create: `apps/api/src/s32/postgres/research-issue-store.test.ts`

**Interfaces:**
- Consumes Task 1 domain types/functions and Task 2 store/error contracts.
- Produces `createPostgresResearchIssueStore(pool: Pool): ResearchIssueStore`.
- Later Tasks 4 and 5 use this store unchanged.

- [ ] **Step 1: Write RED tests for list/detail read snapshots**

Build a fake Pool/PoolClient similar to `project-overview-store.test.ts`.

Pin:
- `BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY`;
- one Project query plus one Issues projection query;
- fixed query count regardless of number of Issues;
- explicit empty list;
- ordering OPEN → RESOLVED → ARCHIVED, then `updatedAt DESC`, then `id DESC`;
- detail returns full question;
- archived Project returns `readOnly:true`.

Use a Project row shape:

```ts
{
  id: projectId,
  name: "北京古道研究",
  lifecycle_state: "ACTIVE",
}
```

and Issue projection rows carrying:
- binding id/project/role/metadata;
- Issue columns;
- global owner count.

- [ ] **Step 2: Verify read tests RED**

Run:

```bash
pnpm vitest run apps/api/src/s32/postgres/research-issue-store.test.ts
```

Expected: FAIL because store does not exist.

- [ ] **Step 3: Implement read-only transaction helper and Project validation**

Implement a store-local helper mirroring M1-E behavior:

```ts
await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY");
...
await client.query("COMMIT");
```

Map PostgreSQL connection/unavailable errors to `ResearchIssueStoreUnavailableError`.

Project validation:
- name nonblank;
- lifecycle only ACTIVE/ARCHIVED;
- readOnly exactly archived.

- [ ] **Step 4: Implement list projection that cannot hide dangling bindings**

Use a projection whose driving table is the requested Project's `RESEARCH_ISSUE` bindings, with a LEFT JOIN to `core.research_issues` and a global owner-count CTE/subquery.

Required semantic shape:

```sql
WITH owner_counts AS (
  SELECT target_id AS issue_id, count(*)::int AS owner_count
  FROM core.project_bindings
  WHERE target_type = 'RESEARCH_ISSUE'
  GROUP BY target_id
)
SELECT
  pb.id AS binding_id,
  pb.project_id AS owner_project_id,
  pb.binding_role,
  pb.metadata AS binding_metadata,
  ri.id AS issue_id,
  ri.title,
  ri.question,
  ri.lifecycle_state,
  ri.created_at,
  ri.updated_at,
  oc.owner_count
FROM core.project_bindings pb
LEFT JOIN core.research_issues ri
  ON ri.id = pb.target_id
LEFT JOIN owner_counts oc
  ON oc.issue_id = pb.target_id
WHERE pb.project_id = $1
  AND pb.target_type = 'RESEARCH_ISSUE'
```

Application validation must fail the whole request if:
- `ri.id` is null (dangling binding);
- owner_count !== 1;
- owner_project_id !== requested Project;
- binding_role !== null;
- binding metadata is not an object;
- Issue canonical title/question/lifecycle is malformed.

Build `questionExcerpt` with Task 1 helper, never persistence.

- [ ] **Step 5: Implement detail projection from Issue row to all owner bindings**

Use a LEFT JOIN so an orphan Issue produces one Issue row with null owner binding rather than disappearing:

```sql
SELECT
  ri.id AS issue_id,
  ri.title,
  ri.question,
  ri.lifecycle_state,
  ri.created_at,
  ri.updated_at,
  pb.id AS binding_id,
  pb.project_id AS owner_project_id,
  pb.binding_role,
  pb.metadata AS binding_metadata
FROM core.research_issues ri
LEFT JOIN core.project_bindings pb
  ON pb.target_type = 'RESEARCH_ISSUE'
 AND pb.target_id = ri.id
WHERE ri.id = $1
ORDER BY pb.id
```

Semantics:
- no Issue row → null;
- Issue + zero binding → `ResearchIssueIntegrityError`;
- >1 binding → integrity error;
- exactly one valid binding owned by another Project → null (scoped 404);
- exactly one valid binding owned by requested Project → detail.

- [ ] **Step 6: Add RED integrity tests**

Pin:
- dangling Project binding → list rejects `ResearchIssueIntegrityError`;
- orphan direct Issue → detail rejects integrity error;
- multi-owner → list/detail rejects;
- non-null binding_role → rejects;
- metadata array/string → rejects;
- blank/CR title, CR question, oversized/canonical-invalid text, invalid lifecycle → rejects;
- valid Issue owned by another Project returns null instead of integrity failure.

- [ ] **Step 7: Write RED tests for create/idempotency transaction**

Fake the query sequence for these cases:
1. new idempotency reservation → ACTIVE Project lock → Issue insert → binding insert → owner verification → idempotency COMPLETED → commit → `status:"created"`;
2. same key/hash existing COMPLETED → no Project ACTIVE gate → reload canonical owner/Issue → `status:"replayed"`;
3. replay where Project is now ARCHIVED still returns replay;
4. same key/different hash → `IdempotencyConflictError`;
5. genuinely new reservation + archived Project → `ProjectReadOnlyError` and rollback;
6. missing Project → `ResearchIssueNotFoundError("PROJECT_NOT_FOUND")`;
7. existing unexpected IN_PROGRESS/FAILED row → integrity error;
8. completed row with wrong `resource_type`, null resource_id, missing resource, wrong owner, or corrupt Issue → integrity error.

- [ ] **Step 8: Implement atomic idempotent create**

Use `BEGIN` (read-write).

Reservation algorithm:

```sql
INSERT INTO ops.idempotency_keys
  (id, scope, idempotency_key, request_hash, status)
VALUES
  ($1, $2, $3, $4, 'IN_PROGRESS')
ON CONFLICT (scope, idempotency_key) DO NOTHING
RETURNING id
```

If no row was inserted, select the existing row `FOR UPDATE` after the conflict wait:

```sql
SELECT id, request_hash, status, resource_type, resource_id, result_payload
FROM ops.idempotency_keys
WHERE scope = $1 AND idempotency_key = $2
FOR UPDATE
```

For existing row:
- different hash → `IdempotencyConflictError`;
- require COMPLETED + RESEARCH_ISSUE + resource_id;
- canonical reload via Issue+owner Project;
- do **not** enforce ACTIVE;
- return `replayed`.

For newly inserted reservation:
- `SELECT id,name,lifecycle_state FROM core.projects WHERE id=$1 FOR UPDATE`;
- missing → Project-not-found error;
- ARCHIVED → `ProjectReadOnlyError`;
- insert Issue with `OPEN`, null current resolution, `metadata='{}'`;
- insert owner ProjectBinding with null role and `metadata='{}'`;
- verify exactly one global owner;
- complete idempotency row:

```sql
UPDATE ops.idempotency_keys
SET status='COMPLETED',
    resource_type='RESEARCH_ISSUE',
    resource_id=$2,
    result_payload=$3::jsonb,
    updated_at=now(),
    completed_at=now()
WHERE id=$1
```

Use a minimal deterministic payload such as `{"issueId":"..."}`, but replay must trust `resource_id` + canonical reload, not result_payload.

Any error rolls back reservation + Issue + binding together.

- [ ] **Step 9: Run the complete store test GREEN**

Run:

```bash
pnpm vitest run apps/api/src/s32/postgres/research-issue-store.test.ts
```

Expected: PASS.

- [ ] **Step 10: Commit Task 3**

```bash
git add apps/api/src/s32/postgres/research-issue-store.ts apps/api/src/s32/postgres/research-issue-store.test.ts
git commit -m "feat(s32): persist project research issues"
```

---

### Task 4: Private Research Issue HTTP routes and S32 registration

**Files:**
- Create: `apps/api/src/s32/routes/research-issue-routes.ts`
- Create: `apps/api/src/s32/routes/research-issue-routes.test.ts`
- Modify: `apps/api/src/s32/register.ts`

**Interfaces:**
- Consumes Task 2 service/errors and Task 3 Postgres store.
- Produces routes:
  - `POST /projects/:projectId/issues`
  - `GET /projects/:projectId/issues`
  - `GET /projects/:projectId/issues/:issueId`

- [ ] **Step 1: Write RED route tests for auth/no-store/config**

Follow `project-overview-route.test.ts`.

For each route, verify:
- disabled S32 → 404 before service;
- private token unconfigured → 503;
- missing token → 401;
- wrong token → 403;
- database/service missing → 503;
- `Cache-Control: no-store`.

- [ ] **Step 2: Write RED create route tests**

POST with header:

```http
Idempotency-Key: 22222222-2222-4222-8222-222222222222
```

Pin:
- service `status:"created"` → 201;
- `status:"replayed"` → 200;
- missing/malformed key → 400 before store;
- invalid body/IDs → 400;
- `ProjectReadOnlyError` → 409 + `PROJECT_READ_ONLY`;
- `IdempotencyConflictError` → 409 + `IDEMPOTENCY_CONFLICT`;
- Project missing → 404;
- unavailable → 503;
- integrity/unknown → generic 500 without internal text.

- [ ] **Step 3: Write RED list/detail route tests**

Pin:
- list direct response `{ project, issues }`;
- detail direct response `{ project, issue }`;
- explicit `issues:[]` remains 200;
- scoped missing Project/Issue → 404;
- wrong-Project service null → same generic 404;
- archived read response stays 200;
- integrity/unknown response contains no SQL/connection details.

- [ ] **Step 4: Implement router**

Mount private middleware exactly once for this router:
- auth;
- `Cache-Control: no-store`;
- DB/service availability.

Use `req.get("idempotency-key")` for create.

Map errors exactly to spec codes/status.

- [ ] **Step 5: Register service/store/router**

In `register.ts` add:

```ts
let researchIssues: ResearchIssuesService | null = null;
...
researchIssues = createResearchIssuesService(
  createPostgresResearchIssueStore(pool),
);
...
router.use(
  "/projects",
  createResearchIssueRouter(config, researchIssues),
);
```

Place the more specific Issue router before the generic `createProjectRouter`.

- [ ] **Step 6: Run API scoped tests**

Run:

```bash
pnpm vitest run   apps/api/src/s32/domain/research-issue.test.ts   apps/api/src/s32/application/research-issues.test.ts   apps/api/src/s32/postgres/research-issue-store.test.ts   apps/api/src/s32/routes/research-issue-routes.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit Task 4**

```bash
git add apps/api/src/s32/register.ts   apps/api/src/s32/routes/research-issue-routes.ts   apps/api/src/s32/routes/research-issue-routes.test.ts
git commit -m "feat(s32): expose private research issue api"
```

---

### Task 5: Real PostgreSQL 16 proof for M2-A atomicity, concurrency, integrity, and archive semantics

**Files:**
- Create: `apps/api/src/s32/postgres/research-issue-store.integration.test.ts`
- Create: `scripts/s32-m2a-integration-check.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes Tasks 1–4.
- Produces `pnpm s32:m2a:check`.
- Must use only frozen M0 migration.

- [ ] **Step 1: Write real-PG integration tests**

Require `S32_M2A_TEST_DATABASE_URL`; skip when absent so ordinary scoped suite does not need Docker.

Create helpers to insert ACTIVE/ARCHIVED Projects directly for fixtures.

Cover at least:

1. normal create:
   - 201-equivalent store result `created`;
   - +1 `core.research_issues`;
   - +1 `core.project_bindings`;
   - +1 COMPLETED idempotency row;
   - Issue is OPEN/current_resolution_id null.

2. same key/hash concurrent create:
   - invoke two `store.create()` promises concurrently with different generated `issueId` inputs but same key/hash;
   - both resolve to the same persisted `issue.id`;
   - one result may be `created` and the other `replayed`;
   - total row delta remains exactly +1/+1/+1.

3. same key/different hash:
   - `IdempotencyConflictError`;
   - no second Issue/binding.

4. response-unknown replay after Project archive:
   - create while ACTIVE;
   - set Project ARCHIVED directly;
   - same key/hash replay returns same Issue with project.readOnly=true;
   - a new key on the archived Project throws `ProjectReadOnlyError`.

5. rollback:
   - choose a known `issueId` for the direct store call;
   - before the call, insert a fixture `core.project_bindings` row with the same `(project_id, target_type='RESEARCH_ISSUE', target_id=issueId)` but no Issue row;
   - the store inserts the Issue and then its owner binding insert hits `uq_pb_triple`;
   - assert the transaction rolled back the newly inserted Issue and idempotency reservation while the pre-existing fixture binding is still the only binding;
   - delete the corrupt fixture binding in test cleanup.

6. ownership corruption:
   - orphan Issue detail → integrity error;
   - multi-owner Issue list/detail → integrity error;
   - dangling RESEARCH_ISSUE binding list → integrity error;
   - non-null binding_role → integrity error.

7. cross-Project privacy:
   - valid Issue owned by B queried through A → null/scoped 404 semantics.

8. canonical malformed Issue row:
   - blank/CR/invalid lifecycle fixture where the frozen constraints permit it → fail closed.

- [ ] **Step 2: Verify RED against missing/incomplete implementation if any**

Run directly with a disposable local PG manually or via the runner once created. Any case that unexpectedly passes before its enforcement exists must be checked for test weakness.

- [ ] **Step 3: Create disposable PG16 runner**

Mirror `scripts/s32-m1e-integration-check.ts` with M2-A-specific names:

- container name `s32-m2a-test-...`;
- label `book-id-search.s32-m2a-run=<name>`;
- random password;
- `127.0.0.1::5432`;
- tmpfs PG data;
- DB `s32_m2a_test`;
- apply only `db/migrations/001_s32_core_schema.sql`;
- run only `research-issue-store.integration.test.ts`;
- finally verify ownership label then force-remove container.

Success output must include:

```text
S32_M2A_REAL_PG=PASS
DISPOSABLE_TEST_CONTAINER_REMOVED=YES
```

- [ ] **Step 4: Add package script**

```json
"s32:m2a:check": "tsx scripts/s32-m2a-integration-check.ts"
```

Do not modify existing M1 scripts.

- [ ] **Step 5: Run real PG GREEN**

```bash
pnpm s32:m2a:check
```

Expected:
- all M2-A real-PG tests PASS;
- both success markers printed;
- no owned test container remains.

- [ ] **Step 6: Frozen schema guard**

Run:

```bash
git diff main --   db/migrations/001_s32_core_schema.sql   db/tests/001_s32_schema_assertions.sql   db/tests/002_s32_negative_invariants.sql
```

Expected: empty.

- [ ] **Step 7: Commit Task 5**

```bash
git add apps/api/src/s32/postgres/research-issue-store.integration.test.ts   scripts/s32-m2a-integration-check.ts package.json
git commit -m "test(s32): prove M2-A on real postgres"
```

---

### Task 6: Typed Web API client, canonical draft normalization, and pending idempotency receipt

**Files:**
- Modify: `apps/web/src/research/api.ts`
- Create: `apps/web/src/research/research-issues-api.test.ts`
- Create: `apps/web/src/research/research-issue-draft.ts`
- Create: `apps/web/src/research/research-issue-draft.test.ts`

**Interfaces:**
- Consumes Task 1 API/domain contract over HTTP.
- Produces Web types:
  - `ResearchIssueProjectContext`
  - `ResearchIssue`
  - `ResearchIssueSummary`
  - `ResearchIssueListResponse`
  - `ResearchIssueDetailResponse`
  - `createResearchIssue(token, projectId, key, input, signal?)`
  - `listResearchIssues(token, projectId, signal?)`
  - `getResearchIssue(token, projectId, issueId, signal?)`
- Produces draft helpers:
  - `normalizeResearchIssueDraft(input)`
  - `hashResearchIssueDraft(projectId, normalized)`
  - `loadPendingResearchIssueReceipt()`
  - `savePendingResearchIssueReceipt(receipt)`
  - `clearPendingResearchIssueReceipt()`
  - `getOrCreateResearchIssueReceipt(projectId, normalized, forceNew?)`

- [ ] **Step 1: Write RED API-client tests**

Pin:
- create sends only normalized body plus `Idempotency-Key` header;
- same-origin `/api/private/s32/projects/:projectId/issues`;
- path segments are encoded;
- AbortSignal is forwarded;
- 201 and 200 both validate same response shape;
- list requires `{project,issues:[]}`, not missing/malformed fields;
- detail requires full `question`;
- malformed success response throws response-abnormal error;
- `PROJECT_READ_ONLY` and `IDEMPOTENCY_CONFLICT` are surfaced as typed `ProjectApiError.code`;
- private server error details are not reflected.

- [ ] **Step 2: Modify request helper to accept explicit safe headers**

Extend `RequestOptions` with the narrow M2-A field:

```ts
type RequestOptions = {
  method?: "GET" | "POST" | "DELETE";
  input?: unknown;
  signal?: AbortSignal;
  idempotencyKey?: string;
};
```

When present, add exactly:

```ts
"Idempotency-Key": idempotencyKey
```

The option must not permit arbitrary caller headers or Authorization override.

Add `IDEMPOTENCY_CONFLICT` to `errorCodes`.

- [ ] **Step 3: Add strict runtime validators and typed methods**

Validators must reject:
- invalid UUID/date/lifecycle;
- `readOnly` inconsistent with Project lifecycle;
- list item containing full `question` instead of required `questionExcerpt` is allowed only if validator ignores extra fields, but required summary fields must exist;
- detail without full question;
- malformed `issues`.

- [ ] **Step 4: Write RED draft/receipt tests**

Pin the Web normalization to the server contract:
- title trim/single-line/160 code points;
- question CRLF/CR normalization/trim/4000 code points;
- stable SHA-256 of fixed-order `{projectId,title,question}`;
- supplementary-plane Unicode counts correctly.

Receipt cases:
- same Project + same normalized hash reuses same key;
- raw input differences that normalize identically reuse key;
- changed normalized payload gets a new key and overwrites old receipt;
- different Project gets new key;
- explicit `forceNew=true` gets new key;
- receipt stores only projectId/requestHash/idempotencyKey/createdAt;
- malformed sessionStorage JSON/shape is ignored;
- sessionStorage unavailable falls back safely to in-memory state, matching existing token-storage resilience.

- [ ] **Step 5: Implement Web draft/hash/receipt helper**

Use `crypto.subtle.digest("SHA-256", new TextEncoder().encode(...))` for browser hashing.

Use a dedicated key such as:

```ts
export const RESEARCH_ISSUE_PENDING_KEY =
  "book-id-search:s32-m2a-issue-create-v1";
```

Do not store title/question.

- [ ] **Step 6: Run Task 6 tests GREEN**

```bash
pnpm vitest run   apps/web/src/research/research-issues-api.test.ts   apps/web/src/research/research-issue-draft.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit Task 6**

```bash
git add apps/web/src/research/api.ts   apps/web/src/research/research-issues-api.test.ts   apps/web/src/research/research-issue-draft.ts   apps/web/src/research/research-issue-draft.test.ts
git commit -m "feat(web): add research issue client contracts"
```

---

### Task 7: Project-page Research Issues section, independent loading, and create/retry UX

**Files:**
- Create: `apps/web/src/research/ResearchIssues.tsx`
- Create: `apps/web/src/research/ResearchIssues.test.tsx`
- Modify: `apps/web/src/research/ProjectsPage.tsx`
- Modify: `apps/web/src/research/research.test.tsx`
- Modify: `apps/web/src/research/research.css`

**Interfaces:**
- Consumes Task 6 API and receipt helpers.
- Produces:
  - `useProjectResearchIssues(token, projectId)`
  - `ResearchIssuesSection`
- Parent `ProjectWorkspace` consumes the hook state independently from Overview.

Suggested hook result:

```ts
type ResearchIssuesLoad =
  | { state: "loading"; response: null; error: "" }
  | { state: "ready"; response: ResearchIssueListResponse; error: "" }
  | { state: "unavailable"; response: null; error: string };

function useProjectResearchIssues(token: string, projectId: string): {
  result: ResearchIssuesLoad;
  retry: () => void;
};
```

- [ ] **Step 1: Write RED hook tests for independent request lifecycle**

Pin:
- one list request on Project/token;
- Project/token change aborts old request and late response cannot overwrite new state;
- 200 `issues:[]` → ready empty;
- 500/503/malformed → unavailable, never empty;
- retry triggers exactly one new request.

- [ ] **Step 2: Write RED ProjectWorkspace integration tests**

Refactor the existing M1-E test assumptions.

Pin both requests are launched independently:

```text
GET /projects/:id/overview
GET /projects/:id/issues
```

Cases:
1. both succeed → Project header + Issues + Materials visible;
2. Overview fails, Issues succeeds → Project name from Issues context + Issues visible + Materials unavailable panel;
3. Issues fails, Overview succeeds → Materials visible + Issues unavailable panel;
4. Issues ready empty → “还没有研究问题”;
5. Issues 500 → never show “还没有研究问题”.

Do not use a shared `Promise.all` failure path.

- [ ] **Step 3: Implement independent state in ProjectWorkspace**

Keep separate attempts/controllers for Overview and Issues.

Do not let Note-save Overview invalidation trigger an Issues refetch.

Do not let Issues retry trigger an Overview refetch.

When rendering Project shell:
- use Overview Project when ready;
- otherwise use Issues Project context when Issues ready;
- if neither is ready, render per-panel loading/error states without inventing Project details.

- [ ] **Step 4: Write RED ResearchIssuesSection presentation tests**

Pin:
- section appears before “研究资料”;
- cards show lifecycle/title/questionExcerpt/updatedAt;
- OPEN→RESOLVED→ARCHIVED server order is preserved; frontend does not re-sort;
- ACTIVE Project shows create control;
- ARCHIVED Project shows no create control;
- archived list remains readable;
- question text renders as plain text, not HTML.

- [ ] **Step 5: Write RED create-form tests**

Pin:
- title/question constraints before POST;
- first submit gets/uses one receipt key;
- double-click/submitting cannot send two browser POSTs;
- confirmed 201/200 clears receipt and navigates exactly to `/research/projects/:projectId/issues/:issueId`;
- 500/503/network failure, client-side malformed-success 502, and dispatched-request abort enter unconfirmed state and keep the key because commit outcome is not proven;
- unchanged retry reuses same key;
- abort after dispatch keeps key;
- changing normalized payload causes a new key;
- `PROJECT_READ_ONLY` clears receipt and shows deterministic read-only error;
- `IDEMPOTENCY_CONFLICT` does **not** auto retry/new-key;
- explicit “作为新的研究问题重新提交” clears old receipt, generates a new key, and sends only after the user's click.

- [ ] **Step 6: Implement ResearchIssuesSection + create state machine**

Use states:

```ts
type CreateState =
  | "idle"
  | "submitting"
  | "unconfirmed"
  | "rejected"
  | "idempotency-conflict";
```

Before POST:
1. normalize draft;
2. compute hash;
3. get/reuse receipt;
4. send typed request with receipt key.

On confirmed 200/201:
- clear receipt;
- navigate to exact Issue Detail.

On outcome-unknown:
- preserve receipt and draft in component state;
- show text explaining retry is idempotent.

Do not optimistically append to Issues list.

- [ ] **Step 7: Add minimal responsive CSS**

Add classes only for:
- Issues section/list/cards;
- lifecycle badge;
- create form;
- unconfirmed/conflict notices.

Use existing research visual language; no redesign.

- [ ] **Step 8: Run Task 7 Web tests GREEN**

```bash
pnpm vitest run   apps/web/src/research/ResearchIssues.test.tsx   apps/web/src/research/research.test.tsx   apps/web/src/research/research-issue-draft.test.ts   apps/web/src/research/research-issues-api.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit Task 7**

```bash
git add apps/web/src/research/ResearchIssues.tsx   apps/web/src/research/ResearchIssues.test.tsx   apps/web/src/research/ProjectsPage.tsx   apps/web/src/research/research.test.tsx   apps/web/src/research/research.css
git commit -m "feat(web): add project research issues"
```

---

### Task 8: Dedicated Research Issue Detail route and read-only historical view

**Files:**
- Create: `apps/web/src/research/ResearchIssueDetail.tsx`
- Create: `apps/web/src/research/ResearchIssueDetail.test.tsx`
- Modify: `apps/web/src/research/ProjectsPage.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/research/research.css`

**Interfaces:**
- Consumes Task 6 `getResearchIssue` and existing `useS32Token`.
- Route:
  - `/research/projects/:projectId/issues/:issueId`
- Reuses `ProjectsPage` access/credential shell rather than creating a second token UI.

- [ ] **Step 1: Write RED detail component tests**

Pin:
- no request without token when rendered through existing access shell;
- exact GET path with encoded Project/Issue IDs;
- loading, ready, retryable unavailable states;
- Project/Issue change aborts old request and ignores late response;
- 404 copy: “研究问题不存在，或不属于当前项目。” with no owner leak;
- 500/503 copy: “研究问题暂不可用。”;
- archived Project detail is readable and shows “已归档 · 只读”;
- full question is displayed as plain text preserving internal newlines;
- createdAt/updatedAt visible;
- “可能答案” empty state explicitly says Claims come in a later stage;
- no Materials/Notes fetch occurs.

- [ ] **Step 2: Add route to App**

```tsx
<Route
  path="/research/projects/:projectId/issues/:issueId"
  element={<ProjectsPage />}
/>
```

In `ProjectsPage`, read `issueId` from params.

When `projectId && issueId` and token exists, render `ResearchIssueDetail`.

When only `projectId`, render normal `ProjectWorkspace`.

- [ ] **Step 3: Implement detail UI**

Required navigation:
- back link uses Project name from Issue detail response and points to `/research/projects/:projectId`;
- ordinary “返回项目资料” link to same Project route.

Do not load Overview.

- [ ] **Step 4: Document title behavior**

Set page title after detail loads, e.g.:

```text
刘祥店迁出时间 · BOOK-ID-SEARCH
```

Restore previous title on unmount; while loading use a generic “研究问题 · BOOK-ID-SEARCH”.

- [ ] **Step 5: Run Task 8 tests GREEN**

```bash
pnpm vitest run   apps/web/src/research/ResearchIssueDetail.test.tsx   apps/web/src/research/ResearchIssues.test.tsx   apps/web/src/research/research.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit Task 8**

```bash
git add apps/web/src/research/ResearchIssueDetail.tsx   apps/web/src/research/ResearchIssueDetail.test.tsx   apps/web/src/research/ProjectsPage.tsx   apps/web/src/App.tsx   apps/web/src/research/research.css
git commit -m "feat(web): add research issue detail"
```

---

### Task 9: Full scoped verification, real browser acceptance, status docs, and one PR

**Files:**
- Modify: `docs/STATUS.md`
- Modify: `AGENTS.md`
- No product expansion beyond Tasks 1–8.

**Interfaces:**
- Consumes all prior tasks.
- Produces one open PR titled `feat(s32): add project research issues`.
- Does not merge or deploy.

- [ ] **Step 1: Run full API S32 scoped suite**

```bash
pnpm vitest run apps/api/src/s32
```

Expected: all M2-A/M1 scoped tests PASS; record exact pass/skip counts.

- [ ] **Step 2: Run real PostgreSQL M2-A suite**

```bash
pnpm s32:m2a:check
```

Expected:
- integration tests PASS;
- `S32_M2A_REAL_PG=PASS`;
- `DISPOSABLE_TEST_CONTAINER_REMOVED=YES`.

- [ ] **Step 3: Run Web research scoped suite**

```bash
pnpm vitest run apps/web/src/research
```

Expected: PASS; record exact count.

- [ ] **Step 4: Run broad Web suite**

```bash
pnpm vitest run apps/web/src
```

Expected: PASS; record exact count.

- [ ] **Step 5: Build and static schema checks**

```bash
pnpm --filter @book-id-search/api build
pnpm --filter @book-id-search/web build
pnpm s32:schema:static
git diff --check
```

Expected: PASS. Existing non-fatal Web chunk-size warning may remain but must be reported, not relabeled away.

- [ ] **Step 6: Prove frozen SQL unchanged**

```bash
git diff main --   db/migrations/001_s32_core_schema.sql   db/tests/001_s32_schema_assertions.sql   db/tests/002_s32_negative_invariants.sql
```

Expected: empty.

- [ ] **Step 7: Run real browser ACTIVE acceptance**

Use the local dev stack with persistent development PostgreSQL, not production.

Complete:

```text
open ACTIVE Project
→ Research Issues section appears before Materials
→ create “刘祥店迁出时间”
→ confirmed create navigates to exact Issue Detail
→ OPEN + full question + Project back-nav visible
→ return to Project
→ Issue card appears from canonical list
→ questionExcerpt is correct
→ refresh Issue Detail
→ still loads from PostgreSQL
```

Record Issue id and Idempotency-Key only in ignored local evidence, never committed secrets.

- [ ] **Step 8: Browser response-unknown/idempotency acceptance**

With browser/network interception or a local test proxy that does not modify committed product code:
- allow POST to reach server and commit but make the browser observe an unknown/lost response;
- retry unchanged draft from the unconfirmed UI;
- verify the same Idempotency-Key is reused;
- verify navigation recovers the already-created Issue;
- verify only one Issue + one owner binding exists.

This is a required M2-A acceptance gate. If the available browser tooling cannot produce a post-commit lost-response condition, stop before opening the PR and report `BLOCKED_ON_RESPONSE_UNKNOWN_BROWSER_ACCEPTANCE`; do not substitute unit tests for this browser requirement.

- [ ] **Step 9: Browser ARCHIVED acceptance**

Using a local fixture/direct dev SQL, archive the test Project after at least one Issue exists.

Verify:
- Project Issues list remains readable;
- Issue Detail remains readable and read-only;
- create UI absent;
- direct POST with a new key returns 409 `PROJECT_READ_ONLY`;
- direct replay of the already completed old key/hash returns 200 same Issue;
- no Issue/binding count changes from rejected new create.

Restore fixture Project to ACTIVE afterward.

- [ ] **Step 10: Browser independent degradation acceptance**

Using request interception:
1. force `/issues` to 503 while Overview works → Materials remain visible and Issues show unavailable/retry;
2. force `/overview` to 503 while Issues works → Issues + Project shell remain visible and Materials show unavailable/retry;
3. restore both → page recovers.

Do not accept an empty-state rendering for forced 503.

- [ ] **Step 11: 390px mobile acceptance**

Real Firefox at width 390px:
- Project Issues section: `scrollWidth === clientWidth === 390`;
- create form: no horizontal overflow;
- Issue Detail: no horizontal overflow.

- [ ] **Step 12: Restart persistence acceptance**

With the local development PG volume preserved:
- restart API + PG/container as appropriate;
- reload Project Issues list and Issue Detail;
- existing Issue remains;
- replay of the known completed key returns same Issue.

No production host is accessed.

- [ ] **Step 13: Run whole repository suite exactly once**

```bash
pnpm test
```

Record exact pass/skip/fail/error counts.

Known historical unrelated baseline before M2-A:
- 15 WeRead cwd-related failures;
- 1 CLI-import error from `apply-match-review.ts`.

If these remain exactly unchanged, report them as known unrelated evidence. If there is any new/changed S32/M2-A failure, stop and fix before PR.

Never call a red whole-suite “green”.

- [ ] **Step 14: Update status documentation**

Update `docs/STATUS.md` to current M2-A branch state and correct the stale pre-merge M1-E text.

Update `AGENTS.md` stage line so it describes M2-A as the current local implemented stage and preserves:
- frozen SQL guard;
- no production changes;
- no M2-B;
- one-writer-per-worktree / Native preference.

Do **not** include unrelated cleanup of `.github/workflows/s32-m1e-branch-check.yml` in this feature PR; it remains a separate cleanup concern.

- [ ] **Step 15: Commit final docs/evidence metadata**

```bash
git add docs/STATUS.md AGENTS.md
git commit -m "docs(s32): record M2-A verification"
```

- [ ] **Step 16: Final whole-branch diff review**

Run:

```bash
git status --short
git diff --stat main...HEAD
git diff --check main...HEAD
git log --oneline main..HEAD
```

Confirm:
- only M2-A files/docs;
- no frozen SQL;
- no production config;
- no M2-B;
- no secrets/private browser evidence.

- [ ] **Step 17: Push feature branch and open exactly one PR**

Branch:

```text
feat/s32-m2a-research-issues
```

PR title:

```text
feat(s32): add project research issues
```

PR body must include:
- source baseline;
- approved spec commit `35f3b422...`;
- tested commit/final head;
- API/Web/PG/browser/build counts;
- known unrelated whole-suite failures separately;
- `MERGED=NO`;
- `DEPLOYED=NO`;
- `PRODUCTION_CHANGED=NO`;
- `M2_B_STARTED=NO`.

Do not merge.

- [ ] **Step 18: Sync GitHub Issue #2 and Notion**

Update/read back:
- GitHub Issue #2;
- M2-A design page;
- M2-A Implementation Plan page;
- M1/M2 project overview page.

Use the same task id, tested commit, final head, and PR URL everywhere.

Final checkpoint:

```text
M2_A_IMPLEMENTATION=COMPLETE_ON_BRANCH
M2_A_PR=OPEN
M2_A_MERGED=NO
PRODUCTION_CHANGED=NO
PRODUCTION_DEPLOYED=NO
M2_B_STARTED=NO
NEXT_ACTION=REVIEW_M2_A_PR
```

- [ ] **Step 19: Stop**

Do not merge PR, deploy, touch Tencent production PostgreSQL, clean/expand production disk, publish images, or start M2-B without a new explicit gate.
