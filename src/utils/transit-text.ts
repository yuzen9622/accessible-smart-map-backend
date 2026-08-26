import type {
  BusApiType,
  BusRealtimeNearbyStop,
  BusRoute,
  BusRouteQueryScope,
} from "../types/transit";

/**
 * Pure transit text / route helpers — stop-name normalization, route-name
 * formatting, City-vs-InterCity bus API detection, and direction / front-bus
 * resolution. Shared by the transit and accessible-route modules.
 * (Moved out of config/lib.ts: these are domain utilities, not config.)
 */

export function normalizeStopName(name?: string): string {
  if (!name) return "";
  return name
    .normalize("NFKC")
    .replace(/[(（][^）)]*[)）]/g, "")
    .replace(/站/g, "")
    .replace(/\s+/g, "")
    .replace(/臺/g, "台")
    .replace(/[－–—-]/g, "")
    .replace("副線", "副")
    .replace(".", "")
    .replace("Rd", "")
    .toLowerCase()
    .trim();
}

export function equalStopName(a?: string, b?: string): boolean {
  const na = normalizeStopName(a);
  const nb = normalizeStopName(b);
  if (!na || !nb) return false;

  return na === nb || na.includes(nb) || nb.includes(na);
}

export function normalizeRouteName(name?: string): string {
  if (!name) return "";
  return name
    .normalize("NFKC")
    .replace(/[(（][^）)]*[)）]/g, "")
    .replace(/路$/g, "")
    .replace(/\s+/g, "")
    .replace(/臺/g, "台")
    .replace(/[－–—-]/g, "")
    .replace("副線", "副")
    .replace("區間車", "區")
    .replace("區間", "區")
    .replace(".", "")
    .toLowerCase()
    .trim();
}

export function equalRouteName(a?: string, b?: string): boolean {
  const na = normalizeRouteName(a);
  const nb = normalizeRouteName(b);
  if (!na || !nb) return false;
  return na === nb;
}

export function getRouteDirectionImproved(
  routeStopsByDirection: { [direction: number]: BusRoute["Stops"] },
  startStopName: string,
  endStopName: string,
  language: "Zh_tw" | "En",
): number {
  for (const dirStr in routeStopsByDirection) {
    const direction = parseInt(dirStr) as 0 | 1;
    const stops = routeStopsByDirection[direction];
    const normStart = normalizeStopName(startStopName);
    const normEnd = normalizeStopName(endStopName);

    const startIndex = stops.findIndex((s) =>
      equalStopName(s?.StopName?.[language], normStart),
    );
    const endIndex = stops.findIndex((s) =>
      equalStopName(s?.StopName?.[language], normEnd),
    );

    if (startIndex !== -1 && endIndex !== -1) {
      return direction;
    }
  }

  return -1;
}
export function getBusFrontOfArrivalStop(
  stops: BusRoute["Stops"],
  arrivalStopName: string,
  bus: BusRealtimeNearbyStop[],
): BusRealtimeNearbyStop | null {
  const arrivalIndex = stops.findIndex(
    (s) => s.StopName.Zh_tw === arrivalStopName,
  );
  if (arrivalIndex === -1) return null;

  const busesInFront = bus.filter((b) => {
    const busIndex = stops.findIndex((s) => s.StopUID === b.StopUID);
    return busIndex !== -1 && busIndex < arrivalIndex;
  });

  if (busesInFront.length === 0) return null;

  let closestBus = busesInFront[0];
  let maxStopIndex = stops.findIndex((s) => s.StopUID === closestBus.StopUID);

  for (const b of busesInFront) {
    const idx = stops.findIndex((s) => s.StopUID === b.StopUID);
    if (idx > maxStopIndex) {
      maxStopIndex = idx;
      closestBus = b;
    }
  }

  return closestBus;
}

/**
 * 格式化路線名稱，只保留英文字母、數字和特定中文字
 * @param routeName 原始路線名稱 (例如: "307經中港路", "紅50延", "藍1區間車")
 * @returns 格式化後的路線名稱 (例如: "307", "紅50延", "藍1區間")
 */
export function formatRouteName(routeName: string): string {
  const keepChars = [
    "紅",
    "藍",
    "綠",
    "黃",
    "橘",
    "橙",
    "棕",
    "粉",
    "灰",
    "白",

    "延",
    "副",
    "區",
    "間",
    "幹",
    "快",
    "直",
    "環",
  ];

  const withoutBrackets = routeName.replace(/[(（][^）)]*[)）]/g, "");

  return withoutBrackets
    .split("")
    .filter((char) => {
      if (/[A-Za-z0-9]/.test(char)) return true;

      if (keepChars.includes(char)) return true;

      return false;
    })
    .join("");
}

/**
 * Escape a value for embedding inside a single-quoted OData string literal.
 *
 * OData (and SQL) escape a literal quote by doubling it, so an attacker who
 * controls the value cannot terminate the string and inject filter operators
 * (e.g. `eq '' or contains(RouteName/Zh_tw,'x`) into TDX $filter expressions.
 *
 * @param value The raw value to embed.
 * @returns The value with every single quote doubled.
 */
export function escapeODataLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * Escape an OData string literal, then percent-encode it for use in a URL so
 * the value cannot terminate the literal or rewrite the query string.
 *
 * @param value The raw value to embed.
 * @returns The OData-escaped, percent-encoded URL literal.
 */
