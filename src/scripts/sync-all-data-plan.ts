/**
 * Pure planning layer for `pnpm data:sync` (see sync-all-data.ts): the step
 * registry, CLI parsing, step selection and precondition checks. No I/O —
 * environment and file existence are injected so this module is unit-tested
 * without touching MongoDB, PostGIS, Chroma or Docker.
 *
 * Steps run sequentially in registry order, which is also dependency order.
 * Groups other than `base` are opt-in because they wipe collections, restart
 * Valhalla, burn quota for a long time, or cost money.
 */

export type StepGroup = "base" | "snapshot" | "valhalla" | "slow" | "paid";

/** Backing services a step talks to; drives connectivity preflight. */
export type StepBackend = "mongo" | "postgis" | "chroma" | "docker";

export interface SyncStep {
  id: string;
  group: StepGroup;
  /** Executable + args, run from the project root. */
  command: readonly string[];
  backends: readonly StepBackend[];
  /** Ids that must be selected and must have exited 0 before this step runs. */
  dependsOn?: readonly string[];
  requiredEnv?: readonly string[];
  /** Paths relative to the project root that must exist. */
  requiredFiles?: readonly string[];
  /** Calls TDX — consecutive TDX steps are spaced by `--tdx-gap`. */
  tdx?: boolean;
  /**
   * Known ways the step exits 0 while only partly succeeding; the exit code
   * cannot reveal these, so the summary repeats them.
   */
  partialFailureNote?: string;
}

const TDX_ENV = ["TDX_CLIENT_ID", "TDX_CLIENT_SECRET"] as const;
const MONGO_ENV = ["DATABASE_URL"] as const;

function pnpmScript(name: string, ...args: string[]): readonly string[] {
  return ["pnpm", "run", "--silent", name, ...args];
}

/**
 * `import:gtfs-all` swallows child failures and still exits 0, so the four
 * GTFS imports run as separate steps (same node flags as that script).
 */
function gtfsScript(name: string): readonly string[] {
  return [
    "node",
    "--max-old-space-size=2048",
    "-r",
    "ts-node/register",
    `src/scripts/${name}`,
  ];
}

