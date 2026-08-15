import { describe, expect, it } from "vitest";
import {
  carParkRowToDoc,
  isDisabledSpaceType,
  parseCarParkSpaces,
  spotRowToDocs,
} from "./tdx-parking-parse";

describe("isDisabledSpaceType", () => {
  it("recognizes disabled car (9) and disabled motorcycle (10)", () => {
    expect(isDisabledSpaceType(9)).toBe(true);
    expect(isDisabledSpaceType(10)).toBe(true);
  });
  it("rejects ordinary types", () => {
    expect(isDisabledSpaceType(0)).toBe(false);
    expect(isDisabledSpaceType(1)).toBe(false);
    expect(isDisabledSpaceType(2)).toBe(false);
  });
});

describe("spotRowToDocs", () => {
  it("maps a disabled spot (SpaceType 9) to a DisabledParking doc", () => {
    const { disabled, space } = spotRowToDocs(
      {
        ParkingSegmentID: "K80",
        ParkingSpotID: "25053",
        Position: { PositionLat: 24.99501, PositionLon: 121.46367 },
        SpaceType: 9,
        HasChargingPoint: 0,
      },
      "臺北市",
    );
    expect(space).toBeUndefined();
    expect(disabled).toMatchObject({
      city: "臺北市",
      district: "臺北市",
      placeName: "身障停車格（25053）",
      isMarked: true,
      source: "tdx",
      externalId: "25053",
      quantity: 1,
    });
    expect(disabled?.location.coordinates).toEqual([121.46367, 24.99501]);
    expect(disabled?.latitude).toBe(24.99501);
  });

  it("maps an ordinary spot to a ParkingSpace doc", () => {
    const { disabled, space } = spotRowToDocs(
      {
        ParkingSegmentID: "3020452",
        ParkingSpotID: "30204523",
        Position: { PositionLat: 25.03729, PositionLon: 121.55917 },
        SpaceType: 1,
        HasChargingPoint: 1,
      },
      "臺北市",
    );
    expect(disabled).toBeUndefined();
    expect(space).toMatchObject({
      city: "臺北市",
      segmentId: "3020452",
      externalId: "30204523",
      spaceType: 1,
      hasChargingPoint: true,
      isDisabled: false,
    });
  });

  it("returns {} when ids or position are missing", () => {
    expect(spotRowToDocs({}, "臺北市")).toEqual({});
    expect(
      spotRowToDocs(
        { ParkingSpotID: "1", ParkingSegmentID: "2", Position: {} },
        "臺北市",
      ),
    ).toEqual({});
  });

  it("rejects coordinates outside Taiwan", () => {
    const { disabled, space } = spotRowToDocs(
      {
        ParkingSegmentID: "X",
        ParkingSpotID: "Y",
        Position: { PositionLat: 35.0, PositionLon: 135.0 },
        SpaceType: 9,
      },
      "臺北市",
    );
    expect(disabled).toBeUndefined();
    expect(space).toBeUndefined();
  });
});

describe("parseCarParkSpaces", () => {
  it("parses total and disabled counts from Description", () => {
    expect(
      parseCarParkSpaces(
        "地下型停車場，小型車228格(含身心障礙6格，含孕婦、育有6歲以下兒童專用停車位4格)",
      ),
    ).toEqual({ totalCarSpaces: 228, disabledSpaces: 6 });
  });

  it("returns empty for missing description", () => {
    expect(parseCarParkSpaces(undefined)).toEqual({});
    expect(parseCarParkSpaces("沒有數量描述")).toEqual({});
  });
});

describe("carParkRowToDoc", () => {
  it("maps a CarPark row to a ParkingLot doc", () => {
    const doc = carParkRowToDoc(
      {
        CarParkID: "TPE1760",
        CarParkName: { Zh_tw: "皇翔臺北廣場停車場" },
        Address: "台北市大同區承德路1段2號",
        CarParkPosition: { PositionLat: 25.04947, PositionLon: 121.51637 },
        CarParkType: 3,
        ChargeTypes: [2, 1],
        WheelchairAccessible: 1,
        Description: "小型車228格(含身心障礙6格)",
      },
      "臺北市",
      "大同區",
    );
    expect(doc).toMatchObject({
      carParkId: "TPE1760",
      name: "皇翔臺北廣場停車場",
      address: "台北市大同區承德路1段2號",
      city: "臺北市",
      district: "大同區",
      carParkType: 3,
      chargeTypes: [2, 1],
      wheelchairAccessible: true,
      disabledSpaces: 6,
      totalCarSpaces: 228,
    });
    expect(doc?.position.coordinates).toEqual([121.51637, 25.04947]);
  });

  it("returns null when name or position is missing", () => {
    expect(
      carParkRowToDoc({ CarParkID: "X", CarParkName: {} }, "臺北市"),
    ).toBeNull();
  });
});
