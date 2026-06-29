# 腾讯云部署

## 推荐配置

- 最低测试：2 核 4GB / 80GB SSD，适合样例、10 万行、50 万行试跑。
- 推荐全量：4 核 8GB / 160GB SSD，适合 500 万行级别全量导入。
- 更稳：4 核 16GB / 200GB SSD，适合更从容地导入、重建索引和保留备份。
- 建议额外预留数据盘，用于 TXT、Meilisearch 数据目录和备份。
- 生产环境不要把 Meilisearch 数据放在空间很小的系统盘。优先把 `MEILI_DATA_DIR` 指向 SSD 数据盘目录。

## 安装 Docker

Ubuntu 示例：

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
```

重新登录后验证：

```bash
docker --version
docker compose version
```

## 上传代码

```bash
git clone <your-repo-url> book-id-search
cd book-id-search
cp .env.example .env
```

编辑 `.env`，把 `MEILI_MASTER_KEY` 改成强随机字符串。

建议设置持久化目录：

```bash
mkdir -p /data/book-id-search/meili_data
sed -i 's#MEILI_DATA_DIR=.*#MEILI_DATA_DIR=/data/book-id-search/meili_data#' .env
```

## 上传 TXT 数据

不要放入 Git。建议放在服务器私有目录：

```bash
mkdir -p ~/private-data
scp "读秀512w（下架书及ss与isbn码）.txt" user@server:~/private-data/
```

## 启动服务

```bash
docker compose up -d --build
```

## 导入数据

服务器上安装 Node.js 22 与 pnpm 后执行：

```bash
pnpm install
pnpm import:file -- --file "$HOME/private-data/读秀512w（下架书及ss与isbn码）.txt" --reset-index
```

如服务器内存紧张，先导入 10 万行：

```bash
pnpm import:file -- --file "$HOME/private-data/读秀512w（下架书及ss与isbn码）.txt" --limit 100000 --reset-index
```

全量导入前先做前置检查：

```bash
pnpm preflight:import -- --file "$HOME/private-data/读秀512w（下架书及ss与isbn码）.txt" --meili-data-dir "$MEILI_DATA_DIR"
```

建议分阶段导入：

```bash
pnpm import:file -- --file "$HOME/private-data/读秀512w（下架书及ss与isbn码）.txt" --offset 0 --limit 500000 --reset-index --checkpoint reports/import-checkpoint.json
pnpm import:file -- --file "$HOME/private-data/读秀512w（下架书及ss与isbn码）.txt" --offset 500000 --limit 500000 --checkpoint reports/import-checkpoint.json
pnpm import:file -- --file "$HOME/private-data/读秀512w（下架书及ss与isbn码）.txt" --offset 1000000 --checkpoint reports/import-checkpoint.json
```

断点续跑：

```bash
pnpm import:file -- --checkpoint reports/import-checkpoint.json --resume
```

查看 Meilisearch 数据目录大小：

```bash
du -sh "$MEILI_DATA_DIR"
df -h "$MEILI_DATA_DIR"
```

## 绑定域名

1. 在腾讯云 DNS 添加 A 记录指向服务器公网 IP。
2. 服务器防火墙和腾讯云安全组开放 80/443 端口。
3. 默认不要公网开放 7700；Meilisearch 只给 API 容器访问。
4. 如需 HTTPS，可在服务器前接入腾讯云 EdgeOne/CDN，或自行安装 Caddy/Nginx + Let's Encrypt。

## 查看日志

```bash
docker compose logs -f meilisearch
docker compose logs -f api
docker compose logs -f web
```

## 常见故障

- `Meilisearch 暂不可用`：检查 `docker compose ps` 和 `docker compose logs meilisearch`。
- 导入 401：确认 `.env` 中 `MEILI_MASTER_KEY` 与运行脚本环境一致。
- 导入慢：增大云硬盘性能，或降低 `--batch-size`。
- 全量导入内存不足：保留 10 万行可运行索引，升级到 8 GB 内存后重新导入。
