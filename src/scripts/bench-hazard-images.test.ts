import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { inflateSync } from "node:zlib";
import { blankPng, summarize } from "./bench-hazard-images.mjs";

function sample(
  id: string,
  group: string,
  verdict: string,
  expected: string[],
  durationMs = 10,
) {
  return {
    id,
    group,
    verdict,
    expected,
    durationMs,
    repeat: 1,
    reason: "test",
    prefilter: undefined,
  };
}

describe("hazard image benchmark accounting", () => {
  it("keeps service failures in the semantic denominator", () => {
    const result = summarize([
      sample("match", "positive", "verified", ["verified"]),
      sample("failed", "positive", "skipped", ["verified"]),
    ]);
    expect(result.semanticAvailability).toEqual({
      numerator: 1,
      denominator: 2,
    });
    expect(result.expectedVerdictAllSemantic).toEqual({
      numerator: 1,
      denominator: 2,
    });
    expect(result.expectedVerdictCompletedOnly).toEqual({
      numerator: 1,
      denominator: 1,
    });
    expect(result.obstacleRecall).toEqual({ numerator: 1, denominator: 2 });
  });

  it("counts accepting a false claim as a failure even with high confidence", () => {
    const result = summarize([
      {
        ...sample("false", "negative", "verified", ["suspicious", "rejected"]),
        confidence: 1,
      },
      sample("unknown", "negative", "suspicious", ["suspicious", "rejected"]),
    ]);
    expect(result.falseAcceptance).toEqual({ numerator: 1, denominator: 2 });
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].id).toBe("false");
  });

  it("does not count expected corrupt-image skips as recognition success", () => {
    const result = summarize([
      sample("bad-bytes", "robustness", "skipped", ["skipped"]),
    ]);
    expect(result.robustnessExpected).toEqual({ numerator: 1, denominator: 1 });
    expect(result.semanticAvailability).toEqual({
      numerator: 0,
      denominator: 0,
    });
    expect(result.expectedVerdictAllSemantic).toEqual({
      numerator: 0,
      denominator: 0,
    });
  });

  it("measures consistency per repeated case and uses measured latency", () => {
    const result = summarize([
      sample("A", "positive", "verified", ["verified"], 10),
      { ...sample("A", "positive", "suspicious", ["verified"], 30), repeat: 2 },
      sample("B", "negative", "rejected", ["rejected"], 20),
      { ...sample("B", "negative", "rejected", ["rejected"], 40), repeat: 2 },
    ]);
    expect(result.repeatConsistency).toEqual({ numerator: 1, denominator: 2 });
    expect(result.durationMs).toEqual({ median: 20, p95: 40, max: 40 });
  });

  it("generates decodable black PNG pixels instead of mislabeled dummy bytes", () => {
    const png = blankPng();
    expect(png.subarray(0, 8)).toEqual(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    expect(png.readUInt32BE(16)).toBe(32);
    expect(png.readUInt32BE(20)).toBe(32);
    const idatLength = png.readUInt32BE(33);
    expect(png.subarray(37, 41).toString()).toBe("IDAT");
    expect(inflateSync(png.subarray(41, 41 + idatLength))).toEqual(
      Buffer.alloc(32 * 33),
    );
  });

  it("refuses live execution before any image read or provider call without --live", () => {
    const result = spawnSync(
      process.execPath,
      [
        "src/scripts/bench-hazard-images.mjs",
        "live",
        "/nonexistent-benchmark-input",
      ],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--live is required");
    expect(result.stdout).toBe("");
  });
});