export function odataUrlLiteral(value: string): string {
  return encodeURIComponent(escapeODataLiteral(value));
}

/**
 * 產生一次公車查詢要依序嘗試的候選 scope（市區 / 公路 × 路線名變體）。
 *
 * TDX 的 City / InterCity 歸屬無法從路線號碼推導 —— 兩邊都有 4 位數路線且互不
 * 重疊（0557 是新竹縣市區公車、0968 是公路客運），所以這裡刻意不猜號碼，只用
 * 呼叫方實際給的 city 決定嘗試順序，由呼叫端依序打到有資料為止。
 *
 * @param fullName 使用者給的路線名，例如 "1619B經中港路不經竹科"、"綠1"、"0557"
 * @param city 呼叫方指定的城市；未指定或為 "InterCity" 時只查公路客運
 * @returns 依嘗試順序排列、已去重的候選 scope
 */
export function busRouteQueryCandidates(
  fullName: string,
  city?: string | null,
): BusRouteQueryScope[] {
  const names = [
    ...new Set([formatRouteName(fullName), fullName.trim()].filter(Boolean)),
  ];
  const types: BusApiType[] =
    city && city !== "InterCity" ? ["City", "InterCity"] : ["InterCity"];

  return types.flatMap((type) => names.map((routeId) => ({ type, routeId })));
}

/**
 * Format a maneuver's post-action distance for direct speech output.
 * @param distanceM Distance travelled after completing the maneuver.
 * @returns A short Traditional-Chinese distance phrase.
 */
export function formatFriendlyDistance(distanceM?: number | null): string {
  if (
    distanceM === null ||
    distanceM === undefined ||
    !Number.isFinite(distanceM)
  ) {
    return "";
  }
  if (distanceM < 20) return "馬上";
  if (distanceM < 1000) return `約 ${Math.round(distanceM / 10) * 10} 公尺`;
  return `約 ${(distanceM / 1000).toFixed(1)} 公里`;
}

/**
 * 將 WalkStep 的方向、路名與動作後距離轉為中文導航指引文字。
 * @param step 正規化步行 maneuver。
 * @returns 可直接交給 TTS 的單句指引。
 */
export function formatWalkStepInstruction(step: {
  relativeDirection?: string | null;
  streetName?: string | null;
  bogusName?: boolean | null;
  distanceM?: number | null;
  targetStreetName?: string | null;
}): string {
  const street = step.streetName?.trim() ?? "";
  const named = !step.bogusName && street !== "";
  const target = step.targetStreetName?.trim() ?? "";
  const dir = (step.relativeDirection ?? "CONTINUE").toUpperCase();
  const friendlyDistance = formatFriendlyDistance(step.distanceM);
  const suffix = !friendlyDistance
    ? ""
    : friendlyDistance === "馬上"
      ? "，馬上接續下一步"
      : `，續行${friendlyDistance}`;
  const unnamedContinue =
    target && friendlyDistance
      ? friendlyDistance === "馬上"
        ? `直行後馬上抵達「${target}」`
        : `直行${friendlyDistance}至「${target}」`
      : `請繼續直行${suffix}`;
  switch (dir) {
    case "DEPART":
      return named ? `沿「${street}」出發${suffix}` : `請出發${suffix}`;
    case "CONTINUE":
    case "STRAIGHT":
      return named ? `沿「${street}」繼續直行${suffix}` : unnamedContinue;
    case "LEFT":
      return named ? `向左轉進入「${street}」${suffix}` : `向左轉${suffix}`;
    case "RIGHT":
      return named ? `向右轉進入「${street}」${suffix}` : `向右轉${suffix}`;
    case "SLIGHTLY_LEFT":
      return named
        ? `稍向左轉進入「${street}」${suffix}`
        : `請稍向左轉${suffix}`;
    case "SLIGHTLY_RIGHT":
      return named
        ? `稍向右轉進入「${street}」${suffix}`
        : `請稍向右轉${suffix}`;
    case "HARD_LEFT":
      return named
        ? `大幅向左轉進入「${street}」${suffix}`
        : `請大幅向左轉${suffix}`;
    case "HARD_RIGHT":
      return named
        ? `大幅向右轉進入「${street}」${suffix}`
        : `請大幅向右轉${suffix}`;
    case "UTURN_LEFT":
    case "UTURN_RIGHT":
      return `請迴轉${suffix}`;
    case "CIRCLE_CLOCKWISE":
    case "CIRCLE_COUNTERCLOCKWISE":
      return `請進入圓環，依指示繞行${suffix}`;
    case "ELEVATOR":
      return "請進入電梯";
    case "ENTER_STATION":
      return "請進入車站";
    case "EXIT_STATION":
      return "請離開車站";
    default:
      return named ? `請沿「${street}」前進${suffix}` : `請繼續前行${suffix}`;
  }
}

/**
 * Escapes regex special characters and expands 台/臺 to [台臺] character class
 * so search terms match both variants in MongoDB regex queries.
 */
export function buildFuzzyKeywordRegex(keyword: string): string {
  const normalized = keyword.normalize("NFKC").trim();
  const escaped = normalized.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
  return escaped.replace(/[台臺]/g, "[台臺]");
}
