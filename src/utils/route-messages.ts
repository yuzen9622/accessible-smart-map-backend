import type { SupportedLang } from "../types/lang";
import type {
  RouteMessageDescriptor,
  RouteMessageDetail,
} from "../types/route-message";

const CATALOG: Record<string, { "zh-TW": string; en: string }> = {
  OUT_OF_RANGE: {
    "zh-TW": "起點與終點距離過遠",
    en: "The route is beyond the supported distance.",
  },
  OUT_OF_COVERAGE: {
    "zh-TW": "本服務目前涵蓋台灣",
    en: "This service currently covers Taiwan.",
  },
  NO_ACCESSIBLE_ROUTE: {
    "zh-TW": "找不到符合無障礙需求的路線",
    en: "No route matching the accessibility requirements was found.",
  },
  NO_ROUTE: { "zh-TW": "找不到可行路線", en: "No viable route was found." },
  ENDPOINT_CONSTRAINT_BLOCKED: {
    "zh-TW": "目前圖資無法將指定位置連接到符合輪椅通行條件的路網，請調整位置",
    en: "The available map cannot connect the specified location to a route meeting wheelchair access limits. Please adjust the location.",
  },
  UPSTREAM_TIMEOUT: {
    "zh-TW": "路線規劃服務逾時，請稍後再試",
    en: "The route planning service timed out. Please try again later.",
  },
  ROUTE_PLANNING_FAILED: {
    "zh-TW": "路線規劃失敗，請稍後再試",
    en: "Unable to plan the route. Please try again later.",
  },
  INTENT_PARSE_FAILED: {
    "zh-TW":
      "無法解析您的查詢，請改用『從 A 到 B』的描述或直接提供 origin/destination",
    en: "Unable to parse the request. Describe a trip from A to B or provide origin and destination.",
  },
  CURRENT_LOCATION_REQUIRED: {
    "zh-TW": "查詢使用了『目前位置』，請一併提供 userLocation 座標",
    en: "The request uses the current location; please provide userLocation coordinates.",
  },
  ROUTE_PARAMETERS_REQUIRED: {
    "zh-TW": "缺少必要參數：origin, destination",
    en: "Required route parameters are missing: origin and destination.",
  },
  COORDINATE_LOOKUP_FAILED: {
    "zh-TW": "無法解析出發地或目的地座標",
    en: "Could not resolve the origin or destination coordinates.",
  },
  VENUE_PLACE_NOT_FOUND: {
    "zh-TW": "查無此場域或場域地點",
    en: "The venue or venue place does not exist.",
  },
  WAYPOINT_LOOKUP_FAILED: {
    "zh-TW": "無法解析中途點座標",
    en: "Could not resolve one or more waypoint coordinates.",
  },
  ROUTE_INTENT_UNAVAILABLE: {
    "zh-TW":
      "語意解析服務暫時無法使用，請稍後再試或直接提供 origin/destination",
    en: "The route intent service is temporarily unavailable. Try again later or provide origin and destination.",
  },
  ROUTE_REQUEST_FAILED: {
    "zh-TW": "路線請求無法處理",
    en: "The route request could not be processed.",
  },
  NAV_INSTRUCTIONS_FAILED: {
    "zh-TW": "無法產生導航指引，請稍後再試",
    en: "Unable to generate navigation instructions. Please try again later.",
  },
  REROUTE_FAILED: {
    "zh-TW": "重新規劃失敗，請稍後再試",
    en: "Unable to replan the route. Please try again later.",
  },
  ROUTE_DATA_SPARSE: {
    "zh-TW": "沿途無障礙資料不足，分數為保守估計",
    en: "Accessibility data along this route is limited; the score is conservative.",
  },
  ROUTE_LONG_WALK: {
    "zh-TW": "步行距離較長，行動不便者請留意",
    en: "This route involves a long walk; please consider your mobility needs.",
  },
  ROUTE_MANY_TRANSFERS: {
    "zh-TW": "轉乘次數較多，行動不便者請留意",
    en: "This route requires several transfers; please consider your mobility needs.",
  },
  ROUTE_ADVERSE_ENVIRONMENT: {
    "zh-TW": "天候或空氣品質不佳，通行較費力",
    en: "Weather or air quality may make travel more difficult.",
  },
  ROUTE_TOILET_AVAILABLE: {
    "zh-TW": "目的地附近有 {count} 處無障礙廁所",
    en: "{count} accessible toilet(s) are registered near the destination.",
  },
  ROUTE_NO_ACCESSIBLE_TOILET: {
    "zh-TW":
      "目的地附近查無登記的無障礙廁所資料，不代表確定沒有，建議到場前先自行確認",
    en: "No accessible toilets are registered near the destination. This does not confirm none exist; please check before arrival.",
  },
  ROUTE_STAIRS_HANDRAIL_UNKNOWN: {
    "zh-TW": "路線包含樓梯段落，OSM 資料未確認此處是否有扶手，請自行確認",
    en: "This route includes stairs, and OSM data does not confirm whether handrails are present. Please check on site.",
  },
  ROUTE_SLOPE_NORMAL_WALK: {
    "zh-TW": "一般步行未套用坡度上限；避免樓梯偏好不代表已啟用輪椅通行限制",
    en: "Normal walking applies no slope limit; preferring to avoid stairs does not enable wheelchair restrictions.",
  },
  ROUTE_SLOPE_OTP_WHEELCHAIR: {
    "zh-TW":
      "輪椅步行會排除已知坡度超過 12% 的非階梯路段；未知坡度仍可能存在，階梯協助段另行標示。您的自訂坡度上限未單獨套用",
    en: "Wheelchair walking excludes non-stair segments with a known slope above 12%. Unknown slopes may remain, and stairs requiring assistance are marked separately. Your custom slope limit is not applied independently.",
  },
  ROUTE_SLOPE_CSR: {
    "zh-TW":
      "CSR 無障礙行人圖目前不會依您設定的任意坡度上限篩選路徑；回傳的坡度僅為已選路段的觀測值，您的坡度上限未被實際執行",
    en: "The CSR pedestrian network does not filter routes by a custom slope limit; reported slopes are observations for the selected segments only.",
  },
  ROUTE_SLOPE_NO_ELEVATION: {
    "zh-TW":
      "開車/機車路線引擎目前無地形高程資料，無法依坡度篩選路徑，您設定的坡度上限未被實際執行",
    en: "The driving route engine has no elevation data and cannot enforce your requested slope limit.",
  },
  ROUTE_SLOPE_SERVER_DEFAULT: {
    "zh-TW":
      "大眾運輸/步行路線引擎目前固定以 8.3% 作為輪椅模式上限，無法套用您要求的更嚴格數值；且受限於 OSM 坡度標記稀疏，實際執行範圍有限",
    en: "The transit/walking engine uses a fixed 8.3% wheelchair slope limit, so it cannot apply a stricter requested value; sparse OSM slope data also limits enforcement.",
  },
  ROUTE_SLOPE_WHEELCHAIR_DISABLED: {
    "zh-TW":
      "此路線未啟用輪椅模式（avoidStairs 為 false），伺服器未套用任何坡度限制",
    en: "Wheelchair mode is not enabled for this route (avoidStairs is false), so the server applied no slope limit.",
  },
  ROUTE_SLOPE_SERVER_LIMIT: {
    "zh-TW": "伺服器已套用 {serverMaxPercent}% 上限（等於或寬於您的設定）",
    en: "The server applied a {serverMaxPercent}% limit (equal to or less restrictive than your setting).",
  },
  ROUTE_WHEELCHAIR_STAIRS_FALLBACK_SUMMARY: {
    "zh-TW": "此路線含樓梯，輪椅無法自行通過，請安排協助並確認現場狀況。",
    en: "This route includes stairs and cannot be used independently in a wheelchair. Arrange assistance and check conditions on site.",
  },
  ROUTE_WHEELCHAIR_STAIRS_FALLBACK: {
    "zh-TW":
      "找不到可達的無階梯路線，此備援路線包含樓梯，輪椅無法自行通過，請安排協助並確認現場狀況。",
    en: "No reachable step-free route was found. This fallback includes stairs and cannot be used independently in a wheelchair. Arrange assistance and check conditions on site.",
  },
  ROUTE_STAIRS_CONSTRAINT_UNSATISFIED: {
    "zh-TW": "目前候選路線仍包含無坡道樓梯，無法完全滿足避開樓梯條件",
    en: "The current candidate route still includes stairs without a ramp, so the avoid-stairs constraint is not fully met.",
  },
  ROUTE_HAZARD_DATA_UNAVAILABLE: {
    "zh-TW": "部分路段的障礙資料暫時無法更新，請留意現場狀況。",
    en: "Hazard data for some segments is temporarily unavailable. Please watch for conditions on site.",
  },
  ROUTE_HAZARD_ON_ROUTE: {
    "zh-TW":
      "此路線經過已確認的路況障礙或道路施工封閉（hazardAdvisory.onRoute），請留意或改採其他候選路線",
    en: "This route passes a confirmed hazard or road closure. Please take care or choose another route.",
  },
  ROUTE_CLOSURE_BYPASS_FAILED: {
    "zh-TW": "無法繞開封閉路段，路線仍會經過該處，請留意現場管制",
    en: "The closed road could not be bypassed; the route still passes through it. Follow on-site traffic controls.",
  },
  ROUTE_HAZARD_ALL_ROUTES_BLOCKED: {
    "zh-TW":
      "所有候選路線都經過已確認的路況障礙或道路施工封閉，已為您保留受影響最小的路線，出發前請務必確認現場狀況",
    en: "All candidate routes pass a confirmed hazard or road closure. The least affected route was retained; check conditions before departure.",
  },
  ROUTE_CSR_APPROXIMATE_INDOOR: {
    "zh-TW":
      "路線包含車站室內段落，該段僅有出入口代理座標、無實測室內線形，地圖上以直線近似呈現，實際步行路徑會不同",
    en: "This route includes an indoor station segment represented by a straight line between entrance proxy points; the actual walking path may differ.",
  },
  ROUTE_PARK_ENTRANCE_SELECTED: {
    "zh-TW":
      "已為您導引至「{parkName}」{entranceName}（無障礙出入口{widthText}{slopeText}）",
    en: "Guidance ends at {parkName}, {entranceName} (accessible entrance{widthText}{slopeText}).",
  },
  ROUTE_PARK_NO_QUALIFYING_ENTRANCE: {
    "zh-TW":
      "目的地公園的登記無障礙出入口都不符合您的淨寬或坡度條件，終點維持您指定的位置，請到場前自行確認可進入的出入口",
    en: "No registered accessible entrance at the destination park meets your width or slope requirements. The route ends at your requested location; please check an entrance before arrival.",
  },
  ROUTE_PARKING_ARRIVAL: {
    "zh-TW":
      "已為您導引至最近身障停車格「{name}」（距目的地約 {distanceM} 公尺）",
    en: "Guidance ends at the nearest accessible parking space, {name} (about {distanceM} m from the destination).",
  },
  ROUTE_NEARBY_PARKING: {
    "zh-TW": "目的地 300m 內有 {count} 處身障停車格",
    en: "{count} accessible parking space(s) are within 300 m of the destination.",
  },
  ROUTE_NEARBY_ACCESS_FEATURES: {
    "zh-TW": "目的地附近有 {count} 處電梯／坡道",
    en: "{count} elevator(s) or ramp(s) are near the destination.",
  },
  ROUTE_BOARD_ELEVATOR_NEARBY: {
    "zh-TW": "乘車站附近有電梯",
    en: "An elevator is near the boarding station.",
  },
  ROUTE_ALIGHT_ELEVATOR_NEARBY: {
    "zh-TW": "下車站附近有電梯",
    en: "An elevator is near the alighting station.",
  },
  ROUTE_BOARD_RAMP_NEARBY: {
    "zh-TW": "乘車站附近有無障礙坡道",
    en: "An accessible ramp is near the boarding station.",
  },
  ROUTE_ALIGHT_RAMP_NEARBY: {
    "zh-TW": "下車站附近有無障礙坡道",
    en: "An accessible ramp is near the alighting station.",
  },
  ROUTE_ACCESSIBLE_TOILET_NEARBY: {
    "zh-TW": "站點附近有無障礙廁所",
    en: "An accessible toilet is near a station on this route.",
  },
  ROUTE_TACTILE_PAVING_NEARBY: {
    "zh-TW": "附近有導盲磚",
    en: "Tactile paving is nearby.",
  },
  ROUTE_AUDIO_SIGNAL_NEARBY: {
    "zh-TW": "附近有音響號誌",
    en: "An audible traffic signal is nearby.",
  },
  ROUTE_BOARD_FACILITIES: {
    "zh-TW": "乘車站設施完善",
    en: "Accessibility facilities are available at the boarding station.",
  },
  ROUTE_ALIGHT_FACILITIES: {
    "zh-TW": "下車站設施完善",
    en: "Accessibility facilities are available at the alighting station.",
  },
  ROUTE_LOW_FLOOR_DIRECT: {
    "zh-TW": "低底盤公車直達",
    en: "Direct service by a low-floor bus.",
  },
  ROUTE_LOW_FLOOR_ALL: {
    "zh-TW": "全線低底盤公車",
    en: "All buses on this route are low-floor.",
  },
  ROUTE_LOW_FLOOR_EVIDENCE: {
    "zh-TW": "有低底盤公車紀錄",
    en: "Low-floor buses have been recorded on this route.",
  },
  ROUTE_HIGH_FLOOR_ALTERNATIVE: {
    "zh-TW":
      "⚠️ 首班公車「{routeName}」為高底盤車；後續 {plateNumb} 為低地板車{etaText}",
    en: "The first bus on {routeName} is high-floor; a low-floor bus ({plateNumb}) follows{etaText}.",
  },
  ROUTE_HIGH_FLOOR_NO_ALTERNATIVE: {
    "zh-TW": "⚠️ 首班公車「{routeName}」為高底盤車，未查到後續低地板班次",
    en: "The first bus on {routeName} is high-floor; no later low-floor bus was found.",
  },
  ROUTE_LOW_FLOOR_ETA: {
    "zh-TW": "（約 {etaMinutes} 分後到站）",
    en: " (about {etaMinutes} min)",
  },
  ROUTE_LOW_FLOOR_STOPS: {
    "zh-TW": "（尚差 {stopsAway} 站）",
    en: " ({stopsAway} stops away)",
  },
  ROUTE_WALK_FROM_ORIGIN: {
    "zh-TW": "起點需步行約 {distanceM} 公尺至可上車路段",
    en: "Walk about {distanceM} m from the origin to a drivable road.",
  },
  ROUTE_WALK_CONNECTOR_UNAVAILABLE: {
    "zh-TW":
      "{placeLabel} 距可行車路段約 {gapM} 公尺，但無法建立可信步行路徑，請留意",
    en: "{placeLabel} is about {gapM} m from a drivable road, but no reliable walking connection could be built. Check on site.",
  },
  ROUTE_WALK_WAYPOINT_PARKING: {
    "zh-TW": "{placeLabel} 需步行約 {distanceM} 公尺往返停車處",
    en: "Walk about {distanceM} m round trip to parking at {placeLabel}.",
  },
  ROUTE_WALK_TO_DESTINATION: {
    "zh-TW": "於終點前約 {distanceM} 公尺處停車，需步行至目的地",
    en: "Parking is about {distanceM} m before the destination; walk the remaining distance.",
  },
  ROUTE_WALK_NEARBY_FEATURES: {
    "zh-TW": "目的地附近有 {count} 處電梯／坡道",
    en: "{count} elevators or ramps are near the destination.",
  },
};

