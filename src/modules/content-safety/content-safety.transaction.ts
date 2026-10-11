import mongoose, { type ClientSession } from "mongoose";

/** Database work only: the driver can rerun the callback after a conflict.
 * Duplicate-key races must restart an aborted transaction, never continue it.
 * No standalone fallback: callers return 503 instead of partial writes.
 */
export async function safetyTransaction<T>(
  work: (session: ClientSession) => Promise<T>,
): Promise<T> {
  const deadline = Date.now() + 10_000;
  for (let attempt = 0; ; attempt++) {
    const session = await mongoose.startSession();
    try {
      return await session.withTransaction(() => work(session), {
        readConcern: { level: "snapshot" },
        writeConcern: { w: "majority" },
        readPreference: "primary",
        timeoutMS: Math.max(1, deadline - Date.now()),
      });
    } catch (error) {
      if (
        (error as { code?: number }).code !== 11000 ||
        attempt >= 3 ||
        Date.now() >= deadline
      )
        throw error;
    } finally {
      await session.endSession();
    }
  }
}
