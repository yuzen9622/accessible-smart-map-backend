import type { RailOdSuspension, RailStationSuspension } from "../types/rail";

/** A partial suspension is boardable only when both queried stops still operate. */
export function railOdIsBoardable(row: RailOdSuspension): boolean {
  const train = row.DailyTrainInfo?.SuspendedFlag;
  const origin = row.OriginStopTime?.SuspendedFlag;
  const destination = row.DestinationStopTime?.SuspendedFlag;
  if (train === 1 || origin === 1 || destination === 1) return false;
  return train !== 2 || (origin === 0 && destination === 0);
}

/** Station boards carry the suspension flag for this particular stop. */
export function railStationIsBoardable(row: RailStationSuspension): boolean {
  if (row.DailyTrainInfo?.SuspendedFlag === 1 || row.SuspendedFlag === 1)
    return false;
  return row.DailyTrainInfo?.SuspendedFlag !== 2 || row.SuspendedFlag === 0;
}
