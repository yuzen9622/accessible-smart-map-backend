#!/usr/bin/env python3
"""Build a versioned Taipei pedestrian graph from an OSM PBF file."""

from __future__ import annotations

import argparse
import copy
import hashlib
import importlib.util
import inspect
import json
import math
import numbers
import os
import random
import re
import sys
from collections import Counter, defaultdict, deque
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from operator import methodcaller
from pathlib import Path
from typing import Any

TAIPEI_BBOX = (121.43, 24.95, 121.68, 25.22)
BBOXES = {"taipei": TAIPEI_BBOX}
INCLUDED_HIGHWAYS = frozenset(
    {
        "footway",
        "path",
        "pedestrian",
        "steps",
        "living_street",
        "track",
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
    }
)
EXPRESSWAY_HIGHWAYS = frozenset({"motorway", "motorway_link"})
DENIED_ACCESS_VALUES = frozenset({"no", "private"})
EXPLICIT_PEDESTRIAN_PERMISSION_VALUES = frozenset({"yes", "designated", "permissive"})
FORWARD_ONEWAY_VALUES = frozenset({"yes", "true", "1"})
REVERSE_ONEWAY_VALUES = frozenset({"-1", "reverse"})
RAMP_VALUES = frozenset({"yes", "designated"})
TRUE_VALUES = frozenset({"yes", "true", "1", "designated"})
FALSE_VALUES = frozenset({"no", "false", "0"})
SIDEWALK_TOLERANCE_M = 10.0
CONNECTIVITY_SAMPLE_SIZE = 100
CONNECTIVITY_MIN_DISTANCE_M = 300.0
CONNECTIVITY_MAX_DISTANCE_M = 3000.0
CONNECTIVITY_SEED = 20260820
NODE_ID_SCALE = 1_000_000_000_000
EDGE_ID_SCALE = 1_000_000_000_000

EDGE_TYPE_CODES = {
    "path": 4,
    "pedestrian": 5,
    "steps": 6,
    "living_street": 7,
    "track": 8,
    "road": 9,
    "residential": 10,
    "service": 11,
    "unclassified": 12,
    "tertiary": 13,
    "tertiary_link": 14,
    "secondary": 15,
    "secondary_link": 16,
    "primary": 17,
    "primary_link": 18,
    "elevator": 19,
}
# Explicitly permitted cycleways use the existing path-like edge type rather than
# falling through to the unknown-edge code.
CYCLEWAY_EDGE_TYPE = EDGE_TYPE_CODES["path"]
SURFACE_CODES = {
    "asphalt": 1,
    "concrete": 2,
    "concrete:lanes": 3,
    "concrete:plates": 4,
    "paving_stones": 5,
    "sett": 6,
    "unhewn_cobblestone": 7,
    "cobblestone": 8,
    "bricks": 9,
    "tiles": 10,
    "metal": 11,
    "wood": 12,
    "rubber": 13,
    "plastic": 14,
    "grass_paver": 15,
    "compacted": 16,
    "fine_gravel": 17,
    "gravel": 18,
    "pebblestone": 19,
    "rock": 20,
    "dirt": 21,
    "earth": 22,
    "ground": 23,
    "mud": 24,
    "sand": 25,
    "grass": 26,
    "clay": 27,
    "unpaved": 28,
    "paved": 29,
    "soil": 30,
    "chippings": 31,
    "shells": 32,
    "artificial_turf": 33,
    "tartan": 34,
    "ice": 35,
    "snow": 36,
    "woodchips": 37,
    "mulch": 38,
    "leaves": 39,
}
SMOOTHNESS_CODES = {
    "excellent": 1,
    "good": 2,
    "intermediate": 3,
    "bad": 4,
    "very_bad": 5,
    "horrible": 6,
    "very_horrible": 7,
    "impassable": 8,
}
WHEELCHAIR_CODES = {
    "yes": 1,
    "designated": 2,
    "limited": 3,
    "no": 4,
}
KERB_CODES = {
    "flush": 1,
    "lowered": 2,
    "raised": 3,
    "rolled": 4,
    "sloped": 5,
    "yes": 6,
    "no": 7,
    "at_grade": 8,
    "dropped": 9,
    "regular": 10,
    "normal": 11,
    "low": 12,
    "none": 13,
    "flush_and_lowered": 14,
    "lowered_and_sloped": 15,
}


@dataclass(frozen=True)
class WayNode:
    """One referenced OSM node with its resolved WGS84 coordinate."""

    osm_id: int
    lon: float
    lat: float


@dataclass(frozen=True)
class WalkWay:
    """An eligible OSM way whose geometry intersects the requested bbox."""

    osm_id: int
    tags: Mapping[str, str]
    nodes: tuple[WayNode, ...]


@dataclass(frozen=True)
class Segment:
    """One undirected OSM-way segment between graph vertices."""

    osm_way_id: int
    tags: Mapping[str, str]
    nodes: tuple[WayNode, ...]

    @property
    def from_osm_node(self) -> int:
        """Return the raw OSM identifier at the segment's first endpoint."""
        return self.nodes[0].osm_id

    @property
    def to_osm_node(self) -> int:
        """Return the raw OSM identifier at the segment's final endpoint."""
        return self.nodes[-1].osm_id

    @property
    def coordinates(self) -> tuple[tuple[float, float], ...]:
        """Return the segment polyline as ordered longitude-latitude pairs."""
        return tuple((node.lon, node.lat) for node in self.nodes)


@dataclass(frozen=True)
class SidewalkRecord:
    """One government sidewalk polygon and its attribute provenance."""

    source_id: str
    width_m: float | None
    effective_width_m: float | None
    direction: str | None
    ramp_count: float | None
    updated_at: str
    metric_geometry: Any


@dataclass(frozen=True)
class SidewalkMatch:
    """The highest-overlap government sidewalk polygon matched to one segment."""

    source_id: str
    width_m: float | None
    effective_width_m: float | None
    direction: str | None
    ramp_count: float | None
    updated_at: str
    overlap_m: float
    distance_m: float


@dataclass
class SidewalkIndex:
    """An STRtree plus the sidewalk records stored in tree insertion order."""

    records: list[SidewalkRecord]
    tree: Any
    geometry_indexes: dict[int, int]


@dataclass(frozen=True)
class NodeRecord:
    """One graph vertex with values ready for PostGIS serialization."""

    osm_node_id: int
    lon: float
    lat: float
    node_type: int
    kerb: int | None
    tactile_paving: bool | None
    traffic_signal: bool | None
    audible_signal: bool | None
    source_ref: str
    attr_meta: dict[str, dict[str, Any]]


@dataclass(frozen=True)
class EdgeRecord:
    """One directed graph edge with values ready for PostGIS serialization."""

    from_osm_node: int
    to_osm_node: int
    coordinates: tuple[tuple[float, float], ...]
    length_m: float
    edge_type: int
    slope_longitudinal: float | None
    surface: int | None
    smoothness: int | None
    width_m: float | None
    effective_width_m: float | None
    wheelchair: int | None
    stair_count: int | None
    has_ramp: bool
    is_bidirectional: bool
    source_ref: str
    attr_meta: dict[str, dict[str, Any]]


