# S32 M2-D Assessment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add durable, append-only Claim Assessments that atomically freeze the currently previewed evidence set, expose privacy-safe Project-scoped history/detail reads, and integrate create/history/detail flows into each Candidate Claim card.

**Architecture:** Use the approved CQRS-lite split. The command path runs one SERIALIZABLE transaction for idempotency, scope/evidence revalidation, Manifest+Items+Assessment insert, canonical read-back, and receipt completion. The read path runs REPEATABLE READ, READ ONLY; it derives the current Project evidence authorization graph, filters visibility before keyset pagination, validates every visible frozen Manifest/hash, and returns summary or detail DTOs. M2-C and M2-D share the same Project evidence authorization module and the same 1..100 evidence-item bound.

**Tech Stack:** TypeScript 5.9, Node.js, Express 5, PostgreSQL 16 / `pg`, React 19, Vite 7, Vitest 4, Testing Library, pnpm 10.

**Spec:** `docs/superpowers/specs/2026-09-21-s32-m2d-assessment-design.md` at approved reviewed head `6ea4e381ffbb7590d0c028793db82adb2c0598b7`.

## Global Constraints

- Begin execution from the then-current `main`; source design baseline was `59476a97739c13ed039ab315cad8e29c85acf94a`. If `main` has advanced, reconcile the approved docs onto a fresh implementation branch rather than implementing against a stale code base.
- Before touching product code, use `superpowers:using-git-worktrees` and create an isolated implementation worktree/feature branch. One writer per worktree.
- Strict TDD: every production change follows RED → GREEN before refactor/commit.
- Frozen SQL must remain byte-for-byte unchanged:
  - `db/migrations/001_s32_core_schema.sql`
  - `db/tests/001_s32_schema_assertions.sql`
  - `db/tests/002_s32_negative_invariants.sql`
- No schema/table/column/FK/index/trigger changes.
- No production/Tencent writes or deployment.
- M2-E Issue Resolution, AI Assessment, Actor management, ResearchRun, Outbox events, and automation side effects are out of scope.
- New M2-D writes: Project `ACTIVE`; Issue `OPEN|RESOLVED`; Claim `ACTIVE|ARCHIVED`.
- Reads: Project `ACTIVE|ARCHIVED`; Issue `OPEN|RESOLVED|ARCHIVED`; Claim `ACTIVE|ARCHIVED`.
- M2-D v1 create fields: `actor_id=NULL`, `numeric_score=NULL`, `score_kind=NULL`, required normalized reasoning 1..8000 Unicode code points, evidence Manifest required.
- Evidence draft/Manifest item count is exactly 1..100. M2-C preview and M2-D create use the same constant/normalizer.
- Manifest v1: `schema_version=1`, `purpose=CLAIM_ASSESSMENT`, `metadata={}`, `locator_type/locator/excerpt=NULL`.
- `manifest_sha256` is an integrity fingerprint only; no dedupe by hash.
- New Assessment/Manifest/Item IDs use `crypto.randomUUID()`, generated once per command and reused across internal retries.
- Command store transaction isolation: SERIALIZABLE; retry only SQLSTATE `40001` and `40P01`; at most 3 total transaction attempts.
- Read store isolation: `REPEATABLE READ, READ ONLY`.
- Completed idempotency replay is not a new write and is evaluated before current write-lifecycle gates.
- No partial Assessment redaction. If any frozen item cannot be authorized through the current Project, the entire Assessment is hidden.
- Visibility must be proven before full hidden-object integrity inspection. Unsupported/malformed hidden `target_type` is omitted/safe-404, not an existence-leaking 500.
- Visible records use strict Manifest v1 integrity validation and recompute the canonical SHA on every history/detail read.
- History ordering is `created_at DESC, id DESC`; keyset pagination default 20, max 50; no total/hidden count.
- All private M2-D endpoints set `Cache-Control: no-store`.
- Never optimistically append an Assessment in the browser; canonical history ordering comes from server GET.
- A POST success remains success even if the subsequent history refresh fails.
- Historical test output cannot be presented as fresh M2-D verification.

## File Structure

### API / domain

- Modify `apps/api/src/s32/domain/evidence-selection.ts` — shared evidence item-count constant and normalization.
- Modify `apps/api/src/s32/domain/evidence-selection.test.ts` — 1/100/101 boundary regression.
- Create `apps/api/src/s32/domain/assessment.ts` — Assessment normalization, request hashing, cursor/limit parsing, DTO domain types.
- Create `apps/api/src/s32/domain/assessment.test.ts`.

### API / application

- Create `apps/api/src/s32/application/assessments.ts` — command/read service interfaces, errors, ID generation once per command.
- Create `apps/api/src/s32/application/assessments.test.ts`.

### API / PostgreSQL

- Create `apps/api/src/s32/postgres/project-evidence-authorization.ts` — extracted canonical Project scope/material graph + candidate/index/old-revision authorization shared by M2-C and M2-D.
- Create `apps/api/src/s32/postgres/project-evidence-authorization.test.ts`.
- Modify `apps/api/src/s32/postgres/evidence-selection-store.ts` — delegate shared graph/authorization; preserve M2-C semantics.
- Modify `apps/api/src/s32/postgres/evidence-selection-store.test.ts`.
- Modify `apps/api/src/s32/postgres/evidence-selection-store.integration.test.ts`.
- Create `apps/api/src/s32/postgres/assessment-command-store.ts` — SERIALIZABLE create/replay path.
- Create `apps/api/src/s32/postgres/assessment-command-store.test.ts`.
- Create `apps/api/src/s32/postgres/assessment-read-store.ts` — privacy-safe history/detail, keyset pagination, compatible Assessment read + strict Manifest validation.
- Create `apps/api/src/s32/postgres/assessment-read-store.test.ts`.
- Create `apps/api/src/s32/postgres/assessment-store.integration.test.ts`.

### API / HTTP wiring

- Create `apps/api/src/s32/routes/assessment-routes.ts`.
- Create `apps/api/src/s32/routes/assessment-routes.test.ts`.
- Modify `apps/api/src/s32/register.ts`.
- Modify `apps/api/src/s32/routes/register.test.ts`.

### Web client / state

- Modify `apps/web/src/research/api.ts` — Assessment DTO validators/client methods/error messages.
- Create `apps/web/src/research/assessment-api.test.ts`.
- Create `apps/web/src/research/assessment-draft.ts` — normalized committed-intent receipt in sessionStorage.
- Create `apps/web/src/research/assessment-draft.test.ts`.
- Modify `apps/web/src/research/EvidenceEditor.tsx` — expose current preview handoff; enforce selected-item max in UI.
- Modify `apps/web/src/research/EvidenceEditor.test.tsx`.
- Create `apps/web/src/research/AssessmentComposer.tsx`.
- Create `apps/web/src/research/AssessmentComposer.test.tsx`.
- Create `apps/web/src/research/AssessmentHistory.tsx`.
- Create `apps/web/src/research/AssessmentHistory.test.tsx`.
- Create `apps/web/src/research/AssessmentDetail.tsx`.
- Create `apps/web/src/research/AssessmentDetail.test.tsx`.
- Modify `apps/web/src/research/CandidateClaims.tsx`.
- Modify `apps/web/src/research/CandidateClaims.test.tsx`.
- Modify `apps/web/src/research/research.css`.

### Integration / verification

- Create `scripts/s32-m2d-integration-check.ts`.
- Modify `package.json` — add `s32:m2d:check`.
- Modify `docs/STATUS.md` and `AGENTS.md` only after fresh final verification, recording exact tested head and honest counts.

## Review Focus

1. **Concurrent or abnormal idempotency receipts:** same-key concurrent create must produce one resource; durable `IN_PROGRESS`/`FAILED` or malformed `COMPLETED` must never trigger a blind duplicate write. Pinned in Task 3 command-store tests.
2. **Privacy when the hidden Manifest is corrupt:** foreign/missing/unsupported-target lineage must stay omitted/safe-404; corruption only becomes 500 after current visibility is independently established. Pinned in Task 4 read-store adversarial tests.
3. **Visibility drift between history and detail:** a summary may be visible at history-load time and become invisible before detail; detail must return safe 404 and the UI must refresh history without saying “permission revoked”. Pinned in Tasks 4 and 10.
4. **Future schema-valid Assessment fields:** non-null Actor/score and null reasoning must remain readable when the Manifest is visible; manifestless rows remain hidden rather than 500. Pinned in Task 4 and Task 6 response validators.
5. **Receipt storage failure / result ambiguity:** sessionStorage failure must preserve same-page in-memory retry identity; explicit 503 and transport-unknown both retry the same command/key, while known 400/404/409 failures clear or invalidate the receipt according to the spec. Pinned in Tasks 7 and 9.

---

### Task 1: Share Project Evidence Authorization and Enforce the 1..100 Draft Bound

