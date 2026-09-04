/**
 * Navigation advisory classification.
 *
 * This module owns the single authoritative severity table for corridor
 * findings: `corridor-monitor.ts` gathers raw facts and `live-bridge.ts`
 * transports them, but neither decides how serious a finding is. Keeping the
 * decision here is what makes "critical always implies a backend reroute"
 * checkable in one place.
 *
 * Pure functions only — no I/O, no clock beyond an injectable `now`.
 */

import type { HazardSeverity, HazardType } from "../../types";
import type { RerouteReason } from "../accessible-route/accessible-route.types";

/** Severity. `critical` is always accompanied by a backend reroute. */
export type NavAdvisorySeverity = "info" | "warning" | "critical";

/** Origin of the event. */
export type NavAdvisoryCategory =
  "facility" | "transit_alert" | "hazard" | "traffic";

/**
 * What the backend did about this event.
 * - none: informational only, no reroute suggested
 * - reroute_suggested: the user decides (client shows both buttons)
 * - reroute_applied: the backend already rerouted; a nav.route_replaced follows
 */
export type NavAdvisoryAction =
  "none" | "reroute_suggested" | "reroute_applied";

export interface NavAdvisory {
  /** Stable dedup key: `${category}:${sourceId}`. Broadcast once per TTL. */
  advisoryId: string;
  category: NavAdvisoryCategory;
  severity: NavAdvisorySeverity;
  action: NavAdvisoryAction;
  /** Single-line headline, the client card's primary text. */
  title: string;
  /** Optional elaboration. */
  detail?: string;
  /** Full spoken text. The client must not assemble its own. */
  speech: string;
  /** Required when action !== "none"; also backfills the client's HTTP reroute. */
  rerouteReason?: RerouteReason;
  /** Where on the remaining corridor the event sits, when locatable. */
  location?: { latitude: number; longitude: number };
  /** Along-route distance from the user's current position, in metres. */
  distanceAheadM?: number;
  /** Issue time, ISO 8601. */
  issuedAt: string;
}

/** A raw, unclassified fact handed over by the corridor scanner. */
export type CorridorFinding =
  | {
      category: "hazard";
      hazardId: string;
      hazardType: HazardType;
      severity: HazardSeverity;
      description?: string;
      location: { latitude: number; longitude: number };
      distanceAheadM: number;
    }
  | {
      category: "facility";
      railSystem: string;
      stationId: string;
      stationName: string;
      elevatorKey: string;
      keyword: string;
      description: string;
    }
  | {
      category: "transit_alert";
      alertId: string;
      title: string;
      description: string;
    };

export interface ClassifyContext {
  /** canonicalRequest.requireElevator */
  requireElevator: boolean;
  /** NavigationSession.getSnapshotState().onVehicle */
  onVehicle: boolean;
  /** Injectable for tests; defaults to () => new Date().toISOString() */
  now?: () => string;
}

export const ADVISORY_DEDUP_TTL_MS = 10 * 60_000;

const BLOCKING_ALERT_RE =
  /停駛|停止營運|全線暫停|暫停營運|封閉|不停靠|取消班次/;

const CATEGORY_PRIORITY: Record<NavAdvisoryCategory, number> = {
  hazard: 3,
  facility: 2,
  transit_alert: 1,
  traffic: 0,
};

const SEVERITY_RANK: Record<NavAdvisorySeverity, number> = {
  critical: 3,
  warning: 2,
  info: 1,
};

const HAZARD_TYPE_LABEL: Record<HazardType, string> = {
  obstacle: "障礙物",
  construction: "施工",
  data_error: "資料錯誤",
};

const TRANSIT_TITLE_MAX = 60;

/** Severity ordering, highest first. Stable for equal severities. */
export function compareAdvisorySeverity(
  a: NavAdvisory,
  b: NavAdvisory,
): number {
  return SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
}

/**
 * Turns one raw fact into an advisory using the authoritative severity table.
 *
 * @param finding The unclassified corridor fact.
 * @param ctx The route preferences and vehicle state that gate the severity.
 * @returns The classified advisory, ready to broadcast.
 */
