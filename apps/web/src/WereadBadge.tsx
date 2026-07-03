import { BookOpen, Check, Highlighter, FileText, Award, MessageCircle, PenTool } from "lucide-react";
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
  const s = w.notesSummary;

  if (compact) {
    return (
      <span className="weread-badge-chip" title="来自你的微信读书" aria-label="微信读书已匹配">
        <BookOpen size={13} />
        微信读书
        {s?.hasNotes ? <span>· 有笔记</span> : null}
      </span>
    );
  }

  const chips: { key: string; icon: React.ReactNode; label: string }[] = [];
  if (s) {
    if (s.highlights > 0) {
      chips.push({ key: "highlights", icon: <Highlighter size={12} />, label: `划线 ${s.highlights}` });
    }
    if (s.thoughts > 0) {
      chips.push({ key: "thoughts", icon: <MessageCircle size={12} />, label: `想法 ${s.thoughts}` });
    }
    if (s.reviews > 0) {
      chips.push({ key: "reviews", icon: <PenTool size={12} />, label: `书评 ${s.reviews}` });
    }
    if (s.total > 0 && chips.length === 0) {
      chips.push({ key: "total", icon: <FileText size={12} />, label: `笔记 ${s.total}` });
    }
  }
  // Show at most 2 chips in detail mode to keep the card compact
  const visibleChips = chips.slice(0, 2);
  const hasMore = chips.length > 2;

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
        {visibleChips.map((chip) => (
          <span key={chip.key}>
            {chip.icon}
            {chip.label}
          </span>
        ))}
        {hasMore ? (
          <span title="更多笔记统计">
            <FileText size={12} />
            +{chips.length - 2}
          </span>
        ) : null}
        {w.matchedRecordsCount && w.matchedRecordsCount > 1 ? (
          <span className="weread-badge__multi" title="同一书目匹配多条微信读书记录">
            多记录匹配
          </span>
        ) : null}
      </div>
    </div>
  );
}
