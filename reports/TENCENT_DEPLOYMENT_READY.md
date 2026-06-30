# Tencent Deployment Ready

## Status

`READY_AWAITING_SERVER_CONFIG`

The project is ready for GitHub publishing and Tencent Cloud 500k validation, but this local machine is missing the GitHub CLI (`gh`) and no Tencent Cloud server configuration was found in environment variables or `.deploy.env`.

## GitHub Repo

- Target URL: `https://github.com/conanxin/book-id-search`
- SSH remote to use: `git@github.com:conanxin/book-id-search.git`
- Local remote can be prepared with:

```bash
git remote add origin git@github.com:conanxin/book-id-search.git
```

## Required Tencent Cloud Config

Create a local ignored `.deploy.env` file:

```dotenv
BOOK_SEARCH_SERVER_HOST=1.2.3.4
BOOK_SEARCH_SERVER_USER=root
BOOK_SEARCH_SERVER_KEY=C:\path\to\key.pem
BOOK_SEARCH_PUBLIC_URL=http://1.2.3.4:5173
BOOK_SEARCH_MEILI_MASTER_KEY=replace-with-a-long-random-secret
```

Do not commit `.deploy.env`.

## Upload Data Command

```powershell
.\scripts\deploy\upload-data.ps1 -Host "$env:BOOK_SEARCH_SERVER_HOST" -User "$env:BOOK_SEARCH_SERVER_USER" -KeyPath "$env:BOOK_SEARCH_SERVER_KEY"
```

This uploads the private TXT to:

```text
/data/book-id-search/private-data/books.txt
```

## Deploy App Command

On the Tencent Cloud server:

```bash
export MEILI_MASTER_KEY="replace-with-a-long-random-secret"
./scripts/deploy/prepare-server.sh
./scripts/deploy/deploy-app.sh
```

## Cloud 500k Import Command

S15 command:

```bash
./scripts/deploy/import-500k.sh
tmux attach -t book-import-500k
./scripts/deploy/verify-remote.sh
```

The import uses:

```bash
docker compose exec -T api pnpm import:file -- --file /data/private/books.txt --index books --offset 0 --limit 500000 --reset-index --batch-size 20000 --search-raw-info false --wait-timeout-ms 900000 --checkpoint reports/import-checkpoint-500k-cloud.json --report reports/import-500k-cloud-report.json
```

## Full Import Command

S16 only. Do not run during S15:

```bash
docker compose exec -T api pnpm import:file -- --file /data/private/books.txt --index books --reset-index --batch-size 20000 --search-raw-info false --wait-timeout-ms 900000 --checkpoint reports/import-checkpoint-full.json --report reports/import-full-report.json
```

Resume:

```bash
docker compose exec -T api pnpm import:file -- --checkpoint reports/import-checkpoint-full.json --resume --wait-timeout-ms 900000
```

## Verification

```bash
curl http://127.0.0.1:3001/api/health
curl http://127.0.0.1:3001/api/stats
curl "http://127.0.0.1:3001/api/search?q=13000000&limit=5"
curl -I http://127.0.0.1:5173
```
