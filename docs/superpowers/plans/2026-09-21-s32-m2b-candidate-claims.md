# S32 M2-B Candidate Claims Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Repository `AGENTS.md` requires Native execution; do not use another agent as a command relay.

**Goal:** Add Issue-scoped competing Candidate Claims so an existing Research Issue can list and safely create immutable possible answers without introducing Evidence, Assessment, Resolution, schema changes, or production changes.

**Architecture:** Add a focused Candidate Claim domain/application/store/router stack beside the existing M2-A Research Issue stack. Claims use only the frozen `core.claims` and `core.research_issue_claims` tables; Project/Issue authorization is validated through the existing M2-A ownership model, while Claim create/replay uses a Project+Issue-scoped idempotency reservation. The Web layer adds a strict Claim API client, a separate three-state pending receipt module, and a separately degradable Claims section inside Issue Detail.

**Tech Stack:** TypeScript 5.9, Node.js, Express, PostgreSQL 16, `pg`, React, React Router, Vitest 4, Testing Library, jsdom, pnpm 10, Docker for disposable PostgreSQL integration.

**Spec:** `docs/superpowers/specs/2026-09-21-s32-m2b-candidate-claims-design.md` at approved commit `98e521c1962ef9c6152badef541ac3ab1fa1bd99`.

## Global Constraints

- Approved source baseline at planning time is `main@beb3888600c6c9520624093da00619d74a15d68f`. At execution start, fetch `origin/main`; if it advanced, compare the delta and record `ACTUAL_SOURCE_BASELINE`. Do not blind reset or discard user work.
- Work in a new isolated local worktree and feature branch. Recommended worktree: `/home/conanxin/codex-projects/book-id-search-s32-m2b`; recommended branch: `feat/s32-m2b-candidate-claims`.
- Read the root `AGENTS.md` before edits. One writer per worktree. Native execution only.
- Do not modify `db/migrations/001_s32_core_schema.sql`, `db/tests/001_s32_schema_assertions.sql`, or `db/tests/002_s32_negative_invariants.sql`.
- Do not add canonical tables, columns, enum values, PostgreSQL extensions, or migrations.
- M2-B uses only `core.claims`, `core.research_issue_claims`, existing `core.projects`, existing `core.research_issues`, existing `core.project_bindings`, and `ops.idempotency_keys`.
- Claim means candidate proposition only. Do not add truth, support/reject, confidence, probability, preferred-answer, Assessment, Evidence, IssueResolution, or ResearchRun semantics.
- New M2-B Claims write `claim_type=NULL`, `subject_type=NULL`, `subject_id=NULL`, `lifecycle_state='ACTIVE'`, `metadata={}`.
- Claim statement identity is immutable. No PATCH/edit/delete/archive Claim API or UI in M2-B.
- Do not semantically deduplicate Claims by statement text and do not add attach-existing-Claim or global Claim search.
- New Claim creation requires ACTIVE Project + OPEN Issue. Reads remain allowed for ACTIVE/ARCHIVED Project and OPEN/RESOLVED/ARCHIVED Issue.
- POST idempotency scope is exactly `S32:M2B:PROJECT_ISSUE_CLAIM_CREATE:<projectId>:<issueId>`.
- Completed same-key/same-hash replay must still return 200 after Project or Issue later becomes read-only.
- Web pending receipt persists only `projectId`, `issueId`, `requestHash`, `idempotencyKey`, `createdAt`; never persist statement text.
- Preserve the M2-A three-state page-local receipt authority model: `undefined` = not restored, receipt = current pending intent, `null` = explicit clear tombstone.
- No Tencent/production access, production database change, container change, deployment, cleanup, image publication, or M2-C work.
- Keep `docs/STATUS.md` short; detailed execution evidence belongs in ignored `logs/` or `progress/`.
- One M2-B implementation PR only. Do not merge it as part of implementation.

## File Structure

New API files:
- `apps/api/src/s32/domain/candidate-claim.ts`
- `apps/api/src/s32/domain/candidate-claim.test.ts`
- `apps/api/src/s32/application/candidate-claims.ts`
- `apps/api/src/s32/application/candidate-claims.test.ts`
- `apps/api/src/s32/postgres/candidate-claim-store.ts`
- `apps/api/src/s32/postgres/candidate-claim-store.test.ts`
- `apps/api/src/s32/postgres/candidate-claim-store.integration.test.ts`
- `apps/api/src/s32/routes/candidate-claim-routes.ts`
- `apps/api/src/s32/routes/candidate-claim-routes.test.ts`

Modified API file:
- `apps/api/src/s32/register.ts`

New Web files:
- `apps/web/src/research/candidate-claim-draft.ts`
- `apps/web/src/research/candidate-claim-draft.test.ts`
- `apps/web/src/research/candidate-claims-api.test.ts`
- `apps/web/src/research/CandidateClaims.tsx`
- `apps/web/src/research/CandidateClaims.test.tsx`

Modified Web files:
- `apps/web/src/research/api.ts`
- `apps/web/src/research/ResearchIssueDetail.tsx`
- `apps/web/src/research/ResearchIssueDetail.test.tsx`
- `apps/web/src/research/research.css`

Integration/docs:
- `scripts/s32-m2b-integration-check.ts`
- `package.json`
- `AGENTS.md`
- `docs/STATUS.md`

## Review Focus

The whole-branch reviewer must deliberately inspect these failure classes even if normal tests pass:

