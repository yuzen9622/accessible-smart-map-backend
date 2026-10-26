import "dotenv/config";
import { acquireSidewalkArchive } from "../adapters/sidewalk-source.adapter";
import { storeSidewalkSource } from "./sidewalk-source-store";

export const DEFAULT_SIDEWALK_SOURCE_URL =
  "https://opdadm.moi.gov.tw/api/v1/no-auth/resource/api/dataset/11D38E3D-F980-40BF-B714-4E0DB8AA1252/resource/673E16B8-66BC-4DD6-BA39-767BE3324F5C/download";

export function parseSidewalkArgs(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
) {
  let zip: string | undefined;
  let url: string | undefined;
  const dbUrl = env.PED_GRAPH_DATABASE_URL;
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") continue;
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (!["--zip", "--url"].includes(arg))
      throw new Error(`unknown sidewalk import argument: ${arg}`);
    const value = args[++i];
    if (!value || value.startsWith("--"))
      throw new Error(`missing value for ${arg}`);
    if (arg === "--zip") zip = value;
    if (arg === "--url") url = value;
  }
  if (zip && url) throw new Error("--zip and --url are mutually exclusive");
  if (!dbUrl) throw new Error("PED_GRAPH_DATABASE_URL is required");
  return {
    zip,
    url: zip
      ? undefined
      : url || env.SIDEWALK_SOURCE_URL || DEFAULT_SIDEWALK_SOURCE_URL,
    dbUrl,
    dryRun,
  };
}

export async function importSidewalks(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
) {
  const options = parseSidewalkArgs(args, env);
  const archive = await acquireSidewalkArchive(options);
  try {
    return await storeSidewalkSource({
      ...options,
      file: archive.file,
      sha256: archive.sha256,
      sourceUrl: options.url ?? "local-zip",
    });
  } finally {
    await archive.cleanup().catch(() => {
      console.warn("Could not remove temporary sidewalk source files.");
    });
  }
}

if (require.main === module) {
  importSidewalks(process.argv.slice(2))
    .then((result) => {
      console.log(JSON.stringify(result));
    })
    .catch(() => {
      // Driver and JSON-parser errors may include credentials or raw source records.
      console.error(
        "Sidewalk import failed; verify source snapshot status before retrying. No routing graph was changed.",
      );
      process.exitCode = 1;
    });
}
