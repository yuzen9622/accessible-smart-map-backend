import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getReviewedOtpWalkPolicies } from "../../../config/otp-walk";
import { otpWalkStairsNativeResponses as recorded } from "../../../../tests/fixtures/otp-walk-stairs-native";
import {
  fetchOtpWalkIdentityResponse,
  fetchOtpWalkPlanResponse,
} from "../../../adapters/otp-walk.adapter";
import { readCurrentSidewalkSourceIdentity } from "./pedestrian-a11y/sidewalk-source.repository";
import { hasCurrentOtpWalkingPolicy } from "../otp-walking-policy.service";
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

const identity = recorded.stairs_strict.data.requestIdentity;
const departure =
  recorded.stairs_strict.data.plan.directWalkSearch.departureTimeMs;
const points = [
  { lat: 25, lng: 121.0002 },
  { lat: 25, lng: 121.0028 },
  { lat: 25, lng: 121.0058 },
];
const options = (): QualifiedOtpWalkOptions => ({
  points,
  mode: "wheelchair",
  avoidStairs: true,
  departureTimeMs: departure,
  deadlineMs: Date.now() + 10000,
});
function queue(...raw: unknown[]) {
  for (const data of raw)
    vi.mocked(fetchOtpWalkPlanResponse).mockResolvedValueOnce({
      status: "received",
      data: structuredClone(data),
    });
}
function queueMixedRoute() {
  queue(
    recorded.stairs_strict,
    recorded.clear_strict,
    recorded.stairs_assisted,
    recorded.clear_strict_after_assisted,
  );
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(departure);
  const {
    artifactSha256,
    manifestSha256,
    observedClassDigestSha256,
    classCount,
  } = identity.runtimePolicyIdentity;
  vi.mocked(getReviewedOtpWalkPolicies).mockReturnValue([
    { artifactSha256, manifestSha256, observedClassDigestSha256, classCount },
  ]);
  vi.mocked(fetchOtpWalkIdentityResponse).mockResolvedValue({
    status: "received",
    data: { data: { requestIdentity: identity } },
  });
  vi.mocked(readCurrentSidewalkSourceIdentity).mockResolvedValue({
    status: "ready",
    identity: {
      sourceVersionId: "fixture",
      sourceBatch: "fixture",
      archiveSha256: "f".repeat(64),
    },
  });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("wheelchair direct WALK native completion and assisted stairs", () => {
  it("completes all strict legs before assistance and repeats the next strict search at actual arrival", async () => {
    queueMixedRoute();
    const request = options();
    const result = await planQualifiedOtpWalk(request);
    if (result.status !== "ready") throw new Error(JSON.stringify(result));
    const calls = vi
      .mocked(fetchOtpWalkPlanResponse)
      .mock.calls.map(([call]) => call);
    expect(calls.map((call) => call.profile)).toEqual([
      "WHEELCHAIR_STRICT",
      "WHEELCHAIR_STRICT",
      "WHEELCHAIR_STAIRS_ASSISTED",
      "WHEELCHAIR_STRICT",
    ]);
    expect(calls.map((call) => call.deadlineMs)).toEqual(
      Array(4).fill(request.deadlineMs),
    );
    expect(calls[0]).toMatchObject({
      origin: points[0],
      destination: points[1],
      time: "10:00:00",
    });
    expect(calls[1]).toMatchObject({
      origin: points[1],
      destination: points[2],
      time: "10:00:00",
    });
    expect(calls[2]).toMatchObject({
      origin: points[0],
      destination: points[1],
      time: "10:00:00",
    });
    const arrived =
      recorded.stairs_assisted.data.plan.itineraries[0].legs[0].endTime;
    expect(calls[3].time).not.toBe(calls[1].time);
    const policy = result.route.walkingPolicy;
    if (policy?.version !== "otp-sidewalk-v1")
      throw new Error("Missing OTP proof");
    expect(policy.mode).toBe("wheelchair");
    expect(policy.stairsFallback).toBe(true);
    expect(policy.segments[0].strictNoRoute).toEqual(
      recorded.stairs_strict.data.plan.directWalkSearch,
    );
    expect(policy.segments[1].strictNoRoute).toBeNull();
    expect(policy.segments[1].startTimeMs).toBe(arrived);
    expect(policy.segments[1].search.departureTimeMs).toBe(arrived);
    expect(
      result.route.legs.map((leg) => leg.walkingPolicy?.stairsFallback),
    ).toEqual([true, false]);
    expect(
      await hasCurrentOtpWalkingPolicy(
        JSON.parse(JSON.stringify(result.route)),
      ),
    ).toBe(true);
  });

  it("returns actual exhausted no-route without assistance when the caller disables fallback", async () => {
    queue(recorded.stairs_strict);
    expect(
      await planQualifiedOtpWalk({
        ...options(),
        points: points.slice(0, 2),
        allowStairsFallback: false,
      }),
    ).toEqual({ status: "no_route" });
    expect(fetchOtpWalkPlanResponse).toHaveBeenCalledTimes(1);
    expect(fetchOtpWalkIdentityResponse).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["TIMEOUT", "TIMEOUT", false],
    ["NOT_EXECUTED_LIMIT", "DISTANCE_LIMIT", false],
    ["INCOMPLETE", "EXHAUSTED", true],
  ])(
    "never enables stairs after %s",
    async (status, nativeOutcome, durationLimitPruned) => {
      const raw = structuredClone(recorded.stairs_strict);
      Object.assign(raw.data.plan.directWalkSearch, {
        status,
        nativeOutcome,
        durationLimitPruned,
      });
      queue(raw);
      expect((await planQualifiedOtpWalk(options())).status).toBe(
        "unavailable",
      );
      expect(fetchOtpWalkPlanResponse).toHaveBeenCalledTimes(1);
    },
  );

  it("does not reuse strict completion from another departure second", async () => {
    const raw = structuredClone(recorded.stairs_strict);
    raw.data.plan.directWalkSearch.departureTimeMs += 1000;
    queue(raw);
    expect((await planQualifiedOtpWalk(options())).status).toBe("unavailable");
    expect(fetchOtpWalkPlanResponse).toHaveBeenCalledTimes(1);
  });

  it("does not begin assistance when the total deadline expires during strict screening", async () => {
    const request = options();
    queue(recorded.stairs_strict);
    vi.mocked(fetchOtpWalkPlanResponse).mockImplementationOnce(async () => {
      vi.setSystemTime(request.deadlineMs);
      return { status: "received", data: recorded.clear_strict };
    });
    expect(await planQualifiedOtpWalk(request)).toEqual({
      status: "unavailable",
      reason: "deadline_exceeded",
    });
    expect(fetchOtpWalkPlanResponse).toHaveBeenCalledTimes(2);
  });

  it.each([
    "strict timestamp",
    "route flag",
    "clear leg flag",
    "route mode",
    "leg stairs observation",
  ])(
    "rejects serialized assistance with corrupt %s before fetching current identity",
    async (kind) => {
      queueMixedRoute();
      const result = await planQualifiedOtpWalk(options());
      if (result.status !== "ready") throw new Error(JSON.stringify(result));
      const route = result.route;
      const policy = route.walkingPolicy;
      const first = route.legs[0].walkingPolicy;
      const clear = route.legs[1].walkingPolicy;
      if (
        policy?.version !== "otp-sidewalk-v1" ||
        first?.version !== "otp-sidewalk-v1" ||
        clear?.version !== "otp-sidewalk-v1"
      )
        throw new Error("Missing OTP proof");
      if (kind === "strict timestamp") {
        const proof = first.segments[0].strictNoRoute;
        if (!proof) throw new Error("Missing strict proof");
        proof.departureTimeMs++;
      }
      if (kind === "route flag") policy.stairsFallback = false;
      if (kind === "clear leg flag") clear.stairsFallback = true;
      if (kind === "route mode") policy.mode = "normal";
      if (kind === "leg stairs observation")
        first.segments[0].evidence.edges[2].policyEvaluation.assistedStairs = false;
      vi.mocked(fetchOtpWalkIdentityResponse).mockClear();
      expect(await hasCurrentOtpWalkingPolicy(route)).toBe(false);
      expect(fetchOtpWalkIdentityResponse).not.toHaveBeenCalled();
    },
  );
});