function catalogEntry(code: string) {
  return Object.prototype.hasOwnProperty.call(CATALOG, code)
    ? CATALOG[code]
    : undefined;
}

function interpolate(
  template: string,
  params: RouteMessageDescriptor["params"] | undefined,
  language: SupportedLang,
): string {
  return template.replace(
    /\{([A-Za-z][A-Za-z0-9]*)\}/g,
    (placeholder, key: string) => {
      const value = params?.[key];
      if (key === "widthText") {
        return typeof params?.widthM === "number"
          ? language === "en"
            ? `, ${params.widthM} m clear width`
            : `，淨寬 ${params.widthM} 公尺`
          : "";
      }
      if (key === "etaText") {
        if (typeof params?.etaMinutes === "number")
          return language === "en"
            ? ` (about ${params.etaMinutes} min)`
            : `（約 ${params.etaMinutes} 分後到站）`;
        if (typeof params?.stopsAway === "number")
          return language === "en"
            ? ` (${params.stopsAway} stops away)`
            : `（尚差 ${params.stopsAway} 站）`;
        return "";
      }
      if (key === "slopeText") {
        return typeof params?.slopePercent === "number"
          ? language === "en"
            ? `, ${params.slopePercent}% slope`
            : `、坡度 ${params.slopePercent}%`
          : "";
      }
      return value === undefined ? placeholder : String(value);
    },
  );
}

