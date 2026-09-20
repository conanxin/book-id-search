# S32 M2-B Candidate Claims Design

**Status:** Written spec for user review  
**Planning branch:** `plan/s32-m2b-candidate-claims`  
**Source baseline:** `main@beb3888600c6c9520624093da00619d74a15d68f`  
**Predecessor:** M2-A Research Issues, merged by PR #15  
**Implementation authorization:** NOT GRANTED by this spec  
**Production authorization:** NOT GRANTED

## 1. Purpose

M2-B moves BOOK-ID-SEARCH from “a Project can hold research questions” to “a Research Issue can hold multiple explicit candidate answers.”

The user-facing result is deliberately narrow:

```text
Research Issue
  ├─ Candidate Claim A
  ├─ Candidate Claim B
  └─ Candidate Claim C
```

A Claim is a proposition that may later be assessed against evidence. Creating or listing a Claim must not imply that the Claim is true, supported, preferred, or resolved.

M2-B is the next smallest useful epistemic slice after M2-A. It does not implement the whole Claim → Evidence → Assessment → Resolution loop.

## 2. Source of truth and design precedence

Implementation must follow the repository state on the source baseline, especially:

- `db/migrations/001_s32_core_schema.sql`
- M2-A API/application/PostgreSQL/Web code already merged to `main`
- existing M0 schema assertions and negative invariant tests
- repository `AGENTS.md`

Historical P29/Notion design material remains architectural context, but when an older design draft conflicts with the executable migration on `main`, the executable migration is authoritative for M2-B.

This matters because historical design drafts contained richer lifecycle/assessment/resolution enums than the migration that actually landed.

M2-B MUST NOT change the frozen M0 migration or its two SQL verification files.

## 3. Actual schema contract used by M2-B

M2-B uses the existing tables only.

### 3.1 `core.claims`

The executable schema currently provides:

```text
id              uuid primary key
claim_type      text nullable
statement       text not null
subject_type    text nullable
subject_id      uuid nullable
lifecycle_state text not null default ACTIVE
metadata        jsonb not null default {}
created_at      timestamptz not null default now()
updated_at      timestamptz not null default now()
```

Current executable lifecycle values are:

```text
ACTIVE
ARCHIVED
```

Current executable `subject_type` allowlist is:

```text
WORK
EDITION
SOURCE
SOURCE_ASSET
NOTE
ACTOR
```

M2-B creates Issue candidate Claims with:

```text
claim_type      = NULL
subject_type    = NULL
subject_id      = NULL
lifecycle_state = ACTIVE
metadata        = {}
```

M2-B MUST NOT encode `RESEARCH_ISSUE` into `subject_type`: it is not in the executable allowlist, and Issue membership already has a dedicated relation table.

### 3.2 `core.research_issue_claims`

The relation is:

```text
issue_id
claim_id
created_at
PRIMARY KEY (issue_id, claim_id)
```

This relation means:

- one Research Issue may have multiple competing Claims;
- one canonical Claim may, in the long-term model, serve multiple Research Issues;
- the relation does not make the Claim owned by a Project;
- M2-B does not create a `ProjectBinding` for Claims.

### 3.3 Claim statement immutability

The migration already installs `CLAIM_STATEMENT_IMMUTABLE`.

The proposition identity fields cannot be updated in place:

- `claim_type`
- `statement`
- `subject_type`
- `subject_id`

M2-B therefore exposes no Claim edit endpoint or edit UI.

If a proposition changes semantically, a future phase must create a new Claim and optionally connect it with a ClaimRelation such as REFINES/SUPERSEDES. ClaimRelation UI is not part of M2-B.

## 4. Product semantics

### 4.1 Research Issue versus Claim

A Research Issue is a question/workflow object.

A Claim is a possible answer/proposition.

Example:

```text
Issue:
刘祥店村是否在 1960 年代发生整体迁出？

Claims:
A. 刘祥店在 1960 年代发生过一次整体迁出。
B. 刘祥店人口变化是渐进外迁，而不是一次整体迁出。
C. 大规模迁移发生在 1960 年代之后。
```

The UI MUST NOT label any of these as correct, supported, likely, accepted, rejected, or preferred.

