/**
 * Endpoint probe for the TDX Road/Traffic integration.
 *
 * TDX documents the Road/Traffic family loosely: the live-congestion path and
 * the road-event service root are not derivable from the docs, and the
 * congestion value domain is not published. This script calls every endpoint
 * `src/config/traffic.ts` pins and prints HTTP status, row count and the first
 * row's key list, so the config records verified paths rather than guesses.
 * Re-run it whenever TDX changes: a 404 here means the config needs updating.
 *
 * It also probes the local Valhalla deployment with `exclude_locations` to
 * confirm the engine accepts the field.
 *
 * Run: pnpm smoke:tdx-traffic
 * Or a subset: pnpm smoke:tdx-traffic -- --cities=Taipei
 */

import "dotenv/config";
import axios from "axios";
import { tdxFetch } from "../config/fetch";
import {
  TDX_LIVE_TRAFFIC_CITIES,
  TRAFFIC_FETCH_TIMEOUT_MS,
  TRAFFIC_TARGET_CITIES,
  trafficUrl,
} from "../config/traffic";
import {
  VALHALLA_BASE_URL,
  VALHALLA_ROUTE_PATH,
  VALHALLA_TIMEOUT_MS,
} from "../config/valhalla";

/** Envelope key holding the rows, per endpoint. */
const PROBES = [
  { label: "Live", url: trafficUrl.liveTrafficUrl, rowsKey: "LiveTraffics" },
  { label: "Section", url: trafficUrl.sectionUrl, rowsKey: "Sections" },
  {
    label: "SectionShape",
    url: trafficUrl.sectionShapeUrl,
    rowsKey: "SectionShapes",
  },
  {
    label: "CongestionLevel",
    url: trafficUrl.congestionLevelUrl,
    rowsKey: "CongestionLevels",
  },
  { label: "LiveEvent", url: trafficUrl.liveEventUrl, rowsKey: "LiveEvents" },
] as const;

function parseCities(): readonly string[] {
  const arg = process.argv.find((a) => a.startsWith("--cities="));
  if (!arg) return TRAFFIC_TARGET_CITIES;
  return arg
    .slice("--cities=".length)
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
}

/**
 * @param payload Parsed TDX response body.
 * @param rowsKey Envelope key expected to hold the rows.
 * @returns A one-line description of the row count and first row's shape.
 */
function describeRows(payload: unknown, rowsKey: string): string {
  if (!payload || typeof payload !== "object") {
    return `unexpected payload type: ${typeof payload}`;
  }
  const envelope = payload as Record<string, unknown>;
  const rows = Array.isArray(payload) ? payload : envelope[rowsKey];
  if (!Array.isArray(rows)) {
    return `MISSING "${rowsKey}" — envelope keys: ${Object.keys(envelope).join(", ")}`;
  }
  if (rows.length === 0) return "0 rows";
  const first: unknown = rows[0];
  if (!first || typeof first !== "object")
    return `${rows.length} rows (opaque)`;
  return `${rows.length} rows — keys: ${Object.keys(first).join(", ")}`;
}

async function probe(
  label: string,
  url: string,
  rowsKey: string,
): Promise<void> {
  try {
    const res = await tdxFetch(url, {
      signal: AbortSignal.timeout(TRAFFIC_FETCH_TIMEOUT_MS),
    });
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      console.log(
        `  ${label.padEnd(16)} HTTP ${res.status} — non-JSON body: ${text.slice(0, 160)}`,
      );
      return;
    }
    console.log(
      `  ${label.padEnd(16)} HTTP ${res.status} — ${describeRows(parsed, rowsKey)}`,
    );
  } catch (error) {
    console.error(
      `  ${label.padEnd(16)} FAILED — ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function probeValhallaExclude(): Promise<void> {
  const body = {
    locations: [
      { lat: 25.0478, lon: 121.5319, type: "break" },
      { lat: 25.033, lon: 121.5654, type: "break" },
    ],
    costing: "auto",
    directions_options: { units: "kilometers" },
    exclude_locations: [
      { lat: 25.0439, lon: 121.5445 },
      { lat: 25.0401, lon: 121.5502 },
    ],
  };
  try {
    const res = await axios.post(
      `${VALHALLA_BASE_URL}${VALHALLA_ROUTE_PATH}`,
      body,
      { signal: AbortSignal.timeout(VALHALLA_TIMEOUT_MS) },
    );
    const trip = (res.data as { trip?: { summary?: unknown } })?.trip;
    console.log(
      `  exclude_locations HTTP ${res.status} — summary: ${JSON.stringify(trip?.summary)}`,
    );
  } catch (error) {
    const status = axios.isAxiosError(error) ? error.response?.status : "n/a";
    const payload = axios.isAxiosError(error)
      ? String(JSON.stringify(error.response?.data)).slice(0, 300)
      : String(error);
    console.error(`  exclude_locations HTTP ${status} — ${payload}`);
  }
}

async function main(): Promise<void> {
  for (const city of parseCities()) {
    console.log(`\n=== ${city} ===`);
    for (const { label, url, rowsKey } of PROBES) {
      if (
        label === "Live" &&
        !(TDX_LIVE_TRAFFIC_CITIES as readonly string[]).includes(city)
      ) {
        console.log(`  ${label.padEnd(16)} SKIP (Live 不支援)`);
        continue;
      }
      await probe(label, url(city), rowsKey);
    }
  }
  console.log(`\n=== Valhalla (${VALHALLA_BASE_URL}) ===`);
  await probeValhallaExclude();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
