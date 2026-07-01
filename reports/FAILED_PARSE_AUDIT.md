# Failed Parse Audit

Source: `/tmp/books-full.txt`
Lines scanned: 5,115,734
Failed parses: 287 (0.0056%)
Elapsed: 13.8s @ 371082 lines/s
Started: 2026-07-01T07:06:38.150Z
Finished: 2026-07-01T07:06:51.936Z

## Reason Distribution

| Reason | Count | Share |
|---|---:|---:|
| missing_dxid | 176 | 61.3% |
| publisher_isbn_dxid_missing | 98 | 34.1% |
| embedded_comma_in_fields | 13 | 4.5% |

## Top Field-Count Distribution (failed lines)

| Field count | Count |
|---:|---:|
| 8 | 274 |
| 12 | 8 |
| 13 | 5 |

## Per-Reason Examples (first 3 each)

### missing_dxid (176)

- line 5092809, id=`line_5092809`, fields=8, warnings=["missing_dxid","missing_title","missing_author","missing_isbn","missing_year"]
  - raw: `40615646,,,,2005,,279,`
- line 5092810, id=`line_5092810`, fields=8, warnings=["missing_dxid","missing_title","missing_author","missing_isbn","missing_year"]
  - raw: `40678731,,,,2000.07,,303,`
- line 5092811, id=`line_5092811`, fields=8, warnings=["missing_dxid","missing_title","missing_author","missing_isbn","missing_year"]
  - raw: `40678739,,,,1989.03,,190,`

### publisher_isbn_dxid_missing (98)

- line 5115380, id=`line_5115380`, fields=8, warnings=["missing_dxid","missing_title","missing_author","missing_publisher","missing_isbn","missing_year"]
  - raw: `11067055,,,,,,341,`
- line 5115381, id=`line_5115381`, fields=8, warnings=["missing_dxid","missing_title","missing_publisher","missing_isbn","missing_year"]
  - raw: `11067056,,,北京国际化纤会议委员会,,,571,`
- line 5115382, id=`line_5115382`, fields=8, warnings=["missing_dxid","missing_title","missing_author","missing_publisher","missing_isbn","year_non_numeric:1999年09月"]
  - raw: `11067087,,,,,1999年09月,393,`

### embedded_comma_in_fields (13)

- line 4898292, id=`line_4898292`, fields=12, warnings=["field_count_high:12","missing_dxid","missing_title","missing_publisher","missing_isbn","missing_year"]
  - raw: `40038179,,,[英]戴维斯(Davis,Lee)等编,中国宇航出版社,200年01月第1版,,,,90,`
- line 4898297, id=`line_4898297`, fields=12, warnings=["field_count_high:12","missing_dxid","missing_title","missing_publisher","missing_isbn","missing_year"]
  - raw: `40038312,,,[英]狄更斯（Dickens,C.）著,华东师范大学出版社,2004年01月第1版,,,,183,`
- line 4898298, id=`line_4898298`, fields=12, warnings=["field_count_high:12","missing_dxid","missing_title","missing_publisher","missing_isbn","missing_year"]
  - raw: `40038314,,,[英]奥斯丁（Austen,J.）著,华东师范大学出版社,2004年01月第1版,,,,160,`

## Interpretation

- The dominant failure mode is **missing_dxid** (61.3% of failures).
- failedParsed lines are NOT indexed (importer skips them). They are recorded in the import report samples.
- weakParsed lines ARE indexed (with rawInfo preserved) — those are 1,598,107 lines missing only ISBN or with non-numeric year/pages.
- These failures reflect data quality issues in the source TXT, not importer bugs.
