// SPDX-License-Identifier: MIT
//
// ReadingDataRepairNavigationFeedback.tsx
//
// S27S-3B — Zero-hook visual feedback for the last guided navigation
// attempt and the ephemeral session summary.
//
// This component:
//   - has ZERO hooks
//   - never triggers navigation, network, storage, or DOM mutation
//   - displays only neutral, factual labels derived from the safe feedback model
//   - never uses user-evaluation language (success/failure/quality/ability/interest)
//   - never exposes private IDs, surfaceKey, action/capability/target enums, raw request/result

import type { JSX } from "react";

import type {
  ReadingDataRepairGuidedSessionState,
  ReadingDataRepairGuidedSessionSummary,
  ReadingDataRepairNavigationFeedbackLabelKey,
} from "./wereadReadingDataRepairGuidedSession";

const FEEDBACK_LABEL: Record<ReadingDataRepairNavigationFeedbackLabelKey, string> = {
  navigation_completed: "已定位到对应区域。",
  surface_not_available: "当前未找到对应区域，本次未执行页面导航。",
  multiple_surfaces_detected: "检测到多个对应区域，为避免误导航，本次未执行页面导航。",
  navigation_request_rejected: "导航请求未通过安全校验，本次未执行页面导航。",
};

export interface ReadingDataRepairNavigationFeedbackProps {
  session: ReadingDataRepairGuidedSessionState;
  summary: ReadingDataRepairGuidedSessionSummary;
}

export function ReadingDataRepairNavigationFeedback(
  props: ReadingDataRepairNavigationFeedbackProps,
): JSX.Element | null {
  const { session, summary } = props;

  if (session.attempts === 0) {
    return null;
  }

  const lastFeedback = session.lastFeedback;
  const label = lastFeedback !== null ? FEEDBACK_LABEL[lastFeedback.labelKey] : null;

  return (
    <section
      className="weread-reading-data-repair-navigation-feedback"
      data-testid="weread-reading-data-repair-navigation-feedback"
      aria-live="polite"
    >
      {label !== null && (
        <div
          className="weread-reading-data-repair-navigation-feedback__last"
          data-testid="weread-reading-data-repair-navigation-feedback-last"
          data-feedback-kind={lastFeedback?.kind}
          data-feedback-status={lastFeedback?.status}
        >
          {label}
        </div>
      )}

      <div
        className="weread-reading-data-repair-navigation-feedback__summary"
        data-testid="weread-reading-data-repair-navigation-feedback-summary"
      >
        <div className="weread-reading-data-repair-navigation-feedback__title">
          页面引导记录
        </div>
        <div className="weread-reading-data-repair-navigation-feedback__row">
          <span>尝试</span>
          <span data-testid="weread-reading-data-repair-feedback-attempts">{summary.attempts}</span>
        </div>
        <div className="weread-reading-data-repair-navigation-feedback__row">
          <span>已定位</span>
          <span data-testid="weread-reading-data-repair-feedback-successful">{summary.successful}</span>
        </div>
        <div className="weread-reading-data-repair-navigation-feedback__row">
          <span>未找到</span>
          <span data-testid="weread-reading-data-repair-feedback-unavailable">{summary.unavailable}</span>
        </div>
        <div className="weread-reading-data-repair-navigation-feedback__row">
          <span>多个候选</span>
          <span data-testid="weread-reading-data-repair-feedback-ambiguous">{summary.ambiguous}</span>
        </div>
        <div className="weread-reading-data-repair-navigation-feedback__row">
          <span>已拒绝</span>
          <span data-testid="weread-reading-data-repair-feedback-rejected">{summary.rejected}</span>
        </div>
      </div>

      <p className="weread-reading-data-repair-navigation-feedback__disclaimer">
        页面引导只改变当前视图位置，不会执行重试、重新加载或修改数据。
      </p>
    </section>
  );
}
