# S32 M2-A Research Issues — Design

**Date:** 2026-09-20  
**Status:** Written spec for review  
**Source baseline:** `main@4204815f8a550ad8ce9fa0ab7bdf4afe486f1e56`  
**Planning branch:** `plan/s32-m2a-research-issues`  
**Scope:** M2-A only. No production deployment. No M2-B implementation.

## 1. Intent

M1 completed the first durable research loop:

```text
Search
→ canonical Work / Edition / Source
→ Project
→ Note / immutable Revision
→ rediscover the same book and return to the exact ProjectBinding
```

M2 starts the next layer: organizing research around explicit questions rather than only around collected materials.

M2-A introduces **Project-owned Research Issues**. A Research Issue is the question the user is trying to answer inside a Project. This slice does not yet implement possible answers (Claims), evidence, assessment, or resolution. It establishes the durable root those later objects will attach to.

A successful M2-A experience is:

```text
Project
→ create a research question
→ enter that Research Issue
→ refresh/restart and recover it from PostgreSQL
→ return to Project and see the question summarized
→ archived Projects remain readable
→ retries do not duplicate Issues
```

## 2. Architectural classification

This is an architectural change because it introduces a new S32 bounded context, new API surface, idempotent write semantics, new canonical integrity rules, and a new independent Project-page data flow.

The existing M0 frozen schema already contains the required storage:

- `core.research_issues`
- `core.project_bindings`
- `ops.idempotency_keys`

M2-A therefore requires **no schema migration**.

## 3. Selected approach

### 3.1 Project-required Issues

Every Research Issue must belong to a Project.

```text
Project
└── Research Issue
```

There are no global/orphan Issues in the product model.

Creation writes both objects in one PostgreSQL transaction:

```text
core.research_issues
+
core.project_bindings
  project_id = <Project.id>
  target_type = RESEARCH_ISSUE
  target_id = <ResearchIssue.id>
  binding_role = NULL
  metadata = {}
```

If either write fails, the transaction rolls back.

### 3.2 Single-owner invariant

A Research Issue is Project-local and must have exactly one owner binding globally.

For a valid Issue:

```text
COUNT(project_bindings
      WHERE target_type='RESEARCH_ISSUE'
        AND target_id=<issueId>) = 1
```

and that binding is the Issue's owner Project.

Application reads treat these states as canonical integrity failures:

- zero owner bindings for an Issue being directly read;
- more than one owner binding;
- non-null `binding_role`;
- owner binding metadata that is not a JSON object.

A valid Issue owned by another Project is **not corruption**; when requested through the wrong Project route it returns 404 and does not disclose the owning Project.

The frozen database schema is not modified to encode this invariant. M2-A enforces it in the application/store layer.

### 3.3 OPEN-only creation

M2-A creates only:

```text
lifecycle_state = OPEN
current_resolution_id = NULL
```

Existing `OPEN`, `RESOLVED`, and `ARCHIVED` Issues may all be read.

M2-A does not implement:

- resolve;
- archive;
- reopen;
- edit;
- delete.

Those transitions are deferred until later M2 slices define Claims/Evidence/Resolution semantics.

### 3.4 Project lifecycle and effective read-only behavior

Project lifecycle and Issue lifecycle remain separate.

An archived Project does not mutate child Issue lifecycle.

Example:

```text
Project = ARCHIVED
Issue = OPEN
```

The Issue remains historically `OPEN`, but the Project context is read-only.

Rules:

```text
ACTIVE Project
  GET list/detail = allowed
  POST create     = allowed

ARCHIVED Project
  GET list/detail = allowed
  POST create     = 409 PROJECT_READ_ONLY
```

## 4. Alternatives considered

### 4.1 Put Issues into the existing Project Overview response

Rejected.

M1-E Overview is the materials/current-Note projection. Adding Issues there would couple two bounded contexts and make future Claims/Evidence expansion turn `/overview` into an increasingly large endpoint.

Selected structure:

```text
Project page
├── GET /projects/:projectId/overview
└── GET /projects/:projectId/issues
```

They load independently.

### 4.2 Allow one Issue to appear in several Projects

Rejected for M2-A.

Multi-owner Issues make Project context ambiguous and complicate future Claim/Evidence ownership. M2-A uses strict single-owner semantics.

### 4.3 Deduplicate Issues by title/question content

Rejected.

Two intentionally distinct research questions may have identical wording. Text equality is not canonical identity.

No fuzzy or exact content merge is performed.

### 4.4 No idempotency and rely on the disabled submit button

Rejected.

A request can commit while the browser loses the response. A later retry would legally create a second Issue because Research Issues have no natural external identity.

M2-A therefore uses `ops.idempotency_keys`.

## 5. Domain model

### 5.1 Project context

Both list and detail responses return only the minimal Project context needed by the Issues bounded context:

```ts
type ResearchIssueProjectContext = {
  id: string;
  name: string;
  lifecycleState: "ACTIVE" | "ARCHIVED";
  readOnly: boolean;
};
```

`readOnly` is true exactly when Project lifecycle is `ARCHIVED`.

This is not an expansion of M1-E Project Overview.

### 5.2 Issue detail

```ts
type ResearchIssue = {
  id: string;
  projectId: string;
  title: string;
  question: string;
  lifecycleState: "OPEN" | "RESOLVED" | "ARCHIVED";
  createdAt: string;
  updatedAt: string;
};
```

### 5.3 Issue list summary

The Project list does not need the full 4,000-code-point question for every card. It uses a dedicated summary read model:

```ts
type ResearchIssueSummary = {
  id: string;
  projectId: string;
  title: string;
  questionExcerpt: string;
  lifecycleState: "OPEN" | "RESOLVED" | "ARCHIVED";
  createdAt: string;
  updatedAt: string;
};
```

The full `question` is returned by the detail endpoint.

## 6. Input normalization

### 6.1 Title

Input rules are applied before request hashing or persistence:

1. value must be a string;
2. trim leading/trailing Unicode whitespace;
3. result must be non-empty;
4. CR or LF anywhere is invalid; title is single-line;
5. length must be 1–160 Unicode code points;
6. preserve internal spacing/content exactly after trim.

Do not collapse internal whitespace.

### 6.2 Question

Normalization:

1. value must be a string;
2. CRLF → LF;
3. remaining CR → LF;
4. trim leading/trailing Unicode whitespace;
5. result must be non-empty;
6. length must be 1–4000 Unicode code points;
7. preserve internal newlines and internal spacing.

Question is plain text in M2-A.

No Markdown parsing, rich text, HTML rendering, or AI rewriting is introduced.

### 6.3 Read integrity

Rows read from PostgreSQL must already satisfy the canonical stored form.

Fail closed with a generic integrity error if a returned Issue has:

- invalid lifecycle;
- blank title/question;
- title with CR/LF;
- leading/trailing whitespace that would change under canonical normalization;
- question containing CR;
- title/question exceeding their code-point limits.

M2-A does not add semantic validation between `RESOLVED` and `current_resolution_id`; that belongs to M2-E.

## 7. Question excerpt

Project Issue cards show a runtime-only question excerpt.

Algorithm:

1. CRLF → LF;
2. remaining CR → LF;
3. every run of Unicode whitespace → one ASCII space;
4. trim;
5. count with Unicode code points, not UTF-16 code units;
6. if length <= 160 code points, return unchanged;
7. otherwise return the first 160 code points plus `…`.

Example implementation semantics should use `Array.from(text)` for the boundary.

The excerpt is:

- not persisted;
- not part of the Issue request hash;
- not written back to `question`;
- not Markdown/HTML;
- not AI-generated.

## 8. API surface

All routes remain under the existing private S32 auth/no-store boundary.

### 8.1 Create

```http
POST /api/private/s32/projects/:projectId/issues
Authorization: Bearer <S32 token>
Idempotency-Key: <uuid>
Content-Type: application/json
```

