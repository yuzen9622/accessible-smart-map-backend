/** TDX Bus Schedule publishes only origin departures, so a mid-route stop's
 * timetable comes from the same GTFS feed OTP plans with. */
const BUS_FEED_ID = "1";
const SEARCH_WINDOW_S = 3 * 3600;
const QUERY = `query($ids: [String]!, $start: Long!, $range: Int!, $n: Int!) {
  stops(ids: $ids) {
    gtfsId
    stoptimesForPatterns(startTime: $start, timeRange: $range, numberOfDepartures: $n, omitNonPickups: true) {
      pattern { route { gtfsId } }
      stoptimes {
        serviceDay
        trip {
          gtfsId
          stoptimes { stop { gtfsId name lat lon } scheduledArrival scheduledDeparture }
        }
      }
    }
  }
}`;

export interface PairTimetableStop {
  stopUid: string;
  name: string;
  lat: number;
  lng: number;
  arrivalAt: number;
  departureAt: number;
}
/** One timetable trip, sliced from the boarding stop to the alighting stop. */
export interface PairTimetableTrip {
  tripId: string;
  subRouteUid: string;
  direction: 0 | 1;
  stops: PairTimetableStop[];
}

interface OtpStopTime {
  stop?: { gtfsId?: string; name?: string; lat?: number; lon?: number };
  scheduledArrival?: number;
  scheduledDeparture?: number;
}
interface OtpResponse {
  data?: {
    stops?: ({
      gtfsId?: string;
      stoptimesForPatterns?: {
        pattern?: { route?: { gtfsId?: string } };
        stoptimes?: {
          serviceDay?: number;
          trip?: { gtfsId?: string; stoptimes?: OtpStopTime[] };
        }[];
      }[];
    } | null)[];
  };
  errors?: { message?: string }[];
}

const local = (gtfsId: string | undefined) =>
  gtfsId?.slice(gtfsId.indexOf(":") + 1) ?? "";

function toStop(st: OtpStopTime, serviceDay: number): PairTimetableStop | null {
  const { stop } = st;
  if (
    !stop?.gtfsId ||
    typeof stop.lat !== "number" ||
    typeof stop.lon !== "number" ||
    typeof st.scheduledArrival !== "number" ||
    typeof st.scheduledDeparture !== "number"
  )
    return null;
  return {
    stopUid: local(stop.gtfsId),
    name: stop.name ?? "",
    lat: stop.lat,
    lng: stop.lon,
    arrivalAt: (serviceDay + st.scheduledArrival) * 1000,
    departureAt: (serviceDay + st.scheduledDeparture) * 1000,
  };
}

/** Next timetable trips of every pattern that boards at one of `boards` and
 * later calls at one of `alights`. Both are sets because one physical stop
 * carries a different id in TDX route data than in the GTFS feed. */
export async function getPairTimetableTrips(input: {
  boards: string[];
  alights: string[];
  now: number;
  perPattern: number;
  signal: AbortSignal;
}): Promise<PairTimetableTrip[]> {
  const boards = [...new Set(input.boards)];
  const alights = new Set(input.alights);
  if (!boards.length || !alights.size) return [];
  const baseUrl = process.env.OTP_BASE_URL ?? "http://localhost:8080";
  const res = await fetch(`${baseUrl}/otp/routers/default/index/graphql`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      query: QUERY,
      variables: {
        ids: boards.map((uid) => `${BUS_FEED_ID}:${uid}`),
        start: Math.floor(input.now / 1000),
        range: SEARCH_WINDOW_S,
        n: input.perPattern,
      },
    }),
    signal: input.signal,
  });
  if (!res.ok) throw new Error(`OTP timetable HTTP ${res.status}`);
  const json = (await res.json()) as OtpResponse;
  if (json.errors?.length)
    throw new Error(json.errors[0]?.message ?? "OTP timetable error");

  const trips = new Map<string, PairTimetableTrip>();
  for (const stop of json.data?.stops ?? []) {
    if (!stop) continue;
    const board = local(stop.gtfsId);
    for (const pattern of stop.stoptimesForPatterns ?? []) {
      const routeId = local(pattern.pattern?.route?.gtfsId);
      const direction = routeId.match(/_([01])$/)?.[1];
      if (direction === undefined) continue;
      for (const { serviceDay, trip } of pattern.stoptimes ?? []) {
        if (!trip?.gtfsId || typeof serviceDay !== "number") continue;
        const all = trip.stoptimes ?? [];
        const from = all.findIndex((s) => local(s.stop?.gtfsId) === board);
        const to = all.findIndex(
          (s, i) => i > from && alights.has(local(s.stop?.gtfsId)),
        );
        if (from < 0 || to < 0) continue;
        const stops = all.slice(from, to + 1).map((s) => toStop(s, serviceDay));
        if (stops.some((s) => s === null)) continue;
        const tripId = local(trip.gtfsId);
        trips.set(tripId, {
          tripId,
          subRouteUid: routeId.replace(/_[01]$/, ""),
          direction: direction === "1" ? 1 : 0,
          stops: stops.filter((s): s is PairTimetableStop => s !== null),
        });
      }
    }
  }
  return [...trips.values()];
}
