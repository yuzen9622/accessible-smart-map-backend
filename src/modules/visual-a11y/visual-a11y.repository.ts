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
 * Audible-signal features inside a bounding box, from every source.
 *
 * @param bbox `[minLng, minLat, maxLng, maxLat]`
 * @returns The matching features
 */
export async function findAudioSignalsInBbox(
  bbox: [number, number, number, number],
): Promise<IVisualA11y[]> {
  const [minLng, minLat, maxLng, maxLat] = bbox;
  return VisualA11yModel.find({
    type: "audio_signal",
    location: {
      $geoWithin: {
        $box: [
          [minLng, minLat],
          [maxLng, maxLat],
        ],
      },
    },
  }).lean<IVisualA11y[]>();
}

/** One upsert instruction for a non-OSM feature, keyed by source id. */
export interface SourcedVisualA11yUpsert {
  source: Exclude<IVisualA11y["source"], "osm">;
  sourceId: string;
  type: IVisualA11y["type"];
  location: { type: "Point"; coordinates: [number, number] };
  properties: IVisualA11y["properties"];
  updatedAt: Date;
}

/**
 * Upserts a batch of non-OSM features keyed by (source, sourceId, type).
 *
 * @param docs Features to insert or update
 * @returns How many were newly inserted and how many existing ones changed
 */
export async function upsertSourcedVisualA11yBatch(
  docs: SourcedVisualA11yUpsert[],
): Promise<{ inserted: number; updated: number }> {
  if (!docs.length) return { inserted: 0, updated: 0 };
  const result = await VisualA11yModel.bulkWrite(
    docs.map((doc) => ({
      updateOne: {
        filter: { source: doc.source, sourceId: doc.sourceId, type: doc.type },
        update: { $set: doc },
        upsert: true,
      },
    })),
    { ordered: false },
  );
  return { inserted: result.upsertedCount, updated: result.modifiedCount };
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
        update: {
          $set: { ...doc, source: "osm", sourceId: String(doc.osmNodeId) },
        },
        upsert: true,
      },
    })),
    { ordered: false },
  );
  return { inserted: result.upsertedCount, updated: result.modifiedCount };
}
