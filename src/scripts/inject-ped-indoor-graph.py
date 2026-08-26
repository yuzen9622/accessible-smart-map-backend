#!/usr/bin/env python3
"""Inject a Taipei GTFS pathways subgraph into an existing pedestrian graph."""

from __future__ import annotations

import argparse
import json
import math
import os
from collections import Counter, defaultdict
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from importlib import import_module
from typing import Any

TAIPEI_BBOX = (121.43, 24.95, 121.68, 25.22)
BBOXES = {"taipei": TAIPEI_BBOX}
GTFS_SOURCE = "gtfs_pathways"
GENERATED_SOURCE_PREFIX = f"{GTFS_SOURCE}:"
GENERATED_ID_SCALE = 1_000_000_000_000
GENERATED_ID_HIGH_WATER = 8_000_000_000_000_000_000
PRIMARY_MATCH_TOLERANCE_M = 50.0
MATCH_THRESHOLDS_M = (10.0, 25.0, 50.0, 100.0)
EARTH_RADIUS_M = 6_371_000.0
EDGE_TYPE_OTHER = 255
CONNECTOR_EDGE_TYPE = 2
PATHWAY_MODE_EDGE_TYPES = {1: 20, 2: 21, 3: 22, 4: 23, 5: 24, 6: 25, 7: 26}
LOCATION_TYPE_NODE_TYPES = {0: 9, 1: 8, 2: 11, 3: 7, 4: 10}

Coordinate = tuple[float, float]
NodeReference = str | int


@dataclass(frozen=True)
class StopRecord:
    """One GTFS stop with its original hierarchy and coordinate fields."""

    stop_id: str
    location_type: int
    parent_station: str | None
    longitude: float | None
    latitude: float | None


@dataclass(frozen=True)
class PathwayRecord:
    """One GTFS pathway used to form directed pedestrian graph edges."""

    pathway_id: str
    from_stop_id: str
    to_stop_id: str
    pathway_mode: int | None
    is_bidirectional: int | None
    traversal_time_s: float | None
    stair_count: int | None


@dataclass(frozen=True)
class StationGroup:
    """A raw parentStation group with an entrance-derived proxy geometry."""

    station_id: str
    entrances: tuple[StopRecord, ...]
    centroid: Coordinate
    radius_m: float
    parent_location_type: int | None


@dataclass(frozen=True)
class NodeDraft:
    """A generated node before assignment of its version-scoped database ID."""

    key: str
    geom: Coordinate | None
    proxy_geom: Coordinate
    station_id: str | None
    station_radius_m: float | None
    node_type: int
    source_ref: str
    attr_meta: dict[str, dict[str, Any]]


@dataclass(frozen=True)
class EdgeDraft:
    """A generated edge before internal references become ped_node IDs."""

    source_ref: str
    from_ref: NodeReference
    to_ref: NodeReference
    geometry: tuple[Coordinate, Coordinate] | None
    length_m: float | None
    edge_type: int
    stair_count: int | None
    traversal_time_s: float | None
    is_bidirectional: bool
    attr_meta: dict[str, dict[str, Any]]


@dataclass(frozen=True)
class NearestOutdoorEdge:
    """A closest outdoor edge, its snap point, and physical partial-edge lengths."""

    entrance_stop_id: str
    edge_id: int
    from_node: int
    to_node: int
    from_coordinate: Coordinate
    to_coordinate: Coordinate
    snap_coordinate: Coordinate
    entrance_distance_m: float
    from_distance_m: float
    to_distance_m: float
    is_bidirectional: bool


@dataclass(frozen=True)
class PreparedIndoorGraph:
    """The selected GTFS subgraph before its entrances are connected outdoors."""

    national_entrance_count: int
    taipei_entrances: tuple[StopRecord, ...]
    station_groups: dict[str, StationGroup]
    nodes: tuple[NodeDraft, ...]
    edges: tuple[EdgeDraft, ...]
    all_pathway_count: int
    taipei_any_endpoint_pathway_count: int
    included_pathway_count: int
    skipped_boundary_pathway_count: int
    skipped_cross_group_pathway_count: int
    parent_group_types: dict[str, int]


def finite_float(value: Any) -> float | None:
    """Return a finite float or None for absent and malformed input.

    @param value External scalar value.
    @returns A finite float or None.
    """
    try:
        parsed = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return parsed if math.isfinite(parsed) else None


def nonnegative_float(value: Any) -> float | None:
    """Return a finite nonnegative float or None for absent and malformed input.

    @param value External scalar value.
    @returns A finite nonnegative float or None.
    """
    parsed = finite_float(value)
    return parsed if parsed is not None and parsed >= 0 else None


def nonnegative_int(value: Any) -> int | None:
    """Return an exact nonnegative integer or None for absent and malformed input.

    @param value External scalar value.
    @returns A nonnegative integer or None.
    """
    parsed = nonnegative_float(value)
    if parsed is None or not parsed.is_integer():
        return None
    try:
        return int(parsed)
    except (OverflowError, ValueError):
        return None


def required_int(value: Any, label: str) -> int:
    """Decode a required database integer without leaking invalid rows into graph IDs.

    @param value Database scalar.
    @param label Field description for errors.
    @returns A valid integer.
    """
    parsed = nonnegative_int(value)
    if parsed is None:
        raise SystemExit(f"{label} is not a nonnegative integer")
    return parsed


def required_float(value: Any, label: str) -> float:
    """Decode a required database float without creating malformed geometry.

    @param value Database scalar.
    @param label Field description for errors.
    @returns A valid finite float.
    """
    parsed = finite_float(value)
    if parsed is None:
        raise SystemExit(f"{label} is not finite")
    return parsed


def required_text(value: Any, label: str) -> str:
    """Normalize a required source identifier.

    @param value Source scalar.
    @param label Field description for errors.
    @returns A nonempty normalized string.
    """
    text = str(value).strip() if value is not None else ""
    if not text:
        raise SystemExit(f"GTFS {label} is missing")
    return text


def optional_text(value: Any) -> str | None:
    """Normalize an optional source identifier.

    @param value Source scalar.
    @returns A normalized string or None.
    """
    text = str(value).strip() if value is not None else ""
    return text or None


def point_in_bbox(point: Coordinate, bbox: tuple[float, float, float, float]) -> bool:
    """Return whether a point is in the inclusive west-south-east-north bbox.

    @param point Longitude-latitude coordinate.
    @param bbox Inclusive geographic bbox.
    @returns Whether the point is in the bbox.
    """
    longitude, latitude = point
    west, south, east, north = bbox
    return west <= longitude <= east and south <= latitude <= north


def is_placeholder_coordinate(point: Coordinate) -> bool:
    """Identify the all-zero coordinate used by GTFS locationType 3 placeholders.

    @param point Longitude-latitude coordinate.
    @returns Whether the coordinate is effectively zero.
    """
    return abs(point[0]) < 0.001 and abs(point[1]) < 0.001


def require_real_coordinate(stop: StopRecord, purpose: str) -> Coordinate:
    """Reject missing and placeholder coordinates before they can enter graph geometry.

    @param stop Stop supplying a coordinate.
    @param purpose Destination graph field description.
    @returns A real longitude-latitude coordinate.
    """
    if stop.longitude is None or stop.latitude is None:
        raise SystemExit(f"GTFS stop {stop.stop_id} has no coordinate for {purpose}")
    point = (stop.longitude, stop.latitude)
    if is_placeholder_coordinate(point):
        raise SystemExit(
            f"GTFS stop {stop.stop_id} has a placeholder coordinate for {purpose}"
        )
    return point


