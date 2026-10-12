import { afterEach, describe, expect, it } from "vitest";
import {
  forLineExternalOpen,
  routePreviewUrl,
  sosTrackingUrl,
} from "./public-links";

afterEach(() => {
  delete process.env.PUBLIC_TRACKING_BASE_URL;
  delete process.env.PUBLIC_LIFF_ROUTE_BASE_URL;
});

describe("public links", () => {
  it("builds the app-claimable tracking path from the share token", () => {
    process.env.PUBLIC_TRACKING_BASE_URL = "https://map.example.com/";
    expect(sosTrackingUrl("abc")).toBe(
      "https://map.example.com/zh-TW/sos/?token=abc",
    );
  });

  it("falls back to the map home for route previews (no /liff/route page)", () => {
    process.env.PUBLIC_TRACKING_BASE_URL = "https://map.example.com";
    expect(routePreviewUrl("abc")).toBe(
      "https://map.example.com/zh-TW/?sessionId=abc",
    );
  });

  it("prefers the explicit route-preview base", () => {
    process.env.PUBLIC_LIFF_ROUTE_BASE_URL = "https://liff.example.com/route";
    expect(routePreviewUrl("abc")).toBe(
      "https://liff.example.com/route?sessionId=abc",
    );
  });

  it("returns undefined without any configured base", () => {
    expect(routePreviewUrl("abc")).toBeUndefined();
  });

  it("adds LINE's external-browser flag without dropping the token", () => {
    expect(
      forLineExternalOpen("https://map.example.com/zh-TW/sos/?token=abc"),
    ).toBe(
      "https://map.example.com/zh-TW/sos/?token=abc&openExternalBrowser=1",
    );
  });
});
