# S32 M2-C Evidence Selection + Manifest Draft Design

**Status:** Conversational design approved; written spec ready for user review  
**Task ID:** `S32_M2C_EVIDENCE_SELECTION_DESIGN_R1`  
**Source baseline:** `main@8f5b4829b172ebae6a0f99201237da0e5666a33b`  
**Planning branch:** `plan/s32-m2c-evidence-selection`  
**Predecessor:** M2-B Candidate Claims merged via PR #16, merge commit `8f5b4829b172ebae6a0f99201237da0e5666a33b`

## 1. Purpose

M2-C advances S32 from:

```text
Research Issue
  -> competing Candidate Claims
```

to:

```text
Research Issue
  -> Candidate Claim
       -> Evidence selection
       -> canonical EvidenceManifest draft
       -> deterministic SHA-256 preview
```

M2-C answers one question:

> For this Candidate Claim, which project materials would the researcher use as supporting, contradictory, or contextual evidence in a later assessment?

M2-C does **not** decide whether the Claim is true, supported overall, preferred, resolved, or high-confidence.

The epistemic boundary remains:

```text
Available material
!= Selected evidence
!= Frozen/consumed evidence
!= Assessment
!= Issue Resolution
```

## 2. Architectural classification and key decision

M2-C is an architectural phase because it introduces a new Claim-scoped evidence-selection subsystem, new private API contracts, canonical manifest serialization, and new UI behavior.

The binding design decision is:

> **M2-C does not insert EvidenceManifest or EvidenceManifestItem rows.**

The executable schema has no direct Claim -> EvidenceManifest relation. Existing durable references to an EvidenceManifest are:

- `core.assessments.evidence_manifest_id`;
- `core.issue_resolutions.evidence_manifest_id`;
- `core.research_runs.evidence_manifest_id`.

Creating a Manifest in M2-C without an Assessment/Resolution/Run would produce an orphan-like canonical object that cannot be recovered from the Claim through the intended model. Adding a new Claim-to-Manifest helper table would change the frozen logical model and duplicate the future Assessment relation.

Therefore M2-C creates only a **page-local Evidence Draft** plus a **server-authoritative canonical preview/hash**.

M2-D will later create:

```text
EvidenceManifest
+ EvidenceManifestItems
+ Assessment
```

atomically in one transaction.

This preserves:

```text
Claim != Assessment != EvidenceManifest
```

and avoids schema changes in M2-C.

## 3. Executable schema is authoritative

Current `main` executable migration is authoritative over historical P29 drafts.

M2-C must use the current physical schema exactly as it exists.

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

Current database invariants include:

- `schema_version > 0`;
- `manifest_sha256` is lowercase 64-hex SHA-256;
- EvidenceManifest rows are immutable after insert;
- UPDATE and DELETE are rejected by the `MANIFEST_IMMUTABLE` trigger.

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

Current physical role allowlist:

```text
SUPPORTING
CONTRADICTORY
CONTEXTUAL
```

Current physical target allowlist:

```text
SOURCE
SOURCE_ASSET
NOTE_REVISION
```

Current database invariants include:

- `ordinal > 0`;
- `UNIQUE(manifest_id, ordinal)`;
- locator type/value are paired;
- non-null excerpt/note must be nonblank;
- ManifestItem rows are immutable after insert.

Historical proposals that used roles such as `PRIMARY`, `CONTROL`, or target type `CLAIM` are not executable authority and must not be restored in M2-C.

## 4. No schema change

M2-C must not modify:

- `db/migrations/001_s32_core_schema.sql`;
- `db/tests/001_s32_schema_assertions.sql`;
- `db/tests/002_s32_negative_invariants.sql`.

M2-C adds:

- no table;
- no column;
- no enum/check value;
- no trigger;
- no index;
- no FK;
- no Claim-to-Manifest relation;
- no migration.

The frozen M0 SQL remains byte-for-byte unchanged.

## 5. M2-C evidence semantics

Evidence roles are relative to the Claim whose route is being edited.

