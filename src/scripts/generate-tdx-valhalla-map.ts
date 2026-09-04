/**
 * Offline mapping generator: Maps TDX road sections to Valhalla GraphIds and Directed Edges.
 *
 * Reads `trafficsections` from MongoDB, calls Valhalla `/trace_attributes` to map-match
 * section geometries against the OSM graph, and outputs the mapping table to
 * `valhalla-data/traffic/tdx-valhalla-edge-map.json`.
 *
 * Usage:
 *   pnpm build:traffic-map
 *   pnpm build:traffic-map -- --cities=Taipei,NewTaipei
 *   pnpm build:traffic-map -- --limit=100
 */

import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import mongoose from "mongoose";
import {
  TDX_SUPPORTED_CITIES,
  TRAFFIC_TARGET_CITIES,
  VALHALLA_EDGE_MAP_PATH,
} from "../config/traffic";
import { VALHALLA_BASE_URL } from "../config/valhalla";
import TrafficSectionModel from "../model/traffic-section.model";

export interface MappedEdge {
  graphId: string;
  tileId: number;
  edgeIndex: number;
  forward: boolean;
  lengthKm?: number;
  wayId?: number;
}

export interface SectionEdgeMapping {
  sectionId: string;
  city: string;
  roadName?: string;
  edges: MappedEdge[];
}

export interface TdxValhallaEdgeMap {
  version: string;
  generatedAt: string;
  valhallaTilesetVersion?: number | string;
  totalSections: number;
  mappedSections: number;
  unmappedSections: number;
  totalEdges: number;
  mappings: SectionEdgeMapping[];
}

interface CliOptions {
  cities: readonly string[];
  limit: number;
  concurrency: number;
  outPath: string;
}

function parseCliOptions(): CliOptions {
  const args = process.argv.slice(2);
  let cities: readonly string[] = TRAFFIC_TARGET_CITIES;
  let limit = 0;
  let concurrency = 8;
  let outPath = VALHALLA_EDGE_MAP_PATH;

  if (args.includes("--all")) {
    cities = TDX_SUPPORTED_CITIES;
  }

  for (const arg of args) {
    if (arg.startsWith("--cities=")) {
      cities = arg
        .slice("--cities=".length)
        .split(",")
        .map((c) => c.trim())
        .filter(Boolean);
    } else if (arg.startsWith("--limit=")) {
      limit = Math.max(
        0,
        Number.parseInt(arg.slice("--limit=".length), 10) || 0,
      );
    } else if (arg.startsWith("--concurrency=")) {
      concurrency = Math.max(
        1,
        Number.parseInt(arg.slice("--concurrency=".length), 10) || 8,
      );
    } else if (arg.startsWith("--out=")) {
      outPath = arg.slice("--out=".length).trim() || VALHALLA_EDGE_MAP_PATH;
    }
  }

  return { cities, limit, concurrency, outPath };
}

interface ValhallaTraceEdge {
  id: number | string;
  way_id?: number;
  forward?: boolean;
  length?: number;
}

interface ValhallaTraceResponse {
  edges?: ValhallaTraceEdge[];
  error?: string;
  error_code?: number;
}

