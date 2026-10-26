import axios from "axios";
import { WALK_SPEED_MPS } from "../config/routing";
import type { OtpDirectWalkProfile } from "../types/otp-walk-search";

const EXECUTED_POLICY_FIELDS = `
  schemaVersion scope profile wheelchairEnabled walkSpeedMps stairsReluctance
  minimumKnownWidthM maximumKnownNonStairSlopeRatio fareAccess
`;

const IDENTITY_FIELDS = `
      schemaVersion
      graphIdentityStatus
      graphByteIdentity { sha256 byteCount }
      sourceManifestIdentityStatus
      buildManifestIdentity {
        manifestSha256 buildInputMode graphSha256 graphByteCount
        sourceVersion sourceBatch sourceArchiveSha256
        mergedPbfSha256 layerReportSha256 declaredBuildPolicyJarSha256
        inputs { path role sha256 byteCount }
        compilerArtifacts { path role sha256 byteCount }
      }
      runtimePolicyIdentityStatus
      runtimePolicyIdentity {
        status reason artifactSha256 manifestSha256
        observedClassDigestSha256 classCount
      }
`;

export const OTP_WALK_IDENTITY_QUERY = `query WalkRequestIdentity {
  requestIdentity { ${IDENTITY_FIELDS} }
}`;

export const OTP_WALK_PLAN_QUERY = `query QualifiedDirectWalk(
  $fromLat: Float!, $fromLon: Float!, $toLat: Float!, $toLon: Float!,
  $date: String!, $time: String!, $stairs: Reluctance!,
  $profile: DirectWalkPolicyProfile!, $wheelchair: Boolean!, $speed: Float!
) {
  requestIdentity { ${IDENTITY_FIELDS} }
  plan(from: {lat: $fromLat, lon: $fromLon}, to: {lat: $toLat, lon: $toLon},
       date: $date, time: $time, wheelchair: $wheelchair, walkSpeed: $speed,
       directWalkPolicyProfile: $profile,
       stairsReluctance: $stairs, numItineraries: 1,
       transportModes: [{mode: WALK}], locale: "zh-TW") {
    routingErrors { code }
    directWalkSearch {
      schemaVersion status nativeOutcome executedPolicy { ${EXECUTED_POLICY_FIELDS} }
      fromLat fromLon toLat toLon departureTimeMs
      maximumSearchDurationS streetSearchTimeoutS durationLimitPruned
      endpointConstraint { scope endpoint phase reasons blockedCandidateCount }
    }
    itineraries { legs {
      mode duration startTime endTime
      walkEvidence {
        schemaVersion captureScope graphIdentityStatus
        executedPolicy { ${EXECUTED_POLICY_FIELDS} }
        graphByteIdentity { sha256 byteCount }
        sourceManifestIdentityStatus runtimePolicyIdentityStatus
        buildManifestIdentity {
          manifestSha256 buildInputMode graphSha256 graphByteCount
          sourceVersion sourceBatch sourceArchiveSha256
          mergedPbfSha256 layerReportSha256 declaredBuildPolicyJarSha256
          inputs { path role sha256 byteCount }
          compilerArtifacts { path role sha256 byteCount }
        }
        edgeOccurrenceCount nonStreetEdgeCount unknownMetadataEdgeCount
        edges {
          occurrenceIndex edgeKind distanceM metadataStatus partial osmWayId
          sourceSegmentIndex reverse knownWidthM sourceRefs widthSourceRefs
          sourceBatch sourceVersion sourceSha256 unknownReason
          policyEvaluation {
            captureSchemaVersion stairs escalator nativeWheelchairAccessible
            knownMaxSlopeRatio knownWidthM knownSmoothness assistedStairs
          }
          attachment {
            ruleVersion regionId surfaceSha256 grade parentOsmWayId
            parentSegmentIndex parentReverse exactCoverage
            widthObservationGeometrySha256 widthCoverageStatus slopeStatus
          }
          areaSources { osmId knownWidthM stairs wheelchairAccessible knownSmoothness sourceRefs
            widthSourceRefs sourceBatch sourceVersion sourceSha256 }
          pathway { pathwayId sourceFromStopId sourceToStopId mode
            knownMinWidthM knownSlopeRatio knownWheelchairAccessible }
        }
        selectedPath {
          geometryCoverageStatus coordinateEncoding gapMetric endpointReachabilityStatus
          startsSearchPath endsSearchPath requestFrom { lat lon } requestTo { lat lon }
          startState { lat lon } endState { lat lon }
          firstGeometryPoint { lat lon } lastGeometryPoint { lat lon }
          requestFromToStartStateGapM requestToToEndStateGapM
          requestFromToFirstGeometryGapM requestToToLastGeometryGapM
          missingGeometryCount positiveDistanceMissingGeometryCount
          stateChainMismatchCount representedGeometryLengthM
          occurrences {
            occurrenceIndex edgeKind distanceM partial
            traversalFrom { lat lon } traversalTo { lat lon }
            traversalDirection geometryStatus geometrySource coordinates { lat lon }
            vertexGapM geometryStartToTraversalFromGapM geometryEndToTraversalToGapM
            gapFromPreviousGeometryM geometryLengthM
          }
        }
      }
    } }
  }
}`;

