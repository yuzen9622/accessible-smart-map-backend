import type { IDisabledParking, IParkingLot, IParkingSpace } from "../types";

/** TDX 官方 SpaceType 編碼（見 docs/reports/tdx-parking-swagger-v1.json）。 */
export const SPACE_TYPE = {
  ALL: 0,
  CAR: 1,
  MOTORCYCLE: 2,
  DISABLED_CAR: 9,
  DISABLED_MOTORCYCLE: 10,
} as const;

/** 身障格 SpaceType 集合（9=身心障礙汽車車位, 10=身心障礙機車車位）。 */
export function isDisabledSpaceType(spaceType: number): boolean {
  return (
    spaceType === SPACE_TYPE.DISABLED_CAR ||
    spaceType === SPACE_TYPE.DISABLED_MOTORCYCLE
  );
}

const TW_BOUNDS = { lngMin: 119, lngMax: 122.5, latMin: 21.5, latMax: 26.5 };

export function inTaiwanBounds(lng: number, lat: number): boolean {
  return (
    lng >= TW_BOUNDS.lngMin &&
    lng <= TW_BOUNDS.lngMax &&
    lat >= TW_BOUNDS.latMin &&
    lat <= TW_BOUNDS.latMax
  );
}

export interface TdxParkingSpotRow {
  ParkingSegmentID?: string;
  ParkingSpotID?: string;
  Position?: { PositionLat?: number; PositionLon?: number };
  SpaceType?: number;
  HasChargingPoint?: number;
}

/**
 * TDX ParkingSpot → DisabledParking（身障格）或 IParkingSpace（一般格）。
 * TDX 資料沒有區/名稱，district 以 city 代填、placeName 用格位 ID 產生，
 * 維持既有 schema 的 required 欄位不破壞。
 */
export function spotRowToDocs(
  row: TdxParkingSpotRow,
  city: string,
): {
  disabled?: Omit<IDisabledParking, "_id">;
  space?: Omit<IParkingSpace, "_id">;
} {
  const spotId = row.ParkingSpotID?.trim();
  const segmentId = row.ParkingSegmentID?.trim();
  const lat = row.Position?.PositionLat;
  const lng = row.Position?.PositionLon;
  const spaceType = row.SpaceType;
  if (!spotId || !segmentId) return {};
  if (typeof lat !== "number" || typeof lng !== "number") return {};
  if (!inTaiwanBounds(lng, lat)) return {};

  const base = {
    city,
    segmentId,
    spaceType: typeof spaceType === "number" ? spaceType : SPACE_TYPE.CAR,
    hasChargingPoint: row.HasChargingPoint === 1,
    externalId: spotId,
    latitude: lat,
    longitude: lng,
    location: {
      type: "Point" as const,
      coordinates: [lng, lat] as [number, number],
    },
    importedAt: new Date(),
  };

  if (typeof spaceType === "number" && isDisabledSpaceType(spaceType)) {
    return {
      disabled: {
        city,
        district: city,
        areacode: "",
        quantity: 1,
        placeName: `身障停車格（${spotId}）`,
        chargeType: "",
        spaceLabel: "",
        isMarked: true,
        source: "tdx",
        externalId: spotId,
        latitude: lat,
        longitude: lng,
        location: base.location,
        importedAt: base.importedAt,
      },
    };
  }

  return { space: { ...base, isDisabled: false } };
}

export interface TdxCarParkRow {
  CarParkID?: string;
  CarParkName?: { Zh_tw?: string };
  Address?: string;
  CarParkPosition?: { PositionLat?: number; PositionLon?: number };
  CarParkType?: number;
  ChargeTypes?: number[];
  WheelchairAccessible?: number;
  Description?: string;
}

/**
 * 從 CarPark.Description 解析車位數量，如
 * 「小型車228格(含身心障礙6格，含孕婦…4格，電動車專用車位7格)」
 * → { totalCarSpaces: 228, disabledSpaces: 6 }
 */
export function parseCarParkSpaces(description?: string): {
  totalCarSpaces?: number;
  disabledSpaces?: number;
} {
  if (!description) return {};
  const total = description.match(/小型車(\d+)格/);
  const disabled = description.match(/身心障礙(\d+)格/);
  return {
    totalCarSpaces: total ? Number(total[1]) : undefined,
    disabledSpaces: disabled ? Number(disabled[1]) : undefined,
  };
}

/** TDX CarPark → IParkingLot（town/district 由 bbox 標記帶入）。 */
export function carParkRowToDoc(
  row: TdxCarParkRow,
  city: string,
  district?: string,
): Omit<IParkingLot, "_id"> | null {
  const id = row.CarParkID?.trim();
  const name = row.CarParkName?.Zh_tw?.trim();
  const lat = row.CarParkPosition?.PositionLat;
  const lng = row.CarParkPosition?.PositionLon;
  if (!id || !name || typeof lat !== "number" || typeof lng !== "number")
    return null;
  if (!inTaiwanBounds(lng, lat)) return null;

  const { totalCarSpaces, disabledSpaces } = parseCarParkSpaces(
    row.Description,
  );
  return {
    carParkId: id,
    name,
    address: row.Address?.trim() || undefined,
    city,
    district,
    carParkType: row.CarParkType,
    chargeTypes: Array.isArray(row.ChargeTypes) ? row.ChargeTypes : [],
    wheelchairAccessible: row.WheelchairAccessible === 1 ? true : undefined,
    disabledSpaces,
    totalCarSpaces,
    latitude: lat,
    longitude: lng,
    position: { type: "Point", coordinates: [lng, lat] },
    location: { type: "Point", coordinates: [lng, lat] },
    importedAt: new Date(),
  };
}
