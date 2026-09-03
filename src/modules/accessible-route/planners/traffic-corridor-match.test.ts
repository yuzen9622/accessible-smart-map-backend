import { describe, expect, it } from "vitest";
import type {
  LiveSection,
  TrafficSectionGeometry,
} from "../../../types/traffic";
import { buildSegmentIndex } from "../../traffic/traffic-segment-index";
import {
  bearingDiffDeg,
  matchLegToSegmentIndex,
  segmentToSegmentApproxMeters,
} from "./traffic-corridor-match";

describe("traffic-corridor-match", () => {
  describe("bearingDiffDeg", () => {
    it("computes angular difference correctly across wrap-around", () => {
      expect(bearingDiffDeg(350, 10)).toBe(20);
      expect(bearingDiffDeg(10, 350)).toBe(20);
      expect(bearingDiffDeg(0, 180)).toBe(180);
      expect(bearingDiffDeg(90, 270)).toBe(180);
      expect(bearingDiffDeg(45, 45)).toBe(0);
      expect(bearingDiffDeg(359, 0)).toBe(1);
    });
  });

  describe("segmentToSegmentApproxMeters", () => {
    it("measures distance between parallel segments correctly", () => {
      // 1 degree lat is ~111,320m, 0.0001 deg is ~11.13m
      const a: [number, number] = [121.5, 25.0];
      const b: [number, number] = [121.5, 25.001];
      const c: [number, number] = [121.5001, 25.0];
      const d: [number, number] = [121.5001, 25.001];

      const dist = segmentToSegmentApproxMeters(a, b, c, d);
      expect(dist).toBeGreaterThan(5);
      expect(dist).toBeLessThan(15);
    });
  });

  describe("directional matching (Layer 2 core)", () => {
    it("matches only the northbound section when northbound and southbound sections are 15m parallel", () => {
      // 15m east is approx 0.00015 degrees longitude at lat 25
      const secNorth: TrafficSectionGeometry = {
        sectionId: "sec-north",
        city: "Taipei",
        geometry: {
          type: "LineString",
          coordinates: [
            [121.50015, 25.0],
            [121.50015, 25.01],
          ], // bearing = 0 (true North)
        },
      };

      const secSouth: TrafficSectionGeometry = {
        sectionId: "sec-south",
        city: "Taipei",
        geometry: {
          type: "LineString",
          coordinates: [
            [121.50015, 25.01],
            [121.50015, 25.0],
          ], // bearing = 180 (true South)
        },
      };

      const index = buildSegmentIndex([secNorth, secSouth]);
      const liveMap = new Map<string, LiveSection>();

      // Northbound route: [121.5, 25.0] -> [121.5, 25.01] (bearing = 0)
      const routeNorth: [number, number][] = [
        [121.5, 25.0],
        [121.5, 25.01],
      ];

      const matchRes = matchLegToSegmentIndex(routeNorth, index, liveMap);
      expect(matchRes.segmentSectionIdx.length).toBe(1);

      const matchedSecId = index.sectionIds[matchRes.segmentSectionIdx[0]];
      expect(matchedSecId).toBe("sec-north");
      expect(matchRes.segmentDistanceM[0]).toBeLessThan(30);

      // Southbound route: [121.5, 25.01] -> [121.5, 25.0] (bearing = 180)
      const routeSouth: [number, number][] = [
        [121.5, 25.01],
        [121.5, 25.0],
      ];

      const matchResSouth = matchLegToSegmentIndex(routeSouth, index, liveMap);
      const matchedSouthSecId =
        index.sectionIds[matchResSouth.segmentSectionIdx[0]];
      expect(matchedSouthSecId).toBe("sec-south");
    });

    it("rejects parallel road 200m away exceeding tolerance", () => {
      // 200m away is approx 0.002 degrees longitude
      const farSection: TrafficSectionGeometry = {
        sectionId: "far-sec",
        city: "Taipei",
        geometry: {
          type: "LineString",
          coordinates: [
            [121.502, 25.0],
            [121.502, 25.01],
          ],
        },
      };

      const index = buildSegmentIndex([farSection]);
      const route: [number, number][] = [
        [121.5, 25.0],
        [121.5, 25.01],
      ];

      const res = matchLegToSegmentIndex(route, index, new Map());
      expect(res.segmentSectionIdx[0]).toBe(-1);
      expect(res.segmentDistanceM[0]).toBe(Infinity);
    });

    it("hits short congestion section covering only 3 route segments without vertex sampling drops", () => {
      // Route has 10 segments from 25.000 to 25.010
      const route: [number, number][] = [];
      for (let i = 0; i <= 10; i++) {
        route.push([121.5, 25.0 + i * 0.001]);
      }

      // Short section covering segments 4, 5, 6 only
      const shortSection: TrafficSectionGeometry = {
        sectionId: "short-jam",
        city: "Taipei",
        geometry: {
          type: "LineString",
          coordinates: [
            [121.5, 25.004],
            [121.5, 25.005],
            [121.5, 25.006],
            [121.5, 25.007],
          ],
        },
      };

      const index = buildSegmentIndex([shortSection]);
      const res = matchLegToSegmentIndex(route, index, new Map());

      expect(res.segmentSectionIdx.length).toBe(10);
      // Unmatched for segments 0..2 (far before the short section)
      expect(res.segmentSectionIdx[0]).toBe(-1);
      expect(res.segmentSectionIdx[1]).toBe(-1);
      expect(res.segmentSectionIdx[2]).toBe(-1);
      // Matched for segments 4..6 (the overlapping segments)
      const secIdx = index.sectionIds.indexOf("short-jam");
      expect(res.segmentSectionIdx[4]).toBe(secIdx);
      expect(res.segmentSectionIdx[5]).toBe(secIdx);
      expect(res.segmentSectionIdx[6]).toBe(secIdx);
      // Unmatched for segments 8..9 (far after the short section)
      expect(res.segmentSectionIdx[8]).toBe(-1);
      expect(res.segmentSectionIdx[9]).toBe(-1);
    });

    it("prefers candidate with live data when distances are tied", () => {
      const secA: TrafficSectionGeometry = {
        sectionId: "sec-no-live",
        city: "Taipei",
        geometry: {
          type: "LineString",
          coordinates: [
            [121.5, 25.0],
            [121.5, 25.01],
          ],
        },
      };
      const secB: TrafficSectionGeometry = {
        sectionId: "sec-has-live",
        city: "Taipei",
        geometry: {
          type: "LineString",
          coordinates: [
            [121.5, 25.0],
            [121.5, 25.01],
          ],
        },
      };

      const index = buildSegmentIndex([secA, secB]);
      const liveMap = new Map<string, LiveSection>([
        ["sec-has-live", { sectionId: "sec-has-live", congestionLevel: 2 }],
      ]);

      const route: [number, number][] = [
        [121.5, 25.0],
        [121.5, 25.01],
      ];

      const res = matchLegToSegmentIndex(route, index, liveMap);
      const matchedSecId = index.sectionIds[res.segmentSectionIdx[0]];
      expect(matchedSecId).toBe("sec-has-live");
    });
  });

  describe("performance regression gate", () => {
    it("matches a 1,700-point route against a 150,000-segment index in under 500ms", () => {
      // Build synthetic 150,000 atomic segments across a grid in Taipei region [121.4 - 121.6, 24.9 - 25.1]
      const totalSegments = 150_000;
      const geometries: TrafficSectionGeometry[] = [];
      const segmentsPerSection = 50;
      const numSections = totalSegments / segmentsPerSection;

      for (let s = 0; s < numSections; s++) {
        const baseLng = 121.4 + (s % 300) * 0.0006;
        const baseLat = 24.9 + Math.floor(s / 300) * 0.02;
        const coords: [number, number][] = [];
        for (let v = 0; v <= segmentsPerSection; v++) {
          coords.push([baseLng, baseLat + v * 0.0003]);
        }
        geometries.push({
          sectionId: `synth-${s}`,
          city: "Taipei",
          geometry: {
            type: "LineString",
            coordinates: coords,
          },
        });
      }

      const index = buildSegmentIndex(geometries);
      expect(index.segmentCount).toBe(totalSegments);

      // Construct a 1,700-point route running through the grid
      const routePolyline: [number, number][] = [];
      for (let i = 0; i < 1700; i++) {
        routePolyline.push([
          121.5 + (i / 1700) * 0.05,
          24.95 + (i / 1700) * 0.1,
        ]);
      }

      const liveMap = new Map<string, LiveSection>();
      const t0 = performance.now();
      const matchResult = matchLegToSegmentIndex(routePolyline, index, liveMap);
      const durationMs = performance.now() - t0;

      expect(matchResult.segmentSectionIdx.length).toBe(1699);
      expect(durationMs).toBeLessThan(500);
    });
  });
});