def haversine_m(start: Coordinate, end: Coordinate) -> float:
    """Return the great-circle distance between two WGS84 coordinates.

    @param start Start longitude-latitude coordinate.
    @param end End longitude-latitude coordinate.
    @returns Distance in metres.
    """
    longitude_delta = math.radians(end[0] - start[0])
    latitude_delta = math.radians(end[1] - start[1])
    start_latitude = math.radians(start[1])
    end_latitude = math.radians(end[1])
    value = (
        math.sin(latitude_delta / 2.0) ** 2
        + math.cos(start_latitude)
        * math.cos(end_latitude)
        * math.sin(longitude_delta / 2.0) ** 2
    )
    return EARTH_RADIUS_M * 2.0 * math.atan2(math.sqrt(value), math.sqrt(1.0 - value))


def centroid_and_radius(points: Sequence[Coordinate]) -> tuple[Coordinate, float]:
    """Calculate an arithmetic entrance centroid and its maximum haversine radius.

    @param points Nonempty entrance longitude-latitude coordinates.
    @returns Centroid and maximum radius in metres.
    """
    if not points:
        raise ValueError("station group has no entrance coordinates")
    centroid = (
        sum(point[0] for point in points) / len(points),
        sum(point[1] for point in points) / len(points),
    )
    return centroid, max(haversine_m(point, centroid) for point in points)


def pathway_mode_to_edge_type(pathway_mode: int | None) -> int:
    """Map GTFS pathwayMode to the shared pedestrian edge dictionary.

    @param pathway_mode GTFS pathway mode.
    @returns Edge type code.
    """
    if pathway_mode is None:
        return EDGE_TYPE_OTHER
    return PATHWAY_MODE_EDGE_TYPES.get(pathway_mode, EDGE_TYPE_OTHER)


def location_type_to_node_type(location_type: int) -> int:
    """Map GTFS locationType to the shared pedestrian node dictionary.

    @param location_type GTFS location type.
    @returns Node type code.
    """
    return LOCATION_TYPE_NODE_TYPES.get(location_type, EDGE_TYPE_OTHER)


def source_meta(value: Any, updated_at: str, **extra: Any) -> dict[str, Any]:
    """Create one provenance value for a generated GTFS graph field.

    @param value Field value.
    @param updated_at UTC source-processing date.
    @param extra Extra source context.
    @returns Provenance metadata.
    """
    return {
        "value": value,
        "source": GTFS_SOURCE,
        "confidence": 1.0,
        "updated_at": updated_at,
        **extra,
    }


def stop_key(stop_id: str) -> str:
    """Create an internal generated-node key for a GTFS stop.

    @param stop_id GTFS stop ID.
    @returns Internal key.
    """
    return f"stop:{stop_id}"


def connector_key(stop_id: str) -> str:
    """Create an internal generated-node key for an entrance connector.

    @param stop_id GTFS stop ID.
    @returns Internal key.
    """
    return f"connector:{stop_id}"


def parse_stop(document: Mapping[str, Any]) -> StopRecord:
    """Parse the needed Mongo gtfstops fields.

    @param document Mongo stop document.
    @returns Normalized stop record.
    """
    location_type = nonnegative_int(document.get("locationType"))
    if location_type is None:
        raise SystemExit(f"GTFS stop {document.get('stopId')} has invalid locationType")
    return StopRecord(
        stop_id=required_text(document.get("stopId"), "stopId"),
        location_type=location_type,
        parent_station=optional_text(document.get("parentStation")),
        longitude=finite_float(document.get("stopLon")),
        latitude=finite_float(document.get("stopLat")),
    )


def parse_pathway(document: Mapping[str, Any]) -> PathwayRecord:
    """Parse the needed Mongo gtfspathways fields.

    @param document Mongo pathway document.
    @returns Normalized pathway record.
    """
    return PathwayRecord(
        pathway_id=required_text(document.get("pathwayId"), "pathwayId"),
        from_stop_id=required_text(document.get("fromStopId"), "fromStopId"),
        to_stop_id=required_text(document.get("toStopId"), "toStopId"),
        pathway_mode=nonnegative_int(document.get("pathwayMode")),
        is_bidirectional=nonnegative_int(document.get("isBidirectional")),
        traversal_time_s=nonnegative_float(document.get("traversalTime")),
        stair_count=nonnegative_int(document.get("stairCount")),
    )


def load_gtfs_records(mongo_uri: str) -> tuple[list[StopRecord], list[PathwayRecord]]:
    """Read GTFS stop and pathway records using the existing Mongo field convention.

    @param mongo_uri MongoDB URI with a database name.
    @returns Parsed stops and pathways.
    """
    client: Any | None = None
    try:
        mongo_client_class = import_module("pymongo").MongoClient
        client = mongo_client_class(mongo_uri)
        if client is None:
            raise RuntimeError("MongoDB client initialization returned no client")
        database = client.get_default_database()
        stop_documents = database["gtfsstops"].find(
            {},
            {
                "_id": 0,
                "stopId": 1,
                "locationType": 1,
                "parentStation": 1,
                "stopLon": 1,
                "stopLat": 1,
            },
        )
        pathway_documents = database["gtfspathways"].find(
            {},
            {
                "_id": 0,
                "pathwayId": 1,
                "fromStopId": 1,
                "toStopId": 1,
                "pathwayMode": 1,
                "isBidirectional": 1,
                "traversalTime": 1,
                "stairCount": 1,
            },
        )
        stops = [parse_stop(document) for document in stop_documents]
        pathways = [parse_pathway(document) for document in pathway_documents]
    except Exception as error:
        raise SystemExit(
            f"unable to load GTFS records from MongoDB: {error}"
        ) from error
    finally:
        if client is not None:
            client.close()
    return stops, pathways


def index_stops(stops: Iterable[StopRecord]) -> dict[str, StopRecord]:
    """Index stops and reject duplicate source IDs.

    @param stops Stop records.
    @returns Stop ID index.
    """
    result: dict[str, StopRecord] = {}
    for stop in stops:
        if stop.stop_id in result:
            raise SystemExit(f"GTFS stopId is duplicated: {stop.stop_id}")
        result[stop.stop_id] = stop
    return result


def build_station_groups(
    stops_by_id: Mapping[str, StopRecord], bbox: tuple[float, float, float, float]
) -> tuple[dict[str, StationGroup], tuple[StopRecord, ...], int]:
    """Group in-bbox entrances by their unmodified parentStation value.

    @param stops_by_id Stop ID index.
    @param bbox Geographic build extent.
    @returns Groups, Taipei entrances, and the nationwide entrance count.
    """
    entrances = [stop for stop in stops_by_id.values() if stop.location_type == 2]
    taipei_entrances = tuple(
        sorted(
            (
                stop
                for stop in entrances
                if stop.longitude is not None
                and stop.latitude is not None
                and point_in_bbox((stop.longitude, stop.latitude), bbox)
            ),
            key=lambda stop: stop.stop_id,
        )
    )
    grouped: dict[str, list[StopRecord]] = defaultdict(list)
    for entrance in taipei_entrances:
        if entrance.parent_station is None:
            raise SystemExit(
                f"Taipei entrance {entrance.stop_id} has no parentStation grouping key"
            )
        require_real_coordinate(entrance, "station proxy geometry")
        grouped[entrance.parent_station].append(entrance)
    groups: dict[str, StationGroup] = {}
    for station_id, group_entrances in grouped.items():
        coordinates = tuple(
            require_real_coordinate(entrance, "station proxy geometry")
            for entrance in group_entrances
        )
        centroid, radius_m = centroid_and_radius(coordinates)
        parent = stops_by_id.get(station_id)
        groups[station_id] = StationGroup(
            station_id=station_id,
            entrances=tuple(sorted(group_entrances, key=lambda item: item.stop_id)),
            centroid=centroid,
            radius_m=radius_m,
            parent_location_type=parent.location_type if parent else None,
        )
    return groups, taipei_entrances, len(entrances)


