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
} from "../../../types/route";
import type {
  LatLng,
  PlanRoadRouteOptions,
  RoadTravelMode,
} from "../accessible-route.types";
import { haversineCoords, haversineMeters } from "../../../utils/geo";
import { normalizeRelativeDirection } from "../../../utils/nav-instructions-engine";
import { ValhallaRoutingError } from "./valhalla-routing.types";
import { planOtpWalkDetailed } from "./otp-routing";
import { unknownWalkA11yDetails } from "./walk-a11y";

export { ValhallaRoutingError } from "./valhalla-routing.types";

const COSTING: Record<RoadTravelMode, ValhallaCosting> = {
  drive: "auto",
  motorcycle: "motorcycle",
  walk: "pedestrian",
};

/** Real point is treated as roadside (no walk connector) within this straight-line gap. */
const WALK_ACCESS_MIN_GAP_M = 30;
/** Max tolerated distance between a pedestrian polyline endpoint and its anchor. */
const CONNECT_TOLERANCE_M = 25;
/** Decimal places used to build the connector cache key. */
const SNAP_KEY_PRECISION = 6;
/** Max pedestrian connector queries in flight per public request. */
const MAX_CONNECTOR_CONCURRENCY = 4;

/** A walk-connector body: a WALK leg without its display from/to labels. */
type WalkConnector = Omit<WalkLeg, "from" | "to">;
type WalkConnectorResult = { body: WalkConnector | null; degraded: boolean };

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

/**
 * Plan a real pedestrian path between two anchors and return it as a WALK-leg
 * body (without display labels). Returns null — never throws — when no
 * trustworthy walkable geometry exists, so a failed connector never fails the
 * host driving route. The pedestrian graph re-snaps each anchor, so both
 * polyline endpoints are gated against their anchor; out-of-tolerance means the
 * anchors are separated by an impassable feature and the connector is dropped.
 * The genuine Valhalla geometry is used verbatim — endpoints are never rewritten.
 *
 * @param fromAnchor Where the walk should start.
 * @param toAnchor Where the walk should end.
 * @returns The connector body, or null when no trustworthy path is found.
 */
async function planWalkConnector(
  fromAnchor: LatLng,
  toAnchor: LatLng,
  mode: PlanRoadRouteOptions["mode"],
  avoidStairs: boolean,
): Promise<WalkConnectorResult> {
  try {
    const otp = await planOtpWalkDetailed(fromAnchor, toAnchor, {
      mode,
      avoidStairs,
    });
    const leg = otp.routes[0]?.legs.find(
      (candidate) => candidate.type === "WALK",
    );
    if (leg?.type === "WALK" && leg.polyline.length >= 2) {
      const pStart = leg.polyline[0];
      const pEnd = leg.polyline.at(-1)!;
      if (
        haversineCoords(pStart, [fromAnchor.lng, fromAnchor.lat]) <=
          CONNECT_TOLERANCE_M &&
        haversineCoords(pEnd, [toAnchor.lng, toAnchor.lat]) <=
          CONNECT_TOLERANCE_M
      ) {
        const { from: _from, to: _to, ...body } = leg;
        return { body, degraded: false };
      }
    }
  } catch (error) {
    console.warn("[valhalla-routing] OTP walk connector failed", error);
  }
  console.warn(
    "[valhalla-routing] OTP walk connector unavailable; falling back to Valhalla",
    JSON.stringify({ fromAnchor, toAnchor }),
  );
  try {
    const result = await computeValhallaRoutes({
      origin: fromAnchor,
      destination: toAnchor,
      costing: "pedestrian",
      wheelchair: avoidStairs,
    });
    if (result.status !== "OK") return { body: null, degraded: true };
    const leg = result.trips[0]?.legs[0];
    if (!leg) return { body: null, degraded: true };
    let points: [number, number][];
    try {
      points = decodeValhallaShape(leg.shapePolyline6);
    } catch {
      return { body: null, degraded: true };
    }
    const pStart = points[0];
    const pEnd = points.at(-1)!;
    if (
      haversineCoords(pStart, [fromAnchor.lng, fromAnchor.lat]) >
      CONNECT_TOLERANCE_M
    ) {
      return { body: null, degraded: true };
    }
    if (
      haversineCoords(pEnd, [toAnchor.lng, toAnchor.lat]) > CONNECT_TOLERANCE_M
    ) {
      return { body: null, degraded: true };
    }
    const steps = walkSteps(leg, points);
    return {
      degraded: true,
      body: {
        type: "WALK",
        distanceM: Math.round(leg.summary.lengthKm * 1000),
        minutesEst: minutes(leg.summary.timeSec),
        polyline: points,
        a11yFacilities: [],
        ...unknownWalkA11yDetails(),
        ...(steps ? { steps } : {}),
      },
    };
  } catch (error) {
    console.warn(
      "[valhalla-routing] Valhalla walk connector fallback failed",
      error,
    );
    return { body: null, degraded: true };
  }
}

