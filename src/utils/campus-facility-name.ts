/** Removes MOE control instructions only; ordinary parentheses and qualifiers survive. */
function stripControlText(value?: string): string {
  return (value ?? "")
    .trim()
    .replace(/^查看詳情\s*[：:]\s*/, "")
    .replace(/(?:\s*[（(]\s*(?:開啟詳細資訊|開啟視窗)\s*[)）])+\s*$/, "")
    .trim();
}

/** Clean short source name, shared by new imports and legacy read projections. */
export function normalizeCampusFacilityName(
  name?: string,
  category?: string,
): string {
  let cleaned = stripControlText(name);
  const type = stripControlText(category);
  const parts = cleaned.split(/[，,]\s*/);
  if (
    parts.length > 1 &&
    ((type && parts[0].trim() === type) ||
      /[（(](?:開啟詳細資訊|開啟視窗)[)）]\s*$/.test(name ?? ""))
  ) {
    cleaned = parts.slice(1).join("，").trim();
  }
  const repeated = cleaned.split(/[，,]\s*/).map((part) => part.trim());
  if (
    repeated.length > 1 &&
    repeated[0] &&
    repeated.every((part) => part === repeated[0])
  ) {
    cleaned = repeated[0];
  }
  return cleaned || type;
}

export function normalizeCampusBuilding(building?: string): string {
  return (building ?? "")
    .trim()
    .replace(/^建築物\s*[：:]\s*/, "")
    .trim();
}

/** Retains the source's floor order and descriptors; never invents a served range. */
export function normalizeCampusFloors(
  floors: readonly string[] = [],
): string[] {
  return [...new Set(floors.map((floor) => floor.trim()).filter(Boolean))];
}

interface CampusFacilityLabelInput {
  schoolName?: string;
  branchName?: string;
  building?: string;
  floors?: readonly string[];
  name?: string;
  facType?: string;
}

/** Readable map label made exclusively from available source-backed location fields. */
export function formatCampusFacilityLabel(
  source: CampusFacilityLabelInput,
): string {
  const name =
    normalizeCampusFacilityName(source.name, source.facType) ||
    "校園無障礙設施";
  const school = source.schoolName?.trim() ?? "";
  const branch = source.branchName?.trim() ?? "";
  const campus =
    school && branch && school !== branch
      ? school + "／" + branch
      : school || branch;
  const building = normalizeCampusBuilding(source.building);
  const floors = normalizeCampusFloors(source.floors).map((floor) => {
    // Some source floor labels repeat the exact facility name ("1F 無障礙廁所").
    // Keep other descriptors such as "1F 辦公室" or "1F 東側".
    const match = /^((?:B?\d+F|地下\d+樓|\d+樓))\s+(.+)$/i.exec(floor);
    return match && match[2] === name ? match[1] : floor;
  });
  return [campus, building, [...new Set(floors)].join(", "), name]
    .filter(Boolean)
    .join(" · ");
}
