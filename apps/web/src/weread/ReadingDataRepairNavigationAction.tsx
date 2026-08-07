// SPDX-License-Identifier: MIT
//
// ReadingDataRepairNavigationAction.tsx
//
// S27S-2A — Zero-hook explicit-user-trigger navigation action component.
//
// Renders one of three states based on NavigationIntent kind:
//   - enabled: renders a native <button type="button"> that calls
//              `onRequestNavigation` ONLY on a real user click
//   - informational: renders neutral informational text (no button)
//   - hidden: renders null
//
// This component:
//   - has ZERO hooks (no useState / useEffect / useMemo / useReducer / useRef)
//   - never auto-navigates on mount / focus / hover / timeout
//   - never touches DOM (no scroll / focus / element lookup)
//   - never issues network or storage writes
//   - never executes repair

import * as React from "react";
import type {
  ReadingDataRepairNavigationIntent,
} from "./wereadReadingDataRepairNavigation";
import type {
  ReadingDataRepairNavigationRequest,
} from "./wereadReadingDataRepairNavigationUi";
import {
  buildReadingDataRepairNavigationRequest,
  resolveNavigationTriggerState,
} from "./wereadReadingDataRepairNavigationUi";

export interface ReadingDataRepairNavigationActionProps {
  intent: ReadingDataRepairNavigationIntent;

  /**
   * Called exactly once per real user click, with a request built from
   // the intent. Never called on mount / render / focus / hover.
   */
  onRequestNavigation: (
    request: ReadingDataRepairNavigationRequest,
  ) => void;

  /**
   * Optional disabled flag (e.g. when the user has already navigated to
   // this surface in the current session).
   */
  disabled?: boolean;

  /**
   * Optional localized labels. Defaults are stable English placeholders;
   // the consumer can override per locale.
   */
  labels?: Partial<{
    viewRelatedArea: string;
    informational: string;
  }>;
}

const DEFAULT_LABELS = {
  viewRelatedArea: "查看对应区域",
  informational: "此项仅供说明，不执行页面导航。",
};

function handleClick(
  intent: ReadingDataRepairNavigationIntent,
  onRequestNavigation: (request: ReadingDataRepairNavigationRequest) => void,
): void {
  const request = buildReadingDataRepairNavigationRequest(intent);
  if (request !== null) {
    onRequestNavigation(request);
  }
}

export function ReadingDataRepairNavigationAction(
  props: ReadingDataRepairNavigationActionProps,
): React.ReactElement | null {
  const triggerState = resolveNavigationTriggerState(props.intent);

  if (triggerState === "hidden") {
    return null;
  }

  if (triggerState === "informational") {
    return React.createElement(
      "p",
      {
        className: "weread-reading-data-repair-navigation-action__informational",
        "data-testid": "weread-reading-data-repair-navigation-informational",
      },
      (props.labels?.informational ?? DEFAULT_LABELS.informational),
    );
  }

  // enabled
  const isDisabled = props.disabled === true;
  return React.createElement(
    "button",
    {
      type: "button",
      className: "weread-reading-data-repair-navigation-action__button",
      "data-testid": "weread-reading-data-repair-navigation-button",
      disabled: isDisabled,
      onClick: () => handleClick(props.intent, props.onRequestNavigation),
    },
    (props.labels?.viewRelatedArea ?? DEFAULT_LABELS.viewRelatedArea),
  );
}