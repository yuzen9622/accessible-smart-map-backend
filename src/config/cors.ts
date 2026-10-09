import type { CorsOptions } from "cors";

/** Credentialed clients need explicit origins; wildcard entries never authorize. */
export function getCorsOptions(): CorsOptions {
  const origins = process.env.CORS_ORIGINS?.split(",")
    .map((origin) => origin.trim())
    .filter((origin) => Boolean(origin) && origin !== "*") ?? [
    "http://localhost:3000",
  ];
  return { origin: origins, credentials: true };
}
