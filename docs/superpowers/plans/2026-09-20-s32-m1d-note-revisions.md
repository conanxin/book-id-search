# S32-M1D Project Item Note + Immutable Revisions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user create exactly one evolving research Note for one Project Edition binding, append immutable revisions with stale-write protection, inspect revision history, and prevent removing an Edition binding while that Note exists.

**Architecture:** Keep PostgreSQL `core.*` as canonical truth and reuse the existing S32 private/same-origin boundary. A NOTE ProjectBinding records project context through `metadata.subjectBindingId`; note creation, revision append, and Edition removal use explicit PostgreSQL transactions and row locks. Revisions are append-only; every edit supplies `baseRevisionId` and stale writes return 409.

**Tech Stack:** Node.js 22+, TypeScript, Express 5, PostgreSQL 16, pg, React 19, React Router, Vite, Vitest, Testing Library/jsdom, Docker for disposable PostgreSQL integration.

**Spec:** `docs/superpowers/specs/2026-09-20-s32-m1d-note-revisions-design.md`

## Global Constraints

- Baseline is `main@51c63b1dc45890bd5989d6bf6442d8ab7aaccc74` after merged PR #12.
- Do not modify `db/migrations/001_s32_core_schema.sql` or its frozen SQL verification files.
- Do not add tables, columns, indexes, triggers, ORM dependencies, rich-text/Markdown rendering frameworks, autosave, AI, Note search, tags, deletion, archive/restore, branch/merge UI, M1-E, or production deployment.
- One Project + Edition ProjectBinding has at most one active Note in M1-D.
- Note project context is represented by a NOTE ProjectBinding whose metadata includes `subjectBindingId`, `subjectType="EDITION"`, and `subjectId=<editionId>`.
- First Note creation must atomically create Note + Revision 1 + current revision pointer + NOTE ProjectBinding.
- Revision writes are append-only and require `baseRevisionId === notes.current_revision_id`; stale base returns conflict without changing current state.
- Normalize content line endings `CRLF→LF`, remaining `CR→LF`; require nonblank normalized content and UTF-8 byte length ≤ 65536.
- `content_sha256` is lowercase SHA-256 of the exact normalized UTF-8 content stored.
- Revision 1 has no parent; each later revision has exactly one parent equal to the previous current revision.
- Existing M1-C Edition removal must fail with conflict when a NOTE binding references that Edition binding.
- Note creation and Edition removal must lock the same Edition ProjectBinding row to avoid an orphaned note subject.
- S32 private requests remain same-origin under `/api/private/s32`; do not put tokens or DB URLs in `VITE_*`.
- Development trial PG remains persistent; automated integration uses a separate disposable PG16 database.
- No production SSH/write, registry publication, merge, or M1-E implementation in this plan.

## Review Focus

1. **Concurrent first-note creation:** two requests for the same Edition binding must produce exactly one Note/R1/NOTE binding; the loser gets a conflict, not a second Note.
2. **Concurrent revision saves from the same base:** exactly one new revision succeeds; the other receives stale conflict and must not create an extra revision number or alter current content.
3. **Race between Note creation and Edition removal:** locking must guarantee either removal wins before any Note exists or Note creation wins and removal is rejected; never orphan `subjectBindingId`.
4. **UTF-8 size and normalization edge cases:** multibyte content around 65536 bytes and CRLF/CR inputs must be judged on normalized UTF-8 bytes and hashed exactly as stored.
5. **Cross-project/cross-note identifier probing:** a valid revision UUID from another Project/Note must return 404 and never disclose that resource; stale UI responses or cleared token must not leave another project's Note visible.

---

## File Structure

### Backend

- Create `apps/api/src/s32/domain/note.ts`  
  Defines Note/Revision DTOs, UUID/content input validation, line-ending normalization, and SHA-256 helper.

- Create `apps/api/src/s32/application/project-item-notes.ts`  
  Defines the application service/store interfaces and typed domain/application errors.

- Create `apps/api/src/s32/postgres/project-item-note-store.ts`  
  Owns current/history reads, first Note transaction, revision append transaction, and project/item/note ownership checks.

- Modify `apps/api/src/s32/postgres/project-binding-store.ts`  
  Makes Edition removal transactional, locks the Edition binding row, and rejects removal if a NOTE ProjectBinding references it.

- Create `apps/api/src/s32/routes/project-item-note-routes.ts`  
  Exposes the four private Note endpoints and fixed safe HTTP error mapping.

- Modify `apps/api/src/s32/register.ts`  
  Wires the Note service/store to the existing shared Pool and mounts specific Note routes before generic project item routes where necessary.

- Tests:
  - `apps/api/src/s32/domain/note.test.ts`
  - `apps/api/src/s32/application/project-item-notes.test.ts`
  - `apps/api/src/s32/postgres/project-item-note-store.test.ts`
  - `apps/api/src/s32/routes/project-item-note-routes.test.ts`
  - extend `apps/api/src/s32/postgres/project-binding-store.test.ts`
  - `apps/api/src/s32/postgres/project-item-note-store.integration.test.ts`
  - `scripts/s32-m1d-integration-check.ts`

### Frontend

- Modify `apps/web/src/research/api.ts`  
  Adds typed Note/revision clients and the dedicated “project item has note” removal message.

- Create `apps/web/src/research/ProjectItemNote.tsx`  
  Owns Note load/create/edit/history/stale-conflict state.

- Create `apps/web/src/research/ProjectItemNote.test.tsx`

- Modify `apps/web/src/research/ProjectItems.tsx`  
  Mounts Note panel per Edition card and preserves current removal behavior/error state.

