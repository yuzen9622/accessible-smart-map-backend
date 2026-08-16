import { tdxFetch } from "../../config/fetch";
import { alertUrl, metroUrl } from "../../config/transit";
import {
  findBusRoutesByName,
  type BusRouteLookupRow,
} from "./alert.repository";
import { ResponseCode } from "../../types/code";
import type { MatchKind, MatchedAlert } from "../../types/transit";
import {
  equalRouteName,
  equalStopName,
  formatRouteName,
} from "../../utils/transit-text";
import {
  clearAlertStore,
  getFreshAlertSnapshot,
  upsertAlertSnapshot,
} from "./alert.store";

export type { MatchKind, MatchedAlert };

type LocalizedName = { Zh_tw?: string };
type AlertStatus = number | string;
type AlertLineSection = {
  LineID: string;
  StartingStationID: string;
  EndingStationID: string;
};

type AlertMetadata = {
  AlertID: string;
  Title: string;
  Description: string;
  Status: AlertStatus;
  Cause?: number | string;
  Effect?: number | string;
  Level?: number | string;
  Reason?: string;
  StartTime?: string | null;
  EndTime?: string | null;
  UpdateTime?: string;
  AlertURL?: string;
  AlertUrl?: string;
};

export type BusAlert = AlertMetadata & {
  Status: 0 | 1 | 2;
  Scope: {
    Operators?: Array<{ OperatorID?: string; OperatorName?: LocalizedName }>;
    Stops?: Array<{
      StopID: string;
      StopName: LocalizedName;
      StationID?: string;
    }>;
    Routes?: Array<{
      RouteID: string;
      RouteName: LocalizedName;
      Direction?: number | null;
    }>;
    SubRoutes?: Array<{
      SubRouteID: string;
      SubRouteName: LocalizedName;
      Direction?: number | null;
    }>;
    Stations?: Array<{
      StationID: string;
      StationName?: LocalizedName | string;
    }>;
    Trips?: Array<{
      TripID: string;
      RouteID?: string;
      SubRouteID?: string;
      Direction?: number | null;
    }>;
  };
  PublishTime?: string;
};

type MetroStationScope =
  string | { StationID: string; StationName?: LocalizedName | string };
type MetroLineScope =
  string | { LineID: string; LineName?: LocalizedName | string };

export type MetroAlert = AlertMetadata & {
  Status: number;
  Scope: {
    Stations?: MetroStationScope[];
    Lines?: MetroLineScope[];
    LineSections?: AlertLineSection[];
  };
  Direction?: number | null;
};

export type TraAlert = AlertMetadata & {
  Status: number;
  Scope: {
    Stations?: Array<{
      StationID: string;
      StationName?: LocalizedName | string;
    }>;
    Lines?: Array<{ LineID: string; LineName?: LocalizedName | string }>;
    Trains?: Array<{ TrainNo: string }>;
    LineSections?: AlertLineSection[];
  };
  Direction?: number | null;
};

export type ThsrAlert = AlertMetadata & {
  Status: "" | "▲" | "X";
  Scope: {
    LineSections?: AlertLineSection[];
  };
  Direction?: number | null;
};

export type TransitContext =
  | {
      mode: "bus";
      city: string;
      routeName: string;
      direction?: number;
      stopUid?: string;
      stopName?: string;
      stopUids?: string[];
      stopNames?: string[];
    }
  | {
      mode: "metro";
      railSystem: string;
      lineCode?: string;
      stationIds?: string[];
    }
  | {
      mode: "tra";
      trainNo?: string;
      lineId?: string;
      stationIds?: string[];
      direction?: number;
    }
  | {
      mode: "thsr";
      lineId?: string;
      direction?: number;
      fromStationId?: string;
      toStationId?: string;
    };

type Match = { kind: MatchKind };
type BusRouteKeys = {
  routeIds: string[];
  subRouteNames: string[];
  stopIds: string[];
};
type AlertCandidate<T extends AlertMetadata> = { alert: T; match: Match };

type TransitAlertSuccess = {
  ok: true;
  mode: TransitContext["mode"];
  matchedAt: string;
  alerts: MatchedAlert[];
};
type TransitAlertFailure = {
  ok: false;
  error: string;
  status: ResponseCode.INVALID_INPUT | ResponseCode.INTERNAL_ERROR;
};

export type TransitAlertResult = TransitAlertSuccess | TransitAlertFailure;

