# S32 R9: byte witness and revocable human locator reports

Date: 2026-10-10

This is a nonproduction, in-memory continuation of [R8 Draft PR #67](https://github.com/conanxin/book-id-search/pull/67) at `8bbd072b7dfaaf21415e7e59e151f8cba7653536`. There is no public route, persistent storage, signature service, API migration or production deployment.

## What changed from R8

R8 only compared the strings supplied in a locator proposal and source witness. R9 additionally computes SHA-256 using real Web Crypto over a copy of the supplied bytes. A mismatch is rejected. A match enables, but does not replace, a human inspection report.

`createLocatorReviewSession(proposal, options)` returns:

- `observeOriginal(bytes)`: compare a real byte digest with the proposal's original-asset digest. No bytes are persisted and the caller's mutable buffer cannot change the snapshot after hashing starts.
- `recordHumanCheck({ inspectedOriginal, observedLabel, assetPageNumber, decision })`: record a HUMAN actor's explicit report, with the current adapter clock. Report input cannot override actor/time or inject `verified`, URLs or quotations.
- `revoke({ reason: "CORRECTION" | "WITHDRAWN" })`: append a withdrawal event; do not edit the previous inspection, and do not revive it in the same session.
- `view()` and `dispose()`: produce frozen snapshots or close the private session.

An example report may say printed page `87` corresponds to scan-page index `93`. These values are distinct; the module never infers a constant pagination offset or asserts that page 93 really exists in a PDF. Both MATCHED and NOT_MATCHED reports are representable.

## State transitions

```text
AWAITING_BYTES -> HASHING -> AWAITING_HUMAN
                              |       |
                       HUMAN_MATCH  HUMAN_MISMATCH
                              \       /
                                REVOKED
Any context loss/change or dispose -> UNAVAILABLE (terminal)
```

The full enum names are `HUMAN_MATCH_RECORDED` and `HUMAN_MISMATCH_RECORDED`. A byte mismatch goes back to AWAITING_BYTES without recording a success event. Successful checks cannot be overwritten by a second report. A correction requires withdrawal and a fresh session.

Events retain sequence, actor ID, timestamp, the frozen project/Edition/Source/SourceAsset/asset-hash/locator proposal, the reported scan-page and printed label, and withdrawal reason. Objects and returned arrays are frozen. This is append-only **within the live session**, not durable or tamper-proof storage.

## Trust boundary and precise limitations

The `currentContext` adapter must supply an authenticated actor and an authorized readable ORIGINAL/PUBLICATION witness, and increment `authGeneration` or `accessRevision` for all relevant changes. R9 validates and compares that supplied context; it does not authenticate its provider. An arbitrary caller can create a synthetic HUMAN context, so this module must not be used as a server authorization boundary.

Every command and view rechecks actor, session/access revisions and source identity. Async hashing checks the context again before committing an event. Observed revocation, logout, hash/identity changes or disposal permanently invalidate the session and return a redacted projection. Changes not delivered by the adapter cannot be detected. Already-delivered snapshots cannot be recalled from another caller.

A digest match proves equality to the expected byte digest, **not** the authenticity, legality, archival origin or edition accuracy of that expected digest. It does not establish that a human opened or read a page. `inspectedOriginal=true` and the reported page mapping are explicit reports, not independently observed facts. The timestamp is adapter-supplied, not a trusted timestamp signature. The code does not parse PDFs, validate page counts, render source images, or extract quotations.

All projections deliberately retain `verified:false`, `href:null`, `excerpt:null`, even after HUMAN_MATCH_RECORDED. No certificate or signed citation is produced. Agent actors cannot submit human reports. If a revocation cannot be logged (e.g. invalid clock), the session becomes unavailable rather than leaving the old report active.

Existing v1 EvidenceManifest items remain immutable and retain their required null locator/excerpt fields. R8 code, formal API DTOs, application routes, backend domain source and SQL remain untouched.

## Tests and evidence

The tests use the three synthetic bytes `abc`, their known SHA-256, synthetic project/actor IDs, and an injected clock/context. They test real hashing, wrong bytes, input mutation, concurrent/pending reads, human/agent distinction, strict fields, label mismatch, separate printed/scan numbering, immutable histories, revocation, clock order, changed actor/source/access revisions and provider errors.

- Initial feature RED: [CI #38036935841](https://github.com/conanxin/book-id-search/actions/runs/38036935841), source `177fceadbedff9e13eaf8cfa9fb97a4eac7804b3`: 36 R9 assertions failed on the scaffold; 50 tests passed (49 R8 plus one R9 fail-closed case). This is new-feature test-first evidence, not 36 pre-existing production bugs.
- First implementation GREEN: [CI #38037060457](https://github.com/conanxin/book-id-search/actions/runs/38037060457), source `9af2145b4c7988f9c87ba9b1da3af8cd140df877`: R9 37/37, R8+R9 86/86, Research 780/780, schema 29/29, Web/API builds and frozen-scope diff check passed.
- Final exact-head and whole-repository results are recorded in the PR and Notion receipt. A passing scoped job is not a claim that the complete root suite is green.

## Next useful delivery

Connect this session to an isolated review screen where a user selects a local source file, sees the distinct printed label/scan index, submits MATCHED or NOT_MATCHED and can withdraw. A real-source pilot should precede backend persistence. Server authorization, source rendition/page-count validation, signatures and durable event storage remain separate unimplemented capabilities; main merge and production release remain separately authorized.