- Extend `apps/web/src/research/ProjectItems.test.tsx` only for integration of the Note trigger and removal conflict copy.

- Modify `apps/web/src/research/research.css` with namespaced Note styles only.

### Verification/docs

- Modify root `package.json` to add `s32:m1d:check`.
- Modify `AGENTS.md` only when execution reaches M1-D, preserving all production restrictions.
- Create `docs/operations/S32_M1D_LOCAL.md`.
- Modify `docs/STATUS.md` only after evidence exists.

---

### Task 1: Define Note content rules, DTOs, and application contracts

**Files:**
- Create: `apps/api/src/s32/domain/note.ts`
- Create: `apps/api/src/s32/domain/note.test.ts`
- Create: `apps/api/src/s32/application/project-item-notes.ts`
- Create: `apps/api/src/s32/application/project-item-notes.test.ts`

**Interfaces:**
- Produces:
  - `normalizeNoteContent(value: unknown): string`
  - `sha256NoteContent(content: string): string`
  - `readRevisionId(value: unknown): string`
  - `ProjectItemNote`
  - `ProjectItemNoteRevision`
  - `ProjectItemNoteRevisionSummary`
  - `ProjectItemNoteStore`
  - `createProjectItemNotesService(store)`
  - typed errors used by routes/store.

- [ ] **Step 1: Write failing domain tests for normalization, byte limits, and hashing**

Create `note.test.ts`:

```ts
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  normalizeNoteContent,
  readRevisionId,
  sha256NoteContent,
} from "./note.js";

describe("note content", () => {
  it("normalizes CRLF and bare CR without trimming user text", () => {
    expect(normalizeNoteContent("  第一行\r\n第二行\r第三行  "))
      .toBe("  第一行\n第二行\n第三行  ");
  });

  it.each([undefined, null, "", " \r\n \t ", 7, []])(
    "rejects blank or non-string content %j",
    value => expect(() => normalizeNoteContent(value)).toThrow("content"),
  );

  it("measures the normalized UTF-8 byte length at 64 KiB", () => {
    const exact = "a".repeat(65536);
    expect(normalizeNoteContent(exact)).toBe(exact);
    expect(() => normalizeNoteContent("a".repeat(65537))).toThrow("65536");
    expect(() => normalizeNoteContent("汉".repeat(21846))).toThrow("65536");
  });

  it("hashes the exact normalized content as lowercase SHA-256", () => {
    const content = normalizeNoteContent("a\r\nb");
    expect(sha256NoteContent(content)).toBe(
      createHash("sha256").update("a\nb", "utf8").digest("hex"),
    );
  });

  it("accepts UUID revision ids and rejects forged identifiers", () => {
    expect(readRevisionId("01234567-1234-4123-8123-123456789abc"))
      .toBe("01234567-1234-4123-8123-123456789abc");
    expect(() => readRevisionId("not-a-uuid")).toThrow("revision");
  });
});
```

- [ ] **Step 2: Run the domain test and verify RED**

```bash
corepack pnpm exec vitest run --maxWorkers=1 apps/api/src/s32/domain/note.test.ts
```

Expected: FAIL because `note.ts` does not exist.

- [ ] **Step 3: Implement minimal domain helpers and DTOs**

Create `note.ts`:

```ts
import { createHash } from "node:crypto";

export class InvalidNoteInputError extends Error {}

const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const MAX_NOTE_BYTES = 65536;

export interface ProjectItemNoteRevisionSummary {
  revisionId: string;
  revisionNo: number;
  createdAt: string;
}

export interface ProjectItemNoteRevision extends ProjectItemNoteRevisionSummary {
  contentFormat: "MARKDOWN";
  content: string;
  contentSha256: string;
}

export interface ProjectItemNote {
  noteId: string;
  projectId: string;
  subjectBindingId: string;
  subjectId: string;
  createdAt: string;
  updatedAt: string;
  currentRevision: ProjectItemNoteRevision;
  revisions: ProjectItemNoteRevisionSummary[];
}

export function normalizeNoteContent(value: unknown): string {
  if (typeof value !== "string") throw new InvalidNoteInputError("content must be text.");
  const normalized = value.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  if (!normalized.trim()) throw new InvalidNoteInputError("content must not be blank.");
  if (Buffer.byteLength(normalized, "utf8") > MAX_NOTE_BYTES) {
    throw new InvalidNoteInputError("content exceeds 65536 UTF-8 bytes.");
  }
  return normalized;
}

export function sha256NoteContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function readRevisionId(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new InvalidNoteInputError("revisionId is invalid.");
  }
  return value;
}
```

- [ ] **Step 4: Run domain tests and verify GREEN**

Expected: PASS.

- [ ] **Step 5: Write failing application-service tests**

Create `project-item-notes.test.ts` with a fake store and test:

```ts
it("normalizes content before create and hashes in the store contract", async () => {
  const store = fakeStore();
  const service = createProjectItemNotesService(store);

  await service.create(projectId, bindingId, { content: "a\r\nb" });

  expect(store.create).toHaveBeenCalledWith({
    projectId,
    bindingId,
    content: "a\nb",
    contentSha256: sha256NoteContent("a\nb"),
  });
});
```

Also pin:
- `get(projectId,bindingId)` validates both UUIDs before store access;
- `append(...,{baseRevisionId,content})` validates base UUID and normalized content;
- `getRevision(...,revisionId)` validates revision UUID;
- malformed input never calls store;
- store errors pass through unchanged for route mapping.

- [ ] **Step 6: Run application tests and verify RED**

