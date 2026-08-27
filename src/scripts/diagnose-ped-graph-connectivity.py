#!/usr/bin/env python3
"""Read-only diagnosis of pedestrian-graph weak-component islands behind unroutable OD pairs.

This script never mutates the graph: every statement it sends is a SELECT, the
connection is opened read-only, and no builder write helper is imported. It
answers "why is this OD pair unroutable" with mechanical evidence — component
sizes, the nearest large-component edge, the geodesic gap, geometric
intersections, and the original OSM tags of both stored and nearby policy-ineligible
ways — and then applies one conservative classification per case.

Proximity is never sufficient evidence for a topology defect: a gap without a
positive same-grade, eligibility, or clipping finding is reported as
OSM_GAP_UNPROVEN so nobody stitches two ways that do not meet in reality.

Three deliberate limits on what may be concluded:

* A connector way is a rule defect only when it is absent from the selected
  stored graph but the current builder policy accepts it. Merely finding a
  nearby way that the current policy rejects proves neither graph history nor
  a policy defect.
* A crossing whose original OSM tags are unavailable on either side is unknown,
  never positive grade-separation evidence.
* A barrier intersecting the straight-line gap proxy does not prove the barrier
  separates the two components, so barriers are recorded as evidence and never
  classify a case. This is "insufficient evidence", not "no barrier".
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import math
import os
import re
import sys
import tempfile
from collections import defaultdict
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

BUILDER_PATH = Path(__file__).with_name("build-ped-graph.py")


def load_builder_module() -> Any:
    """Load build-ped-graph.py so eligibility and geometry policy has exactly one definition."""
    spec = importlib.util.spec_from_file_location(
        "build_ped_graph_for_diagnosis", BUILDER_PATH
    )
    if spec is None or spec.loader is None:
        raise SystemExit(
            f"Unable to load the pedestrian graph builder at {BUILDER_PATH}"
        )
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


BUILDER = load_builder_module()
should_include_way = BUILDER.should_include_way
normalized_tag = BUILDER.normalized_tag
haversine_m = BUILDER.haversine_m
point_in_bbox = BUILDER.point_in_bbox
polyline_intersects_bbox = BUILDER.polyline_intersects_bbox
safe_int = BUILDER.safe_int
finite_float = BUILDER.finite_float

DEFAULT_COMPARISON_PATH = str(Path(tempfile.gettempdir()) / "ped-otp-comparison.json")
DEFAULT_OUTPUT_PATH = str(
    Path(tempfile.gettempdir()) / "ped-graph-connectivity-diagnosis.json"
)

# Endpoint replay tolerance. The comparison file stores IEEE-754 doubles read
# straight from ST_X/ST_Y, so a correct replay matches far below this bound;
# anything looser would start behaving like a nearest-snap, which is exactly
# what this diagnosis must not do.
COORDINATE_TOLERANCE_DEG = 1e-7

# How far around an island the diagnosis looks for large-component edges and for
# original OSM ways. Wide enough to cover the observed 4.3-50 m gaps with room
# for context, narrow enough that the PBF scan stays cheap.
NEARBY_SEARCH_RADIUS_M = 150.0

# Two polylines closer than this at a crossing count as geometrically touching.
INTERSECTION_TOLERANCE_M = 0.5

# An island node this close to the build bbox edge may have been clipped rather
# than genuinely disconnected.
BBOX_EDGE_TOLERANCE_M = 30.0

# Barrier values a wheelchair user cannot pass at all. Deliberately excludes
# kerb/bollard/gate/cycle_barrier, which are usually passable and would turn a
# barrier observation into a false explanation for an ordinary mapping gap.
BLOCKING_BARRIER_VALUES = frozenset(
    {
        "wall",
        "city_wall",
        "retaining_wall",
        "fence",
        "hedge",
        "hedge_bank",
        "guard_rail",
        "handrail",
        "ditch",
    }
)

CLASSIFICATIONS = (
    "ELIGIBILITY_RULE_DEFECT",
    "SAME_GRADE_INTERSECTION_PROVEN",
    "GRADE_SEPARATED",
    "BBOX_ARTIFACT",
    "OSM_GAP_UNPROVEN",
)

# Evaluated top to bottom; the first rule whose positive evidence is present
# wins. OSM_GAP_UNPROVEN is last because it is the "we only have proximity"
# outcome, never a conclusion.
CLASSIFICATION_PRECEDENCE = CLASSIFICATIONS

SOURCE_REF_NODE_PATTERN = re.compile(r"^osm:node/(\d+)$")
SOURCE_REF_WAY_PATTERN = re.compile(r"^osm:way/(\d+)$")

VERSION_QUERY = """
SELECT id, node_count, directed_edge_count, built_at, ST_AsText(bbox) AS bbox_wkt,
       source_hash
FROM ped_graph_version
WHERE id = %s
"""

LATEST_VERSION_QUERY = """
SELECT id, node_count, directed_edge_count, built_at, ST_AsText(bbox) AS bbox_wkt,
       source_hash
FROM ped_graph_version
ORDER BY built_at DESC, id DESC
LIMIT 1
"""

NODE_QUERY = """
SELECT
  node_id,
  ST_X(proxy_geom) AS lon,
  ST_Y(proxy_geom) AS lat,
  node_type,
  source_ref,
  geom IS NOT NULL AS has_real_geom
FROM ped_node
WHERE version_id = %s
ORDER BY node_id
"""

EDGE_ENDPOINT_QUERY = """
SELECT from_node, to_node, source_ref
FROM ped_edge
WHERE version_id = %s
"""

NEARBY_EDGE_QUERY = """
SELECT
  edge_id,
  from_node,
  to_node,
  edge_type,
  length_m,
  is_bidirectional,
  source_ref,
  ST_AsText(geom) AS geom_wkt
FROM ped_edge
WHERE version_id = %s
  AND geom IS NOT NULL
  AND ST_DWithin(geom::geography, ST_GeomFromText(%s, 4326)::geography, %s)
