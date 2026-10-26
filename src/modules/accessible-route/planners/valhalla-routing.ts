import { decode } from "@googlemaps/polyline-codec";
import {
  computeValhallaRoutes,
  type NormalizedValhallaLeg,
  type NormalizedValhallaManeuver,
  type NormalizedValhallaTrip,
  type ValhallaCosting,
} from "../../../adapters/valhalla.adapter";
import { VALHALLA_OSM_ATTRIBUTION } from "../../../config/valhalla";
import { TRAFFIC_MSG } from "../../../constants/messages";
import type {
  AccessibleRoute,
  DriveLeg,
  DriveStep,
  WalkLeg,
  WalkStep,
  WalkAccessRequest,
} from "../../../types/route";
import type {
  LatLng,
  PlanRoadRouteOptions,
  RoadTravelMode,
} from "../accessible-route.types";
import { haversineMeters } from "../../../utils/geo";
import { routeMessage } from "../../../utils/route-messages";
import { normalizeRelativeDirection } from "../../../utils/nav-instructions-engine";
import { ValhallaRoutingError } from "./valhalla-routing.types";
import { unknownWalkA11yDetails } from "./walk-a11y";

export { ValhallaRoutingError } from "./valhalla-routing.types";

const COSTING: Record<RoadTravelMode, ValhallaCosting> = {
  drive: "auto",
  motorcycle: "motorcycle",
  walk: "pedestrian",
};

/** Real point is treated as roadside (no walk connector) within this straight-line gap. */
const WALK_ACCESS_MIN_GAP_M = 30;
const ROUTE_LABEL: Record<RoadTravelMode, string> = {
  drive: "開車",
  motorcycle: "騎車",
  walk: "步行",
};

const MANEUVER_BY_TYPE: Record<number, string> = {
  1: "DEPART",
  2: "DEPART",
  3: "DEPART",
  4: "ARRIVE",
  5: "ARRIVE",
  6: "ARRIVE",
  7: "STRAIGHT",
  8: "STRAIGHT",
  9: "TURN_SLIGHT_RIGHT",
  10: "TURN_RIGHT",
  11: "TURN_SHARP_RIGHT",
  12: "UTURN_RIGHT",
  13: "UTURN_LEFT",
  14: "TURN_SHARP_LEFT",
  15: "TURN_LEFT",
  16: "TURN_SLIGHT_LEFT",
  17: "RAMP_STRAIGHT",
  18: "RAMP_RIGHT",
  19: "RAMP_LEFT",
  20: "EXIT_RIGHT",
  21: "EXIT_LEFT",
  22: "STRAIGHT",
  23: "KEEP_RIGHT",
  24: "KEEP_LEFT",
  25: "MERGE",
  26: "ROUNDABOUT_ENTER",
  27: "ROUNDABOUT_EXIT",
  28: "FERRY_ENTER",
  29: "FERRY_EXIT",
  37: "MERGE_RIGHT",
  38: "MERGE_LEFT",
  39: "ELEVATOR",
  40: "STAIRS",
  41: "ESCALATOR",
  42: "ENTER_STATION",
  43: "EXIT_STATION",
};

const WALK_DIRECTION: Record<string, string> = {
  DEPART: "DEPART",
  STRAIGHT: "STRAIGHT",
  TURN_LEFT: "LEFT",
  TURN_RIGHT: "RIGHT",
  TURN_SHARP_LEFT: "HARD_LEFT",
  TURN_SHARP_RIGHT: "HARD_RIGHT",
  TURN_SLIGHT_LEFT: "SLIGHTLY_LEFT",
  TURN_SLIGHT_RIGHT: "SLIGHTLY_RIGHT",
  KEEP_LEFT: "SLIGHTLY_LEFT",
  KEEP_RIGHT: "SLIGHTLY_RIGHT",
  UTURN_LEFT: "UTURN_LEFT",
  UTURN_RIGHT: "UTURN_RIGHT",
  ROUNDABOUT_ENTER: "CIRCLE_CLOCKWISE",
  ROUNDABOUT_EXIT: "CIRCLE_CLOCKWISE",
  ELEVATOR: "ELEVATOR",
  ENTER_STATION: "ENTER_STATION",
  EXIT_STATION: "EXIT_STATION",
};

