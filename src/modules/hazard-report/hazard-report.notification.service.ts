import { randomUUID } from "node:crypto";
import {
  HAZARD_REVIEW_PUSH,
  HAZARD_REVIEW_PUSH_COPY,
} from "../../constants/hazard-review-notification";
import { PUSH_EVENT_TYPE } from "../../constants/push";
import { pickLocale, sendPushToUser } from "../user/user.push.service";
import {
  claimReviewNotification,
  expireReviewNotifications,
  finishReviewNotification,
  recordReviewNotificationDevice,
  renewReviewNotification,
} from "./hazard-report.notification.repository";

/** One durable claim through the existing user push service. Failures never change
 * the review; a failed acknowledgement remains reclaimable after lease expiry. */
export async function deliverNextReviewNotification(): Promise<boolean> {
  const job = await claimReviewNotification(new Date(), randomUUID());
  if (!job) return false;
  try {
    const delivery = await sendPushToUser(
      job.reporterId,
      (locale) => {
        const copy = pickLocale(HAZARD_REVIEW_PUSH_COPY, locale);
        return {
          title: copy.title,
          body: copy.bodies[job.notification.result],
        };
      },
      {
        type: PUSH_EVENT_TYPE.HAZARD_REVIEW,
        reportId: job.reportId,
        notificationId: `${job.reportId}:${job.notification.revision}`,
      },
      {
        delivered: job.notification.delivered,
        expiresAt: job.notification.deadlineAt,
        beforeSend: () => renewReviewNotification(job, new Date()),
        onAccepted: (digest) =>
          recordReviewNotificationDevice(job, digest, new Date()),
      },
    );
    if (!delivery.cancelled) {
      await finishReviewNotification(
        job,
        delivery.retryable
          ? "pending"
          : delivery.sent || job.notification.delivered.length
            ? "sent"
            : "skipped",
        new Date(),
      );
    }
  } catch {
    // Do not log tokens, owner IDs, report content, or provider error text.
    console.warn("[hazard-review-push] delivery failed; retry scheduled");
    await finishReviewNotification(job, "pending", new Date());
  }
  return true;
}

/** Startup scan recovers pending and expired leases; no in-memory event is needed. */
export function startHazardReviewNotificationWorker(): {
  stop: () => Promise<void>;
} {
  let stopped = false;
  let running: Promise<void> | undefined;
  const tick = () => {
    if (stopped || running) return;
    running = (async () => {
      await expireReviewNotifications(new Date());
      for (let i = 0; i < HAZARD_REVIEW_PUSH.batchSize && !stopped; i++) {
        if (!(await deliverNextReviewNotification())) break;
      }
    })()
      .catch(() => {
        console.warn(
          "[hazard-review-push] worker iteration failed; will retry",
        );
      })
      .finally(() => {
        running = undefined;
      });
  };
  const timer = setInterval(tick, HAZARD_REVIEW_PUSH.pollMs);
  timer.unref();
  tick();
  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await running;
    },
  };
}
