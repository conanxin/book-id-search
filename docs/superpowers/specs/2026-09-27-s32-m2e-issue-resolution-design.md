# S32 M2-E Issue Resolution Design

**Status:** Written spec ready for review  
**Task ID:** `S32_M2E_ISSUE_RESOLUTION_DESIGN_R1`  
**Source baseline:** `main@d8e6d96672e9cef6a2bab5a35c604fbd83ec83d9`  
**Planning branch:** `plan/s32-m2e-issue-resolution`  
**Predecessor:** M2-D Assessment merged and closed  
**Production gate:** R7 final acceptance must reach terminal PASS before M2-E implementation or schema mutation.

## 1. Purpose

M2-D answers:

> Given a specific Claim and frozen evidence set, what Assessment did the researcher make?

M2-E answers:

> For the Research Issue as a whole, what is the current working conclusion, and why?

The epistemic boundary remains:

```text
Claim != Assessment != IssueResolution
Assessment confidence != Issue truth
IssueResolution = issue-level working conclusion
```

M2-E does not edit historical Assessments, mark Claims true/false, delete competing Claims, run AI research, or modify production during design.

## 2. Executable schema is authoritative

Current deployed bootstrap schema already contains:

```text
core.research_issues
  id
  title
  question
  lifecycle_state = OPEN | RESOLVED | ARCHIVED
  current_resolution_id nullable

core.issue_resolutions
  id
  issue_id
  resolution_type
  preferred_claim_id nullable
  rationale nullable
  evidence_manifest_id nullable
  created_at
```

Allowed `resolution_type` values are:

```text
PREFERRED_CLAIM
INSUFFICIENT_EVIDENCE
NO_WORKING_CONCLUSION
```

The bootstrap schema already has a deferred same-Issue current-pointer FK:

```text
(research_issues.id, current_resolution_id)
  -> issue_resolutions(issue_id, id)
```

Therefore current Resolution identity must be read from `current_resolution_id`, never inferred from the newest timestamp.

## 3. Two executable-schema gaps

### 3.1 Preferred Claim membership is not DB-enforced

The architecture requires a preferred Claim to belong to the same Research Issue.

Current executable schema only has:

```text
issue_resolutions.preferred_claim_id -> claims.id
```

M2-E requires an additive post-v1 migration with:

```sql
FOREIGN KEY (issue_id, preferred_claim_id)
REFERENCES core.research_issue_claims (issue_id, claim_id)
ON DELETE RESTRICT
```

This allows NULL for non-`PREFERRED_CLAIM` Resolution rows while making a non-null preferred Claim an actual candidate of the same Issue.

### 3.2 IssueResolution append-only is not DB-enforced

Architecture requires Resolution history to be append-only, but the current five frozen trigger contracts do not protect `core.issue_resolutions`.

M2-E requires a new additive migration that rejects UPDATE and DELETE on IssueResolution rows.

Do not rewrite historical `001_s32_core_schema.sql`. The M2-E invariant migration is a new migration applied only after R7 closes.

## 4. Resolution history and current pointer

M2-E v1 uses:

```text
append-only Resolution history
+
ResearchIssue.current_resolution_id
```

Do not introduce the older speculative `supersedes_resolution_id` field. It is absent from the executable schema and unnecessary for v1.

History order:

```text
created_at DESC, id DESC
```

Current is defined only by the pointer.

## 5. Resolution types

### 5.1 PREFERRED_CLAIM

Meaning: the Issue currently has a preferred working Claim.

Requirements:

- `preferred_claim_id != NULL`;
- preferred Claim belongs to the same Issue;
- rationale is required;
- Claim may remain ACTIVE or ARCHIVED as historical knowledge; Resolution does not mutate the Claim.

### 5.2 INSUFFICIENT_EVIDENCE

Meaning: the research question is valid, but current evidence is insufficient to choose a preferred Claim.

Requirements:

- `preferred_claim_id = NULL`;
- rationale is required.

This is distinct from M2-D Claim-level `INCONCLUSIVE`.

### 5.3 NO_WORKING_CONCLUSION

Meaning: the Issue currently has no usable working conclusion.

Requirements:

- `preferred_claim_id = NULL`;
- rationale is required.

## 6. Evidence basis

M2-E v1 does not create a second Issue-level Evidence Selection subsystem.

`issue_resolutions.evidence_manifest_id` remains nullable.

If present, it must reference an already-existing immutable EvidenceManifest that is currently visible in the Project/Issue context. The Web should normally offer frozen manifests associated with currently visible Assessments.

M2-E does not:

- mutate a Manifest;
- copy ManifestItems;
- change Manifest SHA;
- create an additional Issue-level Manifest solely for Resolution.

Resolution visibility must not leak a Manifest that is no longer authorized in the current Project context.

## 7. Lifecycle

Create Resolution is allowed when:

```text
Project = ACTIVE
Issue = OPEN | RESOLVED
```

Rejected when:

```text
Project ARCHIVED -> PROJECT_READ_ONLY
Issue ARCHIVED   -> RESEARCH_ISSUE_READ_ONLY
```

Successful create runs in one SERIALIZABLE transaction:

1. reserve/resolve idempotency key;
2. lock exact ResearchIssue;
3. compare expected current pointer;
4. validate lifecycle and preferred Claim membership;
5. validate optional Manifest visibility/integrity;
6. insert IssueResolution;
7. CAS-update `research_issues.current_resolution_id`;
8. set `lifecycle_state='RESOLVED'`;
9. canonical read-back;
10. complete idempotency receipt;
11. COMMIT.

M2-E v1 has no reopen command. A future explicit reopen workflow is separate.

## 8. Concurrency

Create request includes:

