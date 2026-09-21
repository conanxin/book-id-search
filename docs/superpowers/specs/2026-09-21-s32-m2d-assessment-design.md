# S32 M2-D Assessment + Atomic Evidence Commit Design

**Status:** Conversational design approved; written spec ready for user review  
**Task ID:** `S32_M2D_ASSESSMENT_DESIGN_R1`  
**Source baseline:** `main@59476a97739c13ed039ab315cad8e29c85acf94a`  
**Planning branch:** `plan/s32-m2d-assessment`  
**Predecessor:** M2-C Evidence Selection merged via PR #17, merge commit `59476a97739c13ed039ab315cad8e29c85acf94a`

## 1. Purpose

M2-D advances S32 from a server-authoritative, zero-write EvidenceManifest preview to a durable, append-only Claim assessment.

The phase sequence is:

```text
M2-A  Research Issues                       MERGED
  |
M2-B  Candidate Claims                      MERGED
  |
M2-C  Evidence Selection
      + page-local draft
      + canonical Manifest preview/hash      MERGED
  |
M2-D  Assessment
      + atomic EvidenceManifest commit       THIS SPEC
  |
M2-E  Issue Resolution
```

M2-D answers one question:

> Given a specific Claim and a specific frozen evidence set, what assessment did the researcher make, with what stance, confidence, and reasoning?

The epistemic boundary remains:

```text
Available Material
!= Selected Evidence
!= Frozen EvidenceManifest
!= Assessment
!= Issue Resolution
```

M2-D does **not** decide the Research Issue, choose a preferred Claim, reopen or resolve an Issue, run AI research, publish an outbox event, or deploy production changes.

## 2. Architectural classification and binding design decision

M2-D is architectural. It introduces the first canonical write that atomically binds:

```text
EvidenceManifest
+ EvidenceManifestItems
+ Assessment
```

The approved implementation organization is **CQRS-lite**:

```text
domain/
  assessment.ts
  evidence-selection.ts

application/
  assessments.ts

postgres/
  assessment-command-store.ts
  assessment-read-store.ts
  project-evidence-authorization.ts

routes/
  assessment-routes.ts
```

The Web is organized as:

```text
CandidateClaimCard
├─ EvidenceEditor
├─ AssessmentComposer
├─ AssessmentHistory
└─ AssessmentDetail
```

This is not a generic CQRS framework and not a generic Manifest subsystem. It is a local separation because the write and read sides have different transaction, privacy, and integrity semantics:

```text
WRITE: SERIALIZABLE command path
READ:  REPEATABLE READ, READ ONLY visibility path
```

## 3. Executable schema is authoritative

The frozen executable schema is authoritative over historical design drafts.

### 3.1 EvidenceManifest

```sql
core.evidence_manifests (
  id uuid PRIMARY KEY,
  schema_version integer NOT NULL DEFAULT 1,
  purpose text NOT NULL,
  manifest_sha256 text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
)
```

M2-D-created Manifest rows use:

```text
schema_version = 1
purpose        = CLAIM_ASSESSMENT
metadata       = {}
```

### 3.2 EvidenceManifestItem

```sql
core.evidence_manifest_items (
  id uuid PRIMARY KEY,
  manifest_id uuid NOT NULL,
  ordinal integer NOT NULL,
  role text NOT NULL,
  target_type text NOT NULL,
  target_id uuid NOT NULL,
  locator_type text NULL,
  locator jsonb NULL,
  excerpt text NULL,
  note text NULL,
  created_at timestamptz NOT NULL DEFAULT now()
)
```

Allowed v1 roles:

```text
SUPPORTING
CONTRADICTORY
CONTEXTUAL
```

Allowed v1 targets:

```text
SOURCE
SOURCE_ASSET
NOTE_REVISION
```

### 3.3 Assessment

```sql
core.assessments (
  id uuid PRIMARY KEY,
  claim_id uuid NOT NULL,
  actor_id uuid NULL,
  stance text NOT NULL,
  confidence_level text NULL,
  numeric_score double precision NULL,
  score_kind text NULL,
  evidence_manifest_id uuid NULL,
  reasoning text NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
)
```

Physical stance allowlist:

```text
SUPPORTS
CONTRADICTS
INCONCLUSIVE
```

Physical confidence allowlist:

```text
LOW
MEDIUM
HIGH
NULL
```

## 4. No schema change

M2-D must not modify:

- `db/migrations/001_s32_core_schema.sql`;
- `db/tests/001_s32_schema_assertions.sql`;
- `db/tests/002_s32_negative_invariants.sql`.

M2-D adds:

- no table;
- no column;
- no FK;
- no enum/check value;
- no trigger;
- no index;
- no `Claim.current_assessment_id`;
- no Assessment-to-Project or Assessment-to-Issue ownership column.

The frozen SQL remains byte-for-byte unchanged.

## 5. Canonical object semantics

The canonical ownership model is:

```text
Claim
├─ Assessment A
├─ Assessment B
└─ Assessment C
```

The same canonical Claim may be related to multiple ResearchIssues.

Therefore:

```text
ASSESSMENT_CANONICAL_SCOPE = GLOBAL_CLAIM
```

Project and Issue are not Assessment owners. They are:

```text
write-command authorization context
+
read-visibility context
```

No Project/Issue identity is hidden in `Assessment.metadata`; M2-D-created Assessment metadata is exactly `{}`.

The historical architecture rule remains:

> Confidence belongs to Assessment, not Claim.

M2-D must not add `Claim.current_assessment_id`. Multiple Human, AI, external, or historical Assessments may coexist in the model.

## 6. M2-D v1 write model

M2-D v1 creates human-local Assessments with no canonical Actor mapping yet:

```text
actor_id          = NULL
stance            = required
confidence_level  = LOW | MEDIUM | HIGH | NULL
numeric_score     = NULL
score_kind        = NULL
reasoning         = required
evidence_manifest_id = NOT NULL
metadata          = {}
```

AI Assessment and Actor management are explicitly deferred.

### 6.1 Stance

Required:

```text
SUPPORTS
CONTRADICTS
INCONCLUSIVE
```

`INCONCLUSIVE` means:

> The Claim was assessed against a frozen evidence set, but no directional conclusion was justified.

It is distinct from:

```text
0 Assessment rows = UNASSESSED
```

and distinct from M2-E `INSUFFICIENT_EVIDENCE`, which is an Issue-level Resolution type.

### 6.2 Confidence

Optional:

```text
LOW
MEDIUM
HIGH
NULL
```

M2-D v1 exposes no numeric score because no calibrated numeric scale has been designed.

## 7. Assessment reasoning contract

Reasoning is required plain text.

Normalization:

1. input must be a string;
2. U+0000 is rejected;
3. CRLF becomes LF;
4. remaining CR becomes LF;
5. leading/trailing Unicode `White_Space` is trimmed;
6. whitespace-only reasoning is invalid;
7. internal whitespace and newlines are preserved exactly;
8. normalized length must be 1..8000 Unicode code points.

Reasoning is not Markdown semantics, HTML, or hidden AI rationale.

The distinction is:

```text
Evidence item note
= why this exact evidence item was selected

Assessment reasoning
= why the overall frozen evidence set led to this assessment
```

## 8. Evidence item contract and shared 1..100 bound

M2-D requires a Manifest for every v1-created Assessment.

```text
M2D_ASSESSMENT_REQUIRES_MANIFEST = YES
M2D_MANIFEST_ITEMS_MIN = 1
M2D_MANIFEST_ITEMS_MAX = 100
```

The 1..100 bound must be a shared domain contract used by:

- M2-C EvidenceManifest preview;
- M2-D Assessment commit.

M2-D therefore makes one deliberate tightening to the already-merged M2-C input boundary:

```text
100 items = accepted
101 items = EVIDENCE_DRAFT_INVALID
```

This does not limit the number of available Project evidence candidates. It limits only the evidence frozen into one Manifest.

Assessment detail returns the complete 1..100 ManifestItems; ManifestItems are not paginated.

## 9. M2-C Preview remains zero-write

M2-C Preview remains:

```text
page-local evidence draft
→ server validation
→ canonical Manifest draft
→ SHA-256
→ persisted=false
```

It creates no:

- EvidenceManifest;
- EvidenceManifestItem;
- Assessment;
- idempotency receipt.

Preview is not a reservation. It:

- does not lock Project evidence;
- does not reserve a Manifest ID;
- does not persist a server-side draft;
- does not guarantee a later commit.

M2-D must revalidate everything at commit time.

## 10. Create Assessment API

M2-D adds:

```http
POST /api/private/s32/projects/:projectId/issues/:issueId/claims/:claimId/assessments
Idempotency-Key: <required>
```

Request:

```ts
interface CreateAssessmentInput {
  stance: "SUPPORTS" | "CONTRADICTS" | "INCONCLUSIVE";
  confidenceLevel: "LOW" | "MEDIUM" | "HIGH" | null;
  reasoning: string;
  expectedManifestSha256: string;
  items: Array<{
    role: "SUPPORTING" | "CONTRADICTORY" | "CONTEXTUAL";
    targetType: "SOURCE" | "SOURCE_ASSET" | "NOTE_REVISION";
    targetId: string;
    note?: string | null;
  }>;
}
```

The client must not submit:

- Assessment ID;
- Manifest ID;
- ManifestItem ID;
- Actor ID;
- numeric score;
- score kind;
- schema version;
- purpose;
- ordinal;
- metadata;
- created timestamp;
- locator;
- excerpt.

Unknown top-level Assessment fields are rejected.

Unknown evidence-item fields are rejected.

All private M2-D endpoints use:

```http
Cache-Control: no-store
```

## 11. Normalized command and request hash

Before the database transaction, the application/domain layer builds a canonical normalized command:

```ts
{
  projectId,
  issueId,
  claimId,
  stance,
  confidenceLevel,
  reasoning,
  expectedManifestSha256,
  items
}
```

IDs are normalized to lowercase UUID representation.

`expectedManifestSha256` must be lowercase 64-hex.

The idempotency request hash covers fixed-order canonical JSON for:

- Project ID;
- Issue ID;
- Claim ID;
- stance;
- confidence;
- normalized reasoning;
- expected Manifest SHA;
- canonical evidence items, including order.

The request hash is SHA-256 over UTF-8 canonical JSON.

Same normalized command produces the same request hash.

Meaningful command changes, including evidence order, change the request hash.

## 12. Idempotency scope

The recommended scope is:

```text
S32:M2D:PROJECT_ISSUE_CLAIM_ASSESSMENT_CREATE:
<projectId>:<issueId>:<claimId>
```

Idempotency-Key is required.

Same scope + same key + same request hash means the same command identity.

Same scope + same key + different request hash means:

```text
409 IDEMPOTENCY_CONFLICT
```

No new Assessment is created.

## 13. ID generation and retry stability

M2-D v1 follows current repository practice:

```text
crypto.randomUUID()
```

for:

- Assessment ID;
- Manifest ID;
- each ManifestItem ID.

A future repository-wide UUIDv7 migration is deferred.

IDs are generated exactly once per command before the first write transaction attempt.

If a SERIALIZABLE transaction retries internally, every retry uses:

- the same normalized command;
- the same Idempotency-Key;
- the same request hash;
- the same Assessment ID;
- the same Manifest ID;
- the same ManifestItem IDs.

## 14. New-write lifecycle

New Assessment writes require:

```text
Project = ACTIVE

Issue =
OPEN
or RESOLVED

Claim =
ACTIVE
or ARCHIVED
```

New write behavior:

```text
Project ARCHIVED -> 409 PROJECT_READ_ONLY
Issue ARCHIVED   -> 409 RESEARCH_ISSUE_READ_ONLY
Claim ARCHIVED   -> allowed
```

Assessment creation does not:

- reopen Issue;
- unarchive Claim;
- create or update IssueResolution;
- change `current_resolution_id`.

## 15. Canonical command transaction

A new command uses one:

```text
SERIALIZABLE
```

transaction.

The command order is:

```text
1. resolve/reserve Idempotency-Key
2. lock canonical scope
3. validate new-write lifecycle
4. reload + validate Project evidence graph
5. authorize every evidence target
6. rebuild canonical Manifest payload
7. recompute Manifest SHA-256
8. compare expectedManifestSha256
9. insert EvidenceManifest
10. insert 1..100 EvidenceManifestItems
11. insert Assessment
12. canonical read-back
13. recompute Manifest hash from persisted rows
14. mark idempotency receipt COMPLETED
15. COMMIT
```

Any final failure rolls back the entire transaction.

## 16. Deterministic lock order

The new-write path locks scope in this order:

```text
Project
→ ResearchIssue
→ ResearchIssueClaim relation
→ Claim
```

M2-D does not lock the entire Project material graph.

Evidence authorization is re-read and validated inside the same SERIALIZABLE transaction.

## 17. Project-authorized evidence at commit

M2-D commit uses the same Project evidence semantics as M2-C.

### 17.1 SOURCE

Authorized when:

```text
Project
→ Edition ProjectBinding
→ metadata.sourceId
→ exact Source
```

and the Source `edition_id` matches that exact bound Edition.

ACTIVE and ARCHIVED Source are allowed.

### 17.2 SOURCE_ASSET

Authorized only when:

```text
SourceAsset.source_id
→ validated Project-authorized Source
```

### 17.3 NOTE_REVISION

Authorized when:

```text
Project
→ Edition ProjectBinding
→ NOTE ProjectBinding
→ exact canonical Note
→ selected immutable NoteRevision
```

The Note binding must satisfy the existing Project Item Note contract.

Candidate listing may show only the current revision, but M2-D commit accepts an older immutable revision when it:

- belongs to the exact authorized Note;
- still exists;
- remains canonical.

A Note advancing from R2 to R7 does not by itself invalidate a previously selected R2.

## 18. Canonical Manifest rebuild

The server never trusts client Manifest structure.

It rebuilds:

```ts
{
  schemaVersion: 1,
  purpose: "CLAIM_ASSESSMENT",
  items: [
    {
      ordinal,
      role,
      targetType,
      targetId,
      locatorType: null,
      locator: null,
      excerpt: null,
      note
    }
  ]
}
```

Rules:

- items preserve submitted canonical order;
- ordinals are server-owned 1..N;
- UUIDs are lowercase;
- notes use the existing M2-C normalization;
- locatorType/locator/excerpt are null;
- fixed property order is used;
- `JSON.stringify` output is hashed as UTF-8;
- SHA-256 is lowercase 64-hex.

`manifestSha256` is an integrity fingerprint only.

It is not:

- object identity;
- a dedupe key;
- authorization;
- a truth/confidence score;
- a security token.

## 19. Preview confirmation gate

The server recomputes:

```text
serverManifestSha256
```

and requires:

```text
serverManifestSha256
==
expectedManifestSha256
```

Mismatch means:

```text
409 EVIDENCE_PREVIEW_STALE
```

and zero durable writes.

