import axios from "axios";
import { strict as assert } from "assert";

const BASE_URL = process.env.TEST_API_URL || "http://localhost:8000";

// Helper to inspect objects recursively for redundant fields (e.g. __v, duplicate coordinates)
function findRedundancies(obj: any, path = ""): string[] {
  const warnings: string[] = [];
  if (!obj || typeof obj !== "object") return warnings;

  if (Array.isArray(obj)) {
    // Check first few items of array to avoid duplicating warnings for every item
    const itemsToCheck = Math.min(obj.length, 2);
    for (let i = 0; i < itemsToCheck; i++) {
      warnings.push(...findRedundancies(obj[i], `${path}[${i}]`));
    }
    return warnings;
  }

  // Check for __v
  if (Object.hasOwn(obj, "__v")) {
    warnings.push(`${path ? path + "." : ""}__v (Mongoose internal version key)`);
  }

  // Check for duplicate coordinates: location (Point) and separate lat/lng or 經度/緯度
  const hasLocation =
    obj.location &&
    typeof obj.location === "object" &&
    obj.location.type === "Point" &&
    Array.isArray(obj.location.coordinates);
  const hasSeparateCoordsZh = Object.hasOwn(obj, "經度") && Object.hasOwn(obj, "緯度");
  const hasSeparateCoordsEn = Object.hasOwn(obj, "latitude") && Object.hasOwn(obj, "longitude");

  if (hasLocation && hasSeparateCoordsZh) {
    warnings.push(`${path ? path + "." : ""}Duplicate coordinates: both "經度"/"緯度" and "location.coordinates" are present`);
  }
  if (hasLocation && hasSeparateCoordsEn) {
    warnings.push(`${path ? path + "." : ""}Duplicate coordinates: both "latitude"/"longitude" and "location.coordinates" are present`);
  }

  // Recurse into children
  for (const [key, value] of Object.entries(obj)) {
    // Avoid double recursion on location coordinates
    if (key !== "location") {
      warnings.push(...findRedundancies(value, path ? `${path}.${key}` : key));
    }
  }

  return warnings;
}

// Deduplicate warnings (strip out index differences so we only report schema issues once)
function cleanWarnings(warnings: string[]): string[] {
  const cleaned = warnings.map((w) => w.replace(/\[\d+\]/g, "[]"));
  return Array.from(new Set(cleaned));
}

