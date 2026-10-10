import { reconcileAdmission } from "./content-safety.admission.repository";
import {
  reconcileDecision,
  cleanupDecisionReceipt,
} from "./content-safety.decision.repository";
import {
  findRecoverableCases,
  deferCaseRecovery,
} from "./content-safety.repository";
import { z } from "zod";
import { sendEmail } from "../../adapters/email.adapter";
import { claimMail, safetyUser, updateMail } from "./content-safety.repository";
import { reportMailPayload } from "./content-safety.mail";
import type { MailRole } from "../../model/content-report.model";

const RETRY_WINDOW_MS = 23 * 3600000; // Below Resend's 24-hour deduplication window.

export async function drainContentReportMail(
  clock: () => Date = () => new Date(),
): Promise<number> {
  let processed = 0;
  for (const role of ["team", "reporter"] as MailRole[]) {
    for (let i = 0; i < 10; i++) {
      const report = await claimMail(role, clock());
      if (!report) break;
      processed++;
      const job = report.mails[role];
      const token = job.leaseToken;
      if (!token) continue;
      const id = String(report._id);
      try {
        // Recheck before dispatch; a removed/changed account must not receive old mail.
        const user = await safetyUser(report.reporterId);
        if (
          !user ||
          (role === "reporter" &&
            (!user.emailVerified || user.email !== report.reporterEmail))
        ) {
          await updateMail(id, role, token, { state: "cancelled" }, clock());
          continue;
        }
        if (
          job.firstAttemptAt &&
          clock().getTime() - job.firstAttemptAt.getTime() >= RETRY_WINDOW_MS
        ) {
          await updateMail(
            id,
            role,
            token,
            { state: "manual_review" },
            clock(),
          );
          continue;
        }
        const to =
          job.payload?.to ??
          (role === "team"
            ? process.env.CONTENT_REPORT_TEAM_EMAIL?.trim()
            : report.reporterEmail);
        // Missing provider configuration is retryable but does not start the provider dedup clock.
        const from = job.payload?.from ?? process.env.RESEND_FROM?.trim();
        if (
          !from ||
          !process.env.RESEND_API_KEY ||
          typeof to !== "string" ||
          !z.email().safeParse(to).success
        )
          throw new Error("MAIL_CONFIG_UNAVAILABLE");
        const payload =
          job.payload ?? reportMailPayload(report, role, to, from);
        const owned = await updateMail(
          id,
          role,
          token,
          { payload, firstAttemptAt: job.firstAttemptAt ?? clock() },
          clock(),
        );
        // A successful CAS can itself finish after the lease deadline (slow DB).
        if (
          !owned ||
          !job.leaseUntil ||
          job.leaseUntil.getTime() <= clock().getTime()
        )
          continue;
        await sendEmail({
          ...payload,
          idempotencyKey: `content-report/${id}/${role}`,
        });
        const acceptedAt = clock();
        await updateMail(
          id,
          role,
          token,
          {
            state: "accepted",
            acceptedAt,
          },
          acceptedAt,
        );
      } catch {
        // Never log provider response bodies, email addresses or report text.
        const failedAt = clock();
        await updateMail(
          id,
          role,
          token,
          {
            state: "pending",
            nextAttemptAt: new Date(
              failedAt.getTime() +
                Math.min(3600000, 30000 * 2 ** Math.min(job.attempts, 7)),
            ),
          },
          failedAt,
        );
      }
    }
  }
  return processed;
}
export async function drainContentSafetyRecovery(
  clock: () => Date = () => new Date(),
) {
  const cases = await findRecoverableCases(clock());
  for (const report of cases) {
    const id = String(report._id);
    // Persist a bounded retry interval before attempting work; restart does not hot-loop.
    await deferCaseRecovery(id, clock());
    try {
      if (report.admission?.state === "pending")
        await reconcileAdmission(id, clock);
      for (const decision of report.decisions) {
        if (
          decision.state === "pending" &&
          (!decision.nextAttemptAt || decision.nextAttemptAt <= clock())
        )
          await reconcileDecision(id, decision.requestId);
        else if (decision.receiptCleanupPending)
          await cleanupDecisionReceipt(report, decision);
      }
    } catch {
      console.error("[content-safety] case recovery deferred");
    }
  }
  return cases.length;
}

export function startContentReportWorker(): { stop: () => Promise<void> } {
  let active: Promise<unknown> | undefined;
  const tick = () => {
    if (active) return;
    active = Promise.allSettled([
      drainContentSafetyRecovery(),
      drainContentReportMail(),
    ])
      .then((results) => {
        if (results.some((result) => result.status === "rejected"))
          console.error("[content-safety] recovery or mail worker unavailable");
      })
      .finally(() => {
        active = undefined;
      });
  };
  tick();
  const timer = setInterval(tick, 5000);
  timer.unref();
  return {
    async stop() {
      clearInterval(timer);
      await active;
    },
  };
}
