/**
 * Labeled cases for the offline tool-routing eval (`eval-tool-routing.ts`).
 * `expectTool` strings MUST match the `openAiChatTools` names in
 * `src/config/ai/tool.ts` (e.g. `planAccessibleRoute`, not the legacy
 * `planRoute`). Cases deliberately stress the known-confusable boundaries.
 */
export interface AgentCase {
  id: string;
  query: string;
  userLocation?: { latitude: number; longitude: number };
  /** Expected tool, or "__none__" to assert NO tool fires (chitchat). */
  expectTool: string;
  mustNotCall?: string[];
  /** Acceptable alternatives for genuinely-ambiguous queries. */
  acceptAlso?: string[];
  /** When true, the memory tools are in the catalogue (logged-in user). */
  loggedIn?: boolean;
  /**
   * Optional argument assertion for the expected tool's first call. Returns
   * null to pass, or a failure reason string. `ctx.today` is today's Taipei
   * date (YYYY-MM-DD) for relative-date checks.
   */
  expectArgs?: (args: any, ctx: { today: string }) => string | null;
  notes?: string;
}

function ymdPlusDays(today: string, n: number): string {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

const TAIPEI_STATION = { latitude: 25.0478, longitude: 121.517 };

export const agentCases: AgentCase[] = [
  // A. parking vs findA11yPlaces (the 停車 trap)
  {
    id: "park-1",
    query: "台北101附近有沒有身障停車位",
    expectTool: "findNearbyParking",
    mustNotCall: ["findA11yPlaces"],
  },
  {
    id: "park-2",
    query: "板橋車站有無障礙廁所嗎",
    expectTool: "findA11yPlaces",
    mustNotCall: ["findNearbyParking"],
  },
  {
    id: "park-3",
    query: "我開車去台中歌劇院，哪裡可以停輪椅族的車",
    expectTool: "findNearbyParking",
    mustNotCall: ["findA11yPlaces", "findGooglePlaces"],
  },
  {
    id: "park-4",
    query: "附近哪裡有無障礙電梯",
    userLocation: TAIPEI_STATION,
    expectTool: "findA11yPlaces",
    mustNotCall: ["findNearbyParking"],
  },

  // B. getEnvironmentInfo vs getAirQuality
  {
    id: "env-1",
    query: "現在 PM2.5 多少",
    userLocation: TAIPEI_STATION,
    expectTool: "getAirQuality",
    mustNotCall: ["getEnvironmentInfo"],
  },
  {
    id: "env-2",
    query: "等等出門天氣如何",
    userLocation: TAIPEI_STATION,
    expectTool: "getEnvironmentInfo",
    mustNotCall: ["getAirQuality"],
  },
  {
    id: "env-3",
    query: "現在適合出門嗎",
    userLocation: TAIPEI_STATION,
    expectTool: "getEnvironmentInfo",
  },
  {
    id: "env-4",
    query: "台北車站附近有監視器可以看路況嗎",
    expectTool: "getEnvironmentInfo",
    mustNotCall: ["getNearbyHazards"],
  },
  {
    id: "env-5",
    query: "空氣品質好嗎，我想散步",
    userLocation: TAIPEI_STATION,
    expectTool: "getEnvironmentInfo",
    acceptAlso: ["getAirQuality"],
    notes: "soft: mentions air but asks about going out",
  },

  // C. planAccessibleRoute vs getNavInstructions
  {
    id: "route-1",
    query: "台中車站到高鐵台中站怎麼走",
    expectTool: "planAccessibleRoute",
    mustNotCall: ["getNavInstructions"],
  },
  {
    id: "route-2",
    query: "從台北車站帶我走到台北101，每一步怎麼走",
    expectTool: "getNavInstructions",
    mustNotCall: ["planAccessibleRoute"],
  },
  {
    id: "route-3",
    query: "我要從這裡去信義威秀的詳細步驟",
    userLocation: TAIPEI_STATION,
    expectTool: "getNavInstructions",
  },
  {
    id: "route-4",
    query: "規劃一條從淡水到北投的無障礙路線",
    expectTool: "planAccessibleRoute",
    mustNotCall: ["getNavInstructions", "findGooglePlaces"],
  },
  {
    id: "route-5",
    query: "step by step from Taipei Main Station to Ximen",
    expectTool: "getNavInstructions",
  },

  // D. the 5 bus tools
  {
    id: "bus-route",
    query: "307 經過哪些站",
    expectTool: "getBusRoute",
    mustNotCall: ["getBusRouteDetail", "getBusArrival"],
  },
  {
    id: "bus-detail",
    query: "紅2 的所有站點、到站時間和時刻表都給我",
    expectTool: "getBusRouteDetail",
  },
  {
    id: "bus-arrival",
    query: "307 在台北車站還有幾分鐘到",
    expectTool: "getBusArrival",
    mustNotCall: ["trackBuses", "getBusRoute"],
  },
  {
    id: "bus-timetable",
    query: "672 首末班車幾點",
    expectTool: "getBusTimetable",
    mustNotCall: ["getBusRouteDetail"],
  },
  {
    id: "bus-track",
    query: "307 來的這班是低底盤嗎",
    expectTool: "trackBuses",
    mustNotCall: ["getBusArrival"],
  },
  {
    id: "bus-track-2",
    query: "下一班紅2是無障礙公車嗎，不要跟我要車牌",
    expectTool: "trackBuses",
  },
  {
    id: "bus-track-3",
    query: "307 現在在哪",
    expectTool: "trackBuses",
    mustNotCall: ["getBusArrival"],
  },
  {
    id: "bus-nearby-1",
    query: "離我最近的公車啥時候來",
    userLocation: { latitude: 24.130608, longitude: 120.637112 },
    expectTool: "findNearbyBusStops",
    mustNotCall: ["findGooglePlaces", "findA11yPlaces"],
    notes: "real failure: model was hallucinating route numbers (290/75)",
  },
  {
    id: "bus-nearby-2",
    query: "附近有哪些公車站",
    userLocation: { latitude: 25.0478, longitude: 121.517 },
    expectTool: "findNearbyBusStops",
  },
  {
    id: "bus-composite",
    query: "從中科大要去火車站可以搭哪些公車、哪班最快來",
    expectTool: "planAccessibleRoute",
    acceptAlso: ["findNearbyBusStops", "getBusRouteDetail"],
    mustNotCall: ["getNavInstructions"],
    notes:
      "composite bus intent; single-round only asserts the first step (candidate-route discovery). Full chain (must reach a bus-ETA tool, must not stop at planAccessibleRoute, bus-oriented final text) is enforced by the full-loop V1b phase and T6 in ai-chat.service.test.ts",
  },

  // E. searchAccessibilityGuide vs findGooglePlaces / findA11yPlaces
  {
    id: "guide-1",
    query: "輪椅怎麼搭公車",
    expectTool: "searchAccessibilityGuide",
    mustNotCall: ["getBusRoute", "findGooglePlaces"],
  },
  {
    id: "guide-2",
    query: "身障停車證怎麼申請",
    expectTool: "searchAccessibilityGuide",
    mustNotCall: ["findNearbyParking"],
  },
  {
    id: "guide-3",
    query: "捷運有哪些無障礙設施",
    expectTool: "searchAccessibilityGuide",
    acceptAlso: ["findA11yPlaces"],
    notes: "soft: knowledge vs place",
  },
  {
    id: "places-1",
    query: "台北車站附近哪裡有好吃的",
    expectTool: "findGooglePlaces",
    mustNotCall: ["findA11yPlaces"],
  },
  {
    id: "places-2",
    query: "附近的咖啡廳",
    userLocation: TAIPEI_STATION,
    expectTool: "findGooglePlaces",
  },
  {
    id: "places-nearest-train",
    query: "帶我去最近的火車站",
    userLocation: TAIPEI_STATION,
    expectTool: "findGooglePlaces",
    mustNotCall: ["planAccessibleRoute"],
    notes:
      "first round must discover the nearest station before route planning",
  },
  {
    id: "places-nearest-metro",
    query: "最近的捷運站怎麼走",
    userLocation: TAIPEI_STATION,
    expectTool: "findGooglePlaces",
    mustNotCall: ["planAccessibleRoute"],
    notes:
      "first round must discover the nearest station before route planning",
  },
  {
    id: "places-explore-cafes",
    query: "附近有哪些咖啡廳",
    userLocation: TAIPEI_STATION,
    expectTool: "findGooglePlaces",
    mustNotCall: ["planAccessibleRoute"],
  },

  // F. English
  {
    id: "en-a11y",
    query: "Is there an accessible toilet at Taipei Main Station?",
    expectTool: "findA11yPlaces",
  },
  {
    id: "en-air",
    query: "What's the air quality right now?",
    userLocation: TAIPEI_STATION,
    expectTool: "getAirQuality",
    acceptAlso: ["getEnvironmentInfo"],
    notes: "soft: English loses the 數值 nuance",
  },

  // G. saveMemory triggers (logged in)
  {
    id: "mem-save-1",
    query: "我住在板橋車站附近，平常都坐輪椅",
    loggedIn: true,
    expectTool: "saveMemory",
  },
  {
    id: "mem-save-2",
    query: "我每天搭307上班",
    loggedIn: true,
    expectTool: "saveMemory",
  },

  // H. mixed-intent / no-tool-expected
  {
    id: "mixed-1",
    query: "從台北車站到台北101怎麼走，那邊天氣如何",
    expectTool: "planAccessibleRoute",
    notes: "model may parallel-call; pass if expected tool present",
  },
  {
    id: "chitchat",
    query: "你好，你可以做什麼",
    expectTool: "__none__",
    notes: "must not spuriously route a greeting",
  },

  // I. train (getTrainTimetable / getStationTimetable) vs plan/bus
  {
    id: "train-1",
    query: "明天早上9點以後從台北到台中的火車有哪些",
    expectTool: "getTrainTimetable",
    mustNotCall: ["planAccessibleRoute", "getBusTimetable"],
    expectArgs: (a, ctx) => {
      if (!hhmmEq(a?.departAfter, "09:00"))
        return `departAfter=${a?.departAfter}`;
      if (a?.arriveBy != null)
        return `arriveBy should be absent, got ${a.arriveBy}`;
      if (a?.date !== ymdPlusDays(ctx.today, 1)) return `date=${a?.date}`;
      if (!hasStation(a?.originStation, "北"))
        return `originStation=${a?.originStation}`;
      if (!hasStation(a?.destinationStation, "中"))
        return `destinationStation=${a?.destinationStation}`;
      return null;
    },
  },
  {
    id: "train-2",
    query: "我週五中午12點前要從台北到左營，高鐵可以搭幾點的",
    expectTool: "getTrainTimetable",
    expectArgs: (a) => {
      if (!hhmmEq(a?.arriveBy, "12:00")) return `arriveBy=${a?.arriveBy}`;
      if (a?.departAfter != null)
        return `departAfter should be absent, got ${a.departAfter}`;
      if (a?.railSystem !== "THSR") return `railSystem=${a?.railSystem}`;
      if (!isFriday(a?.date)) return `date not a valid Friday: ${a?.date}`;
      return null;
    },
  },
  {
    id: "train-3",
    query: "我想知道9點的火車有哪些",
    expectTool: "__none__",
    mustNotCall: ["getTrainTimetable", "getStationTimetable"],
    notes: "沒有任何車站，應追問不猜",
  },
  {
    id: "train-3b",
    query: "我明天要從台北出發，9點以後的火車有哪些",
    expectTool: "getStationTimetable",
    acceptAlso: ["getTrainTimetable"],
    notes: "只給一站+時間＝發車看板；destination 未知時不應硬湊 OD",
    expectArgs: (a) => {
      if (a?.station != null && !hasStation(a?.station, "北"))
        return `station=${a?.station}`;
      if (a?.originStation != null && !hasStation(a?.originStation, "北"))
        return `originStation=${a?.originStation}`;
      return null;
    },
  },
  {
    id: "train-3c",
    query: "我想坐火車去台中，12點前要到",
    expectTool: "__none__",
    acceptAlso: ["getTrainTimetable"],
    mustNotCall: ["getStationTimetable"],
    notes: "只有訖站無起站；問到達導向，應追問起站或走 OD，不應誤用發車看板",
  },
  {
    id: "train-4",
    query: "坐火車從台北到台中要怎麼去、怎麼轉車",
    expectTool: "planAccessibleRoute",
    acceptAlso: ["getTrainTimetable"],
    notes: "轉乘行程界線",
  },
  {
    id: "station-1",
    query: "台中車站最近的火車有哪些",
    expectTool: "getStationTimetable",
    mustNotCall: ["getTrainTimetable", "planAccessibleRoute"],
    expectArgs: (a) =>
      hasStation(a?.station, "中") ? null : `station=${a?.station}`,
  },
  {
    id: "station-2",
    query: "高鐵左營站接下來幾點有車",
    expectTool: "getStationTimetable",
    expectArgs: (a) => {
      if (a?.railSystem !== "THSR") return `railSystem=${a?.railSystem}`;
      if (!hasStation(a?.station, "左營")) return `station=${a?.station}`;
      return null;
    },
  },
  {
    id: "station-3",
    query: "台北車站明天早上6點以後有哪些火車",
    expectTool: "getStationTimetable",
    expectArgs: (a, ctx) => {
      if (a?.date !== ymdPlusDays(ctx.today, 1)) return `date=${a?.date}`;
      if (!hhmmEq(a?.departAfter, "06:00"))
        return `departAfter=${a?.departAfter}`;
      return null;
    },
  },
];

function hhmmEq(value: unknown, expected: string): boolean {
  if (typeof value !== "string") return false;
  const m = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!m) return false;
  return `${m[1].padStart(2, "0")}:${m[2]}` === expected;
}

function hasStation(value: unknown, needle: string): boolean {
  return (
    typeof value === "string" &&
    value.replace(/台/g, "臺").includes(needle.replace(/台/g, "臺"))
  );
}

function isFriday(value: unknown): boolean {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false;
  return new Date(`${value}T00:00:00Z`).getUTCDay() === 5;
}
