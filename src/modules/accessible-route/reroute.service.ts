import { randomBytes } from "crypto";
import { storeBusPlan } from "./bus-plan.repository";
import { ResponseCode } from "../../types/code";
import { DEFAULT_LANG } from "../../types/lang";
import {
  REROUTE_MSG,
  REROUTE_MSG_EN,
  ROUTE_MSG,
} from "../../constants/messages";
import {
  generateNavInstructions,
  generateNavStepsWithLegIndex,
} from "../../utils/nav-instructions-engine";
import type {
  NavigationRouteEnvelope,
  RerouteData,
  RerouteRequest,
} from "./accessible-route.types";
import {
  beginReroute,
  finalizeReroute,
  readNavigationTokenStrict,
  releaseReroute,
} from "./navigation-state.repository";
import { planAccessibleRouteFromRequest } from "./accessible-route.service";
import { isNavigationEnvelope } from "./route-token.service";
import { venueArrivalPlanner } from "./venue-arrival.port";

export type RerouteResult =
  | { ok: true; data: RerouteData }
  | { ok: false; status: ResponseCode; error: string; data?: unknown };

const conflict = (message: string): RerouteResult => ({
  ok: false,
  status: ResponseCode.CONFLICT,
  error: message,
  data: { reason: "REROUTE_CONFLICT" },
});

