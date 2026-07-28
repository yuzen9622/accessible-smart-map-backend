export const TDX_API_KEY = process.env.TDX_API_KEY || "";

export const busUrl = {
  cityRouteSearchUrl:
    "https://tdx.transportdata.tw/api/basic/v2/Bus/Route/City",
  stopOfRouteUrl:
    "https://tdx.transportdata.tw/api/basic/v2/Bus/StopOfRoute/City",
  cityRealtimeByFrequencyUrl:
    "https://tdx.transportdata.tw/api/basic/v2/Bus/RealTimeByFrequency/City",
  cityEstimatedTimeOfArrivalUrl:
    "https://tdx.transportdata.tw/api/basic/v2/Bus/EstimatedTimeOfArrival/City",
  cityScheduleUrl:
    "https://tdx.transportdata.tw/api/basic/v2/Bus/Schedule/City",
  cityVehicleUrl:
    "https://tdx.transportdata.tw/api/basic/v2/Bus/Vehicle/City",
  interCityScheduleUrl:
    "https://tdx.transportdata.tw/api/basic/v2/Bus/Schedule/InterCity",
  interCityStopOfRouteUrl:
    "https://tdx.transportdata.tw/api/basic/v2/Bus/StopOfRoute/InterCity/",
  interCityEstimatedTimeOfArrivalUrl:
    "https://tdx.transportdata.tw/api/basic/v2/Bus/EstimatedTimeOfArrival/Streaming/InterCity",
  interCityRealTimeByFrequencyUrl:
    "https://tdx.transportdata.tw/api/basic/v2/Bus/RealTimeByFrequency/Streaming/InterCity",
};

export const trainUrl = {
  liveBoardUrl: "https://tdx.transportdata.tw/api/basic/v2/Rail/TRA/LiveBoard",
  trainLiveBoardUrl:
    "https://tdx.transportdata.tw/api/basic/v3/Rail/TRA/TrainLiveBoard",
};

const METRO_BASE = "https://tdx.transportdata.tw/api/basic/v2/Rail/Metro";

export const metroUrl = {
  stationUrl: (s: string) => `${METRO_BASE}/Station/${s}`,
  stationOfLineUrl: (s: string) => `${METRO_BASE}/StationOfLine/${s}`,
  s2sTravelTimeUrl: (s: string) => `${METRO_BASE}/S2STravelTime/${s}`,
  frequencyUrl: (s: string) => `${METRO_BASE}/Frequency/${s}`,
  stationFacilityUrl: (s: string) => `${METRO_BASE}/StationFacility/${s}`,
  alertUrl: (s: string) => `${METRO_BASE}/Alert/${s}`,
};

/**
 * Bare metro line code the frontend uses to colour/label a line
 * (淡水信義線 "R" 紅, 板南線 "BL" 藍, 松山新店線 "G" 綠, 中和新蘆線 "O" 橘, 文湖線 "BR" 棕…).
 * Recovers the code from the two id shapes the routers emit. Returns the input
 * unchanged when it matches neither shape.
 *
 * @param railSystem The rail system prefix, e.g. "TRTC".
 * @param raw The raw route id or line uid to extract the code from.
 * @returns The bare metro line code, or the input unchanged.
 */
export function metroLineCode(railSystem: string, raw: string): string {
  if (!raw) return "";
  if (raw.includes("_")) {
    const parts = raw.split("_");
    return parts[1] || parts[0];
  }
  if (railSystem && raw.startsWith(`${railSystem}-`)) {
    return raw.slice(railSystem.length + 1);
  }
  return raw;
}

const RAIL_BASE = "https://tdx.transportdata.tw/api/basic/v2/Rail";

export const thsrUrl = {
  stationUrl: `${RAIL_BASE}/THSR/Station`,
  generalTimetableUrl: `${RAIL_BASE}/THSR/GeneralTimetable`,
  dailyTimetableUrl: `${RAIL_BASE}/THSR/DailyTrainTimetable/Today`,
  dailyTimetableOdUrl: (from: string, to: string, date: string) =>
    `${RAIL_BASE}/THSR/DailyTimetable/OD/${from}/to/${to}/${date}`,
  dailyTimetableStationUrl: (stationId: string, date: string) =>
    `${RAIL_BASE}/THSR/DailyTimetable/Station/${stationId}/${date}`,
  stationFacilityUrl: `${RAIL_BASE}/THSR/StationFacility`,
};

export const traUrl = {
  stationUrl: `${RAIL_BASE}/TRA/Station`,
  generalTimetableUrl: `${RAIL_BASE}/TRA/GeneralTimetable`,
  dailyTimetableUrl: `${RAIL_BASE}/TRA/DailyTrainTimetable/Today`,
  dailyTimetableOdUrl: (from: string, to: string, date: string) =>
    `${RAIL_BASE}/TRA/DailyTimetable/OD/${from}/to/${to}/${date}`,
  dailyTimetableStationUrl: (stationId: string, date: string) =>
    `${RAIL_BASE}/TRA/DailyTimetable/Station/${stationId}/${date}`,
  stationFacilityUrl: `${RAIL_BASE}/TRA/StationFacility`,
};
