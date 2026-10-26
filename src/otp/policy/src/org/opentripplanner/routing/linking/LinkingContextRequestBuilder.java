package org.opentripplanner.routing.linking;

import java.util.List;
import org.opentripplanner.model.GenericLocation;
import org.opentripplanner.street.model.StreetMode;

public class LinkingContextRequestBuilder {

  private final LinkingContextRequest original;
  private boolean governmentEndpointAttachment;
  private boolean endpointWheelchair;
  private boolean transitEndpointFiltering;
  private org.opentripplanner.routing.api.request.RouteRequest directWalkRequest;
  private GenericLocation from;
  private GenericLocation to;
  private List<GenericLocation> viaLocationsWithCoordinates;
  private StreetMode accessMode;
  private StreetMode egressMode;
  private StreetMode directMode;
  private StreetMode transferMode;

  public LinkingContextRequestBuilder(LinkingContextRequest original) {
    this.original = original;
    this.governmentEndpointAttachment = original.governmentEndpointAttachment();
    this.endpointWheelchair = original.endpointWheelchair();
    this.transitEndpointFiltering = original.transitEndpointFiltering();
    this.directWalkRequest = original.directWalkRequest();
    this.from = original.from();
    this.to = original.to();
    this.viaLocationsWithCoordinates = original.viaLocationsWithCoordinates();
    this.accessMode = original.accessMode();
    this.egressMode = original.egressMode();
    this.directMode = original.directMode();
    this.transferMode = original.transferMode();
  }

  public LinkingContextRequestBuilder withFrom(GenericLocation from) {
    this.from = from;
    return this;
  }

  public LinkingContextRequestBuilder withTo(GenericLocation to) {
    this.to = to;
    return this;
  }

  public LinkingContextRequestBuilder withViaLocationsWithCoordinates(
    List<GenericLocation> viaLocationsWithCoordinates
  ) {
    this.viaLocationsWithCoordinates = viaLocationsWithCoordinates;
    return this;
  }

  public LinkingContextRequestBuilder withAccessMode(StreetMode accessMode) {
    this.accessMode = accessMode;
    return this;
  }

  public LinkingContextRequestBuilder withEgressMode(StreetMode egressMode) {
    this.egressMode = egressMode;
    return this;
  }

  public LinkingContextRequestBuilder withDirectMode(StreetMode directMode) {
    this.directMode = directMode;
    return this;
  }

  public LinkingContextRequestBuilder withTransferMode(StreetMode transferMode) {
    this.transferMode = transferMode;
    return this;
  }

  public LinkingContextRequestBuilder withGovernmentEndpointAttachment(boolean value) {
    this.governmentEndpointAttachment = value; return this;
  }

  public LinkingContextRequestBuilder withEndpointWheelchair(boolean value) { endpointWheelchair=value; return this; }
  public boolean endpointWheelchair() { return endpointWheelchair; }
  public LinkingContextRequestBuilder withTransitEndpointFiltering(boolean value) {
    transitEndpointFiltering = value;
    return this;
  }
  public boolean transitEndpointFiltering() { return transitEndpointFiltering; }
  public LinkingContextRequestBuilder withDirectWalkRequest(org.opentripplanner.routing.api.request.RouteRequest value) { directWalkRequest=value; return this; }
  public org.opentripplanner.routing.api.request.RouteRequest directWalkRequest() { return directWalkRequest; }

  public boolean governmentEndpointAttachment() { return governmentEndpointAttachment; }

  public GenericLocation from() {
    return from;
  }

  public GenericLocation to() {
    return to;
  }

  public List<GenericLocation> viaLocationsWithCoordinates() {
    return viaLocationsWithCoordinates;
  }

  public StreetMode accessMode() {
    return accessMode;
  }

  public StreetMode egressMode() {
    return egressMode;
  }

  public StreetMode directMode() {
    return directMode;
  }

  public StreetMode transferMode() {
    return transferMode;
  }

  public LinkingContextRequest build() {
    LinkingContextRequest request = new LinkingContextRequest(this);
    return original.equals(request) ? original : request;
  }
}
