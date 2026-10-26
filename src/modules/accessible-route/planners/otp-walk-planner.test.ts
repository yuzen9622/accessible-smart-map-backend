import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { getReviewedOtpWalkPolicies } from "../../../config/otp-walk";
import {
  fetchOtpWalkIdentityResponse,
  fetchOtpWalkPlanResponse,
} from "../../../adapters/otp-walk.adapter";
import { readCurrentSidewalkSourceIdentity } from "./pedestrian-a11y/sidewalk-source.repository";
import { loadPedGraph } from "./pedestrian-a11y/graph-loader";
import {
  planQualifiedOtpWalk,
  type QualifiedOtpWalkOptions,
} from "./otp-walk-planner";

vi.mock("../../../config/otp-walk", () => ({
  getReviewedOtpWalkPolicies: vi.fn(),
}));
vi.mock("../../../adapters/otp-walk.adapter", () => ({
  fetchOtpWalkIdentityResponse: vi.fn(),
  fetchOtpWalkPlanResponse: vi.fn(),
}));
vi.mock("./pedestrian-a11y/sidewalk-source.repository", () => ({
  readCurrentSidewalkSourceIdentity: vi.fn(),
}));
vi.mock("./pedestrian-a11y/graph-loader", () => ({
  loadPedGraph: vi.fn(() => {
    throw new Error("CSR must not be loaded");
  }),
}));

import { otpWalkNativeResponses as recorded } from "../../../../tests/fixtures/otp-walk-native";

