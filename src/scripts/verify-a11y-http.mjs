import fs from "node:fs";
// Fixed short/long route matrix against an actual HTTP server.
if (!process.argv[2] || !process.argv[3])
  throw new Error("Usage: base-url output.json");
(async () => {
  const output = [];
  const cases = [
    ["short", [121.5651, 25.0412], [121.5579, 25.0413]],
    ["long", [121.4986, 25.1318], [121.5807, 24.9983]],
    ["extended", [121.4456, 25.1679], [121.5807, 24.9983]],
  ];
  for (const [name, from, to] of cases)
    for (const mode of ["normal", "elderly", "wheelchair"]) {
      const body = {
        travelMode: "walk",
        mode,
        origin: { latitude: from[1], longitude: from[0] },
        destination: { latitude: to[1], longitude: to[0] },
      };
      const t = Date.now();
      try {
        const r = await fetch(
          process.argv[2] + "/api/v1/a11y/accessible-route",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(150000),
          },
        );
        const d = await r.json();
        const routes = d.data?.routes ?? [];
        output.push({
          name,
          mode,
          request: body,
          http: r.status,
          ms: Date.now() - t,
          code: d.code,
          routeCount: routes.length,
          routes: routes.map((x) => ({
            engine: x.engine,
            degraded: x.degraded,
            totalMinutes: x.totalMinutes,
            totalWalkDistanceM: x.totalWalkDistanceM,
            warnings: x.warnings,
            hazardAdvisory: x.hazardAdvisory,
            legs: x.legs?.map((l) => ({
              type: l.type,
              points: l.polyline?.length,
              a11y: l.accessibility,
            })),
          })),
        });
      } catch (e) {
        output.push({ name, mode, error: e.message, ms: Date.now() - t });
      }
      console.log(JSON.stringify(output.at(-1)));
    }
  fs.writeFileSync(
    process.argv[3],
    JSON.stringify(
      {
        observedAt: new Date().toISOString(),
        baseUrl: process.argv[2],
        results: output,
      },
      null,
      2,
    ),
  );
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
