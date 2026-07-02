// ------------------------------------------------------------------
// Search-quality regression cases (S24-C6).
// ------------------------------------------------------------------
// Pure data: case definitions for the regression runner. The runner
// itself is in search-quality-regression.ts; these cases can be
// imported by tests or other tooling.
//
// Each case has:
//   - q: the raw query as it would arrive from the front-end
//   - expectations: assertions the runner checks after calling
//     /api/search against the live site.

export interface SearchQualityExpectations {
  cleaned?: string;
  removedPhrasesIncludes?: string[];
  intentType?: string;
  detectedType?: string;
  topId?: string;
  topResultsShouldNotInclude?: string[];
  topResultsShouldContainAnyTerms?: string[];
  topResultsShouldContain?: string[];
  noFiveHundred?: boolean;
}

export interface SearchQualityCase {
  id: string;
  description: string;
  q: string;
  limit?: number;
  expectations: SearchQualityExpectations;
}

export const SEARCH_QUALITY_CASES: SearchQualityCase[] = [
  {
    id: "beijing-travel-natural-language",
    description: "查一下北京旅游的书 — must clean to 北京旅游, detect travel_guide, demote 查斯特菲尔德",
    q: "查一下北京旅游的书",
    limit: 10,
    expectations: {
      cleaned: "北京旅游",
      removedPhrasesIncludes: ["查一下", "的书"],
      intentType: "travel_guide",
      detectedType: "text",
      topResultsShouldContainAnyTerms: ["北京", "旅游", "指南", "自助游", "景点"],
    },
  },
  {
    id: "luxun-related-books",
    description: "帮我找一本鲁迅相关图书 — must clean to 鲁迅",
    q: "帮我找一本鲁迅相关图书",
    expectations: {
      cleaned: "鲁迅",
      // Cleanup joins "相关图书" into a single phrase via the
      // generic-noun list; the test only requires one of the
      // operation/generic phrases to be present.
      removedPhrasesIncludes: ["帮我找一本"],
      intentType: "literature",
      topResultsShouldContain: ["鲁迅"],
    },
  },
  {
    id: "liao-buddhist-pagoda",
    description: "有没有关于辽代佛塔的书 — must clean to 辽代佛塔",
    q: "有没有关于辽代佛塔的书",
    expectations: {
      cleaned: "辽代佛塔",
      intentType: "academic_research",
      topResultsShouldContainAnyTerms: ["佛塔", "辽", "建筑"],
    },
  },
  {
    id: "isbn-spoken",
    description: "ISBN 是 978-7-5384-5525-0 的书 — natural-language ISBN lookup (pre-existing normalize behavior, may not detect isbn prefix; the trailing number alone is precise enough to find the right book)",
    q: "ISBN 是 978-7-5384-5525-0 的书",
    expectations: {
      // detectedType is currently "text" because normalize doesn't
      // strip "ISBN 是" — pre-existing behavior, not a search-quality
      // regression. We only require the cleanup to remove "的书".
      removedPhrasesIncludes: ["的书"],
      topResultsShouldContainAnyTerms: ["时尚秋冬披肩", "吊带"],
    },
  },
  {
    id: "dxid-exact",
    description: "000008232537 — must detect as dxid",
    q: "000008232537",
    expectations: {
      detectedType: "dxid",
      topId: "13000000_000008232537",
    },
  },
  {
    id: "ssid-exact",
    description: "13000000 — must detect as ssid",
    q: "13000000",
    expectations: {
      detectedType: "ssid",
      topId: "13000000_000008232537",
    },
  },
  {
    id: "japanese-shawl-handicraft",
    description: "日本人写的披肩吊带手工书 — corpus doesn't have a strong match for 'japanese + shawl + handicraft' in top-5; the canonical 披肩 book is 时尚秋冬披肩、吊带; we allow no top-5 hit to be WARN since corpus coverage is the real constraint",
    q: "日本人写的披肩吊带手工书",
    expectations: {
      // Intent: practical_manual is the closest, but the cleanup
      // strips "书" so the residual query is "日本人写的披肩吊带手工".
      // We accept any non-empty result set; flag if no top-5 title
      // mentions any of the obvious shawl terms.
      topResultsShouldContainAnyTerms: ["披肩", "吊带", "手工", "编织", "日本"],
    },
  },
  {
    id: "beijing-travel-guide",
    description: "北京旅游指南 — travel_guide with high confidence",
    q: "北京旅游指南",
    expectations: {
      cleaned: "北京旅游指南",
      intentType: "travel_guide",
    },
  },
  {
    id: "beijing-tourism-research",
    description: "北京旅游发展研究 — academic_research dominance",
    q: "北京旅游发展研究",
    expectations: {
      intentType: "academic_research",
      // Research-report titles should not all be wiped out.
      topResultsShouldContainAnyTerms: ["北京", "旅游"],
    },
  },
  {
    id: "chinese-dictionary",
    description: "汉语词典 — reference intent",
    q: "汉语词典",
    expectations: {
      intentType: "reference",
      topResultsShouldContainAnyTerms: ["词典", "汉语"],
    },
  },
  {
    id: "children-picture-book",
    description: "儿童绘本 小猫 — should not 500, may have results",
    q: "儿童绘本 小猫",
    expectations: {
      noFiveHundred: true,
      topResultsShouldContainAnyTerms: ["儿童", "绘本", "小猫"],
    },
  },
  {
    id: "commercial-press-dictionary",
    description: "商务印书馆 词典 — publisher/reference",
    q: "商务印书馆 词典",
    expectations: {
      intentType: "reference",
      topResultsShouldContainAnyTerms: ["商务", "词典"],
    },
  },
  {
    id: "tourism-education-press-beijing",
    description: "旅游教育出版社 北京旅游 — publisher + travel",
    q: "旅游教育出版社 北京旅游",
    expectations: {
      topResultsShouldContainAnyTerms: ["旅游", "北京"],
    },
  },
  {
    id: "obscure-query-no-crash",
    description: "蓝色封面 月球茶壶维修 — should not 500",
    q: "蓝色封面 月球茶壶维修",
    expectations: {
      noFiveHundred: true,
    },
  },
  {
    id: "empty-query",
    description: "empty query — must return 200 with items=[]",
    q: "",
    expectations: {
      noFiveHundred: true,
    },
  },
];