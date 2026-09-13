import { describe, expect, it } from "vitest";
import { normalizeQuery } from "./normalize.js";
import { interpretBookQuery } from "./query-interpretation.js";

const examples: Array<[string, string, string | null]> = [
  ["帮我找钱钟书的《围城》", "围城", "钱钟书"],
  ["找鲁迅的《呐喊》", "呐喊", "鲁迅"],
  ["帮我找老舍写的《骆驼祥子》", "骆驼祥子", "老舍"],
  ["想找沈从文的《边城》", "边城", "沈从文"],
  ["找一本《汉语大词典》", "汉语大词典", null],
  ["请帮我找 梁思成 所著的《中国建筑史》", "中国建筑史", "梁思成"],
  ["陈寅恪著《隋唐制度渊源略论稿》", "隋唐制度渊源略论稿", "陈寅恪"],
  ["有没有《乡土中国》？", "乡土中国", null],
  ["《围城》", "围城", null],
];

const unchanged = [
  "", "   ", "围城 钱钟书", "找梁思成《中国建筑史》",
  "小时候看过一本蓝色封面的苏联航天书", "想了解北京城市史",
  "找《围城》和《边城》", "比较《围城》和《围城》",
  "找《围城", "找围城》", "找《围《城》》", "找《》", "找《  》",
  "《围城》哪个版本适合普通阅读", "找《史记》不要学生版",
  "找《围城》1997年漓江出版社版", "找《围城》给小学生看",
  "不要找鲁迅的《呐喊》", "找非鲁迅的《呐喊》",
  "找鲁迅和老舍的《小说集》", "找鲁迅、老舍的《小说集》",
  "找人民文学出版社的《红楼梦》", "找三联书店的《乡土中国》",
  "找关于鲁迅的《呐喊》", "找鲁迅研究的《呐喊》",
  "找他的《呐喊》", "找你推荐的《呐喊》",
  "读过《围城》", "找鲁迅的《呐喊》作者不是鲁迅",
  "找列夫·托尔斯泰写的《战争与和平》",
];

const identifiers = [
  "978-7-5384-5525-0", "ISBN 是 978-7-5384-5525-0 的书",
  "13000000", "SSID: 13000000", "DXID: 000008232537",
  "000008232537", "0-8044-2957-X", "ISBN ０８０４４２９５７X",
];

describe("interpretBookQuery (S31-B1)", () => {
  it("S31_B1_known_item", () => {
    expect(interpretBookQuery(examples[0][0])).toMatchObject({
      status: "parsed", task: "known_item_lookup", workTitle: "围城",
      author: "钱钟书", searchQuery: "围城 钱钟书",
    });
  });

  it.each(examples)("parses %s", (query, title, author) => {
    const result = interpretBookQuery(query);
    expect(result.status).toBe("parsed");
    expect(result.task).toBe("known_item_lookup");
    expect(result.originalQuery).toBe(query);
    expect(result.workTitle).toBe(title);
    expect(result.author).toBe(author);
    expect(result.searchQuery).toBe(author ? `${title} ${author}` : title);
  });

  it.each(unchanged)("preserves unsupported input %s", (query) => {
    expect(interpretBookQuery(query)).toMatchObject({
      status: "passthrough", task: null, originalQuery: query,
      workTitle: null, author: null, searchQuery: query,
    });
  });

  it.each(identifiers)("keeps the identifier route for %s", (query) => {
    const before = normalizeQuery(query);
    expect(["isbn", "ssid", "dxid"]).toContain(before.detectedType);
    const result = interpretBookQuery(query);
    expect(result.status).toBe("passthrough");
    expect(result.searchQuery).toBe(query);
    expect(normalizeQuery(result.searchQuery)).toEqual(before);
    expect(result.author).toBeNull();
    expect(result.workTitle).toBeNull();
  });

  it("preserves title text, inner spaces and original input", () => {
    const title = "  关于\u3000资料和推荐的书  ";
    const query = `  请帮我找一本《${title}》？  `;
    const result = interpretBookQuery(query);
    expect(result.status).toBe("parsed");
    expect(result.workTitle).toBe(title);
    expect(result.searchQuery).toBe(title);
    expect(result.originalQuery).toBe(query);
  });

  it("uses syntax, not a known-book or known-author lookup", () => {
    for (const author of ["赵青禾", "林初", "欧阳子墨"]) {
      for (const title of ["未入书库的纸船", "请帮我找关于资料的书"]) {
        const result = interpretBookQuery(`帮我找${author}写的《${title}》`);
        expect(result.workTitle).toBe(title);
        expect(result.author).toBe(author);
        expect(result.searchQuery).toBe(`${title} ${author}`);
      }
    }
  });

  it("does not assume that a book was written by its usual author", () => {
    expect(interpretBookQuery("找余华写的《围城》").author).toBe("余华");
  });

  it("is deterministic and returns independent results", () => {
    const a = interpretBookQuery(examples[0][0]);
    const b = interpretBookQuery(examples[0][0]);
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });

  it("rejects non-string input explicitly", () => {
    expect(() => interpretBookQuery(null as unknown as string)).toThrow(TypeError);
  });
});
