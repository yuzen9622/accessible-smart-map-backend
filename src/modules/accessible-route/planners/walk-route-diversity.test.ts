import { describe, expect, it } from "vitest";
import type { AccessibleRoute, WalkLeg } from "../../../types/route";
import { selectDiverseWalkRoutes } from "./walk-route-diversity";

const LON_METRES = 111_195 * Math.cos((25 * Math.PI) / 180);
const LAT_METRES = 111_195;
type Point = [number, number];
const at = (x: number, y: number): Point => [
  121.5 + x / LON_METRES,
  25 + y / LAT_METRES,
];

function route(id: string, points: Point[], blocking = 0): AccessibleRoute {
  const leg: WalkLeg = {
    type: "WALK",
    from: "A",
    to: "B",
    distanceM: 400,
    minutesEst: 10,
    polyline: points,
    a11yFacilities: [],
    maxSlopePercent: null,
    crossings: null,
    crossingsWithCurbRamp: null,
    minPathWidthCm: null,
    surfaceType: "unknown",
    restPoints: [],
  };
  return {
    routeId: id,
    routeName: "步行",
    totalMinutes: 10,
    transferCount: 0,
    legs: [leg],
    accessibilityHighlights: [],
    hazardAdvisory: {
      onRoute: [],
      avoided: [],
      blockingOnRoute: blocking,
      penaltyPoints: blocking,
    },
  };
}

const names = (routes: AccessibleRoute[]) =>
  routes.map((candidate) => candidate.routeId);
const baseline = () => route("primary", [at(0, 0), at(400, 0)]);
const minorDetour = () =>
  route("small-detour", [
    at(0, 0),
    at(160, 0),
    at(160, 8),
    at(190, 8),
    at(190, 0),
    at(400, 0),
  ]);
const largeDetour = () =>
  route("large-detour", [
    at(0, 0),
    at(80, 0),
    at(80, 30),
    at(320, 30),
    at(320, 0),
    at(400, 0),
  ]);

function alternative(
  id: string,
  section: "none" | "left" | "right",
  blocking = 0,
) {
  const points: Point[] = [at(0, 0), at(100, 0), at(100, 20)];
  if (section === "left") {
    points.push(at(200, 20), at(200, 30), at(400, 30), at(400, 20));
  }
  if (section === "right") {
    points.push(at(600, 20), at(600, 30), at(800, 30), at(800, 20));
  }
  points.push(at(900, 20), at(900, 0), at(1000, 0));
  return route(id, points, blocking);
}

