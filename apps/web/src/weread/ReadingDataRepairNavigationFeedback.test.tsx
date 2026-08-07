// SPDX-License-Identifier: MIT
//
// ReadingDataRepairNavigationFeedback.test.tsx
//
// S27S-3B — Feedback UI tests. This component is zero-hook and renders
// safe session feedback only.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { ReadingDataRepairNavigationFeedback } from "./ReadingDataRepairNavigationFeedback";
import {
  applyReadingDataRepairNavigationFeedback,
  buildReadingDataRepairGuidedSessionSummary,
  buildReadingDataRepairNavigationFeedback,
  createInitialReadingDataRepairGuidedSession,
  type ReadingDataRepairGuidedSessionState,
  type ReadingDataRepairGuidedSessionSummary,
} from "./wereadReadingDataRepairGuidedSession";
import type { ReadingDataRepairNavigationRequest } from "./wereadReadingDataRepairNavigationUi";
import type { ReadingDataRepairNavigationExecutionResult } from "./wereadReadingDataRepairNavigationRuntime";

function makeRequest(): ReadingDataRepairNavigationRequest {
  return {
    sourceIssueCode: "empty_archive",
    action: "retry_failed_year",
    capability: "user_retry",
    target: "failed_year_controls",
    surfaceKey: "weread-reading-archive-controls",
    year: 2023,
    initiatedBy: "user_click",
    automatic: false,
    executesRepair: false,
    requestedNetwork: false,
    modifiesSourceData: false,
  };
}

function makeResult(
  status: ReadingDataRepairNavigationExecutionResult["status"],
): ReadingDataRepairNavigationExecutionResult {
  return {
    status,
    surfaceKey: "weread-reading-archive-controls",
    scrollCount: status === "navigated" ? 1 : 0,
    focusCount: status === "navigated" ? 1 : 0,
  };
}

function makeSession(
  status: ReadingDataRepairNavigationExecutionResult["status"],
): { session: ReadingDataRepairGuidedSessionState; summary: ReadingDataRepairGuidedSessionSummary } {
  const f = buildReadingDataRepairNavigationFeedback(makeRequest(), makeResult(status));
  const s = applyReadingDataRepairNavigationFeedback(createInitialReadingDataRepairGuidedSession(), f);
  return { session: s, summary: buildReadingDataRepairGuidedSessionSummary(s) };
}

function renderFeedback(status: ReadingDataRepairNavigationExecutionResult["status"]) {
  const { session, summary } = makeSession(status);
  return renderToStaticMarkup(
    <ReadingDataRepairNavigationFeedback
      session={session}
      summary={summary}
    />,
  );
}