```ts
expectedCurrentResolutionId: string | null
```

Inside the transaction:

- persisted pointer == expected pointer -> continue;
- mismatch -> `409 ISSUE_RESOLUTION_STALE`.

No last-write-wins behavior.

A stale writer must reload the Issue and explicitly decide again.

## 9. Idempotency

Create Resolution requires `Idempotency-Key`.

Recommended scope:

```text
S32:M2E:PROJECT_ISSUE_RESOLUTION_CREATE:<projectId>:<issueId>
```

Canonical request hash includes:

- projectId;
- issueId;
- expectedCurrentResolutionId;
- resolutionType;
- preferredClaimId/null;
- normalized rationale;
- evidenceManifestId/null.

Same key + same hash returns the exact prior Resolution ID.  
Same key + different hash returns `409 IDEMPOTENCY_CONFLICT`.

## 10. Rationale normalization

Rationale is required plain text:

- reject U+0000;
- CRLF/CR -> LF;
- trim outer Unicode whitespace;
- preserve internal whitespace/newlines;
- 1..8000 Unicode code points.

Reuse the M2-D reasoning normalization contract/helper where practical.

## 11. Private HTTP API

Proposed endpoints:

```http
POST /api/private/s32/projects/:projectId/issues/:issueId/resolutions
GET  /api/private/s32/projects/:projectId/issues/:issueId/resolutions
GET  /api/private/s32/projects/:projectId/issues/:issueId/resolutions/:resolutionId
```

Create body:

```json
{
  "expectedCurrentResolutionId": null,
  "resolutionType": "PREFERRED_CLAIM",
  "preferredClaimId": "<uuid>",
  "rationale": "...",
  "evidenceManifestId": "<uuid-or-null>"
}
```

Create status:

- 201 created;
- 200 idempotency replay.

Recommended errors:

- `400 ISSUE_RESOLUTION_INVALID`
- `404 PROJECT_OR_ISSUE_NOT_FOUND`
- `404 PREFERRED_CLAIM_NOT_AVAILABLE`
- `404 EVIDENCE_MANIFEST_NOT_AVAILABLE`
- `409 PROJECT_READ_ONLY`
- `409 RESEARCH_ISSUE_READ_ONLY`
- `409 ISSUE_RESOLUTION_STALE`
- `409 IDEMPOTENCY_CONFLICT`
- `503 ISSUE_RESOLUTION_STORE_UNAVAILABLE`

All private endpoints use `Cache-Control: no-store`.

## 12. Read model

Research Issue UI adds:

```text
Current Working Conclusion
Resolution History
```

The current card reads the exact row referenced by `current_resolution_id`.

History:

- keyset pagination;
- order `created_at DESC, id DESC`;
- default 20, max 50;
- current Resolution marked explicitly;
- preferred Claim rendered from canonical Claim data;
- evidence basis shown only when currently authorized.

Resolution does not hide competing Claims or Assessment history.

## 13. Web composer

Keep M2-E inside the existing Research Issue workspace.

Flow:

```text
Candidate Claims
-> Assessments
-> Form working conclusion
-> choose Resolution type
-> optional preferred Claim
-> optional evidence basis
-> rationale
-> explicit Submit
-> current Resolution + history
```

There is no automatic preferred-Claim inference from Assessment stance or confidence.

## 14. Migration gate

Before product implementation, add an additive post-v1 migration covering:

1. same-Issue preferred Claim composite FK;
2. IssueResolution UPDATE rejection;
3. IssueResolution DELETE rejection;
4. schema assertions;
5. negative invariant tests.

Required DB tests include:

- cross-Issue preferred Claim rejected;
- Resolution UPDATE rejected;
- Resolution DELETE rejected;
- cross-Issue current Resolution remains rejected;
- non-PREFERRED Resolution + NULL preferred passes;
- PREFERRED_CLAIM + NULL preferred remains rejected.

Historical `001_s32_core_schema.sql` remains byte-for-byte unchanged.

## 15. Acceptance gates

Fresh implementation evidence must cover:

1. domain normalization and type matrix;
2. same-Issue preferred Claim invariant;
3. all three Resolution types;
4. append-only DB invariant;
5. OPEN -> RESOLVED atomic write;
6. RESOLVED -> new Resolution pointer advance;
7. stale pointer -> 409 with zero partial write;
8. exact idempotency replay;
9. changed command under same key -> conflict;
10. Project/Issue lifecycle gates;
11. optional existing Manifest visibility/integrity;
12. current pointer never inferred from timestamps;
13. history pagination;
14. real PostgreSQL 16 transaction/concurrency tests;
15. Web create -> current -> history -> detail;
16. response-unknown same-key replay;
17. 390x844 no-horizontal-overflow;
18. targeted API/Web + builds + migration/schema tests + relevant regression suite.

## 16. Hard sequencing gate

Current rollout state remains:

```text
R6_STATE=TERMINAL_PASS
R7_STATE=NOT_EXECUTED
```

M2-E design work is allowed now, but implementation, migration, runtime mutation, and deployment are blocked until R7 final acceptance reaches terminal PASS.

```text
M2_E_DESIGN=READY_FOR_REVIEW
M2_E_IMPLEMENTATION=NOT_STARTED
M2_E_SCHEMA_MIGRATION=NOT_STARTED
M2_E_PRODUCTION_CHANGED=NO
R7_TERMINAL_PASS_REQUIRED_BEFORE_M2E_CODE=YES
```

Next after R7 terminal PASS:

1. approve/freeze this written spec;
2. write implementation plan;
3. additive schema migration + real PG invariant tests;
4. domain/store/routes;
5. Web Resolution composer/history;
6. browser + regression gates;
7. PR review/merge;
8. separate deployment decision.
