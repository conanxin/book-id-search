# S32 M2-E Issue Resolution Implementation Plan

**Status:** Refreshed after R7 terminal closeout; Task 1 follows exact-head planning review and merge
**Task ID:** `S32_M2E_ISSUE_RESOLUTION_IMPLEMENTATION_PLAN_R1`  
**Written spec:** latest canonical spec on this planning branch (post-review lifecycle/replay corrections)  
**Source baseline for planning:** `main@d8e6d96672e9cef6a2bab5a35c604fbd83ec83d9`  
**Planning branch:** `plan/s32-m2e-issue-resolution`

## 0. Hard gate and execution boundary

R7 reached [terminal PASS](https://github.com/conanxin/book-id-search/issues/2#issuecomment-5864529231) and [rollout closeout](https://github.com/conanxin/book-id-search/issues/2#issuecomment-5864572642). The [M2-E re-entry gate](https://github.com/conanxin/book-id-search/issues/2#issuecomment-5864639302) now permits this planning refresh/review/merge, followed by local Task 1. Production schema/runtime mutation still requires separate explicit authorization.

Before creating the implementation worktree require:

```text
R7_STATE=TERMINAL_PASS
S32_ROLLOUT=COMPLETE
R7_FINAL_AUDIT=PASS
R7_INCIDENT_CTRL=20e1b8dee2e77c5df0566f305f7d5a5b1745041c
PRODUCTION_HEAD=20e1b8dee2e77c5df0566f305f7d5a5b1745041c
PR42_REFRESHED_EXACT_HEAD_REVIEW=PASS
PR42=MERGED
IMPLEMENTATION_BASE=<latest main after PR42 merge>
```

The R7 final audit proved production HEAD and GitHub main equal to the incident CTRL at closeout. A later docs-only planning merge advances development main; it does not require another production control-plane sync or alter that historical acceptance identity.

Then create a fresh main-based implementation worktree/branch, suggested:

```text
feat/s32-m2e-issue-resolution
```

One writer per worktree.

Do not implement M2-E on the planning branch.

Historical frozen files must remain byte-for-byte unchanged:

```text
db/migrations/001_s32_core_schema.sql
db/tests/001_s32_schema_assertions.sql
db/tests/002_s32_negative_invariants.sql
```

M2-E is an additive post-v1 migration.

---

## 1. Target architecture

M2-E introduces the first explicit Issue-level working conclusion:

```text
Project
  -> ResearchIssue
       -> Candidate Claims
       -> Claim Assessments
       -> IssueResolution history
       -> current_resolution_id pointer
```

The command path is:

```text
POST Resolution
  -> normalize + hash
  -> SERIALIZABLE transaction
  -> idempotency reservation
  -> lock Project + ResearchIssue
  -> expectedCurrentResolutionId CAS
  -> validate preferred Claim same-Issue membership
  -> validate optional frozen Manifest visibility/integrity
  -> INSERT append-only IssueResolution
  -> UPDATE ResearchIssue.current_resolution_id + updated_at
  -> preserve existing OPEN/RESOLVED lifecycle
  -> canonical read-back
  -> complete idempotency receipt
  -> COMMIT
```

The read path is Project-scoped, privacy-safe, and must never infer current from timestamps.

---

# Task 1 — Add M2-E additive schema migration and migration-chain support

### Create

- `db/migrations/002_s32_m2e_issue_resolution.sql`
- `db/tests/003_s32_m2e_schema_assertions.sql`
- `db/tests/004_s32_m2e_negative_invariants.sql`

### Create

- `scripts/s32-migration-chain.ts`
- `scripts/s32-migration-chain.test.ts`

### Modify

- `scripts/s32-schema-check.ts`
- `scripts/s32-schema-contract.test.ts`
- `scripts/s32-m1a-integration-check.ts`
- `scripts/s32-m1b-integration-check.ts`
- `scripts/s32-m1c-integration-check.ts`
- `scripts/s32-m1d-integration-check.ts`
- `scripts/s32-m1e-integration-check.ts`
- `scripts/s32-m2a-integration-check.ts`
- `scripts/s32-m2b-integration-check.ts`
- `scripts/s32-m2c-integration-check.ts`
- `scripts/s32-m2d-integration-check.ts`

### Migration contents

`002_s32_m2e_issue_resolution.sql` must add only:

1. a fail-closed compatibility preflight over existing IssueResolution rows;
2. same-Issue preferred Claim FK:
   ```sql
   ALTER TABLE core.issue_resolutions
   ADD CONSTRAINT fk_ir_preferred_claim_same_issue
   FOREIGN KEY (issue_id, preferred_claim_id)
   REFERENCES core.research_issue_claims(issue_id, claim_id)
   ON DELETE RESTRICT;
   ```

3. append-only trigger function for `core.issue_resolutions`;

4. UPDATE trigger;

5. DELETE trigger.

The compatibility preflight must reject any existing `PREFERRED_CLAIM` Resolution whose `(issue_id,preferred_claim_id)` membership is absent from `core.research_issue_claims`. Use a stable M2-E-specific exception marker. Do not repair or reinterpret existing research data in the migration.

Do not add tables, columns, enums, indexes, `supersedes_resolution_id`, or generalized framework code.

### Migration-chain harness change

The audit found **10 current real-PG/schema runners** hard-code only `001_s32_core_schema.sql`: schema-check plus M1-A/B/C/D/E and M2-A/B/C/D.

Do not fix this by copying a second hard-coded list into every runner.

Create one shared source of truth, for example `scripts/s32-migration-chain.ts`:

```ts
export const S32_MIGRATION_PATHS = [
  "db/migrations/001_s32_core_schema.sql",
  "db/migrations/002_s32_m2e_issue_resolution.sql",
] as const;

export function readS32MigrationChain(root: string): string[] { ... }
```

Requirements:

- deterministic numeric order;
- explicit list, no filesystem glob ordering;
- fail if any configured migration is missing;
- helper contains paths only, no Docker/psql side effects;
- all current S32 disposable-PG runners import/reuse this helper;
- historical 001 migration bytes remain unchanged;
- future migration additions have one canonical list to update.

Refactor `scripts/s32-schema-check.ts` and every M1-A..M2-D real-PG runner to apply the complete ordered chain before fixtures/tests.

Then run the complete assertion chain:

```text
001_s32_schema_assertions.sql
002_s32_negative_invariants.sql
003_s32_m2e_schema_assertions.sql
004_s32_m2e_negative_invariants.sql
```

Keep fail-closed semantics and cleanup behavior unchanged.

### RED tests first

Add migration-chain tests proving:

- exact ordered list is 001 then 002;
- missing configured migration fails closed;
- every current S32 real-PG runner imports/uses the shared chain rather than directly reading `001_s32_core_schema.sql`.

Add static tests proving:

- historical 001 migration still exists and is not replaced;
- 002 contains the same-Issue composite FK;
- 002 contains UPDATE and DELETE append-only triggers;
- 002 does not CREATE TABLE;
- 002 does not alter the three Resolution type values;
- schema harness applies 001 then 002 in deterministic order.

### Real PostgreSQL gates

Prove both:

#### Fresh install

```text
empty PG16
-> 001
-> 002
-> all schema assertions
-> all negative invariant tests
```

#### Upgrade path

```text
empty PG16
-> 001
-> seed representative valid M2-A/B/C/D rows
-> 002
-> verify rows unchanged
-> verify new constraints active
```

Also run a negative upgrade fixture:

```text
empty PG16
-> 001
-> seed legacy PREFERRED_CLAIM Resolution pointing to a Claim outside its Issue
-> 002
-> require stable fail-closed migration error
-> require no automatic data repair
```

This upgrade-path test is mandatory because production already runs schema v1.

### Expected negative tests

- preferred Claim from another Issue -> reject;
- same-Issue preferred Claim -> accept;
- PREFERRED_CLAIM + NULL -> existing CHECK reject;
- INSUFFICIENT_EVIDENCE + NULL -> accept;
- NO_WORKING_CONCLUSION + NULL -> accept;
- IssueResolution UPDATE -> reject;
- IssueResolution DELETE -> reject;
- cross-Issue `current_resolution_id` -> existing deferred FK still reject.

### Commit boundary

Suggested commit:

```text
feat(s32): add issue resolution invariants
```

---

# Task 2 — Add Issue Resolution domain contract

### Create

- `apps/api/src/s32/domain/issue-resolution.ts`
- `apps/api/src/s32/domain/issue-resolution.test.ts`

### Reuse

- UUID validation patterns from `domain/research-issue.ts`;
- rationale normalization semantics from M2-D `domain/assessment.ts`;
- keyset cursor precision pattern from Assessment history.

### Domain types

Define M2-E v1 write input strictly, while keeping read DTOs compatible with the executable schema. In particular, canonical read records use `rationale: string | null`; the create input still requires normalized non-null rationale.

Define:

```ts
type IssueResolutionType =
  | "PREFERRED_CLAIM"
  | "INSUFFICIENT_EVIDENCE"
  | "NO_WORKING_CONCLUSION";

interface NormalizedIssueResolutionInput {
  expectedCurrentResolutionId: string | null;
  resolutionType: IssueResolutionType;
  preferredClaimId: string | null;
  rationale: string;
  evidenceManifestId: string | null;
}
```

Define canonical DTOs for:

- Resolution record;
- Resolution summary;
- Resolution detail;
- Resolution history response;
- current working conclusion.

### Normalization rules

Pin tests for:

- exact allowed keys only;
- UUID canonical lowercase;
- required rationale;
- U+0000 rejection;
- CRLF/CR -> LF;
- outer Unicode trim;
- 1 / 8000 / 8001 code-point boundaries;
- PREFERRED_CLAIM requires preferredClaimId;
- other types require preferredClaimId=null;
- evidenceManifestId optional UUID/null;
- request hash changes for every meaningful command field;
- cursor precision stable at PostgreSQL microseconds.

Suggested commit:

```text
feat(s32): define issue resolution domain
```

---

# Task 3 — Add application service and command/read interfaces

### Create

- `apps/api/src/s32/application/issue-resolutions.ts`
- `apps/api/src/s32/application/issue-resolutions.test.ts`

### Define errors

At minimum:

```text
IssueResolutionScopeNotFoundError
IssueResolutionNotFoundError
IssueResolutionInvalidPreferredClaimError
IssueResolutionEvidenceNotAvailableError
IssueResolutionStaleError
IssueResolutionIdempotencyConflictError
ProjectReadOnlyForResolutionError
ResearchIssueReadOnlyForResolutionError
IssueResolutionIntegrityError
IssueResolutionStoreUnavailableError
```

### Command interface

Generate the Resolution ID once before calling the store.

The service must parse:

- projectId;
- issueId;
- Idempotency-Key;
- normalized body;
- canonical request hash.

No IDs or timestamps supplied by the client except the explicit expected pointer / optional referenced IDs.

### Read interfaces

Provide:

- list history;
- get detail/current;
- issue-wide eligible evidence-basis list;
- current Resolution may be null.

The history response must include authoritative Issue state:

```ts
issue: {
  id: string;
  lifecycleState: "OPEN" | "RESOLVED" | "ARCHIVED";
  currentResolutionId: string | null;
  updatedAt: string;
}
currentResolution: IssueResolutionSummary | null;
```

The browser uses this pointer for the next create CAS. It must never infer the pointer from history order.

Suggested commit:

```text
feat(s32): add issue resolution service contracts
```

---

# Task 4 — Share canonical Project/Issue scope, then implement SERIALIZABLE Resolution command store

### Modify

- `apps/api/src/s32/postgres/project-evidence-authorization.ts`
- `apps/api/src/s32/postgres/project-evidence-authorization.test.ts`
- M2-D callers/tests only as required by the extraction; behavior must remain unchanged.

### Create

- `apps/api/src/s32/postgres/issue-resolution-command-store.ts`
- `apps/api/src/s32/postgres/issue-resolution-command-store.test.ts`

### Shared Issue scope

Add/export `loadProjectIssueScope(...)` with the existing M2-A/M2-B/M2-D single-owner fail-closed semantics:

- exact Project;
- exact ResearchIssue;
- exactly one `ProjectBinding(target_type='RESEARCH_ISSUE')`;
- binding owner must equal requested Project;
- binding_role NULL;
- binding metadata canonical object;
- dangling / zero-owner / multi-owner corruption fails closed;
- Project and Issue lifecycle/timestamps canonical.

Refactor `loadProjectClaimScope(...)` to build on the shared Issue scope plus exact `research_issue_claims` + Claim validation, rather than duplicating owner semantics.

Run M2-D scope/Assessment regression tests after extraction.

### Reuse patterns from

- `assessment-command-store.ts`;
- `research-issue-store.ts`;
- current M2-D idempotency receipt handling;
- current connection-error classification.

### Transaction order

Use deterministic lock order:

```text
Project
-> ResearchIssue
-> preferred ResearchIssueClaim membership when applicable
-> optional Manifest authorization reads
```

Do not lock all candidate Claims or all Assessment history.

### Lifecycle

Require for a **new** Resolution command:

```text
Project ACTIVE
Issue OPEN | RESOLVED
```

ARCHIVED Project/Issue fail closed.

Creating a Resolution does not mutate Issue lifecycle. OPEN remains OPEN; RESOLVED remains RESOLVED. M2-E v1 is a working-conclusion layer, not the explicit resolve/reopen lifecycle command.

### Replay before CAS

Follow the proven M2-A/M2-B/M2-D authority rule:

1. attempt idempotency reservation;
2. if the key already exists, lock/read the receipt;
3. same hash + COMPLETED -> canonical-read and replay the original Resolution immediately;
4. do **not** apply current-pointer or later lifecycle checks to a completed replay;
5. only a genuinely new reservation proceeds to scope locking/CAS.

This guarantees response-unknown retry still recovers the original command even if another Resolution later advanced the Issue pointer or the Issue later became read-only.

### CAS for new commands

After locking the Issue:

```text
persisted current_resolution_id
==
expectedCurrentResolutionId
```

Otherwise throw `ISSUE_RESOLUTION_STALE` before insertion.

### Preferred Claim

For `PREFERRED_CLAIM`:

- require exact `research_issue_claims(issue_id, claim_id)` row;
- validate Claim canonical row;
- do not mutate Claim lifecycle;
- DB composite FK remains final defense.

### Optional evidence Manifest

If `evidenceManifestId != null`:

- require the Manifest to resolve to exactly one canonical Assessment under the current M2-D write model;
- require that Assessment's Claim to be a candidate of this exact Issue;
- reuse M2-D Project evidence authorization/integrity helpers;
- require that Assessment/Manifest to be currently visible in the same Project context;
- zero matching Assessment -> not an eligible evidence basis;
- multiple matching Assessments -> canonical-integrity error for the new command;
- do not copy Manifest/items;
- do not alter Manifest metadata/hash.

### Idempotency

Scope:

```text
S32:M2E:PROJECT_ISSUE_RESOLUTION_CREATE:<projectId>:<issueId>
```

Receipt:

```text
resource_type=ISSUE_RESOLUTION
resource_id=<resolutionId>
result_payload={"resolutionId":"..."}
```

Same key + same request -> replay exact ID.  
Same key + changed request -> conflict.  
Malformed completed receipt -> integrity error, never duplicate write.

### v1 attribution boundary

Do not add IssueResolution attribution as an incidental side effect of M2-E.

Current schema has no `issue_resolutions.actor_id`, and `contributions.target_type` does not allow `ISSUE_RESOLUTION`. M2-E v1 therefore creates human-local but canonically unattributed Resolution rows. Do not fake a Contribution against the Issue or Claim. Attribution requires a later explicit design/migration.

### Write sequence

1. reserve idempotency row;
2. validate/lock scope;
3. CAS current pointer;
4. validate preferred Claim / optional Manifest;
5. insert IssueResolution;
6. update ResearchIssue:
   - `current_resolution_id = new ID`;
   - `updated_at = now()`;
   - preserve the existing lifecycle_state unchanged;
7. canonical read-back;
8. complete receipt;
9. COMMIT.

### Unit tests

Pin:

- first Resolution from OPEN advances pointer, updates updated_at, and leaves lifecycle OPEN;
- Resolution from RESOLVED advances pointer, updates updated_at, and leaves lifecycle RESOLVED;
- stale pointer;
- same-key completed replay after later pointer drift still returns the original Resolution without pointer mutation;
- same-key completed replay after later read-only lifecycle drift still returns the original Resolution;
- changed request conflict;
- cross-Issue Claim;
- archived Project;
- archived Issue;
- optional Manifest visible/not-visible/corrupt;
- malformed receipt;
- connection error -> 503 class;
- no partial durable write on any failure.

Suggested commit:

```text
feat(s32): implement issue resolution command store
```

---

# Task 5 — Implement privacy-safe Resolution read store

### Create

- `apps/api/src/s32/postgres/issue-resolution-read-store.ts`
- `apps/api/src/s32/postgres/issue-resolution-read-store.test.ts`

### Requirements

Use `REPEATABLE READ, READ ONLY`.

The read store also exposes an issue-wide `listEvidenceBases` query for the Resolution Composer. It must batch across candidate Claims/Assessments and must not fetch each Claim's Assessment history separately.

Validate:

- Project owns exact Issue;
- evidence-bases response carries the canonical Issue id for Web request/response scope binding;
- current pointer belongs to same Issue;
- preferred Claim belongs to same Issue;
- optional Manifest visibility/integrity before returning protected evidence metadata;
- schema-valid historical `rationale=NULL` is readable and returned as null rather than treated as corruption.

### Current semantics

The history response returns both the authoritative `currentResolutionId` and the exact current Resolution object (or null), independently of the requested history page.

Current is:

```text
research_issues.current_resolution_id
```

Never:

```text
ORDER BY created_at DESC LIMIT 1
```

A deliberately newer historical row that is not current must remain non-current in tests.

### History

- order `created_at DESC,id DESC`;
- default 20;
- max 50;
- opaque keyset cursor;
- no total count;
- mark `isCurrent` by pointer comparison.

### Eligible evidence-basis list

Return compact rows from visible Assessments across all candidate Claims of this exact Issue:

- assessmentId;
- claimId + statement excerpt;
- stance/confidence;
- manifest ID/SHA/itemCount;
- assessmentCreatedAt.

Ordering: `assessment.created_at DESC, assessment.id DESC`.  
Default 20 / max 50 / microsecond-safe opaque cursor / no total count.

Visibility filtering must occur before pagination. Query count must remain bounded independently of result N; add a no-N+1 test.

### Visibility

If an optional Manifest becomes unauthorized:

- do not leak Manifest fields;
- define one stable v1 behavior in implementation: preferred is to keep the Resolution row visible but return `evidenceBasisAvailable=false`, because the Issue-level conclusion itself belongs to the Project/Issue while the evidence payload can lose authorization;
- direct evidence detail remains unavailable.

Pin this behavior in tests so it is not accidentally changed to whole-Resolution disappearance.

Suggested commit:

```text
feat(s32): add issue resolution read model
```

---

# Task 6 — Add private HTTP routes and register stores

### Create

- `apps/api/src/s32/routes/issue-resolution-routes.ts`
- `apps/api/src/s32/routes/issue-resolution-routes.test.ts`

### Modify

- `apps/api/src/s32/register.ts`
- `apps/api/src/s32/routes/register.test.ts`

### Endpoints

```http
POST /projects/:projectId/issues/:issueId/resolutions
GET  /projects/:projectId/issues/:issueId/resolutions
GET  /projects/:projectId/issues/:issueId/resolutions/:resolutionId
GET  /projects/:projectId/issues/:issueId/resolution-evidence-bases
```

They are mounted under the existing private S32 project router prefix.

All responses:

```text
Cache-Control: no-store
```

### Status matrix

- create -> 201;
- replay -> 200;
- invalid -> 400;
- scope/preferred Claim/evidence unavailable -> privacy-safe 404;
- read-only/stale/idempotency conflict -> 409;
- store unavailable -> 503;
- integrity -> generic 500.

Suggested commit:

```text
feat(s32): expose issue resolution routes
```

---

# Task 7 — Extend Web API validators/client

### Modify

- `apps/web/src/research/api.ts`

### Create

- `apps/web/src/research/issue-resolution-api.test.ts`

Add strict DTO validators for:

- Resolution record, with `rationale: string | null` on reads;
- authoritative Issue pointer state;
- current Resolution;
- history page;
- eligible evidence-basis page;
- detail;
- created/replayed response.

Add:

```ts
createIssueResolution(...)
listIssueResolutions(...)
getIssueResolution(...)
listIssueResolutionEvidenceBases(...)
```

Map M2-E error codes to user-facing Chinese messages without weakening strict response validation.

Suggested commit:

```text
feat(s32): add issue resolution web client
```

---

# Task 8 — Add browser pending Resolution receipt

### Create

- `apps/web/src/research/issue-resolution-draft.ts`
- `apps/web/src/research/issue-resolution-draft.test.ts`

Use the same three-state semantics proven in Candidate Claim and Assessment flows:

```text
no receipt before explicit Submit
pending exact command
same-key retry after unknown response
changed intent requires explicit discard/new command
success/replay clears receipt
```

Receipt scope includes Project + Issue.

Store:

- normalized command;
- requestHash;
- idempotencyKey;
- createdAt.

Do not store private token.

Suggested commit:

```text
feat(s32): persist pending issue resolution intent
```

---

# Task 9 — Build Resolution Composer

### Create

- `apps/web/src/research/IssueResolutionComposer.tsx`
- `apps/web/src/research/IssueResolutionComposer.test.tsx`

### Modify

- `apps/web/src/research/research.css`

### UI

Render inside Research Issue detail:

```text
形成工作结论
[优先采用某个候选 / 证据不足 / 暂不形成结论]
[preferred Claim selector when needed]
[optional evidence basis]
[rationale textarea]
[提交]
```

Rules:

- no automatic preferred Claim selection from Assessment stance;
- load optional evidence-basis choices from the dedicated issue-wide endpoint, not N per-Claim history requests;
- PREFERRED_CLAIM cannot submit without Claim;
- other types send preferredClaimId=null;
- `expectedCurrentResolutionId` comes only from the authoritative Resolution API pointer state, never from the newest history row;
- stale pointer keeps user rationale/selection and asks for reload/review;
- response-unknown preserves exact pending receipt for same-key retry;
- archived Project/Issue disables composer.

Suggested commit:

```text
feat(s32): add issue resolution composer
```

---

# Task 10 — Add Current Working Conclusion + Resolution History

### Create

- `apps/web/src/research/IssueResolutionCurrent.tsx`
- `apps/web/src/research/IssueResolutionCurrent.test.tsx`
- `apps/web/src/research/IssueResolutionHistory.tsx`
- `apps/web/src/research/IssueResolutionHistory.test.tsx`
- `apps/web/src/research/IssueResolutionDetail.tsx`
- `apps/web/src/research/IssueResolutionDetail.test.tsx`

### Modify

- `apps/web/src/research/ResearchIssueDetail.tsx`
- `apps/web/src/research/ResearchIssueDetail.test.tsx`
- `apps/web/src/research/research.css`

Do not bury Issue-level Resolution inside a single Candidate Claim card.

Page order should become approximately:

```text
Research Issue header
Current Working Conclusion
Candidate Claims + Assessments
Resolution Composer
Resolution History
```

Current view must use the server-provided pointer semantics.

History keeps all prior working conclusions visible, including earlier preferred Claims.

Suggested commit:

```text
feat(s32): show issue resolution history
```

---

# Task 11 — Add real PostgreSQL 16 M2-E integration runner

### Create

- `apps/api/src/s32/postgres/issue-resolution-store.integration.test.ts`
- `scripts/fixtures/s32-m2e-browser.sql`
- `scripts/s32-m2e-integration-check.ts`

### Modify

- `package.json`

Add:

```json
"s32:m2e:check": "tsx scripts/s32-m2e-integration-check.ts"
```

The runner must import and consume `readS32MigrationChain(root)` from
`scripts/s32-migration-chain.ts`, just like the existing runners refactored
in Task 1. Do not copy a separate 001/002 path list into this runner.
The shared chain must be applied completely, in its configured order,
before the synthetic fixture and integration tests:

```text
readS32MigrationChain(root) (currently 001 then 002)
M2-E synthetic fixture
issue-resolution-store.integration.test.ts
```

Use disposable PostgreSQL 16 with the existing ownership-label/tmpfs/random-loopback-port safety pattern.

### Real PG cases

- first Resolution atomic commit while preserving OPEN lifecycle and advancing Issue.updated_at;
- second Resolution moves pointer and keeps first row;
- stale concurrent command loses without partial write;
- same key concurrent calls -> one durable Resolution, create/replay semantic pair;
- cross-Issue preferred Claim rejected by real DB;
- valid v1 upgrade 001->002 preserves existing M2-A/B/C/D rows;
- deliberately invalid legacy cross-Issue preferred Resolution makes 002 fail closed without repair;
- UPDATE/DELETE Resolution rejected by trigger;
- optional Manifest visibility;
- evidence basis must map to exactly one visible Assessment whose Claim belongs to the exact Issue;
- issue-wide evidence-basis pagination and no-N+1 behavior;
- existing M2-D Assessment/Manifest rows preserved;
- `research_issues.lifecycle_state` is preserved exactly while `updated_at` advances on new pointer writes;
- idempotency receipt exact.

Suggested commit:

```text
test(s32): add real postgres issue resolution gates
```

---

# Task 12 — Whole-slice regression and browser acceptance

Run fresh evidence at exact implementation head.

### Targeted API

At minimum:

```text
issue-resolution domain
application service
command store
read store
routes
register
research issue
candidate claims
assessment
evidence authorization
```

### Targeted Web

At minimum:

```text
issue-resolution API
pending receipt
composer
current
history
detail
ResearchIssueDetail
CandidateClaims
Assessment components
```

### Database

Run the full current migration-compatible S32 real-PG matrix:

```bash
pnpm s32:schema:static
pnpm s32:schema:check
pnpm s32:m1a:check
pnpm s32:m1b:check
pnpm s32:m1c:check
pnpm s32:m1d:check
pnpm s32:m1e:check
pnpm s32:m2a:check
pnpm s32:m2b:check
pnpm s32:m2c:check
pnpm s32:m2d:check
pnpm s32:m2e:check
```

All of these must apply the shared current migration chain. Historical test results remain historical; fresh M2-E verification must not claim compatibility from runners that still apply only 001.

### Builds

```bash
pnpm --filter @book-id-search/api build
pnpm --filter @book-id-search/web build
```

### Broad suites

```bash
pnpm vitest run apps/api/src/s32
pnpm vitest run apps/web/src/research
pnpm test
```

Record exact PASS/FAIL/SKIP/unhandled counts. Do not relabel known unrelated failures as PASS.

### Browser

Use real Chromium/Firefox against a disposable real-PG local stack.

Required path:

```text
Project
-> Research Issue
-> candidate Claims
-> existing Assessments
-> create PREFERRED_CLAIM Resolution while Issue remains OPEN
-> current conclusion appears and new Candidate Claim creation remains available
-> create second INSUFFICIENT_EVIDENCE Resolution
-> current pointer changes without lifecycle mutation
-> first Resolution remains in history
-> reload
-> history/current survive
```

Also test:

- stale tab -> 409 with preserved draft;
- response unknown -> same-key replay;
- archived read-only;
- 390x844 no horizontal overflow;
- no token in DOM/bundle/log receipts.

---

# Task 13 — Review, PR, merge, and deployment separation

After exact-head verification:

1. update `docs/STATUS.md`;
2. update `AGENTS.md` only if project-level execution rules materially changed;
3. record tested commit and all actual counts;
4. open PR;
5. require fresh review with CRITICAL=0 / IMPORTANT=0;
6. merge only after CI + review;
7. keep deployment as a separate explicit decision.

Do not combine product merge with production DB migration.

Production deployment must have its own later packet covering:

```text
preflight
002 migration
post-migration invariants
API/Web release if product code changed
browser acceptance
terminal deployment receipt
```

---

## Implementation-plan gate

```text
M2_E_WRITTEN_SPEC=READY_FOR_REVIEW
M2_E_IMPLEMENTATION_PLAN=READY_FOR_REVIEW
M2_E_IMPLEMENTATION=NOT_STARTED
M2_E_SCHEMA_MIGRATION=NOT_STARTED
M2_E_PRODUCTION_CHANGED=NO

R7_STATE=TERMINAL_PASS
S32_ROLLOUT=COMPLETE
R7_TERMINAL_PASS_REQUIRED_BEFORE_IMPLEMENTATION=YES
```

**Next allowed action in the current state:** complete the refreshed PR42 exact-head review/CI and merge.
**Next code action after PR42 merge:** create the fresh implementation worktree and execute Task 1 with RED schema tests first.
