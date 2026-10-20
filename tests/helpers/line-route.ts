export function lineRoutePlanFixture() {
  return {
    ok: true,
    routeContractVersion: 1,
    planId: "2a0f8f9c-1e14-4a60-bc57-74790655cf71",
    selectedRouteId: "bus-1",
    origin: { lat: 25.03, lng: 121.56, name: "目前位置" },
    destination: { lat: 25.0478, lng: 121.517, name: "台北車站" },
    city: "Taipei",
    travelMode: "transit",
    mode: "wheelchair",
    transitPreference: "bus",
    effectivePreferences: {
      mode: "wheelchair",
      travelMode: "transit",
      transitPreference: "bus",
      maxTransfers: 2,
      avoidStairs: true,
      requireElevator: true,
      needsAccessibleToilet: false,
      needsHandrail: false,
    },
    routes: [
      {
        routeId: "bus-1",
        routeToken: "trusted-route-token",
        routeName: "公車路線",
        totalMinutes: 12,
        transferCount: 0,
        accessibilityHighlights: [],
        legs: [
          {
            type: "BUS",
            routeName: "307",
            subRouteUid: "TPE307",
            subRouteName: "307往台北車站",
            departureStop: "起站",
            arrivalStop: "台北車站",
            waitInfo: { time: 3, source: "realtime" },
            direction: 0,
            polyline: [
              [121.56, 25.03],
              [121.517, 25.0478],
            ],
            departureStopA11y: [],
            arrivalStopA11y: [],
          },
        ],
      },
    ],
  };
}
