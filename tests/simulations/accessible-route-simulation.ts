import axios from "axios";
import * as fs from "fs";
import * as path from "path";
import dotenv from "dotenv";

dotenv.config();

const API_URL = process.env.TEST_API_URL || "http://100.121.9.105:8000/api/v1/a11y/accessible-route";
const NUM_TESTS = process.env.NUM_TESTS ? parseInt(process.env.NUM_TESTS) : 200;
const CONCURRENCY = process.env.CONCURRENCY ? parseInt(process.env.CONCURRENCY) : 5;

interface LocationDef {
  name: string;
  lat: number;
  lng: number;
  region: "North" | "Central" | "South" | "East" | "Island";
  system: "TRTC" | "TMRT" | "KRTC" | "TRA" | "THSR" | "Other";
  city: string;
}

interface TestCase {
  origin: LocationDef;
  destination: LocationDef;
  mode: string;
  category: "Northern Metro" | "Central Metro" | "Southern Metro" | "Cross-County" | "Taiwan-Wide Coverage";
  departureTime: string;
}

interface TestResult {
  testCase: TestCase;
  statusCode: number;
  success: boolean;
  latencyMs: number;
  routesCount: number;
  errorMessage?: string;
  dataConfidence?: string;
  transitModes: string[];
  warnings: string[];
  bestRouteScore?: number;
  bestRouteLabel?: string;
  legsDetail?: string;
}

