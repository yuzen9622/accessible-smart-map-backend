import { describe, expect, it } from "vitest";
import {
  DEFAULT_TDX_GAP_SECONDS,
  dependencySkipReason,
  findStepBlockers,
  parseSyncArgs,
  selectSteps,
  SYNC_STEPS,
  syncExitCode,
  type StepStatus,
  type SyncStep,
} from "./sync-all-data-plan";

function ids(steps: readonly SyncStep[]): string[] {
  return steps.map((s) => s.id);
}

function select(argv: string[]): string[] {
  return ids(selectSteps(SYNC_STEPS, parseSyncArgs(argv)));
}

describe("SYNC_STEPS registry", () => {
  it("has unique ids", () => {
    const all = ids(SYNC_STEPS);
    expect(new Set(all).size).toBe(all.length);
  });

  it("lists every dependency before its dependent", () => {
    SYNC_STEPS.forEach((step, index) => {
      for (const dep of step.dependsOn ?? []) {
        const depIndex = SYNC_STEPS.findIndex((s) => s.id === dep);
        expect(depIndex, `${step.id} → ${dep}`).toBeGreaterThanOrEqual(0);
        expect(depIndex, `${step.id} → ${dep}`).toBeLessThan(index);
      }
    });
  });

  it("imports GTFS as four separate steps, not via gtfs-all", () => {
    const gtfs = ids(SYNC_STEPS).filter((id) => id.startsWith("gtfs-"));
    expect(gtfs).toEqual([
      "gtfs-levels",
      "gtfs-stops",
      "gtfs-trips",
      "gtfs-pathways",
    ]);
    expect(SYNC_STEPS.some((s) => s.command.includes("import:gtfs-all"))).toBe(
      false,
    );
  });

  it("rebuilds the traffic map and tar after new Valhalla tiles", () => {
    const order = ids(SYNC_STEPS);
    expect(order.indexOf("valhalla-tiles")).toBeLessThan(
      order.indexOf("traffic-map"),
    );
    expect(order.indexOf("traffic-map")).toBeLessThan(
      order.indexOf("traffic-tar"),
    );
  });

  it("keeps every collection-wiping step out of the default group", () => {
    for (const id of ["a11y-metro", "bathrooms", "campus-a11y", "welfare"]) {
      expect(SYNC_STEPS.find((s) => s.id === id)?.group).not.toBe("base");
    }
  });
});

describe("parseSyncArgs", () => {
  it("defaults to the base group only", () => {
    const options = parseSyncArgs([]);
    expect([...options.groups]).toEqual(["base"]);
    expect(options.planOnly).toBe(false);
    expect(options.failFast).toBe(false);
    expect(options.tdxGapSeconds).toBe(DEFAULT_TDX_GAP_SECONDS);
  });

  it("enables opt-in groups by flag", () => {
    const options = parseSyncArgs(["--with-valhalla", "--with-paid"]);
    expect([...options.groups].sort()).toEqual(["base", "paid", "valhalla"]);
  });

  it("--all enables every group", () => {
    expect([...parseSyncArgs(["--all"]).groups].sort()).toEqual([
      "base",
      "paid",
      "slow",
      "snapshot",
      "valhalla",
    ]);
  });

  it("parses only/skip lists, plan, fail-fast and tdx gap", () => {
    const options = parseSyncArgs([
      "--",
      "--only=tdx-tra, tdx-thsr",
      "--skip=osm",
      "--plan",
      "--fail-fast",
      "--tdx-gap=0",
    ]);
    expect(options.only).toEqual(["tdx-tra", "tdx-thsr"]);
    expect(options.skip).toEqual(["osm"]);
    expect(options.planOnly).toBe(true);
    expect(options.failFast).toBe(true);
    expect(options.tdxGapSeconds).toBe(0);
  });

  it("merges repeated --only / --skip flags", () => {
    const options = parseSyncArgs(["--skip=osm", "--skip=tdx-tra"]);
    expect(options.skip).toEqual(["osm", "tdx-tra"]);
  });

  it("rejects unknown flags and bad gaps", () => {
    expect(() => parseSyncArgs(["--with-everything"])).toThrow(/unknown/);
    expect(() => parseSyncArgs(["--tdx-gap=-1"])).toThrow(/tdx-gap/);
    expect(() => parseSyncArgs(["--tdx-gap=abc"])).toThrow(/tdx-gap/);
  });
});

describe("selectSteps", () => {
  it("default selects only base steps, in registry order", () => {
    const selected = select([]);
    const base = ids(SYNC_STEPS.filter((s) => s.group === "base"));
    expect(selected).toEqual(base);
    expect(selected).toContain("taipei-ramps");
    expect(selected).not.toContain("valhalla-tiles");
    expect(selected).not.toContain("rag");
  });

  it("--all selects every step", () => {
    expect(select(["--all"])).toEqual(ids(SYNC_STEPS));
  });

  it("--only picks ids across groups and ignores group flags", () => {
    expect(select(["--only=rag,tdx-tra"])).toEqual(["tdx-tra", "rag"]);
  });

  it("rejects unknown ids in --only and --skip", () => {
    expect(() => select(["--only=nope"])).toThrow(/unknown step id: nope/);
    expect(() => select(["--skip=nope"])).toThrow(/unknown step id: nope/);
  });

  it("rejects a selected step whose dependency is not selected", () => {
    expect(() => select(["--only=campus-facility-detail"])).toThrow(
      /depends on "campus-a11y"/,
    );
    expect(() =>
      select(["--with-valhalla", "--skip=traffic-sections"]),
    ).toThrow(/"traffic-map" depends on "traffic-sections"/);
  });

  it("allows skipping a dependency together with its dependents", () => {
    const selected = select([
      "--with-valhalla",
      "--skip=valhalla-tiles,traffic-map,traffic-tar",
    ]);
    expect(selected).toContain("valhalla-pbf");
    expect(selected).not.toContain("traffic-map");
  });
});

describe("findStepBlockers", () => {
  const step: SyncStep = {
    id: "x",
    group: "base",
    command: ["true"],
    backends: [],
    requiredEnv: ["A", "B"],
    requiredFiles: ["data/x.csv"],
  };

  it("reports every missing env var and file", () => {
    expect(findStepBlockers(step, { A: "1", B: "" }, () => false)).toEqual([
      "env B is not set",
      "missing data/x.csv",
    ]);
  });

  it("returns nothing when all preconditions hold", () => {
    expect(findStepBlockers(step, { A: "1", B: "2" }, () => true)).toEqual([]);
  });
});

describe("dependency status and exit code", () => {
  const step: SyncStep = {
    id: "child",
    group: "base",
    command: ["true"],
    backends: [],
    dependsOn: ["parent"],
  };

  it("runs a step only when every dependency exited 0", () => {
    expect(
      dependencySkipReason(step, new Map([["parent", "EXITED_0"]])),
    ).toBeNull();
    expect(dependencySkipReason(step, new Map([["parent", "FAILED"]]))).toBe(
      "dependency parent FAILED",
    );
    expect(
      dependencySkipReason(step, new Map([["parent", "SKIPPED_DEP"]])),
    ).toBe("dependency parent SKIPPED_DEP");
  });

  it("exits 0 only when every step exited 0", () => {
    const ok = new Map<string, StepStatus>([["a", "EXITED_0"]]);
    expect(syncExitCode(ok)).toBe(0);
    expect(syncExitCode(new Map([...ok, ["b", "FAILED"]]))).toBe(1);
    expect(syncExitCode(new Map([...ok, ["b", "SKIPPED_DEP"]]))).toBe(1);
  });
});