```bash
corepack pnpm exec vitest run --maxWorkers=1 apps/api/src/s32/application/project-item-notes.test.ts
```

Expected: FAIL because service does not exist.

- [ ] **Step 7: Implement the store interface, errors, and thin service**

Define errors:

```ts
export class ProjectItemNotFoundError extends Error {}
export class ProjectItemInactiveError extends Error {}
export class ProjectItemNoteAlreadyExistsError extends Error {}
export class ProjectItemNoteNotFoundError extends Error {}
export class ProjectItemNoteRevisionNotFoundError extends Error {}
export class StaleNoteRevisionError extends Error {}
export class ProjectItemNoteStoreUnavailableError extends Error {}
export class ProjectItemHasNoteError extends Error {}
```

Define store:

```ts
export interface ProjectItemNoteStore {
  get(input: { projectId: string; bindingId: string }): Promise<ProjectItemNote | null>;

  create(input: {
    projectId: string;
    bindingId: string;
    content: string;
    contentSha256: string;
  }): Promise<ProjectItemNote>;

  appendRevision(input: {
    projectId: string;
    bindingId: string;
    baseRevisionId: string;
    content: string;
    contentSha256: string;
  }): Promise<ProjectItemNote>;

  getRevision(input: {
    projectId: string;
    bindingId: string;
    revisionId: string;
  }): Promise<ProjectItemNoteRevision>;
}
```

The service only validates identifiers/content and computes SHA-256 before calling store methods.

- [ ] **Step 8: Run Task 1 tests**

```bash
corepack pnpm exec vitest run --maxWorkers=1   apps/api/src/s32/domain/note.test.ts   apps/api/src/s32/application/project-item-notes.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit Task 1**

```bash
git add apps/api/src/s32/domain/note.ts         apps/api/src/s32/domain/note.test.ts         apps/api/src/s32/application/project-item-notes.ts         apps/api/src/s32/application/project-item-notes.test.ts
git commit -m "feat(s32): define project item note contracts"
```

---

### Task 2: Implement current/history reads and atomic first-Note creation

**Files:**
- Create: `apps/api/src/s32/postgres/project-item-note-store.ts`
- Create: `apps/api/src/s32/postgres/project-item-note-store.test.ts`

**Interfaces:**
- Consumes `ProjectItemNoteStore` and DTO/errors from Task 1.
- Produces `createPostgresProjectItemNoteStore(pool: Pool): ProjectItemNoteStore`.

- [ ] **Step 1: Write failing store projection/error tests**

Use mocked Pool/PoolClient to pin:
- connection errors map to `ProjectItemNoteStoreUnavailableError`;
- unexpected SQL error is rethrown;
- current Note projection returns current revision + revision summaries newest-first;
- malformed NOTE binding metadata is not silently accepted as another Edition subject.

- [ ] **Step 2: Run store unit tests and verify RED**

```bash
corepack pnpm exec vitest run --maxWorkers=1 apps/api/src/s32/postgres/project-item-note-store.test.ts
```

Expected: FAIL because store does not exist.

- [ ] **Step 3: Implement a shared subject-lock query**

Inside create transaction:

```sql
SELECT
  pb.id AS binding_id,
  pb.target_id AS edition_id,
  p.lifecycle_state AS project_state,
  e.lifecycle_state AS edition_state
FROM core.project_bindings pb
JOIN core.projects p ON p.id = pb.project_id
JOIN core.editions e
  ON pb.target_type = 'EDITION'
 AND e.id = pb.target_id
WHERE pb.id = $1
  AND pb.project_id = $2
  AND pb.target_type = 'EDITION'
FOR UPDATE OF pb
```

Rules:
- no row → `ProjectItemNotFoundError`;
- project not ACTIVE → `ProjectItemInactiveError`;
- Edition not ACTIVE → `ProjectItemInactiveError`.

Do not lock a different table instead; Task 3 removal must lock the same `pb` row.

- [ ] **Step 4: Query existing Note by subjectBindingId under the same lock**

```sql
SELECT pb.target_id AS note_id
FROM core.project_bindings pb
WHERE pb.project_id = $1
  AND pb.target_type = 'NOTE'
  AND pb.binding_role = 'ANNOTATION'
  AND pb.metadata->>'subjectBindingId' = $2
LIMIT 1
```

If any row exists, throw `ProjectItemNoteAlreadyExistsError`.

- [ ] **Step 5: Implement first Note + R1 + NOTE binding in one transaction**

Use generated UUIDs:

```sql
INSERT INTO core.notes (
  id, note_type, lifecycle_state, current_revision_id, next_revision_no, metadata
)
VALUES ($1, 'PROJECT_ITEM_NOTE', 'ACTIVE', NULL, 1, '{}'::jsonb);

INSERT INTO core.note_revisions (
  id, note_id, revision_no, title, content_format, content, content_sha256, change_summary
)
VALUES ($2, $1, 1, NULL, 'MARKDOWN', $3, $4, NULL);

UPDATE core.notes
SET current_revision_id = $2,
    next_revision_no = 2,
    updated_at = now()
WHERE id = $1;

