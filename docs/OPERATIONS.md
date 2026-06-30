# 运维手册

## 重新导入数据

```bash
pnpm import:file -- --file "/path/to/books.txt" --reset-index
```

分段导入：

```bash
pnpm import:file -- --file "/path/to/books.txt" --offset 0 --limit 500000 --reset-index --checkpoint reports/import-checkpoint.json
pnpm import:file -- --file "/path/to/books.txt" --offset 500000 --limit 500000 --checkpoint reports/import-checkpoint.json
```

断点续跑：

```bash
pnpm import:file -- --checkpoint reports/import-checkpoint.json --resume
```

## 清空索引

最安全方式是重新导入时带 `--reset-index`：

```bash
pnpm import:file -- --file "/path/to/books.txt" --limit 100000 --reset-index
```

## 更新代码

```bash
git pull
pnpm install
pnpm build
docker compose up -d --build
```

## 查看日志

```bash
docker compose logs -f meilisearch
docker compose logs -f api
docker compose logs -f web
```

开发模式：

```bash
pnpm dev
```

## 备份 Meilisearch 数据目录

如果使用 `.env` 中的 `MEILI_DATA_DIR` 绑定目录，先查看大小：

```bash
du -sh "$MEILI_DATA_DIR"
df -h "$MEILI_DATA_DIR"
```

先停服务再备份目录：

```bash
docker compose stop meilisearch
tar czf backups/meili_data.tgz -C "$MEILI_DATA_DIR" .
docker compose start meilisearch
```

如果仍使用 Docker volume，可用：

```bash
docker compose stop meilisearch
docker run --rm -v book-id-search_meili_data:/data -v "$PWD/backups:/backup" alpine tar czf /backup/meili_data.tgz -C /data .
docker compose start meilisearch
```

也可以使用 Meilisearch dump/snapshot 能力，但需要按当前 Meilisearch 版本确认接口。

## 处理导入失败

1. 查看 `reports/latest-import-report.json`。
2. 检查失败是否来自 Meilisearch 连接、鉴权或磁盘空间。
3. 用小批量重试：

```bash
pnpm import:file -- --file "/path/to/books.txt" --limit 10000 --dry-run
pnpm import:file -- --file "/path/to/books.txt" --limit 100000 --batch-size 1000 --reset-index
```

4. 若失败来自单行解析，解析器会保留 `rawInfo`，通常不会中断导入。
## S14 导入性能与运维建议

推荐生产导入参数：

```bash
pnpm import:file -- --file "/path/to/books.txt" --index books --reset-index --batch-size 20000 --search-raw-info false --wait-timeout-ms 900000 --checkpoint reports/import-checkpoint-full.json --report reports/import-full-report.json
```

断点续跑：

```bash
pnpm import:file -- --checkpoint reports/import-checkpoint-full.json --resume --wait-timeout-ms 900000
```

分段导入时，每段完成后先运行：

```bash
pnpm verify
curl http://127.0.0.1:3001/api/stats
```

`rawInfo` 搜索取舍：

- `--search-raw-info true`：原始整行也参与搜索，索引更重，导入更慢。
- `--search-raw-info false`：推荐生产默认。原始整行仍保存在文档和详情页里，但不参与全文搜索。
- S14 搜索质量对比已验证：SSID、DXID、ISBN、书名、作者、出版社在 `rawInfo=false` 时仍可命中。

云端长时间导入应在 `tmux` 或 `screen` 里执行，避免 SSH 断开导致进程中止。不要把真实 TXT、`meili_data`、checkpoint JSON、`.env`、日志或二进制文件提交到 Git。
