import type {
  HazardAiReview,
  HazardAiReviewJob,
  HazardPhotoIntake,
} from "./hazard-ai-review";

export type {
  HazardAiReview,
  HazardAiReviewJob,
  HazardPhotoIntake,
} from "./hazard-ai-review";

export type AuthProvider = "google" | "apple" | "local";

export interface IUser {
  _id: string;
  name: string;
  avatar?: string;
  email: string;
  client_id?: string | null;
  appleUserId?: string | null;
  passwordHash?: string;
  authProviders: AuthProvider[];
  emailVerified: boolean;
  tokenVersion: number;
  role?: "user" | "admin";
  passwordResetTokens?: Array<{
    jobId: string;
    tokenHash: string;
    expiresAt: Date;
    consumedAt?: Date;
  }>;
  lineUserId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export type AuthTokenType = "email_verify" | "password_reset";

export interface IAuthSessionRecentJti {
  jti: string;
  rotatedAt: Date;
}

export interface IAuthSession {
  _id: string;
  userId: string;
  currentRefreshJti: string;
  previousRefreshJti?: string | null;
  recentRefreshJtis?: IAuthSessionRecentJti[];
  rotatedAt?: Date | null;
  expiresAt: Date;
  revokedAt?: Date | null;
  revokedReason?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

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

export type PushPlatform = "ios" | "android";

export interface IPushToken {
  _id: string;
  token: string;
  userId: string;
  authSessionId: string;
  platform: PushPlatform;
  locale: string;
  createdAt: Date;
  updatedAt: Date;
}

export type PasswordAssistanceJobStatus = "pending" | "processing" | "failed";

export interface IPasswordAssistanceJob {
  _id: string;
  email: string;
  status: PasswordAssistanceJobStatus;
  attempts: number;
  availableAt: Date;
  lockedAt?: Date | null;
  leaseToken?: string | null;
  tokenExpiresAt?: Date | null;
  lastError?: string;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export type MobilityAid =
  "manual_wheelchair" | "power_wheelchair" | "walker" | "none";

export interface IA11yProfile {
  mobilityAid: MobilityAid | null;
  canUseStairs: boolean | null;
  maxSlopePercent: number | null;
  needsAccessibleToilet: boolean | null;
  needsElevator: boolean | null;
  needsHandrail: boolean | null;
  visualAssistance: boolean | null;
  preferredFontScale: number | null;
}

export interface IConfig {
  language: string;
  darkMode: "light" | "dark" | "system";
  themeColor: string;
  fontSize: string;
  notifications: boolean;
  accessibility: IA11yProfile;
  memoryEnabled: boolean;
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
  source?: string;
  externalId?: string;
  latitude?: number;
  longitude?: number;
  location: { type: "Point"; coordinates: [number, number] };
  importedAt: Date;
}

export interface IParkingSpace {
  _id: string;
  city: string;
  segmentId: string;
  spaceType: number;
  hasChargingPoint: boolean;
  isDisabled: boolean;
  externalId: string;
  latitude?: number;
  longitude?: number;
  location: { type: "Point"; coordinates: [number, number] };
  importedAt: Date;
}

export interface IParkingLot {
  _id: string;
  carParkId: string;
  name: string;
  address?: string;
  city: string;
  district?: string;
  carParkType?: number;
  chargeTypes?: number[];
  wheelchairAccessible?: boolean;
  disabledSpaces?: number;
  totalCarSpaces?: number;
  latitude?: number;
  longitude?: number;
  position: { type: "Point"; coordinates: [number, number] };
  location?: { type: "Point"; coordinates: [number, number] };
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
  source?: BusFleetSource;
  importedAt: Date;
}

export type BusFleetSource =
  "tdx" | "taichung-ebus" | "keelung-ebus" | "hsinchu-ibus";

/** One plate's low-floor status as reported by a city's own bus system. */
export interface BusFleetObservation {
  plateNumb: string;
  city: string;
  isLowFloor: 0 | 1;
  source: BusFleetSource;
  /** The city system's own ids of the routes this plate was seen running. */
  cityRouteIds?: string[];
}

/** Where a plate-on-route sighting came from. */
export type BusFleetSightingSource =
  "taichung-ebus" | "hsinchu-ibus" | "tdx-realtime";

/** A plate seen running a TDX route on one Taipei service day. */
export interface IBusFleetSighting {
  plateNumb: string;
  routeUid: string;
  source: BusFleetSightingSource;
  /** Taipei service date, YYYY-MM-DD; one record per plate, route and day. */
  seenOn: string;
  seenAt: Date;
  expiresAt: Date;
}

/**
 * A route's low-floor history from distinct plates seen on it. Plates whose
 * car type is unknown count toward `distinctPlates` but not the share.
 */
export interface RouteLowFloorEvidence {
  distinctPlates: number;
  knownTypePlates: number;
  lowFloorPlates: number;
  lastSeenAt: Date;
  sources: BusFleetSightingSource[];
}

export type OsmWheelchairValue = "yes" | "designated" | "limited" | "no";

export interface IOsmA11y {
  osmId: string;
  name?: string;
  category:
    "wheelchair_accessible" | "kerb_cut" | "ramp" | "elevator" | "toilet";
  wheelchair?: OsmWheelchairValue;
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

export type VisualA11ySource = "osm" | "taipei_tce";

export interface IVisualA11y {
  _id: string;
  /** "osm" for Overpass nodes; "taipei_tce" for 臺北市交通管制工程處 audible signals. */
  source: VisualA11ySource;
  /** The id within its source: the OSM node id, or the TCE 號誌編號. */
  sourceId: string;
  osmNodeId?: number;
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

/** 臺北市公園處「公園無障礙出入口點位」: one surveyed accessible park entrance. */
export interface IParkEntrance {
  _id: string;
  /** The dataset's row `ID`; a release-local row number, not a durable id. */
  sourceId: string;
  district: string | null;
  parkName: string;
  entranceName: string;
  location: { type: "Point"; coordinates: [number, number] };
  /** Minimum clear sidewalk width at the entrance, in metres; null when unparseable. */
  minClearWidthM: number | null;
  /** Entrance slope in percent; null when unparseable. */
  slopePercent: number | null;
  importedAt: Date;
}

/**
 * Where a park lies, used to tell whether a destination is inside it.
 * `osm` is the OpenStreetMap `leisure=park` outline whose edge carries most of
 * the park's surveyed entrances; `entrance_hull` is the convex hull of the
 * entrances themselves, used only when no OSM outline matches.
 */
export interface IParkArea {
  _id: string;
  /** Matches {@link IParkEntrance.parkName}. */
  parkName: string;
  source: "osm" | "entrance_hull";
  /** `way/123` or `relation/456` when `source` is `osm`. */
  osmId: string | null;
  geometry: { type: "Polygon"; coordinates: [number, number][][] };
  importedAt: Date;
}

export type HazardType = "obstacle" | "construction" | "data_error";
export type HazardSeverity = "blocking" | "difficult" | "minor";
export type AiVerdict = "verified" | "suspicious" | "rejected" | "skipped";
export type HazardStatus = "pending" | "verified" | "rejected" | "expired";

export interface IHazardReport {
  _id: string;
  reporterId: string;
  reportedLocation: { type: "Point"; coordinates: [number, number] };
  hazardType: HazardType;
  severity: HazardSeverity;
  expectedUntil: Date | null;
  description?: string;
  /** Absent once the report is de-identified (photo deleted). */
  photoUrl?: string;
  photoStoragePath?: string;
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
  manualReview?: {
    reviewerId: string;
    decision: "verified" | "rejected";
    note?: string;
    reviewedAt: Date;
  };
  createdAt: Date;
  updatedAt: Date;
  expiredAt: Date;
  /** When the report was rejected or expired; cleared if it is reopened. */
  closedAt?: Date | null;
  /** When identity and free-text content were removed (retention phase A). */
  contentScrubbedAt?: Date;
  /** When the photo was deleted too (retention phase B); fully de-identified. */
  deidentifiedAt?: Date;
  photoDelete?: { attempts: number; nextAttemptAt?: Date };
  /** v2 AI review; absent on legacy reports. */
  aiReview?: HazardAiReview;
  /** Internal work metadata (select:false); never part of a view. */
  aiReviewJob?: HazardAiReviewJob;
  /** Private intake/cleanup state (select:false); absent on legacy reports. */
  photoIntake?: HazardPhotoIntake;
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
  | "pending"
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
  /** True when the system closed the session after it went stale. */
  autoResolved?: boolean;
  resolvedNotice?: ISosResolvedNotice;
  initialNotice?: ISosInitialNotice;
  createdAt: Date;
  updatedAt: Date;
}

/** Delivery state of the auto-resolve notice to bound contacts. */
export interface ISosResolvedNotice {
  status: "pending" | "sent" | "failed";
  attempts: number;
  nextAttemptAt: Date;
  claimId?: string | null;
  retryKey: string;
  lastError?: string | null;
}

export interface ITrafficSection {
  sectionId: string;
  city: string;
  roadName?: string;
  roadClass?: number;
  geometry: {
    type: "LineString" | "MultiLineString";
    coordinates: number[][] | number[][][];
  };
  lengthM?: number;
  roadDirection?: string;
  startKm?: number;
  endKm?: number;
  startPoint?: [number, number];
  updatedAt?: Date;
}

/** Durable initial SOS multicast; payload and audience remain fixed across retries. */
export interface ISosInitialNotice {
  status: "queued" | "accepted" | "failed" | "skipped";
  recipients: string[];
  payload: {
    userName?: string;
    type: "body" | "trapped" | "share_location";
    trackingUrl: string;
    address?: string | null;
  };
  retryKey: string;
  attempts: number;
  nextAttemptAt: Date;
  retryUntil: Date;
  claimId?: string | null;
  leaseUntil?: Date | null;
  notifiedCount: number;
}
