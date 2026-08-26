/**
 * Bus reference data shared by the import scripts and the bus query service:
 * the default import scope (六都), Chinese→English city aliases, and
 * code→label maps for the TDX V3 Vehicle / A1 / N1 enum fields.
 * Pure data + pure helpers only — no I/O (city resolution that falls back to
 * reverse geocoding lives in bus.service.ts).
 */

import { TaiwanCityEn } from "../types/transit";

/** Default static-import scope agreed with the user (六都). */
export const SIX_CITIES: TaiwanCityEn[] = [
  TaiwanCityEn.Taipei,
  TaiwanCityEn.NewTaipei,
  TaiwanCityEn.Taoyuan,
  TaiwanCityEn.Taichung,
  TaiwanCityEn.Tainan,
  TaiwanCityEn.Kaohsiung,
];

/**
 * Chinese (and loose) names → TDX city code. Keys are normalized by
 * {@link normalizeCityKey} before lookup, so "台北市"/"臺北"/"Taipei" all hit.
 */
export const CITY_ALIAS: Record<string, TaiwanCityEn> = {
  台北: TaiwanCityEn.Taipei,
  臺北: TaiwanCityEn.Taipei,
  新北: TaiwanCityEn.NewTaipei,
  桃園: TaiwanCityEn.Taoyuan,
  台中: TaiwanCityEn.Taichung,
  臺中: TaiwanCityEn.Taichung,
  台南: TaiwanCityEn.Tainan,
  臺南: TaiwanCityEn.Tainan,
  高雄: TaiwanCityEn.Kaohsiung,
  基隆: TaiwanCityEn.Keelung,
  新竹: TaiwanCityEn.Hsinchu,
  新竹縣: TaiwanCityEn.HsinchuCounty,
  苗栗: TaiwanCityEn.MiaoliCounty,
  彰化: TaiwanCityEn.ChanghuaCounty,
  南投: TaiwanCityEn.NantouCounty,
  雲林: TaiwanCityEn.YunlinCounty,
  嘉義: TaiwanCityEn.Chiayi,
  嘉義縣: TaiwanCityEn.ChiayiCounty,
  屏東: TaiwanCityEn.PingtungCounty,
  宜蘭: TaiwanCityEn.YilanCounty,
  花蓮: TaiwanCityEn.HualienCounty,
  台東: TaiwanCityEn.TaitungCounty,
  臺東: TaiwanCityEn.TaitungCounty,
  金門: TaiwanCityEn.KinmenCounty,
  澎湖: TaiwanCityEn.PenghuCounty,
  連江: TaiwanCityEn.LienchiangCounty,
  馬祖: TaiwanCityEn.LienchiangCounty,
};

/**
 * Approximate center coordinates [lat, lng] for each city/county in Taiwan,
 * used as distance calculation fallback when route stops lack GPS coordinates.
 */
export const CITY_COORDINATES: Record<
  TaiwanCityEn,
  { lat: number; lng: number }
> = {
  [TaiwanCityEn.Taipei]: { lat: 25.0375, lng: 121.5637 },
  [TaiwanCityEn.NewTaipei]: { lat: 25.0117, lng: 121.4658 },
  [TaiwanCityEn.Taoyuan]: { lat: 24.9936, lng: 121.301 },
  [TaiwanCityEn.Taichung]: { lat: 24.1625, lng: 120.647 },
  [TaiwanCityEn.Tainan]: { lat: 22.9997, lng: 120.227 },
  [TaiwanCityEn.Kaohsiung]: { lat: 22.6273, lng: 120.3014 },
  [TaiwanCityEn.Keelung]: { lat: 25.1276, lng: 121.7392 },
  [TaiwanCityEn.Hsinchu]: { lat: 24.8138, lng: 120.9675 },
  [TaiwanCityEn.HsinchuCounty]: { lat: 24.8387, lng: 121.0177 },
  [TaiwanCityEn.MiaoliCounty]: { lat: 24.5602, lng: 120.8214 },
  [TaiwanCityEn.ChanghuaCounty]: { lat: 24.0816, lng: 120.5385 },
  [TaiwanCityEn.NantouCounty]: { lat: 23.9609, lng: 120.9719 },
  [TaiwanCityEn.YunlinCounty]: { lat: 23.7092, lng: 120.4313 },
  [TaiwanCityEn.Chiayi]: { lat: 23.4801, lng: 120.4491 },
  [TaiwanCityEn.ChiayiCounty]: { lat: 23.4518, lng: 120.2555 },
  [TaiwanCityEn.PingtungCounty]: { lat: 22.6762, lng: 120.4941 },
  [TaiwanCityEn.YilanCounty]: { lat: 24.7021, lng: 121.7377 },
  [TaiwanCityEn.HualienCounty]: { lat: 23.9872, lng: 121.6016 },
  [TaiwanCityEn.TaitungCounty]: { lat: 22.7583, lng: 121.1444 },
  [TaiwanCityEn.KinmenCounty]: { lat: 24.4493, lng: 118.3766 },
  [TaiwanCityEn.PenghuCounty]: { lat: 23.5711, lng: 119.5793 },
  [TaiwanCityEn.LienchiangCounty]: { lat: 26.1505, lng: 119.9499 },
};

