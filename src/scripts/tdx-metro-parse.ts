import type { AnyBulkWriteOperation } from "mongoose";
import type { TdxMetroStation, TdxMetroStationOfLine } from "../types/transit";
import type { ITdxMetroStation } from "../types";

/** Normalize station and line payloads into the exact operations used by the importer. */
export function metroStationOperations(
  stations: TdxMetroStation[],
  stationOfLines: TdxMetroStationOfLine[],
  railSystem: string,
  importedAt = new Date(),
): AnyBulkWriteOperation<ITdxMetroStation>[] {
  const lineMap = new Map<string, Set<string>>();
  for (const sol of stationOfLines) {
    const fullLineUid = `${railSystem}-${sol.LineID}`;
    for (const s of sol.Stations ?? []) {
      // StationUID prefixes are operator-defined (NTMCC-, KLRT-NETWORK-, MG-),
      // so join the two payloads by their shared StationID instead of inventing a UID.
      if (!lineMap.has(s.StationID)) lineMap.set(s.StationID, new Set());
      lineMap.get(s.StationID)!.add(fullLineUid);
    }
  }

  const ops: AnyBulkWriteOperation<ITdxMetroStation>[] = stations
    .filter(
      (s) =>
        s.StationUID &&
        s.StationID &&
        Number.isFinite(s.StationPosition?.PositionLon) &&
        Number.isFinite(s.StationPosition?.PositionLat) &&
        Math.abs(s.StationPosition.PositionLon) <= 180 &&
        Math.abs(s.StationPosition.PositionLat) <= 90,
    )
    .map((s) => ({
      updateOne: {
        filter: { stationUid: s.StationUID },
        update: {
          $set: {
            stationUid: s.StationUID,
            stationName: { Zh_tw: s.StationName.Zh_tw, En: s.StationName.En },
            railSystem,
            lineIds: [...(lineMap.get(s.StationID) ?? [])],
            location: {
              type: "Point",
              coordinates: [
                s.StationPosition.PositionLon,
                s.StationPosition.PositionLat,
              ],
            },
            importedAt,
          },
        },
        upsert: true,
      },
    }));

  return ops;
}
