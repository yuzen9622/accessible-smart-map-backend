import { fetchRailStationIndex } from "../../adapters/rail.adapter";
import {
  fetchMetroNetwork,
  fetchTraLines,
  type TransitLine,
} from "../../adapters/transit-line.adapter";
import { normalizeStationName } from "../../utils/station-name";
import {
  getTransitAlerts,
  SUPPORTED_METRO_SYSTEMS,
  type MatchedAlert,
  type SupportedMetroSystem,
  type TransitContext,
} from "./alert.service";

/** A rail alert question as a person asks it: names, not TDX ids. */
export type RailAlertQuery = {
  mode: "metro" | "tra" | "thsr";
  railSystem?: string;
  lineName?: string;
  stationName?: string;
  trainNo?: string;
  direction?: number;
};

export type RailAlertScopeFailure = {
  ok: false;
  reason:
    | "UNSUPPORTED_RAIL_SYSTEM"
    | "UNKNOWN_LINE"
    | "UNKNOWN_STATION"
    | "SCOPE_REQUIRED"
    | "LOOKUP_UNAVAILABLE";
  error: string;
};

export type RailAlertResult =
  | { ok: true; mode: RailAlertQuery["mode"]; alerts: MatchedAlert[] }
  | RailAlertScopeFailure
  | { ok: false; reason: "ALERT_QUERY_FAILED"; error: string };

type ScopeResult =
  { ok: true; contexts: TransitContext[] } | RailAlertScopeFailure;

function fail(
  reason: RailAlertScopeFailure["reason"],
  error: string,
): RailAlertScopeFailure {
  return { ok: false, reason, error };
}

function lineKey(name: string): string {
  return name
    .replace(/\s/g, "")
    .replace(/台/g, "臺")
    .replace(/線$/, "")
    .toLowerCase();
}

function findLine(
  lines: TransitLine[],
  query: string,
): TransitLine | undefined {
  const key = lineKey(query);
  return lines.find(
    (line) => line.lineId.toLowerCase() === key || lineKey(line.name) === key,
  );
}

function unknownLine(
  query: string,
  lines: TransitLine[],
): RailAlertScopeFailure {
  return fail(
    "UNKNOWN_LINE",
    `找不到路線「${query}」，可用路線：${lines.map((line) => line.name).join("、")}`,
  );
}

function directionOf(direction?: number): 0 | 1 | undefined {
  return direction === 0 || direction === 1 ? direction : undefined;
}

async function railStationId(
  system: "TRA" | "THSR",
  stationName: string,
): Promise<string | RailAlertScopeFailure> {
  if (/^\d{4}$/.test(stationName)) return stationName;
  const outcome = await fetchRailStationIndex(system);
  if (!outcome.ok) {
    return fail("LOOKUP_UNAVAILABLE", "車站資料暫時無法取得，請稍後再試");
  }
  return (
    outcome.index.get(normalizeStationName(stationName)) ??
    fail("UNKNOWN_STATION", `找不到車站「${stationName}」`)
  );
}

