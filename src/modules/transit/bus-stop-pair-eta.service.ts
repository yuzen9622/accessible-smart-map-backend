import {
  findRoutesServingCanonicalPair,
  findVehiclesByPlate,
  MAX_TRIPS_PER_ROUTE,
  type BusPairRoute,
} from "./bus.repository";
import { tdxFetch } from "../../config/fetch";

export async function getCanonicalBusPair(
  input: {
    city: string;
    canonicalBoardStopId: string;
    canonicalAlightStopId: string;
    now: number;
  },
  budget: CandidateRequestBudget,
): Promise<{
  routes: Array<{ route: BusPairRoute; eta: PairEta[] }>;
  vehicles: Awaited<ReturnType<typeof findVehiclesByPlate>>;
  complete: boolean;
}> {
  let complete = true;
  const found = await budget.run(() => findRoutesServingCanonicalPair(input));
  complete = found.complete;
  const routes = await Promise.all(
    found.routes.map(async (route) => {
      try {
        const departureStopId = route.board.stopUID,
          arrivalStopId = route.alight.stopUID;
        if (!departureStopId || !arrivalStopId)
          throw new Error("Missing pair UID");
        const eta = await budget.run(() =>
          getBusStopPairRealtime({
            city: input.city,
            routeName: route.routeName?.Zh_tw ?? "",
            subRouteUid: route.subRouteUid,
            direction: route.direction === 1 ? 1 : 0,
            departureStopId: departureStopId,
            arrivalStopId: arrivalStopId,
            now: input.now,
            signal: budget.signal,
          }),
        );
        eta.sort(
          (a, b) =>
            a.boardingAt - b.boardingAt ||
            (a.plateNumb ?? "").localeCompare(b.plateNumb ?? ""),
        );
        if (eta.length > MAX_TRIPS_PER_ROUTE) complete = false;
        return { route, eta: eta.slice(0, MAX_TRIPS_PER_ROUTE) };
      } catch {
        complete = false;
        return { route, eta: [] };
      }
    }),
  );
  let vehicles: Awaited<ReturnType<typeof findVehiclesByPlate>> = [];
  const plates = [
    ...new Set(
      routes.flatMap((r) =>
        r.eta.flatMap((e) => (e.plateNumb ? [e.plateNumb] : [])),
      ),
    ),
  ];
  if (plates.length) {
    try {
      vehicles = await budget.run(() => findVehiclesByPlate(plates));
    } catch {
      complete = false;
    }
  }
  return { routes, vehicles, complete };
}
import { busUrl } from "../../config/transit";
import {
  busEtaSeconds,
  busEtaIsFresh,
  rememberBusEtaReceipt,
} from "../../utils/tdx-bus-eta";
import type { BusEtaTiming } from "../../types/transit";

interface PairEtaRow extends BusEtaTiming {
  StopSequence?: number;
  StopUID?: string;
  SubRouteUID?: string;
  Direction?: number;
  PlateNumb?: string;
  NextBusTime?: string;
}
export interface PairEta {
  plateNumb?: string;
  boardingAt: number;
  alightingAt: number | null;
}
const cache = new Map<string, { until: number; rows: PairEtaRow[] }>();
const inflight = new Map<string, Promise<PairEtaRow[]>>();
const TTL = 25000,
  MAX_ENTRIES = 128;