function minutes(seconds: number): number {
  return Math.round(seconds / 60);
}

export function decodeValhallaShape(shape: string): [number, number][] {
  const points = decode(shape, 6).map(
    ([lat, lng]) => [lng, lat] as [number, number],
  );
  if (
    points.length < 2 ||
    points.some(
      ([lng, lat]) =>
        !Number.isFinite(lng) ||
        !Number.isFinite(lat) ||
        lng < -180 ||
        lng > 180 ||
        lat < -90 ||
        lat > 90,
    )
  )
    throw new Error("Invalid Valhalla polyline");
  return points;
}

function guidanceFits(
  maneuvers: NormalizedValhallaManeuver[] | undefined,
  points: [number, number][],
): boolean {
  return (
    !!maneuvers?.length &&
    maneuvers.every(
      (m) =>
        m.beginShapeIndex < points.length && m.endShapeIndex < points.length,
    )
  );
}

function maneuverCode(maneuver: NormalizedValhallaManeuver): string {
  return MANEUVER_BY_TYPE[maneuver.type] ?? "CONTINUE";
}

function localizedInstruction(
  maneuver: NormalizedValhallaManeuver,
  code: string,
): string {
  const street = maneuver.streetNames?.[0]?.trim();
  const onto = street ? `進入「${street}」` : "";
  const along = street ? `沿「${street}」` : "沿目前道路";
  switch (code) {
    case "DEPART":
      return `${along}出發`;
    case "ARRIVE":
      return "抵達目的地";
    case "TURN_LEFT":
      return `向左轉${onto}`;
    case "TURN_RIGHT":
      return `向右轉${onto}`;
    case "TURN_SLIGHT_LEFT":
      return `稍向左轉${onto}`;
    case "TURN_SLIGHT_RIGHT":
      return `稍向右轉${onto}`;
    case "TURN_SHARP_LEFT":
      return `大幅向左轉${onto}`;
    case "TURN_SHARP_RIGHT":
      return `大幅向右轉${onto}`;
    case "KEEP_LEFT":
      return "靠左行進";
    case "KEEP_RIGHT":
      return "靠右行進";
    case "UTURN_LEFT":
    case "UTURN_RIGHT":
      return "請迴轉";
    case "RAMP_LEFT":
      return "從左側匝道行進";
    case "RAMP_RIGHT":
      return "從右側匝道行進";
    case "RAMP_STRAIGHT":
      return "繼續沿匝道直行";
    case "EXIT_LEFT":
      return "從左側出口駛出";
    case "EXIT_RIGHT":
      return "從右側出口駛出";
    case "MERGE_LEFT":
      return "向左併入道路";
    case "MERGE_RIGHT":
      return "向右併入道路";
    case "MERGE":
      return "併入道路";
    case "ROUNDABOUT_ENTER":
      return "進入圓環並依指示行進";
    case "ROUNDABOUT_EXIT":
      return `駛出圓環${onto}`;
    case "FERRY_ENTER":
      return "前往渡輪乘船處";
    case "FERRY_EXIT":
      return "離開渡輪";
    case "ELEVATOR":
      return "搭乘電梯";
    case "STAIRS":
      return "走樓梯繼續前進";
    case "ESCALATOR":
      return "搭乘手扶梯";
    case "ENTER_STATION":
      return "進入建築或車站";
    case "EXIT_STATION":
      return "離開建築或車站";
    case "STRAIGHT":
    case "CONTINUE":
    default:
      return `${along}繼續直行`;
  }
}

function driveSteps(
  leg: NormalizedValhallaLeg,
  points: [number, number][],
): DriveStep[] | undefined {
  if (!guidanceFits(leg.maneuvers, points)) return undefined;
  return leg
    .maneuvers!.filter((m) => maneuverCode(m) !== "ARRIVE")
    .map((m) => {
      const maneuver = maneuverCode(m);
      return {
        instruction: localizedInstruction(m, maneuver),
        maneuver,
        distanceM: Math.round(m.lengthKm * 1000),
        durationMin: minutes(m.timeSec),
        polyline: points.slice(m.beginShapeIndex, m.endShapeIndex + 1),
      };
    });
}