export function localizeRouteReason(
  reason: string,
  language?: SupportedLang,
): string | undefined {
  const entry = catalogEntry(reason);
  return language && entry ? entry[language] : undefined;
}

export function routeMessage(
  code: string,
  legacyMessage: string,
  params?: RouteMessageDescriptor["params"],
): RouteMessageDescriptor {
  return { code, legacyMessage, ...(params ? { params } : {}) };
}

/** Only machine-tagged system labels are translated; untagged source names stay verbatim. */
function localizeMessageParams(
  params: RouteMessageDescriptor["params"],
  language: SupportedLang | undefined,
): RouteMessageDescriptor["params"] {
  if (!params || !language) return params;
  let placeLabel: string | undefined;
  if (params.placeRole === "origin") {
    placeLabel = language === "en" ? "Origin" : "起點";
  } else if (params.placeRole === "destination") {
    placeLabel = language === "en" ? "Destination" : "目的地";
  } else if (
    params.placeRole === "waypoint" &&
    typeof params.waypointIndex === "number" &&
    Number.isInteger(params.waypointIndex) &&
    params.waypointIndex > 0
  ) {
    placeLabel =
      language === "en"
        ? `Waypoint ${params.waypointIndex}`
        : `中途點 ${params.waypointIndex}`;
  }
  return placeLabel === undefined ? params : { ...params, placeLabel };
}

