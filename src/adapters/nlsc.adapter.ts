import {
  NLSC_BASE_URL,
  NLSC_POINT_QUERY_PATH,
  NLSC_TIMEOUT_MS,
  NLSC_CACHE_MAX,
  NLSC_CACHE_TTL_MS,
  NLSC_XML_MAX_LENGTH,
} from "../config/nlsc";
import { TaiwanCityEn } from "../types/transit";

export interface NlscAdministrativeArea {
  city: TaiwanCityEn;
  town?: string;
  village?: string;
}

const COUNTY_BY_CODE: Readonly<Record<string, TaiwanCityEn>> = {
  A: TaiwanCityEn.Taipei,
  B: TaiwanCityEn.Taichung,
  C: TaiwanCityEn.Keelung,
  D: TaiwanCityEn.Tainan,
  E: TaiwanCityEn.Kaohsiung,
  F: TaiwanCityEn.NewTaipei,
  G: TaiwanCityEn.YilanCounty,
  H: TaiwanCityEn.Taoyuan,
  I: TaiwanCityEn.Chiayi,
  J: TaiwanCityEn.HsinchuCounty,
  K: TaiwanCityEn.MiaoliCounty,
  M: TaiwanCityEn.NantouCounty,
  N: TaiwanCityEn.ChanghuaCounty,
  O: TaiwanCityEn.Hsinchu,
  P: TaiwanCityEn.YunlinCounty,
  Q: TaiwanCityEn.ChiayiCounty,
  T: TaiwanCityEn.PingtungCounty,
  U: TaiwanCityEn.HualienCounty,
  V: TaiwanCityEn.TaitungCounty,
  W: TaiwanCityEn.KinmenCounty,
  X: TaiwanCityEn.PenghuCounty,
  Z: TaiwanCityEn.LienchiangCounty,
};

const XML_FIELDS = new Set([
  "ctyCode",
  "ctyName",
  "townCode",
  "townName",
  "officeCode",
  "officeName",
  "sectCode",
  "sectName",
  "villageCode",
  "villageName",
]);
const XML_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

class TtlLruCache<V> {
  private readonly entries = new Map<string, { value: V; expiresAt: number }>();

  constructor(
    private readonly maxSize: number,
    private readonly ttlMs: number,
  ) {}

  /** Return unexpired values and refresh their LRU position. */
  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  /** Retain a bounded number of values with a fixed expiry. */
  set(key: string, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: Date.now() + this.ttlMs });
    if (this.entries.size > this.maxSize) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
  }
}

const areaCache = new TtlLruCache<NlscAdministrativeArea>(
  NLSC_CACHE_MAX,
  NLSC_CACHE_TTL_MS,
);

/** Decode only XML predefined/numeric entities; never resolve DTD or external entities. */
function decodeXmlText(text: string): string {
  for (const character of text) {
    const code = character.codePointAt(0)!;
    if (!(
      code === 9 ||
      code === 10 ||
      code === 13 ||
      (code >= 0x20 && code <= 0xd7ff) ||
      (code >= 0xe000 && code <= 0xfffd) ||
      (code >= 0x10000 && code <= 0x10ffff)
    )) {
      throw new Error("Invalid XML character");
    }
  }
  if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);)/.test(text)) {
    throw new Error("Invalid XML entity");
  }
  return text
    .replace(/&([^;]+);/g, (_, entity: string) => {
      if (Object.prototype.hasOwnProperty.call(XML_ENTITIES, entity))
        return XML_ENTITIES[entity];
      const code = entity.startsWith("#x")
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10);
      if (!(
        code === 9 ||
        code === 10 ||
        code === 13 ||
        (code >= 0x20 && code <= 0xd7ff) ||
        (code >= 0xe000 && code <= 0xfffd) ||
        (code >= 0x10000 && code <= 0x10ffff)
      )) {
        throw new Error("Invalid XML character");
      }
      return String.fromCodePoint(code);
    })
    .trim();
}

/** Parse NLSC's bounded, flat XML format strictly; reject malformed or unfamiliar payloads. */
function parseAdministrativeArea(xml: string): NlscAdministrativeArea | null {
  if (xml.length > NLSC_XML_MAX_LENGTH) throw new Error("Oversized XML");
  const root =
    /^\s*(?:<\?xml\s[^?]*\?>\s*)?<townVillageItem>\s*([\s\S]*?)\s*<\/townVillageItem>\s*$/.exec(
      xml,
    );
  if (!root) throw new Error("Unexpected XML root");
  const body = root[1];
  if (
    /^<error>\s*<error>NO_LAND<\/error>\s*<message>[^<]*<\/message>\s*<\/error>$/.test(
      body,
    )
  ) {
    console.warn("[nlsc] NO_LAND");
    return null;
  }
  const fields = new Map<string, string>();
  const fieldPattern = /\s*<([a-zA-Z]+)>([^<]*)<\/\1>\s*/gy;
  let offset = 0;
  while (offset < body.length) {
    fieldPattern.lastIndex = offset;
    const field = fieldPattern.exec(body);
    if (!field || !XML_FIELDS.has(field[1]) || fields.has(field[1])) {
      throw new Error("Unexpected XML field");
    }
    fields.set(field[1], decodeXmlText(field[2]));
    offset = fieldPattern.lastIndex;
  }
  const code = fields.get("ctyCode") ?? "";
  const city = Object.prototype.hasOwnProperty.call(COUNTY_BY_CODE, code)
    ? COUNTY_BY_CODE[code]
    : undefined;
  if (!city) throw new Error("Unknown county code");
  const town = fields.get("townName");
  const village = fields.get("villageName");
  return { city, ...(town ? { town } : {}), ...(village ? { village } : {}) };
}

/** Resolve coordinates through NLSC with a 1.5s deadline and success-only bounded cache. */
export async function getNlscAdministrativeArea(
  lat: number,
  lng: number,
): Promise<NlscAdministrativeArea | null> {
  const key = `${lat.toFixed(4)},${lng.toFixed(4)}`;
  const cached = areaCache.get(key);
  if (cached) return { ...cached };
  try {
    const response = await fetch(
      `${NLSC_BASE_URL}${NLSC_POINT_QUERY_PATH}/${lng}/${lat}/4326`,
      { signal: AbortSignal.timeout(NLSC_TIMEOUT_MS) },
    );
    if (response.status !== 200) {
      console.warn("[nlsc] HTTP failure", { status: response.status });
      return null;
    }
    const area = parseAdministrativeArea(await response.text());
    if (area) areaCache.set(key, area);
    return area ? { ...area } : null;
  } catch {
    console.warn("[nlsc] request failed, timed out or returned unexpected XML");
    return null;
  }
}