const TDX_JSON_FORMAT_QUERY = "?$format=JSON";
const INTERCITY_CITY = "InterCity";
const NORMAL_NUMERIC_ALERT_STATUS = 1;
const NORMAL_THSR_ALERT_STATUS = "";
const DIRECTION_UNKNOWN = 255;
const DIRECTION_BOTH_WAYS = 2; // 雙向 wildcard 僅適用 TRA/THSR（bus 的 2 是「迴圈」，非 wildcard）
const MATCH_KIND_PRIORITY: Record<MatchKind, number> = {
  train: 4,
  stop: 3,
  station: 3,
  route: 2,
  line: 2,
  section: 1,
};
const SUPPORTED_METRO_SYSTEMS = [
  "TRTC",
  "KRTC",
  "TYMC",
  "TMRT",
  "KLRT",
  "TRTCMG",
] as const;
type SupportedMetroSystem = (typeof SUPPORTED_METRO_SYSTEMS)[number];

/** Drop cached alert payloads (primarily for deterministic tests). */
export function clearTransitAlertsCache(): void {
  clearAlertStore();
}

async function getStoreOrFetch<T>(
  key: string,
  url: string,
  extract: (json: unknown) => T[],
): Promise<T[]> {
  const snapshot = getFreshAlertSnapshot(key);
  if (snapshot) return snapshot.alerts as T[];

  const response = await tdxFetch(url);
  if (!response.ok) throw new Error(`TDX ${response.status}`);
  const alerts = extract(await response.json());
  upsertAlertSnapshot(key, alerts, "rest");
  return alerts;
}

function bareAlertArray<T>(json: unknown): T[] {
  return Array.isArray(json) ? (json as T[]) : [];
}

function envelopeAlerts<T>(json: unknown): T[] {
  if (!json || typeof json !== "object") return [];
  const alerts = (json as { Alerts?: unknown }).Alerts;
  return Array.isArray(alerts) ? (alerts as T[]) : [];
}

async function fetchBusCityAlerts(city: string): Promise<BusAlert[]> {
  return getStoreOrFetch(
    `bus:city:${city}`,
    `${alertUrl.busCityUrl(city)}${TDX_JSON_FORMAT_QUERY}`,
    bareAlertArray<BusAlert>,
  );
}

async function fetchBusInterCityAlerts(): Promise<BusAlert[]> {
  return getStoreOrFetch(
    "bus:intercity",
    `${alertUrl.busInterCityUrl}${TDX_JSON_FORMAT_QUERY}`,
    bareAlertArray<BusAlert>,
  );
}

async function fetchMetroAlerts(railSystem: string): Promise<MetroAlert[]> {
  return getStoreOrFetch(
    `metro:${railSystem}`,
    `${metroUrl.alertUrl(railSystem)}${TDX_JSON_FORMAT_QUERY}`,
    envelopeAlerts<MetroAlert>,
  );
}

async function fetchTraAlerts(): Promise<TraAlert[]> {
  return getStoreOrFetch(
    "tra",
    `${alertUrl.traAlertUrl}${TDX_JSON_FORMAT_QUERY}`,
    envelopeAlerts<TraAlert>,
  );
}

async function fetchThsrAlerts(): Promise<ThsrAlert[]> {
  return getStoreOrFetch(
    "thsr",
    `${alertUrl.thsrAlertUrl}${TDX_JSON_FORMAT_QUERY}`,
    (json) =>
      Array.isArray(json)
        ? bareAlertArray<ThsrAlert>(json)
        : envelopeAlerts<ThsrAlert>(json),
  );
}

function active(alert: Pick<AlertMetadata, "StartTime" | "EndTime">): boolean {
  const now = Date.now();
  return (
    (alert.StartTime == null || now >= new Date(alert.StartTime).getTime()) &&
    (alert.EndTime == null || now <= new Date(alert.EndTime).getTime())
  );
}

function dirMatch(
  alertDirection: number | null | undefined,
  contextDirection?: number,
  bothWaysIsWildcard = false,
): boolean {
  // 使用者未指定方向 → 視為全方向都 match（否則有方向 scope 的 alert 會被漏掉）
  if (contextDirection == null) return true;
  if (alertDirection == null || alertDirection === DIRECTION_UNKNOWN)
    return true;
  if (bothWaysIsWildcard && alertDirection === DIRECTION_BOTH_WAYS) return true;
  return alertDirection === contextDirection;
}