1. **Completed replay after lifecycle drift:** replay returns the original Claim after Project→ARCHIVED or Issue→RESOLVED/ARCHIVED, while a genuinely new key is rejected.
2. **Cross-Project privacy with idempotency:** Project+Issue scope and ownership validation never disclose another Project's Issue/Claim or collide with its namespace.
3. **Historical/global Claim compatibility:** GET accepts legitimate canonical Claims whose `claim_type` or subject fields are non-null; only M2-B-created Claim verification requires the NULL shape.
4. **Dangling relation fail-closed:** corrupted `research_issue_claims` with missing Claim becomes integrity failure, never a silently shortened list.
5. **Browser storage asymmetry:** stale valid storage + failed write, failed remove, and restored-then-read-failure preserve the current page-local retry key.

---

### Task 1: Candidate Claim domain contract

**Files:**
- Create: `apps/api/src/s32/domain/candidate-claim.ts`
- Create: `apps/api/src/s32/domain/candidate-claim.test.ts`

**Interfaces:**
- Consumes `readProjectId` and `readResearchIssueId`.
- Produces:
  - `CandidateClaimLifecycle = "ACTIVE" | "ARCHIVED"`
  - `CandidateClaim`
  - `InvalidCandidateClaimInputError`
  - `normalizeCandidateClaimStatement(value)`
  - `readCandidateClaimId(value)`
  - `hashCandidateClaimCreateRequest(projectId, issueId, statement)`

- [ ] **Step 1: Write the failing domain tests**

```ts
import { describe, expect, it } from "vitest";
import {
  InvalidCandidateClaimInputError,
  hashCandidateClaimCreateRequest,
  normalizeCandidateClaimStatement,
  readCandidateClaimId,
} from "./candidate-claim.js";

const projectId = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
const issueId = "BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB";

describe("candidate claim domain", () => {
  it("canonicalizes CR/LF and Unicode White_Space to one ASCII space", () => {
    expect(normalizeCandidateClaimStatement("\u0085  刘祥店\r\n在 1960 年代\t整体迁出。  \u0085"))
      .toBe("刘祥店 在 1960 年代 整体迁出。");
  });

  it("rejects NUL, blank, non-string, and more than 4000 code points", () => {
    expect(() => normalizeCandidateClaimStatement("a\u0000b")).toThrow(InvalidCandidateClaimInputError);
    expect(() => normalizeCandidateClaimStatement("\u0085 \t")).toThrow(InvalidCandidateClaimInputError);
    expect(() => normalizeCandidateClaimStatement(1)).toThrow(InvalidCandidateClaimInputError);
    expect(() => normalizeCandidateClaimStatement("𠮷".repeat(4001))).toThrow(InvalidCandidateClaimInputError);
    expect(normalizeCandidateClaimStatement("𠮷".repeat(4000))).toBe("𠮷".repeat(4000));
  });

  it("normalizes Claim IDs to lowercase UUIDs", () => {
    expect(readCandidateClaimId("CCCCCCCC-CCCC-4CCC-8CCC-CCCCCCCCCCCC"))
      .toBe("cccccccc-cccc-4ccc-8ccc-cccccccccccc");
    expect(() => readCandidateClaimId("bad")).toThrow(InvalidCandidateClaimInputError);
  });

  it("hashes lowercase Project+Issue and normalized statement in fixed key order", () => {
    const a = hashCandidateClaimCreateRequest(projectId, issueId, "\u0085 A\r\n B \u0085");
    const b = hashCandidateClaimCreateRequest(projectId.toLowerCase(), issueId.toLowerCase(), "A B");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(b);
    expect(a).not.toBe(hashCandidateClaimCreateRequest(
      projectId,
      "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      "A B",
    ));
  });
});
```

- [ ] **Step 2: Run RED**

```bash
pnpm exec vitest run apps/api/src/s32/domain/candidate-claim.test.ts --maxWorkers=1
```

Expected: FAIL because the module is absent.

- [ ] **Step 3: Implement the minimal domain module**

```ts
import { createHash } from "node:crypto";
import { readProjectId } from "./project.js";
import { readResearchIssueId } from "./research-issue.js";

export class InvalidCandidateClaimInputError extends Error {}
export type CandidateClaimLifecycle = "ACTIVE" | "ARCHIVED";

export interface CandidateClaim {
  id: string;
  statement: string;
  lifecycleState: CandidateClaimLifecycle;
  createdAt: string;
  updatedAt: string;
}

const uuidPattern = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

export function normalizeCandidateClaimStatement(value: unknown): string {
  if (typeof value !== "string") throw new InvalidCandidateClaimInputError("可能答案必须是文本。");
  if (value.includes("\u0000")) throw new InvalidCandidateClaimInputError("可能答案包含不支持的字符。");
  const normalized = value
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\p{White_Space}+/gu, " ")
    .replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");
  const length = Array.from(normalized).length;
  if (length < 1 || length > 4000) {
    throw new InvalidCandidateClaimInputError("可能答案必须是 1 至 4000 个字符的文本。");
  }
  return normalized;
}

export function readCandidateClaimId(value: unknown): string {
  if (typeof value !== "string" || !uuidPattern.test(value)) {
    throw new InvalidCandidateClaimInputError("Claim ID 格式不正确。");
  }
  return value.toLowerCase();
}

export function hashCandidateClaimCreateRequest(projectId: string, issueId: string, statement: string): string {
  const payload = JSON.stringify({
    projectId: readProjectId(projectId).toLowerCase(),
    issueId: readResearchIssueId(issueId),
    statement: normalizeCandidateClaimStatement(statement),
  });
  return createHash("sha256").update(payload, "utf8").digest("hex");
}
```

