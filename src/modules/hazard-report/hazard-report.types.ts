import type { AiVerdict, HazardSeverity, HazardType } from "../../types";

export type PhotoMimeType = "image/jpeg" | "image/png";

export interface UploadedPhoto {
  buffer: Buffer;
  mimeType: PhotoMimeType;
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

export interface CreateReportInput {
  reporterId: string;
  hazardType: HazardType;
  severity: HazardSeverity;
  latitude: number;
  longitude: number;
  description?: string;
  expectedUntil?: string;
  photo: UploadedPhoto;
}

export interface NearbyReportsInput {
  lat: number;
  lng: number;
  radius?: number;
  hazardType?: HazardType;
  status?: string[];
  limit?: number;
}

export interface MyReportsInput {
  reporterId: string;
  status?: string[];
  hazardType?: HazardType;
  limit?: number;
  cursor?: string;
}

export type ConfirmAction = "confirm" | "deny";

export interface ConfirmInput {
  reportId: string;
  action: ConfirmAction;
  voterId: string;
}

export interface ExifValidationResult {
  timestampFresh: boolean;
  gpsPresent: boolean;
  gpsMatchesClaimed: boolean;
  rawExifTime?: string;
  rawExifLat?: number;
  rawExifLng?: number;
}

export interface AiVerifyResult {
  verdict: AiVerdict;
  confidence: number;
  reason: string;
}

export interface VisionPrefilterResult {
  passed: boolean;
  detectedLabels?: string[];
  safeSearchBlocked: boolean;
}