export async function resolveBusRouteKeys(
  ctx: Extract<TransitContext, { mode: "bus" }>,
): Promise<BusRouteKeys | null> {
  let docs: BusRouteLookupRow[] = [];
  try {
    docs = await findBusRoutesByName(ctx.city, [
      formatRouteName(ctx.routeName),
      ctx.routeName.trim(),
    ]);
  } catch {
    docs = [];
  }
  const stopIds = [
    ...(ctx.stopUids ?? []),
    ...(ctx.stopUid ? [ctx.stopUid] : []),
  ];
  if (!docs.length) {
    const rawName = ctx.routeName?.trim();
    const fmtName = formatRouteName(ctx.routeName);
    const subRouteNames = [
      ...new Set([rawName, fmtName].filter((s): s is string => Boolean(s))),
    ];
    return {
      routeIds: [],
      subRouteNames,
      stopIds,
    };
  }

  const scoped =
    ctx.direction == null
      ? docs
      : docs.filter((doc) => doc.direction === ctx.direction);
  return {
    routeIds: [
      ...new Set(
        scoped
          .map((doc) => doc.routeId)
          .filter((routeId): routeId is string => Boolean(routeId)),
      ),
    ],
    subRouteNames: [
      ...new Set([
        ...scoped
          .map((doc) => doc.subRouteName?.Zh_tw)
          .filter((name): name is string => Boolean(name)),
        ctx.routeName.trim(),
        formatRouteName(ctx.routeName),
      ]),
    ],
    stopIds,
  };
}

function textMentionsAnyStop(
  text: string,
  stopNames: string[],
  stopIds: string[],
): boolean {
  for (const id of stopIds) {
    if (id && text.includes(id)) return true;
  }
  const normText = text.replace(/[\s()（）「」『』【】、，,。-]/g, "");
  for (const name of stopNames) {
    if (!name || name.length < 2) continue;
    const normName = name.replace(/[\s()（）「」『』【】、，,。-]/g, "");
    if (normText.includes(normName)) return true;
    const tai1 = normName.replace(/臺/g, "台");
    const tai2 = normName.replace(/台/g, "臺");
    if (normText.includes(tai1) || normText.includes(tai2)) return true;
    const base = normName.replace(/(?:公車)?(?:招呼)?站$/g, "");
    if (
      base.length >= 2 &&
      (normText.includes(base) ||
        normText.includes(base.replace(/臺/g, "台")) ||
        normText.includes(base.replace(/台/g, "臺")))
    ) {
      return true;
    }
  }
  return false;
}

const STOP_DISRUPTION_KEYWORD_REGEX =
  /取消停靠|臨時站位|站牌遷移|不停靠|暫不停靠|站位調整|招呼站|站位暫停|請至.+候車|移至.+候車|不停[^\n，。、]{1,10}站/;

function isStopSpecificTextDisruption(
  title?: string,
  description?: string,
): boolean {
  const text = `${title ?? ""} ${description ?? ""}`;
  return STOP_DISRUPTION_KEYWORD_REGEX.test(text);
}

function matchBus(
  alert: BusAlert,
  keys: BusRouteKeys,
  ctx: Extract<TransitContext, { mode: "bus" }>,
): Match | null {
  const scope = alert.Scope ?? {};

  // 1. 檢查此通阻是否屬於該路線（使用嚴格路線名稱比對，避免 "3" 或 "302" 誤配 "30"）
  const routeMatch = scope.Routes?.some(
    (route) =>
      (keys.routeIds.includes(route.RouteID) ||
        equalRouteName(route.RouteName?.Zh_tw, ctx.routeName) ||
        keys.subRouteNames.some((name) =>
          equalRouteName(route.RouteName?.Zh_tw, name),
        )) &&
      dirMatch(route.Direction, ctx.direction),
  );

  const subRouteMatch = scope.SubRoutes?.some(
    (subRoute) =>
      (equalRouteName(subRoute.SubRouteName?.Zh_tw, ctx.routeName) ||
        keys.subRouteNames.some((name) =>
          equalRouteName(subRoute.SubRouteName?.Zh_tw, name),
        )) &&
      dirMatch(subRoute.Direction, ctx.direction),
  );

  const hasRouteScope = Boolean(
    scope.Routes?.length || scope.SubRoutes?.length,
  );
  if (hasRouteScope && !routeMatch && !subRouteMatch) {
    return null;
  }

  // 2. 當通阻為特定站點異動（如施工取消停靠/遷移站牌/臨時站位）
  const candidateStopNames = [
    ...(ctx.stopNames ?? []),
    ...(ctx.stopName ? [ctx.stopName] : []),
  ].filter((s): s is string => Boolean(s));

  const hasSpecificStops =
    (scope.Stops && scope.Stops.length > 0) ||
    (scope.Stations && scope.Stations.length > 0);

  const alertText = `${alert.Title ?? ""} ${alert.Description ?? ""}`;
  const isStopDisruption =
    hasSpecificStops ||
    isStopSpecificTextDisruption(alert.Title, alert.Description);

  if (isStopDisruption) {
    if (
      scope.Stops?.some(
        (stop) =>
          keys.stopIds.includes(stop.StopID) ||
          candidateStopNames.some((name) =>
            equalStopName(stop.StopName?.Zh_tw, name),
          ),
      )
    ) {
      return { kind: "stop" };
    }
    if (
      scope.Stations?.some((station) => {
        const sName =
          typeof station.StationName === "string"
            ? station.StationName
            : station.StationName?.Zh_tw;
        return (
          keys.stopIds.includes(station.StationID) ||
          (sName &&
            candidateStopNames.some((name) => equalStopName(sName, name)))
        );
      })
    ) {
      return { kind: "station" };
    }
    if (textMentionsAnyStop(alertText, candidateStopNames, keys.stopIds)) {
      return { kind: "stop" };
    }

    // 若為特定站點異動，且使用者有提供行程站點但均不包含在內，則判定不影響此行程
    const userProvidedAnyStop =
      keys.stopIds.length > 0 || candidateStopNames.length > 0;
    if (userProvidedAnyStop) {
      return null;
    }
  }

  if (routeMatch || subRouteMatch) {
    return { kind: "route" };
  }

  return null;
}

