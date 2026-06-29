# 真实 100000 行演示索引恢复报告

## 结论

- 状态：PASS
- 数据文件：`E:\读秀512w（下架书及ss与isbn码）.txt`
- Meilisearch index：`books`
- API 地址：`http://127.0.0.1:3001/api`
- 前端地址：`http://127.0.0.1:6174`

## 导入结果

- 导入命令：`pnpm import:file -- --file "E:\读秀512w（下架书及ss与isbn码）.txt" --limit 100000 --reset-index --checkpoint reports/import-checkpoint-100k.json --report reports/import-100k-report.json`
- 导入数量：100000
- 读取到的最后行号：100000
- 导入耗时：73.12 秒
- checkpoint：`reports/import-checkpoint-100k.json`
- 导入报告：`reports/import-100k-report.json`
- latest 报告：`reports/latest-import-report.json`

## parseStatus 分布

| parseStatus | 数量 |
| --- | ---: |
| ok | 90187 |
| weak | 9813 |
| failed | 0 |

本次 100000 行弱解析主要来自 ISBN 缺失；`rawInfo` 已保留原始记录。

## 搜索验证样例

| 类型 | 查询 | 结果 |
| --- | --- | --- |
| SSID | `13000000` | PASS，命中 5 条 |
| DXID | `000008232537` | PASS，命中 5 条 |
| ISBN | `9787538455250` | PASS，命中 5 条 |
| 书名 | `时尚秋冬披肩、吊带` | PASS，命中 5 条 |
| 作者 | `（日）日本靓丽社著；陈瑶` | PASS，命中 5 条 |
| 出版社 | `吉林科学技术出版社` | PASS，命中 5 条 |

另用 API 从索引样例 `散曲丛刊  小山乐府续集` 回灌验证：

| 类型 | 查询 | 命中数 |
| --- | --- | ---: |
| 书名 | `散曲丛刊  小山乐府续集` | 4 |
| 作者 | `任纳` | 740 |
| 出版社 | `上海：上海古籍出版社` | 8321 |
| SSID | `13055082` | 1 |
| DXID | `000007828217` | 1 |
| ISBN | `9787532597789` | 1 |

## API 验证

- `/api/health`：PASS
- `/api/stats`：PASS，`numberOfDocuments=100000`，`isIndexing=false`
- `/api/search`：PASS，SSID / DXID / ISBN / 书名 / 作者 / 出版社均可检索。

## 注意

当前 Meilisearch Windows binary 仍运行在 C: 临时目录，适合保留 100000 行演示索引，不建议直接继续跑 500000 行或全量导入。