export function classifyCorridorFinding(
  finding: CorridorFinding,
  ctx: ClassifyContext,
): NavAdvisory {
  const issuedAt = (ctx.now ?? (() => new Date().toISOString()))();

  if (finding.category === "hazard") {
    const typeLabel = HAZARD_TYPE_LABEL[finding.hazardType];
    const title =
      finding.distanceAheadM > 0
        ? `前方 ${Math.round(finding.distanceAheadM)} 公尺有${typeLabel}回報`
        : `前方有${typeLabel}回報`;
    const blocking = finding.severity === "blocking";
    const severity: NavAdvisorySeverity = blocking
      ? "critical"
      : finding.severity === "difficult"
        ? "warning"
        : "info";
    const action: NavAdvisoryAction = blocking
      ? "reroute_applied"
      : finding.severity === "difficult"
        ? "reroute_suggested"
        : "none";
    return {
      advisoryId: `hazard:${finding.hazardId}`,
      category: "hazard",
      severity,
      action,
      title,
      ...(finding.description ? { detail: finding.description } : {}),
      speech: `注意，${title}${blocking ? "，正在為你重新規劃路線" : ""}`,
      ...(action === "none"
        ? {}
        : { rerouteReason: "CONFIRMED_HAZARD" as const }),
      location: finding.location,
      distanceAheadM: finding.distanceAheadM,
      issuedAt,
    };
  }

  if (finding.category === "facility") {
    const title = `${finding.stationName}站電梯${finding.keyword}中`;
    const action: NavAdvisoryAction = ctx.requireElevator
      ? "reroute_applied"
      : "reroute_suggested";
    return {
      advisoryId: `facility:${finding.railSystem}:${finding.stationId}:${finding.elevatorKey}`,
      category: "facility",
      severity: ctx.requireElevator ? "critical" : "warning",
      action,
      title,
      ...(finding.description ? { detail: finding.description } : {}),
      speech: `注意，${title}${
        action === "reroute_applied"
          ? "，正在為你重新規劃路線"
          : "，可查看替代路線"
      }`,
      rerouteReason: "FACILITY_OUTAGE",
      issuedAt,
    };
  }

  const title = finding.title.slice(0, TRANSIT_TITLE_MAX);
  const blocking =
    !ctx.onVehicle &&
    BLOCKING_ALERT_RE.test(`${finding.title} ${finding.description}`);
  const action: NavAdvisoryAction = blocking ? "reroute_applied" : "none";
  return {
    advisoryId: `transit_alert:${finding.alertId}`,
    category: "transit_alert",
    severity: blocking ? "critical" : "warning",
    action,
    title,
    ...(finding.description ? { detail: finding.description } : {}),
    speech: `注意，即時通阻警報：${title}${
      blocking ? "，正在為你重新規劃路線" : ""
    }`,
    ...(action === "none"
      ? {}
      : { rerouteReason: "TRANSIT_DISRUPTION" as const }),
    issuedAt,
  };
}

/**
 * Applies R2: at most one `reroute_applied` survives a scan. Ties break on
 * hazard > facility > transit_alert; the losers drop to `reroute_suggested`.
 *
 * @param advisories The classified advisories from one scan.
 * @returns A new array plus the reason the backend should reroute with.
 */
export function selectRerouteTrigger(advisories: NavAdvisory[]): {
  advisories: NavAdvisory[];
  rerouteReason: RerouteReason | null;
} {
  const applied = advisories.filter((a) => a.action === "reroute_applied");
  if (!applied.length)
    return { advisories: [...advisories], rerouteReason: null };

  let winner = applied[0];
  for (const candidate of applied.slice(1)) {
    if (
      CATEGORY_PRIORITY[candidate.category] > CATEGORY_PRIORITY[winner.category]
    ) {
      winner = candidate;
    }
  }

  return {
    advisories: advisories.map((advisory) =>
      advisory.action === "reroute_applied" && advisory !== winner
        ? { ...advisory, action: "reroute_suggested" as const }
        : advisory,
    ),
    rerouteReason: winner.rerouteReason ?? null,
  };
}

/** TTL dedup gate keyed on `advisoryId`. */
export class AdvisoryDeduper {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly ttlMs: number = ADVISORY_DEDUP_TTL_MS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * Filters out advisories already broadcast inside the TTL and marks the rest
   * as broadcast.
   *
   * @param advisories The candidates for this scan.
   * @returns Only the advisories that may be broadcast now.
   */
  take(advisories: readonly NavAdvisory[]): NavAdvisory[] {
    const now = this.now();
    for (const [key, expiresAt] of this.seen) {
      if (expiresAt <= now) this.seen.delete(key);
    }
    const fresh: NavAdvisory[] = [];
    for (const advisory of advisories) {
      if (this.seen.has(advisory.advisoryId)) continue;
      this.seen.set(advisory.advisoryId, now + this.ttlMs);
      fresh.push(advisory);
    }
    return fresh;
  }

  clear(): void {
    this.seen.clear();
  }
}
