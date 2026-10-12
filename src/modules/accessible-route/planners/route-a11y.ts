/**
 * Route accessibility enrichment.
 *
 * Shared, planner-agnostic helpers that decorate a finished AccessibleRoute leg
 * with accessibility context. Used by every active planner path (OTP and TDX
 * MaaS) via the accessible-route orchestrator; the former in-Mongo GTFS planner
 * also used these before it was retired.
 *
 *   - nearbyA11y       : OSM accessibility facilities around a stop coordinate
 *   - deriveHighlights : route-level a11y highlight strings from board/alight sets
 *   - attachA11yToLeg  : attach board/alight a11y arrays to a transit leg
 *   - enrichLegIndoor  : Indoor Graph step-free exit/elevator guidance
 *
 * Leg/route types are imported as TYPES only so this service has no runtime
 * dependency on the accessible-route module.
 */

import OsmA11y from "../../../model/osm-a11y.model";
import { getStationAccess } from "./indoor-graph";
import type { IOsmA11y } from "../../../types";
import type { SupportedLang } from "../../../types/lang";
import type { RouteMessageDescriptor } from "../../../types/route-message";
import { routeMessage } from "../../../utils/route-messages";
import type {
  AccessibilityMode,
  WalkLeg,
  BusLeg,
  MetroLeg,
  ThsrLeg,
  TraLeg,
} from "../../../types/route";
import type { RailLeg } from "./route-a11y.types";
export type { RailLeg };

const A11Y_RADIUS_M = 200;
const A11Y_LIMIT = 5;

/**
 * Nearby OSM accessibility facilities around a stop coordinate.
 *
 * @param coords The stop's [lng, lat] coordinates.
 * @returns The nearby OSM accessibility facilities.
 */
export async function nearbyA11y(
  coords: [number, number],
): Promise<IOsmA11y[]> {
  return OsmA11y.find({
    location: {
      $near: {
        $geometry: { type: "Point", coordinates: coords },
        $maxDistance: A11Y_RADIUS_M,
      },
    },
  })
    .limit(A11Y_LIMIT)
    .lean() as Promise<IOsmA11y[]>;
}

/**
 * Derive route-level accessibility highlights (same rules as the TDX path).
 *
 * @param boardA11y Accessibility facilities at the boarding stop.
 * @param alightA11y Accessibility facilities at the alighting stop.
 * @returns The derived highlight strings.
 */
export function deriveHighlightMessages(
  boardA11y: IOsmA11y[],
  alightA11y: IOsmA11y[],
): RouteMessageDescriptor[] {
  const tagVal = (nodes: IOsmA11y[], key: string, val: string) =>
    nodes.some((f) => f.tags?.[key] === val);
  const hasCat = (nodes: IOsmA11y[], ...cats: string[]) =>
    nodes.some((f) => cats.includes(f.category));

  const h: RouteMessageDescriptor[] = [];
  if (hasCat(boardA11y, "elevator") || tagVal(boardA11y, "elevator", "yes"))
    h.push(routeMessage("ROUTE_BOARD_ELEVATOR_NEARBY", "乘車站附近有電梯"));
  if (hasCat(alightA11y, "elevator") || tagVal(alightA11y, "elevator", "yes"))
    h.push(routeMessage("ROUTE_ALIGHT_ELEVATOR_NEARBY", "下車站附近有電梯"));
  if (hasCat(boardA11y, "kerb_cut", "ramp"))
    h.push(routeMessage("ROUTE_BOARD_RAMP_NEARBY", "乘車站附近有無障礙坡道"));
  if (hasCat(alightA11y, "kerb_cut", "ramp"))
    h.push(routeMessage("ROUTE_ALIGHT_RAMP_NEARBY", "下車站附近有無障礙坡道"));
  if (
    tagVal(boardA11y, "toilets:wheelchair", "yes") ||
    tagVal(alightA11y, "toilets:wheelchair", "yes")
  )
    h.push(
      routeMessage("ROUTE_ACCESSIBLE_TOILET_NEARBY", "站點附近有無障礙廁所"),
    );
  if (
    tagVal(boardA11y, "tactile_paving", "yes") ||
    tagVal(alightA11y, "tactile_paving", "yes")
  )
    h.push(routeMessage("ROUTE_TACTILE_PAVING_NEARBY", "附近有導盲磚"));
  if (
    tagVal(boardA11y, "traffic_signals:sound", "yes") ||
    tagVal(alightA11y, "traffic_signals:sound", "yes")
  )
    h.push(routeMessage("ROUTE_AUDIO_SIGNAL_NEARBY", "附近有音響號誌"));
  if (
    tagVal(boardA11y, "wheelchair", "yes") ||
    tagVal(boardA11y, "wheelchair", "designated")
  )
    h.push(routeMessage("ROUTE_BOARD_FACILITIES", "乘車站設施完善"));
  if (
    tagVal(alightA11y, "wheelchair", "yes") ||
    tagVal(alightA11y, "wheelchair", "designated")
  )
    h.push(routeMessage("ROUTE_ALIGHT_FACILITIES", "下車站設施完善"));
  return h;
}

