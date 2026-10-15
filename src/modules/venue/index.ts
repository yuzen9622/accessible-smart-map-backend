import type { VenueArrivalPlanner } from "../accessible-route/venue-arrival.port";
import {
  isVenueArrivalCurrent,
  replanVenueLeg,
  resolveVenueArrival,
} from "./venue.service";

export { createVenueRouter } from "./venue.router";

/** The venue planner, registered into accessible-route at the composition root. */
export const venueArrivalPlanner: VenueArrivalPlanner = {
  resolveVenueArrival,
  replanVenueLeg,
  isVenueArrivalCurrent,
};