Body:

```json
{
  "title": "刘祥店迁出时间",
  "question": "刘祥店村是否在 1960 年代发生整体迁出？"
}
```

First successful creation:

```http
201 Created
```

Replay of the same completed idempotent request:

```http
200 OK
```

Both return the same response shape:

```json
{
  "project": {
    "id": "...",
    "name": "北京古道研究",
    "lifecycleState": "ACTIVE",
    "readOnly": false
  },
  "issue": {
    "id": "...",
    "projectId": "...",
    "title": "刘祥店迁出时间",
    "question": "刘祥店村是否在 1960 年代发生整体迁出？",
    "lifecycleState": "OPEN",
    "createdAt": "...",
    "updatedAt": "..."
  }
}
```

No replay flag is required in the response.

Missing/malformed Idempotency-Key or malformed input returns 400.

Archived Project returns:

```json
{
  "error": {
    "code": "PROJECT_READ_ONLY",
    "message": "项目已归档，只能查看研究内容。"
  }
}
```

with HTTP 409.

Same key with a different normalized request hash returns:

```json
{
  "error": {
    "code": "IDEMPOTENCY_CONFLICT",
    "message": "创建请求标识与当前研究问题内容不一致。"
  }
}
```

with HTTP 409.

### 8.2 List

```http
GET /api/private/s32/projects/:projectId/issues
```

Success:

```json
{
  "project": {
    "id": "...",
    "name": "北京古道研究",
    "lifecycleState": "ACTIVE",
    "readOnly": false
  },
  "issues": [
    {
      "id": "...",
      "projectId": "...",
      "title": "刘祥店迁出时间",
      "questionExcerpt": "刘祥店村是否在 1960 年代发生整体迁出？如果是，现有证据能否……",
      "lifecycleState": "OPEN",
      "createdAt": "...",
      "updatedAt": "..."
    }
  ]
}
```

A valid empty list is explicit:

```json
{
  "project": { "...": "..." },
  "issues": []
}
```

Storage/integrity failure is never represented as an empty list.

Ordering:

1. `OPEN`
2. `RESOLVED`
3. `ARCHIVED`
4. within lifecycle: `updated_at DESC`
5. stable tie-break: `id DESC`

### 8.3 Detail

```http
GET /api/private/s32/projects/:projectId/issues/:issueId
```

Returns `{ project, issue }` with the full question.

Error semantics:

```text
Project missing                       → 404
Issue missing                         → 404
Issue validly owned by another Project→ 404
Issue owner count = 0                 → 500 generic integrity error
Issue owner count > 1                 → 500 generic integrity error
Issue malformed                        → 500 generic integrity error
store unavailable                      → 503
```

The 404 case must not reveal which Project owns an Issue.

## 9. Idempotency contract

### 9.1 Header format

M2-A requires `Idempotency-Key` on create.

The browser generates it with `crypto.randomUUID()`. The server validates a UUID-form key; missing or malformed keys are 400.

### 9.2 Scope

```text
S32:M2A:PROJECT_ISSUE_CREATE:<lowercase-projectId>
```

The `ops.idempotency_keys` unique constraint on `(scope, idempotency_key)` protects one Project's create operation.

### 9.3 Request hash

The server computes the hash itself after canonical input normalization.

Canonical hash payload has fixed field order:

```json
{
  "projectId": "<lowercase uuid>",
  "title": "<normalized title>",
  "question": "<normalized question>"
}
```

Hash:

```text
sha256(UTF-8(JSON.stringify(canonicalPayload)))
```

stored as lowercase hex.

The browser may calculate the same hash only to decide whether a session receipt still matches its current normalized input. Browser-supplied hash is never trusted by the API.

### 9.4 Atomic transaction

Creation and idempotency completion live in the same transaction.

Conceptual flow:

