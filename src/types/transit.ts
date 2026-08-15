export enum TaiwanCityEn {
  Taipei = "Taipei",
  NewTaipei = "NewTaipei",
  Taoyuan = "Taoyuan",
  Taichung = "Taichung",
  Tainan = "Tainan",
  Kaohsiung = "Kaohsiung",
  Keelung = "Keelung",
  Hsinchu = "Hsinchu",
  HsinchuCounty = "HsinchuCounty",
  MiaoliCounty = "MiaoliCounty",
  ChanghuaCounty = "ChanghuaCounty",
  NantouCounty = "NantouCounty",
  YunlinCounty = "YunlinCounty",
  ChiayiCounty = "ChiayiCounty",
  Chiayi = "Chiayi",
  PingtungCounty = "PingtungCounty",
  YilanCounty = "YilanCounty",
  HualienCounty = "HualienCounty",
  TaitungCounty = "TaitungCounty",
  KinmenCounty = "KinmenCounty",
  PenghuCounty = "PenghuCounty",
  LienchiangCounty = "LienchiangCounty",
}

/** TDX 公車 API 的兩組 endpoint scope：市區公車 / 公路客運。 */
export type BusApiType = "City" | "InterCity";

/** 一次公車查詢的候選 scope：要打哪組 endpoint、用哪個路線名。 */
export type BusRouteQueryScope = {
  type: BusApiType;
  routeId: string;
};

export type BusStop = {
  StopUID: string;
  StopID: string;
  StopName: {
    Zh_tw: string;
    En: string;
  };
  StopBoarding: number;
  StopSequence: number;
  StopPosition: {
    PositionLon: number;
    PositionLat: number;
    GeoHash: string;
  };
  StationID: string;
  StationGroupID: string;
  LocationCityCode: string;
};
export type BusOperator = {
  OperatorID: string;
  OperatorName: {
    Zh_tw: string;
    En: string;
  };
  OperatorCode: string;
  OperatorNo: string;
};
export type BusRoute = {
  RouteUID: string;
  RouteID: string;
  RouteName: {
    Zh_tw: string;
    En: string;
  };
  Operators: BusOperator[];
  SubRouteUID: string;
  SubRouteID: string;
  SubRouteName: {
    Zh_tw: string;
    En: string;
  };
  Direction: number;
  City: string;
  CityCode: string;
  Stops: BusStop[];
};

export type BusRealTimeByFrequency = {
  PlateNumb: string;
  Direction: 0 | 1;
  BusPosition: {
    PositionLon: number;
    PositionLat: number;
  };
  Speed?: number;
  DutyStatus: number;
  BusStatus: number;
  GPSTime?: string;
};

export type BusRealtimeNearbyStop = {
  PlateNumb: string;
  OperatorID: string;
  OperatorNo: string;
  RouteUID: string;
  RouteID: string;
  RouteName: {
    Zh_tw: string;
    En: string;
  };
  SubRouteUID: string;
  SubRouteID: string;
  SubRouteName: {
    Zh_tw: string;
    En: string;
  };
  Direction: 0 | 1;
  StopUID: string;
  StopID: string;
  StopName: {
    Zh_tw: string;
    En: string;
  };
  StopSequence: number;
  MessageType: number;
  DutyStatus: number;
  BusStatus: number;
  A2EventType: number;
  GPSTime: string;
  TripStartTimeType: number;
  TripStartTime: string;
  TransTime: string;
  SrcRecTime: string;
  SrcTransTime: string;
  SrcUpdateTime: string;
  UpdateTime: string;
};

export type TdxMetroStation = {
  StationUID: string;
  StationID: string;
  StationName: { Zh_tw: string; En: string };
  StationPosition: { PositionLon: number; PositionLat: number };
};

export type TdxMetroStationOfLine = {
  LineID: string;
  Stations: Array<{
    Sequence: number;
    StationID: string;
    StationName: { Zh_tw: string; En: string };
    CumulativeDistance?: number;
  }>;
};

export type TdxMetroS2STravelTimeRecord = {
  LineID: string;
  RouteID?: string;
  TravelTimes: Array<{
    Sequence: number;
    FromStationID: string;
    ToStationID: string;
    RunTime: number;
    StopTime: number;
  }>;
};

export type TdxMetroFrequencyRecord = {
  LineID: string;
  RouteID?: string;
  Headways: Array<{
    StartTime?: string;
    EndTime?: string;
    MinHeadwayMins: number;
    MaxHeadwayMins: number;
  }>;
  OperationTime?: { StartTime: string; EndTime: string };
};

export type TdxMetroStationFacility = {
  StationUID: string;
  Facilities: Array<{
    FacilityType: number;
    FacilityName?: { Zh_tw: string };
    Quantity?: number;
  }>;
};

export type TdxThsrStation = {
  StationUID: string;
  StationID: string;
  StationName: { Zh_tw: string; En: string };
  StationAddress?: string;
  StationPosition: { PositionLon: number; PositionLat: number };
};

export type TdxThsrGeneralTimetableItem = {
  GeneralTimetable: {
    GeneralTrainInfo: {
      TrainNo: string;
      Direction: 0 | 1;
      StartingStationID: string;
      EndingStationID: string;
      Notes?: string;
    };
    StopTimes: Array<{
      StopSequence: number;
      StationID: string;
      StationName: { Zh_tw: string; En: string };
      ArrivalTime: string;
      DepartureTime: string;
    }>;
    ServiceDay?: {
      Sunday: boolean;
      Monday: boolean;
      Tuesday: boolean;
      Wednesday: boolean;
      Thursday: boolean;
      Friday: boolean;
      Saturday: boolean;
    };
  };
};

export type TdxThsrStationFacility = {
  StationUID: string;
  Facilities?: Array<{
    FacilityType: number;
    FacilityName?: { Zh_tw: string };
    Quantity?: number;
  }>;
};

export type TdxTraStation = {
  StationUID: string;
  StationID: string;
  StationName: { Zh_tw: string; En: string };
  StationAddress?: string;
  StationPosition: { PositionLon: number; PositionLat: number };
};

export type TdxTraGeneralTimetableItem = {
  GeneralTimetable: {
    GeneralTrainInfo: {
      TrainNo: string;
      Direction: 0 | 1;
      TrainTypeID?: string;
      TrainTypeName?: { Zh_tw: string; En?: string };
      StartingStationID: string;
      EndingStationID: string;
      WheelchairFlag?: number;
    };
    StopTimes: Array<{
      StopSequence: number;
      StationID: string;
      StationName?: { Zh_tw: string; En: string };
      ArrivalTime: string;
      DepartureTime: string;
    }>;
    ServiceDay?: {
      Sunday: boolean;
      Monday: boolean;
      Tuesday: boolean;
      Wednesday: boolean;
      Thursday: boolean;
      Friday: boolean;
      Saturday: boolean;
    };
  };
};

export type TdxTraStationFacility = {
  StationUID: string;
  Facilities?: Array<{
    FacilityType: number;
    FacilityName?: { Zh_tw: string };
    Quantity?: number;
  }>;
};

/** One abnormal metro operating alert, station ids resolved to names when known. */
export type MetroAlert = {
  alertId: string;
  title: string;
  description: string;
  status: number;
  stations: Array<{ id: string; name: string | null }>;
  lines: string[];
  publishTime: string;
  updateTime: string;
};

/** Alerts of one metro rail system, with the upstream payload's update time. */
export type MetroAlertResult = {
  railSystem: string;
  updatedAt: string;
  alerts: MetroAlert[];
};