def station_assignments(
    stops_by_id: Mapping[str, StopRecord], groups: Mapping[str, StationGroup]
) -> dict[str, str]:
    """Assign direct raw-parentStation members to their selected group.

    @param stops_by_id Stop ID index.
    @param groups Selected parentStation groups.
    @returns Included stop-to-group mapping.
    """
    assignments = {station_id: station_id for station_id in groups}
    for stop in stops_by_id.values():
        parent_station = stop.parent_station
        if parent_station is None or parent_station not in groups:
            continue
        existing = assignments.get(stop.stop_id)
        if existing is not None and existing != parent_station:
            raise SystemExit(
                f"GTFS stop {stop.stop_id} belongs to multiple parentStation groups"
            )
        assignments[stop.stop_id] = parent_station
    return assignments


def select_pathways(
    pathways: Iterable[PathwayRecord], assignments: Mapping[str, str]
) -> tuple[list[PathwayRecord], int, int, int]:
    """Keep only pathways within one raw parentStation group and report exclusions.

    @param pathways All GTFS pathways.
    @param assignments Direct stop-to-group mapping.
    @returns Included pathways, any-endpoint count, boundary count, and cross-group count.
    """
    included: list[PathwayRecord] = []
    any_endpoint_count = 0
    boundary_count = 0
    cross_group_count = 0
    for pathway in pathways:
        from_group = assignments.get(pathway.from_stop_id)
        to_group = assignments.get(pathway.to_stop_id)
        if from_group is not None or to_group is not None:
            any_endpoint_count += 1
        if from_group is not None and to_group is not None:
            if from_group == to_group:
                included.append(pathway)
            else:
                cross_group_count += 1
        elif from_group is not None or to_group is not None:
            boundary_count += 1
    return included, any_endpoint_count, boundary_count, cross_group_count


def node_metadata(
    stop: StopRecord,
    group: StationGroup,
    geom: Coordinate | None,
    updated_at: str,
) -> dict[str, dict[str, Any]]:
    """Build the required provenance fields for one GTFS node.

    @param stop Source GTFS stop.
    @param group ParentStation group.
    @param geom Optional true entrance coordinate.
    @param updated_at UTC source-processing date.
    @returns Node metadata.
    """
    return {
        "node_type": source_meta(
            location_type_to_node_type(stop.location_type),
            updated_at,
            raw_location_type=stop.location_type,
        ),
        "station_id": source_meta(group.station_id, updated_at),
        "station_radius_m": source_meta(group.radius_m, updated_at),
        "geom": source_meta(list(geom) if geom is not None else None, updated_at),
        "proxy_geom": source_meta(list(group.centroid), updated_at),
    }


def build_nodes(
    stops_by_id: Mapping[str, StopRecord],
    assignments: Mapping[str, str],
    groups: Mapping[str, StationGroup],
    bbox: tuple[float, float, float, float],
    updated_at: str,
) -> list[NodeDraft]:
    """Create GTFS nodes with null geom for every non-locationType-2 record.

    @param stops_by_id Stop ID index.
    @param assignments Included stop-to-group mapping.
    @param groups ParentStation groups.
    @param bbox Geographic build extent.
    @param updated_at UTC source-processing date.
    @returns Stable-sorted GTFS node drafts.
    """
    nodes: list[NodeDraft] = []
    for stop_id, station_id in sorted(assignments.items()):
        stop = stops_by_id.get(stop_id)
        if stop is None:
            raise SystemExit(f"GTFS stop {stop_id} is missing from gtfstops")
        group = groups[station_id]
        geom: Coordinate | None = None
        if stop.location_type == 2:
            geom = require_real_coordinate(stop, "ped_node.geom")
            if not point_in_bbox(geom, bbox):
                raise SystemExit(
                    f"selected entrance {stop.stop_id} is outside the requested bbox"
                )
        nodes.append(
            NodeDraft(
                key=stop_key(stop.stop_id),
                geom=geom,
                proxy_geom=group.centroid,
                station_id=station_id,
                station_radius_m=group.radius_m,
                node_type=location_type_to_node_type(stop.location_type),
                source_ref=f"{GTFS_SOURCE}:stop:{stop.stop_id}",
                attr_meta=node_metadata(stop, group, geom, updated_at),
            )
        )
    return nodes


def pathway_metadata(
    pathway: PathwayRecord, updated_at: str
) -> dict[str, dict[str, Any]]:
    """Build the required provenance fields for one GTFS pathway.

    @param pathway Source GTFS pathway.
    @param updated_at UTC source-processing date.
    @returns Edge metadata.
    """
    is_bidirectional = pathway.is_bidirectional == 1
    return {
        "edge_type": source_meta(
            pathway_mode_to_edge_type(pathway.pathway_mode),
            updated_at,
            raw_pathway_mode=pathway.pathway_mode,
        ),
        "pathway_mode": source_meta(pathway.pathway_mode, updated_at),
        "length_m": source_meta(None, updated_at),
        "traversal_time_s": source_meta(pathway.traversal_time_s, updated_at),
        "stair_count": source_meta(pathway.stair_count, updated_at),
        "is_bidirectional": source_meta(
            is_bidirectional,
            updated_at,
            raw_is_bidirectional=pathway.is_bidirectional,
        ),
    }


def build_indoor_edges(
    pathways: Iterable[PathwayRecord], updated_at: str
) -> list[EdgeDraft]:
    """Create one or two null-geometry edges for each selected GTFS pathway.

    @param pathways Selected fully-contained pathways.
    @param updated_at UTC source-processing date.
    @returns Directed indoor edge drafts.
    """
    edges: list[EdgeDraft] = []
    for pathway in sorted(pathways, key=lambda item: item.pathway_id):
        edge_type = pathway_mode_to_edge_type(pathway.pathway_mode)
        bidirectional = pathway.is_bidirectional == 1
        edges.append(
            EdgeDraft(
                source_ref=f"{GTFS_SOURCE}:pathway:{pathway.pathway_id}:forward",
                from_ref=stop_key(pathway.from_stop_id),
                to_ref=stop_key(pathway.to_stop_id),
                geometry=None,
                length_m=None,
                edge_type=edge_type,
                stair_count=pathway.stair_count,
                traversal_time_s=pathway.traversal_time_s,
                is_bidirectional=bidirectional,
                attr_meta=pathway_metadata(pathway, updated_at),
            )
        )
        if bidirectional:
            edges.append(
                EdgeDraft(
                    source_ref=f"{GTFS_SOURCE}:pathway:{pathway.pathway_id}:reverse",
                    from_ref=stop_key(pathway.to_stop_id),
                    to_ref=stop_key(pathway.from_stop_id),
                    geometry=None,
                    length_m=None,
                    edge_type=edge_type,
                    stair_count=pathway.stair_count,
                    traversal_time_s=pathway.traversal_time_s,
                    is_bidirectional=True,
                    attr_meta=pathway_metadata(pathway, updated_at),
                )
            )
    return edges


def parent_group_type_counts(groups: Mapping[str, StationGroup]) -> dict[str, int]:
    """Count raw parent groups that are station roots, ordinary stops, or other values.

    @param groups ParentStation groups.
    @returns Parent root type counts.
    """
    counts = Counter(
        "station"
        if group.parent_location_type == 1
        else "ordinary"
        if group.parent_location_type == 0
        else "other"
        for group in groups.values()
    )
    return {
        "station": counts["station"],
        "ordinary": counts["ordinary"],
        "other": counts["other"],
    }


