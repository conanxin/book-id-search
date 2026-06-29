# 数据格式

## 原始 TXT 行格式

```text
SSID,DXID,书名,作者/编者/译者,出版地/出版社,出版年,页数,ISBN
```

示例：

```text
13509536,000030003051,我又回来了,（法）德比纳著；武娟译,南昌：二十一世纪出版社,2013,30,7539177470
```

## 索引文档字段

| 字段 | 说明 |
| --- | --- |
| `id` | Meilisearch 主键，优先 `ssid_dxid` |
| `ssid` | 读秀 SSID |
| `dxid` | DXID |
| `title` | 书名 |
| `author` | 作者、编者、译者等 |
| `publisher` | 出版地与出版社 |
| `year` | 出版年，无法解析时为 `null` |
| `pages` | 页数，无法解析时为 `null` |
| `isbn` | 去除空格和连字符后的 ISBN |
| `rawInfo` | 原始整行内容 |
| `parseStatus` | `ok`、`weak`、`failed` |
| `parseWarnings` | 解析提示列表 |

## 容错策略

- 支持逗号分隔和 Tab 分隔。
- 字段缺失不会中断导入。
- 出版社字段中的中文冒号不作为分隔符。
- ISBN 缺失时保留空字符串。
- 年份或页数非数字时保留 `null` 并标记 warning。
