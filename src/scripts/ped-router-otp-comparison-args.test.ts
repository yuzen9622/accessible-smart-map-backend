import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseArgs } from "./ped-router-otp-comparison";

const DB_URL = "postgresql://user:pass@localhost:5432/ped";

let savedDbUrl: string | undefined;

beforeEach(() => {
  savedDbUrl = process.env.PED_GRAPH_DATABASE_URL;
  process.env.PED_GRAPH_DATABASE_URL = DB_URL;
});

afterEach(() => {
  if (savedDbUrl === undefined) delete process.env.PED_GRAPH_DATABASE_URL;
  else process.env.PED_GRAPH_DATABASE_URL = savedDbUrl;
});

describe("parseArgs", () => {
  it("reads a replay path from a separated value", () => {
    expect(parseArgs(["--pairs-input", "/tmp/pairs.json"]).pairsInput).toBe(
      "/tmp/pairs.json",
    );
  });

  it("reads a replay path from an inline value", () => {
    expect(parseArgs(["--pairs-input=/tmp/pairs.json"]).pairsInput).toBe(
      "/tmp/pairs.json",
    );
  });

  it("throws instead of silently sampling when --pairs-input trails the argv", () => {
    // The dangerous shape: a lost value used to leave pairsInput undefined, which
    // switched the run back to seeded sampling under the replay's name.
    expect(() => parseArgs(["--pairs-input"])).toThrow(
      "--pairs-input requires a value",
    );
  });

  it("throws when --pairs-input is given an empty value", () => {
    expect(() => parseArgs(["--pairs-input="])).toThrow(
      "--pairs-input requires a value",
    );
    expect(() => parseArgs(["--pairs-input", ""])).toThrow(
      "--pairs-input requires a value",
    );
  });

  it("throws for every value-taking flag missing its value", () => {
    for (const flag of [
      "--db-url",
      "--otp-url",
      "--seed",
      "--samples",
      "--version-id",
      "--output",
      "--pairs-input",
    ]) {
      expect(() => parseArgs([flag])).toThrow(`${flag} requires a value`);
    }
  });

  it("does not let a value-less flag swallow the next flag as its value", () => {
    expect(() => parseArgs(["--seed", "--pairs-input", "/tmp/p.json"])).toThrow(
      "--seed requires a value",
    );
  });

  it("rejects every double-dash token as a separated value but accepts negative numbers", () => {
    for (const nextArgument of ["--unknown", "--otp-url=http://otp.example"])
      expect(() => parseArgs(["--seed", nextArgument])).toThrow(
        "--seed requires a value",
      );

    expect(parseArgs(["--seed", "-1"]).seed).toBe(-1);
  });

  it("rejects an unknown argument rather than ignoring it", () => {
    expect(() => parseArgs(["--pairs-imput", "/tmp/p.json"])).toThrow(
      "unknown argument --pairs-imput",
    );
  });

  it("keeps everything after the first = in an inline value", () => {
    const options = parseArgs([
      "--db-url=postgresql://u:p@h:5432/db?sslmode=require",
    ]);
    expect(options.dbUrl).toBe("postgresql://u:p@h:5432/db?sslmode=require");
  });

  it("leaves the seeded sampling defaults alone when no replay is requested", () => {
    const options = parseArgs(["--version-id", "1"]);
    expect(options.pairsInput).toBeUndefined();
    expect(options.versionId).toBe(1);
    expect(options.dbUrl).toBe(DB_URL);
  });

  it("rejects non-integer numeric options", () => {
    expect(() => parseArgs(["--samples", "0"])).toThrow(
      "--samples must be a positive integer",
    );
    expect(() => parseArgs(["--version-id", "1.5"])).toThrow(
      "--version-id must be an integer",
    );
  });
});