const EN_CITIES = new Set<string>(Object.values(TaiwanCityEn));

/**
 * Resolve a user-supplied city string to a {@link TaiwanCityEn}, or null.
 * Accepts the English enum value directly, Chinese names, and loose variants
 * ("台北市", "臺北", "新北市", "Taipei", "NewTaipei City"…).
 *
 * The 縣 suffix is significant — it distinguishes 新竹縣/嘉義縣 from the 市
 * of the same name — so lookup keeps 縣 first, then strips 市, then 縣, so
 * "新竹縣"→HsinchuCounty but "新竹市"→Hsinchu and "苗栗縣"→MiaoliCounty.
 *
 * @param input Raw city string (may be undefined).
 * @returns The matching TaiwanCityEn, or null when unrecognized.
 */
export function cityFromAlias(input?: string | null): TaiwanCityEn | null {
  if (!input) return null;
  const raw = input.trim();
  if (EN_CITIES.has(raw)) return raw as TaiwanCityEn;

  const compact = raw.replace(/\s+/g, "");
  if (EN_CITIES.has(compact)) return compact as TaiwanCityEn;

  const n = compact.replace(/臺/g, "台").replace(/City/gi, "");
  for (const key of [n, n.replace(/市$/, ""), n.replace(/[縣市]$/, "")]) {
    if (CITY_ALIAS[key]) return CITY_ALIAS[key];
  }

  const enMatch = Object.values(TaiwanCityEn).find(
    (c) => c.toLowerCase() === n.toLowerCase(),
  );
  return enMatch ?? null;
}

/** TDX 是否為低地板 (IsLowFloor) / 是否有升降斜坡 (HasLiftOrRamp): [0:否, 1:是]. */
export function yesNoLabel(code?: number): "是" | "否" | "未知" {
  if (code === 1) return "是";
  if (code === 0) return "否";
  return "未知";
}

/** TDX VehicleClass：[1:大型,2:中型,3:小型,4:雙層,5:雙節,6:小客車,99:其他]. */
export const VEHICLE_CLASS_LABEL: Record<number, string> = {
  1: "大型巴士",
  2: "中型巴士",
  3: "小型巴士",
  4: "雙層巴士",
  5: "雙節巴士",
  6: "營業用小客車",
  99: "其他",
};

/** TDX A1/N1 Direction：[0:去程,1:返程,2:迴圈,255:未知]. */
export const DIRECTION_LABEL: Record<number, string> = {
  0: "去程",
  1: "返程",
  2: "迴圈",
  255: "未知",
};

/** TDX A1 BusStatus 行車狀況. */
export const BUS_STATUS_LABEL: Record<number, string> = {
  0: "正常",
  1: "車禍",
  2: "故障",
  3: "塞車",
  4: "緊急求援",
  5: "加油",
  90: "不明",
  91: "去回不明",
  98: "偏移路線",
  99: "非營運狀態",
};

/** TDX N1 StopStatus 車輛狀態備註. */
export const STOP_STATUS_LABEL: Record<number, string> = {
  0: "正常",
  1: "尚未發車",
  2: "交管不停靠",
  3: "末班車已過",
  4: "今日未營運",
};
