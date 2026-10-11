import { Fragment, useEffect, useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { getRelatedBooks, type RelatedBook, type RelatedBooksResponse } from "../api";
import { getWebAuthAuthGeneration } from "../auth/session";
import { useWebAuthSession } from "../auth/useWebAuthSession";
import { useLibraryScope } from "./useLibraryScope";
import "./library.css";
import "./book-related.css";

interface BookRelatedBooksProps {
  bookId: string;
  renderBook: (book: RelatedBook) => ReactNode;
}

/** Each book and Google session owns its list, including in-flight requests. */
export function BookRelatedBooks(props: BookRelatedBooksProps) {
  const session = useWebAuthSession();
  if (session.status !== "authenticated") return null;
  const generation = getWebAuthAuthGeneration();
  return <RelatedBooksPanel key={JSON.stringify([props.bookId, generation])} {...props} generation={generation} />;
}

const FIELD_LABELS = { isbn: "ISBN", title: "书名", author: "作者", publisher: "出版社" };

function RelatedBooksPanel({ bookId, renderBook, generation }: BookRelatedBooksProps & { generation: number }) {
  const { run, current } = useLibraryScope(generation);
  const [result, setResult] = useState<RelatedBooksResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    void run(signal => getRelatedBooks(bookId, { signal }))
      .then(response => {
        if (cancelled || !current()) return;
        // A missing source id is an older API response. A different id is not
        // a result for this page and must not be rendered as related to it.
        if (response.sourceBookId !== undefined && response.sourceBookId !== bookId) throw new Error("Related book source mismatch");
        setResult(response);
      })
      .catch(() => { if (!cancelled && current()) setError(true); })
      .finally(() => { if (!cancelled && current()) setLoading(false); });
    return () => { cancelled = true; };
  }, [bookId, retry, run, current]);

  const items = result?.items ?? [];
  const partial = result?.partial === true;
  const unavailable = result?.unavailableFields?.map(field => FIELD_LABELS[field]).filter(Boolean).join("、");

  return <section id="related-books" className="library-panel book-related-panel" aria-labelledby="related-books-heading" aria-busy={loading}>
    <div className="library-section-heading">
      <div><span className="library-eyebrow">沿着书目继续找</span><h2 id="related-books-heading">相关图书</h2></div>
      {items.length > 0 && <span className="library-meta">本次展示 {items.length} 本</span>}
    </div>
    <p className="library-muted">根据目录中的 ISBN、书名、作者和出版社寻找线索。关联理由用于继续找书，版本和内容关系仍需核对。</p>

    {loading && <p className="book-related-loading library-muted" role="status"><Loader2 className="spin" size={16} aria-hidden="true" />{result ? "正在重新查找相关图书…" : "正在寻找相关图书…"}</p>}
    {error && <p className="library-error" role="alert">{items.length > 0
      ? "相关图书暂时无法更新，已显示上次取得的图书。可继续查看或重试。"
      : "相关图书暂时无法加载，不影响当前书目信息。请稍后重试。"}</p>}
    {partial && !error && <p className="book-related-partial" role="status">
      {unavailable ? `${unavailable}线索暂时无法查询。` : "部分目录线索暂时无法查询。"}
      {items.length > 0 ? "已取得的图书仍可打开，也可以重试补全。" : "暂未取得可展示的图书，请重试。"}
    </p>}
    {(error || partial) && <div className="library-actions">
      <button type="button" className="library-button" disabled={loading} onClick={() => setRetry(value => value + 1)}>重试相关图书</button>
    </div>}
    {items.length > 0 && <div className="book-related-list">
      {items.map(item => <Fragment key={item.id}>{renderBook(item)}</Fragment>)}
    </div>}
    {!loading && !error && !partial && result && items.length === 0 && <p className="library-empty">当前目录字段没有找到可展示的相关图书。可以返回搜书，尝试其他书名或作者。</p>}
  </section>;
}
