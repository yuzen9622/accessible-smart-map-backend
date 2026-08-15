export type RailSystem = "TRA" | "THSR";

export type RailFetchErrorCode =
  "HTTP_ERROR" | "BAD_PAYLOAD" | "NETWORK" | "BUSY";

export interface NormalizedTrain {
  trainNo: string;
  trainType?: string;
  departureTime: string;
  arrivalTime: string;
  departureMinutes: number;
  arrivalMinutes: number;
  arrivesNextDay?: true;
  durationMinutes: number;
}

export interface NormalizedStationTrain {
  trainNo: string;
  trainType?: string;
  direction?: number;
  destination?: string;
  departureTime: string;
  departureMinutes: number;
  arrivalTime?: string;
}

export type RailFetchOutcome<T> =
  { ok: true; items: T[] } | { ok: false; errorCode: RailFetchErrorCode };

export type OdFetchOutcome = RailFetchOutcome<NormalizedTrain>;

export type StationFetchOutcome = RailFetchOutcome<NormalizedStationTrain>;

export type StationIndexOutcome =
  | { ok: true; index: Map<string, string> }
  | { ok: false; errorCode: RailFetchErrorCode };
