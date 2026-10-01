import { describe, expect, it } from "vitest";
import {
  matchBusShape,
  normalizeBusShapes,
  shapeWktToPath,
  simplifyPath,
  type BusShape,
} from "./bus-shape";

describe("simplifyPath", () => {
  it("刪掉共線的中間點、保留轉折與端點", () => {
    const path: [number, number][] = [
      [121.5, 25.0],
      [121.501, 25.0],
      [121.502, 25.0],
      [121.502, 25.001],
    ];
    expect(simplifyPath(path)).toEqual([
      [121.5, 25.0],
      [121.502, 25.0],
      [121.502, 25.001],
    ]);
  });

  it("偏離超過容許值的點不會被刪", () => {
    const path: [number, number][] = [
      [121.5, 25.0],
      [121.501, 25.0001],
      [121.502, 25.0],
    ];
    expect(simplifyPath(path)).toHaveLength(3);
  });
});

describe("shapeWktToPath", () => {
  it("LINESTRING 直接轉成 [lng, lat]", () => {
    expect(shapeWktToPath("LINESTRING (121.5 25.0, 121.6 25.1)")).toEqual([
      [121.5, 25.0],
      [121.6, 25.1],
    ]);
  });

  it("首尾相接的 MULTILINESTRING 接成一條、不重複接點", () => {
    expect(
      shapeWktToPath(
        "MULTILINESTRING ((121.5 25.0, 121.6 25.0), (121.6 25.0, 121.7 25.0))",
      ),
    ).toEqual([
      [121.5, 25.0],
      [121.6, 25.0],
      [121.7, 25.0],
    ]);
  });

  it("中間斷開的 MULTILINESTRING 拒絕（攤平會畫出幽靈直線）", () => {
    expect(
      shapeWktToPath(
        "MULTILINESTRING ((121.5 25.0, 121.6 25.0), (120.3 22.6, 120.4 22.6))",
      ),
    ).toBeNull();
  });

  it("壞掉或缺漏的幾何回 null", () => {
    expect(shapeWktToPath(undefined)).toBeNull();
    expect(shapeWktToPath("POINT (121.5 25.0)")).toBeNull();
  });
});

describe("normalizeBusShapes", () => {
  it("略過幾何不可用或方向不明的列", () => {
    const shapes = normalizeBusShapes([
      {
        RouteUID: "TPE16111",
        Direction: 0,
        Geometry: "LINESTRING (121.5 25.0, 121.6 25.1)",
      },
      { RouteUID: "TPE16111", Direction: 1, Geometry: "garbage" },
      {
        RouteUID: "TPE16111",
        Direction: 2,
        Geometry: "LINESTRING (121.5 25.0, 121.6 25.1)",
      },
    ]);
    expect(shapes).toEqual([
      {
        routeUid: "TPE16111",
        subRouteUid: undefined,
        direction: 0,
        path: [
          [121.5, 25.0],
          [121.6, 25.1],
        ],
      },
    ]);
  });
});

describe("matchBusShape", () => {
  const pathA: [number, number][] = [
    [120.6, 24.1],
    [120.7, 24.2],
  ];
  const pathB: [number, number][] = [
    [121.5, 25.0],
    [121.6, 25.1],
  ];

  it("優先以 SubRouteUID + 方向精準對應", () => {
    const shapes: BusShape[] = [
      { routeUid: "TXG99", subRouteUid: "TXG99", direction: 0, path: pathA },
      { routeUid: "TXG99", subRouteUid: "TXG991", direction: 0, path: pathB },
    ];
    const target = { routeUid: "TXG99", subRouteUid: "TXG991", direction: 0 };
    expect(matchBusShape(target, shapes, [target])).toBe(pathB);
  });

  it("線形只有 RouteUID（台北）且該方向只有一條子路線時，以 RouteUID 對應", () => {
    const shapes: BusShape[] = [
      { routeUid: "TPE16111", direction: 0, path: pathA },
      { routeUid: "TPE16111", direction: 1, path: pathB },
      { routeUid: "TPE19108", direction: 0, path: pathB },
    ];
    const target = {
      routeUid: "TPE16111",
      subRouteUid: "TPE157463",
      direction: 0,
    };
    const siblings = [
      target,
      { routeUid: "TPE16111", subRouteUid: "TPE157462", direction: 1 },
    ];
    expect(matchBusShape(target, shapes, siblings)).toBe(pathA);
  });

  it("同 RouteUID 同方向有多條子路線時不猜，回 null", () => {
    const shapes: BusShape[] = [
      { routeUid: "TPE1", direction: 0, path: pathA },
    ];
    const target = { routeUid: "TPE1", subRouteUid: "TPE11", direction: 0 };
    const siblings = [
      target,
      { routeUid: "TPE1", subRouteUid: "TPE12", direction: 0 },
    ];
    expect(matchBusShape(target, shapes, siblings)).toBeNull();
  });

  it("線形帶 SubRouteUID 但對不上時，不退回 RouteUID 硬掛", () => {
    const shapes: BusShape[] = [
      { routeUid: "TXG99", subRouteUid: "TXG99", direction: 0, path: pathA },
    ];
    const target = { routeUid: "TXG99", subRouteUid: "TXG991", direction: 0 };
    expect(matchBusShape(target, shapes, [target])).toBeNull();
  });
});
