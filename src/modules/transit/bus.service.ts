/**
 * Bus query service powering the AI agent's bus tools and the /transit/bus/*
 * REST endpoints. Reads imported static data (BusRoute, BusVehicle) and calls
 * TDX only for the genuinely live bits (A1 position, N1 ETA, Schedule). The
 * headline feature: realtime positions are joined against the imported Vehicle
 * table by plate number, so the agent can tell the user whether the
 * approaching bus is low-floor — without ever asking for a plate number.
 *
 * Uses the TDX V2 City endpoints (busUrl): for this TDX account the V3 City
 * endpoints are restricted to a single city, whereas V2 serves all of Taiwan
 * and still exposes Vehicle (IsLowFloor / HasLiftOrRamp). Inter-city (公路客運,
 * 1xxx) routes fall back to the V2 InterCity endpoints.
 */

import {
  busRouteQueryCandidates,
  equalStopName,
  escapeODataLiteral,
  normalizeStopName,
  odataUrlLiteral,
  formatRouteName,
  isBusDirection,
} from "../../utils/transit-text";
import {
  busEtaIsFresh,
  busEtaSeconds,
  rememberBusEtaReceipt,
} from "../../utils/tdx-bus-eta";
import { busUrl } from "../../config/transit";
import { TRANSIT_MSG } from "../../constants/messages";
import { tdxFetch } from "../../config/fetch";
import { resolveCity } from "../geography/city.service";
import {
  formatNextBusTime,
  nextDepartureText,
  resolveStopStatusLabel,
} from "./bus-next-departure";
import {
  type BusRouteDoc,
  findCityStopsNearby,
  findRouteNamesBySubRoute,
  findRoutesByName,
  findRoutesBySubRouteUids,
  findStopsNearby,
  findVehiclesByPlate,
  searchRoutesByKeyword,
  searchStopsByKeyword,
} from "./bus.repository";
import type { BusRouteQueryScope, TaiwanCityEn } from "../../types/transit";
import type { ITdxBusVehicle } from "../../types";
import {
  cityFromAlias,
  yesNoLabel,
  VEHICLE_CLASS_LABEL,
  DIRECTION_LABEL,
  BUS_STATUS_LABEL,
  CITY_COORDINATES,
} from "../../constants/bus";
import { haversineMeters } from "../../utils/geo";
import { redisGet, redisSet } from "../../config/redis";
import { matchBusShape, normalizeBusShapes, type BusShape } from "./bus-shape";

const BUS_SHAPE_CACHE_PREFIX = "bus:shape:v1:";
const BUS_SHAPE_CACHE_TTL_SEC = 24 * 60 * 60;
import type {
  BusRouteInfoResult,
  BusRouteDirection,
  BusArrivalResult,
  BusArrival,
  BusTimetableResult,
  BusFrequency,
  BusScheduleByDirection,
  BusRealtimeOnRouteResult,
  BusOnRoad,
  BusSearchResult,
  BusSearchRouteResult,
  BusStopSearchRouteResult,
  BusStopSearchResult,
  BusNearbyStopsResult,
  BusNearbyStop,
  BusStopArrival,
  BusStopArrivalsData,
  BusStopArrivalsResult,
  BusRouteDetailResult,
  BusRouteDetailDirection,
  BusRouteDetailStop,
} from "./transit.types";

/**
 * Resolve a user-supplied city string (or fall back to reverse-geocoding the
 * user's coordinates) to a TDX city code.
 *
 * @param cityInput Raw city string from the request/tool (optional).
 * @param userLoc User coordinates used as a fallback (optional).
 * @returns The matching TaiwanCityEn, or null when it can't be determined.
 */
export async function resolveBusCity(
  cityInput?: string,
  userLoc?: { latitude: number; longitude: number },
): Promise<TaiwanCityEn | "InterCity" | null> {
  if (cityInput === "InterCity") return "InterCity";
  const direct = cityFromAlias(cityInput);
  if (direct) return direct;
  if (userLoc) {
    return resolveCity(userLoc.latitude, userLoc.longitude);
  }
  return null;
}

function isSoonerEta(
  a: { estimateMinutes: number | null },
  b: { estimateMinutes: number | null },
): boolean {
  if (a.estimateMinutes == null) return false;
  return b.estimateMinutes == null || a.estimateMinutes < b.estimateMinutes;
}

function dirLabel(d: number): string {
  return DIRECTION_LABEL[d] ?? "未知";
}

async function fetchTdxArray(url: string): Promise<any[]> {
  const res = await tdxFetch(url);
  if (!res.ok) throw new Error(`TDX ${res.status}`);
  const json = await res.json();
  if (Array.isArray(json)) rememberBusEtaReceipt(json);
  return Array.isArray(json) ? json : [];
}

/**
 * OData filter selecting rows of the given TDX routes by RouteUID.
 *
 * @param routeUids Route UIDs resolved from the imported route table.
 * @returns A `$filter` expression ready to embed in a TDX URL.
 */
function routeUidFilter(routeUids: string[]): string {
  return routeUids
    .map((u) => `RouteUID eq '${odataUrlLiteral(u)}'`)
    .join(" or ");
}

/**
 * Fetches a route's TDX rows by RouteUID, so renamed routes and names that share
 * a prefix (11 / 11甲) never pull in another route; falls back to name probing
 * only when the UID query fails or no UID is known.
 *
 * @param routeName Route name for the name-based fallback.
 * @param city City scope of the route.
 * @param routeUids Route UIDs from the imported route table.
 * @param byUid Builds the UID-filtered URL for the route's API type.
 * @param byName Builds the name-scoped URL used by fetchRouteScoped.
 * @param accept Optional acceptance predicate for the name-based fallback.
 * @returns The records and the name scope used (null for UID queries).
 */
async function fetchRouteRows(
  routeName: string,
  city: TaiwanCityEn | "InterCity",
  routeUids: string[] | undefined,
  byUid: (filter: string) => string,
  byName: (scope: BusRouteQueryScope) => string,
  accept?: (records: any[]) => boolean,
): Promise<{ records: any[]; scope: BusRouteQueryScope | null }> {
  if (routeUids?.length) {
    try {
      return {
        records: await fetchTdxArray(byUid(routeUidFilter(routeUids))),
        scope: null,
      };
    } catch (err) {
      console.error("TDX RouteUID query failed, falling back to name", err);
    }
  }
  return fetchRouteScoped(routeName, city, byName, accept);
}

const SCOPE_MEMO_TTL_MS = 6 * 60 * 60 * 1000;
const SCOPE_MEMO_MAX_ENTRIES = 2000;
const scopeMemo = new Map<
  string,
  { scope: BusRouteQueryScope; expiresAt: number }
>();

function memorizeScope(key: string, scope: BusRouteQueryScope): void {
  // Bounded LRU-ish: re-inserting moves the key to the end, so the oldest
  // untouched entry is always the first one evicted.
  scopeMemo.delete(key);
  scopeMemo.set(key, { scope, expiresAt: Date.now() + SCOPE_MEMO_TTL_MS });
  while (scopeMemo.size > SCOPE_MEMO_MAX_ENTRIES) {
    const oldest = scopeMemo.keys().next();
    if (oldest.done) break;
    scopeMemo.delete(oldest.value);
  }
}

function rememberedScope(key: string): BusRouteQueryScope | null {
  const hit = scopeMemo.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    scopeMemo.delete(key);
    return null;
  }
  return hit.scope;
}

