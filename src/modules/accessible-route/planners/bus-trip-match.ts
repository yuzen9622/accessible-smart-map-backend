import type { BusLeg } from "../../../types/route";
import { taipeiYmdDash } from "../../../config/taipei-time";
import { BUS_DIRECTIONS } from "../../../constants/bus";
import { busEtaSeconds } from "../../../utils/tdx-bus-eta";
import type { TdxEtaRecord } from "./realtime-transit.types";

const BOARDING_LIVE_WINDOW_MS = 15 * 60_000;

/** A route starting now can still board its first bus much later. */
export function canMatchBusTrip(
  leg: BusLeg,
  now = Date.now(),
): leg is BusLeg & {
  _scheduledDepartureTime: number;
  _boardingReadyTime: number;
} {
  const departure = leg._scheduledDepartureTime;
  return (
    typeof departure === "number" &&
    Number.isFinite(departure) &&
    typeof leg._boardingReadyTime === "number" &&
    Number.isFinite(leg._boardingReadyTime) &&
    Boolean(leg._scheduledTripId) &&
    // A frequency template is not an identified scheduled departure.
    !leg._scheduledTripId?.startsWith("freqpatched_") &&
    Boolean(leg.subRouteUid && leg.departureStopId) &&
    departure <= now + BOARDING_LIVE_WINDOW_MS &&
    taipeiYmdDash(new Date(departure)) === taipeiYmdDash(new Date(now))
  );
}

/**
 * Match an explicitly scheduled departure, never merely the next ETA. Missing
 * schedule/branch/stop/plate evidence or multiple vehicles means keep schedule.
 * Direction changes (GTFS 0/1 versus TDX circular routes) require same-vehicle
 * downstream stop-order evidence; the first available direction is not a match.
 */
export function matchPlannedBus(
  leg: BusLeg,
  records: TdxEtaRecord[],
  now = Date.now(),
): { board: TdxEtaRecord; seconds: number; direction: number } | null {
  if (!canMatchBusTrip(leg, now)) return null;
  const scheduled = new Date(leg._scheduledDepartureTime).toLocaleTimeString(
    "en-GB",
    { timeZone: "Asia/Taipei", hour: "2-digit", minute: "2-digit" },
  );
  const matches = records.flatMap((board) => {
    const seconds = busEtaSeconds(board, now);
    const direction = board.Direction;
    if (
      board.SubRouteUID !== leg.subRouteUid ||
      board.StopUID !== leg.departureStopId ||
      board.ScheduledTime !== scheduled ||
      !board.PlateNumb ||
      board.PlateNumb === "-1" ||
      board.StopStatus !== 0 ||
      seconds === null ||
      now + seconds * 1000 < leg._boardingReadyTime ||
      typeof direction !== "number" ||
      !BUS_DIRECTIONS.some((d) => d !== 255 && d === direction)
    )
      return [];

    if (board.Direction !== leg.direction) {
      const downstream = records.some(
        (alight) =>
          alight.SubRouteUID === leg.subRouteUid &&
          alight.StopUID === leg.arrivalStopId &&
          alight.Direction === board.Direction &&
          alight.PlateNumb === board.PlateNumb &&
          busEtaSeconds(alight, now) !== null &&
          typeof board.StopSequence === "number" &&
          typeof alight.StopSequence === "number" &&
          alight.StopSequence > board.StopSequence,
      );
      if (!downstream) return [];
    }
    return [{ board, seconds, direction }];
  });
  // Duplicate rows are ambiguous too: do not let provider row order select a run.
  return matches.length === 1 ? matches[0] : null;
}
