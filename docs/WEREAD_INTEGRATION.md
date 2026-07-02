# WeRead (微信读书) Integration — Schema & Privacy Boundary

> **Status:** S26A research scaffold. No runtime integration. No public API. No Meilisearch writes.
> **Audience:** future implementer of S26B–S26E.

---

## 1. Goal

`book-id-search` is the **public catalog search** layer: 5,115,734 deduplicated books
indexed in Meilisearch, served at `https://books.conanxin.com`.

The **WeRead Skill** is a separate **personal reading-state layer**: bookshelf,
reading progress, highlights, thoughts.

The two layers are joined through a **private snapshot + matching layer** that
**never** leaks personal reading data back into the public index.

```
┌──────────────────────┐        ┌────────────────────────┐
│   WeRead Skill       │  raw   │   private-data/weread/ │
│   (account-bound)    │ ─────▶ │   raw / snapshots /    │
│   needs WEREAD_API_KEY        │   derived (gitignored) │
└──────────────────────┘        └────────────────────────┘
                                              │
                                              │ normalized snapshot
                                              ▼
                                 ┌────────────────────────────┐
                                 │   match-weread-catalog.ts  │
                                 │   (offline prototype)      │
                                 │   queries books.conanxin   │
                                 │   .com/api/search          │
                                 └────────────────────────────┘
                                              │
                                              │ match candidates
                                              ▼
                                 ┌────────────────────────────┐
                                 │   private overlay API      │  ← S26D, token-gated
                                 │   future frontend badges   │  ← S26E
                                 └────────────────────────────┘
```

---

## 2. Privacy Boundary (HARD RULES)

| Asset                                    | Allowed location                     | Forbidden                             |
| ---------------------------------------- | ------------------------------------ | ------------------------------------- |
| WeRead raw API responses                 | `private-data/weread/raw/`           | Git, Meilisearch, logs                |
| Normalized snapshot (personal bookshelf)  | `private-data/weread/snapshots/`     | Git, Meilisearch, public API          |
| Derived match candidates                 | `private-data/weread/derived/`       | Git, Meilisearch, public API          |
| **Redacted samples** (no real IDs, text) | `samples/weread/`                    | any field containing real data         |
| `WEREAD_API_KEY`                         | environment / secret manager         | `.env`, `.env.example`, Git, logs      |

WeRead data **must not**:

- Be written to Meilisearch.
- Be exposed through the public `https://books.conanxin.com/api/*` endpoints.
- Be committed to Git, even as a "small" test fixture.
- Be printed in logs, health-check reports, or AI quality regression output.
- Be combined with the public catalog so that personal reading state becomes
  discoverable to other users.

The **only** artifacts allowed in Git are the **schema definitions** (this file,
`WEREAD_SKILL_RESEARCH_NOTES.md`) and **fully synthetic, redacted sample JSON**
in `samples/weread/`.

---

## 3. Snapshot Schema (v0.1 — S26A draft)

### `weread-books.snapshot.json`

```ts
type WereadBookSnapshotEntry = {
  wereadBookId: string;                              // required, opaque WeRead ID
  title: string;                                     // required
  author: string;                                    // required
  isbn: string | null;                               // may be unknown
  category: string | null;
  cover: string | null;                              // URL or null
  rating: number | null;                             // 0–5 or null
  readingStatus: "unknown" | "not_started" | "reading" | "finished" | "abandoned";
  progress: number | null;                           // 0–100 or null
  noteCount: number;                                 // ≥0
  highlightCount: number;                            // ≥0
  lastReadAt: string | null;                         // ISO-8601 or null
  updatedAt: string | null;                          // ISO-8601 or null
};
```

### `weread-notes.snapshot.json`

```ts
type WereadNoteSnapshotEntry = {
  wereadBookId: string;                              // required, FK to weread-books
  noteId: string;                                    // required, opaque WeRead note ID
  type: "highlight" | "thought" | "review";         // required
  chapterTitle: string | null;
  text: string;                                      // required
  comment: string | null;
  createdAt: string | null;                          // ISO-8601 or null
  updatedAt: string | null;                          // ISO-8601 or null
};
```

### `weread-matches.snapshot.json`

```ts
type WereadMatchEntry = {
  wereadBookId: string;                              // required, FK to weread-books
  catalogId: string;                                 // required, book-id-search doc id
  ssid: string;                                      // required, public SSID
  dxid: string;                                      // required, public DXID
  isbn: string | null;
  matchMethod: "isbn" | "title_author" | "title_similarity" | "manual";
  matchConfidence: "high" | "medium" | "low";
  titleSimilarity: number | null;                    // 0–1
  authorSimilarity: number | null;                   // 0–1
  confirmedByUser: boolean;                          // always false until user confirms
};
```

> **Note on `confirmedByUser`**: matches generated by `match-weread-catalog.ts`
> are *candidates*. They must never be treated as authoritative until a human
> has explicitly confirmed the link. The public catalog must not be mutated
> based on these candidates.

---

## 4. Recommended Data Flow (per future sync)

1. **Export** (manual, S26B): user runs WeRead Skill with their `WEREAD_API_KEY`
   set in env (never on disk) and writes normalized JSON into
   `private-data/weread/raw/`.
2. **Normalize**: a small private script (S26B) shapes raw → snapshot JSON in
   `private-data/weread/snapshots/<timestamp>/`. This is the S26A schema.
3. **Validate**: `pnpm weread:validate --dir private-data/weread/snapshots/<ts>/`
   enforces schema (this script shipped in S26A).
4. **Match**: `scripts/weread/match-weread-catalog.ts` (S26A prototype, offline)
   queries `https://books.conanxin.com/api/search` per WeRead book, writes
   candidates into `private-data/weread/derived/weread-matches.generated.json`.
5. **Confirm**: S26D will add a token-gated UI/API to accept/reject candidates.
   Until S26D ships, no matches are propagated.
6. **Overlay**: S26E may render private reading badges in the user's own
   browser session, never on shared / public responses.

---

## 5. Roadmap

| Stage | Scope                                                          | Public exposure? |
| ----- | -------------------------------------------------------------- | ---------------- |
| S26A  | Schema + sample + validator + offline match prototype          | **No**           |
| S26B  | Real private snapshot import (user provides raw export)        | **No**           |
| S26C  | Matching engine against private snapshot                        | **No**           |
| S26D  | Token-gated private overlay API                                 | **No**           |
| S26E  | Frontend private reading badges (per-user session)              | **No**           |

At no stage in S26A–S26E is personal reading data committed to Git, written to
Meilisearch, or returned by any public endpoint.

---

## 6. What this doc does **NOT** allow

- Running `pnpm import` against WeRead data into the books index.
- Calling the WeRead API automatically from CI / cron.
- Storing API keys in `.env.example`, `.env`, or any tracked file.
- Writing match results into Meilisearch's `books` index.

For manual WeRead Skill investigation questions, see
[`WEREAD_SKILL_RESEARCH_NOTES.md`](./WEREAD_SKILL_RESEARCH_NOTES.md).