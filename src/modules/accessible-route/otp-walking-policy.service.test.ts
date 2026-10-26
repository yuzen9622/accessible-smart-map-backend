import { beforeEach, describe, expect, it, vi } from "vitest";
import { otpWalkNativeResponses } from "../../../tests/fixtures/otp-walk-native";
import {
  fetchOtpWalkIdentityResponse,
  fetchOtpWalkPlanResponse,
} from "../../adapters/otp-walk.adapter";
import type { AccessibleRoute } from "../../types/route";
import { getReviewedOtpWalkPolicies } from "../../config/otp-walk";
import { readCurrentSidewalkSourceIdentity } from "./planners/pedestrian-a11y/sidewalk-source.repository";
import { getPedGraphRuntime } from "./planners/pedestrian-a11y/graph-runtime";
import { planQualifiedOtpWalk } from "./planners/otp-walk-planner";
import { hasCurrentWalkingPolicy } from "./walking-policy.service";
import { getCurrentOtpWalkingIdentity } from "./otp-walking-policy.service";

vi.mock("../../config/otp-walk", () => ({
  getReviewedOtpWalkPolicies: vi.fn(),
}));
vi.mock("../../adapters/otp-walk.adapter", () => ({
  fetchOtpWalkIdentityResponse: vi.fn(),
  fetchOtpWalkPlanResponse: vi.fn(),
}));
vi.mock("./planners/pedestrian-a11y/sidewalk-source.repository", () => ({
  readCurrentSidewalkSourceIdentity: vi.fn(),
}));
vi.mock("./planners/pedestrian-a11y/graph-runtime", () => ({
  getPedGraphRuntime: vi.fn(() => {
    throw new Error("OTP currentness must not load CSR");
  }),
}));

const recorded = otpWalkNativeResponses.forward;
const nativeIdentity = recorded.data.requestIdentity;
const source = {
  sourceVersionId: nativeIdentity.buildManifestIdentity.sourceVersion,
  sourceBatch: nativeIdentity.buildManifestIdentity.sourceBatch,
  archiveSha256: nativeIdentity.buildManifestIdentity.sourceArchiveSha256,
};
const nativeLeg = recorded.data.plan.itineraries[0].legs[0];

async function plannedRoute(): Promise<AccessibleRoute> {
  const result = await planQualifiedOtpWalk({
    mode: "normal",
    points: [
      { lat: nativeLeg.from.lat, lng: nativeLeg.from.lon },
      { lat: nativeLeg.to.lat, lng: nativeLeg.to.lon },
    ],
    departureTimeMs: nativeLeg.startTime,
    deadlineMs: Date.now() + 5000,
    avoidStairs: true,
  });
  if (result.status !== "ready") throw new Error(result.status);
  return result.route;
}

beforeEach(() => {
  vi.resetAllMocks();
  const {
    artifactSha256,
    manifestSha256,
    observedClassDigestSha256,
    classCount,
  } = nativeIdentity.runtimePolicyIdentity;
  vi.mocked(getReviewedOtpWalkPolicies).mockReturnValue([
    { artifactSha256, manifestSha256, observedClassDigestSha256, classCount },
  ]);
  vi.mocked(readCurrentSidewalkSourceIdentity).mockResolvedValue({
    status: "ready",
    identity: source,
  });
  vi.mocked(fetchOtpWalkIdentityResponse).mockResolvedValue({
    status: "received",
    data: { data: { requestIdentity: nativeIdentity } },
  });
  vi.mocked(fetchOtpWalkPlanResponse).mockResolvedValue({
    status: "received",
    data: recorded,
  });
});

