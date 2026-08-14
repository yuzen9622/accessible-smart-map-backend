export interface MOENVAirQualityRecord {
  sitename: string;
  county: string;
  aqi?: string;
  pollutant?: string;
  status?: string;
  so2?: string;
  co?: string;
  o3?: string;
  o3_8hr?: string;
  pm10?: string;
  "pm2.5"?: string;
  no2?: string;
  nox?: string;
  no?: string;
  wind_speed?: string;
  wind_direc?: string;
  publishtime?: string;
  co_8hr?: string;
  "pm2.5_avg"?: string;
  pm10_avg?: string;
  so2_avg?: string;
  longitude?: string;
  latitude?: string;
  siteid?: string;
}

export interface AIResponse {
  description: string;
  quality:
    | ""
    | "GOOD"
    | "MODERATE"
    | "UNHEALTHY_SENSITIVE"
    | "UNHEALTHY"
    | "VERY_UNHEALTHY"
    | "HAZARDOUS";
}