### SUPPORTING

If credible, the selected evidence tends to increase the plausibility or acceptability of the current Claim.

It does not mean the system has assessed the Claim as true.

### CONTRADICTORY

If credible, the selected evidence tends to weaken or contradict the current Claim.

It does not mean the Claim has been rejected.

### CONTEXTUAL

The selected evidence helps interpret the Claim or its context but does not directly support or contradict it.

### Forbidden interpretations

M2-C must not imply:

- SUPPORTING = TRUE;
- CONTRADICTORY = FALSE;
- item count = strength;
- first item = strongest evidence;
- candidate order = relevance or confidence;
- Manifest hash = truth or quality;
- draft preview = persisted evidence;
- selected evidence = Assessment.

A single draft may intentionally contain supporting and contradictory evidence at the same time.

## 6. Claim-scoped access path

Every M2-C request is scoped through:

```text
Project
  -> exact Research Issue owned by that Project
     -> exact Claim related to that Issue
        -> Project-authorized evidence targets
```

The service must validate:

1. Project exists and is canonical;
2. Project lifecycle is ACTIVE or ARCHIVED;
3. Research Issue exists;
4. the Issue has exactly one canonical Project owner;
5. the Issue belongs to the requested Project;
6. Issue lifecycle is OPEN, RESOLVED, or ARCHIVED;
7. the Claim exists;
8. `research_issue_claims(issue_id, claim_id)` exists exactly once;
9. Claim is canonical and lifecycle is ACTIVE or ARCHIVED.

Safe scope behavior:

- missing Project -> 404;
- missing Issue -> 404;
- Issue owned by another Project -> 404;
- missing Claim -> 404;
- Claim not related to the Issue -> 404;
- malformed/multi-owner/dangling canonical relations -> generic integrity failure.

No endpoint may disclose that a requested Issue, Claim, or Evidence target belongs to another Project.

## 7. Project-authorized Evidence targets

M2-C only allows evidence that can be proven to belong to the current Project material graph.

### 7.1 SOURCE

Current project catalog flow stores `sourceId` in the Edition ProjectBinding metadata.

A SOURCE candidate is valid when:

```text
Project
 -> Edition ProjectBinding
 -> metadata.sourceId
 -> core.sources.id
```

and the Source's `edition_id` must equal the Edition bound by that exact ProjectBinding.

Rules:

- a missing/absent `sourceId` simply means that Project material has no SOURCE candidate;
- if a nonblank `sourceId` is present, it must be a canonical UUID;
- if present, the Source must exist;
- its `edition_id` must match the Project-bound Edition;
- Source lifecycle may be ACTIVE or ARCHIVED;
- a dangling/mismatched source relation is an integrity failure, not silently omitted.

### 7.2 SOURCE_ASSET

A SOURCE_ASSET candidate is valid only when:

```text
SourceAsset.source_id
 -> validated Project-authorized Source
```

All canonical SourceAssets under that Source may be returned.

M2-C does not require SourceAssets to exist. The current catalog promotion path normally creates a Source without creating a SourceAsset, so SOURCE-only material is a valid and expected first-version state.

The private API must not expose internal storage keys or raw remote URIs merely to support evidence selection.

Candidate metadata may expose only non-secret descriptive fields such as:

- asset type;
- asset role;
- storage mode;
- creation timestamp.

### 7.3 NOTE_REVISION

A NOTE_REVISION candidate is valid when:

```text
Project
 -> Edition ProjectBinding
 -> Project NOTE binding
 -> canonical Note
 -> NoteRevision
```

The Note binding must continue to satisfy the existing Project Item Note contract:

- same Project;
- target type NOTE;
- binding role ANNOTATION;
- metadata subjectBindingId points to the exact Edition binding;
- metadata subjectType is EDITION;
- metadata subjectId is the exact Edition;
- Note is canonical.

The candidate list returns the Note's **current immutable revision** only.

However, preview validation accepts an older immutable NoteRevision if:

- it belongs to the exact authorized Note;
- it still exists and is canonical.