- [ ] **Step 4: Run GREEN**

```bash
pnpm exec vitest run apps/api/src/s32/domain/candidate-claim.test.ts --maxWorkers=1
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/s32/domain/candidate-claim.ts apps/api/src/s32/domain/candidate-claim.test.ts
git commit -m "feat(s32): define candidate claim domain"
```

---

### Task 2: Candidate Claim application service

**Files:**
- Create: `apps/api/src/s32/application/candidate-claims.ts`
- Create: `apps/api/src/s32/application/candidate-claims.test.ts`

**Interfaces:**
- Consumes Task 1 domain functions plus existing `readProjectId`, `readResearchIssueId`, `readIdempotencyKey`.
- Produces `CandidateClaimStore`, `createCandidateClaimsService`, and typed Claim errors.

Store interface:

```ts
export interface CandidateClaimStore {
  list(projectId: string, issueId: string): Promise<{ claims: CandidateClaim[] } | null>;
  create(input: {
    projectId: string;
    issueId: string;
    claimId: string;
    idempotencyKey: string;
    requestHash: string;
    statement: string;
  }): Promise<{ status: "created" | "replayed"; claim: CandidateClaim }>;
}
```

Typed errors:

```ts
export class ResearchIssueReadOnlyError extends Error {}
export class CandidateClaimScopeNotFoundError extends Error {}
export class CandidateClaimIntegrityError extends Error {}
export class CandidateClaimStoreUnavailableError extends Error {}
```

Reuse M2-A `ProjectReadOnlyError` and `IdempotencyConflictError`.

- [ ] **Step 1: Write failing application tests**

Pin:

- upper-case Project/Issue/key normalize before store;
- statement canonicalizes before store;
- generated Claim ID is UUID;
- request hash is lowercase 64-hex;
- malformed Project/Issue/key/body/statement reject before store;
- list normalizes identifiers.

- [ ] **Step 2: Run RED**

```bash
pnpm exec vitest run apps/api/src/s32/application/candidate-claims.test.ts --maxWorkers=1
```

- [ ] **Step 3: Implement service**

Core create flow:

```ts
async create(projectInput: unknown, issueInput: unknown, keyInput: unknown, body: unknown) {
  const projectId = readProjectId(projectInput).toLowerCase();
  const issueId = readResearchIssueId(issueInput);
  const idempotencyKey = readIdempotencyKey(keyInput);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new InvalidCandidateClaimInputError("可能答案输入必须是对象。");
  }
  const statement = normalizeCandidateClaimStatement((body as Record<string, unknown>).statement);
  return store.create({
    projectId,
    issueId,
    claimId: randomUUID(),
    idempotencyKey,
    requestHash: hashCandidateClaimCreateRequest(projectId, issueId, statement),
    statement,
  });
}
```

List delegates normalized IDs.

- [ ] **Step 4: Run Task 1+2 GREEN**

```bash
pnpm exec vitest run   apps/api/src/s32/domain/candidate-claim.test.ts   apps/api/src/s32/application/candidate-claims.test.ts   --maxWorkers=1
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/s32/application/candidate-claims.ts apps/api/src/s32/application/candidate-claims.test.ts
git commit -m "feat(s32): add candidate claim service"
```

---

### Task 3: PostgreSQL Candidate Claim store

**Files:**
- Create: `apps/api/src/s32/postgres/candidate-claim-store.ts`
- Create: `apps/api/src/s32/postgres/candidate-claim-store.test.ts`

**Interfaces:**
- Consumes Task 2 `CandidateClaimStore` and typed errors.
- Produces `createPostgresCandidateClaimStore(pool: Pool): CandidateClaimStore`.

- [ ] **Step 1: Write failing store contract tests**

Using the mocked Pool/PoolClient style from `research-issue-store.test.ts`, pin:

1. list starts `BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY`;
2. Project and exact Issue ownership are validated before Claims;
3. Claim list is relation-first with `LEFT JOIN core.claims`;
4. missing Claim columns on a relation row cause `CandidateClaimIntegrityError`;
5. legitimate future/global Claim with non-null type/subject remains readable;
6. idempotency scope is exactly `S32:M2B:PROJECT_ISSUE_CLAIM_CREATE:${projectId}:${issueId}`;
7. create SQL writes `claim_type=NULL`, `subject_type=NULL`, `subject_id=NULL`, `ACTIVE`, `{}`;
8. relation insert occurs in same transaction;
9. replay verifies original Claim still belongs to Issue before lifecycle gates;
10. new create checks ACTIVE Project + OPEN Issue;
11. archived Project → `ProjectReadOnlyError`;
12. RESOLVED/ARCHIVED Issue → `ResearchIssueReadOnlyError`;
13. same key/different hash → `IdempotencyConflictError`;
14. connection errors → `CandidateClaimStoreUnavailableError`.

- [ ] **Step 2: Run RED**

```bash
pnpm exec vitest run apps/api/src/s32/postgres/candidate-claim-store.test.ts --maxWorkers=1
```

- [ ] **Step 3: Implement transaction and ownership helpers**

Use the M2-A transaction pattern. Preserve a generic integrity error to callers.

Issue ownership query:

