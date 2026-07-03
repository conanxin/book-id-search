# WeRead Private Overlay API — Report

> Generated: 2026-07-03T09:30:00.000Z
> S26D phase: private read-only WeRead overlay API behind token.

STATUS: PASS

---

## SCOPE

- Private read-only overlay API.
- Behind `Authorization: Bearer <token>` or `X-Private-Token`.
- No frontend integration.
- No public search behavior change.
- No Meilisearch write.

---

## API_RESULT

- `GET /api/private/weread/summary`:
  - unauthorized: 401
  - authorized: `ok=true`, `dataAvailable=true`
- `GET /api/private/weread/status?catalogId=...`:
  - matched: `matched=true` with redacted `weread` block
  - unmatched: `matched=false`
  - invalid catalogId: 400

---

## DATA_RESULT

- booksCount: 1586
- notesCount: 6989
- confirmedMatchesCount: 51
- data path: `/app/private-data/weread` (bind mount read-only in api container)

---

## SECURITY_RESULT

- token stored in `.env`, not committed
- token not printed in logs or reports
- response does not contain `wereadBookId`, `noteId`, `highlightId`, `cookie`, `session`, `wr_skey`, `wr_vid`
- response does not contain note text / highlight comment / title / author
- `docker-compose.yml` passes token via env, no plaintext value
- private-data bind mounted `:ro`
- no sensitive data in api logs

---

## REGRESSION_RESULT

- vitest: PASS (395 tests, 23 files)
- weread:validate (sample): PASS
- verify: PASS (docs count: 5,115,734)
- search:quality: 17 PASS / 0 WARN / 0 FAIL
- docs count: 5,115,734 (unchanged)

---

## DEPLOY_RESULT

- api rebuilt: yes
- meilisearch: untouched (uptime 2 days)
- web: untouched
- Caddy: untouched

---

## NEXT_STEP

- S26E: private frontend badge or local-only UI behind token
- Or manually confirm more non-ISBN matches before exposing UI
