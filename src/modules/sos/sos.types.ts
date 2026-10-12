export type SosType = "body" | "trapped" | "share_location";

export interface ActiveSosChoice {
  sessionId: string;
  ownerName: string;
  type: SosType;
  createdAt: Date;
}

export interface ActiveSosDetail {
  sessionId: string;
  shareToken: string;
  ownerName: string;
  type: SosType;
  address: string | null;
  handlingStatus: string;
  claimedByName: string | null;
  locationUpdatedAt: Date;
}

export interface ActiveSosChoicePage {
  bound: boolean;
  sessions: ActiveSosChoice[];
  hasMore: boolean;
  offset: number;
}

/**
 * Uniform service-to-controller result. `httpCode` is the HTTP status (also the
 * envelope `code`); failures encode their domain reason inside `data.reason`.
 */
export interface ServiceResult<T = unknown> {
  ok: boolean;
  httpCode: number;
  message: string;
  data?: T;
}

export interface CreateSosInput {
  userId: string;
  type: SosType;
  lat: number;
  lng: number;
  address?: string;
}

export interface UpdateLocationInput {
  userId: string;
  sessionId: string;
  lat: number;
  lng: number;
  address?: string;
}

/**
 * Resolve accepts EITHER a web owner (`userId`) OR a bound LINE contact
 * (`lineUserId`) — exactly one identity is present per call.
 */
export interface ResolveSosInput {
  sessionId: string;
  userId?: string;
  lineUserId?: string;
}

export interface AcknowledgeSosInput {
  sessionId: string;
  lineUserId: string;
}

export interface ClaimSosInput {
  sessionId: string;
  lineUserId: string;
}

/** Family-settable handling states (subset of SosHandlingStatus). */
export type FamilyHandlingStatus = "en_route" | "arrived";

export interface UpdateSosStatusInput {
  sessionId: string;
  lineUserId: string;
  handlingStatus?: FamilyHandlingStatus;
  note?: string;
}

export interface GetSosForOwnerInput {
  userId: string;
  sessionId: string;
}
