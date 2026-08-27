/**
 * Replay support for the paired OTP comparison bench.
 *
 * Replay re-runs the OD coordinates of an earlier comparison file against a
 * chosen graph version so a specific case (say, an unroutable pair) can be
 * reproduced exactly. It deliberately does not snap: a coordinate that no longer
 * identifies exactly one node fails the run, because a silent nearest-snap would
 * turn "this node vanished" into a different, quietly wrong experiment.
 */

import fs from "node:fs";

/** Endpoint tolerance in degrees (~1 cm). A correct replay matches far below it. */
export const REPLAY_COORDINATE_TOLERANCE_DEG = 1e-7;

export interface ReplayPoint {
  lat: number;
  lon: number;
}

export interface ReplayPair {
  /** The `sourceIndex` (or `index`) of the case in the file being replayed. */
  sourceIndex: number;
  from: ReplayPoint;
  to: ReplayPoint;
}

export interface ReplayNodeSource {
  nodeCount: number;
  nodeLat: { [index: number]: number };
  nodeLon: { [index: number]: number };
}

export interface ResolvedReplayPair {
  sourceIndex: number;
  from: number;
  to: number;
}

function readPoint(
  raw: unknown,
  role: "from" | "to",
  position: number,
): ReplayPoint {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`pairs input outcome ${position} has no ${role} endpoint`);
  }
  const { lat, lon } = raw as { lat?: unknown; lon?: unknown };
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new Error(
      `pairs input outcome ${position} ${role} has no finite coordinate`,
    );
  }
  return { lat: lat as number, lon: lon as number };
}

/**
 * @param raw Parsed prior comparison document.
 * @returns Every recorded OD pair, in the original file order, with its case id.
 */
export function parseReplayPairs(raw: unknown): ReplayPair[] {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("pairs input is not a comparison document");
  }
  const { outcomes } = raw as { outcomes?: unknown };
  if (!Array.isArray(outcomes) || outcomes.length === 0) {
    throw new Error("pairs input has no outcomes array");
  }
  return outcomes.map((outcome, position) => {
    if (typeof outcome !== "object" || outcome === null) {
      throw new Error(`pairs input outcome ${position} is not an object`);
    }
    const record = outcome as {
      index?: unknown;
      sourceIndex?: unknown;
      from?: unknown;
      to?: unknown;
    };
    const sourceIndex =
      record.sourceIndex === undefined ? record.index : record.sourceIndex;
    if (!Number.isInteger(sourceIndex)) {
      throw new Error(`pairs input outcome ${position} has no integer case id`);
    }
    return {
      sourceIndex: sourceIndex as number,
      from: readPoint(record.from, "from", position),
      to: readPoint(record.to, "to", position),
    };
  });
}

/**
 * @param filePath Path to a prior comparison evidence file.
 * @returns Its OD pairs, with read and parse failures reported as one clear error.
 */
export function readReplayPairsFile(filePath: string): ReplayPair[] {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(
      `unable to read pairs input ${filePath}: ${(error as Error).message}`,
    );
  }
  return parseReplayPairs(raw);
}

function resolvePoint(
  source: ReplayNodeSource,
  point: ReplayPoint,
  role: "from" | "to",
  sourceIndex: number,
  toleranceDeg: number,
): number {
  let resolved = -1;
  let matchCount = 0;
  for (let node = 0; node < source.nodeCount; node += 1) {
    if (
      Math.abs(source.nodeLat[node] - point.lat) <= toleranceDeg &&
      Math.abs(source.nodeLon[node] - point.lon) <= toleranceDeg
    ) {
      matchCount += 1;
      if (matchCount > 1) {
        throw new Error(
          `case ${sourceIndex} ${role} (${point.lat}, ${point.lon}) is ambiguous: ` +
            `at least 2 nodes match within ${toleranceDeg} degrees`,
        );
      }
      resolved = node;
    }
  }
  if (resolved === -1) {
    throw new Error(
      `case ${sourceIndex} ${role} (${point.lat}, ${point.lon}) matches no node ` +
        `in this graph version within ${toleranceDeg} degrees`,
    );
  }
  return resolved;
}

/**
 * @param source Loaded graph coordinates.
 * @param pairs Pairs read from the file being replayed.
 * @param toleranceDeg Strict coordinate tolerance in degrees.
 * @returns Node pairs in the original order, each carrying its source case id.
 */
export function resolveReplayPairs(
  source: ReplayNodeSource,
  pairs: ReplayPair[],
  toleranceDeg: number = REPLAY_COORDINATE_TOLERANCE_DEG,
): ResolvedReplayPair[] {
  return pairs.map((pair) => {
    const from = resolvePoint(
      source,
      pair.from,
      "from",
      pair.sourceIndex,
      toleranceDeg,
    );
    const to = resolvePoint(
      source,
      pair.to,
      "to",
      pair.sourceIndex,
      toleranceDeg,
    );
    if (from === to) {
      throw new Error(
        `case ${pair.sourceIndex} resolves both endpoints to node ${from}`,
      );
    }
    return { sourceIndex: pair.sourceIndex, from, to };
  });
}