ORDER BY edge_id
"""

# The only statements this script may send. run_select resolves by name so no
# caller can ever hand a dynamically built string to the driver.
QUERIES = {
    "version": VERSION_QUERY,
    "latest_version": LATEST_VERSION_QUERY,
    "nodes": NODE_QUERY,
    "edge_endpoints": EDGE_ENDPOINT_QUERY,
    "nearby_edges": NEARBY_EDGE_QUERY,
}


class DiagnosisError(RuntimeError):
    """Raised when evidence cannot be resolved safely and the run must fail closed."""


def required_int(value: Any, label: str) -> int:
    """Return an integer database value, failing closed instead of propagating a raw cast error."""
    parsed = safe_int(value)
    if parsed is None:
        raise DiagnosisError(f"{label} is not an integer: {value!r}")
    return parsed


def required_float(value: Any, label: str) -> float:
    """Return a finite database value, failing closed instead of propagating a raw cast error."""
    parsed = finite_float(value)
    if parsed is None:
        raise DiagnosisError(f"{label} is not a finite number: {value!r}")
    return parsed


def assert_select_only(sql: str) -> str:
    """Reject anything that is not a single read-only SELECT before it reaches the driver."""
    stripped = "\n".join(
        line for line in sql.splitlines() if not line.strip().startswith("--")
    ).strip()
    if not stripped.upper().startswith("SELECT"):
        raise DiagnosisError(
            f"refusing to run a non-SELECT statement: {stripped[:40]!r}"
        )
    if ";" in stripped.rstrip(";"):
        raise DiagnosisError("refusing to run a multi-statement query")
    forbidden = (
        "INSERT",
        "UPDATE",
        "DELETE",
        "DROP",
        "ALTER",
        "CREATE",
        "TRUNCATE",
        "GRANT",
        "COPY",
        "MERGE",
    )
    tokens = set(re.findall(r"[A-Z]+", stripped.upper()))
    offending = sorted(tokens & set(forbidden))
    if offending:
        raise DiagnosisError(f"refusing to run a statement containing {offending}")
    return sql


@dataclass(frozen=True)
class Endpoint:
    """One OD endpoint as recorded by the comparison run."""

    role: str
    dense_index: int
    lat: float
    lon: float


@dataclass(frozen=True)
class DisconnectedCase:
    """One comparison case this engine could not route, keyed by its stable case id."""

    case_id: int
    straight_line_distance_m: float | None
    endpoints: tuple[Endpoint, Endpoint]


@dataclass(frozen=True)
class ResolvedEndpoint:
    """An endpoint bound to a concrete graph node, with how the binding was proven."""

    role: str
    dense_index: int
    node_id: int
    lat: float
    lon: float
    method: str


@dataclass
class CaseEvidence:
    """Mechanical findings for one case; the only input the classifier is allowed to read."""

    gap_m: float | None = None
    missing_eligible_connector_ways: list[dict[str, Any]] = field(default_factory=list)
    same_grade_intersections: list[dict[str, Any]] = field(default_factory=list)
    grade_separated_intersections: list[dict[str, Any]] = field(default_factory=list)
    unknown_grade_intersections: list[dict[str, Any]] = field(default_factory=list)
    barrier_observations: list[dict[str, Any]] = field(default_factory=list)
    bbox_clipping: dict[str, Any] | None = None


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    """Parse the read-only diagnosis contract: comparison evidence, graph version, PBF, output."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--comparison",
        type=Path,
        default=Path(DEFAULT_COMPARISON_PATH),
        help="Prior ped-router-otp-comparison JSON holding the unroutable cases",
    )
    parser.add_argument(
        "--version-id",
        type=int,
        help="Graph version to diagnose; defaults to the newest ped_graph_version",
    )
    parser.add_argument("--pbf", type=Path, required=True, help="Input OSM PBF")
    parser.add_argument(
        "--db-url",
        default=os.environ.get("PED_GRAPH_DATABASE_URL"),
        help="PostGIS URL; defaults to PED_GRAPH_DATABASE_URL",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path(DEFAULT_OUTPUT_PATH),
        help="Machine-readable JSON evidence destination",
    )
    args = parser.parse_args(argv)
    if not args.comparison.is_file():
        parser.error(f"comparison evidence not found: {args.comparison}")
    if not args.pbf.is_file():
        parser.error(f"PBF not found: {args.pbf}")
    if not args.db_url:
        parser.error("--db-url or PED_GRAPH_DATABASE_URL is required")
    return args


def load_disconnected_cases(document: Mapping[str, Any]) -> list[DisconnectedCase]:
    """Select every comparison outcome this engine failed to route, in the recorded order."""
    outcomes = document.get("outcomes")
    if not isinstance(outcomes, list):
        raise DiagnosisError("comparison document has no outcomes array")
    cases: list[DisconnectedCase] = []
    for position, outcome in enumerate(outcomes):
        if not isinstance(outcome, Mapping):
            raise DiagnosisError(f"outcome {position} is not an object")
        ours = outcome.get("ours")
        if not isinstance(ours, Mapping):
            raise DiagnosisError(f"outcome {position} has no ours result")
        if ours.get("status") == "ok":
            continue
        raw_case_id = outcome.get("sourceIndex", outcome.get("index"))
        if not isinstance(raw_case_id, int) or isinstance(raw_case_id, bool):
            raise DiagnosisError(f"outcome {position} has no integer case id")
        cases.append(
            DisconnectedCase(
                case_id=raw_case_id,
                straight_line_distance_m=finite_float(
                    outcome.get("straightLineDistanceM")
                ),
                endpoints=(
                    _read_endpoint(outcome, "from", position),
                    _read_endpoint(outcome, "to", position),
                ),
            )
        )
    return cases


def _read_endpoint(outcome: Mapping[str, Any], role: str, position: int) -> Endpoint:
    """Read one endpoint, refusing to guess when the recorded shape is incomplete."""
    raw = outcome.get(role)
    if not isinstance(raw, Mapping):
        raise DiagnosisError(f"outcome {position} has no {role} endpoint")
    node = raw.get("node")
    latitude = finite_float(raw.get("lat"))
    longitude = finite_float(raw.get("lon"))
    if not isinstance(node, int) or isinstance(node, bool):
        raise DiagnosisError(f"outcome {position} {role}.node is not an integer")
    if latitude is None or longitude is None:
        raise DiagnosisError(f"outcome {position} {role} has no finite coordinate")
    return Endpoint(role=role, dense_index=node, lat=latitude, lon=longitude)


def resolve_endpoint(
    endpoint: Endpoint,
    ordered_node_ids: Sequence[int],
    node_lon: Sequence[float],
    node_lat: Sequence[float],
    tolerance_deg: float = COORDINATE_TOLERANCE_DEG,
) -> ResolvedEndpoint:
    """Bind an endpoint to the one node whose coordinate matches it within a strict tolerance.

    The dense index is the node's rank in `ORDER BY node_id`, which is exactly how
    the TypeScript graph loader assigns it, so a matching index is reported as the
    binding method. It is never a shortcut around uniqueness: the whole node set is
    scanned every time, and zero matches or two matches both fail closed rather than
    snapping to whatever happens to be nearest. Skipping the scan when the dense
    index happened to agree would silently bind an ambiguous coordinate.
    """
    matches = [
        candidate
        for candidate in range(len(ordered_node_ids))
        if abs(node_lat[candidate] - endpoint.lat) <= tolerance_deg
        and abs(node_lon[candidate] - endpoint.lon) <= tolerance_deg
    ]
    if not matches:
        raise DiagnosisError(
            f"{endpoint.role} endpoint ({endpoint.lat}, {endpoint.lon}) matches no node "
            f"in this graph version within {tolerance_deg} degrees"
        )
    if len(matches) > 1:
        raise DiagnosisError(
            f"{endpoint.role} endpoint ({endpoint.lat}, {endpoint.lon}) is ambiguous: "
            f"{len(matches)} nodes match within {tolerance_deg} degrees"
        )
    resolved = matches[0]
    return ResolvedEndpoint(
        role=endpoint.role,
        dense_index=resolved,
        node_id=ordered_node_ids[resolved],
        lat=node_lat[resolved],
        lon=node_lon[resolved],
        method="dense_index" if resolved == endpoint.dense_index else "coordinate",
    )


