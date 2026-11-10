import axios from "axios";
import {
  VALHALLA_BASE_URL,
  VALHALLA_METADATA_BUDGET_MS,
} from "../config/valhalla";
import { readFile, realpath, stat } from "node:fs/promises";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import type { RoadNetworkInfo, RoadSpeedRules } from "../types/road-guidance";

export type ValhallaReleaseSnapshot = {
  roadNetwork: RoadNetworkInfo;
  rules?: RoadSpeedRules;
  identity: string;
};
const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const sha = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const id = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value);

const MAX_SERVING_MARKER_BYTES = 4096;
function readServingMarker(): Buffer | null {
  let descriptor: number | undefined;
  try {
    const markerPath = path.resolve(
      process.env.VALHALLA_DATA_DIR ?? "valhalla-data",
      "serving-release.json",
    );
    descriptor = openSync(
      markerPath,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );
    const metadata = fstatSync(descriptor);
    if (
      !metadata.isFile() ||
      metadata.size === 0 ||
      metadata.size > MAX_SERVING_MARKER_BYTES
    )
      return null;
    const buffer = Buffer.alloc(MAX_SERVING_MARKER_BYTES + 1);
    const bytesRead = readSync(descriptor, buffer, 0, buffer.length, 0);
    return bytesRead === metadata.size && bytesRead <= MAX_SERVING_MARKER_BYTES
      ? buffer.subarray(0, bytesRead)
      : null;
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        /* Marker failure must not affect base routing. */
      }
    }
  }
}
export function readValhallaReleaseIdentity(): string | null {
  const marker = readServingMarker();
  return marker ? hash(marker) : null;
}

function parseRules(
  value: unknown,
  source: string,
): RoadSpeedRules | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as RoadSpeedRules;
  if (
    raw.schemaVersion !== 1 ||
    raw.sourcePbfSha256 !== source ||
    !raw.ways ||
    typeof raw.ways !== "object" ||
    Array.isArray(raw.ways)
  )
    return undefined;
  for (const [way, rule] of Object.entries(raw.ways)) {
    if (
      !/^[1-9]\d*$/.test(way) ||
      !rule ||
      typeof rule.unresolvedConditional !== "boolean" ||
      typeof rule.unresolvedLaneSpecific !== "boolean"
    )
      return undefined;
    if (
      rule.osmGeometry !== undefined &&
      (!Array.isArray(rule.osmGeometry) ||
        rule.osmGeometry.length < 2 ||
        rule.osmGeometry.some(
          (p) =>
            !Array.isArray(p) ||
            p.length !== 2 ||
            !Number.isFinite(p[0]) ||
            !Number.isFinite(p[1]) ||
            Math.abs(p[0]) > 180 ||
            Math.abs(p[1]) > 90,
        ))
    )
      return undefined;
    for (const directional of [rule.forward, rule.backward]) {
      if (directional === undefined) continue;
      if (!directional || typeof directional.rawValue !== "string")
        return undefined;
      if (directional.kind === "known") {
        if (!Number.isFinite(directional.limitKph) || directional.limitKph <= 0)
          return undefined;
      } else if (
        (directional.kind !== "unlimited" && directional.kind !== "invalid") ||
        directional.limitKph !== null
      )
        return undefined;
    }
  }
  return raw;
}
type ServingStatus = { version: string; tileset_last_modified: number };
const VALIDATION_FIELDS = [
  "candidateRouting",
  "airportSigns",
  "lanes",
  "speedTransition",
  "directionalSourceRules",
  "sourceIntegrity",
  "tileFilesPresent",
] as const;
let artifactCache:
  | {
      key: string;
      signature: string;
      snapshot: ValhallaReleaseSnapshot;
      expected: ServingStatus;
    }
  | undefined;
