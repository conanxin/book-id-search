import { formatWereadCenterSummary, type WereadSummary, type WereadCenterSummaryView, type WereadTrends } from "../wereadPrivate";

export type WereadCenterState =
  | { status: "idle"; token: null; summary: null; trends: null; error: null }
  | { status: "loading"; token: string; summary: null; trends: null; error: null }
  | { status: "ready"; token: string; summary: WereadCenterSummaryView; trends: WereadTrendView; error: null }
  | { status: "error"; token: string | null; summary: null; trends: null; error: string };

export type WereadTrendView = {
  days7Total: number;
  days30Total: number;
  days90Total: number;
  allTimeTotal: number;
  activeDays30: number;
  activeBooks30: number;
  highlightsTotal: number;
  thoughtsTotal: number;
  reviewsTotal: number;
  unknownTotal: number;
  coverageRatio: number;
  notesWithDate: number;
  notesWithoutDate: number;
  daily30: Array<{ date: string; total: number }>;
  confirmedOnlyTotal: number;
  confirmedOnlyActiveBooks: number;
};

export function getInitialWereadCenterState(): WereadCenterState {
  return { status: "idle", token: null, summary: null, trends: null, error: null };
}

export function formatWereadCenterSummaryState(summary: WereadSummary | null): WereadCenterSummaryView {
  return formatWereadCenterSummary(summary);
}

export function classifyWereadError(err: unknown): { type: "auth" | "disabled" | "network"; message: string } {
  const msg = err instanceof Error ? err.message : String(err);
  if (/401|403|unauthorized|invalid token|missing token|认证失败|token 无效|已过期/i.test(msg)) {
    return { type: "auth", message: "Token 无效或已过期" };
  }
  if (/disabled|not enabled|未启用|私有 API/i.test(msg)) {
    return { type: "disabled", message: "私有 API 未启用" };
  }
  return { type: "network", message: msg || "连接失败" };
}

export const WEREAD_CENTER_PRIVACY_COPY = [
  "Token 只保存在当前浏览器 sessionStorage。",
  "关闭浏览器或清除 token 后不再访问私有数据。",
  "不显示笔记或划线的原文。",
  "不返回微信读书内部 ID。",
  "不影响公开搜索，不写入 Meilisearch。",
];

export function formatTrendWindow(trends: WereadTrends | null | undefined): WereadTrendView {
  if (!trends) {
    return {
      days7Total: 0,
      days30Total: 0,
      days90Total: 0,
      allTimeTotal: 0,
      activeDays30: 0,
      activeBooks30: 0,
      highlightsTotal: 0,
      thoughtsTotal: 0,
      reviewsTotal: 0,
      unknownTotal: 0,
      coverageRatio: 0,
      notesWithDate: 0,
      notesWithoutDate: 0,
      daily30: [],
      confirmedOnlyTotal: 0,
      confirmedOnlyActiveBooks: 0,
    };
  }

  const daily30 = (trends.windows.days30.daily ?? []).map((p) => ({
    date: p.date,
    total: p.total,
  }));

  return {
    days7Total: trends.windows.days7.total,
    days30Total: trends.windows.days30.total,
    days90Total: trends.windows.days90.total,
    allTimeTotal: trends.windows.allTime.total,
    activeDays30: trends.windows.days30.activeDays,
    activeBooks30: trends.windows.days30.activeBooks,
    highlightsTotal: trends.windows.allTime.highlights,
    thoughtsTotal: trends.windows.allTime.thoughts,
    reviewsTotal: trends.windows.allTime.reviews,
    unknownTotal: trends.windows.allTime.unknown,
    coverageRatio: trends.coverage.dateCoverageRatio,
    notesWithDate: trends.coverage.notesWithDate,
    notesWithoutDate: trends.coverage.notesWithoutDate,
    daily30,
    confirmedOnlyTotal: trends.confirmedOnly.total,
    confirmedOnlyActiveBooks: trends.confirmedOnly.activeBooks,
  };
}

export function getTrendCoverageLabel(view: WereadTrendView): string {
  const pct = Math.round(view.coverageRatio * 100);
  return `${pct}%`;
}

export type ActivityLevel = "quiet" | "normal" | "active" | "intense";

export function getActivityLevel(view: WereadTrendView): ActivityLevel {
  const d7 = view.days7Total;
  if (d7 >= 50) return "intense";
  if (d7 >= 15) return "active";
  if (d7 >= 3) return "normal";
  return "quiet";
}

export function getTrendCards(view: WereadTrendView): Array<{ label: string; value: string }> {
  return [
    { label: "最近 7 天新增", value: formatTrendNumber(view.days7Total) },
    { label: "最近 30 天新增", value: formatTrendNumber(view.days30Total) },
    { label: "最近 90 天新增", value: formatTrendNumber(view.days90Total) },
    { label: "全部有日期记录", value: formatTrendNumber(view.notesWithDate) },
    { label: "最近 30 天活跃天数", value: formatTrendNumber(view.activeDays30) },
    { label: "最近 30 天活跃书籍", value: formatTrendNumber(view.activeBooks30) },
    { label: "已匹配书目笔记记录", value: formatTrendNumber(view.confirmedOnlyTotal) },
  ];
}

function formatTrendNumber(n: number): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return "0";
  if (n >= 100000) return Math.round(n / 1000) + "k";
  return String(n);
}
