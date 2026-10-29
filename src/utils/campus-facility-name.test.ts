import { describe, expect, it } from "vitest";
import {
  formatCampusFacilityLabel,
  normalizeCampusFacilityName,
  normalizeCampusBuilding,
  normalizeCampusFloors,
} from "./campus-facility-name";

describe("campus facility source names", () => {
  it.each([
    ["無障礙電梯，無障礙電梯 (開啟詳細資訊)", "無障礙電梯", "無障礙電梯"],
    [
      "查看詳情：無障礙坡道，北側坡道 2 號 (開啟視窗)",
      "無障礙坡道",
      "北側坡道 2 號",
    ],
    [
      "無障礙電梯，北側電梯（入口 A） （開啟詳細資訊）",
      "無障礙電梯",
      "北側電梯（入口 A）",
    ],
    ["室外引導通路，通路 A (開啟詳細資訊)", "室外通路", "通路 A"],
    ["廁所盥洗室（女廁）", "無障礙廁所", "廁所盥洗室（女廁）"],
    ["無障礙電梯，無障礙電梯", "無障礙電梯", "無障礙電梯"],
    ["", "無障礙電梯", "無障礙電梯"],
  ])(
    "cleans %s without losing its specific identity",
    (input, category, expected) => {
      expect(normalizeCampusFacilityName(input, category)).toBe(expected);
      expect(normalizeCampusFacilityName(expected, category)).toBe(expected);
    },
  );

  it("retains meaningful commas, parentheses, numbered entrances and unknown labels", () => {
    expect(normalizeCampusFacilityName("東側入口，2 號門（坡道）")).toBe(
      "東側入口，2 號門（坡道）",
    );
    expect(normalizeCampusFacilityName("查看詳情：東側門（暫停使用）")).toBe(
      "東側門（暫停使用）",
    );
    expect(normalizeCampusFacilityName(undefined)).toBe("");
  });

  it("uses known positions only, preserving distinct source floors instead of inventing a range", () => {
    expect(
      formatCampusFacilityLabel({
        schoolName: "甲大學",
        branchName: "北校區",
        building: "建築物：教學館",
        floors: [" B1 ", "1F", "3F", "1F"],
        name: "無障礙電梯，無障礙電梯 (開啟詳細資訊)",
      }),
    ).toBe("甲大學／北校區 · 教學館 · B1, 1F, 3F · 無障礙電梯");
    expect(
      formatCampusFacilityLabel({
        schoolName: "乙大學",
        branchName: "主校區",
        floors: ["1F 辦公室"],
        name: "東側入口（2號）",
      }),
    ).toBe("乙大學／主校區 · 1F 辦公室 · 東側入口（2號）");
    expect(
      formatCampusFacilityLabel({
        schoolName: "實踐大學",
        branchName: "臺北校區",
        floors: ["1F 無障礙廁所"],
        name: "無障礙廁所",
      }),
    ).toBe("實踐大學／臺北校區 · 1F · 無障礙廁所");
    expect(formatCampusFacilityLabel({ name: "坡道" })).toBe("坡道");
    expect(formatCampusFacilityLabel({})).toBe("校園無障礙設施");
    expect(
      formatCampusFacilityLabel({
        schoolName: "甲校",
        branchName: "甲校",
        name: "電梯",
      }),
    ).toBe("甲校 · 電梯");
    expect(normalizeCampusBuilding("建築物：電子館")).toBe("電子館");
    expect(normalizeCampusFloors(["1F", "1F ", "", "2F 東側"])).toEqual([
      "1F",
      "2F 東側",
    ]);
  });
});
