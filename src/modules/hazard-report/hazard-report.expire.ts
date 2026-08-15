import HazardReport from "../../model/hazard-report.model";

const EXPIRY_SCAN_INTERVAL_MS = Number(
  process.env.HAZARD_EXPIRY_SCAN_INTERVAL_MS ?? 5 * 60 * 1000,
);

/**
 * Marks every report whose `expiredAt` has passed and is still `pending` or
 * `verified` as `expired`. Documents and photos are kept (no physical delete),
 * so history survives — `expired` reports just drop out of the default nearby
 * query.
 *
 * @returns The number of reports transitioned to `expired`.
 */
export async function expireStaleReports(): Promise<number> {
  const result = await HazardReport.updateMany(
    {
      expiredAt: { $lte: new Date() },
      status: { $in: ["pending", "verified"] },
    },
    { $set: { status: "expired" } },
  );
  return result.modifiedCount ?? 0;
}

/**
 * Starts the in-process periodic expiry scan (runs once immediately, then every
 * `HAZARD_EXPIRY_SCAN_INTERVAL_MS`). The timer is unref'd so it never keeps the
 * process alive on its own.
 *
 * @returns The interval timer handle.
 */
export function startHazardExpiryJob(): NodeJS.Timeout {
  const run = () =>
    void expireStaleReports().catch((err) =>
      console.error("[hazard-report] expiry scan failed:", err),
    );
  run();
  const timer = setInterval(run, EXPIRY_SCAN_INTERVAL_MS);
  timer.unref?.();
  return timer;
}
