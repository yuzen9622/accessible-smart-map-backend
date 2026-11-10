import { describe, expect, it } from "vitest";
import type { RoadLane } from "../types/road-guidance";
import { roadLaneHint, withLaneHint } from "./road-lane-hint";

const lane = (recommendation: RoadLane["recommendation"]): RoadLane => ({
  directions: ["straight"],
  recommendation,
  maneuverDirection: null,
});
const lanes = (pattern: string): RoadLane[] =>
  [...pattern].map((c) =>
    lane(c === "P" ? "preferred" : c === "U" ? "usable" : "not_recommended"),
  );

describe("roadLaneHint", () => {
  it.each([
    ["NNUP", "靠最右側車道", "use the right lane"],
    ["NNPP", "靠右側兩個車道", "use the right 2 lanes"],
    ["PNNN", "靠最左側車道", "use the left lane"],
    ["PPPN", "靠左側三個車道", "use the left 3 lanes"],
    ["NPNN", "走左邊數來第二車道", "use lane 2 from the left"],
    ["NPPNN", "走左邊數來第二到第三車道", "use lanes 2–3 from the left"],
    ["PNPN", "走左邊數來第一、第三車道", "use lanes 1, 3 from the left"],
    ["NNUU", "靠右側兩個車道", "use the right 2 lanes"],
  ])("%s → %s", (pattern, zh, en) => {
    expect(roadLaneHint(lanes(pattern))).toBe(zh);
    expect(roadLaneHint(lanes(pattern), "en")).toBe(en);
  });

  it("prefers active lanes over merely valid ones (four-lane right turn)", () => {
    expect(roadLaneHint(lanes("NNUP"))).toBe("靠最右側車道");
  });

  it.each(["PPPP", "UUUU", "NNNN", ""])(
    "says nothing when every lane works or none is recommended (%s)",
    (pattern) => {
      expect(roadLaneHint(lanes(pattern))).toBeUndefined();
    },
  );

  it("appends once, after dropping a trailing full stop", () => {
    const text = withLaneHint("右轉進入「民生東路」。", "靠右側兩個車道");
    expect(text).toBe("右轉進入「民生東路」，請靠右側兩個車道");
    expect(withLaneHint(text, "靠右側兩個車道")).toBe(text);
    expect(withLaneHint("Turn right", "use the right lane", "en")).toBe(
      "Turn right, use the right lane",
    );
    expect(withLaneHint("右轉", undefined)).toBe("右轉");
  });
});
