import { describe, expect, it } from "vitest";
import { METRO_LINES, metroLineKey } from "./metro-lines";

// Web and app translate these exact keys (`metroLines.<lineKey>`); keep in sync.
const LINE_KEYS = [
  "TRTC_BL",
  "TRTC_R",
  "TRTC_G",
  "TRTC_O",
  "TRTC_BR",
  "TRTC_R_R-3",
  "TRTC_G_G-3",
  "TRTCMG_MK",
  "NTMC_Y",
  "NTMC_LB",
  "TYMC_A",
  "NTDLRT_V",
  "NTDLRT_V_V-1",
  "NTDLRT_V_V-2",
  "NTALRT_K",
  "KRTC_O",
  "KRTC_R",
  "TMRT_G",
  "KLRT_C",
];

describe("metro line labels", () => {
  it("keeps the label set clients translate, each with Chinese and English", () => {
    expect([...METRO_LINES.keys()]).toEqual(LINE_KEYS);
    for (const { zh, en } of METRO_LINES.values()) {
      expect(zh.trim()).not.toBe("");
      expect(en).toMatch(/^[A-Za-z][A-Za-z -]+$/);
    }
  });

  it.each([
    ["TRTC_BL_BL-1_1", "TRTC", "BL", "TRTC_BL"],
    ["TRTC_R_R-3_0", "TRTC", "R", "TRTC_R_R-3"],
    ["TRTC_R_R-2_1", "TRTC", "R", "TRTC_R"],
    ["TRTC_G_G-3_1", "TRTC", "G", "TRTC_G_G-3"],
    ["TRTCMG_MK_MK-1_1", "TRTCMG", "MK", "TRTCMG_MK"],
    ["NTMC_Y_Y-1_0", "NTMC", "Y", "NTMC_Y"],
    ["NTMC_LB_LB_1", "NTMC", "LB", "NTMC_LB"],
    ["TYMC_A_A-4_0", "TYMC", "A", "TYMC_A"],
    ["NTDLRT_V_V-1_1", "NTDLRT", "V", "NTDLRT_V_V-1"],
    ["NTDLRT_V_V-2_0", "NTDLRT", "V", "NTDLRT_V_V-2"],
    ["NTALRT_K_K-1_0", "NTALRT", "K", "NTALRT_K"],
    ["KRTC_R_R_1", "KRTC", "R", "KRTC_R"],
    ["TMRT_G_G-1_0", "TMRT", "G", "TMRT_G"],
    ["KLRT_C_C_1", "KLRT", "C", "KLRT_C"],
  ])("maps feed route %s to label %s", (routeId, system, lineId, key) => {
    expect(metroLineKey(routeId, system, lineId)).toBe(key);
  });

  it("returns no label for an unknown line", () => {
    expect(metroLineKey("TRTC_X_X-1_0", "TRTC", "X")).toBeUndefined();
  });
});