/**
 * 依序嘗試候選 scope（市區 / 公路 × 路線名變體），第一個回傳可用資料的勝出。
 *
 * TDX 不以路線號碼區分市區公車與公路客運，所以歸屬只能實際打過才知道；命中的
 * scope 會被記住 6 小時，之後同一條路線第一次呼叫就命中，不浪費 TDX 額度。
 *
 * @param routeName 使用者給的路線名
 * @param city 呼叫方指定的城市，或 "InterCity"
 * @param buildUrl 由候選 scope 組出要查詢的 TDX URL
 * @param accept 額外的可用性判斷（例如「這批資料裡有目標站牌」）；未通過就繼續試下一個候選
 * @returns 命中的資料與 scope；全部候選都沒資料時 records 為空陣列、scope 為 null
 */
async function fetchRouteScoped(
  routeName: string,
  city: TaiwanCityEn | "InterCity",
  buildUrl: (scope: BusRouteQueryScope) => string,
  accept?: (records: any[]) => boolean,
): Promise<{ records: any[]; scope: BusRouteQueryScope | null }> {
  const key = `${city}|${routeName}`;
  const candidates = busRouteQueryCandidates(routeName, city);
  const remembered = rememberedScope(key);
  const ordered = remembered
    ? [
        remembered,
        ...candidates.filter(
          (c) => c.type !== remembered.type || c.routeId !== remembered.routeId,
        ),
      ]
    : candidates;

  let lastError: unknown = null;
  let anyResponded = false;
  let unacceptable: { records: any[]; scope: BusRouteQueryScope } | null = null;

  for (const scope of ordered) {
    let records: any[];
    try {
      records = await fetchTdxArray(buildUrl(scope));
    } catch (err) {
      lastError = err;
      continue;
    }
    anyResponded = true;
    if (!records.length) continue;
    if (accept && !accept(records)) {
      unacceptable ??= { records, scope };
      continue;
    }
    memorizeScope(key, scope);
    return { records, scope };
  }

  if (!anyResponded && lastError) throw lastError;
  return unacceptable ?? { records: [], scope: null };
}

/** Build plate → vehicle (low-floor) lookup for a set of plate numbers. */
async function lowFloorMap(
  plates: (string | undefined)[],
): Promise<Map<string, ITdxBusVehicle>> {
  const uniq = [
    ...new Set(plates.filter((p): p is string => !!p && p !== "-1")),
  ];
  if (!uniq.length) return new Map();
  const docs = await findVehiclesByPlate(uniq);
  return new Map(
    docs.map((d): [string, ITdxBusVehicle] => [
      d.plateNumb,
      d as ITdxBusVehicle,
    ]),
  );
}

type NormalizedRoute = {
  routeUid?: string;
  subRouteUid: string;
  subRouteName: string;
  direction: number;
  operators: string[];
  stops: BusRouteDirection["stops"];
};

function buildDirections(records: NormalizedRoute[]): BusRouteDirection[] {
  const bySubRouteAndDir = new Map<string, NormalizedRoute>();
  for (const r of records) {
    const key = `${r.subRouteUid}_${r.direction}`;
    const existing = bySubRouteAndDir.get(key);
    // Duplicate upstream rows for the same sub-route/direction occasionally
    // differ in completeness; keep the longest one without merging branches.
    if (!existing || r.stops.length > existing.stops.length)
      bySubRouteAndDir.set(key, r);
  }
  return [...bySubRouteAndDir.values()]
    .sort(
      (a, b) =>
        a.direction - b.direction || a.subRouteUid.localeCompare(b.subRouteUid),
    )
    .map((r) => {
      const stops = [...r.stops].sort((a, b) => a.seq - b.seq);
      return {
        routeUid: r.routeUid,
        subRouteUid: r.subRouteUid,
        subRouteName: r.subRouteName,
        direction: r.direction,
        directionLabel: dirLabel(r.direction),
        from: stops[0]?.name ?? "",
        to: stops[stops.length - 1]?.name ?? "",
        stopCount: stops.length,
        stops,
      };
    });
}

/**
 * Route geometry from TDX Bus Shape, cached because shapes change rarely and
 * TDX quota is tight. Failures degrade to no shapes so the caller can still
 * answer with stops only.
 *
 * @param routeName The user-supplied route name.
 * @param city The caller's city scope, or "InterCity".
 * @returns The normalized shapes, possibly empty.
 */
async function getBusRouteShapes(
  routeName: string,
  city: TaiwanCityEn | "InterCity",
): Promise<BusShape[]> {
  const cacheKey = `${BUS_SHAPE_CACHE_PREFIX}${city}:${formatRouteName(routeName)}`;
  const cached = await redisGet(cacheKey);
  if (cached) {
    try {
      return JSON.parse(cached) as BusShape[];
    } catch {
      /* fall through to refetch */
    }
  }
  try {
    const { records } = await fetchRouteScoped(
      routeName,
      city,
      ({ type, routeId: id }) =>
        type === "City"
          ? `${busUrl.cityShapeUrl}/${city}/${encodeURIComponent(id)}?$format=JSON`
          : `${busUrl.interCityShapeUrl}/${encodeURIComponent(id)}?$format=JSON`,
    );
    const shapes = normalizeBusShapes(records);
    if (shapes.length)
      await redisSet(cacheKey, JSON.stringify(shapes), BUS_SHAPE_CACHE_TTL_SEC);
    return shapes;
  } catch (e) {
    console.error("Failed to fetch bus shape in getBusRouteDetail", e);
    return [];
  }
}

/**
 * Look up a bus route's stop sequence (both directions). Prefers imported
 * BusRoute data; falls back to a live TDX StopOfRoute query when not imported.
 */
/**
 * ETA URL for a RouteUID filter on the route's API type.
 *
 * @param city City scope ("InterCity" selects the inter-city endpoint).
 * @param filter OData filter expression.
 * @returns The TDX N1 URL.
 */
function etaUidUrl(city: TaiwanCityEn | "InterCity", filter: string): string {
  return city === "InterCity"
    ? `${busUrl.interCityEstimatedTimeOfArrivalUrl}?$format=JSON&$filter=${filter}`
    : `${busUrl.cityEstimatedTimeOfArrivalUrl}/${city}?$format=JSON&$filter=${filter}`;
}

/**
 * RouteUIDs of a route from the imported route table, preferring an exact name match.
 *
 * @param routeName Route name as supplied by the caller.
 * @param city City scope of the route.
 * @returns Distinct RouteUIDs; empty when the route is not imported.
 */
async function resolveRouteUids(
  routeName: string,
  city: TaiwanCityEn | "InterCity",
): Promise<string[]> {
  const names = [
    ...new Set([formatRouteName(routeName), routeName.trim()].filter(Boolean)),
  ];
  let found: Awaited<ReturnType<typeof findRoutesByName>>;
  try {
    found = await findRoutesByName(city, names);
  } catch (err) {
    console.error("Route table lookup failed, falling back to name", err);
    return [];
  }
  const exact = found.filter((d) => d.routeName?.Zh_tw === routeName.trim());
  return [
    ...new Set(
      (exact.length ? exact : found)
        .map((d) => d.routeUid)
        .filter((u): u is string => !!u),
    ),
  ];
}

