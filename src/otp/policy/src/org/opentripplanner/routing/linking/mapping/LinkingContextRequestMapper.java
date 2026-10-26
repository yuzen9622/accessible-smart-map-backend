package org.opentripplanner.routing.linking.mapping;

import org.opentripplanner.routing.algorithm.raptoradapter.router.FilterTransitWhenDirectModeIsEmpty;
import org.opentripplanner.routing.api.request.RouteRequest;
import org.opentripplanner.routing.linking.LinkingContextRequest;

public class LinkingContextRequestMapper {

  public static LinkingContextRequest map(RouteRequest request) {
    var emptyDirectModeHandler = new FilterTransitWhenDirectModeIsEmpty(
      request.journey().direct().mode(),
      request.pageCursor() != null
    );
    var directMode = emptyDirectModeHandler.resolveDirectMode();
    return LinkingContextRequest.of()
      .withDirectWalkRequest(request.directWalkPolicyProfile()!=org.opentripplanner.routing.api.request.DirectWalkPolicyProfile.UNSPECIFIED&&request.journey().wheelchair()?request:null)
      .withGovernmentEndpointAttachment(
        request.directWalkPolicyProfile() != org.opentripplanner.routing.api.request.DirectWalkPolicyProfile.UNSPECIFIED &&
        request.journey().direct().mode() == org.opentripplanner.street.model.StreetMode.WALK &&
        !request.journey().transit().enabled()
      )
      .withEndpointWheelchair(request.journey().wheelchair())
      .withTransitEndpointFiltering(request.journey().transit().enabled())
      .withFrom(request.from())
      .withTo(request.to())
      .withViaLocationsWithCoordinates(request.listViaLocationsWithCoordinates())
      .withAccessMode(request.journey().access().mode())
      .withEgressMode(request.journey().egress().mode())
      .withDirectMode(directMode)
      .withTransferMode(request.journey().transfer().mode())
      .build();
  }
}