`EVIDENCE_PREVIEW_STALE` means only Manifest hash mismatch. It is not a generic code for unavailable evidence, missing scope, or canonical corruption.

## 20. Manifest identity and no dedupe

Every independent successful Assessment command creates:

- a new EvidenceManifest ID;
- new EvidenceManifestItems;
- a new Assessment.

This remains true even if an older Manifest has the same SHA-256.

```text
MANIFEST_DEDUPE = NO
```

Only idempotency replay of the same command returns the exact prior Assessment/Manifest identity.

## 21. Persisted canonical fields

A successful new write persists:

### EvidenceManifest

```text
id              = generated Manifest ID
schema_version  = 1
purpose         = CLAIM_ASSESSMENT
manifest_sha256 = recomputed canonical hash
metadata        = {}
created_at      = PostgreSQL
```

### EvidenceManifestItems

```text
id           = generated Item ID
manifest_id  = exact new Manifest
ordinal      = 1..N
role         = canonical role
target_type  = canonical target type
target_id    = canonical target UUID
locator_type = NULL
locator      = NULL
excerpt      = NULL
note         = normalized note/null
created_at   = PostgreSQL
```

### Assessment

```text
id                   = generated Assessment ID
claim_id             = exact Claim
actor_id             = NULL
stance               = canonical stance
confidence_level     = canonical confidence/null
numeric_score        = NULL
score_kind           = NULL
evidence_manifest_id = exact new Manifest ID
reasoning            = normalized reasoning
metadata             = {}
created_at           = PostgreSQL
```

## 22. PostgreSQL owns persisted timestamps

The client cannot submit canonical timestamps.

M2-D uses the frozen schema `DEFAULT now()` values.

No product invariant requires Manifest, Items, and Assessment timestamps to compare equal. They need only be valid persisted timestamps from the same successful transaction.

## 23. Canonical post-insert read-back

M2-D does not return success by echoing its insert parameters.

Before completing the idempotency receipt, it re-reads:

```text
Assessment
→ exact linked EvidenceManifest
→ exact ordered ManifestItems
```

It validates:

- exact generated IDs;
- exact Claim;
- v1 Assessment write fields;
- exact Manifest schema/purpose/hash/metadata;
- exact item count;
- exact ordinals 1..N;
- exact role/target/note values;
- locatorType/locator/excerpt null;
- valid timestamps.

It then rebuilds the canonical Manifest payload from persisted rows and verifies:

```text
readBackHash
=
stored manifest_sha256
=
expectedManifestSha256
```

Any failure rolls back all writes.

## 24. Idempotency receipt completion

The receipt becomes `COMPLETED` only after canonical read-back passes.

It records:

```text
resource_type = ASSESSMENT
resource_id   = Assessment ID
```

`result_payload` is minimal IDs only, for example:

```json
{
  "assessmentId": "...",
  "manifestId": "..."
}
```

It does not duplicate:

- reasoning;
- evidence notes;
- ManifestItems;
- protected research content.

M2-D v1 does not persist normal durable `FAILED` receipts.

Known failures roll back the transaction, including any new IN_PROGRESS receipt row.

A durable, unexpectedly stuck `IN_PROGRESS` or pre-existing `FAILED` receipt is treated as an abnormal store state and must not be silently retried as a fresh command.

## 25. Idempotency replay

Idempotency resolution happens before new-write lifecycle gates.

If:

```text
same scope
same Idempotency-Key
same requestHash
status = COMPLETED
```

the request enters replay, not new-write.

It never creates another Assessment.

### 25.1 Visible replay

If the original Assessment is currently readable through the requested Project context:

```http
200 OK
```

with:

```json
{
  "status": "replayed",
  "visible": true,
  "assessment": { "...": "..." },
  "evidenceManifest": { "...": "..." }
}
```

### 25.2 Invisible replay

If the original command is proven completed but the resource is not currently readable through the requested Project context:

```http
200 OK
```

with:

```json
{
  "status": "replayed",
  "visible": false,
  "assessmentId": "..."
}
```

The invisible response must not return:

- stance;
- confidence;
- reasoning;
- Manifest ID;
- Manifest hash;
- ManifestItems.

Idempotency acknowledges command completion; current access control governs payload visibility.

## 26. Concurrent same-key requests

Two concurrent identical commands must not create duplicate Assessments.

Expected semantic result:

```text
Request A -> 201 created
Request B -> resolves same receipt -> 200 replayed
```

The existing unique `(scope, idempotency_key)` constraint is part of the concurrency control.

## 27. Transaction retries

Internal retry is allowed only for safe transient PostgreSQL conflicts:

```text
SQLSTATE 40001
SQLSTATE 40P01
```

M2-D defines:

```text
MAX_INTERNAL_RETRIES = 2 additional retries
MAX_TRANSACTION_ATTEMPTS = 3 total attempts
```

Every attempt uses the same command identity and pre-generated IDs.

Retry exhaustion returns a safe store-unavailable error.

M2-D does not auto-retry 400, 404, 409, or integrity 500 failures.

## 28. Canonical write side-effect boundary

A successful new M2-D transaction may durably change only:

- `ops.idempotency_keys`;
- `core.evidence_manifests`;
- `core.evidence_manifest_items`;
- `core.assessments`.

It does not:

- write `ops.outbox_events`;
- create a ResearchRun;
- run AI;
- change Claim lifecycle;
- change Issue lifecycle;
- create/update IssueResolution;
- change `current_resolution_id`;
- trigger search/projection refresh.

```text
M2D_OUTBOX_EVENT = NO
M2D_AUTOMATION_SIDE_EFFECTS = NO
M2D_RESEARCH_RUN = NO
```

## 29. Read lifecycle

Assessment history/detail are readable when:

```text
Project = ACTIVE | ARCHIVED
Issue   = OPEN | RESOLVED | ARCHIVED
Claim   = ACTIVE | ARCHIVED
```

```text
ARCHIVED = READ_ONLY
ARCHIVED != UNREADABLE
```

This preserves historical audit.

## 30. Read transaction and CQRS read path

History/detail use:

```text
REPEATABLE READ, READ ONLY
```

The read flow is:

```text
validate Project → Issue → Claim
→ load + validate current Project material graph
→ derive current evidence authorization
→ determine visible Claim-level Assessments
→ canonical validation of visible rows
→ return history summary or detail
```

The read path answers:

> Can this Project context safely read this Claim-level Assessment now?

It does not reconstruct an originating Project owner because Assessment has no Project owner.

## 31. Project-scoped Assessment visibility

Assessment canonical identity is Claim-global, but read visibility is Project-scoped.

An Assessment is currently visible only when **all** frozen ManifestItems can be authorized through the current Project material graph.

```text
ALL items authorized -> Assessment visible
ANY item not authorized -> entire Assessment invisible
```

Partial redaction is forbidden.

Rationale: stance, reasoning, confidence, and remaining evidence can themselves disclose private evidence context.

## 32. Historical evidence visibility rules

### 32.1 SOURCE

Current Project must still prove:

```text
Project
→ Edition ProjectBinding
→ metadata.sourceId
→ exact Source
```

Source `edition_id` must match the exact bound Edition.

ACTIVE and ARCHIVED Sources remain visible.

### 32.2 SOURCE_ASSET

The exact SourceAsset must still belong to a currently Project-authorized Source.

### 32.3 NOTE_REVISION

The current Project must still authorize the exact Note through the Edition/NOTE binding contract.

A frozen historical NoteRevision remains visible when it:

- belongs to the exact currently authorized Note;
- still exists;
- remains canonical.

It does not need to be `current_revision_id`.

Therefore:

```text
Note current revision R2 → R7
Manifest freezes R2
=> R2 remains valid/visible
```

A required Project binding being removed may make the entire Assessment invisible without modifying the canonical Assessment or Manifest.

## 33. Visibility before integrity

Read privacy requires this order:

```text
prove current visibility lineage first
→ then perform full integrity validation
```

If the current Project cannot establish a supported authorization lineage for a hidden global Assessment, the API must not reveal that Assessment by emitting an integrity-specific response.

### 33.1 Cannot establish visibility

Examples:

- target belongs outside current Project authorization;
- required binding is absent;
- ManifestItem target type is unsupported/malformed, so no supported authorization lineage can be proven.

Result:

```text
history -> omit
detail  -> safe 404
```

### 33.2 Visibility established, then corruption found

Examples:

- invalid role;
- ordinal gap;
- wrong purpose;
- unsupported schema version for this M2-D reader;
- hash mismatch;
- metadata corruption;
- non-null locator/excerpt where v1 requires null;
- invalid visible Actor;
- >100 visible items.

Result:

```text
500 generic integrity failure
```

### 33.3 Current Project material graph corruption

Corruption in the current Project's own canonical material graph is immediately a generic integrity failure, not a hidden global-object case.

## 34. Strict-write / schema-compatible Assessment read

M2-D v1 write is strict, but the reader must not assume every historical/future Assessment was created by the v1 UI.

Readable Assessment fields are:

```ts
{
  id: string;
  claimId: string;
  stance: "SUPPORTS" | "CONTRADICTS" | "INCONCLUSIVE";
  confidenceLevel: "LOW" | "MEDIUM" | "HIGH" | null;
  actorId: string | null;
  numericScore: number | null;
  scoreKind: string | null;
  reasoning: string | null;
  createdAt: string;
}
```

Physical invariants still apply:

- score/score_kind are paired;
- numeric score is 0..1;
- non-null actor must resolve to a canonical Actor;
- dates/UUIDs/enums must be canonical.

A future schema-valid AI/external Assessment must not be rejected merely because M2-D v1 writes `actor_id=NULL` and no numeric score.

## 35. Manifestless Assessment

The physical schema allows:

```text
evidence_manifest_id = NULL
```

Such an Assessment is not automatically database corruption.

However, Project-routed M2-D cannot prove evidence privacy without a frozen Manifest.

Therefore:

```text
history -> omitted
detail  -> safe 404
```

A future Claim-global browsing surface may design separate access semantics.

## 36. Manifest read strictness

Assessment fields are schema-compatible, but the M2-D v1 Manifest reader is strict.

