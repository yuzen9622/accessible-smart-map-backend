import { beforeEach, describe, expect, it, vi } from "vitest";
const redis = vi.hoisted(() => ({
  values: new Map<string, string>(),
  get: vi.fn(),
  store: vi.fn(),
}));
vi.mock("../../config/redis", () => ({ redisGet: redis.get }));
vi.mock(
  "../accessible-route/navigation-state.repository",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../accessible-route/navigation-state.repository")
    >()),
    navigationTokenKey: (token: string) => token,
    storeInitialNavigationEnvelope: redis.store,
  }),
);
vi.mock("../accessible-route/bus-plan.repository", () => ({
  storeBusPlan: vi.fn(),
}));
vi.mock("../accessible-route/planners/pedestrian-a11y/graph-runtime", () => ({
  isPedGraphSnapshotCurrent: vi.fn(async () => true),
  getPedGraphRuntime: vi.fn(async () => ({
    status: "ready",
    snapshot: { graph: { versionId: 7, qualification: sourcePolicy } },
  })),
}));
const sourcePolicy = {
  version: "sidewalk-v1" as const,
  schemaVersion: 1 as const,
  sourceVersionId: "1",
  sourceArchiveSha256: "a".repeat(64),
  osmSha256: "b".repeat(64),
  extent: [118, 21, 123, 27] as const,
};
const walkingPolicy = {
  ...sourcePolicy,
  graphVersionId: 7,
  mode: "normal" as const,
  avoidStairs: false,
  stairsFallback: false,
  selectedEdgeIds: ["701"],
};
import { attachRouteTokens } from "../accessible-route/route-token.service";
import {
  generateNavInstructionsFromInput,
  generateNavInstructions,
} from "./nav-instructions.service";
import type {
  AccessibleRoute,
  BusLeg,
  MetroLeg,
  ThsrLeg,
  TraLeg,
  WalkLeg,
  WalkStepStreetName,
} from "../../types/route";
const bus: BusLeg = {
  type: "BUS",
  routeName: "公車",
  subRouteName: "支線",
  subRouteUid: "TPE1",
  departureStop: "同名站",
  arrivalStop: "終站",
  fromNameEn: "Bus Origin",
  toNameEn: "Bus Destination",
  routeNameEn: "Source Bus",
  fromDisplayName: "should not trust",
  waitInfo: { time: 0, source: "unavailable" },
  direction: 0,
  polyline: [],
  departureStopA11y: [],
  arrivalStopA11y: [],
};
const metro: MetroLeg = {
  type: "METRO",
  railSystem: "TRTC",
  lineId: "R",
  lineUid: "TRTC-R",
  lineName: "紅線",
  departureStation: "同名站",
  arrivalStation: "終站",
  departureStationUid: "TRTC1",
  arrivalStationUid: "TRTC2",
  fromNameEn: "Metro Origin",
  toNameEn: "Metro Destination",
  routeNameEn: "Source Line",
  direction: 0,
  stopsCount: 1,
  rideMinutes: 3,
  waitInfo: { time: 0, source: "unavailable" },
  polyline: [],
  departureStationA11y: [],
  arrivalStationA11y: [],
  facilityHighlights: [],
};
const rail = (type: "TRA" | "THSR"): TraLeg | ThsrLeg => ({
  type,
  trainNo: "123",
  trainTypeName: "車種",
  departureStation: "同名站",
  arrivalStation: "終站",
  departureStationUID: "1",
  arrivalStationUID: "2",
  fromNameEn: `${type} Origin`,
  toNameEn: `${type} Destination`,
  departureTime: "10:00",
  arrivalTime: "10:10",
  rideMinutes: 10,
  waitInfo: { time: 0, source: "schedule" },
  polyline: [],
  departureStationA11y: [],
  arrivalStationA11y: [],
  facilityHighlights: [],
});
const walk: WalkLeg = {
  type: "WALK",
  from: "起點",
  to: "终點",
  toNameEn: "Walk Destination",
  distanceM: 70,
  minutesEst: 2,
  durationS: 120,
  walkingPolicy,
  polyline: [
    [121, 25],
    [121.001, 25],
  ],
  a11yFacilities: [],
  maxSlopePercent: null,
  crossings: null,
  crossingsWithCurbRamp: null,
  minPathWidthCm: null,
  surfaceType: "unknown",
  restPoints: [],
  steps: [
    {
      relativeDirection: "DEPART",
      absoluteDirection: "EAST",
      streetName: "中山路",
      bogusName: false,
      area: false,
      stairs: false,
      steepSlope: false,
      distanceM: 70,
      location: [121, 25],
    },
  ],
  stepStreetNames: [
    {
      index: 0,
      streetName: "中山路",
      nameEn: "Source Road",
      displayName: "saved unrelated",
    },
  ],
};
const sample: AccessibleRoute = {
  routeId: "source",
  routeName: "原始",
  totalMinutes: 30,
  transferCount: 3,
  accessibilityHighlights: [],
  legs: [walk, bus, metro, rail("TRA"), rail("THSR")],
  walkingPolicy,
};
const canonicalRequest = {
  origin: { latitude: 25, longitude: 121 },
  destination: { latitude: 25.1, longitude: 121.1 },
  userLocation: { latitude: 25, longitude: 121 },
  travelMode: "transit" as const,
  mode: "normal" as const,
  maxTransfers: 4,
  format: "standard" as const,
  waypoints: [],
  avoidStairs: false,
  requireElevator: false,
  needsAccessibleToilet: false,
  needsHandrail: false,
};
beforeEach(() => {
  vi.clearAllMocks();
  redis.values.clear();
  redis.get.mockImplementation(
    async (key: string) => redis.values.get(key) ?? null,
  );
  redis.store.mockImplementation(async (key: string, value: unknown) => {
    redis.values.set(key, JSON.stringify(value));
    return true;
  });
});
function text(
  result: Awaited<ReturnType<typeof generateNavInstructionsFromInput>>,
) {
  expect(result.ok).toBe(true);
  return result.ok ? result.data.instructions.map((s) => s.text).join(" ") : "";
}