const identity = recorded.forward.data.requestIdentity;
const rawLeg = recorded.forward.data.plan.itineraries[0].legs[0];
const startedAt = rawLeg.startTime;
const options = (): QualifiedOtpWalkOptions => ({
  mode: "normal",
  points: [
    { lat: 25.0000001, lng: 121.0034567 },
    { lat: 25.0000001, lng: 121.0154321 },
  ],
  avoidStairs: true,
  departureTimeMs: startedAt + 789,
  deadlineMs: Date.now() + 10_000,
});
const identityResponse = () => ({
  status: "received",
  data: { data: { requestIdentity: structuredClone(identity) } },
});
function freshResponse() {
  return structuredClone(recorded.forward);
}
function retime(response: typeof recorded.forward, time: number) {
  const leg = response.data.plan.itineraries[0].legs[0];
  response.data.plan.directWalkSearch.departureTimeMs = time;
  leg.startTime = time;
  leg.endTime = time + leg.duration * 1000;
  return response;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(startedAt - 1000);
  vi.clearAllMocks();
  vi.mocked(getReviewedOtpWalkPolicies).mockReturnValue([
    {
      artifactSha256: identity.runtimePolicyIdentity.artifactSha256,
      manifestSha256: identity.runtimePolicyIdentity.manifestSha256,
      observedClassDigestSha256:
        identity.runtimePolicyIdentity.observedClassDigestSha256,
      classCount: identity.runtimePolicyIdentity.classCount,
    },
  ]);
  vi.mocked(readCurrentSidewalkSourceIdentity).mockResolvedValue({
    status: "ready",
    identity: {
      sourceVersionId: "fixture",
      sourceBatch: "fixture",
      archiveSha256: "f".repeat(64),
    },
  });
  vi.mocked(fetchOtpWalkIdentityResponse).mockImplementation(async () => {
    const response = identityResponse();
    return { status: "received", data: response.data };
  });
  vi.mocked(fetchOtpWalkPlanResponse).mockResolvedValue({
    status: "received",
    data: freshResponse(),
  });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("qualified OTP direct WALK planner", () => {
  it("replays a true native response with exact geometry, edge distance, schedule and unknown observations", async () => {
    const request = options();
    const result = await planQualifiedOtpWalk(request);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error(JSON.stringify(result));
    const route = result.route;
    expect(route.engine).toBe("otp");
    expect(route.legs).toHaveLength(1);
    const leg = route.legs[0];
    if (leg.type !== "WALK") throw new Error("Expected WALK");
    expect(leg.distanceM).toBeCloseTo(1206.848);
    expect(leg.distanceM).not.toBe(rawLeg.distance);
    expect(leg.durationS).toBe(929);
    expect(leg.polyline[0]).toEqual([121.0034567, 25]);
    expect(leg.maxSlopePercent).toBeNull();
    expect(leg.minPathWidthCm).toBeNull();
    expect(leg.surfaceType).toBe("unknown");
    expect(Object.getOwnPropertyDescriptor(leg, "_durationMs")).toMatchObject({
      value: 929000,
      enumerable: false,
    });
    expect(route.departureTime).toBe("2026-10-26T10:00:00.000+08:00");
    expect(route.arrivalTime).toBe("2026-10-26T10:15:29.000+08:00");
    expect(route._scheduledDepartureTime).toBe(startedAt);
    expect(route._scheduledEndTime).toBe(rawLeg.endTime);
    expect(Object.keys(route)).not.toContain("_scheduledEndTime");
    expect(route.walkingPolicy).toMatchObject({
      version: "otp-sidewalk-v1",
      mode: "normal",
      avoidStairs: true,
      stairsFallback: false,
      fareAccess: { mode: "forbid" },
      segments: [
        { durationS: 929, startTimeMs: startedAt, endTimeMs: rawLeg.endTime },
      ],
    });
    expect(fetchOtpWalkPlanResponse).toHaveBeenCalledWith({
      deadlineMs: request.deadlineMs,
      origin: request.points[0],
      destination: request.points[1],
      date: "2026-10-26",
      time: "10:00:00",
      avoidStairs: true,
      profile: "NORMAL",
    });
    expect(fetchOtpWalkIdentityResponse).toHaveBeenCalledTimes(2);
    expect(readCurrentSidewalkSourceIdentity).toHaveBeenCalledTimes(4);
    expect(loadPedGraph).not.toHaveBeenCalled();
  });

  it("preserves ordered waypoint legs and repeated source occurrences, advancing by native seconds", async () => {
    const request = options();
    request.points = [...request.points, request.points[0]];
    const reverse = retime(structuredClone(recorded.reverse), rawLeg.endTime);
    vi.mocked(fetchOtpWalkPlanResponse)
      .mockResolvedValueOnce({ status: "received", data: freshResponse() })
      .mockResolvedValueOnce({ status: "received", data: reverse });
    const result = await planQualifiedOtpWalk(request);
    if (result.status !== "ready") throw new Error(JSON.stringify(result));
    expect(
      result.route.legs.map((leg) => [
        leg.type === "WALK" ? leg.from : null,
        leg.type === "WALK" ? leg.to : null,
      ]),
    ).toEqual([
      ["起點", "中途點 1"],
      ["中途點 1", "終點"],
    ]);
    expect(fetchOtpWalkPlanResponse).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        origin: request.points[1],
        destination: request.points[2],
        time: "10:15:29",
        deadlineMs: request.deadlineMs,
      }),
    );
    const policy = result.route.walkingPolicy;
    if (policy?.version !== "otp-sidewalk-v1")
      throw new Error("Expected native policy");
    expect(policy.segments).toHaveLength(2);
    expect(policy.segments[0].evidence.edges[2].sourceRefs).toEqual([
      "fixture-0",
    ]);
    expect(policy.segments[1].evidence.edges[2].sourceRefs).toEqual([
      "fixture-0",
    ]);
    expect(result.route._scheduledEndTime).toBe(startedAt + 1858_000);
    expect(result.route.totalMinutes).toBe(31);
  });

  it("rejects finite per-leg distances whose whole-trip sum overflows", async () => {
    const request = options();
    request.points = [...request.points, request.points[0]];
    const forward = freshResponse();
    const reverse = retime(structuredClone(recorded.reverse), rawLeg.endTime);
    for (const response of [forward, reverse]) {
      const evidence = response.data.plan.itineraries[0].legs[0].walkEvidence;
      for (const occurrence of evidence.selectedPath.occurrences) {
        if (occurrence.geometryStatus === "PRESENT") {
          occurrence.distanceM = 3e307;
          evidence.edges[occurrence.occurrenceIndex].distanceM = 3e307;
        }
      }
    }
    vi.mocked(fetchOtpWalkPlanResponse)
      .mockResolvedValueOnce({ status: "received", data: forward })
      .mockResolvedValueOnce({ status: "received", data: reverse });
    expect(await planQualifiedOtpWalk(request)).toEqual({
      status: "unavailable",
      reason: "invalid_evidence",
    });
  });

  it("carries seconds and the Taipei date across midnight", async () => {
    const request = options();
    const night = Date.parse("2026-10-26T23:59:37+08:00");
    request.departureTimeMs = night + 321;
    request.points = [...request.points, request.points[0]];
    vi.mocked(fetchOtpWalkPlanResponse)
      .mockResolvedValueOnce({
        status: "received",
        data: retime(freshResponse(), night),
      })
      .mockResolvedValueOnce({
        status: "received",
        data: retime(structuredClone(recorded.reverse), night + 929000),
      });
    const result = await planQualifiedOtpWalk(request);
    expect(result.status).toBe("ready");
    expect(fetchOtpWalkPlanResponse).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ date: "2026-10-26", time: "23:59:37" }),
    );
    expect(fetchOtpWalkPlanResponse).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ date: "2026-10-27", time: "00:15:06" }),
    );
  });

  it.each([
    [
      "missing root",
      (raw: typeof recorded.forward) =>
        Object.assign(raw.data, { requestIdentity: null }),
    ],
    [
      "transit leg",
      (raw: typeof recorded.forward) =>
        (raw.data.plan.itineraries[0].legs[0].mode = "BUS"),
    ],
    [
      "multiple native legs",
      (raw: typeof recorded.forward) =>
        raw.data.plan.itineraries[0].legs.push(structuredClone(rawLeg)),
    ],
    [
      "multiple itineraries",
      (raw: typeof recorded.forward) =>
        raw.data.plan.itineraries.push(
          structuredClone(raw.data.plan.itineraries[0]),
        ),
    ],
    [
      "missing duration",
      (raw: typeof recorded.forward) =>
        Object.assign(raw.data.plan.itineraries[0].legs[0], {
          duration: undefined,
        }),
    ],
    [
      "missing evidence",
      (raw: typeof recorded.forward) =>
        Object.assign(raw.data.plan.itineraries[0].legs[0], {
          walkEvidence: null,
        }),
    ],
    [
      "unverified root",
      (raw: typeof recorded.forward) =>
        (raw.data.requestIdentity.runtimePolicyIdentityStatus = "UNVERIFIED"),
    ],
    [
      "unreviewed policy",
      (raw: typeof recorded.forward) =>
        (raw.data.requestIdentity.runtimePolicyIdentity.artifactSha256 =
          "a".repeat(64)),
    ],
    [
      "wrong source",
      (raw: typeof recorded.forward) =>
        (raw.data.requestIdentity.buildManifestIdentity.sourceBatch = "late"),
    ],
    [
      "leg geometry gap",
      (raw: typeof recorded.forward) =>
        (raw.data.plan.itineraries[0].legs[0].walkEvidence.selectedPath.occurrences[2].coordinates[0].lon += 0.001),
    ],
    [
      "request mismatch",
      (raw: typeof recorded.forward) =>
        (raw.data.plan.itineraries[0].legs[0].walkEvidence.selectedPath.requestFrom.lon += 0.001),
    ],
  ])("fails closed for %s", async (_name, mutate) => {
    const raw = freshResponse();
    mutate(raw);
    vi.mocked(fetchOtpWalkPlanResponse).mockResolvedValueOnce({
      status: "received",
      data: raw,
    });
    expect((await planQualifiedOtpWalk(options())).status).toBe("unavailable");
  });

  it.each([
    [
      "start second",
      (leg: typeof rawLeg) => {
        leg.startTime += 1000;
        leg.endTime += 1000;
      },
    ],
    ["duration", (leg: typeof rawLeg) => leg.duration++],
    [
      "negative clock",
      (leg: typeof rawLeg) => (leg.endTime = leg.startTime - 1000),
    ],
    [
      "subsecond",
      (leg: typeof rawLeg) => {
        leg.endTime += 500;
        leg.duration += 0.5;
      },
    ],
  ])(
    "rejects native %s disagreement instead of repairing timestamps",
    async (_name, mutate) => {
      const raw = freshResponse();
      mutate(raw.data.plan.itineraries[0].legs[0]);
      vi.mocked(fetchOtpWalkPlanResponse).mockResolvedValueOnce({
        status: "received",
        data: raw,
      });
      expect(await planQualifiedOtpWalk(options())).toEqual({
        status: "unavailable",
        reason: "time_mismatch",
      });
    },
  );

  it("rejects mixed identity across waypoint queries", async () => {
    const request = options();
    request.points = [...request.points, request.points[0]];
    const reverse = retime(structuredClone(recorded.reverse), rawLeg.endTime);
    reverse.data.requestIdentity.graphByteIdentity.sha256 = "a".repeat(64);
    reverse.data.requestIdentity.buildManifestIdentity.graphSha256 = "a".repeat(
      64,
    );
    vi.mocked(fetchOtpWalkPlanResponse)
      .mockResolvedValueOnce({ status: "received", data: freshResponse() })
      .mockResolvedValueOnce({ status: "received", data: reverse });
    expect(await planQualifiedOtpWalk(request)).toEqual({
      status: "unavailable",
      reason: "identity_changed",
    });
  });

  it.each(["ready", "no_route"])(
    "rejects a graph change before returning %s",
    async (outcome) => {
      const request = options();
      if (outcome === "no_route") {
        const raw = structuredClone(recorded.disconnected);
        request.points = [
          { lat: 25, lng: 121.001 },
          { lat: 25.01001, lng: 121.0005 },
        ];
        vi.mocked(fetchOtpWalkPlanResponse).mockResolvedValueOnce({
          status: "received",
          data: raw,
        });
      }
      const changed = identityResponse();
      changed.data.data.requestIdentity.graphByteIdentity.sha256 = "a".repeat(
        64,
      );
      changed.data.data.requestIdentity.buildManifestIdentity.graphSha256 =
        "a".repeat(64);
      vi.mocked(fetchOtpWalkIdentityResponse)
        .mockResolvedValueOnce({
          status: "received",
          data: identityResponse().data,
        })
        .mockResolvedValueOnce({ status: "received", data: changed.data });
      expect(await planQualifiedOtpWalk(request)).toEqual({
        status: "unavailable",
        reason: "identity_changed",
      });
    },
  );

  it("rejects source retirement before returning a planned route", async () => {
    vi.mocked(readCurrentSidewalkSourceIdentity)
      .mockResolvedValueOnce({
        status: "ready",
        identity: {
          sourceVersionId: "fixture",
          sourceBatch: "fixture",
          archiveSha256: "f".repeat(64),
        },
      })
      .mockResolvedValueOnce({
        status: "ready",
        identity: {
          sourceVersionId: "fixture",
          sourceBatch: "fixture",
          archiveSha256: "f".repeat(64),
        },
      })
      .mockResolvedValueOnce({
        status: "unavailable",
        reason: "no_active_source",
      });
    expect(await planQualifiedOtpWalk(options())).toEqual({
      status: "unavailable",
      reason: "source_mismatch",
    });
  });

  it("returns no_route only after validating the response identity and current identity again", async () => {
    const raw = structuredClone(recorded.disconnected);
    const request = options();
    request.points = [
      { lat: 25, lng: 121.001 },
      { lat: 25.01001, lng: 121.0005 },
    ];
    vi.mocked(fetchOtpWalkPlanResponse).mockResolvedValueOnce({
      status: "received",
      data: raw,
    });
    expect(await planQualifiedOtpWalk(request)).toEqual({
      status: "no_route",
    });
    expect(fetchOtpWalkIdentityResponse).toHaveBeenCalledTimes(2);
    expect(readCurrentSidewalkSourceIdentity).toHaveBeenCalledTimes(4);
  });

  it("treats GraphQL partial errors and provider errors as unavailable rather than no_route", async () => {
    vi.mocked(fetchOtpWalkPlanResponse).mockResolvedValueOnce({
      status: "received",
      data: { ...freshResponse(), errors: [{ message: "resolver failed" }] },
    });
    expect(await planQualifiedOtpWalk(options())).toEqual({
      status: "unavailable",
      reason: "graphql_error",
    });
    const raw = freshResponse();
    raw.data.plan.itineraries = [];
    Object.assign(raw.data.plan, { routingErrors: [{ code: "SYSTEM_ERROR" }] });
    vi.mocked(fetchOtpWalkPlanResponse).mockResolvedValueOnce({
      status: "received",
      data: raw,
    });
    expect(await planQualifiedOtpWalk(options())).toEqual({
      status: "unavailable",
      reason: "search_result_mismatch",
    });
  });

  it.each(["transport_error", "timeout"])(
    "preserves adapter %s failures",
    async (reason) => {
      const failure =
        reason === "timeout"
          ? { status: "unavailable", reason: "timeout" }
          : { status: "unavailable", reason: "transport_error" };
      if (reason === "timeout")
        vi.mocked(fetchOtpWalkPlanResponse).mockResolvedValueOnce({
          status: "unavailable",
          reason: "timeout",
        });
      else
        vi.mocked(fetchOtpWalkPlanResponse).mockResolvedValueOnce({
          status: "unavailable",
          reason: "transport_error",
        });
      expect(await planQualifiedOtpWalk(options())).toEqual(failure);
    },
  );

  it("does not reset the overall deadline between segments", async () => {
    const request = options();
    request.points = [...request.points, request.points[0]];
    vi.mocked(fetchOtpWalkPlanResponse).mockImplementationOnce(async () => {
      vi.setSystemTime(request.deadlineMs);
      return { status: "received", data: freshResponse() };
    });
    expect(await planQualifiedOtpWalk(request)).toEqual({
      status: "unavailable",
      reason: "deadline_exceeded",
    });
    expect(fetchOtpWalkPlanResponse).toHaveBeenCalledTimes(1);
  });

  it("rejects a late final currentness check", async () => {
    const request = options();
    vi.mocked(fetchOtpWalkIdentityResponse)
      .mockResolvedValueOnce({
        status: "received",
        data: identityResponse().data,
      })
      .mockImplementationOnce(async () => {
        vi.setSystemTime(request.deadlineMs);
        return { status: "received", data: identityResponse().data };
      });
    expect(await planQualifiedOtpWalk(request)).toEqual({
      status: "unavailable",
      reason: "deadline_exceeded",
    });
  });

  it("refuses invalid or expired input before I/O", async () => {
    const request = options();
    request.points = [];
    expect((await planQualifiedOtpWalk(request)).status).toBe("unavailable");
    expect(fetchOtpWalkIdentityResponse).not.toHaveBeenCalled();
    const expired = options();
    expired.deadlineMs = Date.now();
    expect(await planQualifiedOtpWalk(expired)).toEqual({
      status: "unavailable",
      reason: "deadline_exceeded",
    });
  });

  it("fails unavailable if trusted policy configuration is absent", async () => {
    vi.mocked(getReviewedOtpWalkPolicies).mockReturnValue([]);
    expect((await planQualifiedOtpWalk(options())).status).toBe("unavailable");
    expect(fetchOtpWalkPlanResponse).not.toHaveBeenCalled();
  });
});