async function metroScope(query: RailAlertQuery): Promise<ScopeResult> {
  const railSystem = (query.railSystem ?? "TRTC").toUpperCase();
  if (!SUPPORTED_METRO_SYSTEMS.includes(railSystem as SupportedMetroSystem)) {
    return fail(
      "UNSUPPORTED_RAIL_SYSTEM",
      `捷運系統「${railSystem}」沒有即時通阻資料，可查詢：${SUPPORTED_METRO_SYSTEMS.join("、")}`,
    );
  }
  if (!query.lineName && !query.stationName) {
    return fail(
      "SCOPE_REQUIRED",
      "請提供捷運路線或車站名稱；要看整個系統的營運狀態請改用 getMetroAlerts",
    );
  }

  let network;
  try {
    network = await fetchMetroNetwork(railSystem);
  } catch {
    return fail("LOOKUP_UNAVAILABLE", "捷運路網資料暫時無法取得，請稍後再試");
  }

  const line = query.lineName
    ? findLine(network.lines, query.lineName)
    : undefined;
  if (query.lineName && !line)
    return unknownLine(query.lineName, network.lines);

  const stations = query.stationName
    ? network.stations.filter(
        (station) =>
          (station.stationId === query.stationName ||
            normalizeStationName(station.name) ===
              normalizeStationName(query.stationName!)) &&
          (!line || station.lineId === line.lineId),
      )
    : [];
  if (query.stationName && !stations.length) {
    return fail(
      "UNKNOWN_STATION",
      line
        ? `${line.name}沒有「${query.stationName}」站`
        : `找不到捷運站「${query.stationName}」`,
    );
  }

  const stationIds = stations.length
    ? [...new Set(stations.map((station) => station.stationId))]
    : undefined;
  const lineIds = line
    ? [line.lineId]
    : [...new Set(stations.map((station) => station.lineId))];
  return {
    ok: true,
    contexts: lineIds.map((lineCode) => ({
      mode: "metro",
      railSystem,
      lineCode,
      stationIds,
    })),
  };
}

async function traScope(query: RailAlertQuery): Promise<ScopeResult> {
  if (!query.trainNo && !query.lineName && !query.stationName) {
    return fail("SCOPE_REQUIRED", "請提供台鐵車次、路線或車站名稱");
  }
  let lineId: string | undefined;
  if (query.lineName) {
    let lines: TransitLine[];
    try {
      lines = await fetchTraLines();
    } catch {
      return fail("LOOKUP_UNAVAILABLE", "台鐵路線資料暫時無法取得，請稍後再試");
    }
    const line = findLine(lines, query.lineName);
    if (!line) return unknownLine(query.lineName, lines);
    lineId = line.lineId;
  }
  let stationIds: string[] | undefined;
  if (query.stationName) {
    const stationId = await railStationId("TRA", query.stationName);
    if (typeof stationId !== "string") return stationId;
    stationIds = [stationId];
  }
  return {
    ok: true,
    contexts: [
      {
        mode: "tra",
        trainNo: query.trainNo,
        lineId,
        stationIds,
        direction: directionOf(query.direction),
      },
    ],
  };
}

async function thsrScope(query: RailAlertQuery): Promise<ScopeResult> {
  if (!query.stationName) {
    return fail(
      "SCOPE_REQUIRED",
      "高鐵通阻依路段公告，無法用車次比對，請提供上車或下車站名",
    );
  }
  const stationId = await railStationId("THSR", query.stationName);
  if (typeof stationId !== "string") return stationId;
  return {
    ok: true,
    contexts: [
      {
        mode: "thsr",
        fromStationId: stationId,
        direction: directionOf(query.direction),
      },
    ],
  };
}

function resolveScope(query: RailAlertQuery): Promise<ScopeResult> {
  switch (query.mode) {
    case "metro":
      return metroScope(query);
    case "tra":
      return traScope(query);
    case "thsr":
      return thsrScope(query);
  }
}

/**
 * Look up rail alerts from line/station names. Names are resolved to the TDX
 * ids the matcher compares, and an unknown name is an explicit failure rather
 * than an empty (= "operating normally") result.
 *
 * @param query The rail alert question in user-facing names.
 * @returns Matched alerts, or why the names could not be resolved.
 */
export async function getRailAlertsByName(
  query: RailAlertQuery,
): Promise<RailAlertResult> {
  const scope = await resolveScope(query);
  if (!scope.ok) return scope;

  const results = await Promise.all(scope.contexts.map(getTransitAlerts));
  const failed = results.find((result) => !result.ok);
  if (failed && !failed.ok) {
    return { ok: false, reason: "ALERT_QUERY_FAILED", error: failed.error };
  }
  const alerts = new Map<string, MatchedAlert>();
  for (const result of results) {
    if (!result.ok) continue;
    for (const alert of result.alerts) {
      if (!alerts.has(alert.alertId)) alerts.set(alert.alertId, alert);
    }
  }
  return { ok: true, mode: query.mode, alerts: [...alerts.values()] };
}