def build_weak_components(
    node_ids: Iterable[int], edges: Iterable[tuple[int, int]]
) -> dict[int, int]:
    """Union every arc regardless of direction and label each node with its component's min id."""
    parent: dict[int, int] = {node_id: node_id for node_id in node_ids}

    def find(node: int) -> int:
        root = node
        while parent[root] != root:
            root = parent[root]
        while parent[node] != root:
            parent[node], node = root, parent[node]
        return root

    for from_node, to_node in edges:
        if from_node not in parent or to_node not in parent:
            raise DiagnosisError(
                f"edge {from_node}->{to_node} references a node outside this version"
            )
        left, right = find(from_node), find(to_node)
        if left != right:
            # Attach to the smaller id so the representative is order-independent.
            if left < right:
                parent[right] = left
            else:
                parent[left] = right
    return {node_id: find(node_id) for node_id in parent}


def component_sizes(component_of: Mapping[int, int]) -> dict[int, int]:
    """Count members per component representative."""
    sizes: dict[int, int] = defaultdict(int)
    for representative in component_of.values():
        sizes[representative] += 1
    return dict(sizes)


def largest_component(sizes: Mapping[int, int]) -> int:
    """Return the representative of the biggest component, breaking ties by smallest id."""
    if not sizes:
        raise DiagnosisError("graph version has no components")
    return min(
        sizes, key=lambda representative: (-sizes[representative], representative)
    )


def meters_per_degree(latitude: float) -> tuple[float, float]:
    """Return local metres per degree of longitude and latitude at a latitude."""
    return (111_320.0 * math.cos(math.radians(latitude)), 110_540.0)


def to_local_xy(
    point: tuple[float, float], origin: tuple[float, float]
) -> tuple[float, float]:
    """Project a lon/lat point to metres on a tangent plane at the origin."""
    lon_scale, lat_scale = meters_per_degree(origin[1])
    return ((point[0] - origin[0]) * lon_scale, (point[1] - origin[1]) * lat_scale)


def to_lon_lat(
    local: tuple[float, float], origin: tuple[float, float]
) -> tuple[float, float]:
    """Invert to_local_xy."""
    lon_scale, lat_scale = meters_per_degree(origin[1])
    return (origin[0] + local[0] / lon_scale, origin[1] + local[1] / lat_scale)


def point_to_segment_distance_m(
    point: tuple[float, float],
    start: tuple[float, float],
    end: tuple[float, float],
) -> float:
    """Return the shortest distance in metres from a point to a lon/lat segment."""
    origin = point
    px, py = to_local_xy(point, origin)
    ax, ay = to_local_xy(start, origin)
    bx, by = to_local_xy(end, origin)
    dx, dy = bx - ax, by - ay
    if dx == 0.0 and dy == 0.0:
        return haversine_m(point, start)
    ratio = ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)
    ratio = max(0.0, min(1.0, ratio))
    closest = to_lon_lat((ax + ratio * dx, ay + ratio * dy), origin)
    return haversine_m(point, closest)


def point_to_polyline_distance_m(
    point: tuple[float, float], coordinates: Sequence[tuple[float, float]]
) -> float:
    """Return the shortest distance in metres from a point to a lon/lat polyline."""
    if len(coordinates) == 1:
        return haversine_m(point, coordinates[0])
    return min(
        point_to_segment_distance_m(point, start, end)
        for start, end in zip(coordinates, coordinates[1:], strict=False)
    )


def segment_intersection(
    first_start: tuple[float, float],
    first_end: tuple[float, float],
    second_start: tuple[float, float],
    second_end: tuple[float, float],
) -> tuple[float, float] | None:
    """Return the crossing point of two lon/lat segments, or None when they do not cross."""
    origin = first_start
    ax, ay = to_local_xy(first_start, origin)
    bx, by = to_local_xy(first_end, origin)
    cx, cy = to_local_xy(second_start, origin)
    dx, dy = to_local_xy(second_end, origin)
    r = (bx - ax, by - ay)
    s = (dx - cx, dy - cy)
    denominator = r[0] * s[1] - r[1] * s[0]
    if denominator == 0.0:
        return None
    t = ((cx - ax) * s[1] - (cy - ay) * s[0]) / denominator
    u = ((cx - ax) * r[1] - (cy - ay) * r[0]) / denominator
    if not (0.0 <= t <= 1.0 and 0.0 <= u <= 1.0):
        return None
    return to_lon_lat((ax + t * r[0], ay + t * r[1]), origin)


def polyline_intersections(
    first: Sequence[tuple[float, float]], second: Sequence[tuple[float, float]]
) -> list[tuple[float, float]]:
    """Return every crossing point between two lon/lat polylines."""
    points: list[tuple[float, float]] = []
    for a_start, a_end in zip(first, first[1:], strict=False):
        for b_start, b_end in zip(second, second[1:], strict=False):
            crossing = segment_intersection(a_start, a_end, b_start, b_end)
            if crossing is not None:
                points.append(crossing)
    return points


def structural_semantic(value: str | None) -> str:
    """Normalize an affirmative bridge, tunnel, or covered tag to its grade meaning."""
    normalized = normalized_tag(value)
    return "yes" if normalized not in (None, "no", "0", "false") else "no"


def grade_signature(tags: Mapping[str, str]) -> tuple[str, str, str, str, str, str]:
    """Summarise the OSM vertical-placement semantics relevant to a crossing."""
    return (
        normalized_tag(tags.get("layer")) or "0",
        normalized_tag(tags.get("level")) or "",
        structural_semantic(tags.get("bridge")),
        structural_semantic(tags.get("tunnel")),
        normalized_tag(tags.get("location")) or "",
        structural_semantic(tags.get("covered")),
    )


def is_same_grade(first: Mapping[str, str], second: Mapping[str, str]) -> bool:
    """Return whether two ways are provably at the same grade.

    Conservative on purpose: identical placement tags are required, and any
    bridge, tunnel, location, or covered tag disqualifies the pair even when
    both carry it, because matching structures still need not meet.
    """
    left, right = grade_signature(first), grade_signature(second)
    if left != right:
        return False
    return left[2] == "no" and left[3] == "no" and left[4] == "" and left[5] == "no"


def is_grade_separated(first: Mapping[str, str], second: Mapping[str, str]) -> bool:
    """Return whether explicit conflicting OSM placement semantics prove separation.

    This must not be the negation of :func:`is_same_grade`: matching bridge or
    tunnel tags are inconclusive, not proof that two crossing ways are at
    different grades. Only a conflict in the normalized layer, level, bridge,
    tunnel, location, or covered semantics can establish grade separation.
    """
    return grade_signature(first) != grade_signature(second)


