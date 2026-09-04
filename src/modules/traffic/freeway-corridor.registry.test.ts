import { describe, expect, it } from "vitest";
import { getFreewayCorridorRegistry } from "./freeway-corridor.registry";

describe("FreewayCorridorRegistry", () => {
  const registry = getFreewayCorridorRegistry();

  it("should initialize with all 456 freeway sections", () => {
    expect(registry.totalSections).toBe(456);
  });

  it("should have all expected major corridors", () => {
    const keys = registry.getAllCorridorKeys();
    expect(keys).toContain("國道1號_S");
    expect(keys).toContain("國道1號_N");
    expect(keys).toContain("國道1號汐止五股高架道路_S");
    expect(keys).toContain("國道1號汐止五股高架道路_N");
    expect(keys).toContain("國道3號_S");
    expect(keys).toContain("國道3號_N");
    expect(keys).toContain("國道2號_E");
    expect(keys).toContain("國道2號_W");
    expect(keys).toContain("國道5號_S");
    expect(keys).toContain("國道5號_N");
  });

  it("should sort Southbound sections in increasing mileage", () => {
    const n1s = registry.getCorridor("國道1號", "S");
    expect(n1s.length).toBe(85);
    for (let i = 0; i < n1s.length - 1; i++) {
      expect(n1s[i].startKm).toBeLessThanOrEqual(n1s[i + 1].startKm);
      expect(n1s[i].endKm).toBeCloseTo(n1s[i + 1].startKm, 2);
    }
  });

  it("should sort Northbound sections in decreasing mileage", () => {
    const n1n = registry.getCorridor("國道1號", "N");
    expect(n1n.length).toBe(85);
    for (let i = 0; i < n1n.length - 1; i++) {
      expect(n1n[i].startKm).toBeGreaterThanOrEqual(n1n[i + 1].startKm);
      expect(n1n[i].endKm).toBeCloseTo(n1n[i + 1].startKm, 2);
    }
  });

  it("should find section by KM accurately on Southbound corridor", () => {
    // 國道1號 S: 0021 is 圓山到台北 (23.2K -> 25.1K)
    const sec24 = registry.findSectionByKm("國道1號", "S", 24.0);
    expect(sec24).toBeDefined();
    expect(sec24?.sectionId).toBe("0021");
    expect(sec24?.startKm).toBe(23.2);
    expect(sec24?.endKm).toBe(25.1);

    // 0023 is 台北到三重 (25.1K -> 27.1K)
    const sec26 = registry.findSectionByKm("國道1號", "S", 26.0);
    expect(sec26).toBeDefined();
    expect(sec26?.sectionId).toBe("0023");
  });

  it("should find section by KM accurately on Northbound corridor", () => {
    // 國道1號 N: 0022 is 台北到圓山 (25.1K -> 23.2K)
    const sec24N = registry.findSectionByKm("國道1號", "N", 24.0);
    expect(sec24N).toBeDefined();
    expect(sec24N?.sectionId).toBe("0022");
    expect(sec24N?.startKm).toBe(25.1);
    expect(sec24N?.endKm).toBe(23.2);
  });

  it("should distinguish between Ground (國道1號) and Elevated (汐五/五楊高架)", () => {
    // Ground at 15.0K S (Section 0015: 高架汐止端到東湖, 14.0K -> 15.2K)
    const groundSec = registry.findSectionByKm("國道1號", "S", 15.0);
    expect(groundSec).toBeDefined();
    expect(groundSec?.roadName).toBe("國道1號");

    // Elevated at 15.0K S (Section 0159: 汐止端到堤頂, 13.08K -> 18.8K)
    const elevatedSec = registry.findSectionByKm(
      "國道1號汐止五股高架道路",
      "S",
      15.0,
    );
    expect(elevatedSec).toBeDefined();
    expect(elevatedSec?.roadName).toBe("國道1號汐止五股高架道路");
    expect(elevatedSec?.sectionId).toBe("0159");

    // They are distinct sections
    expect(groundSec?.sectionId).not.toBe(elevatedSec?.sectionId);
  });
});