```text
BEGIN
  validate/lock ACTIVE Project

  INSERT idempotency reservation
    or wait for/conflict with same scope+key

  if existing COMPLETED:
    require same request_hash
    reload canonical Issue
    verify ownership
    return replay

  if same key but different hash:
    409 IDEMPOTENCY_CONFLICT

  INSERT research_issues(OPEN, current_resolution_id=NULL)
  INSERT project_bindings(RESEARCH_ISSUE)

  verify exact single-owner invariant

  UPDATE idempotency row:
    status = COMPLETED
    resource_type = RESEARCH_ISSUE
    resource_id = issue.id
    result_payload = minimal deterministic receipt
    completed_at = now()

COMMIT
```

The transaction must serialize two concurrent requests using the same key so both end with the same Issue and the database grows by exactly one Issue and one owner binding.

M2-A does not require persisting a `FAILED` idempotency row for rolled-back creates.

### 9.5 Replay safety

A completed replay must not trust stale `result_payload` as canonical truth.

Use the stored `resource_id` to reload the Issue and verify:

- Issue still exists;
- exactly one owner binding exists;
- owner Project matches scope/route;
- Issue is canonical.

If canonical state is corrupt, fail closed.

## 10. Browser pending receipt

The browser stores only a small session receipt, for example:

```json
{
  "projectId": "...",
  "requestHash": "...",
  "idempotencyKey": "...",
  "createdAt": "..."
}
```

Do not store title/question content in this receipt.

Receipt semantics:

- first submission for a normalized payload → generate key;
- response confirmed 200/201 → clear receipt and navigate to detail;
- network failure / timeout / 500 / 503 / dispatched request later aborted → keep receipt;
- same Project + same normalized payload retry → reuse key;
- normalized payload changed → old receipt no longer applies; generate a new key for the new user intent;
- definitive input/project errors (400, 404, PROJECT_READ_ONLY) may clear the receipt;
- `IDEMPOTENCY_CONFLICT` must not trigger an automatic new key/retry;
- after conflict, only an explicit user action such as “作为新的研究问题重新提交” creates a fresh key.

A request abort after dispatch is treated as outcome-unknown because the server may already have committed.

## 11. PostgreSQL read models

### 11.1 Transactions

Issue list and detail use:

```sql
BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY
```

This gives each endpoint a self-consistent Project/Issue ownership snapshot.

### 11.2 Fixed query count

List and detail must use a fixed number of SQL statements independent of Issue count.

No per-Issue ownership query is allowed.

A typical list implementation may use:

1. one Project query;
2. one Issue+owner-count projection query using CTE/grouping/window logic.

A typical detail implementation may use:

1. one Project query;
2. one Issue+all-owner-bindings query.

The exact SQL may differ, but the query count must not grow with the number of Issues.

### 11.3 List ownership integrity

The list query begins from owner bindings for the requested Project, then validates global owner count for every returned `issue_id`.

If a returned Issue has more than one global owner, the whole list request fails with generic 500; do not omit only the corrupt row.

An orphan Issue with zero bindings cannot naturally appear in a Project list. The orphan invariant is therefore tested through direct detail lookup, where the Issue row is explicitly addressed and its zero-owner state can be detected.

### 11.4 Binding metadata

Owner truth is:

```text
project_id + target_type=RESEARCH_ISSUE + target_id
```

`metadata` is not identity truth.

M2-A creates `metadata={}`. Reads require metadata to be a JSON object but do not require it to remain exactly empty, preserving future extensibility.

## 12. Frontend architecture

### 12.1 Independent bounded-context state

The Project page loads:

```text
Materials:
GET /projects/:projectId/overview

Research Issues:
GET /projects/:projectId/issues
```

with separate request lifecycles and AbortControllers.

Do not wrap them in one `Promise.all()` whose failure hides both sections.

Each context owns:

```text
loading
ready
unavailable
retry
```

Authentication error handling may use the existing shared S32 credential UX, but a storage/integrity failure in one context must not erase the other context.

Examples:

```text
Issues 200 + Overview 500
→ Issues visible
→ Materials unavailable panel

Overview 200 + Issues 500
→ Materials visible
→ Issues unavailable panel
```

Only `ready + issues=[]` may render “还没有研究问题”.

### 12.2 Project shell context

When both endpoints succeed, either contains valid Project identity/lifecycle context.

If Overview is unavailable but Issues succeeds, the Project page can still render the Project name/lifecycle using the Issues response.

The two independent endpoint responses are not required to be cross-request transactionally identical; normal later refresh resolves a concurrent Project lifecycle/name change.

### 12.3 Section placement

Research Issues appear before Materials:

```text
Project header

研究问题
────────
OPEN
刘祥店迁出时间
刘祥店村是否在 1960 年代发生整体迁出？……
更新于 …

[+ 新建研究问题]

研究资料
────────
...
```

ACTIVE Project: create control visible.

ARCHIVED Project: Issues remain readable and no create control is shown.

The server remains authoritative and rejects archived creation even if UI controls are bypassed.

### 12.4 Create form states

Creation has state independent from list loading:

```text
idle
submitting
unconfirmed
rejected
idempotency-conflict
```

`unconfirmed` is used when the request may have committed but the browser cannot prove the result:

- network failure;
- timeout;
- 500/503;
- dispatched request aborted.

Copy should explain that retry uses the same request identifier and will not intentionally create a duplicate.

### 12.5 Create success

A confirmed 200/201 response:

1. clears the pending receipt;
2. navigates directly to:

```text
/research/projects/:projectId/issues/:issueId
```

The browser does not need to optimistically append the Issue to the Project list because it leaves the page.

When the user later returns to Project, the canonical list is fetched again.

## 13. Issue Detail

Route:

```text
/research/projects/:projectId/issues/:issueId
```

M2-A detail shows only:

- back navigation with Project name;
- Issue title;
- lifecycle state;
- full question;
- created/updated timestamps;
- a “可能答案” empty state explaining that Claims arrive in M2-B;
- a normal link back to the Project/materials page.

M2-A Issue Detail does **not** embed:

- Project materials;
- Notes;
- Claims;
- Evidence;
- Assessments;
- Resolution.

Detail uses only the dedicated Issue detail endpoint; it does not require `/overview`.

## 14. Error/degradation semantics

Private routes keep existing S32 auth and `Cache-Control: no-store`.

Suggested application errors:

```ts
InvalidResearchIssueInputError
InvalidIdempotencyKeyError
ProjectNotFoundError
ProjectReadOnlyError
ResearchIssueNotFoundError
ResearchIssueIntegrityError
ResearchIssueStoreUnavailableError
IdempotencyConflictError
```

Transport behavior:

```text
invalid input / key             → 400
Project or scoped Issue missing → 404
PROJECT_READ_ONLY               → 409 + code
IDEMPOTENCY_CONFLICT            → 409 + code
integrity failure               → 500 generic
store unavailable               → 503
unknown                         → 500 generic
```

Never include private integrity details in the HTTP response.

## 15. Acceptance requirements

M2-A is not complete until all of the following are demonstrated locally.

### 15.1 Normal ACTIVE Project loop

```text
open ACTIVE Project
→ see Research Issues section
→ create “刘祥店迁出时间”
→ server returns 201
→ navigate to exact Issue Detail
→ title/question/OPEN visible
→ return to Project
→ Issue appears in canonical list
→ card questionExcerpt matches runtime algorithm
```

### 15.2 Persistence

After local API/PostgreSQL restart with the development volume preserved:

- Issue detail still loads;
- Project Issue list still contains it;
- ownership remains valid.

### 15.3 Idempotent retry/concurrency

Real PostgreSQL proof:

- same Project/key/payload concurrent create;
- both requests return the same Issue id;
- row deltas: exactly +1 Issue, +1 ProjectBinding, +1 completed idempotency key.

Response-unknown browser flow:

- dispatch create;
- simulate lost/unknown response;
- retry unchanged form;
- browser reuses original key;
- same Issue is recovered;
- no duplicate Issue.

