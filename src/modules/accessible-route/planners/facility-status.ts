/**
 * Realtime metro facility status overlay.
 *
 * After route planning has produced the final top-3, this service overlays
 * TDX data onto METRO legs:
 *
 *  • Metro Alert（營運通阻）— the actual REALTIME signal. Service alerts
 *    mentioning elevators/escalators at the leg's stations (or system-wide)
 *    become ⚠️ warnings on the leg and the route.
 *  • 臺北捷運無障礙設施異常公告 (data.taipei) — station-level elevator anomaly
 *    notices for TRTC. Only a station whose latest notice is still an active
 *    outage is flagged; a later 「已完成／開放使用」 notice clears it.
 *  • StationFacility — facility inventory per station. Verified against live
 *    TDX data (2026-06): the schema is keyed by StationID with Elevators[] /
 *    Toilets[] arrays, and for TRTC every array is EMPTY — so absence of data
 *    must never be treated as absence of an elevator. Only POSITIVE signals
 *    are acted on: a non-empty Elevators list adds a facility highlight, and
 *    an elevator whose description flags 維修/故障/暫停 adds a ⚠️ warning.
 *
 * Entirely fail-soft: TDX responses are cached (alerts 5 min, facility list
 * 6 h, one call per rail system), and every error is swallowed — a TDX outage
 * never degrades routing.
 */

import { fetchTaipeiMetroNotices } from "../../../adapters/taipei-metro-notice.adapter";
import { tdxFetch } from "../../../config/fetch";
import { metroUrl } from "../../../config/transit";
import {
  activeElevatorNotices,
  type ActiveMetroNotice,
} from "../../../utils/metro-notice";
import { normalizeStationName } from "../../../utils/station-name";
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
const NOTICE_RAIL_SYSTEM = "TRTC";

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
  } catch (error) {
    console.warn("[facility-status] facility fetch failed", railSystem, error);
  }
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
  } catch (error) {
    console.warn("[facility-status] alert fetch failed", railSystem, error);
  }
  alertCache.set(railSystem, {
    data: alerts,
    expiresAt: Date.now() + ALERT_CACHE_TTL_MS,
  });
  return alerts;
}

async function fetchActiveNotices(
  railSystems: readonly string[],
): Promise<Map<string, ActiveMetroNotice>> {
  if (!railSystems.includes(NOTICE_RAIL_SYSTEM)) return new Map();
  return activeElevatorNotices(await fetchTaipeiMetroNotices());
}

