"""Source-pinned, surface-contained pedestrian topology for the graph builder."""

from __future__ import annotations

import hashlib
import json
import math
import re
import sys
from array import array
from collections import OrderedDict
from contextlib import closing
from copy import deepcopy
from dataclasses import dataclass, replace
from decimal import Decimal
from itertools import pairwise
from pathlib import Path
from typing import Any

import numpy as np
from shapely import __version__ as shapely_version
from shapely import (
    constrained_delaunay_triangles,
    from_wkb,
    geos_version_string,
    get_coordinates,
)
from shapely.geometry import LineString, Point, Polygon, box
from shapely.ops import substring, transform, unary_union
from shapely.strtree import STRtree


class _ImmutableNodeMetadata(dict):
    __slots__ = ()

    @staticmethod
    def _immutable(*args, **kwargs):
        raise TypeError("Generated node metadata is immutable")

    __setitem__ = __delitem__ = clear = pop = popitem = setdefault = update = (
        __ior__
    ) = _immutable

    def __copy__(self):
        return self

    def __deepcopy__(self, memo):
        return self


_GENERATED_NODE_IDENTITY = _ImmutableNodeMetadata(
    source="generated:sidewalk-mesh", namespace="policy-local-ordinal"
)
_EMPTY_NODE_TAGS = _ImmutableNodeMetadata()


@dataclass(frozen=True, slots=True)
class SourceSurface:
    source_id: str
    county: str
    geometry: Any
    width_m: float | None
    effective_width_m: float | None
    raw: dict
    quality_flags: list
    ramp_count: int | None
    ramp_status: str


@dataclass(frozen=True, slots=True)
class SourceSnapshot:
    version_id: str
    archive_sha256: str
    surfaces: tuple[SourceSurface, ...]
    source_batch: str = "unknown"


@dataclass(frozen=True, slots=True)
class SurfaceCell:
    cell_id: int
    source_id: str
    geometry: Any
    grade: tuple[str | None, str | None, str | None, str | None]
    witness: dict


@dataclass(frozen=True, slots=True)
class NegativeObservation:
    way: Any
    geometry: Any
    kind: str
    qualification: str
    observed_width_m: float | None
    areal: bool = False

    @property
    def plane(self):
        mapped = (
            observed_grade(self.way.tags)
            if self.kind == "building"
            else grade(self.way.tags)
        )
        values = [
            None if isinstance(v, str) and v.startswith("opaque:") else v
            for v in mapped
        ]
        return values[0], values[1], values[2], values[3]


def known_width(value):
    if value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return number if math.isfinite(number) and number > 0 else None


def surface_clearance(surface):
    values = [known_width(surface.width_m), known_width(surface.effective_width_m)]
    return min((v for v in values if v is not None), default=None)


def width_regions(api, surface, effective, level, surfaces, source_tree, planes):
    own_width = surface_clearance(surface)
    candidates = []
    if None not in level and not any(str(v).startswith("opaque:") for v in level):
        for index in source_tree.query(effective):
            other = surfaces[int(index)]
            width = surface_clearance(other)
            if (
                other.source_id != surface.source_id
                and width is not None
                and (own_width is None or width < own_width)
                and planes[other.source_id][0] == level
                and not api.pedestrian_access_is_denied(other.raw)
            ):
                candidates.append((width, other.source_id, other))
    remainder = effective
    for _, _, other in sorted(candidates):
        overlap = remainder.intersection(other.geometry)
        if not overlap.is_empty and overlap.area > 0:
            yield overlap, other
            remainder = remainder.difference(other.geometry)
    if not remainder.is_empty:
        yield remainder, None


def scalar_plane(value):
    text = str(value).strip()
    if len(text) > 64 or not re.fullmatch(
        r"[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)", text
    ):
        return None
    number = Decimal(text)
    fixed = format(number, "f")
    return (
        "0" if number == 0 else fixed.rstrip("0").rstrip(".") if "." in fixed else fixed
    )


def grade(tags):
    # Opaque tokens remain strings in OSM identity keys (never unknown XY merges).
    return (
        scalar_plane(tags.get("layer", "0")) or "opaque:" + str(tags.get("layer")),
        scalar_plane(tags.get("level", "0")) or "opaque:" + str(tags.get("level")),
        "yes" if tags.get("bridge") not in (None, "no", "0", "false") else "no",
        "yes" if tags.get("tunnel") not in (None, "no", "0", "false") else "no",
    )


def shared_node_levels(api, ways, node_tags):
    """Resolve only mixed-plane nodes, without a per-vertex set or grade tuple."""
    interned = {}
    first_by_node = {}
    conflicts = {}
    for way in ways:
        if not api.should_include_way(way.tags):
            continue
        plane = grade(way.tags)
        plane = interned.setdefault(plane, plane)
        for node in way.nodes:
            first = first_by_node.setdefault(node.osm_id, plane)
            if first != plane:
                conflicts[node.osm_id] = min(conflicts.get(node.osm_id, first), plane)
    for node_id in conflicts:
        tags = node_tags.get(node_id, {})
        if any(key in tags for key in ("layer", "level", "bridge", "tunnel")):
            conflicts[node_id] = grade(tags)
    return conflicts