export async function getBusRouteInfo(params: {
  routeName: string;
  city: TaiwanCityEn | "InterCity";
  subRouteUid?: string;
}): Promise<BusRouteInfoResult> {
  const { city } = params;
  const routeId = formatRouteName(params.routeName);
  const names = [
    ...new Set([routeId, params.routeName.trim()].filter(Boolean)),
  ];

  try {
    const found = await findRoutesByName(city, names);
    const exact = found.filter(
      (d) => d.routeName?.Zh_tw === params.routeName.trim(),
    );
    const docs = exact.length ? exact : found;

    const matchingDocs = params.subRouteUid
      ? docs.filter((d) => d.subRouteUid === params.subRouteUid)
      : docs;

    if (matchingDocs.length) {
      const normalized: NormalizedRoute[] = matchingDocs.map((d) => ({
        routeUid: d.routeUid,
        subRouteUid: d.subRouteUid,
        subRouteName: d.subRouteName?.Zh_tw || d.routeName?.Zh_tw || routeId,
        direction: d.direction,
        operators: (d.operators ?? [])
          .map((o) => o.name)
          .filter(Boolean) as string[],
        stops: (d.stops ?? []).map((s) => ({
          seq: s.seq,
          name: s.stopName?.Zh_tw ?? "",
          stopUid: s.stopUID,
          lat: s.lat,
          lng: s.lng,
        })),
      }));
      return {
        ok: true,
        routeName: matchingDocs[0].routeName?.Zh_tw || routeId,
        city,
        source: "db",
        operators: [...new Set(normalized.flatMap((n) => n.operators))],
        directions: buildDirections(normalized),
      };
    }

    // Live fallback (route not imported, e.g. inter-city or a non-六都 city).
    const { records: live, scope } = await fetchRouteScoped(
      params.routeName,
      city,
      ({ type, routeId: id }) =>
        type === "City"
          ? `${busUrl.stopOfRouteUrl}/${city}?$format=JSON&$filter=RouteName/Zh_tw eq '${odataUrlLiteral(id)}'`
          : `${busUrl.interCityStopOfRouteUrl}?$format=JSON&$filter=RouteName/Zh_tw eq '${odataUrlLiteral(id)}'`,
      params.subRouteUid
        ? (records) =>
            records.some((r: any) => r.SubRouteUID === params.subRouteUid)
        : undefined,
    );
    const matchingLive = params.subRouteUid
      ? live.filter((r: any) => r.SubRouteUID === params.subRouteUid)
      : live;
    if (!matchingLive.length) {
      return {
        ok: false,
        error: `找不到路線「${params.routeName}」的站序資料`,
        status: 404,
      };
    }
    const normalized: NormalizedRoute[] = matchingLive.map((r: any) => ({
      routeUid: r.RouteUID,
      subRouteUid: r.SubRouteUID,
      subRouteName:
        r.SubRouteName?.Zh_tw ?? r.RouteName?.Zh_tw ?? params.routeName,
      direction: r.Direction,
      operators: (r.Operators ?? [])
        .map((o: any) => o.OperatorName?.Zh_tw)
        .filter(Boolean),
      stops: (r.Stops ?? []).map((s: any) => ({
        seq: s.StopSequence,
        name: s.StopName?.Zh_tw ?? "",
        stopUid: s.StopUID,
        lat: s.StopPosition?.PositionLat,
        lng: s.StopPosition?.PositionLon,
      })),
    }));
    return {
      ok: true,
      routeName: scope?.routeId ?? routeId,
      city,
      source: "tdx",
      operators: [...new Set(normalized.flatMap((n) => n.operators))],
      directions: buildDirections(normalized),
    };
  } catch (err) {
    return {
      ok: false,
      error: (err as Error).message || "路線查詢失敗",
      status: 500,
    };
  }
}

/**
 * Predicted arrival of the next bus of a route at a named stop (TDX N1).
 * Some V2 N1 sources omit a plate number, so low-floor is reported separately via
 * getBusRealtimeOnRoute / trackBuses.
 */
export async function getBusArrivalAtStop(params: {
  routeName: string;
  stopName: string;
  city: TaiwanCityEn | "InterCity";
  direction?: number;
}): Promise<BusArrivalResult> {
  const { city, stopName, direction } = params;
  const routeId = formatRouteName(params.routeName);

  try {
    // No server-side StopName filter: TDX stores 臺/台 variants and bracketed
    // suffixes, so match client-side with equalStopName (which normalizes both).
    const dirFilter = isBusDirection(direction)
      ? `&$filter=Direction eq ${direction}`
      : "";
    const hasStop = (records: any[]) =>
      records.some((r: any) => equalStopName(r.StopName?.Zh_tw, stopName));

    const routeUids = await resolveRouteUids(params.routeName, city);
    const uidDirFilter = isBusDirection(direction)
      ? ` and Direction eq ${direction}`
      : "";
    const { records, scope } = await fetchRouteRows(
      params.routeName,
      city,
      routeUids,
      (filter) => etaUidUrl(city, `(${filter})${uidDirFilter}`),
      ({ type, routeId: id }) =>
        type === "City"
          ? `${busUrl.cityEstimatedTimeOfArrivalUrl}/${city}/${encodeURIComponent(id)}?$format=JSON${dirFilter}`
          : `${busUrl.interCityEstimatedTimeOfArrivalUrl}/${encodeURIComponent(id)}?$format=JSON${dirFilter}`,
      hasStop,
    );
    const matched = records.filter((r: any) =>
      equalStopName(r.StopName?.Zh_tw, stopName),
    );
    if (!matched.length) {
      return {
        ok: false,
        error: `找不到路線「${params.routeName}」在「${stopName}」的到站資料`,
        status: 404,
      };
    }

    const now = new Date();
    const raw = matched.map((r: any) => {
      const seconds = busEtaSeconds(r, now.getTime());
      const fresh = busEtaIsFresh(r, now.getTime());
      return {
        r,
        fresh,
        estimateMinutes: seconds === null ? null : Math.round(seconds / 60),
        stopStatus:
          fresh && typeof r.StopStatus === "number" ? r.StopStatus : undefined,
        nextBusTime: fresh ? formatNextBusTime(r.NextBusTime, now) : null,
      };
    });

    let schedules: BusScheduleByDirection[] | null = null;
    const needsSchedule = raw.some(
      (a) =>
        a.estimateMinutes == null &&
        !a.nextBusTime &&
        [undefined, 0, 1, 3, 4].includes(a.stopStatus),
    );
    if (needsSchedule) {
      const timetable = await getBusTimetable({
        routeName: params.routeName,
        city,
        routeUids,
        preserveSubRoutes: true,
      });
      schedules = timetable.ok ? timetable.schedules : null;
    }
    const scheduleFor = (subRouteUid: string | undefined, dir: number) =>
      schedules?.find(
        (s) => s.subRouteUid === subRouteUid && s.direction === dir,
      ) ?? schedules?.find((s) => s.direction === dir);

    const arrivals: BusArrival[] = raw
      .map(({ r, fresh, estimateMinutes, stopStatus, nextBusTime }) => ({
        subRouteUid: r.SubRouteUID,
        subRouteName: r.SubRouteName?.Zh_tw,
        stopName: r.StopName?.Zh_tw ?? stopName,
        direction: r.Direction,
        directionLabel: dirLabel(r.Direction),
        estimateMinutes,
        statusLabel: resolveStopStatusLabel({
          estimateMinutes,
          stopStatus,
          nextBusTime,
          scheduled: () =>
            nextDepartureText(
              scheduleFor(r.SubRouteUID, r.Direction)?.frequencies ?? [],
              r.StopName?.Zh_tw ?? stopName,
              r.StopSequence === 1,
              now,
            ),
        }),
        plateNumb:
          fresh && r.PlateNumb && r.PlateNumb !== "-1"
            ? r.PlateNumb
            : undefined,
      }))
      .sort((a, b) => {
        if (a.estimateMinutes == null) return 1;
        if (b.estimateMinutes == null) return -1;
        return a.estimateMinutes - b.estimateMinutes;
      });

    return {
      ok: true,
      routeName: scope?.routeId ?? routeId,
      city,
      stopName,
      arrivals,
    };
  } catch (err) {
    return {
      ok: false,
      error: (err as Error).message || "到站查詢失敗",
      status: 500,
    };
  }
}

