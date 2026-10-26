import { randomBytes } from "crypto";
import { DEFAULT_LANG } from "../../types/lang";
import type { AgentLanguage } from "../../types/agent";
import {
  generateNavInstructions,
  generateNavStepsWithLegIndex,
} from "../../utils/nav-instructions-engine";
import type {
  NavigationRouteEnvelope,
  RerouteData,
} from "./accessible-route.types";
import { resolveNavigationEnvelope } from "./route-token.service";
import { storeBusPlan } from "./bus-plan.repository";
import {
  beginReroute,
  finalizeReroute,
  readNavigationTokenStrict,
  releaseReroute,
  resolveCandidateDecision,
  recoverCandidateDecision,
  type CandidateDecision,
  type NavigationSessionSnapshot,
} from "./navigation-state.repository";

export type CandidateSwitchResult =
  | { status: "adopted"; data: RerouteData }
  | { status: "failed" | "reconciling"; reason: string };
export interface CandidateSwitchInput {
  activeToken: string;
  previousVersion: number;
  candidateToken: string;
  proposalId: string;
  language?: AgentLanguage;
  snapshot: NavigationSessionSnapshot;
  isAuthorized: () => boolean;
  /** Independent of utterances after the durable adoption decision. */
  isNavigationCurrent: () => boolean;
  /** Must prepare and schema-validate an independent session, without publishing. */
  prepare: (data: RerouteData, envelope: NavigationRouteEnvelope) => boolean;
  /** Synchronous publication after durable ADOPTED decision. */
  adopt: (data: RerouteData, envelope: NavigationRouteEnvelope) => void;
  onReconciled?: (status: string) => void;
}

const recovering = new Set<string>();
const reconciliationWaiters = new Map<
  string,
  Set<NonNullable<CandidateSwitchInput["onReconciled"]>>
>();
function reconcile(
  navigationId: string,
  done?: CandidateSwitchInput["onReconciled"],
): void {
  if (done) {
    const waiters = reconciliationWaiters.get(navigationId) ?? new Set();
    waiters.add(done);
    reconciliationWaiters.set(navigationId, waiters);
  }
  if (recovering.has(navigationId)) return;
  recovering.add(navigationId);
  const finish = (status: string): void => {
    recovering.delete(navigationId);
    const waiters = reconciliationWaiters.get(navigationId);
    reconciliationWaiters.delete(navigationId);
    for (const waiter of waiters ?? []) waiter(status);
  };
  let attempt = 0;
  const retry = async () => {
    const status = await recoverCandidateDecision(navigationId);
    if (["ADOPTED", "ROLLED_BACK", "missing"].includes(status)) {
      finish(status);
      return;
    }
    if (++attempt >= 6) {
      finish("retry_exhausted");
      return;
    }
    const timer = setTimeout(
      () => void retry(),
      Math.min(250 * 2 ** attempt, 8000),
    );
    timer.unref?.();
  };
  const timer = setTimeout(() => void retry(), 250);
  timer.unref?.();
}

/** Re-enters durable recovery after a prior bounded retry window elapsed. */
export function retryCandidateSwitchReconciliation(
  navigationId: string,
  done?: CandidateSwitchInput["onReconciled"],
): void {
  reconcile(navigationId, done);
}

