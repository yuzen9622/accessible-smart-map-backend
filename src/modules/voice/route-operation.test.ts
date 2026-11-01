import { beforeEach, describe, expect, it, vi } from "vitest";
const { generateContent, getConfig } = vi.hoisted(() => ({
  generateContent: vi.fn(),
  getConfig: vi.fn(),
}));
vi.mock("../../config/ai", () => ({
  googleGenAi: { models: { generateContent } },
}));
vi.mock("../user/user.service", () => ({
  getConfig,
  accessibilityModeFromProfile: (p: any) =>
    p?.mobilityAid === "manual_wheelchair"
      ? "wheelchair"
      : p?.visualAssistance
        ? "visual_impaired"
        : undefined,
}));
import {
  loadVoiceRoutingPreferences,
  resolveRouteOperation,
  routeOperationPreferences,
  unclearRouteOperation,
  validateRouteOperation,
} from "./route-operation";
const request = "用年長者模式開車到松山車站，先不要導航";
const plan = () => ({
  ...unclearRouteOperation(),
  action: "plan" as const,
  evidence: request,
  changes: {
    ...unclearRouteOperation().changes,
    mode: "elderly" as const,
    travelMode: "drive" as const,
  },
  changeEvidence: {
    ...unclearRouteOperation().changeEvidence,
    mode: "年長者模式",
    travelMode: "開車",
  },
  plans: [
    {
      origin: null,
      destination: "松山車站",
      travelMode: "drive" as const,
      transitPreference: null,
    },
  ],
});
beforeEach(() => vi.clearAllMocks());
describe("voice route operation boundary", () => {
  it("keeps unmentioned needs while accepting an explicit elderly road plan", () => {
    const op = validateRouteOperation(plan(), request, {
      mode: "wheelchair",
      avoidStairs: true,
      requireElevator: true,
    });
    expect(op.action).toBe("plan");
    expect(
      routeOperationPreferences(op, {
        mode: "wheelchair",
        avoidStairs: true,
        requireElevator: true,
      }),
    ).toEqual({
      mode: "elderly",
      travelMode: "drive",
      avoidStairs: true,
      requireElevator: true,
    });
  });
  it("does not invent normal mode when no preference was supplied", () => {
    expect(routeOperationPreferences(unclearRouteOperation(), {})).toEqual({});
  });
  it.each(["wheelchair", "visual_impaired"] as const)(
    "requires clarification for unmodified %s self-driving",
    (mode) => {
      const op = {
        ...plan(),
        changes: { ...unclearRouteOperation().changes, travelMode: "drive" },
      };
      expect(validateRouteOperation(op, request, { mode }).action).toBe(
        "clarify",
      );
    },
  );
  it("requires clarification when road mode is unknown after profile failure", () => {
    expect(
      validateRouteOperation(
        {
          ...plan(),
          changes: { ...unclearRouteOperation().changes, travelMode: "drive" },
        },
        request,
        {},
      ).action,
    ).toBe("clarify");
  });
  it.each([
    ["normal", "drive"],
    ["elderly", "motorcycle"],
    ["wheelchair", "drive"],
    ["wheelchair", "motorcycle"],
    ["visual_impaired", "drive"],
    ["visual_impaired", "motorcycle"],
  ] as const)(
    "does not turn an inferred %s/%s travel suggestion into an explicit request for a new destination",
    (mode, travelMode) => {
      const text = "幫我規劃臺北車站到淡水捷運站的路線";
      const input = {
        ...unclearRouteOperation(),
        action: "plan",
        evidence: text,
        plans: [
          {
            origin: "臺北車站",
            destination: "淡水捷運站",
            travelMode,
            transitPreference: null,
          },
        ],
      };
      const preferences = {
        mode,
        travelMode,
        avoidStairs: true,
        requireElevator: true,
      };
      const op = validateRouteOperation(input, text, preferences);
      expect(op.action).toBe("plan");
      expect(op.changes.travelMode).toBeNull();
      expect(op.clarificationReason).not.toBe("accessibility_conflict");
      expect(routeOperationPreferences(op, preferences)).toEqual(preferences);
    },
  );
  it("does not force a self-driving clarification from an inferred mode when the profile is unavailable", () => {
    const text = "規劃臺北車站到淡水捷運站";
    const op = validateRouteOperation(
      {
        ...unclearRouteOperation(),
        action: "plan",
        evidence: text,
        plans: [
          {
            origin: "臺北車站",
            destination: "淡水捷運站",
            travelMode: "drive",
            transitPreference: null,
          },
        ],
      },
      text,
      {},
    );
    expect(op.action).toBe("plan");
    expect(op.changes.travelMode).toBeNull();
    expect(routeOperationPreferences(op, {})).toEqual({});
  });
  it("requires evidence for each explicit preference, including clearing stairs", () => {
    const op = plan();
    op.changes.avoidStairs = false as never;
    expect(
      validateRouteOperation(op, request, { avoidStairs: true }).action,
    ).toBe("clarify");
  });
  it("a single-plan operation cannot authorize a second transport", () => {
    const op = plan();
    op.plans.push({ ...op.plans[0], travelMode: "motorcycle" as never });
    expect(validateRouteOperation(op, request, {}).action).toBe("clarify");
    expect(
      validateRouteOperation({ ...op, action: "compare" }, request, {}).action,
    ).toBe("compare");
    expect(
      validateRouteOperation(
        { ...op, action: "compare", startNavigation: true },
        request,
        {},
      ).action,
    ).toBe("clarify");
  });
  it("validates departure time evidence and retains inherited times", () => {
    const op = {
      ...plan(),
      changes: {
        ...plan().changes,
        departureTime: "2026-11-02T08:00:00+08:00",
      },
      changeEvidence: {
        ...plan().changeEvidence,
        departureTime: "明天早上八點",
      },
    };
    expect(validateRouteOperation(op, request, {}).action).toBe("clarify");
    expect(
      validateRouteOperation(op, request + "明天早上八點", {}).action,
    ).toBe("plan");
    expect(
      routeOperationPreferences(plan(), { departureTime: "09:00" })
        .departureTime,
    ).toBe("09:00");
  });
  it("delegates repeat exclusively to the current-step replay tool", () => {
    const op = validateRouteOperation(
      {
        ...unclearRouteOperation(),
        action: "delegate",
        delegateKind: "step",
        stepAction: "repeat",
        evidence: "再說一次",
      },
      "再說一次",
      {},
    );
    expect(op.delegatedTools).toEqual(["repeatNavStep"]);
    expect(op.stepAction).toBe("repeat");
    expect(op.delegatedTools).not.toContain("startNavigation");
  });
  it("delegates completed-current-step advancement exclusively to advance", () => {
    const text = "我已到了，下一步";
    const op = validateRouteOperation(
      {
        ...unclearRouteOperation(),
        action: "delegate",
        delegateKind: "step",
        stepAction: "advance",
        evidence: text,
      },
      text,
      {},
    );
    expect(op.stepAction).toBe("advance");
    expect(op.delegatedTools).toEqual(["advanceNavStep"]);
    expect(op.delegatedTools).not.toContain("repeatNavStep");
  });
  it.each([undefined, null, "both", "next"])(
    "fails closed for ambiguous or unsupported stepAction %s",
    (stepAction) => {
      const text = "這個步驟要怎麼辦";
      const op = validateRouteOperation(
        {
          ...unclearRouteOperation(),
          action: "delegate",
          delegateKind: "step",
          stepAction,
          evidence: text,
        },
        text,
        {},
      );
      expect(op.action).toBe("clarify");
      expect(op.stepAction).toBeNull();
      expect(op.delegatedTools).toEqual([]);
    },
  );
  it.each([
    "none",
    "plan",
    "compare",
    "start",
    "stop",
    "end_voice",
    "details",
    "clarify",
  ] as const)("rejects stepAction on non-step action %s", (action) => {
    const base =
      action === "plan" || action === "compare"
        ? plan()
        : unclearRouteOperation();
    const op = validateRouteOperation(
      { ...base, action, evidence: request, stepAction: "repeat" },
      request,
      { mode: "elderly" },
    );
    expect(op.action).toBe("clarify");
    expect(op.stepAction).toBeNull();
    expect(op.delegatedTools).toEqual([]);
  });
  it.each(["indoor", "discovery", "candidate_switch"] as const)(
    "rejects stepAction on %s delegation",
    (delegateKind) => {
      const text = "please help with this trip";
      const op = validateRouteOperation(
        {
          ...unclearRouteOperation(),
          action: "delegate",
          delegateKind,
          stepAction: "advance",
          evidence: text,
        },
        text,
        {},
      );
      expect(op.action).toBe("clarify");
      expect(op.stepAction).toBeNull();
      expect(op.delegatedTools).toEqual([]);
    },
  );
  it("retains non-step model compatibility when stepAction is absent", () => {
    const input: Record<string, unknown> = plan();
    delete input.stepAction;
    const op = validateRouteOperation(input, request, { mode: "elderly" });
    expect(op.action).toBe("plan");
    expect(op.stepAction).toBeNull();
  });
  it("requires an exact supporting quote in the current turn for a step action", () => {
    const op = validateRouteOperation(
      {
        ...unclearRouteOperation(),
        action: "delegate",
        delegateKind: "step",
        stepAction: "repeat",
        evidence: "repeat the current instruction",
      },
      "What is the remaining distance?",
      {},
    );
    expect(op.action).toBe("clarify");
    expect(op.delegatedTools).toEqual([]);
  });
  it.each([
    ["repeat", "請重播目前這一步", "repeatNavStep"],
    ["repeat", "Please repeat the instruction I am on.", "repeatNavStep"],
    ["repeat", "今の案内をもう一度お願いします。", "repeatNavStep"],
    ["advance", "我已完成目前這一步，請繼續室內下一步", "advanceNavStep"],
    [
      "advance",
      "I have finished this indoor step. Continue to the next one.",
      "advanceNavStep",
    ],
    [
      "advance",
      "Ya terminé este paso interior. Continúa con el siguiente.",
      "advanceNavStep",
    ],
  ])(
    "accepts grounded multilingual %s extraction: %s",
    async (stepAction, text, tool) => {
      generateContent.mockResolvedValueOnce({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    ...unclearRouteOperation(),
                    action: "delegate",
                    delegateKind: "step",
                    stepAction,
                    evidence: text,
                  }),
                },
              ],
            },
          },
        ],
      });
      const op = await resolveRouteOperation(text, {
        preferences: {},
        selectedRoute: "",
        recentUserTurns: [],
      });
      expect(op.stepAction).toBe(stepAction);
      expect(op.evidence).toBe(text);
      expect(op.delegatedTools).toEqual([tool]);
    },
  );
  it.each(["wheelchair", "visual_impaired"] as const)(
    "labels validated %s road conflicts without authorizing effects",
    (mode) => {
      const input = {
        ...plan(),
        changes: { ...unclearRouteOperation().changes, travelMode: "drive" },
      };
      const op = validateRouteOperation(input, request, {
        mode,
        avoidStairs: true,
        requireElevator: true,
      });
      expect(op.action).toBe("clarify");
      expect(op.clarificationReason).toBe("accessibility_conflict");
      expect(op.delegatedTools).toEqual([]);
      expect(op.startNavigation).toBe(false);
      expect(
        routeOperationPreferences(op, {
          mode,
          avoidStairs: true,
          requireElevator: true,
        }),
      ).toEqual({ mode, avoidStairs: true, requireElevator: true });
    },
  );
  it.each(["drive", "motorcycle"] as const)(
    "labels an already-clarify operation from inherited protected mode and %s",
    (travelMode) => {
      const text = "請幫我確認這個需求";
      const op = validateRouteOperation(
        { ...unclearRouteOperation(), evidence: text },
        text,
        { mode: "wheelchair", travelMode },
      );
      expect(op.action).toBe("clarify");
      expect(op.clarificationReason).toBe("accessibility_conflict");
      expect(op.delegatedTools).toEqual([]);
    },
  );
  it("uses evidence-backed current mode changes when classifying an existing clarification", () => {
    const text = "使用視障模式騎機車";
    const base = unclearRouteOperation();
    const op = validateRouteOperation(
      {
        ...base,
        evidence: text,
        changes: {
          ...base.changes,
          mode: "visual_impaired",
          travelMode: "motorcycle",
        },
        changeEvidence: {
          ...base.changeEvidence,
          mode: "視障模式",
          travelMode: "騎機車",
        },
      },
      text,
      { mode: "normal", travelMode: "transit", avoidStairs: true },
    );
    expect(op.action).toBe("clarify");
    expect(op.clarificationReason).toBe("accessibility_conflict");
    expect(op.delegatedTools).toEqual([]);
    expect(op.startNavigation).toBe(false);
  });
  it("uses an explicit compatible mode over the inherited protected mode for clarification classification", () => {
    const text = "改用一般模式";
    const base = unclearRouteOperation();
    const op = validateRouteOperation(
      {
        ...base,
        evidence: text,
        changes: { ...base.changes, mode: "normal" },
        changeEvidence: { ...base.changeEvidence, mode: "一般模式" },
      },
      text,
      { mode: "wheelchair", travelMode: "drive" },
    );
    expect(op.action).toBe("clarify");
    expect(op.clarificationReason).toBe("ambiguous");
  });
  it("keeps generic and invalid operations ambiguous without trusting a supplied server-only reason", () => {
    expect(unclearRouteOperation().clarificationReason).toBe("ambiguous");
    const text = "請說明";
    const op = validateRouteOperation(
      {
        ...unclearRouteOperation(),
        evidence: text,
        clarificationReason: "accessibility_conflict",
      },
      text,
      { mode: "elderly", travelMode: "drive" },
    );
    expect(op.clarificationReason).toBe("ambiguous");
    expect(
      validateRouteOperation(
        { action: "clarify", clarificationReason: "accessibility_conflict" },
        text,
        { mode: "wheelchair", travelMode: "drive" },
      ).clarificationReason,
    ).toBe("ambiguous");
    expect(
      validateRouteOperation(
        { ...unclearRouteOperation(), evidence: "not this turn" },
        text,
        { mode: "wheelchair", travelMode: "drive" },
      ).clarificationReason,
    ).toBe("ambiguous");
    expect(
      validateRouteOperation(plan(), request, { mode: "normal" })
        .clarificationReason,
    ).toBeUndefined();
  });
  it("failed or malformed extraction cannot authorize tools", async () => {
    generateContent.mockRejectedValueOnce(new Error("down"));
    expect(
      (
        await resolveRouteOperation(request, {
          preferences: {},
          selectedRoute: "",
          recentUserTurns: [],
        })
      ).action,
    ).toBe("clarify");
    generateContent.mockResolvedValueOnce({
      candidates: [{ content: { parts: [{ text: "not json" }] } }],
    });
    expect(
      (
        await resolveRouteOperation(request, {
          preferences: {},
          selectedRoute: "",
          recentUserTurns: [],
        })
      ).action,
    ).toBe("clarify");
  });
  it("reads saved needs without inventing or writing profile data", async () => {
    getConfig.mockResolvedValue({
      accessibility: {
        mobilityAid: "manual_wheelchair",
        canUseStairs: false,
        needsElevator: true,
      },
    });
    expect(await loadVoiceRoutingPreferences("user")).toEqual({
      mode: "wheelchair",
      avoidStairs: true,
      requireElevator: true,
    });
    expect(
      await loadVoiceRoutingPreferences("user", { mode: "elderly" }),
    ).toEqual({ mode: "elderly", avoidStairs: true, requireElevator: true });
    getConfig.mockRejectedValueOnce(new Error("down"));
    expect(await loadVoiceRoutingPreferences("user")).toEqual({});
  });
});