def load_source(db_url, version_id):
    import psycopg2

    with closing(psycopg2.connect(db_url)) as connection:
        connection.set_session(isolation_level="REPEATABLE READ", readonly=True)
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT archive_sha256,report,source_batch FROM ped_sidewalk_source_version WHERE id=%s",
                (version_id,),
            )
            row = cursor.fetchone()
            if row is None or not re.fullmatch(r"[0-9a-f]{64}", row[0]):
                raise ValueError(
                    "Missing or invalid pinned sidewalk source version/hash"
                )
            archive_hash, report, source_batch = row
            cursor.execute(
                """SELECT source_id,county,ST_AsBinary(geom),width_m,effective_width_m,
                raw_properties,quality_flags,ramp_count,ramp_status FROM ped_sidewalk_polygon
                WHERE source_version_id=%s ORDER BY source_id""",
                (version_id,),
            )
            surfaces = []
            for (
                source_id,
                county,
                wkb,
                width,
                effective,
                raw,
                flags,
                ramps,
                status,
            ) in cursor:
                geometry = from_wkb(bytes(wkb))
                if (
                    geometry.is_empty
                    or not geometry.is_valid
                    or geometry.geom_type not in ("Polygon", "MultiPolygon")
                ):
                    raise ValueError(f"Invalid pinned sidewalk geometry: {source_id}")
                west, south, east, north = geometry.bounds
                if not (-180 <= west <= east <= 180 and -90 <= south <= north <= 90):
                    raise ValueError(
                        f"Invalid pinned sidewalk coordinates: {source_id}"
                    )
                width, effective = known_width(width), known_width(effective)
                if width is not None and effective is not None and effective > width:
                    effective = None
                surfaces.append(
                    SourceSurface(
                        source_id,
                        county,
                        geometry,
                        width,
                        effective,
                        raw,
                        flags,
                        ramps,
                        status,
                    )
                )
            if not surfaces or len(surfaces) != report.get("acceptedFeatureCount"):
                raise ValueError("Pinned sidewalk source row accounting failed")
            return SourceSnapshot(
                str(version_id), archive_hash, tuple(surfaces), source_batch
            )


def polygon_parts(geometry):
    if geometry.geom_type == "Polygon":
        return [geometry] if geometry.area > 0 else []
    return [
        part
        for child in getattr(geometry, "geoms", ())
        for part in polygon_parts(child)
    ]


def intersection_points(geometry: Any) -> list[Point]:
    if geometry.is_empty:
        return []
    if geometry.geom_type == "Point":
        return [geometry]
    if geometry.geom_type in ("LineString", "LinearRing"):
        return [Point(geometry.coords[0]), Point(geometry.coords[-1])]
    return [
        point
        for child in getattr(geometry, "geoms", ())
        for point in intersection_points(child)
    ]


_CELL_COVERAGE_BUFFERS = OrderedDict()
_CELL_COVERAGE_BUFFER_LIMIT = 128


def cell_covers(cell, geometry):
    # IEEE-754 WGS84 midpoint arithmetic can land nanometres outside an edge.
    # This <0.02 micrometre bound is not a topology snapping radius.
    if cell.covers(geometry):
        return True
    key = id(cell)
    cached = _CELL_COVERAGE_BUFFERS.get(key)
    if cached is None or cached[0] is not cell:
        cached = (cell, cell.buffer(1e-13))
        _CELL_COVERAGE_BUFFERS[key] = cached
        if len(_CELL_COVERAGE_BUFFERS) > _CELL_COVERAGE_BUFFER_LIMIT:
            _CELL_COVERAGE_BUFFERS.popitem(last=False)
    _CELL_COVERAGE_BUFFERS.move_to_end(key)
    return cached[1].covers(geometry)


def shared_surface_portal(left, right, contact=None):
    contact = left.intersection(right) if contact is None else contact
    if contact.is_empty:
        return None
    def verified(candidates):
        for point in candidates:
            if all(cell_covers(cell, LineString([cell.centroid, point])) for cell in (left, right)):
                return tuple(point.coords[0])
        return None

    parts = contact.geoms if hasattr(contact, "geoms") else (contact,)
    for part in parts:
        portal = verified((part.representative_point(), part.centroid, *(Point(coordinate) for coordinate in get_coordinates(part))))
        if portal is not None:
            return portal
    # Overlay rounding can miss a valid existing vertex; never move a boundary.
    return verified(Point(coordinate) for cell in (left, right) for coordinate in get_coordinates(cell))


def surface_mesh(polygon):
    forward, _ = metric_transforms(polygon)
    original_vertices = {
        forward(x, y): (x, y)
        for ring in (polygon.exterior, *polygon.interiors)
        for x, y in ring.coords
    }
    metric_polygon = transform(forward, polygon)
    triangles = sorted(
        (
            Polygon([original_vertices[tuple(p)] for p in triangle.exterior.coords])
            for triangle in constrained_delaunay_triangles(metric_polygon).geoms
        ),
        key=lambda t: t.wkb_hex,
    )
    if not triangles or any(not polygon.covers(t) for t in triangles):
        raise ValueError("Constrained mesh escaped its source surface")
    links = []
    for triangle in triangles:
        center = tuple(triangle.centroid.coords[0])
        coordinates = list(triangle.exterior.coords)
        for a, b in pairwise(coordinates):
            midpoint = ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
            links.append((center, midpoint))
    return triangles, links


def metric_transforms(geometry):
    center = geometry.centroid
    x_scale = 6371000 * math.pi / 180 * math.cos(math.radians(center.y))
    y_scale = 6371000 * math.pi / 180

    def forward(x, y, z=None):
        return (x - center.x) * x_scale, (y - center.y) * y_scale

    def reverse(x, y, z=None):
        return x / x_scale + center.x, y / y_scale + center.y

    return forward, reverse


def clip_barriers(surface, barriers):
    if not barriers:
        return surface
    # A conservative 1 cm wall exclusion is a barrier witness, not gap healing.
    return surface.difference(unary_union(barriers).buffer(0.01))


ORDINARY_HIGHWAYS = {
    "road",
    "residential",
    "service",
    "unclassified",
    "tertiary",
    "tertiary_link",
    "secondary",
    "secondary_link",
    "primary",
    "primary_link",
    "living_street",
    "track",
}
VEHICLE_HIGHWAYS = ORDINARY_HIGHWAYS | {
    "motorway",
    "motorway_link",
    "trunk",
    "trunk_link",
}
GRADE_KEYS = ("layer", "level", "bridge", "tunnel")


def observed_grade(tags):
    mapped = grade(tags)
    values = [
        (scalar_plane(tags[key]) if i < 2 else mapped[i])
        if tags.get(key) not in (None, "")
        else None
        for i, key in enumerate(GRADE_KEYS)
    ]
    return values[0], values[1], values[2], values[3]


def compatible_grade(observed, mapped):
    return all(
        a is None or b is None or a == b for a, b in zip(observed, mapped, strict=True)
    )


def names(tags):
    return {
        name.strip().casefold()
        for key in ("NAME", "name", "alt_name", "official_name", "short_name")
        for name in str(tags.get(key) or "").split(";")
        if name.strip()
    }