/** Candidate switching never replans and never trusts a projected/client route. */
export async function switchNavigationCandidate(
  input: CandidateSwitchInput,
): Promise<CandidateSwitchResult> {
  const failed = (reason: string): CandidateSwitchResult => ({
    status: "failed",
    reason,
  });
  const language = input.language ?? DEFAULT_LANG;
  const isCurrent = () => input.isAuthorized() && input.isNavigationCurrent();
  const active = await readNavigationTokenStrict(input.activeToken);
  if (!isCurrent()) return failed("STALE_AUTHORIZATION");
  const candidate = await readNavigationTokenStrict(input.candidateToken);
  if (!isCurrent()) return failed("STALE_AUTHORIZATION");
  const previous =
    active.status === "ok"
      ? await resolveNavigationEnvelope(active.value)
      : null;
  if (!isCurrent()) return failed("STALE_AUTHORIZATION");
  const candidateEnvelope =
    candidate.status === "ok"
      ? await resolveNavigationEnvelope(candidate.value)
      : null;
  if (!isCurrent()) return failed("STALE_AUTHORIZATION");
  if (!previous || !candidateEnvelope)
    return failed("ROUTE_TOKEN_EXPIRED_OR_UNSUPPORTED");
  if (
    previous.routeVersion !== input.previousVersion ||
    previous.navigationId !== input.snapshot.navigationId
  )
    return failed("STALE_NAVIGATION");
  if (
    [previous, candidateEnvelope].some(
      (e) =>
        e.route.navigationId !== e.navigationId ||
        e.route.routeVersion !== e.routeVersion ||
        typeof e.route.routeId !== "string",
    )
  )
    return failed("INVALID_CANONICAL_ENVELOPE");
  const begun = await beginReroute(
    previous.navigationId,
    previous.routeVersion,
    input.proposalId,
  );
  let recoveredAdopt: (() => void) | undefined;
  const unresolved = (): CandidateSwitchResult => {
    reconcile(previous.navigationId, (status) => {
      if (status === "ADOPTED" && input.isNavigationCurrent())
        recoveredAdopt?.();
      input.onReconciled?.(status);
    });
    return { status: "reconciling", reason: "NAVIGATION_STATE_RECONCILING" };
  };
  if (begun.status === "reconciling") return unresolved();
  if (begun.status !== "acquired") return failed("REROUTE_CONFLICT");
  const release = () =>
    releaseReroute(
      previous.navigationId,
      previous.routeVersion,
      input.proposalId,
    );
  let finalized = false;
  try {
    if (!isCurrent()) {
      await release();
      return failed("STALE_AUTHORIZATION");
    }
    const routeVersion = previous.routeVersion + 1;
    const routeToken = randomBytes(32).toString("base64url");
    const route = {
      ...candidateEnvelope.route,
      navigationId: previous.navigationId,
      routeVersion,
      routeToken,
    };
    const instructions = generateNavInstructions(route, undefined, language);
    const steps = generateNavStepsWithLegIndex(route, language);
    if (!instructions.ok || !steps.ok) {
      await release();
      return failed("NAV_INSTRUCTIONS_UNAVAILABLE");
    }
    const warnings = [
      ...new Set([
        ...(route.warnings ?? []),
        ...instructions.data.warnings,
        ...steps.warnings,
      ]),
    ];
    const data: RerouteData = {
      navigationId: previous.navigationId,
      previousRouteVersion: previous.routeVersion,
      routeVersion,
      routeToken,
      route,
      instructions: instructions.data.instructions,
      steps: steps.steps.map(({ instruction }, index) => ({
        index,
        instruction: instruction.text,
        legType: instruction.legType,
        distanceM: instruction.distanceM,
        isTransit: ["BUS", "METRO", "THSR", "TRA"].includes(
          instruction.legType,
        ),
      })),
      warnings,
      currentStepIndex: 0,
      replayed: false,
    };
    const envelope: NavigationRouteEnvelope = {
      schemaVersion: 1,
      navigationId: previous.navigationId,
      routeVersion,
      route,
      canonicalRequest: candidateEnvelope.canonicalRequest,
    };
    if (!input.prepare(data, envelope) || !isCurrent()) {
      await release();
      return failed("REPLACEMENT_NOT_READY");
    }
    recoveredAdopt = () => input.adopt(data, envelope);
    const decision: CandidateDecision = {
      state: "PENDING_DECISION",
      navigationId: previous.navigationId,
      previousVersion: previous.routeVersion,
      nextVersion: routeVersion,
      oldToken: input.activeToken,
      newToken: routeToken,
      proposalId: input.proposalId,
      createdAt: Date.now(),
    };
    const result = await finalizeReroute(
      previous.routeVersion,
      input.proposalId,
      routeToken,
      envelope,
      data,
      decision,
    );
    if (result !== "ok" && result !== "unavailable") {
      await release();
      return failed("REROUTE_CONFLICT");
    }
    finalized = true;
    let status =
      result === "ok"
        ? "PENDING_DECISION"
        : await resolveCandidateDecision(decision, envelope, data, "probe");
    if (status === "missing") {
      await release();
      return failed("COMMIT_NOT_APPLIED");
    }
    if (status !== "PENDING_DECISION" && status !== "ADOPTED")
      return unresolved();
    if (!isCurrent() && status !== "ADOPTED") {
      status = await resolveCandidateDecision(
        decision,
        envelope,
        data,
        "rollback",
      );
      if (status === "ROLLED_BACK" || status === "missing")
        return failed("STALE_AUTHORIZATION");
      return unresolved();
    }
    if (status !== "ADOPTED") {
      status = await resolveCandidateDecision(
        decision,
        envelope,
        data,
        "adopt",
        {
          ...input.snapshot,
          routeToken,
          routeVersion,
          currentStepIndex: 0,
          onVehicle: false,
          updatedAt: Date.now(),
        },
      );
      if (status === "unavailable")
        status = await resolveCandidateDecision(
          decision,
          envelope,
          data,
          "probe",
        );
    }
    if (status !== "ADOPTED") return unresolved();
    if (!input.isNavigationCurrent()) return unresolved();
    input.adopt(data, envelope);
    void Promise.resolve(storeBusPlan(routeToken, route)).catch(() => {});
    return { status: "adopted", data };
  } catch {
    if (finalized) return unresolved();
    await release();
    return failed("REPLACEMENT_NOT_READY");
  }
}
