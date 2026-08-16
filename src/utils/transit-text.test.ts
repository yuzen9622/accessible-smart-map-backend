import { describe, it, expect } from "vitest";
import {
  busRouteQueryCandidates,
  equalRouteName,
  escapeODataLiteral,
  formatFriendlyDistance,
  formatWalkStepInstruction,
  normalizeRouteName,
  odataUrlLiteral,
} from "./transit-text";

describe("busRouteQueryCandidates", () => {
  it("有帶城市時先試市區、再退回公路（不從路線號碼猜歸屬）", () => {
    // 0557 是新竹縣「市區公車」、0968 是「公路客運」，兩者號碼形狀完全一樣，
    // 所以候選順序只能由呼叫方給的 city 決定，不能靠號碼判斷。
    expect(busRouteQueryCandidates("0557", "HsinchuCounty")).toEqual([
      { type: "City", routeId: "0557" },
      { type: "InterCity", routeId: "0557" },
    ]);
    expect(busRouteQueryCandidates("0968", "HsinchuCounty")).toEqual([
      { type: "City", routeId: "0968" },
      { type: "InterCity", routeId: "0968" },
    ]);
  });

  it("四位數與三位數路線得到相同的候選形狀", () => {
    expect(busRouteQueryCandidates("307", "Taipei")).toEqual([
      { type: "City", routeId: "307" },
      { type: "InterCity", routeId: "307" },
    ]);
    expect(busRouteQueryCandidates("1717", "Taipei")).toEqual([
      { type: "City", routeId: "1717" },
      { type: "InterCity", routeId: "1717" },
    ]);
  });

  it("沒帶城市或指定 InterCity 時只查公路客運", () => {
    expect(busRouteQueryCandidates("1619")).toEqual([
      { type: "InterCity", routeId: "1619" },
    ]);
    expect(busRouteQueryCandidates("1619", "InterCity")).toEqual([
      { type: "InterCity", routeId: "1619" },
    ]);
  });

  it("路線名含贅字時，格式化後的名稱與原始名稱都是候選", () => {
    expect(
      busRouteQueryCandidates("1619B經中港路不經竹科", "Taichung"),
    ).toEqual([
      { type: "City", routeId: "1619B" },
      { type: "City", routeId: "1619B經中港路不經竹科" },
      { type: "InterCity", routeId: "1619B" },
      { type: "InterCity", routeId: "1619B經中港路不經竹科" },
    ]);
  });

  it("格式化後與原始名稱相同時不重複產生候選", () => {
    expect(busRouteQueryCandidates("綠1", "Taichung")).toEqual([
      { type: "City", routeId: "綠1" },
      { type: "InterCity", routeId: "綠1" },
    ]);
  });
});

describe("formatWalkStepInstruction", () => {
  it("formats DEPART with street name", () => {
    expect(
      formatWalkStepInstruction({
        relativeDirection: "DEPART",
        streetName: "信義路",
        bogusName: false,
      }),
    ).toBe("沿「信義路」出發");
  });

  it("formats DEPART without street name", () => {
    expect(
      formatWalkStepInstruction({
        relativeDirection: "DEPART",
        streetName: "",
        bogusName: true,
      }),
    ).toBe("請出發");
  });

  it("formats LEFT with street name", () => {
    expect(
      formatWalkStepInstruction({
        relativeDirection: "LEFT",
        streetName: "敦化南路",
        bogusName: false,
      }),
    ).toBe("向左轉進入「敦化南路」");
  });

  it("formats RIGHT without street name", () => {
    expect(
      formatWalkStepInstruction({
        relativeDirection: "RIGHT",
        streetName: "",
        bogusName: true,
      }),
    ).toBe("向右轉");
  });

  it("formats CONTINUE with street name", () => {
    expect(
      formatWalkStepInstruction({
        relativeDirection: "CONTINUE",
        streetName: "忠孝東路",
        bogusName: false,
      }),
    ).toBe("沿「忠孝東路」繼續直行");
  });

  it("formats ELEVATOR, ENTER_STATION, EXIT_STATION", () => {
    expect(formatWalkStepInstruction({ relativeDirection: "ELEVATOR" })).toBe(
      "請進入電梯",
    );
    expect(
      formatWalkStepInstruction({ relativeDirection: "ENTER_STATION" }),
    ).toBe("請進入車站");
    expect(
      formatWalkStepInstruction({ relativeDirection: "EXIT_STATION" }),
    ).toBe("請離開車站");
  });

  it("formats maneuver distance and the next named target", () => {
    expect(formatFriendlyDistance(12)).toBe("馬上");
    expect(formatFriendlyDistance(185)).toBe("約 190 公尺");
    expect(formatFriendlyDistance(1011)).toBe("約 1.0 公里");
    expect(
      formatWalkStepInstruction({
        relativeDirection: "CONTINUE",
        bogusName: true,
        distanceM: 185,
        targetStreetName: "民族西路",
      }),
    ).toBe("直行約 190 公尺至「民族西路」");
    expect(
      formatWalkStepInstruction({
        relativeDirection: "RIGHT",
        streetName: "民族西路",
        bogusName: false,
        distanceM: 1011,
      }),
    ).toBe("向右轉進入「民族西路」，續行約 1.0 公里");
  });
});

describe("escapeODataLiteral", () => {
  it("doubles single quotes inside a value", () => {
    expect(escapeODataLiteral("307")).toBe("307");
    expect(escapeODataLiteral("綠1")).toBe("綠1");
    expect(escapeODataLiteral("It's a route")).toBe("It''s a route");
    expect(escapeODataLiteral("' or contains(RouteName/Zh_tw,'x")).toBe(
      "'' or contains(RouteName/Zh_tw,''x",
    );
    expect(escapeODataLiteral("''''")).toBe("''''''''");
  });
});

describe("odataUrlLiteral", () => {
  it("preserves a normal route name", () => {
    expect(odataUrlLiteral("307")).toBe("307");
  });

  it("doubles single quotes without percent-encoding them", () => {
    expect(odataUrlLiteral("It's")).toBe("It''s");
  });

  it("percent-encodes query-rewriting characters", () => {
    expect(odataUrlLiteral("x&$top=10000")).toBe("x%26%24top%3D10000");
  });

  it("percent-encodes Chinese values as UTF-8", () => {
    expect(odataUrlLiteral("臺北市")).toBe("%E8%87%BA%E5%8C%97%E5%B8%82");
  });
});

describe("equalRouteName & normalizeRouteName", () => {
  it("normalizes route names with suffix variations", () => {
    expect(normalizeRouteName("30路")).toBe("30");
    expect(normalizeRouteName("30")).toBe("30");
    expect(normalizeRouteName("紅30路")).toBe("紅30");
    expect(normalizeRouteName("307副線")).toBe("307副");
  });

  it("strictly distinguishes routes with overlapping substrings (no false positives)", () => {
    expect(equalRouteName("30", "30")).toBe(true);
    expect(equalRouteName("30", "30路")).toBe(true);
    expect(equalRouteName("30", "3")).toBe(false);
    expect(equalRouteName("30", "302")).toBe(false);
    expect(equalRouteName("30", "302延")).toBe(false);
    expect(equalRouteName("30", "307")).toBe(false);
    expect(equalRouteName("紅30", "30")).toBe(false);
    expect(equalRouteName("綠3", "3")).toBe(false);
    expect(equalRouteName("藍1", "1")).toBe(false);
    expect(equalRouteName("500", "500跳蛙")).toBe(false);
    expect(equalRouteName("153", "153副")).toBe(false);
  });
});