/** Shared HTTP/voice reroute orchestration with fail-closed Redis concurrency. */
export async function rerouteAccessibleRoute(
  request: RerouteRequest,
): Promise<RerouteResult> {
  const language = request.language ?? DEFAULT_LANG;
  const messages = language === "en" ? REROUTE_MSG_EN : REROUTE_MSG;
  const tokenRead = await readNavigationTokenStrict(request.routeToken);
  if (tokenRead.status === "unavailable") {
    return {
      ok: false,
      status: ResponseCode.SERVICE_UNAVAILABLE,
      error: messages.UNAVAILABLE,
      data: { reason: "NAVIGATION_STATE_UNAVAILABLE" },
    };
  }
  if (
    tokenRead.status === "missing" ||
    !isNavigationEnvelope(tokenRead.value)
  ) {
    return {
      ok: false,
      status: ResponseCode.GONE,
      error: messages.GONE,
      data: { reason: "ROUTE_TOKEN_EXPIRED_OR_UNSUPPORTED" },
    };
  }
  const previous = tokenRead.value;
  // A venue trip keeps its gate for good: if the venue was re-imported and
  // that gate is gone or moved, the token no longer supports rerouting.
  const storedVenueArrival = previous.canonicalRequest.venueArrival;
  if (
    storedVenueArrival &&
    !(await venueArrivalPlanner().isVenueArrivalCurrent(storedVenueArrival))
  ) {
    return {
      ok: false,
      status: ResponseCode.GONE,
      error: messages.VENUE_UPDATED,
      data: { reason: "ROUTE_TOKEN_EXPIRED_OR_UNSUPPORTED" },
    };
  }
  if (previous.routeVersion !== request.previousRouteVersion) {
    return conflict(messages.CONFLICT);
  }
  const begun = await beginReroute(
    previous.navigationId,
    request.previousRouteVersion,
    request.clientRequestId,
  );
  if (begun.status === "unavailable") {
    return {
      ok: false,
      status: ResponseCode.SERVICE_UNAVAILABLE,
      error: messages.UNAVAILABLE,
      data: { reason: "NAVIGATION_STATE_UNAVAILABLE" },
    };
  }
  if (begun.status === "replay") return { ok: true, data: begun.data };
  if (begun.status === "stale") return conflict(messages.CONFLICT);
  if (begun.status === "conflict") return conflict(messages.CONFLICT);

  const release = () =>
    releaseReroute(
      previous.navigationId,
      request.previousRouteVersion,
      request.clientRequestId,
    );
  try {
    const currentOrigin = {
      latitude: request.currentPosition.latitude,
      longitude: request.currentPosition.longitude,
    };
    const planned = await planAccessibleRouteFromRequest({
      ...previous.canonicalRequest,
      language,
      origin: currentOrigin,
      userLocation: currentOrigin,
    });
    if (!planned.ok) {
      await release();
      const existingData = planned.data as
        { reason?: string; [key: string]: unknown } | undefined;
      return {
        ...planned,
        // a stale venue keeps its own 410 message in both languages
        error:
          language === "en" && planned.status !== ResponseCode.GONE
            ? REROUTE_MSG_EN.PLAN_FAILED
            : planned.error,
        data: existingData?.reason
          ? existingData
          : { ...(existingData ?? {}), reason: "REROUTE_PLANNING_FAILED" },
      };
    }
    const selected = planned.data.routes[0];
    if (!selected) {
      await release();
      return {
        ok: false,
        status: ResponseCode.UNPROCESSABLE_ENTITY,
        error: language === "en" ? REROUTE_MSG_EN.NO_ROUTE : ROUTE_MSG.NO_ROUTE,
        data: { reason: "NO_ROUTE" },
      };
    }
    const routeVersion = request.previousRouteVersion + 1;
    const route = {
      ...selected,
      navigationId: previous.navigationId,
      routeVersion,
    };
    const instructionsResult = generateNavInstructions(
      route,
      undefined,
      language,
    );
    const stepsResult = generateNavStepsWithLegIndex(route, language);
    if (!instructionsResult.ok || !stepsResult.ok) {
      await release();
      return {
        ok: false,
        status: ResponseCode.UNPROCESSABLE_ENTITY,
        error: messages.NO_STEPS,
        data: { reason: "NAV_INSTRUCTIONS_UNAVAILABLE" },
      };
    }
    const routeToken = randomBytes(32).toString("base64url");
    const warnings = [
      ...(route.warnings ?? []),
      ...instructionsResult.data.warnings,
      ...stepsResult.warnings,
    ].filter((value, index, all) => all.indexOf(value) === index);
    const warningDetails = (route.warningDetails ?? []).flatMap((detail) => {
      const rawMessage = route.warnings?.[detail.index];
      if (!rawMessage || detail.message !== rawMessage) return [];
      const index = warnings.indexOf(rawMessage);
      return index < 0 ? [] : [{ ...detail, index, message: rawMessage }];
    });
    const data: RerouteData = {
      navigationId: previous.navigationId,
      previousRouteVersion: request.previousRouteVersion,
      routeVersion,
      routeToken,
      route,
      instructions: instructionsResult.data.instructions,
      steps: stepsResult.steps.map(({ instruction }, index) => ({
        index,
        instruction: instruction.text,
        legType: instruction.legType,
        distanceM: instruction.distanceM,
        isTransit: ["BUS", "METRO", "THSR", "TRA"].includes(
          instruction.legType,
        ),
      })),
      warnings,
      ...(warningDetails.length ? { warningDetails } : {}),
      currentStepIndex: 0,
      replayed: false,
      ...(planned.data.venueArrival
        ? {
            venueArrival: planned.data.venueArrival,
            venueLeg: planned.data.venueLeg,
          }
        : {}),
    };
    const envelope: NavigationRouteEnvelope = {
      schemaVersion: 1,
      route,
      navigationId: previous.navigationId,
      routeVersion,
      canonicalRequest: {
        ...previous.canonicalRequest,
        origin: currentOrigin,
        userLocation: currentOrigin,
        language,
        // the venue version actually used for this leg, not the stored one
        ...(planned.data.venueArrival
          ? { venueArrival: planned.data.venueArrival }
          : {}),
      },
    };
    const finalized = await finalizeReroute(
      request.previousRouteVersion,
      request.clientRequestId,
      routeToken,
      envelope,
      data,
    );
    if (finalized === "unavailable") {
      return {
        ok: false,
        status: ResponseCode.SERVICE_UNAVAILABLE,
        error: messages.UNAVAILABLE,
        data: { reason: "NAVIGATION_STATE_UNAVAILABLE" },
      };
    }
    if (finalized === "stale") return conflict(messages.CONFLICT);
    if (finalized === "conflict") return conflict(messages.CONFLICT);
    await storeBusPlan(routeToken, route);
    return { ok: true, data };
  } catch (error) {
    await release();
    throw error;
  }
}
