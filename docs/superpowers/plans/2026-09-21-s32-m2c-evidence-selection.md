# S32 M2-C Evidence Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Repository `AGENTS.md` requires Native execution; do not use another agent as a command relay.

**Goal:** Add Claim-scoped project evidence selection and a server-authoritative, zero-write EvidenceManifest draft preview with deterministic SHA-256, without creating EvidenceManifest, Assessment, or M2-D state.

**Architecture:** Build a focused `evidence-selection` domain/application/store/router stack beside M2-B. PostgreSQL is used only for repeatable-read authorization and candidate discovery; the application/domain layer owns normalization, canonical serialization, ordinals, and hashing. The Web layer adds a lazy per-Claim Evidence Editor whose draft is page-local only and whose preview is explicitly non-persisted.

**Tech Stack:** TypeScript 5.9, Node.js, Express, PostgreSQL 16, `pg`, React, React Router, Vitest 4, Testing Library, jsdom, pnpm 10, Docker for disposable PostgreSQL integration, real Firefox acceptance through an external user-space Playwright runner.

**Spec:** `docs/superpowers/specs/2026-09-21-s32-m2c-evidence-selection-design.md` at approved commit `23f47490cb5fc9bd872409c98ca24c27f14c0af5`.

## Global Constraints

- Approved source baseline at planning time is `main@8f5b4829b172ebae6a0f99201237da0e5666a33b`. At execution start, fetch `origin/main`; if it advanced, compare the delta and record `ACTUAL_SOURCE_BASELINE`. Do not blind reset, rebase, or discard user work.
- Work in a fresh isolated local worktree and feature branch. Recommended worktree: `/home/conanxin/codex-projects/book-id-search-s32-m2c`; recommended branch: `feat/s32-m2c-evidence-selection`.
- Read root `AGENTS.md` before edits. One writer per worktree. Native execution only.
- Do not modify `db/migrations/001_s32_core_schema.sql`, `db/tests/001_s32_schema_assertions.sql`, or `db/tests/002_s32_negative_invariants.sql`.
- Do not add a schema migration, table, column, enum/check value, index, trigger, FK, or Claim-to-Manifest relation.
- M2-C must never INSERT/UPDATE/DELETE `core.evidence_manifests`, `core.evidence_manifest_items`, `core.assessments`, `core.issue_resolutions`, `core.research_runs`, or `ops.idempotency_keys`.
- Executable Evidence roles are exactly `SUPPORTING | CONTRADICTORY | CONTEXTUAL`.
- Executable Evidence targets are exactly `SOURCE | SOURCE_ASSET | NOTE_REVISION`.
- Server-owned preview values are exactly `schemaVersion=1`, `purpose=CLAIM_ASSESSMENT`, sequential `ordinal=1..N`, `locatorType=null`, `locator=null`, `excerpt=null`.
- Preview response must include `persisted:false` and must not expose a Manifest UUID.
- Preview is not an authorization token. Future M2-D will revalidate and recompute inside its own write transaction.
- Candidate and preview DB access use `REPEATABLE READ, READ ONLY`; no N+1 query behavior.
- Evidence draft is page/component memory only. Do not persist it to PostgreSQL, ops tables, sessionStorage, localStorage, or IndexedDB.
- M2-C remains available for ACTIVE/ARCHIVED Project, OPEN/RESOLVED/ARCHIVED Issue, and ACTIVE/ARCHIVED Claim because it performs no canonical mutation.
- Do not add Assessment/stance/confidence/score/reasoning, IssueResolution, ResearchRun, ClaimRelation, AI evidence search/ranking/classification, SourceAsset creation, granular locator semantics, or production deployment.
- Keep `docs/STATUS.md` short. Detailed execution evidence belongs in ignored `logs/` / `progress/` and browser artifacts outside the repo.
- One M2-C implementation PR only. Do not merge it during implementation.

## File Structure

New API files:

- `apps/api/src/s32/domain/evidence-selection.ts` — role/target/note normalization, draft canonicalization, serialization, SHA-256, response types.
- `apps/api/src/s32/domain/evidence-selection.test.ts` — exact canonical/hash contract tests.
- `apps/api/src/s32/application/evidence-selection.ts` — service/store boundary and safe typed errors.
- `apps/api/src/s32/application/evidence-selection.test.ts` — input normalization/delegation and zero-write service semantics.
- `apps/api/src/s32/postgres/evidence-selection-store.ts` — Claim scope authorization, project evidence graph discovery, preview target authorization; read-only only.
- `apps/api/src/s32/postgres/evidence-selection-store.test.ts` — mocked query-contract and fail-closed tests.
- `apps/api/src/s32/postgres/evidence-selection-store.integration.test.ts` — real PostgreSQL16 scope/candidate/older-revision/zero-write tests.
- `apps/api/src/s32/routes/evidence-selection-routes.ts` — private candidates GET and preview POST.
- `apps/api/src/s32/routes/evidence-selection-routes.test.ts` — auth/config/HTTP/error/zero-idempotency tests.

Modified API file:

- `apps/api/src/s32/register.ts` — construct Evidence Selection service from the shared S32 Pool and mount before generic project routes.

New Web files:

- `apps/web/src/research/evidence-selection-api.test.ts` — strict candidates/preview client tests.
- `apps/web/src/research/EvidenceEditor.tsx` — lazy Claim-scoped evidence draft editor and preview.
- `apps/web/src/research/EvidenceEditor.test.tsx` — explicit role, page-local draft, preview invalidation, local degradation, archived reads.

Modified Web files:

- `apps/web/src/research/api.ts` — Evidence candidate/draft/preview types and private client functions.
- `apps/web/src/research/CandidateClaims.tsx` — embed one EvidenceEditor per Claim.
- `apps/web/src/research/CandidateClaims.test.tsx` — integration regression: Claims remain visible and Evidence Editor is independently scoped.
- `apps/web/src/research/research.css` — Evidence Editor layout/mobile wrapping.

Integration/docs:

- `scripts/s32-m2c-integration-check.ts` — disposable PG16 runner.
- `package.json` — add `s32:m2c:check`.
- `AGENTS.md` — only after implementation verification, advance current local stage to M2-C while keeping M2-D/production unauthorized.
- `docs/STATUS.md` — short final branch checkpoint.

## Review Focus

The whole-branch reviewer must deliberately inspect these failure classes:

1. **Declared source corruption vs missing source:** absent `sourceId` means no Source candidate, but a declared nonblank malformed/dangling/mismatched `sourceId` must fail closed instead of silently disappearing.
2. **Current Note advances after candidate fetch:** preview must still accept the previously selected immutable older NoteRevision when it belongs to the same authorized Project Note.
3. **Cross-Project target probing:** a valid Source/Asset/Revision from another Project must return the same safe target-not-available shape as a nonexistent target, with no existence leakage.
4. **Zero-write preview under success and failure:** before/after row counts for manifests/items/assessments/resolutions/runs/idempotency must remain exactly unchanged, including malformed/cross-project requests.
5. **Preview staleness in UI:** any role/note/order/add/remove change after a successful preview must immediately remove the old hash/persisted=false display and require another preview.

