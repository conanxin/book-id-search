// Frozen PR85 candidate policy from ce420a3c010b4a6bf1b261df374baf1d1cd85ef7.
// Experimental comparator only; not used by the application.
import type { BookWebResearchSource } from "../../apps/api/src/ai/book-web-research.js";

export function isDirectBookReviewCandidate(source: BookWebResearchSource, bookTitle: string): boolean {
  const reviewTitle = /书评|读后感|评介|评述|读《|评《/u.test(source.title);
  const isbn = source.bookClues?.isbn;
  const hasTargetIsbn = isbn === "matched" || isbn === "mixed";
  const hasQuotedBookAndAuthor = source.title.includes(`《${bookTitle.trim()}》`)
    && source.bookClues?.text.includes("author");
  return reviewTitle && (hasTargetIsbn || !!hasQuotedBookAndAuthor);
}