def is_blocking_barrier(tags: Mapping[str, str]) -> bool:
    """Return whether a feature's barrier tagging describes something impassable on foot.

    This is a statement about tagging only. It says nothing about whether the
    feature actually separates two graph components, which is why a positive
    result is recorded as evidence and never used to classify a case.
    """
    barrier = normalized_tag(tags.get("barrier"))
    if barrier is None:
        return False
    if barrier in BLOCKING_BARRIER_VALUES:
        return True
    return normalized_tag(tags.get("foot")) in BUILDER.DENIED_ACCESS_VALUES


def has_explicit_pedestrian_permission(tags: Mapping[str, str]) -> bool:
    """Delegate the narrow affirmative-foot policy to the graph builder."""
    return bool(BUILDER.has_explicit_pedestrian_permission(tags))


def eligible_missing_connector_ways(
    missing_connector_ways: Sequence[Mapping[str, Any]],
) -> list[Mapping[str, Any]]:
    """Keep connectors absent from the selected graph that the current builder accepts."""
    return [
        way
        for way in missing_connector_ways
        if way.get("missingFromSelectedStoredGraph")
        and should_include_way(way.get("tags") or {})
    ]


def classify_case(evidence: CaseEvidence) -> tuple[str, list[str]]:
    """Pick exactly one classification from positive evidence, defaulting to unproven."""
    eligible_missing = eligible_missing_connector_ways(
        evidence.missing_eligible_connector_ways
    )
    if eligible_missing:
        ways = ", ".join(str(way["osmWayId"]) for way in eligible_missing[:3])
        return (
            "ELIGIBILITY_RULE_DEFECT",
            [
                "an OSM way accepted by the current should_include_way policy is absent "
                "from the selected stored graph and shares nodes with both the island and "
                f"the largest component (way {ways})"
            ],
        )
    if evidence.same_grade_intersections:
        return (
            "SAME_GRADE_INTERSECTION_PROVEN",
            [
                f"{len(evidence.same_grade_intersections)} island/main edge crossing(s) "
                "with identical layer, level, bridge, tunnel, location and covered tags "
                "and no shared OSM node"
            ],
        )
    if evidence.grade_separated_intersections:
        return (
            "GRADE_SEPARATED",
            [
                f"{len(evidence.grade_separated_intersections)} island/main edge crossing(s) "
                "with explicitly conflicting layer, level, bridge, tunnel, location or "
                "covered semantics"
            ],
        )
    if evidence.bbox_clipping is not None:
        return (
            "BBOX_ARTIFACT",
            [
                "the island touches the build bbox edge and an eligible way continues "
                "outside it, so the island is a clipping remainder"
            ],
        )
    gap = (
        f"{evidence.gap_m:.2f} m" if evidence.gap_m is not None else "unknown distance"
    )
    reasons = [
        f"only proximity evidence ({gap}); no missing current-policy-eligible connector, "
        "same-grade crossing or clipping was proven, so the gap must not be stitched blindly"
    ]
    if evidence.unknown_grade_intersections:
        reasons.append(
            f"{len(evidence.unknown_grade_intersections)} crossing(s) could not be graded "
            "to a positive conclusion because original tags are unavailable or their vertical "
            "semantics are inconclusive; unknown is not grade separation"
        )
    if evidence.barrier_observations:
        reasons.append(
            f"{len(evidence.barrier_observations)} impassably tagged barrier feature(s) meet "
            "the straight-line gap proxy; one proxy crossing does not prove the barrier "
            "separates the two components, so this is evidence only and classifies nothing"
        )
    return ("OSM_GAP_UNPROVEN", reasons)


def parse_linestring_wkt(wkt: str) -> list[tuple[float, float]]:
    """Parse a PostGIS LINESTRING WKT into lon/lat pairs."""
    match = re.match(r"^\s*LINESTRING\s*\((.*)\)\s*$", wkt, re.IGNORECASE | re.DOTALL)
    if match is None:
        raise DiagnosisError(f"unsupported edge geometry: {wkt[:32]!r}")
    coordinates: list[tuple[float, float]] = []
    for chunk in match.group(1).split(","):
        parts = chunk.split()
        longitude = finite_float(parts[0]) if len(parts) >= 2 else None
        latitude = finite_float(parts[1]) if len(parts) >= 2 else None
        if longitude is None or latitude is None:
            raise DiagnosisError(f"unsupported edge geometry vertex: {chunk!r}")
        coordinates.append((longitude, latitude))
    return coordinates


def parse_polygon_bbox(wkt: str | None) -> tuple[float, float, float, float] | None:
    """Parse the stored build bbox polygon into a west-south-east-north tuple."""
    if not wkt:
        return None
    match = re.match(r"^\s*POLYGON\s*\(\((.*)\)\)\s*$", wkt, re.IGNORECASE | re.DOTALL)
    if match is None:
        return None
    points: list[tuple[float, float]] = []
    for chunk in match.group(1).split(","):
        parts = chunk.split()
        longitude = finite_float(parts[0]) if len(parts) >= 2 else None
        latitude = finite_float(parts[1]) if len(parts) >= 2 else None
        if longitude is None or latitude is None:
            return None
        points.append((longitude, latitude))
    if not points:
        return None
    longitudes = [point[0] for point in points]
    latitudes = [point[1] for point in points]
    return (min(longitudes), min(latitudes), max(longitudes), max(latitudes))


def distance_to_bbox_edge_m(
    point: tuple[float, float], bbox: tuple[float, float, float, float]
) -> float:
    """Return the distance in metres from a point to the nearest bbox edge."""
    west, south, east, north = bbox
    corners = (
        ((west, south), (east, south)),
        ((east, south), (east, north)),
        ((east, north), (west, north)),
        ((west, north), (west, south)),
    )
    return min(point_to_segment_distance_m(point, start, end) for start, end in corners)


def osm_id_from_source_ref(source_ref: Any, pattern: re.Pattern[str]) -> int | None:
    """Extract the OSM id from a `osm:node/N` or `osm:way/N` source reference."""
    if not isinstance(source_ref, str):
        return None
    match = pattern.match(source_ref.strip())
    return safe_int(match.group(1)) if match else None


def expand_bbox(
    bbox: tuple[float, float, float, float], radius_m: float
) -> tuple[float, float, float, float]:
    """Grow a west-south-east-north bbox by a metre radius."""
    west, south, east, north = bbox
    lon_scale, lat_scale = meters_per_degree((south + north) / 2.0)
    return (
        west - radius_m / lon_scale,
        south - radius_m / lat_scale,
        east + radius_m / lon_scale,
        north + radius_m / lat_scale,
    )


def multipoint_wkt(points: Sequence[tuple[float, float]]) -> str:
    """Serialise lon/lat points as MULTIPOINT WKT for a parameterised ST_DWithin filter."""
    if not points:
        raise DiagnosisError("cannot build a MULTIPOINT from an empty point set")
    body = ", ".join(f"({lon!r} {lat!r})" for lon, lat in points)
    return f"MULTIPOINT ({body})"