A visible M2-D Assessment Manifest must satisfy:

```text
schema_version = 1
purpose = CLAIM_ASSESSMENT
metadata = {}
manifest_sha256 = lowercase 64-hex
```

Visible ManifestItems must satisfy:

```text
count = 1..100
ordinal = exactly 1..N
role in v1 allowlist
target_type in v1 allowlist
target_id canonical UUID
locator_type = NULL
locator = NULL
excerpt = NULL
note = canonical M2-C note/null
```

The reader rebuilds the fixed-order canonical Manifest payload and recomputes SHA-256 on every visible history/detail read.

```text
recomputed SHA == stored manifest_sha256
```

Otherwise the visible record fails closed with generic integrity error.

## 37. History API

M2-D adds:

```http
GET /api/private/s32/projects/:projectId/issues/:issueId/claims/:claimId/assessments
```

Query:

```text
cursor = optional opaque server cursor
limit  = optional, default 20, max 50
```

Order:

```text
created_at DESC
id DESC
```

Pagination is keyset pagination.

Visibility must be applied **before** cursor/limit pagination.

Server queries `limit + 1` visible records to derive `nextCursor`.

No total/totalPages/hiddenCount is returned.

Invalid/tampered/unsupported cursor returns:

```text
400 ASSESSMENT_CURSOR_INVALID
```

A limit above 50 is rejected rather than silently clamped.

## 38. Visibility-first history query architecture

The read-store history flow is:

```text
1. validate scope
2. load validated Project material graph
3. derive authorized Source/SourceAsset/Note sets
4. SQL-select currently visible Assessments
5. apply keyset cursor/order/limit+1 to visible set
6. batch-load returned page's Manifest/Items/Actors
7. full canonical validation + hash recomputation
8. return summaries
```

The query count must be bounded and independent of the number of returned Assessments. N+1 Manifest/Actor queries are forbidden.

Hidden global Assessment corruption must not become an existence side channel.

## 39. History summary response

History returns lightweight summaries only.

```ts
interface AssessmentSummary {
  id: string;
  stance: "SUPPORTS" | "CONTRADICTS" | "INCONCLUSIVE";
  confidenceLevel: "LOW" | "MEDIUM" | "HIGH" | null;
  actorId: string | null;
  numericScore: number | null;
  scoreKind: string | null;
  reasoningExcerpt: string | null;
  createdAt: string;
  evidenceManifest: {
    id: string;
    schemaVersion: 1;
    purpose: "CLAIM_ASSESSMENT";
    manifestSha256: string;
    itemCount: number;
  };
}
```

`reasoningExcerpt`:

- null when reasoning is null;
- collapses internal Unicode whitespace/newlines to one space for display;
- is at most 240 Unicode code points;
- appends an ellipsis when truncated.

The excerpt is a display projection only. It does not affect identity or hashing.

History does not return:

- full reasoning;
- target IDs;
- ManifestItems;
- evidence notes.

The first returned visible record may be labeled in the UI as:

```text
最近一次评价
```

It must never be called current/final/preferred/current truth.

An empty history means only:

> 当前没有可显示的评价记录。

It must not claim that the Claim has never had an Assessment globally.

## 40. Assessment detail API

M2-D adds:

```http
GET /api/private/s32/projects/:projectId/issues/:issueId/claims/:claimId/assessments/:assessmentId
```

It returns:

- Claim context;
- full compatible Assessment fields;
- full reasoning;
- the exact frozen EvidenceManifest;
- all 1..100 ordered ManifestItems.

If `assessmentId` belongs to another Claim, is manifestless in this Project-routed surface, or is currently not visible through the requested Project context:

```text
404 ASSESSMENT_NOT_FOUND
```

The API does not disclose another Project/Claim owner.

## 41. Error contract

### 400

```text
ASSESSMENT_INVALID
EVIDENCE_DRAFT_INVALID
ASSESSMENT_CURSOR_INVALID
```

### 404

```text
PROJECT_ISSUE_OR_CLAIM_NOT_FOUND
EVIDENCE_TARGET_NOT_AVAILABLE
ASSESSMENT_NOT_FOUND
```

### 409

```text
PROJECT_READ_ONLY
RESEARCH_ISSUE_READ_ONLY
EVIDENCE_PREVIEW_STALE
IDEMPOTENCY_CONFLICT
```

### 500

Generic canonical integrity failure.

### 503

```text
ASSESSMENT_STORE_UNAVAILABLE
```

used for store/network unavailability, exhausted safe transient retries, or abnormal durable receipt state where the server cannot safely complete/confirm the operation.

No error may reveal that a hidden Issue, Claim, evidence target, or Assessment belongs to another Project.

## 42. Browser Assessment Composer

The Claim-card flow is:

```text
Evidence Draft
→ Preview
→ Assessment fields
→ Explicit Submit
→ Canonical History
```

Composer fields:

- stance;
- optional confidence;
- reasoning.

Submit is enabled only when:

- Project/Issue are writable for M2-D;
- current Evidence preview is valid;
- stance is selected;
- reasoning is valid;
- no pending committed command exists;
- history is not integrity-blocked.

