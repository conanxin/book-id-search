# WeRead Skill — Research Notes (S26A follow-up)

> Companion to [`WEREAD_INTEGRATION.md`](./WEREAD_INTEGRATION.md).
> These notes guide the **manual** investigation of the WeRead Skill that
> S26A did not (and could not) perform automatically. They are written for a
> future maintainer running the Skill against a real account, with the goal of
> populating the schema defined in `WEREAD_INTEGRATION.md` and verifying that
> `pnpm weread:validate` will accept real snapshots.

---

## 1. Research purpose

This document is a checklist for **S26B** (real private snapshot import) and
**later** phases. It must not contain:

- Real WeRead account data
- Real `WEREAD_API_KEY` values
- Real notes, highlights, or chapter titles from any book
- Real session cookies, tokens, or QR-code payloads

Anything sensitive must be redacted to "示例…" placeholders before being
copied into a sample file or into this document.

---

## 2. Credential policy

`WEREAD_API_KEY` (or whatever token the WeRead Skill ultimately accepts):

| Allowed | Forbidden |
| ------- | --------- |
| Shell environment variable (`export WEREAD_API_KEY=...`) | Any tracked file (`.env`, `.env.example`, code, docs) |
| Local secret manager (e.g. `~/.config/<skill>/credentials`) | Logs, health-check output, AI-quality regression reports |
| Inline `WEREAD_API_KEY=…` only inside the user's local shell session | Public HTTP responses, `console.log`, error messages |

Rules:

1. **Never** commit a real `WEREAD_API_KEY`.
2. **Never** print the value, even partially. (`console.log(key.slice(0,4))` is also forbidden — it teaches the user the habit.)
3. **Never** propagate it through a public-facing endpoint.
4. **Never** store it in `private-data/` next to a snapshot. Credentials and
   personal data live in separate locations.

---

## 3. Manual research checklist

When you have access to a real WeRead account with this Skill installed,
walk through the following and capture answers in a private scratch file
**outside** the repo. Only the redacted conclusions should ever be referenced
here.

| # | Question | Why we need it |
| - | -------- | -------------- |
| 1 | Can the Skill list the user's bookshelf? | Required for the `weread-books` snapshot. |
| 2 | Does each entry carry a stable `bookId` (e.g. `wr_…`)? | The `wereadBookId` foreign key. |
| 3 | Does each entry carry ISBN-10/13? | Needed for high-confidence ISBN matching. |
| 4 | Does each entry carry author / publisher / category? | Improves title-author matching. |
| 5 | Does each entry carry `readingStatus`? | Maps to the enum in our schema. |
| 6 | Does each entry carry `progress` (0–100)? | Same. |
| 7 | Does each entry carry `noteCount` / `highlightCount`? | Optional convenience fields. |
| 8 | Can the Skill export highlights? | Required for `weread-notes` (type=highlight). |
| 9 | Can the Skill export thoughts? | Required for `weread-notes` (type=thought). |
| 10 | Does each note carry `chapterTitle`? | Optional but improves UX in S26E. |
| 11 | Does each note carry `createdAt` / `updatedAt`? | ISO-8601 strings; verify format. |
| 12 | Are there pagination cursors? | Affects the normalizer's loop in S26B. |
| 13 | Are there rate limits? | Affects whether S26B can be run from cron. |
| 14 | Are any fields unstable / nullable / renamed across versions? | Drives a `version` field in the snapshot if needed. |
| 15 | Can we fetch a public-readable URL for each book? | Future only — **do not** expose in S26A–S26D. |

Record yes/no/partial for each, plus a one-line note. Do **not** paste raw
JSON or book titles into this document.

---

## 4. Suggested private workflow (S26B hand-off)

Once the checklist above is answered:

1. **Export** (manual, single-user machine):
   ```bash
   export WEREAD_API_KEY=...   # do not persist
   # Run the Skill / Agent to dump raw JSON to private-data/weread/raw/<timestamp>.json
   ```

2. **Normalize** (private script, also outside this repo or guarded by a
   `--private-only` flag). Shape raw → snapshot, then write to:
   ```bash
   private-data/weread/snapshots/<timestamp>/
   ├── weread-books.snapshot.json
   ├── weread-notes.snapshot.json
   └── weread-matches.snapshot.json   # may be empty initially
   ```

3. **Validate**:
   ```bash
   pnpm weread:validate -- --dir private-data/weread/snapshots/<timestamp>
   ```
   Must return `STATUS=PASS` or `STATUS=WARN`. If `FAIL`, fix the normalizer
   before continuing.

4. **Match** (optional, only after validation passes):
   ```bash
   NO_PROXY="*" no_proxy="*" pnpm weread:match -- \
     --weread private-data/weread/snapshots/<timestamp>/weread-books.snapshot.json \
     --catalog-query-url https://books.conanxin.com/api/search \
     --out private-data/weread/derived/weread-matches.generated.json
   ```
   Review candidates by hand. Do **not** auto-confirm.

5. **Confirm** (S26D, future): a token-gated UI will eventually allow
   accepting or rejecting each candidate. Until S26D ships, no matches are
   propagated to any persistence layer.

---

## 5. Redaction rules

When turning real data into samples (e.g. for a bug report or test fixture):

- Replace real `wereadBookId` with `wr_sample_book_NNNN` or similar obvious
  placeholders.
- Replace real titles with `示例书 / 示例小说 / 示例技术手册`. **Never** use
  a real book title in a sample.
- Replace real author names with `示例作者 A / B / C`.
- Replace real ISBNs with `9787000000000`-style fake ISBNs that don't collide
  with the public catalog.
- Replace real note text with `这是一条示例笔记文本，不包含真实阅读笔记内容。`
- Replace real `chapterTitle` with `示例章节 1`.
- **Always** replace session cookies, tokens, QR-code payloads, and account
  IDs with literal `__redacted__` strings, even in private test fixtures.

When in doubt, **do not include** the field. A missing field is recoverable;
a leaked field is not.

---

## 6. Future phases

| Stage | Scope | Hard rules |
| ----- | ----- | ---------- |
| **S26B** | Real private snapshot import (this checklist drives it). | No Git, no Meilisearch, no public API. |
| **S26C** | Matching engine improvements (year, publisher, series, user feedback). | Read-only against public catalog; writes only to `private-data/weread/derived/`. |
| **S26D** | Token-gated private overlay API. | Returns data only to the owning user's session. No cross-user leakage. |
| **S26E** | Frontend private reading badges. | Per-session only. Server still must not return personal reading state to anonymous users. |

At no stage will personal WeRead data be:

- Committed to Git
- Written to Meilisearch
- Returned by any public endpoint
- Logged in any persistent file
- Combined with public catalog data in a way that would let an outsider
  identify what a specific user is reading.