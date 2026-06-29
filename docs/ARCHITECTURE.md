# 架构说明

## 组件

- `apps/web`：Vite + React + TypeScript 中文前端。
- `apps/api`：Node.js + Express + TypeScript API。
- `scripts/import-books.ts`：TXT 流式导入脚本。
- `scripts/parse-line.ts`：容错单行解析器。
- `meilisearch`：全文搜索与索引存储。

## 数据流

1. 私有 TXT 文件通过 `pnpm import:file` 传入导入脚本。
2. 导入脚本逐行解析并批量写入 Meilisearch `books` index。
3. API 从 Meilisearch 查询并返回标准 JSON。
4. Web 通过 `VITE_API_BASE_URL` 调 API，展示搜索结果和详情。

## 索引设置

- primary key：`id`
- searchableAttributes：`title, author, publisher, isbn, ssid, dxid, rawInfo`
- displayedAttributes：核心字段与解析状态
- filterableAttributes：`year, publisher, parseStatus`
- sortableAttributes：`year`

## 部署形态

- 开发：`docker compose up -d meilisearch` + `pnpm dev`
- 生产：`docker compose up -d --build`
- 生产 Web 使用 Nginx 托管静态文件并反向代理 `/api` 到 API 容器。
