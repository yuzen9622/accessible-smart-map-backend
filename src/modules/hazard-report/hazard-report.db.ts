import { HAZARD_AI } from "../../config/hazard-ai";

/**
 * Every new job/intake query carries a client-side `timeoutMS` (driver CSOT)
 * next to the server-side `maxTimeMS`, so a stalled connection cannot hold a
 * worker slot or the request thread past the bound. Per-operation only: the
 * global connection settings are untouched.
 */
export const DB_OPTIONS: Record<string, number> = {
  timeoutMS: HAZARD_AI.dbTimeoutMs,
};
