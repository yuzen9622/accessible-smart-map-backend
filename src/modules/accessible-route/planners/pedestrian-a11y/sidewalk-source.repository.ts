import { z } from "zod";
import { getPedGraphClient } from "./graph-runtime";

const ACTIVE_SOURCE_QUERY = `
  SELECT id::text AS "sourceVersionId",
         source_batch AS "sourceBatch",
         archive_sha256 AS "archiveSha256"
  FROM ped_sidewalk_source_version
  WHERE lifecycle_status = 'ACTIVE'
  LIMIT 2
`;

const sourceIdentitySchema = z.object({
  sourceVersionId: z.string().regex(/^[1-9]\d*$/),
  sourceBatch: z
    .string()
    .min(1)
    .refine((value) => value.trim() === value),
  archiveSha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const queryResultSchema = z.object({ rows: z.array(z.unknown()) });
const budgetSchema = z.object({
  deadlineMs: z.number().finite(),
  timeoutMs: z.number().int().positive().max(2_147_483_647),
});

export type SidewalkSourceIdentity = z.infer<typeof sourceIdentitySchema>;
export type SidewalkSourceReadBudget = z.infer<typeof budgetSchema>;
export type CurrentSidewalkSourceResult =
  | { status: "ready"; identity: SidewalkSourceIdentity }
  | {
      status: "unavailable";
      reason:
        | "no_active_source"
        | "ambiguous_active_source"
        | "malformed_source"
        | "query_failed"
        | "invalid_budget"
        | "deadline_exceeded"
        | "timeout";
    };

/** Read the unique ACTIVE source without loading a graph or caching its identity. */
export async function readCurrentSidewalkSourceIdentity(
  budget: SidewalkSourceReadBudget,
): Promise<CurrentSidewalkSourceResult> {
  const parsedBudget = budgetSchema.safeParse(budget);
  if (!parsedBudget.success)
    return { status: "unavailable", reason: "invalid_budget" };
  const now = Date.now();
  if (parsedBudget.data.deadlineMs <= now)
    return { status: "unavailable", reason: "deadline_exceeded" };
  const timeoutAt = now + parsedBudget.data.timeoutMs;
  const expiresAt = Math.min(parsedBudget.data.deadlineMs, timeoutAt);
  const expired: CurrentSidewalkSourceResult = {
    status: "unavailable",
    reason:
      parsedBudget.data.deadlineMs <= timeoutAt
        ? "deadline_exceeded"
        : "timeout",
  };
  let timer: NodeJS.Timeout | undefined;
  try {
    const work = async (): Promise<CurrentSidewalkSourceResult> => {
      const client = await getPedGraphClient();
      if (Date.now() >= expiresAt) return expired;
      const raw: unknown = await client.query<unknown>(ACTIVE_SOURCE_QUERY);
      if (Date.now() >= expiresAt) return expired;
      const result = queryResultSchema.safeParse(raw);
      if (!result.success)
        return { status: "unavailable", reason: "malformed_source" };
      const rows = result.data.rows;
      if (!rows.length)
        return { status: "unavailable", reason: "no_active_source" };
      if (rows.length !== 1)
        return { status: "unavailable", reason: "ambiguous_active_source" };
      const identity = sourceIdentitySchema.safeParse(rows[0]);
      return identity.success
        ? { status: "ready", identity: identity.data }
        : { status: "unavailable", reason: "malformed_source" };
    };
    // The shared query interface cannot cancel an in-flight DB read. Bound the
    // caller's wait and prevent a late client acquisition from starting a query.
    return await Promise.race([
      work(),
      new Promise<CurrentSidewalkSourceResult>((resolve) => {
        timer = setTimeout(() => resolve(expired), expiresAt - Date.now());
        timer.unref?.();
      }),
    ]);
  } catch {
    return Date.now() >= expiresAt
      ? expired
      : { status: "unavailable", reason: "query_failed" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