def way_line(way):
    return LineString([(n.lon, n.lat) for n in way.nodes])


def corridor_intervals(line, geometry):
    forward, _ = metric_transforms(line)
    metric = transform(forward, line)
    other = transform(forward, geometry)
    if other.distance(metric) > 40:
        return []
    rectangle = other.minimum_rotated_rectangle
    corners = (
        list(rectangle.exterior.coords)
        if rectangle.geom_type == "Polygon"
        else list(other.coords)
    )
    a, b = max(
        pairwise(corners), key=lambda pair: Point(pair[0]).distance(Point(pair[1]))
    )
    axis = (b[0] - a[0], b[1] - a[1])
    points = (
        intersection_points(geometry.boundary)
        if geometry.geom_type == "Polygon"
        else intersection_points(geometry)
    )
    if geometry.geom_type in ("Polygon", "MultiPolygon"):
        points = [
            Point(p) for part in polygon_parts(geometry) for p in part.exterior.coords
        ]
    positions = [line.project(point) for point in points]
    if not positions or max(positions) <= min(positions):
        return []
    for start, end in pairwise(metric.coords):
        dx, dy = end[0] - start[0], end[1] - start[1]
        denominator = math.hypot(dx, dy) * math.hypot(*axis)
        if denominator and abs((dx * axis[0] + dy * axis[1]) / denominator) >= 0.9:
            return [(min(positions), max(positions))]
    return []


def corridor_context(surfaces, ways, tree):
    confirmed, potential = {}, {}
    for surface in surfaces:
        candidates = [
            ways[int(i)]
            for i in tree.query(surface.geometry.buffer(0.0005))
            if ways[int(i)].tags.get("highway") in ORDINARY_HIGHWAYS
            and compatible_grade(observed_grade(surface.raw), grade(ways[int(i)].tags))
            and corridor_intervals(way_line(ways[int(i)]), surface.geometry)
        ]
        matched = [w for w in candidates if names(surface.raw) & names(w.tags)]
        confirmed[surface.source_id] = matched
        potential[surface.source_id] = [] if matched else candidates
    return confirmed, potential


def resolve_surface_grade(surface, ways, node_tags, corridor_ways):
    observed = observed_grade(surface.raw)
    if all(value is not None for value in observed):
        return observed, {"status": "observed", "osm_way_ids": []}
    witnesses = list(corridor_ways)
    for way in ways:
        if not way_line(way).intersects(surface.geometry):
            continue
        if way.tags.get("highway") not in {"footway", "path", "pedestrian", "steps"}:
            continue
        named = bool(names(surface.raw) & names(way.tags)) and corridor_intervals(
            way_line(way), surface.geometry
        )
        entry = any(
            surface.geometry.covers(Point(n.lon, n.lat))
            and (
                node_tags.get(n.osm_id, {}).get("entrance") not in (None, "no")
                or way.tags.get("footway") in {"crossing", "sidewalk"}
            )
            for n in way.nodes
        )
        if named or entry:
            witnesses.append(way)
    witnesses = [w for w in witnesses if compatible_grade(observed, grade(w.tags))]
    planes = {grade(w.tags) for w in witnesses}
    if len(planes) == 1 and not any(
        value.startswith("opaque:") for plane in planes for value in plane
    ):
        return planes.pop(), {
            "status": "inferred",
            "osm_way_ids": sorted({str(w.osm_id) for w in witnesses}),
        }
    return observed, {
        "status": "ambiguous" if planes else "unknown",
        "osm_way_ids": sorted({str(w.osm_id) for w in witnesses}),
    }


def road_forbidden_intervals(
    way,
    surfaces,
    surface_tree,
    observations,
    observation_tree=None,
    confirmed=None,
    resolved_planes=None,
):
    tags = way.tags
    if tags.get("highway") not in ORDINARY_HIGHWAYS:
        return []
    line = way_line(way)
    if any(
        tags.get(key) in {"yes", "left", "right", "both", "separate"}
        for key in ("sidewalk", "sidewalk:left", "sidewalk:right", "sidewalk:both")
    ):
        return [(0.0, line.length)]
    candidates = []
    for i in surface_tree.query(line.buffer(0.0005)):
        surface = surfaces[int(i)]
        plane = (resolved_planes or {}).get(
            surface.source_id, (observed_grade(surface.raw), {})
        )[0]
        if not compatible_grade(plane, grade(tags)):
            continue
        assigned = (confirmed or {}).get(surface.source_id, [])
        if assigned and way.osm_id not in {w.osm_id for w in assigned}:
            continue
        candidates.append(surface.geometry)
    indexes = (
        observation_tree.query(line.buffer(0.0005))
        if observation_tree is not None
        else range(len(observations))
    )
    for i in indexes:
        geometry, evidence = observations[int(i)]
        if grade(evidence) == grade(tags):
            candidates.append(geometry)
    return [
        interval
        for geometry in candidates
        for interval in corridor_intervals(line, geometry)
    ]


def negative_observation(api, way, line, *, linear_only=False):
    tags = way.tags
    building = any(
        tags.get(k) not in (None, "no") for k in ("building", "building:part")
    )
    road = tags.get("highway") in VEHICLE_HIGHWAYS
    denied = api.pedestrian_access_is_denied(tags)
    wall = tags.get("barrier") in {"wall", "fence", "retaining_wall", "city_wall"}
    if not (building or road or denied or wall):
        return None
    kind = (
        "building"
        if building
        else "road"
        if road
        else "denied"
        if denied
        else "barrier"
    )
    width = known_width(api.parse_measurement_m(tags.get("width")))
    if (
        not linear_only
        and tags.get("area") != "no"
        and (building or tags.get("area") == "yes")
        and line.is_ring
    ):
        return NegativeObservation(
            way, Polygon(line.coords), kind, "footprint", width, True
        )
    if denied and not road:
        if width is None:
            return NegativeObservation(
                way, line, kind, "surface_width_quarantine", None
            )
        forward, reverse = metric_transforms(line)
        footprint = transform(reverse, transform(forward, line).buffer(width / 2))
        return NegativeObservation(way, footprint, kind, "known_width", width)
    return NegativeObservation(way, line, kind, "topological_cut", width)