/** Concurrency limiter: at most `limit` tasks run at once, the rest queue. */
function createLimiter(limit: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  const release = () => {
    active--;
    queue.shift()?.();
  };
  return function run<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        active++;
        task().then(resolve, reject).finally(release);
      };
      if (active < limit) start();
      else queue.push(start);
    });
  };
}

/** Clone a connector body into a full WALK leg with position-specific labels. */
function toWalkLeg(body: WalkConnector, from: string, to: string): WalkLeg {
  return {
    ...body,
    from,
    to,
    polyline: [...body.polyline],
    a11yFacilities: [],
  };
}

/**
 * Append leading/trailing/waypoint walk-access legs to road routes so a user
 * standing off the drivable network sees a real walk to/from the road instead
 * of being silently snapped onto it. Only affects drive/motorcycle. Each route
 * uses its own snapped endpoints; each affected waypoint gets an atomic
 * arrive+depart walk pair (both succeed or neither is added).
 */
async function attachWalkAccessLegs(
  routes: AccessibleRoute[],
  origin: LatLng,
  destination: LatLng,
  waypoints: LatLng[],
  finalWalkTarget?: LatLng,
  mode?: PlanRoadRouteOptions["mode"],
  avoidStairs = false,
): Promise<AccessibleRoute[]> {
  // When the drive was routed to a proxy arrival point (e.g. a disabled parking
  // bay), the tail walk must reach the user's true destination, not the proxy.
  const tailTarget = finalWalkTarget ?? destination;
  const limiter = createLimiter(MAX_CONNECTOR_CONCURRENCY);
  const cache = new Map<string, Promise<WalkConnectorResult>>();
  const round = (n: number) => n.toFixed(SNAP_KEY_PRECISION);
  const connector = (from: LatLng, to: LatLng) => {
    const key = `${round(from.lng)},${round(from.lat)}|${round(to.lng)},${round(to.lat)}`;
    let pending = cache.get(key);
    if (!pending) {
      pending = limiter(() => planWalkConnector(from, to, mode, avoidStairs));
      cache.set(key, pending);
    }
    return pending;
  };

  return Promise.all(
    routes.map(async (route) => {
      const driveLegs = route.legs as DriveLeg[];
      const originSnap = driveLegs[0].from;
      const destSnap = driveLegs.at(-1)!.to;
      const gapHead = haversineMeters(
        origin.lat,
        origin.lng,
        originSnap.lat,
        originSnap.lng,
      );
      const gapTail = haversineMeters(
        destSnap.lat,
        destSnap.lng,
        tailTarget.lat,
        tailTarget.lng,
      );
      const headPending =
        gapHead > WALK_ACCESS_MIN_GAP_M ? connector(origin, originSnap) : null;
      const tailPending =
        gapTail > WALK_ACCESS_MIN_GAP_M
          ? connector(destSnap, tailTarget)
          : null;

      const wpMatches = driveLegs.length - 1 === waypoints.length;
      if (waypoints.length && !wpMatches) {
        console.warn(
          `[valhalla-routing] leg/waypoint count mismatch (${driveLegs.length - 1} vs ${waypoints.length}); skipping waypoint walk legs`,
        );
      }
      const wpSlots = wpMatches
        ? waypoints.flatMap((trueWp, j) => {
            const arrivalSnap = driveLegs[j].to;
            const departureSnap = driveLegs[j + 1].from;
            const gapArrival = haversineMeters(
              trueWp.lat,
              trueWp.lng,
              arrivalSnap.lat,
              arrivalSnap.lng,
            );
            const gapDeparture = haversineMeters(
              trueWp.lat,
              trueWp.lng,
              departureSnap.lat,
              departureSnap.lng,
            );
            const gap = Math.max(gapArrival, gapDeparture);
            if (gap <= WALK_ACCESS_MIN_GAP_M) return [];
            return [
              {
                index: j,
                gap,
                inPending: connector(arrivalSnap, trueWp),
                outPending: connector(trueWp, departureSnap),
              },
            ];
          })
        : [];

      const headResult = headPending ? await headPending : null;
      const tailResult = tailPending ? await tailPending : null;
      const head = headResult?.body ?? null;
      const tail = tailResult?.body ?? null;
      const wpResolved = await Promise.all(
        wpSlots.map(async (slot) => ({
          index: slot.index,
          gap: slot.gap,
          in: (await slot.inPending).body,
          out: (await slot.outPending).body,
          degraded:
            (await slot.inPending).degraded || (await slot.outPending).degraded,
        })),
      );
      const wpByIndex = new Map(wpResolved.map((slot) => [slot.index, slot]));

      const highlights = [...route.accessibilityHighlights];
      let walkMinutes = 0;
      let walkDistanceM = 0;
      const legs: AccessibleRoute["legs"] = [];

      if (headPending) {
        if (head) {
          legs.push(toWalkLeg(head, "起點", "上車處"));
          walkMinutes += head.minutesEst;
          walkDistanceM += head.distanceM;
          highlights.push(`起點需步行約 ${head.distanceM} 公尺至可上車路段`);
        } else {
          highlights.push(
            `起點距可行車路段約 ${Math.round(gapHead)} 公尺，但無法建立可信步行路徑，請留意`,
          );
        }
      }

      driveLegs.forEach((leg, i) => {
        legs.push(leg);
        if (i >= driveLegs.length - 1) return;
        const slot = wpByIndex.get(i);
        if (!slot) return;
        const label = `中途點 ${i + 1}`;
        if (slot.in && slot.out) {
          legs.push(toWalkLeg(slot.in, `${label} 停車處`, label));
          legs.push(toWalkLeg(slot.out, label, `${label} 停車處`));
          walkMinutes += slot.in.minutesEst + slot.out.minutesEst;
          walkDistanceM += slot.in.distanceM + slot.out.distanceM;
          highlights.push(
            `${label} 需步行約 ${slot.in.distanceM + slot.out.distanceM} 公尺往返停車處`,
          );
        } else {
          highlights.push(
            `${label} 距可行車路段約 ${Math.round(slot.gap)} 公尺，但無法建立可信步行路徑，請留意`,
          );
        }
      });

      if (tailPending) {
        if (tail) {
          legs.push(toWalkLeg(tail, "下車處", "終點"));
          walkMinutes += tail.minutesEst;
          walkDistanceM += tail.distanceM;
          highlights.push(
            `於終點前約 ${tail.distanceM} 公尺處停車，需步行至目的地`,
          );
        } else {
          highlights.push(
            `目的地距可行車路段約 ${Math.round(gapTail)} 公尺，但無法建立可信步行路徑，請留意`,
          );
        }
      }

      return {
        ...route,
        legs,
        totalMinutes: route.totalMinutes + walkMinutes,
        totalWalkDistanceM: walkDistanceM,
        accessibilityHighlights: highlights,
      };
    }),
  );
}