```sql
SELECT
  ri.id AS issue_id,
  ri.lifecycle_state AS issue_lifecycle_state,
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

For write flow, lock the Project row, Issue row, and currently matching owner rows before validating owner count. Do not change schema.

- [ ] **Step 4: Implement fail-closed Claim list**

```sql
SELECT
  ric.issue_id,
  c.id AS claim_id,
  c.claim_type,
  c.statement,
  c.subject_type,
  c.subject_id,
  c.lifecycle_state,
  c.metadata,
  c.created_at,
  c.updated_at
FROM core.research_issue_claims ric
LEFT JOIN core.claims c ON c.id = ric.claim_id
WHERE ric.issue_id = $1
ORDER BY
  CASE c.lifecycle_state WHEN 'ACTIVE' THEN 0 WHEN 'ARCHIVED' THEN 1 ELSE 2 END,
  c.created_at ASC,
  c.id ASC
```

Canonical list validation checks UUID, canonical statement, ACTIVE/ARCHIVED lifecycle, object metadata, valid timestamps.

Do not require NULL `claim_type`/subject on general list reads.

- [ ] **Step 5: Implement idempotent create/replay**

Exact scope:

```ts
const scope = `S32:M2B:PROJECT_ISSUE_CLAIM_CREATE:${input.projectId}:${input.issueId}`;
```

Existing receipt path:

- hash mismatch → `IdempotencyConflictError`;
- require COMPLETED + resource_type CLAIM + resource_id;
- validate Project and exact Issue ownership without new-write lifecycle gates;
- verify exactly one `research_issue_claims(issue_id, resource_id)`;
- read Claim;
- replay verification requires NULL type/subject shape because the resource came from this M2-B command;
- return replayed.

New receipt path:

```sql
INSERT INTO core.claims
  (id, claim_type, statement, subject_type, subject_id, lifecycle_state, metadata)
VALUES
  ($1, NULL, $2, NULL, NULL, 'ACTIVE', '{}'::jsonb);

INSERT INTO core.research_issue_claims (issue_id, claim_id)
VALUES ($1, $2);
```

Then complete `ops.idempotency_keys` with `resource_type='CLAIM'`.

- [ ] **Step 6: Run API unit scope GREEN**

```bash
pnpm exec vitest run   apps/api/src/s32/domain/candidate-claim.test.ts   apps/api/src/s32/application/candidate-claims.test.ts   apps/api/src/s32/postgres/candidate-claim-store.test.ts   --maxWorkers=1
```

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/s32/postgres/candidate-claim-store.ts apps/api/src/s32/postgres/candidate-claim-store.test.ts
git commit -m "feat(s32): persist candidate claims"
```

---

### Task 4: Claim routes and S32 registration

**Files:**
- Create: `apps/api/src/s32/routes/candidate-claim-routes.ts`
- Create: `apps/api/src/s32/routes/candidate-claim-routes.test.ts`
- Modify: `apps/api/src/s32/register.ts`

**Interfaces:**
- Produces `createCandidateClaimRouter(config, service)`.
- Routes:
  - `GET /:projectId/issues/:issueId/claims`
  - `POST /:projectId/issues/:issueId/claims`

- [ ] **Step 1: Write failing HTTP/config/error tests**

Endpoint matrix:

```ts
const endpoints = [
  ["GET", `/${projectId}/issues/${issueId}/claims`, {}],
  ["POST", `/${projectId}/issues/${issueId}/claims`, {
    body: { statement: "可能答案" },
    key,
  }],
] as const;
```

For every endpoint test disabled/token-unconfigured/missing-token/wrong-token/database-unconfigured and `Cache-Control:no-store`.

Success:
- create → 201 `{claim}`;
- completed replay → 200 `{claim}`;
- list → 200 `{claims:[...]}`.

Safe errors:

```text
InvalidCandidateClaimInputError     -> 400 CLAIM_INVALID_INPUT
ProjectReadOnlyError                -> 409 PROJECT_READ_ONLY
ResearchIssueReadOnlyError          -> 409 RESEARCH_ISSUE_READ_ONLY
IdempotencyConflictError            -> 409 IDEMPOTENCY_CONFLICT
CandidateClaimScopeNotFoundError    -> 404
CandidateClaimStoreUnavailableError -> 503
CandidateClaimIntegrityError        -> 500
unknown Error                       -> 500
```

Assert no internal detail leakage.

- [ ] **Step 2: Run RED**

```bash
pnpm exec vitest run apps/api/src/s32/routes/candidate-claim-routes.test.ts --maxWorkers=1
```

- [ ] **Step 3: Implement route**

POST response:

```ts
const result = await service.create(
  req.params.projectId,
  req.params.issueId,
  req.header("Idempotency-Key"),
  req.body,
);
res.status(result.status === "created" ? 201 : 200).json({ claim: result.claim });
```

GET null scope maps to 404.

- [ ] **Step 4: Register on shared S32 Pool**

In `register.ts`, construct Candidate Claim service/store from the same Pool and mount before generic Project routes:

```ts
router.use("/projects", createCandidateClaimRouter(config, candidateClaims));
```

Registration test spies on Candidate Claim store and Project store factories and proves identical Pool identity.

- [ ] **Step 5: Run targeted API GREEN**

```bash
pnpm exec vitest run   apps/api/src/s32/domain/candidate-claim.test.ts   apps/api/src/s32/application/candidate-claims.test.ts   apps/api/src/s32/postgres/candidate-claim-store.test.ts   apps/api/src/s32/routes/candidate-claim-routes.test.ts   --maxWorkers=1
```

