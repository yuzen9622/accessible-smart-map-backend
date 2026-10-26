import express from "express";
import request from "supertest";
import axios, { AxiosHeaders } from "axios";
import { z } from "zod";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { getReviewedOtpWalkPolicies } from "../../config/otp-walk";
import { otpWalkStairsNativeResponses } from "../../../tests/fixtures/otp-walk-stairs-native";
import { otpWalkNativeResponses } from "../../../tests/fixtures/otp-walk-native";
import endpointRefusals from "../../../tests/fixtures/otp-walk-endpoint-refusal-native.json";
import currentEndpointRefusal from "../../../tests/fixtures/otp-walk-endpoint-refusal-current-native.json";
import waypointRefusal from "../../../tests/fixtures/otp-walk-endpoint-waypoint-native.json";

const io = vi.hoisted(() => ({
  cache: new Map<string, string>(),
  redisEval: vi.fn(),
  graphRuntime: vi.fn(),
  csrPlan: vi.fn(),
  valhallaPlan: vi.fn(),
}));
vi.mock("../../config/otp-walk", () => ({
  getReviewedOtpWalkPolicies: vi.fn(),
}));
vi.mock("../../config/redis", () => ({
  redisReady: vi.fn(async () => {}),
  redisClient: { status: "ready", eval: io.redisEval },
  redisGet: vi.fn(async (key: string) => io.cache.get(key) ?? null),
  redisSet: vi.fn(async () => true),
}));
vi.mock("./planners/pedestrian-a11y/graph-runtime", () => ({
  getPedGraphRuntime: io.graphRuntime,
  peekPedGraphSnapshot: () => null,
  getPedGraphClient: vi.fn(async () => {
    throw new Error("Unexpected CSR connection");
  }),
}));
vi.mock("./planners/pedestrian-a11y/csr-walk-planner", () => ({
  planCsrWalkRoute: io.csrPlan,
}));
vi.mock("./planners/valhalla-routing", () => ({
  planValhallaRoute: io.valhallaPlan,
  ValhallaRoutingError: class extends Error {},
}));
vi.mock("./planners/pedestrian-a11y/sidewalk-source.repository", () => ({
  readCurrentSidewalkSourceIdentity: vi.fn(),
}));
vi.mock("./route-display-enrichment.repository", () => ({
  lookupRouteNameSources: vi.fn(async () => ({
    busStops: new Map(),
    busRoutes: new Map(),
    metroStations: new Map(),
    trainStations: new Map(),
  })),
  trainNameKey: (system: string, id: string) => `${system}:${id}`,
}));
vi.mock("../../adapters/google.adapter", () => ({
  getCity: vi.fn(async () => null),
  getCoordinates: vi.fn(),
}));
vi.mock("../../adapters/nlsc.adapter", () => ({
  getNlscAdministrativeArea: vi.fn(async () => null),
}));
vi.mock("../../adapters/terrain-elevation.adapter", () => ({
  sampleTerrain: vi.fn(async () => ({ ok: false, reason: "data_unavailable" })),
}));
vi.mock("../a11y/a11y.orchestration", () => ({
  findNearby: vi.fn(async () => ({ nearbyOsm: [] })),
}));
vi.mock("../a11y/a11y.service", () => ({
  findNearbyParking: vi.fn(async () => []),
  findParkArrivalCandidates: vi.fn(async () => ({
    containingParks: [],
    nearbyEntrances: [],
    parksWithArea: [],
  })),
  findEntrancesOfParks: vi.fn(async () => []),
}));
vi.mock("../hazard-report/hazard-report.service", () => ({
  findConfirmedHazardsWithin: vi.fn(async () => []),
}));
vi.mock("../transit/metro.service", () => ({
  getMetroAlerts: vi.fn(async () => []),
}));
vi.mock("../transit/alert.service", () => ({
  getTransitAlerts: vi.fn(async () => ({ ok: true, alerts: [] })),
}));
vi.mock("../environment/environment.service", () => ({
  getWeatherAndAirQuality: vi.fn(async () => ({})),
}));

import { createAccessibleRouteRouter } from "./accessible-route.router";
import {
  AccessibleRouteResponseSchema,
  RouteFailureDataSchema,
} from "./accessible-route.schema";
import {
  getNavigationEnvelopeByToken,
  resolveNavigationEnvelope,
} from "./route-token.service";
import { navigationTokenKey } from "./navigation-state.repository";
import { readCurrentSidewalkSourceIdentity } from "./planners/pedestrian-a11y/sidewalk-source.repository";

