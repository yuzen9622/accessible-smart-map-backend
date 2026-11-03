import { describe, expect, it } from "vitest";
import {
  matchBusShape,
  trimBusShape,
  normalizeBusShapes,
  shapeWktToPath,
  type BusShape,
} from "./bus-shape";

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
    expect(matchBusShape(target, shapes, [target], [])).toBe(pathB);
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
    expect(matchBusShape(target, shapes, siblings, [])).toBe(pathA);
  });

  describe("同 RouteUID 同方向有多條子路線", () => {
    const target = { routeUid: "TPE1", subRouteUid: "TPE11", direction: 0 };
    const siblings = [
      target,
      { routeUid: "TPE1", subRouteUid: "TPE12", direction: 0 },
    ];
    const onA: [number, number][] = [
      [120.62, 24.12],
      [120.68, 24.18],
    ];

    it("本身站點沿著唯一一條路線線形時採用", () => {
      const shapes: BusShape[] = [
        { routeUid: "TPE1", direction: 0, path: pathA },
        { routeUid: "TPE1", direction: 0, path: pathB },
      ];
      const path = matchBusShape(target, shapes, siblings, onA)!;
      // Trimmed to the branch's own stops, not the shared full shape.
      expect(path[0][0]).toBeCloseTo(120.62);
      expect(path.at(-1)![0]).toBeCloseTo(120.68);
    });

    it("站點不沿著線形時不猜，回 null", () => {
      const shapes: BusShape[] = [
        { routeUid: "TPE1", direction: 0, path: pathA },
      ];
      expect(
        matchBusShape(target, shapes, siblings, [
          [121.52, 25.02],
          [121.58, 25.08],
        ]),
      ).toBeNull();
    });

    it("兩條路線線形都吻合時不猜，回 null", () => {
      const shapes: BusShape[] = [
        { routeUid: "TPE1", direction: 0, path: pathA },
        { routeUid: "TPE1", direction: 0, path: [...pathA] },
      ];
      expect(matchBusShape(target, shapes, siblings, onA)).toBeNull();
    });
  });

  it("線形帶 SubRouteUID 但對不上時，不退回 RouteUID 硬掛", () => {
    const shapes: BusShape[] = [
      { routeUid: "TXG99", subRouteUid: "TXG99", direction: 0, path: pathA },
    ];
    const target = { routeUid: "TXG99", subRouteUid: "TXG991", direction: 0 };
    expect(matchBusShape(target, shapes, [target], [])).toBeNull();
  });
});

describe("trimBusShape", () => {
  const road: [number, number][] = [
    [121, 25],
    [121.01, 25],
    [121.01, 25.01],
    [121.02, 25.01],
  ];
  it("preserves both road turns while trimming the unused prefix and suffix", () => {
    const result = trimBusShape(road, [
      [121.005, 25.00001],
      [121.01, 25.005],
      [121.015, 25.01001],
    ]);
    expect(result).not.toBeNull();
    expect(result!.slice(1, -1)).toEqual([
      [121.01, 25],
      [121.01, 25.01],
    ]);
    expect(result![0][0]).toBeCloseTo(121.005);
    expect(result!.at(-1)![0]).toBeCloseTo(121.015);
  });
  it("rejects reversed stops or distant branch geometry", () => {
    expect(
      trimBusShape(road, [
        [121.015, 25.01],
        [121.005, 25],
      ]),
    ).toBeNull();
    expect(
      trimBusShape(road, [
        [120, 24],
        [120.1, 24.1],
      ]),
    ).toBeNull();
  });
  it("matches a stop on the outbound pass when the return pass is nearer", () => {
    // Out along y=25, back along y=25.0003 (~33 m north): a stop 25 m north
    // of the outbound road is nearest the return pass.
    const outAndBack: [number, number][] = [
      [121, 25],
      [121.02, 25],
      [121.02, 25.0003],
      [121, 25.0003],
    ];
    const result = trimBusShape(outAndBack, [
      [121.001, 25],
      [121.005, 25.000225],
      [121.015, 25],
      [121.005, 25.0003],
    ]);
    expect(result).not.toBeNull();
    expect(result!.slice(1, -1)).toEqual([
      [121.02, 25],
      [121.02, 25.0003],
    ]);
  });
  it("passes an intermediate loop stop before the repeated terminus", () => {
    const loop: [number, number][] = [
      [121, 25],
      [121.01, 25],
      [121.01, 25.01],
      [121, 25],
    ];
    expect(
      trimBusShape(loop, [
        [121, 25],
        [121.01, 25],
        [121.01, 25.01],
        [121, 25],
      ]),
    ).toEqual(loop);
  });
});