This prevents a race where a Note advances after the candidate list is loaded from invalidating a previously selected immutable revision.

M2-C does not proactively expose full revision history in the evidence candidate picker.

## 8. Evidence candidate API

M2-C adds one private read endpoint:

```http
GET /api/private/s32/projects/:projectId/issues/:issueId/claims/:claimId/evidence-candidates
```

Response:

```ts
interface EvidenceCandidateResponse {
  claim: {
    id: string;
    statement: string;
    lifecycleState: "ACTIVE" | "ARCHIVED";
  };
  candidates: EvidenceCandidate[];
}
```

Candidate union:

```ts
type EvidenceCandidate =
  | {
      targetType: "SOURCE";
      targetId: string;
      materialBindingId: string;
      materialTitle: string;
      sourceType: string;
      sourceLifecycleState: "ACTIVE" | "ARCHIVED";
      observedAt: string;
    }
  | {
      targetType: "SOURCE_ASSET";
      targetId: string;
      materialBindingId: string;
      materialTitle: string;
      sourceId: string;
      assetType: string;
      assetRole: "ORIGINAL" | "DERIVED";
      storageMode: "LOCAL" | "REMOTE" | "HYBRID";
      createdAt: string;
    }
  | {
      targetType: "NOTE_REVISION";
      targetId: string;
      materialBindingId: string;
      materialTitle: string;
      noteId: string;
      revisionNo: number;
      contentFormat: "MARKDOWN" | "PLAIN_TEXT";
      createdAt: string;
    };
```

The endpoint does not return:

- raw Note content;
- storage keys;
- remote asset URIs;
- evidence strength;
- confidence;
- Assessment state.

### Stable candidate ordering

Candidate ordering is deterministic but carries no epistemic meaning.

Order:

1. Project material by `ProjectBinding.created_at ASC`;
2. material binding ID ASC as tie-break;
3. SOURCE;
4. SOURCE_ASSET by `created_at ASC, id ASC`;
5. current NOTE_REVISION.

The UI must not describe this order as relevance, importance, or evidence quality.

## 9. Manifest preview API

M2-C adds one private deterministic preview endpoint:

```http
POST /api/private/s32/projects/:projectId/issues/:issueId/claims/:claimId/evidence-manifest-preview
```

Although the method is POST because the input is a structured draft body, this endpoint performs **no canonical database mutation**.

It requires no Idempotency-Key because it is a deterministic read/validation/hash operation.

Request:

```ts
interface EvidenceManifestPreviewInput {
  items: Array<{
    role: "SUPPORTING" | "CONTRADICTORY" | "CONTEXTUAL";
    targetType: "SOURCE" | "SOURCE_ASSET" | "NOTE_REVISION";
    targetId: string;
    note?: string | null;
  }>;
}
```

The request does not accept:

- schemaVersion;
- purpose;
- ordinal;
- manifestSha256;
- locatorType;
- locator;
- excerpt;
- manifest ID;
- Assessment fields.

Those are server-owned or outside M2-C.

Unknown top-level/item fields should be rejected rather than silently gaining semantics.

## 10. Draft validation

The preview service must:

1. validate Project -> Issue -> Claim scope;
2. require `items` to be a non-empty array;
3. validate every role against the executable role allowlist;
4. validate every target type against the executable target allowlist;
5. normalize every target ID to lowercase UUID;
6. reject duplicate `(targetType, targetId)` items within the same draft;
7. validate every target against the current Project evidence graph;
8. preserve request item order;
9. assign ordinals `1..N`;
10. normalize optional item note;
11. build the canonical serialization;
12. calculate server-side SHA-256;
13. return a preview;
14. perform zero writes to canonical/ops tables.

Duplicate evidence with two roles is forbidden in one draft. If the researcher believes one object has a nuanced role, that nuance belongs in the item note rather than duplicate rows with conflicting roles.

## 11. Evidence item note

The optional item `note` means:

> Why this exact object was selected as evidence for the current Claim.

It is not Assessment reasoning and must not contain hidden confidence/stance fields.