---

### Task 1: Evidence draft domain and canonical SHA-256

**Files:**
- Create: `apps/api/src/s32/domain/evidence-selection.ts`
- Create: `apps/api/src/s32/domain/evidence-selection.test.ts`

**Interfaces:**

Produces:

```ts
export type EvidenceRole = "SUPPORTING" | "CONTRADICTORY" | "CONTEXTUAL";
export type EvidenceTargetType = "SOURCE" | "SOURCE_ASSET" | "NOTE_REVISION";

export interface EvidenceDraftInputItem {
  role: EvidenceRole;
  targetType: EvidenceTargetType;
  targetId: string;
  note: string | null;
}

export interface CanonicalEvidenceDraftItem extends EvidenceDraftInputItem {
  ordinal: number;
  locatorType: null;
  locator: null;
  excerpt: null;
}

export interface EvidenceManifestDraft {
  schemaVersion: 1;
  purpose: "CLAIM_ASSESSMENT";
  manifestSha256: string;
  items: CanonicalEvidenceDraftItem[];
}

export class InvalidEvidenceDraftError extends Error {}

export function readEvidenceRole(value: unknown): EvidenceRole;
export function readEvidenceTargetType(value: unknown): EvidenceTargetType;
export function normalizeEvidenceItemNote(value: unknown): string | null;
export function normalizeEvidencePreviewInput(value: unknown): EvidenceDraftInputItem[];
export function canonicalEvidencePayload(items: EvidenceDraftInputItem[]): {
  schemaVersion: 1;
  purpose: "CLAIM_ASSESSMENT";
  items: CanonicalEvidenceDraftItem[];
};
export function serializeCanonicalEvidencePayload(payload: ReturnType<typeof canonicalEvidencePayload>): string;
export function buildEvidenceManifestDraft(items: EvidenceDraftInputItem[]): EvidenceManifestDraft;
```

- [ ] **Step 1: Write RED tests for role/target/note normalization**

Pin exact executable enums and note rules:

```ts
it("accepts only executable evidence roles and target types", () => {
  for (const role of ["SUPPORTING", "CONTRADICTORY", "CONTEXTUAL"]) {
    expect(readEvidenceRole(role)).toBe(role);
  }
  for (const bad of ["PRIMARY", "CONTROL", "SUPPORT", null]) {
    expect(() => readEvidenceRole(bad)).toThrow(InvalidEvidenceDraftError);
  }
  for (const target of ["SOURCE", "SOURCE_ASSET", "NOTE_REVISION"]) {
    expect(readEvidenceTargetType(target)).toBe(target);
  }
  for (const bad of ["CLAIM", "NOTE", "EDITION", null]) {
    expect(() => readEvidenceTargetType(bad)).toThrow(InvalidEvidenceDraftError);
  }
});

it("normalizes optional note without collapsing internal whitespace", () => {
  expect(normalizeEvidenceItemNote(undefined)).toBeNull();
  expect(normalizeEvidenceItemNote(null)).toBeNull();
  expect(normalizeEvidenceItemNote(" \u0085\r\n line 1\rline  2 \u0085 ")).toBe("line 1\nline  2");
  expect(normalizeEvidenceItemNote(" \t\u0085 ")).toBeNull();
  expect(() => normalizeEvidenceItemNote("a\0b")).toThrow(InvalidEvidenceDraftError);
  expect(() => normalizeEvidenceItemNote("𠮷".repeat(2001))).toThrow(InvalidEvidenceDraftError);
  expect(normalizeEvidenceItemNote("𠮷".repeat(2000))).toBe("𠮷".repeat(2000));
});
```

- [ ] **Step 2: Write RED tests for exact body shape, non-empty items, UUID normalization, duplicates**

```ts
it("rejects unknown fields, empty drafts, malformed UUIDs, and duplicate target pairs", () => {
  expect(() => normalizeEvidencePreviewInput({ items: [] })).toThrow(InvalidEvidenceDraftError);
  expect(() => normalizeEvidencePreviewInput({ items: [{ role: "SUPPORTING", targetType: "SOURCE", targetId: "bad" }] }))
    .toThrow(InvalidEvidenceDraftError);
  expect(() => normalizeEvidencePreviewInput({ items: [{ role: "SUPPORTING", targetType: "SOURCE", targetId: sourceId, extra: true }] }))
    .toThrow(InvalidEvidenceDraftError);
  expect(() => normalizeEvidencePreviewInput({
    items: [
      { role: "SUPPORTING", targetType: "SOURCE", targetId: sourceId },
      { role: "CONTRADICTORY", targetType: "SOURCE", targetId: sourceId.toUpperCase() },
    ],
  })).toThrow(InvalidEvidenceDraftError);
});
```

The top-level object may contain only `items`; each item may contain only `role,targetType,targetId,note`.

- [ ] **Step 3: Write RED tests for canonical property order, ordinals, and hash sensitivity**

```ts
it("serializes the fixed canonical payload in exact property order", () => {
  const normalized = normalizeEvidencePreviewInput({
    items: [{
      role: "SUPPORTING",
      targetType: "NOTE_REVISION",
      targetId: noteRevisionId.toUpperCase(),
      note: " why ",
    }],
  });
  const payload = canonicalEvidencePayload(normalized);
  expect(payload).toEqual({
    schemaVersion: 1,
    purpose: "CLAIM_ASSESSMENT",
    items: [{
      ordinal: 1,
      role: "SUPPORTING",
      targetType: "NOTE_REVISION",
      targetId: noteRevisionId,
      locatorType: null,
      locator: null,
      excerpt: null,
      note: "why",
    }],
  });
  expect(serializeCanonicalEvidencePayload(payload)).toBe(
    '{"schemaVersion":1,"purpose":"CLAIM_ASSESSMENT","items":[{"ordinal":1,"role":"SUPPORTING","targetType":"NOTE_REVISION","targetId":"' +
      noteRevisionId +
      '","locatorType":null,"locator":null,"excerpt":null,"note":"why"}]}'
  );
});

it("hash is deterministic and changes on role/target/note/order but not external context", () => {
  const base = normalizeEvidencePreviewInput({ items: [itemA, itemB] });
  const a = buildEvidenceManifestDraft(base);
  const b = buildEvidenceManifestDraft(normalizeEvidencePreviewInput({ items: [itemA, itemB] }));
  expect(a.manifestSha256).toBe(b.manifestSha256);
  expect(a.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
  expect(buildEvidenceManifestDraft(normalizeEvidencePreviewInput({ items: [{ ...itemA, role: "CONTRADICTORY" }, itemB] })).manifestSha256).not.toBe(a.manifestSha256);
  expect(buildEvidenceManifestDraft(normalizeEvidencePreviewInput({ items: [itemB, itemA] })).manifestSha256).not.toBe(a.manifestSha256);
});
```

- [ ] **Step 4: Run RED**

```bash
pnpm exec vitest run apps/api/src/s32/domain/evidence-selection.test.ts --maxWorkers=1
```