INSERT INTO core.project_bindings (
  id, project_id, target_type, target_id, binding_role, metadata
)
VALUES (
  $5, $6, 'NOTE', $1, 'ANNOTATION',
  jsonb_build_object(
    'subjectBindingId', $7,
    'subjectType', 'EDITION',
    'subjectId', $8
  )
);
```

R1 has no row in `note_revision_parents`.

- [ ] **Step 6: Implement canonical current/history projection**

Load Note only through:
- project_id;
- NOTE binding;
- exact `metadata.subjectBindingId`;
- NOTE target;
- current revision belonging to that Note.

Revision summaries:

```sql
SELECT id, revision_no, created_at
FROM core.note_revisions
WHERE note_id = $1
ORDER BY revision_no DESC
```

Return `{note:null}` at route layer only when no NOTE binding exists. A malformed/inconsistent chain must raise a store/integrity error, never pretend Note is absent.

- [ ] **Step 7: Implement single revision read with ownership check**

Query must join Note binding by project + subjectBindingId and revision by note_id + revision id. A revision from another Note/Project returns not found.

- [ ] **Step 8: Run store unit tests**

Expected: PASS.

- [ ] **Step 9: Commit Task 2**

```bash
git add apps/api/src/s32/postgres/project-item-note-store.ts         apps/api/src/s32/postgres/project-item-note-store.test.ts
git commit -m "feat(s32): create project item notes transactionally"
```

---

### Task 3: Append immutable revisions with stale-write protection

**Files:**
- Modify: `apps/api/src/s32/postgres/project-item-note-store.ts`
- Modify: `apps/api/src/s32/postgres/project-item-note-store.test.ts`

**Interfaces:**
- Implements `ProjectItemNoteStore.appendRevision()`.

- [ ] **Step 1: Write failing append/stale tests**

Mock SQL expectations for:
- current note selected `FOR UPDATE`;
- baseRevisionId mismatch throws `StaleNoteRevisionError` before insert;
- successful R2 inserts one revision and one parent row;
- Note pointer and `next_revision_no` update;
- no UPDATE against `core.note_revisions`.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
corepack pnpm exec vitest run --maxWorkers=1   apps/api/src/s32/postgres/project-item-note-store.test.ts
```

Expected: new append tests FAIL.

- [ ] **Step 3: Implement locked current Note lookup**

Within a transaction:

```sql
SELECT
  n.id AS note_id,
  n.lifecycle_state,
  n.current_revision_id,
  n.next_revision_no
FROM core.project_bindings nb
JOIN core.notes n
  ON nb.target_type='NOTE'
 AND n.id=nb.target_id
WHERE nb.project_id=$1
  AND nb.binding_role='ANNOTATION'
  AND nb.metadata->>'subjectBindingId'=$2
FOR UPDATE OF n
```

Rules:
- missing → `ProjectItemNoteNotFoundError`;
- note not ACTIVE → `ProjectItemInactiveError`;
- missing current_revision_id → integrity/store error;
- base mismatch → `StaleNoteRevisionError`.

- [ ] **Step 4: Insert the new immutable revision and parent**

```sql
INSERT INTO core.note_revisions (
  id, note_id, revision_no, title, content_format, content, content_sha256, change_summary
)
VALUES ($1, $2, $3, NULL, 'MARKDOWN', $4, $5, NULL);

INSERT INTO core.note_revision_parents (
  note_id, child_revision_id, parent_revision_id, parent_order
)
VALUES ($2, $1, $6, 1);

UPDATE core.notes
SET current_revision_id=$1,
    next_revision_no=$3 + 1,
    updated_at=now()
WHERE id=$2;
```

Never update/delete an old revision.

- [ ] **Step 5: Return the refreshed current Note projection**

After update, read the Note/current/history in the same transaction and commit.

- [ ] **Step 6: Run Task 3 tests**

Expected: PASS.

- [ ] **Step 7: Commit Task 3**

```bash
git add apps/api/src/s32/postgres/project-item-note-store.ts         apps/api/src/s32/postgres/project-item-note-store.test.ts
git commit -m "feat(s32): append immutable note revisions"
```

---

### Task 4: Protect M1-C Edition removal once a Note exists

**Files:**
- Modify: `apps/api/src/s32/application/project-items.ts`
- Modify: `apps/api/src/s32/postgres/project-binding-store.ts`
- Modify: `apps/api/src/s32/postgres/project-binding-store.test.ts`
- Modify: `apps/api/src/s32/routes/project-item-routes.ts`
- Modify: `apps/api/src/s32/routes/project-item-routes.test.ts`

**Interfaces:**
- Consumes `ProjectItemHasNoteError` from Task 1.
- Changes `removeEdition()` semantics from a single DELETE to a short transaction with the same Edition-binding row lock used by Note creation.

- [ ] **Step 1: Write failing removal-guard tests**

Pin:
- remove locks exact Edition binding `FOR UPDATE`;
- wrong project/non-EDITION/missing binding remains not-found behavior;
- NOTE binding with matching `metadata.subjectBindingId` throws `ProjectItemHasNoteError`;
- no Note → delete succeeds;
- unexpected/connection failures retain current public-safe mapping.

Route test:

```ts
it("returns 409 when a project material already has a Note", async () => {
  service.remove.mockRejectedValue(new ProjectItemHasNoteError("PROJECT_ITEM_HAS_NOTE"));
  const response = await request(app)
    .delete(`/projects/${projectId}/items/${bindingId}`)
    .set("Authorization", "Bearer token");

  expect(response.status).toBe(409);
  expect(response.body.error.message).toBe("这项资料已有研究笔记，暂不能直接移出项目。");
});
```

- [ ] **Step 2: Run tests and verify RED**

```bash
corepack pnpm exec vitest run --maxWorkers=1   apps/api/src/s32/postgres/project-binding-store.test.ts   apps/api/src/s32/routes/project-item-routes.test.ts
```

- [ ] **Step 3: Implement transactional removal**