function noticeFor(
  notices: Map<string, ActiveMetroNotice>,
  railSystem: string,
  stationName: string,
): ActiveMetroNotice | undefined {
  if (railSystem !== NOTICE_RAIL_SYSTEM) return undefined;
  return notices.get(normalizeStationName(stationName));
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
 * Elevator anomaly notice for one station of a metro leg.
 *
 * @param leg The metro leg to annotate.
 * @param route The route the leg belongs to.
 * @param notice The active notice for the station, if any.
 * @param prefix Whether this is the boarding or alighting station.
 * @param stationName The station name for warning messages.
 * @returns Whether a notice was applied.
 */
function applyNotice(
  leg: MetroLeg,
  route: AccessibleRoute,
  notice: ActiveMetroNotice | undefined,
  prefix: "乘車站" | "下車站",
  stationName: string,
): boolean {
  if (!notice) return false;
  const warning =
    `⚠️ ${prefix}「${stationName}」電梯${notice.keyword}中：${notice.description}`.slice(
      0,
      120,
    );
  pushUnique(leg.facilityHighlights, warning);
  pushUnique(route.accessibilityHighlights, warning);
  return true;
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
 * most two TDX calls per rail system involved (both cached), plus one cached
 * Taipei Metro notice download when a TRTC leg is present.
 *
 * @param routes The final candidate routes to annotate in place.
 * @param _mode The accessibility mode (unused).
 * @returns The routes that board or alight at a station with an active
 *   elevator anomaly notice.
 */
export async function overlayFacilityStatus(
  routes: AccessibleRoute[],
  _mode: AccessibilityMode = "normal",
): Promise<Set<AccessibleRoute>> {
  const affected = new Set<AccessibleRoute>();
  const metroLegs: { route: AccessibleRoute; leg: MetroLeg }[] = [];
  for (const route of routes) {
    for (const leg of route.legs) {
      if (leg.type === "METRO") metroLegs.push({ route, leg });
    }
  }
  if (!metroLegs.length) return affected;

  const systems = [...new Set(metroLegs.map(({ leg }) => leg.railSystem))];
  const bySystem = new Map<
    string,
    {
      facilities: Map<string, TdxStationFacilityItem>;
      alerts: TdxMetroAlertItem[];
    }
  >();
  const [notices] = await Promise.all([
    fetchActiveNotices(systems),
    ...systems.map(async (sys) => {
      const [facilities, alerts] = await Promise.all([
        fetchFacilityIndex(sys),
        fetchMetroAlerts(sys),
      ]);
      return bySystem.set(sys, { facilities, alerts });
    }),
  ]);

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
    const departureHit = applyNotice(
      leg,
      route,
      noticeFor(notices, leg.railSystem, leg.departureStation),
      "乘車站",
      leg.departureStation,
    );
    const arrivalHit = applyNotice(
      leg,
      route,
      noticeFor(notices, leg.railSystem, leg.arrivalStation),
      "下車站",
      leg.arrivalStation,
    );
    if (departureHit || arrivalHit) affected.add(route);
  }
  return affected;
}

/** One elevator outage fact for a station still ahead on the corridor. */
export interface MetroElevatorOutage {
  railSystem: string;
  stationId: string;
  stationName: string;
  /** Stable dedup sub-key: the elevator title, or "station" when absent. */
  elevatorKey: string;
  /** The OUTAGE_RE keyword that matched, e.g. 「維修」. */
  keyword: string;
  /** Original description, truncated to 120 characters. */
  description: string;
}

/** A station to probe, as seen from the remaining corridor. */
export interface MetroStationProbe {
  railSystem: string;
  stationUid: string;
  stationName: string;
}

/** TDX alerts carry an id in the wild even though the overlay never reads it. */
type IdentifiedMetroAlert = TdxMetroAlertItem & { AlertID?: string };

function alertTouchesStation(
  alert: TdxMetroAlertItem,
  stationId: string,
  stationName: string,
): boolean {
  const stations = alert.Scope?.Stations ?? [];
  if (!stations.length) return true;
  return stations.some((s) => {
    const name = s.StationName?.Zh_tw ?? "";
    const byName =
      name &&
      stationName &&
      (stationName.includes(name) || name.includes(stationName));
    const byId = s.StationID && s.StationID === stationId;
    return Boolean(byName || byId);
  });
}

/**
 * Reports elevator 維修/故障/暫停/停用 for the metro stations still ahead on the
 * corridor, from TDX and the Taipei Metro anomaly notices. Shares the overlay's
 * caches, so it adds no upstream call volume.
 * Entirely fail-soft: any error yields an empty array.
 *
 * @param stations The stations to probe, from the remaining corridor.
 * @returns One outage per station/elevator that carries a positive signal.
 */
export async function probeMetroElevatorOutages(
  stations: readonly MetroStationProbe[],
): Promise<MetroElevatorOutage[]> {
  if (!stations.length) return [];

  try {
    const systems = [...new Set(stations.map((s) => s.railSystem))];
    const bySystem = new Map<
      string,
      {
        facilities: Map<string, TdxStationFacilityItem>;
        alerts: TdxMetroAlertItem[];
      }
    >();
    const [notices] = await Promise.all([
      fetchActiveNotices(systems),
      ...systems.map(async (sys) => {
        const [facilities, alerts] = await Promise.all([
          fetchFacilityIndex(sys),
          fetchMetroAlerts(sys),
        ]);
        return bySystem.set(sys, { facilities, alerts });
      }),
    ]);

    const outages: MetroElevatorOutage[] = [];
    const seen = new Set<string>();
    const push = (outage: MetroElevatorOutage): void => {
      const key = `${outage.railSystem}|${outage.stationId}|${outage.elevatorKey}`;
      if (seen.has(key)) return;
      seen.add(key);
      outages.push(outage);
    };

    for (const station of stations) {
      const data = bySystem.get(station.railSystem);
      if (!data) continue;
      const stationId = toStationId(station.stationUid);
      if (!stationId) continue;

      const item = data.facilities.get(stationId);
      for (const e of item?.Elevators ?? []) {
        const description = `${e.Title?.Zh_tw ?? ""}${e.Description ?? ""}`;
        const flagged = description.match(OUTAGE_RE);
        if (!flagged) continue;
        push({
          railSystem: station.railSystem,
          stationId,
          stationName: station.stationName,
          elevatorKey: e.Title?.Zh_tw || "station",
          keyword: flagged[0],
          description: description.slice(0, 120),
        });
      }

      for (const alert of data.alerts as IdentifiedMetroAlert[]) {
        const text = `${alert.Title ?? ""} ${alert.Description ?? ""}`;
        if (!/電梯|電扶梯/.test(text)) continue;
        if (!alertTouchesStation(alert, stationId, station.stationName))
          continue;
        push({
          railSystem: station.railSystem,
          stationId,
          stationName: station.stationName,
          elevatorKey: `alert:${alert.AlertID ?? alert.Title ?? ""}`,
          keyword: text.match(OUTAGE_RE)?.[0] ?? "異常",
          description: text.trim().slice(0, 120),
        });
      }

      const notice = noticeFor(
        notices,
        station.railSystem,
        station.stationName,
      );
      if (notice) {
        push({
          railSystem: station.railSystem,
          stationId,
          stationName: station.stationName,
          elevatorKey: `notice:${notice.postedAt.toISOString()}`,
          keyword: notice.keyword,
          description: notice.description,
        });
      }
    }
    return outages;
  } catch (err) {
    console.warn("[facility-status] elevator outage probe failed", err);
    return [];
  }
}
