import axios from "axios";
import { addTaipeiDays, taipeiYmd } from "../../../config/taipei-time";

const FRESHNESS_TIMEOUT_MS = 20_000;
const FRESHNESS_REFRESH_MS = Number(
  process.env.OTP_FRESHNESS_REFRESH_MS ?? 30 * 60_000,
);
const FRESHNESS_RETRY_MS = 60_000;
const LOOKAHEAD_DAYS = 7;

const FRESHNESS_QUERY = `
query Freshness($today: String!, $ahead: String!) {
  serviceTimeRange { end }
  routes(transportModes: [RAIL, SUBWAY, TRAM, MONORAIL]) {
    agency { gtfsId name }
    patterns {
      today: tripsForDate(serviceDate: $today) { gtfsId }
      ahead: tripsForDate(serviceDate: $ahead) { gtfsId }
    }
  }
}`;

const ACTIVE_DATES_QUERY = `
query AgencyActiveDates($agency: String!) {
  agency(id: $agency) {
    routes { patterns { trips { activeDates } } }
  }
}`;

export type AgencyFreshnessStatus = "ok" | "expiring" | "expired";

export interface AgencyFreshness {
  agency: string;
  name: string;
  routes: number;
  tripsToday: number;
  tripsInLookahead: number;
  status: AgencyFreshnessStatus;
}

export interface TransitDataFreshness {
  checkedAt: string;
  serviceDate: string;
  lookaheadDate: string;
  serviceEnd: string | null;
  stale: boolean;
  agencies: AgencyFreshness[];
}

interface FreshnessResponse {
  data?: {
    serviceTimeRange?: { end?: number | null } | null;
    routes?: {
      agency?: { gtfsId?: string; name?: string } | null;
      patterns?: { today?: unknown[]; ahead?: unknown[] }[] | null;
    }[];
  };
  errors?: { message?: string }[];
}

interface ActiveDatesResponse {
  data?: {
    agency?: {
      routes?: { patterns?: { trips?: { activeDates?: string[] }[] }[] }[];
    } | null;
  };
  errors?: { message?: string }[];
}

let latest: TransitDataFreshness | null = null;

/**
 * Classify one operator from its trip counts.
 *
 * @param tripsToday Trips the graph runs today.
 * @param tripsInLookahead Trips it runs on the lookahead date.
 * @returns Expired when nothing runs today, expiring when nothing runs on the
 *   lookahead date, otherwise ok.
 */
function classify(
  tripsToday: number,
  tripsInLookahead: number,
): AgencyFreshnessStatus {
  if (tripsToday === 0) return "expired";
  if (tripsInLookahead === 0) return "expiring";
  return "ok";
}

/**
 * Summarise an OTP freshness response per rail/metro operator.
 *
 * @param body The GraphQL response body.
 * @param now The check instant.
 * @returns The freshness snapshot.
 */
export function summariseFreshness(
  body: FreshnessResponse,
  now: Date,
): TransitDataFreshness {
  if (body.errors?.length) {
    throw new Error(
      `OTP freshness query failed: ${body.errors[0]?.message ?? "unknown"}`,
    );
  }
  const byAgency = new Map<string, AgencyFreshness>();
  for (const route of body.data?.routes ?? []) {
    const agency = route.agency?.gtfsId ?? "unknown";
    const entry = byAgency.get(agency) ?? {
      agency,
      name: route.agency?.name ?? agency,
      routes: 0,
      tripsToday: 0,
      tripsInLookahead: 0,
      status: "ok" as AgencyFreshnessStatus,
    };
    entry.routes += 1;
    for (const pattern of route.patterns ?? []) {
      entry.tripsToday += pattern.today?.length ?? 0;
      entry.tripsInLookahead += pattern.ahead?.length ?? 0;
    }
    byAgency.set(agency, entry);
  }
  const agencies = [...byAgency.values()]
    .map((entry) => ({
      ...entry,
      status: classify(entry.tripsToday, entry.tripsInLookahead),
    }))
    .sort((a, b) => a.agency.localeCompare(b.agency));
  const end = body.data?.serviceTimeRange?.end;
  return {
    checkedAt: now.toISOString(),
    serviceDate: taipeiYmd(now),
    lookaheadDate: taipeiYmd(addTaipeiDays(now, LOOKAHEAD_DAYS)),
    serviceEnd:
      typeof end === "number" ? new Date(end * 1000).toISOString() : null,
    stale: agencies.some((agency) => agency.status === "expired"),
    agencies,
  };
}

