# S32 P1-B R2 — Locator v2 Draft Contract Spike (NO WRITE)

Task: `S32_P1B_R2_LOCATOR_CONTRACT_SPIKE`  
Date: 2026-10-10  
Scope: **STRICT LOCAL MODEL + TESTS**; authorization, source witness attestation and API/storage release still **PENDING DESIGN/APPROVAL**.

## Motivation and existing constraints

The frozen schema `db/migrations/001_s32_core_schema.sql` already has nullable `core.evidence_manifest_items.locator_type`, `locator`, and `excerpt`, **but the accepted v1 `apps/web/src/research/api.ts` contract requires all three fields to be exactly null**. Old Assessment/Resolution manifests are immutable and must never be amended in place. The P1-B v0.1 [citation-disclosure draft](https://github.com/conanxin/book-id-search/pull/62) only says an authorized Source/Asset/NoteRevision is an object-level reference, not a page, plate or quotation. This R2 proof does not alter that.

The core data model makes `core.sources.edition_id` nullable, and `core.source_assets.sha256` nullable for some storage modes. Therefore a page/plate claimed against a Source that does not have a fixed Edition or a witnessed original SourceAsset checksum **cannot** be treated as page-verified. Importantly, `EvidenceManifest.manifest_sha256` is NOT an asset-content fingerprint.

## Code and test boundaries

- Pure TS prototype: `apps/web/src/research/locator-v2-draft.ts`.
- Contract tests: `apps/web/src/research/locator-v2-draft.test.ts`.
- Dedicated CI: `.github/workflows/s32-p1b-r2-locator-contract.yml`.
- **No calls to network, filesystem, database, mutating APIs, authentication provider, release process, or agent-generated auto-citations.**
- No imports from production routes and no user-visible Locator editing UI. No new v1 API DTO, schema migration, signed verification credential or backward-incompatible change.
- Work begins as independent **Draft PR stacked on #62**, whose parent #58 is not merged. It is deliberately *not* opened against `main`.

## Minimal page/plate R2 proposal envelope

A human-proposed location is a fixed version-2 object with **exactly eight fields**:
```ts
{
  schemaVersion: 2,
  projectId: "uuid", editionId: "uuid", sourceId: "uuid",
  sourceAssetId: "uuid", assetSha256: "64-char lowercase sha256",
  kind: "PRINTED_PAGE" | "PLATE",
  label: "87" // or "图版二十一", "xii"
}
```

The locator label remains the researcher's literal input; it is not normalized into page offsets or fabricated PDF links. Unknown keys are rejected (e.g. `verified`, `href`, `excerpt`, `locator`, `bbox`). Labels reject blank/whitespace, HTML/URL, newlines/control/bidi characters and overly long strings.

A separate **trusted-server-supplied** witness envelope is required for structural matching: same project/edition/source/original SourceAsset and **asset-byte** SHA-256, `sourceType=PUBLICATION`, `assetRole=ORIGINAL`, `access=READABLE`. The pure function does **not** itself authenticate the user or verify the witness; passing it fabricated values grants nothing. It returns a stable, minimal projection **without source IDs, URL, document bytes or quotation**.

Status outcomes:
| Status | Meaning | Verified page? |
| --- | --- | --- |
| `INVALID` | Unknown/malformed draft, forbidden self-certified fields | **No** |
| `UNAVAILABLE` | Missing/revoked/denied witness; no fixed Edition, original asset or checksum | **No** |
| `IDENTITY_CONFLICT` | Project/Edition/Source/Asset or original bytes differ from proposal | **No** |
| `PENDING_HUMAN_VERIFICATION` | Draft shape and separately supplied witness identity agree | **Still no** |

Even for `PENDING_HUMAN_VERIFICATION`, `verified=false`, `href=null`, `excerpt=null`: this is merely an eligible *proposal*, not an authenticated quotation, remotely navigable source page or accepted frozen Manifest item.

`summarizeV1EvidenceLocation` is read-only: empty items → `NO_EVIDENCE`; authorized legacy v1 items with strictly null locator/excerpt → `NOT_RECORDED`; unexpected populated/malformed legacy fields → `UNSUPPORTED`. It cannot convert v1 to v2 or mutate history.

## Threat and negative acceptance gates

The new tests cover user-controlled `verified`/URL/excerpt injection, schema/version mismatch, false UUID/asset hash, unsafe Chinese/Latin page labels, wrong Owner project, different Edition/Source/SourceAsset, asset SHA drift, missing/denied/revoked original, derivative assets and absent checksum, no witness, immutable v1 null disclosure and frozen input immutability.

Tests can establish **structural fail-closed behavior**; no CI synthetic witness constitutes a human visual proof of page 87, no actual PDF has been verified, and an unauthorized user must not be allowed to construct trusted witness values in the eventual server API.

## R2 is NOT permission for Locator storage

A real feature still requires a separate review and explicit authorization for:
1. How an Edition matches printed pagination when `Source.edition_id` is null and documents have multiple editions or editions are reflowed.
2. A verifiable SourceAsset byte identity, scan frame/page-map provenance, readable original rights and source-link revocation. Null SHA for remote material must not be treated as trustworthy.
3. Human review identity (actor), timestamp, attestation/version, and a complete audit/revocation event lifecycle, independent of researcher's notes and AI guesses.
4. Whether a published `Locator` should be its own append-only sidecar object rather than retrofitting immutable v1 `EvidenceManifest` rows.
5. An additive migration, DTO v2-specific API, read authorization, deletion/revocation tests, and PG16/Chromium acceptance. Never modify frozen migration 001 or v1 response to pretend v2 support.
6. Real Owner user-journey/pilot on a legally accessible original and **explicit user consent for Schema/API writes and production release**.

## Separate integration status

[#58](https://github.com/conanxin/book-id-search/pull/58), [#62](https://github.com/conanxin/book-id-search/pull/62) and [#66](https://github.com/conanxin/book-id-search/pull/66) were still Draft/unmerged at this phase start. R6 previously demonstrated a local five-PR Git integration, but no remote PR has been merged. The present R2 contract spike does not alter that dependency, root WeRead test debt, or paused off-host backup work.

```text
TASK_ID=S32_P1B_R2_LOCATOR_CONTRACT_SPIKE
PHASE=NO_WRITE_STRUCTURAL_PROTOTYPE
V1_MANIFEST=IMMUTABLE_NULL_LOCATORS
SOURCE_AUTHORIZATION=NOT_IMPLEMENTED_IN_PROTOTYPE
HUMAN_PAGE_VERIFICATION=NOT_IMPLEMENTED
SCHEMA_MIGRATION=NO
API_WRITE=NO
PUBLIC_ROUTE=NO
PRODUCTION_CHANGED=NO
MERGE_APPROVAL=NO
```
