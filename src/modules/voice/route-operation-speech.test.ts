import { describe, expect, it } from "vitest";
import type { RouteOperation } from "./route-operation";
import { routeOperationSpeech } from "./route-operation-speech";

const operation: RouteOperation = {
  action: "compare",
  evidence: "compare",
  delegateKind: null,
  stepAction: null,
  delegatedTools: [],
  startNavigation: false,
  changes: {
    mode: null,
    avoidStairs: null,
    requireElevator: null,
    departureTime: null,
    travelMode: null,
  },
  changeEvidence: {
    mode: "",
    avoidStairs: "",
    requireElevator: "",
    departureTime: "",
    travelMode: "",
  },
  candidateNumber: null,
  candidateId: null,
  plans: [
    {
      origin: "A",
      destination: "B",
      travelMode: "drive",
      transitPreference: null,
    },
    {
      origin: "A",
      destination: "B",
      travelMode: "motorcycle",
      transitPreference: null,
    },
  ],
};
const result = (minutes: number) => ({
  ok: true,
  routes: [{ routeId: "r", totalMinutes: minutes }],
});
describe("server-owned route operation speech", () => {
  it("keeps the requested comparison order even when the motorcycle result arrives first", () => {
    const results = new Map<number | string, unknown>([
      [1, result(11)],
      [0, result(16)],
    ]);
    const speech = routeOperationSpeech(operation, results, false, "zh-TW");
    expect(speech).toBe(
      "已規劃開車路線，預估 16 分鐘。已規劃騎機車路線，預估 11 分鐘。目前只規劃路線，未開始導航。",
    );
  });
  it("uses the selected candidate time and keeps failed alternatives explicit", () => {
    const results = new Map<number | string, unknown>([
      [
        0,
        {
          ok: true,
          selectedRouteId: "selected",
          routes: [
            { routeId: "first", totalMinutes: 1 },
            { routeId: "selected", totalMinutes: 19, warnings: ["closure"] },
          ],
        },
      ],
      [1, { ok: false, routes: [] }],
    ]);
    expect(routeOperationSpeech(operation, results, false, "en")).toBe(
      "Driving route planned, approximately 19 minutes. Please review the 1 route notices. Motorcycling: route planning was unsuccessful. These are route previews only. Navigation has not started.",
    );
  });
  it("does not call planning success navigation success", () => {
    expect(
      routeOperationSpeech(
        {
          ...operation,
          action: "plan",
          plans: [operation.plans[0]],
          startNavigation: true,
        },
        new Map([[0, result(16)]]),
        true,
        "zh-TW",
      ),
    ).toContain("目前未能開始導航");
  });
  it("leaves actual started navigation to its existing announcement and GPS stream", () => {
    expect(
      routeOperationSpeech(
        { ...operation, action: "plan", startNavigation: true },
        new Map([[0, { ...result(16), navigationStarted: true }]]),
        true,
        "zh-TW",
      ),
    ).toBeNull();
  });
  it("does not claim stopped navigation while the navigation session is still active", () => {
    expect(
      routeOperationSpeech(
        { ...operation, action: "stop", plans: [] },
        new Map([["stop", { ok: true }]]),
        true,
        "zh-TW",
      ),
    ).toBe("目前未能停止導航。");
  });
  it("leaves successful step and switch effects to NavigationSession even on arrival", () => {
    for (const tool of [
      "repeatNavStep",
      "advanceNavStep",
      "confirmNavigationCandidateSwitch",
      "startNavigation",
    ]) {
      const op = {
        ...operation,
        action: "delegate" as const,
        delegateKind:
          tool === "confirmNavigationCandidateSwitch"
            ? ("candidate_switch" as const)
            : ("step" as const),
      };
      expect(
        routeOperationSpeech(
          op,
          new Map([[tool, { ok: true }]]),
          tool === "startNavigation",
          "zh-TW",
        ),
      ).toBeNull();
    }
  });
  it("does not invent a direction when no navigation step is available", () => {
    expect(
      routeOperationSpeech(
        { ...operation, action: "delegate", delegateKind: "step" },
        new Map([
          ["repeatNavStep", { ok: false, reason: "NO_ACTIVE_NAVIGATION" }],
        ]),
        false,
        "zh-TW",
      ),
    ).toBe("目前沒有可執行這個操作的導航步驟。");
  });
  it("asks for candidate confirmation without claiming that a proposal already changed navigation", () => {
    expect(
      routeOperationSpeech(
        { ...operation, action: "delegate", delegateKind: "candidate_switch" },
        new Map([
          [
            "proposeNavigationCandidate",
            { ok: true, candidateNumber: 2, totalMinutes: 15 },
          ],
        ]),
        true,
        "zh-TW",
      ),
    ).toBe("可切換至第 2 條路線，預估 15 分鐘。目前尚未切換，要切換嗎？");
  });
});
