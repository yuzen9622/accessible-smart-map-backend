import { describe, it, expect } from "vitest";
import { haversineMeters, parseLocation } from "./geo";

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
