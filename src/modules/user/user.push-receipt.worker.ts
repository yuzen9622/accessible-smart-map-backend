import { getExpoPushReceipts } from "../../adapters/expo-push.adapter";
import {
  EXPO_CREDENTIAL_ERROR_CODES,
  EXPO_DEVICE_NOT_REGISTERED,
  PUSH_RECEIPT,
} from "../../constants/push";
import { normalizeReceiptErrorCode } from "../../utils/push-error-code";
import {
  claimDueReceipt,
  expireReceipts,
  finalizeReceipt,
  isReceiptClaimLive,
  releaseReceiptClaim,
  rescheduleReceipt,
  type ClaimedReceipt,
} from "./user.push-receipt.repository";
import { deleteRegistrationGeneration } from "./user.push-token.repository";

/** Controlled operational counters; contain no user, token or ticket data. */
export const pushReceiptCounters: Record<string, number> = {};
const count = (key: string) => {
  pushReceiptCounters[key] = (pushReceiptCounters[key] ?? 0) + 1;
};

type Clock = () => Date;

/** A fixed instant (tests) advances with real elapsed time so fences stay meaningful. */
function toClock(now?: Date | Clock): Clock {
  if (typeof now === "function") return now;
  if (!now) return () => new Date();
  const offset = now.getTime() - Date.now();
  return () => new Date(Date.now() + offset);
}

async function removeRegistration(
  claim: ClaimedReceipt,
  clock: Clock,
): Promise<void> {
  // Never run the destructive step on an expired/superseded claim.
  if (!(await isReceiptClaimLive(claim, clock()))) {
    count("claim_lost");
    return;
  }
  try {
    await deleteRegistrationGeneration(claim);
  } catch {
    count("cleanup_failed");
    console.warn("[push-receipt] registration cleanup failed; will retry");
    await rescheduleReceipt(claim, EXPO_DEVICE_NOT_REGISTERED, {
      state: "cleanup_pending",
      now: clock(),
    });
    return;
  }
  count("device_not_registered_cleaned");
  await finalizeReceipt(claim, "failed", EXPO_DEVICE_NOT_REGISTERED, clock());
}

type Lookup = Awaited<ReturnType<typeof getExpoPushReceipts>>;

async function processClaim(
  claim: ClaimedReceipt,
  lookup: Lookup,
  clock: Clock,
): Promise<void> {
  try {
    if (claim.state === "cleanup_pending") {
      await removeRegistration(claim, clock);
      return;
    }
    const id = claim.ticketId as string;
    const receipt = lookup.receipts.get(id);
    if (!receipt) {
      const reason = lookup.failedIds.has(id)
        ? "lookup_failed"
        : "receipt_missing";
      count(reason);
      await rescheduleReceipt(claim, reason, { now: clock() });
    } else if (receipt.status === "ok") {
      await finalizeReceipt(claim, "provider_accepted", null, clock());
    } else {
      const code = normalizeReceiptErrorCode(receipt.errorCode);
      count(`receipt_error_${code}`);
      if (EXPO_CREDENTIAL_ERROR_CODES.includes(code)) {
        console.warn("[push-receipt] Expo credential error", { code });
      }
      if (code === EXPO_DEVICE_NOT_REGISTERED) {
        await removeRegistration(claim, clock);
      } else {
        await finalizeReceipt(claim, "failed", code, clock());
      }
    }
  } catch {
    // The lease stays and expires; the record is reclaimed. Never resends.
    count("record_failed");
    console.warn("[push-receipt] record processing failed; will retry");
  }
}

/**
 * One bounded receipt pass: expires overdue tracking, claims a small batch of
 * due records and resolves them with modest concurrency. Only ever calls the
 * receipt API; it can never send a notification.
 *
 * @param now Fixed instant (tests) or clock; DB writes always use fresh time
 * @param shouldStop Checked between row groups; unprocessed claims are released
 * @returns How many records were claimed
 */
export async function runPushReceiptPass(
  now?: Date | Clock,
  shouldStop: () => boolean = () => false,
): Promise<number> {
  const clock = toClock(now);
  const previousCounters = { ...pushReceiptCounters };
  await expireReceipts(clock());
  const settled = await Promise.allSettled(
    Array.from({ length: PUSH_RECEIPT.claimBatchSize }, () =>
      claimDueReceipt(clock()),
    ),
  );
  const claims: ClaimedReceipt[] = [];
  for (const r of settled) {
    if (r.status === "fulfilled") {
      if (r.value) claims.push(r.value);
    } else {
      count("claim_failed");
    }
  }
  if (!claims.length) {
    reportPassFailures(previousCounters);
    return 0;
  }

  let lookup: Lookup = { receipts: new Map(), failedIds: new Set() };
  const toLookup = claims.filter((c) => c.state === "pending" && c.ticketId);
  if (toLookup.length && !shouldStop()) {
    lookup = await getExpoPushReceipts(
      toLookup.map((c) => c.ticketId as string),
    );
  }
  for (let i = 0; i < claims.length; i += PUSH_RECEIPT.rowConcurrency) {
    const group = claims.slice(i, i + PUSH_RECEIPT.rowConcurrency);
    if (shouldStop()) {
      await Promise.allSettled(
        claims.slice(i).map((c) => releaseReceiptClaim(c, clock())),
      );
      break;
    }
    await Promise.all(group.map((c) => processClaim(c, lookup, clock)));
  }
  reportPassFailures(previousCounters);
  return claims.length;
}

/** One bounded, identifier-free summary per pass for operational log alerts. */
function reportPassFailures(before: Record<string, number>): void {
  const failures = Object.fromEntries(
    Object.entries(pushReceiptCounters)
      .filter(
        ([key, value]) =>
          key !== "device_not_registered_cleaned" && value > (before[key] ?? 0),
      )
      .map(([key, value]) => [key, value - (before[key] ?? 0)]),
  );
  if (Object.keys(failures).length) {
    console.warn("[push-receipt] pass outcomes", failures);
  }
}

/** Background receipt poller: single-flight, bounded, awaited on stop. */
export function startPushReceiptWorker(): { stop: () => Promise<void> } {
  let stopped = false;
  let running: Promise<void> | undefined;
  const tick = () => {
    if (stopped || running) return;
    running = (async () => {
      for (let i = 0; i < PUSH_RECEIPT.maxPassesPerTick && !stopped; i++) {
        const claimed = await runPushReceiptPass(undefined, () => stopped);
        if (claimed < PUSH_RECEIPT.claimBatchSize) break;
      }
    })()
      .catch(() => {
        console.warn("[push-receipt] worker iteration failed; will retry");
      })
      .finally(() => {
        running = undefined;
      });
  };
  const timer = setInterval(tick, PUSH_RECEIPT.pollMs);
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