- [ ] **Step 6: Commit**

```bash
git add   apps/api/src/s32/routes/candidate-claim-routes.ts   apps/api/src/s32/routes/candidate-claim-routes.test.ts   apps/api/src/s32/register.ts
git commit -m "feat(s32): expose candidate claim API"
```

---

### Task 5: Disposable PostgreSQL16 integration gate

**Files:**
- Create: `apps/api/src/s32/postgres/candidate-claim-store.integration.test.ts`
- Create: `scripts/s32-m2b-integration-check.ts`
- Modify: `package.json`

**Interfaces:**
- Produces `s32:m2b:check` and `S32_M2B_REAL_PG=PASS`.

- [ ] **Step 1: Write real-PG tests**

Guard:

```ts
const databaseUrl = process.env.S32_M2B_TEST_DATABASE_URL;
const parsed = databaseUrl ? new URL(databaseUrl) : null;
if (parsed && (parsed.hostname !== "127.0.0.1" || parsed.pathname !== "/s32_m2b_test")) {
  throw new Error("M2-B integration requires isolated local s32_m2b_test");
}
```

Required cases:

1. one new Claim + one relation + one COMPLETED CLAIM receipt;
2. concurrent same key → exactly one Claim/relation/receipt;
3. same key/different hash → conflict with unchanged counts;
4. Project archived → completed replay succeeds, new key rejected;
5. Issue RESOLVED → completed replay succeeds, new key rejected;
6. Issue ARCHIVED → completed replay succeeds, new key rejected;
7. valid Issue owned by another Project → scoped not found;
8. multi-owner Issue → integrity failure;
9. dangling Issue→Claim relation → integrity failure;
10. relation insert failure rolls back Claim + receipt;
11. legitimate Claim with non-null claim_type/subject is list-readable;
12. a newly constructed store on the same DB reads list and completed replay.

Dangling relation setup is isolated-test-only:

```sql
SET session_replication_role = replica;
INSERT INTO core.research_issue_claims (issue_id, claim_id) VALUES ($1, $2);
SET session_replication_role = origin;
```

Always restore `session_replication_role` in `finally`.

For relation-insert rollback, install a temporary test-only trigger on `core.research_issue_claims` that raises for one known Claim ID, then drop it in `finally`.

- [ ] **Step 2: Verify safe skip without env**

```bash
pnpm exec vitest run apps/api/src/s32/postgres/candidate-claim-store.integration.test.ts --maxWorkers=1
```

Expected: suite skipped, file loads.

- [ ] **Step 3: Create M2-B runner**

Clone M2-A runner safety shape with:

```text
label    book-id-search.s32-m2b-run
database s32_m2b_test
env      S32_M2B_TEST_DATABASE_URL
marker   S32_M2B_REAL_PG=PASS
```

Keep loopback-only port, tmpfs, 512 MiB, PG16, `ON_ERROR_STOP=1`, ownership check, cleanup marker.

- [ ] **Step 4: Add package script**

```json
"s32:m2b:check": "tsx scripts/s32-m2b-integration-check.ts"
```

- [ ] **Step 5: Run real PG16**

```bash
pnpm s32:m2b:check
```

Expected all integration tests PASS plus:

```text
S32_M2B_REAL_PG=PASS
DISPOSABLE_TEST_CONTAINER_REMOVED=YES
```

- [ ] **Step 6: Commit**

```bash
git add   apps/api/src/s32/postgres/candidate-claim-store.integration.test.ts   scripts/s32-m2b-integration-check.ts   package.json
git commit -m "test(s32): verify candidate claims on postgres"
```

---

### Task 6: Web Claim client and pending receipt

**Files:**
- Modify: `apps/web/src/research/api.ts`
- Create: `apps/web/src/research/candidate-claims-api.test.ts`
- Create: `apps/web/src/research/candidate-claim-draft.ts`
- Create: `apps/web/src/research/candidate-claim-draft.test.ts`

**Interfaces:**
- Produces:
  - `CandidateClaim`
  - `listCandidateClaims(...)`
  - `createCandidateClaim(...)`
  - pending receipt helpers with Project+Issue+hash+key+createdAt.

- [ ] **Step 1: Write strict API client tests**

Exact paths:

```text
GET  /api/private/s32/projects/:projectId/issues/:issueId/claims
POST /api/private/s32/projects/:projectId/issues/:issueId/claims
```

POST sends only `{statement}` plus `Idempotency-Key`.

Validator rejects malformed Claim id, statement, lifecycle, timestamps, list body, and create body.

Add safe mappings:

```ts
CLAIM_INVALID_INPUT: { status: 400, message: "可能答案输入不正确。" },
RESEARCH_ISSUE_READ_ONLY: {
  status: 409,
  message: "这个研究问题已经只读，不能添加新的可能答案。",
},
```

Keep existing PROJECT_READ_ONLY and IDEMPOTENCY_CONFLICT mappings.

- [ ] **Step 2: Write receipt RED tests**

Required:

- stale valid A + B write failure → B retry keeps B key;
- clear + remove failure → remains null;
- fresh module restore + later read failure → keeps restored key;
- stored keys exactly `createdAt,idempotencyKey,issueId,projectId,requestHash`;
- stored JSON contains no statement;
- changed Project, Issue, or normalized statement rotates key;
- `forceNew=true` rotates key;
- invalid/unreadable initial storage can recover later;
- browser/server hash matches including U+0085 NEL.

- [ ] **Step 3: Run RED**