def prepare_indoor_graph(
    stops: Iterable[StopRecord],
    pathways: Iterable[PathwayRecord],
    bbox: tuple[float, float, float, float],
    updated_at: str,
) -> PreparedIndoorGraph:
    """Select the requested direct-parentStation Taipei subgraph without database writes.

    @param stops All GTFS stops.
    @param pathways All GTFS pathways.
    @param bbox Geographic build extent.
    @param updated_at UTC source-processing date.
    @returns Prepared GTFS graph.
    """
    stop_records = list(stops)
    pathway_records = list(pathways)
    stops_by_id = index_stops(stop_records)
    groups, taipei_entrances, national_entrance_count = build_station_groups(
        stops_by_id, bbox
    )
    assignments = station_assignments(stops_by_id, groups)
    included_pathways, any_endpoint_count, boundary_count, cross_group_count = (
        select_pathways(pathway_records, assignments)
    )
    nodes = build_nodes(stops_by_id, assignments, groups, bbox, updated_at)
    edges = build_indoor_edges(included_pathways, updated_at)
    return PreparedIndoorGraph(
        national_entrance_count=national_entrance_count,
        taipei_entrances=taipei_entrances,
        station_groups=groups,
        nodes=tuple(nodes),
        edges=tuple(edges),
        all_pathway_count=len(pathway_records),
        taipei_any_endpoint_pathway_count=any_endpoint_count,
        included_pathway_count=len(included_pathways),
        skipped_boundary_pathway_count=boundary_count,
        skipped_cross_group_pathway_count=cross_group_count,
        parent_group_types=parent_group_type_counts(groups),
    )


def database_boolean(value: Any, label: str) -> bool:
    """Decode a PostgreSQL boolean value without treating nonempty text as true.

    @param value Database scalar.
    @param label Field description for errors.
    @returns Decoded boolean.
    """
    if value in (True, 1, "1", "t", "true"):
        return True
    if value in (False, 0, "0", "f", "false"):
        return False
    raise SystemExit(f"{label} is not a boolean")


def nearest_outdoor_edge(
    cursor: Any, version_id: int, entrance: StopRecord
) -> NearestOutdoorEdge:
    """Use a PostGIS GiST KNN ordering and ST_Distance to find an outdoor edge.

    @param cursor Active PostGIS cursor.
    @param version_id Pedestrian graph version ID.
    @param entrance GTFS entrance with true coordinates.
    @returns Closest outdoor edge match.
    """
    longitude, latitude = require_real_coordinate(entrance, "outdoor-edge matching")
    try:
        cursor.execute(
            """
            WITH target AS (
              SELECT ST_SetSRID(ST_MakePoint(%s, %s), 4326) AS geom
            )
            SELECT
              edge.edge_id,
              edge.from_node,
              edge.to_node,
              edge.is_bidirectional,
              ST_X(ST_StartPoint(edge.geom)),
              ST_Y(ST_StartPoint(edge.geom)),
              ST_X(ST_EndPoint(edge.geom)),
              ST_Y(ST_EndPoint(edge.geom)),
              ST_X(ST_ClosestPoint(edge.geom, target.geom)),
              ST_Y(ST_ClosestPoint(edge.geom, target.geom)),
              ST_Distance(edge.geom::geography, target.geom::geography),
              ST_Distance(
                ST_StartPoint(edge.geom)::geography,
                ST_ClosestPoint(edge.geom, target.geom)::geography
              ),
              ST_Distance(
                ST_EndPoint(edge.geom)::geography,
                ST_ClosestPoint(edge.geom, target.geom)::geography
              )
            FROM ped_edge AS edge
            CROSS JOIN target
            WHERE edge.version_id = %s
              AND edge.geom IS NOT NULL
              AND COALESCE(edge.source_ref, '') NOT LIKE %s
            ORDER BY edge.geom <-> target.geom, edge.edge_id
            LIMIT 1
            """,
            (longitude, latitude, version_id, f"{GENERATED_SOURCE_PREFIX}%"),
        )
        row = cursor.fetchone()
    except Exception as error:
        raise SystemExit(
            f"unable to match entrance {entrance.stop_id}: {error}"
        ) from error
    if row is None:
        raise SystemExit("no pre-existing outdoor edge is available for matching")
    return NearestOutdoorEdge(
        entrance_stop_id=entrance.stop_id,
        edge_id=required_int(row[0], "nearest outdoor edge_id"),
        from_node=required_int(row[1], "nearest outdoor from_node"),
        to_node=required_int(row[2], "nearest outdoor to_node"),
        from_coordinate=(
            required_float(row[4], "nearest outdoor start longitude"),
            required_float(row[5], "nearest outdoor start latitude"),
        ),
        to_coordinate=(
            required_float(row[6], "nearest outdoor end longitude"),
            required_float(row[7], "nearest outdoor end latitude"),
        ),
        snap_coordinate=(
            required_float(row[8], "nearest outdoor snap longitude"),
            required_float(row[9], "nearest outdoor snap latitude"),
        ),
        entrance_distance_m=required_float(row[10], "nearest outdoor distance"),
        from_distance_m=required_float(row[11], "nearest outdoor start distance"),
        to_distance_m=required_float(row[12], "nearest outdoor end distance"),
        is_bidirectional=database_boolean(row[3], "nearest outdoor is_bidirectional"),
    )


def connector_metadata(
    match: NearestOutdoorEdge,
    updated_at: str,
    length_m: float | None = None,
    kind: str | None = None,
    is_bidirectional: bool | None = None,
    station_group: StationGroup | None = None,
) -> dict[str, dict[str, Any]]:
    """Build GTFS-only attribute provenance for a connector node or edge.

    @param match Outdoor edge match.
    @param updated_at UTC source-processing date.
    @param length_m Optional real connector length.
    @param kind Optional connector topology role.
    @param is_bidirectional Optional generated edge direction flag.
    @param station_group Optional parentStation group for a connector node.
    @returns Connector metadata.
    """
    values: dict[str, dict[str, Any]] = {
        "entrance_stop_id": source_meta(match.entrance_stop_id, updated_at),
        "matched_outdoor_edge_id": source_meta(match.edge_id, updated_at),
        "match_distance_m": source_meta(match.entrance_distance_m, updated_at),
    }
    if length_m is None:
        if station_group is None:
            raise ValueError("connector node requires a parentStation group")
        values.update(
            {
                "node_type": source_meta(12, updated_at),
                "station_id": source_meta(station_group.station_id, updated_at),
                "station_radius_m": source_meta(station_group.radius_m, updated_at),
                "geom": source_meta(list(match.snap_coordinate), updated_at),
                "proxy_geom": source_meta(list(station_group.centroid), updated_at),
            }
        )
    else:
        values.update(
            {
                "edge_type": source_meta(CONNECTOR_EDGE_TYPE, updated_at),
                "length_m": source_meta(length_m, updated_at),
                "is_bidirectional": source_meta(is_bidirectional, updated_at),
                "connector_kind": source_meta(kind, updated_at),
            }
        )
    return values


def connector_edge(
    source_ref: str,
    from_ref: NodeReference,
    to_ref: NodeReference,
    start: Coordinate,
    end: Coordinate,
    length_m: float,
    match: NearestOutdoorEdge,
    kind: str,
    is_bidirectional: bool,
    updated_at: str,
) -> EdgeDraft:
    """Create one real-geometry edge that joins a GTFS entrance to the outdoor graph.

    @param source_ref Stable generated source reference.
    @param from_ref Existing or generated source node reference.
    @param to_ref Existing or generated target node reference.
    @param start Real WGS84 edge start.
    @param end Real WGS84 edge end.
    @param length_m Physical edge length.
    @param match Outdoor edge match.
    @param kind Connector topology role.
    @param is_bidirectional Whether this edge is in a bidirectional pair.
    @param updated_at UTC source-processing date.
    @returns Connector edge draft.
    """
    return EdgeDraft(
        source_ref=source_ref,
        from_ref=from_ref,
        to_ref=to_ref,
        geometry=(start, end),
        length_m=length_m,
        edge_type=CONNECTOR_EDGE_TYPE,
        stair_count=None,
        traversal_time_s=None,
        is_bidirectional=is_bidirectional,
        attr_meta=connector_metadata(
            match, updated_at, length_m, kind, is_bidirectional
        ),
    )


