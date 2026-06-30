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
docker compose exec -T api pnpm import:file --file /data/private/books.txt --index books --offset 0 --limit 500000 --reset-index --batch-size 20000 --search-raw-info false --wait-timeout-ms 900000 --checkpoint reports/import-checkpoint-500k-cloud.json --report reports/import-500k-cloud-report.json
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
docker compose exec -T api pnpm import:file --file /data/private/books.txt --index books --reset-index --batch-size 20000 --search-raw-info false --wait-timeout-ms 900000 --checkpoint reports/import-checkpoint-full.json --report reports/import-full-report.json
```

断点续跑：

```bash
docker compose exec -T api pnpm import:file --checkpoint reports/import-checkpoint-full.json --resume --wait-timeout-ms 900000
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

## Cloud 500k 实测（2026-06-30 · Tencent CVM 118.195.129.137）

实测环境：2c8g / `/dev/vda2` 100G 系统盘，**未挂独立 /data 盘**。
本轮只跑 500k 验证，**不跑全量**。命令已修掉冗余 `--`：

```bash
./scripts/deploy/import-500k.sh
```

实际跑通的命令（容器内 path 为 `/data/private/books.txt`，host 上对应 `/data/book-id-search/private-data/books.txt`）：

```bash
docker compose exec -T api pnpm import:file \
  --file /data/private/books.txt \
  --index books --offset 0 --limit 500000 --reset-index \
  --batch-size 20000 --search-raw-info false --wait-timeout-ms 900000 \
  --checkpoint reports/import-checkpoint-500k-cloud.json \
  --report reports/import-500k-cloud-report.json
```

实测结果：

| 指标 | 值 |
|---|---|
| elapsed | 162.62s |
| rate | 3074.65 rows/s |
| totalLines | 500000 |
| imported | 500000 |
| failedParsed | 0 |
| weakParsed | 59332（主要是 missing_isbn） |
| meili_data | 136K → **1.6 GiB** |
| disk free | 38 GiB → 36 GiB（Δ ~2 GiB） |
| `pnpm verify` | **PASS** · 6/6 sample queries 各 5 hits |
| `/api/stats` | numberOfDocuments=500000, isIndexing=false |

完整报告：`reports/TENCENT_500K_CLOUD_PASS_REPORT.md`，stats 快照：`reports/tencent-500k-stats.json`。

### 已知文档 bug（本次已修）

旧的部署文档和 `scripts/deploy/import-500k.sh` 在 `pnpm import:file` 后多写了 `--`：

```bash
# WRONG — 触发 "未知参数：--"
docker compose exec -T api pnpm import:file -- --file /data/private/books.txt ...

# RIGHT — 这次 500k 实测用的就是这个
docker compose exec -T api pnpm import:file --file /data/private/books.txt ...
```

本次已经把 `docs/DEPLOY_TENCENT_CLOUD.md`、`docs/OPERATIONS.md`、`scripts/deploy/import-500k.sh` 里的 `--` 都去掉了。

### S16 前置条件（全量导入）

`reports/FULL_IMPORT_PREFLIGHT.md` 当前显示：

```
[preflight] BLOCKED: estimatedFullIndex=41.75 GiB free=37.19 GiB
```

也就是当前单系统盘 100G 上不能跑全量。S16 前必须：

1. **挂独立 /data 盘**，**≥100GiB**（推荐 **160GiB+**），把 `/data/book-id-search/meili_data` 迁过去。
2. **不要**把 `MEILI_PORT_BIND` 改成 `0.0.0.0:7700`（7700 继续只绑 `127.0.0.1`）。
3. **不要**直接改 Caddy / 80 / 443；用反向代理把 80/443 → 5173/3001 才是稳态。
4. **不要**碰已经在跑的 `books` 500k 索引；全量用 `--reset-index` 是显式动作。
5. 跑全量用 `scripts/deploy/import-full.sh`（本仓库新增，未执行）。

公网访问现状与建议收口方式见 `reports/PUBLIC_ACCESS_CHECK.md`。
### Caddy 反代站点已上线（2026-06-30）

公网入口已收敛到 Caddy：

- 域名：`https://books.conanxin.com` → Caddy → `127.0.0.1:5173`（web 容器）
- TLS：Let's Encrypt 自动签发 + 自动续期（cert issuer=Let's Encrypt YE2）
- HTTP/2、HTTPS 都通过验证：
  - `GET https://books.conanxin.com/` → 200, `via: 1.1 Caddy`
  - `GET https://books.conanxin.com/api/health` → `{"ok":true,"meili":{"status":"available"},"index":"books"}`
  - `GET https://books.conanxin.com/api/stats` → `numberOfDocuments=500000`
  - `GET https://books.conanxin.com/api/search?q=9787538455250` → 命中 13000000_000008232537
- `music.conanxin.com`（已有站点）**未受影响**
- `127.0.0.1:7700`（Meili）**未公网**

#### Caddy reload 的坑

- `sudo systemctl reload caddy` 在 WSL 容器内会失败：`status=226/NAMESPACE`，原因是 systemd 启动 caddy reload 子进程时 mount 命名空间失败（`/run/systemd/unit-root/tmp` 不存在）
- 解决方法：`sudo caddy reload --config /etc/caddy/Caddyfile --force` 直接调用，绕过 systemctl namespace

#### 收口剩余动作（用户手动）

- **关闭 TCP 3001 公网入站**（安全组）：现在 3001 仍公网可访问，验证窗口已结束可以收
- **关闭 TCP 5173 公网入站**（安全组）：Caddy 通过本机 127.0.0.1:5173 访问 web，公网不再需要
- **保留 80/443 公网**：Caddy 需要
- **保留 22**：SSH 需要
- **不要开放 7700**

#### 当前 Caddy 配置（`/etc/caddy/Caddyfile`）

```
music.conanxin.com {
    encode gzip zstd
    reverse_proxy 127.0.0.1:8787
    header {
        X-Frame-Options "DENY"
        X-Content-Type-Options "nosniff"
        Referrer-Policy "strict-origin-when-cross-origin"
    }
}

books.conanxin.com {
    encode gzip zstd
    reverse_proxy 127.0.0.1:5173 {
        header_up Host {host}
        header_up X-Real-IP {remote_host}
    }
    header {
        X-Frame-Options SAMEORIGIN
        X-Content-Type-Options nosniff
        Referrer-Policy strict-origin-when-cross-origin
    }
}
```

`X-Forwarded-For` / `X-Forwarded-Proto` 已经被 Caddy reverse_proxy 自动设置，删掉以免 caddy validate warning。