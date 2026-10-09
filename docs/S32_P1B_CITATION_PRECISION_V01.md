# S32 P1-B — Evidence citation scope v0.1 (read-only)

TASK_ID: `S32_P1B_CITATION_PRECISION_IMPLEMENTATION_R1`
Date: 2026-10-09
Phase: **READ_ONLY_SOURCE_LEVEL_DISCLOSURE**; locator-domain expansion remains **PENDING_REVIEW**.

## Observed source of truth

- [M2-C accepted design](https://app.notion.com/p/3e234a28189a81eea645e3fb64fd5e2d) explicitly excludes PDF page/bbox/timecode/DOM locators and fixes canonical v1 items' `locatorType`, `locator`, and `excerpt` to `null`. An evidence `note` is the researcher's note and is **not** a verified quotation.
- `db/migrations/001_s32_core_schema.sql` declares nullable `locator_type`, `locator`, `excerpt` on `core.evidence_manifest_items`, and enforces paired locator fields. **Available DB columns do not imply active domain support or validated page identities.**
- `apps/web/src/research/api.ts` validates all three as exactly `null` for v1 Manifest previews and frozen Assessment/Resolution detail items. A non-v1 response must fail contract validation rather than quietly become an authenticated source citation.
- `ResearchDossierPage` displays verified **project binding** deep-links only when eligible source/asset/note revision mapping is uniquely authorized; their path is `/research/projects/:projectId?item=:bindingId`. It is not a PDF URL or confirmed page location.
- For partial/denied source mappings, current view must preserve **not verified or not accessible** rather than reconstructing a private target ID or fabricating a link. Fingerprint SHA-256 identifies the serialized Manifest, **not** source-file bytes or quotation authenticity.

## Three strictly distinct meanings

| State | What has been verified? | What cannot be claimed? |
| --- | --- | --- |
| Catalog metadata match | Discovery-layer candidate record and parse hints | User owns or read the full book; historical statement proven |
| Authorized frozen Evidence target | Project-scoped Source / SourceAsset / NoteRevision identity and role | Page, plate, original excerpt, photo pixel coordinate, PDF anchor |
| Page/plate/paragraph-level locator (future gate) | *Not implemented in the v1 API*. Will require explicit Edition/Asset + locator-type validation, witness/provenance and independent authorization | Must never infer from Project Binding, free-text note, SHA-256, LLM output |

## This PR / R1 scope

1. A shared read-only `EvidenceCitationScope` component discloses that **v1 frozen items record evidence objects, not source pages/plates/excerpts**, without inventing source fields, URLs or write APIs.
2. AssessmentDetail and IssueResolutionDetail disclose this boundary **only when the corresponding authorized Manifest detail has actually been retrieved**. Unknown/unavailable evidence continues to show the existing neutral error, not a confident statement.
3. Dossier header, Assessment detail, Resolution detail, and Run snapshot explain the same source-level boundary. The Dossier source index and Run-generated note link label explicitly says **project material**, not "verified quotation". Missing mappings yield no fake href.
4. No `apps/api`, `db`, migration, auth/provider, storage, search index, Google login, or production environment changes.

## Negative acceptance and epistemic safety

- Empty/no authorized manifest does not generate a claim that a verified page exists.
- No `locatorType`, `locator`, `excerpt`, storage key, URL or full-text snippet is manufactured.
- Free-text research note cannot be silently recast as a verbatim quotation.
- Dossier project deep link remains exactly the authorized ProjectBinding, not a guessed remote document URL.
- 404/503/revoked/partial scope must preserve existing privacy and source-resolution errors. Authenticated project references still require actual API success.
- Existing model/reader concurrency, D01-A timelines, M2/M3 contracts, original source/asset authority and production schema remain unchanged.

## Next independently reviewed contract Gate: P1-B R2 (NOT APPROVED)

Before accepting typed locator data, define:

- Edition/Source/SourceAsset identity and version compatibility, and what exact original bytes or archival frame were witnessed.
- Locator vocabularies for printed page/range, plate/figure, PDF page+bbox, archival folio, website DOM anchor, audio timestamp, field observation, with validation and explicit **unknown**.
- Whether a locator is *reported*, *transcribed*, *visually verified* or *revoked*, by whom, against which verified edition/asset; distinguish researcher's annotation from source quote.
- Changes in authorization, partial source visibility, stale/revoked assets, cross-edition pagination, append-only Manifest/Run replay behavior, and how older null-locator v1 records remain readable.
- Contract, migration and rollback gates separately reviewed, with synthetic PG16 data first. Frozen `001_s32_core_schema.sql` must never be edited in place.

**This R1 is a presentation-only trust improvement**, not the next locator storage schema or "verified citation" product release.

```text
TASK_ID=S32_P1B_CITATION_PRECISION_IMPLEMENTATION_R1
SCOPE=READ_ONLY
LOCATOR_WRITE=NOT_IMPLEMENTED
SOURCE_LEVEL_LINK=PROJECT_BINDING_ONLY
VERIFIED_PAGE_LINK=NONE
SCHEMA_CHANGE=NO
MIGRATION_CHANGE=NO
PR_STACKED_ON=58_OPEN_DRAFT
MAIN_CHANGED=NO
PRODUCTION_CHANGED=NO
MERGE=HOLD
```
