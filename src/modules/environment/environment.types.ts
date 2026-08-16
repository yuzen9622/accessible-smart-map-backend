/**
 * Response types for the pre-trip environment aggregation endpoint. Each data
 * block carries its own `status` so any one source can degrade independently.
 */

export type DataStatus = "ok" | "unavailable";

export interface WeatherBlock {
  status: DataStatus;
  temperature?: number;
  precipitationProbability?: number;
  windSpeed?: number;
  windDirection?: string;
  condition?: string;
  rainfall?: number;
  forecastTime?: string;
  observationTime?: string;
  stationName?: string;
  reason?: string;
}

export interface AirQualityBlock {
  status: DataStatus;
  pm25?: number;
  quality?: string;
  advice?: string;
  area?: string | null;
  stationCoordinates?: [number, number] | null;
  reason?: string;
}

export interface CctvCamera {
  id: string;
  name: string;
  location: { lat: number; lng: number };
  distanceM: number;
  snapshotUrl: string | null;
  streamUrl: string | null;
}

export interface CctvBlock {
  status: DataStatus;
  cameras?: CctvCamera[];
  reason?: string;
}

export interface EnvironmentData {
  location: { lat: number; lng: number };
  weather: WeatherBlock;
  airQuality: AirQualityBlock;
  nearbyCctv: CctvBlock;
}

export interface CwaTimeEntry {
  DataTime?: string;
  StartTime?: string;
  EndTime?: string;
  ElementValue: Array<Record<string, string>>;
}

export interface CwaWeatherElement {
  ElementName: string;
  Time: CwaTimeEntry[];
}

export interface CwaLocation {
  LocationName: string;
  Latitude: string;
  Longitude: string;
  WeatherElement: CwaWeatherElement[];
}

export interface CwaObservationCoordinate {
  CoordinateName: string;
  CoordinateFormat?: string;
  StationLatitude: string;
  StationLongitude: string;
}

export interface CwaObservationStation {
  StationName: string;
  StationId: string;
  ObsTime?: {
    DateTime?: string;
  };
  GeoInfo?: {
    Coordinates?: CwaObservationCoordinate[];
    CountyName?: string;
    TownName?: string;
  };
  WeatherElement?: {
    Weather?: string;
    Now?: {
      Precipitation?: string;
    };
    WindDirection?: string;
    WindSpeed?: string;
    AirTemperature?: string;
    RelativeHumidity?: string;
    AirPressure?: string;
  };
}

export interface CwaObservationResponse {
  records?: {
    Station?: CwaObservationStation[];
  };
}

export interface RawCamera {
  id: string;
  name: string;
  lat: number;
  lon: number;
  cam_url?: string;
}