const post = vi.spyOn(axios, "post");
const requestPayload = z.object({
  query: z.string(),
  variables: z.record(z.string(), z.unknown()).optional(),
});
type GraphqlRequest = z.infer<typeof requestPayload>;
const requests: GraphqlRequest[] = [];
let plans: unknown[] = [];
let currentIdentity = structuredClone(
  otpWalkNativeResponses.forward.data.requestIdentity,
);
const startedAt =
  otpWalkNativeResponses.forward.data.plan.itineraries[0].legs[0].startTime;
const app = express();
app.use(express.json());
app.use("/api/v1/a11y", createAccessibleRouteRouter());
const body = () => ({
  travelMode: "walk",
  mode: "normal",
  avoidStairs: true,
  origin: { latitude: 25.0000001, longitude: 121.0034567 },
  destination: { latitude: 25.0000001, longitude: 121.0154321 },
});
async function plan(extra: Record<string, unknown> = {}) {
  return request(app)
    .post("/api/v1/a11y/accessible-route")
    .send({ ...body(), ...extra });
}
function noFallback() {
  expect(io.graphRuntime).not.toHaveBeenCalled();
  expect(io.csrPlan).not.toHaveBeenCalled();
  expect(io.valhallaPlan).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(startedAt);
  currentIdentity = structuredClone(
    otpWalkNativeResponses.forward.data.requestIdentity,
  );
  requests.length = 0;
  plans = [];
  io.cache.clear();
  const runtime = currentIdentity.runtimePolicyIdentity;
  vi.mocked(getReviewedOtpWalkPolicies).mockReturnValue([
    {
      artifactSha256: runtime.artifactSha256,
      manifestSha256: runtime.manifestSha256,
      observedClassDigestSha256: runtime.observedClassDigestSha256,
      classCount: runtime.classCount,
    },
  ]);
  io.graphRuntime.mockRejectedValue(new Error("CSR unavailable"));
  io.csrPlan.mockRejectedValue(new Error("CSR planner must not run"));
  io.valhallaPlan.mockRejectedValue(new Error("Valhalla must not run"));
  io.redisEval.mockImplementation(
    async (
      _script: unknown,
      _keys: unknown,
      key: unknown,
      _head: unknown,
      value: unknown,
    ) => {
      io.cache.set(z.string().parse(key), z.string().parse(value));
      return 1;
    },
  );
  vi.mocked(readCurrentSidewalkSourceIdentity).mockResolvedValue({
    status: "ready",
    identity: {
      sourceVersionId: "fixture",
      sourceBatch: "fixture",
      archiveSha256: "f".repeat(64),
    },
  });
  post.mockImplementation(async (_url, raw: unknown) => {
    const payload = requestPayload.parse(raw);
    requests.push(payload);
    const data = payload.variables
      ? (plans.shift() ?? structuredClone(otpWalkNativeResponses.forward))
      : { data: { requestIdentity: structuredClone(currentIdentity) } };
    return {
      data,
      status: 200,
      statusText: "OK",
      headers: {},
      config: { headers: new AxiosHeaders() },
    };
  });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("native OTP through the public WALK entry", () => {
  it("returns the final point of a captured waypoint refusal without issuing a partial-route token", async () => {
    const first = waypointRefusal.cases[0];
    const second = waypointRefusal.cases[1];
    currentIdentity = structuredClone(first.response.data.requestIdentity);
    vi.setSystemTime(first.response.data.plan.directWalkSearch.departureTimeMs);
    const runtime = currentIdentity.runtimePolicyIdentity;
    vi.mocked(getReviewedOtpWalkPolicies).mockReturnValue([
      {
        artifactSha256: runtime.artifactSha256,
        manifestSha256: runtime.manifestSha256,
        observedClassDigestSha256: runtime.observedClassDigestSha256,
        classCount: runtime.classCount,
      },
    ]);
    const manifest = currentIdentity.buildManifestIdentity;
    vi.mocked(readCurrentSidewalkSourceIdentity).mockResolvedValue({
      status: "ready",
      identity: {
        sourceVersionId: manifest.sourceVersion,
        sourceBatch: manifest.sourceBatch,
        archiveSha256: manifest.sourceArchiveSha256,
      },
    });
    plans.push(
      structuredClone(first.response),
      structuredClone(second.response),
    );
    const [origin, via, destination] = waypointRefusal.chain.coordinates.map(
      (point) => ({
        latitude: point.lat,
        longitude: point.lon,
      }),
    );
    const response = await plan({
      mode: "wheelchair",
      format: "compact",
      origin,
      destination,
      waypoints: [via],
    });
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(response.body.message).toBe(
      "目前圖資無法將指定位置連接到符合輪椅通行條件的路網，請調整位置",
    );
    expect(RouteFailureDataSchema.parse(response.body.data)).toEqual({
      reason: "ENDPOINT_CONSTRAINT_BLOCKED",
      endpointConstraint: { pointIndex: 2, reasons: ["KNOWN_WIDTH"] },
    });
    expect(
      requests
        .filter((entry) => entry.variables)
        .map((entry) => entry.variables?.time),
    ).toEqual(["18:00:07", "18:00:20"]);
    expect(requests.filter((entry) => !entry.variables)).toHaveLength(2);
    expect(readCurrentSidewalkSourceIdentity).toHaveBeenCalledTimes(4);
    expect(io.cache.size).toBe(0);
    noFallback();
  });

  const strictRefusals = endpointRefusals.cases.filter(
    (row) =>
      row.response.data.plan.directWalkSearch.status ===
        "ENDPOINT_CONSTRAINT_BLOCKED" &&
      row.response.data.plan.directWalkSearch.executedPolicy.profile ===
        "WHEELCHAIR_STRICT",
  );
  it("uses the bundled reviewed policy for a captured native refusal without deployment configuration", async () => {
    const actual = await vi.importActual<
      typeof import("../../config/otp-walk")
    >("../../config/otp-walk");
    vi.mocked(getReviewedOtpWalkPolicies).mockImplementation(
      actual.getReviewedOtpWalkPolicies,
    );
    const row = currentEndpointRefusal;
    const proof = row.response.data.plan.directWalkSearch;
    const constraint = proof.endpointConstraint;
    if (!constraint) throw new Error("Missing captured constraint");
    currentIdentity = structuredClone(row.response.data.requestIdentity);
    vi.setSystemTime(proof.departureTimeMs);
    const manifest = currentIdentity.buildManifestIdentity;
    vi.mocked(readCurrentSidewalkSourceIdentity).mockResolvedValue({
      status: "ready",
      identity: {
        sourceVersionId: manifest.sourceVersion,
        sourceBatch: manifest.sourceBatch,
        archiveSha256: manifest.sourceArchiveSha256,
      },
    });
    plans.push(structuredClone(row.response));
    const response = await plan({
      mode: "wheelchair",
      origin: { latitude: proof.fromLat, longitude: proof.fromLon },
      destination: { latitude: proof.toLat, longitude: proof.toLon },
    });
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(RouteFailureDataSchema.parse(response.body.data)).toEqual({
      reason: "ENDPOINT_CONSTRAINT_BLOCKED",
      endpointConstraint: {
        pointIndex: constraint.endpoint === "FROM" ? 0 : 1,
        reasons: constraint.reasons,
      },
    });
    expect(requests.filter((entry) => entry.variables)).toHaveLength(1);
    expect(io.cache.size).toBe(0);
    noFallback();
  });
  it.each(strictRefusals)(
    "returns an explained 422 for captured $case without an unsafe fallback",
    async (row) => {
      const proof = row.response.data.plan.directWalkSearch;
      const constraint = proof.endpointConstraint;
      if (!constraint) throw new Error("Missing captured constraint");
      currentIdentity = structuredClone(row.response.data.requestIdentity);
      vi.setSystemTime(proof.departureTimeMs);
      const runtime = currentIdentity.runtimePolicyIdentity;
      vi.mocked(getReviewedOtpWalkPolicies).mockReturnValue([
        {
          artifactSha256: runtime.artifactSha256,
          manifestSha256: runtime.manifestSha256,
          observedClassDigestSha256: runtime.observedClassDigestSha256,
          classCount: runtime.classCount,
        },
      ]);
      const manifest = currentIdentity.buildManifestIdentity;
      vi.mocked(readCurrentSidewalkSourceIdentity).mockResolvedValue({
        status: "ready",
        identity: {
          sourceVersionId: manifest.sourceVersion,
          sourceBatch: manifest.sourceBatch,
          archiveSha256: manifest.sourceArchiveSha256,
        },
      });
      plans.push(structuredClone(row.response));
      const response = await plan({
        mode: "wheelchair",
        language: "en",
        origin: { latitude: proof.fromLat, longitude: proof.fromLon },
        destination: { latitude: proof.toLat, longitude: proof.toLon },
      });
      expect(response.status, JSON.stringify(response.body)).toBe(422);
      expect(response.body.message).toBe(
        "The available map cannot connect the specified location to a route meeting wheelchair access limits. Please adjust the location.",
      );
      expect(RouteFailureDataSchema.parse(response.body.data)).toEqual({
        reason: "ENDPOINT_CONSTRAINT_BLOCKED",
        endpointConstraint: {
          pointIndex: constraint.endpoint === "FROM" ? 0 : 1,
          reasons: constraint.reasons,
        },
      });
      expect(requests.filter((entry) => entry.variables)).toHaveLength(1);
      expect(requests.filter((entry) => !entry.variables)).toHaveLength(2);
      expect(readCurrentSidewalkSourceIdentity).toHaveBeenCalledTimes(4);
      expect(io.cache.size).toBe(0);
      noFallback();
    },
  );

  it.each(["standard", "compact"])(
    "preserves native evidence through %s response and real token resolution without CSR",
    async (format) => {
      const response = await plan({ format, maxSlopePercent: 3 });
      expect(response.status).toBe(200);
      const value: unknown = response.body;
      const parsed = AccessibleRouteResponseSchema.parse(value);
      const data = parsed.data;
      if (!data) throw new Error("Missing route data");
      const route = data.routes[0];
      expect(route.engine).toBe("otp");
      expect(route.walkingPolicy?.version).toBe("otp-sidewalk-v1");
      if (route.walkingPolicy?.version !== "otp-sidewalk-v1")
        throw new Error("Missing native policy");
      const native =
        otpWalkNativeResponses.forward.data.plan.itineraries[0].legs[0]
          .walkEvidence;
      expect(route.walkingPolicy.segments[0].evidence).toEqual(native);
      expect(route.walkingPolicy.identity).toEqual(currentIdentity);
      expect(route.legs[0].polyline).toEqual(
        native.selectedPath.occurrences.flatMap((part) =>
          part.coordinates.map((p) => [p.lon, p.lat]),
        ),
      );
      expect(data.slopeConstraint).toMatchObject({
        requestedMaxPercent: 3,
        enforced: false,
      });
      expect(route.walkingPolicy.mode).toBe("normal");
      const outbound = requests.find((entry) => entry.variables);
      expect(outbound?.variables).toMatchObject({ stairs: 12 });
      expect(outbound?.variables).toMatchObject({
        profile: "NORMAL",
        wheelchair: false,
        speed: 1.3,
      });
      const token = route.routeToken;
      if (!token) throw new Error("No navigation token stored");
      const serialized = io.cache.get(navigationTokenKey(token));
      if (!serialized) throw new Error("No Redis envelope");
      const stored: unknown = JSON.parse(serialized);
      const resolved = await resolveNavigationEnvelope(stored);
      expect(resolved?.route.walkingPolicy).toEqual(route.walkingPolicy);
      expect(await getNavigationEnvelopeByToken(token)).not.toBeNull();
      noFallback();
    },
  );

  it.each(["source", "graph", "runtime"])(
    "rejects a previously issued token after %s changes",
    async (change) => {
      const response = await plan();
      expect(response.status).toBe(200);
      const value: unknown = response.body;
      const token =
        AccessibleRouteResponseSchema.parse(value).data?.routes[0].routeToken;
      if (!token) throw new Error("No token");
      expect(await getNavigationEnvelopeByToken(token)).not.toBeNull();
      if (change === "source")
        vi.mocked(readCurrentSidewalkSourceIdentity).mockResolvedValue({
          status: "unavailable",
          reason: "no_active_source",
        });
      if (change === "graph") {
        currentIdentity.graphByteIdentity.sha256 = "a".repeat(64);
        currentIdentity.buildManifestIdentity.graphSha256 = "a".repeat(64);
      }
      if (change === "runtime")
        currentIdentity.runtimePolicyIdentity.artifactSha256 = "a".repeat(64);
      expect(await getNavigationEnvelopeByToken(token)).toBeNull();
      noFallback();
    },
  );

  it("returns 422 for verified no-route and 503 for an unavailable provider without fallback", async () => {
    const empty = structuredClone(otpWalkNativeResponses.disconnected);
    plans.push(empty);
    const noRouteResponse = await plan({
      origin: { latitude: 25, longitude: 121.001 },
      destination: { latitude: 25.01001, longitude: 121.0005 },
    });
    expect(noRouteResponse.status, JSON.stringify(noRouteResponse.body)).toBe(
      422,
    );
    post.mockRejectedValueOnce(new Error("OTP unreachable"));
    expect((await plan()).status).toBe(503);
    expect(io.cache.size).toBe(0);
    noFallback();
  });

  it("retains waypoint segment order, repeated source evidence and second-accurate timing through compact normalization", async () => {
    const forward = structuredClone(otpWalkNativeResponses.forward);
    const reverse = structuredClone(otpWalkNativeResponses.reverse);
    const first = forward.data.plan.itineraries[0].legs[0];
    const next = reverse.data.plan.itineraries[0].legs[0];
    reverse.data.plan.directWalkSearch.departureTimeMs = first.endTime;
    next.startTime = first.endTime;
    next.endTime = next.startTime + next.duration * 1000;
    plans.push(forward, reverse);
    const response = await plan({
      format: "compact",
      destination: body().origin,
      waypoints: [body().destination],
    });
    expect(response.status).toBe(200);
    const value: unknown = response.body;
    const route = AccessibleRouteResponseSchema.parse(value).data?.routes[0];
    if (!route || route.walkingPolicy?.version !== "otp-sidewalk-v1")
      throw new Error("Missing native route");
    expect(route.walkingPolicy.segments).toHaveLength(2);
    expect(
      route.walkingPolicy.segments.map(
        (segment) => segment.evidence.edges[2].sourceRefs,
      ),
    ).toEqual([["fixture-0"], ["fixture-0"]]);
    expect(
      requests
        .filter((entry) => entry.variables)
        .map((entry) => entry.variables?.time),
    ).toEqual(["10:00:00", "10:15:29"]);
    expect(route.arrivalTime).toBe("2026-10-26T10:30:58.000+08:00");
    if (!route.routeToken) throw new Error("Missing token");
    expect(await getNavigationEnvelopeByToken(route.routeToken)).not.toBeNull();
    noFallback();
  });
  it.each(["standard", "compact"])(
    "qualifies native wheelchair strict evidence and tokens through %s",
    async (format) => {
      plans.push(structuredClone(otpWalkNativeResponses.wheelchair));
      const response = await plan({
        format,
        mode: "wheelchair",
        maxSlopePercent: 3,
      });
      expect(response.status).toBe(200);
      const value: unknown = response.body;
      const data = AccessibleRouteResponseSchema.parse(value).data;
      const route = data?.routes[0];
      if (
        !route ||
        route.walkingPolicy?.version !== "otp-sidewalk-v1" ||
        !route.routeToken
      )
        throw new Error("Missing native route");
      expect(route.walkingPolicy.mode).toBe("wheelchair");
      expect(route.walkingPolicy.stairsFallback).toBe(false);
      expect(route.walkingPolicy.segments[0].evidence).toEqual(
        otpWalkNativeResponses.wheelchair.data.plan.itineraries[0].legs[0]
          .walkEvidence,
      );
      expect(
        requests.find((entry) => entry.variables)?.variables,
      ).toMatchObject({
        profile: "WHEELCHAIR_STRICT",
        wheelchair: true,
        speed: 0.8,
        stairs: 12,
      });
      expect(data?.slopeConstraint).toMatchObject({
        requestedMaxPercent: 3,
        enforced: false,
      });
      expect(
        await getNavigationEnvelopeByToken(route.routeToken),
      ).not.toBeNull();
      noFallback();
    },
  );

  it.each(["standard", "compact"])(
    "retains assisted stairs warnings, per-leg flags and native proof through %s",
    async (format) => {
      currentIdentity = structuredClone(
        otpWalkStairsNativeResponses.stairs_strict.data.requestIdentity,
      );
      plans.push(
        ...[
          otpWalkStairsNativeResponses.stairs_strict,
          otpWalkStairsNativeResponses.clear_strict,
          otpWalkStairsNativeResponses.stairs_assisted,
          otpWalkStairsNativeResponses.clear_strict_after_assisted,
        ].map((raw) => structuredClone(raw)),
      );
      const response = await plan({
        format,
        mode: "wheelchair",
        origin: { latitude: 25, longitude: 121.0002 },
        destination: { latitude: 25, longitude: 121.0058 },
        waypoints: [{ latitude: 25, longitude: 121.0028 }],
      });
      expect(response.status).toBe(200);
      const value: unknown = response.body;
      const route = AccessibleRouteResponseSchema.parse(value).data?.routes[0];
      if (
        !route ||
        route.walkingPolicy?.version !== "otp-sidewalk-v1" ||
        !route.routeToken
      )
        throw new Error("Missing native route");
      expect(route.walkingPolicy.stairsFallback).toBe(true);
      expect(
        route.legs.map((leg) =>
          leg.type === "WALK" ? leg.walkingPolicy?.stairsFallback : null,
        ),
      ).toEqual([true, false]);
      expect(route.accessibilityLabel).toBe("critical");
      expect(route.warningDetails).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "ROUTE_WHEELCHAIR_STAIRS_FALLBACK" }),
        ]),
      );
      expect(
        await getNavigationEnvelopeByToken(route.routeToken),
      ).not.toBeNull();
      noFallback();
    },
  );
});