export interface CandidateRequestBudget {
  signal: AbortSignal;
  run<T>(work: () => Promise<T>): Promise<T>;
  close(): void;
}
/** One budget per planning/poll request, shared by every pair and skeleton. */
export function createCandidateRequestBudget(
  timeoutMs = 8000,
): CandidateRequestBudget {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("Bus candidate deadline")),
    timeoutMs,
  );
  let active = 0;
  const queue: Array<() => void> = [];
  const abort = () => {
    while (queue.length) queue.shift()?.();
  };
  controller.signal.addEventListener("abort", abort, { once: true });
  return {
    signal: controller.signal,
    async run<T>(work: () => Promise<T>): Promise<T> {
      controller.signal.throwIfAborted();
      if (active >= 3)
        await new Promise<void>((resolve) => queue.push(resolve));
      controller.signal.throwIfAborted();
      active++;
      let aborted: (() => void) | undefined;
      try {
        return await Promise.race([
          Promise.resolve().then(work),
          new Promise<never>((_, reject) => {
            aborted = () =>
              reject(
                controller.signal.reason ?? new Error("Bus candidate deadline"),
              );
            controller.signal.addEventListener("abort", aborted, {
              once: true,
            });
            if (controller.signal.aborted) aborted();
          }),
        ]);
      } finally {
        if (aborted) controller.signal.removeEventListener("abort", aborted);
        active--;
        queue.shift()?.();
      }
    },
    close() {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", abort);
    },
  };
}
function timeOf(row: PairEtaRow, now: number): number | null {
  if (!busEtaIsFresh(row, now)) return null;
  const seconds = busEtaSeconds(row, now);
  if (seconds !== null) return now + seconds * 1000;
  // NextBusTime is a stop-specific prediction, never origin timetable time.
  if (row.StopStatus !== undefined && row.StopStatus >= 2) return null;
  const next =
    row.NextBusTime && row.StopSequence === 1
      ? Date.parse(row.NextBusTime)
      : NaN;
  return Number.isFinite(next) && next >= now ? next : null;
}
interface RouteEtaQuery {
  city: string;
  routeName: string;
  subRouteUid: string;
  direction: 0 | 1;
  signal: AbortSignal;
  now: number;
}
async function routeEtaRows(input: RouteEtaQuery): Promise<PairEtaRow[]> {
  const key = `${input.city}|${input.subRouteUid}|${input.direction}`;
  const cached = cache.get(key);
  let rows = cached && cached.until > input.now ? cached.rows : undefined;
  if (!rows) {
    let pending = inflight.get(key);
    if (!pending) {
      const task = async () => {
        const base =
          input.city === "InterCity"
            ? busUrl.interCityEstimatedTimeOfArrivalUrl
            : `${busUrl.cityEstimatedTimeOfArrivalUrl}/${input.city}`;
        const filter = `SubRouteUID eq '${input.subRouteUid.replace(/'/g, "''")}' and Direction eq ${input.direction}`;
        const res = await tdxFetch(
          `${base}/${encodeURIComponent(input.routeName)}?$format=JSON&$filter=${encodeURIComponent(filter)}`,
          { signal: input.signal },
        );
        if (!res.ok) throw new Error(`Bus ETA HTTP ${res.status}`);
        const data: unknown = await res.json();
        if (!Array.isArray(data)) throw new Error("Invalid bus ETA rows");
        const result: PairEtaRow[] = data.filter(
          (r): r is PairEtaRow => !!r && typeof r === "object",
        );
        rememberBusEtaReceipt(result, input.now);
        const oldest = cache.keys().next().value;
        if (cache.size >= MAX_ENTRIES && oldest !== undefined)
          cache.delete(oldest);
        cache.set(key, { until: input.now + TTL, rows: result });
        return result;
      };
      pending = task().finally(() => inflight.delete(key));
      inflight.set(key, pending);
    }
    rows = await pending;
  }
  return rows.filter(
    (r) =>
      r.SubRouteUID === input.subRouteUid && r.Direction === input.direction,
  );
}
/** Exactly one route-scoped ETA read; downstream vehicle identity must be unique. */
export async function getBusStopPairRealtime(
  input: RouteEtaQuery & { departureStopId: string; arrivalStopId: string },
): Promise<PairEta[]> {
  const scoped = await routeEtaRows(input);
  const board = scoped.filter((r) => r.StopUID === input.departureStopId);
  const alight = scoped.filter((r) => r.StopUID === input.arrivalStopId);
  return board.flatMap((row) => {
    const boardingAt = timeOf(row, input.now);
    if (boardingAt === null) return [];
    const plate =
      row.PlateNumb && row.PlateNumb !== "-1" ? row.PlateNumb : undefined;
    const downstream = plate ? alight.filter((r) => r.PlateNumb === plate) : [];
    const uniqueBoard =
      plate && board.filter((r) => r.PlateNumb === plate).length === 1;
    const end =
      uniqueBoard && downstream.length === 1
        ? timeOf(downstream[0], input.now)
        : null;
    return [
      {
        plateNumb: plate,
        boardingAt,
        alightingAt: end !== null && end >= boardingAt ? end : null,
      },
    ];
  });
}
/** Per-stop arrival of one identified vehicle; a stop without exactly one row for it is omitted. */
export async function getBusVehicleStopTimes(
  input: RouteEtaQuery & { plateNumb: string; stopIds: string[] },
): Promise<Map<string, number>> {
  const scoped = await routeEtaRows(input);
  const times = new Map<string, number>();
  for (const stopId of input.stopIds) {
    const rows = scoped.filter(
      (r) => r.StopUID === stopId && r.PlateNumb === input.plateNumb,
    );
    const at = rows.length === 1 ? timeOf(rows[0], input.now) : null;
    if (at !== null) times.set(stopId, at);
  }
  return times;
}
