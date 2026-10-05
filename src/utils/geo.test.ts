import { describe, it, expect } from "vitest";
import {
  degToCompassToken,
  haversineMeters,
  parseLocation,
  roundCoordinate,
  simplifyPath,
} from "./geo";

describe("haversineMeters", () => {
  it("is zero for identical points", () => {
    expect(haversineMeters(25.033, 121.5654, 25.033, 121.5654)).toBe(0);
  });

  it("approximates a 1 metre latitude offset", () => {
    const d = haversineMeters(25, 121, 25 + 1 / 111195, 121);
    expect(d).toBeGreaterThan(0.9);
    expect(d).toBeLessThan(1.1);
  });

  it("resolves the 20m geo-fence boundary", () => {
    const justInside = haversineMeters(25, 121, 25 + 19.9 / 111195, 121);
    const justOutside = haversineMeters(25, 121, 25 + 20.1 / 111195, 121);
    expect(justInside).toBeLessThan(20);
    expect(justOutside).toBeGreaterThan(20);
  });

  it("scales east-west distance by latitude", () => {
    const d = haversineMeters(25, 121, 25, 121.001);
    expect(d).toBeGreaterThan(95);
    expect(d).toBeLessThan(106);
  });
});

describe("degToCompassToken", () => {
  it("returns the public English eight-direction vocabulary", () => {
    expect(degToCompassToken(0)).toBe("NORTH");
    expect(degToCompassToken(45)).toBe("NORTHEAST");
    expect(degToCompassToken(90)).toBe("EAST");
    expect(degToCompassToken(180)).toBe("SOUTH");
    expect(degToCompassToken(270)).toBe("WEST");
    expect(degToCompassToken(360)).toBe("NORTH");
  });
});

describe("parseLocation", () => {
  it("parses comma-separated lat,lng string", () => {
    expect(parseLocation("24.137,120.686")).toEqual({
      lat: 24.137,
      lng: 120.686,
    });
    expect(parseLocation("24.137, 120.686")).toEqual({
      lat: 24.137,
      lng: 120.686,
    });
  });

  it("auto-detects reversed lng,lat string (Taiwan coordinates)", () => {
    expect(parseLocation("120.686,24.137")).toEqual({
      lat: 24.137,
      lng: 120.686,
    });
  });

  it("parses JSON string with lat and lng or latitude and longitude", () => {
    expect(parseLocation('{"lat":24.137,"lng":120.686}')).toEqual({
      lat: 24.137,
      lng: 120.686,
    });
    expect(parseLocation('{"latitude":24.137,"longitude":120.686}')).toEqual({
      lat: 24.137,
      lng: 120.686,
    });
  });

  it("parses objects with lat/lng or latitude/longitude", () => {
    expect(parseLocation({ lat: 24.137, lng: 120.686 })).toEqual({
      lat: 24.137,
      lng: 120.686,
    });
    expect(parseLocation({ latitude: "24.137", longitude: "120.686" })).toEqual(
      {
        lat: 24.137,
        lng: 120.686,
      },
    );
  });

  it("parses GeoJSON array [lng, lat] and [lat, lng]", () => {
    expect(parseLocation([120.686, 24.137])).toEqual({
      lat: 24.137,
      lng: 120.686,
    });
    expect(parseLocation([24.137, 120.686])).toEqual({
      lat: 24.137,
      lng: 120.686,
    });
  });

  it("returns undefined for invalid inputs", () => {
    expect(parseLocation(undefined)).toBeUndefined();
    expect(parseLocation(null)).toBeUndefined();
    expect(parseLocation("")).toBeUndefined();
    expect(parseLocation("invalid,input")).toBeUndefined();
    expect(parseLocation({})).toBeUndefined();
    expect(parseLocation([999, 999])).toBeUndefined();
  });
});

describe("simplifyPath", () => {
  it("刪掉共線的中間點、保留轉折與端點", () => {
    const path: [number, number][] = [
      [121.5, 25.0],
      [121.501, 25.0],
      [121.502, 25.0],
      [121.502, 25.001],
    ];
    expect(simplifyPath(path, 5)).toEqual([
      [121.5, 25.0],
      [121.502, 25.0],
      [121.502, 25.001],
    ]);
  });

  it("偏離超過容許值的點不會被刪", () => {
    const path: [number, number][] = [
      [121.5, 25.0],
      [121.501, 25.0001],
      [121.502, 25.0],
    ];
    expect(simplifyPath(path, 5)).toHaveLength(3);
  });
});

describe("roundCoordinate", () => {
  it("rounds both axes to 6 decimals", () => {
    expect(roundCoordinate([121.12345678, 25.98765432])).toEqual([
      121.123457, 25.987654,
    ]);
  });
});
