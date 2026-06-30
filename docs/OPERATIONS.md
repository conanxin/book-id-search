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
docker compose exec -T api pnpm import:file --file /data/private/books.txt --index books --offset 0 --limit 500000 --reset-index --batch-size 20000 --search-raw-info false --wait-timeout-ms 900000 --checkpoint reports/import-checkpoint-500k-cloud.json --report reports/import-500k-cloud-report.json
```

全量导入，S16 使用：

```bash
docker compose exec -T api pnpm import:file --file /data/private/books.txt --index books --reset-index --batch-size 20000 --search-raw-info false --wait-timeout-ms 900000 --checkpoint reports/import-checkpoint-full.json --report reports/import-full-report.json
```

断点续跑：

```bash
docker compose exec -T api pnpm import:file --checkpoint reports/import-checkpoint-full.json --resume --wait-timeout-ms 900000
```

长时间导入建议放进 `tmux` 或 `screen`。

## 清空索引

最安全方式是在重新导入时显式使用 `--reset-index`：

```bash
docker compose exec -T api pnpm import:file --file /data/private/books.txt --limit 100000 --reset-index
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
docker compose exec -T api pnpm import:file --checkpoint reports/import-checkpoint-full.json --resume --wait-timeout-ms 900000
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

## Cloud 500k 备注（2026-06-30 · Tencent CVM）

- 云端 500k 验证已经跑通，`/api/stats` → `numberOfDocuments=500000, isIndexing=false`。
- 云端 meili_data 增长 136K → 1.6 GiB，根盘 free 从 38 GiB 降到 36 GiB。
- `pnpm verify` 在云端容器里 PASS（6/6 样例查询各 5 hits）。
- 7700 仍然只绑 `127.0.0.1:7700`，未公网开放。
- 完整报告见 `reports/TENCENT_500K_CLOUD_PASS_REPORT.md`。
- 全量 S16 前置条件见 `reports/FULL_IMPORT_PREFLIGHT.md` 和 `docs/DEPLOY_TENCENT_CLOUD.md`。

### pnpm 命令行参数 bug 备忘

部署文档和老版 `scripts/deploy/import-500k.sh` 之前写的是：

```bash
docker compose exec -T api pnpm import:file -- --file /data/private/books.txt ...
```

这个 `--` 会被 `tsx scripts/import-books.ts` 当作**未知参数**直接拒绝。正确写法是：

```bash
docker compose exec -T api pnpm import:file --file /data/private/books.txt ...
```

`pnpm preflight:import` 同理。`docs/DEPLOY_TENCENT_CLOUD.md`、`docs/OPERATIONS.md`、
`scripts/deploy/import-500k.sh` 在本次收口（S15H）中已经全部修正。
### Caddy 反代 reload（2026-06-30）

新增 `books.conanxin.com` 反代到 `127.0.0.1:5173`，TLS 走 Let's Encrypt 自动签发。
本次 reload 时遇到 `sudo systemctl reload caddy` 在 WSL 容器内返回 `status=226/NAMESPACE`
（systemd mount namespace 准备失败：`/run/systemd/unit-root/tmp` 不存在）。

绕过方法：

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo caddy reload --config /etc/caddy/Caddyfile --force
```

这条直接调用的方式不会触发 systemd namespace，配置立即生效、ACME 自动签发证书。
后续如果改了 Caddyfile 也要用这套命令而不是 systemctl reload。### Docker 镜像 build 时的 registry mirror 坑

2026-06-30 S15J rebuild api 镜像时，`docker.m.daocloud.io` TLS 抽风，`mirror.gcr.io` 间歇性不可达，`registry-1.docker.io` 直连又被卡住。

观察：

- `daemon.json` 里 mirror 顺序影响 fallback 行为：把 `https://mirror.gcr.io` 放第一位通常更稳
- 如果 build 卡在 `failed to resolve source metadata for docker.io/library/node:22-alpine`，先 `curl -sI https://registry-1.docker.io/v2/library/node/manifests/22-alpine` 看是不是直连通了
- `docker build --pull=false -f apps/api/Dockerfile -t book-id-search-api:latest .` 比 `docker compose up -d --build` 更可控（避免 daemon 触发额外 mirror）

### /api/stats verbose IP 判断

`isLocalhostRequest` 接受四类 IP：

| peer | 说明 |
|---|---|
| `127.0.0.1` | host IPv4 loopback |
| `::1` | host IPv6 loopback |
| `::ffff:127.0.0.1` | IPv4-mapped IPv6 loopback |
| `172.18.0.1` | docker 默认 bridge `book-id-search_default` 的 gateway |

`172.18.0.1` 这一项是因为 host 调用 `127.0.0.1:3001` 时，docker 用 DNAT 把请求路由到 api 容器，api 看到的源 IP 不是 127.0.0.1 而是 docker bridge gateway。web/api/meili 互调用各自的容器 IP（172.18.0.2/3/4），不会撞到 gateway，所以 verbose 仍然只对 host 可用。

如果以后改了 docker 网络（用 `docker network create --subnet=...`），gateway IP 会变，需要相应更新判断。