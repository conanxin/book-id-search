import type { AssessmentDetailResponse } from "./api";

type FrozenEvidenceItems = AssessmentDetailResponse["evidenceManifest"]["items"];

/**
 * Disclosure only: the v1 evidence contract records object IDs and notes,
 * not authenticated page/plate/paragraph locators or verbatim source excerpts.
 * No source URL, citation anchor, or verification status is inferred.
 */
export function EvidenceCitationScope({ items }: { items: FrozenEvidenceItems }) {
  if (!items.length) return null;
  const noLocation = items.every(item =>
    item.locatorType === null && item.locator === null && item.excerpt === null);

  return <p className="research-muted evidence-citation-scope" role="note">
    {noLocation
      ? "当前证据清单仅记录证据对象；页码、图版、段落与原文摘录均未记录。证据说明属于研究者备注，不代表已核验原文。"
      : "部分证据包含来源定位数据，但不代表已经核实原文；请逐项核对版本、页码、权限与摘录。"}
  </p>;
}
