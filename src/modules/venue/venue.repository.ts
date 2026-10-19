import VenueModel from "../../model/venue.model";
import type { VenueDocument } from "./venue.types";

export type VenueSummaryRow = Pick<
  VenueDocument,
  "venueId" | "name" | "center" | "version" | "importedAt"
> & { buildings: { id: string; name: string }[] };

/**
 * @param venueId Venue id.
 * @returns The stored version, or null when the venue does not exist.
 */
export async function findVenueVersion(
  venueId: string,
): Promise<number | null> {
  const row = await VenueModel.findOne({ venueId }, { version: 1, _id: 0 })
    .lean<{ version: number }>()
    .exec();
  return row?.version ?? null;
}

/**
 * @param venueId Venue id.
 * @returns The whole compiled venue as one snapshot, or null.
 */
export async function findVenue(
  venueId: string,
): Promise<VenueDocument | null> {
  return VenueModel.findOne({ venueId }, { _id: 0, __v: 0 })
    .lean<VenueDocument>()
    .exec();
}

/** @returns One summary row per venue, sorted by id. */
export async function listVenueSummaries(): Promise<VenueSummaryRow[]> {
  return VenueModel.find(
    {},
    {
      _id: 0,
      venueId: 1,
      name: 1,
      center: 1,
      version: 1,
      importedAt: 1,
      "buildings.id": 1,
      "buildings.name": 1,
    },
  )
    .sort({ venueId: 1 })
    .lean<VenueSummaryRow[]>()
    .exec();
}

/** MongoDB duplicate-key error code. */
const DUPLICATE_KEY = 11000;

/**
 * Replaces (or creates) a venue and bumps its version in one atomic write,
 * so two concurrent imports never both claim the same version. Relies on the
 * unique `venueId` index: when two first imports race, the loser gets a
 * duplicate-key error and retries as an update of the winner's document.
 *
 * @param doc Compiled venue without its version.
 * @returns The version written.
 */
export async function replaceVenue(
  doc: Omit<VenueDocument, "version">,
): Promise<number> {
  await VenueModel.init();
  const write = () =>
    VenueModel.findOneAndUpdate(
      { venueId: doc.venueId },
      { $set: doc, $inc: { version: 1 } },
      { upsert: true, new: true, projection: { version: 1, _id: 0 } },
    )
      .lean<{ version: number }>()
      .exec();
  let row: { version: number } | null;
  try {
    row = await write();
  } catch (error) {
    if ((error as { code?: number }).code !== DUPLICATE_KEY) throw error;
    row = await write();
  }
  if (!row) throw new Error(`venue ${doc.venueId} was not written`);
  return row.version;
}
