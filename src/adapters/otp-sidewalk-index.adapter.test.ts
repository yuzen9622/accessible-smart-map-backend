import { afterEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { AccessibleRoute } from "../types/route";
import {
  matchCrossings,
  matchSidewalkSegments,
  OtpSidewalkIndexSchema,
  type IndexedCrossing,
} from "./otp-sidewalk-index.adapter";

describe("mapped sidewalk intervals", () => {
  it("does not paint unknown endpoints when only the middle is mapped", () => {
    expect(
      matchSidewalkSegments(
        [
          [121, 25],
          [121.0001, 25],
        ],
        [["sidewalk", 121.00002, 25, 121.00008, 25, 1]],
      ),
    ).toEqual([]);
  });
  it("accepts parallel sidewalk sources that both describe the stretch", () => {
    expect(
      matchSidewalkSegments(
        [
          [121, 25],
          [121.0001, 25],
        ],
        [
          ["sidewalk", 121, 24.9999955, 121.0001, 24.9999955, 1],
          ["sidewalk", 121, 25.0000045, 121.0001, 25.0000045, 2],
        ],
      ),
    ).toEqual([{ startIndex: 0, endIndex: 1 }]);
  });
  it("accepts continuous fragments of the same source without adding route points", () => {
    expect(
      matchSidewalkSegments(
        [
          [121, 25],
          [121.0001, 25],
        ],
        [
          ["sidewalk", 121, 25, 121.00005, 25, 1],
          ["sidewalk", 121.00005, 25, 121.0001, 25, 1],
        ],
      ),
    ).toEqual([{ startIndex: 0, endIndex: 1 }]);
  });
  it("does not color known indoor or stairs intervals with outdoor evidence", () => {
    expect(
      matchSidewalkSegments(
        [
          [121, 25],
          [121.0001, 25],
        ],
        [["sidewalk", 121, 25, 121.0001, 25, 1]],
        [{ startIndex: 0, endIndex: 1 }],
      ),
    ).toEqual([]);
  });
  it("rejects corrupt long or out-of-range segments before creating a spatial grid", () => {
    for (const segment of [
      ["sidewalk", -180, -90, 180, 90, 1],
      ["sidewalk", 181, 25, 181.0001, 25, 1],
      ["sidewalk", 121, 25, 121.1, 25, 1],
    ])
      expect(
        OtpSidewalkIndexSchema.safeParse({
          version: 1,
          sourcePbfSha256: "a".repeat(64),
          segments: [segment],
        }).success,
      ).toBe(false);
  });
  it("keeps original indexes and merges adjacent sidewalk intervals", () => {
    const points: [number, number][] = [
      [121, 25],
      [121.0001, 25],
      [121.0002, 25],
      [121.0003, 25],
    ];
    expect(
      matchSidewalkSegments(points, [["sidewalk", 121, 25, 121.0002, 25, 0]]),
    ).toEqual([{ startIndex: 0, endIndex: 2 }]);
    expect(points).toEqual([
      [121, 25],
      [121.0001, 25],
      [121.0002, 25],
      [121.0003, 25],
    ]);
  });
  it("leaves a road blue even with a mapped sidewalk beside it", () => {
    expect(
      matchSidewalkSegments(
        [
          [121, 25],
          [121.001, 25],
        ],
        [
          ["sidewalk", 121, 25.00006, 121.001, 25.00006, 0],
          ["other", 121, 25, 121.001, 25, 100],
        ],
      ),
    ).toEqual([]);
  });
  it("does not claim ambiguous overlapping road and sidewalk geometry", () => {
    expect(
      matchSidewalkSegments(
        [
          [121, 25],
          [121.001, 25],
        ],
        [
          ["sidewalk", 121, 25, 121.001, 25, 0],
          ["other", 121, 25, 121.001, 25, 100],
        ],
      ),
    ).toEqual([]);
  });
  it("does not span an unmapped crossing between mapped sidewalks", () => {
    const points: [number, number][] = [
      [121, 25],
      [121.0001, 25],
      [121.0002, 25],
      [121.0003, 25],
    ];
    expect(
      matchSidewalkSegments(points, [
        ["sidewalk", 121, 25, 121.0001, 25, 0],
        ["sidewalk", 121.0002, 25, 121.0003, 25, 0],
        ["other", 121.0001, 25, 121.0002, 25, 100],
      ]),
    ).toEqual([
      { startIndex: 0, endIndex: 1 },
      { startIndex: 2, endIndex: 3 },
    ]);
  });
  it("tolerates polyline quantization at sidewalk joins", () => {
    // OTP rounds vertices to 1e-5°: the turn vertex lands ~0.5 m past both
    // mapped ends, and a connector starting at the join touches the leg.
    expect(
      matchSidewalkSegments(
        [
          [121, 25],
          [121.0001, 25],
          [121.0001, 25.0001],
        ],
        [
          ["sidewalk", 121, 25, 121.000095, 25, 1],
          ["sidewalk", 121.000095, 25, 121.000095, 25.0001, 2],
          ["other", 121.000095, 25, 121.0002, 25, 100],
        ],
      ),
    ).toEqual([{ startIndex: 0, endIndex: 2 }]);
  });
  it("keeps an unproven corner blue without dropping its neighbours", () => {
    expect(
      matchSidewalkSegments(
        [
          [121, 25],
          [121.0001, 25],
          [121.0002, 25],
          [121.0003, 25],
        ],
        [
          ["sidewalk", 121, 25, 121.0001, 25, 0],
          ["sidewalk", 121.0002, 25, 121.0003, 25, 1],
          ["other", 121.000095, 25, 121.000205, 25, 100],
        ],
      ),
    ).toEqual([
      { startIndex: 0, endIndex: 1 },
      { startIndex: 2, endIndex: 3 },
    ]);
  });
  it("leaves missing evidence and zero-length intervals blue", () => {
    expect(
      matchSidewalkSegments(
        [
          [121, 25],
          [121.001, 25],
        ],
        [],
      ),
    ).toEqual([]);
    expect(
      matchSidewalkSegments(
        [
          [121, 25],
          [121, 25],
        ],
        [["sidewalk", 121, 25, 121.001, 25, 0]],
      ),
    ).toEqual([]);
  });
});

describe("deployed index provenance", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    vi.restoreAllMocks();
  });
  it.each(["matched", "mismatched", "indoor"])(
    "keeps %s provenance and indoor bounds honest",
    async (variant) => {
      const dir = await mkdtemp(join(tmpdir(), "sidewalk-index-test-"));
      try {
        const source = "bound source fixture";
        await writeFile(join(dir, "taiwan-otp.osm.pbf"), source);
        await writeFile(
          join(dir, "sidewalk-index.json"),
          JSON.stringify({
            version: 1,
            sourcePbfSha256:
              variant === "mismatched"
                ? "a".repeat(64)
                : createHash("sha256").update(source).digest("hex"),
            segments: [["sidewalk", 121, 25, 121.0001, 25, 1]],
          }),
        );
        vi.stubEnv("OTP_SIDEWALK_INDEX_PATH", join(dir, "sidewalk-index.json"));
        vi.resetModules();
        const { annotateSidewalkSegments } =
          await import("./otp-sidewalk-index.adapter");
        const route: AccessibleRoute = {
          routeId: "test",
          routeName: "walk",
          totalMinutes: 1,
          transferCount: 0,
          accessibilityHighlights: [],
          legs: [
            {
              type: "WALK",
              from: "a",
              to: "b",
              distanceM: 10,
              minutesEst: 1,
              polyline: [
                [121, 25],
                [121.0001, 25],
              ],
              a11yFacilities: [],
              maxSlopePercent: null,
              crossings: null,
              crossingsWithCurbRamp: null,
              minPathWidthCm: null,
              surfaceType: "unknown",
              restPoints: [],
              ...(variant === "indoor"
                ? {
                    a11ySegments: [
                      {
                        startIndex: 0,
                        endIndex: 1,
                        feature: "stairs",
                        indoor: true,
                        distanceM: 10,
                        maxSlopePercent: null,
                        minWidthCm: null,
                      },
                    ],
                  }
                : {}),
            },
          ],
        };
        await annotateSidewalkSegments([route]);
        expect(route.legs[0]).toHaveProperty(
          "sidewalkSegments",
          variant === "matched" ? [{ startIndex: 0, endIndex: 1 }] : [],
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});

// A 12 m crossing running north from (121, 25).
const CROSSING: IndexedCrossing = [
  7,
  1,
  1,
  0,
  [
    [121, 25],
    [121, 25.000108],
  ],
];

describe("classified crossings (index v2)", () => {
  it("matches a leg that walks across the crossing", () => {
    expect(
      matchCrossings(
        [
          [120.9999, 24.99998],
          [121.00001, 25.00001],
          [121.00001, 25.0001],
          [121.0001, 25.00012],
        ],
        [CROSSING],
      ).map(([wayId]) => wayId),
    ).toEqual([7]);
  });

  it("matches a crossing in the middle of a long two-point leg", () => {
    // 2.2 km straight north through the crossing, no vertex near it.
    expect(
      matchCrossings(
        [
          [121, 24.99],
          [121, 25.01],
        ],
        [CROSSING],
      ).map(([wayId]) => wayId),
    ).toEqual([7]);
  });

  it("does not match a leg that only walks past one end", () => {
    expect(
      matchCrossings(
        [
          [120.9995, 24.99999],
          [121.0005, 24.99999],
        ],
        [CROSSING],
      ),
    ).toEqual([]);
  });

  it("counts a crossing once even when its way is reached from many points", () => {
    const polyline: [number, number][] = [];
    for (let i = 0; i <= 10; i++)
      polyline.push([121, 25 + (i * 0.000108) / 10]);
    expect(matchCrossings(polyline, [CROSSING])).toHaveLength(1);
  });

  it("accepts v1 without crossings and rejects malformed crossing rows", () => {
    const base = { sourcePbfSha256: "a".repeat(64), segments: [] };
    expect(
      OtpSidewalkIndexSchema.safeParse({ ...base, version: 1 }).success,
    ).toBe(true);
    expect(
      OtpSidewalkIndexSchema.safeParse({
        ...base,
        version: 2,
        crossings: [CROSSING],
      }).success,
    ).toBe(true);
    expect(
      OtpSidewalkIndexSchema.safeParse({ ...base, version: 2 }).success,
    ).toBe(false);
    for (const bad of [
      [7, 2, 1, 0, CROSSING[4]],
      [7, 1, 1, 0, [[121, 25]]],
      [-1, 1, 1, 0, CROSSING[4]],
    ]) {
      expect(
        OtpSidewalkIndexSchema.safeParse({
          ...base,
          version: 2,
          crossings: [bad],
        }).success,
      ).toBe(false);
    }
  });
});

describe("index reload after a failed load", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    vi.useRealTimers();
  });

  it("retries an unchanged but now readable index after the retry interval", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sidewalk-index-retry-"));
    try {
      const source = "pbf fixture";
      const sha = createHash("sha256").update(source).digest("hex");
      await writeFile(join(dir, "taiwan-otp.osm.pbf"), source);
      const indexFile = join(dir, "sidewalk-index.json");
      await writeFile(
        indexFile,
        JSON.stringify({
          version: 2,
          sourcePbfSha256: sha,
          segments: [],
          crossings: [CROSSING],
        }),
      );
      await chmod(indexFile, 0o000);
      vi.stubEnv("OTP_SIDEWALK_INDEX_PATH", indexFile);
      vi.resetModules();
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const adapter = await import("./otp-sidewalk-index.adapter");
      const route = () => {
        const r = {
          routeId: "r",
          routeName: "walk",
          totalMinutes: 1,
          transferCount: 0,
          accessibilityHighlights: [],
          legs: [
            {
              type: "WALK",
              from: "a",
              to: "b",
              distanceM: 12,
              minutesEst: 1,
              polyline: [
                [121, 24.99999],
                [121, 25.00011],
              ],
              a11yFacilities: [],
              maxSlopePercent: null,
              crossings: null,
              crossingsWithCurbRamp: null,
              minPathWidthCm: null,
              surfaceType: "unknown",
              restPoints: [],
            },
          ],
        } as AccessibleRoute;
        return r;
      };
      const unreadable = route();
      await adapter.annotateSidewalkSegments([unreadable]);
      expect(unreadable.legs[0]).toMatchObject({ crossings: null });

      await chmod(indexFile, 0o644); // mtime and size unchanged
      const now = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(
        now + adapter.INDEX_RETRY_AFTER_FAILURE_MS + 1,
      );
      const readable = route();
      await adapter.annotateSidewalkSegments([readable]);
      expect(readable.legs[0]).toMatchObject({ crossings: 1 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("crossing evidence on deployed routes", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  function walkRoute(
    engine?: "pedestrian-a11y" | "otp-fallback",
  ): AccessibleRoute {
    return {
      routeId: "test",
      routeName: "walk",
      totalMinutes: 1,
      transferCount: 0,
      accessibilityHighlights: [],
      ...(engine ? { engine } : {}),
      legs: [
        {
          type: "WALK",
          from: "a",
          to: "b",
          distanceM: 12,
          minutesEst: 1,
          polyline: [
            [121, 24.99999],
            [121, 25.00011],
          ],
          a11yFacilities: [],
          maxSlopePercent: null,
          crossings: 3,
          crossingsWithCurbRamp: 3,
          minPathWidthCm: null,
          surfaceType: "unknown",
          restPoints: [],
        },
      ],
    } as AccessibleRoute;
  }

  it("replaces OSM counts on OTP legs, leaves CSR legs, and reloads a new release", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sidewalk-index-crossing-"));
    try {
      const source = "pbf fixture";
      const sha = createHash("sha256").update(source).digest("hex");
      await writeFile(join(dir, "taiwan-otp.osm.pbf"), source);
      const write = (crossings: IndexedCrossing[]) =>
        writeFile(
          join(dir, "sidewalk-index.json"),
          JSON.stringify({
            version: 2,
            sourcePbfSha256: sha,
            segments: [],
            crossings,
          }),
        );
      await write([CROSSING]);
      vi.stubEnv("OTP_SIDEWALK_INDEX_PATH", join(dir, "sidewalk-index.json"));
      vi.resetModules();
      const { annotateSidewalkSegments } =
        await import("./otp-sidewalk-index.adapter");

      const transit = walkRoute();
      const otpWalk = walkRoute("otp-fallback");
      const csr = walkRoute("pedestrian-a11y");
      await annotateSidewalkSegments([transit, otpWalk, csr]);
      for (const route of [transit, otpWalk]) {
        expect(route.legs[0]).toMatchObject({
          crossings: 1,
          crossingsWithCurbRamp: 0,
        });
      }
      expect(csr.legs[0]).toMatchObject({
        crossings: 3,
        crossingsWithCurbRamp: 3,
      });

      await new Promise((resolve) => setTimeout(resolve, 20));
      await write([
        [7, 2, 0, 0, CROSSING[4]],
        [
          8,
          0,
          1,
          1,
          [
            [122, 25],
            [122, 25.0001],
          ],
        ],
      ]);
      const next = walkRoute();
      await annotateSidewalkSegments([next]);
      expect(next.legs[0]).toMatchObject({
        crossings: 1,
        crossingsWithCurbRamp: 1,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