```bash
pnpm exec vitest run   apps/web/src/research/candidate-claims-api.test.ts   apps/web/src/research/candidate-claim-draft.test.ts   --maxWorkers=1
```

- [ ] **Step 4: Implement strict client**

```ts
export interface CandidateClaim {
  id: string;
  statement: string;
  lifecycleState: "ACTIVE" | "ARCHIVED";
  createdAt: string;
  updatedAt: string;
}

export const listCandidateClaims = (token, projectId, issueId, signal?) =>
  request<{ claims: CandidateClaim[] }>(
    token,
    `/projects/${encodeURIComponent(projectId)}/issues/${encodeURIComponent(issueId)}/claims`,
    { signal },
    body => Array.isArray(body.claims) && body.claims.every(isCandidateClaim),
  );

export const createCandidateClaim = (token, projectId, issueId, idempotencyKey, statement, signal?) =>
  request<{ claim: CandidateClaim }>(
    token,
    `/projects/${encodeURIComponent(projectId)}/issues/${encodeURIComponent(issueId)}/claims`,
    { method: "POST", input: { statement }, signal, idempotencyKey },
    body => isCandidateClaim(body.claim),
  );
```

- [ ] **Step 5: Implement receipt module**

```ts
export interface PendingCandidateClaimReceipt {
  projectId: string;
  issueId: string;
  requestHash: string;
  idempotencyKey: string;
  createdAt: string;
}

let memoryReceipt: PendingCandidateClaimReceipt | null | undefined;
```

Hash key order matches server exactly:

```ts
JSON.stringify({
  projectId: projectId.toLowerCase(),
  issueId: issueId.toLowerCase(),
  statement: normalizedStatement,
});
```

After restore/save/clear, memory wins over stale storage. Initial missing/invalid/unreadable storage returns null without memoizing explicit null.

- [ ] **Step 6: Run GREEN**

```bash
pnpm exec vitest run   apps/web/src/research/candidate-claims-api.test.ts   apps/web/src/research/candidate-claim-draft.test.ts   --maxWorkers=1
```

- [ ] **Step 7: Commit**

```bash
git add   apps/web/src/research/api.ts   apps/web/src/research/candidate-claims-api.test.ts   apps/web/src/research/candidate-claim-draft.ts   apps/web/src/research/candidate-claim-draft.test.ts
git commit -m "feat(s32): add candidate claim web client"
```

---

### Task 7: Candidate Claims section in Issue Detail

**Files:**
- Create: `apps/web/src/research/CandidateClaims.tsx`
- Create: `apps/web/src/research/CandidateClaims.test.tsx`
- Modify: `apps/web/src/research/ResearchIssueDetail.tsx`
- Modify: `apps/web/src/research/ResearchIssueDetail.test.tsx`
- Modify: `apps/web/src/research/research.css`

**Interfaces:**
- Produces `CandidateClaims({ token, project, issue })`.

- [ ] **Step 1: Write independent-read RED tests**

Pin:

```ts
it("keeps Issue visible when Claims fail", async () => {
  vi.mocked(listCandidateClaims).mockRejectedValue(new ProjectApiError(503, "SECRET"));
  renderIssue();
  expect(await screen.findByRole("heading", { name: issue.title })).toBeTruthy();
  expect(await screen.findByText("可能答案暂不可用。")).toBeTruthy();
  expect(document.body.textContent).not.toContain("SECRET");
});

it("renders confirmed empty Claims", async () => {
  vi.mocked(listCandidateClaims).mockResolvedValue({ claims: [] });
  renderIssue();
  expect(await screen.findByText("还没有可能答案。")).toBeTruthy();
});
```

Also render two Claims and assert no truth/confidence/preferred wording.

- [ ] **Step 2: Write create-state RED tests**

Pin:

1. ACTIVE+OPEN shows create;
2. archived Project hides create but shows Claims;
3. RESOLVED/ARCHIVED Issue hides create but shows Claims;
4. success inserts returned canonical Claim into list and clears form/receipt;
5. network/500 unknown freezes statement and exposes same-key retry;
6. retry reuses same statement+key;
7. unconfirmed statement cannot be edited;
8. IDEMPOTENCY_CONFLICT requires explicit “作为新的可能答案重新提交” and force-new key;
9. 400/PROJECT_READ_ONLY/RESEARCH_ISSUE_READ_ONLY clear pending receipt;
10. Claim list retry does not reload/hide Issue Detail.

- [ ] **Step 3: Run RED**

```bash
pnpm exec vitest run   apps/web/src/research/CandidateClaims.test.tsx   apps/web/src/research/ResearchIssueDetail.test.tsx   --maxWorkers=1
```

- [ ] **Step 4: Implement component**

Read state:

```ts
type ClaimsLoad =
  | { state: "loading"; claims: CandidateClaim[]; error: "" }
  | { state: "ready"; claims: CandidateClaim[]; error: "" }
  | { state: "unavailable"; claims: CandidateClaim[]; error: string };
```

Create state:

```ts
type ClaimCreateState =
  | "idle"
  | "submitting"
  | "unconfirmed"
  | "rejected"
  | "idempotency-conflict";
```

Write gate:

```ts
const canCreate = !project.readOnly && issue.lifecycleState === "OPEN";
```

No `Promise.all` with Issue Detail. Claim failure stays inside Claim section.

- [ ] **Step 5: Replace M2-A placeholder**

Replace the placeholder section with:

```tsx
<CandidateClaims token={token} project={response.project} issue={response.issue} />
```

