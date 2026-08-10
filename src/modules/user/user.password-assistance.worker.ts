import { processPasswordAssistance } from "./user.auth.service";
import {
  claimPasswordAssistanceJob,
  completePasswordAssistanceJob,
  failPasswordAssistanceJob,
  renewPasswordAssistanceLease,
} from "./user.password-assistance.queue";

const POLL_INTERVAL_MS = 1_000;
const LEASE_HEARTBEAT_MS = 60_000;
const MAX_JOBS_PER_TICK = 25;
let running = false;

function startLeaseHeartbeat(jobId: unknown, leaseToken: string): NodeJS.Timeout {
  let refreshing = false;
  const timer = setInterval(() => {
    if (refreshing) return;
    refreshing = true;
    void renewPasswordAssistanceLease({ jobId, leaseToken })
      .then((renewed) => {
        if (!renewed) {
          console.warn("[auth] 帳號協助工作 heartbeat lease 已失效", String(jobId));
        }
      })
      .catch((error) => console.error("[auth] 帳號協助 lease heartbeat 失敗", error))
      .finally(() => {
        refreshing = false;
      });
  }, LEASE_HEARTBEAT_MS);
  timer.unref();
  return timer;
}

/** Process a bounded batch so queue traffic cannot monopolize the event loop. */
export async function drainPasswordAssistanceQueue(): Promise<number> {
  let processed = 0;

  while (processed < MAX_JOBS_PER_TICK) {
    const job = await claimPasswordAssistanceJob();
    if (!job) break;

    const leaseToken = job.leaseToken;
    if (!leaseToken) {
      console.error("[auth] 帳號協助工作缺少 lease token", String(job._id));
      processed += 1;
      continue;
    }

    try {
      // Fence stale workers immediately before dispatch. The processor uses a
      // stable per-job reset token and Resend idempotency key, so retries cannot
      // rotate the link or send the same job twice.
      const renewed = await renewPasswordAssistanceLease({ jobId: job._id, leaseToken });
      if (!renewed) {
        console.warn("[auth] 帳號協助工作 dispatch 前 lease 已失效", String(job._id));
        processed += 1;
        continue;
      }

      const heartbeat = startLeaseHeartbeat(job._id, leaseToken);
      try {
        await processPasswordAssistance({
          email: job.email,
          jobId: String(job._id),
          leaseToken,
        });
        const completed = await completePasswordAssistanceJob({ jobId: job._id, leaseToken });
        if (!completed) {
          console.warn("[auth] 帳號協助工作完成時 lease 已失效", String(job._id));
        }
      } finally {
        clearInterval(heartbeat);
      }
    } catch (error) {
      console.error("[auth] 帳號協助工作執行失敗", error);
      const released = await failPasswordAssistanceJob({
        jobId: job._id,
        leaseToken,
        attempts: job.attempts,
        error,
      });
      if (!released) {
        console.warn("[auth] 帳號協助工作失敗時 lease 已失效", String(job._id));
      }
    }
    processed += 1;
  }

  return processed;
}

async function runWorkerTick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await drainPasswordAssistanceQueue();
  } catch (error) {
    console.error("[auth] 帳號協助 queue 暫時不可用", error);
  } finally {
    running = false;
  }
}

/** Start the in-process durable queue consumer after MongoDB connects. */
export function startPasswordAssistanceWorker(): NodeJS.Timeout {
  void runWorkerTick();
  const timer = setInterval(() => void runWorkerTick(), POLL_INTERVAL_MS);
  timer.unref();
  return timer;
}