export const SYNC_STEPS: readonly SyncStep[] = [
  // --- base: upsert-only, safe to re-run against a live database ---
  {
    id: "tdx-stops",
    group: "base",
    command: pnpmScript("import:tdx-stops"),
    backends: ["mongo"],
    requiredEnv: [...MONGO_ENV, ...TDX_ENV],
    tdx: true,
  },
  {
    id: "tdx-bus-routes",
    group: "base",
    command: pnpmScript("import:tdx-bus-routes"),
    backends: ["mongo"],
    requiredEnv: [...MONGO_ENV, ...TDX_ENV],
    tdx: true,
  },
  {
    id: "tdx-bus-vehicles",
    group: "base",
    command: pnpmScript("import:tdx-bus-vehicles"),
    backends: ["mongo"],
    requiredEnv: [...MONGO_ENV, ...TDX_ENV],
    tdx: true,
  },
  {
    id: "city-bus-vehicles",
    group: "base",
    command: pnpmScript("import:city-bus-vehicles"),
    backends: ["mongo"],
    requiredEnv: [...MONGO_ENV],
    partialFailureNote:
      "fails only when every city source fails; Keelung/Hsinchu fill in over repeated runs",
  },
  {
    id: "tdx-metro",
    group: "base",
    command: pnpmScript("import:tdx-metro"),
    backends: ["mongo"],
    requiredEnv: [...MONGO_ENV, ...TDX_ENV],
    tdx: true,
  },
  {
    id: "tdx-tra",
    group: "base",
    command: pnpmScript("import:tdx-tra"),
    backends: ["mongo"],
    requiredEnv: [...MONGO_ENV, ...TDX_ENV],
    tdx: true,
  },
  {
    id: "tdx-thsr",
    group: "base",
    command: pnpmScript("import:tdx-thsr"),
    backends: ["mongo"],
    requiredEnv: [...MONGO_ENV, ...TDX_ENV],
    tdx: true,
  },
  {
    // No flags: TRAFFIC_TARGET_CITIES, the same scope build:traffic-map maps.
    id: "traffic-sections",
    group: "base",
    command: pnpmScript("import:traffic-sections"),
    backends: ["mongo"],
    requiredEnv: [...MONGO_ENV, ...TDX_ENV],
    tdx: true,
  },
  {
    id: "osm",
    group: "base",
    command: pnpmScript("import:osm"),
    backends: ["mongo"],
    requiredEnv: [...MONGO_ENV],
    partialFailureNote:
      "a failed Overpass query is logged and skipped; the run still exits 0",
  },
  {
    id: "visual-a11y",
    group: "base",
    command: pnpmScript("import:visual-a11y"),
    backends: ["mongo"],
    requiredEnv: [...MONGO_ENV],
  },
  {
    id: "taipei-aps",
    group: "base",
    command: pnpmScript("import:taipei-aps"),
    backends: ["mongo"],
    requiredEnv: [...MONGO_ENV],
  },
  {
    id: "taipei-park-entrances",
    group: "base",
    command: pnpmScript("import:taipei-park-entrances"),
    backends: ["mongo"],
    requiredEnv: [...MONGO_ENV],
  },
  {
    id: "gtfs-levels",
    group: "base",
    command: gtfsScript("import-gtfs-levels.ts"),
    backends: ["mongo"],
    requiredEnv: [...MONGO_ENV],
    requiredFiles: ["data/gtfs/levels.txt"],
  },
  {
    id: "gtfs-stops",
    group: "base",
    command: gtfsScript("import-gtfs-stops.ts"),
    backends: ["mongo"],
    dependsOn: ["gtfs-levels"],
    requiredEnv: [...MONGO_ENV],
    requiredFiles: ["data/gtfs/stops.txt"],
  },
  {
    id: "gtfs-trips",
    group: "base",
    command: gtfsScript("import-gtfs-trips.ts"),
    backends: ["mongo"],
    requiredEnv: [...MONGO_ENV],
    requiredFiles: ["data/gtfs/trips.txt"],
  },
  {
    id: "gtfs-pathways",
    group: "base",
    command: gtfsScript("import-gtfs-pathways.ts"),
    backends: ["mongo"],
    dependsOn: ["gtfs-stops"],
    requiredEnv: [...MONGO_ENV],
    requiredFiles: ["data/gtfs/pathways.txt"],
  },
  {
    id: "taipei-ramps",
    group: "base",
    command: pnpmScript("import:taipei-ramps"),
    backends: ["postgis"],
    requiredEnv: ["PED_GRAPH_DATABASE_URL"],
  },

  // --- snapshot: deleteMany({}) then insert — readers see an empty collection mid-run ---
  {
    id: "a11y-metro",
    group: "snapshot",
    command: pnpmScript("import:a11y-metro"),
    backends: ["mongo"],
    requiredEnv: [...MONGO_ENV],
    requiredFiles: [
      "data/metro-a11y/捷運車站出入口無障礙電梯、無障礙坡道GPS座標.csv",
    ],
  },
  {
    id: "bathrooms",
    group: "snapshot",
    command: pnpmScript("import:bathrooms"),
    backends: ["mongo"],
    requiredEnv: [...MONGO_ENV],
    requiredFiles: ["data/bathrooms/無障礙廁所.csv"],
  },

  // --- valhalla: new tile release + restart, then re-derive the traffic edge map ---
  {
    id: "valhalla-pbf",
    group: "valhalla",
    // Placeholder command: the runner downloads the PBF itself (only if missing).
    command: ["download-pbf"],
    backends: [],
  },
  {
    id: "valhalla-tiles",
    group: "valhalla",
    command: pnpmScript("build:valhalla-tiles"),
    backends: ["docker"],
    dependsOn: ["valhalla-pbf"],
  },
  {
    // Edge ids change with every tile build, so the TDX→Valhalla map is stale.
    id: "traffic-map",
    group: "valhalla",
    command: pnpmScript("build:traffic-map"),
    backends: ["mongo"],
    dependsOn: ["traffic-sections", "valhalla-tiles"],
    requiredEnv: [...MONGO_ENV],
    partialFailureNote:
      "sections Valhalla fails to match are logged and dropped; the edge map can end up empty",
  },
  {
    id: "traffic-tar",
    group: "valhalla",
    command: pnpmScript("build:traffic-tar"),
    backends: [],
    dependsOn: ["traffic-map"],
    requiredEnv: [...TDX_ENV],
    tdx: true,
    partialFailureNote:
      "prints `generated: false, skipped: true` (no edge map / no speed data) and still exits 0 — check its Result line",
  },

  // --- slow: heavy TDX quota or a long crawl ---
  {
    id: "parking-tdx",
    group: "slow",
    command: pnpmScript("import:parking-tdx"),
    backends: ["mongo"],
    requiredEnv: [...MONGO_ENV, ...TDX_ENV],
    tdx: true,
  },
  {
    id: "campus-a11y",
    group: "slow",
    command: pnpmScript("import:campus-a11y"),
    backends: ["mongo"],
    requiredEnv: [...MONGO_ENV],
    partialFailureNote:
      "schools that fail to crawl are skipped, then the collection is still wiped and rewritten",
  },
  {
    id: "campus-facility-detail",
    group: "slow",
    command: pnpmScript("import:campus-facility-detail"),
    backends: ["mongo"],
    dependsOn: ["campus-a11y"],
    requiredEnv: [...MONGO_ENV],
  },

  // --- paid: Google geocoding / Gemini embeddings ---
  {
    id: "welfare",
    group: "paid",
    command: pnpmScript("import:welfare"),
    backends: ["mongo"],
    requiredEnv: [...MONGO_ENV, "GOOGLE_MAPS_API_KEY"],
    requiredFiles: ["data/welfare/全國身心障礙福利機構一覽表.csv"],
    partialFailureNote:
      "wipes the collection first; rows that fail to geocode are dropped",
  },
  {
    id: "rag",
    group: "paid",
    command: pnpmScript("import:rag"),
    backends: ["chroma"],
    requiredEnv: ["GEMINI_API_KEY"],
    requiredFiles: ["data/rag"],
    partialFailureNote:
      "upserts by chunk id but never prunes chunks whose source file was removed or renamed",
  },
];

