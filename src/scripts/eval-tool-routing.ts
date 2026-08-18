/**
 * Offline tool-routing eval. Runs each labeled case through the REAL routing
 * path (`routeOnce` → same `buildRoutingConfig` + `buildGeminiTools` as
 * production) and scores whether the expected tool fired. Does NOT execute any
 * tool and never touches MongoDB. Calls the real Gemini API, so it runs as a
 * standalone script (never under `npm test`).
 *
 * Run: `npm run eval:routing`   (EVAL_RUNS=N to change runs-per-case, default 3)
 */
import fs from "fs";
import path from "path";
import type { InteractionInputStep } from "../types/agent";
import { model } from "../config/ai";
import {
  CHAT_SYSTEM_PROMPT,
  withUserLocation,
  withCurrentDate,
} from "../config/ai/chat-prompt";
import { taipeiYmdDash } from "../config/taipei-time";
import { routeOnce, runToolLoop } from "../modules/agent/agent-manager.service";
import { agentCases, type AgentCase } from "./agent-cases";
import { extractCalls, gradeArgs } from "./eval-grade";

const N = Number(process.env.EVAL_RUNS ?? 3);
const NONE = "__none__";

type Verdict = "PASS" | "FLAKY" | "FAIL" | "ERROR";

interface Outcome {
  id: string;
  query: string;
  expectTool: string;
  runs: string[][];
  errors: number;
  passes: number;
  verdict: Verdict;
  argFails: string[];
}

function gradeRun(c: AgentCase, called: string[]): boolean {
  if (c.expectTool === NONE) return called.length === 0;
  const accept = new Set([c.expectTool, ...(c.acceptAlso ?? [])]);
  const hit = called.some((t) => accept.has(t));
  const forbidden = (c.mustNotCall ?? []).some((t) => called.includes(t));
  return hit && !forbidden;
}

