/** Public catalog fields used only to fill an editable webpage-evidence question. */
export interface BookWebReviewTarget { title: string; author: string; isbn: string }
export interface BookWebReviewQuestionPreset {
  id: "identity" | "review" | "edition";
  label: string;
  question: string;
}
export interface BookWebReviewQuestions {
  initialQuestion: string;
  presets: BookWebReviewQuestionPreset[];
}

function field(value: string, limit: number): string {
  const cleaned = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "\ufffd")
    .replace(/\s+/gu, " ").trim();
  if (cleaned.length <= limit) return cleaned;
  const end = /[\ud800-\udbff]/.test(cleaned[limit - 1]) ? limit - 1 : limit;
  return cleaned.slice(0, end) + "…（已截短）";
}

/** No identity inference or requests. Missing titles keep the legacy free-form workflow. */
export function bookWebReviewQuestions(book?: BookWebReviewTarget): BookWebReviewQuestions | null {
  if (!book || typeof book.title !== "string" || typeof book.author !== "string" || typeof book.isbn !== "string") return null;
  const title = field(book.title, 300);
  if (!title) return null;
  const identity = [
    "目标书目（用于核对，不是网页原文）：",
    "书名：" + title,
    "作者：" + (field(book.author, 200) || "未提供"),
    "ISBN：" + (field(book.isbn, 100) || "未提供"),
  ].join("\n");
  const question = (task: string) => identity + "\n\n" + task;
  return {
    initialQuestion: question("请在当前已读网页中定位直接讨论这部作品的原句，并保留辨认作品和评论内容所需的上下文。区分作品评论、书目介绍和其他作品；原文不足时保留不足，不补写结论。"),
    presets: [
      { id: "identity", label: "作品身份", question: question("请定位能核对目标作品书名、作者和讨论对象的原句。保留其他作品名称及限定语，帮助区分同名书、作者其他作品与仅提及本书的段落；不要凭 ISBN 或姓名单独确认同书。") },
      { id: "review", label: "评论内容", question: question("请定位直接评价这部作品的论点、材料、方法或写法的原句，并保留评价对象与限定语。不要用商品简介、推荐语列表、作者访谈或其他作品的评价代替本书评论。") },
      { id: "edition", label: "版本线索", question: question("请定位提到本书 ISBN、出版社、译者、出版年份或版次的原句及上下文。并列保留不同版本线索；不要把出现 ISBN、年份相近或正文未提到版本解释成已经确认具体版本。") },
    ],
  };
}
