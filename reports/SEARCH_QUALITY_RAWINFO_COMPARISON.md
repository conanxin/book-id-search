# Search Quality RawInfo Comparison

- Status: PASS
- Reason: Standard fields still match when rawInfo is not searchable.

## Sample

- id: `13000000_000008232537`
- SSID: `13000000`
- DXID: `000008232537`
- title: 时尚秋冬披肩、吊带
- author: （日）日本靓丽社著；陈瑶译
- publisher: 长春：吉林科学技术出版社
- ISBN: `9787538455250`
- rawInfo-only candidate: not found

| query type | query | required | rawInfo=true hits | rawInfo=false hits | rawInfo=true sample | rawInfo=false sample |
| --- | --- | --- | ---: | ---: | --- | --- |
| SSID | `13000000` | yes | 10 | 10 | yes | yes |
| DXID | `000008232537` | yes | 10 | 10 | yes | yes |
| ISBN | `9787538455250` | yes | 2 | 2 | yes | yes |
| title | `时尚秋冬披肩、吊带` | yes | 10 | 10 | yes | yes |
| author | `（日）日本靓丽社著；陈瑶` | yes | 10 | 10 | yes | yes |
| publisher | `吉林科学技术出版社` | yes | 10 | 10 | yes | yes |

## Conclusion
- SSID / DXID / ISBN / title / author / publisher remain searchable without rawInfo.
- If only rawInfo-only fragments stop matching, that is an acceptable production tradeoff for faster indexing and smaller search surface.
