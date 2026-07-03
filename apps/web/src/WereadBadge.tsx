import { BookOpen, Check, Highlighter, FileText, Award } from "lucide-react";
import type { WereadStatus } from "./wereadPrivate";

interface WereadBadgeProps {
  status: WereadStatus | null | undefined;
  compact?: boolean;
}

const statusMap: Record<string, string> = {
  finished: "已读",
  reading: "在读",
  unread: "未读",
  abandoned: "放弃",
  unknown: "未知",
};

const confidenceMap: Record<string, string> = {
  high: "高置信",
  medium: "中置信",
  low: "低置信",
};

export default function WereadBadge({ status, compact }: WereadBadgeProps) {
  if (!status || !status.matched || !status.weread) return null;
  const w = status.weread;
  const reading = statusMap[w.readingStatus ?? ""] || w.readingStatus || "已匹配";

  if (compact) {
    return (
      <span className="weread-badge-chip" title="来自你的微信读书" aria-label="微信读书已匹配">
        <BookOpen size={13} />
        微信读书 · {reading}
      </span>
    );
  }

  return (
    <div className="weread-badge">
      <div className="weread-badge__header">
        <BookOpen size={15} />
        <span>微信读书</span>
        <span className="weread-badge__state">{reading}</span>
        {w.matchConfidence && confidenceMap[w.matchConfidence] ? (
          <span className="weread-badge__confidence" title="匹配置信度">
            <Award size={12} />
            {w.matchMethod === "isbn" ? "ISBN " : ""}
            {confidenceMap[w.matchConfidence]}
          </span>
        ) : null}
      </div>
      <div className="weread-badge__stats">
        {w.progress !== undefined && w.progress !== null ? (
          <span>
            <Check size={12} />
            进度 {w.progress}%
          </span>
        ) : null}
        {w.noteCount ? (
          <span>
            <FileText size={12} />
            笔记 {w.noteCount}
          </span>
        ) : null}
        {w.highlightCount ? (
          <span>
            <Highlighter size={12} />
            划线 {w.highlightCount}
          </span>
        ) : null}
      </div>
    </div>
  );
}
