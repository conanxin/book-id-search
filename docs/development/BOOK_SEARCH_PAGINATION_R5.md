# Public search pagination

TASK_ID: `BOOK_SEARCH_PAGINATION_R5`

## User-facing behavior

Public catalog search remains anonymous. The first page keeps the existing local ranking, while subsequent pages read slices from the same aligned candidate windows. For a fixed query and page size on an unchanged index, an exact match promoted by local ranking appears once and other catalog IDs are not skipped.

The result count is Meilisearch's estimate. Navigation is limited to the current index's first 1,000 browseable hits, or 50 pages at the Web app's fixed 20 results per page. Larger estimates show an explanation and a suggestion to narrow the title, author or SSID. A deep link beyond the browseable range shows a return-to-last-page action instead of the ordinary no-results message. This limit does not remove records from the catalog.

The URL owns the committed query and page. Typing a new query commits it after 300 ms and starts at page 1; Enter commits immediately. Back/Forward restores the query, page and input. Search responses never overwrite the input draft. Pagination buttons and keyboard navigation respect the browse boundary.

## Implementation scope

- Preserves original local commits `8c1b0c6` (R1 API) and `6038ebd` (R4 Web) on top of deployed PR #74 merge `8c9d3383`.
- Uses the existing bounded over-fetch and ranking rules. A page may read two aligned windows when it crosses their boundary; the response shape stays unchanged.
- Keeps the 1,000-hit cap in `searchPagination.ts`, matching the live index setting inspected on 2026-11-12. If that setting changes, update this helper as part of the same release.
- Changes no authentication policy, personal introductions, notes, AI behavior, dependencies or database schema. There is no new page-size control.

## Focused verification

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm exec vitest run apps/api/src/handle-search.test.ts apps/web/src/searchPagination.test.ts apps/web/src/weread/SearchDetailWereadSession.test.tsx --maxWorkers 1
corepack pnpm --filter @book-id-search/api build
corepack pnpm --filter @book-id-search/web build
corepack pnpm exec playwright test --config playwright.search-pagination.config.ts
```

The API regression places an exact-title match inside the candidate window, checks its promotion, and follows all 55 fixture IDs over 14 pages. Running that test against the deployed old handler reproduces a repeated `page-row-10`; the candidate must pass both uniqueness and complete-ID coverage. A separate case exercises a page spanning the 120-document window boundary.

The browser journey uses the built Web preview on port 13134 and synthetic public API responses. It checks desktop and 390 px layouts, pages 1/2/49/50, page 51 deep links, disabled boundary controls, query reset, Back/Forward, immediate Enter submission and distinct zero-result behavior. It records requests, page errors and screenshots. It does not exercise real Google OAuth, a live Meilisearch query or any model.

Current test outcomes and the exact reviewed commit belong in the PR and phase records. The October 29 R2/R3 snapshot and isolated API evidence remains historical evidence, not a newly run live-index test. This task does not claim a repository-wide test or script-TypeScript pass.

## Release scope

The candidate requires API and Web together, using the existing release builders and actual Compose chain after merge authorization. It requires no migration or Meilisearch setting change. Production remained at `8c9d3383` during the read-only inspection on 2026-11-12. This development task does not merge or publish the candidate.