### 4.2 No semantic de-duplication by statement

The architecture explicitly does not use Claim statement text as canonical identity.

Therefore:

- there is no `UNIQUE(statement)`;
- two distinct Claim IDs may have identical normalized statement text;
- M2-B does not globally search for an existing Claim by text and silently reuse it;
- M2-B does not provide “attach existing Claim” yet.

Idempotency protects request retry, not semantic deduplication.

### 4.3 No truth/confidence state in Claim

M2-B MUST NOT add confidence, support/reject stance, probability, or truth state to Claim.

Those belong to Assessment in a later phase.

## 5. M2-B scope

M2-B includes:

1. list Claims attached to one Research Issue;
2. create a new ACTIVE Claim and attach it to that Issue atomically;
3. safe idempotent create/replay;
4. read Claims for ACTIVE or archived/read-only contexts;
5. integrate a separately degradable “可能答案” section into existing Issue Detail;
6. preserve Claim immutability and frozen schema boundaries.

M2-B excludes:

- EvidenceManifest / EvidenceManifestItem;
- selecting Project Materials or Notes as evidence;
- Assessment / confidence;
- IssueResolution / preferred Claim;
- ResearchRun;
- ClaimRelation UI;
- Claim edit;
- Claim delete / hard delete;
- Claim archive/retract UI;
- link-existing-Claim UI;
- global Claim search;
- AI Claim generation, rewriting, ranking, or summarization;
- Issue lifecycle mutation;
- Project Overview expansion;
- schema migration;
- production deployment.

## 6. Claim API shape

M2-B adds only Issue-scoped endpoints:

```http
GET  /api/private/s32/projects/:projectId/issues/:issueId/claims
POST /api/private/s32/projects/:projectId/issues/:issueId/claims
```

There is no global Claim route in M2-B.

### 6.1 Claim response type

```ts
interface CandidateClaim {
  id: string;
  statement: string;
  lifecycleState: "ACTIVE" | "ARCHIVED";
  createdAt: string;
  updatedAt: string;
}
```

GET response:

```json
{
  "claims": []
}
```

POST response:

```json
{
  "claim": {
    "id": "uuid",
    "statement": "...",
    "lifecycleState": "ACTIVE",
    "createdAt": "...",
    "updatedAt": "..."
  }
}
```

The path itself establishes Project and Issue context. The Claim response does not duplicate Project or full Issue objects.

## 7. Claim statement input contract

POST accepts:

```json
{
  "statement": "..."
}
```

M2-B canonical input normalization is application-level and does not modify the frozen SQL schema.

Normalization:

1. input must be a string;
2. CRLF → LF;
3. remaining CR → LF;
4. every Unicode `White_Space` run collapses to one ASCII space;
5. trim leading/trailing Unicode whitespace;
6. reject U+0000/NUL because PostgreSQL text cannot store it;
7. after normalization, length must be 1–4000 Unicode code points;
8. result is stored as plain text.

This creates one stable canonical statement for hashing and display while allowing punctuation and non-ASCII text.

M2-B does not parse Markdown/HTML and does not infer Claim type.

## 8. Project and Issue access rules

All Claim access is anchored through:

```text
Project → exact owned Research Issue → research_issue_claims → Claim
```

The server MUST reuse M2-A ownership semantics:

- Project missing → 404;
- Issue missing → 404;
- Issue belongs to a different Project → 404;
- Issue owner binding count 0 or >1 → generic integrity failure;
- non-null Issue binding_role → generic integrity failure;
- dangling RESEARCH_ISSUE ProjectBinding → generic integrity failure.

Claims are not Project-owned via ProjectBinding; they are visible through an authorized Issue relation.

## 9. Read behavior

Claim GET is allowed when:

- Project is ACTIVE or ARCHIVED;
- Issue is OPEN, RESOLVED, or ARCHIVED.

Read-only state must never erase historical Claims from view.

The list store uses one `REPEATABLE READ, READ ONLY` transaction.

The query path MUST use relation-first / fail-closed semantics so a dangling `research_issue_claims.claim_id` cannot disappear through an inner join.

