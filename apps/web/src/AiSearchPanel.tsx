import { FormEvent, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Loader2, Sparkles, AlertCircle, X, ArrowLeft } from "lucide-react";
import {
  getAiStatus,
  searchAiIntent,
  type AiSearchResponse,
} from "./api";

/**
 * S21A — AI-assisted natural-language book search.
 *
 * Hidden entirely when `/api/ai/status` reports `enabled=false`.
 * Calls POST `/api/ai/search-intent` and renders the AI understanding +
 * the items it found (every item comes from Meilisearch; the AI only adds
 * a one-line `aiReason`).
 */
export default function AiSearchPanel() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [query, setQuery] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<AiSearchResponse | null>(null);
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
  }

  return (
    <section className="search-panel ai-panel" aria-label="AI 找书">
      <div className="brand-row">
        <Sparkles size={28} />
        <h1>AI 找书</h1>
        <span className="ai-panel__hint">用自然语言描述你想找的书，AI 会帮你生成搜索策略</span>
      </div>

      <form className="ai-form" onSubmit={submit} role="search">
        <textarea
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="例如：我想找一本日本人写的关于披肩和吊带的手工编织书"
          aria-label="描述你想找的书"
          rows={3}
          disabled={submitting}
          autoFocus
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
          <span>{error}</span>
        </div>
      ) : null}

      {result ? (
        <div className="ai-result">
          <div className="ai-result__understanding">
            <Sparkles size={16} />
            <div>
              <div className="ai-result__label">AI 理解</div>
              <div className="ai-result__text">{result.ai.understanding}</div>
            </div>
          </div>

          {result.ai.searchQueries.length > 0 ? (
            <div className="ai-result__queries">
              <div className="ai-result__label">使用的搜索词</div>
              <div className="ai-result__chips">
                {result.ai.searchQueries.map((q, i) => (
                  <span key={i} className="ai-chip">{q}</span>
                ))}
              </div>
            </div>
          ) : null}

          {result.ai.keywords.length > 0 ? (
            <div className="ai-result__keywords">
              <div className="ai-result__label">关键词</div>
              <div className="ai-result__chips">
                {result.ai.keywords.map((k, i) => (
                  <span key={i} className="ai-chip ai-chip--keyword">{k}</span>
                ))}
              </div>
            </div>
          ) : null}

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

          <div className="ai-result__items">
            <div className="ai-result__label">
              候选图书 ({result.items.length})
            </div>
            {result.items.length === 0 ? (
              <div className="ai-result__empty">没有找到匹配的书。</div>
            ) : (
              <ul className="ai-result__list">
                {result.items.map((it) => (
                  <li key={it.id} className="ai-result__item">
                    <Link to={`/books/${encodeURIComponent(it.id)}`} className="ai-result__title">
                      {it.title || "（未命名）"}
                    </Link>
                    <div className="ai-result__meta">
                      {it.author || "未知作者"} · {it.publisher || "未知出版社"}
                      {it.year ? ` · ${it.year}` : ""}
                    </div>
                    {it.aiReason ? (
                      <div className="ai-result__reason">
                        <Sparkles size={12} /> {it.aiReason}
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <Link to="/" className="ai-result__back">
            <ArrowLeft size={14} /> 返回普通搜索
          </Link>
        </div>
      ) : null}
    </section>
  );
}