describe("native OTP walking proof currentness", () => {
  it("revalidates serialized native geometry and fresh identities without CSR", async () => {
    const route = await plannedRoute();
    const serialized: AccessibleRoute = JSON.parse(JSON.stringify(route));
    vi.mocked(fetchOtpWalkIdentityResponse).mockClear();
    vi.mocked(readCurrentSidewalkSourceIdentity).mockClear();
    expect(await hasCurrentWalkingPolicy(serialized)).toBe(true);
    expect(await hasCurrentWalkingPolicy(serialized)).toBe(true);
    expect(fetchOtpWalkIdentityResponse).toHaveBeenCalledTimes(2);
    expect(readCurrentSidewalkSourceIdentity).toHaveBeenCalledTimes(4);
    expect(getPedGraphRuntime).not.toHaveBeenCalled();
  });

  it("rejects a source retired during the current identity HTTP request", async () => {
    vi.mocked(readCurrentSidewalkSourceIdentity)
      .mockResolvedValueOnce({ status: "ready", identity: source })
      .mockResolvedValueOnce({
        status: "ready",
        identity: { ...source, sourceVersionId: "new" },
      });
    expect(await getCurrentOtpWalkingIdentity(Date.now() + 5000)).toEqual({
      status: "unavailable",
      reason: "source_mismatch",
    });
  });

  it.each(["source", "graph", "runtime", "unavailable"])(
    "rejects cached proof when the current %s changes",
    async (kind) => {
      const route = await plannedRoute();
      if (kind === "source") {
        vi.mocked(readCurrentSidewalkSourceIdentity).mockResolvedValue({
          status: "ready",
          identity: { ...source, archiveSha256: "a".repeat(64) },
        });
      } else if (kind === "unavailable") {
        vi.mocked(fetchOtpWalkIdentityResponse).mockResolvedValue({
          status: "unavailable",
          reason: "timeout",
        });
      } else {
        const changed = structuredClone(nativeIdentity);
        if (kind === "graph") {
          changed.graphByteIdentity.sha256 = "a".repeat(64);
          changed.buildManifestIdentity.graphSha256 = "a".repeat(64);
        } else {
          changed.runtimePolicyIdentity.artifactSha256 = "a".repeat(64);
        }
        vi.mocked(fetchOtpWalkIdentityResponse).mockResolvedValue({
          status: "received",
          data: { data: { requestIdentity: changed } },
        });
      }
      expect(await hasCurrentWalkingPolicy(route)).toBe(false);
    },
  );

  const corruptions: [string, (route: AccessibleRoute) => void][] = [
    [
      "public geometry",
      (route) => {
        route.legs[0].polyline[0][0] += 0.00001;
      },
    ],
    [
      "total distance",
      (route) => {
        route.totalWalkDistanceM = 1;
      },
    ],
    [
      "arrival clock",
      (route) => {
        route.arrivalTime = route.departureTime;
      },
    ],
    [
      "rounded duration",
      (route) => {
        route.totalMinutes += 1;
      },
    ],
    [
      "per-leg duration",
      (route) => {
        const leg = route.legs[0];
        if (leg.type === "WALK") leg.durationS = 1;
      },
    ],
    [
      "missing route segment",
      (route) => {
        if (route.walkingPolicy?.version === "otp-sidewalk-v1")
          route.walkingPolicy.segments = [];
      },
    ],
    [
      "unfulfilled walking access",
      (route) => {
        route._walkAccessRequests = [
          {
            beforeLegIndex: 0,
            role: "origin",
            from: "origin",
            to: "road",
            fromAnchor: { lat: 25, lng: 121 },
            toAnchor: { lat: 25, lng: 121.01 },
          },
        ];
      },
    ],
  ];
  it.each(corruptions)(
    "rejects %s inconsistent with selected native segments",
    async (_name, corrupt) => {
      const route = await plannedRoute();
      corrupt(route);
      vi.mocked(fetchOtpWalkIdentityResponse).mockClear();
      expect(await hasCurrentWalkingPolicy(route)).toBe(false);
      expect(fetchOtpWalkIdentityResponse).not.toHaveBeenCalled();
    },
  );
});
