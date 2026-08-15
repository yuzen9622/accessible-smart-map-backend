import MetroStationModel from "../../model/metro-station.model";

/** The station fields the alert enrichment path reads. */
export interface MetroStationName {
  stationUid: string;
  stationName: { Zh_tw: string };
}

/**
 * Resolves station UIDs to their Chinese names.
 *
 * @param stationUids Station UIDs to look up
 * @returns The matching stations; empty when no UIDs were asked for
 */
export async function findMetroStationsByUids(
  stationUids: string[],
): Promise<MetroStationName[]> {
  if (stationUids.length === 0) return [];
  return MetroStationModel.find({
    stationUid: { $in: stationUids },
  }).lean<MetroStationName[]>();
}
