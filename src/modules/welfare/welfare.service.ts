import type { SupportedLang } from "../../types/lang";
import type { IWelfare } from "../../types";
import { selectDisplayText } from "../../utils/source-display";
import {
  findNearbyWelfare,
  findWelfareBy,
  findWelfareById,
} from "./welfare.repository";

/** Welfare institutions within `radiusM` of the point (only geocoded ones have a location). */
export async function findNearby(
  lat: number,
  lng: number,
  radiusM = 1000,
  lang?: SupportedLang,
) {
  return (await findNearbyWelfare(lat, lng, radiusM)).map((row) =>
    displayWelfare(row, lang),
  );
}

/** Directory listing, optionally filtered by county and/or institution type. */
export async function findAll(
  filter: { county?: string; type?: string } = {},
  lang?: SupportedLang,
) {
  return (await findWelfareBy(filter)).map((row) => displayWelfare(row, lang));
}

/** Single institution by id, or null if the id is malformed or not found. */
export async function findById(id: string, lang?: SupportedLang) {
  const row = await findWelfareById(id);
  return row ? displayWelfare(row, lang) : null;
}

function displayWelfare(row: IWelfare, lang?: SupportedLang) {
  if (lang === undefined) return row;
  return {
    ...row,
    displayName: selectDisplayText(row.name, undefined, lang),
    displayAddress: selectDisplayText(row.address, undefined, lang),
  };
}
