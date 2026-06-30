# 腾讯云部署

本项目适合部署到腾讯云轻量应用服务器或 CVM。真实 TXT 数据不进入 GitHub，只上传到服务器私有目录。

## 推荐配置

- 最低测试：2 核 4GB / 80GB SSD
- 推荐全量：4 核 8GB / 160GB SSD
- 更稳：4 核 16GB / 200GB SSD

生产环境不要把 Meilisearch 数据放在空间很小的系统盘。推荐：

- 应用目录：`/opt/book-id-search`
- Meilisearch 数据目录：`/data/book-id-search/meili_data`
- 私有 TXT 目录：`/data/book-id-search/private-data`

## 端口与公网

- Web 默认端口：`5173`
- API 默认端口：`3001`
- Meilisearch 默认只绑定到 `127.0.0.1:7700`

不要把 Meilisearch `7700` 直接暴露到公网。公网访问建议只开放 Web 端口，或在 Nginx/Caddy/腾讯云 EdgeOne 后面绑定域名和 HTTPS。

如确实需要临时调试 Meilisearch 端口，可在 `.env` 中设置：

```bash
MEILI_PORT_BIND=0.0.0.0:7700
```

调试完成后请改回：

```bash
MEILI_PORT_BIND=127.0.0.1:7700
```

## 准备服务器

```bash
./scripts/deploy/prepare-server.sh
```

脚本会安装 `git`、`curl`、`tmux`，检查 Docker 和 Docker Compose，并创建：

```text
/opt/book-id-search
/data/book-id-search/meili_data
/data/book-id-search/private-data
```

如果 Docker 不存在，按脚本提示安装：

```bash
curl -fsSL https://get.docker.com | sudo sh
```

## 上传真实 TXT

在本地 Windows 执行：

```powershell
.\scripts\deploy\upload-data.ps1 -Host "1.2.3.4" -User root -KeyPath "C:\path\to\key.pem"
```

上传目标：

```text
/data/book-id-search/private-data/books.txt
```

不要把真实 TXT 放进 Git 仓库。

## 部署应用

在服务器执行：

```bash
export MEILI_MASTER_KEY="replace-with-a-long-random-secret"
./scripts/deploy/deploy-app.sh
```

脚本会 clone/pull `https://github.com/conanxin/book-id-search.git`，写入 `.env`，然后运行：

```bash
docker compose up -d --build
```

查看服务状态：

```bash
docker compose ps
docker compose logs -f api
docker compose logs -f web
docker compose logs -f meilisearch
```

## 500k 云端验证

S15 只建议导入前 500000 行，不直接跑全量。

```bash
./scripts/deploy/import-500k.sh
```

脚本会在 `tmux` session `book-import-500k` 中运行：

```bash
docker compose exec -T api pnpm import:file -- --file /data/private/books.txt --index books --offset 0 --limit 500000 --reset-index --batch-size 20000 --search-raw-info false --wait-timeout-ms 900000 --checkpoint reports/import-checkpoint-500k-cloud.json --report reports/import-500k-cloud-report.json
```

查看进度：

```bash
tmux attach -t book-import-500k
```

验证：

```bash
./scripts/deploy/verify-remote.sh
```

如果已经配置公网地址：

```bash
PUBLIC_URL="http://your-domain-or-ip:5173" ./scripts/deploy/verify-remote.sh
```

## 推荐生产导入参数

S14 benchmark 推荐：

```bash
--batch-size 20000 --search-raw-info false --wait-timeout-ms 900000
```

`--search-raw-info false` 不删除原始记录，只是不把 `rawInfo` 放进全文搜索字段。SSID、DXID、ISBN、书名、作者、出版社仍可搜索，详情页仍保留原始记录。

## 全量导入

S16 使用，不在 S15 执行：

```bash
docker compose exec -T api pnpm import:file -- --file /data/private/books.txt --index books --reset-index --batch-size 20000 --search-raw-info false --wait-timeout-ms 900000 --checkpoint reports/import-checkpoint-full.json --report reports/import-full-report.json
```

断点续跑：

```bash
docker compose exec -T api pnpm import:file -- --checkpoint reports/import-checkpoint-full.json --resume --wait-timeout-ms 900000
```

建议在 `tmux` 或 `screen` 中运行长时间导入。

## 查看数据目录大小

```bash
du -sh /data/book-id-search/meili_data
df -h /data/book-id-search/meili_data
```

## 常见故障

- Meilisearch 不可用：检查 `docker compose logs -f meilisearch`
- 导入 401：确认服务器 `.env` 中的 `MEILI_MASTER_KEY` 与容器环境一致
- 搜索无结果：确认导入报告和 `/api/stats` 的 `numberOfDocuments`
- 端口打不开：检查腾讯云安全组、防火墙、`WEB_PORT` 和公网绑定
- 导入中断：使用 checkpoint/resume 继续，不要从 0 重跑