A relation pointing to a missing or canonically invalid Claim is an integrity error, not an empty list.

No N+1 query behavior is allowed.

Stable ordering:

1. ACTIVE before ARCHIVED;
2. `created_at ASC`;
3. `id ASC` as the final deterministic tie-break.

The chronological order intentionally preserves the development of competing hypotheses.

## 10. Create behavior

A genuinely new Claim may be created only when:

```text
Project.lifecycle_state = ACTIVE
AND
ResearchIssue.lifecycle_state = OPEN
```

New Claim creation is forbidden when:

- Project is ARCHIVED → 409 `PROJECT_READ_ONLY`;
- Issue is RESOLVED or ARCHIVED → 409 `RESEARCH_ISSUE_READ_ONLY`.

M2-B does not add Issue lifecycle mutation; it only respects the existing lifecycle values.

## 11. Atomic PostgreSQL command

For a genuinely new request, one transaction must:

1. reserve the idempotency key;
2. lock/read the Project;
3. lock/read the exact Issue and validate its single Project ownership;
4. confirm Project is ACTIVE;
5. confirm Issue is OPEN;
6. insert one `core.claims` row;
7. insert one `core.research_issue_claims` row;
8. mark idempotency row COMPLETED with `resource_type='CLAIM'` and the Claim ID;
9. re-read/validate the canonical Claim before returning;
10. commit.

Any failure rolls back all steps.

The implementation MUST NOT leave an unattached Claim if the Issue relation insert fails.

## 12. Idempotency contract

POST requires `Idempotency-Key`, using the same UUID contract as M2-A.

Scope:

```text
S32:M2B:PROJECT_ISSUE_CLAIM_CREATE:<projectId>:<issueId>
```

The server computes its own SHA-256 request hash from canonical values:

```json
{
  "projectId": "lowercase uuid",
  "issueId": "lowercase uuid",
  "statement": "normalized statement"
}
```

The browser does not send the hash.

### 12.1 First create

New key + valid writable Project/Issue:

- create Claim + relation;
- complete idempotency receipt;
- return 201.

### 12.2 Same-key replay

Same key + same request hash after a completed create:

- return the same canonical Claim;
- return 200;
- do not create a second Claim or relation.

Completed replay remains valid even if the Project later becomes ARCHIVED or the Issue later becomes RESOLVED/ARCHIVED. A replay is recovery of a completed command, not a new semantic write.

Replay must still fail closed if the recorded Claim or its Issue relation/ownership is corrupted.

### 12.3 Same key, different payload

Same scope + same key + different request hash:

- return 409 `IDEMPOTENCY_CONFLICT`;
- create nothing.

The server MUST NOT silently mint a replacement key.

## 13. Browser pending receipt

The Web layer reuses the proven M2-A response-unknown semantics.

Session storage contains only:

```json
{
  "projectId": "uuid",
  "issueId": "uuid",
  "requestHash": "sha256",
  "idempotencyKey": "uuid",
  "createdAt": "ISO timestamp"
}
```

It MUST NOT store Claim statement text.

The page-local receipt state must preserve the M2-A three-state authority model:

```text
undefined = not restored yet
receipt   = current authoritative pending intent
null      = explicit page-local clear tombstone
```

After restore/save/clear, stale persistent storage must not override current page-local state.

A successful restore must be cached into memory.

A failed persistence write cannot guarantee recovery across a full page reload; the UI and acceptance claims must not promise otherwise.

While a create result is unconfirmed:

- statement input is frozen;
- retry uses the same normalized payload and same idempotency key;
- changing intent requires an explicit separate action/new submission.

## 14. Error mapping

M2-B adds/uses typed API errors:

```text
400 CLAIM_INVALID_INPUT
404 PROJECT_OR_ISSUE_NOT_FOUND        (public safe shape; no cross-Project disclosure)
409 PROJECT_READ_ONLY
409 RESEARCH_ISSUE_READ_ONLY
409 IDEMPOTENCY_CONFLICT
500 generic canonical integrity failure
503 Claim store unavailable
```

The API MUST NOT expose SQL details, owner IDs from another Project, or internal corruption detail to the browser.

## 15. Web Issue Detail integration

