import { describe, expect, it } from "vitest";
import {
  localizeRouteDetails,
  presentRouteMessages,
  routeMessage,
} from "./route-messages";

describe("route message presentation", () => {
  it.each([
    ["origin", undefined, "Origin", "起點"],
    ["destination", undefined, "Destination", "目的地"],
    ["waypoint", 2, "Waypoint 2", "中途點 2"],
  ] as const)(
    "localizes machine-tagged %s labels, including public params and re-localization",
    (placeRole, waypointIndex, en, zh) => {
      const params = {
        placeRole,
        placeLabel: zh,
        gapM: 100,
        ...(waypointIndex ? { waypointIndex } : {}),
      };
      const descriptor = routeMessage(
        "ROUTE_WALK_CONNECTOR_UNAVAILABLE",
        "legacy warning",
        params,
      );
      const english = presentRouteMessages(
        ["legacy warning"],
        [descriptor],
        "en",
      );
      expect(english.messages[0]).toContain(`${en} is about 100 m`);
      expect(english.details?.[0].params?.placeLabel).toBe(en);
      expect(params.placeLabel).toBe(zh); // Never mutate a cached descriptor.
      const chinese = localizeRouteDetails(
        english.messages,
        english.details,
        "zh-TW",
      );
      expect(chinese.messages[0]).toContain(`${zh} 距可行車路段`);
      expect(chinese.details?.[0].params?.placeLabel).toBe(zh);
    },
  );

  it("never guesses the language of an untagged source place label", () => {
    const result = presentRouteMessages(
      ["raw"],
      [
        routeMessage("ROUTE_WALK_CONNECTOR_UNAVAILABLE", "raw", {
          placeLabel: "起點咖啡",
          gapM: 50,
        }),
      ],
      "en",
    );
    expect(result.messages[0]).toContain("起點咖啡 is about 50 m");
    expect(result.details?.[0].params?.placeLabel).toBe("起點咖啡");
  });
  it("deduplicates after localization and recalculates final indexes", () => {
    const result = presentRouteMessages(
      [
        "old warning",
        "Accessibility data along this route is limited; the score is conservative.",
      ],
      [routeMessage("ROUTE_DATA_SPARSE", "old warning")],
      "en",
    );
    expect(result.messages).toEqual([
      "Accessibility data along this route is limited; the score is conservative.",
    ]);
    expect(result.details).toEqual([
      {
        index: 0,
        code: "ROUTE_DATA_SPARSE",
        message:
          "Accessibility data along this route is limited; the score is conservative.",
      },
    ]);
  });

  it.each(["constructor", "__proto__", "UNKNOWN_CODE"])(
    "preserves fallback text for an unknown code %s",
    (code) => {
      const result = presentRouteMessages(
        ["legacy message"],
        [routeMessage(code, "legacy message", { value: "safe" })],
        "en",
      );
      expect(result.messages).toEqual(["legacy message"]);
      expect(result.details?.[0]).toMatchObject({
        index: 0,
        code,
        message: "legacy message",
      });
    },
  );

  it("does not apply stale or mismatched detail indexes to a different raw warning", () => {
    const result = localizeRouteDetails(
      ["unrelated raw warning", "still raw"],
      [
        { index: 0, code: "ROUTE_DATA_SPARSE", message: "old message" },
        { index: 8, code: "ROUTE_LONG_WALK", message: "out of bounds" },
      ],
      "en",
    );
    expect(result).toEqual({
      messages: ["unrelated raw warning", "still raw"],
    });
  });

  it("keeps the Chinese legacy string when language is omitted and re-localizes matching details", () => {
    const legacy = "沿途無障礙資料不足，分數為保守估計";
    const initial = presentRouteMessages(
      [legacy],
      [routeMessage("ROUTE_DATA_SPARSE", legacy)],
      undefined,
    );
    expect(initial.messages).toEqual([legacy]);
    const english = localizeRouteDetails(
      initial.messages,
      initial.details,
      "en",
    );
    expect(english.messages[0]).toBe(
      "Accessibility data along this route is limited; the score is conservative.",
    );
    expect(english.details?.[0]).toMatchObject({
      index: 0,
      message: english.messages[0],
    });
  });
});