const LOCATIONS: LocationDef[] = [
  // === 北部捷運/公車 (TRTC / Taipei & New Taipei & Taoyuan) ===
  { name: "台北車站", lat: 25.0478, lng: 121.5171, region: "North", system: "TRTC", city: "Taipei" },
  { name: "台北101/世貿站", lat: 25.0339, lng: 121.5644, region: "North", system: "TRTC", city: "Taipei" },
  { name: "西門站", lat: 25.0422, lng: 121.5083, region: "North", system: "TRTC", city: "Taipei" },
  { name: "淡水站", lat: 25.1678, lng: 121.4456, region: "North", system: "TRTC", city: "NewTaipei" },
  { name: "板橋車站", lat: 25.0130, lng: 121.4623, region: "North", system: "TRTC", city: "NewTaipei" },
  { name: "蘆洲站", lat: 25.0874, lng: 121.4647, region: "North", system: "TRTC", city: "NewTaipei" },
  { name: "南港展覽館站", lat: 25.0532, lng: 121.6175, region: "North", system: "TRTC", city: "Taipei" },
  { name: "動物園站", lat: 24.9982, lng: 121.5796, region: "North", system: "TRTC", city: "Taipei" },
  { name: "松山車站", lat: 25.0501, lng: 121.5777, region: "North", system: "TRTC", city: "Taipei" },
  { name: "頂溪站", lat: 25.0128, lng: 121.5152, region: "North", system: "TRTC", city: "NewTaipei" },
  { name: "桃園高鐵站 (捷運)", lat: 25.0130, lng: 121.2150, region: "North", system: "TRTC", city: "Taoyuan" },
  { name: "桃園機場第一航廈站", lat: 25.0833, lng: 121.2167, region: "North", system: "TRTC", city: "Taoyuan" },

  // === 中部捷運/公車 (TMRT / Taichung) ===
  { name: "高鐵台中站 (捷運)", lat: 24.1121, lng: 120.6162, region: "Central", system: "TMRT", city: "Taichung" },
  { name: "市政府站 (台中)", lat: 24.1627, lng: 120.6480, region: "Central", system: "TMRT", city: "Taichung" },
  { name: "北屯總站", lat: 24.1837, lng: 120.7047, region: "Central", system: "TMRT", city: "Taichung" },
  { name: "文心森林公園站", lat: 24.1432, lng: 120.6473, region: "Central", system: "TMRT", city: "Taichung" },
  { name: "烏日站 (捷運)", lat: 24.1089, lng: 120.6253, region: "Central", system: "TMRT", city: "Taichung" },
  { name: "豐樂公園站", lat: 24.1293, lng: 120.6473, region: "Central", system: "TMRT", city: "Taichung" },
  { name: "水安宮站", lat: 24.1541, lng: 120.6489, region: "Central", system: "TMRT", city: "Taichung" },

  // === 南部捷運/公車 (KRTC / Kaohsiung) ===
  { name: "左營站 (捷運)", lat: 22.6879, lng: 120.3069, region: "South", system: "KRTC", city: "Kaohsiung" },
  { name: "高雄車站 (捷運)", lat: 22.6397, lng: 120.3021, region: "South", system: "KRTC", city: "Kaohsiung" },
  { name: "美麗島站", lat: 22.6288, lng: 120.3026, region: "South", system: "KRTC", city: "Kaohsiung" },
  { name: "西子灣站", lat: 22.6217, lng: 120.2684, region: "South", system: "KRTC", city: "Kaohsiung" },
  { name: "小港站", lat: 22.5658, lng: 120.3544, region: "South", system: "KRTC", city: "Kaohsiung" },
  { name: "大寮站", lat: 22.6211, lng: 120.4283, region: "South", system: "KRTC", city: "Kaohsiung" },
  { name: "南岡山站", lat: 22.7938, lng: 120.2974, region: "South", system: "KRTC", city: "Kaohsiung" },
  { name: "凹子底站", lat: 22.6578, lng: 120.3029, region: "South", system: "KRTC", city: "Kaohsiung" },

  // === 跨縣市鐵路/高鐵/其他區域 (TRA / THSR / Other) ===
  { name: "基隆車站", lat: 25.1320, lng: 121.7397, region: "North", system: "TRA", city: "Keelung" },
  { name: "宜蘭車站", lat: 24.7547, lng: 121.7583, region: "East", system: "TRA", city: "Yilan" },
  { name: "羅東車站", lat: 24.6766, lng: 121.7761, region: "East", system: "TRA", city: "Yilan" },
  { name: "花蓮車站", lat: 23.9933, lng: 121.6012, region: "East", system: "TRA", city: "Hualien" },
  { name: "玉里車站", lat: 23.3347, lng: 121.3150, region: "East", system: "TRA", city: "Hualien" },
  { name: "台東車站", lat: 22.7931, lng: 121.1235, region: "East", system: "TRA", city: "Taitung" },
  { name: "屏東車站", lat: 22.6692, lng: 120.4862, region: "South", system: "TRA", city: "Pingtung" },
  { name: "潮州車站", lat: 22.5505, lng: 120.5422, region: "South", system: "TRA", city: "Pingtung" },
  { name: "高鐵左營站", lat: 22.6879, lng: 120.3069, region: "South", system: "THSR", city: "Kaohsiung" },
  { name: "高鐵台南站", lat: 22.9248, lng: 120.2858, region: "South", system: "THSR", city: "Tainan" },
  { name: "台南車站", lat: 22.9972, lng: 120.2128, region: "South", system: "TRA", city: "Tainan" },
  { name: "嘉義車站", lat: 23.4791, lng: 120.4411, region: "South", system: "TRA", city: "Chiayi" },
  { name: "高鐵嘉義站", lat: 23.4594, lng: 120.3243, region: "South", system: "THSR", city: "Chiayi" },
  { name: "高鐵雲林站", lat: 23.7349, lng: 120.4194, region: "Central", system: "THSR", city: "Yunlin" },
  { name: "斗六車站", lat: 23.7128, lng: 120.5447, region: "Central", system: "TRA", city: "Yunlin" },
  { name: "高鐵彰化站", lat: 23.8732, lng: 120.5843, region: "Central", system: "THSR", city: "Changhua" },
  { name: "員林車站", lat: 23.9592, lng: 120.5694, region: "Central", system: "TRA", city: "Changhua" },
  { name: "彰化車站", lat: 24.0818, lng: 120.5385, region: "Central", system: "TRA", city: "Changhua" },
  { name: "台中車站", lat: 24.1373, lng: 120.6869, region: "Central", system: "TRA", city: "Taichung" },
  { name: "高鐵新竹站", lat: 24.8083, lng: 121.0402, region: "North", system: "THSR", city: "Hsinchu" },
  { name: "新竹車站", lat: 24.8016, lng: 120.9714, region: "North", system: "TRA", city: "Hsinchu" },
  { name: "高鐵苗栗站", lat: 24.6062, lng: 120.8249, region: "Central", system: "THSR", city: "Miaoli" },
  { name: "苗栗車站", lat: 24.5701, lng: 120.8245, region: "Central", system: "TRA", city: "Miaoli" },
  { name: "竹南車站", lat: 24.6826, lng: 120.8817, region: "Central", system: "TRA", city: "Miaoli" },
  { name: "高鐵桃園站", lat: 25.0130, lng: 121.2150, region: "North", system: "THSR", city: "Taoyuan" },
  { name: "高鐵板橋站", lat: 25.0130, lng: 121.4623, region: "North", system: "THSR", city: "NewTaipei" },

  // === 特殊與偏遠地區/非捷運 (Other) ===
  { name: "澎湖馬公公車總站", lat: 23.5684, lng: 119.5668, region: "Island", system: "Other", city: "Penghu" },
  { name: "金門金城車站", lat: 24.4361, lng: 118.3188, region: "Island", system: "Other", city: "Kinmen" },
  { name: "阿里山國家森林遊樂區", lat: 23.5113, lng: 120.8030, region: "Central", system: "Other", city: "Chiayi" },
  { name: "日月潭水社碼頭", lat: 23.8684, lng: 120.9114, region: "Central", system: "Other", city: "Nantou" },
  { name: "墾丁大街", lat: 21.9441, lng: 120.7972, region: "South", system: "Other", city: "Pingtung" },
  { name: "礁溪溫泉公園", lat: 24.8296, lng: 121.7766, region: "East", system: "Other", city: "Yilan" },
  { name: "知本溫泉", lat: 22.6947, lng: 121.0205, region: "East", system: "Other", city: "Taitung" },
  { name: "清境農場", lat: 24.0583, lng: 121.1627, region: "Central", system: "Other", city: "Nantou" }
];

