import { describe, expect, it } from "vitest";
import type { NormalizedValhallaManeuver } from "../../../adapters/valhalla.adapter";
import { getFreewayCorridorRegistry } from "../../traffic/freeway-corridor.registry";
import {
  determineDirectionFromAnchors,
  matchAnchorsSequentially,
  matchLegByFreewayLinearReferencing,
  pointToSegmentProj,
  resolveCandidateCorridors,
  type MatchedAnchor,
} from "./freeway-linear-referencing";

describe("FreewayLinearReferencing Engine", () => {
  const registry = getFreewayCorridorRegistry();

  describe("resolveCandidateCorridors", () => {
    it("should resolve 國道1號 ground corridor", () => {
      const res = resolveCandidateCorridors(["1", "中山高速公路"]);
      expect(res.roadNames).toEqual(["國道1號"]);
      expect(res.kmMin).toBeUndefined();
    });

    it("should resolve 汐五高架 with KM range [13.08, 32.1]", () => {
      const res = resolveCandidateCorridors(["1", "汐止五股高架道路"]);
      expect(res.roadNames).toEqual(["國道1號汐止五股高架道路"]);
      expect(res.kmMin).toBe(13.08);
      expect(res.kmMax).toBe(32.1);
    });

    it("should resolve 五楊高架 with KM range [32.1, 71.35]", () => {
      const res = resolveCandidateCorridors(["1", "五股楊梅高架道路"]);
      expect(res.roadNames).toEqual(["國道1號汐止五股高架道路"]);
      expect(res.kmMin).toBe(32.1);
      expect(res.kmMax).toBe(71.35);
    });

    it("should resolve 國道3號 and 國道3甲", () => {
      expect(
        resolveCandidateCorridors(["3", "福爾摩沙高速公路"]).roadNames,
      ).toEqual(["國道3號"]);
      expect(
        resolveCandidateCorridors(["3甲", "台北聯絡線"]).roadNames,
      ).toEqual(["國道3甲"]);
    });

    it("should resolve East-West freeways (2, 4, 6, 8, 10, 76)", () => {
      expect(resolveCandidateCorridors(["2"]).roadNames).toEqual(["國道2號"]);
      expect(resolveCandidateCorridors(["4"]).roadNames).toEqual(["國道4號"]);
      expect(resolveCandidateCorridors(["5"]).roadNames).toEqual(["國道5號"]);
      expect(resolveCandidateCorridors(["6"]).roadNames).toEqual(["國道6號"]);
      expect(resolveCandidateCorridors(["8"]).roadNames).toEqual(["國道8號"]);
      expect(resolveCandidateCorridors(["10"]).roadNames).toEqual(["國道10號"]);
      expect(resolveCandidateCorridors(["76"]).roadNames).toEqual(["臺76線"]);
    });
  });

  describe("pointToSegmentProj", () => {
    it("should project point accurately onto a line segment", () => {
      const a: [number, number] = [121.5, 25.0];
      const b: [number, number] = [121.6, 25.0];
      const p: [number, number] = [121.55, 25.001]; // ~111m north of midpoint

      const { distM, t, proj } = pointToSegmentProj(p, a, b);
      expect(t).toBeCloseTo(0.5, 2);
      expect(distM).toBeCloseTo(111, 0);
      expect(proj[0]).toBeCloseTo(121.55, 3);
      expect(proj[1]).toBeCloseTo(25.0, 3);
    });

    it("should clamp projection to segment endpoints", () => {
      const a: [number, number] = [121.5, 25.0];
      const b: [number, number] = [121.6, 25.0];
      const beforeA: [number, number] = [121.4, 25.0];

      const { t, proj } = pointToSegmentProj(beforeA, a, b);
      expect(t).toBe(0);
      expect(proj).toEqual(a);
    });
  });

  describe("12 Benchmark Scenarios", () => {
    // Helper to generate synthetic polyline along Section start points
    function makePolylineFromSections(
      sectionIds: string[],
      pointsPerSection = 5,
    ): [number, number][] {
      const polyline: [number, number][] = [];
      const sections = sectionIds
        .map((id) => registry.getSection(id))
        .filter((s) => s?.startPoint);

      for (let i = 0; i < sections.length; i++) {
        const p1 = sections[i]!.startPoint!;
        const p2 =
          sections[i]!.endPoint ??
          (i < sections.length - 1 ? sections[i + 1]!.startPoint! : p1);

        for (let j = 0; j < pointsPerSection; j++) {
          const frac = j / pointsPerSection;
          polyline.push([
            p1[0] + frac * (p2[0] - p1[0]),
            p1[1] + frac * (p2[1] - p1[1]),
          ]);
        }
      }
      if (sections.length > 0 && sections.at(-1)?.endPoint) {
        polyline.push([
          sections.at(-1)!.endPoint![0],
          sections.at(-1)!.endPoint![1],
        ]);
      }
      return polyline;
    }

    // 1. 國1平面線
    it("Scenario 1: 國1平面線 (圓山 -> 台北 -> 三重)", () => {
      // 0021: 圓山到台北 (23.2K -> 25.1K)
      // 0023: 台北到三重 (25.1K -> 27.1K)
      // 0025: 三重到五股轉接道 (27.1K -> 32.1K)
      const polyline = makePolylineFromSections(["0021", "0023", "0025"]);
      const maneuvers: NormalizedValhallaManeuver[] = [
        {
          type: 24,
          beginShapeIndex: 0,
          endShapeIndex: polyline.length - 1,
          highway: true,
          streetNames: ["1", "中山高速公路"],
          lengthKm: 8.9,
          timeSec: 320,
          stairs: false,
        },
      ];

      const res = matchLegByFreewayLinearReferencing(polyline, maneuvers);
      expect(res.coveredSegmentCount).toBeGreaterThan(0);
      expect(res.matchedSectionIds.has("0021")).toBe(true);
      expect(res.matchedSectionIds.has("0023")).toBe(true);
      expect(res.matchedSectionIds.has("0025")).toBe(true);
      expect(res.segmentSectionIds.every((id) => id !== null)).toBe(true);
    });

    // 2. 汐五高架
    it("Scenario 2: 汐五高架 (汐止端 -> 堤頂 -> 環北)", () => {
      // 0159: 汐止端到堤頂 (13.08K -> 18.8K)
      // 0161: 堤頂到下塔悠 (18.8K -> 20.7K)
      // 0163: 下塔悠到環北 (20.7K -> 26.1K)
      const polyline = makePolylineFromSections(["0159", "0161", "0163"]);
      const maneuvers: NormalizedValhallaManeuver[] = [
        {
          type: 24,
          beginShapeIndex: 0,
          endShapeIndex: polyline.length - 1,
          highway: true,
          streetNames: ["1", "汐止五股高架道路"],
          lengthKm: 13.0,
          timeSec: 500,
          stairs: false,
        },
      ];

      const res = matchLegByFreewayLinearReferencing(polyline, maneuvers);
      expect(res.matchedSectionIds.has("0159")).toBe(true);
      expect(res.matchedSectionIds.has("0161")).toBe(true);
      expect(res.matchedSectionIds.has("0163")).toBe(true);
      // Ensure it did not match ground sections 0015 / 0017
      expect(res.matchedSectionIds.has("0015")).toBe(false);
    });

    // 3. 五楊高架
    it("Scenario 3: 五楊高架 (五股轉接道 -> 泰山轉接道 -> 機場系統)", () => {
      // 0433: 五股轉接道到泰山轉接道 (32.1K -> 36.0K)
      // 0435: 泰山轉接道到機場系統 (36.0K -> 52.5K)
      const polyline = makePolylineFromSections(["0433", "0435"]);
      const maneuvers: NormalizedValhallaManeuver[] = [
        {
          type: 24,
          beginShapeIndex: 0,
          endShapeIndex: polyline.length - 1,
          highway: true,
          streetNames: ["1", "五股楊梅高架道路"],
          lengthKm: 20.4,
          timeSec: 720,
          stairs: false,
        },
      ];

      const res = matchLegByFreewayLinearReferencing(polyline, maneuvers);
      expect(res.matchedSectionIds.has("0433")).toBe(true);
      expect(res.matchedSectionIds.has("0435")).toBe(true);
      // Ground section 0031 shouldn't be matched
      expect(res.matchedSectionIds.has("0031")).toBe(false);
    });

    // 4. 平面/高架分岔與匯入
    it("Scenario 4: 平面/高架分岔與匯入 (從五股轉接道切換)", () => {
      // Vehicle starts on ground 0025 (三重到五股轉接道, 27.1K -> 32.1K),
      // then switches at 五股轉接道 into elevated 0433 (五股轉接道到泰山轉接道, 32.1K -> 36.0K)
      const polyGround = makePolylineFromSections(["0025"], 5);
      const polyElev = makePolylineFromSections(["0433"], 5);
      const fullPolyline = [...polyGround, ...polyElev];

      const maneuvers: NormalizedValhallaManeuver[] = [
        {
          type: 24,
          beginShapeIndex: 0,
          endShapeIndex: polyGround.length - 1,
          highway: true,
          streetNames: ["1", "中山高速公路"],
          lengthKm: 5.0,
          timeSec: 180,
          stairs: false,
        },
        {
          type: 24,
          beginShapeIndex: polyGround.length,
          endShapeIndex: fullPolyline.length - 1,
          highway: true,
          streetNames: ["1", "五股楊梅高架道路"],
          lengthKm: 3.9,
          timeSec: 150,
          stairs: false,
        },
      ];

      const res = matchLegByFreewayLinearReferencing(fullPolyline, maneuvers);
      expect(res.matchedSectionIds.has("0025")).toBe(true);
      expect(res.matchedSectionIds.has("0433")).toBe(true);
    });

    // 5. 南下與北上單調性
    it("Scenario 5: 南下與北上單調性驗證", () => {
      // Southbound (mileage increases)
      const anchorsS: MatchedAnchor[] = [
        {
          sectionId: "0021",
          km: 23.2,
          shapeIdx: 0,
          t: 0,
          distanceAlongRouteM: 0,
          perpendicularDistM: 1,
        },
        {
          sectionId: "0023",
          km: 25.1,
          shapeIdx: 20,
          t: 0,
          distanceAlongRouteM: 1900,
          perpendicularDistM: 1,
        },
        {
          sectionId: "0025",
          km: 27.1,
          shapeIdx: 40,
          t: 0,
          distanceAlongRouteM: 3900,
          perpendicularDistM: 1,
        },
      ];
      // Northbound (mileage decreases)
      const anchorsN: MatchedAnchor[] = [
        {
          sectionId: "0026",
          km: 32.1,
          shapeIdx: 0,
          t: 0,
          distanceAlongRouteM: 0,
          perpendicularDistM: 1,
        },
        {
          sectionId: "0024",
          km: 27.1,
          shapeIdx: 25,
          t: 0,
          distanceAlongRouteM: 5000,
          perpendicularDistM: 1,
        },
        {
          sectionId: "0022",
          km: 25.1,
          shapeIdx: 45,
          t: 0,
          distanceAlongRouteM: 7000,
          perpendicularDistM: 1,
        },
      ];

      expect(determineDirectionFromAnchors(anchorsS, [], false)).toBe("S");
      expect(determineDirectionFromAnchors([], anchorsN, false)).toBe("N");
    });

    it("Scenario 5b: 85° vs 95° 方位角邊界硬性排除回歸驗證", () => {
      // Route is heading North (bearing = 0°)
      const routeBearing = 0;

      // Candidate Pos has bearing 95° (> 90° reverse/orthogonal) and distance 1m (closer)
      const anchorsPos: MatchedAnchor[] = [
        {
          sectionId: "sec-pos",
          km: 20.0,
          shapeIdx: 0,
          t: 0,
          distanceAlongRouteM: 0,
          perpendicularDistM: 1,
          sectionBearing: 95,
        },
      ];

      // Candidate Neg has bearing 85° (<= 90° forward) and distance 8m (further)
      const anchorsNeg: MatchedAnchor[] = [
        {
          sectionId: "sec-neg",
          km: 20.0,
          shapeIdx: 0,
          t: 0,
          distanceAlongRouteM: 0,
          perpendicularDistM: 8,
          sectionBearing: 85,
        },
      ];

      // Must strictly eliminate Pos (95° > 90°) and select Neg (85° <= 90°) despite Neg being further away!
      expect(
        determineDirectionFromAnchors(
          anchorsPos,
          anchorsNeg,
          false,
          routeBearing,
        ),
      ).toBe("N");

      // If both are > 90° (e.g. 95° and 105°), must return null (safe fallback to spatial)
      const bothReversePos: MatchedAnchor[] = [
        { ...anchorsPos[0], sectionBearing: 95 },
      ];
      const bothReverseNeg: MatchedAnchor[] = [
        { ...anchorsNeg[0], sectionBearing: 105 },
      ];
      expect(
        determineDirectionFromAnchors(
          bothReversePos,
          bothReverseNeg,
          false,
          routeBearing,
        ),
      ).toBeNull();
    });

    // 6. 國3
    it("Scenario 6: 國3 (南港 -> 木柵 -> 新店)", () => {
      // 0189: 南港到南港系統 (15.1K -> 16.3K)
      // 0193: 南深路到木柵 (16.5K -> 20.8K)
      // 0197: 木柵休息站到新店 (25.1K -> 26.8K)
      const polyline = makePolylineFromSections(["0189", "0193", "0197"]);
      const maneuvers: NormalizedValhallaManeuver[] = [
        {
          type: 24,
          beginShapeIndex: 0,
          endShapeIndex: polyline.length - 1,
          highway: true,
          streetNames: ["3", "福爾摩沙高速公路"],
          lengthKm: 11.7,
          timeSec: 420,
          stairs: false,
        },
      ];

      const res = matchLegByFreewayLinearReferencing(polyline, maneuvers);
      expect(res.matchedSectionIds.has("0189")).toBe(true);
      expect(res.matchedSectionIds.has("0193")).toBe(true);
      expect(res.matchedSectionIds.has("0197")).toBe(true);
    });

    // 7. 東西向國道 (國2, 國3甲, 國2甲, 國4, 國6, 國8, 國10, 臺76)
    it("Scenario 7: 東西向國道完整解析與匹配", () => {
      // 國2: 0167 (0.0K -> 0.9K), 0169 (0.9K -> 5.0K)
      const poly2 = makePolylineFromSections(["0167", "0169"]);
      const res2 = matchLegByFreewayLinearReferencing(poly2, [
        {
          type: 24,
          beginShapeIndex: 0,
          endShapeIndex: poly2.length - 1,
          highway: true,
          streetNames: ["2", "國道二號"],
          lengthKm: 5.0,
          timeSec: 180,
          stairs: false,
        },
      ]);
      expect(res2.matchedSectionIds.has("0167")).toBe(true);
      expect(res2.matchedSectionIds.has("0169")).toBe(true);

      // 國3甲 (台北聯絡線): 0349 (0.0K -> 0.7K), 0351 (0.7K -> 3.6K)
      const poly3a = makePolylineFromSections(["0349", "0351"]);
      const res3a = matchLegByFreewayLinearReferencing(poly3a, [
        {
          type: 24,
          beginShapeIndex: 0,
          endShapeIndex: poly3a.length - 1,
          highway: true,
          streetNames: ["3甲", "台北聯絡線"],
          lengthKm: 3.6,
          timeSec: 150,
          stairs: false,
        },
      ]);
      expect(res3a.matchedSectionIds.has("0349")).toBe(true);
      expect(res3a.matchedSectionIds.has("0351")).toBe(true);

      // 國2甲 (大園支線): 0491
      const poly2a = makePolylineFromSections(["0491"]);
      const res2a = matchLegByFreewayLinearReferencing(poly2a, [
        {
          type: 24,
          beginShapeIndex: 0,
          endShapeIndex: poly2a.length - 1,
          highway: true,
          streetNames: ["2甲", "大園支線"],
          lengthKm: 2.0,
          timeSec: 80,
          stairs: false,
        },
      ]);
      expect(res2a.matchedSectionIds.has("0491")).toBe(true);

      // 國4: 0355, 0357
      const poly4 = makePolylineFromSections(["0355", "0357"]);
      const res4 = matchLegByFreewayLinearReferencing(poly4, [
        {
          type: 24,
          beginShapeIndex: 0,
          endShapeIndex: poly4.length - 1,
          highway: true,
          streetNames: ["4"],
          lengthKm: 4.0,
          timeSec: 140,
          stairs: false,
        },
      ]);
      expect(res4.matchedSectionIds.has("0355")).toBe(true);

      // 國6: 0379, 0417
      const poly6 = makePolylineFromSections(["0379", "0417"]);
      const res6 = matchLegByFreewayLinearReferencing(poly6, [
        {
          type: 24,
          beginShapeIndex: 0,
          endShapeIndex: poly6.length - 1,
          highway: true,
          streetNames: ["6"],
          lengthKm: 5.0,
          timeSec: 180,
          stairs: false,
        },
      ]);
      expect(res6.matchedSectionIds.has("0379")).toBe(true);

      // 國8: 0389, 0391
      const poly8 = makePolylineFromSections(["0389", "0391"]);
      const res8 = matchLegByFreewayLinearReferencing(poly8, [
        {
          type: 24,
          beginShapeIndex: 0,
          endShapeIndex: poly8.length - 1,
          highway: true,
          streetNames: ["8"],
          lengthKm: 4.0,
          timeSec: 140,
          stairs: false,
        },
      ]);
      expect(res8.matchedSectionIds.has("0389")).toBe(true);

      // 國10: 0399, 0401
      const poly10 = makePolylineFromSections(["0399", "0401"]);
      const res10 = matchLegByFreewayLinearReferencing(poly10, [
        {
          type: 24,
          beginShapeIndex: 0,
          endShapeIndex: poly10.length - 1,
          highway: true,
          streetNames: ["10"],
          lengthKm: 4.0,
          timeSec: 140,
          stairs: false,
        },
      ]);
      expect(res10.matchedSectionIds.has("0399")).toBe(true);
    });

    // 8. 起點直接位於國道中段 (有界後向外推與截止)
    it("Scenario 8: 起點直接位於國道中段 (有界後向外推與超過上限截止)", () => {
      // Car enters after section start (e.g. at KM 24.0 between 23.2 and 25.1)
      const sec21 = registry.getSection("0021")!; // 23.2K -> 25.1K
      const sec23 = registry.getSection("0023")!; // 25.1K -> 27.1K

      const p1: [number, number] = [sec21.startPoint![0], sec21.startPoint![1]];
      const p2: [number, number] = [sec23.startPoint![0], sec23.startPoint![1]];
      const p3: [number, number] = [sec23.endPoint![0], sec23.endPoint![1]];

      // Midpoint between p1 and p2 (approx 24.1K, distance ~1000m before p2)
      const midP: [number, number] = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2];
      const polyline: [number, number][] = [midP, p2, p3];

      const maneuvers: NormalizedValhallaManeuver[] = [
        {
          type: 24,
          beginShapeIndex: 0,
          endShapeIndex: polyline.length - 1,
          highway: true,
          streetNames: ["1"],
          lengthKm: 3.0,
          timeSec: 100,
          stairs: false,
        },
      ];

      const res = matchLegByFreewayLinearReferencing(polyline, maneuvers);
      // Section 0021 should be matched via backward bounded extrapolation (< 3000m)
      expect(res.matchedSectionIds.has("0021")).toBe(true);
      expect(res.matchedSectionIds.has("0023")).toBe(true);

      // Now test point that is > 3000m (e.g. 10km) before the anchor: extrapolation must be cut off
      const farBeforeP: [number, number] = [p2[0] - 0.1, p2[1] + 0.1]; // ~15km away
      const farPolyline: [number, number][] = [farBeforeP, p2, p3];
      const farRes = matchLegByFreewayLinearReferencing(farPolyline, [
        {
          type: 24,
          beginShapeIndex: 0,
          endShapeIndex: farPolyline.length - 1,
          highway: true,
          streetNames: ["1"],
          lengthKm: 15.0,
          timeSec: 600,
          stairs: false,
        },
      ]);
      // First segment (farBeforeP -> p2) exceeds 3000m from anchor, must remain null
      expect(farRes.segmentSectionIds[0]).toBeNull();
    });

    // 9. 終點位於交流道出口附近 (有界前向外推與截止)
    it("Scenario 9: 終點位於交流道出口附近 (有界前向外推與超過上限截止)", () => {
      // Polyline covers Section 0021 (23.2K -> 25.1K) and continues 500m past 25.1K
      const sec21 = registry.getSection("0021")!;
      const sec23 = registry.getSection("0023")!;

      const p1: [number, number] = [sec21.startPoint![0], sec21.startPoint![1]];
      const p2: [number, number] = [sec23.startPoint![0], sec23.startPoint![1]];
      const p3: [number, number] = [
        p2[0] + 0.1 * (sec23.endPoint![0] - p2[0]),
        p2[1] + 0.1 * (sec23.endPoint![1] - p2[1]),
      ];

      const polyline: [number, number][] = [p1, p2, p3];
      const maneuvers: NormalizedValhallaManeuver[] = [
        {
          type: 24,
          beginShapeIndex: 0,
          endShapeIndex: 2,
          highway: true,
          streetNames: ["1"],
          lengthKm: 2.3,
          timeSec: 90,
          stairs: false,
        },
      ];

      const res = matchLegByFreewayLinearReferencing(polyline, maneuvers);
      expect(res.matchedSectionIds.has("0021")).toBe(true);
      expect(res.matchedSectionIds.has("0023")).toBe(true);

      // Now test point that is > 3000m (e.g. 10km) after the anchor: forward extrapolation must be cut off
      const farAfterP: [number, number] = [p2[0] + 0.1, p2[1] - 0.1]; // ~15km away
      const farPolyline: [number, number][] = [p1, p2, farAfterP];
      const farRes = matchLegByFreewayLinearReferencing(farPolyline, [
        {
          type: 24,
          beginShapeIndex: 0,
          endShapeIndex: 2,
          highway: true,
          streetNames: ["1"],
          lengthKm: 15.0,
          timeSec: 600,
          stairs: false,
        },
      ]);
      // Segment (p2 -> farAfterP) exceeds 3000m from anchor, must remain null
      expect(farRes.segmentSectionIds[1]).toBeNull();
    });

    // 10. 路線只經過單一 Section
    it("Scenario 10: 路線只經過單一 Section", () => {
      const sec21 = registry.getSection("0021")!; // 23.2K -> 25.1K
      const p1: [number, number] = [sec21.startPoint![0], sec21.startPoint![1]];
      const p2: [number, number] = [sec21.endPoint![0], sec21.endPoint![1]];

      const polyline: [number, number][] = [
        p1,
        [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2],
        p2,
      ];
      const maneuvers: NormalizedValhallaManeuver[] = [
        {
          type: 24,
          beginShapeIndex: 0,
          endShapeIndex: 2,
          highway: true,
          streetNames: ["1"],
          lengthKm: 1.9,
          timeSec: 70,
          stairs: false,
        },
      ];

      const res = matchLegByFreewayLinearReferencing(polyline, maneuvers);
      expect(res.matchedSectionIds.size).toBe(1);
      expect(res.matchedSectionIds.has("0021")).toBe(true);
      expect(res.segmentSectionIds[0]).toBe("0021");
      expect(res.segmentSectionIds[1]).toBe("0021");
    });

    // 11. Anchor 缺失或距離超過門檻 (拒絕異常錨點並平滑內插)
    it("Scenario 11: 異常錨點拒絕與順暢內插", () => {
      const secList = registry.getCorridor("國道1號", "S").slice(0, 5);
      const polyline = makePolylineFromSections(
        secList.map((s) => s.sectionId),
      );

      // Create a corrupted section copy with an anchor 500m off-track
      const corruptedSections = secList.map((s, idx) => {
        if (idx === 2) {
          return {
            ...s,
            startPoint: [s.startPoint![0] + 0.05, s.startPoint![1] + 0.05] as [
              number,
              number,
            ], // ~5km away
          };
        }
        return s;
      });

      const cumDist = [0];
      for (let i = 0; i < polyline.length - 1; i++) {
        cumDist.push(cumDist[i] + 100);
      }

      const anchors = matchAnchorsSequentially(
        corruptedSections,
        polyline,
        0,
        polyline.length - 1,
        cumDist,
        35, // threshold
      );

      // Corrupted section 2 must have been rejected
      expect(anchors.some((a) => a.sectionId === secList[2].sectionId)).toBe(
        false,
      );
      // Valid sections 0, 1, 3, 4 should still be matched
      expect(anchors.some((a) => a.sectionId === secList[0].sectionId)).toBe(
        true,
      );
      expect(anchors.some((a) => a.sectionId === secList[1].sectionId)).toBe(
        true,
      );
      expect(anchors.some((a) => a.sectionId === secList[3].sectionId)).toBe(
        true,
      );
    });

    // 12. 平行道路抗噪與反向平行車道決策 (0002 北上 vs 0003 南下)
    it("Scenario 12: 反向平行車道抗噪 (0002 北上 vs 0003 南下 準確判定)", () => {
      // 0002 is 國道1號 N (基隆 1.1K -> 基隆端 0.0K), bearing ~40° (Northeast)
      // 0003 is 國道1號 S (基隆 1.1K -> 八堵 2.6K), startPoint is only ~30.38m from 0002 route
      const sec0002 = registry.getSection("0002")!;
      const p1: [number, number] = [
        sec0002.startPoint![0],
        sec0002.startPoint![1],
      ];
      const p2: [number, number] = [sec0002.endPoint![0], sec0002.endPoint![1]];

      const polylineNorth: [number, number][] = [
        p1,
        [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2],
        p2,
      ];

      const maneuvers: NormalizedValhallaManeuver[] = [
        {
          type: 24,
          beginShapeIndex: 0,
          endShapeIndex: 2,
          highway: true,
          streetNames: ["1", "中山高速公路"],
          lengthKm: 1.1,
          timeSec: 55,
          stairs: false,
        },
      ];

      const res = matchLegByFreewayLinearReferencing(polylineNorth, maneuvers);

      // Must correctly identify as Northbound Section 0002, NOT Southbound Section 0003
      expect(res.matchedSectionIds.has("0002")).toBe(true);
      expect(res.matchedSectionIds.has("0003")).toBe(false);
      expect(res.segmentSectionIds[0]).toBe("0002");
      expect(res.segmentSectionIds[1]).toBe("0002");

      // Verify that matched section is strictly N direction
      const matchedMeta = registry.getSection(res.segmentSectionIds[0]!);
      expect(matchedMeta?.roadDirection).toBe("N");
    });

    it("Scenario 13: 缺少 maneuvers 或無 freeway 屬性時優雅降級為空結果", () => {
      const polyline: [number, number][] = [
        [121.5, 25.04],
        [121.51, 25.04],
      ];
      // Empty maneuvers
      const resEmpty = matchLegByFreewayLinearReferencing(polyline, []);
      expect(resEmpty.coveredSegmentCount).toBe(0);
      expect(resEmpty.matchedSectionIds.size).toBe(0);

      // Non-highway local street maneuver
      const resLocal = matchLegByFreewayLinearReferencing(polyline, [
        {
          type: 10,
          beginShapeIndex: 0,
          endShapeIndex: 1,
          highway: false,
          streetNames: ["忠孝東路"],
          lengthKm: 1.0,
          timeSec: 100,
          stairs: false,
        },
      ]);
      expect(resLocal.coveredSegmentCount).toBe(0);
      expect(resLocal.segmentSectionIds[0]).toBeNull();
    });
  });
});