describe("selectDiverseWalkRoutes", () => {
  it("drops a short detour when most of both paths overlap", () => {
    expect(
      names(
        selectDiverseWalkRoutes([baseline(), minorDetour(), largeDetour()]),
      ),
    ).toEqual(["primary", "large-detour"]);
  });

  it("filters routes with around 80% overlap and keeps one with around 60%", () => {
    const mostlyShared = route("eighty", [
      at(0, 0),
      at(140, 0),
      at(140, 8),
      at(220, 8),
      at(220, 0),
      at(400, 0),
    ]);
    const substantiallyDifferent = route("sixty", [
      at(0, 0),
      at(110, 0),
      at(110, 8),
      at(270, 8),
      at(270, 0),
      at(400, 0),
    ]);
    expect(
      names(
        selectDiverseWalkRoutes([
          baseline(),
          mostlyShared,
          substantiallyDifferent,
        ]),
      ),
    ).toEqual(["primary", "sixty"]);
  });

  it("treats different sampling densities on the same path as overlapping", () => {
    const sampled = route(
      "sampled",
      Array.from({ length: 41 }, (_, i) => at(i * 10, 0)),
    );
    expect(names(selectDiverseWalkRoutes([baseline(), sampled]))).toEqual([
      "primary",
    ]);
  });

  it("rejects a pair when the shorter route shares around 90% and the longer around 60%", () => {
    const longer = route("longer", [
      at(0, 0),
      at(180, 0),
      at(180, 100),
      at(220, 100),
      at(220, 0),
      at(400, 0),
    ]);
    expect(names(selectDiverseWalkRoutes([baseline(), longer]))).toEqual([
      "primary",
    ]);
  });

  it("keeps two routes when both share around 74% of their length", () => {
    const upper = route("upper", [
      at(0, 0),
      at(155.5, 0),
      at(155.5, 10),
      at(244.5, 10),
      at(244.5, 0),
      at(400, 0),
    ]);
    const lower = route("lower", [
      at(0, 0),
      at(155.5, 0),
      at(155.5, -10),
      at(244.5, -10),
      at(244.5, 0),
      at(400, 0),
    ]);
    expect(names(selectDiverseWalkRoutes([upper, lower]))).toEqual([
      "upper",
      "lower",
    ]);
  });

  it("retains the safer ranked route when a similar route has a blocking hazard", () => {
    const safe = baseline();
    const blocked = minorDetour();
    if (blocked.hazardAdvisory) {
      blocked.hazardAdvisory.blockingOnRoute = 1;
      blocked.hazardAdvisory.penaltyPoints = 1;
    }
    expect(names(selectDiverseWalkRoutes([safe, blocked]))).toEqual([
      "primary",
    ]);
  });

  it("does not collapse distinct nearby parallel paths four metres apart", () => {
    const parallel = route("parallel", [at(0, 4), at(400, 4)]);
    expect(names(selectDiverseWalkRoutes([baseline(), parallel]))).toEqual([
      "primary",
      "parallel",
    ]);
  });

  it("groups opposite walkways when browsing different road corridors", () => {
    const first = baseline();
    const parallel = route("parallel", [at(0, 40), at(400, 40)]);
    const otherRoad = route("other-road", [
      at(0, 0),
      at(0, 100),
      at(400, 100),
      at(400, 0),
    ]);
    for (const [candidate, streetName] of [
      [first, "甲路"],
      [parallel, "甲路人行道"],
      [otherRoad, "乙路"],
    ] as const) {
      const leg = candidate.legs[0];
      if (leg.type === "WALK")
        leg.steps = [
          {
            streetName,
            distanceM: 400,
            location: leg.polyline![0],
            stairs: false,
            steepSlope: false,
            bogusName: false,
            area: false,
            relativeDirection: "CONTINUE",
            absoluteDirection: "NORTH",
          },
        ];
    }
    expect(
      names(selectDiverseWalkRoutes([first, parallel, otherRoad], true)),
    ).toEqual(["primary", "other-road"]);
    const nearbyDifferentStreet = structuredClone(otherRoad);
    nearbyDifferentStreet.routeId = "nearby-different-street";
    nearbyDifferentStreet.legs[0].polyline = [at(0, 4), at(400, 4)];
    expect(
      names(selectDiverseWalkRoutes([first, nearbyDifferentStreet], true)),
    ).toEqual(["primary", "nearby-different-street"]);
    expect(
      selectDiverseWalkRoutes(
        [first, route("unknown", [at(0, 200), at(400, 200)])],
        true,
      ),
    ).toEqual([first]);
  });

  it("does not confuse a route reference with a different street or discard a partly unnamed corridor", () => {
    const east = baseline();
    const sameRoad = route("same-road", [at(0, 40), at(400, 40)]);
    const west = route("west", [
      at(0, 0),
      at(0, -100),
      at(400, -100),
      at(400, 0),
    ]);
    const streetSets: [AccessibleRoute, [string, number][]][] = [
      [
        east,
        [
          ["新生南路二段", 200],
          ["5", 200],
        ],
      ],
      [
        sameRoad,
        [
          ["新生南路一段", 100],
          ["新生南路三段", 100],
          ["忠孝東路二段", 200],
        ],
      ],
      [
        west,
        [
          ["泰順街", 80],
          ["新生南路二段", 5],
        ],
      ],
    ];
    for (const [candidate, streets] of streetSets) {
      const leg = candidate.legs[0];
      if (leg.type === "WALK")
        leg.steps = streets.map(([streetName, distanceM]) => ({
          streetName,
          distanceM,
          location: leg.polyline[0],
          stairs: false,
          steepSlope: false,
          bogusName: false,
          area: false,
          relativeDirection: "CONTINUE",
          absoluteDirection: "NORTH",
        }));
    }
    expect(
      names(selectDiverseWalkRoutes([east, sameRoad, west], true)),
    ).toEqual(["primary", "west"]);
  });

  it("preserves a short route when no other candidate is available", () => {
    const short = route("short", [at(0, 0), at(5, 0)]);
    expect(selectDiverseWalkRoutes([short])).toEqual([short]);
    expect(selectDiverseWalkRoutes([])).toEqual([]);
  });

  it("treats shared waypoint legs as part of one complete walking path", () => {
    const first = baseline();
    const split = route("split", [at(0, 0), at(200, 0)]);
    split.legs.push(...route("rest", [at(200, 0), at(400, 0)]).legs);
    expect(names(selectDiverseWalkRoutes([first, split]))).toEqual(["primary"]);
  });

  it("does not present unknown or disconnected geometry as a distinct route", () => {
    const unknown = route("unknown", []);
    const disconnected = route("disconnected", [at(0, 0), at(100, 0)]);
    disconnected.legs.push(...route("gap", [at(102, 0), at(400, 0)]).legs);
    expect(
      names(
        selectDiverseWalkRoutes([
          baseline(),
          unknown,
          disconnected,
          largeDetour(),
        ]),
      ),
    ).toEqual(["primary", "large-detour"]);
    expect(names(selectDiverseWalkRoutes([unknown, baseline()]))).toEqual([
      "unknown",
    ]);
  });

  it("finds a pair of diverse candidates when the earlier candidate overlaps both", () => {
    const first = route("primary", [at(0, 0), at(1000, 0)]);
    const candidates = [
      first,
      alternative("middle", "none"),
      alternative("left", "left"),
      alternative("right", "right"),
    ];
    expect(names(selectDiverseWalkRoutes(candidates))).toEqual([
      "primary",
      "left",
      "right",
    ]);
  });

  it("compares the second and third routes against each other", () => {
    const first = route("primary", [at(0, 0), at(1000, 0)]);
    const firstAlternative = alternative("first-alt", "none");
    const similarAlternative = alternative("similar-alt", "left");
    expect(
      names(
        selectDiverseWalkRoutes([first, firstAlternative, similarAlternative]),
      ),
    ).toEqual(["primary", "first-alt"]);
  });

  it("does not treat geometry exceeding the bounded comparison budget as proof of diversity", () => {
    const tooLong = route("too-long", [at(0, 20), at(32_004, 20)]);
    const tooMany = route(
      "too-many",
      Array.from({ length: 12_001 }, (_, i) => at(i / 100, 20)),
    );
    expect(
      names(
        selectDiverseWalkRoutes([baseline(), tooLong, tooMany, largeDetour()]),
      ),
    ).toEqual(["primary", "large-detour"]);
    expect(names(selectDiverseWalkRoutes([tooLong, baseline()]))).toEqual([
      "too-long",
    ]);
  });

  it("preserves a safer candidate instead of filling slots with more blocked routes", () => {
    const first = route("primary", [at(0, 0), at(1000, 0)]);
    const candidates = [
      first,
      alternative("safe", "none"),
      alternative("blocked-left", "left", 1),
      alternative("blocked-right", "right", 1),
    ];
    expect(names(selectDiverseWalkRoutes(candidates))).toEqual([
      "primary",
      "safe",
    ]);
  });

  it("retains ranked order when several equally safe combinations are valid", () => {
    const first = route("primary", [at(0, 0), at(400, 0)]);
    const one = route("one", [at(0, 0), at(100, 40), at(300, 40), at(400, 0)]);
    const two = route("two", [
      at(0, 0),
      at(100, -40),
      at(300, -40),
      at(400, 0),
    ]);
    const three = route("three", [
      at(0, 0),
      at(100, 80),
      at(300, 80),
      at(400, 0),
    ]);
    expect(names(selectDiverseWalkRoutes([first, one, two, three]))).toEqual([
      "primary",
      "one",
      "two",
    ]);
  });
});
