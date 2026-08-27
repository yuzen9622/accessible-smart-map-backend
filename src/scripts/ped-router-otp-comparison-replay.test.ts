import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  REPLAY_COORDINATE_TOLERANCE_DEG,
  parseReplayPairs,
  readReplayPairsFile,
  resolveReplayPairs,
  type ReplayNodeSource,
} from "./ped-router-otp-comparison-replay";

const outcome = (
  index: number,
  from: [number, number],
  to: [number, number],
  extra: Record<string, unknown> = {},
) => ({
  index,
  from: { node: 0, lat: from[0], lon: from[1] },
  to: { node: 1, lat: to[0], lon: to[1] },
  ours: { status: "no_route" },
  ...extra,
});

const graph = (points: [number, number][]): ReplayNodeSource => ({
  nodeCount: points.length,
  nodeLat: Float64Array.from(points.map(([lat]) => lat)),
  nodeLon: Float64Array.from(points.map(([, lon]) => lon)),
});

const written: string[] = [];

afterEach(() => {
  for (const file of written.splice(0)) fs.rmSync(file, { force: true });
});

function writeTemp(contents: string): string {
  const file = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "replay-")),
    "pairs.json",
  );
  fs.writeFileSync(file, contents);
  written.push(file);
  return file;
}

describe("parseReplayPairs", () => {
  it("keeps every outcome in the original order with its case id", () => {
    const pairs = parseReplayPairs({
      outcomes: [
        outcome(0, [25.0, 121.5], [25.01, 121.51]),
        outcome(7, [25.02, 121.52], [25.03, 121.53]),
      ],
    });
    expect(pairs.map((pair) => pair.sourceIndex)).toEqual([0, 7]);
    expect(pairs[1].from).toEqual({ lat: 25.02, lon: 121.52 });
  });

  it("prefers sourceIndex so a replay of a replay keeps the original case id", () => {
    const pairs = parseReplayPairs({
      outcomes: [
        outcome(0, [25.0, 121.5], [25.01, 121.51], { sourceIndex: 140 }),
      ],
    });
    expect(pairs[0].sourceIndex).toBe(140);
  });

  it("rejects a document without outcomes", () => {
    expect(() => parseReplayPairs({ outcomes: [] })).toThrow(/no outcomes/);
    expect(() => parseReplayPairs(null)).toThrow(/comparison document/);
  });

  it("rejects an outcome with a non-finite coordinate", () => {
    const broken = outcome(3, [25.0, 121.5], [25.01, 121.51]);
    broken.to = { node: 1, lat: Number.NaN, lon: 121.51 };
    expect(() => parseReplayPairs({ outcomes: [broken] })).toThrow(
      /no finite coordinate/,
    );
  });
});

describe("readReplayPairsFile", () => {
  it("reads a comparison file from disk", () => {
    const file = writeTemp(
      JSON.stringify({
        outcomes: [outcome(9, [25.0, 121.5], [25.01, 121.51])],
      }),
    );
    expect(readReplayPairsFile(file)[0].sourceIndex).toBe(9);
  });

  it("reports unreadable and malformed inputs as one clear error", () => {
    expect(() => readReplayPairsFile(writeTemp("{not json"))).toThrow(
      /unable to read pairs input/,
    );
  });
});

describe("resolveReplayPairs", () => {
  const nodes = graph([
    [25.0, 121.5],
    [25.01, 121.51],
    [25.02, 121.52],
  ]);

  it("resolves exact coordinates to their nodes, preserving order and case ids", () => {
    const resolved = resolveReplayPairs(nodes, [
      {
        sourceIndex: 22,
        from: { lat: 25.02, lon: 121.52 },
        to: { lat: 25.0, lon: 121.5 },
      },
      {
        sourceIndex: 7,
        from: { lat: 25.0, lon: 121.5 },
        to: { lat: 25.01, lon: 121.51 },
      },
    ]);
    expect(resolved).toEqual([
      { sourceIndex: 22, from: 2, to: 0 },
      { sourceIndex: 7, from: 0, to: 1 },
    ]);
  });

  it("does not nearest-snap a coordinate that no longer exists", () => {
    expect(() =>
      resolveReplayPairs(nodes, [
        {
          sourceIndex: 24,
          from: { lat: 25.0000009, lon: 121.5000009 },
          to: { lat: 25.01, lon: 121.51 },
        },
      ]),
    ).toThrow(/matches no node/);
  });

  it("fails closed when two nodes share the coordinate", () => {
    const duplicated = graph([
      [25.0, 121.5],
      [25.01, 121.51],
      [25.01, 121.51],
    ]);
    expect(() =>
      resolveReplayPairs(duplicated, [
        {
          sourceIndex: 29,
          from: { lat: 25.01, lon: 121.51 },
          to: { lat: 25.0, lon: 121.5 },
        },
      ]),
    ).toThrow(/ambiguous/);
  });

  it("rejects a pair whose endpoints collapse onto one node", () => {
    expect(() =>
      resolveReplayPairs(nodes, [
        {
          sourceIndex: 89,
          from: { lat: 25.0, lon: 121.5 },
          to: { lat: 25.0, lon: 121.5 },
        },
      ]),
    ).toThrow(/both endpoints/);
  });

  it("accepts a coordinate inside the tolerance and rejects one just outside", () => {
    const inside = REPLAY_COORDINATE_TOLERANCE_DEG / 2;
    const outside = REPLAY_COORDINATE_TOLERANCE_DEG * 10;
    const pair = (offset: number) => [
      {
        sourceIndex: 127,
        from: { lat: 25.0 + offset, lon: 121.5 },
        to: { lat: 25.01, lon: 121.51 },
      },
    ];
    expect(resolveReplayPairs(nodes, pair(inside))[0].from).toBe(0);
    expect(() => resolveReplayPairs(nodes, pair(outside))).toThrow(
      /matches no node/,
    );
  });
});
