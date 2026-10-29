/**
 * Pure parsing helpers for the MOE Campus Accessibility Map (cam.moe.gov.tw).
 *
 * `POST /Facility/FacilityResultList` returns server-rendered HTML (not JSON),
 * with facility photos inlined as base64 data URIs (a single campus can exceed
 * 20 MB). These helpers strip the images and extract the structured data the
 * importer needs. Kept I/O-free so they can be unit-tested.
 */

import { parseGeoPoint } from "../utils/campus-geo";
export { mercatorToWgs84, parseGeoPoint } from "../utils/campus-geo";

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/**
 * Decodes numeric (&#x81FA; / &#21488;) and common named HTML entities.
 * @param s encoded string
 * @returns decoded string
 */
export function decodeHtmlEntities(s: string): string {
  return s.replace(
    /&#x([0-9a-fA-F]+);|&#(\d+);|&([a-zA-Z]+);/g,
    (match, hex, dec, name) => {
      if (hex) return String.fromCodePoint(parseInt(hex, 16));
      if (dec) return String.fromCodePoint(parseInt(dec, 10));
      return NAMED_ENTITIES[name] ?? match;
    },
  );
}

export interface ParsedCampusFacility {
  facUid: string;
  facTypeId: number | null;
  facType: string | null;
  name: string;
  building: string | null;
  buildingUid: string | null;
  floors: string[];
  floorIds: string[];
}

export interface ParsedCampusResult {
  complete: boolean;
  noResult: boolean;
  campusGeo: { lat: number; lng: number } | null;
  address: string | null;
  phone: string | null;
  buildingCount: number;
  facilityCount: number;
  facilities: ParsedCampusFacility[];
}

function extractAttr(attrs: string, name: string): string | null {
  const m = new RegExp(`${name}="([^"]*)"`).exec(attrs);
  return m ? decodeHtmlEntities(m[1]) : null;
}

/**
 * Parses the FacilityResultList HTML for one campus.
 *
 * The same physical facility (one elevator serving 7 floors) is rendered as
 * one button per floor, so facilities are deduplicated by `data-fac-uid` with
 * floors merged — this matches the site's own facility counter.
 * @param rawHtml response body of POST /Facility/FacilityResultList
 * @returns structured campus info + deduplicated facility list
 */
