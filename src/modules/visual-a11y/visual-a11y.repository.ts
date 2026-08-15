import VisualA11yModel from "../../model/visual-a11y.model";
import { IVisualA11y } from "../../types";

function makeGeoQuery(lng: number, lat: number, radiusM: number) {
  return {
    $near: {
      $geometry: { type: "Point", coordinates: [lng, lat] },
      $maxDistance: radiusM,
    },
  };
}

/** One upsert-by-OSM-node instruction, in domain terms. */
export interface VisualA11yUpsert {
  osmNodeId: number;
  type: IVisualA11y["type"];
  location: { type: "Point"; coordinates: [number, number] };
  properties: IVisualA11y["properties"];
  updatedAt: Date;
}

/**
 * Visual-accessibility features within a radius of a point.
 *
 * @param lat Latitude of the search centre
 * @param lng Longitude of the search centre
 * @param radiusM Search radius in metres
 * @param type Optional feature type filter
 * @returns Matching features, nearest first
 */
export async function findNearbyVisualA11y(
  lat: number,
  lng: number,
  radiusM: number,
  type?: IVisualA11y["type"],
): Promise<IVisualA11y[]> {
  const filter: Record<string, unknown> = {
    location: makeGeoQuery(lng, lat, radiusM),
  };
  if (type) filter.type = type;
  return VisualA11yModel.find(filter).lean<IVisualA11y[]>();
}

/**
 * Upserts a batch of features keyed by (osmNodeId, type).
 *
 * @param docs Features to insert or update
 * @returns How many were newly inserted and how many existing ones changed
 */
export async function upsertVisualA11yBatch(
  docs: VisualA11yUpsert[],
): Promise<{ inserted: number; updated: number }> {
  const result = await VisualA11yModel.bulkWrite(
    docs.map((doc) => ({
      updateOne: {
        filter: { osmNodeId: doc.osmNodeId, type: doc.type },
        update: { $set: doc },
        upsert: true,
      },
    })),
    { ordered: false },
  );
  return { inserted: result.upsertedCount, updated: result.modifiedCount };
}