def build_connectors(
    matches: Iterable[NearestOutdoorEdge],
    entrances_by_id: Mapping[str, StopRecord],
    station_groups: Mapping[str, StationGroup],
    updated_at: str,
) -> tuple[list[NodeDraft], list[EdgeDraft]]:
    """Create entrance nodes plus directional partial-edge links without changing outdoor rows.

    @param matches Accepted 50 m outdoor matches.
    @param entrances_by_id Taipei entrance index.
    @param station_groups Raw parentStation groups.
    @param updated_at UTC source-processing date.
    @returns Connector nodes and edges.
    """
    nodes: list[NodeDraft] = []
    edges: list[EdgeDraft] = []
    for match in sorted(matches, key=lambda item: item.entrance_stop_id):
        entrance = entrances_by_id[match.entrance_stop_id]
        if (
            entrance.parent_station is None
            or entrance.parent_station not in station_groups
        ):
            raise SystemExit(
                f"connector entrance {entrance.stop_id} has no selected parentStation group"
            )
        station_group = station_groups[entrance.parent_station]
        entrance_coordinate = require_real_coordinate(entrance, "connector geometry")
        key = connector_key(match.entrance_stop_id)
        prefix = f"{GTFS_SOURCE}:connector-edge:{match.entrance_stop_id}"
        nodes.append(
            NodeDraft(
                key=key,
                geom=match.snap_coordinate,
                proxy_geom=station_group.centroid,
                station_id=station_group.station_id,
                station_radius_m=station_group.radius_m,
                node_type=12,
                source_ref=f"{GTFS_SOURCE}:connector:{match.entrance_stop_id}",
                attr_meta=connector_metadata(
                    match, updated_at, station_group=station_group
                ),
            )
        )
        edges.extend(
            (
                connector_edge(
                    f"{prefix}:entrance-forward",
                    stop_key(match.entrance_stop_id),
                    key,
                    entrance_coordinate,
                    match.snap_coordinate,
                    match.entrance_distance_m,
                    match,
                    "entrance_to_snap",
                    True,
                    updated_at,
                ),
                connector_edge(
                    f"{prefix}:entrance-reverse",
                    key,
                    stop_key(match.entrance_stop_id),
                    match.snap_coordinate,
                    entrance_coordinate,
                    match.entrance_distance_m,
                    match,
                    "snap_to_entrance",
                    True,
                    updated_at,
                ),
            )
        )
        if match.is_bidirectional:
            edges.extend(
                (
                    connector_edge(
                        f"{prefix}:snap-to-from",
                        key,
                        match.from_node,
                        match.snap_coordinate,
                        match.from_coordinate,
                        match.from_distance_m,
                        match,
                        "snap_to_outdoor_from",
                        True,
                        updated_at,
                    ),
                    connector_edge(
                        f"{prefix}:from-to-snap",
                        match.from_node,
                        key,
                        match.from_coordinate,
                        match.snap_coordinate,
                        match.from_distance_m,
                        match,
                        "outdoor_from_to_snap",
                        True,
                        updated_at,
                    ),
                    connector_edge(
                        f"{prefix}:snap-to-to",
                        key,
                        match.to_node,
                        match.snap_coordinate,
                        match.to_coordinate,
                        match.to_distance_m,
                        match,
                        "snap_to_outdoor_to",
                        True,
                        updated_at,
                    ),
                    connector_edge(
                        f"{prefix}:to-to-snap",
                        match.to_node,
                        key,
                        match.to_coordinate,
                        match.snap_coordinate,
                        match.to_distance_m,
                        match,
                        "outdoor_to_to_snap",
                        True,
                        updated_at,
                    ),
                )
            )
        else:
            edges.extend(
                (
                    connector_edge(
                        f"{prefix}:from-to-snap",
                        match.from_node,
                        key,
                        match.from_coordinate,
                        match.snap_coordinate,
                        match.from_distance_m,
                        match,
                        "outdoor_from_to_snap",
                        False,
                        updated_at,
                    ),
                    connector_edge(
                        f"{prefix}:snap-to-to",
                        key,
                        match.to_node,
                        match.snap_coordinate,
                        match.to_coordinate,
                        match.to_distance_m,
                        match,
                        "snap_to_outdoor_to",
                        False,
                        updated_at,
                    ),
                )
            )
    return nodes, edges


def generated_identifier(version_id: int, ordinal: int, label: str) -> int:
    """Create a high positive BIGINT that preserves loader text-keyset ordering.

    @param version_id Graph version ID.
    @param ordinal Stable positive sequence number.
    @param label Identifier kind for errors.
    @returns Generated signed 64-bit ID.
    """
    if version_id <= 0 or ordinal <= 0 or ordinal >= GENERATED_ID_SCALE:
        raise ValueError(f"invalid {label} identifier inputs")
    value = version_id * GENERATED_ID_SCALE + ordinal
    if value >= GENERATED_ID_HIGH_WATER:
        raise ValueError(f"{label} identifier exceeds the generated BIGINT range")
    return GENERATED_ID_HIGH_WATER - value


def point_wkt(point: Coordinate | None) -> str | None:
    """Serialize an optional point for PostGIS.

    @param point Optional WGS84 coordinate.
    @returns Point WKT or None.
    """
    return None if point is None else f"POINT ({point[0]:.12f} {point[1]:.12f})"


def line_wkt(line: tuple[Coordinate, Coordinate] | None) -> str | None:
    """Serialize an optional two-point line for PostGIS.

    @param line Optional WGS84 line.
    @returns Line WKT or None.
    """
    if line is None:
        return None
    return (
        f"LINESTRING ({line[0][0]:.12f} {line[0][1]:.12f}, "
        f"{line[1][0]:.12f} {line[1][1]:.12f})"
    )


def resolve_node_reference(
    reference: NodeReference, generated_node_ids: Mapping[str, int]
) -> int:
    """Resolve a generated key or retain an existing outdoor node ID.

    @param reference Generated key or outdoor node ID.
    @param generated_node_ids Generated ID mapping.
    @returns ped_node ID.
    """
    if isinstance(reference, int):
        return reference
    if reference not in generated_node_ids:
        raise SystemExit(f"generated edge refers to missing node {reference}")
    return generated_node_ids[reference]


def percentile(values: Sequence[float], proportion: float) -> float | None:
    """Calculate the deterministic floor-index percentile used by integration tests.

    @param values Numeric samples.
    @param proportion Zero-to-one percentile.
    @returns Percentile or None for no sample.
    """
    if not values:
        return None
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, math.floor((len(ordered) - 1) * proportion))]


def distribution(values: Sequence[float]) -> dict[str, float | int | None]:
    """Summarize numeric samples with count, min, p50, p95, and max.

    @param values Numeric samples.
    @returns Rounded distribution summary.
    """
    if not values:
        return {"count": 0, "min": None, "p50": None, "p95": None, "max": None}
    return {
        "count": len(values),
        "min": round(min(values), 3),
        "p50": round(percentile(values, 0.5) or 0.0, 3),
        "p95": round(percentile(values, 0.95) or 0.0, 3),
        "max": round(max(values), 3),
    }


def threshold_report(
    matches: Sequence[NearestOutdoorEdge], total: int
) -> dict[str, dict[str, float | int]]:
    """Calculate all required tolerance success rates using the Taipei denominator.

    @param matches All Taipei nearest-edge matches.
    @param total Taipei entrance denominator.
    @returns Threshold metrics keyed by metres.
    """
    result: dict[str, dict[str, float | int]] = {}
    for threshold in MATCH_THRESHOLDS_M:
        success = sum(match.entrance_distance_m <= threshold for match in matches)
        result[f"{threshold:.0f}"] = {
            "success": success,
            "denominator": total,
            "rate_pct": round(success / total * 100.0, 3) if total else 0.0,
        }
    return result


def count_undirected_segments(edges: Sequence[EdgeDraft]) -> int:
    """Count the undirected links behind generated directed edges.

    @param edges Generated directed edge drafts.
    @returns Undirected segment count.
    """
    paired = sum(edge.is_bidirectional for edge in edges)
    if paired % 2 != 0:
        raise SystemExit("bidirectional generated edges are not fully paired")
    return paired // 2 + (len(edges) - paired)