Expected: FAIL because the domain module is absent.

- [ ] **Step 5: Implement the minimal domain module**

Use `node:crypto.createHash("sha256")`. UUID validation follows the existing S32 lowercase UUID normalization pattern. Build the canonical object explicitly in fixed insertion order and hash exactly `JSON.stringify(payload)`.

Do not accept caller-supplied `schemaVersion`, `purpose`, `ordinal`, `manifestSha256`, `locatorType`, `locator`, or `excerpt`.

- [ ] **Step 6: Run GREEN**

```bash
pnpm exec vitest run apps/api/src/s32/domain/evidence-selection.test.ts --maxWorkers=1
```

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/s32/domain/evidence-selection.ts apps/api/src/s32/domain/evidence-selection.test.ts
git commit -m "feat(s32): define evidence manifest draft"
```

---

### Task 2: Evidence Selection application boundary

**Files:**
- Create: `apps/api/src/s32/application/evidence-selection.ts`
- Create: `apps/api/src/s32/application/evidence-selection.test.ts`

**Interfaces:**

Consumes Task 1 domain functions plus existing Project/Issue/Claim ID readers.

Produces:

```ts
export class EvidenceSelectionScopeNotFoundError extends Error {}
export class EvidenceTargetNotAvailableError extends Error {}
export class EvidenceSelectionIntegrityError extends Error {}
export class EvidenceSelectionStoreUnavailableError extends Error {}

export interface EvidenceClaimContext {
  id: string;
  statement: string;
  lifecycleState: "ACTIVE" | "ARCHIVED";
}

export type EvidenceSourceType =
  | "PUBLICATION" | "WEB_PAGE" | "ARCHIVAL_RECORD" | "DATABASE_RECORD"
  | "MUSEUM_OBJECT" | "EXHIBITION_LABEL" | "EMAIL"
  | "FIELD_OBSERVATION" | "INTERVIEW" | "OTHER";

export type EvidenceAssetType =
  | "DOCUMENT" | "IMAGE" | "AUDIO" | "VIDEO"
  | "WEB_SNAPSHOT" | "TEXT" | "DATA" | "OTHER";

