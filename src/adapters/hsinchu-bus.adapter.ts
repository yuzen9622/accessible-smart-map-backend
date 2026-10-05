/**
 * 新竹縣市智慧公車 (ibus.hsinchu.gov.tw). One platform serves 新竹市 (HSZ…) and
 * 新竹縣 (HSQ… / HSP…) routes; each stop row carries the plate of a bus at that
 * stop and its `car_accessibility` flag. Only buses currently in service are
 * visible, so callers accumulate plates across polls.
 */
import type { BusFleetObservation } from "../types";

const HSINCHU_API_BASE = "https://ibus.hsinchu.gov.tw/ibusWeb/ibus_gis";
const HSINCHU_TIMEOUT_MS = 20_000;
const HSINCHU_REQUEST_GAP_MS = 300;
const HSINCHU_ROUTE_CLASSES = ["41", "42", "43", "44", "45", "47", "48"];

interface HsinchuRoute {
  RouteId?: string;
  RouteIds?: string;
}

interface HsinchuStop {
  routeId?: string;
  car_no?: string;
  car_accessibility?: number | string | null;
}

interface HsinchuRouteDetails {
  go?: HsinchuStop[];
  back?: HsinchuStop[];
}

/**
 * Read the low-floor flag from a Hsinchu stop row.
 *
 * @param value The `car_accessibility` value (1 accessible, 0 standard, null unknown).
 * @returns 1, 0, or undefined when the platform does not know.
 */
export function hsinchuLowFloorFlag(
  value: HsinchuStop["car_accessibility"],
): 0 | 1 | undefined {
  if (value === 1 || value === "1") return 1;
  if (value === 0 || value === "0") return 0;
  return undefined;
}

/**
 * The city a Hsinchu route belongs to, from its route-ID prefix.
 *
 * @param routeId A platform route ID such as `HSZ010001_1`.
 * @returns `Hsinchu` for 新竹市 routes, otherwise `HsinchuCounty`.
 */
export function hsinchuCityOf(routeId: string | undefined): string {
  return routeId?.startsWith("HSZ") ? "Hsinchu" : "HsinchuCounty";
}

/**
 * Turn one route's stop rows into per-plate observations.
 *
 * @param details The `getRouteDetails` response.
 * @returns One observation per plate with a known flag.
 */
export function parseHsinchuRouteDetails(
  details: HsinchuRouteDetails,
): BusFleetObservation[] {
  const byPlate = new Map<string, BusFleetObservation>();
  for (const stop of [...(details.go ?? []), ...(details.back ?? [])]) {
    const plate = stop.car_no?.trim().toUpperCase();
    const flag = hsinchuLowFloorFlag(stop.car_accessibility);
    if (!plate || flag === undefined) continue;
    byPlate.set(plate, {
      plateNumb: plate,
      city: hsinchuCityOf(stop.routeId),
      isLowFloor: flag,
      source: "hsinchu-ibus",
    });
  }
  return [...byPlate.values()];
}

/**
 * POST a JSON request to one Hsinchu endpoint.
 *
 * @param path The endpoint name under the GIS API base.
 * @param body The JSON body.
 * @returns The parsed JSON body.
 */
async function postHsinchu<T>(path: string, body: object): Promise<T> {
  const res = await fetch(`${HSINCHU_API_BASE}/${path}/`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(HSINCHU_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Hsinchu ibus ${path} HTTP ${res.status}`);
  return (await res.json()) as T;
}

/**
 * Fetch every bus currently running on a Hsinchu city / county route with its
 * low-floor flag. 公路客運 (class 46) is left to the highway-bus source.
 *
 * @returns Per-plate observations for buses in service right now.
 */
export async function fetchHsinchuFleet(): Promise<BusFleetObservation[]> {
  const routeGroups = new Set<string>();
  for (const cls of HSINCHU_ROUTE_CLASSES) {
    const list = await postHsinchu<{ routes?: HsinchuRoute[] }>(
      "getRoutesByClass",
      { class: cls, text: "" },
    );
    for (const route of list.routes ?? []) {
      const ids = route.RouteIds || route.RouteId;
      if (ids) routeGroups.add(ids);
    }
    await new Promise((r) => setTimeout(r, HSINCHU_REQUEST_GAP_MS));
  }

  const byPlate = new Map<string, BusFleetObservation>();
  for (const routeIds of routeGroups) {
    try {
      const details = await postHsinchu<HsinchuRouteDetails>(
        "getRouteDetails",
        { routeIds },
      );
      for (const obs of parseHsinchuRouteDetails(details)) {
        byPlate.set(obs.plateNumb, obs);
      }
    } catch (err) {
      console.warn(
        `[bus-fleet] Hsinchu route ${routeIds} failed: ${(err as Error).message}`,
      );
    }
    await new Promise((r) => setTimeout(r, HSINCHU_REQUEST_GAP_MS));
  }
  return [...byPlate.values()];
}
