import { tdxFetch } from "../../config/fetch";
import { metroUrl } from "../../config/transit";
import MetroStationModel from "../../model/metro-station.model";
import type { MetroAlert, MetroAlertResult } from "../../types/transit";

export type { MetroAlert, MetroAlertResult };

const SUPPORTED_METRO_SYSTEMS = [
  "TRTC",
  "KRTC",
  "TYMC",
  "TMRT",
  "KLRT",
  "TRTCMG",
] as const;
type MetroRailSystem = (typeof SUPPORTED_METRO_SYSTEMS)[number];

interface TdxMetroAlert {
  AlertID: string;
  Title: string;
  Description: string;
  Status: number;
  Scope?: {
    Stations?: string[];
    Lines?: string[];
  };
  PublishTime: string;
  UpdateTime: string;
}

interface TdxMetroAlertResponse {
  UpdateTime: string;
  AuthorityCode: string;
  Alerts: TdxMetroAlert[];
}

const NORMAL_ALERT_TITLES = new Set(["正常營運", "目前全線正常營運"]);

/** TDX refreshes the alert feed once a minute, so a shorter TTL only adds load. */
const METRO_ALERT_CACHE_TTL_MS = 60_000;
const METRO_ALERT_FETCH_TIMEOUT_MS = 5_000;
const alertCache = new Map<
  string,
  { data: TdxMetroAlertResponse; expiresAt: number }
>();

/** Drop every cached alert payload (tests, or a forced refresh). */
export function clearMetroAlertsCache(): void {
  alertCache.clear();
}

async function fetchMetroAlerts(
  railSystem: string,
): Promise<TdxMetroAlertResponse> {
  const cached = alertCache.get(railSystem);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  // Fail-open guard: a hanging TDX request must never stall route planning,
  // which awaits these lookups through Promise.allSettled.
  const response = await tdxFetch(
    `${metroUrl.alertUrl(railSystem)}?$format=JSON`,
    { signal: AbortSignal.timeout(METRO_ALERT_FETCH_TIMEOUT_MS) },
  );
  if (!response.ok) throw new Error(`TDX ${response.status}`);
  const data = (await response.json()) as TdxMetroAlertResponse;
  alertCache.set(railSystem, {
    data,
    expiresAt: Date.now() + METRO_ALERT_CACHE_TTL_MS,
  });
  return data;
}

/**
 * Fetch current abnormal operating alerts for one or all supported metro systems.
 */
export async function getMetroAlerts(
  railSystem?: string,
): Promise<MetroAlertResult[]> {
  if (
    railSystem !== undefined &&
    !SUPPORTED_METRO_SYSTEMS.includes(railSystem as MetroRailSystem)
  ) {
    throw new Error(`Unsupported metro rail system: ${railSystem}`);
  }

  const railSystems =
    railSystem === undefined ? [...SUPPORTED_METRO_SYSTEMS] : [railSystem];
  const responses = await Promise.all(
    railSystems.map(async (system) => ({
      railSystem: system,
      data: await fetchMetroAlerts(system),
    })),
  );

  const stationIds = Array.from(
    new Set(
      responses.flatMap(({ data }) =>
        data.Alerts.filter(
          (alert) => !NORMAL_ALERT_TITLES.has(alert.Title),
        ).flatMap((alert) => alert.Scope?.Stations ?? []),
      ),
    ),
  );
  const stations =
    stationIds.length === 0
      ? []
      : await MetroStationModel.find({
          stationUid: { $in: stationIds },
        }).lean();
  const stationNames = new Map(
    stations.map((station) => [station.stationUid, station.stationName.Zh_tw]),
  );

  return responses.map(({ railSystem: system, data }) => ({
    railSystem: system,
    updatedAt: data.UpdateTime,
    alerts: data.Alerts.filter(
      (alert) => !NORMAL_ALERT_TITLES.has(alert.Title),
    ).map((alert) => ({
      alertId: alert.AlertID,
      title: alert.Title,
      description: alert.Description,
      status: alert.Status,
      stations: (alert.Scope?.Stations ?? []).map((id) => ({
        id,
        name: stationNames.get(id) ?? null,
      })),
      lines: alert.Scope?.Lines ?? [],
      publishTime: alert.PublishTime,
      updateTime: alert.UpdateTime,
    })),
  }));
}