Preserve Issue title/question/status/dates/navigation.

- [ ] **Step 6: Add minimal responsive CSS**

Add Claim list/card/form/action classes only. Require `overflow-wrap:anywhere` on statements and `min-width:0` on controls. Reuse existing design tokens.

- [ ] **Step 7: Run GREEN**

```bash
pnpm exec vitest run   apps/web/src/research/CandidateClaims.test.tsx   apps/web/src/research/ResearchIssueDetail.test.tsx   apps/web/src/research/candidate-claims-api.test.ts   apps/web/src/research/candidate-claim-draft.test.ts   --maxWorkers=1
```

- [ ] **Step 8: Commit**

```bash
git add   apps/web/src/research/CandidateClaims.tsx   apps/web/src/research/CandidateClaims.test.tsx   apps/web/src/research/ResearchIssueDetail.tsx   apps/web/src/research/ResearchIssueDetail.test.tsx   apps/web/src/research/research.css
git commit -m "feat(s32): show candidate claims on issue detail"
```

---

### Task 8: Scoped verification and real browser acceptance

**Files:**
- No product edits unless a real defect is first reproduced by a failing automated test.
- Evidence goes to ignored `logs/s32-m2b/` and `/home/conanxin/codex-artifacts/s32-m2b/`.

- [ ] **Step 1: Targeted API**

```bash
pnpm exec vitest run   apps/api/src/s32/domain/candidate-claim.test.ts   apps/api/src/s32/application/candidate-claims.test.ts   apps/api/src/s32/postgres/candidate-claim-store.test.ts   apps/api/src/s32/routes/candidate-claim-routes.test.ts   --maxWorkers=1
```

Record exact counts.

- [ ] **Step 2: API S32 scoped**

```bash
pnpm exec vitest run apps/api/src/s32 --maxWorkers=1
```

Any new/changed S32 failure blocks completion.

- [ ] **Step 3: Targeted Web**

```bash
pnpm exec vitest run   apps/web/src/research/candidate-claims-api.test.ts   apps/web/src/research/candidate-claim-draft.test.ts   apps/web/src/research/CandidateClaims.test.tsx   apps/web/src/research/ResearchIssueDetail.test.tsx   --maxWorkers=1
```

- [ ] **Step 4: Web research and broad Web**

```bash
pnpm exec vitest run apps/web/src/research --maxWorkers=1
pnpm exec vitest run apps/web --maxWorkers=1
```

- [ ] **Step 5: Builds and schema/frozen checks**

```bash
pnpm --filter @book-id-search/api build
pnpm --filter @book-id-search/web build
pnpm s32:schema:static
git diff --check
git diff --exit-code origin/main --   db/migrations/001_s32_core_schema.sql   db/tests/001_s32_schema_assertions.sql   db/tests/002_s32_negative_invariants.sql
```

Frozen diff command must exit 0.

- [ ] **Step 6: Fresh real PG16**

```bash
pnpm s32:m2b:check
```

Require `S32_M2B_REAL_PG=PASS` and `DISPOSABLE_TEST_CONTAINER_REMOVED=YES`.

- [ ] **Step 7: Full repository suite**

```bash
pnpm exec vitest run --maxWorkers=1
```

Report every failure exactly. Historical WeRead/CLI failures are not fresh evidence until observed again. Any new/changed failure blocks completion.

- [ ] **Step 8: Browser normal create**

Real Firefox + local dev PG:

1. ACTIVE Project + OPEN Issue;
2. create Claim A → 201;
3. SQL: Claim +1, relation +1;
4. refresh and confirm GET restores A;
5. create competing Claim B;
6. refresh and confirm A/B chronological order.

- [ ] **Step 9: Browser response-unknown hard acceptance**

1. put stale valid receipt A in sessionStorage;
2. let getItem keep returning A;
3. make B setItem fail;
4. submit B;
5. prove API/PG commits first;
6. only then discard browser response;
7. confirm unconfirmed UI and frozen statement;
8. record FIRST_B_KEY;
9. retry unchanged;
10. prove RETRY_B_KEY == FIRST_B_KEY and same canonical statement;
11. response = 200;
12. same Claim ID;
13. SQL remains B Claim=1 / relation=1 / no third key.

Pre-commit abort or mocks do not satisfy this gate.

- [ ] **Step 10: Browser lifecycle/replay**

- Project ARCHIVED: list readable, new key 409 PROJECT_READ_ONLY, completed key 200 same Claim.
- Restore ACTIVE; Issue RESOLVED: list readable, new key 409 RESEARCH_ISSUE_READ_ONLY, completed key 200.
- Issue ARCHIVED: same behavior.
- Restore local fixtures afterward.

- [ ] **Step 11: Independent degradation and mobile**

- Claims GET failure leaves Issue fully visible and only Claims section unavailable.
- Claim retry recovers independently.
- Firefox 390×844: require `innerWidth=clientWidth=scrollWidth`; inspect statement wrapping/form/actions.

- [ ] **Step 12: Restart persistence**

Restart only local dev API and PG container/volume without wiping the volume. Verify list and completed replay still return same Claim, with no duplicate.

- [ ] **Step 13: Cleanup exact acceptance fixtures only**

Preserve existing dev data and volume. Record:

```text
ACCEPTANCE_TEMP_DATA_CLEANED=YES
PRODUCTION_CHANGED=NO
```

Task 8 has no commit if no defect is found. Any defect fix must follow RED→GREEN and then rerun the affected gates.