def outdoor_graph_statistics(
    existing_notes: Mapping[str, Any],
) -> tuple[int, dict[str, int]]:
    """Read the outdoor-only statistics, preferring the snapshot a prior injection wrote.

    @param existing_notes Stored version notes.
    @returns Outdoor undirected segment count and outdoor edge type distribution.
    """
    segment_count = existing_notes.get(
        "outdoor_undirected_segment_count",
        existing_notes.get("undirected_segment_count"),
    )
    distribution = existing_notes.get(
        "outdoor_edge_type_distribution",
        existing_notes.get("edge_type_distribution"),
    )
    if not isinstance(segment_count, int) or not isinstance(distribution, Mapping):
        raise SystemExit(
            "version notes lack the outdoor graph statistics written by build-ped-graph"
        )
    if not all(isinstance(value, int) for value in distribution.values()):
        raise SystemExit("stored outdoor edge type distribution has non-integer counts")
    return segment_count, {str(key): value for key, value in distribution.items()}


def merge_edge_type_distribution(
    outdoor_distribution: Mapping[str, int], edges: Sequence[EdgeDraft]
) -> dict[str, int]:
    """Add the generated edge types to the preserved outdoor distribution.

    @param outdoor_distribution Outdoor-only edge type counts.
    @param edges Generated directed edge drafts.
    @returns Whole-graph edge type counts keyed by stringified edge type.
    """
    merged = Counter(outdoor_distribution)
    merged.update(str(edge.edge_type) for edge in edges)
    return {key: merged[key] for key in sorted(merged, key=int)}


def build_notes(
    prepared: PreparedIndoorGraph,
    all_matches: Sequence[NearestOutdoorEdge],
    accepted_matches: Sequence[NearestOutdoorEdge],
    outdoor_node_count: int,
    outdoor_edge_count: int,
    outdoor_segment_count: int,
    outdoor_distribution: Mapping[str, int],
    connector_node_count: int,
    connector_edges: Sequence[EdgeDraft],
) -> dict[str, Any]:
    """Build the complete reproducibility evidence persisted in ped_graph_version.notes.

    @param prepared Prepared GTFS graph.
    @param all_matches All nearest-edge distances.
    @param accepted_matches Fixed-50-metre matches.
    @param outdoor_node_count Preserved outdoor node count.
    @param outdoor_edge_count Preserved outdoor directed edge count.
    @param outdoor_segment_count Preserved outdoor undirected segment count.
    @param outdoor_distribution Preserved outdoor edge type distribution.
    @param connector_node_count Generated connector node count.
    @param connector_edges Generated connector edge drafts.
    @returns JSON-serializable notes additions.
    """
    taipei_total = len(prepared.taipei_entrances)
    national_total = prepared.national_entrance_count
    accepted_count = len(accepted_matches)
    radii = [group.radius_m for group in prepared.station_groups.values()]
    connector_edge_count = len(connector_edges)
    indoor_segment_count = count_undirected_segments(prepared.edges)
    connector_segment_count = count_undirected_segments(connector_edges)
    return {
        "outdoor_node_count": outdoor_node_count,
        "indoor_node_count": len(prepared.nodes),
        "connector_node_count": connector_node_count,
        "outdoor_directed_edge_count": outdoor_edge_count,
        "indoor_directed_edge_count": len(prepared.edges),
        "connector_edge_count": connector_edge_count,
        "node_count": outdoor_node_count + len(prepared.nodes) + connector_node_count,
        "directed_edge_count": outdoor_edge_count
        + len(prepared.edges)
        + connector_edge_count,
        "outdoor_undirected_segment_count": outdoor_segment_count,
        "indoor_undirected_segment_count": indoor_segment_count,
        "connector_undirected_segment_count": connector_segment_count,
        "undirected_segment_count": outdoor_segment_count
        + indoor_segment_count
        + connector_segment_count,
        "outdoor_edge_type_distribution": dict(outdoor_distribution),
        "edge_type_distribution": merge_edge_type_distribution(
            outdoor_distribution, (*prepared.edges, *connector_edges)
        ),
        "gtfs_pathways": {
            "all_pathway_count": prepared.all_pathway_count,
            "taipei_any_endpoint_pathway_count": prepared.taipei_any_endpoint_pathway_count,
            "injected_fully_contained_pathway_count": prepared.included_pathway_count,
            "skipped_boundary_pathway_count": prepared.skipped_boundary_pathway_count,
            "skipped_cross_group_pathway_count": prepared.skipped_cross_group_pathway_count,
        },
        "entrance_matching": {
            "primary_taipei_50m": {
                "success": accepted_count,
                "denominator": taipei_total,
                "failure": taipei_total - accepted_count,
                "rate_pct": round(accepted_count / taipei_total * 100.0, 3)
                if taipei_total
                else 0.0,
            },
            "national_context": {
                "success": accepted_count,
                "denominator": national_total,
                "out_of_build_scope": national_total - taipei_total,
                "rate_pct": round(accepted_count / national_total * 100.0, 3)
                if national_total
                else 0.0,
            },
            "thresholds_m": threshold_report(all_matches, taipei_total),
            "distance_distribution_m": distribution(
                [match.entrance_distance_m for match in all_matches]
            ),
            "entrance_matches": [
                {
                    "stop_id": match.entrance_stop_id,
                    "matched_outdoor_edge_id": match.edge_id,
                    "distance_m": round(match.entrance_distance_m, 3),
                    "within_50m": match.entrance_distance_m
                    <= PRIMARY_MATCH_TOLERANCE_M,
                }
                for match in sorted(all_matches, key=lambda item: item.entrance_stop_id)
            ],
        },
        "station_radius_m": {
            "distribution": distribution(radii),
            "parent_group_types": prepared.parent_group_types,
            "groups": [
                {
                    "parent_station": group.station_id,
                    "entrance_count": len(group.entrances),
                    "radius_m": round(group.radius_m, 3),
                }
                for group in sorted(
                    prepared.station_groups.values(), key=lambda item: item.station_id
                )
            ],
        },
    }


def count_result(cursor: Any, label: str) -> int:
    """Read and validate a count row after a static SQL count query.

    @param cursor Active PostGIS cursor.
    @param label Count description for errors.
    @returns Count value.
    """
    try:
        row = cursor.fetchone()
    except Exception as error:
        raise SystemExit(f"unable to read {label}: {error}") from error
    if row is None:
        raise SystemExit(f"{label} query returned no row")
    return required_int(row[0], label)


def count_outdoor_nodes(cursor: Any, version_id: int, prefix: str) -> int:
    """Count non-generated nodes in one graph version.

    @param cursor Active PostGIS cursor.
    @param version_id Pedestrian graph version ID.
    @param prefix Generated source-ref prefix pattern.
    @returns Outdoor node count.
    """
    try:
        cursor.execute(
            """
            SELECT count(*) FROM ped_node
            WHERE version_id = %s AND COALESCE(source_ref, '') NOT LIKE %s
            """,
            (version_id, prefix),
        )
    except Exception as error:
        raise SystemExit(f"unable to query outdoor node count: {error}") from error
    return count_result(cursor, "outdoor node count")


def count_outdoor_edges(cursor: Any, version_id: int, prefix: str) -> int:
    """Count non-generated directed edges in one graph version.

    @param cursor Active PostGIS cursor.
    @param version_id Pedestrian graph version ID.
    @param prefix Generated source-ref prefix pattern.
    @returns Outdoor directed edge count.
    """
    try:
        cursor.execute(
            """
            SELECT count(*) FROM ped_edge
            WHERE version_id = %s AND COALESCE(source_ref, '') NOT LIKE %s
            """,
            (version_id, prefix),
        )
    except Exception as error:
        raise SystemExit(
            f"unable to query outdoor directed edge count: {error}"
        ) from error
    return count_result(cursor, "outdoor directed edge count")


