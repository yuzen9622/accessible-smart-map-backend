import {
  findNearbyVisualA11y,
  upsertVisualA11yBatch,
  type VisualA11yUpsert,
} from "./visual-a11y.repository";
import { IVisualA11y } from "../../types";
import { fetchOverpassElements } from "../../adapters/overpass.adapter";

const BBOX = "24.95,121.45,25.12,121.62";

const QUERIES: { type: IVisualA11y["type"]; query: string }[] = [
  {
    type: "audio_signal",
    query: `[out:json][timeout:25];node["traffic_signals:sound"="yes"](${BBOX});out body;`,
  },
  {
    type: "tactile_paving",
    query: `[out:json][timeout:25];node["tactile_paving"="yes"](${BBOX});out body;`,
  },
];

function parseBool(v?: string): boolean | null {
  if (v === "yes") return true;
  if (v === "no") return false;
  return null;
}

function parseAudioSignal(
  tags: Record<string, string>
): IVisualA11y["properties"] {
  return {
    buttonOperated: parseBool(tags["button_operated"]),
    vibration: parseBool(tags["traffic_signals:vibration"]),
    roadName: tags["road_name"] ?? null,
  };
}

function parseTactilePaving(
  tags: Record<string, string>
): IVisualA11y["properties"] {
  const subType =
    tags["highway"] === "bus_stop"
      ? "bus_stop"
      : tags["kerb"] != null
        ? "kerb"
        : "crossing";
  return {
    subType,
    name: tags["name"] ?? null,
    nameEn: tags["name:en"] ?? null,
    wheelchair: tags["wheelchair"] ?? null,
  };
}

async function fetchOverpass(query: string): Promise<any[]> {
  return fetchOverpassElements(query, {
    userAgent: "accessible-smart-map-backend/1.0 (visual-a11y sync)",
    timeoutMs: 40_000, // queries declare [timeout:25]; leave headroom for queueing
  });
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

export async function findNearby(
  lat: number,
  lng: number,
  radiusM = 500,
  type?: IVisualA11y["type"]
) {
  return findNearbyVisualA11y(lat, lng, radiusM, type);
}

export async function syncFromOverpass(): Promise<{
  inserted: number;
  updated: number;
}> {
  let totalInserted = 0;
  let totalUpdated = 0;

  for (let i = 0; i < QUERIES.length; i++) {
    const { type, query } = QUERIES[i];
    if (i > 0) await sleep(2000);

    const elements = await fetchOverpass(query);
    const nodes = elements.filter(
      (el) => el.type === "node" && el.lat != null && el.lon != null
    );

    if (nodes.length === 0) continue;

    const ops: VisualA11yUpsert[] = nodes.map((el) => {
      const tags: Record<string, string> = el.tags ?? {};
      const properties =
        type === "audio_signal"
          ? parseAudioSignal(tags)
          : parseTactilePaving(tags);
      return {
        osmNodeId: el.id as number,
        type,
        location: { type: "Point" as const, coordinates: [el.lon, el.lat] as [number, number] },
        properties,
        updatedAt: new Date(),
      };
    });

    const CHUNK = 500;
    for (let j = 0; j < ops.length; j += CHUNK) {
      const result = await upsertVisualA11yBatch(ops.slice(j, j + CHUNK));
      totalInserted += result.inserted;
      totalUpdated += result.updated;
    }
  }

  return { inserted: totalInserted, updated: totalUpdated };
}
