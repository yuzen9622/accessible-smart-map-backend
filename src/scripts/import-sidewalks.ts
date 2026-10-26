import "dotenv/config";
import {
  acquireSidewalkArchive,
  SIDEWALK_COUNTIES,
} from "../adapters/sidewalk-source.adapter";
import { storeSidewalkSource } from "./sidewalk-source-store";

export const DEFAULT_SIDEWALK_SOURCE_URL =
  "https://opdadm.moi.gov.tw/api/v1/no-auth/resource/api/dataset/11D38E3D-F980-40BF-B714-4E0DB8AA1252/resource/673E16B8-66BC-4DD6-BA39-767BE3324F5C/download";

export type SidewalkImportStage =
  "options" | "download" | "local-zip" | "store";

const STAGE_MESSAGES: Record<SidewalkImportStage, string> = {
  options: "checking import options",
  download: "downloading sidewalk ZIP",
  "local-zip": "reading local sidewalk ZIP",
  store: "validating sidewalk data and storing it in PostGIS",
};

const ERROR_CODE_MESSAGES: Record<string, string> = {
  ENOENT: "Local ZIP file does not exist.",
  EACCES: "File access denied; check ZIP and temporary-directory permissions.",
  ENOSPC: "Insufficient disk space for the source archive.",
  ERR_INVALID_URL: "Source URL is invalid.",
  ENOTFOUND:
    "Host could not be resolved; check the source or database hostname.",
  EAI_AGAIN: "DNS lookup temporarily failed; retry after checking the network.",
  ECONNREFUSED: "Connection refused; check the source or PostGIS endpoint.",
  ECONNRESET: "Connection was interrupted; retry after checking the network.",
  ETIMEDOUT: "Connection timed out; check network and service availability.",
  UND_ERR_CONNECT_TIMEOUT: "Source connection timed out.",
  UND_ERR_HEADERS_TIMEOUT: "Source server timed out before sending headers.",
  UND_ERR_BODY_TIMEOUT: "Source download stalled.",
  UND_ERR_SOCKET: "Source connection closed before the download finished.",
  CERT_HAS_EXPIRED: "Source TLS certificate has expired.",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE:
    "Source TLS certificate could not be verified.",
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY:
    "Source TLS issuer is not trusted by this Node environment.",
  "28P01": "PostGIS authentication failed; check PED_GRAPH_DATABASE_URL.",
  "3D000": "The configured PostGIS database does not exist.",
  "42501": "PostGIS permission denied; check schema and table privileges.",
  "42704": "A required database object is missing; confirm PostGIS is enabled.",
  "42883":
    "A required database function is missing; confirm PostGIS is enabled.",
  "55P03":
    "PostGIS lock timed out; check for another import or graph publication.",
  "57014": "PostGIS operation was canceled or exceeded its time limit.",
  "53300": "PostGIS has too many open connections.",
};

const SAFE_ERROR_MESSAGES = new Set([
  "PED_GRAPH_DATABASE_URL is required",
  "--zip and --url are mutually exclusive",
  "unknown sidewalk import argument",
  "missing value for --zip",
  "missing value for --url",
  "source URL must use HTTP(S)",
  "archive compressed size exceeds limit",
  "unsafe ZIP path",
  "ZIP symlink rejected",
  "encrypted ZIP entry rejected",
  "unsupported ZIP compression",
  "unsafe ZIP size",
  "ZIP entry size exceeds limit",
  "ZIP archive expansion limit exceeded",
  "unknown county/schema in WGS84 filename",
  "duplicate county ZIP entry",
  "mixed or missing source batches",
  "missing WGS84 counties: all 22 required",
  "missing county",
  "ZIP streamed entry size exceeds limit",
  "ZIP entry size/CRC mismatch",
  "invalid county FeatureCollection schema",
  "unsupported county CRS",
  "source county/row accounting failed",
  "staged source row accounting failed",
  "stored source snapshot integrity failed",
  ...SIDEWALK_COUNTIES.map(
    (county) => `county has no accepted polygons: ${county}`,
  ),
]);

export function formatSidewalkImportError(
  stage: SidewalkImportStage,
  error: unknown,
): string {
  let detail =
    "Unexpected import error; check the source ZIP and database configuration.";
  let current = error;
  const seen = new Set<unknown>();
  for (
    let depth = 0;
    depth < 5 && current && typeof current === "object" && !seen.has(current);
    depth++
  ) {
    seen.add(current);
    const failure = current as {
      code?: unknown;
      name?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    if (
      typeof failure.code === "string" &&
      Object.prototype.hasOwnProperty.call(ERROR_CODE_MESSAGES, failure.code)
    ) {
      detail = `${failure.code}: ${ERROR_CODE_MESSAGES[failure.code]}`;
      break;
    }
    if (failure.name === "TimeoutError" || failure.name === "AbortError") {
      detail =
        "Operation timed out or was aborted; the source download has a 180-second limit.";
      break;
    }
    if (typeof failure.message === "string") {
      if (stage === "store" && failure.message === "timeout expired") {
        detail =
          "PostGIS connection timed out after 10 seconds; check database availability.";
        break;
      }
      if (
        stage === "store" &&
        [
          "Connection terminated",
          "Connection terminated unexpectedly",
        ].includes(failure.message)
      ) {
        detail =
          "PostGIS connection was terminated; check database availability and snapshot status.";
        break;
      }
      if (SAFE_ERROR_MESSAGES.has(failure.message)) {
        detail = failure.message;
        break;
      }
      const status = /^source download HTTP ([1-5]\d{2})$/.exec(
        failure.message,
      )?.[1];
      if (status) {
        detail = `Source server returned HTTP ${status}; check upstream availability before retrying.`;
        break;
      }
    }
    if (current instanceof SyntaxError) {
      detail =
        "Source contains invalid JSON; check the downloaded GeoJSON files.";
      break;
    }
    current = failure.cause;
  }
  return `Sidewalk import failed [${stage}]: ${detail} Verify source snapshot status before retrying. No routing graph was changed.`;
}

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
      throw new Error("unknown sidewalk import argument");
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
  onStage?: (stage: SidewalkImportStage) => void,
) {
  onStage?.("options");
  const options = parseSidewalkArgs(args, env);
  onStage?.(options.zip ? "local-zip" : "download");
  const archive = await acquireSidewalkArchive(options);
  try {
    onStage?.("store");
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
  let stage: SidewalkImportStage = "options";
  importSidewalks(process.argv.slice(2), process.env, (nextStage) => {
    stage = nextStage;
    console.error(`[sidewalk-import] ${STAGE_MESSAGES[stage]}`);
  })
    .then((result) => {
      console.log(JSON.stringify(result));
    })
    .catch((error: unknown) => {
      // Driver and JSON-parser errors may include credentials or raw source records.
      console.error(formatSidewalkImportError(stage, error));
      process.exitCode = 1;
    });
}