Normalization:

1. omitted -> `null`;
2. explicit `null` -> `null`;
3. otherwise must be a string;
4. CRLF -> LF;
5. remaining CR -> LF;
6. trim leading/trailing Unicode `White_Space`;
7. whitespace-only -> `null`;
8. non-null normalized value must be at most 2000 Unicode code points;
9. U+0000 is rejected;
10. internal whitespace/newlines are preserved.

Stored/previewed as plain text.

## 12. M2-C locator boundary

M2-C v1 intentionally does not design granular locators.

Every canonical draft item has:

```text
locatorType = null
locator     = null
excerpt     = null
```

This is deliberate because the current useful slice primarily has:

- DATABASE_RECORD Source;
- immutable NoteRevision;
- few/no SourceAsset objects in the main user flow.

M2-C does not prematurely invent:

- page number;
- PDF bounding box;
- text range;
- DOM selector;
- timestamp/timecode;
- OCR anchor.

A future phase may extend locator semantics after stable SourceAsset/document workflows exist.

## 13. Canonical Manifest Draft

Server-owned values are fixed:

```text
schemaVersion = 1
purpose       = CLAIM_ASSESSMENT
```

Canonical preview type:

```ts
interface EvidenceManifestDraft {
  schemaVersion: 1;
  purpose: "CLAIM_ASSESSMENT";
  manifestSha256: string;
  items: Array<{
    ordinal: number;
    role: "SUPPORTING" | "CONTRADICTORY" | "CONTEXTUAL";
    targetType: "SOURCE" | "SOURCE_ASSET" | "NOTE_REVISION";
    targetId: string;
    locatorType: null;
    locator: null;
    excerpt: null;
    note: string | null;
  }>;
}
```

Preview response:

```ts
interface EvidenceManifestPreviewResponse {
  claim: {
    id: string;
    statement: string;
  };
  draft: EvidenceManifestDraft;
  persisted: false;
}
```

The literal `persisted: false` is part of the API contract to prevent the browser from presenting a preview as an already-created EvidenceManifest.

No manifest UUID exists in M2-C.

## 14. Canonical serialization and hash

The server is the only authority for the manifest preview hash.

The client never supplies a trusted hash.

Canonical serialization is UTF-8 JSON with exact fixed property order:

```json
{
  "schemaVersion": 1,
  "purpose": "CLAIM_ASSESSMENT",
  "items": [
    {
      "ordinal": 1,
      "role": "SUPPORTING",
      "targetType": "NOTE_REVISION",
      "targetId": "lowercase-uuid",
      "locatorType": null,
      "locator": null,
      "excerpt": null,
      "note": "normalized plain text or null"
    }
  ]
}
```

Rules:

- no insignificant custom pretty-print whitespace is included in the hashed byte stream;
- property order is exactly the order above;
- items remain in request order;
- ordinals are assigned by the server;
- UUIDs are lowercase;
- note is normalized first;
- `manifestSha256 = SHA256(UTF-8(canonical JSON))`;
- output is lowercase 64-hex.

Reordering the draft items changes the hash.

The hash does **not** include:

- Project ID;
- Issue ID;
- Claim ID;
- display label;
- material title;
- current Source/Note metadata.

Those values are context/presentation, not fields in the physical EvidenceManifest snapshot.

The same hash may legitimately appear in distinct future Manifest rows. `manifest_sha256` is an integrity fingerprint, not a canonical ID or deduplication key.

M2-D must not silently reuse a prior Manifest merely because the hash matches.

## 15. Preview is not an authorization token

A successful M2-C preview does not grant a future M2-D write.

Between preview and Assessment commit:

- a Project material relation may change;
- a source may become inaccessible;
- a candidate Claim may leave the relevant context;
- other canonical state may change.

Therefore M2-D must:

1. receive the draft item data, not trust a prior preview as authorization;
2. revalidate Project -> Issue -> Claim;
3. revalidate every evidence target inside the M2-D write transaction;
4. rebuild the same canonical serialization;
5. recompute the SHA-256;
6. atomically insert Manifest + Items + Assessment.

