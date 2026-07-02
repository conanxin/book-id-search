// ------------------------------------------------------------------
// Intent profile (S24-2).
// ------------------------------------------------------------------
// Pure helpers. No I/O. Given a cleaned natural-language query,
// return the inferred user intent + positive/negative term lists
// that the rerank layer uses to promote matching titles and
// demote mismatched genres.
//
// Why this exists:
//   "北京旅游" should rank travel guides above research reports on
//   tourism economics. The previous S19 rerank layer only looked at
//   raw field hits; "北京" + "旅游" matched the research report
//   too, so it competed. Intent lets the rerank layer
//   deterministically favor travel-guide titles and downrank
//   research-report titles for the same query.
//
// The classification is rule-based, not ML. We have 6 domain
// types (travel_guide, academic_research, practical_manual,
// literature, textbook, reference) and 1 catch-all (general).
// Each type has:
//   - triggers: 1-3 word tokens whose presence strongly suggests the
//     intent. Detection: if any trigger is a substring of the
//     cleaned query, that intent is a candidate.
//   - positiveTerms: vocabulary that, when present in a book's
//     title/author/publisher, should bump the book's local rank
//     for this intent.
//   - negativeTerms: vocabulary that should demote the book for
//     this intent (e.g. "研究报告" / "论文集" for travel_guide).
//   - label: short Chinese label for the UI.

export type IntentType =
  | "travel_guide"
  | "practical_manual"
  | "academic_research"
  | "literature"
  | "textbook"
  | "reference"
  | "general";

export interface IntentProfile {
  type: IntentType;
  label: string;
  positiveTerms: string[];
  negativeTerms: string[];
  /** "high" if the query contains a strong trigger; "medium" if only
   *  a soft hint; "low" if we fell back to general. */
  confidence: "none" | "low" | "medium" | "high";
}

interface IntentDef {
  type: IntentType;
  label: string;
  triggers: string[];
  positiveTerms: string[];
  negativeTerms: string[];
}

const INTENTS: IntentDef[] = [
  {
    type: "travel_guide",
    label: "旅行指南",
    triggers: [
      "旅游",
      "旅行",
      "自助游",
      "景点",
      "游记",
      "攻略",
      "导游",
      "出游",
      "度假",
      "指南",  // "北京旅游指南" should be high-confidence
    ],
    positiveTerms: [
      "指南",
      "自助游",
      "景点",
      "旅行",
      "游记",
      "攻略",
      "实用",
      "路线",
      "地图",
      "风光",
    ],
    negativeTerms: [
      "研究报告",
      "论文集",
      "统计年鉴",
      "发展战略",
      "咨询报告",
      "规划报告",
    ],
  },
  {
    type: "academic_research",
    label: "学术研究",
    triggers: [
      "研究",
      "论文",
      "学术",
      "考古",
      "报告",
      "史料",
      "考",
      "学",
      "理论",
    ],
    positiveTerms: [
      "研究",
      "论文",
      "考古",
      "史料",
      "报告",
      "文集",
      "学术",
      "理论",
      "分析",
      "史",
      "学",
    ],
    negativeTerms: [
      "入门",
      "实用",
      "自助游",
      "攻略",
      "指南",
      "图解",
      "儿童",
    ],
  },
  {
    type: "practical_manual",
    label: "实用手册",
    triggers: [
      "手册",
      "教程",
      "操作",
      "实用",
      "入门",
      "训练",
      "图解",
      "做法",
      "技巧",
      "编织",
      "钩针",
    ],
    positiveTerms: [
      "手册",
      "教程",
      "实用",
      "操作",
      "图解",
      "入门",
      "技巧",
      "做法",
      "训练",
      "基础",
    ],
    negativeTerms: [
      "研究",
      "论文",
      "战略",
      "报告",
      "理论",
    ],
  },
  {
    type: "literature",
    label: "文学作品",
    triggers: [
      "小说",
      "诗",
      "散文",
      "文集",
      "故事",
      "寓言",
      "童话",
      "鲁迅",
    ],
    positiveTerms: [
      "小说",
      "文集",
      "散文",
      "诗",
      "故事",
      "选集",
      "全集",
      "作品",
      "短篇",
      "长篇",
    ],
    negativeTerms: [
      "辞典",
      "年鉴",
      "汇编",
      "索引",
      "研究报告",
      "攻略",
    ],
  },
  {
    type: "textbook",
    label: "教材教辅",
    triggers: [
      "教材",
      "教辅",
      "课本",
      "练习",
      "试题",
      "考研",
      "高考",
      "中考",
    ],
    positiveTerms: [
      "教材",
      "教辅",
      "课本",
      "练习",
      "试题",
      "教程",
      "同步",
      "辅导",
      "复习",
    ],
    negativeTerms: [
      "小说",
      "故事",
      "游记",
      "散文",
    ],
  },
  {
    type: "reference",
    label: "工具书/辞典",
    triggers: [
      "辞典",
      "词典",
      "字典",
      "年鉴",
      "索引",
      "目录",
      "资料汇编",
      "大百科",
      "百科",
    ],
    positiveTerms: [
      "辞典",
      "年鉴",
      "索引",
      "汇编",
      "资料",
      "百科",
      "大全",
    ],
    negativeTerms: [
      "小说",
      "故事",
      "游记",
      "散文",
    ],
  },
];

