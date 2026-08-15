import { describe, it, expect } from "vitest";
import {
  parseCsvLine,
  tm2ToWgs84,
  rowToParking,
} from "./disabled-parking-parse";

describe("parseCsvLine", () => {
  it("splits a plain row into 9 fields", () => {
    const cols = parseCsvLine(
      "八里區,65000230,1,商港八路,假日計時收費,身汽1,是,290453.8688,2782367.478",
    );
    expect(cols).toHaveLength(9);
    expect(cols[0]).toBe("八里區");
    expect(cols[5]).toBe("身汽1");
  });

  it("keeps a comma inside a quoted field as one column", () => {
    const cols = parseCsvLine(
      '八里區,65000230,1,十三行博物館第二停車場,"計次收費,假日計時收費",身汽11,是,290906.4756,2783053.446',
    );
    expect(cols).toHaveLength(9);
    expect(cols[4]).toBe("計次收費,假日計時收費");
    expect(cols[5]).toBe("身汽11");
  });
});

describe("tm2ToWgs84", () => {
  it("reprojects a TWD97/TM2 point in 八里 to WGS84 lng/lat", () => {
    const [lng, lat] = tm2ToWgs84(290453.8688, 2782367.478);
    expect(lng).toBeGreaterThan(121.3);
    expect(lng).toBeLessThan(121.5);
    expect(lat).toBeGreaterThan(25.0);
    expect(lat).toBeLessThan(25.2);
  });
});

describe("rowToParking", () => {
  it("maps columns by position and reprojects coordinates", () => {
    const doc = rowToParking(
      parseCsvLine(
        "八里區,65000230,1,商港八路,假日計時收費,身汽1,是,290453.8688,2782367.478",
      ),
      "新北市",
    );
    expect(doc).not.toBeNull();
    expect(doc!.city).toBe("新北市");
    expect(doc!.district).toBe("八里區");
    expect(doc!.placeName).toBe("商港八路");
    expect(doc!.spaceLabel).toBe("身汽1");
    expect(doc!.isMarked).toBe(true);
    expect(doc!.location.coordinates[0]).toBeCloseTo(doc!.longitude!, 6);
    expect(doc!.location.coordinates[1]).toBeCloseTo(doc!.latitude!, 6);
    expect(doc!.longitude).toBeGreaterThan(121.3);
    expect(doc!.latitude).toBeGreaterThan(25.0);
  });

  it("returns null for a row with too few columns", () => {
    expect(rowToParking(["八里區", "65000230"], "新北市")).toBeNull();
  });

  it("returns null when coordinates fall outside Taiwan bounds", () => {
    const doc = rowToParking(
      parseCsvLine("測試區,0,1,某路,免費,身汽0,否,0,0"),
      "新北市",
    );
    expect(doc).toBeNull();
  });
});