M2-C preview is deterministic guidance, not a reservation, lock, capability, or persisted command.

## 16. Read-only lifecycle behavior

M2-C performs no canonical mutation, so evidence candidates and preview remain available when:

### Project

- ACTIVE;
- ARCHIVED.

### Research Issue

- OPEN;
- RESOLVED;
- ARCHIVED.

### Claim

- ACTIVE;
- ARCHIVED.

M2-C adds no lifecycle mutation.

The ability to create a new Assessment under read-only states is a separate M2-D design decision and is not pre-decided by M2-C.

## 17. Browser draft lifetime

M2-C evidence selection is a non-canonical draft.

Version 1 intentionally has **no persistence contract** for the draft.

The implementation may keep draft state in page/component memory, but must not write it to:

- PostgreSQL;
- `ops.idempotency_keys`;
- sessionStorage;
- localStorage;
- browser IndexedDB.

Reload/navigation may discard the draft.

This avoids storing item notes or private research-selection state in browser persistence before a durable domain object exists.

No M2-B-style pending receipt is required because M2-C has no canonical write and no response-unknown duplication risk.

## 18. UI design

The existing Issue Detail remains the canonical screen.

Each Candidate Claim card gains an evidence action such as:

```text
构建证据集
```

Expanding it loads that Claim's evidence candidates independently.

Suggested structure:

```text
Candidate Claim
------------------------------------------------
“刘祥店可能在 1960 年代整体迁出”

[构建证据集]

Supporting
  selected: Project note · Revision 3

Contradictory
  selected: Source record

Contextual
  selected: another Source

[预览 EvidenceManifest]

Evidence Draft
3 items
SHA-256: 75ab...

尚未提交。
将在评价该 Claim 时冻结为 EvidenceManifest。
```

### Selection interaction

The UI must require an explicit evidence role.

It must not auto-classify a selected item as SUPPORTING.

A candidate is included only after the researcher explicitly assigns:

- Supporting;
- Contradictory;
- Contextual.

Optional note is edited per selected item.

Selection order becomes Manifest ordinal order.

### Preview invalidation

Any draft edit after a successful preview:

- role change;
- add/remove item;
- note change;
- order change;

invalidates the displayed preview hash.

The UI must require re-preview before showing the new draft as canonically normalized.

### Independent degradation

Evidence-candidate failure for one Claim must not hide:

- Issue Detail;
- the Claim;
- other Candidate Claims.

The expanded evidence editor shows a local unavailable state and retry.

Preview failure likewise remains local to the evidence editor.

## 19. Error mapping

M2-C adds safe private API errors.

Suggested mapping:

```text
400 EVIDENCE_DRAFT_INVALID
404 PROJECT_ISSUE_OR_CLAIM_NOT_FOUND
404 EVIDENCE_TARGET_NOT_AVAILABLE
500 generic canonical integrity failure
503 Evidence selection store unavailable
```

Rules:

- malformed role/type/UUID/note/duplicate/empty draft -> 400;
- wrong Project Issue/Claim -> safe 404;
- target not authorized by the current Project -> safe 404;
- target may exist elsewhere, but the response must not reveal that;
- dangling/malformed canonical relationships -> 500 generic safe shape;
- connection/unavailable failure -> 503.

Internal SQL, foreign Project IDs, storage keys, or corruption details must never be returned.

All private responses keep `Cache-Control: no-store`.

## 20. Candidate and preview transaction model

### Candidate GET

Use one `REPEATABLE READ, READ ONLY` transaction.

It must validate Claim scope and material/evidence relationships from one snapshot.

No N+1 query pattern is allowed.

### Preview POST

Use one `REPEATABLE READ, READ ONLY` transaction for all scope/target validation.

Hashing may happen inside the application layer after canonical rows are returned, but it must be based only on the validated normalized draft.

The endpoint must not execute INSERT/UPDATE/DELETE in:

