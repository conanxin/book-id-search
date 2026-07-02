import { FormEvent, useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  Sparkles,
  AlertCircle,
  Loader2,
  Database,
  Tag,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  ChevronDown,
  Search,
} from "lucide-react";
import {
  getAiStatus,
  getBookInsight,
  type BookInsightResponse,
} from "./api";

/**
 * S22A — AI book detail insight.
 *
 * Hidden entirely when AI is disabled. Renders a "AI 分析这本书" button by
 * default; the user must click to actually invoke MiniMax. While loading,
 * shows a spinner. Once loaded, shows the structured insight with:
 *   - scopeNote (disclaimer)
 *   - shortSummary
 *   - subjectTags (chips)
 *   - likelyAudience
 *   - bibliographicSignals (list)
 *   - searchSuggestions (clickable → normal search)
 *   - trustAssessment (color-coded level)
 *   - caveats
 *   - cache.hit hint
 */
export default function BookInsightSection({ bookId }: { bookId: string }) {
  const navigate = useNavigate();
  const [, setSearchParams] = useSearchParams();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [data, setData] = useState<BookInsightResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getAiStatus()
      .then((s) => {
        if (!cancelled) setEnabled(s.enabled);
      })
      .catch(() => {
        if (!cancelled) setEnabled(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (enabled === null) return null;
  if (enabled === false) {
    return (
      <section className="book-insight book-insight--disabled">
        <div className="book-insight__header">
          <Sparkles size={16} />
          <h2>AI 书目分析</h2>
        </div>
        <div className="book-insight__notice">AI 功能未启用</div>
      </section>
    );
  }

  async function loadInsight(ev?: FormEvent) {
    if (ev) ev.preventDefault();
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      const r = await getBookInsight(bookId);
      setData(r);
    } catch (e) {
      const msg = (e as Error)?.message ?? "AI 分析失败";
      setError(msg);
    } finally {
      setLoading(false);
    }
  }

  function switchToNormalSearch(q: string) {
    setSearchParams({ q });
  }

  return (
    <section className="book-insight" aria-label="AI 书目分析">
      <div className="book-insight__header">
        <Sparkles size={16} />
        <h2>AI 书目分析</h2>
        {data?.cache?.hit ? (
          <span className="ai-hint ai-hint--cache">
            来自 {data.cache.ttlSeconds ?? 600} 秒缓存
          </span>
        ) : null}
        {data?.source === "rule_based_fallback" ? (
          <span className="ai-hint ai-hint--fallback">
            <AlertCircle size={11} /> 规则生成
          </span>
        ) : null}
      </div>

      <p className="book-insight__disclaimer">
        <Database size={12} /> 仅基于书目字段分析；不代表图书全文内容。
      </p>

      {!data ? (
        <form onSubmit={loadInsight}>
          <button
            type="submit"
            className="book-insight__button"
            disabled={loading}
            aria-label="AI 分析这本书"
          >
            {loading ? (
              <>
                <Loader2 size={14} className="spin" />
                AI 分析中...
              </>
            ) : (
              <>
                <Sparkles size={14} />
                AI 分析这本书
              </>
            )}
          </button>
        </form>
      ) : (
        <InsightBody data={data} onSwitchToNormalSearch={switchToNormalSearch} />
      )}

      {error ? (
        <div className="book-insight__error" role="alert">
          <AlertCircle size={14} />
          <span>AI 服务暂时不可用，请稍后再试</span>
          <button
            type="button"
            className="book-insight__retry"
            onClick={() => loadInsight()}
            disabled={loading}
          >
            重试
          </button>
        </div>
      ) : null}
    </section>
  );
}

function InsightBody({
  data,
  onSwitchToNormalSearch,
}: {
  data: BookInsightResponse;
  onSwitchToNormalSearch: (q: string) => void;
}) {
  const { insight, basis, quality } = data;
  const hasQualityBadges = quality.missingFields.length > 0 || quality.parseStatus !== "ok";

  return (
    <div className="book-insight__body">
      <p className="book-insight__scope">{insight.scopeNote}</p>

      {hasQualityBadges ? (
        <div className="book-insight__quality">
          {quality.missingFields.includes("isbn") ? (
            <span className="quality-badge quality-badge--warning">
              <AlertTriangle size={11} /> 缺 ISBN
            </span>
          ) : null}
          {quality.parseStatus === "weak" ? (
            <span className="quality-badge quality-badge--weak">
              <AlertTriangle size={11} /> 弱解析
            </span>
          ) : null}
          {quality.parseStatus === "failed" ? (
            <span className="quality-badge quality-badge--error">
              <XCircle size={11} /> 解析失败
            </span>
          ) : null}
        </div>
      ) : null}

      <InsightSection label="简短解读">
        <p className="book-insight__summary">{insight.shortSummary}</p>
      </InsightSection>

      {insight.subjectTags.length > 0 ? (
        <InsightSection label="主题标签">
          <div className="ai-result__chips">
            {insight.subjectTags.map((t, i) => (
              <span key={i} className="ai-chip ai-chip--keyword">
                <Tag size={11} /> {t}
              </span>
            ))}
          </div>
        </InsightSection>
      ) : null}

      {insight.likelyAudience ? (
        <InsightSection label="可能适合">
          <p className="book-insight__text">{insight.likelyAudience}</p>
        </InsightSection>
      ) : null}

      {insight.bibliographicSignals.length > 0 ? (
        <InsightSection label="书目信号">
          <ul className="book-insight__list">
            {insight.bibliographicSignals.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </InsightSection>
      ) : null}

      {insight.searchSuggestions.length > 0 ? (
        <InsightSection label="延伸检索">
          <div className="ai-result__chips">
            {insight.searchSuggestions.map((q, i) => (
              <button
                key={i}
                type="button"
                className="ai-chip ai-chip--query"
                onClick={() => onSwitchToNormalSearch(q)}
                title={`在普通搜索中查找：${q}`}
              >
                <Search size={11} /> {q}
              </button>
            ))}
          </div>
        </InsightSection>
      ) : null}

      <InsightSection label="可信度">
        <TrustBadge
          level={insight.trustAssessment.level}
          reasons={insight.trustAssessment.reasons}
        />
      </InsightSection>

      {insight.caveats.length > 0 ? (
        <InsightSection label="注意事项">
          <ul className="book-insight__list book-insight__list--caveats">
            {insight.caveats.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </InsightSection>
      ) : null}

      <details className="book-insight__basis">
        <summary>
          <ChevronDown size={12} /> 数据基础（{basis.id}）
        </summary>
        <div className="book-insight__basis-body">
          <p>书名：{basis.title || "—"}</p>
          <p>作者：{basis.author || "—"}</p>
          <p>出版社：{basis.publisher || "—"}</p>
          <p>年份：{basis.year ?? "—"}</p>
          <p>ISBN：{basis.isbn || "—"}</p>
          <p>SSID：{basis.ssid || "—"}</p>
          <p>DXID：{basis.dxid || "—"}</p>
          <p>解析状态：{basis.parseStatus}</p>
        </div>
      </details>
    </div>
  );
}

function InsightSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="book-insight__section">
      <div className="book-insight__label">{label}</div>
      {children}
    </div>
  );
}

function TrustBadge({
  level,
  reasons,
}: {
  level: "high" | "medium" | "low";
  reasons: string[];
}) {
  const config = {
    high: { Icon: CheckCircle2, text: "高", cls: "trust--high" },
    medium: { Icon: AlertTriangle, text: "中", cls: "trust--medium" },
    low: { Icon: XCircle, text: "低", cls: "trust--low" },
  }[level];
  const Icon = config.Icon;
  return (
    <div className={`book-insight__trust ${config.cls}`}>
      <span className="book-insight__trust-level">
        <Icon size={14} /> {config.text}
      </span>
      {reasons.length > 0 ? (
        <ul className="book-insight__trust-reasons">
          {reasons.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
