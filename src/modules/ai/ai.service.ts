import { googleGenAi, model } from "../../config/ai";
import { intentConfig, explainConfig } from "../../config/ai/config";
import { intentContents, explainContents } from "../../config/ai/contents";
import type { AccessibilityMode } from "../../types/route";
import type { RouteIntent, RouteExplanation } from "../../types/ai";

const VALID_MODES: AccessibilityMode[] = [
  "wheelchair",
  "elderly",
  "visual_impaired",
  "normal",
];

/**
 * Parse a free-form travel query into a RouteIntent via a single structured
 * Gemini call. Returns null when the model produces no usable JSON or the
 * essential fields (from/to) are missing.
 *
 * @param query Free-form natural-language travel query
 * @returns The parsed RouteIntent, or null when unusable
 */
export async function parseRouteIntent(
  query: string,
): Promise<RouteIntent | null> {
  const aiResponse = await googleGenAi.models.generateContent({
    model,
    contents: [
      ...intentContents,
      { role: "user", parts: [{ text: JSON.stringify({ query }) }] },
    ],
    config: intentConfig,
  });

  const text = aiResponse?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) return null;

  let parsed: Partial<RouteIntent>;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  if (!parsed.from || !parsed.to) return null;

  const mode: AccessibilityMode = VALID_MODES.includes(
    parsed.mode as AccessibilityMode,
  )
    ? (parsed.mode as AccessibilityMode)
    : "normal";

  return {
    from: parsed.from,
    to: parsed.to,
    mode,
    departureTime: parsed.departureTime || "now",
    preferences: {
      minimizeTransfers: parsed.preferences?.minimizeTransfers ?? false,
      preferElevator:
        parsed.preferences?.preferElevator ?? mode === "wheelchair",
    },
  };
}

/**
 * Strip bulky fields (polylines, raw OSM facility arrays) from an
 * AccessibleRoute before sending it to Gemini — only what the explanation
 * prompt actually reads. Tolerates arbitrary route shapes.
 *
 * @param route Arbitrary AccessibleRoute-shaped object
 * @returns A compact route object for the explanation prompt
 */
function compactRoute(route: Record<string, any>): Record<string, any> {
  const legs = Array.isArray(route.legs)
    ? route.legs.map((leg: Record<string, any>) => {
        const {
          polyline: _polyline,
          a11yFacilities: _a11yFacilities,
          departureStopA11y: _depStopA11y,
          arrivalStopA11y: _arrStopA11y,
          departureStationA11y: _depStaA11y,
          arrivalStationA11y: _arrStaA11y,
          ...rest
        } = leg ?? {};
        return rest;
      })
    : [];
  return {
    routeName: route.routeName,
    totalMinutes: route.totalMinutes,
    transferCount: route.transferCount,
    departureDate: route.departureDate,
    accessibilityScore: route.accessibilityScore,
    accessibilityLabel: route.accessibilityLabel,
    accessibilityHighlights: route.accessibilityHighlights,
    legs,
  };
}

/**
 * Generate a RouteExplanation for a planned route via a single structured
 * Gemini call. Returns null when the model produces no usable JSON.
 *
 * @param route The AccessibleRoute object to explain
 * @param mode Accessibility mode shaping the explanation
 * @param language Output language for the explanation
 * @returns The generated RouteExplanation, or null when unusable
 */
export async function generateRouteExplanation(
  route: Record<string, any>,
  mode: AccessibilityMode = "normal",
  language: "zh-TW" | "en" = "zh-TW",
): Promise<RouteExplanation | null> {
  const aiResponse = await googleGenAi.models.generateContent({
    model,
    contents: [
      ...explainContents,
      {
        role: "user",
        parts: [
          {
            text: JSON.stringify({
              route: compactRoute(route),
              mode,
              language,
            }),
          },
        ],
      },
    ],
    config: explainConfig,
  });

  const text = aiResponse?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) return null;

  let parsed: Partial<RouteExplanation> & { alternatives?: string };
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed.summary) return null;

  return {
    summary: parsed.summary,
    accessibilityHighlights: Array.isArray(parsed.accessibilityHighlights)
      ? parsed.accessibilityHighlights
      : [],
    warnings: Array.isArray(parsed.warnings) ? parsed.warnings : [],
    alternatives: parsed.alternatives?.trim() ? parsed.alternatives : null,
  };
}