export type OtpWalkIdentityResponse =
  | { status: "received"; data: unknown }
  | {
      status: "unavailable";
      reason:
        "invalid_budget" | "deadline_exceeded" | "timeout" | "transport_error";
    };

/** Fetch a fresh request identity even when OTP has no route to return. */
export async function fetchOtpWalkIdentityResponse(options: {
  deadlineMs: number;
}): Promise<OtpWalkIdentityResponse> {
  return fetchOtpWalkResponse({ ...options, query: OTP_WALK_IDENTITY_QUERY });
}

export async function fetchOtpWalkPlanResponse(options: {
  deadlineMs: number;
  origin: { lat: number; lng: number };
  destination: { lat: number; lng: number };
  date: string;
  time: string;
  avoidStairs: boolean;
  profile: OtpDirectWalkProfile;
}): Promise<OtpWalkIdentityResponse> {
  return fetchOtpWalkResponse({
    deadlineMs: options.deadlineMs,
    query: OTP_WALK_PLAN_QUERY,
    variables: {
      fromLat: options.origin.lat,
      fromLon: options.origin.lng,
      toLat: options.destination.lat,
      toLon: options.destination.lng,
      date: options.date,
      time: options.time,
      stairs: options.profile !== "NORMAL" || options.avoidStairs ? 12 : 1,
      profile: options.profile,
      wheelchair: options.profile !== "NORMAL",
      speed:
        options.profile === "NORMAL"
          ? WALK_SPEED_MPS.normal
          : WALK_SPEED_MPS.wheelchair,
    },
  });
}

async function fetchOtpWalkResponse(options: {
  deadlineMs: number;
  query: string;
  variables?: Record<string, string | number | boolean>;
}): Promise<OtpWalkIdentityResponse> {
  const timeoutMs = Number(process.env.OTP_TIMEOUT_MS ?? 30_000);
  if (
    !Number.isFinite(options.deadlineMs) ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > 2_147_483_647
  )
    return { status: "unavailable", reason: "invalid_budget" };
  const startedAt = Date.now();
  if (options.deadlineMs <= startedAt)
    return { status: "unavailable", reason: "deadline_exceeded" };
  const timeoutAt = startedAt + timeoutMs;
  const expiresAt = Math.min(options.deadlineMs, timeoutAt);
  const expired: OtpWalkIdentityResponse = {
    status: "unavailable",
    reason: options.deadlineMs <= timeoutAt ? "deadline_exceeded" : "timeout",
  };
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  try {
    const work = async (): Promise<OtpWalkIdentityResponse> => {
      const baseUrl = process.env.OTP_BASE_URL ?? "http://localhost:8080";
      const response = await axios.post<unknown>(
        `${baseUrl.replace(/\/$/, "")}/otp/routers/default/index/graphql`,
        {
          query: options.query,
          ...(options.variables ? { variables: options.variables } : {}),
        },
        {
          signal: controller.signal,
          timeout: Math.max(1, Math.floor(expiresAt - Date.now())),
          maxRedirects: 0,
        },
      );
      return Date.now() >= expiresAt
        ? expired
        : { status: "received", data: response.data };
    };
    return await Promise.race([
      work(),
      new Promise<OtpWalkIdentityResponse>((resolve) => {
        timer = setTimeout(
          () => {
            controller.abort();
            resolve(expired);
          },
          Math.max(0, expiresAt - Date.now()),
        );
        timer.unref?.();
      }),
    ]);
  } catch (error: unknown) {
    if (
      controller.signal.aborted ||
      Date.now() >= expiresAt ||
      (axios.isAxiosError(error) &&
        (error.code === "ECONNABORTED" || error.code === "ETIMEDOUT"))
    ) {
      controller.abort();
      return expired;
    }
    return { status: "unavailable", reason: "transport_error" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