/**
 * Get full route details: stops, ETA for all stops, and timetables.
 * Ideal for a full bus route view in an app.
 */
export async function getBusRouteDetail(params: {
  routeName: string;
  city: TaiwanCityEn | "InterCity";
  subRouteUid?: string;
}): Promise<BusRouteDetailResult> {
  const { city, routeName } = params;
  const routeId = formatRouteName(routeName);

  try {
    // 1. Get base route info (stops)
    const routeInfoRes = await getBusRouteInfo(params);
    if (!routeInfoRes.ok) return routeInfoRes;

    // 2. Get timetable (optional, we won't fail if not found)
    const routeUids = [
      ...new Set(
        routeInfoRes.directions
          .map((d) => d.routeUid)
          .filter((u): u is string => !!u),
      ),
    ];
    const timetableRes = await getBusTimetable({
      ...params,
      routeUids,
      preserveSubRoutes: true,
    });

    const shapes = await getBusRouteShapes(routeName, city);

    // 3. Get ETAs for all stops on the route
    // 部分縣市（例如台北）的 ETA 不帶 SubRouteUID，這種紀錄無法分辨子路線，
    // 只能保留下來改用方向對應。
    const matchesEtaSubRoute = (r: any): boolean =>
      r.SubRouteUID == null || r.SubRouteUID === params.subRouteUid;
    let etaRecords: any[] = [];
    let etaScope: BusRouteQueryScope | null = null;
    try {
      const eta = await fetchRouteRows(
        routeName,
        city,
        routeUids,
        (filter) => etaUidUrl(city, filter),
        ({ type, routeId: id }) =>
          type === "City"
            ? `${busUrl.cityEstimatedTimeOfArrivalUrl}/${city}/${encodeURIComponent(id)}?$format=JSON`
            : `${busUrl.interCityEstimatedTimeOfArrivalUrl}/${encodeURIComponent(id)}?$format=JSON`,
        params.subRouteUid
          ? (records) => records.some(matchesEtaSubRoute)
          : undefined,
      );
      etaRecords = params.subRouteUid
        ? eta.records.filter(matchesEtaSubRoute)
        : eta.records;
      etaScope = eta.scope;
    } catch (e) {
      console.error("Failed to fetch ETA in getBusRouteDetail", e);
    }

    type StopEta = {
      estimateMinutes: number | null;
      stopStatus: number | undefined;
      nextBusTime: string | null;
    };
    // key：有 SubRouteUID 時為 `${subRouteUid}_${dir}`；沒有時退回只用方向
    // `dir_${dir}`（台北市 ETA 不帶 SubRouteUID，舊寫法會整批丟掉，整條路線
    // 都顯示「尚未發車」）。
    const etaMap = new Map<string, Map<string, StopEta>>();
    const etaByStopUid = new Map<string, StopEta>();
    const now = new Date();
    for (const r of etaRecords) {
      const subRouteUid = r.SubRouteUID;
      const dir = r.Direction;
      const stopName = r.StopName?.Zh_tw;
      if (dir == null || !stopName) continue;

      const key = subRouteUid == null ? `dir_${dir}` : `${subRouteUid}_${dir}`;
      let dirMap = etaMap.get(key);
      if (!dirMap) {
        dirMap = new Map();
        etaMap.set(key, dirMap);
      }

      const seconds = busEtaSeconds(r, now.getTime());
      const est = seconds === null ? null : Math.round(seconds / 60);
      const fresh = busEtaIsFresh(r, now.getTime());

      const next: StopEta = {
        estimateMinutes: est,
        stopStatus:
          fresh && typeof r.StopStatus === "number" ? r.StopStatus : undefined,
        nextBusTime: fresh ? formatNextBusTime(r.NextBusTime, now) : null,
      };
      // 同方向同站名可能有多筆（不同子路線或站位共用站名）：保留最快到站的一班。
      const existing = dirMap.get(stopName);
      if (!existing || isSoonerEta(next, existing)) dirMap.set(stopName, next);
      if (r.StopUID) {
        const uidKey = `${key}|${r.StopUID}`;
        const sameStop = etaByStopUid.get(uidKey);
        if (!sameStop || isSoonerEta(next, sameStop))
          etaByStopUid.set(uidKey, next);
      }
    }

    const directions: BusRouteDetailDirection[] = routeInfoRes.directions.map(
      (d) => {
        const dirMap =
          etaMap.get(`${d.subRouteUid}_${d.direction}`) ??
          etaMap.get(`dir_${d.direction}`);
        const dirSchedule = timetableRes.ok
          ? (timetableRes.schedules.find(
              (sched) =>
                sched.subRouteUid === d.subRouteUid &&
                sched.direction === d.direction,
            ) ??
            timetableRes.schedules.find(
              (sched) => !sched.subRouteUid && sched.direction === d.direction,
            ))
          : null;
        const frequencies = dirSchedule?.frequencies || [];

        const stops: BusRouteDetailStop[] = d.stops.map((s, index) => {
          let etaData: StopEta | undefined = s.stopUid
            ? (etaByStopUid.get(
                `${d.subRouteUid}_${d.direction}|${s.stopUid}`,
              ) ?? etaByStopUid.get(`dir_${d.direction}|${s.stopUid}`))
            : undefined;
          if (!etaData && dirMap) {
            const entries = [...dirMap.entries()];
            etaData =
              entries.find(
                ([key]) => normalizeStopName(key) === normalizeStopName(s.name),
              )?.[1] ??
              entries.find(([key]) => equalStopName(key, s.name))?.[1];
          }
          const estimateMinutes = etaData?.estimateMinutes ?? null;

          return {
            ...s,
            estimateMinutes,
            statusLabel: resolveStopStatusLabel({
              estimateMinutes,
              stopStatus: etaData?.stopStatus,
              nextBusTime: etaData?.nextBusTime ?? null,
              scheduled: () =>
                nextDepartureText(frequencies, s.name, index === 0, now),
            }),
          };
        });
        return {
          ...d,
          stops,
          polyline: matchBusShape(d, shapes, routeInfoRes.directions),
        };
      },
    );

    return {
      ok: true,
      routeName: etaScope?.routeId ?? routeInfoRes.routeName ?? routeId,
      city,
      operators: routeInfoRes.operators,
      schedules: timetableRes.ok ? timetableRes.schedules : undefined,
      directions,
    };
  } catch (err) {
    return {
      ok: false,
      error: (err as Error).message || "路線詳情查詢失敗",
      status: 500,
    };
  }
}

