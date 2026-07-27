export type AuthProvider = "google" | "local";

export interface IUser {
  _id: string;
  name: string;
  avatar?: string;
  email: string;
  client_id?: string | null;
  passwordHash?: string;
  authProviders: AuthProvider[];
  emailVerified: boolean;
  tokenVersion: number;
  lineUserId?: string | null;
  settings?: {
    memoryEnabled?: boolean;
  };
  createdAt: string;
  updatedAt: string;
}

export type AuthTokenType = "email_verify" | "password_reset";

export interface IAuthToken {
  _id: string;
  userId: string;
  type: AuthTokenType;
  tokenHash: string;
  expiresAt: Date;
  usedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface IConfig {
  language: string;
  darkMode: "light" | "dark" | "system";
  themeColor: string;
  fontSize: string;
  notifications: boolean;
  user_id: Schema.Types.ObjectId;
}

export interface IA11y {
  _id: string;
  項次: string;
  "出入口電梯/無障礙坡道名稱": string;
  經度?: number;
  緯度?: number;
  location: { type: "Point"; coordinates: [number, number] };
}

export interface IBathroom {
  _id: string;
  county: string;
  areacode: string;
  village: string;
  number: string;
  name: string;
  address: string;
  administration: string;
  latitude?: number;
  longitude?: number;
  location: { type: "Point"; coordinates: [number, number] };
  grade: string;
  type2: string;
  type: string;
  exec: string;
  diaper: string;
}

export interface IDisabledParking {
  _id: string;
  city: string;
  district: string;
  areacode: string;
  quantity: number;
  placeName: string;
  chargeType: string;
  spaceLabel: string;
  isMarked: boolean;
  latitude?: number;
  longitude?: number;
  location: { type: "Point"; coordinates: [number, number] };
  importedAt: Date;
}

export interface IWelfare {
  _id: string;
  name: string;
  county: string;
  district: string;
  address: string;
  phone: string;
  type: string;
  approvedCapacity: { residential: number; night: number; day: number };
  actualServed: { residential: number; night: number; day: number };
  evaluationTerm: string;
  evaluationGrade: string;
  geocoded: boolean;
  location?: { type: "Point"; coordinates: [number, number] };
  importedAt: Date;
}

export interface ICampusFacility {
  facUid: string;
  facTypeId?: number;
  facType?: string;
  name?: string;
  building?: string;
  buildingUid?: string;
  floors: string[];
  floorIds: string[];
  location?: { type: "Point"; coordinates: [number, number] };
  specs?: { label: string; value: string }[];
  detailFetchedAt?: Date;
}

export interface ICampusA11y {
  _id: string;
  schoolId: number;
  schoolName: string;
  branchId: number;
  branchName: string;
  city?: string;
  address?: string;
  phone?: string;
  buildingCount: number;
  facilityCount: number;
  facilities: ICampusFacility[];
  location?: { type: "Point"; coordinates: [number, number] };
  searchName?: string;
  aliasNames?: string[];
  importedAt: Date;
}

export interface RankRequest {
  start: google.maps.LatLngLiteral;
  end: google.maps.LatLngLiteral;
  instructions: string;
  duration: number;
  a11y: [];
}

export interface AIRankResponse {
  route_description: string;
  route_total_score: number;
}

export interface ITdxBusStop {
  stopUid: string;
  stopName: { Zh_tw: string; En?: string };
  city: string;
  subRouteIds: string[];
  location: { type: "Point"; coordinates: [number, number] };
  importedAt: Date;
}

export interface ITdxBusRouteStop {
  stopUID: string;
  stopId?: string;
  stopName: { Zh_tw: string; En?: string };
  seq: number;
  lat?: number;
  lng?: number;
}

export interface ITdxBusRoute {
  subRouteUid: string;
  routeUid: string;
  routeId?: string;
  city: string;
  routeName: { Zh_tw: string; En?: string };
  subRouteName?: { Zh_tw: string; En?: string };
  direction: number;
  operators: { id?: string; name?: string }[];
  stops: ITdxBusRouteStop[];
  importedAt: Date;
}

export interface ITdxBusVehicle {
  plateNumb: string;
  city: string;
  operatorId?: string;
  vehicleClass?: number;
  vehicleType?: number;
  isLowFloor?: number;
  hasLiftOrRamp?: number;
  isElectric?: number;
  isHybrid?: number;
  hasWifi?: number;
  importedAt: Date;
}

export interface IOsmA11y {
  osmId: string;
  name?: string;
  category: "wheelchair_accessible" | "kerb_cut" | "ramp" | "elevator" | "toilet";
  wheelchair?: "yes" | "limited" | "no";
  tags: Record<string, string>;
  location: { type: "Point"; coordinates: [number, number] };
  importedAt: Date;
}

export interface ITdxMetroStation {
  stationUid: string;
  stationName: { Zh_tw: string; En?: string };
  railSystem: string;
  lineIds: string[];
  location: { type: "Point"; coordinates: [number, number] };
  importedAt: Date;
}

export interface ITdxTrainStation {
  stationUID: string;
  stationID: string;
  stationName: { Zh_tw: string; En?: string };
  railSystem: string;
  location: { type: "Point"; coordinates: [number, number] };
  importedAt: Date;
}

export interface AgentResponse {
  action:
    | "findNearbyA11y"
    | "transportInfo"
    | "locationAccessibility"
    | "googleSearch"
    | "feedback";
  type?: string;
  range?: number;
  location?: { lat: number; lng: number };
  routeId?: string;
  origin?: object | string;
  destination?: object | string;
  query?: string;
}

export interface IGtfsLevel {
  levelId: string;
  levelIndex: number;
  levelName: string;
}

export interface IGtfsPathway {
  pathwayId: string;
  fromStopId: string;
  toStopId: string;
  pathwayMode: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  isBidirectional: 0 | 1;
  traversalTime?: number;
  stairCount?: number;
}

export interface IGtfsStop {
  stopId: string;
  stopName: string;
  stopLat: number;
  stopLon: number;
  zoneId?: string;
  locationType: 0 | 1 | 2 | 3;
  parentStation?: string;
  levelId?: string;
  location: {
    type: "Point";
    coordinates: [number, number];
  };
}

export interface IGtfsTrip {
  tripId: string;
  routeId: string;
  serviceId: string;
  shapeId?: string;
  directionId: 0 | 1;
  bikesAllowed?: 0 | 1 | 2;
}

export interface IVisualA11y {
  _id: string;
  osmNodeId: number;
  type: "audio_signal" | "tactile_paving";
  location: { type: "Point"; coordinates: [number, number] };
  properties: {
    buttonOperated?: boolean | null;
    vibration?: boolean | null;
    roadName?: string | null;
    subType?: string | null;
    name?: string | null;
    nameEn?: string | null;
    wheelchair?: string | null;
  };
  updatedAt: Date;
}

export type HazardType = "obstacle" | "construction" | "data_error";
export type AiVerdict = "verified" | "suspicious" | "rejected" | "skipped";
export type HazardStatus = "pending" | "verified" | "rejected" | "expired";

export interface IHazardReport {
  _id: string;
  reporterId: string;
  reportedLocation: { type: "Point"; coordinates: [number, number] };
  hazardType: HazardType;
  description?: string;
  photoUrl: string;
  photoStoragePath: string;
  exifValidation: {
    timestampFresh: boolean;
    gpsPresent: boolean;
    gpsMatchesClaimed: boolean;
    rawExifTime?: string;
    rawExifLat?: number;
    rawExifLng?: number;
  };
  aiVerification: {
    verdict: AiVerdict;
    confidence: number;
    reason: string;
    prefilter?: {
      passed?: boolean;
      detectedLabels?: string[];
      safeSearchBlocked?: boolean;
    };
    attemptedAt?: Date;
  };
  status: HazardStatus;
  confirmCount: number;
  denyCount: number;
  confirmedBy: string[];
  deniedBy: string[];
  createdAt: Date;
  updatedAt: Date;
  expiredAt: Date;
}

export interface IEmergencyContact {
  _id: string;
  userId: string;
  name: string;
  lineUserId: string | null;
  bindStatus: "pending" | "bound";
  bindCode?: string | null;
  bindCodeExpiresAt?: Date | null;
  lastLineLat?: number | null;
  lastLineLng?: number | null;
  lastLineLocationUpdatedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ILineLinkCode {
  _id: string;
  userId: string;
  code: string;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export type SosHandlingStatus =
  | "notified"
  | "acknowledged"
  | "claimed"
  | "en_route"
  | "arrived"
  | "resolved";

export interface ISosAcknowledgement {
  contactId?: string | null;
  lineUserId: string;
  name?: string | null;
  at: Date;
}

export type SosTimelineType =
  | "created"
  | "notified"
  | "acknowledged"
  | "claimed"
  | "status_update"
  | "resolved";

export interface ISosTimelineEntry {
  type: SosTimelineType;
  actorType: "victim" | "contact" | "system";
  actorLineUserId?: string | null;
  actorName?: string | null;
  note?: string | null;
  at: Date;
}

export interface ISosSession {
  _id: string;
  userId: string;
  type: "body" | "trapped" | "share_location";
  status: "active" | "resolved";
  handlingStatus: SosHandlingStatus;
  lat: number;
  lng: number;
  address?: string | null;
  shareToken: string;
  locationUpdatedAt: Date;
  resolvedAt?: Date | null;
  claimedBy?: string | null;
  claimedByName?: string | null;
  claimedByContactId?: string | null;
  claimedAt?: Date | null;
  acknowledgements: ISosAcknowledgement[];
  timeline: ISosTimelineEntry[];
  staleAlertSent: boolean;
  createdAt: Date;
  updatedAt: Date;
}
