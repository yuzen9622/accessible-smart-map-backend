/**
 * 基隆市公車資訊便民服務網 (ebus.klcba.gov.tw, 9284). TDX has no Keelung vehicle
 * table and iBus flags every Keelung route as inaccessible, while the city's
 * own realtime feed marks each running bus. Only buses currently in service
 * are visible, so callers accumulate plates across polls.
 */
import type { BusFleetObservation } from "../types";

const KEELUNG_API_BASE = "https://ebus.klcba.gov.tw/IMP/jsp/rwd_api";
const KEELUNG_TIMEOUT_MS = 15_000;
const KEELUNG_REQUEST_GAP_MS = 300;

interface KeelungRouteStatus {
  id?: number | string;
  hasBus?: boolean;
  bHasBus_back?: boolean;
}

interface KeelungBus {
  carNo?: string;
  imgTag?: string;
}

/**
 * Read the low-floor flag from a Keelung bus record. The city's own page
 * draws the wheelchair icon when the first digit of `imgTag` is 1.
 *
 * @param bus One `busData` entry.
 * @returns 1 for low-floor, 0 for a standard bus, undefined when absent.
 */
export function keelungLowFloorFlag(bus: KeelungBus): 0 | 1 | undefined {
  const head = bus.imgTag?.trim().charAt(0);
  if (head === "1") return 1;
  if (head === "0") return 0;
  return undefined;
}

/**
 * Turn `busData` entries into per-plate observations.
 *
 * @param buses The `busData` array of one route direction.
 * @returns One observation per plate with a readable flag.
 */
export function parseKeelungBuses(
  buses: KeelungBus[] | undefined,
): BusFleetObservation[] {
  const out: BusFleetObservation[] = [];
  for (const bus of buses ?? []) {
    const plate = bus.carNo?.trim().toUpperCase();
    const flag = keelungLowFloorFlag(bus);
    if (!plate || flag === undefined) continue;
    out.push({
      plateNumb: plate,
      city: "Keelung",
      isLowFloor: flag,
      source: "keelung-ebus",
    });
  }
  return out;
}

/**
 * POST a form-encoded request to one Keelung endpoint.
 *
 * @param path The JSP file name under the RWD API base.
 * @param form The form fields.
 * @returns The parsed JSON body.
 */
async function postKeelung<T>(
  path: string,
  form: Record<string, string>,
): Promise<T> {
  const res = await fetch(`${KEELUNG_API_BASE}/${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(KEELUNG_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Keelung ebus ${path} HTTP ${res.status}`);
  return (await res.json()) as T;
}

/**
 * Fetch every bus currently running on a Keelung route with its low-floor flag.
 *
 * @returns Per-plate observations for buses in service right now.
 */
export async function fetchKeelungFleet(): Promise<BusFleetObservation[]> {
  const status = await postKeelung<{ data?: KeelungRouteStatus[] }>(
    "ajax_routestatus.jsp",
    { paramType: "GetRouteStatus", Lang: "cht" },
  );
  const targets: { id: string; goback: "0" | "1" }[] = [];
  for (const route of status.data ?? []) {
    if (route.id == null) continue;
    const id = String(route.id);
    if (route.hasBus) targets.push({ id, goback: "0" });
    if (route.bHasBus_back) targets.push({ id, goback: "1" });
  }

  const byPlate = new Map<string, BusFleetObservation>();
  for (const target of targets) {
    try {
      const info = await postKeelung<{ busData?: KeelungBus[] }>(
        "ajax_routeinfo_pathattr.jsp",
        target,
      );
      for (const obs of parseKeelungBuses(info.busData)) {
        byPlate.set(obs.plateNumb, obs);
      }
    } catch (err) {
      console.warn(
        `[bus-fleet] Keelung route ${target.id}/${target.goback} failed: ${(err as Error).message}`,
      );
    }
    await new Promise((r) => setTimeout(r, KEELUNG_REQUEST_GAP_MS));
  }
  return [...byPlate.values()];
}