The existing M2-A Issue Detail remains the canonical Issue screen.

Its “可能答案” placeholder becomes a separately loaded Claim section.

States:

```text
loading
ready
unavailable
```

Issue Detail and Claims must not be coupled through one Promise.all.

Required behavior:

- Issue ready + Claims failed → Issue remains fully visible; Claim section says “可能答案暂不可用” with retry.
- Issue ready + Claims empty → “还没有可能答案。”
- Issue ready + Claims present → render Claim cards.
- ACTIVE Project + OPEN Issue → show “添加可能答案”.
- ARCHIVED Project or non-OPEN Issue → Claims remain readable; create control hidden.

Claim cards show only:

- lifecycle badge;
- statement;
- created time.

M2-B does not show confidence, evidence count, support/reject badges, “preferred answer,” or truth language.

Claim cards are not global-detail links in M2-B.

## 16. Claim creation UX

The create form has one field:

```text
可能答案
[ statement textarea/input ]
```

First successful create:

- append/refresh the canonical Claim list;
- clear the pending receipt;
- reset the form.

Response unknown:

- keep the pending receipt;
- freeze input;
- show explicit same-identifier retry action.

409 `IDEMPOTENCY_CONFLICT`:

- do not auto-retry with a new key;
- require explicit “作为新的可能答案重新提交” action.

Definite 400 / PROJECT_READ_ONLY / RESEARCH_ISSUE_READ_ONLY:

- clear the pending receipt;
- show the typed safe error.

## 17. Canonical integrity checks

M2-B store reads must validate:

- Claim ID is UUID;
- statement is already canonical according to M2-B normalization;
- lifecycle is ACTIVE or ARCHIVED;
- `claim_type IS NULL` for M2-B-created Issue claims;
- `subject_type IS NULL` and `subject_id IS NULL` for M2-B-created Issue claims;
- metadata is an object;
- timestamps are valid;
- relation points to the requested Issue.

M2-B does not assume every historical Claim in the database was created by M2-B. Therefore GET must not reject a legitimate future/global Claim solely because `claim_type` or subject fields are non-null. The stricter NULL invariant applies to the row created by the M2-B command and its replay verification, not to all canonical Claims forever.

This distinction preserves the long-term schema goal that one Claim can serve multiple contexts.

## 18. No hidden Assessment/Resolution semantics

The following interpretations are explicitly forbidden in M2-B:

- list order means likelihood;
- first Claim means preferred answer;
- ACTIVE means supported/true;
- ARCHIVED means false/rejected;
- newest Claim supersedes older Claims;
- identical statement means same canonical Claim.

Any future preferred/current answer must be represented by IssueResolution, not inferred from Claim presentation.

## 19. Database invariant boundary discovered during design

Historical P29 material once described a database-level invariant:

```text
(issue_id, preferred_claim_id)
  -> research_issue_claims(issue_id, claim_id)
```

The executable migration on the current source baseline does not contain that composite preferred-Claim FK. It currently has:

- a normal FK from `issue_resolutions.preferred_claim_id` to `claims.id`;
- a composite deferred FK ensuring `research_issues.current_resolution_id` points to a Resolution belonging to the same Issue.

Therefore M2-B deliberately does not implement IssueResolution.

When Resolution is designed later, “preferred Claim belongs to the Issue” must be explicitly enforced as an application transaction invariant unless a separately approved schema migration changes the database contract.

M2-B MUST NOT silently modify M0 to restore the historical draft constraint.

## 20. Testing and acceptance

Implementation is not complete until the following are proven.

### Domain/application

1. statement normalization is deterministic across Unicode whitespace and CR/LF forms;
2. NUL is rejected before PostgreSQL;
3. same canonical input produces the same request hash;
4. different Project or Issue IDs produce different request hashes/scopes;
5. Claim statement cannot be updated through an API path;
6. Claim creation returns only ACTIVE canonical rows.

### PostgreSQL/store