- `core`;
- `ops`;
- `derived`.

## 21. Integrity / fail-closed rules

M2-C must fail closed on at least:

- Project lifecycle outside ACTIVE/ARCHIVED;
- malformed Project metadata needed by evidence scope;
- Issue zero/multiple owner corruption;
- dangling Issue ProjectBinding;
- Claim relation whose Claim is missing;
- canonical Claim corruption;
- nonblank Project material `sourceId` that is not UUID;
- Source missing for a declared sourceId;
- Source edition mismatch;
- malformed Source lifecycle;
- SourceAsset missing/corrupt under an authorized Source;
- duplicate/malformed Project Note binding;
- Note binding subject metadata mismatch;
- Note missing/corrupt;
- NoteRevision missing or owned by another Note;
- invalid revision number/content format/timestamp;
- preview target that cannot be proven to belong to the current Project material graph.

A malformed relation must never be converted into "no evidence candidates."

## 22. Scope exclusions

M2-C explicitly does not implement:

- INSERT into `core.evidence_manifests`;
- INSERT into `core.evidence_manifest_items`;
- EvidenceManifest history/list/detail pages;
- Claim-to-Manifest relation;
- Assessment;
- stance;
- confidence level;
- numeric score;
- Assessment reasoning;
- IssueResolution;
- preferred Claim;
- ResearchRun;
- ClaimRelation;
- AI evidence search;
- AI evidence ranking;
- AI role classification;
- global evidence search;
- external file ingestion;
- SourceAsset creation;
- PDF/page/bbox/timecode/DOM locator system;
- persistent browser evidence drafts;
- schema migration;
- production deployment.

## 23. M2-D handoff contract

M2-C deliberately prepares a clean M2-D command boundary.

Future M2-D is expected to accept:

```text
Project
Issue
Claim
Assessment stance/confidence/reasoning
Evidence Manifest Draft items
```

and atomically create:

```text
EvidenceManifest
EvidenceManifestItems
Assessment
```

Expected future Manifest insert shape:

```text
schema_version = 1
purpose        = CLAIM_ASSESSMENT
manifest_sha256 = recomputed server hash
metadata       = {}
```

M2-C does not authorize or implement that write.

## 24. Acceptance criteria

### Domain / canonicalization

1. only the three executable roles are accepted;
2. only SOURCE/SOURCE_ASSET/NOTE_REVISION are accepted;
3. target UUIDs normalize to lowercase;
4. empty items are rejected;
5. duplicate target pairs are rejected;
6. item notes normalize deterministically;
7. whitespace-only note becomes null;
8. NUL or >2000-code-point note is rejected;
9. request order produces ordinals 1..N;
10. same normalized draft yields the same hash;
11. changed role changes hash;
12. changed target changes hash;
13. changed note changes hash;
14. changed order changes hash;
15. Claim/Project/Issue/display labels do not change hash.

### Project / Claim scope

16. wrong-Project Issue returns safe 404;
17. Claim not related to Issue returns safe 404;
18. multi-owner/dangling Issue scope fails closed;
19. Claim corruption fails closed;
20. ACTIVE and ARCHIVED Claim are readable.

### Evidence target authorization

21. valid Project Source is listed;
22. absent sourceId yields no Source candidate without failing the material;
23. declared dangling/mismatched sourceId fails closed;
24. SourceAsset under an authorized Source is listed;
25. SourceAsset from another Source/Project is rejected;
26. current project NoteRevision is listed;
27. preview accepts a previously selected older revision of the same authorized Note;
28. revision from another Note/Project is rejected;
29. candidate ordering is deterministic and does not imply relevance.

### Preview

30. preview returns `persisted:false`;
31. preview returns no manifest ID;
32. preview returns server-owned schemaVersion=1;
33. preview returns server-owned purpose=CLAIM_ASSESSMENT;
34. locatorType/locator/excerpt are null;
35. preview performs zero canonical/ops writes;
36. preview hash matches the documented canonical serialization exactly;
37. a cross-Project evidence target returns safe 404 without existence leakage.

