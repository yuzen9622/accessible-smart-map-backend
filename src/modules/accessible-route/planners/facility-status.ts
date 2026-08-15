/**
 * Realtime metro facility status overlay.
 *
 * After route planning has produced the final top-3, this service overlays
 * TDX data onto METRO legs:
 *
 *  • Metro Alert（營運通阻）— the actual REALTIME signal. Service alerts
 *    mentioning elevators/escalators at the leg's stations (or system-wide)
 *    become ⚠️ warnings on the leg and the route.
 *  • StationFacility — facility inventory per station. Verified against live
 *    TDX data (2026-06): the schema is keyed by StationID with Elevators[] /
 *    Toilets[] arrays, and for TRTC every array is EMPTY — so absence of data
 *    must never be treated as absence of an elevator. Only POSITIVE signals
 *    are acted on: a non-empty Elevators list adds a facility highlight, and
 *    an elevator whose description flags 維修/故障/暫停 adds a ⚠️ warning.
 *
 * Entirely fail-soft: TDX responses are cached (alerts 5 min, facility list
 * 6 h, one call per rail system), and every error is swallowed — a TDX outage
 * never degrades routing. Disable with USE_REALTIME_FACILITY=false.
 */

import { tdxFetch } from "../../../config/fetch";
import { metroUrl } from "../../../config/transit";
import type {
  AccessibilityMode,
  AccessibleRoute,
  MetroLeg,
} from "../../../types/route";
import type {
  TdxStationFacilityItem,
  TdxMetroAlertEnvelope,
  TdxMetroAlertItem,
  CacheEntry,
} from "./facility-status.types";

const OUTAGE_RE = /維修|故障|暫停|停用/;
const ALERT_CACHE_TTL_MS = 5 * 60 * 1000;
const FACILITY_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

const facilityCache = new Map<
  string,
  CacheEntry<Map<string, TdxStationFacilityItem>>
>();
const alertCache = new Map<string, CacheEntry<TdxMetroAlertItem[]>>();

function cached<T>(
  cache: Map<string, CacheEntry<T>>,
  key: string,
): T | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return undefined;
  }
  return entry.data;
}

async function fetchFacilityIndex(
  railSystem: string,
): Promise<Map<string, TdxStationFacilityItem>> {
  const hit = cached(facilityCache, railSystem);
  if (hit) return hit;
  let index = new Map<string, TdxStationFacilityItem>();
  try {
    const resp = await tdxFetch(
      `${metroUrl.stationFacilityUrl(railSystem)}?$format=JSON`,
    );
    if (resp.ok) {
      const items = (await resp.json()) as TdxStationFacilityItem[];
      if (Array.isArray(items)) {
        index = new Map(items.map((i) => [i.StationID, i]));
      }
    }
  } catch {}
  facilityCache.set(railSystem, {
    data: index,
    expiresAt: Date.now() + FACILITY_CACHE_TTL_MS,
  });
  return index;
}

async function fetchMetroAlerts(
  railSystem: string,
): Promise<TdxMetroAlertItem[]> {
  const hit = cached(alertCache, railSystem);
  if (hit !== undefined) return hit;
  let alerts: TdxMetroAlertItem[] = [];
  try {
    const resp = await tdxFetch(
      `${metroUrl.alertUrl(railSystem)}?$format=JSON`,
    );
    if (resp.ok) {
      const data = (await resp.json()) as
        TdxMetroAlertEnvelope | TdxMetroAlertItem[];
      alerts = Array.isArray(data) ? data : (data?.Alerts ?? []);
    }
  } catch {}
  alertCache.set(railSystem, {
    data: alerts,
    expiresAt: Date.now() + ALERT_CACHE_TTL_MS,
  });
  return alerts;
}

/**
 * Bare TDX StationID from either UID convention:
 * GTFS-built legs carry "TRTC_O12", legacy TDX legs carry "TRTC-O12" → "O12".
 *
 * @param uid The station UID in either convention.
 * @returns The bare StationID, or null when not parseable.
 */
function toStationId(uid: string): string | null {
  if (!uid) return null;
  const sep = uid.includes("_") ? "_" : uid.includes("-") ? "-" : null;
  if (!sep) return null;
  const id = uid.slice(uid.indexOf(sep) + 1);
  return id || null;
}

function pushUnique(arr: string[], text: string): void {
  if (!arr.includes(text)) arr.push(text);
}

/**
 * Positive-signal facility highlights + outage warnings for one station.
 *
 * @param leg The metro leg to annotate.
 * @param route The route the leg belongs to.
 * @param item The TDX facility record for the station, if any.
 * @param prefix Whether this is the boarding or alighting station.
 * @param stationName The station name for warning messages.
 */
