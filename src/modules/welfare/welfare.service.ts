import {
  findNearbyWelfare,
  findWelfareBy,
  findWelfareById,
} from "./welfare.repository";

/** Welfare institutions within `radiusM` of the point (only geocoded ones have a location). */
export async function findNearby(lat: number, lng: number, radiusM = 1000) {
  return findNearbyWelfare(lat, lng, radiusM);
}

/** Directory listing, optionally filtered by county and/or institution type. */
export async function findAll(filter: { county?: string; type?: string } = {}) {
  return findWelfareBy(filter);
}

/** Single institution by id, or null if the id is malformed or not found. */
export async function findById(id: string) {
  return findWelfareById(id);
}
