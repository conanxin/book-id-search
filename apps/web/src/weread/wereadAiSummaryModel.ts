/**
 * S27E — Client-side model helpers for the private WeRead AI summary panel.
 *
 * Pure functions only — no React, no DOM. The component layer turns the
 * output of these helpers into JSX; this file makes the data contract
 * testable without a DOM testing library.
 */

import type { WereadAiSummaryMeta, WereadAiSummaryResult } from "../wereadPrivate";

export const AI_SUMMARY_CLIENT_LIMITS = {
  MAX_INPUT_ITEMS: 30,
  MAX_TOTAL_CHARS: 30_000,
} as const;

export type BuildInputSource = {
  type: string;
  text: string;
  comment?: string | null;
};

/**
 * Sanitize a single loaded note into the shape the server expects.
 *
 * - Invalid / unknown types are coerced to "unknown".
 * - Items whose text AND comment are both empty are dropped.
 * - Extra fields are silently discarded by TypeScript typing.
 */
function sanitizeInputItem(raw: BuildInputSource): {
  type: "highlight" | "thought" | "review" | "unknown";
  text: string;
  comment: string | null;
} | null {
  const type: "highlight" | "thought" | "review" | "unknown" =
    raw.type === "highlight" || raw.type === "thought" || raw.type === "review"
      ? raw.type
      : "unknown";
  const rawText = typeof raw.text === "string" ? raw.text : "";
  const text = rawText.trim();
  const rawComment = typeof raw.comment === "string" ? raw.comment : "";
  const trimmedComment = rawComment.trim();
  const comment = trimmedComment.length > 0 ? trimmedComment : null;
  if (!text && !comment) return null;
  return { type, text, comment };
}

/**
 * Build the request payload from the loaded notes.
 *
 * - Caps at MAX_INPUT_ITEMS (30) — caller is expected to surface a hint.
 * - Drops empty items.
 * - Returns a brand-new array; never mutates the input.
 */
export function buildAiSummaryInput(
  items: ReadonlyArray<BuildInputSource>
): Array<{
  type: "highlight" | "thought" | "review" | "unknown";
  text: string;
  comment: string | null;
}> {
  const out: Array<{
    type: "highlight" | "thought" | "review" | "unknown";
    text: string;
    comment: string | null;
  }> = [];
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const sanitized = sanitizeInputItem(raw);
    if (!sanitized) continue;
    out.push(sanitized);
    if (out.length >= AI_SUMMARY_CLIENT_LIMITS.MAX_INPUT_ITEMS) break;
  }
  return out;
}

export function validateAiSummaryEligibility(
  items: ReadonlyArray<BuildInputSource>
): { eligible: true } | { eligible: false; reason: string } {
  const cleaned = buildAiSummaryInput(items);
  if (cleaned.length === 0) {
    return { eligible: false, reason: "当前没有可整理的笔记。" };
  }
  return { eligible: true };
}

/**
 * Format the response meta for the on-page summary header. The text is
 * static — no note contents leak through here.
 */
export function formatAiSummaryMeta(meta: WereadAiSummaryMeta): string {
  const provider = meta.provider === "minimax" ? "MiniMax" : meta.provider;
  return `基于 ${meta.itemsUsed} 条笔记整理 · 总字符 ${meta.totalCharacters} · ${provider} · 不保存`;
}

export function hasAiSummaryContent(summary: WereadAiSummaryResult | null): boolean {
  if (!summary) return false;
  if (!summary.overview.trim()) return false;
  if (summary.themes.length === 0) return false;
  if (summary.keyPoints.length === 0) return false;
  return true;
}

/**
 * Build a Markdown dump for the "复制摘要" button. Generated client-side
 * only — the server never sees this string. We deliberately strip the
 * `evidenceCount` number from the Markdown (it's only useful in-context).
 */
export function buildAiSummaryMarkdown(
  summary: WereadAiSummaryResult,
  meta: WereadAiSummaryMeta
): string {
  const lines: string[] = [];
  lines.push("# AI 整理当前已加载笔记");
  lines.push("");
  lines.push(`> ${formatAiSummaryMeta(meta)}`);
  lines.push("");
  lines.push("## 主题概览");
  lines.push("");
  lines.push(summary.overview.trim());
  lines.push("");
  if (summary.themes.length > 0) {
    lines.push("## 主要主题");
    lines.push("");
    for (const theme of summary.themes) {
      lines.push(`### ${theme.title}`);
      lines.push("");
      lines.push(theme.summary);
      lines.push("");
    }
  }
  if (summary.keyPoints.length > 0) {
    lines.push("## 关键观点");
    lines.push("");
    for (const point of summary.keyPoints) {
      lines.push(`- ${point}`);
    }
    lines.push("");
  }
  if (summary.reviewQuestions.length > 0) {
    lines.push("## 待复习问题");
    lines.push("");
    for (const q of summary.reviewQuestions) {
      lines.push(`- ${q}`);
    }
    lines.push("");
  }
  if (summary.readingDirections.length > 0) {
    lines.push("## 延伸阅读方向");
    lines.push("");
    for (const d of summary.readingDirections) {
      lines.push(`- ${d}`);
    }
    lines.push("");
  }
  lines.push("---");
  lines.push("");
  lines.push(
    "本摘要由 MiniMax 基于当前浏览器已加载的笔记临时生成，AI 输出可能有遗漏，" +
      "请人工复核。"
  );
  return lines.join("\n");
}

/**
 * Map provider / network errors to friendly Chinese strings. The error
 * must NEVER carry token, note text, prompt, or provider raw body.
 */
export function getAiSummaryErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const msg = raw.toLowerCase();
  if (/401|unauthorized|missing token|认证失败|无效.*token|token 无效|已过期/.test(msg)) {
    return "Token 无效或已过期，请在 /weread 重新连接。";
  }
  if (/403|disabled|not enabled|未启用/.test(msg)) {
    return "私有 API 未启用。";
  }
  if (/429|too many|rate limit|限流/.test(msg)) {
    return "请求过于频繁（限流），请稍后再试。";
  }
  if (/timeout|aborted|504/.test(msg)) {
    return "AI 服务超时，请稍后再试。";
  }
  if (/502|provider|empty content|无法解析/.test(msg)) {
    return "AI 服务暂时不可用，请稍后再试。";
  }
  if (/413|too large|超大/.test(msg)) {
    return "笔记正文过大，请缩小整理范围。";
  }
  if (/empty items|没有可整理|至少需要/.test(msg)) {
    return "请先加载至少 1 条有效笔记。";
  }
  return "AI 整理失败，请稍后再试。";
}