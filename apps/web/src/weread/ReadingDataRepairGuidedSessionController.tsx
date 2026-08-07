// SPDX-License-Identifier: MIT
//
// ReadingDataRepairGuidedSessionController.tsx
//
// S27S-3B — Ephemeral session state controller.
//
// This component owns the single React `useState` for the guided navigation
// session. It does NOT execute DOM navigation itself; it delegates to the
// existing Runtime executor, then feeds the Execution Result into the pure
// Feedback/Session model.
//
// Contract:
//   - exactly one `useState`
//   - zero `useEffect` / `useMemo` / `useReducer` / `useRef`
//   - no DOM access, no storage, no network, no URL, no retry, no timeout
//   - session is ephemeral: persisted=false, no wall-clock timestamps, no random
//   - reset happens only through the parent-supplied React `key` remount

import { useState, type JSX } from "react";

import type { ReadingDataRepairNavigationRequest } from "./wereadReadingDataRepairNavigationUi";
import {
  executeReadingDataRepairNavigationRequest,
  type ReadingDataRepairNavigationExecutionResult,
} from "./wereadReadingDataRepairNavigationRuntime";
import {
  applyReadingDataRepairNavigationFeedback,
  buildReadingDataRepairGuidedSessionSummary,
  buildReadingDataRepairNavigationFeedback,
  createInitialReadingDataRepairGuidedSession,
  resetReadingDataRepairGuidedSession,
  type ReadingDataRepairGuidedSessionState,
  type ReadingDataRepairGuidedSessionSummary,
} from "./wereadReadingDataRepairGuidedSession";

export interface ReadingDataRepairGuidedSessionRenderContext {
  session: ReadingDataRepairGuidedSessionState;
  summary: ReadingDataRepairGuidedSessionSummary;
  onRequestNavigation: (request: ReadingDataRepairNavigationRequest) => void;
}

export interface ReadingDataRepairGuidedSessionControllerProps {
  children: (context: ReadingDataRepairGuidedSessionRenderContext) => JSX.Element;
  executor?: (request: ReadingDataRepairNavigationRequest) => ReadingDataRepairNavigationExecutionResult;
}

export function ReadingDataRepairGuidedSessionController(
  props: ReadingDataRepairGuidedSessionControllerProps,
): JSX.Element {
  const [session, setSession] = useState<ReadingDataRepairGuidedSessionState>(
    createInitialReadingDataRepairGuidedSession,
  );

  const executor = props.executor ?? executeReadingDataRepairNavigationRequest;

  const handleRequestNavigation = (request: ReadingDataRepairNavigationRequest): void => {
    const result = executor(request);
    const feedback = buildReadingDataRepairNavigationFeedback(request, result);
    setSession((prev) => applyReadingDataRepairNavigationFeedback(prev, feedback));
  };

  const summary = buildReadingDataRepairGuidedSessionSummary(session);

  return props.children({
    session,
    summary,
    onRequestNavigation: handleRequestNavigation,
  });
}

export { resetReadingDataRepairGuidedSession };