function walkSteps(
  leg: NormalizedValhallaLeg,
  points: [number, number][],
): WalkStep[] | undefined {
  if (!guidanceFits(leg.maneuvers, points)) return undefined;
  return leg
    .maneuvers!.filter((m) => maneuverCode(m) !== "ARRIVE")
    .map((m) => {
      const maneuver = maneuverCode(m);
      const streetName = m.streetNames?.[0] ?? "";
      return {
        relativeDirection: normalizeRelativeDirection(
          WALK_DIRECTION[maneuver] ?? "CONTINUE",
        ),
        absoluteDirection: null,
        streetName,
        bogusName: streetName.length === 0,
        area: false,
        stairs: m.stairs,
        steepSlope: false,
        distanceM: Math.round(m.lengthKm * 1000),
        location: points[m.beginShapeIndex],
      };
    });
}

function labels(index: number, count: number): [string, string] {
  return [
    index === 0 ? "起點" : `中途點 ${index}`,
    index === count - 1 ? "終點" : `中途點 ${index + 1}`,
  ];
}

function mapTrip(
  trip: NormalizedValhallaTrip,
  mode: RoadTravelMode,
  index: number,
): AccessibleRoute {
  const mappedLegs = trip.legs.map((leg, legIndex): DriveLeg | WalkLeg => {
    const points = decodeValhallaShape(leg.shapePolyline6);
    if (mode === "walk") {
      const [from, to] = labels(legIndex, trip.legs.length);
      return {
        type: "WALK",
        from,
        to,
        distanceM: Math.round(leg.summary.lengthKm * 1000),
        minutesEst: minutes(leg.summary.timeSec),
        polyline: points,
        a11yFacilities: [],
        ...unknownWalkA11yDetails(),
        ...(walkSteps(leg, points) ? { steps: walkSteps(leg, points) } : {}),
      };
    }
    return {
      type: mode === "motorcycle" ? "MOTORCYCLE" : "DRIVE",
      from: { lat: points[0][1], lng: points[0][0] },
      to: { lat: points.at(-1)![1], lng: points.at(-1)![0] },
      distanceM: Math.round(leg.summary.lengthKm * 1000),
      durationMin: minutes(leg.summary.timeSec),
      polyline: points,
      ...(driveSteps(leg, points) ? { steps: driveSteps(leg, points) } : {}),
      maneuvers: leg.maneuvers,
    };
  });
  return {
    routeId: `${mode}-${index}`,
    routeName: ROUTE_LABEL[mode],
    totalMinutes: minutes(trip.summary.timeSec),
    transferCount: 0,
    legs: mappedLegs,
    accessibilityHighlights: [],
    totalWalkDistanceM:
      mode === "walk"
        ? mappedLegs.reduce((sum, leg) => sum + leg.distanceM, 0)
        : 0,
    attribution: VALHALLA_OSM_ATTRIBUTION,
  };
}

