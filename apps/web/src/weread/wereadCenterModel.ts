import { formatWereadCenterSummary, type WereadSummary, type WereadCenterSummaryView } from "../wereadPrivate";

export type WereadCenterState =
  | { status: "idle"; token: null; summary: null; error: null }
  | { status: "loading"; token: string; summary: null; error: null }
  | { status: "ready"; token: string; summary: WereadCenterSummaryView; error: null }
  | { status: "error"; token: string | null; summary: null; error: string };

export function getInitialWereadCenterState(): WereadCenterState {
  return { status: "idle", token: null, summary: null, error: null };
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
