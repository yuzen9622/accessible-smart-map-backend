import { tdxFetch } from "../config/fetch";
import { alertUrl, metroUrl } from "../config/transit";

const LINE_DIRECTORY_TTL_MS = 12 * 60 * 60 * 1000;

export type TransitLine = { lineId: string; name: string };
export type MetroStationOnLine = {
  stationId: string;
  name: string;
  lineId: string;
};
export type MetroNetwork = {
  lines: TransitLine[];
  stations: MetroStationOnLine[];
};

type LocalizedName = { Zh_tw?: string } | undefined;
type TdxLine = { LineID?: string; LineName?: LocalizedName };
type TdxStationOfLine = {
  LineID?: string;
  Stations?: Array<{ StationID?: string; StationName?: LocalizedName }>;
};

const cache = new Map<string, { value: unknown; expiresAt: number }>();
const inflight = new Map<string, Promise<unknown>>();

/** Drop cached directories (primarily for deterministic tests). */
export function clearTransitLineCache(): void {
  cache.clear();
  inflight.clear();
}

async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value as T;
  const pending = inflight.get(key);
  if (pending) return pending as Promise<T>;
  const promise = load()
    .then((value) => {
      cache.set(key, { value, expiresAt: Date.now() + LINE_DIRECTORY_TTL_MS });
      return value;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await tdxFetch(`${url}?$format=JSON`);
  if (!response.ok) throw new Error(`TDX ${response.status}`);
  return response.json();
}

function toLines(rows: TdxLine[]): TransitLine[] {
  return rows.flatMap((row) =>
    row.LineID && row.LineName?.Zh_tw
      ? [{ lineId: row.LineID, name: row.LineName.Zh_tw }]
      : [],
  );
}

/**
 * Fetch a metro system's lines and the stations on each line, cached for 12 h.
 * Throws on upstream failure or an empty/malformed payload (never cached) so
 * callers never mistake an outage for an unknown name.
 *
 * @param railSystem TDX metro system code, e.g. "TRTC".
 * @returns The system's line directory and per-line station list.
 */
export function fetchMetroNetwork(railSystem: string): Promise<MetroNetwork> {
  return cached(`metro:${railSystem}`, async () => {
    const [lines, stationOfLine] = await Promise.all([
      fetchJson(metroUrl.lineUrl(railSystem)),
      fetchJson(metroUrl.stationOfLineUrl(railSystem)),
    ]);
    const stations = (
      Array.isArray(stationOfLine) ? (stationOfLine as TdxStationOfLine[]) : []
    ).flatMap((line) =>
      (line.Stations ?? []).flatMap((station) =>
        line.LineID && station.StationID && station.StationName?.Zh_tw
          ? [
              {
                stationId: station.StationID,
                name: station.StationName.Zh_tw,
                lineId: line.LineID,
              },
            ]
          : [],
      ),
    );
    const network = {
      lines: toLines(Array.isArray(lines) ? (lines as TdxLine[]) : []),
      stations,
    };
    if (!network.lines.length || !network.stations.length)
      throw new Error(`TDX metro network for ${railSystem} is empty`);
    return network;
  });
}

/**
 * Fetch the TRA line directory (LineID ↔ Chinese name), cached for 12 h.
 *
 * @returns The TRA lines.
 */
export function fetchTraLines(): Promise<TransitLine[]> {
  return cached("tra", async () => {
    const body = (await fetchJson(alertUrl.traLineUrl)) as {
      Lines?: TdxLine[];
    };
    const lines = toLines(Array.isArray(body?.Lines) ? body.Lines : []);
    if (!lines.length) throw new Error("TDX TRA line directory is empty");
    return lines;
  });
}