**Files:**
- Modify: `apps/api/src/s32/domain/evidence-selection.ts`
- Modify: `apps/api/src/s32/domain/evidence-selection.test.ts`
- Create: `apps/api/src/s32/postgres/project-evidence-authorization.ts`
- Create: `apps/api/src/s32/postgres/project-evidence-authorization.test.ts`
- Modify: `apps/api/src/s32/postgres/evidence-selection-store.ts`
- Modify: `apps/api/src/s32/postgres/evidence-selection-store.test.ts`
- Modify: `apps/api/src/s32/postgres/evidence-selection-store.integration.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const EVIDENCE_MANIFEST_ITEMS_MAX = 100;

  export interface ProjectClaimScope {
    projectId: string;
    projectLifecycleState: "ACTIVE" | "ARCHIVED";
    issueId: string;
    issueLifecycleState: "OPEN" | "RESOLVED" | "ARCHIVED";
    claim: EvidenceClaimContext;
  }

  export interface ProjectEvidenceAuthorization {
    groups: ProjectMaterialGroup[];
    sourceIds: ReadonlySet<string>;
    sourceAssetIds: ReadonlySet<string>;
    noteIds: ReadonlySet<string>;
    currentRevisionNoteByRevision: ReadonlyMap<string, string>;
  }

  export async function loadProjectClaimScope(
    client: PoolClient,
    projectId: string,
    issueId: string,
    claimId: string,
    options?: { lock?: boolean },
  ): Promise<ProjectClaimScope | null>;

  export async function loadProjectEvidenceAuthorization(
    client: PoolClient,
    projectId: string,
  ): Promise<ProjectEvidenceAuthorization>;

  export async function authorizeEvidenceItems(
    client: PoolClient,
    auth: ProjectEvidenceAuthorization,
    items: ReadonlyArray<EvidenceDraftInputItem>,
  ): Promise<void>;

  export function evidenceCandidatesFromAuthorization(
    auth: ProjectEvidenceAuthorization,
  ): EvidenceCandidate[];
  ```
- M2-C `evidence-selection-store.ts` consumes those helpers unchanged semantically.
- Later command/read stores consume the same helpers; no second material-graph implementation is allowed.

- [ ] **Step 1: Add RED tests for shared item-count boundaries**

In `domain/evidence-selection.test.ts`, add:

```ts
import {
  EVIDENCE_MANIFEST_ITEMS_MAX,
  normalizeEvidencePreviewInput,
} from "./evidence-selection";

const item = {
  role: "SUPPORTING",
  targetType: "SOURCE",
  targetId: "11111111-1111-4111-8111-111111111111",
  note: null,
};

it("accepts exactly 100 evidence items and rejects 101", () => {
  const hundred = Array.from({ length: 100 }, (_, n) => ({
    ...item,
    targetId: `\${n.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`,
  }));
  expect(EVIDENCE_MANIFEST_ITEMS_MAX).toBe(100);
  expect(normalizeEvidencePreviewInput({ items: hundred })).toHaveLength(100);
  expect(() =>
    normalizeEvidencePreviewInput({
      items: [...hundred, { ...item, targetId: "ffffffff-1111-4111-8111-111111111111" }],
    }),
  ).toThrow("证据草稿最多");
});
```

Also retain the existing empty-draft rejection.

- [ ] **Step 2: Run the domain test and verify RED**

Run:

```bash
pnpm vitest run apps/api/src/s32/domain/evidence-selection.test.ts
```

Expected: FAIL because `EVIDENCE_MANIFEST_ITEMS_MAX` does not exist and/or 101 items are currently accepted.

- [ ] **Step 3: Implement the shared max constant and enforce it**

In `domain/evidence-selection.ts`:

```ts
export const EVIDENCE_MANIFEST_ITEMS_MIN = 1;
export const EVIDENCE_MANIFEST_ITEMS_MAX = 100;

const items = (value as Record<string, unknown>).items;
if (!Array.isArray(items) || items.length < EVIDENCE_MANIFEST_ITEMS_MIN) {
  throw new InvalidEvidenceDraftError("证据草稿不能为空。");
}
if (items.length > EVIDENCE_MANIFEST_ITEMS_MAX) {
  throw new InvalidEvidenceDraftError("证据草稿最多包含 100 条证据。");
}
```

Do not change hashing/canonical serialization.

- [ ] **Step 4: Add RED extraction tests for Project evidence authorization**

Create `project-evidence-authorization.test.ts` using the existing mocked-`PoolClient` patterns from `evidence-selection-store.test.ts`. Pin:

```ts
it("builds one authorization index shared by candidate and item authorization", async () => {
  const auth = await loadProjectEvidenceAuthorization(client, PROJECT);
  expect(auth.sourceIds.has(SOURCE)).toBe(true);
  expect(auth.sourceAssetIds.has(ASSET)).toBe(true);
  expect(auth.noteIds.has(NOTE)).toBe(true);
});

it("authorizes an old immutable revision only when it belongs to an authorized Note", async () => {
  const auth = await loadProjectEvidenceAuthorization(client, PROJECT);
  await expect(authorizeEvidenceItems(client, auth, [{
    role: "SUPPORTING",
    targetType: "NOTE_REVISION",
    targetId: OLD_REVISION,
    note: null,
  }])).resolves.toBeUndefined();
});
```

Also carry forward existing canonical corruption cases: malformed `sourceId`, mismatched Source edition, invalid Note subject metadata, noncanonical old revision.

- [ ] **Step 5: Run extraction tests and verify RED**

Run:

```bash
pnpm vitest run \
  apps/api/src/s32/postgres/project-evidence-authorization.test.ts \
  apps/api/src/s32/postgres/evidence-selection-store.test.ts
```

Expected: FAIL because the shared module does not exist.

- [ ] **Step 6: Extract the shared module and delegate M2-C to it**

Move, without semantic change, the current `loadScope`, material graph parsing/validation, graph indexing, old-revision bounded query, and candidate mapping into `project-evidence-authorization.ts`.

Keep error conversion explicit: the shared module should throw M2-C/M2-D neutral internal authorization/integrity errors or accept error constructors as dependencies; do **not** make M2-D depend on `EvidenceSelectionIntegrityError` names. A concrete pattern is:

```ts
export class ProjectEvidenceIntegrityError extends Error {}
export class ProjectEvidenceTargetUnavailableError extends Error {}
```

Then map them at M2-C/M2-D store boundaries.

Update `evidence-selection-store.ts` to:

```ts
const scope = await loadProjectClaimScope(client, input.projectId, input.issueId, input.claimId);
if (!scope) return null;
const auth = await loadProjectEvidenceAuthorization(client, input.projectId);
await authorizeEvidenceItems(client, auth, input.items);
```

and candidates to `evidenceCandidatesFromAuthorization(auth)`.

- [ ] **Step 7: Run M2-C focused + real-PG regression**

Run:

```bash
pnpm vitest run \
  apps/api/src/s32/domain/evidence-selection.test.ts \
  apps/api/src/s32/postgres/project-evidence-authorization.test.ts \
  apps/api/src/s32/postgres/evidence-selection-store.test.ts \
  apps/api/src/s32/application/evidence-selection.test.ts \
  apps/api/src/s32/routes/evidence-selection-routes.test.ts
pnpm s32:m2c:check
```

Expected: PASS; real PG runner still prints `S32_M2C_REAL_PG=PASS` and disposable container removal confirmation.

- [ ] **Step 8: Commit**

```bash
git add \
  apps/api/src/s32/domain/evidence-selection.ts \
  apps/api/src/s32/domain/evidence-selection.test.ts \
  apps/api/src/s32/postgres/project-evidence-authorization.ts \
  apps/api/src/s32/postgres/project-evidence-authorization.test.ts \
  apps/api/src/s32/postgres/evidence-selection-store.ts \
  apps/api/src/s32/postgres/evidence-selection-store.test.ts \
  apps/api/src/s32/postgres/evidence-selection-store.integration.test.ts
git commit -m "refactor(s32): share evidence authorization for assessments"
```

---

### Task 2: Add Assessment Domain and Application Contracts

**Files:**
- Create: `apps/api/src/s32/domain/assessment.ts`
- Create: `apps/api/src/s32/domain/assessment.test.ts`
- Create: `apps/api/src/s32/application/assessments.ts`
- Create: `apps/api/src/s32/application/assessments.test.ts`

**Interfaces:**
- Consumes: `EvidenceDraftInputItem`, `normalizeEvidencePreviewInput`, `buildEvidenceManifestDraft`, project/issue/claim ID readers.
- Produces:

```ts
export type AssessmentStance = "SUPPORTS" | "CONTRADICTS" | "INCONCLUSIVE";
export type AssessmentConfidenceLevel = "LOW" | "MEDIUM" | "HIGH";

export interface NormalizedAssessmentInput {
  stance: AssessmentStance;
  confidenceLevel: AssessmentConfidenceLevel | null;
  reasoning: string;
  expectedManifestSha256: string;
  items: EvidenceDraftInputItem[];
}

export function normalizeAssessmentCreateInput(value: unknown): NormalizedAssessmentInput;
export function hashAssessmentCreateRequest(
  projectId: string,
  issueId: string,
  claimId: string,
  input: NormalizedAssessmentInput,
): string;

export interface AssessmentSummary { /* spec fields */ }
export interface AssessmentDetail { /* spec full Assessment + Manifest */ }

export interface AssessmentCursor {
  createdAt: string;
  id: string;
}
export function readAssessmentHistoryQuery(value: unknown): {
  limit: number;
  cursor: AssessmentCursor | null;
};
export function encodeAssessmentCursor(cursor: AssessmentCursor): string;
```

Application produces:

```ts
export interface AssessmentCommandStore {
  create(input: AssessmentCreateCommand): Promise<AssessmentCreateResult>;
}

export interface AssessmentReadStore {
  list(input: AssessmentListCommand): Promise<AssessmentHistoryResponse | null>;
  get(input: AssessmentGetCommand): Promise<AssessmentDetailResponse | null>;
}

export function createAssessmentsService(
  commandStore: AssessmentCommandStore,
  readStore: AssessmentReadStore,
): {
  create(project: unknown, issue: unknown, claim: unknown, key: unknown, body: unknown): Promise<AssessmentCreateResult>;
  list(project: unknown, issue: unknown, claim: unknown, query: unknown): Promise<AssessmentHistoryResponse | null>;
  get(project: unknown, issue: unknown, claim: unknown, assessment: unknown): Promise<AssessmentDetailResponse | null>;
};
```

- [ ] **Step 1: Write RED domain tests**

Create `assessment.test.ts` with:

```ts
it.each(["SUPPORTS", "CONTRADICTS", "INCONCLUSIVE"])("accepts stance %s", stance => {
  expect(normalizeAssessmentCreateInput({
    stance,
    confidenceLevel: null,
    reasoning: "  第一行\r\n第二行  保持  ",
    expectedManifestSha256: "a".repeat(64),
    items: [ITEM],
  }).reasoning).toBe("第一行\n第二行  保持");
});

it("rejects NUL, empty, and >8000-code-point reasoning", () => {
  for (const reasoning of ["\0x", "   ", "甲".repeat(8001)]) {
    expect(() => normalizeAssessmentCreateInput({ ...BASE, reasoning })).toThrow();
  }
});

it("accepts 8000 code points exactly", () => {
  expect(normalizeAssessmentCreateInput({ ...BASE, reasoning: "甲".repeat(8000) }).reasoning)
    .toHaveLength(8000);
});

it("rejects unknown top-level fields", () => {
  expect(() => normalizeAssessmentCreateInput({ ...BASE, actorId: "11111111-1111-4111-8111-111111111111" }))
    .toThrow();
});

it("hash changes for judgment or evidence changes but canonical whitespace/UUID casing normalizes", () => {
  const a = normalizeAssessmentCreateInput(BASE);
  const b = normalizeAssessmentCreateInput({ ...BASE, stance: "CONTRADICTS" });
  expect(hashAssessmentCreateRequest(P, I, C, a)).not.toBe(hashAssessmentCreateRequest(P, I, C, b));
});

it("cursor round-trips and rejects tampered/unsupported values", () => {
  const cursor = encodeAssessmentCursor({ createdAt: "2026-09-21T00:00:00.000Z", id: C });
  expect(readAssessmentHistoryQuery({ cursor, limit: "20" }).cursor?.id).toBe(C);
  expect(() => readAssessmentHistoryQuery({ cursor: cursor + "x" })).toThrow();
  expect(() => readAssessmentHistoryQuery({ limit: "51" })).toThrow();
});
```

- [ ] **Step 2: Run domain tests and verify RED**

```bash
pnpm vitest run apps/api/src/s32/domain/assessment.test.ts
```

Expected: FAIL because the module/functions do not exist.

- [ ] **Step 3: Implement the domain module**

Use strict top-level keys `stance,confidenceLevel,reasoning,expectedManifestSha256,items`. Reuse `normalizeEvidencePreviewInput({items})` so M2-C/M2-D item semantics cannot drift.

For cursor encoding, use versioned base64url JSON:

```ts
type CursorPayload = { v: 1; createdAt: string; id: string };
const raw = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
```

Decode only `v:1`, valid ISO timestamp, valid UUID.

Do not include Project/Claim labels in either Manifest hash or cursor.

- [ ] **Step 4: Write RED application-service tests**

In `application/assessments.test.ts`:

```ts
it("generates all canonical IDs once and passes one normalized command to the store", async () => {
  const commandStore = { create: vi.fn(async input => CREATED_RESULT) };
  const readStore = { list: vi.fn(), get: vi.fn() };
  const service = createAssessmentsService(commandStore, readStore);
  await service.create(P, I, C, KEY, BASE_BODY);
  const sent = vi.mocked(commandStore.create).mock.calls[0][0];
  expect(sent.assessmentId).toMatch(UUID_RE);
  expect(sent.manifestId).toMatch(UUID_RE);
  expect(sent.manifestItemIds).toHaveLength(1);
  expect(sent.requestHash).toMatch(/^[0-9a-f]{64}$/);
});

it("delegates history/detail with normalized IDs and parsed cursor/limit", async () => {
  // assert exact projectId/issueId/claimId/assessmentId and limit/cursor values
});
```

- [ ] **Step 5: Run application test and verify RED**

```bash
pnpm vitest run apps/api/src/s32/application/assessments.test.ts
```

Expected: FAIL because `createAssessmentsService` does not exist.

- [ ] **Step 6: Implement the application service and explicit error types**

Define errors used later by route/store layers:

```ts
export class AssessmentInvalidError extends Error {}
export class AssessmentScopeNotFoundError extends Error {}
export class AssessmentNotFoundError extends Error {}
export class AssessmentIntegrityError extends Error {}
export class AssessmentStoreUnavailableError extends Error {}
export class EvidencePreviewStaleError extends Error {}
export class ProjectReadOnlyForAssessmentError extends Error {}
export class ResearchIssueReadOnlyForAssessmentError extends Error {}
export class AssessmentIdempotencyConflictError extends Error {}
```

Generate `assessmentId`, `manifestId`, and all `manifestItemIds` with `randomUUID()` exactly once before calling `commandStore.create`.

- [ ] **Step 7: Run focused tests and commit**

```bash
pnpm vitest run \
  apps/api/src/s32/domain/assessment.test.ts \
  apps/api/src/s32/application/assessments.test.ts
git add \
  apps/api/src/s32/domain/assessment.ts \
  apps/api/src/s32/domain/assessment.test.ts \
  apps/api/src/s32/application/assessments.ts \
  apps/api/src/s32/application/assessments.test.ts
git commit -m "feat(s32): define assessment domain contracts"
```

---

### Task 3: Implement the SERIALIZABLE Assessment Command Store

**Files:**
- Create: `apps/api/src/s32/postgres/assessment-command-store.ts`
- Create: `apps/api/src/s32/postgres/assessment-command-store.test.ts`

**Interfaces:**
- Consumes: `AssessmentCommandStore`, normalized create command, shared Project scope/evidence authorization.
- Produces: `createPostgresAssessmentCommandStore(pool: Pool): AssessmentCommandStore`.
- Later route registration passes the same Pool to command/read/evidence stores.

- [ ] **Step 1: Write RED idempotency and lifecycle tests**

Use a scripted fake `Pool/PoolClient` like existing candidate-claim store tests. Pin:

```ts
it("creates one Manifest, N Items, Assessment, then completes receipt after canonical read-back", async () => {
  const result = await store.create(COMMAND);
  expect(result.status).toBe("created");
  expect(sql).toContain("BEGIN ISOLATION LEVEL SERIALIZABLE");
  expect(orderOf(sql, "INSERT INTO core.evidence_manifests"))
    .toBeLessThan(orderOf(sql, "INSERT INTO core.assessments"));
  expect(orderOf(sql, "SELECT")) // canonical read-back query after inserts
    .toBeLessThan(orderOf(sql, "status='COMPLETED'"));
});

it("replays the exact completed resource before current write-lifecycle gates", async () => {
  // receipt COMPLETED, Project now ARCHIVED
  const result = await store.create(COMMAND);
  expect(result.status).toBe("replayed");
  expect(result.assessment.id).toBe(ASSESSMENT_ID);
  expect(sql).not.toContain("INSERT INTO core.assessments");
});

it("same key with different request hash throws AssessmentIdempotencyConflictError", async () => {
  await expect(store.create(COMMAND)).rejects.toBeInstanceOf(AssessmentIdempotencyConflictError);
});

it.each([
  ["ARCHIVED", "OPEN", ProjectReadOnlyForAssessmentError],
  ["ACTIVE", "ARCHIVED", ResearchIssueReadOnlyForAssessmentError],
])("rejects new write lifecycle %s/%s", async (projectState, issueState, ErrorType) => {
  await expect(runWithStates(projectState, issueState)).rejects.toBeInstanceOf(ErrorType);
});
```

Also pin Claim ARCHIVED + Issue RESOLVED as allowed.

- [ ] **Step 2: Run command-store test and verify RED**

```bash
pnpm vitest run apps/api/src/s32/postgres/assessment-command-store.test.ts
```

Expected: FAIL because the command store does not exist.

- [ ] **Step 3: Implement transaction retry wrapper with stable input IDs**

Implement:

```ts
async function serializableWithRetry<T>(
  pool: Pool,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      // connect; BEGIN ISOLATION LEVEL SERIALIZABLE; run; COMMIT
    } catch (error) {
      // ROLLBACK
      if (!isRetryable(error) || attempt === 2) throw classify(error);
    } finally {
      // release
    }
  }
  throw new AssessmentStoreUnavailableError("ASSESSMENT_STORE_UNAVAILABLE");
}
```

Retry only `40001` / `40P01`. Network/store errors classify to 503 error; domain/integrity errors pass through.

The command input already contains stable IDs, so this wrapper must never call `randomUUID()`.

- [ ] **Step 4: Implement idempotency-first state machine**

Scope:

```ts
const scope =
  `S32:M2D:PROJECT_ISSUE_CLAIM_ASSESSMENT_CREATE:\${projectId}:\${issueId}:\${claimId}`;
```

Reserve with `INSERT ... ON CONFLICT DO NOTHING`.

Conflict path:
- lock/read existing receipt;
- request hash mismatch → `AssessmentIdempotencyConflictError`;
- `COMPLETED` must have `resource_type='ASSESSMENT'` and canonical resource ID;
- durable `IN_PROGRESS` or `FAILED` → `AssessmentStoreUnavailableError`;
- malformed completed receipt/resource → `AssessmentIntegrityError`.

Do not run new-write lifecycle gates for a canonical completed replay.

- [ ] **Step 5: Implement new-write scope locks and evidence confirmation**

Use shared helpers in deterministic order:
1. Project row `FOR UPDATE`;
2. ResearchIssue row `FOR UPDATE`;
3. exact `research_issue_claims` row `FOR UPDATE`;
4. Claim row `FOR UPDATE`.

Then:
- enforce Project ACTIVE;
- Issue OPEN|RESOLVED;
- Claim ACTIVE|ARCHIVED;
- load current Project evidence authorization;
- authorize all submitted items;
- build canonical Manifest with existing `buildEvidenceManifestDraft(items)`;
- compare server SHA to `expectedManifestSha256`;
- mismatch → `EvidencePreviewStaleError`.

- [ ] **Step 6: Implement atomic inserts, read-back, and final receipt completion**

Insert exact server-owned fields. Batch ManifestItems with parameterized SQL, preserving `manifestItemIds[index]` and `ordinal=index+1`.

After inserts, re-read Assessment + Manifest + ordered Items. Validate strict-v1 create invariants and call `buildEvidenceManifestDraft(readBackItems)`; require:

```ts
readBack.manifestSha256 === persistedManifest.manifestSha256
&& persistedManifest.manifestSha256 === input.expectedManifestSha256
```

Only then:

```sql
UPDATE ops.idempotency_keys
SET status='COMPLETED',
    resource_type='ASSESSMENT',
    resource_id=$2,
    result_payload=$3::jsonb,
    completed_at=now(),
    updated_at=now()
WHERE id=$1
```

with minimal `{assessmentId,manifestId}`.

- [ ] **Step 7: Add Review Focus tests for concurrency/abnormal receipts**

Add deterministic tests:

```ts
it.each(["IN_PROGRESS", "FAILED"])("never treats durable %s receipt as a fresh write", async status => {
  await expect(runWithReceipt({ status })).rejects.toBeInstanceOf(AssessmentStoreUnavailableError);
  expect(insertAssessmentCalls()).toBe(0);
});

it("malformed COMPLETED receipt/resource fails integrity and does not create", async () => {
  await expect(runWithReceipt({ status: "COMPLETED", resource_type: "CLAIM" }))
    .rejects.toBeInstanceOf(AssessmentIntegrityError);
  expect(insertAssessmentCalls()).toBe(0);
});

it("retries 40001 with the same IDs and succeeds on the second transaction", async () => {
  const result = await runWithFirstAttemptFailure("40001");
  expect(result.status).toBe("created");
  expect(seenAssessmentIds).toEqual([ASSESSMENT_ID, ASSESSMENT_ID]);
});
```

For the concurrent same-key semantic, use a deterministic fake unique-conflict/interleaving test here; real PG duplicate prevention is added in Task 11.

- [ ] **Step 8: Run command-store tests and commit**

```bash
pnpm vitest run \
  apps/api/src/s32/domain/assessment.test.ts \
  apps/api/src/s32/application/assessments.test.ts \
  apps/api/src/s32/postgres/project-evidence-authorization.test.ts \
  apps/api/src/s32/postgres/assessment-command-store.test.ts
git add \
  apps/api/src/s32/postgres/assessment-command-store.ts \
  apps/api/src/s32/postgres/assessment-command-store.test.ts
git commit -m "feat(s32): add atomic assessment command store"
```

---

### Task 4: Implement the Privacy-Safe Assessment Read Store

**Files:**
- Create: `apps/api/src/s32/postgres/assessment-read-store.ts`
- Create: `apps/api/src/s32/postgres/assessment-read-store.test.ts`

**Interfaces:**
- Consumes: shared Project scope/evidence authorization, Assessment domain cursor/DTO types.
- Produces: `createPostgresAssessmentReadStore(pool: Pool): AssessmentReadStore`.

- [ ] **Step 1: Write RED visibility matrix tests**

Create mocked-store tests for:
- authorized ACTIVE/ARCHIVED Source visible;
- authorized SourceAsset visible, foreign asset hidden;
- current NoteRevision visible;
- older immutable revision of the same authorized Note visible after current advances;
- foreign Note revision hidden;
- removed binding hides the entire Assessment;
- manifestless Assessment is hidden, not integrity failure.

Representative assertion:

```ts
it("hides the whole Assessment if any frozen item is not currently authorized", async () => {
  const result = await store.list({ projectId: P, issueId: I, claimId: C, limit: 20, cursor: null });
  expect(result?.assessments.map(x => x.id)).not.toContain(MIXED_VISIBILITY_ASSESSMENT);
});

it("manifestless Assessment is omitted from list and safe-404 in detail", async () => {
  expect((await store.list(LIST)).assessments).toEqual([]);
  expect(await store.get({ ...SCOPE, assessmentId: MANIFESTLESS })).toBeNull();
});
```

- [ ] **Step 2: Add RED privacy-ordering tests (Review Focus)**

```ts
it("does not leak hidden malformed target_type as an integrity 500", async () => {
  // Assessment is not independently visible and item target_type is unsupported.
  await expect(store.list(LIST)).resolves.toMatchObject({ assessments: [] });
  await expect(store.get({ ...SCOPE, assessmentId: HIDDEN_BAD_TYPE })).resolves.toBeNull();
});

it("returns integrity error after visibility is established and the visible Manifest hash is wrong", async () => {
  await expect(store.get({ ...SCOPE, assessmentId: VISIBLE_BAD_HASH }))
    .rejects.toBeInstanceOf(AssessmentIntegrityError);
});
```

Also pin visible role/ordinal/purpose/schema/metadata/locator/excerpt/>100 corruption → integrity failure.

- [ ] **Step 3: Add RED future-compatible read tests (Review Focus)**

```ts
it("reads a schema-valid Actor/score Assessment with null reasoning when Manifest is visible", async () => {
  const detail = await store.get({ ...SCOPE, assessmentId: FUTURE_STYLE });
  expect(detail?.assessment).toMatchObject({
    actorId: ACTOR_ID,
    numericScore: 0.82,
    scoreKind: "CALIBRATED_PROBABILITY",
    reasoning: null,
  });
});
```

Non-null Actor must resolve to a canonical Actor; malformed visible Actor → integrity error.

- [ ] **Step 4: Add RED visibility-first keyset pagination tests**

Use at least 60 global rows in the fake query result model, with newest 15 hidden and next 25 visible:

```ts
it("filters visibility before limit so hidden newest rows do not shorten the page", async () => {
  const page = await store.list({ ...LIST, limit: 20 });
  expect(page.assessments).toHaveLength(20);
  expect(page.nextCursor).not.toBeNull();
});

it("uses created_at DESC,id DESC without duplicate/skip across pages", async () => {
  const first = await store.list({ ...LIST, limit: 20 });
  const second = await store.list({ ...LIST, limit: 20, cursor: decode(first.nextCursor!) });
  expect(intersection(ids(first), ids(second))).toEqual([]);
});
```

- [ ] **Step 5: Run read-store test and verify RED**

```bash
pnpm vitest run apps/api/src/s32/postgres/assessment-read-store.test.ts
```

Expected: FAIL because the store does not exist.

- [ ] **Step 6: Implement REPEATABLE READ read transactions and visibility-first SQL**

Implement a read-only transaction wrapper.

History flow:
1. `loadProjectClaimScope`;
2. `loadProjectEvidenceAuthorization`;
3. select Claim Assessments with non-null Manifest;
4. SQL visibility predicate for supported target lineages;
5. keyset predicate;
6. `ORDER BY a.created_at DESC,a.id DESC LIMIT $limitPlusOne`;
7. batch-load page Manifest/Items/Actors;
8. validate visible Assessment + Manifest v1;
9. recompute hash;
10. produce summary and `nextCursor`.

Do not fetch N Manifests/Actors one-by-one.

- [ ] **Step 7: Implement compatible Assessment validation + strict Manifest validation**

Assessment read accepts schema-valid:
- Actor/null;
- score pair/null;
- reasoning string/null.

Manifest read requires exact v1 purpose/schema/metadata and 1..100 contiguous items.

For history excerpt:

```ts
export function reasoningExcerpt(reasoning: string | null): string | null {
  if (reasoning === null) return null;
  const flat = reasoning.replace(/\p{White_Space}+/gu, " ").trim();
  const chars = Array.from(flat);
  return chars.length <= 240 ? flat : chars.slice(0, 240).join("") + "…";
}
```

- [ ] **Step 8: Instrument bounded query count**

Expose test-only query instrumentation through the fake client or count `client.query` calls. Assert the count for 1 visible row and 20 visible rows is equal or bounded by the same constant; do not assert an unnecessarily exact count.

- [ ] **Step 9: Run focused read tests and commit**

```bash
pnpm vitest run \
  apps/api/src/s32/postgres/project-evidence-authorization.test.ts \
  apps/api/src/s32/postgres/assessment-read-store.test.ts
git add \
  apps/api/src/s32/postgres/assessment-read-store.ts \
  apps/api/src/s32/postgres/assessment-read-store.test.ts
git commit -m "feat(s32): add privacy-safe assessment history reads"
```

---

### Task 5: Add Assessment HTTP Routes and Register Both Stores

**Files:**
- Create: `apps/api/src/s32/routes/assessment-routes.ts`
- Create: `apps/api/src/s32/routes/assessment-routes.test.ts`
- Modify: `apps/api/src/s32/register.ts`
- Modify: `apps/api/src/s32/routes/register.test.ts`

**Interfaces:**
- Consumes: `AssessmentsService`, shared private auth.
- Produces endpoints:
  - POST `/:projectId/issues/:issueId/claims/:claimId/assessments`
  - GET `/:projectId/issues/:issueId/claims/:claimId/assessments`
  - GET `/:projectId/issues/:issueId/claims/:claimId/assessments/:assessmentId`

- [ ] **Step 1: Write RED route tests for full status matrix**

Create table-driven tests:

```ts
it.each([
  [new InvalidAssessmentInputError("x"), 400, "ASSESSMENT_INVALID"],
  [new InvalidEvidenceDraftError("x"), 400, "EVIDENCE_DRAFT_INVALID"],
  [new AssessmentScopeNotFoundError("x"), 404, "PROJECT_ISSUE_OR_CLAIM_NOT_FOUND"],
  [new EvidenceTargetNotAvailableError("x"), 404, "EVIDENCE_TARGET_NOT_AVAILABLE"],
  [new AssessmentNotFoundError("x"), 404, "ASSESSMENT_NOT_FOUND"],
  [new ProjectReadOnlyForAssessmentError("x"), 409, "PROJECT_READ_ONLY"],
  [new ResearchIssueReadOnlyForAssessmentError("x"), 409, "RESEARCH_ISSUE_READ_ONLY"],
  [new EvidencePreviewStaleError("x"), 409, "EVIDENCE_PREVIEW_STALE"],
  [new AssessmentIdempotencyConflictError("x"), 409, "IDEMPOTENCY_CONFLICT"],
])("maps domain error safely", async (error, status, code) => {
  // start router, trigger service error, assert status/code and absence of internal detail
});
```

Add 500 generic and 503 unavailable.

Every route test must assert:

```ts
expect(res.headers.get("cache-control")).toBe("no-store");
```

- [ ] **Step 2: Add RED happy-path route tests**

Pin:
- POST 201 `status=created,visible=true`;
- POST 200 replay visible=true;
- POST 200 replay visible=false and no protected fields;
- GET history default/explicit limit+cursor delegation;
- GET detail success;
- GET detail null → safe `ASSESSMENT_NOT_FOUND`;
- limit 51 → 400, not clamped.

- [ ] **Step 3: Run route tests and verify RED**

```bash
pnpm vitest run apps/api/src/s32/routes/assessment-routes.test.ts
```

Expected: FAIL because router is absent.

- [ ] **Step 4: Implement the router**

Follow `evidence-selection-routes.ts` private auth/no-store pattern. Require `Idempotency-Key` on POST using the existing idempotency-key reader contract.

Do not expose error.message from integrity/store internals.

- [ ] **Step 5: Add RED register wiring tests**

Extend `routes/register.test.ts` mocks to assert:
- assessment command store and read store receive the same Pool as evidence selection;
- `createAssessmentsService(commandStore, readStore)` is called;
- `createAssessmentRouter` is mounted under `/projects`.

- [ ] **Step 6: Wire register.ts**

Construct:

```ts
const assessmentCommandStore = createPostgresAssessmentCommandStore(pool);
const assessmentReadStore = createPostgresAssessmentReadStore(pool);
assessments = createAssessmentsService(assessmentCommandStore, assessmentReadStore);
```

Mount `createAssessmentRouter(config, assessments)`.

- [ ] **Step 7: Run route/register regressions and commit**

```bash
pnpm vitest run \
  apps/api/src/s32/routes/assessment-routes.test.ts \
  apps/api/src/s32/routes/register.test.ts \
  apps/api/src/s32/routes/evidence-selection-routes.test.ts \
  apps/api/src/s32/routes/candidate-claim-routes.test.ts \
  apps/api/src/s32/routes/research-issue-routes.test.ts
git add \
  apps/api/src/s32/routes/assessment-routes.ts \
  apps/api/src/s32/routes/assessment-routes.test.ts \
  apps/api/src/s32/register.ts \
  apps/api/src/s32/routes/register.test.ts
git commit -m "feat(s32): expose assessment create and history routes"
```

---

### Task 6: Add Strict Web API Validators and Assessment Client Methods

**Files:**
- Modify: `apps/web/src/research/api.ts`
- Create: `apps/web/src/research/assessment-api.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface AssessmentSummary { /* exact spec shape */ }
  export interface AssessmentDetailResponse { /* exact spec shape */ }
  export type AssessmentCreateResponse =
    | { status: "created" | "replayed"; visible: true; assessment: Assessment; evidenceManifest: AssessmentManifestSummary }
    | { status: "replayed"; visible: false; assessmentId: string };

  export function createAssessment(...): Promise<AssessmentCreateResponse>;
  export function listAssessments(...): Promise<AssessmentHistoryResponse>;
  export function getAssessment(...): Promise<AssessmentDetailResponse>;
  ```

- [ ] **Step 1: Write RED response-validator tests**

Mock `fetch` and pin exact acceptance/rejection:

```ts
it("accepts future-compatible Actor/score/null reasoning in history", async () => {
  mockJson({ assessments: [{
    ...SUMMARY,
    actorId: ACTOR,
    numericScore: 0.82,
    scoreKind: "CALIBRATED_PROBABILITY",
    reasoningExcerpt: null,
  }], nextCursor: null });
  await expect(listAssessments("t", P, I, C)).resolves.toBeDefined();
});

it("rejects malformed score pairing and malformed Manifest summary", async () => {
  mockJson({ assessments: [{ ...SUMMARY, numericScore: 0.5, scoreKind: null }], nextCursor: null });
  await expect(listAssessments("t", P, I, C)).rejects.toMatchObject({ status: 502 });
});

it("accepts replay visible=false only with assessmentId and no protected payload", async () => {
  mockJson({ status: "replayed", visible: false, assessmentId: A });
  const result = await createAssessment(/* exact args */);
  expect(result.visible).toBe(false);
});
```

- [ ] **Step 2: Run and verify RED**

```bash
pnpm vitest run apps/web/src/research/assessment-api.test.ts
```

Expected: FAIL because methods/types are absent.

- [ ] **Step 3: Extend centralized error mapping**

Add codes/messages:
- `ASSESSMENT_INVALID`
- `ASSESSMENT_CURSOR_INVALID`
- `ASSESSMENT_NOT_FOUND`
- `EVIDENCE_PREVIEW_STALE`
- assessment-specific wording for `IDEMPOTENCY_CONFLICT`.

Do not add a 403 interpretation for hidden Assessment.

- [ ] **Step 4: Implement strict validators/client calls**

History validator:
- validates UUIDs/timestamps/enums;
- validates score pairing/range;
- `reasoningExcerpt: string|null`;
- validates v1 Manifest summary;
- `nextCursor: string|null`.

Detail validator additionally validates full ordered items 1..100 and null locator/excerpt.

POST sends exact normalized body and required `Idempotency-Key`.

- [ ] **Step 5: Run tests and commit**

```bash
pnpm vitest run \
  apps/web/src/research/assessment-api.test.ts \
  apps/web/src/research/evidence-selection-api.test.ts \
  apps/web/src/research/candidate-claims-api.test.ts
git add apps/web/src/research/api.ts apps/web/src/research/assessment-api.test.ts
git commit -m "feat(web): add assessment API client contracts"
```

---

### Task 7: Add the Browser Pending Assessment Receipt

**Files:**
- Create: `apps/web/src/research/assessment-draft.ts`
- Create: `apps/web/src/research/assessment-draft.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const ASSESSMENT_PENDING_KEY = "book-id-search:s32-m2d-assessment-create-v1";

  export interface PendingAssessmentReceipt {
    projectId: string;
    issueId: string;
    claimId: string;
    requestHash: string;
    idempotencyKey: string;
    createdAt: string;
    command: NormalizedAssessmentBrowserCommand;
  }

  export async function hashAssessmentCommand(...): Promise<string>;
  export function loadPendingAssessmentReceipt(): PendingAssessmentReceipt | null;
  export function clearPendingAssessmentReceipt(): void;
  export async function getOrCreateAssessmentReceipt(
    scope: { projectId: string; issueId: string; claimId: string },
    command: NormalizedAssessmentBrowserCommand,
  ): Promise<PendingAssessmentReceipt>;
  export class PendingAssessmentIntentConflictError extends Error {}
  ```

- [ ] **Step 1: Write RED normalization/hash tests**

Use browser-side normalization matching server rules:
- reasoning CRLF/CR, outer trim, internal preservation, NUL/8001 rejection;
- lowercase IDs;
- exact evidence item order;
- hash includes stance/confidence/reasoning/expected SHA/items.

Do not create a second evidence-note normalization semantic; browser receipt stores the already-current preview command values.

- [ ] **Step 2: Write RED persistence/recovery tests (Review Focus)**

```ts
it("does not create a receipt until getOrCreate is called for explicit submit", () => {
  expect(loadPendingAssessmentReceipt()).toBeNull();
});

it("returns the same key for the same frozen command after reload restoration", async () => {
  const first = await getOrCreateAssessmentReceipt(SCOPE, COMMAND);
  resetMemoryForTest();
  const restored = loadPendingAssessmentReceipt();
  expect(restored?.idempotencyKey).toBe(first.idempotencyKey);
});

it("storage write failure keeps same-page in-memory retry identity", async () => {
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
  const first = await getOrCreateAssessmentReceipt(SCOPE, COMMAND);
  const second = await getOrCreateAssessmentReceipt(SCOPE, COMMAND);
  expect(second.idempotencyKey).toBe(first.idempotencyKey);
});

it("changed intent in the same scope never silently rotates the key", async () => {
  await getOrCreateAssessmentReceipt(SCOPE, COMMAND);
  await expect(getOrCreateAssessmentReceipt(SCOPE, { ...COMMAND, stance: "CONTRADICTS" }))
    .rejects.toBeInstanceOf(PendingAssessmentIntentConflictError);
});
```

- [ ] **Step 3: Run and verify RED**

```bash
pnpm vitest run apps/web/src/research/assessment-draft.test.ts
```

Expected: FAIL because module is absent.

- [ ] **Step 4: Implement tri-state memory + sessionStorage semantics**

Follow the proven M2-B pattern:
- `undefined` = may restore from storage;
- receipt object = authoritative;
- `null` = explicit page-local clear tombstone;
- storage exceptions never rotate identity during the page lifetime.

Receipt validation includes exact scope, 64-hex request hash, UUID idempotency key, valid createdAt, and normalized command shape.

- [ ] **Step 5: Run and commit**

```bash
pnpm vitest run apps/web/src/research/assessment-draft.test.ts
git add apps/web/src/research/assessment-draft.ts apps/web/src/research/assessment-draft.test.ts
git commit -m "feat(web): persist pending assessment intent safely"
```

---

### Task 8: Make EvidenceEditor Hand Off a Current Preview Safely

**Files:**
- Modify: `apps/web/src/research/EvidenceEditor.tsx`
- Modify: `apps/web/src/research/EvidenceEditor.test.tsx`

**Interfaces:**
- Produces:
  ```ts
  export interface CurrentEvidencePreview {
    draftVersion: number;
    manifestSha256: string;
    items: Array<{ role; targetType; targetId; note }>;
  }

  type EvidenceEditorProps = {
    ...existing;
    onPreviewChange?: (preview: CurrentEvidencePreview | null) => void;
    disabled?: boolean;
  };
  ```
- AssessmentComposer consumes only `CurrentEvidencePreview`; it never computes the Manifest SHA itself.

- [ ] **Step 1: Add RED handoff tests**

```ts
it("emits a current preview after server preview succeeds", async () => {
  const onPreviewChange = vi.fn();
  show({ onPreviewChange });
  // select + preview
  expect(onPreviewChange).toHaveBeenLastCalledWith({
    draftVersion: expect.any(Number),
    manifestSha256: "a".repeat(64),
    items: [{ role: "SUPPORTING", targetType: "SOURCE", targetId: source.targetId, note: "" }],
  });
});

it("emits null immediately on any evidence mutation and never restores stale in-flight preview", async () => {
  // existing stale guard + callback assertion
  expect(onPreviewChange).toHaveBeenLastCalledWith(null);
});
```

- [ ] **Step 2: Add RED 100-selection UI test**

Provide 101 candidates. Select 100; assert the 101st role buttons are disabled or replaced by a clear “最多 100 项” state. The server remains authoritative; this is UX prevention only.

- [ ] **Step 3: Run and verify RED**

```bash
pnpm vitest run apps/web/src/research/EvidenceEditor.test.tsx
```

Expected: FAIL on new callback/max-selection behavior.

- [ ] **Step 4: Implement preview handoff and max-selection UX**

In `mutateDraft`, call `onPreviewChange?.(null)` synchronously with preview invalidation. On successful current preview, emit the server SHA + canonical command items. On unmount, emit null only if the parent component remains mounted and expects cleanup; avoid state update warnings.

Preserve existing AbortController + `draftVersion` stale-response guard.

- [ ] **Step 5: Run and commit**

```bash
pnpm vitest run \
  apps/web/src/research/EvidenceEditor.test.tsx \
  apps/web/src/research/evidence-selection-api.test.ts
git add apps/web/src/research/EvidenceEditor.tsx apps/web/src/research/EvidenceEditor.test.tsx
git commit -m "feat(web): hand off validated evidence previews"
```

---

### Task 9: Build AssessmentComposer and Exact Retry/Error State Semantics

**Files:**
- Create: `apps/web/src/research/AssessmentComposer.tsx`
- Create: `apps/web/src/research/AssessmentComposer.test.tsx`
- Modify: `apps/web/src/research/research.css`

**Interfaces:**
- Consumes: `CurrentEvidencePreview`, create API, pending receipt helpers.
- Produces:
  ```ts
  export function AssessmentComposer(props: {
    token: string;
    projectId: string;
    issueId: string;
    claimId: string;
    preview: CurrentEvidencePreview | null;
    writeAllowed: boolean;
    integrityBlocked: boolean;
    onCommitted: (result: AssessmentCreateResponse) => void;
    onNeedsEvidenceRefresh: () => void;
    onPreviewInvalidated: () => void;
  }): JSX.Element;
  ```

- [ ] **Step 1: Write RED submit-gate and preview-preservation tests**

```ts
it("requires current preview + stance + valid reasoning but not confidence", async () => {
  renderComposer({ preview: PREVIEW });
  expect(submit()).toBeDisabled();
  await userEvent.click(screen.getByLabelText("支持"));
  await userEvent.type(screen.getByLabelText("判断理由"), "当前证据支持。");
  expect(submit()).toBeEnabled();
});

it("assessment-field changes do not invalidate the evidence preview", async () => {
  const onPreviewInvalidated = vi.fn();
  // edit stance/confidence/reasoning
  expect(onPreviewInvalidated).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Write RED pending/retry tests (Review Focus)**

```ts
it.each([
  new TypeError("network"),
  new ProjectApiError(503, "服务暂不可用", "ASSESSMENT_STORE_UNAVAILABLE"),
])("keeps frozen command and retries exact same key/body on ambiguous/retryable result %#", async error => {
  vi.mocked(createAssessment).mockRejectedValueOnce(error).mockResolvedValueOnce(CREATED);
  // submit, assert fields disabled, click same-key retry
  expect(secondCall.idempotencyKey).toBe(firstCall.idempotencyKey);
  expect(secondCall.input).toEqual(firstCall.input);
});
```

Also test reload restoration from a preseeded receipt and explicit discard warning semantics.

- [ ] **Step 3: Write RED known-failure mapping tests**

Pin:
- 400 invalid → clear receipt, editable;
- 409 stale → clear receipt, preserve fields, call `onPreviewInvalidated`;
- 404 evidence unavailable → clear receipt, preserve fields, call `onNeedsEvidenceRefresh`;
- Project/Issue read-only → clear receipt + disable/close write UI;
- idempotency conflict → no silent rotation; require explicit discard;
- history integrity blocker prop disables submit.

- [ ] **Step 4: Run and verify RED**

```bash
pnpm vitest run apps/web/src/research/AssessmentComposer.test.tsx
```

Expected: FAIL because component is absent.

- [ ] **Step 5: Implement component state machine**

Use explicit states:
`idle|submitting|unconfirmed|rejected|idempotency-conflict|success`.

Before POST:
1. normalize browser command;
2. call `getOrCreateAssessmentReceipt`;
3. freeze fields;
4. POST exact receipt key/command.

On 201/200:
- clear receipt;
- clear local fields;
- call `onCommitted`;
- do not append history locally.

For `visible=false`, show success acknowledgement without protected content.

- [ ] **Step 6: Run focused Web tests and commit**

```bash
pnpm vitest run \
  apps/web/src/research/AssessmentComposer.test.tsx \
  apps/web/src/research/assessment-draft.test.ts \
  apps/web/src/research/assessment-api.test.ts
git add \
  apps/web/src/research/AssessmentComposer.tsx \
  apps/web/src/research/AssessmentComposer.test.tsx \
  apps/web/src/research/research.css
git commit -m "feat(web): add assessment composer and retry flow"
```

---

### Task 10: Add Assessment History/Detail and Integrate the Claim Card

**Files:**
- Create: `apps/web/src/research/AssessmentHistory.tsx`
- Create: `apps/web/src/research/AssessmentHistory.test.tsx`
- Create: `apps/web/src/research/AssessmentDetail.tsx`
- Create: `apps/web/src/research/AssessmentDetail.test.tsx`
- Modify: `apps/web/src/research/CandidateClaims.tsx`
- Modify: `apps/web/src/research/CandidateClaims.test.tsx`
- Modify: `apps/web/src/research/research.css`

**Interfaces:**
- `AssessmentHistory` owns pages, cursor, load-more, refresh, and integrity-block signal.
- `AssessmentDetail` owns selected ID/detail state.
- `CandidateClaims` coordinates per-Claim Evidence preview + Composer + History but never collapses the Claim card because an Assessment read fails.

- [ ] **Step 1: Write RED History component tests**

Pin:
- empty copy exactly “当前没有可显示的评价记录。”;
- first visible summary labeled “最近一次评价”;
- no “current/final/preferred/真相” copy;
- load-more appends;
- next-page failure preserves loaded entries;
- invalid cursor preserves loaded entries and exposes explicit reload;
- network/503 failure is local/unavailable;
- integrity 500 invokes `onIntegrityBlocked(true)`.

- [ ] **Step 2: Write RED Detail component tests (Review Focus visibility drift)**

```ts
it("safe 404 after earlier visible summary shows neutral unavailable and asks history to refresh", async () => {
  vi.mocked(getAssessment).mockRejectedValue(
    new ProjectApiError(404, "该评价当前不可用。", "ASSESSMENT_NOT_FOUND"),
  );
  const onRefreshHistory = vi.fn();
  // open detail
  expect(await screen.findByText("该评价当前不可用。")).toBeTruthy();
  expect(onRefreshHistory).toHaveBeenCalled();
  expect(document.body.textContent).not.toMatch(/权限|其他项目/);
});
```

Also prove 500/503 detail errors do not erase the history summary.

- [ ] **Step 3: Run component tests and verify RED**

```bash
pnpm vitest run \
  apps/web/src/research/AssessmentHistory.test.tsx \
  apps/web/src/research/AssessmentDetail.test.tsx
```

Expected: FAIL because components are absent.

- [ ] **Step 4: Implement History and Detail**

History:
- default 20;
- renders excerpt/hash/itemCount/createdAt;
- uses server `nextCursor`;
- does not request total.

Detail:
- renders full reasoning/null copy;
- ordered frozen items;
- wraps long SHA;
- never exposes hidden target existence through custom wording.

- [ ] **Step 5: Write RED Claim-card integration tests**

Extend `CandidateClaims.test.tsx`:
- Claim card renders even if history 503;
- EvidenceEditor remains usable when history network-fails;
- Composer remains usable on 503 but is blocked on history integrity 500;
- Project ARCHIVED and Issue ARCHIVED hide/disable composer while history remains;
- Claim ARCHIVED still permits composer when Project ACTIVE + Issue OPEN/RESOLVED;
- successful POST triggers history reload, not local append;
- POST success + history refresh failure still shows “评价已成功提交” and separate refresh error.

- [ ] **Step 6: Implement Claim-card coordination**

Replace the inline claim article body with a small per-Claim session component if necessary so each Claim owns:
- `CurrentEvidencePreview | null`;
- history refresh generation;
- history integrity block;
- selected detail ID.

Keep Candidate Claim creation behavior unchanged.

- [ ] **Step 7: Add responsive CSS**

Add focused classes for composer/history/detail. At `max-width:700px`, controls stack vertically; SHA uses `overflow-wrap:anywhere` / `word-break:break-all`; no horizontal scroll container.

- [ ] **Step 8: Run focused Web regressions and commit**

```bash
pnpm vitest run \
  apps/web/src/research/CandidateClaims.test.tsx \
  apps/web/src/research/EvidenceEditor.test.tsx \
  apps/web/src/research/AssessmentComposer.test.tsx \
  apps/web/src/research/AssessmentHistory.test.tsx \
  apps/web/src/research/AssessmentDetail.test.tsx \
  apps/web/src/research/ResearchIssueDetail.test.tsx
git add \
  apps/web/src/research/AssessmentHistory.tsx \
  apps/web/src/research/AssessmentHistory.test.tsx \
  apps/web/src/research/AssessmentDetail.tsx \
  apps/web/src/research/AssessmentDetail.test.tsx \
  apps/web/src/research/CandidateClaims.tsx \
  apps/web/src/research/CandidateClaims.test.tsx \
  apps/web/src/research/research.css
git commit -m "feat(web): show assessment history and frozen evidence"
```

---

### Task 11: Add Real PostgreSQL 16 M2-D Integration and Atomicity Gates

**Files:**
- Create: `apps/api/src/s32/postgres/assessment-store.integration.test.ts`
- Create: `scripts/s32-m2d-integration-check.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: command/read stores, frozen migration.
- Produces root script `pnpm s32:m2d:check`.

- [ ] **Step 1: Write the integration fixture and RED happy-path test**

Use the M2-C fixture style but a separate database name/environment guard:

```text
S32_M2D_TEST_DATABASE_URL
database path must equal /s32_m2d_test
host must equal 127.0.0.1
```

Seed:
- ACTIVE Project, OPEN Issue, ACTIVE Claim;
- Project Edition/Source/Asset/Note with R1/R2;
- second Project with foreign evidence;
- archived Project/Issue/Claim variants;
- canonical Actor for compatible-read test.

Test:

```ts
it("real PG: atomically creates Manifest + items + Assessment + completed receipt and reads it back", async () => {
  const created = await commandStore.create(COMMAND);
  expect(created.status).toBe("created");
  const counts = await durableCounts();
  expect(counts).toEqual({
    manifests: "1",
    manifest_items: String(COMMAND.items.length),
    assessments: "1",
    completed_receipts: "1",
  });
  const detail = await readStore.get({ ...SCOPE, assessmentId: created.assessment.id });
  expect(detail?.evidenceManifest.manifestSha256).toBe(COMMAND.expectedManifestSha256);
});
```

- [ ] **Step 2: Add real-PG zero-write failures**

For stale preview, cross-Project evidence, canonical Project graph corruption, and terminal retry-safe failure where feasible:
- capture counts before;
- execute;
- capture after;
- assert exact equality.

Do not use cleanup to mask partial rows.

- [ ] **Step 3: Add real-PG idempotency/concurrency tests**

Pin:
- same key/same command second call returns same Assessment/Manifest IDs with unchanged row counts;
- same key/different command → conflict, unchanged counts;
- two concurrent same-key/same-command promises against real PG produce one durable Assessment and one semantic create/replay pair. If database scheduling makes the exact order nondeterministic, assert the set of statuses is `{"created","replayed"}` rather than timing order.

- [ ] **Step 4: Add real-PG visibility/read tests**

Pin:
- older R1 visible after Note current is R2;
- archived Source/Note visible;
- binding removal hides whole Assessment;
- future-compatible actor/score/null-reasoning row readable;
- manifestless row hidden;
- newest hidden rows do not shorten a 20-visible-row page.

- [ ] **Step 5: Add immutable-trigger fresh checks**

Attempt UPDATE/DELETE for:
- `core.assessments`;
- `core.evidence_manifests`;
- `core.evidence_manifest_items`.

Assert database rejects every mutation.

- [ ] **Step 6: Create disposable PG16 runner**

Clone `scripts/s32-m2c-integration-check.ts` safety pattern:
- `postgres:16-alpine`;
- loopback-only random host port;
- 512 MiB cap;
- tmpfs PG data;
- random password;
- ownership label `book-id-search.s32-m2d-run`;
- apply only `db/migrations/001_s32_core_schema.sql`;
- run only `assessment-store.integration.test.ts`;
- force-remove only the owned container in `finally`;
- print `S32_M2D_REAL_PG=PASS` and `DISPOSABLE_TEST_CONTAINER_REMOVED=YES`.

Add to `package.json`:

```json
"s32:m2d:check": "tsx scripts/s32-m2d-integration-check.ts"
```

- [ ] **Step 7: Run real PG gate and commit**

```bash
pnpm s32:m2d:check
```

Expected:
- M2-D real PG tests PASS;
- `S32_M2D_REAL_PG=PASS`;
- disposable container removal YES.

Then:

```bash
git add \
  apps/api/src/s32/postgres/assessment-store.integration.test.ts \
  scripts/s32-m2d-integration-check.ts \
  package.json
git commit -m "test(s32): add real postgres assessment gates"
```

---

### Task 12: Run Whole-Slice Verification, Real Browser Acceptance, and Record Exact Evidence

**Files:**
- Modify after verification only: `docs/STATUS.md`
- Modify after verification only: `AGENTS.md`

**Interfaces:**
- Consumes the complete M2-D branch.
- Produces no new domain behavior; produces exact verification evidence and status documentation.

- [ ] **Step 1: Run all targeted M2-D tests**

```bash
pnpm vitest run \
  apps/api/src/s32/domain/evidence-selection.test.ts \
  apps/api/src/s32/domain/assessment.test.ts \
  apps/api/src/s32/application/evidence-selection.test.ts \
  apps/api/src/s32/application/assessments.test.ts \
  apps/api/src/s32/postgres/project-evidence-authorization.test.ts \
  apps/api/src/s32/postgres/evidence-selection-store.test.ts \
  apps/api/src/s32/postgres/assessment-command-store.test.ts \
  apps/api/src/s32/postgres/assessment-read-store.test.ts \
  apps/api/src/s32/routes/evidence-selection-routes.test.ts \
  apps/api/src/s32/routes/assessment-routes.test.ts \
  apps/api/src/s32/routes/register.test.ts \
  apps/web/src/research/evidence-selection-api.test.ts \
  apps/web/src/research/assessment-api.test.ts \
  apps/web/src/research/assessment-draft.test.ts \
  apps/web/src/research/EvidenceEditor.test.tsx \
  apps/web/src/research/AssessmentComposer.test.tsx \
  apps/web/src/research/AssessmentHistory.test.tsx \
  apps/web/src/research/AssessmentDetail.test.tsx \
  apps/web/src/research/CandidateClaims.test.tsx \
  apps/web/src/research/ResearchIssueDetail.test.tsx
```

Record exact PASS/FAIL/SKIP counts against the exact branch HEAD.

- [ ] **Step 2: Run M2-C and M2-D real PG gates**

```bash
pnpm s32:m2c:check
pnpm s32:m2d:check
```

Both must pass; both disposable containers must report removed.

- [ ] **Step 3: Run schema/frozen-file gates**

```bash
pnpm s32:schema:static
git diff --exit-code <IMPLEMENTATION_BASE_SHA> -- \
  db/migrations/001_s32_core_schema.sql \
  db/tests/001_s32_schema_assertions.sql \
  db/tests/002_s32_negative_invariants.sql
git diff --check
```

At execution time replace `<IMPLEMENTATION_BASE_SHA>` in the command with the exact base SHA recorded in the progress ledger before the first product-code change. Expected: no frozen SQL diff and `git diff --check` exit 0.

- [ ] **Step 4: Run API/Web builds**

```bash
pnpm --filter @book-id-search/api build
pnpm --filter @book-id-search/web build
```

Expected: both PASS.

- [ ] **Step 5: Run S32/API/Web scoped regressions**

Use the then-current S32 test inventory. At minimum run:

```bash
pnpm vitest run apps/api/src/s32
pnpm vitest run apps/web/src/research
```

Record exact counts, including any skips.

- [ ] **Step 6: Run the full repository suite honestly**

```bash
pnpm test
```

Record exact PASS/FAIL/SKIP/unhandled counts. If unrelated known failures remain, identify them by test/file and do not relabel the full suite as PASS.

- [ ] **Step 7: Prepare isolated local browser fixture**

Use a disposable PostgreSQL16 container, not production. An exact safe shell flow is:

```bash
export M2D_BROWSER_CONTAINER="s32-m2d-browser-$$"
export M2D_BROWSER_PASSWORD="$(node -e "console.log(require('crypto').randomBytes(18).toString('hex'))")"
docker --host unix:///var/run/docker.sock run --detach --rm \
  --name "$M2D_BROWSER_CONTAINER" \
  --label "book-id-search.s32-m2d-browser=$M2D_BROWSER_CONTAINER" \
  --memory=512m \
  --tmpfs /var/lib/postgresql/data:rw,size=268435456 \
  -p 127.0.0.1::5432 \
  -e POSTGRES_USER=s32browser \
  -e POSTGRES_PASSWORD="$M2D_BROWSER_PASSWORD" \
  -e POSTGRES_DB=s32_m2d_browser \
  postgres:16-alpine
```

Wait with `pg_isready`, apply the frozen migration with `psql -v ON_ERROR_STOP=1`, and seed only synthetic S32 fixture rows equivalent to `assessment-store.integration.test.ts`. Record the mapped port.

Start local API/Web:

```bash
S32_FEATURES_ENABLED=true \
S32_DATABASE_URL="postgresql://s32browser:$M2D_BROWSER_PASSWORD@127.0.0.1:<MAPPED_PORT>/s32_m2d_browser" \
S32_PRIVATE_API_TOKEN="m2d-browser-token" \
API_HOST=127.0.0.1 \
API_PORT=3001 \
pnpm --filter @book-id-search/api dev
```

and separately:

```bash
pnpm --filter @book-id-search/web dev
```

The Web URL is `http://127.0.0.1:5173`; Vite proxies `/api` to `127.0.0.1:3001`.

- [ ] **Step 8: Run real-browser happy-path and recovery acceptance**

Using the available real browser automation, verify:
1. Open synthetic Research Issue detail.
2. Expand one Claim evidence editor.
3. Select Source and old NoteRevision evidence with explicit roles.
4. Preview and capture displayed SHA + “尚未提交”.
5. Select stance, optional confidence, and enter multi-line reasoning.
6. Mutate an Assessment field; Preview remains valid.
7. Mutate evidence note/order; Preview disappears while Assessment fields remain.
8. Re-preview and Submit.
9. History reload shows “最近一次评价” summary, Manifest hash, item count.
10. Open detail and verify full reasoning/frozen items.
11. Simulate/fixture response-unknown, reload, restore frozen receipt, same-key retry, and replay success.
12. Confirm no optimistic duplicate history row appears.

- [ ] **Step 9: Run privacy/lifecycle/mobile browser acceptance**

Verify:
- Project ARCHIVED → history/detail readable, composer unavailable;
- Issue ARCHIVED → history/detail readable, composer unavailable;
- Claim ARCHIVED under ACTIVE Project + OPEN/RESOLVED Issue → composer available;
- detail safe-404 after visibility drift shows “该评价当前不可用”, not ownership/permission wording;
- history empty wording is “当前没有可显示的评价记录。”;
- 390×844 viewport has no horizontal overflow;
- long SHA wraps;
- many evidence items scroll vertically.

- [ ] **Step 10: Tear down browser fixture safely**

Stop dev servers. Verify ownership label before removing:

```bash
owner="$(docker --host unix:///var/run/docker.sock inspect \
  --format '{{ index .Config.Labels "book-id-search.s32-m2d-browser" }}' \
  "$M2D_BROWSER_CONTAINER")"
test "$owner" = "$M2D_BROWSER_CONTAINER"
docker --host unix:///var/run/docker.sock rm --force "$M2D_BROWSER_CONTAINER"
```

Record `DISPOSABLE_BROWSER_CONTAINER_REMOVED=YES`.

- [ ] **Step 11: Update STATUS/AGENTS with exact evidence only after all checks**

Write:
- implementation base SHA;
- exact tested HEAD SHA;
- targeted counts;
- M2-C/M2-D real-PG results;
- builds;
- frozen SQL unchanged;
- full-suite exact counts and unrelated failures;
- browser acceptance results;
- production unchanged;
- M2-E not started.

Do not write “all passed” if the full suite has known failures.

- [ ] **Step 12: Commit verification/status documentation**

```bash
git add docs/STATUS.md AGENTS.md
git commit -m "docs(s32): record M2-D assessment verification"
```

- [ ] **Step 13: Re-run exact-head smoke after the docs commit**

Because the docs commit changes HEAD, re-run at least:

```bash
pnpm vitest run \
  apps/api/src/s32/domain/assessment.test.ts \
  apps/api/src/s32/postgres/assessment-command-store.test.ts \
  apps/api/src/s32/postgres/assessment-read-store.test.ts \
  apps/api/src/s32/routes/assessment-routes.test.ts \
  apps/web/src/research/AssessmentComposer.test.tsx \
  apps/web/src/research/AssessmentHistory.test.tsx \
  apps/web/src/research/CandidateClaims.test.tsx
pnpm --filter @book-id-search/api build
pnpm --filter @book-id-search/web build
git diff --check
```

Record this exact final HEAD for review.

---

## Final Execution Gate

Implementation is complete only when all plan tasks are committed and the fresh evidence ledger supports:

```text
M2_D_IMPLEMENTATION=COMPLETE_ON_BRANCH
M2_D_REAL_PG16=PASS
M2_D_REAL_BROWSER=PASS
FROZEN_SQL_CHANGED=NO
PRODUCTION_CHANGED=NO
PRODUCTION_DEPLOYED=NO
M2_E_STARTED=NO
```

Then use `superpowers:requesting-code-review` for one whole-branch exact-head review. If the reviewer finds Critical/Important issues, apply at most the approved fix pass, re-run affected fresh gates, and re-review before any merge decision.

This plan does **not** authorize implementation until the user approves the plan and chooses an execution method.