Frontend gating is UX only; the server revalidates all authority.

## 43. Preview invalidation in the browser

Any evidence mutation invalidates the prior preview:

- add/remove item;
- role change;
- target change;
- note change;
- order change.

The browser clears the old preview/hash and disables submit.

It preserves:

- stance;
- confidence;
- reasoning.

Assessment-field mutations do **not** invalidate the EvidenceManifest preview because stance/confidence/reasoning are not part of the Manifest hash.

Existing M2-C stale-preview response guards remain required.

## 44. Browser pending commit receipt

Evidence/Assessment draft state remains in component memory before explicit submit.

Only after the user explicitly clicks Submit does the browser create a sessionStorage receipt.

The receipt represents **committed intent**, not an editable draft.

It contains at least:

- Project/Issue/Claim scope;
- Idempotency-Key;
- request hash;
- local receipt-created time;
- normalized stance/confidence/reasoning;
- expected Manifest SHA;
- canonical evidence command items.

Once present, the command is frozen.

Network result unknown:

```text
keep receipt
→ same key
→ same normalized command
→ retry
```

Silent Idempotency-Key rotation is forbidden.

If the user wants changed intent, the UI requires explicit discard.

Discarding local pending state does not delete a possibly already-created server Assessment.

## 45. Browser response handling

### 45.1 201 created

- clear pending receipt;
- clear composer;
- acknowledge success;
- reload history from server.

### 45.2 200 replayed, visible=true

- clear pending receipt;
- clear composer;
- acknowledge prior success;
- reload history.

### 45.3 200 replayed, visible=false

- clear pending receipt;
- clear composer;
- acknowledge that the command previously succeeded;
- do not show protected Assessment content;
- reload history;
- do not optimistically append a local Assessment.

### 45.4 409 EVIDENCE_PREVIEW_STALE

- clear failed pending receipt;
- invalidate preview;
- preserve evidence draft;
- preserve stance/confidence/reasoning;
- require a new preview;
- future submit uses a new key.

### 45.5 404 EVIDENCE_TARGET_NOT_AVAILABLE

- clear failed pending receipt;
- preserve user-entered Assessment fields;
- refresh evidence candidates;
- do not disclose cross-Project ownership.

### 45.6 Project/Issue read-only

- clear failed pending receipt;
- close/disable the composer;
- keep history readable.

### 45.7 Explicit 503

The command intent has not changed. The UI may keep the pending receipt and allow same-key/same-command retry.

### 45.8 Transport result unknown

The browser cannot know whether commit occurred. It must keep the receipt and permit only same-key/same-command confirmation.

## 46. Independent UI degradation

Claim, Evidence, Assessment write, Assessment history, and Assessment detail are related but separate capability surfaces.

History network/503 failure:

- Claim remains visible;
- EvidenceEditor remains independently usable;
- composer remains usable;
- history offers independent retry.

History integrity 500:

- Claim remains visible;
- new Assessment submit is disabled;
- integrity warning is shown.

Detail failure:

- history remains visible;
- detail gets its own retry/error state.

Next-page failure:

- already-loaded history remains;
- only the load-more surface shows an error.

Safe detail 404:

- show neutral “该评价当前不可用”;
- refresh history.

POST success followed by history-refresh failure:

- Assessment remains successfully submitted;
- pending receipt remains cleared;
- UI reports history refresh failure separately;
- it must never rewrite success as “提交失败”.

No optimistic history insertion is allowed. Canonical ordering comes from GET history.

## 47. Lifecycle UI behavior

### Project ARCHIVED

- history/detail readable;
- new Assessment composer disabled/hidden.

### Issue ARCHIVED

- history/detail readable;
- new Assessment composer disabled/hidden.

### Claim ARCHIVED

- history/detail readable;
- new Assessment may still be created when Project is ACTIVE and Issue is OPEN/RESOLVED.

## 48. Web component state ownership

Recommended ownership:

### EvidenceEditor

- evidence draft;
- Preview request state;
- current Manifest SHA;
- canonical preview items.

### AssessmentComposer

- stance;
- confidence;
- reasoning;
- pending commit receipt;
- POST state.

### AssessmentHistory

- loaded summaries;
- nextCursor;
- load-more state;
- refresh state.

### AssessmentDetail

- selected Assessment ID;
- detail loading/data/error.

A shared client API/error mapper should centralize M2-D HTTP error-code parsing.

## 49. Testing architecture

M2-D uses layered proof.

```text
Domain
→ Application
→ Command Store
→ Read Store
→ Real PostgreSQL16
→ Routes
→ Web Components
→ Real Browser
→ Repository Regression
```

Historical test results are not fresh M2-D evidence.

Strict TDD RED→GREEN is required.

### 49.1 Domain

Fresh coverage includes:

- stance/confidence allowlists;
- reasoning normalization, U+0000, 1/8000/8001 code-point boundaries;
- 0/1/100/101 evidence items;
- duplicate target rejection;
- item note normalization;
- request-hash determinism;
- Manifest-hash determinism.

### 49.2 Application

Prove:

- command normalization;
- IDs generated once;
- stable IDs across retry attempts;
- no client/server-owned timestamp confusion.

### 49.3 Command Store

Prove:

- idempotent create/replay;
- same key/different command conflict;
- replay before lifecycle gates;
- write lifecycle matrix;
- evidence authorization;
- stale preview zero-write;
- cross-Project target zero-write;
- canonical graph corruption zero-write;
- post-insert read-back rollback;
- abnormal receipt handling;
- safe transient retry semantics.

### 49.4 Read Store

Prove:

- SOURCE/SOURCE_ASSET/NOTE_REVISION visibility matrix;
- historical NoteRevision allowance;
- whole-Assessment visibility;
- manifestless Assessment hidden without corruption;
- future-compatible Actor/score/reasoning-null read;
- visible Manifest corruption fail-closed;
- hidden corruption no-leak;
- visibility-first pagination;
- stable keyset pagination;
- invalid cursor;
- bounded query count / no N+1.

### 49.5 Real PostgreSQL 16

Disposable real PostgreSQL16 is required.

Fresh integration proves:

- one Manifest + N Items + one Assessment + COMPLETED receipt on success;
- transaction rollback leaves zero partial durable rows;
- real FK/CHECK/unique behavior;
- PostgreSQL timestamps;
- append-only/immutable triggers for Assessment/Manifest/ManifestItem;
- actual transactional behavior.

Real race tests may be included only if deterministic. Flaky timing-based races are forbidden as hard gates.

### 49.6 Routes

Fresh route coverage proves:

- POST 201 created;
- POST 200 replay visible=true;
- POST 200 replay visible=false;
- all 400/404/409/500/503 mappings;
- cursor/limit parsing;
- safe 404 detail;
- response shapes;
- `Cache-Control: no-store`.

### 49.7 Web

Fresh component tests prove:

- evidence mutation invalidates preview but preserves Assessment fields;
- Assessment mutation does not invalidate Manifest preview;
- submit gate;
- pending receipt only after explicit submit;
- same-key retry after unknown result;
- explicit discard for changed intent;
- independent history/detail degradation;
- POST success remains success if history refresh fails.

### 49.8 Real browser

Fresh browser evidence must include:

```text
Issue detail
→ Claim
→ evidence selection
→ Preview
→ stance/confidence/reasoning
→ Submit
→ history
→ detail
```

It must also cover:

- stale Preview invalidation;
- response-unknown/reload/same-key replay recovery;
- archived Project/Issue read-only history;
- archived Claim Assessment creation when otherwise writable;
- 390×844 no horizontal overflow;
- long hash wrapping;
- long/large detail vertically usable.

## 50. Required verification gates

A future approved implementation must provide fresh evidence for:

- targeted M2-D domain/application/store/route/Web tests;
- M2-C regression, including the new 100-item bound;
- Research Issue / Candidate Claim regressions;
- S32 API scoped suite;
- Web research scoped suite;
- API build;
- Web build;
- disposable real PostgreSQL16 integration;
- explicit zero-write row-count assertions;
- immutable trigger checks;
- no-N+1 instrumentation;
- real-browser acceptance;
- 390×844 mobile gate;
- frozen SQL byte-diff;
- `git diff --check`;
- full repository suite with unrelated failures reported exactly;
- exact-head review evidence.

Critical properties that intentionally receive cross-layer proof include:

- zero-write failures;
- idempotency;
- privacy/visibility;
- Preview stale behavior;
- pending-result recovery.

## 51. Repository and production boundaries

A future implementation, only if separately approved, must:

- begin from then-current main;
- use an isolated worktree/feature branch;
- use one writer per worktree;
- use Native execution;
- preserve user/uncommitted work;
- use disposable PostgreSQL for integration;
- keep all frozen SQL files unchanged;
- avoid production/Tencent writes;
- avoid deployment;
- avoid M2-E implementation.

This written design spec authorizes no product implementation.

## 52. Current gate

```text
TASK_ID=S32_M2D_ASSESSMENT_DESIGN_R1
SOURCE_BASELINE=59476a97739c13ed039ab315cad8e29c85acf94a
PLANNING_BRANCH=plan/s32-m2d-assessment

M2_A_IMPLEMENTATION=MERGED
M2_B_IMPLEMENTATION=MERGED
M2_C_IMPLEMENTATION=MERGED

M2_D_CONVERSATIONAL_DESIGN=APPROVED
M2_D_WRITTEN_SPEC=READY_FOR_USER_REVIEW
M2_D_IMPLEMENTATION_PLAN=NOT_STARTED
M2_D_IMPLEMENTATION=NOT_STARTED
M2_E_STARTED=NO

SCHEMA_CHANGED=NO
FROZEN_SQL_CHANGED=NO
PRODUCTION_CHANGED=NO
PRODUCTION_DEPLOYED=NO

NEXT_ACTION=USER_REVIEW_M2D_WRITTEN_SPEC
```

Approval of this written spec authorizes only the next planning stage: writing the M2-D Implementation Plan.

It does not authorize product implementation, deployment, schema changes, or M2-E.
