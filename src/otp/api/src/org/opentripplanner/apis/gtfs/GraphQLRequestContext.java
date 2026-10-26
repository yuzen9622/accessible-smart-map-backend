package org.opentripplanner.apis.gtfs;

import graphql.schema.GraphQLSchema;
import org.opentripplanner.routing.api.RoutingService;
import org.opentripplanner.routing.api.request.RouteRequest;
import org.opentripplanner.routing.fares.FareService;
import org.opentripplanner.routing.graphfinder.GraphFinder;
import org.opentripplanner.service.realtimevehicles.RealtimeVehicleService;
import org.opentripplanner.service.vehicleparking.VehicleParkingService;
import org.opentripplanner.service.vehiclerental.VehicleRentalService;
import org.opentripplanner.standalone.api.OtpServerRequestContext;
import org.opentripplanner.transfer.regular.RegularTransferService;
import org.opentripplanner.transit.service.TransitService;

public record GraphQLRequestContext(
  RoutingService routingService,
  TransitService transitService,
  RegularTransferService transferService,
  FareService fareService,
  VehicleRentalService vehicleRentalService,
  VehicleParkingService vehicleParkingService,
  RealtimeVehicleService realTimeVehicleService,
  GraphQLSchema schema,
  GraphFinder graphFinder,
  RouteRequest defaultRouteRequest,
  org.opentripplanner.model.plan.leg.GraphByteIdentity graphByteIdentity,
  org.opentripplanner.model.plan.leg.BuildManifestIdentity buildManifestIdentity,
  org.opentripplanner.runtime.policyidentity.RuntimePolicyIdentity.Result runtimePolicyIdentity
) {
  /** Preserve the existing constructor ABI; contexts without a bound graph remain unverified. */
  public GraphQLRequestContext(
    RoutingService routingService, TransitService transitService,
    RegularTransferService transferService, FareService fareService,
    VehicleRentalService vehicleRentalService, VehicleParkingService vehicleParkingService,
    RealtimeVehicleService realTimeVehicleService, GraphQLSchema schema,
    GraphFinder graphFinder, RouteRequest defaultRouteRequest
  ) {
    this(routingService, transitService, transferService, fareService, vehicleRentalService,
      vehicleParkingService, realTimeVehicleService, schema, graphFinder, defaultRouteRequest, null);
  }

  public GraphQLRequestContext(
    RoutingService routingService, TransitService transitService,
    RegularTransferService transferService, FareService fareService,
    VehicleRentalService vehicleRentalService, VehicleParkingService vehicleParkingService,
    RealtimeVehicleService realTimeVehicleService, GraphQLSchema schema,
    GraphFinder graphFinder, RouteRequest defaultRouteRequest,
    org.opentripplanner.model.plan.leg.GraphByteIdentity graphByteIdentity
  ) {
    this(routingService, transitService, transferService, fareService, vehicleRentalService,
      vehicleParkingService, realTimeVehicleService, schema, graphFinder, defaultRouteRequest,
      graphByteIdentity, null);
  }

  /** Existing 12-argument callers snapshot runtime identity at context creation. */
  public GraphQLRequestContext(
    RoutingService routingService, TransitService transitService,
    RegularTransferService transferService, FareService fareService,
    VehicleRentalService vehicleRentalService, VehicleParkingService vehicleParkingService,
    RealtimeVehicleService realTimeVehicleService, GraphQLSchema schema,
    GraphFinder graphFinder, RouteRequest defaultRouteRequest,
    org.opentripplanner.model.plan.leg.GraphByteIdentity graphByteIdentity,
    org.opentripplanner.model.plan.leg.BuildManifestIdentity buildManifestIdentity
  ) {
    this(routingService, transitService, transferService, fareService, vehicleRentalService,
      vehicleParkingService, realTimeVehicleService, schema, graphFinder, defaultRouteRequest,
      graphByteIdentity, buildManifestIdentity,
      org.opentripplanner.runtime.policyidentity.RuntimePolicyIdentity.current());
  }

  public RequestIdentity requestIdentity() {
    return new RequestIdentity(graphByteIdentity, buildManifestIdentity, runtimePolicyIdentity);
  }

  public static GraphQLRequestContext ofServerContext(OtpServerRequestContext context) {
    return new GraphQLRequestContext(
      context.routingService(),
      context.transitService(),
      context.transferService(),
      context.fareService(),
      context.vehicleRentalService(),
      context.vehicleParkingService(),
      context.realtimeVehicleService(),
      context.gtfsSchema(),
      context.graphFinder(),
      context.defaultRouteRequest(),
      org.opentripplanner.routing.graph.LoadedGraphIdentityRegistry.forGraph(context.graph()),
      org.opentripplanner.routing.graph.LoadedGraphIdentityRegistry.manifestForGraph(context.graph())
    );
  }

  /**
   * Returns a clone of the default route request. The clone is necessary because one HTTP
   * request can lead to several GraphQL queries, for example through batch or alias queries.
   */
  @Override
  public RouteRequest defaultRouteRequest() {
    return defaultRouteRequest;
  }
}