def surface_exclusions(surface, level, observations):
    exclusions = []
    witnesses = []
    for observation in observations:
        way = observation.way
        tags = way.tags
        if not compatible_grade(level, observation.plane):
            continue
        if not observation.geometry.intersects(surface.geometry):
            continue
        excluded = observation.geometry
        quarantine_width = None
        if observation.qualification in {"surface_width_quarantine", "topological_cut"}:
            forward, reverse = metric_transforms(observation.geometry)
            distance = 0.01
            if observation.qualification == "surface_width_quarantine":
                rectangle = transform(
                    forward, surface.geometry
                ).minimum_rotated_rectangle
                quarantine_width = max(
                    min(
                        Point(a).distance(Point(b))
                        for a, b in pairwise(rectangle.exterior.coords)
                    ),
                    surface.width_m or 0,
                )
                distance = quarantine_width / 2
            excluded = transform(
                reverse, transform(forward, observation.geometry).buffer(distance)
            )
        exclusions.append(excluded)
        witness = {
            "osm_source_ref": getattr(way, "source_ref", f"osm:way/{way.osm_id}"),
            **(
                {"osm_way_id": str(way.osm_id)}
                if getattr(way, "source_kind", "way") == "way"
                else {}
            ),
            "member_refs": getattr(way, "member_refs", ()),
            "kind": observation.kind,
            "qualification": observation.qualification,
            "grade": observation.plane,
            "observed_width_m": observation.observed_width_m,
            "osm_tags": dict(tags),
        }
        if quarantine_width is not None:
            witness["quarantine_width_m"] = quarantine_width
        witnesses.append(witness)
    return exclusions, witnesses


def build_network(
    api,
    pbf_path,
    bbox,
    snapshot,
    dem_file=None,
    *,
    exclude_invalid_areas=False,
    stage_edges=False,
):
    store = (
        api.load_local_module("ped_edge_store", "ped-edge-store.py").DiskEdgeStore(
            api.EdgeRecord
        )
        if stage_edges
        else None
    )
    try:
        return _build_network(
            api,
            pbf_path,
            bbox,
            snapshot,
            dem_file,
            exclude_invalid_areas,
            store if store is not None else [],
        )
    except BaseException:
        if store is not None:
            store.close()
        raise


