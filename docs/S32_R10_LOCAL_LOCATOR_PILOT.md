# S32 R10 — Local-file Locator pilot (isolated development page)

**Task:** `S32_R10_LOCAL_LOCATOR_PILOT`  
**Date:** 2026-10-10  
**Parent:** [R9 Draft PR #68](https://github.com/conanxin/book-id-search/pull/68) at `f7f169ebbcd2aa350b8c523675fff7be3fd2e5ac`.  
**Delivery:** a browser-only, developer-served test page for local PDF/image review. **No public production route, no permanent citation, no database/API change.**

## What to run locally

From the checkout of the R10 branch (Windows/WSL supported), execute:

```bash
pnpm install --frozen-lockfile && pnpm --filter @book-id-search/web dev
```

Then open **http://127.0.0.1:5173/locator-pilot.html** in a browser on the same machine. The regular app at `/` remains unchanged. The new `apps/web/locator-pilot.html` is served by Vite **in development** and is deliberately omitted from the production `dist/index.html` entry. CI verifies `apps/web/dist/locator-pilot.html` does not appear in the regular Web build.

**Do not publicly expose port 5173 or treat the dev URL as a production preview.** It has no real Owner authentication and is unsuitable for use with confidential source material on a shared or public machine.

## Single-file user journey

1. Select a **local** PDF, PNG, JPG or WEBP **up to 20 MiB**. The page uses a temporary browser blob URL to preview the file. Some PDF browsers may fail to render it; use another local viewer in that case.
2. Choose *印刷页码* or *图版*, and enter a literal label such as `87` or `图版二十一`. Optionally enter a **pre-existing independent** 64-hex SHA-256 digest. Supplying an independent digest only compares bytes; its trustworthiness is **not** authenticated.
3. Read and acknowledge the explicit non-authentication notice, then click *开始本地核对*.
4. The browser reads the selected local file and computes SHA-256; if the optional independently supplied SHA does not match, it **rejects** the file. Otherwise it creates an **explicitly synthetic** ephemeral R9 context using the same local file's SHA and a known fake edition/source/asset identity. This is a self-comparison, NOT independent archive/source attestation.
5. Inspect the PDF/image manually, enter the **observed printed label** separately from the **scan-page sequence number (1-based)**, acknowledge manual inspection, and choose *记录匹配* or *记录不匹配*. A match with an inconsistent observed printed label is refused; a NOT_MATCHED report can preserve what was actually seen.
6. Review the in-memory event list; optionally click *撤销报告*. The original event stays visible for this browser session and a withdrawal event is appended; this cannot be undone in the same session.
7. Select another file or *清空并重新开始* to dispose the old session and start a new one. Reloading the page loses all local report history.

There is **no `fetch`/XHR to Research API**, no `localStorage`, no database or remote file upload, no file bytes written to disk by application code, and no new production routes. The PDF/image preview uses an object URL and revokes it when the selected file changes or component unmounts.

## Research truthfulness and safeguards

- **The page does not claim to verify an original book or archival document.** The digest is derived from the same file selected by the user; an independently supplied hash is not provenance by itself. All proposal and witness IDs are fake local-only constants.
- The model records an explicit HUMAN-type local **report**, not a trusted authenticated person or a signed review. Anybody with the test page can act as the simulated actor. The `verified` field remains **false** and `href`/`excerpt` remain **null** even after *记录匹配*.
- A scan-page sequence is never converted automatically into a printed page number. The prototype does **not** parse actual PDF page counts, image positions, bounding boxes, OCR text or quotations; it cannot know whether the human's page claim is correct.
- In-memory events are only frozen JavaScript objects, not durable/audited immutable history. Session invalidation prevents *current* state reuse but cannot recall data already copied by a caller.
- The preview shows locally selected content, possibly subject to the PDF viewer implementation. Browser policies, extensions and developer tools remain outside this app's control.
- Changing the file or resetting disposes prior state; async file reading and hashing are guarded by a generation counter so stale results do not reappear.
- The component has no import from formal `App.tsx`, `main.tsx` or any S32 API. R8's strict candidate validation and R9's in-memory session are reused without changing them.

## Verification plan

- **TDD RED:** R10 component introduced with intentionally unimplemented handlers. The initial scoped CI confirms 8 behavioral failures and 1 initial disclaimer check passed. This is proof that the new behavior was absent, not 8 production incidents.
- **R10 component GREEN:** local-file SHA, MATCHED/NOT_MATCHED, revocation, input validation, reset/file-replacement stale state, no fetch and non-verification labels.
- **Research/Schema/build gates:** the full `apps/web/src/research` suite, frozen Schema static suite, Web and API builds; exact diff checks ensure no change to `db/**`, API src, `App.tsx`, `main.tsx`, v1 `api.ts`, the R8/R9 safety modules, or production HTML entry.
- **Actual Chromium:** a standalone script starts a disposable local Vite server, selects a synthetic PDF through the browser file-input, records/withdraws reports, repeats a mismatch flow and confirms **no API/external HTTP requests**. Synthetic screenshot artifact is retained; the local server is terminated.
- **Whole-repository baseline:** previous R9 full `pnpm test` on #68 showed 5,686 pass / 15 WeRead CLI failures / 92 skip and one unhandled error. R10 does not touch those scripts; if root is rerun, report its exact results and any differences, without claiming overall GREEN.

## Remaining product Gate

This is a usable **isolated developer pilot**, not yet a public production Locator feature. The next decision is to test it against a legitimately accessible original and get feedback on page label vs scan-page index, errors and document preview. Real Owner identity, authorized SourceAsset, trusted digest provenance, signatures, durable append-only event storage, PDF pagination validation, multi-edition mapping, permission revocation and production release are separate **not implemented / not approved** workstreams.

**`MAIN_MERGE=NO | DB_WRITE=NO | VERIFIED_PAGE=NO | PUBLIC_ROUTE=NO | DEPLOY=NO`.**