export async function planValhallaRoute(
  origin: LatLng,
  destination: LatLng,
  opts: PlanRoadRouteOptions,
): Promise<AccessibleRoute[]> {
  const callValhalla = (excludeLocations?: LatLng[]) =>
    computeValhallaRoutes({
      origin,
      destination,
      waypoints: opts.waypoints,
      costing: COSTING[opts.travelMode],
      computeAlternatives: true,
      wheelchair:
        opts.travelMode === "walk" &&
        (opts.avoidStairs ?? opts.mode === "wheelchair"),
      ...(excludeLocations?.length ? { excludeLocations } : {}),
    });

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
  let routes: AccessibleRoute[];
  try {
    routes = result.trips.map((trip, index) =>
      mapTrip(trip, opts.travelMode, index),
    );
  } catch (error) {
    if (error instanceof ValhallaRoutingError) throw error;
    throw new ValhallaRoutingError("Malformed Valhalla response");
  }
  if (bypassFailed) {
    for (const route of routes)
      route.accessibilityHighlights.push(TRAFFIC_MSG.CLOSURE_BYPASS_FAILED);
  }
  if (opts.travelMode === "walk" || routes.length === 0) return routes;
  return attachWalkAccessLegs(
    routes,
    origin,
    destination,
    opts.waypoints ?? [],
    opts.finalWalkTarget,
    opts.mode,
    opts.avoidStairs ?? opts.mode === "wheelchair",
  );
}
