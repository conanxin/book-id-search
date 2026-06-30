# Ready Awaiting Server Config

## Status

`READY_AWAITING_SERVER_CONFIG`

S15D cannot start Tencent Cloud deployment because no server configuration was found.

## GitHub Status

- Remote: `https://github.com/conanxin/book-id-search.git`
- Branch: `main`
- Latest local commit: `0618d7a Add Tencent Cloud deployment workflow`
- Remote `main`: pushed
- Remote tag `v0.1.0`: pushed

## Server Config Check

| Field | Configured |
| --- | --- |
| `.deploy.env` | no |
| `BOOK_SEARCH_SERVER_HOST` | no |
| `BOOK_SEARCH_SERVER_USER` | no |
| `BOOK_SEARCH_SERVER_KEY` | no |
| `BOOK_SEARCH_PUBLIC_URL` | no |
| `BOOK_SEARCH_MEILI_MASTER_KEY` | no |

No secrets were printed or stored.

## Required `.deploy.env`

Create this local file in the project root. It is ignored by Git.

```dotenv
BOOK_SEARCH_SERVER_HOST=1.2.3.4
BOOK_SEARCH_SERVER_USER=root
BOOK_SEARCH_SERVER_KEY=C:\path\to\key.pem
BOOK_SEARCH_PUBLIC_URL=http://1.2.3.4:5173
BOOK_SEARCH_MEILI_MASTER_KEY=replace-with-a-long-random-secret
```

## Next Commands

After creating `.deploy.env`, rerun S15D or run the deployment flow manually.

Upload private TXT:

```powershell
.\scripts\deploy\upload-data.ps1 -Host "$env:BOOK_SEARCH_SERVER_HOST" -User "$env:BOOK_SEARCH_SERVER_USER" -KeyPath "$env:BOOK_SEARCH_SERVER_KEY"
```

On the Tencent Cloud server:

```bash
export MEILI_MASTER_KEY="replace-with-a-long-random-secret"
./scripts/deploy/prepare-server.sh
./scripts/deploy/deploy-app.sh
./scripts/deploy/import-500k.sh
```

Verify:

```bash
./scripts/deploy/verify-remote.sh
curl http://127.0.0.1:3001/api/stats
tmux ls
tmux capture-pane -t book-import-500k -p
```

## S15D Result

- Tencent prepare server: not run
- Data upload: not run
- Docker Compose: not run
- Preflight: not run
- 500k cloud import: not run

Reason: missing server SSH/deployment configuration.
