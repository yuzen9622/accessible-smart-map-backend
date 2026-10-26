import "dotenv/config";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { getCurrentOtpWalkingIdentity } from "../modules/accessible-route/otp-walking-policy.service";
import type { QualifiedOtpWalkOptions } from "../modules/accessible-route/planners/otp-walk-planner";

const manifestSchema = z.object({
  schemaVersion: z.literal(2),
  phase: z.literal("BUILT"),
  graph: z.object({
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    byteCount: z.number().int().positive(),
  }),
  source: z.object({
    version: z.string().min(1),
    batch: z.string().min(1),
    archiveSha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
});

interface NativeVerifier {
  getIdentity: typeof getCurrentOtpWalkingIdentity;
  planWalk: (options: QualifiedOtpWalkOptions) => Promise<{ status: string }>;
}

export function parseNativeVerificationArgs(args: readonly string[]) {
  let otp: string | undefined;
  let release: string | undefined;
  let identityOnly = false;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === "--identity-only" && !identityOnly) {
      identityOnly = true;
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--"))
      throw new Error(
        "Expected --otp URL --release DIRECTORY [--identity-only]",
      );
    if (flag === "--otp" && otp === undefined) otp = value;
    else if (flag === "--release" && release === undefined) release = value;
    else throw new Error("Unknown or duplicate native verification argument");
    index++;
  }
  if (!otp || !release)
    throw new Error("Expected --otp URL --release DIRECTORY [--identity-only]");
  const url = new URL(otp);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("OTP URL must be an HTTP origin without credentials");
  return { otp: url.origin, release: path.resolve(release), identityOnly };
}

export async function verifyNativeRelease(
  options: { release: string; identityOnly: boolean },
  verifier: NativeVerifier,
) {
  const bytes = readFileSync(
    path.join(options.release, "evidence/build-manifest.json"),
  );
  const manifest = manifestSchema.parse(JSON.parse(bytes.toString("utf8")));
  const manifestSha = createHash("sha256").update(bytes).digest("hex");
  const checkIdentity = async () => {
    const result = await verifier.getIdentity(Date.now() + 15_000);
    if (result.status !== "ready")
      throw new Error("OTP source or policy identity is unavailable");
    const observed = result.identity.buildManifestIdentity;
    if (
      observed.manifestSha256 !== manifestSha ||
      result.identity.graphByteIdentity.sha256 !== manifest.graph.sha256 ||
      result.identity.graphByteIdentity.byteCount !==
        manifest.graph.byteCount ||
      observed.sourceVersion !== manifest.source.version ||
      observed.sourceBatch !== manifest.source.batch ||
      observed.sourceArchiveSha256 !== manifest.source.archiveSha256
    )
      throw new Error("Loaded OTP graph does not match the candidate release");
  };
  await checkIdentity();
  let routesChecked = 0;
  if (!options.identityOnly) {
    const a = { lat: 25.06217441700756, lng: 121.533374610859 };
    const b = { lat: 25.06193048958242, lng: 121.53337238742401 };
    for (const mode of ["normal", "wheelchair"] as const) {
      for (const points of [
        [a, b],
        [a, b, a],
      ]) {
        const result = await verifier.planWalk({
          mode,
          points,
          avoidStairs: true,
          allowStairsFallback: false,
          departureTimeMs: Date.now(),
          deadlineMs: Date.now() + 45_000,
        });
        if (result.status !== "ready")
          throw new Error(`OTP ${mode}/${points.length}-point route failed`);
        routesChecked++;
      }
    }
    await checkIdentity();
  }
  return { graphSha256: manifest.graph.sha256, routesChecked };
}

async function main() {
  const options = parseNativeVerificationArgs(process.argv.slice(2));
  process.env.OTP_BASE_URL = options.otp;
  const { getCurrentOtpWalkingIdentity: getIdentity } =
    await import("../modules/accessible-route/otp-walking-policy.service");
  const { planQualifiedOtpWalk: planWalk } =
    await import("../modules/accessible-route/planners/otp-walk-planner");
  const { closePedGraphRuntime } =
    await import("../modules/accessible-route/planners/pedestrian-a11y/graph-runtime");
  try {
    const result = await verifyNativeRelease(options, {
      getIdentity,
      planWalk,
    });
    console.log(JSON.stringify({ status: "PASS", ...result }));
  } finally {
    await closePedGraphRuntime();
  }
}

if (require.main === module) {
  main().catch(() => {
    console.error(
      "Native OTP verification failed; check the candidate graph, source and routing results.",
    );
    process.exitCode = 1;
  });
}