async function evalCase(c: AgentCase): Promise<Outcome> {
  const sys = withCurrentDate(
    withUserLocation(CHAT_SYSTEM_PROMPT, c.userLocation),
  );
  const ctx = { today: taipeiYmdDash() };
  const userId = c.loggedIn ? "eval-user" : undefined; // only toggles tool catalogue; never hits DB
  const runs: string[][] = [];
  const argFails: string[] = [];
  let errors = 0;
  let passes = 0;

  for (let i = 0; i < N; i++) {
    try {
      const { calledTools, raw } = await routeOnce(c.query, sys, {
        userLocation: c.userLocation,
        userId,
      });
      runs.push(calledTools);
      const namePass = gradeRun(c, calledTools);
      const argResult = gradeArgs(extractCalls(raw), c, ctx);
      if (!argResult.pass && argResult.reason) argFails.push(argResult.reason);
      if (namePass && argResult.pass) passes++;
    } catch (e: any) {
      errors++;
      runs.push([`__error__:${e?.message ?? "unknown"}`]);
    }
  }

  let verdict: Verdict;
  if (errors === N) verdict = "ERROR";
  else if (passes === N) verdict = "PASS";
  else if (passes === 0) verdict = "FAIL";
  else verdict = "FLAKY";

  return {
    id: c.id,
    query: c.query,
    expectTool: c.expectTool,
    runs,
    errors,
    passes,
    verdict,
    argFails,
  };
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

/**
 * V1b — composite-bus full-loop acceptance. Runs the REAL model through the
 * whole `runToolLoop` for「從中科大…哪班最快來」, but injects a canned tool
 * executor (no DB / TDX / Google) so it stays deterministic and quota-free.
 * Kills the reported symptom: the model must not stop at `planAccessibleRoute`
 * — the full call sequence must reach a bus-ETA/timetable tool, must never call
 * `getNavInstructions`, and the final text must be bus-oriented (mentions one
 * of the canned candidate routes).
 */
const COMPOSITE_QUERY = "從中科大要去火車站可以搭哪些公車、哪班最快來";
const NUTC = { latitude: 24.130608, longitude: 120.637112 };
const CANNED_ROUTES = ["159", "48"];
const BUS_ETA_TOOLS = ["getBusArrival", "getBusRouteDetail", "getBusTimetable"];

async function cannedExec(
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  switch (name) {
    case "planAccessibleRoute":
      return JSON.stringify({
        ok: true,
        routes: [
          {
            summary: "搭 159 路直達",
            legs: [{ mode: "BUS", routeName: "159" }],
          },
          { summary: "搭 48 路轉乘", legs: [{ mode: "BUS", routeName: "48" }] },
        ],
      });
    case "findNearbyBusStops":
      return JSON.stringify({
        ok: true,
        stops: [{ name: "中科大站", routes: CANNED_ROUTES }],
      });
    case "getBusArrival":
      return JSON.stringify({
        ok: true,
        routeName: args?.routeName ?? "159",
        etaMinutes: args?.routeName === "48" ? 9 : 4,
      });
    case "getBusRouteDetail":
      return JSON.stringify({
        ok: true,
        routeName: args?.routeName ?? "159",
        stops: [],
        etaMinutes: 4,
      });
    case "getBusTimetable":
      return JSON.stringify({
        ok: true,
        routeName: args?.routeName ?? "159",
        firstBus: "06:00",
        lastBus: "22:30",
      });
    default:
      return JSON.stringify({ ok: true });
  }
}

interface CompositeRun {
  seq: string[];
  text: string;
  hitBusEta: boolean;
  noNav: boolean;
  busOriented: boolean;
  pass: boolean;
}

async function runCompositeOnce(): Promise<CompositeRun> {
  const sys = withUserLocation(CHAT_SYSTEM_PROMPT, NUTC);
  const input: InteractionInputStep[] = [
    { type: "user_input", content: [{ type: "text", text: COMPOSITE_QUERY }] },
  ];
  const seq: string[] = [];
  const result = await runToolLoop(
    input,
    sys,
    model,
    NUTC,
    (n) => seq.push(n),
    undefined,
    undefined,
    false,
    false,
    false,
    cannedExec,
  );
  const text = result.text ?? "";
  const hitBusEta = seq.some((n) => BUS_ETA_TOOLS.includes(n));
  const noNav = !seq.includes("getNavInstructions");
  const busOriented =
    text.length > 0 && CANNED_ROUTES.some((r) => text.includes(r));
  return {
    seq,
    text,
    hitBusEta,
    noNav,
    busOriented,
    pass: hitBusEta && noNav && busOriented,
  };
}

async function evalComposite(): Promise<{
  verdict: Verdict;
  passes: number;
  runs: CompositeRun[];
}> {
  const runs: CompositeRun[] = [];
  let errors = 0;
  for (let i = 0; i < N; i++) {
    try {
      runs.push(await runCompositeOnce());
    } catch (e: any) {
      errors++;
      runs.push({
        seq: [`__error__:${e?.message ?? "unknown"}`],
        text: "",
        hitBusEta: false,
        noNav: false,
        busOriented: false,
        pass: false,
      });
    }
  }
  const passes = runs.filter((r) => r.pass).length;
  let verdict: Verdict;
  if (errors === N) verdict = "ERROR";
  else if (passes === N) verdict = "PASS";
  else if (passes === 0) verdict = "FAIL";
  else verdict = "FLAKY";
  return { verdict, passes, runs };
}

async function main(): Promise<void> {
  if (!process.env.GEMINI_API_KEY) {
    console.error(
      "GEMINI_API_KEY is required. Run via `npm run eval:routing` (loads .env via dotenvx).",
    );
    process.exit(1);
  }

  console.log(
    `Tool-Routing Eval  (model=${model}, N=${N}, ${agentCases.length} cases)`,
  );
  console.log("=".repeat(76));

  const outcomes: Outcome[] = [];
  for (const c of agentCases) {
    const o = await evalCase(c);
    outcomes.push(o);
    const got = o.verdict === "PASS" ? "" : `  got: ${JSON.stringify(o.runs)}`;
    const argNote = o.argFails.length ? `  argFail: ${o.argFails[0]}` : "";
    console.log(
      `${pad(o.verdict, 5)} ${pad(o.id, 16)} ${pad(o.expectTool, 24)} ${o.passes}/${N}${got}${argNote}`,
    );
  }

  const total = outcomes.length;
  const strictPass = outcomes.filter((o) => o.verdict === "PASS").length;
  const lenientPass = outcomes.reduce((s, o) => s + o.passes, 0);
  const fails = outcomes.filter((o) => o.verdict === "FAIL");
  const flaky = outcomes.filter((o) => o.verdict === "FLAKY");
  const errs = outcomes.filter((o) => o.verdict === "ERROR");

  console.log("-".repeat(76));
  console.log(
    `Strict accuracy : ${strictPass}/${total}  (${((strictPass / total) * 100).toFixed(1)}%)`,
  );
  console.log(
    `Lenient accuracy: ${lenientPass}/${total * N}  (${((lenientPass / (total * N)) * 100).toFixed(1)}%)`,
  );
  console.log(
    `FAIL: ${fails.length}   FLAKY: ${flaky.length}   ERROR: ${errs.length}`,
  );
  if (fails.length || errs.length) {
    console.log("Mis-routes / errors:");
    for (const o of [...fails, ...errs]) {
      console.log(
        `  - ${o.id}: expected ${o.expectTool}, got ${JSON.stringify(o.runs)}`,
      );
    }
  }

  console.log("=".repeat(76));
  console.log(`V1b composite-bus full-loop  (query: ${COMPOSITE_QUERY})`);
  const composite = await evalComposite();
  for (const r of composite.runs) {
    const flags = `busEta=${r.hitBusEta} noNav=${r.noNav} busText=${r.busOriented}`;
    console.log(
      `  ${pad(r.pass ? "PASS" : "FAIL", 5)} seq=${JSON.stringify(r.seq)}  ${flags}`,
    );
  }
  console.log(`V1b verdict: ${composite.verdict}  ${composite.passes}/${N}`);
  const compositeFail =
    composite.verdict === "FAIL" ||
    composite.verdict === "ERROR" ||
    composite.verdict === "FLAKY";

  const outDir = path.resolve(__dirname, "eval-reports");
  fs.mkdirSync(outDir, { recursive: true });
  const report = {
    timestamp: new Date().toISOString(),
    model,
    runs: N,
    strict: { pass: strictPass, total, accuracy: strictPass / total },
    lenient: {
      pass: lenientPass,
      total: total * N,
      accuracy: lenientPass / (total * N),
    },
    cases: outcomes,
    compositeBus: {
      verdict: composite.verdict,
      passes: composite.passes,
      runs: composite.runs,
    },
  };
  const stamp = report.timestamp.replace(/[:.]/g, "-");
  fs.writeFileSync(
    path.join(outDir, `routing-${stamp}.json`),
    JSON.stringify(report, null, 2),
  );
  fs.writeFileSync(
    path.join(outDir, "latest.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(
    `\nReport: src/scripts/eval-reports/routing-${stamp}.json (+ latest.json)`,
  );

  process.exit(fails.length + errs.length > 0 || compositeFail ? 1 : 0);
}

main().catch((err) => {
  console.error("Eval failed:", err);
  process.exit(1);
});
