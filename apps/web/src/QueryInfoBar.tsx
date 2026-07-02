/**
 * S24-C5 — Query-info chips bar.
 *
 * Shows under the search box when the API returns a `queryInfo` with
 * cleanup / intent signals. Lightweight, no large layout shifts, no
 * horizontal overflow at 360px.
 */
import type { QueryInfo } from "./api";

interface Props {
  queryInfo?: QueryInfo;
}

const INTENT_LABEL: Record<string, string> = {
  travel_guide: "旅行指南",
  practical_manual: "实用手册",
  academic_research: "学术研究",
  literature: "文学作品",
  textbook: "教材教辅",
  reference: "工具书/辞典",
  general: "通用",
};

export function QueryInfoBar({ queryInfo }: Props) {
  if (!queryInfo) return null;
  const qi = queryInfo;
  const cleanupApplied = qi.cleanupApplied === true;
  const intentType = qi.intentType;
  const showIntent = intentType && intentType !== "general" && qi.intentLabel;
  const showCleanup = cleanupApplied && (qi.cleaned ?? "").trim().length > 0;
  if (!showCleanup && !showIntent) return null;

  return (
    <div className="query-info-bar" role="status" aria-live="polite">
      {showCleanup ? (
        <>
          <span className="query-info-bar__chip query-info-bar__chip--cleanup">
            已自动忽略：
            {(qi.removedPhrases ?? []).join("、")}
          </span>
          <span className="query-info-bar__chip query-info-bar__chip--cleaned">
            实际搜索：<strong>{qi.cleaned}</strong>
          </span>
        </>
      ) : null}
      {showIntent ? (
        <span className="query-info-bar__chip query-info-bar__chip--intent">
          识别为：<strong>{qi.intentLabel}</strong>类检索
        </span>
      ) : null}
    </div>
  );
}

interface RankingProps {
  ranking?: {
    score: number;
    intentBoosts?: string[];
    intentPenalties?: string[];
    evidence?: string[];
  };
}

/**
 * S24-C5 — Ranking-evidence chips.
 *
 * Renders up to 3 short evidence strings for the current item's
 * ranking. The evidence array is filtered to keep only the most
 * user-meaningful chips (phrase match, intent boosts, intent
 * penalties). Pure ranking score is not shown to the user.
 */
export function RankingChips({ ranking }: RankingProps) {
  if (!ranking) return null;
  const phrases: string[] = [];
  if (ranking.evidence) {
    for (const e of ranking.evidence) {
      // Skip internal-only evidence ("标识符精确匹配" already shown
      // via the match badge, so we filter out other technical notes).
      if (e.includes("书名完整包含")) {
        phrases.push("书名完整命中");
      } else if (e.includes("书名包含全部")) {
        phrases.push("书名命中主要词");
      } else if (e.startsWith("已加权")) {
        phrases.push("已加权：" + e.replace("已加权：", "").split("（")[0]);
      } else if (e.startsWith("已降权")) {
        phrases.push("已降权：" + e.replace("已降权：", "").split("（")[0]);
      }
      if (phrases.length >= 3) break;
    }
  }
  if (phrases.length === 0) return null;
  return (
    <div className="ranking-chips" aria-label="排序依据">
      {phrases.map((p, i) => (
        <span key={i} className="ranking-chip">
          {p}
        </span>
      ))}
    </div>
  );
}

// Re-export for convenience
export { INTENT_LABEL };