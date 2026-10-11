import { Router } from "express";
import {
  getBusRouteHandler,
  getBusRouteDetailHandler,
  getBusArrivalHandler,
  getBusTimetableHandler,
  getBusPositionsHandler,
  searchBusRoutesHandler,
  searchBusStopsHandler,
  getNearbyStopsHandler,
  getBusStopArrivalsHandler,
  getTransitAlertsHandler,
  getTrainTimetableHandler,
  getStationTimetableHandler,
  suggestTrainStationsHandler,
} from "./transit.controller";
import { validateRequest } from "../../middleware/validate-request.middleware";
import {
  BusRouteQuerySchema,
  BusRouteDetailQuerySchema,
  BusArrivalQuerySchema,
  BusTimetableQuerySchema,
  BusPositionsQuerySchema,
  BusSearchQuerySchema,
  BusStopSearchQuerySchema,
  BusNearbyQuerySchema,
  BusStopArrivalsQuerySchema,
  AlertQuerySchema,
  TrainTimetableQuerySchema,
  StationTimetableQuerySchema,
  StationSuggestQuerySchema,
} from "./transit.schema";

export function createTransitRouter(): Router {
  const router = Router();

  router.get(
    "/alerts",
    validateRequest({ query: AlertQuerySchema }),
    getTransitAlertsHandler,
  );

  router.get(
    "/train/timetable",
    validateRequest({ query: TrainTimetableQuerySchema }),
    getTrainTimetableHandler,
  );
  router.get(
    "/train/station-timetable",
    validateRequest({ query: StationTimetableQuerySchema }),
    getStationTimetableHandler,
  );
  router.get(
    "/train/stations",
    validateRequest({ query: StationSuggestQuerySchema }),
    suggestTrainStationsHandler,
  );

  router.get(
    "/bus/route",
    validateRequest({ query: BusRouteQuerySchema }),
    getBusRouteHandler,
  );
  router.get(
    "/bus/route-detail",
    validateRequest({ query: BusRouteDetailQuerySchema }),
    getBusRouteDetailHandler,
  );
  router.get(
    "/bus/arrival",
    validateRequest({ query: BusArrivalQuerySchema }),
    getBusArrivalHandler,
  );
  router.get(
    "/bus/timetable",
    validateRequest({ query: BusTimetableQuerySchema }),
    getBusTimetableHandler,
  );
  router.get(
    "/bus/positions",
    validateRequest({ query: BusPositionsQuerySchema }),
    getBusPositionsHandler,
  );

  router.get(
    "/bus/search-routes",
    validateRequest({ query: BusSearchQuerySchema }),
    searchBusRoutesHandler,
  );
  router.get(
    "/bus/search-route",
    validateRequest({ query: BusSearchQuerySchema }),
    searchBusRoutesHandler,
  );
  router.get(
    "/bus/search-stops",
    validateRequest({ query: BusStopSearchQuerySchema }),
    searchBusStopsHandler,
  );
  router.get(
    "/bus/search-stop",
    validateRequest({ query: BusStopSearchQuerySchema }),
    searchBusStopsHandler,
  );
  router.get(
    "/bus/nearby-stops",
    validateRequest({ query: BusNearbyQuerySchema }),
    getNearbyStopsHandler,
  );
  router.get(
    "/bus/stop-arrivals",
    validateRequest({ query: BusStopArrivalsQuerySchema }),
    getBusStopArrivalsHandler,
  );

  return router;
}
