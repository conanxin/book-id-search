# Windows 无 Docker 本地运行

## 适用场景

本方式适合 Windows 本地测试，尤其是没有 Docker Desktop 时验证 Meilisearch、API、前端和导入脚本。它不是推荐生产部署方式；生产环境优先使用 Docker Compose 和持久化数据盘。

## 准备 meilisearch.exe

可以从 Meilisearch GitHub Releases 下载 `meilisearch-windows-amd64.exe`，改名为 `meilisearch.exe`，放到一个本地工具目录，例如：

```powershell
C:\tools\meilisearch\meilisearch.exe
```

也可以放在临时目录，但临时目录不适合长期保存索引。

## 配置环境

```powershell
Copy-Item .env.example .env
```

确保 `.env` 中：

```text
MEILI_HOST=http://127.0.0.1:7700
MEILI_MASTER_KEY=book-id-search-dev-key
MEILI_INDEX=books
```

## 启动 Meilisearch

```powershell
New-Item -ItemType Directory -Force C:\data\book-id-search\meili_data
C:\tools\meilisearch\meilisearch.exe --db-path C:\data\book-id-search\meili_data --http-addr 127.0.0.1:7700 --master-key book-id-search-dev-key --env development
```

另开一个 PowerShell 验证：

```powershell
Invoke-RestMethod http://127.0.0.1:7700/health
```

## 导入样例并启动项目

```powershell
pnpm install
pnpm import:sample
pnpm dev
```

- 前端：http://localhost:5173
- API：http://localhost:3001/api/health
- Meilisearch：http://localhost:7700

## 导入前 100000 行真实 TXT

```powershell
pnpm import:file -- --file "E:\读秀512w（下架书及ss与isbn码）.txt" --limit 100000 --reset-index
pnpm verify
```

## 注意事项

- Windows binary 适合本地测试，不建议作为生产部署方式。
- 全量导入前先运行 `pnpm preflight:import`。
- Meilisearch 数据目录要放在空间充足的 SSD，不要放在空间很小的系统盘。
- 真实 TXT 不要复制进项目目录，也不要提交到 Git。
