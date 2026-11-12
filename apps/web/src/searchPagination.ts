/**
 * Current production Meilisearch books index is configured with pagination.maxTotalHits=1000.
 * This client-side cap is a temporary compatibility boundary for the existing
 * public SearchResponse, which reports estimatedTotalHits but no browsable cap.
 * A future API release should return the live server-side browsing limit.
 */
export const SEARCH_BROWSABLE_RESULTS_CAP = 1000;

export interface SearchBrowseScope {
  reportedTotal: number;
  browsableTotal: number;
  totalPages: number;
  truncated: boolean;
  outOfRange: boolean;
}

/**
 * Do not treat estimatedTotalHits as the number of navigable records.
 * Search result pages beyond maxTotalHits are empty even if estimatedTotalHits
 * is much higher; never navigate there in the public search UI.
 */
export function getSearchBrowseScope(
  reportedTotalInput: number,
  pageSizeInput: number,
  currentPageInput: number,
  maxBrowseInput = SEARCH_BROWSABLE_RESULTS_CAP,
): SearchBrowseScope {
  const reportedTotal = Number.isSafeInteger(reportedTotalInput) && reportedTotalInput >= 0
    ? reportedTotalInput : 0;
  const pageSize = Number.isSafeInteger(pageSizeInput) && pageSizeInput > 0
    ? pageSizeInput : 20;
  const browseCap = Number.isSafeInteger(maxBrowseInput) && maxBrowseInput > 0
    ? maxBrowseInput : SEARCH_BROWSABLE_RESULTS_CAP;
  const currentPage = Number.isSafeInteger(currentPageInput) && currentPageInput > 0
    ? currentPageInput : 1;
  const browsableTotal = Math.min(reportedTotal, browseCap);
  const totalPages = Math.max(1, Math.ceil(browsableTotal / pageSize));
  return {
    reportedTotal,
    browsableTotal,
    totalPages,
    truncated: reportedTotal > browseCap,
    outOfRange: reportedTotal > 0 && currentPage > totalPages,
  };
}