export function deriveHighlights(
  boardA11y: IOsmA11y[],
  alightA11y: IOsmA11y[],
): string[] {
  return deriveHighlightMessages(boardA11y, alightA11y).map(
    (item) => item.legacyMessage,
  );
}

/**
 * Build a single mode-tailored Chinese sentence summarising a route's
 * accessibility, for direct display (replacing the frontend's generic
 * label-based copy). Wheelchair/normal emphasise elevator/ramp presence and walk
 * distance; elderly emphasises walk distance and transfers; visual_impaired
 * emphasises tactile paving / audio signals. Pure and always non-empty.
 *
 * @param input.mode Accessibility mode driving the emphasis.
 * @param input.walkDistanceM Total walking distance in metres.
 * @param input.transferCount Number of transfers in the route.
 * @param input.facilities All OSM a11y nodes gathered along the route.
 * @param input.label The route's score label (drives the closing verdict).
 * @returns An accessibility summary; omitted language preserves Chinese copy.
 */
export function buildAccessibilitySummary(input: {
  mode: AccessibilityMode;
  walkDistanceM: number;
  transferCount: number;
  facilities: IOsmA11y[];
  label: "excellent" | "good" | "fair" | "poor" | "critical";
  language?: SupportedLang;
}): string {
  const { mode, walkDistanceM, transferCount, facilities, label, language } =
    input;
  const copy = (zh: string, en: string) => (language === "en" ? en : zh);

  const hasElevator = facilities.some(
    (n) =>
      n.category === "elevator" ||
      n.tags?.["elevator"] === "yes" ||
      n.tags?.["highway"] === "elevator",
  );
  const hasRamp = facilities.some(
    (n) => n.category === "ramp" || n.tags?.["ramp:wheelchair"] === "yes",
  );
  const hasTactilePaving = facilities.some(
    (n) => n.tags?.["tactile_paving"] === "yes",
  );
  const hasAudioSignal = facilities.some(
    (n) => n.tags?.["traffic_signals:sound"] === "yes",
  );

  const walkText = copy(
    `步行約 ${Math.round(walkDistanceM)} 公尺`,
    `Walk about ${Math.round(walkDistanceM)} m`,
  );
  const transferText =
    transferCount <= 0
      ? copy("全程直達", "Direct service")
      : copy(
          `需轉乘 ${transferCount} 次`,
          `${transferCount} transfer(s) required`,
        );

  const verdict = (good: string, ok: string, hard: string): string => {
    if (label === "excellent" || label === "good") return good;
    if (label === "fair") return ok;
    return hard;
  };

  const parts: string[] = [];

  if (mode === "visual_impaired") {
    parts.push(
      hasTactilePaving || hasAudioSignal
        ? copy(
            "沿途設有導盲磚或語音號誌",
            "Tactile paving or audible signals are available along the route",
          )
        : copy(
            "沿途導盲設施資訊有限",
            "Information on guidance facilities along the route is limited",
          ),
    );
    parts.push(transferText);
    parts.push(
      verdict(
        copy("適合視障者通行", "Suitable for visually impaired travellers"),
        copy(
          "大致可行，請留意路口",
          "Generally feasible; take care at crossings",
        ),
        copy(
          "通行較困難，建議結伴",
          "Travel may be difficult; consider travelling with a companion",
        ),
      ),
    );
  } else if (mode === "elderly") {
    parts.push(walkText);
    parts.push(transferText);
    if (hasElevator)
      parts.push(
        copy("車站設有電梯可搭乘", "Elevators are available at stations"),
      );
    parts.push(
      verdict(
        copy(
          "步行負擔低，適合長者",
          "Low walking burden, suitable for older travellers",
        ),
        copy(
          "步行負擔尚可，請適度休息",
          "Moderate walking burden; take breaks as needed",
        ),
        copy(
          "步行或轉乘負擔較大，請斟酌",
          "Walking or transfers may be demanding; consider your needs",
        ),
      ),
    );
  } else {
    parts.push(
      hasElevator
        ? copy("全程設有電梯", "Elevators are available along the route")
        : hasRamp
          ? copy(
              "沿途設有無障礙坡道",
              "Accessible ramps are available along the route",
            )
          : copy(
              "沿途無障礙設施資訊有限",
              "Accessibility facility information along the route is limited",
            ),
    );
    parts.push(walkText);
    parts.push(
      verdict(
        copy("適合輪椅通行", "Suitable for wheelchair travel"),
        copy(
          "大致可行，建議留意路況",
          "Generally feasible; check conditions along the route",
        ),
        copy(
          "通行較困難，請斟酌",
          "Travel may be difficult; consider your needs",
        ),
      ),
    );
  }

  return language === "en" ? `${parts.join("; ")}.` : parts.join("，");
}

