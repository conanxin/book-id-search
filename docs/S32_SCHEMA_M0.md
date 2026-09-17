# S32 Canonical Research Layer — M0 Schema

## Scope
- 22 core physical tables (frozen from R2 + R3 recovery bundle)
- 4 ops physical tables (frozen from P29-D3)
- 0 concrete derived physical tables in M0 (`derived` schema reserved but empty)
- 5 frozen trigger contracts (P29-C frozen + R3 expanded)
- 2 deferred composite current-pointer FKs (notes, research_issues)
- D2 frozen indexes (ISBN/SHA/partial-unique/FK-side lookup)

## M0 != Production PostgreSQL deployment
M0 is an executable schema migration + empty-DB install gate.
- No Production PostgreSQL deployment
- No API DB connection wired
- No Web/Meili runtime changes
- Production runtime remains Meilisearch + Express (unchanged)

## Architecture boundary
- canonical truth ≠ projection (Meilisearch remains derived)
- 5,115,734 catalog docs NOT bulk-copied to canonical PostgreSQL
- core MUST NOT depend on ops
- polymorphic ops refs do not hard-FK to core entities
- application-only invariants NOT promoted to SQL triggers
  (archival-write-gate, dag-deep-cycle, optimistic-concurrency-cas, etc.)

## Migration order (dependency-aware)
1. CREATE SCHEMA core / ops / derived
2. B1: actors, works, editions
3. B2: sources, source_assets, source_asset_parents, external_identities
4. B3: notes, note_revisions, note_revision_parents
5. B4: claims, claim_relations, evidence_manifests, evidence_manifest_items, research_issues, research_issue_claims, research_runs, assessments, issue_resolutions
6. B5: projects, project_bindings, contributions
7. ops: outbox_events, idempotency_keys, integrity_check_runs, projection_generations
8. D2 indexes (13 total: 9 core + 4 ops)
9. POST-CREATE composite circular FKs (deferred):
   - notes(id, current_revision_id) -> note_revisions(note_id, id)
   - research_issues(id, current_resolution_id) -> issue_resolutions(issue_id, id)
10. 5 trigger contracts (P29-C + R3)

## DB vs application invariant boundary
| Invariant | Layer |
|---|---|
| NOTE_CURRENT_POINTER_SAME_NOTE | DB (deferred composite FK) |
| NOTE_PARENT_SAME_NOTE | DB (composite FK) |
| NOTE_PARENT_SELF_EDGE | DB (CHECK) |
| ISSUE_CURRENT_RESOLUTION_SAME_ISSUE | DB (deferred composite FK) |
| SOURCE_ASSET_STORAGE_MODE | DB (CHECK) |
| EXTERNAL_IDENTITY_ACTIVE_BINDING | DB (partial unique INDEX) |
| RELATIONAL allowlist (TEXT+CHECK) | DB |
| SHA-256 format checks | DB |
| NOTE_REVISION_IMMUTABILITY | DB trigger (reject UPDATE/DELETE) |
| CLAIM_STATEMENT_IMMUTABLE | DB trigger (reject UPDATE of proposition fields) |
| ASSESSMENT_APPEND_ONLY | DB trigger (reject UPDATE/DELETE) |
| MANIFEST_IMMUTABLE | DB trigger (reject UPDATE/DELETE on manifests+items) |
| TERMINAL_RUN_IMMUTABILITY | DB trigger (terminal reject UPDATE/DELETE; RUNNING allows status/completed_at/output/environment only) |
| ARCHIVE_WRITE_GATE | application |
| DAG_DEEP_CYCLE_RULE | application + integrity |
| OPTIMISTIC_CONCURRENCY_CAS | application |
| CREATE_CONFLICT_BRANCH / MERGE | application |
| SYMMETRIC_CLAIM_RELATION_CANONICALIZATION | application + integrity |
| POLYMORPHIC_TARGET_VALIDATION | application |
| PURGE_REVOKE_PRIVACY_PROPAGATION | application lifecycle |
| RESEARCH_RUN_REPLAY_CREATES_NEW_RUN | application |

## Validation commands
```bash
pnpm s32:schema:static   # vitest static contract test (DB-less text scan)
pnpm s32:schema:check    # disposable postgres:16-alpine container, fresh DB A+B, assertions
```

## File map
- `db/migrations/001_s32_core_schema.sql` — 517 lines, sha=2ab45d2b2b1ff378e3c74dfa78497c35eb472d596e74aa0d4cda19e7ca77d798
- `scripts/s32-schema-contract.test.ts` — static contract test (vitest)
- `scripts/s32-schema-check.ts` — disposable PG16 harness (docker CLI, tmpfs PGDATA)
- `db/tests/001_s32_schema_assertions.sql` — runtime schema assertions
- `db/tests/002_s32_negative_invariants.sql` — negative invariant tests

## Next gate
S32-M0 PR review / merge gate, then S32-M1 PostgreSQL runtime integration planning.
M0 does NOT auto-deploy to production.
