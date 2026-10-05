/**
 * Audible pedestrian signals along WALK legs, for the visual_impaired mode.
 * Signals come from every visual_a11ys source; the Taipei TCE record wins over
 * an OSM node for the same intersection.
 */

import type { VisualA11ySource } from "../../../types";
import type { WalkA11yPoint } from "../../../types/route";
import { pointToSegmentDistanceM } from "./hazard-routing";
import { haversineMeters } from "../../../utils/geo";

export const AUDIO_SIGNAL_MATCH_RADIUS_M = 20;
export const AUDIO_SIGNAL_DEDUP_RADIUS_M = 15;

/** One audible signal candidate. */
export interface AudioSignalCandidate {
  source: VisualA11ySource;
  location: [number, number];
  name?: string | null;
}

/**
 * Audible signals within the match radius of a polyline, one per intersection.
 *
 * @param polyline The leg geometry as [lng, lat] points.
 * @param signals The candidate signals.
 * @returns The matched signals as WALK point facilities, in input order.
 */
export function matchAudioSignals(
  polyline: readonly [number, number][],
  signals: readonly AudioSignalCandidate[],
): WalkA11yPoint[] {
  if (polyline.length < 2) return [];
  const ordered = [...signals].sort(
    (a, b) => Number(a.source === "osm") - Number(b.source === "osm"),
  );
  const kept: AudioSignalCandidate[] = [];
  for (const signal of ordered) {
    let near = false;
    for (let i = 1; i < polyline.length && !near; i++) {
      near =
        pointToSegmentDistanceM(
          signal.location,
          polyline[i - 1],
          polyline[i],
        ) <= AUDIO_SIGNAL_MATCH_RADIUS_M;
    }
    if (!near) continue;
    const duplicate = kept.some(
      (k) =>
        haversineMeters(
          k.location[1],
          k.location[0],
          signal.location[1],
          signal.location[0],
        ) <= AUDIO_SIGNAL_DEDUP_RADIUS_M,
    );
    if (!duplicate) kept.push(signal);
  }
  return kept.map((s) => ({
    type: "audio_signal",
    location: s.location,
    ...(s.name ? { name: s.name } : {}),
  }));
}

/**
 * Bounding box around a set of polylines, padded by the match radius.
 *
 * @param polylines The geometries.
 * @returns `[minLng, minLat, maxLng, maxLat]`, or null when empty.
 */
export function paddedBbox(
  polylines: readonly (readonly [number, number][])[],
): [number, number, number, number] | null {
  const points = polylines.flat();
  if (!points.length) return null;
  let [minLng, minLat, maxLng, maxLat] = [
    Infinity,
    Infinity,
    -Infinity,
    -Infinity,
  ];
  for (const [lng, lat] of points) {
    minLng = Math.min(minLng, lng);
    maxLng = Math.max(maxLng, lng);
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
  }
  const padLat = AUDIO_SIGNAL_MATCH_RADIUS_M / 111_320;
  const padLng = padLat / Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180);
  return [minLng - padLng, minLat - padLat, maxLng + padLng, maxLat + padLat];
}