/** Declare mandatory anchors only. No pedestrian provider is qualified here. */
function attachWalkAccessLegs(
  routes: AccessibleRoute[],
  origin: LatLng,
  destination: LatLng,
  waypoints: LatLng[],
  finalWalkTarget?: LatLng,
): AccessibleRoute[] {
  return routes.flatMap((route, routeIndex) => {
    const legs = route.legs as DriveLeg[];
    if (!legs.length || legs.length !== waypoints.length + 1) {
      console.warn("[valhalla-routing] invalid vehicle leg/waypoint count", {
        routeIndex,
      });
      return [];
    }
    const requests: WalkAccessRequest[] = [];
    const gap = (a: LatLng, b: LatLng) =>
      haversineMeters(a.lat, a.lng, b.lat, b.lng);
    const add = (
      beforeLegIndex: number,
      fromAnchor: LatLng,
      toAnchor: LatLng,
      from: string,
      to: string,
      role: WalkAccessRequest["role"],
      waypointIndex?: number,
    ) => {
      requests.push({
        beforeLegIndex,
        fromAnchor,
        toAnchor,
        from,
        to,
        role,
        ...(waypointIndex !== undefined ? { waypointIndex } : {}),
      });
    };
    if (gap(origin, legs[0].from) > WALK_ACCESS_MIN_GAP_M)
      add(0, origin, legs[0].from, "起點", "上車處", "origin");
    waypoints.forEach((point, index) => {
      if (
        Math.max(
          gap(legs[index].to, point),
          gap(point, legs[index + 1].from),
        ) <= WALK_ACCESS_MIN_GAP_M
      )
        return;
      const label = `中途點 ${index + 1}`;
      add(
        index + 1,
        legs[index].to,
        point,
        `${label} 停車處`,
        label,
        "waypoint",
        index + 1,
      );
      add(
        index + 1,
        point,
        legs[index + 1].from,
        label,
        `${label} 停車處`,
        "waypoint",
        index + 1,
      );
    });
    const target = finalWalkTarget ?? destination;
    if (
      gap(legs.at(-1)!.to, target) >
      (finalWalkTarget ? 0.25 : WALK_ACCESS_MIN_GAP_M)
    )
      add(
        legs.length,
        legs.at(-1)!.to,
        target,
        "下車處",
        "終點",
        "destination",
      );
    return [
      {
        ...route,
        ...(requests.length ? { _walkAccessRequests: requests } : {}),
      },
    ];
  });
}

export async function planValhallaRoute(
  origin: LatLng,
  destination: LatLng,
  opts: PlanRoadRouteOptions,
): Promise<AccessibleRoute[]> {
  const callValhalla = (excludeLocations?: LatLng[]) => {
    const params: Parameters<typeof computeValhallaRoutes>[0] = {
      origin,
      destination,
      waypoints: opts.waypoints,
      costing: COSTING[opts.travelMode],
      computeAlternatives: true,
      wheelchair:
        opts.travelMode === "walk" &&
        (opts.avoidStairs ?? opts.mode === "wheelchair"),
      dateTime: { type: 0 },
    };
    if (excludeLocations?.length) {
      params.excludeLocations = excludeLocations;
    }
    return computeValhallaRoutes(params);
  };

  const requested = opts.excludeLocations?.length
    ? opts.excludeLocations
    : undefined;
  let result = await callValhalla(requested);
  // exclude_locations is a hard exclusion, so a closure sitting on the only
  // viable road makes Valhalla answer 442. Routing through it with a warning
  // beats handing back no route at all.
  let bypassFailed = false;
  if (result.status === "NO_ROUTE" && requested) {
    result = await callValhalla();
    bypassFailed = true;
  }
  if (result.status === "NO_ROUTE") return [];
  if (result.status === "UPSTREAM_ERROR") {
    throw new ValhallaRoutingError(
      "Valhalla routing upstream error",
      result.httpStatus,
    );
  }
  const routes = result.trips.flatMap((trip, index) => {
    try {
      return [mapTrip(trip, opts.travelMode, index)];
    } catch {
      console.warn("[valhalla-routing] malformed vehicle trip", { index });
      return [];
    }
  });
  if (bypassFailed) {
    for (const route of routes) {
      route.accessibilityHighlights.push(TRAFFIC_MSG.CLOSURE_BYPASS_FAILED);
      route._accessibilityHighlightMessages = [
        ...(route._accessibilityHighlightMessages ?? []),
        routeMessage(
          "ROUTE_CLOSURE_BYPASS_FAILED",
          TRAFFIC_MSG.CLOSURE_BYPASS_FAILED,
        ),
      ];
    }
  }
  if (opts.travelMode === "walk" || routes.length === 0) return routes;
  return attachWalkAccessLegs(
    routes,
    origin,
    destination,
    opts.waypoints ?? [],
    opts.finalWalkTarget,
  );
}