function applyStationFacility(
  leg: MetroLeg,
  route: AccessibleRoute,
  item: TdxStationFacilityItem | undefined,
  prefix: "乘車站" | "下車站",
  stationName: string,
): void {
  if (!item) return;

  if (item.Elevators?.length) {
    pushUnique(leg.facilityHighlights, `${prefix}有電梯`);
    for (const e of item.Elevators) {
      const desc = `${e.Title?.Zh_tw ?? ""}${e.Description ?? ""}`;
      const flagged = desc.match(OUTAGE_RE);
      if (flagged) {
        const warning = `⚠️ ${prefix}「${stationName}」電梯${flagged[0]}中，請改走其他出口`;
        pushUnique(leg.facilityHighlights, warning);
        pushUnique(route.accessibilityHighlights, warning);
      }
    }
  }
  if (item.Toilets?.length) {
    pushUnique(leg.facilityHighlights, `${prefix}有廁所設施`);
  }
}

/**
 * Alert overlay: elevator-related service alerts touching this leg's stations.
 *
 * @param leg The metro leg to annotate.
 * @param route The route the leg belongs to.
 * @param alerts The service alerts to evaluate.
 */
function applyAlerts(
  leg: MetroLeg,
  route: AccessibleRoute,
  alerts: TdxMetroAlertItem[],
): void {
  for (const alert of alerts) {
    const text = `${alert.Title ?? ""} ${alert.Description ?? ""}`;
    if (!/電梯|電扶梯/.test(text)) continue;

    const stations = alert.Scope?.Stations ?? [];
    const touchesLeg =
      !stations.length ||
      stations.some((s) => {
        const name = s.StationName?.Zh_tw ?? "";
        const byName =
          name &&
          (leg.departureStation.includes(name) ||
            leg.arrivalStation.includes(name) ||
            name.includes(leg.departureStation) ||
            name.includes(leg.arrivalStation));
        const byId =
          s.StationID &&
          (toStationId(leg.departureStationUid) === s.StationID ||
            toStationId(leg.arrivalStationUid) === s.StationID);
        return Boolean(byName || byId);
      });
    if (!touchesLeg) continue;

    const warning = `⚠️ ${alert.Title ?? "設施異常"}${
      alert.Description && alert.Description !== alert.Title
        ? `：${alert.Description}`
        : ""
    }`.slice(0, 120);
    pushUnique(leg.facilityHighlights, warning);
    pushUnique(route.accessibilityHighlights, warning);
  }
}

/**
 * Overlay realtime TDX facility/alert status onto the final routes (top-3),
 * in place. METRO legs only — THSR/TRA facility status is out of scope. At
 * most two TDX calls per rail system involved (both cached).
 *
 * @param routes The final candidate routes to annotate in place.
 * @param _mode The accessibility mode (unused).
 */
export async function overlayFacilityStatus(
  routes: AccessibleRoute[],
  _mode: AccessibilityMode = "normal",
): Promise<void> {
  if (process.env.USE_REALTIME_FACILITY === "false") return;

  const metroLegs: { route: AccessibleRoute; leg: MetroLeg }[] = [];
  for (const route of routes) {
    for (const leg of route.legs) {
      if (leg.type === "METRO") metroLegs.push({ route, leg });
    }
  }
  if (!metroLegs.length) return;

  const systems = [...new Set(metroLegs.map(({ leg }) => leg.railSystem))];
  const bySystem = new Map<
    string,
    {
      facilities: Map<string, TdxStationFacilityItem>;
      alerts: TdxMetroAlertItem[];
    }
  >();
  await Promise.all(
    systems.map(async (sys) => {
      const [facilities, alerts] = await Promise.all([
        fetchFacilityIndex(sys),
        fetchMetroAlerts(sys),
      ]);
      bySystem.set(sys, { facilities, alerts });
    }),
  );

  for (const { route, leg } of metroLegs) {
    const data = bySystem.get(leg.railSystem);
    if (!data) continue;
    const depId = toStationId(leg.departureStationUid);
    const arrId = toStationId(leg.arrivalStationUid);
    applyStationFacility(
      leg,
      route,
      depId ? data.facilities.get(depId) : undefined,
      "乘車站",
      leg.departureStation,
    );
    applyStationFacility(
      leg,
      route,
      arrId ? data.facilities.get(arrId) : undefined,
      "下車站",
      leg.arrivalStation,
    );
    applyAlerts(leg, route, data.alerts);
  }
}
