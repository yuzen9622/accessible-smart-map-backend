/**
 * AI domain contracts shared across modules — the structured shapes the AI
 * layer parses a query into (RouteIntent) and explains a route with
 * (RouteExplanation). Lives in the neutral types layer so the ai module and the
 * accessible-route orchestrator can both depend on them DOWNWARD.
 */

import type { AccessibilityMode, TransitPreference } from "./route";

export interface RouteIntent {
  from: string;
  to: string;
  mode: AccessibilityMode;
  departureTime: string;
  preferences: {
    transitPreference?: TransitPreference;
    minimizeTransfers: boolean;
    preferElevator: boolean;
  };
}

export interface RouteExplanation {
  summary: string;
  accessibilityHighlights: string[];
  warnings: string[];
  alternatives: string | null;
}