```text
BEGIN
SELECT target pb FOR UPDATE
validate exact project + EDITION
SELECT 1 FROM core.project_bindings
 WHERE project_id=$project
   AND target_type='NOTE'
   AND metadata->>'subjectBindingId'=$binding
 LIMIT 1
if exists → throw ProjectItemHasNoteError
DELETE exact Edition binding
COMMIT
```

Rollback on all failures. Do not delete NOTE/Note/Revision rows.

- [ ] **Step 4: Map `ProjectItemHasNoteError` to 409**

Return the exact user-facing message from Step 1. Do not collapse it into the generic M1-C 409 because the UI needs a precise safe explanation.

- [ ] **Step 5: Run Task 4 tests**

Expected: PASS.

- [ ] **Step 6: Commit Task 4**

```bash
git add apps/api/src/s32/application/project-items.ts         apps/api/src/s32/postgres/project-binding-store.ts         apps/api/src/s32/postgres/project-binding-store.test.ts         apps/api/src/s32/routes/project-item-routes.ts         apps/api/src/s32/routes/project-item-routes.test.ts
git commit -m "feat(s32): protect project material with notes"
```

---

### Task 5: Expose the private Note API and wire the shared Pool

**Files:**
- Create: `apps/api/src/s32/routes/project-item-note-routes.ts`
- Create: `apps/api/src/s32/routes/project-item-note-routes.test.ts`
- Modify: `apps/api/src/s32/register.ts`

**Interfaces:**
- Produces:
  - `GET /projects/:projectId/items/:bindingId/note`
  - `POST /projects/:projectId/items/:bindingId/note`
  - `POST /projects/:projectId/items/:bindingId/note/revisions`
  - `GET /projects/:projectId/items/:bindingId/note/revisions/:revisionId`

- [ ] **Step 1: Write failing auth/status/error tests**

For all four endpoints verify:
- S32 disabled 404;
- token not configured 503;
- missing token 401;
- wrong token 403;
- database/service unavailable 503;
- auth failure causes zero service calls;
- all responses have `Cache-Control: no-store`.

Map:
- malformed ids/body/content/size → 400;
- project/item/note/revision not found → 404;
- inactive project/item/note → 409;
- Note exists → 409;
- stale revision → 409 with a distinct safe message;
- store unavailable → 503;
- unexpected secret-bearing Error → generic 500 without secret content.

- [ ] **Step 2: Run route tests and verify RED**

```bash
corepack pnpm exec vitest run --maxWorkers=1 apps/api/src/s32/routes/project-item-note-routes.test.ts
```

- [ ] **Step 3: Implement route handlers**

```ts
router.get("/:projectId/items/:bindingId/note", ...);
router.post("/:projectId/items/:bindingId/note", ...);
router.post("/:projectId/items/:bindingId/note/revisions", ...);
router.get("/:projectId/items/:bindingId/note/revisions/:revisionId", ...);
```

Success:
- GET no Note → 200 `{note:null}`;
- create → 201 `{note}`;
- append → 201 `{note}`;
- get revision → 200 `{revision}`.

- [ ] **Step 4: Wire one Note store/service to the existing shared Pool**

In `register.ts`:
- do not create another Pool;
- instantiate `createPostgresProjectItemNoteStore(pool)`;
- instantiate `createProjectItemNotesService(store)`;
- mount the Note router under `/projects`.

Mount **specific Note routes before** the generic `/:projectId/items/:bindingId` DELETE or prove by HTTP tests that Express method/path routing cannot shadow them.

- [ ] **Step 5: Run S32 route regressions**

```bash
corepack pnpm exec vitest run --maxWorkers=1   apps/api/src/s32/routes/project-item-note-routes.test.ts   apps/api/src/s32/routes/project-item-routes.test.ts   apps/api/src/s32/routes/project-routes.test.ts   apps/api/src/s32/routes/catalog-promotion-route.test.ts
```

Expected: PASS.

- [ ] **Step 6: Build API**

```bash
corepack pnpm --filter @book-id-search/api build
```

Expected: exit 0.

- [ ] **Step 7: Commit Task 5**

```bash
git add apps/api/src/s32/routes/project-item-note-routes.ts         apps/api/src/s32/routes/project-item-note-routes.test.ts         apps/api/src/s32/register.ts
git commit -m "feat(s32): expose private project item note API"
```

---

### Task 6: Prove Note/Revision invariants on real PostgreSQL 16

**Files:**
- Create: `apps/api/src/s32/postgres/project-item-note-store.integration.test.ts`
- Create: `scripts/s32-m1d-integration-check.ts`
- Modify: root `package.json`

**Interfaces:**
- Produces `pnpm s32:m1d:check`.
- Uses unchanged M0 migration and real M1-C promotion/binding components to create realistic Edition bindings.

- [ ] **Step 1: Add the root script**

```json
"s32:m1d:check": "tsx scripts/s32-m1d-integration-check.ts"
```

- [ ] **Step 2: Add isolated DB guard**

Integration test reads only `S32_M1D_TEST_DATABASE_URL` and rejects anything except:

```text
host=127.0.0.1
database=/s32_m1d_test
```

- [ ] **Step 3: Write the core real-PG scenario**

Using Project A + promoted Edition X + Edition ProjectBinding:

1. create R1;
2. assert:
   - notes=1;
   - note_revisions=1;
   - note_revision_parents=0;
   - NOTE binding=1;
   - current_revision_id=R1;
   - next_revision_no=2;
   - SHA equals stored normalized content.
3. repeat create → `ProjectItemNoteAlreadyExistsError`, counts unchanged.
4. two concurrent create calls on a fresh Edition binding → exactly one success and one conflict; one Note only.

