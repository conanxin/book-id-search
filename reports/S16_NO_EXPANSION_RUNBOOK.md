# S16 No-Expansion Full Import Runbook

Date: 2026-06-30

## 1. 前置条件

- [ ] 当前 books index 已备份确认
- [ ] 磁盘剩余空间 >= 30GiB（当前：36GiB）
- [ ] 500k demo 索引状态正常
- [ ] Meilisearch 服务健康
- [ ] 已通知用户约 15-20 分钟的维护窗口

## 2. 维护窗口说明

**预计维护时间：20-25 分钟**

- 0-1 min: 停止服务 + 删除旧索引
- 1-18 min: 全量导入（约 510 万条，5500 行/秒）
- 18-20 min: 验证索引 + 恢复服务

## 3. 当前 500k demo 恢复方案

如果全量导入失败，按以下步骤恢复 500k demo：

```bash
# Option 1: 使用 checkpoint 恢复（如果 checkpoint 存在）
MEILI_HOST=http://127.0.0.1:7700 npx tsx scripts/import-books.ts \
  --file /data/book-id-search/private-data/books.txt \
  --index books \
  --limit 500000 \
  --resume \
  --checkpoint reports/import-checkpoint.json

# Option 2: 从头重建 500k
MEILI_HOST=http://127.0.0.1:7700 npx tsx scripts/import-books.ts \
  --file /data/book-id-search/private-data/books.txt \
  --index books \
  --limit 500000 \
  --reset-index \
  --store-raw-info false \
  --index-profile minimal \
  --filter-profile minimal \
  --sortable-profile minimal
```

## 4. 全量执行策略

### 核心原则：
- ❌ 不做 tmp index（避免双倍磁盘占用）
- ❌ 不保留 500k meili_data（重置从头开始）
- ✅ clean start（reset 旧索引）
- ✅ reset books 索引
- ✅ full import 全量 510 万条

### 推荐命令：

```bash
cd /opt/book-id-search

# 1. 停止前端服务（避免用户访问空索引）
sudo docker compose stop web

# 2. 执行全量导入
MEILI_HOST=http://127.0.0.1:7700 npx tsx scripts/import-books.ts \
  --file /data/book-id-search/private-data/books.txt \
  --index books \
  --batch-size 20000 \
  --reset-index \
  --search-raw-info false \
  --store-raw-info false \
  --index-profile minimal \
  --filter-profile minimal \
  --sortable-profile minimal \
  --checkpoint reports/full-import-checkpoint.json \
  --disk-guard-free-gb 15

# 3. 验证导入结果
curl -s -H "Authorization: Bearer $MEILI_MASTER_KEY" \
  http://127.0.0.1:7700/indexes/books/stats

# 4. 恢复前端服务
sudo docker compose start web
```

## 5. 磁盘保护机制

### 启动前检查：
- 确保 `/` 分区剩余空间 >= 30GiB

### 导入中监控：
```bash
# 每 5 分钟检查一次
watch -n 300 df -h /

# 如果剩余空间 < 15GiB，立即停止导入
# Ctrl+C 终止进程
# 然后执行 500k 恢复方案
```

### 紧急阈值：
- ⚠️ < 15GiB：准备中止
- ❌ < 10GiB：立即中止并恢复

## 6. 失败恢复

### 使用 checkpoint 恢复（推荐）：

```bash
# 如果中途中断，使用 resume 继续
MEILI_HOST=http://127.0.0.1:7700 npx tsx scripts/import-books.ts \
  --file /data/book-id-search/private-data/books.txt \
  --index books \
  --resume \
  --checkpoint reports/full-import-checkpoint.json
```

### 清空后重建 500k：

```bash
# 删除失败的索引（通过 API），然后重建 500k demo
# 参考第 3 节的恢复命令
```

## 7. 绝不做的事

- ❌ **不做并行 full tmp index**：会双倍占用磁盘空间
- ❌ **不做全量 dump**：额外 2+GB 磁盘写入
- ❌ **不开放 7700 端口**：仅限 localhost 访问
- ❌ **不改 Caddy 配置**：保持现有安全配置

## 8. 验证清单

- [ ] 文档数量 >= 5,100,000
- [ ] SSID 搜索正常
- [ ] ISBN 搜索正常  
- [ ] Title 搜索正常
- [ ] Author 搜索正常
- [ ] 前端服务可正常访问
- [ ] 磁盘剩余空间 >= 10GiB
