import { randomBytes } from "crypto";
import { ResponseCode } from "../../types/code";
import { REROUTE_MSG, ROUTE_MSG } from "../../constants/messages";
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

export type RerouteResult =
  | { ok: true; data: RerouteData }
  | { ok: false; status: ResponseCode; error: string; data?: unknown };

const conflict = (message: string): RerouteResult => ({
  ok: false,
  status: ResponseCode.CONFLICT,
  error: message,
});

/** Shared HTTP/voice reroute orchestration with fail-closed Redis concurrency. */
export async function rerouteAccessibleRoute(
  request: RerouteRequest,
): Promise<RerouteResult> {
  const tokenRead = await readNavigationTokenStrict(request.routeToken);
  if (tokenRead.status === "unavailable") {
    return {
      ok: false,
      status: ResponseCode.SERVICE_UNAVAILABLE,
      error: REROUTE_MSG.UNAVAILABLE,
    };
  }
  if (
    tokenRead.status === "missing" ||
    !isNavigationEnvelope(tokenRead.value)
  ) {
    return {
      ok: false,
      status: ResponseCode.GONE,
      error: REROUTE_MSG.GONE,
    };
  }
  const previous = tokenRead.value;
  if (previous.routeVersion !== request.previousRouteVersion) {
    return conflict(REROUTE_MSG.CONFLICT);
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
      error: REROUTE_MSG.UNAVAILABLE,
    };
  }
  if (begun.status === "replay") return { ok: true, data: begun.data };
  if (begun.status === "stale") return conflict(REROUTE_MSG.CONFLICT);
  if (begun.status === "conflict") return conflict(REROUTE_MSG.CONFLICT);

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
      origin: currentOrigin,
      userLocation: currentOrigin,
    });
    if (!planned.ok) {
      await release();
      return planned;
    }
    const selected = planned.data.routes[0];
    if (!selected) {
      await release();
      return {
        ok: false,
        status: ResponseCode.UNPROCESSABLE_ENTITY,
        error: ROUTE_MSG.NO_ROUTE,
      };
    }
    const routeVersion = request.previousRouteVersion + 1;
    const route = {
      ...selected,
      navigationId: previous.navigationId,
      routeVersion,
    };
    const instructionsResult = generateNavInstructions(route);
    const stepsResult = generateNavStepsWithLegIndex(route);
    if (!instructionsResult.ok || !stepsResult.ok) {
      await release();
      return {
        ok: false,
        status: ResponseCode.UNPROCESSABLE_ENTITY,
        error: "替代路線無法產生導航步驟",
      };
    }
    const routeToken = randomBytes(32).toString("base64url");
    const warnings = [
      ...(route.warnings ?? []),
      ...instructionsResult.data.warnings,
      ...stepsResult.warnings,
    ].filter((value, index, all) => all.indexOf(value) === index);
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
      currentStepIndex: 0,
      replayed: false,
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
        error: REROUTE_MSG.UNAVAILABLE,
      };
    }
    if (finalized === "stale") return conflict(REROUTE_MSG.CONFLICT);
    if (finalized === "conflict") return conflict(REROUTE_MSG.CONFLICT);
    return { ok: true, data };
  } catch (error) {
    await release();
    throw error;
  }
}
