import type { RouteIntent } from "../../types/ai";

/**
 * Port for turning a free-form travel query into a structured RouteIntent.
 *
 * The planner needs intent parsing but must not depend on the `ai` module —
 * `ai` already depends on the planner (agent-tools calls
 * planAccessibleRouteFromRequest), so a direct import would close a cycle.
 * The planner therefore owns the interface and `ai` supplies the
 * implementation, which is registered once at the composition root (src/app.ts).
 */
export type RouteIntentParser = (
	query: string,
) => Promise<RouteIntent | null>;

let parser: RouteIntentParser | null = null;

/**
 * Installs the concrete intent parser. Called once from the composition root.
 *
 * @param next Implementation supplied by the `ai` module
 */
export function registerRouteIntentParser(next: RouteIntentParser): void {
	parser = next;
}

/**
 * Parses a query through the registered parser.
 *
 * Throws when no parser has been registered so the caller's existing failure
 * path reports the same "intent service unavailable" error it already reports
 * for a parser that throws, rather than silently degrading to "no intent".
 *
 * @param query Free-form travel query
 * @returns The parsed intent, or null when the query is unusable
 */
export function parseRouteIntent(query: string): Promise<RouteIntent | null> {
	if (!parser) {
		throw new Error("[accessible-route] no route intent parser registered");
	}
	return parser(query);
}