- [ ] **Step 4: Prove immutable revision append + stale conflict**

Append R2 from R1:
- snapshot R1 row before;
- append;
- compare R1 row byte/field-equivalent after;
- R2 revision_no=2;
- parent row exactly `R2 → R1`;
- current=R2;
- next=3.

Then launch two concurrent append calls with base=R2:
- one succeeds as R3;
- one throws `StaleNoteRevisionError`;
- only one revision_no=3 exists;
- current points to that R3.

- [ ] **Step 5: Prove cross-project isolation**

Bind the same Edition X into Project B and create its Note:
- Project B Note id differs from Project A Note id;
- Project B starts at revision_no=1;
- reading Project A with B revision UUID returns revision-not-found;
- reading Project B with A revision UUID returns revision-not-found.

- [ ] **Step 6: Prove Edition removal race safety and guard**

First deterministic guard:
- Note exists → M1-C removal throws `ProjectItemHasNoteError`;
- Edition binding, NOTE binding, Note, all revisions remain.

Then use two clients/promises against a fresh binding to overlap:
- create first Note;
- remove Edition.
Accept only these valid serializable-by-lock outcomes:
  - remove commits first and Note create returns item-not-found; no Note rows;
  - Note create commits first and remove returns has-note; binding + Note remain.
Reject any outcome where Note exists while Edition binding is gone.

- [ ] **Step 7: Prove transaction rollback**

Use a temporary test trigger/function or transaction-local fault injection only inside disposable PG to force failure after R1 insert but before Note binding insert. After rollback assert zero Note/Revision/NOTE binding rows for that subject.

Do not modify the migration file.

- [ ] **Step 8: Prove no unrelated domain writes**

Allowed additions for M1-D fixture:
- projects
- works
- editions
- sources
- external_identities
- project_bindings
- notes
- note_revisions
- note_revision_parents

All other `core/ops/derived` tables remain zero.

- [ ] **Step 9: Build disposable PG16 runner**

Follow M1-C runner:
- unique container name;
- `postgres:16-alpine`;
- tmpfs PG data;
- random loopback port/password;
- ownership label `book-id-search.s32-m1d-run=<name>`;
- apply unchanged migration;
- run only M1-D integration file;
- verify ownership before removal;
- print:
  - `S32_M1D_REAL_PG=PASS`
  - `DISPOSABLE_TEST_CONTAINER_REMOVED=YES`.

- [ ] **Step 10: Run**

```bash
corepack pnpm s32:m1d:check
```

Expected: PASS.

- [ ] **Step 11: Commit Task 6**

```bash
git add apps/api/src/s32/postgres/project-item-note-store.integration.test.ts         scripts/s32-m1d-integration-check.ts package.json
git commit -m "test(s32): verify M1D note revisions on PostgreSQL"
```

---

### Task 7: Add typed Note clients and ProjectItemNote UI

**Files:**
- Modify: `apps/web/src/research/api.ts`
- Create: `apps/web/src/research/ProjectItemNote.tsx`
- Create: `apps/web/src/research/ProjectItemNote.test.tsx`
- Modify: `apps/web/src/research/ProjectItems.tsx`
- Modify: `apps/web/src/research/ProjectItems.test.tsx`
- Modify: `apps/web/src/research/research.css`

**Interfaces:**
- Produces web DTOs matching Task 1:
  - `ProjectItemNote`
  - `ProjectItemNoteRevision`
  - `ProjectItemNoteRevisionSummary`
- Produces clients:
  - `getProjectItemNote(token, projectId, bindingId, signal?)`
  - `createProjectItemNote(token, projectId, bindingId, content, signal?)`
  - `appendProjectItemNoteRevision(token, projectId, bindingId, baseRevisionId, content, signal?)`
  - `getProjectItemNoteRevision(token, projectId, bindingId, revisionId, signal?)`
- Produces `ProjectItemNotePanel({token, projectId, item})`.

- [ ] **Step 1: Write failing API-client tests**

Pin:
- all Note URLs are same-origin under `/api/private/s32/projects`;
- POST create sends only `{content}`;
- POST append sends only `{baseRevisionId,content}`;
- no automatic POST retry;
- GET `{note:null}` is accepted;
- malformed Note/revision payload returns client-side 502 error;
- 409 stale message is distinct from generic conflict;
- 409 removal guard is displayed as “这项资料已有研究笔记，暂不能直接移出项目。”.

- [ ] **Step 2: Implement typed Note clients**

Keep the existing private request helper; extend it carefully so:
- DELETE 204 still works;
- Note GET can validate nullable Note;
- full revision and summary shapes are checked;
- server response body is never reflected directly as an arbitrary message.

- [ ] **Step 3: Write failing `ProjectItemNotePanel` component tests**

Cover:
- closed initial trigger “研究笔记” performs no Note request until opened;
- open + no Note → textarea/create UI;
- blank UI save disabled;
- create success renders current R1;
- existing Note renders current content and history summaries;
- edit prefills exact current content;
- successful save R2 updates current and history;
- stale 409 preserves draft text and shows reload-latest action;
- reload latest updates base revision but does not silently overwrite draft until user chooses; use two explicit actions:
  - “重新加载最新版本” → update displayed latest and keep draft in a separate warning block;
  - “用最新版本重新编辑” → replace textarea only after explicit click.
- failed create/save leaves current UI unchanged;
- clicking history loads immutable content read-only;
- cross-request/unmount abort prevents stale response from changing UI;
- token/project/binding key changes clear previous Note content immediately.

