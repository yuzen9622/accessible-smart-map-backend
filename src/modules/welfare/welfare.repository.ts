import mongoose from "mongoose";
import WelfareModel from "../../model/welfare.model";
import { IWelfare } from "../../types";

function makeGeoQuery(lng: number, lat: number, radiusM: number) {
  return {
    $near: {
      $geometry: { type: "Point", coordinates: [lng, lat] },
      $maxDistance: radiusM,
    },
  };
}

/**
 * Welfare institutions within a radius of a point.
 *
 * @param lat Latitude of the search centre
 * @param lng Longitude of the search centre
 * @param radiusM Search radius in metres
 * @returns Matching institutions, nearest first
 */
export async function findNearbyWelfare(
  lat: number,
  lng: number,
  radiusM: number,
): Promise<IWelfare[]> {
  return WelfareModel.find({
    location: makeGeoQuery(lng, lat, radiusM),
  }).lean<IWelfare[]>();
}

/**
 * Directory listing, optionally narrowed by county and/or institution type.
 *
 * @param filter Optional county and type constraints
 * @returns Matching institutions
 */
export async function findWelfareBy(filter: {
  county?: string;
  type?: string;
}): Promise<IWelfare[]> {
  const query: Record<string, unknown> = {};
  if (filter.county) query.county = filter.county;
  if (filter.type) query.type = filter.type;
  return WelfareModel.find(query).lean<IWelfare[]>();
}

/**
 * Single institution by id.
 *
 * @param id Candidate document id
 * @returns The institution, or null when the id is malformed or unknown
 */
export async function findWelfareById(id: string): Promise<IWelfare | null> {
  if (!mongoose.isValidObjectId(id)) return null;
  return WelfareModel.findById(id).lean<IWelfare | null>();
}