function serviceDayLabel(sd?: Record<string, number>): string {
  if (!sd) return "";
  const days = [
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
    "Sunday",
  ];
  const on = days.filter((d) => sd[d]);
  if (on.length === 7) return "每日";
  const weekday = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
  if (on.length === 5 && weekday.every((d) => sd[d])) return "平日";
  if (on.length === 2 && sd.Saturday && sd.Sunday) return "假日";
  const zh: Record<string, string> = {
    Monday: "一",
    Tuesday: "二",
    Wednesday: "三",
    Thursday: "四",
    Friday: "五",
    Saturday: "六",
    Sunday: "日",
  };
  return on.length ? `週${on.map((d) => zh[d]).join("")}` : "";
}

/**
 * Route timetable per direction: first/last service time and the service
 * frequency (headway) bands (TDX V2 Schedule — frequency-based).
 */
export async function getBusTimetable(params: {
  routeName: string;
  city: TaiwanCityEn | "InterCity";
  subRouteUid?: string;
  /** Internal route-detail mode; the standalone timetable endpoint stays grouped by direction. */
  preserveSubRoutes?: boolean;
  afterTime?: string;
  limit?: number;
  /** Internal: query by these RouteUIDs instead of probing route names. */
  routeUids?: string[];
}): Promise<BusTimetableResult> {
  const { city } = params;
  const routeId = formatRouteName(params.routeName);

  try {
    const { records, scope } = await fetchRouteRows(
      params.routeName,
      city,
      params.routeUids,
      (filter) =>
        city === "InterCity"
          ? `${busUrl.interCityScheduleUrl}?$format=JSON&$filter=${filter}`
          : `${busUrl.cityScheduleUrl}/${city}?$format=JSON&$filter=${filter}`,
      ({ type, routeId: id }) =>
        type === "City"
          ? `${busUrl.cityScheduleUrl}/${city}?$format=JSON&$filter=RouteName/Zh_tw eq '${odataUrlLiteral(id)}'`
          : `${busUrl.interCityScheduleUrl}?$format=JSON&$filter=RouteName/Zh_tw eq '${odataUrlLiteral(id)}'`,
      params.subRouteUid
        ? (rows) => rows.some((r: any) => r.SubRouteUID === params.subRouteUid)
        : undefined,
    );
    const matchingRecords = params.subRouteUid
      ? records.filter((r: any) => r.SubRouteUID === params.subRouteUid)
      : records;
    if (!matchingRecords.length) {
      return {
        ok: false,
        error: `找不到路線「${params.routeName}」的時刻表`,
        status: 404,
      };
    }

    type ScheduleBucket = {
      subRouteUid?: string;
      subRouteName?: string;
      direction: number;
      frequencies: BusFrequency[];
    };
    const bySubRouteAndDir = new Map<string, ScheduleBucket>();
    for (const r of matchingRecords) {
      const keepSubRoute = params.preserveSubRoutes || !!params.subRouteUid;
      const subRouteUid = keepSubRoute ? r.SubRouteUID || undefined : undefined;
      const key = keepSubRoute
        ? `${subRouteUid ?? ""}_${r.Direction}`
        : String(r.Direction);
      const bucket = bySubRouteAndDir.get(key) ?? {
        subRouteUid,
        subRouteName: keepSubRoute ? r.SubRouteName?.Zh_tw : undefined,
        direction: r.Direction,
        frequencies: [] as BusFrequency[],
      };
      const list = bucket.frequencies;
      for (const f of r.Frequencys ?? []) {
        list.push({
          scheduleType: "headway",
          start: f.StartTime,
          end: f.EndTime,
          minHeadwayMins: f.MinHeadwayMins,
          maxHeadwayMins: f.MaxHeadwayMins,
          serviceDays: serviceDayLabel(f.ServiceDay),
        });
      }
      // Some operators publish Timetables (explicit trips) instead of Frequencys.
      for (const t of r.Timetables ?? []) {
        const stopTimes = (t.StopTimes ?? [])
          .map((st: any) => ({
            seq: st.StopSequence,
            stopName: st.StopName?.Zh_tw ?? "",
            arrivalTime: st.ArrivalTime || st.DepartureTime || "",
          }))
          .filter((st: any) => st.arrivalTime);
        const origin = stopTimes[0];
        if (!origin) continue;

        list.push({
          scheduleType: "trip",
          serviceDays: serviceDayLabel(t.ServiceDay),
          originStopName: origin.stopName,
          originDepartureTime: origin.arrivalTime,
          // Only surface per-stop times when upstream published more than the
          // origin; otherwise the field would imply data that does not exist.
          ...(stopTimes.length > 1 ? { stopTimes } : {}),
        });
      }
      bySubRouteAndDir.set(key, bucket);
    }

    const after = /^\d{2}:\d{2}$/.test(params.afterTime ?? "")
      ? params.afterTime
      : undefined;
    const limit =
      typeof params.limit === "number" && params.limit > 0
        ? Math.min(Math.floor(params.limit), 24)
        : undefined;
    let truncated = false;

    const schedules: BusScheduleByDirection[] = [...bySubRouteAndDir.values()]
      .sort(
        (a, b) =>
          a.direction - b.direction ||
          (a.subRouteUid ?? "").localeCompare(b.subRouteUid ?? ""),
      )
      .map(({ subRouteUid, subRouteName, direction, frequencies: all }) => {
        // first/last describe the whole published service, so compute them
        // BEFORE any afterTime/limit filtering narrows the view.
        const times = all.flatMap((f) =>
          f.scheduleType === "trip"
            ? [f.originDepartureTime]
            : [f.start, f.end].filter(
                Boolean as unknown as (v: unknown) => boolean,
              ),
        ) as string[];
        const sorted = [...times].sort();

        // Upstream can repeat byte-identical entries for the same branch.
        // Deduplicate before filtering so `limit` counts distinct departures.
        const seen = new Set<string>();
        let frequencies = all.filter((f) => {
          const key =
            f.scheduleType === "trip"
              ? `t|${f.serviceDays}|${f.originStopName}|${f.originDepartureTime}`
              : `h|${f.serviceDays}|${f.start}|${f.end}|${f.minHeadwayMins}|${f.maxHeadwayMins}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        if (after) {
          // Headway windows are kept unless they have already ended: they still
          // answer "how often", which is all such routes can offer.
          frequencies = frequencies.filter((f) =>
            f.scheduleType === "trip"
              ? f.originDepartureTime >= after
              : (f.end ?? "23:59") >= after,
          );
        }
        frequencies = [...frequencies].sort((a, b) => {
          const ka =
            a.scheduleType === "trip" ? a.originDepartureTime : (a.start ?? "");
          const kb =
            b.scheduleType === "trip" ? b.originDepartureTime : (b.start ?? "");
          return ka.localeCompare(kb);
        });
        if (limit && frequencies.length > limit) {
          truncated = true;
          frequencies = frequencies.slice(0, limit);
        }

        return {
          ...(subRouteUid ? { subRouteUid } : {}),
          ...(subRouteName ? { subRouteName } : {}),
          direction,
          directionLabel: dirLabel(direction),
          first: sorted[0],
          last: sorted[sorted.length - 1],
          frequencies,
        };
      });

    return {
      ok: true,
      routeName: scope?.routeId ?? routeId,
      city,
      schedules,
      note: "本路線時刻僅為起站發車時刻（originDepartureTime）或班距（headway）；上游未提供中途站的到站時刻。要推估中途站時間必須自行估算並向使用者標明為估計值。",
      ...(truncated ? { truncated } : {}),
    };
  } catch (err) {
    return {
      ok: false,
      error: (err as Error).message || "時刻表查詢失敗",
      status: 500,
    };
  }
}

/**
 * All buses currently running on a route (TDX A1), each annotated with
 * low-floor / lift-or-ramp status joined from the imported Vehicle table.
 * The user never supplies a plate number — the agent obtains the live plates.
 */
/**
 * TDX 依路線名查詢時會一併回傳同號碼的其他路線（查「700」連「700跳蛙公車」都會回來），
 * 而 `formatRouteName` 又會把「700跳蛙公車」縮成「700」先查——於是跳蛙沒發車時，一般 700
 * 的車會被當成跳蛙的車回給前端。完整名稱本身就是一條已匯入的路線時，只保留這條路線的紀錄；
 * 查不到（例如「307公車」這種帶雜訊的輸入）或 DB 失敗時不過濾，維持原本的模糊比對。
 *
 * @param routeName 呼叫方給的路線名
 * @param city 呼叫方指定的城市，或 "InterCity"
 * @returns 要保留的完整路線名；不需要過濾時為 null
 */
async function exactRouteNameToKeep(
  routeName: string,
  city: TaiwanCityEn | "InterCity",
): Promise<string | null> {
  const fullName = routeName.trim();
  if (!fullName || fullName === formatRouteName(fullName)) return null;
  try {
    const docs = await findRoutesByName(city, [fullName]);
    return docs.length ? fullName : null;
  } catch (e) {
    console.error("Failed to resolve exact route name for bus positions", e);
    return null;
  }
}

export async function getBusRealtimeOnRoute(params: {
  routeName: string;
  city: TaiwanCityEn | "InterCity";
  direction?: number;
}): Promise<BusRealtimeOnRouteResult> {
  const { city, direction } = params;
  const routeId = formatRouteName(params.routeName);

  try {
    const dirFilter = isBusDirection(direction)
      ? `&$filter=Direction eq ${direction}`
      : "";
    const interCityDirFilter = isBusDirection(direction)
      ? ` and Direction eq ${direction}`
      : "";

    const keepRouteName = await exactRouteNameToKeep(params.routeName, city);
    const scoped = await fetchRouteScoped(
      params.routeName,
      city,
      ({ type, routeId: id }) =>
        type === "City"
          ? `${busUrl.cityRealtimeByFrequencyUrl}/${city}/${encodeURIComponent(id)}?$format=JSON${dirFilter}`
          : `${busUrl.interCityRealTimeByFrequencyUrl}?$format=JSON&$filter=RouteName/Zh_tw eq '${odataUrlLiteral(id)}'${interCityDirFilter}`,
    );
    const { scope } = scoped;
    const records = keepRouteName
      ? scoped.records.filter(
          (r: { RouteName?: { Zh_tw?: string } }) =>
            r.RouteName?.Zh_tw === keepRouteName,
        )
      : scoped.records;
    if (!records.length) {
      return {
        ok: false,
        error: `路線「${params.routeName}」目前沒有營運中的車輛`,
        status: 404,
      };
    }

    const vehicles = await lowFloorMap(records.map((r: any) => r.PlateNumb));
    const buses: BusOnRoad[] = records.map((r: any) => {
      const veh = vehicles.get(r.PlateNumb);
      return {
        subRouteUid: r.SubRouteUID,
        subRouteName: r.SubRouteName?.Zh_tw,
        plateNumb: r.PlateNumb,
        direction: r.Direction,
        directionLabel: dirLabel(r.Direction),
        lat: r.BusPosition?.PositionLat,
        lng: r.BusPosition?.PositionLon,
        speed: r.Speed,
        statusLabel: BUS_STATUS_LABEL[r.BusStatus] ?? "正常",
        gpsTime: r.GPSTime,
        isLowFloor: yesNoLabel(veh?.isLowFloor),
        hasLiftOrRamp: yesNoLabel(veh?.hasLiftOrRamp),
        vehicleClass:
          veh?.vehicleClass != null
            ? VEHICLE_CLASS_LABEL[veh.vehicleClass]
            : undefined,
      };
    });

    return {
      ok: true,
      routeName: keepRouteName ?? scope?.routeId ?? routeId,
      city,
      count: buses.length,
      lowFloorCount: buses.filter((b) => b.isLowFloor === "是").length,
      buses,
    };
  } catch (err) {
    return {
      ok: false,
      error: (err as Error).message || "即時位置查詢失敗",
      status: 500,
    };
  }
}

/**
 * Search bus routes by keyword across all cities in the DB.
 * When `userLoc` is provided, calculates the distance from the user to each route
 * (using the closest stop on the route, or city center fallback) and sorts ascending by distance.
 *
 * @param keyword Route name search keyword
 * @param userLoc Optional user GPS coordinates { lat, lng }
 * @param limit Maximum results to return (default: 50)
 */
export async function searchBusRoutes(
  keyword: string,
  userLoc?: { lat: number; lng: number } | null,
  limit: number = 50,
): Promise<BusSearchRouteResult> {
  try {
    const queryLimit = userLoc ? 2000 : limit;
    const routes = await searchRoutesByKeyword(keyword, queryLimit);

    type RouteWithDistance = {
      item: BusSearchResult;
      distance?: number;
    };

    const mapped: RouteWithDistance[] = routes.map((r) => {
      const dir0 =
        r.subRoutes.find((sr: any) => sr.direction === 0) || r.subRoutes[0];
      const stops = dir0?.stops || [];
      const sortedStops = [...stops].sort((a: any, b: any) => a.seq - b.seq);
      const departure = sortedStops[0]?.stopName?.Zh_tw || "";
      const destination =
        sortedStops[sortedStops.length - 1]?.stopName?.Zh_tw || "";

      let distance: number | undefined;
      if (userLoc) {
        let minDist = Infinity;
        for (const sub of r.subRoutes) {
          for (const s of sub.stops || []) {
            if (
              typeof s.lat === "number" &&
              typeof s.lng === "number" &&
              !Number.isNaN(s.lat) &&
              !Number.isNaN(s.lng)
            ) {
              const d = haversineMeters(userLoc.lat, userLoc.lng, s.lat, s.lng);
              if (d < minDist) minDist = d;
            }
          }
        }
        if (minDist === Infinity && r._id.city) {
          const resolvedCity = cityFromAlias(r._id.city);
          if (resolvedCity && CITY_COORDINATES[resolvedCity]) {
            const cityCoord = CITY_COORDINATES[resolvedCity];
            minDist = haversineMeters(
              userLoc.lat,
              userLoc.lng,
              cityCoord.lat,
              cityCoord.lng,
            );
          }
        }
        if (minDist !== Infinity) {
          distance = Math.round(minDist);
        }
      }

      return {
        item: {
          routeName: r._id.routeName,
          city: r._id.city,
          departure,
          destination,
          ...(distance !== undefined ? { distance } : {}),
        },
        distance,
      };
    });

    if (userLoc) {
      mapped.sort((a, b) => {
        const distA = a.distance ?? Infinity;
        const distB = b.distance ?? Infinity;
        if (distA !== distB) {
          return distA - distB;
        }
        const aExact = a.item.routeName === keyword ? 0 : 1;
        const bExact = b.item.routeName === keyword ? 0 : 1;
        if (aExact !== bExact) return aExact - bExact;
        return a.item.routeName.localeCompare(b.item.routeName, "zh-TW");
      });
    }

    const result = mapped.slice(0, limit).map((m) => m.item);

    return { ok: true, routes: result };
  } catch (err) {
    return {
      ok: false,
      error: (err as Error).message || "路線搜尋失敗",
      status: 500,
    };
  }
}

/**
 * Search bus stops by keyword across all cities in the DB.
 * When `userLoc` is provided, calculates the distance from the user to each stop
 * and sorts ascending by distance.
 *
 * @param keyword Fuzzy match against the stop's Chinese name.
 * @param userLoc Optional user coordinates { lat, lng } for distance sorting
 * @param limit Maximum matching stops to return (default: 50)
 * @returns Matching stops (deduped by name + city), each with the routes passing through; capped at limit.
 */
export async function searchBusStops(
  keyword: string,
  userLoc?: { lat: number; lng: number } | null,
  limit: number = 50,
): Promise<BusStopSearchRouteResult> {
  try {
    const queryLimit = userLoc ? 500 : 250;
    const stops = await searchStopsByKeyword(keyword, queryLimit, userLoc);

    if (!stops.length) {
      return { ok: true, stops: [] };
    }

    const allSubRouteIds = [
      ...new Set(stops.flatMap((s) => s.subRouteIds || [])),
    ];
    const routes = await findRouteNamesBySubRoute(allSubRouteIds);

    const routeMap = new Map<string, string>();
    for (const r of routes) {
      if (r.subRouteName?.Zh_tw && r.routeName?.Zh_tw) {
        routeMap.set(r.subRouteName.Zh_tw, r.routeName.Zh_tw);
      }
    }

    const mergedMap = new Map<string, BusStopSearchResult>();

    for (const s of stops) {
      const key = `${s.stopName.Zh_tw}|${s.city}`;
      const routesForStop = (s.subRouteIds || [])
        .map((id: string) => routeMap.get(id) || id)
        .filter(Boolean) as string[];

      let distance: number | undefined;
      if (userLoc) {
        if (typeof s.distance === "number" && !Number.isNaN(s.distance)) {
          distance = Math.round(s.distance);
        } else {
          const coords = s.location?.coordinates;
          if (
            Array.isArray(coords) &&
            coords.length >= 2 &&
            typeof coords[0] === "number" &&
            typeof coords[1] === "number" &&
            !Number.isNaN(coords[0]) &&
            !Number.isNaN(coords[1])
          ) {
            // coords is [lng, lat]
            distance = Math.round(
              haversineMeters(userLoc.lat, userLoc.lng, coords[1], coords[0]),
            );
          } else if (s.city) {
            const resolvedCity = cityFromAlias(s.city);
            if (resolvedCity && CITY_COORDINATES[resolvedCity]) {
              const cityCoord = CITY_COORDINATES[resolvedCity];
              distance = Math.round(
                haversineMeters(
                  userLoc.lat,
                  userLoc.lng,
                  cityCoord.lat,
                  cityCoord.lng,
                ),
              );
            }
          }
        }
      }

      const existing = mergedMap.get(key);
      if (existing) {
        existing.routes = [
          ...new Set([...existing.routes, ...routesForStop]),
        ].sort();
        if (
          distance !== undefined &&
          (existing.distance === undefined || distance < existing.distance)
        ) {
          existing.distance = distance;
        }
      } else {
        mergedMap.set(key, {
          stopUid: s.stopUid,
          stopName: s.stopName.Zh_tw,
          city: s.city,
          coordinates: s.location.coordinates as [number, number],
          routes: [...new Set(routesForStop)].sort(),
          ...(distance !== undefined ? { distance } : {}),
        });
      }
    }

    const stopList = [...mergedMap.values()];

    if (userLoc) {
      stopList.sort((a, b) => {
        const distA = a.distance ?? Infinity;
        const distB = b.distance ?? Infinity;
        if (distA !== distB) {
          return distA - distB;
        }
        const aExact = a.stopName === keyword ? 0 : 1;
        const bExact = b.stopName === keyword ? 0 : 1;
        if (aExact !== bExact) return aExact - bExact;
        return a.stopName.localeCompare(b.stopName, "zh-TW");
      });
    } else {
      stopList.sort((a, b) => a.stopName.localeCompare(b.stopName, "zh-TW"));
    }

    const finalStops = stopList.slice(0, limit);

    return { ok: true, stops: finalStops };
  } catch (err) {
    return {
      ok: false,
      error: (err as Error).message || "站牌搜尋失敗",
      status: 500,
    };
  }
}

/**
 * Get nearby bus stops sorted by distance.
 */
export async function getNearbyStops(params: {
  lat: number;
  lng: number;
  radius: number;
  limit: number;
}): Promise<BusNearbyStopsResult> {
  const { lat, lng, radius, limit } = params;
  try {
    // Expand the aggregate limit since we will merge stops with the same name in memory
    const queryLimit = limit * 5;
    const stops = await findStopsNearby(lat, lng, radius, queryLimit);

    if (!stops.length) {
      return { ok: true, stops: [] };
    }

    // Collect all subRouteIds (which are actually route/sub-route names, e.g., "2", "307")
    const allSubRouteIds = [
      ...new Set(stops.flatMap((s) => s.subRouteIds || [])),
    ];
    const routes = await findRouteNamesBySubRoute(allSubRouteIds);

    const routeMap = new Map<string, string>();
    for (const r of routes) {
      if (r.subRouteName?.Zh_tw && r.routeName?.Zh_tw) {
        routeMap.set(r.subRouteName.Zh_tw, r.routeName.Zh_tw);
      }
    }

    const mergedMap = new Map<string, BusNearbyStop>();

    for (const s of stops) {
      const stopNameZh = s.stopName.Zh_tw;
      const routesForStop = (s.subRouteIds || [])
        .map((id: string) => routeMap.get(id) || id)
        .filter(Boolean) as string[];

      const existing = mergedMap.get(stopNameZh);
      const dist = Math.round(s.distance);

      if (existing) {
        // Union routes and sort
        existing.routes = [
          ...new Set([...existing.routes, ...routesForStop]),
        ].sort();
        // If this stop instance is closer, update distance, coordinates, and UID
        if (dist < existing.distance) {
          existing.distance = dist;
          existing.coordinates = s.location.coordinates as [number, number];
          existing.stopUid = s.stopUid;
        }
      } else {
        mergedMap.set(stopNameZh, {
          stopUid: s.stopUid,
          stopName: stopNameZh,
          city: s.city,
          coordinates: s.location.coordinates as [number, number],
          distance: dist,
          routes: [...new Set(routesForStop)].sort(),
        });
      }
    }

    const finalStops = [...mergedMap.values()]
      .sort((a, b) => a.distance - b.distance)
      .slice(0, limit);

    return { ok: true, stops: finalStops };
  } catch (err) {
    return {
      ok: false,
      error: (err as Error).message || "尋找附近站牌失敗",
      status: 500,
    };
  }
}

/** Radius (m) around the caller's coordinates in which the stop is resolved. */
const STOP_ARRIVALS_RADIUS_M = 300;
const STOP_ARRIVALS_STOP_LIMIT = 50;
const STOP_ARRIVALS_TTL_MS = 20_000;
const STOP_ARRIVALS_MAX_ENTRIES = 500;

const stopArrivalsCache = new Map<
  string,
  { data: BusStopArrivalsData; expiresAt: number }
>();
const stopArrivalsInFlight = new Map<string, Promise<BusStopArrivalsResult>>();

/** Drop the stop-arrivals cache and in-flight registry (test isolation). */
export function clearStopArrivalsCache(): void {
  stopArrivalsCache.clear();
  stopArrivalsInFlight.clear();
}

function stopArrivalsKey(
  city: string,
  stopName: string,
  lat: number,
  lng: number,
): string {
  return `${city}|${normalizeStopName(stopName)}|${lat.toFixed(4)}|${lng.toFixed(4)}`;
}

function compareEstimate(a: number | null, b: number | null): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return a - b;
}

/** Last stop name per `subRouteUid|direction`, from one batched lookup. */
async function headsignMap(
  subRouteUids: string[],
): Promise<Map<string, string>> {
  const docs = await findRoutesBySubRouteUids(subRouteUids);
  const map = new Map<string, string>();
  for (const doc of docs) {
    const last = (doc.stops ?? []).reduce<
      NonNullable<BusRouteDoc["stops"]>[number] | null
    >((acc, stop) => (!acc || stop.seq > acc.seq ? stop : acc), null);
    const name = last?.stopName?.Zh_tw;
    if (name) map.set(`${doc.subRouteUid}|${doc.direction}`, name);
  }
  return map;
}

async function loadStopArrivals(params: {
  stopName: string;
  city: TaiwanCityEn;
  lat: number;
  lng: number;
}): Promise<BusStopArrivalsResult> {
  const { stopName, city, lat, lng } = params;
  try {
    const wanted = normalizeStopName(stopName);
    const nearby = await findCityStopsNearby(
      city,
      lat,
      lng,
      STOP_ARRIVALS_RADIUS_M,
      STOP_ARRIVALS_STOP_LIMIT,
    );
    const stopUids = [
      ...new Set(
        nearby
          .filter((s) => normalizeStopName(s.stopName.Zh_tw) === wanted)
          .map((s) => s.stopUid),
      ),
    ];
    if (!stopUids.length) {
      return { ok: false, error: TRANSIT_MSG.STOP_NOT_FOUND, status: 404 };
    }

    // ONE TDX call for every route serving the physical stop.
    const filter = stopUids
      .map((uid) => `StopUID eq '${escapeODataLiteral(uid)}'`)
      .join(" or ");
    const records = await fetchTdxArray(
      `${busUrl.cityEstimatedTimeOfArrivalUrl}/${city}?$filter=${encodeURIComponent(filter)}&$format=JSON`,
    );

    const nowMs = Date.now();
    const rows: (BusStopArrival & { key: string })[] = [];
    for (const r of records) {
      const routeName: string | undefined = r.RouteName?.Zh_tw;
      if (!routeName || (r.Direction !== 0 && r.Direction !== 1)) continue;
      const seconds = busEtaSeconds(r, nowMs);
      const fresh = busEtaIsFresh(r, nowMs);
      const estimateMinutes =
        seconds === null ? null : Math.round(seconds / 60);
      rows.push({
        key: `${routeName}|${r.SubRouteUID ?? ""}|${r.Direction}`,
        routeName,
        subRouteUid: r.SubRouteUID,
        subRouteName: r.SubRouteName?.Zh_tw,
        direction: r.Direction,
        headsign: null,
        estimateMinutes,
        statusLabel: resolveStopStatusLabel({
          estimateMinutes,
          stopStatus:
            fresh && typeof r.StopStatus === "number"
              ? r.StopStatus
              : undefined,
          nextBusTime: fresh
            ? formatNextBusTime(r.NextBusTime, new Date(nowMs))
            : null,
          scheduled: () => null,
        }),
        plateNumb:
          fresh && r.PlateNumb && r.PlateNumb !== "-1"
            ? r.PlateNumb
            : undefined,
        isLowFloor: null,
        hasLiftOrRamp: null,
      });
    }

    // One row per (route, subRoute, direction): keep the smallest ETA.
    const best = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      const cur = best.get(row.key);
      if (!cur || compareEstimate(row.estimateMinutes, cur.estimateMinutes) < 0)
        best.set(row.key, row);
    }
    const deduped = [...best.values()];

    const [vehicles, headsigns] = await Promise.all([
      lowFloorMap(deduped.map((a) => a.plateNumb)),
      headsignMap([
        ...new Set(
          deduped.map((a) => a.subRouteUid).filter((u): u is string => !!u),
        ),
      ]),
    ]);

    const arrivals: BusStopArrival[] = deduped
      .map(({ key: _key, ...a }) => {
        const veh = a.plateNumb ? vehicles.get(a.plateNumb) : undefined;
        return {
          ...a,
          headsign: a.subRouteUid
            ? (headsigns.get(`${a.subRouteUid}|${a.direction}`) ?? null)
            : null,
          isLowFloor: flagOrNull(veh?.isLowFloor),
          hasLiftOrRamp: flagOrNull(veh?.hasLiftOrRamp),
        };
      })
      .sort((a, b) => compareEstimate(a.estimateMinutes, b.estimateMinutes));

    return { ok: true, stopName, city, arrivals };
  } catch (err) {
    return {
      ok: false,
      error: (err as Error).message || TRANSIT_MSG.STOP_ARRIVALS_FAILED,
      status: 500,
    };
  }
}

function flagOrNull(code?: number): boolean | null {
  if (code === 1) return true;
  if (code === 0) return false;
  return null;
}

/**
 * Next-bus ETA of every route at ONE physical stop, plus whether that next bus
 * is low-floor / has a lift. Replaces the per-route fan-out of
 * route-detail + positions + arrival with a single TDX ETA call, cached for
 * 20 s and shared by concurrent callers of the same stop.
 *
 * InterCity is unsupported: its ETA endpoint is the per-route
 * `Streaming/InterCity/{RouteName}` form with no city-wide StopUID listing.
 */
export async function getBusStopArrivals(params: {
  stopName: string;
  city: TaiwanCityEn | "InterCity";
  lat: number;
  lng: number;
}): Promise<BusStopArrivalsResult> {
  const { stopName, city, lat, lng } = params;
  if (city === "InterCity") {
    return {
      ok: false,
      error: TRANSIT_MSG.STOP_ARRIVALS_INTERCITY_UNSUPPORTED,
      status: 400,
    };
  }

  const key = stopArrivalsKey(city, stopName, lat, lng);
  const now = Date.now();
  const cached = stopArrivalsCache.get(key);
  if (cached && cached.expiresAt > now) {
    return { ok: true, ...cached.data };
  }

  const pending = stopArrivalsInFlight.get(key);
  if (pending) return pending;

  const request = loadAndCacheStopArrivals(key, {
    stopName,
    city,
    lat,
    lng,
  });
  stopArrivalsInFlight.set(key, request);
  return request;
}

async function loadAndCacheStopArrivals(
  key: string,
  params: { stopName: string; city: TaiwanCityEn; lat: number; lng: number },
): Promise<BusStopArrivalsResult> {
  try {
    const result = await loadStopArrivals(params);
    if (result.ok) {
      const { ok: _ok, ...data } = result;
      if (stopArrivalsCache.size >= STOP_ARRIVALS_MAX_ENTRIES) {
        const t = Date.now();
        for (const [k, v] of stopArrivalsCache)
          if (v.expiresAt <= t) stopArrivalsCache.delete(k);
        if (stopArrivalsCache.size >= STOP_ARRIVALS_MAX_ENTRIES)
          stopArrivalsCache.clear();
      }
      stopArrivalsCache.set(key, {
        data,
        expiresAt: Date.now() + STOP_ARRIVALS_TTL_MS,
      });
    }
    return result;
  } finally {
    stopArrivalsInFlight.delete(key);
  }
}