function getRandomDepartureTime(): string {
  const now = new Date();
  const daysOffset = Math.floor(Math.random() * 5); // 0 to 4 days ahead
  const hour = 7 + Math.floor(Math.random() * 15); // 07:00 to 22:00
  const minute = Math.floor(Math.random() * 60);
  
  const targetDate = new Date(now.getTime() + daysOffset * 24 * 60 * 60 * 1000);
  targetDate.setHours(hour, minute, 0, 0);
  
  const pad = (n: number) => n.toString().padStart(2, "0");
  const yyyy = targetDate.getFullYear();
  const mm = pad(targetDate.getMonth() + 1);
  const dd = pad(targetDate.getDate());
  const hh = pad(targetDate.getHours());
  const mi = pad(targetDate.getMinutes());
  const ss = pad(targetDate.getSeconds());
  
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}+08:00`;
}

function generateTestCases(count: number): TestCase[] {
  const cases: TestCase[] = [];
  const modes = ["wheelchair", "elderly", "visual_impaired", "normal"];
  
  const northMetro = LOCATIONS.filter((l) => l.region === "North" && l.system === "TRTC");
  const centralMetro = LOCATIONS.filter((l) => l.region === "Central" && l.system === "TMRT");
  const southMetro = LOCATIONS.filter((l) => l.region === "South" && l.system === "KRTC");
  const railHubs = LOCATIONS.filter((l) => l.system === "TRA" || l.system === "THSR");
  const remotePlaces = LOCATIONS.filter((l) => l.region === "East" || l.region === "Island" || l.system === "Other");

  // target distribution:
  // - North Metro: ~25%
  // - Central Metro: ~15%
  // - South Metro: ~15%
  // - Cross-County: ~30%
  // - Remote / Taiwan-Wide: ~15%
  
  const northCount = Math.floor(count * 0.25);
  const centralCount = Math.floor(count * 0.15);
  const southCount = Math.floor(count * 0.15);
  const crossCount = Math.floor(count * 0.30);
  const remoteCount = count - northCount - centralCount - southCount - crossCount;

  // 1. North Metro
  for (let i = 0; i < northCount; i++) {
    const o = northMetro[Math.floor(Math.random() * northMetro.length)];
    let d = northMetro[Math.floor(Math.random() * northMetro.length)];
    while (d.name === o.name) {
      d = northMetro[Math.floor(Math.random() * northMetro.length)];
    }
    cases.push({
      origin: o,
      destination: d,
      mode: modes[Math.floor(Math.random() * modes.length)],
      category: "Northern Metro",
      departureTime: getRandomDepartureTime()
    });
  }

  // 2. Central Metro
  for (let i = 0; i < centralCount; i++) {
    const o = centralMetro[Math.floor(Math.random() * centralMetro.length)];
    let d = centralMetro[Math.floor(Math.random() * centralMetro.length)];
    while (d.name === o.name) {
      d = centralMetro[Math.floor(Math.random() * centralMetro.length)];
    }
    cases.push({
      origin: o,
      destination: d,
      mode: modes[Math.floor(Math.random() * modes.length)],
      category: "Central Metro",
      departureTime: getRandomDepartureTime()
    });
  }

  // 3. South Metro
  for (let i = 0; i < southCount; i++) {
    const o = southMetro[Math.floor(Math.random() * southMetro.length)];
    let d = southMetro[Math.floor(Math.random() * southMetro.length)];
    while (d.name === o.name) {
      d = southMetro[Math.floor(Math.random() * southMetro.length)];
    }
    cases.push({
      origin: o,
      destination: d,
      mode: modes[Math.floor(Math.random() * modes.length)],
      category: "Southern Metro",
      departureTime: getRandomDepartureTime()
    });
  }

  // 4. Cross-County
  for (let i = 0; i < crossCount; i++) {
    const candidates = [...northMetro, ...centralMetro, ...southMetro, ...railHubs];
    const o = candidates[Math.floor(Math.random() * candidates.length)];
    let d = candidates[Math.floor(Math.random() * candidates.length)];
    let attempts = 0;
    while ((d.city === o.city || d.name === o.name) && attempts < 20) {
      d = candidates[Math.floor(Math.random() * candidates.length)];
      attempts++;
    }
    cases.push({
      origin: o,
      destination: d,
      mode: modes[Math.floor(Math.random() * modes.length)],
      category: "Cross-County",
      departureTime: getRandomDepartureTime()
    });
  }

  // 5. Remote / Taiwan-Wide
  for (let i = 0; i < remoteCount; i++) {
    const o = remotePlaces[Math.floor(Math.random() * remotePlaces.length)];
    const candidates = [...LOCATIONS];
    let d = candidates[Math.floor(Math.random() * candidates.length)];
    let attempts = 0;
    while ((d.name === o.name) && attempts < 20) {
      d = candidates[Math.floor(Math.random() * candidates.length)];
      attempts++;
    }
    cases.push({
      origin: o,
      destination: d,
      mode: modes[Math.floor(Math.random() * modes.length)],
      category: "Taiwan-Wide Coverage",
      departureTime: getRandomDepartureTime()
    });
  }

  // Shuffle
  return cases.sort(() => Math.random() - 0.5);
}

async function runTestCase(testCase: TestCase, idx: number, total: number): Promise<TestResult> {
  const payload = {
    origin: { latitude: testCase.origin.lat, longitude: testCase.origin.lng },
    destination: { latitude: testCase.destination.lat, longitude: testCase.destination.lng },
    mode: testCase.mode,
    departureTime: testCase.departureTime,
    format: "standard"
  };

  const startTime = Date.now();
  try {
    const response = await axios.post(API_URL, payload, { timeout: 35000 });
    const latency = Date.now() - startTime;
    const body = response.data;

    const routes = body.data?.routes || [];
    const transitModesSet = new Set<string>();
    let bestScore: number | undefined;
    let bestLabel: string | undefined;
    let warnings: string[] = [];
    let legsDetailStr = "";

    if (routes.length > 0) {
      const bestRoute = routes[0];
      bestScore = bestRoute.accessibilityScore;
      bestLabel = bestRoute.accessibilityLabel;
      warnings = bestRoute.scoreWarnings || [];
      
      // Collect all transit modes across all returned routes
      for (const route of routes) {
        for (const leg of route.legs) {
          transitModesSet.add(leg.type);
        }
      }
      
      // Get detail for best route legs
      legsDetailStr = bestRoute.legs.map((l: any) => {
        if (l.type === "WALK") return `WALK(${l.distanceM}m)`;
        if (l.type === "BUS") return `BUS(${l.routeName})`;
        if (l.type === "METRO") return `METRO(${l.lineId || l.lineName})`;
        if (l.type === "TRA") return `TRA(${l.trainNo || l.trainTypeName})`;
        if (l.type === "THSR") return `THSR(${l.trainNo})`;
        return l.type;
      }).join(" -> ");
    }

    console.log(
      `\x1b[36m[${idx + 1}/${total}]\x1b[0m \x1b[32m✔ SUCCESS\x1b[0m | \x1b[1m${testCase.category}\x1b[0m | ` +
      `\x1b[33m${testCase.origin.name}\x1b[0m -> \x1b[33m${testCase.destination.name}\x1b[0m | ` +
      `Mode: ${testCase.mode} | Routes: ${routes.length} | Latency: ${latency}ms`
    );

    return {
      testCase,
      statusCode: response.status,
      success: true,
      latencyMs: latency,
      routesCount: routes.length,
      dataConfidence: body.data?.routes?.[0]?.dataConfidence,
      transitModes: Array.from(transitModesSet),
      warnings,
      bestRouteScore: bestScore,
      bestRouteLabel: bestLabel,
      legsDetail: legsDetailStr
    };
  } catch (error: any) {
    const latency = Date.now() - startTime;
    const status = error.response?.status || 500;
    const message = error.response?.data?.message || error.message;

    console.log(
      `\x1b[36m[${idx + 1}/${total}]\x1b[0m \x1b[31m✘ FAILED\x1b[0m (${status}) | \x1b[1m${testCase.category}\x1b[0m | ` +
      `\x1b[33m${testCase.origin.name}\x1b[0m -> \x1b[33m${testCase.destination.name}\x1b[0m | ` +
      `Error: ${message.substring(0, 50)} | Latency: ${latency}ms`
    );

    return {
      testCase,
      statusCode: status,
      success: false,
      latencyMs: latency,
      routesCount: 0,
      errorMessage: message,
      transitModes: [],
      warnings: []
    };
  }
}

async function runPool(testCases: TestCase[]): Promise<TestResult[]> {
  const results: TestResult[] = [];
  const queue = [...testCases];
  const activePromises: Promise<void>[] = [];
  let idx = 0;
  const total = testCases.length;

  console.log(`Starting ${total} simulation tests targeting: ${API_URL}`);
  console.log(`Concurrency Limit: ${CONCURRENCY}\n`);

  const startTime = Date.now();

  const worker = async () => {
    while (queue.length > 0) {
      const task = queue.shift();
      if (!task) break;
      const currentIdx = idx++;
      const result = await runTestCase(task, currentIdx, total);
      results.push(result);
    }
  };

  // Start initial workers
  const numWorkers = Math.min(CONCURRENCY, queue.length);
  for (let w = 0; w < numWorkers; w++) {
    activePromises.push(worker());
  }

  await Promise.all(activePromises);
  const totalDuration = Date.now() - startTime;
  console.log(`\nAll tests completed in ${(totalDuration / 1000).toFixed(2)} seconds.\n`);

  return results;
}

function generateReport(results: TestResult[], durationMs: number): string {
  const total = results.length;
  const passed = results.filter((r) => r.success && r.statusCode === 200).length;

  // Latency metrics
  const validLatencies = results.map((r) => r.latencyMs);
  const avgLatency = validLatencies.reduce((a, b) => a + b, 0) / total;
  const sortedLatencies = [...validLatencies].sort((a, b) => a - b);
  const minLatency = sortedLatencies[0];
  const maxLatency = sortedLatencies[total - 1];
  const p95Latency = sortedLatencies[Math.floor(total * 0.95)] || maxLatency;

  // Category metrics
  const categories = ["Northern Metro", "Central Metro", "Southern Metro", "Cross-County", "Taiwan-Wide Coverage"] as const;
  const categoryStats = categories.map((cat) => {
    const catResults = results.filter((r) => r.testCase.category === cat);
    const catTotal = catResults.length;
    const catPassed = catResults.filter((r) => r.success && r.statusCode === 200).length;
    const catHasRoutes = catResults.filter((r) => r.success && r.routesCount > 0).length;
    const catAvgLat = catResults.reduce((sum, r) => sum + r.latencyMs, 0) / (catTotal || 1);
    
    return {
      category: cat,
      total: catTotal,
      passed: catPassed,
      passRate: catTotal > 0 ? (catPassed / catTotal) * 100 : 0,
      hasRoutes: catHasRoutes,
      hasRoutesRate: catTotal > 0 ? (catHasRoutes / catTotal) * 100 : 0,
      avgLatency: catAvgLat
    };
  });

  // Transit Modes Statistics (Across all successful routes)
  const modeCounts: { [mode: string]: number } = { WALK: 0, BUS: 0, METRO: 0, TRA: 0, THSR: 0 };
  results.forEach((r) => {
    if (r.success) {
      r.transitModes.forEach((m) => {
        if (modeCounts[m] !== undefined) {
          modeCounts[m]++;
        } else {
          modeCounts[m] = 1;
        }
      });
    }
  });

  // Accessibility modes stats
  const modeStats: { [mode: string]: { total: number; passed: number; hasRoutes: number } } = {
    wheelchair: { total: 0, passed: 0, hasRoutes: 0 },
    elderly: { total: 0, passed: 0, hasRoutes: 0 },
    visual_impaired: { total: 0, passed: 0, hasRoutes: 0 },
    normal: { total: 0, passed: 0, hasRoutes: 0 }
  };
  results.forEach((r) => {
    const m = r.testCase.mode;
    if (modeStats[m]) {
      modeStats[m].total++;
      if (r.success && r.statusCode === 200) {
        modeStats[m].passed++;
        if (r.routesCount > 0) {
          modeStats[m].hasRoutes++;
        }
      }
    }
  });

  // Labels and Warnings stats
  const labelCounts: { [label: string]: number } = { excellent: 0, good: 0, fair: 0, poor: 0, critical: 0 };
  const warningCounts: { [warning: string]: number } = {};
  const errorCounts: { [error: string]: number } = {};

  results.forEach((r) => {
    if (r.success) {
      if (r.bestRouteLabel && labelCounts[r.bestRouteLabel] !== undefined) {
        labelCounts[r.bestRouteLabel]++;
      }
      r.warnings.forEach((w) => {
        warningCounts[w] = (warningCounts[w] || 0) + 1;
      });
    } else if (r.errorMessage) {
      errorCounts[r.errorMessage] = (errorCounts[r.errorMessage] || 0) + 1;
    }
  });

  // Sort warnings and errors
  const sortedWarnings = Object.entries(warningCounts).sort((a, b) => b[1] - a[1]);
  const sortedErrors = Object.entries(errorCounts).sort((a, b) => b[1] - a[1]);

  const md = `# Accessible Route Planner Simulation Test Report

## 1. Executive Summary
This report summarizes the results of the comprehensive load and scenario simulation testing for the Accessible Route Planner endpoint:
\`${API_URL}\`

The test was run on **${new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei" })}** simulating **${total}** realistic user route planning requests covering all of Taiwan.

### Key Metrics
- **Total Executed Tests**: ${total}
- **HTTP Success Rate (200 OK)**: **${((passed / total) * 100).toFixed(1)}%** (${passed}/${total})
- **Routes Found Rate**: **${((results.filter((r) => r.routesCount > 0).length / total) * 100).toFixed(1)}%** (${results.filter((r) => r.routesCount > 0).length}/${total})
- **Avg Response Latency**: **${avgLatency.toFixed(0)} ms**
- **p95 Latency**: **${p95Latency} ms**
- **Min / Max Latency**: **${minLatency} ms / ${maxLatency} ms**
- **Total Simulation Duration**: **${(durationMs / 1000).toFixed(1)} seconds**

---

## 2. Category Performance Analysis
We distributed the test cases into 5 categories to simulate specific real-world behaviors and transit systems across Taiwan:

| Scenario Category | Total Tests | Pass Rate (HTTP 200) | Has Routes Rate | Avg Latency |
| :--- | :---: | :---: | :---: | :---: |
${categoryStats.map((cs) => `| **${cs.category}** | ${cs.total} | ${cs.passRate.toFixed(1)}% | ${cs.hasRoutesRate.toFixed(1)}% | ${cs.avgLatency.toFixed(0)} ms |`).join("\n")}

### Analysis by Scenario:
1. **Northern Metro**: Exercises the Taipei/New Taipei/Taoyuan Metro systems (TRTC, TYMC) and local buses. Extremely high route-finding rate due to dense network and data coverage.
2. **Central Metro**: Focuses on the Taichung Metro (TMRT) and local bus lines. Tests regional route planning.
3. **Southern Metro**: Exercises the Kaohsiung Metro (KRTC) and light rail.
4. **Cross-County**: Tests long-distance public transit using the Taiwan Railway (TRA) and Taiwan High Speed Rail (THSR) networks connecting different cities.
5. **Taiwan-Wide Coverage**: Includes offshore islands (Penghu, Kinmen), high mountain areas (Alishan, Sun Moon Lake, Qingjing), and East Coast counties (Yilan, Hualien, Taitung) to stress test edge cases, remote bus lines, and 404 (no route) graceful degradations.

---

## 3. Transit Mode & Coverage Analysis
How many test cases successfully planned routes using each public transit mode (and walking):

| Transit Mode | Description | Routes Using Mode |
| :--- | :--- | :---: |
| **WALK** | Walking segments (always present) | ${modeCounts.WALK || 0} |
| **BUS** | Local city bus & highway bus | ${modeCounts.BUS || 0} |
| **METRO** | North/Central/South MRT & Light Rail | ${modeCounts.METRO || 0} |
| **TRA** | Taiwan Railway Administration trains | ${modeCounts.TRA || 0} |
| **THSR** | Taiwan High Speed Rail | ${modeCounts.THSR || 0} |

---

## 4. Accessibility Mode Analysis
Tests are distributed across various user profile accessibility modes to evaluate the weight systems and转乘 penalties:

| Mode | Total Runs | Success Rate | Route-Finding Rate |
| :--- | :---: | :---: | :---: |
| **wheelchair** (輪椅) | ${modeStats.wheelchair.total} | ${((modeStats.wheelchair.passed / (modeStats.wheelchair.total || 1)) * 100).toFixed(1)}% | ${((modeStats.wheelchair.hasRoutes / (modeStats.wheelchair.total || 1)) * 100).toFixed(1)}% |
| **elderly** (長者) | ${modeStats.elderly.total} | ${((modeStats.elderly.passed / (modeStats.elderly.total || 1)) * 100).toFixed(1)}% | ${((modeStats.elderly.hasRoutes / (modeStats.elderly.total || 1)) * 100).toFixed(1)}% |
| **visual_impaired** (視障) | ${modeStats.visual_impaired.total} | ${((modeStats.visual_impaired.passed / (modeStats.visual_impaired.total || 1)) * 100).toFixed(1)}% | ${((modeStats.visual_impaired.hasRoutes / (modeStats.visual_impaired.total || 1)) * 100).toFixed(1)}% |
| **normal** (一般人) | ${modeStats.normal.total} | ${((modeStats.normal.passed / (modeStats.normal.total || 1)) * 100).toFixed(1)}% | ${((modeStats.normal.hasRoutes / (modeStats.normal.total || 1)) * 100).toFixed(1)}% |

### Best Route Accessibility Scores Distribution:
- **Excellent** (Score 80-100): ${labelCounts.excellent}
- **Good** (Score 60-79): ${labelCounts.good}
- **Fair** (Score 40-59): ${labelCounts.fair}
- **Poor** (Score 20-39): ${labelCounts.poor}
- **Critical** (Score <20): ${labelCounts.critical}

---

## 5. Errors and Warnings Log

### Top 5 Warnings from Route Planner (for successful requests)
Warnings are generated by the a11y scoring engine (e.g. data density, long walking distance, or no real-time ETA):
${sortedWarnings.slice(0, 5).map(([w, c]) => `- **${w}** (${c} times)`).join("\n") || "None detected."}

### Top 5 Errors / Graceful Failures
These are failed API requests or network timeouts:
${sortedErrors.slice(0, 5).map(([e, c]) => `- **${e}** (${c} times)`).join("\n") || "None detected."}

---

## 6. Detailed Test Cases Log (Truncated Sample)
Here are the first 30 test cases executed for traceability:

| ID | Category | Route Pair | Mode | Status | Routes | Latency | Legs (Best Candidate) |
| :--- | :--- | :--- | :---: | :---: | :---: | :---: | :--- |
${results.slice(0, 30).map((r, i) => 
  `| ${i + 1} | ${r.testCase.category} | ${r.testCase.origin.name} -> ${r.testCase.destination.name} | ${r.testCase.mode} | ${r.success ? `🟢 200` : `🔴 ${r.statusCode}`} | ${r.routesCount} | ${r.latencyMs}ms | ${r.legsDetail || "-"} |`
).join("\n")}
`;

  return md;
}

async function main() {
  const startTime = Date.now();
  const testCases = generateTestCases(NUM_TESTS);
  
  const results = await runPool(testCases);
  const duration = Date.now() - startTime;

  const markdown = generateReport(results, duration);

  const reportDir = path.join(__dirname, "../reports");
  if (!fs.existsSync(reportDir)) {
    fs.mkdirSync(reportDir, { recursive: true });
  }
  const reportPath = path.join(reportDir, "simulation-test-report.md");
  fs.writeFileSync(reportPath, markdown);
  console.log(`\nMarkdown report saved to: ${reportPath}`);

  // Also write to conversation artifact directory if available
  const artifactDir = "/Users/yuen/.gemini/antigravity-cli/brain/2700f80b-9ff2-4b83-b2d1-18b14787b09e";
  if (fs.existsSync(artifactDir)) {
    fs.writeFileSync(path.join(artifactDir, "simulation_test_report.md"), markdown);
    console.log(`Markdown report saved to conversation artifacts: ${path.join(artifactDir, "simulation_test_report.md")}`);
  }

  // Print text summary in console
  const total = results.length;
  const passed = results.filter((r) => r.success && r.statusCode === 200).length;
  const withRoutes = results.filter((r) => r.routesCount > 0).length;
  console.log("=========================================");
  console.log("        SIMULATION TEST COMPLETED        ");
  console.log("=========================================");
  console.log(`Total Requests: ${total}`);
  console.log(`HTTP 200 Success Rate: ${((passed / total) * 100).toFixed(2)}% (${passed}/${total})`);
  console.log(`Routes Found Rate: ${((withRoutes / total) * 100).toFixed(2)}% (${withRoutes}/${total})`);
  console.log(`Average Latency: ${(results.reduce((a, b) => a + b.latencyMs, 0) / total).toFixed(0)}ms`);
  console.log("=========================================");
}

main().catch((err) => {
  console.error("Simulation runner encountered a fatal error:", err);
  process.exit(1);
});