/**
 * Pick the most specific intent for `query`. If no intent has a
 * trigger that matches, returns a "general" profile with empty
 * positive/negative terms — the rerank layer treats that as
 * "no opinion".
 *
 * Dominance rules (S24-2):
 *   When two intents tie on raw trigger score, the "more
 *   technical" intent wins. Specifically, if the query contains
 *   any of the academic-research strong-signal triggers (研究 /
 *   论文 / 学术 / 考古 / 史料 / 理论), the intent is forced to
 *   academic_research even if a lifestyle intent (旅游 / 旅行 /
 *   ...) also matched. This reflects the user behavior of "I want
 *   the academic study of X", not "I want a holiday guide about
 *   X". Same logic for textbook: 教材 / 教辅 / 试题 / 高考 / 考研
 *   force textbook.
 */
const ACADEMIC_DOMINANCE = ["研究", "论文", "学术", "考古", "史料", "理论"];
const TEXTBOOK_DOMINANCE = ["教材", "教辅", "课本", "试题", "考研", "高考", "中考"];

export function detectIntentProfile(query: string): IntentProfile {
  const q = (query ?? "").toString().trim();
  if (!q) {
    return {
      type: "general",
      label: "通用",
      positiveTerms: [],
      negativeTerms: [],
      confidence: "low",
    };
  }

  // Dominance short-circuit: if any "strong-signal" trigger is
  // present, force the corresponding intent. This lets "北京
  // 旅游发展研究" resolve to academic_research instead of
  // travel_guide.
  for (const trig of ACADEMIC_DOMINANCE) {
    if (q.includes(trig)) {
      const def = INTENTS.find((d) => d.type === "academic_research")!;
      const hitCount = def.triggers.filter((t) => q.includes(t)).length;
      const confidence: IntentProfile["confidence"] =
        hitCount >= 3 ? "high" : hitCount >= 2 ? "medium" : "low";
      return {
        type: def.type,
        label: def.label,
        positiveTerms: def.positiveTerms,
        negativeTerms: def.negativeTerms,
        confidence,
      };
    }
  }
  for (const trig of TEXTBOOK_DOMINANCE) {
    if (q.includes(trig)) {
      const def = INTENTS.find((d) => d.type === "textbook")!;
      const hitCount = def.triggers.filter((t) => q.includes(t)).length;
      const confidence: IntentProfile["confidence"] =
        hitCount >= 3 ? "high" : hitCount === 2 ? "medium" : "low";
      return {
        type: def.type,
        label: def.label,
        positiveTerms: def.positiveTerms,
        negativeTerms: def.negativeTerms,
        confidence,
      };
    }
  }

  // Score each intent by the number of distinct triggers that
  // appear as substrings in the query. Longer triggers get a
  // slight bonus (more specific).
  let best: { def: IntentDef; score: number } | null = null;
  for (const def of INTENTS) {
    let score = 0;
    for (const trig of def.triggers) {
      if (q.includes(trig)) {
        // Bonus for longer triggers (more specific).
        score += 1 + Math.max(0, trig.length - 1) * 0.1;
      }
    }
    if (score > 0 && (!best || score > best.score)) {
      best = { def, score };
    }
  }

  if (!best) {
    return {
      type: "general",
      label: "通用",
      positiveTerms: [],
      negativeTerms: [],
      confidence: "low",
    };
  }

  // Confidence: 1 trigger = low, 2 = medium, 3+ = high.
  const triggerHits = best.def.triggers.filter((t) => q.includes(t)).length;
  const confidence: IntentProfile["confidence"] =
    triggerHits >= 3 ? "high" : triggerHits === 2 ? "medium" : "low";

  return {
    type: best.def.type,
    label: best.def.label,
    positiveTerms: best.def.positiveTerms,
    negativeTerms: best.def.negativeTerms,
    confidence,
  };
}