async function runTests() {
  console.log("==================================================");
  console.log("   ACCESSIBLE SMART MAP BACKEND INTEGRATION TESTS ");
  console.log("==================================================");
  console.log(`Targeting Server: ${BASE_URL}\n`);

  let passed = 0;
  let failed = 0;
  const auditReport: { [route: string]: { status: string; redundancies: string[]; notes?: string } } = {};

  // Session variables
  let accessToken = "";
  let refreshTokenCookie = "";
  let testUserId = "";
  const testClientId = "test-oauth-client-id-12345";
  const testEmail = "test-user-integration@example.com";

  const runTest = async (
    name: string,
    route: string,
    testFn: () => Promise<{ note?: string }>
  ) => {
    console.log(`[TEST] ${name} (${route})...`);
    try {
      const { note } = await testFn();
      console.log(`  \x1b[32m✔ PASSED\x1b[0m`);
      passed++;
      const existing = auditReport[route];
      auditReport[route] = {
        status: "PASS",
        redundancies: existing?.redundancies || [],
        notes: note || existing?.notes
      };
    } catch (error: any) {
      console.error(`  \x1b[31m✘ FAILED\x1b[0m:`, error.message);
      if (error.response) {
        console.error(`    Status: ${error.response.status}`);
        console.error(`    Body:`, JSON.stringify(error.response.data));
      }
      failed++;
      const existing = auditReport[route];
      auditReport[route] = {
        status: "FAIL",
        redundancies: existing?.redundancies || [],
        notes: error.message
      };
    }
    console.log("--------------------------------------------------");
  };

  // 1. Health check
  await runTest("Health Check", "GET /health", async () => {
    const res = await axios.get(`${BASE_URL}/health`);
    assert.equal(res.status, 200);
    assert.equal(res.data.status, "OK");
    assert.ok(res.data.message);
    const redundancies = cleanWarnings(findRedundancies(res.data));
    auditReport["GET /health"] = { status: "PASS", redundancies };
    return {};
  });

  // 2. OpenAPI Spec
  await runTest("OpenAPI Spec", "GET /api/v1/openapi.json", async () => {
    const res = await axios.get(`${BASE_URL}/api/v1/openapi.json`);
    assert.equal(res.status, 200);
    assert.ok(res.data.openapi);
    const redundancies = cleanWarnings(findRedundancies(res.data));
    auditReport["GET /api/v1/openapi.json"] = { status: "PASS", redundancies };
    return {};
  });

  // 3. User Login
  await runTest("User Login", "POST /api/v1/user/login", async () => {
    const res = await axios.post(`${BASE_URL}/api/v1/user/login`, {
      name: "Integration Test User",
      email: testEmail,
      client_id: testClientId,
      avatar: "https://example.com/avatar.png",
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.ok, true);
    assert.ok(res.data.accessToken);
    assert.ok(res.data.data.user);
    assert.ok(res.data.data.config);

    accessToken = res.data.accessToken;
    testUserId = res.data.data.user._id;

    // Capture cookies
    const cookies = res.headers["set-cookie"];
    if (cookies) {
      refreshTokenCookie = cookies.join("; ");
    }

    const redundancies = cleanWarnings(findRedundancies(res.data));
    auditReport["POST /api/v1/user/login"] = { status: "PASS", redundancies };
    return { note: `Successfully logged in. User ID: ${testUserId}` };
  });

  // 4. User Info (Requires auth)
  await runTest("User Info", "GET /api/v1/user/info", async () => {
    const res = await axios.get(`${BASE_URL}/api/v1/user/info`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.ok, true);
    assert.equal(res.data.data.user.email, testEmail);

    const redundancies = cleanWarnings(findRedundancies(res.data));
    auditReport["GET /api/v1/user/info"] = { status: "PASS", redundancies };
    return {};
  });

  // 5. Get User Config (Requires auth)
  await runTest("Get User Config", "POST /api/v1/user/config", async () => {
    const res = await axios.post(
      `${BASE_URL}/api/v1/user/config`,
      {},
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    assert.equal(res.status, 200);
    assert.equal(res.data.ok, true);
    assert.equal(res.data.data.user_id, testUserId);

    const redundancies = cleanWarnings(findRedundancies(res.data));
    auditReport["POST /api/v1/user/config"] = { status: "PASS", redundancies };
    return {};
  });

  // 6. Update User Config (Requires auth)
  await runTest("Update User Config", "POST /api/v1/user/config/update", async () => {
    const res = await axios.post(
      `${BASE_URL}/api/v1/user/config/update`,
      { language: "en", darkMode: "dark" },
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    assert.equal(res.status, 200);
    assert.equal(res.data.ok, true);
    assert.equal(res.data.data.language, "en");
    assert.equal(res.data.data.darkMode, "dark");

    const redundancies = cleanWarnings(findRedundancies(res.data));
    auditReport["POST /api/v1/user/config/update"] = { status: "PASS", redundancies };
    return {};
  });

  // 7. Token Re-issue
  await runTest("Token Re-issue", "POST /api/v1/user/token", async () => {
    const res = await axios.post(`${BASE_URL}/api/v1/user/token`, {
      token: accessToken,
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.ok, true);
    assert.ok(res.data.accessToken);

    const redundancies = cleanWarnings(findRedundancies(res.data));
    auditReport["POST /api/v1/user/token"] = { status: "PASS", redundancies };
    return {};
  });

  // 8. Refresh Token (via cookies)
  await runTest("Refresh Token", "POST /api/v1/user/refresh", async () => {
    const res = await axios.post(
      `${BASE_URL}/api/v1/user/refresh`,
      {},
      {
        headers: { Cookie: refreshTokenCookie },
      }
    );
    assert.equal(res.status, 200);
    assert.equal(res.data.ok, true);
    assert.ok(res.data.accessToken);

    const redundancies = cleanWarnings(findRedundancies(res.data));
    auditReport["POST /api/v1/user/refresh"] = { status: "PASS", redundancies };
    return {};
  });

  // 9. Bus Arrival ETA
  await runTest("Bus Arrival ETA", "POST /api/v1/transit/bus", async () => {
    const res = await axios.post(`${BASE_URL}/api/v1/transit/bus`, {
      route_name: "299",
      arrival_stop: "捷運台北車站",
      departure_stop: "捷運忠孝復興站",
      arrival_lat: 25.0478,
      arrival_lng: 121.5171,
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.ok, true);
    assert.ok(Array.isArray(res.data.data));

    const redundancies = cleanWarnings(findRedundancies(res.data));
    auditReport["POST /api/v1/transit/bus"] = { status: "PASS", redundancies };
    return { note: `Found ${res.data.data.length} ETA estimates` };
  });

  // 10. Bus Realtime Position
  await runTest("Bus Realtime Position", "GET /api/v1/transit/bus/realtime", async () => {
    try {
      const res = await axios.get(`${BASE_URL}/api/v1/transit/bus/realtime`, {
        params: {
          plate_number: "KKA-9999", // Mock format, but satisfies the regex validation
          arrival_lat: "25.0478",
          arrival_lng: "121.5171",
          route_name: "299",
        },
      });
      assert.ok(res.status === 200 || res.status === 404);
      const redundancies = cleanWarnings(findRedundancies(res.data));
      auditReport["GET /api/v1/transit/bus/realtime"] = { status: "PASS", redundancies };
      return { note: `HTTP Status: ${res.status}. Returned data: ${JSON.stringify(res.data.data)}` };
    } catch (err: any) {
      if (err.response && (err.response.status === 400 || err.response.status === 404)) {
        auditReport["GET /api/v1/transit/bus/realtime"] = {
          status: "PASS (Graceful Fail)",
          redundancies: [],
          notes: `Returned expected 400/404 for invalid plate: ${err.response.data.message}`,
        };
        return {};
      }
      throw err;
    }
  });

  // 11. All Places (A11y)
  await runTest("All Places", "GET /api/v1/a11y/all-places", async () => {
    const res = await axios.get(`${BASE_URL}/api/v1/a11y/all-places`);
    assert.equal(res.status, 200);
    assert.equal(res.data.ok, true);
    assert.ok(Array.isArray(res.data.data));

    const redundancies = cleanWarnings(findRedundancies(res.data));
    auditReport["GET /api/v1/a11y/all-places"] = { status: "PASS", redundancies };
    return { note: `Fetched ${res.data.data.length} barrier-free places` };
  });

  // 12. All Bathrooms (A11y)
  await runTest("All Bathrooms", "GET /api/v1/a11y/all-bathrooms", async () => {
    const res = await axios.get(`${BASE_URL}/api/v1/a11y/all-bathrooms`);
    assert.equal(res.status, 200);
    assert.equal(res.data.ok, true);
    assert.ok(Array.isArray(res.data.data));

    const redundancies = cleanWarnings(findRedundancies(res.data));
    auditReport["GET /api/v1/a11y/all-bathrooms"] = { status: "PASS", redundancies };
    return { note: `Fetched ${res.data.data.length} barrier-free bathrooms` };
  });

  // 13. Nearby A11y (A11y)
  await runTest("Nearby A11y", "GET /api/v1/a11y/nearby-a11y", async () => {
    const res = await axios.get(`${BASE_URL}/api/v1/a11y/nearby-a11y`, {
      params: { lat: "25.0478", lng: "121.5171" },
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.ok, true);
    assert.ok(res.data.data.nearbyMetroA11y);
    assert.ok(res.data.data.nearbyBathroom);
    assert.ok(res.data.data.nearbyOsm);

    const redundancies = cleanWarnings(findRedundancies(res.data));
    auditReport["GET /api/v1/a11y/nearby-a11y"] = { status: "PASS", redundancies };
    return {
      note: `Found ${res.data.data.nearbyMetroA11y.length} metro exit/lifts, ${res.data.data.nearbyBathroom.length} bathrooms, and ${res.data.data.nearbyOsm.length} OSM nodes.`,
    };
  });

  // 14. Place details (A11y)
  await runTest("Place Details", "GET /api/v1/a11y/place", async () => {
    const res = await axios.get(`${BASE_URL}/api/v1/a11y/place`, {
      params: { osmId: "3541337393" },
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.ok, true);
    assert.ok(Array.isArray(res.data.data));
    assert.equal(res.data.data[0].osmId, "3541337393");

    const redundancies = cleanWarnings(findRedundancies(res.data));
    auditReport["GET /api/v1/a11y/place"] = { status: "PASS", redundancies };
    return {};
  });

  // 15. Accessible Route Planner (A11y)
  await runTest("Accessible Route Planner", "POST /api/v1/a11y/accessible-route", async () => {
    const res = await axios.post(`${BASE_URL}/api/v1/a11y/accessible-route`, {
      origin: { latitude: 25.0478, longitude: 121.5171 },
      destination: { latitude: 25.0339, longitude: 121.5644 },
      mode: "wheelchair",
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.ok, true);
    assert.ok(res.data.data.routes);

    const redundancies = cleanWarnings(findRedundancies(res.data));
    auditReport["POST /api/v1/a11y/accessible-route"] = { status: "PASS", redundancies };
    return { note: `Planned ${res.data.data.routes.length} candidate routes` };
  });

  // 16. Air Quality
  await runTest("Air Quality", "GET /api/v1/air/air-quality", async () => {
    const res = await axios.get(`${BASE_URL}/api/v1/air/air-quality`, {
      params: { lat: "25.0478", lng: "121.5171" },
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.ok, true);
    assert.ok(res.data.data.quality);

    const redundancies = cleanWarnings(findRedundancies(res.data));
    auditReport["GET /api/v1/air/air-quality"] = { status: "PASS", redundancies };
    return { note: `Quality: ${res.data.data.quality}. Description: ${res.data.data.description}` };
  });

  // 17. AI Intent
  await runTest("AI Intent", "POST /api/v1/ai/intent", async () => {
    const res = await axios.post(`${BASE_URL}/api/v1/ai/intent`, {
      query: "我坐輪椅要從台北車站到台北101",
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.ok, true);
    assert.equal(res.data.data.mode, "wheelchair");

    const redundancies = cleanWarnings(findRedundancies(res.data));
    auditReport["POST /api/v1/ai/intent"] = { status: "PASS", redundancies };
    return { note: `Parsed origin: ${res.data.data.origin}, destination: ${res.data.data.destination}` };
  });

  // 18. AI Explain
  await runTest("AI Explain", "POST /api/v1/ai/explain", async () => {
    const res = await axios.post(`${BASE_URL}/api/v1/ai/explain`, {
      route: {
        totalMinutes: 15,
        legs: [
          {
            type: "WALK",
            from: "台北車站",
            to: "捷運台北車站",
            distanceM: 100,
            minutesEst: 2,
            polyline: [[121.5171, 25.0478], [121.5173, 25.0475]],
            a11yFacilities: [],
          },
        ],
      },
      mode: "wheelchair",
      language: "zh-TW",
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.ok, true);
    assert.ok(res.data.data.summary);

    const redundancies = cleanWarnings(findRedundancies(res.data));
    auditReport["POST /api/v1/ai/explain"] = { status: "PASS", redundancies };
    return { note: `Explanation summary: ${res.data.data.summary.substring(0, 60)}...` };
  });

  // 19. AI Chat
  await runTest("AI Chat", "POST /api/v1/ai/chat", async () => {
    const res = await axios.post(`${BASE_URL}/api/v1/ai/chat`, {
      messages: [{ role: "user", content: "台北車站附近的無障礙廁所在哪裡？" }],
      stream: false,
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.ok, true);
    assert.ok(res.data.data.choices);

    const redundancies = cleanWarnings(findRedundancies(res.data));
    auditReport["POST /api/v1/ai/chat"] = { status: "PASS", redundancies };
    return { note: `AI Response choice 0 content: ${res.data.data.choices[0].message.content.substring(0, 60)}...` };
  });

  // 20. User Logout (Requires cookies)
  await runTest("User Logout", "POST /api/v1/user/logout", async () => {
    const res = await axios.post(
      `${BASE_URL}/api/v1/user/logout`,
      {},
      {
        headers: { Cookie: refreshTokenCookie },
      }
    );
    assert.equal(res.status, 200);
    assert.equal(res.data.ok, true);

    const redundancies = cleanWarnings(findRedundancies(res.data));
    auditReport["POST /api/v1/user/logout"] = { status: "PASS", redundancies };
    return {};
  });

  console.log("\n==================================================");
  console.log("                TEST RUN SUMMARY                  ");
  console.log("==================================================");
  console.log(`Passed: ${passed}/${passed + failed}`);
  console.log(`Failed: ${failed}/${passed + failed}`);
  console.log("==================================================\n");

  console.log("==================================================");
  console.log("           REDUNDANT FIELDS AUDIT REPORT          ");
  console.log("==================================================");
  for (const [route, info] of Object.entries(auditReport)) {
    console.log(`Route: ${route}`);
    console.log(`Status: ${info.status}`);
    if (info.redundancies.length > 0) {
      console.log(`Redundancies:`);
      info.redundancies.forEach((r) => console.log(`  - \x1b[33m${r}\x1b[0m`));
    } else {
      console.log(`Redundancies: None detected`);
    }
    console.log("");
  }
}

runTests().catch((err) => {
  console.error("Test execution aborted with severe error:", err);
  process.exit(1);
});