describe("saved source names in real token navigation", () => {
  it("same token renders two languages with no planner or source I/O and unchanged saved route", async () => {
    const [saved] = await attachRouteTokens([sample], canonicalRequest);
    const before = redis.values.get(saved.routeToken!);
    const [en, zh] = await Promise.all([
      generateNavInstructionsFromInput({
        routeToken: saved.routeToken!,
        language: "en",
      }),
      generateNavInstructionsFromInput({
        routeToken: saved.routeToken!,
        language: "zh-TW",
      }),
    ]);
    for (const name of [
      "Source Road",
      "Source Bus",
      "Bus Origin",
      "Bus Destination",
      "Source Line",
      "Metro Origin",
      "Metro Destination",
      "TRA Origin",
      "TRA Destination",
      "THSR Origin",
      "THSR Destination",
    ])
      expect(text(en)).toContain(name);
    for (const name of ["中山路", "公車", "同名站", "終站", "紅線", "車種"])
      expect(text(zh)).toContain(name);
    expect(text(en)).not.toContain("should not trust");
    expect(text(en)).not.toContain("saved unrelated");
    expect(redis.values.get(saved.routeToken!)).toBe(before);
    expect(redis.store).toHaveBeenCalledTimes(1);
    if (en.ok && zh.ok)
      expect(en.data.instructions.map(({ text: _t, ...s }) => s)).toEqual(
        zh.data.instructions.map(({ text: _t, ...s }) => s),
      );
    expect(Object.keys(walk.steps![0])).toHaveLength(9);
  });
  it("sealed routes missing optional source names retain original canonical names", async () => {
    const old = structuredClone(sample);
    for (const leg of old.legs) {
      for (const key of [
        "fromNameEn",
        "toNameEn",
        "routeNameEn",
        "fromDisplayName",
        "toDisplayName",
        "routeDisplayName",
        "stepStreetNames",
      ])
        delete (leg as unknown as Record<string, unknown>)[key];
    }
    const [saved] = await attachRouteTokens([old], canonicalRequest);
    const routeToken = saved.routeToken;
    if (!routeToken) throw new Error("Trusted fixture was not persisted");
    expect(
      text(
        await generateNavInstructionsFromInput({
          routeToken,
          language: "en",
        }),
      ),
    ).toContain("中山路");
    expect(
      text(
        await generateNavInstructionsFromInput({
          routeToken,
          language: "en",
        }),
      ),
    ).toContain("同名站");
  });
  it("rejects a legacy WALK token without routing-policy evidence", async () => {
    const unqualified = structuredClone(sample);
    delete unqualified.walkingPolicy;
    for (const leg of unqualified.legs) {
      if (leg.type === "WALK") delete leg.walkingPolicy;
    }
    redis.values.set("unqualified", JSON.stringify(unqualified));
    const result = await generateNavInstructionsFromInput({
      routeToken: "unqualified",
      language: "en",
    });
    expect(result.ok).toBe(false);
    expect(redis.store).not.toHaveBeenCalled();
  });
  it.each([
    [{ index: 1, streetName: "中山路", nameEn: "wrong", displayName: "wrong" }],
    [{ index: 0, streetName: "錯路", nameEn: "wrong", displayName: "wrong" }],
    [walk.stepStreetNames![0], walk.stepStreetNames![0]],
    [{ index: 0, streetName: "中山路", nameEn: "   ", displayName: "wrong" }],
  ])(
    "rejects invalid sources at consumption even on externally restored snapshots: %j",
    (...entries) => {
      const leg = { ...walk, stepStreetNames: entries as WalkStepStreetName[] };
      const en = generateNavInstructions({ legs: [leg] }, undefined, "en");
      expect(text(en)).toContain("中山路");
      expect(text(en)).not.toContain("wrong");
    },
  );
  it("walk leg fallback uses saved endpoint sources without translated machine steps", () => {
    expect(
      text(
        generateNavInstructions(
          { legs: [{ ...walk, steps: undefined }] },
          undefined,
          "en",
        ),
      ),
    ).toContain("Walk Destination");
  });
});
