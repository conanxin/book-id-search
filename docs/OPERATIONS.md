# 运维手册

## 查看服务状态

```bash
docker compose ps
docker compose logs -f meilisearch
docker compose logs -f api
docker compose logs -f web
```

本地开发：

```bash
pnpm dev
```

## 重新导入数据

Docker Compose 云端推荐在 API 容器中运行导入脚本。私有 TXT 通过 `BOOK_DATA_DIR` 只读挂载到容器内 `/data/private`。

500000 行验证：

```bash
./scripts/deploy/import-500k.sh
```

或手动执行：

```bash
docker compose exec -T api pnpm import:file -- --file /data/private/books.txt --index books --offset 0 --limit 500000 --reset-index --batch-size 20000 --search-raw-info false --wait-timeout-ms 900000 --checkpoint reports/import-checkpoint-500k-cloud.json --report reports/import-500k-cloud-report.json
```

全量导入，S16 使用：

```bash
docker compose exec -T api pnpm import:file -- --file /data/private/books.txt --index books --reset-index --batch-size 20000 --search-raw-info false --wait-timeout-ms 900000 --checkpoint reports/import-checkpoint-full.json --report reports/import-full-report.json
```

断点续跑：

```bash
docker compose exec -T api pnpm import:file -- --checkpoint reports/import-checkpoint-full.json --resume --wait-timeout-ms 900000
```

长时间导入建议放进 `tmux` 或 `screen`。

## 清空索引

最安全方式是在重新导入时显式使用 `--reset-index`：

```bash
docker compose exec -T api pnpm import:file -- --file /data/private/books.txt --limit 100000 --reset-index
```

## 更新代码

```bash
cd /opt/book-id-search
git pull --ff-only
docker compose up -d --build
```

## 查看统计

```bash
curl http://127.0.0.1:3001/api/health
curl http://127.0.0.1:3001/api/stats
```

## 备份 Meilisearch 数据目录

查看大小：

```bash
du -sh /data/book-id-search/meili_data
df -h /data/book-id-search/meili_data
```

停止服务后备份：

```bash
docker compose stop meilisearch
mkdir -p /data/book-id-search/backups
tar czf /data/book-id-search/backups/meili_data-$(date +%Y%m%d-%H%M%S).tgz -C /data/book-id-search/meili_data .
docker compose start meilisearch
```

## 处理导入失败

1. 查看报告：`reports/import-500k-cloud-report.json` 或 `reports/import-full-report.json`
2. 查看 checkpoint：`reports/import-checkpoint-500k-cloud.json` 或 `reports/import-checkpoint-full.json`
3. 检查磁盘：`df -h /data/book-id-search/meili_data`
4. 检查 Meilisearch 日志：`docker compose logs -f meilisearch`
5. 使用 resume 继续：

```bash
docker compose exec -T api pnpm import:file -- --checkpoint reports/import-checkpoint-full.json --resume --wait-timeout-ms 900000
```

解析器会保留 `rawInfo`，单行异常通常不会中断导入；真正需要关注的是 Meilisearch 连接、认证、磁盘空间和任务超时。

## 不进入 Git 的内容

- 真实 TXT
- `.env`
- `.deploy.env`
- `meili_data`
- checkpoint JSON
- 日志
- `meilisearch.exe`
- 构建产物