export type EvidenceCandidate =
  | {
      targetType: "SOURCE";
      targetId: string;
      materialBindingId: string;
      materialTitle: string;
      sourceType: EvidenceSourceType;
      sourceLifecycleState: "ACTIVE" | "ARCHIVED";
      observedAt: string;
    }
  | {
      targetType: "SOURCE_ASSET";
      targetId: string;
      materialBindingId: string;
      materialTitle: string;
      sourceId: string;
      assetType: EvidenceAssetType;
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

export interface EvidenceSelectionStore {
  candidates(input: {
    projectId: string;
    issueId: string;
    claimId: string;
  }): Promise<{ claim: EvidenceClaimContext; candidates: EvidenceCandidate[] } | null>;

  authorizePreview(input: {
    projectId: string;
    issueId: string;
    claimId: string;
    items: EvidenceDraftInputItem[];
  }): Promise<{ claim: EvidenceClaimContext } | null>;
}

export function createEvidenceSelectionService(store: EvidenceSelectionStore): {
  candidates(project: unknown, issue: unknown, claim: unknown): Promise<{ claim: EvidenceClaimContext; candidates: EvidenceCandidate[] } | null>;
  preview(project: unknown, issue: unknown, claim: unknown, body: unknown): Promise<{
    claim: { id: string; statement: string };
    draft: EvidenceManifestDraft;
    persisted: false;
  }>;
};
```

- [ ] **Step 1: Write RED application tests**

Pin:

- Project/Issue/Claim IDs are canonicalized to lowercase before store access;
- preview body is normalized before authorization;
- malformed IDs/body never call the store;
- preview calls `authorizePreview` before building the hash response;
- null authorization result becomes `EvidenceSelectionScopeNotFoundError`;
- response claim exposes only `id,statement`;
- `persisted` is literal false;
- no idempotency key, random UUID, or DB resource ID is generated in the service.

- [ ] **Step 2: Run RED**

```bash
pnpm exec vitest run apps/api/src/s32/application/evidence-selection.test.ts --maxWorkers=1
```

- [ ] **Step 3: Implement service**

Core preview shape:

```ts
async function preview(projectInput: unknown, issueInput: unknown, claimInput: unknown, body: unknown) {
  const projectId = readProjectId(projectInput).toLowerCase();
  const issueId = readResearchIssueId(issueInput);
  const claimId = readCandidateClaimId(claimInput);
  const items = normalizeEvidencePreviewInput(body);

  const authorized = await store.authorizePreview({ projectId, issueId, claimId, items });
  if (!authorized) throw new EvidenceSelectionScopeNotFoundError("PROJECT_ISSUE_OR_CLAIM_NOT_FOUND");

  return {
    claim: { id: authorized.claim.id, statement: authorized.claim.statement },
    draft: buildEvidenceManifestDraft(items),
    persisted: false as const,
  };
}
```

The domain hash is computed only after store authorization succeeds.

- [ ] **Step 4: Run Task 1+2 GREEN**

```bash
pnpm exec vitest run   apps/api/src/s32/domain/evidence-selection.test.ts   apps/api/src/s32/application/evidence-selection.test.ts   --maxWorkers=1
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/s32/application/evidence-selection.ts apps/api/src/s32/application/evidence-selection.test.ts
git commit -m "feat(s32): add evidence selection service"
```

---

### Task 3: PostgreSQL evidence candidate discovery and preview authorization

**Files:**
- Create: `apps/api/src/s32/postgres/evidence-selection-store.ts`
- Create: `apps/api/src/s32/postgres/evidence-selection-store.test.ts`

**Interfaces:**

Produces `createPostgresEvidenceSelectionStore(pool: Pool): EvidenceSelectionStore`.

- [ ] **Step 1: Write RED tests for read-only transaction and Claim scope**

Use the mocked Pool/PoolClient pattern from M2-B.

Pin:

1. candidates starts `BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY`;
2. authorizePreview starts the same read-only transaction;
3. Project ACTIVE/ARCHIVED are accepted;
4. Issue OPEN/RESOLVED/ARCHIVED are accepted;
5. Claim ACTIVE/ARCHIVED are accepted;
6. wrong-Project Issue, missing Claim, or Claim not related to Issue return null;
7. zero/multiple Issue owner corruption and dangling Claim relation fail closed;
8. no SQL statement contains INSERT/UPDATE/DELETE.

Claim context query should validate Project + exact Issue owner + exact Issue-Claim relation in one bounded read path.

- [ ] **Step 2: Write RED tests for Project material SOURCE semantics**

Candidate graph must distinguish:

```text
metadata.sourceId absent/null/blank -> no SOURCE candidate
metadata.sourceId declared malformed -> integrity error
declared UUID but Source missing -> integrity error
Source edition mismatch -> integrity error
valid ACTIVE/ARCHIVED Source -> candidate
```

The candidate response pins the current executable `source_type` allowlist and lifecycle.

- [ ] **Step 3: Write RED tests for SOURCE_ASSET and current NOTE_REVISION**

Pin:

- assets are returned only under validated authorized Sources;
- asset type/role/storage mode must match executable allowlists;
- storage_key/remote_uri are never projected into the candidate response;
- Project Note binding must be ANNOTATION with exact subjectBindingId/subjectType/subjectId;
- duplicate/malformed Note binding is integrity failure;
- current NoteRevision must belong to the Note and have valid revision number/content format/timestamp;
- candidate response contains revision metadata but not Note content.

- [ ] **Step 4: Write RED tests for deterministic candidate order**

Build rows representing two Project materials and assert output order:

```text
material binding created_at ASC
material binding id ASC
SOURCE
SOURCE_ASSET created_at ASC / id ASC
current NOTE_REVISION
```

No client-side relevance/ranking field is added.

- [ ] **Step 5: Write RED preview authorization tests**

For one request containing SOURCE + SOURCE_ASSET + NOTE_REVISION, require one bounded authorization query/set, not per-item N+1.

Pin:

- authorized current Source accepted;
- authorized SourceAsset accepted only under its authorized Source;
- current NoteRevision accepted;
- an older immutable NoteRevision of the same authorized Note is accepted;
- revision from a different Note/Project throws `EvidenceTargetNotAvailableError`;
- cross-Project Source/Asset returns the same target-not-available class;
- a nonexistent target returns the same target-not-available class;
- malformed Project graph still throws integrity, not target-not-available.

- [ ] **Step 6: Run store tests RED**

```bash
pnpm exec vitest run apps/api/src/s32/postgres/evidence-selection-store.test.ts --maxWorkers=1
```

- [ ] **Step 7: Implement read-only transaction helper**

Use:

```ts
async function readOnlyTransaction<T>(pool: Pool, run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    const value = await run(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw classifyEvidenceSelectionStoreError(error);
  } finally {
    client.release();
  }
}
```

Map only real connection/query-timeout failures to `EvidenceSelectionStoreUnavailableError`; preserve typed scope/target/integrity errors.

- [ ] **Step 8: Implement Claim scope validation**

Follow the M2-B owner invariants but include exact Claim membership:

```sql
SELECT
  p.id AS project_id,
  p.lifecycle_state AS project_state,
  ri.id AS issue_id,
  ri.lifecycle_state AS issue_state,
  pb.id AS issue_binding_id,
  pb.project_id AS owner_project_id,
  pb.binding_role AS issue_binding_role,
  pb.metadata AS issue_binding_metadata,
  ric.claim_id AS relation_claim_id,
  c.statement AS claim_statement,
  c.lifecycle_state AS claim_state,
  c.claim_type,
  c.subject_type,
  c.subject_id,
  c.metadata AS claim_metadata,
  c.created_at AS claim_created_at,
  c.updated_at AS claim_updated_at
FROM core.projects p
LEFT JOIN core.research_issues ri ON ri.id = $2
LEFT JOIN core.project_bindings pb
  ON pb.target_type = 'RESEARCH_ISSUE'
 AND pb.target_id = ri.id
LEFT JOIN core.research_issue_claims ric
  ON ric.issue_id = ri.id
 AND ric.claim_id = $3
LEFT JOIN core.claims c ON c.id = ric.claim_id
WHERE p.id = $1
ORDER BY pb.id
```

If the Issue exists with zero/multiple owner bindings, fail closed. If canonical scope exists but requested Project does not own it, return null. Missing Claim relation returns null. Validate Claim canonicality with the same long-term compatibility rule as M2-B: non-null historical/global claim type/subject are allowed.

- [ ] **Step 9: Implement one candidate graph query**

Use Project Edition bindings as the anchor and LEFT JOIN:

- Edition;
- declared Source from `pb.metadata->>'sourceId'`;
- SourceAssets under that Source;
- Project NOTE binding tied to the Edition binding;
- Note;
- current NoteRevision.

The query must project enough columns to distinguish "source absent" from "source declared but dangling".

Do not fetch raw Note content, storage keys, or remote URIs.

Group rows per material binding, validate all repeated canonical fields, and emit candidates in the fixed order.

- [ ] **Step 10: Implement one preview target authorization query**

Construct a `VALUES` CTE from normalized items:

```sql
WITH requested(ordinal, target_type, target_id) AS (
  VALUES
    ($1::int, $2::text, $3::uuid),
    ($4::int, $5::text, $6::uuid)
)
...
```

Join requested targets to the authorized Project material graph. For NOTE_REVISION, join all revisions belonging to the exact authorized Note rather than only `current_revision_id`.

Return one authorization result per requested ordinal. If any ordinal is absent, throw `EvidenceTargetNotAvailableError`.

Do not use a query path that can reveal whether the target exists outside the Project.

- [ ] **Step 11: Run API unit scope GREEN**

```bash
pnpm exec vitest run   apps/api/src/s32/domain/evidence-selection.test.ts   apps/api/src/s32/application/evidence-selection.test.ts   apps/api/src/s32/postgres/evidence-selection-store.test.ts   --maxWorkers=1
```

- [ ] **Step 12: Commit**

```bash
git add apps/api/src/s32/postgres/evidence-selection-store.ts apps/api/src/s32/postgres/evidence-selection-store.test.ts
git commit -m "feat(s32): authorize evidence selection"
```

---

### Task 4: Private Evidence Selection HTTP routes and S32 registration

**Files:**
- Create: `apps/api/src/s32/routes/evidence-selection-routes.ts`
- Create: `apps/api/src/s32/routes/evidence-selection-routes.test.ts`
- Modify: `apps/api/src/s32/register.ts`

**Routes:**

```text
GET  /:projectId/issues/:issueId/claims/:claimId/evidence-candidates
POST /:projectId/issues/:issueId/claims/:claimId/evidence-manifest-preview
```

- [ ] **Step 1: Write RED auth/config tests**

For both endpoints pin:

- feature disabled -> 404;
- token unconfigured -> 503;
- missing token -> 401;
- wrong token -> 403;
- DB/service unconfigured -> 503;
- every response has `Cache-Control: no-store`;
- no store/service call on auth/config rejection.

- [ ] **Step 2: Write RED success tests**

Candidates:

```ts
expect(response.status).toBe(200);
expect(await response.json()).toEqual({ claim, candidates });
```

Preview:

```ts
expect(response.status).toBe(200);
expect(await response.json()).toEqual({
  claim: { id: claim.id, statement: claim.statement },
  draft,
  persisted: false,
});
```

Assert no `Idempotency-Key` is required and no 201 status is used.

- [ ] **Step 3: Write RED safe error mapping tests**

```text
InvalidProjectInputError
InvalidResearchIssueInputError
InvalidCandidateClaimInputError
InvalidEvidenceDraftError            -> 400 EVIDENCE_DRAFT_INVALID

EvidenceSelectionScopeNotFoundError  -> 404 PROJECT_ISSUE_OR_CLAIM_NOT_FOUND
EvidenceTargetNotAvailableError      -> 404 EVIDENCE_TARGET_NOT_AVAILABLE
EvidenceSelectionIntegrityError      -> 500 generic safe message
EvidenceSelectionStoreUnavailableError -> 503
unknown Error                        -> 500
```

No SQL, foreign Project IDs, target existence details, storage keys, or internal corruption text may leak.

- [ ] **Step 4: Run route test RED**

```bash
pnpm exec vitest run apps/api/src/s32/routes/evidence-selection-routes.test.ts --maxWorkers=1
```

- [ ] **Step 5: Implement router and shared-Pool registration**

Mount before generic Project routes:

```ts
router.use("/projects", createEvidenceSelectionRouter(config, evidenceSelection));
```

Construct from the same S32 `Pool` as M2-B and Project services.

Registration test spies on the Evidence Selection store factory and Candidate Claim/Project store factory and proves exact Pool object identity.

- [ ] **Step 6: Run targeted API GREEN**

```bash
pnpm exec vitest run   apps/api/src/s32/domain/evidence-selection.test.ts   apps/api/src/s32/application/evidence-selection.test.ts   apps/api/src/s32/postgres/evidence-selection-store.test.ts   apps/api/src/s32/routes/evidence-selection-routes.test.ts   --maxWorkers=1
```

- [ ] **Step 7: Commit**

```bash
git add   apps/api/src/s32/routes/evidence-selection-routes.ts   apps/api/src/s32/routes/evidence-selection-routes.test.ts   apps/api/src/s32/register.ts
git commit -m "feat(s32): expose evidence selection API"
```

---

### Task 5: Disposable PostgreSQL16 zero-write integration gate

**Files:**
- Create: `apps/api/src/s32/postgres/evidence-selection-store.integration.test.ts`
- Create: `scripts/s32-m2c-integration-check.ts`
- Modify: `package.json`

- [ ] **Step 1: Write real-PG fixture helpers**

Create canonical fixtures for:

- ACTIVE/ARCHIVED Project;
- OPEN/RESOLVED/ARCHIVED Issue with exact Project owner;
- ACTIVE/ARCHIVED Claim related to Issue;
- Project Edition binding with valid Source ID in metadata;
- Source under the same Edition;
- two SourceAssets under that Source;
- Project annotation Note with revision 1 and revision 2/current;
- a second Project with its own Source/Asset/NoteRevision for cross-project probes.

Do not alter frozen SQL.

- [ ] **Step 2: Write candidate integration cases**

Require:

1. SOURCE candidate appears;
2. SOURCE_ASSET candidates appear under that Source;
3. only current NOTE_REVISION appears in candidates;
4. candidate order follows material/source/asset/current-note contract;
5. absent sourceId produces no Source candidate;
6. declared malformed/dangling/mismatched Source fails closed;
7. archived Project/Issue/Claim reads remain valid;
8. wrong-Project Issue/Claim returns scoped not found.

- [ ] **Step 3: Write preview integration cases**

Require:

1. mixed SOURCE/SOURCE_ASSET/current NOTE_REVISION preview succeeds;
2. older revision 1 of the same authorized Note succeeds after current is revision 2;
3. cross-project Source/Asset/Revision returns `EvidenceTargetNotAvailableError`;
4. nonexistent target returns the same class;
5. duplicate target draft fails before DB authorization;
6. response hash exactly matches Task 1 canonical serialization.

- [ ] **Step 4: Pin zero-write row counts**

Before and after **every successful preview and at least one failed preview**, compare:

```sql
SELECT
  (SELECT count(*) FROM core.evidence_manifests) AS manifests,
  (SELECT count(*) FROM core.evidence_manifest_items) AS manifest_items,
  (SELECT count(*) FROM core.assessments) AS assessments,
  (SELECT count(*) FROM core.issue_resolutions) AS resolutions,
  (SELECT count(*) FROM core.research_runs) AS runs,
  (SELECT count(*) FROM ops.idempotency_keys) AS idempotency;
```

Require exact equality.

Also verify the store transaction is read-only by attempting no mutation; no test should weaken DB permissions or disable triggers to make preview pass.

- [ ] **Step 5: Add env guard**

```ts
const url = process.env.S32_M2C_TEST_DATABASE_URL;
const parsed = url ? new URL(url) : null;
if (parsed && (parsed.hostname !== "127.0.0.1" || parsed.pathname !== "/s32_m2c_test")) {
  throw new Error("M2-C integration requires isolated local s32_m2c_test");
}
```

- [ ] **Step 6: Verify safe skip without env**

```bash
pnpm exec vitest run apps/api/src/s32/postgres/evidence-selection-store.integration.test.ts --maxWorkers=1
```

Expected: file loads, integration suite skips.

- [ ] **Step 7: Create M2-C runner**

Clone the M2-B disposable runner safety model with:

```text
label    book-id-search.s32-m2c-run
database s32_m2c_test
env      S32_M2C_TEST_DATABASE_URL
marker   S32_M2C_REAL_PG=PASS
```

Keep:

- `postgres:16-alpine`;
- loopback-only random port;
- tmpfs PG data;
- 512 MiB memory;
- `ON_ERROR_STOP=1`;
- ownership-label verification before forced cleanup;
- `DISPOSABLE_TEST_CONTAINER_REMOVED=YES`.

- [ ] **Step 8: Add package script and run**

```json
"s32:m2c:check": "tsx scripts/s32-m2c-integration-check.ts"
```

Run:

```bash
pnpm s32:m2c:check
```

Require real PG tests PASS, `S32_M2C_REAL_PG=PASS`, and cleanup marker YES.

- [ ] **Step 9: Commit**

```bash
git add   apps/api/src/s32/postgres/evidence-selection-store.integration.test.ts   scripts/s32-m2c-integration-check.ts   package.json
git commit -m "test(s32): verify zero-write evidence preview"
```

---

### Task 6: Strict Web Evidence Selection client

**Files:**
- Modify: `apps/web/src/research/api.ts`
- Create: `apps/web/src/research/evidence-selection-api.test.ts`

**Interfaces:**

Add exact Web types mirroring the spec:

```ts
export type EvidenceRole = "SUPPORTING" | "CONTRADICTORY" | "CONTEXTUAL";
export type EvidenceTargetType = "SOURCE" | "SOURCE_ASSET" | "NOTE_REVISION";

export type EvidenceSourceType =
  | "PUBLICATION" | "WEB_PAGE" | "ARCHIVAL_RECORD" | "DATABASE_RECORD"
  | "MUSEUM_OBJECT" | "EXHIBITION_LABEL" | "EMAIL"
  | "FIELD_OBSERVATION" | "INTERVIEW" | "OTHER";

export type EvidenceAssetType =
  | "DOCUMENT" | "IMAGE" | "AUDIO" | "VIDEO"
  | "WEB_SNAPSHOT" | "TEXT" | "DATA" | "OTHER";

export type EvidenceCandidate =
  | {
      targetType: "SOURCE";
      targetId: string;
      materialBindingId: string;
      materialTitle: string;
      sourceType: EvidenceSourceType;
      sourceLifecycleState: "ACTIVE" | "ARCHIVED";
      observedAt: string;
    }
  | {
      targetType: "SOURCE_ASSET";
      targetId: string;
      materialBindingId: string;
      materialTitle: string;
      sourceId: string;
      assetType: EvidenceAssetType;
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

export interface EvidenceClaimContext {
  id: string;
  statement: string;
  lifecycleState: "ACTIVE" | "ARCHIVED";
}

export interface EvidenceManifestDraftPreview {
  schemaVersion: 1;
  purpose: "CLAIM_ASSESSMENT";
  manifestSha256: string;
  items: Array<{
    ordinal: number;
    role: EvidenceRole;
    targetType: EvidenceTargetType;
    targetId: string;
    locatorType: null;
    locator: null;
    excerpt: null;
    note: string | null;
  }>;
}

export function listEvidenceCandidates(
  token: string,
  projectId: string,
  issueId: string,
  claimId: string,
  signal?: AbortSignal,
): Promise<{ claim: EvidenceClaimContext; candidates: EvidenceCandidate[] }>;

export function previewEvidenceManifest(
  token: string,
  projectId: string,
  issueId: string,
  claimId: string,
  items: Array<{ role: EvidenceRole; targetType: EvidenceTargetType; targetId: string; note: string | null }>,
  signal?: AbortSignal,
): Promise<{
  claim: { id: string; statement: string };
  draft: EvidenceManifestDraftPreview;
  persisted: false;
}>;
```

- [ ] **Step 1: Write RED path/request tests**

Pin exact encoded paths and preview body. Preview must not send `Idempotency-Key`.

- [ ] **Step 2: Write RED strict response validators**

Reject:

- malformed Claim;
- unknown evidence role/target type;
- malformed UUIDs;
- invalid Source/Asset physical enums;
- invalid timestamps/revision numbers;
- candidate fields that are missing;
- preview `persisted:true`;
- preview with Manifest ID;
- schemaVersion other than 1;
- purpose other than CLAIM_ASSESSMENT;
- non-sequential ordinals;
- non-null locator/excerpt;
- bad hash;
- duplicate preview targets;
- malformed note.

- [ ] **Step 3: Write safe error mapping tests**

Add:

```ts
EVIDENCE_DRAFT_INVALID: { status: 400, message: "证据草稿输入不正确。" },
PROJECT_ISSUE_OR_CLAIM_NOT_FOUND: { status: 404, message: "研究问题或可能答案不存在。" },
EVIDENCE_TARGET_NOT_AVAILABLE: { status: 404, message: "所选证据不可用于当前研究项目。" },
```

Do not leak server-provided secret/error detail.

- [ ] **Step 4: Run RED**

```bash
pnpm exec vitest run apps/web/src/research/evidence-selection-api.test.ts --maxWorkers=1
```

- [ ] **Step 5: Implement client and validators**

Use the existing same-origin `request` helper. Do not add any storage or hash computation to the Web client.

- [ ] **Step 6: Run GREEN**

```bash
pnpm exec vitest run apps/web/src/research/evidence-selection-api.test.ts --maxWorkers=1
```

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/research/api.ts apps/web/src/research/evidence-selection-api.test.ts
git commit -m "feat(s32): add evidence selection web client"
```

---

### Task 7: Page-local Evidence Editor per Claim

**Files:**
- Create: `apps/web/src/research/EvidenceEditor.tsx`
- Create: `apps/web/src/research/EvidenceEditor.test.tsx`
- Modify: `apps/web/src/research/CandidateClaims.tsx`
- Modify: `apps/web/src/research/CandidateClaims.test.tsx`
- Modify: `apps/web/src/research/research.css`

**Interfaces:**

```ts
export function EvidenceEditor(props: {
  token: string;
  projectId: string;
  issueId: string;
  claim: CandidateClaim;
}): JSX.Element;
```

Internal draft item:

```ts
type LocalEvidenceItem = {
  role: EvidenceRole;
  candidate: EvidenceCandidate;
  note: string;
};
```

No persistence helper module is allowed in M2-C.

- [ ] **Step 1: Write RED lazy-load and degradation tests**

Pin:

- collapsed Claim shows `构建证据集` and does not call candidates API;
- expanding one Claim loads only that Claim's candidates;
- candidates loading/ready/unavailable are local to EvidenceEditor;
- candidate failure keeps Issue/Claim/other Claims visible;
- retry calls only candidates API;
- ACTIVE/ARCHIVED Claim and archived Project still allow opening the read/preview editor.

- [ ] **Step 2: Write RED explicit-role selection tests**

No candidate is selected by default.

For a SOURCE candidate, expose explicit actions/controls:

```text
作为支持证据
作为反驳证据
作为背景证据
```

Pin:

- clicking one adds exactly one draft item with that role;
- same target cannot appear twice;
- role can be changed explicitly afterward;
- remove removes it;
- Move up/down changes draft order;
- optional note preserves internal whitespace/newline as typed; the server remains normalization authority.

- [ ] **Step 3: Write RED preview and invalidation tests**

Pin:

1. Preview button disabled/absent while draft empty;
2. preview sends current ordered items;
3. success displays:
   - item count;
   - 64-hex hash;
   - `尚未提交`;
   - `将在评价该 Claim 时冻结为 EvidenceManifest。`;
4. UI never displays a Manifest ID;
5. role change clears the prior preview;
6. note edit clears the prior preview;
7. reorder clears the prior preview;
8. add/remove clears the prior preview;
9. preview failure keeps draft editable and only editor displays safe error;
10. retry preview uses the current draft.

- [ ] **Step 4: Write RED no-persistence regression**

Spy/stub browser persistence APIs:

```ts
const sessionSet = vi.spyOn(Storage.prototype, "setItem");
const localSet = vi.spyOn(Storage.prototype, "setItem");
```

Prefer direct stubs for `window.sessionStorage.setItem` and `window.localStorage.setItem` so calls can be distinguished.

Perform candidate selection, note edit, reorder, and preview. Require zero writes to both storages.

Unmount/remount and assert the local draft is gone.

Do not add IndexedDB code; the absence of any indexedDB use is confirmed by source review and real browser acceptance.

- [ ] **Step 5: Run editor RED**

```bash
pnpm exec vitest run apps/web/src/research/EvidenceEditor.test.tsx --maxWorkers=1
```

- [ ] **Step 6: Implement EvidenceEditor**

State model:

```ts
type CandidateLoadState = "collapsed" | "loading" | "ready" | "unavailable";
type PreviewState =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "ready"; response: EvidencePreviewResponse }
  | { state: "unavailable"; message: string };
```

Keep `draft: LocalEvidenceItem[]` only in component state.

Every draft mutation calls one helper that updates draft and resets preview to `idle`.

- [ ] **Step 7: Integrate into Claim cards**

In `CandidateClaims.tsx`, inside each Claim article render:

```tsx
<EvidenceEditor
  token={token}
  projectId={project.id}
  issueId={issue.id}
  claim={claim}
/>
```

Do not couple EvidenceEditor candidates/preview to the existing Claim list request.

- [ ] **Step 8: Add responsive CSS**

Use existing research tokens. Add only:

- evidence editor container;
- candidate list;
- selected item row;
- role controls;
- note textarea;
- reorder/remove actions;
- preview card/hash wrapping.

Require `min-width:0`, `overflow-wrap:anywhere`, and 390px no-overflow behavior.

- [ ] **Step 9: Run UI GREEN**

```bash
pnpm exec vitest run   apps/web/src/research/EvidenceEditor.test.tsx   apps/web/src/research/CandidateClaims.test.tsx   apps/web/src/research/ResearchIssueDetail.test.tsx   apps/web/src/research/evidence-selection-api.test.ts   --maxWorkers=1
```

- [ ] **Step 10: Commit**

```bash
git add   apps/web/src/research/EvidenceEditor.tsx   apps/web/src/research/EvidenceEditor.test.tsx   apps/web/src/research/CandidateClaims.tsx   apps/web/src/research/CandidateClaims.test.tsx   apps/web/src/research/research.css
git commit -m "feat(s32): add claim evidence editor"
```

---

### Task 8: Fresh verification and real Firefox acceptance

**Files:**
- No product edits unless a real defect is first reproduced by a failing automated test.
- Evidence: ignored `logs/s32-m2c/` and `/home/conanxin/codex-artifacts/s32-m2c/`.

- [ ] **Step 1: Targeted API**

```bash
pnpm exec vitest run   apps/api/src/s32/domain/evidence-selection.test.ts   apps/api/src/s32/application/evidence-selection.test.ts   apps/api/src/s32/postgres/evidence-selection-store.test.ts   apps/api/src/s32/routes/evidence-selection-routes.test.ts   --maxWorkers=1
```

Record exact file/test counts.

- [ ] **Step 2: API S32 scoped**

```bash
pnpm exec vitest run apps/api/src/s32 --maxWorkers=1
```

Any new S32 failure blocks completion.

- [ ] **Step 3: Targeted Web**

```bash
pnpm exec vitest run   apps/web/src/research/evidence-selection-api.test.ts   apps/web/src/research/EvidenceEditor.test.tsx   apps/web/src/research/CandidateClaims.test.tsx   apps/web/src/research/ResearchIssueDetail.test.tsx   --maxWorkers=1
```

- [ ] **Step 4: Web research and broad Web**

```bash
pnpm exec vitest run apps/web/src/research --maxWorkers=1
pnpm exec vitest run apps/web --maxWorkers=1
```

- [ ] **Step 5: Builds/schema/diff**

```bash
pnpm --filter @book-id-search/api build
pnpm --filter @book-id-search/web build
pnpm s32:schema:static
git diff --check
git diff --exit-code origin/main --   db/migrations/001_s32_core_schema.sql   db/tests/001_s32_schema_assertions.sql   db/tests/002_s32_negative_invariants.sql
```

- [ ] **Step 6: Real PG16 zero-write gate**

```bash
pnpm s32:m2c:check
```

Require `S32_M2C_REAL_PG=PASS` and `DISPOSABLE_TEST_CONTAINER_REMOVED=YES`.

- [ ] **Step 7: Fresh full repository suite**

```bash
pnpm exec vitest run --maxWorkers=1 > logs/s32-m2c/full-suite-final.log 2>&1
```

Report exact pass/skip/fail/file/unhandled counts. Do not copy M2-B counts. Classify known unrelated failures only from fresh output/provenance.

- [ ] **Step 8: Firefox fixture setup**

Use real local API + Web + persistent dev PG. Reuse user-space Firefox if available; do not add Playwright to repo dependencies.

Create acceptance data through existing/local S32 paths or exact local SQL fixtures:

- ACTIVE Project with one Issue and one Claim;
- one Project Edition binding with valid Source;
- one SourceAsset under that Source, required for asset acceptance;
- one Project annotation Note with two immutable revisions, revision 2 current;
- a second Project with foreign Source/Asset/NoteRevision for privacy rejection.

Record exact fixture IDs in ignored acceptance log.

- [ ] **Step 9: Firefox candidate acceptance**

On Issue Detail:

1. Claim remains visible before editor expansion;
2. click `构建证据集`;
3. verify SOURCE candidate;
4. verify SOURCE_ASSET candidate;
5. verify current NOTE_REVISION candidate;
6. verify Note content/storage key/remote URI are not leaked;
7. archive Project/Issue/Claim in separate checks and verify candidates remain readable;
8. restore fixture lifecycle.

Record `BROWSER_CANDIDATES=PASS`.

- [ ] **Step 10: Firefox explicit roles + preview**

Select at least:

- one SUPPORTING item;
- one CONTRADICTORY item;
- one CONTEXTUAL item.

Require no default role assignment.

Add a multi-line note, preview, and record:

```text
persisted=false
schemaVersion=1
purpose=CLAIM_ASSESSMENT
manifestSha256=<actual 64-hex>
```

UI must visibly state `尚未提交` and must show no Manifest UUID.

Record `BROWSER_PREVIEW=PASS`.

- [ ] **Step 11: Firefox preview invalidation**

After successful preview, perform each mutation in turn with a re-preview between checks:

- role change;
- note edit;
- reorder;
- add item;
- remove item.

After each mutation, old hash display must disappear before any new preview call.

Record `PREVIEW_INVALIDATION=PASS`.

- [ ] **Step 12: Firefox old NoteRevision race**

Fetch candidates while revision 1 is current, then advance the Note to revision 2 before previewing the already-selected revision 1.

Preview revision 1 must still succeed because it belongs to the same authorized immutable Note.

Record `OLD_NOTE_REVISION_PREVIEW=PASS`.

- [ ] **Step 13: Firefox cross-Project target rejection**

Use the foreign Project target through a direct preview request from the current Project scope.

Require safe 404 `EVIDENCE_TARGET_NOT_AVAILABLE` without target existence/foreign Project detail.

Record `CROSS_PROJECT_EVIDENCE_REJECTED=PASS`.

- [ ] **Step 14: Firefox independent degradation**

Intercept candidates GET for one Claim only:

- Issue and Claim remain visible;
- other Claim evidence editors remain usable;
- failed editor shows local unavailable + retry;
- retry recovers.

Then intercept preview only and verify selected draft remains editable.

Record `EVIDENCE_INDEPENDENT_DEGRADATION=PASS`.

- [ ] **Step 15: Browser non-persistence + mobile**

Before interactions, capture sessionStorage/localStorage keys. Build and preview a draft, then assert no M2-C key/value was added. Reload and confirm the draft/preview are gone rather than falsely restored.

At 390x844 require:

```text
innerWidth == clientWidth == scrollWidth == 390
```

Record:

```text
DRAFT_BROWSER_PERSISTENCE=NONE
RELOAD_DRAFT_DISCARDED=YES
MOBILE_390=PASS
```

- [ ] **Step 16: Browser/DB zero-write proof**

Before and after all M2-C candidate/preview interactions, query exact counts for:

- evidence_manifests;
- evidence_manifest_items;
- assessments;
- issue_resolutions;
- research_runs;
- ops.idempotency_keys.

Require no M2-C-caused delta.

Record `BROWSER_ZERO_CANONICAL_WRITES=PASS`.

- [ ] **Step 17: Cleanup exact acceptance fixtures only**

Delete only M2-C acceptance fixtures and restore lifecycle changes. Preserve existing dev volume/data.

Record `ACCEPTANCE_TEMP_DATA_CLEANED=YES`.

- [ ] **Step 18: Whole-branch review**

Fresh reviewer focus:

1. declared source corruption;
2. old NoteRevision race;
3. cross-Project probing;
4. zero-write preview;
5. preview invalidation.

Critical/Important finding: reproduce RED, one fix pass, rerun affected + relevant broad gates. Minor findings are recorded without scope expansion.

---

### Task 9: Status, one PR, and synchronized handoff

**Files:**
- Modify: `AGENTS.md`
- Modify: `docs/STATUS.md`

- [ ] **Step 1: Update AGENTS.md only after all Task 8 gates**

Advance the local stage to M2-C Evidence Selection + Manifest Draft Preview. Explicitly keep:

```text
M2-D not authorized
production changes not authorized
frozen M0 SQL unchanged
```

- [ ] **Step 2: Write short STATUS checkpoint**

Include:

- task_id;
- actual source baseline;
- approved spec/plan commits;
- branch;
- tested commit/final head;
- fresh API/Web/PG/build/schema/full-suite counts;
- Firefox candidate/preview/invalidation/old-revision/privacy/degradation/non-persistence/zero-write/mobile results;
- frozen SQL unchanged;
- IMPLEMENTED/TESTED/COMMITTED/PUSHED/MERGED/DEPLOYED flags;
- next action = review the single M2-C PR.

- [ ] **Step 3: Final exact-head diff checks**

```bash
git diff --check
git status --short
git diff --exit-code origin/main --   db/migrations/001_s32_core_schema.sql   db/tests/001_s32_schema_assertions.sql   db/tests/002_s32_negative_invariants.sql
```

- [ ] **Step 4: Commit docs**

```bash
git add AGENTS.md docs/STATUS.md
git commit -m "docs(s32): record M2-C evidence selection"
```

- [ ] **Step 5: Re-run final-head critical verification**

```bash
pnpm exec vitest run   apps/api/src/s32/domain/evidence-selection.test.ts   apps/api/src/s32/application/evidence-selection.test.ts   apps/api/src/s32/postgres/evidence-selection-store.test.ts   apps/api/src/s32/routes/evidence-selection-routes.test.ts   apps/web/src/research/evidence-selection-api.test.ts   apps/web/src/research/EvidenceEditor.test.tsx   apps/web/src/research/CandidateClaims.test.tsx   apps/web/src/research/ResearchIssueDetail.test.tsx   --maxWorkers=1

pnpm --filter @book-id-search/api build
pnpm --filter @book-id-search/web build
git diff --check
```

Only after this run may `FINAL_HEAD` be called tested.

- [ ] **Step 6: Push feature branch**

```bash
git push -u origin feat/s32-m2c-evidence-selection
```

Never force-push on drift.

- [ ] **Step 7: Open exactly one M2-C PR**

Title:

```text
feat(s32): add evidence selection preview
```

PR body must distinguish:

- source baseline;
- approved spec/plan;
- tested/final head;
- zero-write architecture;
- exact fresh test counts;
- PG16 zero-write result;
- Firefox acceptance;
- frozen SQL unchanged;
- full-suite unrelated failures;
- production untouched;
- M2-D not started.

Do not merge.

- [ ] **Step 8: Sync Issue #2 and Notion**

Update:

1. GitHub Issue #2;
2. project overview `3dd34a28-189a-81d4-8f74-ec74593dac5f`;
3. M2-C design page `3e234a28-189a-81ee-a645-e3fb64fd5e2d`;
4. M2-C implementation-plan page created during planning;
5. overview Summary.

Read back every write. Failed sync remains `PENDING`.

- [ ] **Step 9: Final handoff**

Return:

```text
TASK_ID=S32_M2C_EVIDENCE_SELECTION_EXECUTION_R1
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
ZERO_WRITE_PG_GATE=
FROZEN_SQL_UNCHANGED=
GIT_DIFF_CHECK=

FULL_SUITE_RESULT=
FULL_SUITE_TEST_FAILURES=
FULL_SUITE_FILE_FAILURES=
FULL_SUITE_UNHANDLED_ERRORS=
KNOWN_UNRELATED_FAILURES=

BROWSER_CANDIDATES=
BROWSER_PREVIEW=
MANIFEST_SHA256=
PREVIEW_INVALIDATION=
OLD_NOTE_REVISION_PREVIEW=
CROSS_PROJECT_EVIDENCE_REJECTED=
EVIDENCE_INDEPENDENT_DEGRADATION=
DRAFT_BROWSER_PERSISTENCE=
RELOAD_DRAFT_DISCARDED=
BROWSER_ZERO_CANONICAL_WRITES=
MOBILE_390=
ACCEPTANCE_TEMP_DATA_CLEANED=

FINAL_REVIEW=
FINAL_REVIEW_BLOCKERS=
RULINGS=
DEFERRED_MINORS=

TESTED_COMMIT=
FINAL_HEAD=
PR_URL=
GITHUB_SYNC=
NOTION_SYNC=

M2_C_IMPLEMENTATION=COMPLETE_ON_BRANCH
M2_C_PR=OPEN
M2_C_MERGED=NO
PRODUCTION_CHANGED=NO
PRODUCTION_DEPLOYED=NO
M2_D_STARTED=NO
NEXT_ACTION=REVIEW_M2C_PR
```

Stop there. Do not merge, deploy, or start M2-D.

---

## Plan Self-Review Checklist

- **Spec coverage:** Tasks 1–7 implement every product requirement; Task 8 proves runtime/browser/zero-write boundaries; Task 9 only performs handoff.
- **No schema drift:** no task edits the M0 migration or either frozen SQL verification file.
- **Zero-write consistency:** candidate/preview store, routes, PG integration, browser acceptance, and final status all prohibit Manifest/Item/Assessment/ops writes.
- **Executable enum consistency:** role/target/source-type/asset-type/asset-role/storage-mode values come only from current schema.
- **Hash consistency:** server owns schemaVersion/purpose/ordinal/hash; fixed JSON order is defined once in Task 1; Web never computes or supplies trusted hash.
- **Scope consistency:** every API path uses Project -> exact owned Issue -> exact related Claim -> Project evidence graph.
- **Note race consistency:** candidates expose current revision; preview authorization accepts older immutable revision only when it belongs to the same authorized Note.
- **Privacy consistency:** foreign and nonexistent evidence targets share the same safe target-not-available behavior.
- **Browser draft consistency:** no persistence helper/storage key exists; reload discard is explicit and tested.
- **Epistemic boundary:** no Assessment/stance/confidence/resolution/AI evidence semantics enter M2-C.
- **Review Focus coverage:** all five listed risks have automated and/or real-PG/browser tests in their owning tasks.