def count_total_nodes(cursor: Any, version_id: int) -> int:
    """Count all nodes in one graph version.

    @param cursor Active PostGIS cursor.
    @param version_id Pedestrian graph version ID.
    @returns Total node count.
    """
    try:
        cursor.execute(
            "SELECT count(*) FROM ped_node WHERE version_id = %s", (version_id,)
        )
    except Exception as error:
        raise SystemExit(f"unable to query total node count: {error}") from error
    return count_result(cursor, "total node count")


def count_total_edges(cursor: Any, version_id: int) -> int:
    """Count all directed edges in one graph version.

    @param cursor Active PostGIS cursor.
    @param version_id Pedestrian graph version ID.
    @returns Total directed edge count.
    """
    try:
        cursor.execute(
            "SELECT count(*) FROM ped_edge WHERE version_id = %s", (version_id,)
        )
    except Exception as error:
        raise SystemExit(
            f"unable to query total directed edge count: {error}"
        ) from error
    return count_result(cursor, "total directed edge count")


def count_invalid_node_metadata(cursor: Any, version_id: int, prefix: str) -> int:
    """Count generated node metadata values that lack the GTFS source label.

    @param cursor Active PostGIS cursor.
    @param version_id Pedestrian graph version ID.
    @param prefix Generated source-ref prefix pattern.
    @returns Invalid generated node metadata count.
    """
    try:
        cursor.execute(
            """
            SELECT count(*) FROM ped_node,
              LATERAL jsonb_each(attr_meta) AS attribute
            WHERE version_id = %s AND source_ref LIKE %s
              AND COALESCE(attribute.value->>'source', '') <> %s
            """,
            (version_id, prefix, GTFS_SOURCE),
        )
    except Exception as error:
        raise SystemExit(f"unable to query generated node metadata: {error}") from error
    return count_result(cursor, "generated node metadata")


def count_invalid_edge_metadata(cursor: Any, version_id: int, prefix: str) -> int:
    """Count generated edge metadata values that lack the GTFS source label.

    @param cursor Active PostGIS cursor.
    @param version_id Pedestrian graph version ID.
    @param prefix Generated source-ref prefix pattern.
    @returns Invalid generated edge metadata count.
    """
    try:
        cursor.execute(
            """
            SELECT count(*) FROM ped_edge,
              LATERAL jsonb_each(attr_meta) AS attribute
            WHERE version_id = %s AND source_ref LIKE %s
              AND COALESCE(attribute.value->>'source', '') <> %s
            """,
            (version_id, prefix, GTFS_SOURCE),
        )
    except Exception as error:
        raise SystemExit(f"unable to query generated edge metadata: {error}") from error
    return count_result(cursor, "generated edge metadata")


def replace_generated_rows(
    cursor: Any, version_id: int
) -> tuple[int, int, dict[str, Any]]:
    """Lock one version, remove only this script's former rows, and preserve outdoor counts.

    @param cursor Active PostGIS cursor.
    @param version_id Pedestrian graph version ID.
    @returns Outdoor node count, outdoor edge count, and existing notes.
    """
    try:
        cursor.execute(
            "SELECT notes FROM ped_graph_version WHERE id = %s FOR UPDATE",
            (version_id,),
        )
        version_row = cursor.fetchone()
    except Exception as error:
        raise SystemExit(
            f"unable to lock graph version {version_id}: {error}"
        ) from error
    if version_row is None:
        raise SystemExit(f"ped_graph_version {version_id} does not exist")
    try:
        existing_notes = json.loads(version_row[0]) if version_row[0] else {}
    except (TypeError, json.JSONDecodeError) as error:
        raise SystemExit(
            f"ped_graph_version {version_id} notes are not JSON"
        ) from error
    prefix = f"{GENERATED_SOURCE_PREFIX}%"
    outdoor_node_count = count_outdoor_nodes(cursor, version_id, prefix)
    outdoor_edge_count = count_outdoor_edges(cursor, version_id, prefix)
    for key, observed in (
        ("outdoor_node_count", outdoor_node_count),
        ("outdoor_directed_edge_count", outdoor_edge_count),
    ):
        stored = existing_notes.get(key)
        if stored is not None and stored != observed:
            raise SystemExit(f"stored {key} does not match preserved outdoor graph")
    try:
        cursor.execute(
            "DELETE FROM ped_edge WHERE version_id = %s AND source_ref LIKE %s",
            (version_id, prefix),
        )
        cursor.execute(
            "DELETE FROM ped_node WHERE version_id = %s AND source_ref LIKE %s",
            (version_id, prefix),
        )
    except Exception as error:
        raise SystemExit(f"unable to replace generated graph rows: {error}") from error
    if count_outdoor_nodes(cursor, version_id, prefix) != outdoor_node_count:
        raise SystemExit("generated-node cleanup changed outdoor nodes")
    if count_outdoor_edges(cursor, version_id, prefix) != outdoor_edge_count:
        raise SystemExit("generated-edge cleanup changed outdoor edges")
    return outdoor_node_count, outdoor_edge_count, existing_notes


def insert_nodes(
    cursor: Any,
    version_id: int,
    nodes: Sequence[NodeDraft],
    generated_ids: Mapping[str, int],
) -> None:
    """Bulk insert generated GTFS and connector nodes.

    @param cursor Active PostGIS cursor.
    @param version_id Pedestrian graph version ID.
    @param nodes Generated node drafts.
    @param generated_ids Generated node ID mapping.
    @returns Nothing.
    """
    rows = [
        (
            generated_ids[node.key],
            version_id,
            point_wkt(node.geom),
            point_wkt(node.proxy_geom),
            node.station_id,
            node.station_radius_m,
            node.node_type,
            node.source_ref,
            json.dumps(node.attr_meta, ensure_ascii=False, separators=(",", ":")),
        )
        for node in nodes
    ]
    try:
        execute_values = import_module("psycopg2.extras").execute_values
        execute_values(
            cursor,
            """
            INSERT INTO ped_node (
              node_id, version_id, geom, proxy_geom, station_id, station_radius_m,
              node_type, source_ref, attr_meta
            ) VALUES %s
            """,
            rows,
            template="(%s,%s,ST_GeomFromText(%s,4326),ST_GeomFromText(%s,4326),%s,%s,%s,%s,%s::jsonb)",
            page_size=1_000,
        )
    except Exception as error:
        raise SystemExit(f"unable to insert generated nodes: {error}") from error


def insert_edges(
    cursor: Any,
    version_id: int,
    edges: Sequence[EdgeDraft],
    generated_ids: Mapping[str, int],
) -> None:
    """Bulk insert generated directed indoor and connector edges.

    @param cursor Active PostGIS cursor.
    @param version_id Pedestrian graph version ID.
    @param edges Generated edge drafts.
    @param generated_ids Generated node ID mapping.
    @returns Nothing.
    """
    rows = [
        (
            generated_identifier(version_id, ordinal, "edge"),
            version_id,
            resolve_node_reference(edge.from_ref, generated_ids),
            resolve_node_reference(edge.to_ref, generated_ids),
            line_wkt(edge.geometry),
            edge.length_m,
            edge.edge_type,
            edge.stair_count,
            edge.traversal_time_s,
            edge.is_bidirectional,
            edge.source_ref,
            json.dumps(edge.attr_meta, ensure_ascii=False, separators=(",", ":")),
        )
        for ordinal, edge in enumerate(edges, start=1)
    ]
    try:
        execute_values = import_module("psycopg2.extras").execute_values
        execute_values(
            cursor,
            """
            INSERT INTO ped_edge (
              edge_id, version_id, from_node, to_node, geom, length_m, edge_type,
              stair_count, traversal_time_s, is_bidirectional, source_ref, attr_meta
            ) VALUES %s
            """,
            rows,
            template="(%s,%s,%s,%s,ST_GeomFromText(%s,4326),%s,%s,%s,%s,%s,%s,%s::jsonb)",
            page_size=1_000,
        )
    except Exception as error:
        raise SystemExit(f"unable to insert generated edges: {error}") from error