def open_read_only_connection(db_url: str) -> Any:
    """Open a session that the server itself refuses to let write."""
    try:
        import psycopg2
    except ImportError as error:
        raise SystemExit(
            "psycopg2 is required to diagnose the pedestrian graph"
        ) from error
    connection = psycopg2.connect(db_url)
    connection.set_session(readonly=True, autocommit=True)
    return connection


def run_select(
    connection: Any, query_name: str, params: Sequence[Any]
) -> list[tuple[Any, ...]]:
    """Execute one allowlisted, guarded SELECT with bound parameters and return every row."""
    sql = QUERIES.get(query_name)
    if sql is None:
        raise DiagnosisError(f"unknown query {query_name!r}")
    with connection.cursor() as cursor:
        cursor.execute(assert_select_only(sql), tuple(params))
        return cursor.fetchall()


def read_version(connection: Any, version_id: int | None) -> dict[str, Any]:
    """Read the requested graph version, or the newest one."""
    rows = (
        run_select(connection, "latest_version", ())
        if version_id is None
        else run_select(connection, "version", (version_id,))
    )
    if not rows:
        raise DiagnosisError(f"graph version {version_id} does not exist")
    row = rows[0]
    resolved_id = safe_int(row[0])
    if resolved_id is None:
        raise DiagnosisError("ped_graph_version returned a non-integer id")
    return {
        "versionId": resolved_id,
        "nodeCount": safe_int(row[1]),
        "directedEdgeCount": safe_int(row[2]),
        "builtAt": row[3].isoformat() if row[3] is not None else None,
        "bbox": parse_polygon_bbox(row[4]),
        "sourceHash": row[5] if isinstance(row[5], str) else None,
    }


def verify_pbf_source_hash(version: Mapping[str, Any], pbf_path: Path) -> str:
    """Fail closed unless the supplied PBF is byte-identical to the one this version was built from.

    Every OSM way id and tag this diagnosis reports comes from the PBF, while the
    node ids and components come from the database. Reading those two from
    different inputs would silently attribute one extract's tags to another
    extract's topology, so the SHA-256 recorded by `build-ped-graph.py`
    (`sha256_file`, same algorithm and same meaning) must match exactly.
    """
    recorded = version.get("sourceHash")
    if not isinstance(recorded, str) or not recorded.strip():
        raise DiagnosisError(
            f"graph version {version.get('versionId')} has no source_hash, so the PBF it was "
            "built from cannot be verified; refusing to attribute OSM ids and tags to it"
        )
    actual = BUILDER.sha256_file(pbf_path)
    if actual != recorded.strip():
        raise DiagnosisError(
            f"PBF {pbf_path} does not match graph version {version.get('versionId')}: "
            f"recorded source_hash {recorded.strip()} but this file hashes to {actual}. "
            "Supply the exact extract the version was built from; do not bypass this check."
        )
    return actual


