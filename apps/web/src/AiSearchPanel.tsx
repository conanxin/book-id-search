import { FormEvent, useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  Loader2,
  Sparkles,
  AlertCircle,
  X,
  ArrowLeft,
  Database,
  Copy,
  Check,
  Search,
  ZapOff,
  Tag,
} from "lucide-react";
import {
  getAiStatus,
  searchAiIntent,
  type AiItem,
  type AiSearchResponse,
} from "./api";

/**
 * S21A-TP2 — AI-assisted natural-language book search, polished.
 *
 * - Hidden entirely when `/api/ai/status` reports `enabled=false`.
 * - Calls POST `/api/ai/search-intent` and renders:
 *   • disclaimer
 *   • AI understanding
 *   • searchQueries (clickable → normal search handoff)
 *   • keywords
 *   • candidates with matchedQueries + aiReason + aiEvidence.matchedQueryCount
 *   • cache.hit hint
 *   • fallbackUsed warning
 *   • "Copy AI summary" button
 *   • "Switch to normal search" with the raw query
 */
export default function AiSearchPanel() {
  const navigate = useNavigate();
  const [, setSearchParams] = useSearchParams();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [query, setQuery] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<AiSearchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

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
  if (enabled === false) return null;

  async function submit(ev: FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    const q = query.trim();
    if (!q || submitting) return;
    setSubmitting(true);
    setError(null);
    setResult(null);
    try {
      const r = await searchAiIntent(q);
      setResult(r);
    } catch (e) {
      const msg = (e as Error)?.message ?? "AI 找书请求失败";
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  }

  function reset() {
    setQuery("");
    setResult(null);
    setError(null);
    setCopied(false);
  }

  function switchToNormalSearch(q: string) {
    // Switch back to normal search mode with this query prefilled.
    setSearchParams({ q });
  }

  function buildSummary(r: AiSearchResponse): string {
    const lines: string[] = [];
    lines.push(`用户描述：${r.query}`);
    lines.push(`AI 理解：${r.ai.understanding}`);
    if (r.ai.searchQueries.length) {
      lines.push(`搜索词：${r.ai.searchQueries.join(" | ")}`);
    }
    if (r.ai.keywords.length) {
      lines.push(`关键词：${r.ai.keywords.join(", ")}`);
    }
    if (r.ai.fallbackUsed) {
      lines.push(`（注：AI 检索词未命中，已回退到原始描述搜索）`);
    }
    lines.push("");
    lines.push(`候选图书（前 5 条）：`);
    r.items.slice(0, 5).forEach((it, i) => {
      const reason = it.aiReason ? ` — ${it.aiReason}` : "";
      lines.push(
        `${i + 1}. ${it.title} | ${it.author || "未知作者"} | ISBN ${it.isbn || "—"} | SSID ${it.ssid} | DXID ${it.dxid}${reason}`,
      );
    });
    return lines.join("\n");
  }

  async function copySummary() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(buildSummary(result));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore
    }
  }

  return (
    <section className="search-panel ai-panel" aria-label="AI 找书">
      <div className="brand-row">
        <Sparkles size={28} />
        <h1>AI 找书</h1>
        <span className="ai-panel__hint">用自然语言描述你想找的书</span>
      </div>

      <div className="ai-disclaimer" role="note">
        <Database size={14} />
        <span>
          AI 只帮助理解描述和解释候选，<strong>SSID / DXID / ISBN</strong> 均来自真实书目索引。
        </span>
      </div>

      <form className="ai-form" onSubmit={submit} role="search">
        <textarea
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="例如：我想找一本日本人写的关于披肩和吊带的手工编织书"
          aria-label="描述你想找的书"
          rows={3}
          disabled={submitting}
          maxLength={400}
        />
        <div className="ai-form__actions">
          <button type="submit" disabled={!query.trim() || submitting}>
            {submitting ? (
              <>
                <Loader2 size={14} className="spin" />
                AI 正在分析你的描述…
              </>
            ) : (
              <>
                <Sparkles size={14} />
                AI 分析并搜索
              </>
            )}
          </button>
          {(query || result) && (
            <button type="button" className="ai-form__clear" onClick={reset} aria-label="重置">
              <X size={14} /> 重置
            </button>
          )}
        </div>
      </form>

      {error ? (
        <div className="ai-panel__error" role="alert">
          <AlertCircle size={16} />
          <span>AI 服务暂时不可用，请稍后再试</span>
        </div>
      ) : null}

      {result ? (
        <div className="ai-result">
          {/* meta hints: cache + fallback */}
          <div className="ai-result__hints">
            {result.cache?.hit ? (
              <span className="ai-hint ai-hint--cache">
                <ZapOff size={12} /> 来自 {result.cache.ttlSeconds ?? 300} 秒缓存
              </span>
            ) : null}
            {result.ai.fallbackUsed ? (
              <span className="ai-hint ai-hint--fallback">
                <AlertCircle size={12} />
                {result.ai.fallbackReason ??
                  "AI 检索词未命中，已回退到原始描述搜索。"}
              </span>
            ) : null}
          </div>

          {/* Section: AI 理解 */}
          <div className="ai-section">
            <div className="ai-section__title">
              <Sparkles size={14} /> AI 理解
            </div>
            <div className="ai-section__body">{result.ai.understanding}</div>
          </div>

          {/* Section: 搜索词 (clickable) */}
          {result.ai.searchQueries.length > 0 ? (
            <div className="ai-section">
              <div className="ai-section__title">使用的搜索词</div>
              <div className="ai-result__chips">
                {result.ai.searchQueries.map((q, i) => (
                  <button
                    key={i}
                    type="button"
                    className="ai-chip ai-chip--query"
                    title={`在普通搜索中查找：${q}`}
                    onClick={() => switchToNormalSearch(q)}
                  >
                    <Search size={11} /> {q}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {/* Section: 关键词 */}
          {result.ai.keywords.length > 0 ? (
            <div className="ai-section">
              <div className="ai-section__title">关键词</div>
              <div className="ai-result__chips">
                {result.ai.keywords.map((k, i) => (
                  <span key={i} className="ai-chip ai-chip--keyword">
                    <Tag size={11} /> {k}
                  </span>
                ))}
              </div>
            </div>
          ) : null}

          {/* Section: 候选图书 */}
          <div className="ai-section">
            <div className="ai-section__title">
              候选图书 ({result.items.length})
            </div>
            {result.items.length === 0 ? (
              <div className="ai-result__empty">
                没有找到候选书。可以尝试加入书名、作者、出版社、年份或 ISBN。
              </div>
            ) : (
              <ul className="ai-result__list">
                {result.items.map((it) => (
                  <AiCandidate key={it.id} item={it} />
                ))}
              </ul>
            )}
          </div>

          {/* Copy + handoff */}
          {result.items.length > 0 ? (
            <div className="ai-result__footer">
              <button
                type="button"
                className="ai-form__clear"
                onClick={copySummary}
                aria-label="复制 AI 搜索摘要"
              >
                {copied ? <Check size={14} /> : <Copy size={14} />}
                {copied ? "已复制" : "复制 AI 搜索摘要"}
              </button>
              <button
                type="button"
                className="ai-form__clear"
                onClick={() => switchToNormalSearch(result.query)}
                aria-label="转为普通搜索"
              >
                <Search size={14} /> 用原始描述在普通搜索中查找
              </button>
            </div>
          ) : null}

          <Link to="/" className="ai-result__back">
            <ArrowLeft size={14} /> 返回普通搜索
          </Link>

          {result.warnings.length > 0 ? (
            <details className="ai-result__warnings">
              <summary>{result.warnings.length} 条调试信息</summary>
              <ul>
                {result.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/** One candidate book card with matchedQueries, parseStatus, aiReason. */
function AiCandidate({ item }: { item: AiItem }) {
  const ev = item.aiEvidence;
  return (
    <li className="ai-result__item">
      <div className="ai-result__item-head">
        <Link to={`/books/${encodeURIComponent(item.id)}`} className="ai-result__title">
          {item.title || "（未命名）"}
        </Link>
        {item.parseStatus && item.parseStatus !== "ok" ? (
          <span
            className={`ai-badge ai-badge--${item.parseStatus}`}
            title={
              item.parseStatus === "weak"
                ? "解析存在弱项（如缺 ISBN）"
                : "解析失败"
            }
          >
            {item.parseStatus === "weak" ? "弱解析" : "解析失败"}
          </span>
        ) : null}
      </div>
      <div className="ai-result__meta">
        {item.author || "未知作者"} · {item.publisher || "未知出版社"}
        {item.year ? ` · ${item.year}` : ""}
      </div>
      <div className="ai-result__ids">
        {item.isbn ? <span>ISBN {item.isbn}</span> : null}
        {item.ssid ? <span>SSID {item.ssid}</span> : null}
        {item.dxid ? <span>DXID {item.dxid}</span> : null}
      </div>
      {ev && ev.matchedQueries.length > 0 ? (
        <div className="ai-result__evidence">
          <span className="ai-evidence-label">
            命中 {ev.matchedQueryCount} 个搜索词
          </span>
          <div className="ai-result__chips">
            {ev.matchedQueries.map((q, i) => (
              <span key={i} className="ai-chip ai-chip--matched">
                {q}
              </span>
            ))}
          </div>
          {ev.source === "fallback_query" ? (
            <span className="ai-hint ai-hint--fallback-sm">回退查询</span>
          ) : null}
        </div>
      ) : null}
      {item.aiReason ? (
        <div className="ai-result__reason">
          <Sparkles size={12} /> {item.aiReason}
        </div>
      ) : null}
    </li>
  );
}
