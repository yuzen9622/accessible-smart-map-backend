/**
 * Robust Overpass API client.
 *
 * Public Overpass instances are chronically overloaded — HTTP 504/429 and
 * dropped connections are the normal state, not an exception. Every request
 * is therefore a lottery ticket: this adapter rotates through several public
 * instances, retries each one with exponential backoff on transient failures,
 * and only gives up after every instance has failed. All endpoint errors are
 * reported together so one silent failure never hides the real cause (the
 * previous two-endpoint call sites overwrote the first error and surfaced
 * only the last one).
 */

export interface OverpassFetchOptions {
  /** Descriptive User-Agent; public instances throttle unrecognized UAs. */
  userAgent?: string;
  /** Budget for a single HTTP attempt (ms). Must exceed the query's own `[timeout:N]`. Default 90_000. */
  timeoutMs?: number;
  /** HTTP attempts per endpoint before moving to the next. Default 2. */
  attemptsPerEndpoint?: number;
  /** Base retry delay (ms), doubled after each failed attempt. Default 3_000. */
  retryDelayMs?: number;
}

/**
 * Full-planet public instances. Region-restricted ones (overpass.osm.jp,
 * overpass.osm.ch, overpass.amscloud.de…) are excluded because callers query
 * Taiwan-wide data.
 */
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass.openstreetmap.ru/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  "https://overpass.kaart.com/api/interpreter",
];

/** Statuses worth retrying — the instance is busy or temporarily broken. */
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** One-line, truncated error body so a giant HTML error page never floods the log. */
function summarizeBody(body: string): string {
  const oneLine = body.replace(/\s+/g, " ").trim();
  return oneLine.length > 200 ? `${oneLine.slice(0, 200)}…` : oneLine;
}

/** Overpass sometimes answers HTTP 200 with a runtime error in `remark` (e.g. query timeout). */
function hasRuntimeError(json: { remark?: unknown }): boolean {
  return typeof json.remark === "string" && json.remark.includes("runtime error");
}

/**
 * Runs an Overpass query against every public instance until one succeeds.
 *
 * @param query Raw Overpass QL, e.g. `[out:json][timeout:60];…;out body;`.
 * @returns The parsed `elements` array (empty when the query matched nothing).
 * @throws When every endpoint failed; the message lists each endpoint's error.
 */
export async function fetchOverpassElements(
  query: string,
  options: OverpassFetchOptions = {}
): Promise<any[]> {
  const {
    userAgent = "accessible-smart-map-backend/1.0 (accessibility data import)",
    timeoutMs = 90_000,
    attemptsPerEndpoint = 2,
    retryDelayMs = 3_000,
  } = options;

  // Rotate the starting endpoint so repeated runs spread load instead of
  // hammering the first instance every time.
  const start = Math.floor(Math.random() * OVERPASS_ENDPOINTS.length);
  const endpoints = OVERPASS_ENDPOINTS.map(
    (_, i) => OVERPASS_ENDPOINTS[(start + i) % OVERPASS_ENDPOINTS.length]
  );

  const failures: string[] = [];

  for (const url of endpoints) {
    for (let attempt = 1; attempt <= attemptsPerEndpoint; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let retryable = true;
      try {
        const resp = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
            "User-Agent": userAgent,
          },
          body: `data=${encodeURIComponent(query)}`,
          signal: controller.signal,
        });

        const bodyText = await resp.text();

        if (resp.ok) {
          let json: { elements?: any[]; remark?: unknown } | null = null;
          try {
            json = JSON.parse(bodyText);
          } catch {
            // Not JSON — fall through to the failure branch below.
          }
          if (json && !hasRuntimeError(json)) {
            return json.elements ?? [];
          }
          failures.push(
            `${url} (attempt ${attempt}): HTTP ${resp.status} runtime error` +
              (json?.remark ? ` — ${summarizeBody(String(json.remark))}` : "")
          );
          // A 200-with-remark means the query itself hit its timeout — re-running
          // the same instance rarely helps; move on to the next one.
          retryable = false;
        } else {
          failures.push(
            `${url} (attempt ${attempt}): HTTP ${resp.status} — ${summarizeBody(bodyText)}`
          );
          // Permanent 4xx (e.g. 400 parse error) won't get better on retry.
          retryable = RETRYABLE_STATUS.has(resp.status);
        }
      } catch (err) {
        const aborted = (err as Error)?.name === "AbortError";
        failures.push(
          `${url} (attempt ${attempt}): ${
            aborted ? `timeout after ${timeoutMs}ms` : (err as Error).message
          }`
        );
        retryable = true; // network errors and timeouts are transient
      } finally {
        clearTimeout(timer);
      }

      if (retryable && attempt < attemptsPerEndpoint) {
        await sleep(retryDelayMs * 2 ** (attempt - 1));
      }
    }
  }

  throw new Error(
    `Overpass request failed on all ${endpoints.length} endpoints ` +
      `(${attemptsPerEndpoint} attempt(s) each): ${failures.join("; ")}`
  );
}
