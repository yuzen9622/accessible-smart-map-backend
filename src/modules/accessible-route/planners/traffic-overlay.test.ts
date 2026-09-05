import { describe, expect, it } from "vitest";
import type { AccessibleRoute, DriveLeg } from "../../../types/route";
import type {
  LiveSection,
  RoadIncident,
  TrafficSectionGeometry,
} from "../../../types/traffic";
import { buildSegmentIndex } from "../../traffic/traffic-segment-index";
import {
  applyIncidentAdvisories,
  applyTrafficOverlay,
  bboxOfPoints,
  bboxOfPolyline,
  classifyIncident,
  deriveLegTraffic,
  matchSectionsToLeg,
  pickExcludeLocations,
  pointToSegmentMeters,
} from "./traffic-overlay";

describe("traffic-overlay", () => {
  describe("bboxOfPolyline and bboxOfPoints", () => {
    it("computes bbox for polyline correctly", () => {
      const coords: [number, number][] = [
        [121.5, 25.0],
        [121.6, 25.1],
        [121.4, 25.05],
      ];
      expect(bboxOfPolyline(coords)).toEqual([121.4, 25.0, 121.6, 25.1]);
    });

    it("returns zero bbox for empty coordinates", () => {
      expect(bboxOfPolyline([])).toEqual([0, 0, 0, 0]);
      expect(bboxOfPoints([])).toEqual([0, 0, 0, 0]);
    });

    it("computes padded bbox for LatLng points", () => {
      const points = [
        { lat: 25.0, lng: 121.5 },
        { lat: 25.1, lng: 121.6 },
      ];
      const bbox = bboxOfPoints(points, 0.01);
      expect(bbox[0]).toBeCloseTo(121.49);
      expect(bbox[1]).toBeCloseTo(24.99);
      expect(bbox[2]).toBeCloseTo(121.61);
      expect(bbox[3]).toBeCloseTo(25.11);
    });
  });

  describe("pointToSegmentMeters", () => {
    it("returns 0 for point lying on segment", () => {
      const a: [number, number] = [121.5, 25.0];
      const b: [number, number] = [121.6, 25.0];
      const p: [number, number] = [121.55, 25.0];
      expect(pointToSegmentMeters(p, a, b)).toBeCloseTo(0, 1);
    });

    it("returns distance to perpendicular projection when between endpoints", () => {
      const a: [number, number] = [121.5, 25.0];
      const b: [number, number] = [121.6, 25.0];
      // 0.001 deg north is approx 111.3 meters
      const p: [number, number] = [121.55, 25.001];
      const dist = pointToSegmentMeters(p, a, b);
      expect(dist).toBeGreaterThan(100);
      expect(dist).toBeLessThan(120);
    });

    it("returns distance to endpoint when beyond segment bounds", () => {
      const a: [number, number] = [121.5, 25.0];
      const b: [number, number] = [121.6, 25.0];
      const p: [number, number] = [121.49, 25.0];
      const dist = pointToSegmentMeters(p, a, b);
      expect(dist).toBeGreaterThan(1000);
    });
  });

  describe("matchSectionsToLeg", () => {
    const legPolyline: [number, number][] = [
      [121.52, 25.042],
      [121.523, 25.042],
      [121.526, 25.042],
      [121.53, 25.042],
    ];

    it("matches section overlapping closely with the route polyline", () => {
      const geometries: TrafficSectionGeometry[] = [
        {
          sectionId: "sec-1",
          city: "Taipei",
          geometry: {
            type: "LineString",
            coordinates: [
              [121.521, 25.042],
              [121.525, 25.042],
              [121.528, 25.042],
            ],
          },
        },
      ];
      const liveMap = new Map<string, LiveSection>([
        [
          "sec-1",
          {
            sectionId: "sec-1",
            congestionLevel: 1,
            speedKmh: 45,
          },
        ],
      ]);
      const index = buildSegmentIndex(geometries);
      const matched = matchSectionsToLeg(legPolyline, index, liveMap);

      expect(matched.length).toBe(1);
      expect(matched[0].sectionId).toBe("sec-1");
      expect(matched[0].congestionLevel).toBe(1);
      expect(matched[0].speedKmh).toBe(45);
      expect(matched[0].coveredM).toBeGreaterThan(0);
    });

    it("rejects parallel section that is 200m away", () => {
      // 0.002 deg lat difference is roughly 220 meters
      const geometries: TrafficSectionGeometry[] = [
        {
          sectionId: "sec-far",
          city: "Taipei",
          geometry: {
            type: "LineString",
            coordinates: [
              [121.521, 25.044],
              [121.525, 25.044],
            ],
          },
        },
      ];
      const index = buildSegmentIndex(geometries);
      const matched = matchSectionsToLeg(legPolyline, index, new Map());

      expect(matched.length).toBe(0);
    });

    it("rejects traffic derivation when section overlap is insufficient (< minCoverageRatio 0.25)", () => {
      // 16-segment polyline (each segment ~101m, total ~1611m)
      // With corridor matching, overlapping segment + 2 adjacent end-touching segments match (~302m).
      // Coverage ratio = ~302m / ~1611m ≈ 0.188 (< minCoverageRatio 0.25).
      const polyline: [number, number][] = [];
      for (let i = 0; i <= 16; i++) {
        polyline.push([121.52 + i * 0.001, 25.042]);
      }

      // Section only overlaps 1 segment (~101m) and the rest branches far north
      const geometries: TrafficSectionGeometry[] = [
        {
          sectionId: "sec-low-overlap",
          city: "Taipei",
          geometry: {
            type: "LineString",
            coordinates: [
              [121.521, 25.042],
              [121.522, 25.042],
              [121.522, 25.05],
              [121.523, 25.05],
              [121.524, 25.05],
              [121.525, 25.05],
              [121.526, 25.05],
              [121.527, 25.05],
              [121.528, 25.05],
              [121.529, 25.05],
              [121.53, 25.05],
            ],
          },
        },
      ];

      const legLengthM = 1600;
      const leg: DriveLeg = {
        type: "DRIVE",
        from: { lat: 25.042, lng: 121.52 },
        to: { lat: 25.042, lng: 121.536 },
        distanceM: legLengthM,
        durationMin: 3,
        polyline,
      };

      const liveMap = new Map<string, LiveSection>([
        [
          "sec-low-overlap",
          { sectionId: "sec-low-overlap", congestionLevel: 5 },
        ],
      ]);
      const index = buildSegmentIndex(geometries);
      const matched = matchSectionsToLeg(polyline, index, liveMap);

      expect(matched.length).toBe(1);
      expect(matched[0].coveredM).toBeLessThan(0.4 * legLengthM);

      const traffic = deriveLegTraffic(leg, matched);
      expect(traffic).toEqual({});
    });

    it("rejects cross-street perpendicular section", () => {
      const geometries: TrafficSectionGeometry[] = [
        {
          sectionId: "sec-cross",
          city: "Taipei",
          geometry: {
            type: "LineString",
            coordinates: [
              [121.525, 25.035],
              [121.525, 25.049],
            ],
          },
        },
      ];
      const index = buildSegmentIndex(geometries);
      const matched = matchSectionsToLeg(legPolyline, index, new Map());

      expect(matched.length).toBe(0);
    });
  });

  describe("deriveLegTraffic", () => {
    // 1km line (~0.01 deg lng at lat 25)
    const polyline: [number, number][] = [
      [121.52, 25.042],
      [121.53, 25.042],
    ];

    const baseLeg: DriveLeg = {
      type: "DRIVE",
      from: { lat: 25.042, lng: 121.52 },
      to: { lat: 25.042, lng: 121.53 },
      distanceM: 1000,
      durationMin: 2, // 120s free flow (~8.33 m/s = 30 km/h)
      polyline,
    };

    it("derives 'light' when traffic speed matches or exceeds free-flow", () => {
      const matched = [
        {
          sectionId: "sec-1",
          congestionLevel: 1 as const,
          speedKmh: 35,
          coveredM: 800,
        },
      ];

      const res = deriveLegTraffic(baseLeg, matched);
      expect(res.trafficLevel).toBe("light");
      expect(res.durationInTrafficMin).toBeDefined();
    });

    it("derives 'moderate' when ratio is between 1.15 and 1.50", () => {
      const matched = [
        {
          sectionId: "sec-slow",
          congestionLevel: 3 as const,
          speedKmh: 24,
          coveredM: 900,
        },
      ];

      const res = deriveLegTraffic(baseLeg, matched);
      expect(res.trafficLevel).toBe("moderate");
      expect(res.durationInTrafficMin).toBeGreaterThanOrEqual(2);
    });

    it("derives 'heavy' when ratio exceeds 1.50", () => {
      const matched = [
        {
          sectionId: "sec-jam",
          congestionLevel: 5 as const,
          speedKmh: 6,
          coveredM: 900,
        },
      ];

      const res = deriveLegTraffic(baseLeg, matched);
      expect(res.trafficLevel).toBe("heavy");
      expect(res.durationInTrafficMin).toBeGreaterThan(baseLeg.durationMin);
    });

    it("returns empty object when coverage is below 25%", () => {
      const matched = [
        {
          sectionId: "sec-tiny",
          congestionLevel: 1 as const,
          speedKmh: 30,
          coveredM: 100, // 10% of 1000m
        },
      ];

      const res = deriveLegTraffic(baseLeg, matched);
      expect(res).toEqual({});
    });

    it("returns empty object for degenerate leg with durationMin <= 0", () => {
      const degenerateLeg = { ...baseLeg, durationMin: 0 };
      const matched = [
        {
          sectionId: "sec-1",
          congestionLevel: 1 as const,
          speedKmh: 30,
          coveredM: 800,
        },
      ];

      expect(deriveLegTraffic(degenerateLeg, matched)).toEqual({});
    });
  });

  describe("classifyIncident", () => {
    it("classifies road closure keywords as 'closure'", () => {
      expect(
        classifyIncident({
          title: "和平東路雙向封閉施工",
          description: "禁止通行",
        }),
      ).toBe("closure");
      expect(
        classifyIncident({
          title: "道路積水中斷",
          description: "暫時管制通行",
        }),
      ).toBe("closure");
      expect(
        classifyIncident({ title: "前方封路", description: "車輛請改道" }),
      ).toBe("closure");
    });

    it("classifies accidents and construction as 'advisory'", () => {
      expect(
        classifyIncident({
          title: "內湖路擦撞事故",
          description: "佔用外側車道",
        }),
      ).toBe("advisory");
      expect(
        classifyIncident({ title: "道路局部施工", description: "減速慢行" }),
      ).toBe("advisory");
      expect(
        classifyIncident({ title: "不明事件", description: "未定義" }),
      ).toBe("advisory");
    });
  });

  describe("pickExcludeLocations", () => {
    it("truncates closures to max 50 and sorts by distance to origin/dest line", () => {
      const closures: RoadIncident[] = [];
      for (let i = 0; i < 60; i++) {
        closures.push({
          incidentId: `inc-${i}`,
          title: "道路封閉",
          severity: "closure",
          location: {
            lat: 25.04 + i * 0.001,
            lng: 121.52 + (i % 2 === 0 ? 0.0001 : 0.005),
          },
        });
      }

      const picked = pickExcludeLocations(
        closures,
        { lat: 25.04, lng: 121.52 },
        { lat: 25.1, lng: 121.52 },
      );

      expect(picked.length).toBe(50);
      expect(picked[0]).toHaveProperty("lat");
      expect(picked[0]).toHaveProperty("lng");
    });
  });

  describe("applyIncidentAdvisories", () => {
    it("attaches incident within 100m to the nearest leg", () => {
      const leg1: DriveLeg = {
        type: "DRIVE",
        from: { lat: 25.042, lng: 121.52 },
        to: { lat: 25.042, lng: 121.53 },
        distanceM: 1000,
        durationMin: 2,
        polyline: [
          [121.52, 25.042],
          [121.53, 25.042],
        ],
      };

      const route: AccessibleRoute = {
        routeId: "test-route-1",
        routeName: "測試路線",
        totalMinutes: 2,
        transferCount: 0,
        accessibilityHighlights: [],
        legs: [leg1],
      };

      // 0.0003 deg lat is approx 33m from the line
      const closeIncident: RoadIncident = {
        incidentId: "inc-close",
        title: "車禍",
        severity: "advisory",
        location: { lat: 25.0423, lng: 121.525 },
      };

      // 0.002 deg lat is approx 220m from the line
      const farIncident: RoadIncident = {
        incidentId: "inc-far",
        title: "施工",
        severity: "advisory",
        location: { lat: 25.044, lng: 121.525 },
      };

      applyIncidentAdvisories([route], [closeIncident, farIncident], 100);

      expect(leg1.incidents).toBeDefined();
      expect(leg1.incidents?.length).toBe(1);
      expect(leg1.incidents?.[0].incidentId).toBe("inc-close");
    });
  });

  describe("applyTrafficOverlay invariant protection", () => {
    it("absorbs the congestion delta into totalMinutes while leaving durationMin and polyline untouched", () => {
      const originalPolyline: [number, number][] = [
        [121.52, 25.042],
        [121.53, 25.042],
      ];

      const leg: DriveLeg = {
        type: "DRIVE",
        from: { lat: 25.042, lng: 121.52 },
        to: { lat: 25.042, lng: 121.53 },
        distanceM: 1000,
        durationMin: 2,
        polyline: [...originalPolyline],
      };

      const route: AccessibleRoute = {
        routeId: "test-route-2",
        routeName: "測試路線 2",
        totalMinutes: 2,
        transferCount: 0,
        accessibilityHighlights: [],
        legs: [leg],
      };

      const liveMap = new Map<string, LiveSection>();
      liveMap.set("sec-test", {
        sectionId: "sec-test",
        congestionLevel: 4,
        speedKmh: 12,
      });

      const geometries: TrafficSectionGeometry[] = [
        {
          sectionId: "sec-test",
          city: "Taipei",
          geometry: {
            type: "LineString",
            coordinates: [
              [121.522, 25.042],
              [121.528, 25.042],
            ],
          },
        },
      ];

      applyTrafficOverlay([route], liveMap, buildSegmentIndex(geometries));

      expect(leg.durationMin).toBe(2);
      expect(leg.polyline).toEqual(originalPolyline);

      expect(leg.durationInTrafficMin).toBeDefined();
      expect(leg.trafficLevel).toBeDefined();

      expect(route.totalMinutes).toBe(
        Math.max(1, Math.round(2 + (leg.durationInTrafficMin! - 2))),
      );
      expect(route.totalMinutes).toBe(leg.durationInTrafficMin);
      expect(route.totalMinutes).toBeGreaterThan(2);
    });

    it("shifts totalMinutes by the delta only, preserving non-drive time such as walk access legs", () => {
      const leg: DriveLeg = {
        type: "DRIVE",
        from: { lat: 25.042, lng: 121.52 },
        to: { lat: 25.042, lng: 121.53 },
        distanceM: 1000,
        durationMin: 2,
        polyline: [
          [121.52, 25.042],
          [121.53, 25.042],
        ],
      };

      const route: AccessibleRoute = {
        routeId: "test-route-walk-tail",
        routeName: "測試路線含步行銜接",
        totalMinutes: 10,
        transferCount: 0,
        accessibilityHighlights: [],
        legs: [leg],
      };

      const liveMap = new Map<string, LiveSection>();
      liveMap.set("sec-test", {
        sectionId: "sec-test",
        congestionLevel: 4,
        speedKmh: 12,
      });

      const geometries: TrafficSectionGeometry[] = [
        {
          sectionId: "sec-test",
          city: "Taipei",
          geometry: {
            type: "LineString",
            coordinates: [
              [121.522, 25.042],
              [121.528, 25.042],
            ],
          },
        },
      ];

      applyTrafficOverlay([route], liveMap, buildSegmentIndex(geometries));

      expect(leg.durationInTrafficMin).toBeDefined();
      expect(route.totalMinutes).toBe(10 + (leg.durationInTrafficMin! - 2));
    });

    it("accumulates the delta across every drive leg of a waypoint route", () => {
      const makeLeg = (lngFrom: number, lngTo: number): DriveLeg => ({
        type: "DRIVE",
        from: { lat: 25.042, lng: lngFrom },
        to: { lat: 25.042, lng: lngTo },
        distanceM: 1000,
        durationMin: 2,
        polyline: [
          [lngFrom, 25.042],
          [lngTo, 25.042],
        ],
      });

      const legA = makeLeg(121.52, 121.53);
      const legB = makeLeg(121.54, 121.55);

      const route: AccessibleRoute = {
        routeId: "test-route-waypoints",
        routeName: "測試中途點路線",
        totalMinutes: 4,
        transferCount: 0,
        accessibilityHighlights: [],
        legs: [legA, legB],
      };

      const liveMap = new Map<string, LiveSection>();
      liveMap.set("sec-a", {
        sectionId: "sec-a",
        congestionLevel: 4,
        speedKmh: 12,
      });
      liveMap.set("sec-b", {
        sectionId: "sec-b",
        congestionLevel: 4,
        speedKmh: 12,
      });

      const geometries: TrafficSectionGeometry[] = [
        {
          sectionId: "sec-a",
          city: "Taipei",
          geometry: {
            type: "LineString",
            coordinates: [
              [121.522, 25.042],
              [121.528, 25.042],
            ],
          },
        },
        {
          sectionId: "sec-b",
          city: "Taipei",
          geometry: {
            type: "LineString",
            coordinates: [
              [121.542, 25.042],
              [121.548, 25.042],
            ],
          },
        },
      ];

      applyTrafficOverlay([route], liveMap, buildSegmentIndex(geometries));

      expect(legA.durationInTrafficMin).toBeDefined();
      expect(legB.durationInTrafficMin).toBeDefined();

      const expectedDelta =
        legA.durationInTrafficMin! - 2 + (legB.durationInTrafficMin! - 2);
      expect(expectedDelta).toBeGreaterThan(0);
      expect(route.totalMinutes).toBe(4 + expectedDelta);
    });

    it("subtracts from totalMinutes when live traffic runs faster than the free-flow estimate", () => {
      const leg: DriveLeg = {
        type: "DRIVE",
        from: { lat: 25.042, lng: 121.52 },
        to: { lat: 25.042, lng: 121.53 },
        distanceM: 1000,
        durationMin: 10,
        polyline: [
          [121.52, 25.042],
          [121.53, 25.042],
        ],
      };

      const route: AccessibleRoute = {
        routeId: "test-route-faster",
        routeName: "測試路線車流順暢",
        totalMinutes: 12,
        transferCount: 0,
        accessibilityHighlights: [],
        legs: [leg],
      };

      const liveMap = new Map<string, LiveSection>();
      liveMap.set("sec-fast", {
        sectionId: "sec-fast",
        congestionLevel: 1,
        speedKmh: 60,
      });

      const geometries: TrafficSectionGeometry[] = [
        {
          sectionId: "sec-fast",
          city: "Taipei",
          geometry: {
            type: "LineString",
            coordinates: [
              [121.522, 25.042],
              [121.528, 25.042],
            ],
          },
        },
      ];

      applyTrafficOverlay([route], liveMap, buildSegmentIndex(geometries));

      expect(leg.durationInTrafficMin).toBeDefined();
      expect(leg.durationInTrafficMin!).toBeLessThan(leg.durationMin);
      expect(route.totalMinutes).toBe(12 + (leg.durationInTrafficMin! - 10));
      expect(route.totalMinutes).toBeGreaterThanOrEqual(1);
    });

    it("leaves totalMinutes untouched when no live section matches the leg", () => {
      const leg: DriveLeg = {
        type: "DRIVE",
        from: { lat: 25.042, lng: 121.52 },
        to: { lat: 25.042, lng: 121.53 },
        distanceM: 1000,
        durationMin: 2,
        polyline: [
          [121.52, 25.042],
          [121.53, 25.042],
        ],
      };

      const route: AccessibleRoute = {
        routeId: "test-route-no-live",
        routeName: "測試路線無即時資料",
        totalMinutes: 7,
        transferCount: 0,
        accessibilityHighlights: [],
        legs: [leg],
      };

      applyTrafficOverlay(
        [route],
        new Map<string, LiveSection>(),
        buildSegmentIndex([]),
      );

      expect(route.totalMinutes).toBe(7);
    });

    it("handles MultiLineString geometries without generating false connecting segments", () => {
      const leg: DriveLeg = {
        type: "DRIVE",
        from: { lat: 25.042, lng: 121.52 },
        to: { lat: 25.042, lng: 121.53 },
        distanceM: 1000,
        durationMin: 2,
        polyline: [
          [121.52, 25.042],
          [121.53, 25.042],
        ],
      };

      const route: AccessibleRoute = {
        routeId: "test-multiline-route",
        routeName: "測試 MultiLineString",
        totalMinutes: 2,
        transferCount: 0,
        accessibilityHighlights: [],
        legs: [leg],
      };

      const liveMap = new Map<string, LiveSection>();
      liveMap.set("sec-multi", {
        sectionId: "sec-multi",
        congestionLevel: 4,
        speedKmh: 15,
      });

      // Disjoint MultiLineString with two segments separated by a gap
      const geometries: TrafficSectionGeometry[] = [
        {
          sectionId: "sec-multi",
          city: "Taipei",
          geometry: {
            type: "MultiLineString",
            coordinates: [
              [
                [121.521, 25.042],
                [121.523, 25.042],
              ],
              [
                [121.527, 25.042],
                [121.529, 25.042],
              ],
            ],
          },
        },
      ];

      applyTrafficOverlay([route], liveMap, buildSegmentIndex(geometries));

      expect(leg.durationInTrafficMin).toBeDefined();
      expect(leg.trafficLevel).toBeDefined();
    });

    it("prevents time inflation when multiple parallel or overlapping sections match the same leg", () => {
      // 1000m leg with 1.2 min (72 sec) free-flow duration -> ~50 km/h
      const leg: DriveLeg = {
        type: "DRIVE",
        from: { lat: 25.042, lng: 121.52 },
        to: { lat: 25.042, lng: 121.53 },
        distanceM: 1000,
        durationMin: 1.2,
        polyline: [
          [121.52, 25.042],
          [121.53, 25.042],
        ],
      };

      // 3 parallel sections completely overlapping the 1000m leg, all reporting speed 12 km/h (3.33 m/s)
      // Expected time for 1000m at 12 km/h: 1000 / (12 * 1000 / 3600) = 300 sec = 5 min
      // Without scale normalization, 3 sections would sum to 300 + 300 + 300 = 900 sec = 15 min!
      const matchedParallel = [
        {
          sectionId: "sec-lane-1",
          congestionLevel: 4 as const,
          speedKmh: 12,
          coveredM: 1000,
        },
        {
          sectionId: "sec-lane-2",
          congestionLevel: 4 as const,
          speedKmh: 12,
          coveredM: 1000,
        },
        {
          sectionId: "sec-lane-3",
          congestionLevel: 4 as const,
          speedKmh: 12,
          coveredM: 1000,
        },
      ];

      const traffic = deriveLegTraffic(leg, matchedParallel);

      // Should be around 5 min, definitely NOT 15 min
      expect(traffic.durationInTrafficMin).toBe(5);
      expect(traffic.trafficLevel).toBe("heavy");
    });

    it("attaches incident advisories to all matching candidate routes, not just the globally closest leg", () => {
      const leg1: DriveLeg = {
        type: "DRIVE",
        from: { lat: 25.042, lng: 121.52 },
        to: { lat: 25.042, lng: 121.53 },
        distanceM: 1000,
        durationMin: 2,
        polyline: [
          [121.52, 25.042],
          [121.53, 25.042],
        ],
      };

      const leg2: DriveLeg = {
        type: "DRIVE",
        from: { lat: 25.0421, lng: 121.52 },
        to: { lat: 25.0421, lng: 121.53 },
        distanceM: 1000,
        durationMin: 2,
        polyline: [
          [121.52, 25.0421],
          [121.53, 25.0421],
        ],
      };

      const route1: AccessibleRoute = {
        routeId: "candidate-route-1",
        routeName: "候選路線 1",
        totalMinutes: 2,
        transferCount: 0,
        accessibilityHighlights: [],
        legs: [leg1],
      };

      const route2: AccessibleRoute = {
        routeId: "candidate-route-2",
        routeName: "候選路線 2",
        totalMinutes: 2,
        transferCount: 0,
        accessibilityHighlights: [],
        legs: [leg2],
      };

      // Incident located at 25.04205 (closer to leg1 by ~5m, but well within 100m tolerance for leg2 as well)
      const incident: RoadIncident = {
        incidentId: "inc-shared",
        title: "道路施工",
        severity: "advisory",
        location: { lat: 25.04205, lng: 121.525 },
      };

      applyIncidentAdvisories([route1, route2], [incident], 100);

      expect(leg1.incidents).toBeDefined();
      expect(leg1.incidents?.some((i) => i.incidentId === "inc-shared")).toBe(
        true,
      );

      expect(leg2.incidents).toBeDefined();
      expect(leg2.incidents?.some((i) => i.incidentId === "inc-shared")).toBe(
        true,
      );
    });
  });

  describe("deriveTrafficSegments", () => {
    it("derives semantic traffic segments along polyline without hardcoded colors", () => {
      const polyline: [number, number][] = [
        [121.5, 25.04],
        [121.51, 25.04],
        [121.52, 25.04],
        [121.53, 25.04],
      ];

      const candidates: TrafficSectionGeometry[] = [
        {
          sectionId: "sec-free",
          city: "Taipei",
          geometry: {
            type: "LineString",
            coordinates: [
              [121.5, 25.04],
              [121.51, 25.04],
            ],
          },
        },
        {
          sectionId: "sec-jam",
          city: "Taipei",
          geometry: {
            type: "LineString",
            coordinates: [
              [121.51, 25.04],
              [121.53, 25.04],
            ],
          },
        },
      ];

      const leg: DriveLeg = {
        type: "DRIVE",
        from: { lat: 25.04, lng: 121.5 },
        to: { lat: 25.04, lng: 121.53 },
        distanceM: 3000,
        durationMin: 5,
        polyline,
      };

      const route: AccessibleRoute = {
        routeId: "route-with-segments",
        routeName: "測試路線",
        totalMinutes: 5,
        transferCount: 0,
        accessibilityHighlights: [],
        legs: [leg],
      };

      applyTrafficOverlay(
        [route],
        new Map([
          ["sec-free", { sectionId: "sec-free", congestionLevel: 1 }],
          ["sec-jam", { sectionId: "sec-jam", congestionLevel: 5 }],
        ]),
        buildSegmentIndex(candidates),
      );

      expect(leg.trafficSegments).toBeDefined();
      expect(leg.trafficSegments?.length).toBeGreaterThanOrEqual(2);
      expect(leg.trafficSegments?.[0].trafficLevel).toBe("light");
      expect(leg.trafficSegments?.[0].congestionLevel).toBe(1);
      expect(leg.trafficSegments?.[1].trafficLevel).toBe("heavy");
      expect(leg.trafficSegments?.[1].congestionLevel).toBe(5);
      // Ensure no color field exists in semantic DriveTrafficSegment (pure semantic design)
      expect((leg.trafficSegments?.[0] as any).color).toBeUndefined();
    });

    it("prioritizes Freeway Linear Referencing for highway maneuvers and falls back to spatial for local roads", () => {
      // Points 0..4 are on 國道1號 (圓山 0021 -> 台北 25.1K -> 三重 0023)
      // Points 4..6 are on a local city street
      const polyline: [number, number][] = [
        [121.53199, 25.07281], // 0021 start (圓山)
        [121.5299, 25.0735],
        [121.52783, 25.07434], // 0021 end / 0023 start (台北 25.1K)
        [121.515, 25.073],
        [121.503, 25.071], // 0023 end (三重 27.1K)
        [121.501, 25.068], // Local street turn
        [121.498, 25.065], // Local street end
      ];

      // Spatial index only has the local street section (not the freeway sections)
      const localCandidates: TrafficSectionGeometry[] = [
        {
          sectionId: "sec-local",
          city: "NewTaipei",
          geometry: {
            type: "LineString",
            coordinates: [
              [121.503, 25.071],
              [121.501, 25.068],
              [121.498, 25.065],
            ],
          },
        },
      ];

      const leg: DriveLeg = {
        type: "DRIVE",
        from: { lat: 25.07281, lng: 121.53199 },
        to: { lat: 25.065, lng: 121.498 },
        distanceM: 5000,
        durationMin: 8,
        polyline,
        maneuvers: [
          {
            type: 24,
            beginShapeIndex: 0,
            endShapeIndex: 4,
            highway: true,
            streetNames: ["1", "中山高速公路"],
            lengthKm: 3.9,
            timeSec: 150,
          },
          {
            type: 10,
            beginShapeIndex: 4,
            endShapeIndex: 6,
            streetNames: ["重新路"],
            lengthKm: 1.1,
            timeSec: 120,
          },
        ],
      };

      const route: AccessibleRoute = {
        routeId: "two-tier-route",
        routeName: "國道轉市區混合路線",
        totalMinutes: 8,
        transferCount: 0,
        accessibilityHighlights: [],
        legs: [leg],
      };

      const liveMap = new Map<string, LiveSection>([
        ["0021", { sectionId: "0021", congestionLevel: 1, speedKmh: 90 }], // 順暢 90 km/h
        ["0023", { sectionId: "0023", congestionLevel: 5, speedKmh: 20 }], // 壅塞 20 km/h
        [
          "sec-local",
          { sectionId: "sec-local", congestionLevel: 3, speedKmh: 35 },
        ], // 車多 35 km/h
      ]);

      const metrics = applyTrafficOverlay(
        [route],
        liveMap,
        buildSegmentIndex(localCandidates),
      );

      expect(metrics.matchedSections).toBeGreaterThanOrEqual(2);
      expect(leg.trafficSegments).toBeDefined();

      // Verify that freeway sections 0021 and 0023 are matched on the freeway segment
      const levels = leg.trafficSegments!.map((s) => s.congestionLevel);
      expect(levels).toContain(1); // from 0021
      expect(levels).toContain(5); // from 0023
      expect(levels).toContain(3); // from sec-local fallback!

      // Verify duration in traffic is derived and reflects traffic delay
      expect(leg.durationInTrafficMin).toBeDefined();
      expect(leg.trafficLevel).toBeDefined();
    });
  });
});