@dataclass(frozen=True)
class GraphBuild:
    """The in-memory result of extracting and enriching a pedestrian graph."""

    nodes: dict[int, NodeRecord]
    edges: list[EdgeRecord]
    undirected_segment_count: int
    invalid_way_location_count: int
    sidewalk_matched_segment_count: int


def load_local_module(module_name: str, filename: str) -> Any:
    """Load a sibling script whose hyphenated filename is not importable normally."""
    path = Path(__file__).resolve().with_name(filename)
    spec = importlib.util.spec_from_file_location(module_name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load helper script: {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


DENY_FOOT_HELPER = load_local_module(
    "ped_graph_deny_foot_on_expressways", "deny-foot-on-expressways.py"
)
DEM_HELPER = load_local_module("ped_graph_dem_helper", "inject-osm-dem-slopes.py")


def normalized_tag(value: Any) -> str | None:
    """Return a lower-case tag value, or None when the source value is blank."""
    if value is None:
        return None
    text = str(value).strip().lower()
    return text or None


def attribute_meta(
    value: Any,
    source: str,
    updated_at: str,
    confidence: float = 1.0,
    **extra: Any,
) -> dict[str, Any]:
    """Build the source-aware JSON shape required by ped_edge.attr_meta."""
    result: dict[str, Any] = {
        "value": value,
        "source": source,
        "confidence": confidence,
        "updated_at": updated_at,
    }
    result.update(extra)
    return result


def enum_code(value: Any, mapping: Mapping[str, int]) -> int | None:
    """Map a tagged enum to its schema code, preserving unknown concrete values as 255."""
    normalized = normalized_tag(value)
    if normalized is None:
        return None
    return mapping.get(normalized, 255)


def edge_type_for_tags(tags: Mapping[str, str]) -> int:
    """Map highway and footway tags to the ped_edge edge_type code."""
    highway = normalized_tag(tags.get("highway"))
    if highway == "footway":
        footway = normalized_tag(tags.get("footway"))
        if footway == "sidewalk":
            return 1
        if footway == "crossing":
            return 3
        return 2
    if highway == "crossing":
        return 3
    if highway == "cycleway":
        return CYCLEWAY_EDGE_TYPE
    return EDGE_TYPE_CODES.get(highway or "", 255)


def parse_measurement_m(value: Any) -> float | None:
    """Parse a simple OSM width value into metres without treating invalid data as zero."""
    if value is None:
        return None
    match = re.search(
        r"([-+]?\d+(?:[.,]\d+)?)\s*(cm|centimet(?:er|re)s?|m|met(?:er|re)s?|ft|feet)?",
        str(value).strip(),
        flags=re.IGNORECASE,
    )
    if not match:
        return None
    try:
        number = float(match.group(1).replace(",", "."))
    except ValueError:
        return None
    unit = (match.group(2) or "m").lower()
    if unit.startswith(("cm", "centimet")):
        return number / 100.0
    if unit in {"ft", "feet"}:
        return number * 0.3048
    return number


def finite_float(value: Any) -> float | None:
    """Return a finite float without allowing malformed external values to escape."""
    try:
        parsed = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return parsed if math.isfinite(parsed) else None


def safe_int(value: Any) -> int | None:
    """Return an integer external identifier or count without propagating conversion errors."""
    try:
        return int(value)
    except (TypeError, ValueError, OverflowError):
        return None


def parse_nonnegative_number(value: Any) -> float | None:
    """Return a nonnegative finite source number, or None for absent or invalid input."""
    if value is None or str(value).strip() == "":
        return None
    parsed = finite_float(value)
    if parsed is None or parsed < 0:
        return None
    return parsed


def parse_nonnegative_integer(value: Any) -> int | None:
    """Return a nonnegative integer OSM count, or None when no exact count is supplied."""
    parsed = parse_nonnegative_number(value)
    if parsed is None or not parsed.is_integer():
        return None
    return safe_int(parsed)


def is_true_tag(value: Any) -> bool:
    """Return whether an OSM tag carries one of the affirmative values."""
    return normalized_tag(value) in TRUE_VALUES


def bool_tag(value: Any) -> bool | None:
    """Map an OSM yes/no-like tag to Boolean without guessing unknown values."""
    normalized = normalized_tag(value)
    if normalized in TRUE_VALUES:
        return True
    if normalized in FALSE_VALUES:
        return False
    return None


def pedestrian_access_is_denied(tags: Mapping[str, str]) -> bool:
    """Apply the shared denial and expressway-hardening checks for pedestrian access."""
    if normalized_tag(tags.get("foot")) in DENIED_ACCESS_VALUES:
        return True
    if normalized_tag(tags.get("access")) in DENIED_ACCESS_VALUES:
        return True
    hardened_tags, _ = DENY_FOOT_HELPER.rewritten_tags(tags)
    return normalized_tag(hardened_tags.get("foot")) in DENIED_ACCESS_VALUES


def has_explicit_pedestrian_permission(tags: Mapping[str, str]) -> bool:
    """Return whether a way explicitly grants pedestrian access under the cycleway policy."""
    highway = normalized_tag(tags.get("highway"))
    if highway in EXPRESSWAY_HIGHWAYS or pedestrian_access_is_denied(tags):
        return False
    return normalized_tag(tags.get("foot")) in EXPLICIT_PEDESTRIAN_PERMISSION_VALUES


def should_include_way(tags: Mapping[str, str]) -> bool:
    """Apply WP-2's walking-way eligibility rules using the shared expressway hardener."""
    highway = normalized_tag(tags.get("highway"))
    if highway == "cycleway":
        return has_explicit_pedestrian_permission(tags)
    if highway in EXPRESSWAY_HIGHWAYS or pedestrian_access_is_denied(tags):
        return False
    return highway in INCLUDED_HIGHWAYS


def pedestrian_oneway_direction(tags: Mapping[str, str]) -> int:
    """Return 1, -1, or 0 for explicit pedestrian one-way travel only."""
    if normalized_tag(tags.get("highway")) == "steps":
        return 0
    oneway_foot = normalized_tag(tags.get("oneway:foot"))
    if oneway_foot in FORWARD_ONEWAY_VALUES:
        return 1
    if oneway_foot in REVERSE_ONEWAY_VALUES:
        return -1
    return 0


def haversine_m(start: tuple[float, float], end: tuple[float, float]) -> float:
    """Return the great-circle distance between WGS84 longitude-latitude coordinates."""
    lon1, lat1 = start
    lon2, lat2 = end
    radius_m = 6_371_000.0
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    delta_phi = math.radians(lat2 - lat1)
    delta_lambda = math.radians(lon2 - lon1)
    value = (
        math.sin(delta_phi / 2.0) ** 2
        + math.cos(phi1) * math.cos(phi2) * math.sin(delta_lambda / 2.0) ** 2
    )
    return radius_m * 2.0 * math.atan2(math.sqrt(value), math.sqrt(1.0 - value))


def polyline_length_m(coordinates: Sequence[tuple[float, float]]) -> float:
    """Return the accumulated haversine length of every segment in a polyline."""
    return sum(
        haversine_m(start, end)
        for start, end in zip(coordinates, coordinates[1:], strict=False)
    )


def point_in_bbox(
    point: tuple[float, float], bbox: tuple[float, float, float, float]
) -> bool:
    """Return whether a WGS84 point lies inside an inclusive west-south-east-north bbox."""
    lon, lat = point
    west, south, east, north = bbox
    return west <= lon <= east and south <= lat <= north


def segment_intersects_bbox(
    start: tuple[float, float],
    end: tuple[float, float],
    bbox: tuple[float, float, float, float],
) -> bool:
    """Return whether a straight segment intersects an inclusive axis-aligned bbox."""
    if point_in_bbox(start, bbox) or point_in_bbox(end, bbox):
        return True
    west, south, east, north = bbox
    delta_lon = end[0] - start[0]
    delta_lat = end[1] - start[1]
    bounds = (
        (-delta_lon, start[0] - west),
        (delta_lon, east - start[0]),
        (-delta_lat, start[1] - south),
        (delta_lat, north - start[1]),
    )
    lower, upper = 0.0, 1.0
    for coefficient, value in bounds:
        if coefficient == 0.0:
            if value < 0.0:
                return False
            continue
        ratio = value / coefficient
        if coefficient < 0.0:
            if ratio > upper:
                return False
            lower = max(lower, ratio)
        else:
            if ratio < lower:
                return False
            upper = min(upper, ratio)
    return lower <= upper


def polyline_intersects_bbox(
    coordinates: Sequence[tuple[float, float]],
    bbox: tuple[float, float, float, float],
) -> bool:
    """Return whether any polyline segment intersects the requested geographic bbox."""
    return any(
        segment_intersects_bbox(start, end, bbox)
        for start, end in zip(coordinates, coordinates[1:], strict=False)
    )


def count_way_node_references(ways: Sequence[WalkWay]) -> Counter[int]:
    """Count each OSM node once per eligible way, as required for intersection cuts."""
    counts: Counter[int] = Counter()
    for way in ways:
        counts.update({node.osm_id for node in way.nodes})
    return counts


def split_way_into_segments(
    way: WalkWay, reference_counts: Mapping[int, int]
) -> list[Segment]:
    """Cut one way at its endpoints and at nodes shared by at least two eligible ways."""
    if len(way.nodes) < 2:
        return []
    cut_indexes = {0, len(way.nodes) - 1}
    cut_indexes.update(
        index
        for index, node in enumerate(way.nodes)
        if reference_counts.get(node.osm_id, 0) >= 2
    )
    ordered_cuts = sorted(cut_indexes)
    segments: list[Segment] = []
    for start_index, end_index in zip(ordered_cuts, ordered_cuts[1:], strict=False):
        nodes = way.nodes[start_index : end_index + 1]
        if (
            len(nodes) >= 2
            and polyline_length_m(tuple((node.lon, node.lat) for node in nodes)) > 0.0
        ):
            segments.append(Segment(way.osm_id, way.tags, nodes))
    return segments


def source_updated_at(path: Path) -> str:
    """Return the UTC calendar date of an input file for provenance metadata."""
    return (
        datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc).date().isoformat()
    )


def sidewalk_source_version(path: Path) -> str:
    """Extract a YYYYMM data version from a sidewalk filename, falling back to its file date."""
    match = re.search(r"(?<!\d)(20\d{4})(?!\d)", path.name)
    return match.group(1) if match else source_updated_at(path)


def local_metric_transformer() -> Any:
    """Return a local equirectangular transform accurate enough for Taipei's 10 m overlay."""
    center_lon = (TAIPEI_BBOX[0] + TAIPEI_BBOX[2]) / 2.0
    center_lat = (TAIPEI_BBOX[1] + TAIPEI_BBOX[3]) / 2.0
    metres_per_lon = 111_320.0 * math.cos(math.radians(center_lat))
    metres_per_lat = 110_540.0

    def transform(longitude: Any, latitude: Any, z: Any = None) -> tuple[Any, Any]:
        return (
            (longitude - center_lon) * metres_per_lon,
            (latitude - center_lat) * metres_per_lat,
        )

    return transform


def build_sidewalk_index(path: Path) -> SidewalkIndex:
    """Load government sidewalk polygons into an STRtree using a local metre coordinate system."""
    try:
        from shapely import make_valid
        from shapely.geometry import shape
        from shapely.ops import transform
        from shapely.strtree import STRtree
    except ImportError as error:
        raise SystemExit(
            "shapely is required for government sidewalk overlay"
        ) from error

    try:
        with path.open(encoding="utf-8-sig") as handle:
            payload = json.load(handle)
    except (OSError, json.JSONDecodeError) as error:
        raise SystemExit(f"Unable to read sidewalk GeoJSON {path}: {error}") from error
    transformer = local_metric_transformer()
    records: list[SidewalkRecord] = []
    for index, feature in enumerate(payload.get("features", []), start=1):
        geometry = feature.get("geometry")
        if not geometry:
            continue
        try:
            metric_geometry = transform(transformer, shape(geometry))
        except (TypeError, ValueError) as error:
            print(
                f"[build-ped-graph] skipping invalid sidewalk geometry {index}: {error}"
            )
            continue
        if not metric_geometry.is_valid:
            try:
                metric_geometry = make_valid(metric_geometry)
            except (TypeError, ValueError) as error:
                print(
                    f"[build-ped-graph] skipping unrepairable sidewalk geometry {index}: {error}"
                )
                continue
        if metric_geometry.is_empty or not metric_geometry.is_valid:
            print(f"[build-ped-graph] skipping invalid sidewalk geometry {index}")
            continue
        properties = feature.get("properties") or {}
        source_id = str(
            feature.get("id") or properties.get("OBJECTID") or f"sidewalk:{index}"
        )
        records.append(
            SidewalkRecord(
                source_id=source_id,
                width_m=parse_nonnegative_number(properties.get("SW_WTH")),
                effective_width_m=parse_nonnegative_number(properties.get("SWW_WTH")),
                direction=(
                    str(properties["SW_DIRECT"])
                    if properties.get("SW_DIRECT") not in (None, "")
                    else None
                ),
                ramp_count=parse_nonnegative_number(properties.get("SW_RAMP")),
                updated_at=sidewalk_source_version(path),
                metric_geometry=metric_geometry,
            )
        )
    if not records:
        raise SystemExit(f"No valid sidewalk polygons found in {path}")
    geometries = [record.metric_geometry for record in records]
    return SidewalkIndex(
        records=records,
        tree=STRtree(geometries),
        geometry_indexes={
            id(geometry): index for index, geometry in enumerate(geometries)
        },
    )


def sidewalk_record_for_candidate(
    sidewalk_index: SidewalkIndex, candidate: Any
) -> SidewalkRecord | None:
    """Resolve Shapely 1 geometry or Shapely 2 integer STRtree query output to a record."""
    if isinstance(candidate, numbers.Integral):
        index = safe_int(candidate)
        if index is None or not 0 <= index < len(sidewalk_index.records):
            return None
        return sidewalk_index.records[index]
    index = sidewalk_index.geometry_indexes.get(id(candidate))
    if index is not None:
        return sidewalk_index.records[index]
    for record in sidewalk_index.records:
        if record.metric_geometry.equals(candidate):
            return record
    return None


def match_sidewalk_to_coordinates(
    coordinates: Sequence[tuple[float, float]], sidewalk_index: SidewalkIndex
) -> SidewalkMatch | None:
    """Attach a segment to its highest-overlap sidewalk polygon within ten metres."""
    try:
        from shapely.geometry import LineString
    except ImportError as error:
        raise SystemExit(
            "shapely is required for government sidewalk overlay"
        ) from error
    if len(coordinates) < 2:
        return None
    transformer = local_metric_transformer()
    metric_coordinates = [transformer(lon, lat) for lon, lat in coordinates]
    line = LineString(metric_coordinates)
    if line.is_empty or line.length == 0.0:
        return None
    best: tuple[tuple[int, float, float, str], SidewalkMatch] | None = None
    query_candidates = methodcaller("query", line.buffer(SIDEWALK_TOLERANCE_M))
    for candidate in query_candidates(sidewalk_index.tree):
        record = sidewalk_record_for_candidate(sidewalk_index, candidate)
        if record is None:
            continue
        distance_m = finite_float(line.distance(record.metric_geometry))
        if distance_m is None or distance_m > SIDEWALK_TOLERANCE_M:
            continue
        overlap_m = finite_float(line.intersection(record.metric_geometry).length)
        if overlap_m is None:
            continue
        match = SidewalkMatch(
            source_id=record.source_id,
            width_m=record.width_m,
            effective_width_m=record.effective_width_m,
            direction=record.direction,
            ramp_count=record.ramp_count,
            updated_at=record.updated_at,
            overlap_m=overlap_m,
            distance_m=distance_m,
        )
        score = (
            1 if overlap_m > 0.0 else 0,
            overlap_m,
            -distance_m,
            record.source_id,
        )
        if best is None or score > best[0]:
            best = (score, match)
    return best[1] if best else None


def make_edge_attributes(
    tags: Mapping[str, str], osm_updated_at: str, sidewalk_match: SidewalkMatch | None
) -> dict[str, Any]:
    """Extract OSM and matched government attributes for one undirected segment."""
    surface = enum_code(tags.get("surface"), SURFACE_CODES)
    smoothness = enum_code(tags.get("smoothness"), SMOOTHNESS_CODES)
    wheelchair = enum_code(tags.get("wheelchair"), WHEELCHAIR_CODES)
    width_m = parse_measurement_m(tags.get("width"))
    effective_width_m: float | None = None
    has_ramp = (
        normalized_tag(tags.get("ramp")) in RAMP_VALUES
        or normalized_tag(tags.get("ramp:wheelchair")) in RAMP_VALUES
    )
    stair_count = parse_nonnegative_integer(tags.get("step_count"))
    edge_type = edge_type_for_tags(tags)
    meta: dict[str, dict[str, Any]] = {
        "edge_type": attribute_meta(
            edge_type,
            "osm",
            osm_updated_at,
            raw_highway=tags.get("highway"),
            raw_footway=tags.get("footway"),
        )
    }
    for name, raw_value, code in (
        ("surface", tags.get("surface"), surface),
        ("smoothness", tags.get("smoothness"), smoothness),
        ("wheelchair", tags.get("wheelchair"), wheelchair),
    ):
        if raw_value is not None:
            meta[name] = attribute_meta(raw_value, "osm", osm_updated_at, code=code)
    if tags.get("width") is not None:
        meta["width_m"] = attribute_meta(
            width_m, "osm", osm_updated_at, raw_value=tags.get("width")
        )
    if tags.get("step_count") is not None:
        meta["stair_count"] = attribute_meta(
            stair_count, "osm", osm_updated_at, raw_value=tags.get("step_count")
        )
    if tags.get("ramp") is not None or tags.get("ramp:wheelchair") is not None:
        meta["has_ramp"] = attribute_meta(
            has_ramp,
            "osm",
            osm_updated_at,
            ramp=tags.get("ramp"),
            ramp_wheelchair=tags.get("ramp:wheelchair"),
        )
    if sidewalk_match is not None:
        if sidewalk_match.width_m is not None:
            width_m = sidewalk_match.width_m
            meta["width_m"] = attribute_meta(
                width_m,
                "gov_sidewalk",
                sidewalk_match.updated_at,
                source_id=sidewalk_match.source_id,
            )
        if sidewalk_match.effective_width_m is not None:
            effective_width_m = sidewalk_match.effective_width_m
            meta["effective_width_m"] = attribute_meta(
                effective_width_m,
                "gov_sidewalk",
                sidewalk_match.updated_at,
                source_id=sidewalk_match.source_id,
            )
        meta["gov_sidewalk_source_id"] = attribute_meta(
            sidewalk_match.source_id,
            "gov_sidewalk",
            sidewalk_match.updated_at,
            overlap_m=round(sidewalk_match.overlap_m, 3),
            distance_m=round(sidewalk_match.distance_m, 3),
        )
        if sidewalk_match.direction is not None:
            meta["sidewalk_direction"] = attribute_meta(
                sidewalk_match.direction,
                "gov_sidewalk",
                sidewalk_match.updated_at,
                source_id=sidewalk_match.source_id,
            )
        if sidewalk_match.ramp_count is not None:
            meta["sidewalk_ramp_count"] = attribute_meta(
                sidewalk_match.ramp_count,
                "gov_sidewalk",
                sidewalk_match.updated_at,
                source_id=sidewalk_match.source_id,
            )
    return {
        "edge_type": edge_type,
        "surface": surface,
        "smoothness": smoothness,
        "width_m": width_m,
        "effective_width_m": effective_width_m,
        "wheelchair": wheelchair,
        "stair_count": stair_count,
        "has_ramp": has_ramp,
        "attr_meta": meta,
    }


def slope_for_coordinates(
    coordinates: Sequence[tuple[float, float]], length_m: float, dem_reader: Any
) -> float | None:
    """Sample endpoint elevations through the existing DEM reader and return directed slope."""
    if dem_reader is None or length_m <= 0.0 or len(coordinates) < 2:
        return None
    start_lon, start_lat = coordinates[0]
    end_lon, end_lat = coordinates[-1]
    try:
        start_elevation = dem_reader.get_elevation(start_lon, start_lat)
        end_elevation = dem_reader.get_elevation(end_lon, end_lat)
    except Exception:
        return None
    if start_elevation is None or end_elevation is None:
        return None
    start_value = finite_float(start_elevation)
    end_value = finite_float(end_elevation)
    if start_value is None or end_value is None:
        return None
    return (end_value - start_value) / length_m


def edge_record_for_direction(
    segment: Segment,
    attributes: Mapping[str, Any],
    reverse: bool,
    is_bidirectional: bool,
    dem_reader: Any,
    dem_updated_at: str | None,
) -> EdgeRecord:
    """Build one forward or reverse directed edge from an enriched undirected segment."""
    coordinates = segment.coordinates
    if reverse:
        coordinates = tuple(reversed(coordinates))
    length_m = polyline_length_m(coordinates)
    attr_meta = copy.deepcopy(attributes["attr_meta"])
    slope_longitudinal = slope_for_coordinates(coordinates, length_m, dem_reader)
    if slope_longitudinal is not None and dem_updated_at is not None:
        attr_meta["slope_longitudinal"] = attribute_meta(
            slope_longitudinal, "dem", dem_updated_at
        )
    return EdgeRecord(
        from_osm_node=segment.to_osm_node if reverse else segment.from_osm_node,
        to_osm_node=segment.from_osm_node if reverse else segment.to_osm_node,
        coordinates=coordinates,
        length_m=length_m,
        edge_type=attributes["edge_type"],
        slope_longitudinal=slope_longitudinal,
        surface=attributes["surface"],
        smoothness=attributes["smoothness"],
        width_m=attributes["width_m"],
        effective_width_m=attributes["effective_width_m"],
        wheelchair=attributes["wheelchair"],
        stair_count=attributes["stair_count"],
        has_ramp=attributes["has_ramp"],
        is_bidirectional=is_bidirectional,
        source_ref=f"osm:way/{segment.osm_way_id}",
        attr_meta=attr_meta,
    )


def build_directed_edges(
    segments: Sequence[Segment],
    sidewalk_matches: Sequence[SidewalkMatch | None] | None = None,
    dem_reader: Any = None,
    osm_updated_at: str = "1970-01-01",
    dem_updated_at: str | None = None,
) -> list[EdgeRecord]:
    """Turn segmented ways into pedestrian-directed edges with all edge attributes."""
    if sidewalk_matches is None:
        sidewalk_matches = [None] * len(segments)
    if len(sidewalk_matches) != len(segments):
        raise ValueError("Each segment requires exactly one sidewalk match slot")
    edges: list[EdgeRecord] = []
    for segment, sidewalk_match in zip(segments, sidewalk_matches, strict=False):
        attributes = make_edge_attributes(segment.tags, osm_updated_at, sidewalk_match)
        direction = pedestrian_oneway_direction(segment.tags)
        if direction == -1:
            edges.append(
                edge_record_for_direction(
                    segment,
                    attributes,
                    reverse=True,
                    is_bidirectional=False,
                    dem_reader=dem_reader,
                    dem_updated_at=dem_updated_at,
                )
            )
        elif direction == 1:
            edges.append(
                edge_record_for_direction(
                    segment,
                    attributes,
                    reverse=False,
                    is_bidirectional=False,
                    dem_reader=dem_reader,
                    dem_updated_at=dem_updated_at,
                )
            )
        else:
            edges.append(
                edge_record_for_direction(
                    segment,
                    attributes,
                    reverse=False,
                    is_bidirectional=True,
                    dem_reader=dem_reader,
                    dem_updated_at=dem_updated_at,
                )
            )
            edges.append(
                edge_record_for_direction(
                    segment,
                    attributes,
                    reverse=True,
                    is_bidirectional=True,
                    dem_reader=dem_reader,
                    dem_updated_at=dem_updated_at,
                )
            )
    return edges


def node_type_for(
    tags: Mapping[str, str], reference_count: int, is_stairs_endpoint: bool
) -> int:
    """Classify a retained OSM graph vertex using the schema's applicable-role precedence."""
    if normalized_tag(tags.get("highway")) == "elevator":
        return 5
    if tags.get("entrance") is not None:
        return 4
    if (
        normalized_tag(tags.get("highway")) == "crossing"
        or tags.get("crossing") is not None
    ):
        return 3
    if is_stairs_endpoint:
        return 6
    if reference_count >= 2:
        return 2
    return 1


def node_signal_values(tags: Mapping[str, str]) -> tuple[bool | None, bool | None]:
    """Extract known traffic and audible signal facts from OSM node tags."""
    traffic_signal: bool | None = None
    if normalized_tag(tags.get("highway")) == "traffic_signals":
        traffic_signal = True
    for name in ("traffic_signals", "crossing:signals"):
        value = bool_tag(tags.get(name))
        if value is not None:
            traffic_signal = value
    audible_values = [
        bool_tag(tags.get(name))
        for name in (
            "traffic_signals:sound",
            "traffic_signals:vibration",
            "audible_signals",
        )
        if tags.get(name) is not None
    ]
    audible_signal = (
        True if True in audible_values else False if False in audible_values else None
    )
    return traffic_signal, audible_signal


def build_node_records(
    segments: Sequence[Segment],
    reference_counts: Mapping[int, int],
    node_tags: Mapping[int, Mapping[str, str]],
    osm_updated_at: str,
) -> dict[int, NodeRecord]:
    """Construct the retained endpoint nodes with graph roles and source-aware attributes."""
    endpoints: dict[int, WayNode] = {}
    stairs_endpoints: set[int] = set()
    for segment in segments:
        endpoints.setdefault(segment.from_osm_node, segment.nodes[0])
        endpoints.setdefault(segment.to_osm_node, segment.nodes[-1])
        if normalized_tag(segment.tags.get("highway")) == "steps":
            stairs_endpoints.add(segment.from_osm_node)
            stairs_endpoints.add(segment.to_osm_node)
    records: dict[int, NodeRecord] = {}
    for osm_node_id, node in endpoints.items():
        tags = node_tags.get(osm_node_id, {})
        kerb = enum_code(tags.get("kerb"), KERB_CODES)
        tactile_paving = bool_tag(tags.get("tactile_paving"))
        traffic_signal, audible_signal = node_signal_values(tags)
        node_type = node_type_for(
            tags,
            reference_counts.get(osm_node_id, 0),
            osm_node_id in stairs_endpoints,
        )
        meta: dict[str, dict[str, Any]] = {
            "node_type": attribute_meta(node_type, "osm", osm_updated_at)
        }
        if tags.get("kerb") is not None:
            meta["kerb"] = attribute_meta(
                tags.get("kerb"), "osm", osm_updated_at, code=kerb
            )
        if tags.get("tactile_paving") is not None:
            meta["tactile_paving"] = attribute_meta(
                tactile_paving,
                "osm",
                osm_updated_at,
                raw_value=tags.get("tactile_paving"),
            )
        if traffic_signal is not None:
            meta["traffic_signal"] = attribute_meta(
                traffic_signal, "osm", osm_updated_at
            )
        if audible_signal is not None:
            meta["audible_signal"] = attribute_meta(
                audible_signal, "osm", osm_updated_at
            )
        records[osm_node_id] = NodeRecord(
            osm_node_id=osm_node_id,
            lon=node.lon,
            lat=node.lat,
            node_type=node_type,
            kerb=kerb,
            tactile_paving=tactile_paving,
            traffic_signal=traffic_signal,
            audible_signal=audible_signal,
            source_ref=f"osm:node/{osm_node_id}",
            attr_meta=meta,
        )
    return records


def import_osmium() -> Any:
    """Import pyosmium only for PBF work so pure-function tests remain dependency-light."""
    try:
        import osmium
    except ImportError as error:
        raise SystemExit(
            "pyosmium is required to build the pedestrian graph"
        ) from error
    return osmium


def apply_with_locations(osmium: Any, handler: Any, pbf_path: Path) -> None:
    """Apply a pyosmium handler with coordinate resolution on both supported API generations."""
    apply_file = getattr(handler, "apply_file", None)
    if apply_file is not None:
        try:
            parameters = inspect.signature(apply_file).parameters
        except (TypeError, ValueError):
            parameters = {}
        if "idx" in parameters:
            apply_file(str(pbf_path), locations=True, idx="sparse_mem_array")
            return
        try:
            apply_file(str(pbf_path), locations=True)
            return
        except TypeError as error:
            print(
                "[build-ped-graph] pyosmium apply_file lacks the modern "
                f"locations overload; using compatibility fallback: {error}"
            )
    if not all(
        hasattr(osmium, attribute)
        for attribute in ("NodeLocationsForWays", "apply", "index")
    ):
        raise SystemExit("This pyosmium build cannot provide node locations for ways")
    reader = osmium.io.Reader(str(pbf_path))
    location_store = osmium.index.create_map("sparse_mem_array")
    location_handler = osmium.NodeLocationsForWays(location_store)
    try:
        osmium.apply(reader, location_handler, handler)
    finally:
        reader.close()


def collect_walk_ways(
    pbf_path: Path, bbox: tuple[float, float, float, float]
) -> tuple[list[WalkWay], int]:
    """Read eligible OSM ways with resolved geometry intersecting the requested city bbox."""
    osmium = import_osmium()

    class WayCollector(osmium.SimpleHandler):
        def __init__(self) -> None:
            super().__init__()
            self.ways: list[WalkWay] = []
            self.invalid_location_count = 0

        def way(self, way: Any) -> None:
            tags = dict(way.tags)
            if not should_include_way(tags):
                return
            resolved_nodes_list: list[WayNode] = []
            try:
                for node in way.nodes:
                    osm_node_id = safe_int(node.ref)
                    longitude = finite_float(node.location.lon)
                    latitude = finite_float(node.location.lat)
                    if osm_node_id is None or longitude is None or latitude is None:
                        self.invalid_location_count += 1
                        return
                    resolved_nodes_list.append(
                        WayNode(osm_node_id, longitude, latitude)
                    )
                way_id = safe_int(way.id)
            except (AttributeError, TypeError, ValueError):
                self.invalid_location_count += 1
                return
            if way_id is None:
                self.invalid_location_count += 1
                return
            resolved_nodes = tuple(resolved_nodes_list)
            coordinates = tuple((node.lon, node.lat) for node in resolved_nodes)
            if len(resolved_nodes) < 2 or not polyline_intersects_bbox(
                coordinates, bbox
            ):
                return
            self.ways.append(WalkWay(way_id, tags, resolved_nodes))

    collector = WayCollector()
    apply_with_locations(osmium, collector, pbf_path)
    collector.ways.sort(key=lambda way: way.osm_id)
    return collector.ways, collector.invalid_location_count


def collect_node_tags(
    pbf_path: Path, node_ids: set[int]
) -> dict[int, Mapping[str, str]]:
    """Read tags only for retained graph endpoints during a second low-memory PBF pass."""
    osmium = import_osmium()

    class NodeCollector(osmium.SimpleHandler):
        def __init__(self) -> None:
            super().__init__()
            self.tags: dict[int, Mapping[str, str]] = {}

        def node(self, node: Any) -> None:
            osm_node_id = safe_int(node.id)
            if osm_node_id is not None and osm_node_id in node_ids:
                self.tags[osm_node_id] = dict(node.tags)

    collector = NodeCollector()
    collector.apply_file(str(pbf_path))
    return collector.tags


def open_dem_reader(dem_file: Path | None) -> tuple[Any, str | None]:
    """Open the existing inject-osm-dem-slopes DemReader or fail soft when no DEM is available."""
    if dem_file is None:
        print("[build-ped-graph] DEM not supplied; slope_longitudinal will remain NULL")
        return None, None
    if not dem_file.is_file():
        print(
            f"[build-ped-graph] DEM not found at {dem_file}; "
            "slope_longitudinal will remain NULL"
        )
        return None, None
    reader_class = getattr(DEM_HELPER, "DemReader", None)
    if reader_class is None:
        print(
            "[build-ped-graph] DEM reader dependencies unavailable; "
            "slope_longitudinal will remain NULL"
        )
        return None, None
    try:
        return reader_class(str(dem_file)), source_updated_at(dem_file)
    except Exception as error:
        print(
            f"[build-ped-graph] unable to open DEM {dem_file}: {error}; "
            "slope_longitudinal will remain NULL"
        )
        return None, None


def build_graph(
    pbf_path: Path,
    bbox: tuple[float, float, float, float],
    dem_file: Path | None = None,
    sidewalk_geojson: Path | None = None,
) -> GraphBuild:
    """Extract, cut, overlay, enrich, and direct a graph without touching PostGIS."""
    ways, invalid_way_location_count = collect_walk_ways(pbf_path, bbox)
    if not ways:
        raise SystemExit(f"No eligible walking ways found in bbox {bbox}")
    reference_counts = count_way_node_references(ways)
    segments = [
        segment
        for way in ways
        for segment in split_way_into_segments(way, reference_counts)
        if polyline_intersects_bbox(segment.coordinates, bbox)
    ]
    if not segments:
        raise SystemExit(f"No walkable segments found in bbox {bbox}")
    endpoint_ids = {
        endpoint
        for segment in segments
        for endpoint in (segment.from_osm_node, segment.to_osm_node)
    }
    node_tags = collect_node_tags(pbf_path, endpoint_ids)
    sidewalk_matches: list[SidewalkMatch | None] = [None] * len(segments)
    if sidewalk_geojson is not None:
        if sidewalk_geojson.is_file():
            sidewalk_index = build_sidewalk_index(sidewalk_geojson)
            sidewalk_matches = [
                match_sidewalk_to_coordinates(segment.coordinates, sidewalk_index)
                for segment in segments
            ]
        else:
            print(
                f"[build-ped-graph] sidewalk GeoJSON not found at {sidewalk_geojson}; "
                "width overlay will be skipped"
            )
    osm_updated_at = source_updated_at(pbf_path)
    dem_reader, dem_updated_at = open_dem_reader(dem_file)
    try:
        nodes = build_node_records(
            segments, reference_counts, node_tags, osm_updated_at
        )
        edges = build_directed_edges(
            segments,
            sidewalk_matches=sidewalk_matches,
            dem_reader=dem_reader,
            osm_updated_at=osm_updated_at,
            dem_updated_at=dem_updated_at,
        )
    finally:
        if dem_reader is not None:
            dem_reader.close()
    return GraphBuild(
        nodes=nodes,
        edges=edges,
        undirected_segment_count=len(segments),
        invalid_way_location_count=invalid_way_location_count,
        sidewalk_matched_segment_count=sum(
            match is not None for match in sidewalk_matches
        ),
    )


def is_reachable(
    adjacency: Mapping[int, Sequence[int]], start: int, target: int
) -> bool:
    """Return whether one directed graph vertex can reach another via breadth-first search."""
    if start == target:
        return True
    visited = {start}
    queue: deque[int] = deque([start])
    while queue:
        current = queue.popleft()
        for neighbour in adjacency.get(current, ()):
            if neighbour == target:
                return True
            if neighbour not in visited:
                visited.add(neighbour)
                queue.append(neighbour)
    return False


def connectivity_sample(
    nodes: Mapping[int, NodeRecord],
    edges: Sequence[EdgeRecord],
    sample_size: int = CONNECTIVITY_SAMPLE_SIZE,
    min_distance_m: float = CONNECTIVITY_MIN_DISTANCE_M,
    max_distance_m: float = CONNECTIVITY_MAX_DISTANCE_M,
    seed: int = CONNECTIVITY_SEED,
) -> dict[str, Any]:
    """Sample geographically separated node pairs and report their directed reachability."""
    adjacency: dict[int, list[int]] = defaultdict(list)
    for edge in edges:
        adjacency[edge.from_osm_node].append(edge.to_osm_node)
    node_ids = tuple(nodes)
    randomizer = random.Random(seed)
    sampled_pairs: set[tuple[int, int]] = set()
    reachable_count = 0
    distances: list[float] = []
    attempts = 0
    max_attempts = max(sample_size * 10_000, 10_000)
    while len(sampled_pairs) < sample_size and attempts < max_attempts:
        attempts += 1
        start = randomizer.choice(node_ids)
        target = randomizer.choice(node_ids)
        if start == target or (start, target) in sampled_pairs:
            continue
        start_node = nodes[start]
        target_node = nodes[target]
        distance_m = haversine_m(
            (start_node.lon, start_node.lat), (target_node.lon, target_node.lat)
        )
        if not min_distance_m <= distance_m <= max_distance_m:
            continue
        sampled_pairs.add((start, target))
        distances.append(distance_m)
        if is_reachable(adjacency, start, target):
            reachable_count += 1
    sampled_count = len(sampled_pairs)
    return {
        "requested": sample_size,
        "sampled": sampled_count,
        "reachable": reachable_count,
        "unreachable": sampled_count - reachable_count,
        "rate_pct": round(reachable_count / sampled_count * 100.0, 3)
        if sampled_count
        else None,
        "distance_min_m": round(min(distances), 3) if distances else None,
        "distance_max_m": round(max(distances), 3) if distances else None,
        "seed": seed,
    }


def coverage_pct(values: Sequence[Any]) -> float:
    """Return the percentage of values that are known, preserving zero as a known value."""
    if not values:
        return 0.0
    return round(sum(value is not None for value in values) / len(values) * 100.0, 3)


def graph_report(graph: GraphBuild, connectivity: Mapping[str, Any]) -> dict[str, Any]:
    """Produce the reproducibility metrics stored in ped_graph_version.notes."""
    edge_type_distribution = dict(
        sorted(Counter(edge.edge_type for edge in graph.edges).items())
    )
    return {
        "node_count": len(graph.nodes),
        "undirected_segment_count": graph.undirected_segment_count,
        "directed_edge_count": len(graph.edges),
        "invalid_way_location_count": graph.invalid_way_location_count,
        "edge_type_distribution": edge_type_distribution,
        "coverage_pct": {
            "slope_longitudinal": coverage_pct(
                [edge.slope_longitudinal for edge in graph.edges]
            ),
            "surface": coverage_pct([edge.surface for edge in graph.edges]),
            "smoothness": coverage_pct([edge.smoothness for edge in graph.edges]),
            "width_m": coverage_pct([edge.width_m for edge in graph.edges]),
            "effective_width_m": coverage_pct(
                [edge.effective_width_m for edge in graph.edges]
            ),
            "wheelchair": coverage_pct([edge.wheelchair for edge in graph.edges]),
        },
        "sidewalk_overlay": {
            "matched_undirected_segments": graph.sidewalk_matched_segment_count,
            "segment_coverage_pct": round(
                graph.sidewalk_matched_segment_count
                / graph.undirected_segment_count
                * 100.0,
                3,
            ),
        },
        "connectivity": dict(connectivity),
    }


def sha256_file(path: Path) -> str:
    """Return the SHA-256 content hash of a source input without loading it into memory."""
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def scoped_identifier(version_id: int, source_id: int, scale: int, label: str) -> int:
    """Create a version-scoped BIGINT ID so repeat builds never overwrite earlier versions."""
    if source_id < 0 or source_id >= scale:
        raise ValueError(
            f"{label} source id {source_id} does not fit the configured scale"
        )
    scoped = version_id * scale + source_id
    if scoped >= 2**63:
        raise ValueError(f"{label} id {scoped} exceeds Postgres BIGINT")
    return scoped


def line_wkt(coordinates: Sequence[tuple[float, float]]) -> str:
    """Serialize a nonempty WGS84 polyline as EWKT-compatible LineString text."""
    return (
        "LINESTRING ("
        + ", ".join(
            f"{longitude:.8f} {latitude:.8f}" for longitude, latitude in coordinates
        )
        + ")"
    )


def bbox_wkt(bbox: tuple[float, float, float, float]) -> str:
    """Serialize a west-south-east-north extent as a closed WGS84 polygon WKT."""
    west, south, east, north = bbox
    return (
        "POLYGON (("
        f"{west} {south}, {east} {south}, {east} {north}, {west} {north}, {west} {south}"
        "))"
    )


def ensure_graph_schema(cursor: Any) -> None:
    """Fail early with a clear error when WP-1's required PostGIS tables are absent."""
    cursor.execute(
        "SELECT to_regclass('public.ped_graph_version'), "
        "to_regclass('public.ped_node'), to_regclass('public.ped_edge')"
    )
    schema_row = cursor.fetchone()
    if schema_row is None:
        raise RuntimeError("PostGIS schema check returned no row")
    missing = [
        table
        for table, value in zip(
            ("ped_graph_version", "ped_node", "ped_edge"), schema_row, strict=False
        )
        if value is None
    ]
    if missing:
        raise SystemExit(
            "PostGIS pedestrian graph schema is missing tables: " + ", ".join(missing)
        )


def write_graph_to_postgis(
    graph: GraphBuild,
    source_hash: str,
    bbox: tuple[float, float, float, float],
    report: Mapping[str, Any],
    db_url: str,
) -> int:
    """Create one graph version and bulk insert version-scoped node and edge records."""
    try:
        import psycopg2
        from psycopg2.extras import execute_values
    except ImportError as error:
        raise SystemExit(
            "psycopg2 is required to write the pedestrian graph"
        ) from error

    notes = json.dumps(
        report, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    )
    connection = psycopg2.connect(db_url)
    try:
        with connection, connection.cursor() as cursor:
            ensure_graph_schema(cursor)
            cursor.execute(
                """
                    INSERT INTO ped_graph_version
                      (
                        source_hash, bbox, node_count, directed_edge_count, notes,
                        lifecycle_status, indoor_injection_complete
                      )
                    VALUES
                      (%s, ST_GeomFromText(%s, 4326), %s, %s, %s, %s, %s)
                    RETURNING id
                    """,
                (
                    source_hash,
                    bbox_wkt(bbox),
                    len(graph.nodes),
                    len(graph.edges),
                    notes,
                    "CANDIDATE",
                    False,
                ),
            )
            version_row = cursor.fetchone()
            if version_row is None:
                raise RuntimeError("PostGIS did not return a graph version id")
            version_id = safe_int(version_row[0])
            if version_id is None:
                raise RuntimeError("PostGIS returned an invalid graph version id")
            node_id_map = {
                osm_node_id: scoped_identifier(
                    version_id, osm_node_id, NODE_ID_SCALE, "node"
                )
                for osm_node_id in graph.nodes
            }
            node_rows = (
                (
                    node_id_map[node.osm_node_id],
                    version_id,
                    node.lon,
                    node.lat,
                    node.lon,
                    node.lat,
                    node.node_type,
                    node.kerb,
                    node.tactile_paving,
                    node.traffic_signal,
                    node.audible_signal,
                    node.source_ref,
                    json.dumps(node.attr_meta, ensure_ascii=False),
                )
                for node in graph.nodes.values()
            )
            execute_values(
                cursor,
                """
                    INSERT INTO ped_node (
                      node_id, version_id, geom, proxy_geom, station_id,
                      station_radius_m, node_type, kerb, tactile_paving,
                      traffic_signal, audible_signal, source_ref, attr_meta
                    ) VALUES %s
                    """,
                node_rows,
                template=(
                    "(%s,%s,ST_SetSRID(ST_MakePoint(%s,%s),4326),"
                    "ST_SetSRID(ST_MakePoint(%s,%s),4326),NULL,NULL,"
                    "%s,%s,%s,%s,%s,%s,%s::jsonb)"
                ),
                page_size=1_000,
            )
            edge_rows = (
                (
                    scoped_identifier(version_id, ordinal, EDGE_ID_SCALE, "edge"),
                    version_id,
                    node_id_map[edge.from_osm_node],
                    node_id_map[edge.to_osm_node],
                    line_wkt(edge.coordinates),
                    edge.length_m,
                    edge.edge_type,
                    edge.slope_longitudinal,
                    edge.surface,
                    edge.smoothness,
                    edge.width_m,
                    edge.effective_width_m,
                    edge.wheelchair,
                    edge.stair_count,
                    edge.has_ramp,
                    edge.is_bidirectional,
                    edge.source_ref,
                    json.dumps(edge.attr_meta, ensure_ascii=False),
                )
                for ordinal, edge in enumerate(graph.edges, start=1)
            )
            execute_values(
                cursor,
                """
                    INSERT INTO ped_edge (
                      edge_id, version_id, from_node, to_node, geom, length_m,
                      edge_type, slope_longitudinal, slope_cross, surface,
                      smoothness, width_m, effective_width_m, wheelchair,
                      stair_count, traversal_time_s, has_ramp, is_bidirectional,
                      source_ref, attr_meta
                    ) VALUES %s
                    """,
                edge_rows,
                template=(
                    "(%s,%s,%s,%s,ST_GeomFromText(%s,4326),%s,%s,%s,NULL,"
                    "%s,%s,%s,%s,%s,%s,NULL,%s,%s,%s,%s::jsonb)"
                ),
                page_size=1_000,
            )
        return version_id
    finally:
        connection.close()


def print_report(version_id: int, source_hash: str, report: Mapping[str, Any]) -> None:
    """Print the requested graph size, attribute coverage, and reachability summary."""
    coverage = report["coverage_pct"]
    connectivity = report["connectivity"]
    print(f"[build-ped-graph] graph_version_id={version_id}")
    print(
        "[build-ped-graph] lifecycle_status=CANDIDATE "
        "(run indoor injection and explicit promotion before use)"
    )
    print(f"[build-ped-graph] source_hash={source_hash}")
    print(
        "[build-ped-graph] "
        f"nodes={report['node_count']} "
        f"undirected_segments={report['undirected_segment_count']} "
        f"directed_edges={report['directed_edge_count']}"
    )
    print(
        f"[build-ped-graph] edge_type_distribution={report['edge_type_distribution']}"
    )
    print(
        "[build-ped-graph] coverage_pct "
        f"slope={coverage['slope_longitudinal']:.3f} "
        f"surface={coverage['surface']:.3f} "
        f"smoothness={coverage['smoothness']:.3f} "
        f"width={coverage['width_m']:.3f} "
        f"effective_width={coverage['effective_width_m']:.3f} "
        f"wheelchair={coverage['wheelchair']:.3f}"
    )
    print(
        "[build-ped-graph] sidewalk_overlay "
        f"matched_segments={report['sidewalk_overlay']['matched_undirected_segments']} "
        f"coverage_pct={report['sidewalk_overlay']['segment_coverage_pct']:.3f}"
    )
    print(
        "[build-ped-graph] connectivity "
        f"reachable={connectivity['reachable']}/{connectivity['sampled']} "
        f"rate_pct={connectivity['rate_pct']:.3f} "
        f"distance_m=[{connectivity['distance_min_m']:.3f},"
        f"{connectivity['distance_max_m']:.3f}] "
        f"seed={connectivity['seed']}"
    )


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    """Parse the documented PBF, DEM, sidewalk, bbox, and database build contract."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pbf", type=Path, required=True, help="Input Taiwan OSM PBF")
    parser.add_argument(
        "--dem-file",
        type=Path,
        help="Optional EPSG:4326 DEM GeoTIFF; missing files are handled fail-soft",
    )
    parser.add_argument(
        "--sidewalk-geojson",
        type=Path,
        help="Optional Taipei government sidewalk GeoJSON for width overlay",
    )
    parser.add_argument("--bbox", choices=tuple(BBOXES), required=True)
    parser.add_argument(
        "--db-url",
        default=os.environ.get("PED_GRAPH_DATABASE_URL"),
        help="PostGIS URL; defaults to PED_GRAPH_DATABASE_URL",
    )
    args = parser.parse_args(argv)
    if not args.pbf.is_file():
        parser.error(f"PBF not found: {args.pbf}")
    if not args.db_url:
        parser.error("--db-url or PED_GRAPH_DATABASE_URL is required")
    return args


def main(argv: Sequence[str] | None = None) -> int:
    """Run the complete offline PBF-to-PostGIS pedestrian graph build."""
    args = parse_args(argv)
    bbox = BBOXES[args.bbox]
    print(f"[build-ped-graph] collecting OSM ways from {args.pbf}")
    graph = build_graph(
        args.pbf,
        bbox,
        dem_file=args.dem_file,
        sidewalk_geojson=args.sidewalk_geojson,
    )
    connectivity = connectivity_sample(graph.nodes, graph.edges)
    if connectivity["sampled"] != CONNECTIVITY_SAMPLE_SIZE:
        raise SystemExit(
            "Unable to obtain 100 node pairs within 300 m–3 km for connectivity sampling"
        )
    report = graph_report(graph, connectivity)
    source_hash = sha256_file(args.pbf)
    version_id = write_graph_to_postgis(graph, source_hash, bbox, report, args.db_url)
    print_report(version_id, source_hash, report)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
