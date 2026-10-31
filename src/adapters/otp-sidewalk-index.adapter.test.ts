import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { AccessibleRoute } from "../types/route";
import {
  matchSidewalkSegments,
  OtpSidewalkIndexSchema,
} from "./otp-sidewalk-index.adapter";

describe("mapped sidewalk intervals", () => {
  it("does not paint unknown endpoints when only the middle is mapped", () => {
    expect(
      matchSidewalkSegments(
        [
          [121, 25],
          [121.00001, 25],
        ],
        [["sidewalk", 121.000003, 25, 121.000007, 25, 1]],
      ),
    ).toEqual([]);
  });
  it("leaves competing parallel sidewalk sources unclassified", () => {
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
    ).toEqual([]);
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