def _build_network(
    api, pbf_path, bbox, snapshot, dem_file, exclude_invalid_areas, edges
):
    areas = api.load_local_module("ped_osm_areas", "ped-osm-areas.py").collect_areas(
        pbf_path,
        bbox,
        api.pedestrian_access_is_denied,
        VEHICLE_HIGHWAYS,
        exclude_invalid=exclude_invalid_areas,
    )
    if hasattr(edges, "flush"):
        print(
            f"[build-ped-graph] stage=areas records={len(areas.records)}",
            file=sys.stderr,
            flush=True,
        )
    ways, invalid_count = api.collect_walk_ways(
        pbf_path, bbox, include_observations=True, include_building_outlines=False
    )
    ways = [way for way in ways if way.osm_id not in areas.excluded_way_ids]
    if hasattr(edges, "flush"):
        print(
            f"[build-ped-graph] stage=ways records={len(ways)} invalid={invalid_count}",
            file=sys.stderr,
            flush=True,
        )
    node_tags = api.collect_node_tags(
        pbf_path, {n.osm_id for w in ways for n in w.nodes}
    )
    if hasattr(edges, "flush"):
        print(
            f"[build-ped-graph] stage=node-tags records={len(node_tags)}",
            file=sys.stderr,
            flush=True,
        )
    shared_levels = shared_node_levels(api, ways, node_tags)
    if hasattr(edges, "flush"):
        print(
            f"[build-ped-graph] stage=shared-levels conflicts={len(shared_levels)}",
            file=sys.stderr,
            flush=True,
        )
    barriers = [
        w
        for w in ways
        if w.tags.get("barrier") in {"wall", "fence", "retaining_wall", "city_wall"}
    ]
    barrier_geometries = [
        LineString([(n.lon, n.lat) for n in w.nodes]) for w in barriers
    ]
    barrier_tree = STRtree(barrier_geometries)
    extent = box(*bbox)
    surfaces = tuple(s for s in snapshot.surfaces if s.geometry.intersects(extent))
    source_tree = STRtree([s.geometry for s in surfaces])
    way_geometries = [way_line(w) for w in ways]
    way_tree = STRtree(way_geometries)
    negative_observations = [
        observation
        for way, geometry in zip(ways, way_geometries, strict=True)
        if (observation := negative_observation(api, way, geometry, linear_only=True))
        is not None
    ]
    # Area boundaries must not reappear as solid footprints or linear cuts in
    # courtyards; retain independent traversal/barrier/denial member evidence.
    area_way_ids = {
        a.osm_id for a in areas.records if a.source_kind == "way"
    } | areas.delegated_outer_ids
    negative_observations = [
        o
        for o in negative_observations
        if o.way.osm_id not in area_way_ids or o.kind != "building"
    ]
    negative_observations.extend(
        NegativeObservation(
            area,
            area.geometry,
            "building"
            if any(
                area.tags.get(k) not in (None, "no")
                for k in ("building", "building:part")
            )
            else "road"
            if (
                area.tags.get("highway") in VEHICLE_HIGHWAYS
                or area.tags.get("area:highway") in VEHICLE_HIGHWAYS
            )
            else "denied",
            area.qualification,
            known_width(api.parse_measurement_m(area.tags.get("width"))),
            True,
        )
        for area in areas.records
    )
    negative_tree = STRtree([item.geometry for item in negative_observations])
    confirmed, potential = corridor_context(surfaces, ways, way_tree)
    surface_planes = {
        s.source_id: resolve_surface_grade(
            s,
            [ways[int(i)] for i in way_tree.query(s.geometry)],
            node_tags,
            confirmed[s.source_id],
        )
        for s in surfaces
    }
    potential = {
        source_id: [
            w
            for w in candidates
            if compatible_grade(surface_planes[source_id][0], grade(w.tags))
        ]
        for source_id, candidates in potential.items()
    }
    unresolved_roads = {
        w.osm_id for candidates in potential.values() for w in candidates
    }
    pedestrian_nodes = {
        n.osm_id
        for w in ways
        if api.should_include_way(w.tags)
        and w.tags.get("highway") not in ORDINARY_HIGHWAYS
        for n in w.nodes
    }
    denied_surfaces = [s for s in surfaces if api.pedestrian_access_is_denied(s.raw)]
    denied_tree = STRtree([s.geometry for s in denied_surfaces])
    hard_denials = [
        (s.geometry, surface_planes[s.source_id][0]) for s in denied_surfaces
    ]
    for observation in negative_observations:
        if (
            observation.kind == "road" and not observation.areal
        ) or not api.pedestrian_access_is_denied(observation.way.tags):
            continue
        geometry = observation.geometry
        if observation.qualification == "surface_width_quarantine":
            forward, reverse = metric_transforms(geometry)
            geometry = transform(reverse, transform(forward, geometry).buffer(0.01))
        hard_denials.append((geometry, observation.plane))
    if hasattr(edges, "flush"):
        print(
            f"[build-ped-graph] stage=indexes surfaces={len(surfaces)} "
            f"negative_observations={len(negative_observations)} hard_denials={len(hard_denials)}",
            file=sys.stderr,
            flush=True,
        )
    cells = []
    cell_surfaces = []
    region_width_evidence = {}
    constrained_region_count = 0
    native_width_evidence_count = 0
    nodes: Any = (
        api.load_local_module("ped_node_store", "ped-node-store.py").CompactNodeStore(
            api.NodeRecord,
            api.NodeRecord(
                0, 0.0, 0.0, api.node_type_for({}, 1, False),
                api.enum_code(None, api.KERB_CODES), None, None, None,
                "generated:sidewalk-mesh",
                {"identity": dict(_GENERATED_NODE_IDENTITY), "osm_tags": {}},
            ),
        )
        if hasattr(edges, "flush") else {}
    )
    keys = {}
    used = set()
    gov_edge_count = 0
    cell_metadata = OrderedDict()
    metadata_cache_limit = 128 if hasattr(edges, "flush") else None
    updated_at = api.source_updated_at(pbf_path)
    attached_sources = set()
    associations = {
        "ordinary_ways_with_sidewalk_association": 0,
        "ordinary_ways_without_resolved_sidewalk_association": 0,
        "ordinary_ways_with_unresolved_sidewalk_association": len(unresolved_roads),
    }

    def vertex(key, coordinate, source_ref, tags=None, merge_mesh=False):
        if key in keys:
            return keys[key]
        tags = tags or {}
        mesh_key = ("mesh", coordinate, key[-1])
        if merge_mesh and key[0] in {"osm", "osm-cut"} and mesh_key in keys:
            local_id = keys[mesh_key]
            keys[key] = local_id
            node = nodes[local_id]
            node = replace(node, attr_meta=deepcopy(node.attr_meta))
            node.attr_meta.setdefault("osm_members", {})[source_ref] = dict(tags)
            node_type = api.node_type_for(tags, 1, False)
            traffic, audible = api.node_signal_values(tags)
            nodes[local_id] = replace(
                node,
                node_type=node_type if node_type != 1 else node.node_type,
                kerb=api.enum_code(tags.get("kerb"), api.KERB_CODES),
                tactile_paving=api.bool_tag(tags.get("tactile_paving")),
                traffic_signal=traffic,
                audible_signal=audible,
            )
            return local_id
        local_id = len(keys) + 1
        if local_id >= api.NODE_ID_SCALE:
            raise ValueError("Policy node ordinal exceeds namespace")
        keys[key] = local_id
        tags = tags or {}
        traffic, audible = api.node_signal_values(tags)
        nodes[local_id] = api.NodeRecord(
            local_id,
            coordinate[0],
            coordinate[1],
            api.node_type_for(tags, 1, False),
            api.enum_code(tags.get("kerb"), api.KERB_CODES),
            api.bool_tag(tags.get("tactile_paving")),
            traffic,
            audible,
            source_ref,
            {
                "identity": _GENERATED_NODE_IDENTITY
                if source_ref == "generated:sidewalk-mesh"
                else {"source": source_ref, "namespace": "policy-local-ordinal"},
                "osm_tags": dict(tags) if tags else _EMPTY_NODE_TAGS,
            },
        )
        return local_id

    unknown_plane_keys = {}

    def plane_key(cell):
        if None not in cell.grade:
            return cell.grade
        key = (cell.grade, cell.source_id)
        return unknown_plane_keys.setdefault(key, key)

    def mesh_vertex(coordinate, level):
        return vertex(
            ("mesh", coordinate, level), coordinate, "generated:sidewalk-mesh", {}
        )

    def gov_link(a, b, cell, surface, from_id=None, to_id=None):
        nonlocal gov_edge_count
        if a == b:
            return
        geometry = LineString([a, b])
        if from_id is not None:
            attached_sources.add(surface.source_id)
        if not cell_covers(cell.geometry, geometry):
            raise ValueError("Surface connector lacks cell coverage witness")
        from_id = mesh_vertex(a, plane_key(cell)) if from_id is None else from_id
        to_id = mesh_vertex(b, plane_key(cell)) if to_id is None else to_id
        if cell.cell_id not in cell_metadata:
            meta = {
                "surface_witness": {
                    "cell_id": cell.cell_id,
                    "source_version_id": snapshot.version_id,
                    "source_id": surface.source_id,
                    "grade": cell.grade,
                },
                "source_properties": surface.raw,
                "quality_flags": surface.quality_flags,
                "ramp_observation": {
                    "count": surface.ramp_count,
                    "status": surface.ramp_status,
                },
            }
            for name in ("width_m", "effective_width_m"):
                value = cell.witness[name]
                if value is not None:
                    meta[name] = api.attribute_meta(
                        value,
                        "gov_sidewalk",
                        snapshot.source_batch,
                        source_version_id=snapshot.version_id,
                        source_id=surface.source_id,
                    )
            if "source_width_constraint" in cell.witness:
                meta["effective_width_m"] = cell.witness["source_width_constraint"]
            cell_metadata[cell.cell_id] = meta
            if (
                metadata_cache_limit is not None
                and len(cell_metadata) > metadata_cache_limit
            ):
                cell_metadata.popitem(last=False)
        cell_metadata.move_to_end(cell.cell_id)
        meta = cell_metadata[cell.cell_id]
        edge = api.EdgeRecord(
            from_id,
            to_id,
            (a, b),
            api.polyline_length_m((a, b)),
            1,
            None,
            None,
            None,
            surface.width_m,
            cell.witness["effective_width_m"],
            None,
            None,
            False,
            True,
            f"gov_sidewalk:{snapshot.version_id}:{surface.source_id}:cell/{cell.cell_id}",
            meta,
        )
        used.update((from_id, to_id))
        gov_edge_count += 2
        edges.extend(
            (
                edge,
                replace(
                    edge, from_osm_node=to_id, to_osm_node=from_id, coordinates=(b, a)
                ),
            )
        )

    for surface_index, surface in enumerate(surfaces):
        # Counts refer to completed sources, including denied sources with no mesh.
        if surface_index and surface_index % 1000 == 0 and hasattr(edges, "flush"):
            print(
                f"[build-ped-graph] stage=surface-mesh-progress sources_completed={surface_index} "
                f"sources_total={len(surfaces)} cells={len(cells)} nodes={len(nodes)} edges={len(edges)}",
                file=sys.stderr,
                flush=True,
            )
        if api.pedestrian_access_is_denied(surface.raw):
            continue
        relevant_barriers = [
            barriers[int(i)] for i in barrier_tree.query(surface.geometry)
        ]
        level, grade_witness = surface_planes[surface.source_id]
        exclusions, negative_witnesses = surface_exclusions(
            surface,
            level,
            [
                negative_observations[int(i)]
                for i in negative_tree.query(surface.geometry)
            ],
        )
        for exclusion, witness in zip(exclusions, negative_witnesses, strict=True):
            if (
                witness["qualification"] == "surface_width_quarantine"
                and witness["kind"] != "road"
            ):
                quarantine = exclusion.intersection(surface.geometry)
                if not quarantine.is_empty:
                    hard_denials.append((quarantine, witness["grade"]))
        effective = (
            surface.geometry.difference(unary_union(exclusions))
            if exclusions
            else surface.geometry
        )
        access_conflicts = [
            denied_surfaces[int(i)]
            for i in denied_tree.query(surface.geometry)
            if compatible_grade(
                surface_planes[denied_surfaces[int(i)].source_id][0], level
            )
        ]
        if access_conflicts:
            effective = effective.difference(
                unary_union([s.geometry for s in access_conflicts])
            )
        # Complete source evidence is shared by all cells and never mutated.
        source_witness = {
            "grade_resolution": grade_witness,
            "road_correspondence": {
                "status": "confirmed"
                if confirmed[surface.source_id]
                else "potential"
                if potential[surface.source_id]
                else "none_observed",
                "confirmed_osm_way_ids": [
                    str(w.osm_id) for w in confirmed[surface.source_id]
                ],
                "potential_osm_way_ids": [
                    str(w.osm_id) for w in potential[surface.source_id]
                ],
            },
            "negative_geometry": negative_witnesses,
            "raw_properties": surface.raw,
            "quality_flags": surface.quality_flags,
            "county": surface.county,
            "barrier_way_ids": [
                str(w.osm_id)
                for w in relevant_barriers
                if compatible_grade(level, grade(w.tags))
                and LineString([(n.lon, n.lat) for n in w.nodes]).intersects(
                    surface.geometry
                )
            ],
            "access": "not_known_denied",
            "excluded_access_source_ids": [s.source_id for s in access_conflicts],
            "width_m": surface.width_m,
            "effective_width_m": surface.effective_width_m,
            "mesh": "constrained-triangle",
        }
        own_clearance = surface_clearance(surface)
        own_evidence = (
            api.attribute_meta(
                own_clearance,
                "gov_sidewalk",
                snapshot.source_batch,
                source_version_id=snapshot.version_id,
                source_id=surface.source_id,
                raw_properties=surface.raw,
                width_m=surface.width_m,
                effective_width_m=surface.effective_width_m,
            )
            if own_clearance is not None
            else None
        )
        for region, governing in width_regions(
            api, surface, effective, level, surfaces, source_tree, surface_planes
        ):
            region_witness = source_witness
            if governing is not None:
                constrained_region_count += 1
                constraint = api.attribute_meta(
                    surface_clearance(governing),
                    "gov_sidewalk",
                    snapshot.source_batch,
                    source_version_id=snapshot.version_id,
                    source_id=governing.source_id,
                    raw_properties=governing.raw,
                    width_m=governing.width_m,
                    effective_width_m=governing.effective_width_m,
                )
                region_witness = {
                    **source_witness,
                    "effective_width_m": surface_clearance(governing),
                    "source_width_constraint": constraint,
                }
            region_width_evidence[id(region_witness)] = region_witness.get(
                "source_width_constraint", own_evidence
            )
            for polygon in sorted(polygon_parts(region), key=lambda p: p.wkb_hex):
                triangles, links = surface_mesh(polygon)
                polygon_cells = []
                for triangle in triangles:
                    cell = SurfaceCell(
                        len(cells) + 1,
                        surface.source_id,
                        triangle,
                        level,
                        region_witness,
                    )
                    cells.append(cell)
                    cell_surfaces.append(surface)
                    polygon_cells.append(cell)
                    mesh_vertex(tuple(triangle.centroid.coords[0]), plane_key(cell))
                by_center = {
                    tuple(c.geometry.centroid.coords[0]): c for c in polygon_cells
                }
                for a, b in links:
                    gov_link(a, b, by_center[a], surface)

    if hasattr(edges, "flush"):
        print(
            f"[build-ped-graph] stage=surface-mesh sources_completed={len(surfaces)} "
            f"cells={len(cells)} nodes={len(nodes)} edges={len(edges)}",
            file=sys.stderr,
            flush=True,
        )
    hard_denial_tree = STRtree([geometry for geometry, _ in hard_denials])
    cell_tree = STRtree([c.geometry for c in cells])
    unproven_contacts = []
    region_ids = {}
    cell_regions = np.fromiter(
        (region_ids.setdefault(id(c.witness), len(region_ids)) for c in cells),
        dtype=np.uint32,
        count=len(cells),
    )
    # Regions of one source also need portals across their attribute boundary.
    for i, cell in enumerate(cells):
        if None in cell.grade:
            continue
        candidates = cell_tree.query(cell.geometry)
        candidates = candidates[
            (candidates > i) & (cell_regions[candidates] != cell_regions[i])
        ]
        for j in candidates:
            j = int(j)
            other = cells[j]
            if other.grade != cell.grade:
                continue
            contact = cell.geometry.intersection(other.geometry)
            if contact.is_empty:
                continue
            portal = shared_surface_portal(cell.geometry, other.geometry, contact)
            if portal is None:
                rejected = {
                    "source_ids": [cell.source_id, other.source_id],
                    "cell_ids": [cell.cell_id, other.cell_id],
                    "reason": "no_verified_common_portal",
                }
                unproven_contacts.append(rejected)
                print(
                    "[build-ped-graph] unproven_inter_source_contact="
                    + json.dumps(rejected, sort_keys=True),
                    file=sys.stderr,
                    flush=True,
                )
                continue
            for index in (i, j):
                member = cells[index]
                gov_link(
                    tuple(member.geometry.centroid.coords[0]),
                    portal,
                    member,
                    cell_surfaces[index],
                )

    observations = [
        (LineString([(n.lon, n.lat) for n in w.nodes]), dict(w.tags))
        for w in ways
        if w.tags.get("footway") == "sidewalk"
    ]
    observation_tree = STRtree([geometry for geometry, _ in observations])
    segments = []
    for way in ways:
        if not api.should_include_way(way.tags):
            continue
        level = grade(way.tags)
        forbidden = road_forbidden_intervals(
            way,
            surfaces,
            source_tree,
            observations,
            observation_tree,
            confirmed,
            surface_planes,
        )
        if 9 <= api.edge_type_for_tags(way.tags) <= 18:
            key = (
                "ordinary_ways_with_sidewalk_association"
                if forbidden
                else "ordinary_ways_without_resolved_sidewalk_association"
            )
            associations[key] += 1
        full_line = LineString([(n.lon, n.lat) for n in way.nodes])
        for left, right in pairwise(way.nodes):
            line = LineString([(left.lon, left.lat), (right.lon, right.lat)])
            if line.length == 0:
                continue
            cuts = {0.0, line.length}
            matches = [
                int(i) for i in cell_tree.query(line) if cells[int(i)].grade == level
            ]
            for i in matches:
                cuts.update(
                    line.project(p)
                    for p in intersection_points(
                        line.intersection(cells[i].geometry.boundary)
                    )
                )
            denied_matches = [
                hard_denials[int(i)][0]
                for i in hard_denial_tree.query(line)
                if compatible_grade(hard_denials[int(i)][1], level)
            ]
            for geometry in denied_matches:
                cuts.update(
                    line.project(p)
                    for p in intersection_points(line.intersection(geometry.boundary))
                )
            for low, high in forbidden:
                for distance in (low, high):
                    p = full_line.interpolate(distance)
                    if line.distance(p) < 1e-12:
                        cuts.add(line.project(p))
            wall_geometries = [
                barrier_geometries[int(i)]
                for i in barrier_tree.query(line.buffer(0.000001))
                if grade(barriers[int(i)].tags) == level
            ]
            forward, reverse = metric_transforms(line)
            wall_exclusion = (
                transform(
                    reverse,
                    unary_union(
                        [transform(forward, wall) for wall in wall_geometries]
                    ).buffer(0.01),
                )
                if wall_geometries
                else None
            )
            if wall_exclusion is not None:
                cuts.update(
                    line.project(p)
                    for p in intersection_points(
                        line.intersection(wall_exclusion.boundary)
                    )
                )
            cuts = sorted(cuts)
            for low, high in pairwise(cuts):
                piece = substring(line, low, high)
                midpoint = piece.interpolate(0.5, normalized=True)
                position = full_line.project(midpoint)
                if (
                    any(a <= position <= b for a, b in forbidden)
                    or any(geometry.covers(midpoint) for geometry in denied_matches)
                    or (wall_exclusion is not None and wall_exclusion.covers(midpoint))
                ):
                    continue
                resolved = []
                for distance in (low, high):
                    point = line.interpolate(distance)
                    coordinate = tuple(point.coords[0])
                    original = (
                        left
                        if distance == 0
                        else right
                        if distance == line.length
                        else None
                    )
                    tags = node_tags.get(original.osm_id, {}) if original else {}
                    if tags.get("barrier") in {
                        "wall",
                        "fence",
                        "block",
                    } or api.pedestrian_access_is_denied(tags):
                        resolved = []
                        break
                    point_level = (
                        shared_levels.get(original.osm_id, level) if original else level
                    )
                    key = (
                        ("osm", original.osm_id, point_level)
                        if original
                        else ("osm-cut", way.osm_id, coordinate, level)
                    )
                    legal_attachment = way.tags.get(
                        "highway"
                    ) not in ORDINARY_HIGHWAYS or (
                        original is not None
                        and (
                            tags.get("highway") == "crossing"
                            or original.osm_id in pedestrian_nodes
                            or tags.get("entrance") not in (None, "no")
                        )
                    )
                    node_id = vertex(
                        key,
                        coordinate,
                        f"osm:node/{original.osm_id}"
                        if original
                        else f"generated:osm-way/{way.osm_id}:surface-intersection",
                        tags,
                        merge_mesh=legal_attachment,
                    )
                    resolved.append(api.WayNode(node_id, *coordinate))
                    endpoint_cells = (
                        matches
                        if point_level == level
                        else [
                            int(i)
                            for i in cell_tree.query(point)
                            if cells[int(i)].grade == point_level
                        ]
                    )
                    for i in endpoint_cells if legal_attachment else ():
                        cell = cells[i]
                        if cell_covers(cell.geometry, point):
                            gov_link(
                                coordinate,
                                tuple(cell.geometry.centroid.coords[0]),
                                cell,
                                cell_surfaces[i],
                                from_id=node_id,
                            )
                if len(resolved) == 2:
                    constraint = None
                    minimum = None
                    for i in matches:
                        cell = cells[i]
                        if not cell_covers(cell.geometry, piece):
                            continue
                        width = min(
                            (
                                v
                                for name in ("width_m", "effective_width_m")
                                if (v := known_width(cell.witness[name])) is not None
                            ),
                            default=None,
                        )
                        if width is not None and (minimum is None or width < minimum):
                            minimum = width
                            constraint = region_width_evidence[id(cell.witness)]
                    if constraint is not None:
                        native_width_evidence_count += 1
                    segments.append(
                        api.Segment(way.osm_id, way.tags, tuple(resolved), constraint)
                    )
    segments = qualify_stair_counts(segments, ways)
    dem, dem_date = api.open_dem_reader(dem_file)
    try:
        osm_edges = api.iter_directed_edges(
            segments, dem_reader=dem, osm_updated_at=updated_at, dem_updated_at=dem_date
        )
        original_way_tags = {f"osm:way/{way.osm_id}": dict(way.tags) for way in ways}
        for edge in osm_edges:
            original_tags = original_way_tags[edge.source_ref]
            edge.attr_meta["osm_tags"] = original_tags
            if edge.edge_type == 6 and original_tags.get("step_count") is not None:
                edge.attr_meta["source_way_step_count"] = api.attribute_meta(
                    api.parse_nonnegative_integer(original_tags["step_count"]),
                    "osm",
                    updated_at,
                    raw_value=original_tags["step_count"],
                    scope="whole-osm-way",
                    segment_count_known=edge.stair_count is not None,
                )
            used.update((edge.from_osm_node, edge.to_osm_node))
            edges.append(edge)
    finally:
        if dem is not None:
            dem.close()
    if not edges:
        raise ValueError("Qualified sidewalk graph is empty")
    if hasattr(edges, "flush"):
        nodes.retain_nodes(used)
    else:
        nodes = {key: node for key, node in nodes.items() if key in used}
    flush = getattr(edges, "flush", None)
    if flush is not None:
        flush()
        print(
            f"[build-ped-graph] stage=edges-complete cells={len(cells)} nodes={len(nodes)} edges={len(edges)}",
            file=sys.stderr,
            flush=True,
        )
    return api.GraphBuild(
        nodes,
        edges,
        gov_edge_count // 2 + len(segments),
        invalid_count,
        gov_edge_count // 2,
        tuple(cells),
        {
            "source_width_policy": {
                "version": "compatible-source-minimum-v1",
                "rules_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            },
            "source_width_constrained_regions": constrained_region_count,
            "native_pieces_with_source_width_evidence": native_width_evidence_count,
            **associations,
            **areas.statistics,
            "source_members_in_extent": len(surfaces),
            "source_members_with_osm_attachment": len(attached_sources),
            "source_members_without_osm_attachment": len(
                {c.source_id for c in cells} - attached_sources
            ),
            "source_members_with_known_access_denial": sum(
                api.pedestrian_access_is_denied(s.raw) for s in surfaces
            ),
            **(
                {"unproven_inter_source_contacts": unproven_contacts}
                if unproven_contacts
                else {}
            ),
        },
    )


def geometry_environment():
    return {"shapely": shapely_version, "geos": geos_version_string}


def qualify_stair_counts(segments, ways):
    original_coordinates = {
        way.osm_id: tuple((node.lon, node.lat) for node in way.nodes) for way in ways
    }
    by_way = {}
    for index, segment in enumerate(segments):
        if segment.tags.get("highway") == "steps":
            by_way.setdefault(segment.osm_way_id, []).append(index)
    for indexes in by_way.values():
        if len(indexes) == 1 and segments[
            indexes[0]
        ].coordinates == original_coordinates.get(segments[indexes[0]].osm_way_id):
            continue
        for index in indexes:
            tags = dict(segments[index].tags)
            if "step_count" in tags:
                tags["original_step_count"] = tags.pop("step_count")
            segments[index] = replace(segments[index], tags=tags)
    return segments


def component_statistics(graph):
    node_ids = graph.nodes
    maximum = max(node_ids, default=0)
    if node_ids and min(node_ids) >= 0 and maximum <= 2 * len(node_ids):
        indexes = array("q", [-1]) * (maximum + 1)
        for index, node in enumerate(node_ids):
            indexes[node] = index
    else:
        indexes = {node: index for index, node in enumerate(node_ids)}
    parents = array("Q", range(len(node_ids)))
    sizes = array("Q", [1]) * len(node_ids)

    def root(index):
        while parents[index] != index:
            parents[index] = parents[parents[index]]
            index = parents[index]
        return index

    endpoints = getattr(graph.edges, "iter_endpoints", None)
    pairs = (
        endpoints()
        if endpoints is not None
        else ((edge.from_osm_node, edge.to_osm_node) for edge in graph.edges)
    )
    count = len(node_ids)
    largest = 1 if node_ids else 0
    for start, end in pairs:
        left, right = root(indexes[start]), root(indexes[end])
        if left == right:
            continue
        if sizes[left] < sizes[right]:
            left, right = right, left
        parents[right] = left
        sizes[left] += sizes[right]
        count -= 1
        largest = max(largest, sizes[left])
    return {
        "weak_component_count": count,
        "largest_component_nodes": largest,
        "surface_cell_count": len(graph.surface_cells),
        "source_member_count": len({cell.source_id for cell in graph.surface_cells}),
    }


def write_cells(cursor, version_id, snapshot_id, cells):
    from psycopg2.extras import execute_values

    cursor.execute(Path(__file__).with_name("migrate-ped-walk-policy.sql").read_text())
    if cells:
        execute_values(
            cursor,
            """INSERT INTO ped_walk_surface_cell
            (version_id,cell_id,sidewalk_source_version_id,source_id,geom,grade,witness)
            VALUES %s""",
            (
                (
                    version_id,
                    cell.cell_id,
                    snapshot_id,
                    cell.source_id,
                    cell.geometry.wkt,
                    json.dumps(cell.grade),
                    json.dumps(cell.witness, ensure_ascii=False),
                )
                for cell in cells
            ),
            template="(%s,%s,%s,%s,ST_GeomFromText(%s,4326),%s::jsonb,%s::jsonb)",
            page_size=1000,
        )