---

### Task 9: Docs, one PR, and synchronized handoff

**Files:**
- Modify: `AGENTS.md`
- Modify: `docs/STATUS.md`

- [ ] **Step 1: Update AGENTS.md only after verification**

Set current local stage to M2-B Candidate Claims and keep M2-C/production unauthorized. Do not weaken production guards.

- [ ] **Step 2: Replace stale STATUS top checkpoint**

Keep short. Include task_id, actual source baseline, approved spec/plan commits, feature branch, tested/final commits, exact test counts, PG/browser evidence, frozen SQL unchanged, full-suite exact state, and implementation/merge/deploy flags.

- [ ] **Step 3: Final diff checks**

```bash
git diff --check
git status --short
git diff --name-only "$(git merge-base origin/main HEAD)"...HEAD
git diff --exit-code origin/main --   db/migrations/001_s32_core_schema.sql   db/tests/001_s32_schema_assertions.sql   db/tests/002_s32_negative_invariants.sql
```

- [ ] **Step 4: Commit docs**

```bash
git add AGENTS.md docs/STATUS.md
git commit -m "docs(s32): record M2-B candidate claims"
```

- [ ] **Step 5: Reverify exact final head**

```bash
pnpm exec vitest run   apps/api/src/s32/domain/candidate-claim.test.ts   apps/api/src/s32/application/candidate-claims.test.ts   apps/api/src/s32/postgres/candidate-claim-store.test.ts   apps/api/src/s32/routes/candidate-claim-routes.test.ts   apps/web/src/research/candidate-claims-api.test.ts   apps/web/src/research/candidate-claim-draft.test.ts   apps/web/src/research/CandidateClaims.test.tsx   apps/web/src/research/ResearchIssueDetail.test.tsx   --maxWorkers=1
pnpm --filter @book-id-search/api build
pnpm --filter @book-id-search/web build
git diff --check
```

Only after this run may `FINAL_HEAD` be called tested.

- [ ] **Step 6: Push feature branch**

```bash
git push -u origin feat/s32-m2b-candidate-claims
```

Never force-push on rejection.

- [ ] **Step 7: Open one PR**

Title:

```text
feat(s32): add candidate claims
```

Body includes source baseline, approved spec+plan, tested/final head, exact fresh test counts, real PG/browser, frozen SQL, full-suite evidence boundary, production untouched, M2-C not started.

- [ ] **Step 8: Sync Issue #2**

Use same task_id/source/tested/final/PR truth as the PR.

- [ ] **Step 9: Sync existing Notion pages**

Update:
1. project overview `3dd34a28-189a-81d4-8f74-ec74593dac5f`;
2. M2-B design `3e134a28-189a-81bd-8c9b-df935d28ff57`;
3. M2-B implementation-plan page created during planning;
4. project overview Summary.

Read back each write.

- [ ] **Step 10: Final handoff**

Return:

```text
TASK_ID=
ACTUAL_SOURCE_BASELINE=
APPROVED_SPEC_COMMIT=
APPROVED_PLAN_COMMIT=
TARGETED_API=
API_S32_SCOPED=
TARGETED_WEB=
WEB_RESEARCH=
WEB_BROAD=
API_BUILD=
WEB_BUILD=
SCHEMA_STATIC=
REAL_PG_RESULT=
DISPOSABLE_TEST_CONTAINER_REMOVED=
FROZEN_SQL_UNCHANGED=
GIT_DIFF_CHECK=
FULL_SUITE_RESULT=
KNOWN_UNRELATED_FAILURES=
BROWSER_CREATE=
BROWSER_RESPONSE_UNKNOWN=
FIRST_B_KEY=
RETRY_B_KEY=
SAME_KEY_REPLAY=
SAME_CLAIM_ID=
B_CLAIM_COUNT=
B_RELATION_COUNT=
READ_ONLY_REPLAY=
INDEPENDENT_DEGRADATION=
MOBILE_390=
RESTART_PERSISTENCE=
ACCEPTANCE_TEMP_DATA_CLEANED=
TESTED_COMMIT=
FINAL_HEAD=
PR_URL=
GITHUB_SYNC=
NOTION_SYNC=
M2_B_IMPLEMENTATION=COMPLETE_ON_BRANCH
M2_B_PR=OPEN
M2_B_MERGED=NO
PRODUCTION_CHANGED=NO
PRODUCTION_DEPLOYED=NO
M2_C_STARTED=NO
NEXT_ACTION=REVIEW_M2B_PR
```

Stop. Do not merge, deploy, or start M2-C.

---

## Plan Self-Review Checklist

- Every written-spec requirement maps to Tasks 1–7, Task 8 runtime/browser gates, or Task 9 handoff.
- No task edits frozen M0 SQL.
- `CandidateClaim`, service/store methods, route paths, client names, and receipt fields are consistent.
- Project+Issue idempotency scope appears everywhere; issue-only scope does not.
- New create requires ACTIVE+OPEN; completed replay bypasses new-write lifecycle gates but still validates ownership/relation.
- General list reads permit historical/global Claim type/subject fields.
- Wrong-Project access is scoped 404 and isolated by Project+Issue idempotency namespace.
- Three M2-A R2 storage-asymmetry tests exist plus real-browser response-unknown acceptance.
- No Evidence/Assessment/Resolution/ResearchRun/truth/confidence/preferred semantics enter M2-B.
- Full-suite failures are reported exactly and never hidden behind scoped green results.