def collect_nearby_osm(
    pbf_path: Path, boxes: Sequence[tuple[float, float, float, float]]
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Read every OSM way and barrier node whose geometry touches one of the search boxes."""
    osmium = BUILDER.import_osmium()
    safe_int = BUILDER.safe_int
    finite_float = BUILDER.finite_float

    class NearbyCollector(osmium.SimpleHandler):
        def __init__(self) -> None:
            super().__init__()
            self.ways: list[dict[str, Any]] = []
            self.nodes: list[dict[str, Any]] = []

        def node(self, node: Any) -> None:
            tags = dict(node.tags)
            if "barrier" not in tags:
                return
            osm_id = safe_int(node.id)
            longitude = (
                finite_float(node.location.lon) if node.location.valid() else None
            )
            latitude = (
                finite_float(node.location.lat) if node.location.valid() else None
            )
            if osm_id is None or longitude is None or latitude is None:
                return
            if not any(point_in_bbox((longitude, latitude), box) for box in boxes):
                return
            self.nodes.append(
                {"osmId": osm_id, "lon": longitude, "lat": latitude, "tags": tags}
            )

        def way(self, way: Any) -> None:
            tags = dict(way.tags)
            if not ({"highway", "barrier", "railway"} & tags.keys()):
                return
            osm_id = safe_int(way.id)
            if osm_id is None:
                return
            refs: list[int] = []
            coordinates: list[tuple[float, float]] = []
            try:
                for node in way.nodes:
                    node_id = safe_int(node.ref)
                    longitude = finite_float(node.location.lon)
                    latitude = finite_float(node.location.lat)
                    if node_id is None or longitude is None or latitude is None:
                        return
                    refs.append(node_id)
                    coordinates.append((longitude, latitude))
            except (AttributeError, TypeError, ValueError, RuntimeError):
                return
            if len(coordinates) < 2:
                return
            if not any(polyline_intersects_bbox(coordinates, box) for box in boxes):
                return
            self.ways.append(
                {
                    "osmWayId": osm_id,
                    "tags": tags,
                    "nodeRefs": refs,
                    "coordinates": coordinates,
                    "eligibleUnderCurrentPolicy": bool(should_include_way(tags)),
                }
            )

    collector = NearbyCollector()
    BUILDER.apply_with_locations(osmium, collector, pbf_path)
    collector.ways.sort(key=lambda way: way["osmWayId"])
    collector.nodes.sort(key=lambda node: node["osmId"])
    return collector.ways, collector.nodes


def main(argv: Sequence[str] | None = None) -> int:
    """Run the read-only connectivity diagnosis and write its evidence document."""
    args = parse_args(argv)
    try:
        document = json.loads(args.comparison.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise DiagnosisError(
            f"unable to read comparison evidence {args.comparison}: {error}"
        ) from error
    cases = load_disconnected_cases(document)
    print(
        f"[diagnose-ped-connectivity] {len(cases)} unroutable case(s) in {args.comparison}"
    )

    connection = open_read_only_connection(args.db_url)
    try:
        version = read_version(connection, args.version_id)
        version_id = version["versionId"]
        source_hash = verify_pbf_source_hash(version, args.pbf)
        print(
            f"[diagnose-ped-connectivity] pbf sha256 matches version {version_id} "
            f"source_hash={source_hash}"
        )
        node_rows = run_select(connection, "nodes", (version_id,))
        edge_rows = run_select(connection, "edge_endpoints", (version_id,))

        ordered_node_ids = [
            required_int(row[0], "ped_node.node_id") for row in node_rows
        ]
        node_lon = [required_float(row[1], "ped_node longitude") for row in node_rows]
        node_lat = [required_float(row[2], "ped_node latitude") for row in node_rows]
        node_type = dict(
            zip(ordered_node_ids, (row[3] for row in node_rows), strict=True)
        )
        node_source_ref = dict(
            zip(ordered_node_ids, (row[4] for row in node_rows), strict=True)
        )
        index_of_node = {
            node_id: index for index, node_id in enumerate(ordered_node_ids)
        }
        osm_node_of = {
            node_id: osm_id_from_source_ref(ref, SOURCE_REF_NODE_PATTERN)
            for node_id, ref in node_source_ref.items()
        }

        edges = [
            (
                required_int(row[0], "ped_edge.from_node"),
                required_int(row[1], "ped_edge.to_node"),
            )
            for row in edge_rows
        ]
        stored_way_ids: set[int] = set()
        for row in edge_rows:
            osm_way_id = osm_id_from_source_ref(row[2], SOURCE_REF_WAY_PATTERN)
            if osm_way_id is not None:
                stored_way_ids.add(osm_way_id)
        component_of = build_weak_components(ordered_node_ids, edges)
        sizes = component_sizes(component_of)
        main_component = largest_component(sizes)
        print(
            f"[diagnose-ped-connectivity] version={version_id} nodes={len(ordered_node_ids)} "
            f"arcs={len(edges)} components={len(sizes)} largest={sizes[main_component]}"
        )

        resolved_cases = [
            (
                case,
                tuple(
                    resolve_endpoint(endpoint, ordered_node_ids, node_lon, node_lat)
                    for endpoint in case.endpoints
                ),
            )
            for case in cases
        ]

        members_by_component: dict[int, list[int]] = defaultdict(list)
        for node_id, representative in component_of.items():
            members_by_component[representative].append(node_id)

        search_boxes: list[tuple[float, float, float, float]] = []
        for _, endpoints in resolved_cases:
            for endpoint in endpoints:
                representative = component_of[endpoint.node_id]
                if representative == main_component:
                    continue
                members = members_by_component[representative]
                longitudes = [node_lon[index_of_node[node]] for node in members]
                latitudes = [node_lat[index_of_node[node]] for node in members]
                search_boxes.append(
                    expand_bbox(
                        (
                            min(longitudes),
                            min(latitudes),
                            max(longitudes),
                            max(latitudes),
                        ),
                        NEARBY_SEARCH_RADIUS_M,
                    )
                )

        print(
            f"[diagnose-ped-connectivity] scanning {args.pbf} for "
            f"{len(search_boxes)} island neighbourhood(s)"
        )
        osm_ways, osm_barrier_nodes = collect_nearby_osm(args.pbf, search_boxes)
        ways_by_id = {way["osmWayId"]: way for way in osm_ways}
        print(
            f"[diagnose-ped-connectivity] read {len(osm_ways)} nearby way(s) and "
            f"{len(osm_barrier_nodes)} barrier node(s)"
        )

        reports: list[dict[str, Any]] = []
        for case, endpoints in resolved_cases:
            reports.append(
                diagnose_case(
                    connection=connection,
                    version=version,
                    case=case,
                    endpoints=endpoints,
                    component_of=component_of,
                    sizes=sizes,
                    main_component=main_component,
                    members_by_component=members_by_component,
                    index_of_node=index_of_node,
                    node_lon=node_lon,
                    node_lat=node_lat,
                    node_type=node_type,
                    osm_node_of=osm_node_of,
                    stored_way_ids=stored_way_ids,
                    ways_by_id=ways_by_id,
                    osm_ways=osm_ways,
                    osm_barrier_nodes=osm_barrier_nodes,
                )
            )
    finally:
        connection.close()

    island_sizes = sorted(
        size
        for representative, size in sizes.items()
        if representative != main_component
    )
    report = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "comparisonSource": str(args.comparison),
        "pbfSource": str(args.pbf),
        "pbfSourceHash": version["sourceHash"],
        "pbfSourceHashVerified": True,
        "graph": version,
        "access": {
            "mode": "read_only",
            "statements": "SELECT only, guarded by assert_select_only",
        },
        "classificationPrecedence": list(CLASSIFICATION_PRECEDENCE),
        "weakComponents": {
            "componentCount": len(sizes),
            "largestComponentSize": sizes[main_component],
            "largestComponentShare": sizes[main_component] / max(len(component_of), 1),
            "nodesOutsideLargestComponent": len(component_of) - sizes[main_component],
            "islandCount": len(island_sizes),
            "islandSizeMin": island_sizes[0] if island_sizes else None,
            "islandSizeMax": island_sizes[-1] if island_sizes else None,
        },
        "caseCount": len(reports),
        "unclassifiedCount": sum(
            1 for item in reports if not item.get("classification")
        ),
        "classificationCounts": _count_classifications(reports),
        "cases": reports,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    for item in reports:
        print(
            f"[diagnose-ped-connectivity] case {item['caseId']}: {item['classification']}"
        )
    print(
        f"[diagnose-ped-connectivity] unclassified={report['unclassifiedCount']} "
        f"wrote {args.output}"
    )
    return 0


def _count_classifications(reports: Sequence[Mapping[str, Any]]) -> dict[str, int]:
    """Tally classifications so the report carries its own aggregate."""
    counts: dict[str, int] = dict.fromkeys(CLASSIFICATIONS, 0)
    for item in reports:
        label = item.get("classification")
        if isinstance(label, str) and label in counts:
            counts[label] += 1
    return counts


def diagnose_case(
    *,
    connection: Any,
    version: Mapping[str, Any],
    case: DisconnectedCase,
    endpoints: Sequence[ResolvedEndpoint],
    component_of: Mapping[int, int],
    sizes: Mapping[int, int],
    main_component: int,
    members_by_component: Mapping[int, Sequence[int]],
    index_of_node: Mapping[int, int],
    node_lon: Sequence[float],
    node_lat: Sequence[float],
    node_type: Mapping[int, Any],
    osm_node_of: Mapping[int, int | None],
    stored_way_ids: set[int],
    ways_by_id: Mapping[int, Mapping[str, Any]],
    osm_ways: Sequence[Mapping[str, Any]],
    osm_barrier_nodes: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    """Collect every mechanical fact for one case and classify it once."""
    island_reports: list[dict[str, Any]] = []
    evidence = CaseEvidence()

    for endpoint in endpoints:
        representative = component_of[endpoint.node_id]
        if representative == main_component:
            island_reports.append(
                {
                    "role": endpoint.role,
                    "nodeId": endpoint.node_id,
                    "denseIndex": endpoint.dense_index,
                    "resolvedBy": endpoint.method,
                    "lat": endpoint.lat,
                    "lon": endpoint.lon,
                    "componentSize": sizes[representative],
                    "inLargestComponent": True,
                }
            )
            continue
        island_reports.append(
            _diagnose_island(
                connection=connection,
                version=version,
                endpoint=endpoint,
                representative=representative,
                sizes=sizes,
                main_component=main_component,
                members_by_component=members_by_component,
                component_of=component_of,
                index_of_node=index_of_node,
                node_lon=node_lon,
                node_lat=node_lat,
                node_type=node_type,
                osm_node_of=osm_node_of,
                stored_way_ids=stored_way_ids,
                ways_by_id=ways_by_id,
                osm_ways=osm_ways,
                osm_barrier_nodes=osm_barrier_nodes,
                evidence=evidence,
            )
        )

    classification, reasons = classify_case(evidence)
    return {
        "caseId": case.case_id,
        "straightLineDistanceM": case.straight_line_distance_m,
        "endpoints": island_reports,
        "gapM": evidence.gap_m,
        "evidence": {
            "missingEligibleConnectorWays": evidence.missing_eligible_connector_ways,
            "sameGradeIntersections": evidence.same_grade_intersections,
            "gradeSeparatedIntersections": evidence.grade_separated_intersections,
            "unknownGradeIntersections": evidence.unknown_grade_intersections,
            "barrierObservations": evidence.barrier_observations,
            "bboxClipping": evidence.bbox_clipping,
        },
        "nonClassifyingEvidence": [
            "barrierObservations",
            "unknownGradeIntersections",
        ],
        "classification": classification,
        "classificationReasons": reasons,
    }


def _diagnose_island(
    *,
    connection: Any,
    version: Mapping[str, Any],
    endpoint: ResolvedEndpoint,
    representative: int,
    sizes: Mapping[int, int],
    main_component: int,
    members_by_component: Mapping[int, Sequence[int]],
    component_of: Mapping[int, int],
    index_of_node: Mapping[int, int],
    node_lon: Sequence[float],
    node_lat: Sequence[float],
    node_type: Mapping[int, Any],
    osm_node_of: Mapping[int, int | None],
    stored_way_ids: set[int],
    ways_by_id: Mapping[int, Mapping[str, Any]],
    osm_ways: Sequence[Mapping[str, Any]],
    osm_barrier_nodes: Sequence[Mapping[str, Any]],
    evidence: CaseEvidence,
) -> dict[str, Any]:
    """Gather island geometry, the nearest main edge, tags, and fill the shared evidence."""
    members = list(members_by_component[representative])
    island_points = [
        (node_lon[index_of_node[node]], node_lat[index_of_node[node]])
        for node in members
    ]
    island_osm_nodes = {
        osm_node_of.get(node) for node in members if osm_node_of.get(node) is not None
    }

    rows = run_select(
        connection,
        "nearby_edges",
        (
            version["versionId"],
            multipoint_wkt(island_points),
            NEARBY_SEARCH_RADIUS_M,
        ),
    )
    island_edges: list[dict[str, Any]] = []
    main_edges: list[dict[str, Any]] = []
    for row in rows:
        record = {
            "edgeId": required_int(row[0], "ped_edge.edge_id"),
            "fromNode": required_int(row[1], "ped_edge.from_node"),
            "toNode": required_int(row[2], "ped_edge.to_node"),
            "edgeType": row[3],
            "lengthM": finite_float(row[4]),
            "sourceRef": row[6],
            "coordinates": parse_linestring_wkt(row[7]),
        }
        component = component_of.get(record["fromNode"])
        if component == representative:
            island_edges.append(record)
        elif component == main_component:
            main_edges.append(record)

    nearest: dict[str, Any] | None = None
    for edge in main_edges:
        for point in island_points:
            distance = point_to_polyline_distance_m(point, edge["coordinates"])
            if nearest is None or distance < nearest["gapM"]:
                nearest = {
                    "gapM": distance,
                    "edgeId": edge["edgeId"],
                    "sourceRef": edge["sourceRef"],
                    "edgeType": edge["edgeType"],
                    "fromNode": edge["fromNode"],
                    "toNode": edge["toNode"],
                    "fromIslandPoint": {"lon": point[0], "lat": point[1]},
                }
    if nearest is not None and (
        evidence.gap_m is None or nearest["gapM"] < evidence.gap_m
    ):
        evidence.gap_m = nearest["gapM"]

    _collect_intersection_evidence(
        island_edges=island_edges,
        main_edges=main_edges,
        ways_by_id=ways_by_id,
        evidence=evidence,
    )
    _collect_eligibility_evidence(
        island_osm_nodes=island_osm_nodes,
        component_of=component_of,
        osm_node_of=osm_node_of,
        main_component=main_component,
        stored_way_ids=stored_way_ids,
        osm_ways=osm_ways,
        evidence=evidence,
    )
    if nearest is not None:
        _collect_barrier_evidence(
            gap_start=(
                nearest["fromIslandPoint"]["lon"],
                nearest["fromIslandPoint"]["lat"],
            ),
            nearest_edge_coordinates=next(
                edge["coordinates"]
                for edge in main_edges
                if edge["edgeId"] == nearest["edgeId"]
            ),
            osm_ways=osm_ways,
            osm_barrier_nodes=osm_barrier_nodes,
            evidence=evidence,
        )
    _collect_bbox_evidence(
        version=version,
        island_points=island_points,
        island_osm_nodes=island_osm_nodes,
        osm_ways=osm_ways,
        evidence=evidence,
    )

    island_way_refs = sorted(
        {
            edge["sourceRef"]
            for edge in island_edges
            if isinstance(edge["sourceRef"], str)
        }
    )
    return {
        "role": endpoint.role,
        "nodeId": endpoint.node_id,
        "denseIndex": endpoint.dense_index,
        "resolvedBy": endpoint.method,
        "lat": endpoint.lat,
        "lon": endpoint.lon,
        "nodeType": node_type.get(endpoint.node_id),
        "inLargestComponent": False,
        "componentSize": sizes[representative],
        "componentRepresentativeNodeId": representative,
        "componentNodeIds": sorted(members),
        "islandSourceWays": [
            {
                "sourceRef": ref,
                "tags": dict(
                    ways_by_id.get(
                        osm_id_from_source_ref(ref, SOURCE_REF_WAY_PATTERN) or -1,
                        {},
                    ).get("tags", {})
                ),
            }
            for ref in island_way_refs
        ],
        "nearestLargestComponentEdge": nearest,
        "nearestLargestComponentEdgeTags": (
            dict(
                ways_by_id.get(
                    osm_id_from_source_ref(nearest["sourceRef"], SOURCE_REF_WAY_PATTERN)
                    or -1,
                    {},
                ).get("tags", {})
            )
            if nearest is not None
            else None
        ),
        "nearbyWaysNotEligibleUnderCurrentPolicy": (
            _nearby_ways_not_eligible_under_current_policy(island_points, osm_ways)
        ),
    }


def _collect_intersection_evidence(
    *,
    island_edges: Sequence[Mapping[str, Any]],
    main_edges: Sequence[Mapping[str, Any]],
    ways_by_id: Mapping[int, Mapping[str, Any]],
    evidence: CaseEvidence,
) -> None:
    """Record island/main crossings that share no OSM node, split by what the tags prove."""
    for island_edge in island_edges:
        island_way = ways_by_id.get(
            osm_id_from_source_ref(island_edge["sourceRef"], SOURCE_REF_WAY_PATTERN)
            or -1
        )
        for main_edge in main_edges:
            shared = {island_edge["fromNode"], island_edge["toNode"]} & {
                main_edge["fromNode"],
                main_edge["toNode"],
            }
            if shared:
                continue
            crossings = polyline_intersections(
                island_edge["coordinates"], main_edge["coordinates"]
            )
            if not crossings:
                continue
            main_way = ways_by_id.get(
                osm_id_from_source_ref(main_edge["sourceRef"], SOURCE_REF_WAY_PATTERN)
                or -1
            )
            island_tags = dict(island_way.get("tags", {})) if island_way else {}
            main_tags = dict(main_way.get("tags", {})) if main_way else {}
            record = {
                "islandEdgeId": island_edge["edgeId"],
                "islandSourceRef": island_edge["sourceRef"],
                "islandTags": island_tags,
                "mainEdgeId": main_edge["edgeId"],
                "mainSourceRef": main_edge["sourceRef"],
                "mainTags": main_tags,
                "crossings": [{"lon": lon, "lat": lat} for lon, lat in crossings],
            }
            if island_way is None or main_way is None:
                # Missing tags prove nothing in either direction: this crossing is
                # neither same-grade nor grade-separated, it is simply unknown.
                record["note"] = "original tags unavailable for at least one way"
                evidence.unknown_grade_intersections.append(record)
            elif is_same_grade(island_tags, main_tags):
                evidence.same_grade_intersections.append(record)
            elif is_grade_separated(island_tags, main_tags):
                evidence.grade_separated_intersections.append(record)
            else:
                # Not sharing a provable grade does not prove a different one:
                # matching bridge/tunnel tags and other ambiguous combinations
                # remain unknown unless positive placement evidence conflicts.
                record["note"] = "vertical placement semantics are inconclusive"
                evidence.unknown_grade_intersections.append(record)


def _collect_eligibility_evidence(
    *,
    island_osm_nodes: set[int | None],
    component_of: Mapping[int, int],
    osm_node_of: Mapping[int, int | None],
    main_component: int,
    stored_way_ids: set[int],
    osm_ways: Sequence[Mapping[str, Any]],
    evidence: CaseEvidence,
) -> None:
    """Find current-policy-eligible connectors absent from the selected stored graph."""
    main_osm_nodes = {
        osm_id
        for node_id, osm_id in osm_node_of.items()
        if osm_id is not None and component_of.get(node_id) == main_component
    }
    for way in osm_ways:
        tags = dict(way["tags"])
        if not should_include_way(tags) or way["osmWayId"] in stored_way_ids:
            continue
        refs = set(way["nodeRefs"])
        if not (refs & island_osm_nodes) or not (refs & main_osm_nodes):
            continue
        evidence.missing_eligible_connector_ways.append(
            {
                "osmWayId": way["osmWayId"],
                "tags": tags,
                "explicitPedestrianPermission": has_explicit_pedestrian_permission(
                    tags
                ),
                "eligibleUnderCurrentPolicy": True,
                "missingFromSelectedStoredGraph": True,
                "sharedIslandNodes": sorted(refs & island_osm_nodes),
                "sharedLargestComponentNodes": sorted(refs & main_osm_nodes)[:8],
            }
        )


def _collect_barrier_evidence(
    *,
    gap_start: tuple[float, float],
    nearest_edge_coordinates: Sequence[tuple[float, float]],
    osm_ways: Sequence[Mapping[str, Any]],
    osm_barrier_nodes: Sequence[Mapping[str, Any]],
    evidence: CaseEvidence,
) -> None:
    """Record impassably tagged barriers that meet the straight-line gap proxy.

    Non-classifying by construction. The proxy is one straight line between the
    two nearest points, so a crossing shows the barrier lies between them, not
    that it separates the components: the barrier may be short, may be walked
    around, or may not touch the real connection route at all. Proving separation
    needs a topological cut, which this diagnosis does not attempt.
    """
    gap_end = min(
        nearest_edge_coordinates,
        key=lambda point: haversine_m(gap_start, point),
    )
    gap_line = [gap_start, gap_end]
    for way in osm_ways:
        if not is_blocking_barrier(way["tags"]):
            continue
        if not polyline_intersections(gap_line, way["coordinates"]):
            continue
        evidence.barrier_observations.append(
            {
                "osmId": way["osmWayId"],
                "kind": "way",
                "tags": dict(way["tags"]),
                "provesSeparation": False,
            }
        )
    for node in osm_barrier_nodes:
        if not is_blocking_barrier(node["tags"]):
            continue
        if (
            point_to_segment_distance_m((node["lon"], node["lat"]), gap_start, gap_end)
            > INTERSECTION_TOLERANCE_M
        ):
            continue
        evidence.barrier_observations.append(
            {
                "osmId": node["osmId"],
                "kind": "node",
                "tags": dict(node["tags"]),
                "provesSeparation": False,
            }
        )


def _collect_bbox_evidence(
    *,
    version: Mapping[str, Any],
    island_points: Sequence[tuple[float, float]],
    island_osm_nodes: set[int | None],
    osm_ways: Sequence[Mapping[str, Any]],
    evidence: CaseEvidence,
) -> None:
    """Record clipping: the island hugs the build bbox and an eligible way continues outside."""
    bbox = version.get("bbox")
    if bbox is None or evidence.bbox_clipping is not None:
        return
    touching = [
        point
        for point in island_points
        if distance_to_bbox_edge_m(point, bbox) <= BBOX_EDGE_TOLERANCE_M
    ]
    if not touching:
        return
    for way in osm_ways:
        if not way["eligibleUnderCurrentPolicy"]:
            continue
        if not (set(way["nodeRefs"]) & island_osm_nodes):
            continue
        outside = [
            point for point in way["coordinates"] if not point_in_bbox(point, bbox)
        ]
        if not outside:
            continue
        evidence.bbox_clipping = {
            "osmWayId": way["osmWayId"],
            "tags": dict(way["tags"]),
            "verticesOutsideBbox": len(outside),
            "islandNodesNearBboxEdge": len(touching),
        }
        return


def _nearby_ways_not_eligible_under_current_policy(
    island_points: Sequence[tuple[float, float]],
    osm_ways: Sequence[Mapping[str, Any]],
) -> list[dict[str, Any]]:
    """List nearby ways the current policy does not accept, without inferring graph history."""
    scored: list[tuple[float, dict[str, Any]]] = []
    for way in osm_ways:
        if way["eligibleUnderCurrentPolicy"]:
            continue
        distance = min(
            point_to_polyline_distance_m(point, way["coordinates"])
            for point in island_points
        )
        if distance > NEARBY_SEARCH_RADIUS_M:
            continue
        scored.append(
            (
                distance,
                {
                    "osmWayId": way["osmWayId"],
                    "distanceM": distance,
                    "tags": dict(way["tags"]),
                },
            )
        )
    scored.sort(key=lambda item: (item[0], item[1]["osmWayId"]))
    return [record for _, record in scored[:10]]


if __name__ == "__main__":
    raise SystemExit(main())