function validStatus(value: unknown): value is ServingStatus {
  if (!value || typeof value !== "object") return false;
  const raw = value as ServingStatus;
  return (
    typeof raw.version === "string" &&
    !!raw.version &&
    Number.isSafeInteger(raw.tileset_last_modified) &&
    raw.tileset_last_modified >= 0
  );
}
async function artifactSignature(release: string): Promise<string> {
  const files = await Promise.all(
    ["manifest.json", "road-speed-rules.json"].map((file) =>
      stat(path.join(release, file)),
    ),
  );
  return JSON.stringify(
    files.map(({ ino, size, mtimeMs, ctimeMs }) => ({
      ino,
      size,
      mtimeMs,
      ctimeMs,
    })),
  );
}
async function loadSnapshot(
  deadline: number,
): Promise<ValhallaReleaseSnapshot | null> {
  const root = path.resolve(process.env.VALHALLA_DATA_DIR ?? "valhalla-data");
  const markerBytes = readServingMarker();
  if (!markerBytes) return null;
  const before = markerBytes.toString("utf8");
  let marker;
  try {
    marker = JSON.parse(before);
  } catch {
    return null;
  }
  if (
    !id(marker.buildId) ||
    typeof marker.instanceId !== "string" ||
    !marker.instanceId ||
    typeof marker.startedAt !== "string" ||
    !Number.isFinite(Date.parse(marker.startedAt)) ||
    typeof marker.valhallaImageDigest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(marker.valhallaImageDigest) ||
    (marker.manifestSha256 !== null && !sha(marker.manifestSha256))
  )
    return null;
  const release = path.join(root, "releases", marker.buildId);
  const active = await realpath(path.join(root, "active"));
  if (active !== (await realpath(release)) || deadline <= Date.now())
    return null;
  const upstream = await axios.get(`${VALHALLA_BASE_URL}/status`, {
    signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
  });
  if (!validStatus(upstream.data)) return null;
  const status = upstream.data;
  const identity = hash(markerBytes);
  const key = root + ":" + identity;
  const unverified: ValhallaReleaseSnapshot = {
    roadNetwork: {
      tilesetId: marker.buildId,
      sourcePbfSha256: null,
      provenance: "unverified",
    },
    identity,
  };
  let snapshot = unverified;
  if (marker.manifestSha256 !== null) {
    try {
      const signature = await artifactSignature(release);
      let expected: ServingStatus;
      if (artifactCache?.key === key && artifactCache.signature === signature) {
        snapshot = artifactCache.snapshot;
        expected = artifactCache.expected;
      } else {
        const bytes = await readFile(
          path.join(release, "manifest.json"),
          "utf8",
        );
        const manifest = JSON.parse(bytes);
        const validation = manifest.validation;
        if (
          hash(bytes) !== marker.manifestSha256 ||
          manifest.schemaVersion !== 1 ||
          manifest.buildId !== marker.buildId ||
          manifest.valhallaImageDigest !== marker.valhallaImageDigest ||
          !sha(manifest.sourcePbfSha256) ||
          !sha(manifest.speedRulesSha256) ||
          manifest.speedRulesSchemaVersion !== 1 ||
          !validStatus(manifest.expectedServingStatus) ||
          !validation ||
          VALIDATION_FIELDS.some((field) => validation[field] !== true)
        )
          throw new Error("Invalid manifest");
        const rulesBytes = await readFile(
          path.join(release, "road-speed-rules.json"),
          "utf8",
        );
        const rules = parseRules(
          JSON.parse(rulesBytes),
          manifest.sourcePbfSha256,
        );
        if (
          hash(rulesBytes) !== manifest.speedRulesSha256 ||
          !rules ||
          signature !== (await artifactSignature(release))
        )
          throw new Error("Invalid rules");
        expected = manifest.expectedServingStatus;
        snapshot = {
          roadNetwork: {
            tilesetId: marker.buildId,
            sourcePbfSha256: manifest.sourcePbfSha256,
            provenance: "verified",
          },
          rules,
          identity,
        };
        for (const way of Object.values(rules.ways)) {
          if (way.forward) Object.freeze(way.forward);
          if (way.backward) Object.freeze(way.backward);
          if (way.osmGeometry) {
            way.osmGeometry.forEach(Object.freeze);
            Object.freeze(way.osmGeometry);
          }
          Object.freeze(way);
        }
        Object.freeze(rules.ways);
        Object.freeze(rules);
        Object.freeze(snapshot.roadNetwork);
        Object.freeze(snapshot);
        artifactCache = { key, signature, snapshot, expected };
      }
      if (
        status.version !== expected.version ||
        status.tileset_last_modified !== expected.tileset_last_modified
      )
        return null;
    } catch {
      snapshot = unverified;
    }
  }
  if (
    identity !== readValhallaReleaseIdentity() ||
    active !== (await realpath(path.join(root, "active"))) ||
    deadline <= Date.now()
  )
    return null;
  return snapshot;
}
export async function getValhallaReleaseSnapshot(
  timeoutMs = VALHALLA_METADATA_BUDGET_MS,
): Promise<ValhallaReleaseSnapshot | null> {
  if (timeoutMs <= 0) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      loadSnapshot(Date.now() + timeoutMs).catch(() => null),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
export async function isValhallaReleaseCurrent(
  snapshot: ValhallaReleaseSnapshot,
  timeoutMs = VALHALLA_METADATA_BUDGET_MS,
): Promise<boolean> {
  const current = await getValhallaReleaseSnapshot(timeoutMs);
  return (
    current !== null &&
    current.identity === snapshot.identity &&
    current.roadNetwork.provenance === snapshot.roadNetwork.provenance &&
    current.roadNetwork.sourcePbfSha256 === snapshot.roadNetwork.sourcePbfSha256
  );
}