function matchMetro(
  alert: MetroAlert,
  ctx: Extract<TransitContext, { mode: "metro" }>,
): Match | null {
  const scope = alert.Scope ?? {};
  const hasSpecificStations = scope.Stations && scope.Stations.length > 0;

  if (hasSpecificStations) {
    if (
      scope.Stations?.some((station) =>
        typeof station === "string"
          ? ctx.stationIds?.includes(station)
          : ctx.stationIds?.includes(station.StationID),
      )
    ) {
      return { kind: "station" };
    }
    if (ctx.stationIds && ctx.stationIds.length > 0) {
      return null;
    }
  }

  if (
    ctx.lineCode &&
    scope.Lines?.some((line) =>
      typeof line === "string"
        ? line === ctx.lineCode
        : line.LineID === ctx.lineCode,
    )
  ) {
    return { kind: "line" };
  }
  return null;
}

function isStationIdWithinSection(
  stationId: string,
  startingStationId: string,
  endingStationId: string,
): boolean {
  if (
    /^\d+$/.test(stationId) &&
    /^\d+$/.test(startingStationId) &&
    /^\d+$/.test(endingStationId)
  ) {
    const station = Number(stationId);
    const start = Number(startingStationId);
    const end = Number(endingStationId);
    return station >= Math.min(start, end) && station <= Math.max(start, end);
  }

  const [lower, upper] =
    startingStationId <= endingStationId
      ? [startingStationId, endingStationId]
      : [endingStationId, startingStationId];
  return stationId >= lower && stationId <= upper;
}

function covers(
  section: AlertLineSection,
  stationIds: Array<string | undefined> | undefined,
): boolean {
  const requestedStationIds = (stationIds ?? []).filter(
    (stationId): stationId is string => Boolean(stationId),
  );
  if (!requestedStationIds.length) return false;
  return requestedStationIds.some((stationId) =>
    isStationIdWithinSection(
      stationId,
      section.StartingStationID,
      section.EndingStationID,
    ),
  );
}

function matchTra(
  alert: TraAlert,
  ctx: Extract<TransitContext, { mode: "tra" }>,
): Match | null {
  if (!dirMatch(alert.Direction, ctx.direction, true)) return null;
  const scope = alert.Scope ?? {};
  if (
    ctx.trainNo &&
    scope.Trains?.some((train) => train.TrainNo === ctx.trainNo)
  ) {
    return { kind: "train" };
  }
  if (
    scope.Stations?.some((station) =>
      ctx.stationIds?.includes(station.StationID),
    )
  ) {
    return { kind: "station" };
  }
  if (scope.LineSections?.some((section) => covers(section, ctx.stationIds))) {
    return { kind: "section" };
  }
  const hasSpecificScope =
    (scope.Trains && scope.Trains.length > 0) ||
    (scope.Stations && scope.Stations.length > 0) ||
    (scope.LineSections && scope.LineSections.length > 0);

  if (
    !hasSpecificScope &&
    ctx.lineId &&
    scope.Lines?.some((line) => line.LineID === ctx.lineId)
  ) {
    return { kind: "line" };
  }
  return null;
}

function matchThsr(
  alert: ThsrAlert,
  ctx: Extract<TransitContext, { mode: "thsr" }>,
): Match | null {
  if (!dirMatch(alert.Direction, ctx.direction, true)) return null;
  if (
    alert.Scope?.LineSections?.some((section) =>
      covers(section, [ctx.fromStationId, ctx.toStationId]),
    )
  ) {
    return { kind: "section" };
  }
  return null;
}