/** Localizes only details whose index and message still correspond to the raw array. */
export function localizeRouteDetails(
  messages: readonly string[] | undefined,
  details: readonly RouteMessageDetail[] | undefined,
  language: SupportedLang | undefined,
): { messages: string[]; details?: RouteMessageDetail[] } {
  const valid = new Map<number, RouteMessageDetail>();
  const seen = new Set<number>();
  for (const detail of details ?? []) {
    if (
      !Number.isInteger(detail.index) ||
      detail.index < 0 ||
      detail.index >= (messages?.length ?? 0)
    )
      continue;
    if (messages?.[detail.index] !== detail.message || seen.has(detail.index))
      continue;
    seen.add(detail.index);
    valid.set(detail.index, detail);
  }
  const output: string[] = [];
  const nextDetails: RouteMessageDetail[] = [];
  (messages ?? []).forEach((raw, oldIndex) => {
    const detail = valid.get(oldIndex);
    const entry = detail ? catalogEntry(detail.code) : undefined;
    const params = entry
      ? localizeMessageParams(detail?.params, language)
      : detail?.params;
    const message =
      detail && entry && language
        ? interpolate(entry[language], params, language)
        : raw;
    if (output.includes(message)) return;
    const index = output.length;
    output.push(message);
    if (detail)
      nextDetails.push({
        ...detail,
        ...(params ? { params } : {}),
        index,
        message,
      });
  });
  return {
    messages: output,
    ...(nextDetails.length ? { details: nextDetails } : {}),
  };
}

/** Builds final strings and details together so indexes reflect the localized, deduplicated array. */
export function presentRouteMessages(
  rawMessages: readonly string[] | undefined,
  descriptors: readonly RouteMessageDescriptor[] | undefined,
  language: SupportedLang | undefined,
): { messages: string[]; details?: RouteMessageDetail[] } {
  const output: string[] = [];
  const details: RouteMessageDetail[] = [];
  for (const raw of rawMessages ?? []) {
    const descriptor = (descriptors ?? []).find(
      (item) => item.legacyMessage === raw,
    );
    const entry = descriptor ? catalogEntry(descriptor.code) : undefined;
    const params = entry
      ? localizeMessageParams(descriptor?.params, language)
      : descriptor?.params;
    const message =
      descriptor && entry && language
        ? interpolate(entry[language], params, language)
        : raw;
    if (output.includes(message)) continue;
    const index = output.length;
    output.push(message);
    if (descriptor) {
      details.push({
        index,
        code: descriptor.code,
        ...(params ? { params } : {}),
        message,
      });
    }
  }
  return { messages: output, ...(details.length ? { details } : {}) };
}