/**
 * Attach board/alight a11y arrays to a transit leg (field name varies by type).
 *
 * @param leg The transit leg to annotate.
 * @param boardA11y Accessibility facilities at the boarding stop.
 * @param alightA11y Accessibility facilities at the alighting stop.
 */
export function attachA11yToLeg(
  leg: BusLeg | MetroLeg | ThsrLeg | TraLeg,
  boardA11y: IOsmA11y[],
  alightA11y: IOsmA11y[],
): void {
  if (leg.type === "BUS") {
    leg.departureStopA11y = boardA11y;
    leg.arrivalStopA11y = alightA11y;
  } else {
    leg.departureStationA11y = boardA11y;
    leg.arrivalStationA11y = alightA11y;
  }
}

/**
 * Enrich a rail leg + its adjacent walk legs with indoor-graph guidance:
 *  • the in-station walk to the boarding station gets `exitInfo` (nearest
 *    step-free entrance + elevator info), and likewise the walk OUT of the
 *    alighting station;
 *  • the rail leg's `facilityHighlights` gains step-free / elevator notes.
 *
 * Best-effort and non-throwing: stations without indoor data are left untouched.
 *
 * @param leg The rail leg to enrich.
 * @param walkIn The walk leg into the boarding station, or null.
 * @param walkOut The walk leg out of the alighting station, or null.
 * @param originCoords The user's [lng, lat] origin.
 * @param destCoords The user's [lng, lat] destination.
 * @param boardCoords The boarding station's [lng, lat] coordinates.
 * @param alightCoords The alighting station's [lng, lat] coordinates.
 * @param mode The accessibility mode for traversal constraints.
 */
export async function enrichLegIndoor(
  leg: RailLeg,
  walkIn: WalkLeg | null,
  walkOut: WalkLeg | null,
  originCoords: [number, number],
  destCoords: [number, number],
  boardCoords: [number, number],
  alightCoords: [number, number],
  mode: AccessibilityMode = "wheelchair",
): Promise<void> {
  const boardName = leg.departureStation;
  const alightName = leg.arrivalStation;

  const [board, alight] = await Promise.all([
    getStationAccess(
      { name: boardName, coords: boardCoords },
      originCoords,
      mode,
    ),
    getStationAccess(
      { name: alightName, coords: alightCoords },
      destCoords,
      mode,
      "egress",
    ),
  ]);

  const exitTypeFor = (a: NonNullable<typeof board>) =>
    (a.usesElevator ? "elevator" : "ramp") as "elevator" | "ramp";

  if (board?.entrance) {
    if (walkIn && board.stepFree) {
      walkIn.exitInfo = {
        exitName: board.entrance.name,
        exitNumber: board.entrance.exitNumber,
        type: exitTypeFor(board),
        coords: board.entrance.coords,
      };
    }
    if (board.stepFree && board.usesElevator) {
      leg.facilityHighlights.push(
        `乘車站「${board.stationName}」可由${board.entrance.name}電梯無障礙進站` +
          (board.elevatorLevelName ? `（${board.elevatorLevelName}）` : ""),
      );
    } else if (board.stepFree) {
      leg.facilityHighlights.push(
        `乘車站「${board.stationName}」${board.entrance.name}為無障礙平面進站`,
      );
    } else if (board.hasElevator) {
      leg.facilityHighlights.push(`乘車站「${board.stationName}」設有電梯`);
    }
  }

  if (alight?.entrance) {
    if (walkOut && alight.stepFree) {
      walkOut.exitInfo = {
        exitName: alight.entrance.name,
        exitNumber: alight.entrance.exitNumber,
        type: exitTypeFor(alight),
        coords: alight.entrance.coords,
      };
    }
    if (alight.stepFree && alight.usesElevator) {
      leg.facilityHighlights.push(
        `下車站「${alight.stationName}」可由${alight.entrance.name}電梯無障礙出站` +
          (alight.elevatorLevelName ? `（${alight.elevatorLevelName}）` : ""),
      );
    } else if (alight.stepFree) {
      leg.facilityHighlights.push(
        `下車站「${alight.stationName}」${alight.entrance.name}為無障礙平面出站`,
      );
    } else if (alight.hasElevator) {
      leg.facilityHighlights.push(`下車站「${alight.stationName}」設有電梯`);
    }
  }
}
