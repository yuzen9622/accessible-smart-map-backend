import { lineRoutePlanFixture } from "./line-route";

export function lineRoadPlanFixture(
  travelMode: "drive" | "motorcycle" = "drive",
) {
  const base = lineRoutePlanFixture();
  const polyline = [
    [121.56, 25.03],
    [121.517, 25.0478],
  ];
  return {
    ...base,
    travelMode,
    mode: "normal",
    transitPreference: "none",
    selectedRouteId: `${travelMode}-0`,
    effectivePreferences: {
      ...base.effectivePreferences,
      travelMode,
      mode: "normal",
      transitPreference: "none",
      avoidStairs: false,
      requireElevator: false,
    },
    routes: [
      {
        routeId: `${travelMode}-0`,
        routeToken: "trusted-road-route",
        routeName: travelMode === "drive" ? "開車路線" : "機車路線",
        totalMinutes: 12,
        transferCount: 0,
        accessibilityHighlights: [],
        legs: [
          {
            type: travelMode === "drive" ? "DRIVE" : "MOTORCYCLE",
            from: { lat: 25.03, lng: 121.56 },
            to: { lat: 25.0478, lng: 121.517 },
            distanceM: 3900,
            durationMin: 12,
            polyline,
            steps: [
              {
                instruction: "直行",
                distanceM: 3900,
                durationMin: 12,
                polyline,
              },
            ],
            maneuvers: [
              {
                instruction: "直行",
                type: 1,
                lengthKm: 3.9,
                timeSec: 720,
                beginShapeIndex: 0,
                endShapeIndex: 1,
                streetNames: ["市民大道"],
                highway: false,
                stairs: false,
              },
            ],
            trafficSegments: [
              {
                fromIndex: 0,
                toIndex: 1,
                trafficLevel: "unknown",
                congestionLevel: -99,
              },
            ],
          },
        ],
      },
    ],
  };
}
