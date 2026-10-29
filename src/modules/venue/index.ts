import type { VenueArrivalPlanner } from "../accessible-route/venue-arrival.port";
import {
  isVenueArrivalCurrent,
  replanVenueLeg,
  resolveVenueArrival,
  resolveVenueDeparture,
} from "./venue.service";

export { createVenueRouter } from "./venue.router";

/** The venue planner, registered into accessible-route at the composition root. */
export const venueArrivalPlanner: VenueArrivalPlanner = {
  resolveVenueArrival,
  resolveVenueDeparture,
  replanVenueLeg,
  isVenueArrivalCurrent,
};