describe("S27S-3B ReadingDataRepairNavigationFeedback", () => {
  it("1. initial state renders no false feedback", () => {
    const session = createInitialReadingDataRepairGuidedSession();
    const summary = buildReadingDataRepairGuidedSessionSummary(session);
    const html = renderToStaticMarkup(
      <ReadingDataRepairNavigationFeedback session={session} summary={summary} />,
    );
    expect(html).not.toContain("已定位");
    expect(html).not.toContain("导航失败");
    expect(html).not.toContain("0 次");
  });

  it("2. navigation_completed text is rendered", () => {
    const html = renderFeedback("navigated");
    expect(html).toContain("已定位到对应区域");
  });

  it("3. surface_not_available text is rendered", () => {
    const html = renderFeedback("surface_not_found");
    expect(html).toContain("当前未找到对应区域");
  });

  it("4. multiple_surfaces_detected text is rendered", () => {
    const html = renderFeedback("ambiguous_surface");
    expect(html).toContain("检测到多个对应区域");
  });

  it("5. navigation_request_rejected text is rendered", () => {
    const html = renderFeedback("rejected_request");
    expect(html).toContain("导航请求未通过安全校验");
  });

  it("6. success kind is set on completed feedback", () => {
    const html = renderFeedback("navigated");
    expect(html).toContain('data-feedback-kind="success"');
  });

  it("7. notice kind is set on unavailable feedback", () => {
    const html = renderFeedback("surface_not_found");
    expect(html).toContain('data-feedback-kind="notice"');
  });

  it("8. warning kind is set on ambiguous feedback", () => {
    const html = renderFeedback("ambiguous_surface");
    expect(html).toContain('data-feedback-kind="warning"');
  });

  it("9. warning kind is set on rejected feedback", () => {
    const html = renderFeedback("rejected_request");
    expect(html).toContain('data-feedback-kind="warning"');
  });

  it("10. aria-live is polite", () => {
    const html = renderFeedback("navigated");
    expect(html).toContain('aria-live="polite"');
  });

  it("11. attempts count is displayed", () => {
    const html = renderFeedback("navigated");
    expect(html).toContain('data-testid="weread-reading-data-repair-feedback-attempts"');
    expect(html).toMatch(/data-testid="weread-reading-data-repair-feedback-attempts"[^>]*>1</);
  });

  it("12. successful count is displayed", () => {
    const html = renderFeedback("navigated");
    expect(html).toMatch(/data-testid="weread-reading-data-repair-feedback-successful"[^>]*>1</);
  });

  it("13. unavailable count is displayed", () => {
    const html = renderFeedback("surface_not_found");
    expect(html).toMatch(/data-testid="weread-reading-data-repair-feedback-unavailable"[^>]*>1</);
  });

  it("14. ambiguous count is displayed", () => {
    const html = renderFeedback("ambiguous_surface");
    expect(html).toMatch(/data-testid="weread-reading-data-repair-feedback-ambiguous"[^>]*>1</);
  });

  it("15. rejected count is displayed", () => {
    const html = renderFeedback("rejected_request");
    expect(html).toMatch(/data-testid="weread-reading-data-repair-feedback-rejected"[^>]*>1</);
  });

  it("16. no success rate is displayed", () => {
    const html = renderFeedback("navigated");
    expect(html).not.toContain("成功率");
    expect(html).not.toContain("%");
  });

  it("17. no failure rate is displayed", () => {
    const html = renderFeedback("surface_not_found");
    expect(html).not.toContain("失败率");
  });

  it("18. no repair rate is displayed", () => {
    const html = renderFeedback("navigated");
    expect(html).not.toContain("修复率");
  });

  it("19. no target enum rendered", () => {
    const html = renderFeedback("navigated");
    expect(html).not.toContain("failed_year_controls");
  });

  it("20. no surfaceKey rendered", () => {
    const html = renderFeedback("navigated");
    expect(html).not.toContain("weread-reading-archive-controls");
  });

  it("21. no sourceIssueCode rendered", () => {
    const html = renderFeedback("navigated");
    expect(html).not.toContain("empty_archive");
  });

  it("22. no action enum rendered", () => {
    const html = renderFeedback("navigated");
    expect(html).not.toContain("retry_failed_year");
  });

  it("23. no capability enum rendered", () => {
    const html = renderFeedback("navigated");
    expect(html).not.toContain("user_retry");
  });

  it("24. no IDs rendered", () => {
    const html = renderFeedback("navigated");
    expect(html).not.toMatch(/rec[a-z0-9]{8,}/);
    expect(html).not.toMatch(/issue[a-z0-9]{8,}/);
  });

  it("25. no actual/expected rendered", () => {
    const html = renderFeedback("navigated");
    expect(html).not.toMatch(/\bactual\b|\bexpected\b/);
  });

  it("26. no title/author/catalogId rendered", () => {
    const html = renderFeedback("navigated");
    const stripped = html.replace(/class="[^"]*"/g, "");
    expect(stripped).not.toMatch(/title|author|catalogId/);
  });

  it("27. no auto-repair wording", () => {
    const html = renderFeedback("navigated");
    expect(html).not.toContain("自动修复");
    expect(html).not.toContain("一键修复");
  });

  it("28. no user-success wording", () => {
    const html = renderFeedback("navigated");
    expect(html).not.toContain("用户成功");
    expect(html).not.toContain("修复成功");
  });

  it("29. no user-failure wording", () => {
    const html = renderFeedback("surface_not_found");
    expect(html).not.toContain("用户失败");
    expect(html).not.toContain("修复失败");
  });

  it("30. no evaluation wording", () => {
    const html = renderFeedback("navigated");
    expect(html).not.toMatch(/阅读质量|能力提升|兴趣增强|人格|优秀|较差|健康分|风险分/);
  });

  it("31. zero hooks in Feedback component", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const src = await fs.readFile(
      path.resolve(__dirname, "ReadingDataRepairNavigationFeedback.tsx"),
      "utf8",
    );
    expect(src).not.toMatch(/useState|useEffect|useMemo|useReducer|useRef/);
  });

  it("32. no DOM API in Feedback component", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const src = await fs.readFile(
      path.resolve(__dirname, "ReadingDataRepairNavigationFeedback.tsx"),
      "utf8",
    );
    expect(src).not.toMatch(/window|document|querySelector|scrollIntoView|focus\(/);
  });

  it("33. no storage access", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const src = await fs.readFile(
      path.resolve(__dirname, "ReadingDataRepairNavigationFeedback.tsx"),
      "utf8",
    );
    expect(src).not.toMatch(/localStorage|sessionStorage|indexedDB/);
  });

  it("34. no URL access", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const src = await fs.readFile(
      path.resolve(__dirname, "ReadingDataRepairNavigationFeedback.tsx"),
      "utf8",
    );
    expect(src).not.toMatch(/history|location|hash/);
  });

  it("35. no network access", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const src = await fs.readFile(
      path.resolve(__dirname, "ReadingDataRepairNavigationFeedback.tsx"),
      "utf8",
    );
    expect(src).not.toMatch(/fetch\(|XMLHttpRequest|WebSocket/);
  });

  it("36. safe disclaimer is present", () => {
    const html = renderFeedback("navigated");
    expect(html).toContain("页面引导只改变当前视图位置，不会执行重试、重新加载或修改数据");
  });

  it("37. no NaN/Infinity displayed", () => {
    const html = renderFeedback("navigated");
    expect(html).not.toContain("NaN");
    expect(html).not.toContain("Infinity");
  });

  it("38. deterministic render for same session", () => {
    const { session, summary } = makeSession("navigated");
    const a = renderToStaticMarkup(<ReadingDataRepairNavigationFeedback session={session} summary={summary} />);
    const b = renderToStaticMarkup(<ReadingDataRepairNavigationFeedback session={session} summary={summary} />);
    expect(a).toBe(b);
  });

  it("39. no autoFocus attribute", () => {
    const html = renderFeedback("navigated");
    expect(html).not.toContain("autoFocus");
    expect(html).not.toContain("autofocus");
  });

  it("40. no role=alert", () => {
    const html = renderFeedback("navigated");
    expect(html).not.toContain('role="alert"');
  });
});
