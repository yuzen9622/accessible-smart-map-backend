/**
 * Top-3 demotion for routes that board or alight at a metro station with an
 * active elevator anomaly notice. The notices are station-level (they never say
 * which of a station's elevators is out), so an affected route is moved behind
 * unaffected ones rather than excluded. Routes with a blocking hazard on route
 * stay behind every route without one.
 */

import type { AccessibilityMode, AccessibleRoute } from "../../types/route";

/**
 * Stable reorder of the final routes in place.
 *
 * @param routes The final routes, best first.
 * @param affected Routes touching a station with an active elevator notice.
 * @param mode The accessibility mode.
 * @param requireElevator Whether the caller requires working elevators.
 */
export function demoteElevatorNoticeRoutes(
  routes: AccessibleRoute[],
  affected: ReadonlySet<AccessibleRoute>,
  mode: AccessibilityMode,
  requireElevator: boolean,
): void {
  if (routes.length < 2 || affected.size === 0) return;
  if (mode !== "wheelchair" && !requireElevator) return;
  if (routes.some((r) => r._isFutureScheduled === true)) return;

  const ranked = routes.map((route, index) => ({
    route,
    index,
    key:
      ((route.hazardAdvisory?.blockingOnRoute ?? 0) > 0 ? 2 : 0) +
      (affected.has(route) ? 1 : 0),
  }));
  ranked.sort((a, b) => a.key - b.key || a.index - b.index);
  for (let i = 0; i < ranked.length; i++) routes[i] = ranked[i].route;
}