### 15.4 Conflict

Same scope/key with different normalized payload:

- HTTP 409 `IDEMPOTENCY_CONFLICT`;
- no second Issue;
- UI does not silently mint a new key and retry.

### 15.5 Archived Project

```text
ARCHIVED Project
→ list Issues readable
→ detail readable
→ no create UI
→ direct create API = 409 PROJECT_READ_ONLY
→ no row-count change
```

### 15.6 Integrity failure

Inject test corruption in disposable PostgreSQL:

- Issue with zero owner bindings addressed via detail → generic 500;
- Issue with two owner bindings → list/detail generic 500;
- non-null owner `binding_role` → generic 500;
- malformed canonical title/question/lifecycle → generic 500.

### 15.7 Cross-Project privacy

A valid Issue owned by Project B requested via Project A:

- returns 404;
- response does not identify Project B.

### 15.8 Independent degradation

Browser acceptance verifies:

- Issues endpoint failure does not hide working Materials;
- Overview failure does not hide working Issues;
- only a confirmed empty Issues response displays the empty state.

### 15.9 Excerpt

Automated tests cover:

- whitespace normalization;
- exactly 160 code points;
- 161 code points adds `…`;
- supplementary-plane Unicode boundary;
- excerpt never changes stored question.

### 15.10 Mobile

Real browser at 390px width:

- Project Issues section has no horizontal overflow;
- create form has no horizontal overflow;
- Issue Detail has no horizontal overflow.

## 16. Real PostgreSQL verification

Use a disposable isolated PostgreSQL 16 instance, separate from persistent local development PG.

Requirements mirror prior S32 integration runners:

- random password;
- loopback random port;
- tmpfs where practical;
- owner label;
- deterministic cleanup in finally;
- apply only frozen M0 migration;
- no production access.

The runner must verify atomic rollback, idempotency concurrency, ownership corruption detection, archived write rejection, and restart-safe canonical persistence as appropriate.

## 17. Security and privacy boundaries

- private S32 auth remains mandatory;
- same-origin/private API rules remain unchanged;
- `Cache-Control: no-store`;
- wrong-Project Issue access returns 404 without owner disclosure;
- browser pending receipt does not store question/title content;
- database/integrity messages are not exposed to the client;
- no production credentials or environment changes are part of M2-A.

## 18. Explicit exclusions

M2-A does not implement:

- Claim creation/editing;
- Claim relations;
- EvidenceManifest or EvidenceManifestItem;
- Assessment;
- IssueResolution;
- ResearchRun;
- Issue lifecycle mutation;
- Issue edit;
- Issue delete/hard delete;
- Issue move/copy/share/multi-owner behavior;
- global Issue search;
- Issue ↔ Edition/Source/Note direct links;
- material selection inside Issue Detail;
- AI issue generation;
- AI rewriting;
- AI summaries;
- Markdown/rich-text Issue questions;
- Project Overview response expansion;
- new database migration/schema changes;
- M2-B;
- production deployment.

## 19. Frozen boundaries

These M0 files remain unchanged:

```text
db/migrations/001_s32_core_schema.sql
db/tests/001_s32_schema_assertions.sql
db/tests/002_s32_negative_invariants.sql
```

M2-A uses the already-frozen tables rather than modifying them.

## 20. Delivery boundary

The implementation stage, once separately approved, should finish with:

```text
M2_A_IMPLEMENTATION=COMPLETE_ON_BRANCH
M2_A_PR=OPEN
M2_A_MERGED=NO
PRODUCTION_CHANGED=NO
PRODUCTION_DEPLOYED=NO
M2_B_STARTED=NO
NEXT_ACTION=REVIEW_M2_A_PR
```

Source merge and production deployment remain separate authorization gates.

## 21. Design status

All conversational design decisions required for M2-A are incorporated into this written spec.

The next gate is explicit review/approval of this written spec. Only after written-spec approval should an implementation plan be created.