export function parseFacilityResultHtml(rawHtml: string): ParsedCampusResult {
  const raw = rawHtml.replace(/data:image\/[a-z]+;base64,[A-Za-z0-9+/=]+/g, "");

  const result: ParsedCampusResult = {
    complete: false,
    noResult: raw.includes('id="noResult"'),
    campusGeo: null,
    address: null,
    phone: null,
    buildingCount: 0,
    facilityCount: 0,
    facilities: [],
  };
  if (result.noResult) return result;

  const geoMatch = /data-geo="([^"]+)"/.exec(raw);
  if (geoMatch)
    result.campusGeo = parseGeoPoint(decodeHtmlEntities(geoMatch[1]));

  const addrMatch = /校園地址：\s*([^<]+)</.exec(raw);
  if (addrMatch) result.address = decodeHtmlEntities(addrMatch[1]).trim();

  const phoneMatch = /聯絡電話：\s*([^<]+)</.exec(raw);
  if (phoneMatch) result.phone = decodeHtmlEntities(phoneMatch[1]).trim();

  const firstArticle = raw.indexOf("<article");
  const header = decodeHtmlEntities(
    firstArticle >= 0 ? raw.slice(0, firstArticle) : raw,
  );
  const countMatch = /共\s*(\d+)\s*筆建物，(\d+)\s*筆設施/.exec(header);
  if (countMatch) {
    result.buildingCount = parseInt(countMatch[1], 10);
    result.facilityCount = parseInt(countMatch[2], 10);
  }

  const byUid = new Map<string, ParsedCampusFacility>();
  const articles = raw.split('<article class="result-all-item"').slice(1);
  for (const article of articles) {
    const buildingMatch = /<h2 id="[^"]*"[^>]*aria-label="([^"]*)"/.exec(
      article,
    );
    const building = buildingMatch
      ? decodeHtmlEntities(buildingMatch[1])
      : null;

    const levelRe =
      /<div class="level" data-level="([^"]*)"([\s\S]*?)(?=<div class="level"|<\/article>|$)/g;
    for (
      let level = levelRe.exec(article);
      level;
      level = levelRe.exec(article)
    ) {
      const floorName = decodeHtmlEntities(level[1]).trim();
      const buttonRe =
        /<button class="[^"]*btn-fac-detail"([\s\S]*?)<\/button>/g;
      for (
        let button = buttonRe.exec(level[2]);
        button;
        button = buttonRe.exec(level[2])
      ) {
        const attrs = button[1];
        const facUid = extractAttr(attrs, "data-fac-uid");
        if (!facUid) continue;

        let fac = byUid.get(facUid);
        if (!fac) {
          const label = extractAttr(attrs, "aria-label") ?? "";
          const labelMatch = /^查看詳情：([^，]+)，(.+?)\s*\(開啟視窗\)/.exec(
            label,
          );
          const typeIdRaw = extractAttr(attrs, "data-type");
          fac = {
            facUid,
            facTypeId: typeIdRaw ? parseInt(typeIdRaw, 10) : null,
            facType: labelMatch ? labelMatch[1] : null,
            name: labelMatch ? labelMatch[2] : label,
            building,
            buildingUid: extractAttr(attrs, "data-building-uid"),
            floors: [],
            floorIds: [],
          };
          byUid.set(facUid, fac);
        }
        if (floorName && !fac.floors.includes(floorName)) {
          fac.floors.push(floorName);
        }
        const floorId = extractAttr(attrs, "data-floor-id");
        if (floorId && !fac.floorIds.includes(floorId)) {
          fac.floorIds.push(floorId);
        }
      }
    }
  }
  result.facilities = [...byUid.values()];
  result.complete =
    Boolean(countMatch) &&
    articles.length > 0 &&
    result.facilityCount > 0 &&
    result.facilityCount === result.facilities.length;
  return result;
}

export interface ParsedFacilityDetail {
  geo: { lat: number; lng: number } | null;
  specs: { label: string; value: string }[];
}

/**
 * Parses the single-facility detail HTML (POST /Facility/FacilityResult) for
 * the facility's own coordinate and its accessibility spec bullets. Photos are
 * base64-inlined (~2 MB) and stripped first.
 *
 * Specs render as `●label:value` bullets whose value ends at the next tag or
 * bullet, so the value class excludes `<` and `●` to avoid swallowing adjacent
 * button text. Labels are deduplicated, keeping the first occurrence.
 * @param rawHtml response body of POST /Facility/FacilityResult
 * @returns facility WGS84 geo (or null) + ordered label/value spec pairs
 */
export function parseFacilityDetailHtml(rawHtml: string): ParsedFacilityDetail {
  const raw = decodeHtmlEntities(
    rawHtml.replace(/data:image\/[a-z]+;base64,[A-Za-z0-9+/=]+/g, ""),
  );

  const geoMatch = /data-facility-geo="([^"]+)"/.exec(raw);
  const geo = geoMatch ? parseGeoPoint(geoMatch[1]) : null;

  const specs: { label: string; value: string }[] = [];
  const seen = new Set<string>();
  const bulletRe = /●\s*([^：:<●]{1,20}?)\s*[:：]\s*([^<●\n]{1,40})/g;
  for (let m = bulletRe.exec(raw); m; m = bulletRe.exec(raw)) {
    const label = m[1].trim();
    const value = m[2].trim();
    if (!label || !value || seen.has(label)) continue;
    seen.add(label);
    specs.push({ label, value });
  }

  return { geo, specs };
}