export const STEP_GROUPS: readonly StepGroup[] = [
  "base",
  "snapshot",
  "valhalla",
  "slow",
  "paid",
];

export interface SyncOptions {
  groups: ReadonlySet<StepGroup>;
  only: readonly string[];
  skip: readonly string[];
  planOnly: boolean;
  failFast: boolean;
  tdxGapSeconds: number;
}

const GROUP_FLAGS: Record<string, StepGroup> = {
  "--with-snapshot": "snapshot",
  "--with-valhalla": "valhalla",
  "--with-slow": "slow",
  "--with-paid": "paid",
};

export const DEFAULT_TDX_GAP_SECONDS = 10;

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * @param argv Arguments after the script path.
 * @returns Parsed options.
 * @throws On an unknown flag or a malformed value.
 */
export function parseSyncArgs(argv: readonly string[]): SyncOptions {
  const groups = new Set<StepGroup>(["base"]);
  const only: string[] = [];
  const skip: string[] = [];
  let planOnly = false;
  let failFast = false;
  let tdxGapSeconds = DEFAULT_TDX_GAP_SECONDS;

  for (const arg of argv) {
    if (arg === "--") continue;
    if (arg in GROUP_FLAGS) groups.add(GROUP_FLAGS[arg]);
    else if (arg === "--all") STEP_GROUPS.forEach((g) => groups.add(g));
    else if (arg === "--plan") planOnly = true;
    else if (arg === "--fail-fast") failFast = true;
    else if (arg.startsWith("--only=")) only.push(...splitList(arg.slice(7)));
    else if (arg.startsWith("--skip=")) skip.push(...splitList(arg.slice(7)));
    else if (arg.startsWith("--tdx-gap=")) {
      const value = Number(arg.slice("--tdx-gap=".length));
      if (!Number.isFinite(value) || value < 0) {
        throw new Error(`--tdx-gap needs a non-negative number, got "${arg}"`);
      }
      tdxGapSeconds = value;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { groups, only, skip, planOnly, failFast, tdxGapSeconds };
}

/**
 * `--only` picks steps by id regardless of group; otherwise the enabled
 * groups decide. `--skip` then removes ids. Every dependency of a selected
 * step must itself be selected — a silently missing prerequisite would let a
 * step run against stale inputs.
 *
 * @returns Selected steps in registry (= execution) order.
 * @throws On an unknown id or an unselected dependency.
 */
export function selectSteps(
  steps: readonly SyncStep[],
  options: Pick<SyncOptions, "groups" | "only" | "skip">,
): SyncStep[] {
  const known = new Set(steps.map((s) => s.id));
  for (const id of [...options.only, ...options.skip]) {
    if (!known.has(id)) throw new Error(`unknown step id: ${id}`);
  }
  const skip = new Set(options.skip);
  const only = new Set(options.only);
  const selected = steps.filter(
    (s) =>
      !skip.has(s.id) &&
      (only.size > 0 ? only.has(s.id) : options.groups.has(s.group)),
  );
  const selectedIds = new Set(selected.map((s) => s.id));
  for (const step of selected) {
    for (const dep of step.dependsOn ?? []) {
      if (!selectedIds.has(dep)) {
        throw new Error(
          `step "${step.id}" depends on "${dep}", which is not selected — add it or also skip "${step.id}"`,
        );
      }
    }
  }
  return selected;
}

/**
 * @param step The step to check.
 * @param env Environment variables.
 * @param fileExists Existence check for project-root-relative paths.
 * @returns Human-readable unmet preconditions (empty = runnable).
 */
export function findStepBlockers(
  step: SyncStep,
  env: Readonly<Record<string, string | undefined>>,
  fileExists: (relativePath: string) => boolean,
): string[] {
  const blockers: string[] = [];
  for (const name of step.requiredEnv ?? []) {
    if (!env[name]) blockers.push(`env ${name} is not set`);
  }
  for (const file of step.requiredFiles ?? []) {
    if (!fileExists(file)) blockers.push(`missing ${file}`);
  }
  return blockers;
}

export type StepStatus = "EXITED_0" | "FAILED" | "SKIPPED_DEP";

/**
 * @returns Why the step must be skipped because a dependency did not exit 0,
 *          or null when every dependency succeeded.
 */
export function dependencySkipReason(
  step: SyncStep,
  results: ReadonlyMap<string, StepStatus>,
): string | null {
  for (const dep of step.dependsOn ?? []) {
    const status = results.get(dep);
    if (status !== "EXITED_0") {
      return `dependency ${dep} ${status ?? "did not run"}`;
    }
  }
  return null;
}

/** @returns 0 only when every step that was due to run exited 0. */
export function syncExitCode(results: ReadonlyMap<string, StepStatus>): 0 | 1 {
  for (const status of results.values()) {
    if (status !== "EXITED_0") return 1;
  }
  return 0;
}