- [ ] **Step 4: Implement the Note panel state machine**

Recommended states:
- `closed`
- `loading`
- `empty`
- `reading`
- `editing`
- `history`

Keep:
- `note`
- `draft`
- `staleDraft`
- `selectedRevision`
- `error`
- `saving`

No autosave, debounce, Markdown HTML, localStorage draft persistence, or global state.

- [ ] **Step 5: Mount Note panel inside each Project material card**

In `ProjectItems.tsx`:

```tsx
<ProjectItemNotePanel
  token={token}
  projectId={projectId}
  item={item}
/>
```

Place it between bibliographic fields/actions and the card end.

Do not load all notes merely because the project item list rendered; Note GET happens when the user opens that material's Note panel.

- [ ] **Step 6: Preserve removal conflict in ProjectItems**

When `removeProjectItem` receives the dedicated 409 client error, keep the Edition item visible and show the dedicated message. Do not close/discard an open Note panel.

- [ ] **Step 7: Add namespaced CSS**

Use only:
- `.research-note*`
- existing `.research-*` primitives.

Textarea should resize vertically, preserve whitespace, and fit 390px viewport without fixed width.

- [ ] **Step 8: Run research tests**

```bash
corepack pnpm exec vitest run --maxWorkers=1 apps/web/src/research
```

Expected: PASS.

- [ ] **Step 9: Build Web**

```bash
corepack pnpm --filter @book-id-search/web build
```

Expected: exit 0; report existing bundle warning if present.

- [ ] **Step 10: Commit Task 7**

```bash
git add apps/web/src/research/api.ts         apps/web/src/research/ProjectItemNote.tsx         apps/web/src/research/ProjectItemNote.test.tsx         apps/web/src/research/ProjectItems.tsx         apps/web/src/research/ProjectItems.test.tsx         apps/web/src/research/research.css
git commit -m "feat(s32): add versioned research note UI"
```

---

### Task 8: Run complete scoped verification and real browser acceptance

**Files:**
- Create: `docs/operations/S32_M1D_LOCAL.md`
- Modify: `AGENTS.md`
- Modify: `docs/STATUS.md` only after evidence exists.

**Interfaces:**
- Produces the final M1-D `tested_commit` and reproducible evidence.

- [ ] **Step 1: Advance AGENTS local authorization to M1-D**

Replace the M1-C-only local stage sentence with:

```text
Current authorized local stage is M1-D: one versioned Note per Project EDITION binding, immutable NoteRevision append/history, stale-write protection, and an Edition-removal guard when a Note exists. Keep M0 migration/frozen SQL unchanged. No M1-E or production changes are authorized.
```

Preserve all production restrictions.

- [ ] **Step 2: Write local runbook**

`docs/operations/S32_M1D_LOCAL.md` documents:
- reuse of existing persistent development PG and S32 token;
- M1-D requires an existing M1-C Edition project item;
- disposable `pnpm s32:m1d:check` never touches trial volume;
- exact API/Web start commands;
- browser acceptance sequence;
- evidence dirs `logs/s32-m1d/` and `/home/conanxin/codex-artifacts/s32-m1d/`;
- never `down -v`.

- [ ] **Step 3: Run scoped S32 backend unit/static tests**

```bash
corepack pnpm exec vitest run --maxWorkers=1   apps/api/src/s32   scripts/s32-schema-contract.test.ts   --exclude '**/*.integration.test.ts'
```

Record exact files/tests; expected 0 failures.

- [ ] **Step 4: Run real PG16 M1-D integration**

```bash
corepack pnpm s32:m1d:check
```

Expected PASS and own container removed.

- [ ] **Step 5: Run affected Web/search regressions**

At minimum:

```bash
corepack pnpm exec vitest run --maxWorkers=1   apps/web/src/research   apps/web/src/EditionCompare.test.tsx   apps/api/src/search   apps/api/src/handle-search.test.ts
```

Expected 0 failures.

- [ ] **Step 6: Build API and Web**

```bash
corepack pnpm --filter @book-id-search/api build
corepack pnpm --filter @book-id-search/web build
```

Expected exit 0 / 0.

- [ ] **Step 7: Prove frozen DB files unchanged**

```bash
git diff --exit-code 51c63b1dc45890bd5989d6bf6442d8ab7aaccc74 --   db/migrations/001_s32_core_schema.sql   db/tests/001_s32_schema_assertions.sql   db/tests/002_s32_negative_invariants.sql
```

Expected empty output.

- [ ] **Step 8: Real browser acceptance on existing local project**

Use “北京古道研究” and one real M1-C material. If the prior M1-C browser acceptance removed its item, explicitly add one real catalog book again through the normal UI first; do not SQL-insert a fake project item.

Perform:

```text
1. Open project detail.
2. Expand 研究笔记 on one Edition material.
3. Create R1 with recognizable multiline content including CRLF-equivalent typing/paste.
4. Refresh → R1 remains.
5. Edit and save R2.
6. Current content shows R2; history lists R2/R1.
7. Open R1 → original content unchanged.
8. Simulate stale edit using a second tab:
   - both load R2;
   - tab A saves R3;
   - tab B tries save based on R2;
   - tab B receives conflict and preserves its draft.
9. Restart local API and development PG, preserving volume.
10. Reopen → current/history remain.
11. Try 移出项目 on this Edition → 409 dedicated message; Edition item + Note remain.
12. On another Edition item with no Note, verify M1-C removal still succeeds.
13. Check 390px width for note editor/history with no horizontal overflow.
```

- [ ] **Step 9: Capture database receipts**

