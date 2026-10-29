import { describe, expect, it } from "vitest";
import {
  projectRouteForModel,
  projectToolResult,
  summarizeRouteResult,
} from "./agent-route-projection";

describe("source name route projections", () => {
  it("retains valid JSON values and omitted optional fields", () => {
    expect(
      projectRouteForModel({ a: null, b: undefined, c: [true, 0, "原文"] }),
    ).toEqual({ a: null, b: undefined, c: [true, 0, "原文"] });
  });
  it.each([BigInt(1), Symbol("not JSON"), () => "not JSON"])(
    "rejects unsupported tool data rather than making a false domain assertion",
    (value) => {
      expect(() => projectRouteForModel({ value })).toThrow(
        "JSON-compatible tool data",
      );
    },
  );
  const step = Object.freeze({
    relativeDirection: "DEPART",
    absoluteDirection: "NORTH",
    streetName: "羅斯福路",
    bogusName: false,
    area: false,
    stairs: false,
    steepSlope: false,
    distanceM: 80,
    location: [121.5, 25.05],
  });
  const leg = Object.freeze({
    type: "WALK",
    from: "起點",
    to: "臺北車站",
    fromDisplayName: "Origin",
    toDisplayName: "Taipei Main Station",
    routeDisplayName: "Walking route",
    steps: Object.freeze([step]),
    stepStreetNames: Object.freeze([
      {
        index: 0,
        streetName: "羅斯福路",
        nameEn: "Roosevelt Road",
        displayName: "Roosevelt Road",
      },
    ]),
    polyline: [
      [121.5, 25.05],
      [121.501, 25.05],
    ],
  });
  const payload = Object.freeze({
    planId: "plan",
    selectedRouteId: "route",
    routes: Object.freeze([
      {
        routeId: "route",
        routeToken: "private-capability",
        legs: [leg],
        warnings: [],
      },
    ]),
  });

  it("retains the canonical nine fields and sidecar for the client but excludes bulk street data from the model", () => {
    const before = JSON.stringify(payload);
    const result = projectToolResult(payload);
    expect(result.clientResult).toBe(payload);
    expect(JSON.stringify(result.modelResult)).not.toContain(
      "private-capability",
    );
    expect(JSON.stringify(result.modelResult)).not.toContain("stepStreetNames");
    expect(JSON.stringify(result.modelResult)).not.toContain("Roosevelt Road");
    expect(result.modelResult).toMatchObject({
      routes: [
        {
          legs: [
            {
              from: "起點",
              to: "臺北車站",
              fromDisplayName: "Origin",
              toDisplayName: "Taipei Main Station",
            },
          ],
        },
      ],
    });
    expect(Object.keys(step)).toHaveLength(9);
    expect(JSON.stringify(payload)).toBe(before);
  });

  it("keeps source displays alongside canonical values in bounded model summaries", () => {
    const summary = summarizeRouteResult(payload, 4000);
    expect(summary).not.toBeNull();
    expect(JSON.parse(summary ?? "null")).toMatchObject({
      routes: [
        {
          legs: [
            {
              from: "起點",
              to: "臺北車站",
              fromDisplayName: "Origin",
              toDisplayName: "Taipei Main Station",
              routeDisplayName: "Walking route",
            },
          ],
        },
      ],
    });
    expect(summary).not.toContain("stepStreetNames");
    expect(summary).not.toContain("private-capability");
  });

  it("keeps the metro line, train terminal and alighting station in model summaries", () => {
    const summary = summarizeRouteResult(
      {
        routes: [
          {
            routeId: "metro",
            legs: [
              {
                type: "METRO",
                lineName: "板南線",
                terminalStation: "頂埔",
                terminalDisplayName: "Dingpu",
                arrivalStation: "台北車站",
              },
            ],
          },
        ],
      },
      4000,
    );
    expect(JSON.parse(summary ?? "null")).toMatchObject({
      routes: [
        {
          legs: [
            {
              lineName: "板南線",
              terminalStation: "頂埔",
              terminalDisplayName: "Dingpu",
              arrivalStation: "台北車站",
            },
          ],
        },
      ],
    });
  });
});

describe("summarizeRouteResult indoor ends", () => {
  it("names both ends of an indoor-only plan and the indoor end of a venue trip", () => {
    const indoorOnly = summarizeRouteResult(
      {
        planId: "p",
        selectedRouteId: "indoor:a>b",
        venueLeg: { fromPlaceId: "info-2606", toPlaceId: "info-2301" },
        routes: [{ routeId: "indoor:a>b", legs: [] }],
      },
      1200,
    );
    expect(JSON.parse(indoorOnly!).indoor).toEqual({
      from: "info-2606",
      to: "info-2301",
    });
    const intoVenue = summarizeRouteResult(
      {
        planId: "p",
        selectedRouteId: "r",
        venueArrival: { placeId: "zk-3314" },
        venueLeg: { fromPlaceId: "gate", toPlaceId: "zk-3314" },
        routes: [{ routeId: "r", legs: [] }],
      },
      1200,
    );
    expect(JSON.parse(intoVenue!).indoor).toEqual({ to: "zk-3314" });
  });
});