### Lifecycle

38. candidates work for ACTIVE/ARCHIVED Project;
39. candidates/preview work for OPEN/RESOLVED/ARCHIVED Issue;
40. candidates/preview work for ACTIVE/ARCHIVED Claim;
41. M2-C creates no lifecycle mutation.

### Web

42. Issue/Claim remain visible when evidence candidates fail;
43. evidence editor retries independently;
44. selecting evidence requires explicit role;
45. optional note remains plain text;
46. preview clearly says "尚未提交";
47. any draft mutation invalidates a prior preview;
48. reload does not claim to recover the draft;
49. no evidence draft is stored in browser persistence;
50. no confidence/truth/preferred/Assessment language appears;
51. mobile 390x844 has no horizontal overflow.

### Frozen boundaries

52. M0 migration unchanged;
53. both frozen SQL test files unchanged;
54. no EvidenceManifest row is created by M2-C;
55. no EvidenceManifestItem row is created by M2-C;
56. no Assessment row is created by M2-C;
57. production unchanged;
58. M2-D implementation not started.

## 25. Verification scope for future implementation

A future approved implementation plan must include fresh evidence for:

- domain canonical serialization/hash tests;
- application scope/validation tests;
- PostgreSQL candidate/preview store tests;
- private route tests;
- real disposable PostgreSQL16 integration;
- explicit zero-write row-count checks for Manifest/Item/Assessment/ops tables;
- targeted Web evidence-editor tests;
- Research Issue Detail regression tests;
- Web research scoped suite;
- broad Web suite;
- API/Web builds;
- schema static gate;
- frozen SQL diff;
- `git diff --check`;
- full repository suite with unrelated failures reported exactly;
- real Firefox acceptance including:
  - Source candidate;
  - NoteRevision candidate;
  - explicit role selection;
  - preview hash;
  - `persisted:false` messaging;
  - preview invalidation after edit;
  - cross-Project target rejection;
  - independent degradation;
  - archived read behavior;
  - zero Manifest/Item/Assessment DB rows;
  - 390x844 no overflow.

Historical test results from M2-B must not be relabeled as fresh M2-C verification.

## 26. Repository and production boundaries

Future implementation, if separately approved, must:

- begin from the then-current `main`;
- use an isolated local worktree/feature branch;
- use one writer per worktree;
- use Native execution;
- preserve existing uncommitted/user work;
- use disposable PostgreSQL for integration;
- keep the M0 migration and two SQL verification files frozen;
- avoid production/Tencent writes;
- avoid deployment;
- avoid M2-D implementation.

This written spec does not authorize implementation.

## 27. Phase sequence

The phase sequence is now:

```text
M2-A  Research Issues                    MERGED
  |
M2-B  Candidate Claims                   MERGED
  |
M2-C  Evidence Selection
      + Manifest Draft
      + Canonical Hash                    THIS SPEC
  |
M2-D  Assessment
      + atomic EvidenceManifest commit
  |
M2-E  Issue Resolution
```

## 28. Current gate

```text
TASK_ID=S32_M2C_EVIDENCE_SELECTION_DESIGN_R1
SOURCE_BASELINE=8f5b4829b172ebae6a0f99201237da0e5666a33b
PLANNING_BRANCH=plan/s32-m2c-evidence-selection

M2_B_IMPLEMENTATION=MERGED
M2_C_CONVERSATIONAL_DESIGN=APPROVED
M2_C_WRITTEN_SPEC=READY_FOR_USER_REVIEW
M2_C_IMPLEMENTATION_PLAN=NOT_STARTED
M2_C_IMPLEMENTATION=NOT_STARTED
M2_D_STARTED=NO

SCHEMA_CHANGED=NO
PRODUCTION_CHANGED=NO
PRODUCTION_DEPLOYED=NO

NEXT_ACTION=USER_REVIEW_M2C_WRITTEN_SPEC
```

Approval of this written spec will authorize only the next planning stage: writing the M2-C Implementation Plan. It will not authorize product implementation.
