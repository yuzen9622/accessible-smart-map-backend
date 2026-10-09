import type { AccessibilityMode, TransitPreference } from "./route";

export type RouteContextInput = { routeToken: string } | null;
export interface RoutingPreferences {
  mode?: AccessibilityMode;
  transitPreference?: TransitPreference;
  departureTime?: string;
  avoidStairs?: boolean;
  requireElevator?: boolean;
}
export type RouteContextFailure =
  "INVALID_ROUTE_TOKEN" | "ROUTE_CONTEXT_UNAVAILABLE" | "STALE_SELECTION";
export type RouteContextResult =
  | {
      ok: true;
      routeId: string | null;
      navigationId: string | null;
      routeVersion: number | null;
    }
  | { ok: false; reason: RouteContextFailure };
export interface RouteContextUpdate {
  requestId: string;
  selectionVersion: number;
  routeContext: RouteContextInput;
}

/** Two views of one execution: geometry and capability tokens stay with the UI. */
export interface ProjectedToolResult {
  clientResult: unknown;
  modelResult: unknown;
}
