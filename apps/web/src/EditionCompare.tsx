import type { Book } from "./api";

export const EDITION_COMPARE_MAX = 4;

export interface EditionCompareSelectionResult {
  items: Book[];
  limitReached: boolean;
}

export function toggleEditionCompareSelection(
  current: readonly Book[],
  book: Book
): EditionCompareSelectionResult {
  if (current.some((item) => item.id === book.id)) {
    return {
      items: current.filter((item) => item.id !== book.id),
      limitReached: false,
    };
  }

  if (current.length >= EDITION_COMPARE_MAX) {
    return {
      items: [...current],
      limitReached: true,
    };
  }

  return {
    items: [...current, book],
    limitReached: false,
  };
}

function displayValue(
  value: string | number | null | undefined
): string {
  if (value === null || value === undefined || value === "") return "—";
  return String(value);
}

function parseStatusLabel(status: Book["parseStatus"]): string {
  if (status === "ok") return "正常";
  if (status === "weak") return "弱解析";
  return "解析异常";
}

const ROWS: Array<{
  label: string;
  mono?: boolean;
  value: (book: Book) => string;
}> = [
  { label: "出版社", value: (book) => displayValue(book.publisher) },
  { label: "年份", value: (book) => displayValue(book.year) },
  { label: "页数", value: (book) => displayValue(book.pages) },
  { label: "ISBN", mono: true, value: (book) => displayValue(book.isbn) },
  { label: "SSID", mono: true, value: (book) => displayValue(book.ssid) },
  { label: "DXID", mono: true, value: (book) => displayValue(book.dxid) },
  {
    label: "解析状态",
    value: (book) => parseStatusLabel(book.parseStatus),
  },
];

export function EditionComparePanel({
  books,
  onRemove,
  onClear,
}: {
  books: readonly Book[];
  onRemove?: (id: string) => void;
  onClear?: () => void;
}) {
  if (books.length < 2) return null;

  return (
    <section className="edition-compare" aria-label="版本对比">
      <div className="edition-compare__header">
        <div>
          <strong>版本对比</strong>
          <span>已选择 {books.length} 个版本</span>
        </div>

        {onClear ? (
          <button
            type="button"
            className="toolbar-button"
            onClick={onClear}
          >
            清空对比
          </button>
        ) : null}
      </div>

      <div className="edition-compare__table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">字段</th>

              {books.map((book) => (
                <th scope="col" key={book.id}>
                  <span className="edition-compare__title">
                    {book.title || "未命名图书"}
                  </span>

                  <span className="edition-compare__edition">
                    {book.year ?? "年份未知"} ·{" "}
                    {book.publisher || "出版社未知"}
                  </span>

                  {onRemove ? (
                    <button
                      type="button"
                      className="toolbar-button edition-compare__remove"
                      onClick={() => onRemove(book.id)}
                      aria-label={`移除 ${
                        book.title || "未命名图书"
                      } 对比`}
                    >
                      移除
                    </button>
                  ) : null}
                </th>
              ))}
            </tr>
          </thead>

          <tbody>
            {ROWS.map((row) => (
              <tr key={row.label}>
                <th scope="row">{row.label}</th>

                {books.map((book) => (
                  <td
                    key={`${row.label}-${book.id}`}
                    className={
                      row.mono ? "edition-compare__mono" : undefined
                    }
                  >
                    {row.value(book)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
