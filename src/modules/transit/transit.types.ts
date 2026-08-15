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
  subRouteUid?: string;
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
  subRouteUid?: string;
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

export type BusFrequency = {
  start?: string;
  end?: string;
  minHeadwayMins?: number;
  maxHeadwayMins?: number;
  serviceDays: string;
  stopTimes?: { seq: number; stopName: string; arrivalTime: string }[];
};

export type BusScheduleByDirection = {
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
    }
  | BusServiceError;

export type BusOnRoad = {
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
};

export type BusStopSearchRouteResult =
  | {
      ok: true;
      stops: BusStopSearchResult[];
    }
  | BusServiceError;
