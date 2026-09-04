import { describe, expect, it } from "vitest";
import {
  AdvisoryDeduper,
  classifyCorridorFinding,
  selectRerouteTrigger,
  type ClassifyContext,
  type CorridorFinding,
} from "./nav-advisory";

describe("classifyCorridorFinding", () => {
  const ctxElevator: ClassifyContext = {
    requireElevator: true,
    onVehicle: false,
    now: () => "2026-09-04T12:00:00.000Z",
  };
  const ctxNormal: ClassifyContext = {
    requireElevator: false,
    onVehicle: false,
    now: () => "2026-09-04T12:00:00.000Z",
  };

  it("classifies blocking hazard as critical with reroute_applied (H1)", () => {
    const finding: CorridorFinding = {
      category: "hazard",
      hazardId: "h-1",
      hazardType: "obstacle",
      severity: "blocking",
      description: "人行道施工完全封閉",
      location: { latitude: 25.033, longitude: 121.565 },
      distanceAheadM: 120,
    };
    const advisory = classifyCorridorFinding(finding, ctxNormal);
    expect(advisory).toMatchObject({
      advisoryId: "hazard:h-1",
      category: "hazard",
      severity: "critical",
      action: "reroute_applied",
      rerouteReason: "CONFIRMED_HAZARD",
      title: "前方 120 公尺有障礙物回報",
      detail: "人行道施工完全封閉",
    });
    expect(advisory.speech).toContain("正在為你重新規劃路線");
  });

  it("classifies difficult hazard as warning with reroute_suggested (H2)", () => {
    const finding: CorridorFinding = {
      category: "hazard",
      hazardId: "h-2",
      hazardType: "construction",
      severity: "difficult",
      location: { latitude: 25.033, longitude: 121.565 },
      distanceAheadM: 80,
    };
    const advisory = classifyCorridorFinding(finding, ctxNormal);
    expect(advisory).toMatchObject({
      category: "hazard",
      severity: "warning",
      action: "reroute_suggested",
      rerouteReason: "CONFIRMED_HAZARD",
    });
  });

  it("classifies minor hazard as info with action none (H3)", () => {
    const finding: CorridorFinding = {
      category: "hazard",
      hazardId: "h-3",
      hazardType: "data_error",
      severity: "minor",
      location: { latitude: 25.033, longitude: 121.565 },
      distanceAheadM: 0,
    };
    const advisory = classifyCorridorFinding(finding, ctxNormal);
    expect(advisory).toMatchObject({
      category: "hazard",
      severity: "info",
      action: "none",
    });
    expect(advisory.rerouteReason).toBeUndefined();
  });

  it("classifies facility outage as critical when requireElevator is true (F1)", () => {
    const finding: CorridorFinding = {
      category: "facility",
      railSystem: "TRTC",
      stationId: "BL11",
      stationName: "忠孝復興",
      elevatorKey: "elevator-2",
      keyword: "維修",
      description: "2號出口電梯維修中",
    };
    const advisory = classifyCorridorFinding(finding, ctxElevator);
    expect(advisory).toMatchObject({
      advisoryId: "facility:TRTC:BL11:elevator-2",
      category: "facility",
      severity: "critical",
      action: "reroute_applied",
      rerouteReason: "FACILITY_OUTAGE",
    });
  });

  it("classifies facility outage as warning when requireElevator is false (F2)", () => {
    const finding: CorridorFinding = {
      category: "facility",
      railSystem: "TRTC",
      stationId: "BL11",
      stationName: "忠孝復興",
      elevatorKey: "elevator-2",
      keyword: "維修",
      description: "2號出口電梯維修中",
    };
    const advisory = classifyCorridorFinding(finding, ctxNormal);
    expect(advisory).toMatchObject({
      category: "facility",
      severity: "warning",
      action: "reroute_suggested",
      rerouteReason: "FACILITY_OUTAGE",
    });
  });

  it("classifies blocking transit alert before boarding as critical (T1)", () => {
    const finding: CorridorFinding = {
      category: "transit_alert",
      alertId: "alert-1",
      title: "淡水信義線全線暫停營運",
      description: "信義安和段號誌故障",
    };
    const advisory = classifyCorridorFinding(finding, ctxNormal);
    expect(advisory).toMatchObject({
      category: "transit_alert",
      severity: "critical",
      action: "reroute_applied",
      rerouteReason: "TRANSIT_DISRUPTION",
    });
  });

  it("downgrades blocking transit alert to warning if already on vehicle (R1)", () => {
    const finding: CorridorFinding = {
      category: "transit_alert",
      alertId: "alert-1",
      title: "淡水信義線全線暫停營運",
      description: "信義安和段號誌故障",
    };
    const advisory = classifyCorridorFinding(finding, {
      ...ctxNormal,
      onVehicle: true,
    });
    expect(advisory).toMatchObject({
      category: "transit_alert",
      severity: "warning",
      action: "none",
    });
    expect(advisory.speech).toContain("注意");
  });
});

describe("selectRerouteTrigger & AdvisoryDeduper", () => {
  it("prioritizes hazard > facility > transit_alert for critical trigger selection", () => {
    const ctx: ClassifyContext = {
      requireElevator: true,
      onVehicle: false,
      now: () => "2026-09-04T12:00:00.000Z",
    };
    const f1 = classifyCorridorFinding(
      {
        category: "facility",
        railSystem: "TRTC",
        stationId: "BL11",
        stationName: "忠孝復興",
        elevatorKey: "e-1",
        keyword: "故障",
        description: "電梯故障",
      },
      ctx,
    );
    const h1 = classifyCorridorFinding(
      {
        category: "hazard",
        hazardId: "h-1",
        hazardType: "obstacle",
        severity: "blocking",
        location: { latitude: 25.033, longitude: 121.565 },
        distanceAheadM: 50,
      },
      ctx,
    );
    const t1 = classifyCorridorFinding(
      {
        category: "transit_alert",
        alertId: "t-1",
        title: "停駛通告",
        description: "全線停駛",
      },
      ctx,
    );

    const trigger = selectRerouteTrigger([f1, t1, h1]);
    expect(trigger.rerouteReason).toBe("CONFIRMED_HAZARD");
    expect(
      trigger.advisories.find((a) => a.category === "hazard")?.action,
    ).toBe("reroute_applied");
    expect(
      trigger.advisories.find((a) => a.category === "facility")?.action,
    ).toBe("reroute_suggested");
  });

  it("dedupes identical advisories within TTL", () => {
    let now = 1000;
    const deduper = new AdvisoryDeduper(10 * 60_000, () => now);
    const adv = {
      advisoryId: "hazard:h-1",
      category: "hazard" as const,
      severity: "warning" as const,
      action: "none" as const,
      title: "test",
      speech: "test",
      issuedAt: "2026-09-04T12:00:00.000Z",
    };

    expect(deduper.take([adv])).toHaveLength(1);
    expect(deduper.take([adv])).toHaveLength(0);

    // After TTL passes
    now += 10 * 60_000 + 1;
    expect(deduper.take([adv])).toHaveLength(1);
  });
});
