/**
 * Metro / light-rail line labels. `lineKey` is the stable label clients
 * translate with i18n (`metroLines.<lineKey>`); `zh` is the canonical
 * `lineName`, `en` only feeds text the backend itself writes (English nav
 * instructions, AI display names). Clients must not render these strings.
 *
 * Keys are matched first as the route id without its `_0/_1` direction suffix
 * (branches such as `TRTC_R_R-3`), then as `${railSystem}_${lineId}`.
 */
export const METRO_LINES: ReadonlyMap<string, { zh: string; en: string }> =
  new Map([
    ["TRTC_BL", { zh: "板南線", en: "Bannan Line" }],
    ["TRTC_R", { zh: "淡水信義線", en: "Tamsui-Xinyi Line" }],
    ["TRTC_G", { zh: "松山新店線", en: "Songshan-Xindian Line" }],
    ["TRTC_O", { zh: "中和新蘆線", en: "Zhonghe-Xinlu Line" }],
    ["TRTC_BR", { zh: "文湖線", en: "Wenhu Line" }],
    ["TRTC_R_R-3", { zh: "新北投支線", en: "Xinbeitou Branch Line" }],
    ["TRTC_G_G-3", { zh: "小碧潭支線", en: "Xiaobitan Branch Line" }],
    ["TRTCMG_MK", { zh: "貓空纜車", en: "Maokong Gondola" }],
    ["NTMC_Y", { zh: "環狀線", en: "Circular Line" }],
    ["NTMC_LB", { zh: "三鶯線", en: "Sanying Line" }],
    ["TYMC_A", { zh: "桃園機場捷運", en: "Taoyuan Airport MRT" }],
    ["NTDLRT_V", { zh: "淡海輕軌", en: "Danhai LRT" }],
    [
      "NTDLRT_V_V-1",
      { zh: "淡海輕軌綠山線", en: "Danhai LRT Green Mountain Line" },
    ],
    [
      "NTDLRT_V_V-2",
      { zh: "淡海輕軌藍海線", en: "Danhai LRT Blue Coast Line" },
    ],
    ["NTALRT_K", { zh: "安坑輕軌", en: "Ankeng LRT" }],
    ["KRTC_O", { zh: "橘線", en: "Orange Line" }],
    ["KRTC_R", { zh: "紅線", en: "Red Line" }],
    ["TMRT_G", { zh: "烏日文心北屯線", en: "Green Line" }],
    ["KLRT_C", { zh: "高雄環狀輕軌", en: "Circular Light Rail" }],
  ]);

/** The matched line label for an OTP/GTFS route id, or undefined for unknown lines. */
export function metroLineKey(
  routeId: string,
  railSystem: string,
  lineId: string,
): string | undefined {
  return [routeId.replace(/_[01]$/, ""), `${railSystem}_${lineId}`].find(
    (key) => METRO_LINES.has(key),
  );
}
