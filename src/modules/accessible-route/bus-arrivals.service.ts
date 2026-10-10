import { ResponseCode } from "../../types/code";
import { TRANSIT_MSG } from "../../constants/messages";
import {
  getPlannedBusRouteDetail,
  resolveBusCity,
} from "../transit/bus.service";
import type { BusRouteDetailResult } from "../transit/transit.types";
import { readBusPlan } from "./bus-plan.repository";
import { getRouteByToken } from "./route-token.service";
import { attachBusSchedule } from "./route-schedule";

/** Only trusted, stored plan data selects the timetable and provider query. */
export async function getPlannedBusArrivals(
  routeToken: string,
  legIndex: number,
): Promise<BusRouteDetailResult> {
  const route = await getRouteByToken(routeToken);
  const busPlan = route ? null : await readBusPlan(routeToken);
  if (!route && !busPlan)
    return {
      ok: false,
      status: ResponseCode.NOT_FOUND,
      error: TRANSIT_MSG.PLAN_EXPIRED,
    };
  const leg = route?.legs[legIndex] ?? busPlan?.legs[legIndex];
  if (leg?.type !== "BUS" || !leg.scheduledTrip) {
    return {
      ok: false,
      status: ResponseCode.INVALID_INPUT,
      error: TRANSIT_MSG.PLAN_BUS_MISSING,
    };
  }
  const first = leg.scheduledTrip.stops[0];
  const departure = first?.departureAt ?? first?.arrivalAt;
  const city = await resolveBusCity(leg.tdxCity ?? leg.cityCode);
  if (!city || typeof departure !== "number") {
    return {
      ok: false,
      status: ResponseCode.INVALID_INPUT,
      error: TRANSIT_MSG.PLAN_BUS_MISSING,
    };
  }
  attachBusSchedule(
    leg,
    departure,
    leg.scheduledTrip.boardingReadyAt,
    leg.scheduledTrip.tripId,
  );
  return getPlannedBusRouteDetail(leg, city);
}
