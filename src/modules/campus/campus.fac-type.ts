/**
 * Canonical registry of campus accessibility facility types.
 *
 * `id` is the MOE facTypeId (a stable government code from
 * `GET /api/Base/FacType`); `code` is the machine-friendly slug the API uses
 * for filtering so clients never depend on Chinese strings. IDs are
 * non-contiguous (the source skips 12/14/15), so this table is the single
 * source of truth — never assume a dense range.
 */

export interface CampusFacType {
  /** MOE facTypeId — stable numeric code stored on each facility. */
  id: number;
  /** Machine-friendly slug used by the API `type` filter. */
  code: string;
  /** Chinese display label. */
  label: string;
  /** Whether the MOE source marks this as a commonly used type. */
  common: boolean;
  /** Display order (MOE SEQ). */
  seq: number;
}

export const CAMPUS_FAC_TYPES: readonly CampusFacType[] = [
  { id: 1, code: "outdoor_path", label: "室外通路", common: false, seq: 0 },
  { id: 2, code: "ramp", label: "無障礙坡道", common: true, seq: 1 },
  {
    id: 3,
    code: "building_entrance",
    label: "建築物出入口",
    common: false,
    seq: 2,
  },
  {
    id: 4,
    code: "indoor_outdoor_entrance",
    label: "室內外出入口",
    common: false,
    seq: 3,
  },
  {
    id: 5,
    code: "accessible_stairs",
    label: "無障礙樓梯",
    common: false,
    seq: 4,
  },
  {
    id: 6,
    code: "accessible_toilet",
    label: "無障礙廁所",
    common: true,
    seq: 5,
  },
  {
    id: 7,
    code: "indoor_corridor",
    label: "無障礙室內走廊",
    common: false,
    seq: 6,
  },
  { id: 8, code: "elevator", label: "無障礙電梯", common: true, seq: 7 },
  {
    id: 9,
    code: "accessible_bathroom",
    label: "無障礙浴室",
    common: false,
    seq: 8,
  },
  {
    id: 10,
    code: "wheelchair_seating",
    label: "輪椅觀眾席",
    common: false,
    seq: 9,
  },
  {
    id: 11,
    code: "accessible_parking",
    label: "無障礙停車位",
    common: true,
    seq: 10,
  },
  {
    id: 13,
    code: "accessible_dormitory",
    label: "無障礙寢室",
    common: false,
    seq: 12,
  },
  {
    id: 16,
    code: "accessible_motorcycle_parking",
    label: "無障礙機車停車位",
    common: false,
    seq: 15,
  },
];

/** All type codes, ordered by display sequence — usable as a Zod enum. */
export const CAMPUS_FAC_TYPE_CODES = CAMPUS_FAC_TYPES.map((t) => t.code);

const BY_CODE = new Map(CAMPUS_FAC_TYPES.map((t) => [t.code, t]));
const BY_ID = new Map(CAMPUS_FAC_TYPES.map((t) => [t.id, t]));
const BY_LABEL = new Map(CAMPUS_FAC_TYPES.map((t) => [t.label, t]));

/**
 * Resolves a type slug to its MOE facTypeId.
 * @param code machine-friendly type slug
 * @returns the facTypeId, or undefined for an unknown code
 */
export function codeToId(code: string): number | undefined {
  return BY_CODE.get(code)?.id;
}

/**
 * Resolves a MOE facTypeId to the canonical type entry, falling back to a
 * Chinese label lookup for legacy facilities that stored only `facType`.
 * @param id facTypeId (may be undefined)
 * @param label Chinese label fallback (may be undefined)
 * @returns the matching type entry, or undefined when neither resolves
 */
export function resolveFacType(
  id?: number,
  label?: string,
): CampusFacType | undefined {
  if (id != null && BY_ID.has(id)) return BY_ID.get(id);
  if (label && BY_LABEL.has(label)) return BY_LABEL.get(label);
  return undefined;
}
