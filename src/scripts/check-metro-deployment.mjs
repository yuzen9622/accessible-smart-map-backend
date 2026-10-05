// Run inside the actual backend container; tokens are kept only in private seed files.
import fs from "node:fs";
import crypto from "node:crypto";
const base = `http://127.0.0.1:${process.env.PORT || 8000}`;
const command = process.argv[2];
const filename = process.argv[3];
const rows = [];
function check(name, ok, facts = {}) {
  rows.push({ name, pass: !!ok, ...facts });
  if (!ok) throw new Error(`Deployment check failed: ${name}`);
}
async function post(suffix, body) {
  const response = await fetch(
    base + "/api/v1/a11y/accessible-route" + suffix,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90000),
    },
  );
  return {
    status: response.status,
    json: await response.json(),
    countersHeader: response.headers.get("X-Benchmark-Counters"),
  };
}
function input(c, mode = "normal", preference = "metro") {
  return {
    origin: { latitude: c.o[0], longitude: c.o[1] },
    destination: { latitude: c.d[0], longitude: c.d[1] },
    travelMode: "transit",
    mode,
    transitPreference: preference,
    maxTransfers: 2,
    departureTime: "2026-10-05T09:00:00+08:00",
  };
}
const cases = [
  { id: "TPE", o: [25.041135, 121.565685], d: [25.042025, 121.508175] },
  { id: "NWT", o: [24.95761, 121.53746], d: [25.013858, 121.515462] },
  { id: "TAO", o: [25.06053, 121.37073], d: [25.01374, 121.21406] },
  { id: "TXG", o: [24.17141, 120.66045], d: [24.11011, 120.61405] },
  { id: "TNN", o: [22.9973, 120.2128], d: [23.0381, 120.2533] },
  { id: "KHH", o: [22.639694, 120.302703], d: [22.688376, 120.308887] },
  { id: "KHH-LRT", o: [22.635988, 120.282567], d: [22.65604, 120.30282] },
];
let redis;
try {
  const health = await fetch(base + "/health");
  const status = await health.json();
  check(
    "actual-service-health",
    health.status === 200 && status.status === "OK",
  );
  if (command === "seed-legacy") {
    const seeds = [];
    for (const preference of ["none", "bus", "rail"]) {
      const result = await post("", input(cases[0], "normal", preference));
      const route = result.json.data?.routes?.[0];
      check(
        `seed-${preference}`,
        result.status === 200 &&
          result.json.data?.transitPreference === preference &&
          !!route?.routeToken,
      );
      seeds.push({
        preference,
        token: route.routeToken,
        version: route.routeVersion || 1,
        position: input(cases[0]).origin,
      });
    }
    fs.writeFileSync(filename, JSON.stringify(seeds), {
      mode: 0o600,
      flag: "wx",
    });
  } else if (command === "verify") {
    ({ default: redis } = await import("/app/dist/config/redis.js"));
    await redis.redisReady();
    let seeds;
    try {
      seeds = JSON.parse(fs.readFileSync(filename || 0, "utf8"));
    } catch {
      throw new Error("Private legacy seed could not be read");
    }
    async function rerouteAndCheck(seed, label) {
      const result = await post("/reroute", {
        routeToken: seed.token,
        currentPosition: seed.position,
        previousRouteVersion: seed.version,
        reason: "MANUAL",
        clientRequestId: crypto.randomUUID(),
      });
      const data = result.json.data;
      check(
        `${label}-reroute`,
        result.status === 200 &&
          data?.routeVersion === seed.version + 1 &&
          !!data?.routeToken &&
          data?.instructions?.length > 0 &&
          data?.steps?.length > 0,
        {
          status: result.status,
          versionBefore: seed.version,
          versionAfter: data?.routeVersion,
        },
      );
      const encoded = await redis.redisGet(
        "voice-nav:route:" + data.routeToken,
      );
      let canonical;
      try {
        canonical = encoded ? JSON.parse(encoded) : null;
      } catch {
        throw new Error("Canonical is not valid JSON");
      }
      check(
        `${label}-canonical`,
        canonical?.canonicalRequest?.transitPreference === seed.preference &&
          canonical?.routeVersion === data.routeVersion,
        { preference: seed.preference },
      );
    }
    for (const seed of seeds)
      await rerouteAndCheck(seed, `legacy-${seed.preference}`);
    let metroSeed;
    for (const c of cases)
      for (const mode of ["normal", "wheelchair"]) {
        const result = await post("", input(c, mode));
        const routes = result.json.data?.routes || [];
        const hasMetro = routes.some((route) =>
          route.legs.some((leg) => leg.type === "METRO"),
        );
        const expectedTransit =
          c.id === "TNN"
            ? !hasMetro &&
              routes.some((route) =>
                route.legs.some((leg) => leg.type === "TRA"),
              )
            : hasMetro;
        check(
          `${c.id}-${mode}`,
          result.status === 200 &&
            result.json.data?.transitPreference === "metro" &&
            routes.length > 0 &&
            expectedTransit &&
            result.countersHeader === null,
          {
            status: result.status,
            hasMetro,
            types: routes.map((route) =>
              route.legs
                .filter((leg) => leg.type !== "WALK")
                .map((leg) => leg.type),
            ),
          },
        );
        if (c.id === "TPE" && mode === "normal")
          metroSeed = {
            token: routes[0].routeToken,
            version: routes[0].routeVersion || 1,
            position: input(c).origin,
            preference: "metro",
          };
      }
    await rerouteAndCheck(metroSeed, "metro");
    for (const preference of ["none", "bus", "rail"]) {
      const result = await post("", input(cases[0], "normal", preference));
      check(
        `existing-${preference}`,
        result.status === 200 &&
          result.json.data?.transitPreference === preference &&
          result.json.data?.routes?.length > 0,
      );
    }
    for (const explicitNone of [false, true]) {
      const body = input(cases[0]);
      if (explicitNone) body.transitPreference = "none";
      else delete body.transitPreference;
      body.query = "我想從市政府站到西門站，偏好搭地鐵或輕軌";
      const result = await post("", body);
      const parsed = result.json.data?.intent?.preferences?.transitPreference;
      const applied = result.json.data?.transitPreference;
      check(
        explicitNone ? "natural-intent-explicit-none" : "natural-intent-metro",
        result.status === 200 &&
          parsed === "metro" &&
          applied === (explicitNone ? "none" : "metro"),
        { status: result.status, parsed, applied },
      );
    }
    const invalid = await post("", {
      ...input(cases[0]),
      transitPreference: "subway",
    });
    check("invalid-subway-rejected", invalid.status === 400, {
      status: invalid.status,
    });
    const docs = await fetch(base + "/api/v1/openapi.json");
    check("production-docs-policy-preserved", docs.status === 404, {
      status: docs.status,
    });
    const { generateOpenAPIDocument } =
      await import("/app/dist/openapi/document.js");
    const enums = [];
    function scan(value, key = "$") {
      if (!value || typeof value !== "object") return;
      if (key.endsWith(".transitPreference") && Array.isArray(value.enum))
        enums.push(value.enum);
      for (const [name, child] of Object.entries(value))
        scan(child, key + "." + name);
    }
    scan(generateOpenAPIDocument());
    check(
      "deployed-openapi-enums",
      enums.length >= 3 &&
        enums.every(
          (values) =>
            JSON.stringify(values) ===
            JSON.stringify(["none", "bus", "rail", "metro"]),
        ),
      { enums: enums.length },
    );
  } else throw new Error("Unknown check command");
  console.log(JSON.stringify({ pass: true, command, checks: rows }));
} catch (error) {
  console.log(
    JSON.stringify({
      pass: false,
      command,
      checks: rows,
      error: error.message,
    }),
  );
  process.exitCode = 1;
} finally {
  redis?.redisClient?.disconnect();
}