function updateTimeValue(value?: string): number {
  if (!value) return 0;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function toMatchedAlert(alert: AlertMetadata, match: Match): MatchedAlert {
  const matched: MatchedAlert = {
    alertId: alert.AlertID,
    title: alert.Title,
    description: alert.Description,
    status: alert.Status,
    matchKind: match.kind,
    startTime: alert.StartTime,
    endTime: alert.EndTime,
  };
  if (alert.Cause != null) matched.cause = alert.Cause;
  if (alert.Effect != null) matched.effect = alert.Effect;
  if (alert.Level != null) matched.level = alert.Level;
  if (alert.Reason != null) matched.reason = alert.Reason;
  const sourceAlertUrl = alert.AlertURL ?? alert.AlertUrl;
  if (sourceAlertUrl != null) matched.alertUrl = sourceAlertUrl;
  return matched;
}

function success<T extends AlertMetadata>(
  mode: TransitContext["mode"],
  candidates: AlertCandidate<T>[],
): TransitAlertSuccess {
  const sorted = candidates.sort((left, right) => {
    const priority =
      MATCH_KIND_PRIORITY[right.match.kind] -
      MATCH_KIND_PRIORITY[left.match.kind];
    return (
      priority ||
      updateTimeValue(right.alert.UpdateTime) -
        updateTimeValue(left.alert.UpdateTime)
    );
  });

  // Deduplicate by AlertID so multi-subroute TDX entries only return ONE unique alert
  const uniqueAlertsMap = new Map<string, MatchedAlert>();
  for (const { alert, match } of sorted) {
    if (!uniqueAlertsMap.has(alert.AlertID)) {
      uniqueAlertsMap.set(alert.AlertID, toMatchedAlert(alert, match));
    }
  }

  return {
    ok: true,
    mode,
    matchedAt: new Date().toISOString(),
    alerts: [...uniqueAlertsMap.values()],
  };
}

function failure(
  error: string,
  status: TransitAlertFailure["status"],
): TransitAlertFailure {
  return { ok: false, error, status };
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "TDX alert query failed";
}

export async function getTransitAlerts(
  ctx: TransitContext,
): Promise<TransitAlertResult> {
  try {
    switch (ctx.mode) {
      case "bus": {
        const keys = await resolveBusRouteKeys(ctx);
        const alerts =
          ctx.city === INTERCITY_CITY
            ? await fetchBusInterCityAlerts()
            : await fetchBusCityAlerts(ctx.city);
        if (!keys) return success("bus", []);
        return success(
          "bus",
          alerts.flatMap((alert) => {
            if (!active(alert) || alert.Status === NORMAL_NUMERIC_ALERT_STATUS)
              return [];
            const match = matchBus(alert, keys, ctx);
            return match ? [{ alert, match }] : [];
          }),
        );
      }
      case "metro": {
        if (
          !SUPPORTED_METRO_SYSTEMS.includes(
            ctx.railSystem as SupportedMetroSystem,
          )
        ) {
          return failure(
            `Unsupported metro rail system: ${ctx.railSystem}`,
            ResponseCode.INVALID_INPUT,
          );
        }
        const alerts = await fetchMetroAlerts(ctx.railSystem);
        return success(
          "metro",
          alerts.flatMap((alert) => {
            if (!active(alert) || alert.Status === NORMAL_NUMERIC_ALERT_STATUS)
              return [];
            const match = matchMetro(alert, ctx);
            return match ? [{ alert, match }] : [];
          }),
        );
      }
      case "tra": {
        const alerts = await fetchTraAlerts();
        return success(
          "tra",
          alerts.flatMap((alert) => {
            if (!active(alert) || alert.Status === NORMAL_NUMERIC_ALERT_STATUS)
              return [];
            const match = matchTra(alert, ctx);
            return match ? [{ alert, match }] : [];
          }),
        );
      }
      case "thsr": {
        const alerts = await fetchThsrAlerts();
        return success(
          "thsr",
          alerts.flatMap((alert) => {
            if (!active(alert) || alert.Status === NORMAL_THSR_ALERT_STATUS)
              return [];
            const match = matchThsr(alert, ctx);
            return match ? [{ alert, match }] : [];
          }),
        );
      }
      default:
        return failure(
          `Unsupported transit mode: ${(ctx as { mode?: string }).mode ?? "unknown"}`,
          ResponseCode.INVALID_INPUT,
        );
    }
  } catch (error) {
    return failure(errorMessage(error), ResponseCode.INTERNAL_ERROR);
  }
}
