import {
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
    .replace(/[\(（][^）\)]*[\)）]/g, "")
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

export function getRouteDirectionImproved(
  routeStopsByDirection: { [direction: number]: BusRoute["Stops"] },
  startStopName: string,
  endStopName: string,
  language: "Zh_tw" | "En"
): number {
  for (const dirStr in routeStopsByDirection) {
    const direction = parseInt(dirStr) as 0 | 1;
    const stops = routeStopsByDirection[direction];
    const normStart = normalizeStopName(startStopName);
    const normEnd = normalizeStopName(endStopName);

    const startIndex = stops.findIndex((s) =>
      equalStopName(s?.StopName?.[language], normStart)
    );
    const endIndex = stops.findIndex((s) =>
      equalStopName(s?.StopName?.[language], normEnd)
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
  bus: BusRealtimeNearbyStop[]
): BusRealtimeNearbyStop | null {
  const arrivalIndex = stops.findIndex(
    (s) => s.StopName.Zh_tw === arrivalStopName
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

  const withoutBrackets = routeName.replace(/[\(（][^）\)]*[\)）]/g, "");

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
  city?: string | null
): BusRouteQueryScope[] {
  const names = [
    ...new Set([formatRouteName(fullName), fullName.trim()].filter(Boolean)),
  ];
  const types: BusApiType[] =
    city && city !== "InterCity" ? ["City", "InterCity"] : ["InterCity"];

  return types.flatMap((type) => names.map((routeId) => ({ type, routeId })));
}

/**
 * 將 WalkStep 的方向與路名轉為中文導航指引文字
 */
export function formatWalkStepInstruction(step: {
  relativeDirection?: string | null;
  streetName?: string | null;
  bogusName?: boolean | null;
}): string {
  const street = step.streetName?.trim() ?? "";
  const named = !step.bogusName && street !== "";
  const dir = (step.relativeDirection ?? "CONTINUE").toUpperCase();
  switch (dir) {
    case "DEPART":
      return named ? `請沿「${street}」出發` : "請出發";
    case "CONTINUE":
    case "STRAIGHT":
      return named ? `請繼續直行，沿「${street}」前進` : "請繼續直行";
    case "LEFT":
      return named ? `在「${street}」，請向左轉` : "請向左轉";
    case "RIGHT":
      return named ? `在「${street}」，請向右轉` : "請向右轉";
    case "SLIGHTLY_LEFT":
      return "請稍向左偏";
    case "SLIGHTLY_RIGHT":
      return "請稍向右偏";
    case "HARD_LEFT":
      return "請大幅向左轉";
    case "HARD_RIGHT":
      return "請大幅向右轉";
    case "UTURN_LEFT":
    case "UTURN_RIGHT":
      return "請迴轉";
    case "CIRCLE_CLOCKWISE":
    case "CIRCLE_COUNTERCLOCKWISE":
      return "請進入圓環，依指示繞行";
    case "ELEVATOR":
      return "請進入電梯";
    case "ENTER_STATION":
      return "請進入車站";
    case "EXIT_STATION":
      return "請離開車站";
    default:
      return named ? `請沿「${street}」前進` : "請繼續前行";
  }
}