def assert_metadata_sources(cursor: Any, version_id: int) -> None:
    """Verify every generated metadata entry has the required gtfs_pathways source.

    @param cursor Active PostGIS cursor.
    @param version_id Pedestrian graph version ID.
    @returns Nothing.
    """
    prefix = f"{GENERATED_SOURCE_PREFIX}%"
    if count_invalid_node_metadata(cursor, version_id, prefix):
        raise SystemExit("generated node metadata has a non-GTFS source")
    if count_invalid_edge_metadata(cursor, version_id, prefix):
        raise SystemExit("generated edge metadata has a non-GTFS source")


def inject_prepared_graph(
    prepared: PreparedIndoorGraph, version_id: int, db_url: str, updated_at: str
) -> dict[str, Any]:
    """Replace this version's prior generated rows with the prepared indoor subgraph.

    @param prepared Prepared GTFS graph.
    @param version_id Pedestrian graph version ID.
    @param db_url PostGIS URI.
    @param updated_at UTC source-processing date.
    @returns Persisted notes object.
    """
    try:
        connection = import_module("psycopg2").connect(db_url)
    except Exception as error:
        raise SystemExit(f"unable to connect to PostGIS: {error}") from error
    try:
        with connection, connection.cursor() as cursor:
            outdoor_nodes, outdoor_edges, existing_notes = replace_generated_rows(
                cursor, version_id
            )
            all_matches = [
                nearest_outdoor_edge(cursor, version_id, entrance)
                for entrance in prepared.taipei_entrances
            ]
            accepted_matches = [
                match
                for match in all_matches
                if match.entrance_distance_m <= PRIMARY_MATCH_TOLERANCE_M
            ]
            entrance_index = {
                entrance.stop_id: entrance for entrance in prepared.taipei_entrances
            }
            connector_nodes, connector_edges = build_connectors(
                accepted_matches,
                entrance_index,
                prepared.station_groups,
                updated_at,
            )
            nodes = sorted(
                (*prepared.nodes, *connector_nodes), key=lambda item: item.key
            )
            generated_ids = {
                node.key: generated_identifier(version_id, ordinal, "node")
                for ordinal, node in enumerate(nodes, start=1)
            }
            edges = (*prepared.edges, *connector_edges)
            insert_nodes(cursor, version_id, nodes, generated_ids)
            insert_edges(cursor, version_id, edges, generated_ids)
            outdoor_segments, outdoor_distribution = outdoor_graph_statistics(
                existing_notes
            )
            report = build_notes(
                prepared,
                all_matches,
                accepted_matches,
                outdoor_nodes,
                outdoor_edges,
                outdoor_segments,
                outdoor_distribution,
                len(connector_nodes),
                connector_edges,
            )
            notes = {**existing_notes, **report}
            total_nodes = count_total_nodes(cursor, version_id)
            total_edges = count_total_edges(cursor, version_id)
            if (
                total_nodes != report["node_count"]
                or total_edges != report["directed_edge_count"]
            ):
                raise SystemExit(
                    "generated graph totals do not match the version notes"
                )
            assert_metadata_sources(cursor, version_id)
            try:
                cursor.execute(
                    """
                    UPDATE ped_graph_version
                    SET node_count = %s, directed_edge_count = %s, notes = %s
                    WHERE id = %s
                    """,
                    (
                        report["node_count"],
                        report["directed_edge_count"],
                        json.dumps(notes, ensure_ascii=False, sort_keys=True),
                        version_id,
                    ),
                )
            except Exception as error:
                raise SystemExit(
                    f"unable to update graph version notes: {error}"
                ) from error
            if cursor.rowcount != 1:
                raise SystemExit(f"ped_graph_version {version_id} update failed")
            return notes
    finally:
        connection.close()


def print_report(version_id: int, notes: Mapping[str, Any]) -> None:
    """Print graph totals and all required matching and radius summaries.

    @param version_id Pedestrian graph version ID.
    @param notes Persisted notes object.
    @returns Nothing.
    """
    matching = notes["entrance_matching"]
    taipei = matching["primary_taipei_50m"]
    national = matching["national_context"]
    distance = matching["distance_distribution_m"]
    radius = notes["station_radius_m"]["distribution"]
    parents = notes["station_radius_m"]["parent_group_types"]
    print(f"[inject-ped-indoor-graph] version_id={version_id}")
    print(
        "[inject-ped-indoor-graph] "
        f"nodes outdoor={notes['outdoor_node_count']} indoor={notes['indoor_node_count']} "
        f"connectors={notes['connector_node_count']} total={notes['node_count']}"
    )
    print(
        "[inject-ped-indoor-graph] "
        f"edges outdoor={notes['outdoor_directed_edge_count']} "
        f"indoor={notes['indoor_directed_edge_count']} "
        f"connectors={notes['connector_edge_count']} total={notes['directed_edge_count']}"
    )
    print(
        "[inject-ped-indoor-graph] "
        f"undirected_segments outdoor={notes['outdoor_undirected_segment_count']} "
        f"indoor={notes['indoor_undirected_segment_count']} "
        f"connectors={notes['connector_undirected_segment_count']} "
        f"total={notes['undirected_segment_count']}"
    )
    print(
        "[inject-ped-indoor-graph] "
        f"matching_50m_taipei={taipei['success']}/{taipei['denominator']} "
        f"({taipei['rate_pct']:.3f}%) national_context={national['success']}/"
        f"{national['denominator']} ({national['rate_pct']:.3f}%) "
        f"out_of_scope={national['out_of_build_scope']}"
    )
    print(
        "[inject-ped-indoor-graph] "
        f"distance_m p50={distance['p50']:.3f} p95={distance['p95']:.3f} "
        f"max={distance['max']:.3f}"
    )
    print(
        "[inject-ped-indoor-graph] thresholds "
        + " ".join(
            f"{threshold}m={values['success']}/{values['denominator']} "
            f"({values['rate_pct']:.3f}%)"
            for threshold, values in matching["thresholds_m"].items()
        )
    )
    print(
        "[inject-ped-indoor-graph] "
        f"station_radius_m p50={radius['p50']:.3f} p95={radius['p95']:.3f} "
        f"max={radius['max']:.3f} groups={radius['count']} "
        f"parent_station={parents['station']} parent_ordinary={parents['ordinary']} "
        f"parent_other={parents['other']}"
    )


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    """Parse the documented command-line contract.

    @param argv Optional arguments.
    @returns Parsed arguments.
    """
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version-id", type=int, required=True)
    parser.add_argument("--bbox", choices=tuple(BBOXES), required=True)
    parser.add_argument(
        "--mongo-uri",
        default=os.environ.get("MONGO_URI") or os.environ.get("DATABASE_URL"),
    )
    parser.add_argument("--db-url", default=os.environ.get("PED_GRAPH_DATABASE_URL"))
    args = parser.parse_args(argv)
    if args.version_id <= 0:
        parser.error("--version-id must be positive")
    if not args.mongo_uri:
        parser.error("--mongo-uri or MONGO_URI/DATABASE_URL is required")
    if not args.db_url:
        parser.error("--db-url or PED_GRAPH_DATABASE_URL is required")
    return args


def main(argv: Sequence[str] | None = None) -> int:
    """Run the complete GTFS-to-PostGIS injection.

    @param argv Optional arguments.
    @returns Process exit status.
    """
    args = parse_args(argv)
    updated_at = datetime.now(timezone.utc).date().isoformat()
    stops, pathways = load_gtfs_records(args.mongo_uri)
    prepared = prepare_indoor_graph(stops, pathways, BBOXES[args.bbox], updated_at)
    notes = inject_prepared_graph(prepared, args.version_id, args.db_url, updated_at)
    print_report(args.version_id, notes)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