7. create inserts exactly one Claim and one Issue relation atomically;
8. relation failure rolls back the Claim;
9. same-key/same-hash concurrent or sequential replay returns one Claim;
10. same-key/different-hash returns conflict with no extra Claim;
11. wrong-Project Issue lookup returns 404 behavior;
12. orphan/multi-owner/dangling Issue ownership fails closed;
13. dangling Issue→Claim relation fails closed;
14. new create rejects archived Project;
15. new create rejects RESOLVED/ARCHIVED Issue;
16. completed same-key replay still returns the original Claim after Project/Issue later becomes read-only;
17. restart preserves list and completed replay;
18. frozen SQL remains byte-for-byte unchanged.

### Web/API client

19. Claim payload validation rejects malformed server responses;
20. Claim section failure does not hide Issue Detail;
21. empty Claim section renders a true empty state, not “unavailable”;
22. read-only contexts hide create UI without hiding Claims;
23. unconfirmed state freezes statement input;
24. stale-storage/write-failure retry keeps the current Claim key, not an older stored key;
25. clear tombstone survives removeItem failure;
26. fresh restore is cached before later read failure;
27. idempotency conflict requires explicit new-intent action.

### Real browser acceptance

28. ACTIVE Project + OPEN Issue: create Claim → 201 → one Claim + one relation → visible after canonical re-read;
29. response is dropped only after the API commit; unchanged retry sends identical payload/key → 200 → same Claim ID → database count remains 1/1;
30. archived Project: list readable, new key rejected, completed replay succeeds;
31. non-OPEN Issue: list readable, new key rejected, completed replay succeeds;
32. Claim API failure leaves Issue content visible;
33. API/PG restart preserves list/replay;
34. 390×844 Issue Detail/Claim form has no horizontal overflow.

## 21. Verification scope

M2-B changes product code but not schema.

Expected implementation verification includes:

- targeted domain/application/store/route tests;
- API S32 scoped suite;
- Web research scoped suite;
- relevant broader Web suite;
- API build;
- Web build;
- schema static tests;
- frozen SQL diff;
- `git diff --check`;
- disposable PostgreSQL 16 integration for Claim create/replay/integrity behavior;
- real browser acceptance above.

Known unrelated broad-suite failures must remain explicitly separated from M2-B scoped evidence.

## 22. Repository and production boundaries

M2-B implementation, when separately approved, must:

- start from the actual then-current `main`, not assume this planning baseline is still current;
- use an isolated local worktree/feature branch;
- preserve existing uncommitted work;
- keep one writer per worktree;
- keep the M0 migration and both frozen SQL test files unchanged;
- use disposable PostgreSQL for integration;
- not modify Tencent/production runtime;
- not deploy PostgreSQL;
- not publish images;
- not start M2-C.

This written spec does not itself authorize implementation.

## 23. Phase decomposition after M2-B

The intended next research stack is:

```text
M2-A  Research Issues             MERGED
M2-B  Candidate Claims            THIS SPEC
M2-C  Evidence selection/manifests
M2-D  Assessments
M2-E  Issue Resolution
```

ResearchRun, ClaimRelation UI, attach-existing-Claim, AI assistance, and global Claim search remain later decisions and are not implicitly authorized by this sequence.

## 24. Design gate

```text
M2_A_IMPLEMENTATION=MERGED
M2_A_MERGE_COMMIT=beb3888600c6c9520624093da00619d74a15d68f

M2_B_NAME=CANDIDATE_CLAIMS
M2_B_SCOPE=RESEARCH_ISSUE_TO_COMPETING_CLAIMS
M2_B_TABLES=core.claims,core.research_issue_claims
M2_B_SCHEMA_CHANGE=NO
M2_B_EVIDENCE=DEFER_M2_C
M2_B_ASSESSMENT=DEFER_M2_D
M2_B_RESOLUTION=DEFER_M2_E
M2_B_RESEARCH_RUN=DEFER
M2_B_CLAIM_RELATION_UI=DEFER

M2_B_WRITTEN_SPEC=READY_FOR_USER_REVIEW
M2_B_IMPLEMENTATION_PLAN=NOT_STARTED
M2_B_IMPLEMENTATION=NOT_STARTED

PRODUCTION_CHANGED=NO
PRODUCTION_DEPLOYED=NO
```

The next gate is explicit user approval of this written spec. Only after that approval may an M2-B implementation plan be written.