Local SQL/API receipt must show for the tested Note:
- one ACTIVE Note;
- revision numbers sequential;
- current pointer = latest;
- next_revision_no = latest+1;
- one NOTE ProjectBinding with correct subjectBindingId;
- R2 parent R1, R3 parent R2;
- old content/hash unchanged;
- no Claim/Assessment/etc writes caused by Note operations.

Do not expose token/password in logs.

- [ ] **Step 10: Run failure checks without destructive cleanup**

Check:
- wrong token;
- DB stopped → Note GET/save 503, no false empty/success;
- malformed/oversize content via HTTP;
- foreign revision UUID returns 404;
- cancel edit keeps current Note untouched.

Restore local PG/API afterward.

- [ ] **Step 11: Run `git diff --check`**

```bash
git diff --check
```

Expected exit 0.

- [ ] **Step 12: Record verified status and commit**

Only after Steps 3–11:

```bash
git add AGENTS.md docs/operations/S32_M1D_LOCAL.md docs/STATUS.md         apps/api apps/web package.json scripts
git status --short
git commit -m "docs(s32): record M1D local verification"
```

If browser/integration verification exposes a product defect, fix it in a separate code commit, rerun affected checks, and record the actual final `tested_commit`.

---

### Task 9: Open one M1-D review PR and synchronize GitHub + Notion

**Files:**
- No new product work unless final verification found a defect.
- `docs/STATUS.md` may receive only exact receipts.

**Interfaces:**
- Produces one M1-D PR and synchronized `task_id/tested_commit/PR URL`.

- [ ] **Step 1: Confirm actual branch ancestry and cleanliness**

```bash
git fetch origin
git merge-base --is-ancestor 51c63b1dc45890bd5989d6bf6442d8ab7aaccc74 HEAD
git status --short
```

If remote main moved, compare before rebase; do not reset blindly.

- [ ] **Step 2: Push feature branch**

Recommended:

```text
feat/s32-m1d-note-revisions
```

- [ ] **Step 3: Open one PR against main**

PR body includes:

```text
task_id=S32_M1D_NOTE_REVISIONS_R1
source_baseline=<actual SHA>
tested_commit=<actual SHA>

IMPLEMENTED=YES
TESTED=<exact scoped result>
COMMITTED=YES
PUSHED=YES
MERGED=NO
DEPLOYED=NO
PRODUCTION_CHANGED=NO
M1_E_STARTED=NO
```

Include exact:
- backend/research test counts;
- real PG result;
- browser acceptance;
- frozen SQL diff;
- known NOT_RUN/failures;
- artifact/log paths.

- [ ] **Step 4: Update Issue #2 once**

Only phase checkpoint:
- PR;
- tested commit;
- scoped verification;
- notable limitations;
- production unchanged;
- next gate = PR review.

- [ ] **Step 5: Update existing M1-D Notion design page and project overview**

Use the same task id/tested commit/PR URL/flags. Create no second canonical M1-D page unless an Implementation Plan page already exists from planning.

Record:
- what user can do;
- revision safety model;
- evidence;
- unresolved limitations;
- next gate.

- [ ] **Step 6: Read back GitHub + Notion**

Verify all contain identical:
- task_id;
- tested_commit;
- PR URL;
- MERGED/DEPLOYED;
- M1_E_STARTED.

Failed sync is `PENDING`, not success.

- [ ] **Step 7: Stop at review gate**

Expected state:

```text
M1_D_IMPLEMENTATION=COMPLETE_ON_BRANCH
M1_D_VERIFICATION=PASS_SCOPED
M1_D_PR=OPEN
M1_D_MERGED=NO
PRODUCTION_CHANGED=NO
M1_E_STARTED=NO
```

Do not merge, deploy, remove worktrees/volumes, or start M1-E automatically.

---

## Self-Review Result

### Spec coverage

Covered:
- one Note per Project Edition binding → Tasks 2/6;
- NOTE ProjectBinding subjectBindingId model → Tasks 2/6;
- CRLF normalization, size, hash → Tasks 1/6;
- atomic Note+R1+binding creation → Tasks 2/6;
- immutable revision append and parent chain → Tasks 3/6;
- stale base 409/concurrency → Tasks 3/5/6/7;
- current/history/single revision reads → Tasks 2/5/7;
- cross-project isolation → Task 6;
- removal guard and create/remove race → Tasks 4/6;
- same-origin S32 client/UI → Task 7;
- no autosave/delete/archive/restore/Markdown HTML → Global Constraints + Task 7;
- real browser refresh/restart/stale tab/history/removal guard → Task 8;
- GitHub/Notion synchronization → Task 9;
- no schema or production changes → Global Constraints + Tasks 8/9.

No uncovered spec requirement found.

### Placeholder scan

Placeholder scan found no unresolved markers, generic error-handling steps, deferred implementation notes, or undefined downstream interfaces.

### Type consistency

Checked:
- Note/Revision DTO names match backend and frontend plan usage.
- create/append/read method signatures use `projectId + bindingId`; append adds `baseRevisionId`.
- NOTE relationship consistently uses `metadata.subjectBindingId`.
- revision ownership checks always include Note/project subject context.
- Edition removal conflict consistently uses `ProjectItemHasNoteError`.

### Review Focus coverage

1. Concurrent first-note creation → Task 6.
2. Concurrent same-base revision append → Task 6.
3. Note-create vs Edition-remove race → Tasks 4/6.
4. UTF-8/normalization boundary → Tasks 1/6.
5. Cross-project UUID probing and stale UI/token state → Tasks 5/6/7/8.
