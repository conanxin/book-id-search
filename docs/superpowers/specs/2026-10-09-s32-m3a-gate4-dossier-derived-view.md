# S32 M3-A Gate 4 — Research Dossier derived read contract

Date: 2026-10-09 (Asia/Shanghai)

Task: `S32_M3A_GATE4_TASK1_DOSSIER_DERIVED_READ_CONTRACT_R1`

Source baseline: `main@42cf1b7b4a10a6edfa53d688012728dded0b3049`

Branch: `feat/s32-m3a-gate4-dossier`

Status: **TASK1_CONTRACT_AUDIT_COMPLETE / REVIEWABLE_WITH_OPEN_DECISION_D01**.

This document freezes the observed read contracts and the proposed composition boundaries. D01, the presentation of chronology with unequal timestamp precision, remains explicitly open for review. It does not claim that a Dossier implementation, tests, a pull request, or a deployment exists.

## 0. Authority and result

The governing scope is [Issue #55](https://github.com/conanxin/book-id-search/issues/55), following the merged [M3-A design, sections 3–5 and 11](https://github.com/conanxin/book-id-search/blob/42cf1b7b4a10a6edfa53d688012728dded0b3049/docs/superpowers/specs/2026-09-29-s32-m3a-research-run-dossier-auth.md).

The existing Notion phase page is [Gate 4 design and handoff](https://app.notion.com/p/3f334a28189a81e09bdbc00a9ff68ef9). Gate 3's production closure is recorded in [Issue #2](https://github.com/conanxin/book-id-search/issues/2#issuecomment-6068773792). Production observations in those records are historical evidence, not a production re-test performed for this task.

The source audit uses the exact baseline above. Older design headers, the obsolete next-stage text in `docs/STATUS.md`, and the historical R1 Project-scoped proposal do not override the accepted Issue-scoped design or the Gate 3 closure.

### 0.1 What the audit established

| Finding | Consequence for Gate 4 |
|---|---|
| `getResearchIssue` has no `currentResolutionId` field. | Read the current pointer and its separately returned current summary from `listIssueResolutions`. |
| Assessment, Resolution, and Run have different evidence visibility contracts. | Use separate adapters; do not invent a universal unavailable-manifest DTO. |
| Run summaries expose `startedAtMicros`; Resolution `createdAt` and Run `completedAt` expose only millisecond ISO strings. | Existing APIs cannot support a fully precise cross-stream total event order. D01 must be resolved before Task 2 implements the chronology policy. |
| Run history is paginated by start time, not completion time. | A first page cannot represent every recently completed Run. |
| Run evidence items intentionally omit `targetId`, even when available. | Do not reconstruct targets by joining a Run snapshot to another manifest response. |
| Run `output.produced` references are not independent authorization to read those objects. | Resolve content through the object's own authorized reader; preserve failures. |
| Existing evidence locators and excerpts are null. | Show grounded object references and fingerprints; do not fabricate page, image, map, or source permalinks. |
| Read transactions are independent. | A composed Dossier is a current reading window, not a cross-endpoint atomic snapshot. |

**Fit-gap:** Existing reads support a useful Issue dossier with honest visibility and coverage. They do not provide a globally precise event log, a full historical content snapshot, universal per-produced-object degradation, or full scholarly citations. These limits do not justify a Dossier table or a migration.

### 0.2 Delivery boundary

Task 1 changes this document only. It does not change Web/API code, DTOs, schemas, migrations, deployment files, authentication, or production data. It does not create a PR or start Task 2.

Issues #56 and #57 and the previously recorded unrelated WeRead/scripts failures stay outside this diff. They are not prerequisites for a documentation-only contract audit.

## 1. User outcome and scope

For one authorized Project/ResearchIssue, provide a readable dossier containing:

1. Question.
2. Current Working Conclusion.
3. Competing Claims.
4. Evidence.
5. Assessments.
6. Resolution History.
7. Research Runs.
8. What Changed.
9. Sources / Object References.

The proposed route remains `/research/projects/:projectId/issues/:issueId/dossier`. It is not a route implemented at this baseline.

The Dossier assembles existing records. It creates no canonical object and exposes no research write command. Its links may return to the existing Issue workspace, where existing commands retain their own permissions. A Dossier remains read-only even when its Project is active.

Archived Projects and archived/resolved Issues remain readable when their existing scope and evidence authorization pass. Archiving is not synonymous with evidence revocation.

Spatial presentation has no verified coordinate/geometry input in these readers and is deferred. Export and persisted Dossier snapshots are deferred. Do not add inactive buttons that imply those capabilities already exist.

## 2. Sources inspected

All source links below pin the baseline commit. Function names identify the audited contract even if line locations change later.

| Key | Source | Relevant responsibility |
|---|---|---|
| W | [Web research API](https://github.com/conanxin/book-id-search/blob/42cf1b7b4a10a6edfa53d688012728dded0b3049/apps/web/src/research/api.ts) | Actual DTOs, validators, request/auth handling, and existing read functions |
| I | [ResearchIssue read store](https://github.com/conanxin/book-id-search/blob/42cf1b7b4a10a6edfa53d688012728dded0b3049/apps/api/src/s32/postgres/research-issue-store.ts) | Question and Project context; no current pointer in this DTO |
| C | [CandidateClaim store](https://github.com/conanxin/book-id-search/blob/42cf1b7b4a10a6edfa53d688012728dded0b3049/apps/api/src/s32/postgres/candidate-claim-store.ts) | Issue membership, unpaginated claim order, archived reads |
| A | [Assessment read store](https://github.com/conanxin/book-id-search/blob/42cf1b7b4a10a6edfa53d688012728dded0b3049/apps/api/src/s32/postgres/assessment-read-store.ts) | Visibility before paging; exact evidence detail |
| R | [Resolution read store](https://github.com/conanxin/book-id-search/blob/42cf1b7b4a10a6edfa53d688012728dded0b3049/apps/api/src/s32/postgres/issue-resolution-read-store.ts) | Current pointer, history, details, visible evidence-bases |
| U | [Run read store](https://github.com/conanxin/book-id-search/blob/42cf1b7b4a10a6edfa53d688012728dded0b3049/apps/api/src/s32/postgres/research-run-read-store.ts) | Start-time ordering, redacted evidence, ancestors, produced-reference validation |
| E | [Project evidence authorization](https://github.com/conanxin/book-id-search/blob/42cf1b7b4a10a6edfa53d688012728dded0b3049/apps/api/src/s32/postgres/project-evidence-authorization.ts) | Current Project material graph; authorized historical NoteRevisions |
| H | [Private request auth](https://github.com/conanxin/book-id-search/blob/42cf1b7b4a10a6edfa53d688012728dded0b3049/apps/api/src/auth/private-request-auth.ts) | Owner session, machine compatibility, and unsafe-method checks |
| F | [Manifest canonicalization](https://github.com/conanxin/book-id-search/blob/42cf1b7b4a10a6edfa53d688012728dded0b3049/apps/api/src/s32/domain/evidence-selection.ts) | What the manifest hash actually fingerprints |
| UI | [Issue detail](https://github.com/conanxin/book-id-search/blob/42cf1b7b4a10a6edfa53d688012728dded0b3049/apps/web/src/research/ResearchIssueDetail.tsx), [ProjectsPage](https://github.com/conanxin/book-id-search/blob/42cf1b7b4a10a6edfa53d688012728dded0b3049/apps/web/src/research/ProjectsPage.tsx), [App](https://github.com/conanxin/book-id-search/blob/42cf1b7b4a10a6edfa53d688012728dded0b3049/apps/web/src/App.tsx) | Existing authenticated mount boundary and routes |

The corresponding domain/application files and route error mappings were also inspected for pagination and error semantics. This is a static source audit; existing tests were read as supporting contracts where needed, but no application or database tests were executed for a documentation-only change.

## 3. Source-of-truth matrix

All functions below are private, authenticated Web readers under `/api/private/s32`. None is a public data endpoint. Use the existing exported client, not a new fetch path that bypasses its validators or session handling.

`P`, `I`, `C`, `A`, `R`, and `U` in API signatures below mean requested Project, Issue, Claim, Assessment, Resolution, and Run identifiers.

| Dossier section | Existing reader and exact source | Paging and availability | Required rendering rule |
|---|---|---|---|
| Question | `getResearchIssue(P,I)` → `project.{id,name,lifecycleState,readOnly}` and `issue.{id,projectId,title,question,lifecycleState,createdAt,updatedAt}` | One detail; scope 404 or service/error state | Verify response Project and Issue IDs against the route. This reader has no current-resolution pointer. |
| Current | `listIssueResolutions(P,I,{limit,cursor})` → `issue.currentResolutionId` plus independent `currentResolution` | Current summary is returned separately from the requested history page | Use the pointer/summary pair from one accepted response. Null pointer and null current summary mean no current working conclusion. |
| Full Current rationale | `getIssueResolution(P,I,R)` → `issue`, `resolution.{id,issueId,resolutionType,preferredClaimId,rationale,createdAt,isCurrent}` | Detail may observe a newer current pointer | Check requested R and the current pointer again; never substitute another historical record on failure. |
| Competing Claims | `listCandidateClaims(P,I)` → `claims[].{id,statement,lifecycleState,createdAt,updatedAt}` | Unpaginated. Server order is ACTIVE before ARCHIVED, then `created_at ASC,id ASC` | Preserve server order. Candidate Claims are alternatives, not ranked truth or inferred confidence. |
| Evidence overview | `listIssueResolutionEvidenceBases(P,I,{limit,cursor})` → `issueId,evidenceBases[],nextCursor` | Only currently visible eligible Assessment bases; each row has `assessmentId,claimId,claimStatementExcerpt,stance,confidenceLevel,manifestId,manifestSha256,itemCount,assessmentCreatedAt` | This is an index of currently available bases, not all historical evidence or all Run inputs. |
| Evidence details | Authorized `getAssessment` / `getIssueResolution` detail; selected `getResearchRun` root snapshot | Three different disclosure contracts, section 5 | Preserve origin and shape. A manifest's matching hash/ID is not permission to enrich a Run response. |
| Assessments | `listAssessments(P,I,C,{limit,cursor})` and `getAssessment(P,I,C,A)` | Per-Claim pagination, current visibility filtering; no Issue-wide full Assessment-detail endpoint | Use evidence-bases for initial Issue overview, then load selected Claim history/detail on demand. Do not label filtered results as all historical Assessments. |
| Resolution History | `listIssueResolutions` → `resolutions[]`, `nextCursor` | Server microsecond keyset order; each row has summary fields, `isCurrent`, and availability | Preserve returned order. The first history row does not define Current. |
| Research Runs | `listResearchRuns(P,I,{limit,cursor})` → `runs[],nextCursor`; `getResearchRun(P,I,U)` → `run,evidenceManifest,ancestors` | List order uses start time. Summary has `startedAtMicros`; detail has richer procedure/output but no root microsecond fields | Preserve status, observed timing, replay relation, and source coverage. Do not make terminal or write controls part of the Dossier. |
| What Changed | Resolution records plus Run chronology already obtained | Loaded records only; unequal timestamp precision; D01 open | Derive factual record events only. Never infer causal findings or a full change log from a partial page. |
| Sources / Object References | IDs and authorized fields from the readers above; optional current `listEvidenceCandidates(P,I,C)` metadata enrichment | Locator and excerpt fields in existing A/R manifests are null; Run targets are withheld | Display grounded identities/fingerprints. Add a link only for a route/locator actually supported and authorized. |

### 3.1 Assessment fields

Summary fields are `id,stance,confidenceLevel,actorId,numericScore,scoreKind,reasoningExcerpt,createdAt,evidenceManifest`. Detail supplies `claimId` and full `reasoning`.

Nullable confidence, actor, score, and reasoning remain nullable. An actor ID is not an actor display name; a score is not a probability unless its actual `scoreKind` establishes that meaning. Do not manufacture confidence or authority from metadata.

### 3.2 Run fields

Summary fields are `runId,issueId,status,replayOf,startedAtMicros,startedAt,completedAt,evidenceManifest`.

Root detail fields are `runId,projectId,issueId,status,evidenceManifestId,replayOf,procedure,executionContract,environment,output,knowledgeCutoff,startedAt,completedAt,createdAt`.

`output.produced` has `claimIds,assessmentIds,resolutionIds,noteRevisionIds`; these are references. `output.gaps` records declared gaps, not a complete checklist. `knowledgeCutoff` is nullable and must not be synthesized from creation time.

Do not replace the summary with the detail DTO: the latter lacks root `startedAtMicros`. Keep only the explicitly supplied precision for each accepted record.

## 4. Current-resolution invariants

The authority is the database `core.research_issues.current_resolution_id`, exposed through the Resolution reader's `issue.currentResolutionId`. W's `ResearchIssue` and I's `canonicalIssue` do not expose that column.

R's `list` independently reads the pointer record even when it is not in the requested history page. W's `isIssueResolutionHistoryResponse` validates pointer/null consistency and `isCurrent` flags.

The Dossier must enforce these rules:

1. `currentResolutionId === null` requires `currentResolution === null`. Show “尚未形成当前工作结论”.
2. A non-null pointer requires a summary with the same ID, same Issue, and `isCurrent:true`. Malformed success is a response error, never an empty state.
3. `NO_WORKING_CONCLUSION` is an explicitly recorded Resolution, distinct from no Resolution. Likewise `INSUFFICIENT_EVIDENCE` is a conclusion type, not a failed fetch.
4. `preferredClaimId` is rendered only as the currently recorded preference. It does not suppress competing or archived Claims.
5. A newer Run, a successful Run, a newer Assessment, or the first history row must never set Current.
6. An old page can validly contain no current row. Retain the independently returned current summary.
7. An accepted Resolution-page/detail response with a changed pointer invalidates the old current detail and historical `isCurrent` badges. Reconcile from the new authoritative pointer, rather than arrival-time merging unrelated snapshots.
8. For a selected Current detail, require the returned record ID to equal the requested ID, `resolution.issueId` to equal I, and the returned pointer still to select it. If Current moved, show “当前工作结论已更新，请刷新” and perform at most one explicit reconciliation read; never loop indefinitely.
9. An older request must not overwrite a newer accepted scope/generation. Pointer equality, not a millisecond `updatedAt` comparison alone, detects a changed current identity.
10. When Current is unavailable, historical sections may still be readable. They must not be promoted to Current as a fallback.
11. Archived scope does not clear Current. The Dossier does not offer a command to change it.

These are per-response consistency guarantees. Separately fetched Question, Current, history, and Run data may span several transactions. Show the last successful read time and, when applicable, that some sections need refresh; do not claim a common database snapshot timestamp.

## 5. Evidence privacy matrix

The following shapes are observed source contracts, not interchangeable presentation conveniences.

| Surface | Authorized response | Unavailable evidence response | Forbidden enrichment |
|---|---|---|---|
| Assessment list | Five-key manifest: `id,schemaVersion,purpose,manifestSha256,itemCount` | Whole Assessment is filtered out before paging | Do not synthesize a hidden row, count, or unavailable placeholder. |
| Assessment detail | Six-key manifest: `id,schemaVersion,purpose,manifestSha256,createdAt,items` | Detail 404 `ASSESSMENT_NOT_FOUND` | Do not restore its reasoning/items from a Run's produced IDs or an old cache. |
| Resolution list/current | Five-key Assessment manifest with `evidenceBasisAvailable:true` | Resolution retained; `false` and `evidenceManifest:null` | No remembered manifest ID/hash/count or target detail may be copied into the null response. |
| Resolution detail | Six-key Assessment manifest with `evidenceBasisAvailable:true` | Resolution retained; `false` and `null` | The public Resolution record itself omits `evidenceManifestId`. Do not reintroduce it. |
| Resolution evidence-bases | Visible basis row with Assessment/Claim/Manifest identifiers and hash/count | Basis omitted before paging | This is not a registry of unavailable manifests. |
| Run list | Four-key compact `id,manifestSha256,itemCount,available` | Same four keys, `available:false` | No `items` property, including empty/null/undefined placeholders. |
| Run ancestors | Same four-key compact regardless of availability | Same four keys, `available:false` | Ancestors do not become root-detail snapshots. |
| Run root detail | Five-key snapshot `id,manifestSha256,itemCount,available:true,items` | Four-key snapshot, `available:false` | Available Run items still cannot acquire `targetId`, locator, or excerpt. |

A/R visible detail item:

~~~ts
{
  ordinal, role, targetType, targetId,
  locatorType: null, locator: null, excerpt: null, note
}
~~~

Run visible root item:

~~~ts
{ ordinal, role, targetType, note }
~~~

W validators enforce these key sets. Add display metadata in a separate view model, not by mutating a validated source DTO.

### 5.1 Meanings that the response does not prove

- Assessment 404 does not distinguish absent, foreign, or no-longer-visible records.
- Resolution `false/null` means “未指定或当前不可访问证据依据”; it does not distinguish never-selected evidence from revoked evidence.
- Run `available:false` means its structured input items cannot currently be expanded. It does not identify the failed target, cause, person, or time.
- ARCHIVED is an accepted readable lifecycle state; it is not the same as revoked material membership.
- A successful filtered empty result means no currently visible matching records from that read, not that no such records ever existed.
- Server 500 integrity failures and 503 service failures are not evidence-unavailable success states.

Use the existing neutral wording. Never invent deletion/revocation events or hidden totals.

### 5.2 Authorization and historical revisions

E authorizes Source and SourceAsset targets through the current Project material graph. Historical NoteRevisions remain eligible when their parent Note still belongs to that Project. Do not silently replace a frozen historical revision with today's current revision.

A checks visibility before validating selected records. R and U also validate persisted relationships and manifest integrity; damaged data can produce a 500 rather than an unavailable snapshot. Preserve these distinctions.

### 5.3 Produced-object policy

U's `validateProducedReferences` verifies Claim/Assessment/Resolution Issue relationships. Its Assessment membership check does not rerun that Assessment's evidence visibility filter. NoteRevision access failure can make the entire Run detail fail with 500. Run list and detail can therefore legitimately have different read outcomes.

For Dossier composition:

- Treat produced IDs as recorded references, not permissions or guaranteed available content.
- Do not print or hyperlink a produced Assessment ID before its own current authorized reader succeeds.
- Resolve Claim references against the current Issue Claims response. Resolve Resolution details with their scoped reader.
- A Run supplies produced Assessment IDs but not the Claim ID required by `getAssessment(P,I,C,A)`. Obtain the A-to-C mapping only from the current scope's already-loaded visible evidence-bases or an authorized Assessment history/detail. A missing mapping in a partial index means unresolved/not requested, not unavailable. On explicit request, continue that evidence-bases index with its own cursor; never guess a Claim ID or scan every Claim to fill the mapping. Even an exhausted visible index cannot prove why a produced reference has no available mapping. Only call the Assessment detail reader once the mapping is established.
- A NoteRevision link requires a verified parent binding/Note/revision mapping and the existing revision reader. If that mapping is not available, show an unresolved reference state without inventing a route or exposing an unverified target.
- Display “相关对象当前不可用” only after the object's own neutral 404 or explicit unavailable result. Missing mappings remain unresolved; pending reads remain loading; network/500/502/503 failures remain errors with a retry action. Omit unverified target identity/details in all of these states, but preserve the distinction between lack of a mapping, unavailable content, and a failed request. Do not backfill from raw output or historical caches.
- A failed Run detail remains an error while its valid list summary can remain visible. Do not convert 500 to “没有研究输出”.
- A single-object redaction wrapper that keeps every Run detail readable after produced-reference loss would be a separate backend behavior change, not something this Dossier can claim to provide.

Free-text `note`, procedure, environment, and output summaries are not a semantic redaction service. Do not parse arbitrary prose/UUIDs into privileged navigation. Exact-key checks describe structured-field exposure only.

### 5.4 Refresh and retained data

Keep private data in page memory only. On scope/auth-generation change, cancel all requests and clear the old view before any new scope is displayed. Do not persist Dossier payloads or target details in browser storage.

Within one scope, a freshly observed unavailable response invalidates corresponding previously displayed target details. If readers disagree within a refresh window, keep the narrower disclosure and require a new authorized detail read; never merge into a richer manifest. This is conservative client composition, not a claim of immediate server-push revocation.

No new background synchronization, persistent cache, or source snapshot store is required.

## 6. Pagination, time precision, and coverage

### 6.1 Existing order must survive composition

Keep server cursors opaque. Pass `nextCursor` unchanged to the same reader and same Project/Issue/Claim scope. Do not decode/re-encode cursors, generate cursors from displayed dates, or convert microsecond strings to JavaScript Number.

A/R history readers use microsecond-based server keysets despite exposing millisecond display timestamps. U's list uses `started_at DESC,id DESC` and returns `startedAtMicros`. Preserve each stream's returned order on append.

Use `BigInt` or exact decimal-string comparison only for actual microsecond fields. JavaScript Date is acceptable for human-readable formatting, not as a replacement for precise ordering keys.

| Stream | Source order / cursor basis | Exposed time used by the Dossier | Coverage limitation |
|---|---|---|---|
| Claims | ACTIVE before ARCHIVED, creation ASC, ID ASC; no cursor | ISO `createdAt/updatedAt` | Unpaginated current list; not an edit-event history |
| Assessment history | `created_at DESC,id DESC`, visibility before keyset | Millisecond `createdAt` | Only currently visible Assessments for the selected Claim |
| Resolution history | `created_at DESC,id DESC` | Millisecond `createdAt` | Current returned independently; no precise cross-stream timestamp |
| Resolution evidence-bases | Assessment creation DESC, Assessment ID DESC | Millisecond `assessmentCreatedAt` | Current eligible/visible bases, not all evidence |
| Run history | `started_at DESC,id DESC` | Exact `startedAtMicros` plus display `startedAt`; millisecond nullable `completedAt` | Start-ordered pages can omit an old Run that completed recently |
| Run root detail | One Run plus oldest-first ancestors | Millisecond ISO timing; root lacks `startedAtMicros` | Ancestors are a lineage, not an Issue's full Run history |

The proposed UI page size is 20. Actual server defaults and maximums are 20/50 for Assessment history, Resolution history, and Resolution evidence-bases, and 20/100 for Run history. Assessment and Resolution cursors are v2, using creation microseconds plus ID; Run cursors are v1, using start microseconds plus ID. Keep cursors opaque despite documenting their source contract. Keep separate cursors for each stream and each opened Claim's Assessments.

Pagination sources: `domain/assessment.ts` (`readAssessmentHistoryQuery`, cursor validation), `domain/issue-resolution.ts` (`readIssueResolutionHistoryQuery` and cursor parsing), and `application/research-runs.ts` plus `domain/research-run.ts`. These paths are relative to `apps/api/src/s32` at the pinned baseline. Do not send limit 100 to the A/R readers.

### 6.2 Coverage contract

Each stream tracks its own:

~~~ts
{
  scopeKey,
  loadedCount,
  nextCursor,
  status,          // notRequested | loading | ready | partial | error
  readGeneration
}
~~~

`nextCursor:null` proves exhaustion only for that stream under that sequence of successful current-visibility reads. It does not prove access to hidden rows, that all other streams were read, or that no concurrent write happened.

Never show “全部历史”, “最近所有变化”, “自上次访问以来全部变化”, or a global total when only one or more pages have been loaded. Preferred wording is “已加载的研究记录” with per-stream “加载更多”.

A later page failure retains accepted prior rows and offers retry for that cursor. It does not become an empty collection. Duplicate IDs are deduplicated by typed ID; conflicting immutable identity/content is an error to reconcile, not silently overwritten evidence. A Run's legitimate RUNNING-to-terminal transition is handled as a fresh authoritative state of the same Run.

The unpaginated Claims endpoint has no server-side page limit. Render a bounded subset initially if useful, disclose “已显示 X / 已读取 Y”, and never pretend a client display limit is a server cursor.

## 7. What Changed — factual derivation and open decision D01

### 7.1 Allowed event meanings

Only the following facts can be derived from the inspected sources:

| Proposed event | Required authoritative input | Wording / limit |
|---|---|---|
| `RESOLUTION_RECORDED` | An accepted Resolution record/summary with ID and creation time | “记录工作结论”; an event is not proof the conclusion is true or remains current |
| `RUN_STARTED` | An accepted Run summary | “开始研究轮次”; use its actual start key |
| `RUN_TERMINATED` | Run status SUCCEEDED/FAILED/CANCELLED with non-null completion time | “研究轮次成功完成 / 失败 / 取消”; success does not resolve the Issue |
| Replay annotation | Verified `replayOf` and, when fetched, validated ancestry | “重放自另一轮次”; not a claim that results are identical |

`RUNNING` must not generate a terminal event. A terminal Run's semantic fields are treated as immutable by the accepted application contract; RUNNING state is not an immutable final result.

Event identity is typed and deterministic, for example `resolution:<id>:recorded` and `run:<id>:started/terminated`. This is an ephemeral display key, not a new database/event ID.

Do not generate Claim-created, Assessment-adopted, Source-revoked, “evidence disproved claim”, “Run caused Resolution”, or “research complete” events from absent audit fields. The accepted What Changed scope is Resolution history plus Run chronology.

A text comparison can be labeled a comparison of two explicitly selected loaded records. It cannot be promoted to causal explanation. No generated AI summary is required for v0.1.

### 7.2 D01: unequal timestamp precision

**Observed gap:** Resolution creation and Run completion do not expose microsecond sort keys. Displaying `2026-10-09T01:02:03.123Z` does not identify the original database microsecond inside that millisecond. Padding zeros invents precision. Decoding a page cursor cannot recover every row's missing timestamp.

Two cross-stream records in the same displayed millisecond have an unresolved actual order. Run-start keys can be precise while adjacent Resolution or terminal-event keys are not. A fixed type/ID tie-breaker is only presentation, not a historical sequence.

**Recommended proposal — D01-A:** Retain the separate authoritative Resolution and Run streams. The What Changed section groups the factual events from loaded records and explicitly leaves same-millisecond cross-stream ordering unresolved. Preserve server order within each source stream. Label source coverage and do not advertise a precise merged event log. Do not create backend work for the first useful read-only dossier.

If a merged presentation is used after D01-A is accepted, compare only established non-overlapping time bounds; represent a millisecond value as an uncertainty interval, not an invented exact microsecond. Events with overlapping intervals must be visibly grouped without a “before/after” claim. A display tie-breaker must never erase the source-stream order or imply causality.

**Alternative — D01-B:** If Gate 4 requires a fully precise merged order, prepare a separately scoped additive read-contract change. At minimum audit/expose Resolution `createdAtMicros` and Run `completedAtMicros` in the actual chronology-bearing DTOs, plus any detail key required by direct reads. Update the existing validators and targeted pagination tests. No Dossier table or database migration follows from this gap. A completion-ordered endpoint is a different requirement and is unnecessary unless the product needs an exhaustive “latest completions” feed.

**Decision status: OPEN_DECISION.** This task documents the gap and recommends D01-A; it does not silently replace #55's precision requirement with an approximate total order. Task 2 must start from a recorded D01 choice. It must not invent missing fields or implement D01-B under a frontend-only task.

## 8. Sources, citations, and provenance

Use the label “来源与对象引用” for the v0.1 capability. “Stable citation” here means a grounded identifier and provenance, not guaranteed public access or a persisted historical export.

### 8.1 Permitted reference construction

| Available evidence | Permitted output | Not supported |
|---|---|---|
| Project/Issue IDs | Existing Project/Issue navigation; current Dossier route only once implemented | A public permanent content snapshot |
| Resolution ID from its scoped reader | Dossier-local detail selection or a verified existing control | An invented standalone `/resolutions/:id` page |
| Run ID from its scoped reader | Dossier-local read-only detail selection | An invented standalone Run permalink |
| Visible A/R manifest | Manifest ID, exact server SHA, item count, and authorized typed target IDs | Full source text or bibliographic details absent from the response |
| Run manifest | ID, SHA, count, and permitted role/type/note fields | Target IDs recovered from a same-ID/hash A/R manifest |
| Evidence candidate metadata after current scope check | Material title, binding mapping, Source/Asset type, or Note revision number actually returned | An old Run's historical material title/content, raw storage paths, source URLs not supplied |
| Verified NoteRevision mapping and successful existing revision read | Exact revision identity and supported existing Project navigation | Replacing the old revision with its latest version |
| Missing locator/excerpt | Omit or label “未提供定位/摘录” | Invented page numbers, coordinates, quotations, or image regions |

The current router supports `/books/:id`, `/research/projects`, `/research/projects/:projectId`, and `/research/projects/:projectId/issues/:issueId`. Existing Assessment/Resolution/Run details are controls/components rather than independently registered routes. The Dossier may add local section anchors as a new UI proposal, but must not describe them as existing stable external links.

### 8.2 What the fingerprint proves

F hashes the canonical evidence selection and item annotations, including target identity. The hash is not a file-byte checksum, a webpage/text snapshot hash, a measure of truth, or an independent source count.

Run redaction removes fields that participate in hashing; the browser cannot recompute that original manifest hash from the Run root snapshot alone. Show it as a server-validated manifest fingerprint.

Neither matching hashes nor matching IDs upgrade one endpoint's disclosure contract. Origin remains part of the derived reference model.

## 9. Read-only page and loading architecture

Everything in this section is a proposed Task 2/3 design, not implemented baseline behavior.

### 9.1 Route and authentication

Add the proposed Dossier route using the existing Google-session boundary and account panel. A minimal integration is an explicit read-view mode on `ProjectsPage`, or a small shared authenticated shell if extraction is clearly simpler; do not build a second login flow.

The private Dossier subtree is keyed by Project/Issue and mounted only while authenticated. It must be removed immediately on sign-out/session invalidation.

Existing W `request` already checks authenticated state before sending, uses `credentials:"same-origin"` and `cache:"no-store"`, and accepts `AbortSignal`. CSRF treatment stays in the shared client/server; Dossier domain reads are GETs. Do not resurrect `useS32Token` or a browser bearer-token prompt.

The shared client does not prove every successful response still belongs to the current auth generation. A Dossier loader must do that before accepting results.

### 9.2 Minimal request plan

1. Read `getResearchIssue(P,I)` first. Validate route/response identity and readable scope.
2. Start three independent initial reads with a maximum concurrency of four: Claims, first Resolution page (also supplies Current), and first Run page.
3. Reuse that Resolution response for Current and History. Do not perform a redundant Current-only request merely to obtain the same pointer.
4. Load evidence-bases when the Evidence/Assessment overview is requested. Load full Current rationale or a selected record detail on demand.
5. Load per-Claim Assessment history only when opened. No eager one-request-per-Claim, per-Resolution, per-Run, or per-ancestor detail fanout.
6. Fetch one selected Run detail to get its full allowed root snapshot and ancestors; do not call every ancestor detail.
7. Deduplicate same-scope requests by typed resource ID and generation. Keep concurrency bounded at four; queue only explicit user-requested pages/details. No automatic drain-to-exhaustion loop.

With no expanded detail, the initial private domain workload is one scope read followed by three reads. A whole-Issue visible evidence overview costs one further read when requested. Initial request count does not grow with Claim count.

The evidence-bases endpoint is reused as a read-only available-basis index, not invoked to select/create a Resolution or a Run.

### 9.3 Cancellation and scope validation

Maintain a scope key `P:I:authGeneration` plus a monotonically increasing request generation. Each initial, retry, pagination, and detail request belongs to that scope and an abort controller.

`authGeneration` is a proposed in-memory mount/session-transition counter, not an existing field returned by the session API. Do not use session email/name as a stable principal identifier. Serialize pointer reconciliation and reject an older Current-affecting request after a newer one supersedes it; arrival order alone does not establish which database snapshot is newer.

On route change, sign-out, unmount, or a full refresh:

- abort every outstanding request, including queued, older-page, retry, and detail requests;
- discard old private payloads and selected target references;
- accept a response only if its scope/generation is still active and its signal is not aborted.

Where DTOs expose IDs, validate them against the requested IDs, not just against one another. In particular W's `getResearchRun` validates Project/Issue consistency but does not compare the requested Run ID to `run.runId`; the new loader must check that identity explicitly. Also verify requested Assessment/Resolution IDs and returned Claim/Issue context.

Claims/list payloads without a Project/Issue field cannot provide additional self-identification; bind them to the actual request context and rely on the existing server scope checks. Do not invent response fields to fill that gap.

Use cancellation plus acceptance guards. Aborting only the first effect request does not cover a later retry or “load more” request.

### 9.4 States and user text

| State | Meaning | Example text/behavior |
|---|---|---|
| not requested | Section not opened yet | “展开以读取”; no zero count |
| loading | Active read has not settled | Scoped status message; no stale prior-Issue content |
| ready, empty | Successful read, currently visible zero rows | “暂无可见评价” / “还没有研究轮次” as appropriate |
| ready, partial | Some pages loaded; more exist or another stream has not been read | Loaded count and a section-specific “加载更多” |
| unavailable object/evidence | Specific neutral 404 or explicit source availability result | Source-specific text; no fabricated cause |
| section error | Network/500/502/503 or malformed success | Keep safe accepted sections; retry only failed section |
| missing root scope | Project/Issue 404 | “研究问题不存在，或不属于当前项目”; clear all child data |
| auth loss | 401/403 or session leaves authenticated state | Clear private subtree and return to shared account/login flow |
| aborted/stale result | Superseded request | Ignore; never render as an error or a new result |

A malformed successful payload remains a client 502. A server integrity 500 is an error, not evidence-unavailable or empty. Never display raw SQL/internal error messages.

Use headings and navigation usable on a 390px-wide viewport. Long IDs/hashes wrap. Native buttons control sections and pagination; keyboard focus remains usable after loading more, opening/closing a detail, and retrying. Do not mount write-capable composers or terminal actions in a nominally read-only Dossier.

## 10. Fit-gap decisions

| Capability | Existing API fit | Gate 4 treatment |
|---|---|---|
| Question and same-Project/Issue scope | YES | Reuse existing Issue reader plus route identity checks |
| Authoritative Current independent of history page | YES, through Resolution reader | Correct the misleading assumption that `getResearchIssue` exposes the pointer |
| Claims and visible Assessments | YES, with per-Claim detail/history | Use issue-wide evidence-bases for overview and lazy per-Claim reads |
| Evidence with revocation-aware disclosure | YES, different per source | Preserve section 5 contracts; no universal manifest DTO |
| Run lifecycle history and replay ancestry | YES | Read only; no new lifecycle commands |
| Precise merged microsecond event order | NO | D01 open; recommend honest source streams/ambiguous groups |
| Full “latest completed Runs” coverage from a start-ordered first page | NO | Explicit loaded-record coverage; no such completeness claim |
| Entire Dossier as one atomic database snapshot | NO | Per-reader read window; no snapshot persistence claim |
| Produced-object loss represented as per-item unavailable while every Run detail succeeds | NO | Preserve actual 404/500; separate future backend change if needed |
| Full citations / page-level locators / source file hashes | NO | Grounded object references only; unsupported fields omitted |
| Historical source content reconstruction from manifest alone | NO | Never call a manifest a saved copy of all source content |
| Spatial panel and export | NO verified inputs / intentionally deferred | Defer; no new schema |

**No new endpoint is required for the recommended first useful dossier.** The exact chronology requirement remains an explicit review decision. If D01-B is selected, the minimal candidate is extension of existing read fields and validators, not automatic creation of an aggregation endpoint or a new domain model.

## 11. Implementation handoff

### Task 2 — pure model and safe composition

Proposed task ID: `S32_M3A_GATE4_TASK2_DOSSIER_VIEW_MODEL_AND_TESTS_R1`.

Prerequisites: review this exact document commit, record D01-A or D01-B, and verify that the implementation base includes the same source contracts. This document does not start Task 2.

Proposed new files, to confirm at Task 2 start:

- `apps/web/src/research/dossier-model.ts` — typed source adapters, Current derivation, evidence disclosure, event/coverage model, grounded references.
- `apps/web/src/research/dossier-model.test.ts` — model invariants and adversarial payload combinations.

Task 2 accepts explicit, already-read source responses and coverage/scope state. It does not perform fetches, add a React hook, or implement an effectful request loader. It defines the pure acceptance/identity rules and the interfaces Task 3 will use. Do not alter source DTOs simply to make a single generic interface convenient.

RED→GREEN should prove a real failure mode before implementing each behavior. Do not execute those tests in Task 1, install dependencies just for this document, or broaden into unrelated baseline failures.

Task 2 stops with its source and relevant test evidence. It does not add the UI, create a PR, merge, migrate, or deploy. If D01-B is selected, reconcile its separate backend contract scope before changing API files.

### Task 3 — UI and navigation

Proposed components:

- `dossier-reader.ts` / `dossier-reader.test.ts` — existing-reader orchestration, bounded queue, and controlled promise-race tests for scope/auth/record identity; a small `useResearchDossier.ts` hook may own the React lifecycle.
- `ResearchDossierPage.tsx` — read-only composition and per-section states.
- Small Dossier-only sections for evidence, references, and What Changed where useful.
- `App.tsx` — register the proposed Dossier route.
- `ProjectsPage.tsx` — use the existing authenticated shell/read-view selection.
- `ResearchIssueDetail.tsx` — add “研究档案” navigation.
- `research.css` — only needed Dossier wrapping/layout rules.

Reuse existing display components only if their read behavior and controls fit this contract. Existing Run history/detail components include lifecycle integrations; importing them wholesale must not reintroduce write controls.

### Task 4 — real-browser acceptance

Use disposable non-production PostgreSQL 16 and deterministic fixtures to prove the completed Dossier. Production's zero-Run condition is a legitimate baseline, not a reason to insert fake production data.

The browser must exercise the real route, auth boundary, API responses, and visible results. It must cover both a populated dossier and empty states. Retain concise evidence sufficient to distinguish implemented, tested, committed, and deployed.

Reuse the existing isolated acceptance harness and configured test-owner session fixture with the real session middleware. Do not replace domain authorization with a browser bearer token or a bypassing auth mock. This does not require repeating external Google account login in Task 4, and it does not claim a new production Google-login verification.

Gate 5 remains whole-slice acceptance and the later PR/release decision. Task 1 never authorizes that transition.

## 12. Acceptance matrix for subsequent work

These are required future checks, not tests claimed as executed by this document.

| ID | Scenario | Observable acceptance |
|---|---|---|
| D-01 | No current Resolution, no Claims, no Runs | Distinct legitimate empty states; no synthetic Current or output |
| D-02 | Explicit NO_WORKING_CONCLUSION / INSUFFICIENT_EVIDENCE | Render recorded types rather than treating them as absent data |
| D-03 | Current record outside the loaded history page | Correct independent Current; no `resolutions[0]` fallback |
| D-04 | Current pointer changes while detail is pending | Old detail cannot regain CURRENT; bounded reconciliation |
| D-05 | New Run/Assessment arrives after Current | Current unchanged unless authoritative pointer changes |
| D-06 | Multiple pages with equal displayed timestamps | Preserve server cursor and source order; no duplicates or fabricated microseconds |
| D-07 | Cross-stream same-millisecond events | D01's accepted ambiguity/precision policy; no false before/after assertion |
| D-08 | Old Run completes after newer Runs started | Loaded-record coverage stays honest; no “all recent changes” claim |
| D-09 | RUNNING vs terminal; replay ancestry | No terminal event for RUNNING; ancestry is not full Issue history |
| D-10 | Assessment evidence loses visibility | Row/detail follows filtered/404 contract; no stale reasoning/items restored |
| D-11 | Resolution has absent or unavailable evidence | Conclusion retained; false/null with no remembered manifest fields |
| D-12 | Run compact vs root snapshot | Four-key list/ancestor; five-key available root; no targetId reconstruction |
| D-13 | Produced Assessment has no Claim mapping; mapping is later loaded; target is 404 or 503 | Use only authorized A-to-C mapping, distinguish unresolved/unavailable/error, and never guess or perform eager Claim scans; actual Run detail 500 remains error |
| D-14 | Historical NoteRevision | Exact old revision remains referenced; never replaced by current revision |
| D-15 | Cross-Project Issue and foreign detail ID | Neutral 404/scope failure; no payload from another scope |
| D-16 | Well-shaped wrong requested record ID | Loader rejects identity mismatch even when upstream structural validation passes |
| D-17 | Malformed success / 500 / 503 / network error | Error, not zero data; unaffected sections stay usable |
| D-18 | Scope switch during initial, retry, more, or detail read | Every stale result ignored; no previous-Issue data flash |
| D-19 | Logout/session loss with in-flight reads | Private subtree cleared immediately; no later response repopulates it |
| D-20 | Archived Project/Issue | Authorized history readable; no Dossier write controls or mutation calls |
| D-21 | Missing locator/source metadata | No invented links, source title, page, coordinates, quotation, or file checksum |
| D-22 | Many Claims / repeated details | Bounded concurrency, no eager N+1 fanout, one active cursor request per stream |
| D-23 | 390px mobile and keyboard | No page-level overflow; wrapping IDs/hashes; operable controls and focus |
| D-24 | Dossier interaction inventory | Domain traffic limited to existing GET reads; login/logout stay shared auth behavior |

## 13. Task 1 review and handoff receipt

The deliverable is this exact documentation file. Source analysis and document consistency review do not constitute a feature acceptance run.

~~~text
TASK_ID=S32_M3A_GATE4_TASK1_DOSSIER_DERIVED_READ_CONTRACT_R1
BASE_MAIN_HEAD=42cf1b7b4a10a6edfa53d688012728dded0b3049
SOURCE_OF_TRUTH_MATRIX=SOURCE_AUDITED
CURRENT_RESOLUTION_POINTER=RESOLUTION_READER_AUTHORITY_CONFIRMED
WHAT_CHANGED_DERIVATION=FACTUAL_EVENTS_DEFINED_D01_OPEN
EVIDENCE_PRIVACY=THREE_SOURCE_CONTRACTS_AUDITED
SOURCE_CITATIONS=GROUNDED_OBJECT_REFERENCES_ONLY
PAGINATION_PRECISION=PER_STREAM_PRESERVED_CROSS_STREAM_GAP_RECORDED
EMPTY_ERROR_READONLY=DEFINED
API_FIT_GAP=EXISTING_READS_USABLE_PRECISE_MERGED_ORDER_UNSUPPORTED
ARCHIVED_SCOPE=READABLE_SUBJECT_TO_EXISTING_AUTHORIZATION
API_CHANGED=NO
WEB_CHANGED=NO
DB_CHANGED=NO
DEPLOY_CHANGED=NO
PRODUCTION_CHANGED=NO
FEATURE_IMPLEMENTATION_STARTED=NO
TASK2_STARTED=NO
STATUS=TASK1_CONTRACT_AUDIT_COMPLETE_REVIEWABLE_D01_OPEN
NEXT_ACTION=REVIEW_D01_THEN_S32_M3A_GATE4_TASK2_DOSSIER_VIEW_MODEL_AND_TESTS_R1
~~~

Record the actual documentation commit, remote branch SHA, diff check, and document-review result in the existing Notion phase page after verification. Do not put invented future hashes or passing test counts into this file.

**STOP after Task 1.** Preserve the open decision visibly. No PR, merge, production work, or automatic Task 2 follows from this receipt.
