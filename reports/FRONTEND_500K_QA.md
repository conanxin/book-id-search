# 前端 500000 行索引 QA 报告

## 结论

- 状态：PASS
- 前端地址：`http://127.0.0.1:6174`
- API 地址：`http://127.0.0.1:3001/api`
- `5173` 当前被其他本地页面占用，本项目使用 `6174`
- 浏览器 console error：0

## 首页

- 首页可打开：PASS
- 标题 `图书 SSID / DXID 检索`：PASS
- stats 显示 records：PASS，`500,000`
- stats 显示 index：PASS，`books`
- stats 显示 last import：PASS，`2026/6/30 11:20:00`
- stats 显示 indexing：PASS，`空闲`

## 搜索交互

搜索关键词：`南北异人传`

- 搜索框可输入：PASS
- 搜索按钮可点击：PASS
- 结果数量显示：PASS，`共 354 条`
- 结果卡片显示 parseStatus：PASS，显示 `正常`
- 结果卡片显示 rawInfo：PASS

## 弱解析提示

搜索关键词：`13001363`

- 命中弱解析记录：PASS
- 显示 `弱解析`：PASS
- 显示提示 `本条为弱解析，原始记录已保留。`：PASS
- ISBN 缺失显示为占位：PASS，`—`

## 详情页

详情地址：`http://127.0.0.1:6174/books/13253452_000007920349`

- 详情页可打开：PASS
- rawInfo 可见：PASS
- `复制`按钮存在：PASS
- 相关图书可见：PASS
- 相关图书中弱解析提示可见：PASS

## 判断

500000 行索引下，前端首页、搜索、弱解析提示、详情页和相关图书展示均可用。
