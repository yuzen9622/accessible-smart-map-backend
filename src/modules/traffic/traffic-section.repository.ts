import TrafficSectionModel from "../../model/traffic-section.model";
import type { ITrafficSection } from "../../types";
import type {
  Bbox,
  TrafficGeometry,
  TrafficSectionGeometry,
} from "../../types/traffic";

const BATCH_SIZE = 500;

function bboxToPolygon(bbox: Bbox) {
  const [minLng, minLat, maxLng, maxLat] = bbox;
  return {
    type: "Polygon",
    coordinates: [
      [
        [minLng, minLat],
        [maxLng, minLat],
        [maxLng, maxLat],
        [minLng, maxLat],
        [minLng, minLat],
      ],
    ],
  };
}

function toSectionGeometry(doc: {
  sectionId: string;
  roadName?: string;
  roadClass?: number;
  city: string;
  geometry: {
    type: "LineString" | "MultiLineString";
    coordinates: number[][] | number[][][];
  };
}): TrafficSectionGeometry {
  const isMulti = doc.geometry?.type === "MultiLineString";
  const rawCoords = doc.geometry?.coordinates;

  const geometry: TrafficGeometry = isMulti
    ? {
        type: "MultiLineString",
        coordinates: (rawCoords as [number, number][][]) ?? [],
      }
    : {
        type: "LineString",
        coordinates: (rawCoords as [number, number][]) ?? [],
      };

  return {
    sectionId: doc.sectionId,
    roadName: doc.roadName,
    roadClass: doc.roadClass,
    city: doc.city,
    geometry,
  };
}

function isDbConnected(): boolean {
  return TrafficSectionModel.db?.readyState === 1;
}

export async function findSectionsInBbox(
  bbox: Bbox,
): Promise<TrafficSectionGeometry[]> {
  if (!isDbConnected()) {
    return [];
  }
  const polygon = bboxToPolygon(bbox);
  const docs = await TrafficSectionModel.find({
    geometry: {
      $geoIntersects: {
        $geometry: polygon,
      },
    },
  })
    .lean()
    .exec();

  return docs.map(toSectionGeometry);
}

export const findSectionsIntersecting = findSectionsInBbox;

export async function findByCity(
  city: string,
): Promise<TrafficSectionGeometry[]> {
  if (!isDbConnected()) {
    return [];
  }
  const docs = await TrafficSectionModel.find({ city }).lean().exec();
  return docs.map(toSectionGeometry);
}

export async function findCitiesIntersecting(bbox: Bbox): Promise<string[]> {
  if (!isDbConnected()) {
    return [];
  }
  const polygon = bboxToPolygon(bbox);
  const cities = await TrafficSectionModel.distinct("city", {
    geometry: {
      $geoIntersects: {
        $geometry: polygon,
      },
    },
  }).exec();

  return cities.filter(
    (c): c is string => typeof c === "string" && Boolean(c.trim()),
  );
}

/**
 * Full-collection load for the resident segment index. Only ever called at
 * startup / by the periodic refresher, never on a request path.
 */
export async function findAllSections(): Promise<TrafficSectionGeometry[]> {
  if (!isDbConnected()) return [];
  const docs = await TrafficSectionModel.find({}).lean().exec();
  return docs.map(toSectionGeometry);
}

export async function latestImportedAt(): Promise<Date | null> {
  if (!isDbConnected()) {
    return null;
  }
  const latest = await TrafficSectionModel.findOne()
    .sort({ updatedAt: -1 })
    .select("updatedAt")
    .lean()
    .exec();

  return latest?.updatedAt ?? null;
}

export interface BulkUpsertResult {
  upserted: number;
  modified: number;
}

export async function bulkUpsertSections(
  sections: ITrafficSection[],
): Promise<BulkUpsertResult> {
  if (sections.length === 0 || !isDbConnected()) {
    return { upserted: 0, modified: 0 };
  }

  let upserted = 0;
  let modified = 0;

  for (let i = 0; i < sections.length; i += BATCH_SIZE) {
    const batch = sections.slice(i, i + BATCH_SIZE);
    const ops = batch.map((sec) => ({
      updateOne: {
        filter: { sectionId: sec.sectionId },
        update: {
          $set: {
            city: sec.city,
            roadName: sec.roadName,
            roadClass: sec.roadClass,
            geometry: sec.geometry,
            lengthM: sec.lengthM,
            updatedAt: sec.updatedAt ?? new Date(),
          },
        },
        upsert: true,
      },
    }));

    const res = await TrafficSectionModel.bulkWrite(ops, { ordered: false });
    upserted += res.upsertedCount;
    modified += res.modifiedCount;
  }

  return { upserted, modified };
}

export const upsertSections = bulkUpsertSections;
