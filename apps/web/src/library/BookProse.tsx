import { createContext, memo, useContext, useId, useMemo, type ComponentProps } from "react";
import Markdown, { type Components } from "react-markdown";
import { Link } from "react-router-dom";
import remarkGfm from "remark-gfm";
import "./book-prose.css";

const insideLink = createContext(false);
const relativeBase = "https://book-prose.invalid/";

/** Markdown is display-only; only web URLs and relative references become links. */
function proseUrl(value: string): string | undefined {
  if (!value || /[\u0000-\u0020\u007f\\]/u.test(value)) return undefined;
  try {
    const url = new URL(value, relativeBase);
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

function ProseLink({ href, children, ...props }: ComponentProps<"a">) {
  if (!href) return <span>{children}</span>;
  const internal = (href.startsWith("/") && !href.startsWith("//")) || href.startsWith("?");
  const external = new URL(href, relativeBase).origin !== new URL(relativeBase).origin;
  return <insideLink.Provider value={true}>
    {internal ? <Link {...props} to={href}>{children}</Link>
      : <a {...props} href={href} target={external ? "_blank" : undefined} rel={external ? "noopener noreferrer" : undefined}>{children}</a>}
  </insideLink.Provider>;
}

function ImageReference({ src, alt }: { src?: string | Blob; alt?: string }) {
  const linked = useContext(insideLink);
  const label = `图片：${alt || "未命名图片"}`;
  const href = typeof src === "string" ? proseUrl(src) : undefined;
  return <span className="book-prose-image">
    {linked || !href ? label : <ProseLink href={href}>{label}（查看图片）</ProseLink>}
  </span>;
}

/** Readable CommonMark/GFM, without rewriting the saved introduction or note. */
export const BookProse = memo(function BookProse({ content, className }: { content: string; className?: string }) {
  const prefix = `book-prose-${useId().replaceAll(":", "")}-`;
  const components = useMemo<Components>(() => ({
    h1: "h4",
    h2: ({ node: _node, id, ...props }) => <h4 {...props} id={id === "footnote-label" ? `${prefix}label` : id} />,
    h3: "h5",
    h4: "h6",
    h5: "h6",
    h6: "h6",
    a: ({ node: _node, "aria-describedby": describedBy, ...props }) => <ProseLink {...props}
      aria-describedby={describedBy === "footnote-label" ? `${prefix}label` : describedBy} />,
    img: ({ src, alt }) => <ImageReference src={src} alt={alt} />,
    pre: ({ node: _node, ...props }) => <pre {...props} tabIndex={0} aria-label="代码块" />,
    table: ({ node: _node, ...props }) => <div className="book-prose-table" role="region" aria-label="表格" tabIndex={0}><table {...props} /></div>,
  }), [prefix]);

  return <div className={["library-prose", "book-prose", className].filter(Boolean).join(" ")}>
    <Markdown components={components} remarkPlugins={[remarkGfm]} urlTransform={proseUrl}
      remarkRehypeOptions={{ clobberPrefix: prefix, footnoteLabel: "注释", footnoteLabelProperties: {}, footnoteBackLabel: "返回正文" }}>
      {content}
    </Markdown>
  </div>;
});