/**
 * Recount one operator from each trip's active service dates.
 * `tripsForDate` omits frequency-based (headway) trips, so an operator that
 * runs only on headways — Taichung MRT — reads as zero without this.
 *
 * @param entry The operator entry to update.
 * @param body The agency active-dates response.
 * @param today Today as "YYYYMMDD".
 * @param ahead The lookahead date as "YYYYMMDD".
 * @returns The entry with counts and status recomputed.
 */
export function recountFromActiveDates(
  entry: AgencyFreshness,
  body: ActiveDatesResponse,
  today: string,
  ahead: string,
): AgencyFreshness {
  let tripsToday = 0;
  let tripsInLookahead = 0;
  for (const route of body.data?.agency?.routes ?? []) {
    for (const pattern of route.patterns ?? []) {
      for (const trip of pattern.trips ?? []) {
        const dates = trip.activeDates ?? [];
        if (dates.includes(today)) tripsToday += 1;
        if (dates.includes(ahead)) tripsInLookahead += 1;
      }
    }
  }
  return {
    ...entry,
    tripsToday,
    tripsInLookahead,
    status: classify(tripsToday, tripsInLookahead),
  };
}

/**
 * Ask OTP which rail and metro operators still run trips today and on the
 * lookahead date. Bus calendars span the graph's full service range, so the
 * reported `serviceEnd` covers them.
 *
 * @param now The check instant.
 * @returns The fresh snapshot, also cached for {@link getTransitDataFreshness}.
 */
export async function refreshTransitDataFreshness(
  now: Date = new Date(),
): Promise<TransitDataFreshness> {
  const baseUrl = process.env.OTP_BASE_URL ?? "http://localhost:8080";
  const response = await axios.post(
    `${baseUrl}/otp/routers/default/index/graphql`,
    {
      query: FRESHNESS_QUERY,
      variables: {
        today: taipeiYmd(now),
        ahead: taipeiYmd(addTaipeiDays(now, LOOKAHEAD_DAYS)),
      },
    },
    { timeout: FRESHNESS_TIMEOUT_MS },
  );
  let snapshot = summariseFreshness(response.data as FreshnessResponse, now);
  const agencies = await Promise.all(
    snapshot.agencies.map(async (entry) => {
      if (entry.status === "ok") return entry;
      const recount = await axios.post(
        `${baseUrl}/otp/routers/default/index/graphql`,
        { query: ACTIVE_DATES_QUERY, variables: { agency: entry.agency } },
        { timeout: FRESHNESS_TIMEOUT_MS },
      );
      return recountFromActiveDates(
        entry,
        recount.data as ActiveDatesResponse,
        snapshot.serviceDate,
        snapshot.lookaheadDate,
      );
    }),
  );
  snapshot = {
    ...snapshot,
    agencies,
    stale: agencies.some((agency) => agency.status === "expired"),
  };
  latest = snapshot;
  const expired = snapshot.agencies.filter((a) => a.status === "expired");
  const expiring = snapshot.agencies.filter((a) => a.status === "expiring");
  if (expired.length) {
    console.error(
      "[otp-freshness] transit timetables expired — rebuild the OTP graph",
      JSON.stringify({
        serviceDate: snapshot.serviceDate,
        expired: expired.map((a) => a.agency),
      }),
    );
  } else if (expiring.length) {
    console.warn(
      "[otp-freshness] transit timetables expire within the lookahead window",
      JSON.stringify({
        lookaheadDate: snapshot.lookaheadDate,
        expiring: expiring.map((a) => a.agency),
      }),
    );
  }
  return snapshot;
}

/**
 * @returns The most recent freshness snapshot, or null before the first check.
 */
export function getTransitDataFreshness(): TransitDataFreshness | null {
  return latest;
}

/**
 * Check freshness now and keep re-checking; a failed check (OTP still loading
 * its graph, or unreachable) retries after a minute.
 *
 * @returns A stop function that cancels the pending check.
 */
export function startTransitFreshnessJob(): () => void {
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  const schedule = (delayMs: number) => {
    if (stopped) return;
    timer = setTimeout(run, delayMs);
    timer.unref?.();
  };
  const run = () => {
    refreshTransitDataFreshness()
      .then(() => schedule(FRESHNESS_REFRESH_MS))
      .catch((err: unknown) => {
        console.warn(
          "[otp-freshness] check failed; retrying",
          err instanceof Error ? err.message : err,
        );
        schedule(FRESHNESS_RETRY_MS);
      });
  };
  run();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
