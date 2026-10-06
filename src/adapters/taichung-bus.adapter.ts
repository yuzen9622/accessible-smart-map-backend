/**
 * 臺中市公車即時動態資訊 (citybus.taichung.gov.tw) GraphQL. TDX carries only 96
 * Taichung vehicles, all flagged non-low-floor and none matching live plates,
 * so the city's own daily dispatch (dailyTimeTable carId + carType) is the
 * source of truth for which plate is accessible.
 */
import type { BusFleetObservation } from "../types";
import { mergeFleetObservation } from "../utils/bus-fleet";

const TAICHUNG_GRAPHQL_URL = "https://citybus.taichung.gov.tw/ebus/graphql";
const TAICHUNG_TIMEOUT_MS = 30_000;
const TAICHUNG_ROUTES_PER_QUERY = 40;
const TAICHUNG_BATCH_GAP_MS = 300;

const ACCESSIBLE_CAR_TYPES = new Set([
  "dsby",
  "lfv",
  "lfv_2",
  "midi_dsby",
  "ev",
]);
const STANDARD_CAR_TYPES = new Set(["no_s", "midi", "sml", "sidi"]);

interface TimetableNode {
  carId?: string | null;
  carType?: string | null;
}

type TimetableResponse = Record<
  string,
  { edges?: { node?: TimetableNode }[] } | null
>;

/**
 * Map a Taichung car type to the TDX IsLowFloor convention. The accessible set
 * is what the city's own map draws with the wheelchair icon (`ev` is drawn as
 * `ev_dsby`).
 *
 * @param carType The `carType` value from the city's dispatch data.
 * @returns 1 for accessible, 0 for a standard bus, undefined when unknown.
 */
export function taichungLowFloorFlag(
  carType: string | null | undefined,
): 0 | 1 | undefined {
  const type = carType?.trim();
  if (!type) return undefined;
  if (ACCESSIBLE_CAR_TYPES.has(type)) return 1;
  if (STANDARD_CAR_TYPES.has(type)) return 0;
  return undefined;
}

/**
 * Turn one batched dailyTimeTable response into per-plate observations.
 *
 * @param data The GraphQL `data` object, keyed by query alias.
 * @returns One observation per plate with a known car type.
 */
export function parseTaichungTimetables(
  data: TimetableResponse,
): BusFleetObservation[] {
  const byPlate = new Map<string, BusFleetObservation>();
  for (const [alias, table] of Object.entries(data)) {
    // Each alias is `r<xno>`; the city's xno is also TDX's Taichung RouteID.
    const routeId = alias.replace(/^r/, "");
    for (const edge of table?.edges ?? []) {
      const plate = edge.node?.carId?.trim().toUpperCase();
      const flag = taichungLowFloorFlag(edge.node?.carType);
      if (!plate || flag === undefined) continue;
      mergeFleetObservation(byPlate, {
        plateNumb: plate,
        city: "Taichung",
        isLowFloor: flag,
        source: "taichung-ebus",
        cityRouteIds: [routeId],
      });
    }
  }
  return [...byPlate.values()];
}

/**
 * POST one query to the Taichung GraphQL endpoint.
 *
 * @param query The GraphQL query text.
 * @returns The `data` object of the response.
 */
async function queryTaichung<T>(query: string): Promise<T> {
  const res = await fetch(TAICHUNG_GRAPHQL_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(TAICHUNG_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Taichung ebus HTTP ${res.status}`);
  const body = (await res.json()) as { data?: T; errors?: unknown[] };
  if (!body.data) {
    throw new Error(
      `Taichung ebus GraphQL error: ${JSON.stringify(body.errors ?? []).slice(0, 200)}`,
    );
  }
  return body.data;
}

/**
 * Fetch every plate dispatched on the given day with its low-floor status.
 *
 * @param date Service date as YYYY-MM-DD (Taipei time).
 * @returns Per-plate observations for the whole Taichung city-bus fleet that day.
 */
export async function fetchTaichungFleet(
  date: string,
): Promise<BusFleetObservation[]> {
  const routes = await queryTaichung<{
    routes: { edges: { node: { id: string } }[] };
  }>('{ routes(lang: "zh") { edges { node { id } } } }');
  const ids = routes.routes.edges
    .map((e) => e.node.id)
    .filter((id) => /^\d+$/.test(id));

  const byPlate = new Map<string, BusFleetObservation>();
  for (let i = 0; i < ids.length; i += TAICHUNG_ROUTES_PER_QUERY) {
    const aliases = ids
      .slice(i, i + TAICHUNG_ROUTES_PER_QUERY)
      .map(
        (id) =>
          `r${id}: dailyTimeTable(xno: ${id}, date: "${date}") { edges { node { carId carType } } }`,
      )
      .join(" ");
    const data = await queryTaichung<TimetableResponse>(`{ ${aliases} }`);
    for (const obs of parseTaichungTimetables(data)) {
      mergeFleetObservation(byPlate, obs);
    }
    await new Promise((r) => setTimeout(r, TAICHUNG_BATCH_GAP_MS));
  }
  return [...byPlate.values()];
}