async function matchSectionToEdges(
  coordinates: [number, number][],
): Promise<MappedEdge[] | null> {
  if (coordinates.length < 2) return null;

  // Valhalla trace_attributes takes [{lat, lon}, ...]
  const shape = coordinates.map(([lon, lat]) => ({ lat, lon }));

  const res = await fetch(`${VALHALLA_BASE_URL}/trace_attributes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      shape,
      costing: "auto",
      shape_match: "walk_or_snap",
    }),
    signal: AbortSignal.timeout(6000),
  });

  if (!res.ok) {
    return null;
  }

  const data = (await res.json()) as ValhallaTraceResponse;
  if (!data.edges || !Array.isArray(data.edges) || data.edges.length === 0) {
    return null;
  }

  const mappedEdges: MappedEdge[] = [];
  for (const edge of data.edges) {
    if (edge.id == null) continue;
    const rawId = BigInt(edge.id);
    const level = Number(rawId & 7n);
    const tileIdx = Number((rawId & 0x1fffff8n) >> 3n);
    const tileId = level | (tileIdx << 3);
    const edgeIndex = Number((rawId >> 25n) & 0x1fffffn);

    mappedEdges.push({
      graphId: String(edge.id),
      tileId,
      edgeIndex,
      forward: edge.forward ?? true,
      lengthKm: edge.length,
      wayId: edge.way_id,
    });
  }

  return mappedEdges.length > 0 ? mappedEdges : null;
}

async function getValhallaStatus(): Promise<{
  tileset_last_modified?: number;
} | null> {
  try {
    const res = await fetch(`${VALHALLA_BASE_URL}/status`, {
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      return (await res.json()) as { tileset_last_modified?: number };
    }
  } catch {
    // Fail-soft: status is optional metadata
  }
  return null;
}

export async function runGenerateMap(
  opts?: Partial<CliOptions>,
): Promise<TdxValhallaEdgeMap> {
  const options: CliOptions = {
    ...parseCliOptions(),
    ...opts,
  };

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    throw new Error("DATABASE_URL is not set in environment");
  }

  if (mongoose.connection.readyState !== 1) {
    await mongoose.connect(dbUrl);
  }

  console.log(
    `[generate-tdx-valhalla-map] Querying sections for cities: [${options.cities.join(", ")}]...`,
  );

  const query: Record<string, unknown> = {
    city: { $in: options.cities },
  };

  let queryBuilder = TrafficSectionModel.find(query).lean();
  if (options.limit > 0) {
    queryBuilder = queryBuilder.limit(options.limit);
  }

  const sections = await queryBuilder.exec();
  console.log(
    `[generate-tdx-valhalla-map] Found ${sections.length} sections. Starting map match against ${VALHALLA_BASE_URL}...`,
  );

  const status = await getValhallaStatus();
  const mappings: SectionEdgeMapping[] = [];
  let mappedCount = 0;
  let unmappedCount = 0;
  let totalEdges = 0;

  // Process sections in bounded concurrent batches
  const concurrency = options.concurrency;
  for (let i = 0; i < sections.length; i += concurrency) {
    const chunk = sections.slice(i, i + concurrency);
    const results = await Promise.all(
      chunk.map(async (sec) => {
        let coords: [number, number][] = [];
        if (sec.geometry?.type === "LineString") {
          coords = sec.geometry.coordinates as [number, number][];
        } else if (sec.geometry?.type === "MultiLineString") {
          const multi = sec.geometry.coordinates as [number, number][][];
          coords = multi.flat();
        }

        try {
          const edges = await matchSectionToEdges(coords);
          return { sec, edges };
        } catch {
          return { sec, edges: null };
        }
      }),
    );

    for (const { sec, edges } of results) {
      if (edges && edges.length > 0) {
        mappings.push({
          sectionId: sec.sectionId,
          city: sec.city,
          roadName: sec.roadName,
          edges,
        });
        mappedCount++;
        totalEdges += edges.length;
      } else {
        unmappedCount++;
      }
    }

    const processed = Math.min(i + concurrency, sections.length);
    if (processed % 100 === 0 || processed === sections.length) {
      console.log(
        `[generate-tdx-valhalla-map] Progress: ${processed}/${sections.length} (${(
          (processed / sections.length) *
          100
        ).toFixed(
          1,
        )}%) - Mapped: ${mappedCount}, Unmapped: ${unmappedCount}, Total Edges: ${totalEdges}`,
      );
    }
  }

  const output: TdxValhallaEdgeMap = {
    version: "1.0.0",
    generatedAt: new Date().toISOString(),
    valhallaTilesetVersion: status?.tileset_last_modified,
    totalSections: sections.length,
    mappedSections: mappedCount,
    unmappedSections: unmappedCount,
    totalEdges,
    mappings,
  };

  const resolvedOutPath = path.resolve(process.cwd(), options.outPath);
  await fs.mkdir(path.dirname(resolvedOutPath), { recursive: true });
  await fs.writeFile(resolvedOutPath, JSON.stringify(output, null, 2), "utf8");

  console.log(
    `[generate-tdx-valhalla-map] Successfully wrote ${mappedCount} mappings (${totalEdges} edges) to ${resolvedOutPath}`,
  );

  return output;
}

// Direct execution entrypoint
if (process.argv[1] && process.argv[1].includes("generate-tdx-valhalla-map")) {
  runGenerateMap()
    .then(async () => {
      await mongoose.disconnect();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error("[generate-tdx-valhalla-map] Fatal error:", err);
      await mongoose.disconnect();
      process.exit(1);
    });
}
