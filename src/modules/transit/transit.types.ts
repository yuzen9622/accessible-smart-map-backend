/**
 * transit module type declarations — the result envelopes the transit service
 * returns for bus ETA / position queries.
 */

import type { TaiwanCityEn } from "../../types/transit";

export type Lang = "Zh_tw" | "En";

export type BusEtaResult =
  | {
      ok: true;
      routeId: string;
      direction: number;
      city: TaiwanCityEn | "InterCity";
      etaData: any;
    }
  | { ok: false; error: string; status: 400 | 500 };

export type BusPositionResult =
  | { ok: true; positionData: any }
  | { ok: false; error: string; status: 400 | 500 };

/** Failure envelope shared by the V3 bus query service (bus.service.ts). */
export type BusServiceError = {
  ok: false;
  error: string;
  status: 400 | 404 | 500;
};

export type BusRouteDirection = {
  subRouteUid: string;
  subRouteName: string;
  direction: number;
  directionLabel: string;
  from: string;
  to: string;
  stopCount: number;
  stops: { seq: number; name: string; lat?: number; lng?: number }[];
};

export type BusRouteInfoResult =
  | {
      ok: true;
      routeName: string;
      city: TaiwanCityEn | "InterCity";
      source: "db" | "tdx";
      operators: string[];
      directions: BusRouteDirection[];
    }
  | BusServiceError;

export type BusRouteDetailStop = {
  seq: number;
  name: string;
  lat?: number;
  lng?: number;
  estimateMinutes: number | null;
  statusLabel: string;
};

export type BusRouteDetailDirection = {
  subRouteUid: string;
  subRouteName: string;
  direction: number;
  directionLabel: string;
  from: string;
  to: string;
  stopCount: number;
  stops: BusRouteDetailStop[];
};

export type BusRouteDetailResult =
  | {
      ok: true;
      routeName: string;
      city: TaiwanCityEn | "InterCity";
      operators: string[];
      schedules?: BusScheduleByDirection[];
      directions: BusRouteDetailDirection[];
    }
  | BusServiceError;

export type BusArrival = {
  subRouteUid: string;
  subRouteName: string;
  stopName: string;
  direction: number;
  directionLabel: string;
  estimateMinutes: number | null;
  statusLabel: string;
  plateNumb?: string;
};

export type BusArrivalResult =
  | {
      ok: true;
      routeName: string;
      city: TaiwanCityEn | "InterCity";
      stopName: string;
      arrivals: BusArrival[];
    }
  | BusServiceError;

/**
 * One discrete published departure. `originDepartureTime` is named for the stop
 * it actually belongs to because TDX city-bus schedules publish ONLY the origin
 * terminal's time — never the time at an arbitrary stop along the route. The
 * previous shape put that value in a generic `stopTimes[].arrivalTime`, which
 * reads like a full timetable and invites callers (and the LLM) to present the
 * origin's time as the queried stop's departure time.
 */
export type BusScheduledTrip = {
  scheduleType: "trip";
  serviceDays: string;
  originStopName: string;
  originDepartureTime: string;
  /** Per-stop times, present only when the operator actually published more
   * than the origin stop. Absent for every feed that publishes origin-only. */
  stopTimes?: { seq: number; stopName: string; arrivalTime: string }[];
};

/** A headway-based service window: no discrete departures exist to enumerate. */
export type BusHeadwayWindow = {
  scheduleType: "headway";
  serviceDays: string;
  start?: string;
  end?: string;
  minHeadwayMins?: number;
  maxHeadwayMins?: number;
};

export type BusFrequency = BusScheduledTrip | BusHeadwayWindow;

export type BusScheduleByDirection = {
  /** Present when TDX identifies which branch published this schedule. */
  subRouteUid?: string;
  subRouteName?: string;
  direction: number;
  directionLabel: string;
  first?: string;
  last?: string;
  frequencies: BusFrequency[];
};

export type BusTimetableResult =
  | {
      ok: true;
      routeName: string;
      city: TaiwanCityEn | "InterCity";
      schedules: BusScheduleByDirection[];
      /** States the upstream data's limit so callers never mistake an origin
       * departure time for the queried stop's time. */
      note: string;
      /** True when `limit` dropped some departures. */
      truncated?: boolean;
    }
  | BusServiceError;

export type BusOnRoad = {
  subRouteUid: string;
  subRouteName: string;
  plateNumb: string;
  direction: number;
  directionLabel: string;
  lat?: number;
  lng?: number;
  speed?: number;
  statusLabel: string;
  gpsTime?: string;
  isLowFloor: "是" | "否" | "未知";
  hasLiftOrRamp: "是" | "否" | "未知";
  vehicleClass?: string;
};

export type BusRealtimeOnRouteResult =
  | {
      ok: true;
      routeName: string;
      city: TaiwanCityEn | "InterCity";
      count: number;
      lowFloorCount: number;
      buses: BusOnRoad[];
    }
  | BusServiceError;

export type BusSearchResult = {
  routeName: string;
  city: string;
  departure: string;
  destination: string;
  distance?: number;
};

export type BusSearchRouteResult =
  | {
      ok: true;
      routes: BusSearchResult[];
    }
  | BusServiceError;

export type BusNearbyStop = {
  stopUid: string;
  stopName: string;
  city: string;
  coordinates: [number, number];
  distance: number;
  routes: string[];
};

export type BusNearbyStopsResult =
  | {
      ok: true;
      stops: BusNearbyStop[];
    }
  | BusServiceError;

export type BusStopSearchResult = {
  stopUid: string;
  stopName: string;
  city: string;
  coordinates: [number, number];
  routes: string[];
  distance?: number;
};

export type BusStopSearchRouteResult =
  | {
      ok: true;
      stops: BusStopSearchResult[];
    }
  | BusServiceError;
