#!/usr/bin/env python3
"""Add source-pinned sparse sidewalk ways to a new, sorted OSM PBF.

This is an offline data compiler. It does not build, serve, or promote OTP.
Unknown grades remain isolated; geometry proximity never creates a junction.
"""

from __future__ import annotations

import argparse
import base64
from bisect import bisect_right
from collections import defaultdict
from dataclasses import dataclass, field, replace
from fractions import Fraction
from functools import lru_cache
import hashlib
import heapq
import importlib.util
import json
import math
import os
from pathlib import Path
import sys
import tempfile
import zlib
from types import SimpleNamespace

import osmium
from shapely import get_coordinates, from_wkb
from shapely.errors import GEOSException
from shapely.geometry import LineString, Point, box
from shapely.ops import unary_union
from shapely.strtree import STRtree


def load_module(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot load {filename}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


BUILDER = load_module("otp_layer_builder", "build-ped-graph.py")
NETWORK = load_module("otp_layer_network", "ped-sidewalk-network.py")
TOPOLOGY = load_module("otp_layer_topology", "otp-sidewalk-topology.py")
MAX_REFS = 2000
ENDPOINT_PROOF_TAG = "asm:endpoint:proof:v1"
ENDPOINT_PROOF_RULE = "government-endpoint-v1"
ENDPOINT_PROOF_CHUNK_BYTES = 1000
ENDPOINT_PROOF_MAX_BYTES = 8 * 1024 * 1024
ENDPOINT_PROOF_MAX_COMPRESSED_BYTES = 2 * 1024 * 1024
ENDPOINT_PROOF_MAX_CHUNKS = 4096


def canonical_json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def proof_geometry(geometry, *, polygon_only=True):
    """Keep exact surfaces and complete width observations, without repairs."""
    allowed = {"Polygon", "MultiPolygon"} if polygon_only else {
        "Point", "LineString", "Polygon", "MultiPoint", "MultiLineString",
        "MultiPolygon", "GeometryCollection",
    }
    if geometry.geom_type not in allowed or geometry.is_empty or not geometry.is_valid or geometry.has_z or geometry.has_m:
        kind = "polygon" if polygon_only else "geometry"
        raise ValueError(f"Endpoint proof requires a valid nonempty 2D {kind}")
    for x, y in get_coordinates(geometry):
        if not math.isfinite(x) or not math.isfinite(y) or not (-180 <= x <= 180 and -90 <= y <= 90):
            raise ValueError("Endpoint proof has non-finite or out-of-range coordinates")
    value = geometry.wkb
    return dict(geometry_wkb_hex=value.hex(), geometry_sha256=hashlib.sha256(value).hexdigest())


def endpoint_proof(region, snapshot, closure_node_ids=()):
    """One content-bound proof shared by the region's unchanged derived ways."""
    surface = proof_geometry(region.geometry)
    closure_node_ids = sorted(set(closure_node_ids))
    eligibility = (
        "shared_precision_connector" if region.connector else
        "closure_affected" if closure_node_ids else
        "unknown_grade" if not known_plane(region.plane) else "eligible"
    )
    width = NETWORK.surface_clearance(region.width_source)
    observations = []
    for geometry, source in region.width_observations:
        # Width overlays may include linear contacts alongside polygons. Their
        # positive-length intersections govern width, so retain every component.
        observation = proof_geometry(geometry, polygon_only=False)
        observed_width = NETWORK.surface_clearance(source)
        observation.update(source_refs=[source.source_id], known=observed_width is not None, width_m=observed_width)
        observations.append(observation)
    observations = sorted({canonical_json(item): item for item in observations}.values(), key=canonical_json)
    payload = dict(
        crs="EPSG:4326", rule_version=ENDPOINT_PROOF_RULE,
        region_kind="shared_surface_precision_connector" if region.connector else "effective_surface",
        eligibility=eligibility, closure_node_ids=closure_node_ids,
        source_version=str(snapshot.version_id), source_batch=snapshot.source_batch,
        source_sha256=snapshot.archive_sha256,
        source_refs=sorted(region.source_refs or (region.surface.source_id,)),
        grade=list(region.plane), grade_known=known_plane(region.plane),
        surface_wkb_hex=surface["geometry_wkb_hex"], surface_sha256=surface["geometry_sha256"],
        width_base=dict(known=width is not None, width_m=width, source_refs=[region.width_source.source_id]),
        width_observations=observations,
    )
    payload_json = canonical_json(payload)
    value = canonical_json(dict(schema_version=1, region_id=hashlib.sha256(payload_json.encode("utf-8")).hexdigest(), payload_json=payload_json))
    decode_endpoint_proof(value)
    return value


def decode_endpoint_proof(value):
    """Strict readback oracle for the private, pinned PBF proof contract."""
    def unique(pairs):
        result = {}
        for key, item in pairs:
            if key in result:
                raise ValueError("Duplicate endpoint proof key")
            result[key] = item
        return result

    def parse(text):
        return json.loads(text, object_pairs_hook=unique, parse_constant=lambda value: (_ for _ in ()).throw(ValueError("Non-finite endpoint proof number")))

    def keys(item, required):
        if not isinstance(item, dict) or set(item) != set(required.split()):
            raise ValueError("Invalid endpoint proof fields")

    def digest(value):
        return isinstance(value, str) and len(value) == 64 and all(character in "0123456789abcdef" for character in value)

    def refs(value):
        if not isinstance(value, list) or not value or any(not isinstance(item, str) or not item for item in value) or value != sorted(set(value)):
            raise ValueError("Invalid endpoint proof source refs")

    def width(item):
        refs(item["source_refs"])
        amount = item["width_m"]
        if type(item["known"]) is not bool or (item["known"] and (type(amount) not in (int, float) or not math.isfinite(amount) or amount <= 0)) or (not item["known"] and amount is not None):
            raise ValueError("Invalid endpoint proof width")

    def geometry(encoded, expected, *, polygon_only=True):
        if not isinstance(encoded, str) or not digest(expected):
            raise ValueError("Invalid endpoint proof geometry fields")
        raw = bytes.fromhex(encoded)
        if raw.hex() != encoded or hashlib.sha256(raw).hexdigest() != expected:
            raise ValueError("Endpoint proof geometry hash mismatch")
        try:
            actual = proof_geometry(from_wkb(raw), polygon_only=polygon_only)
        except GEOSException as error:
            raise ValueError("Invalid endpoint proof WKB") from error
        if actual["geometry_wkb_hex"] != encoded:
            raise ValueError("Endpoint proof requires exact 2D WKB")

    envelope = parse(value)
    keys(envelope, "schema_version region_id payload_json")
    if type(envelope["schema_version"]) is not int or envelope["schema_version"] != 1 or not digest(envelope["region_id"]) or not isinstance(envelope["payload_json"], str):
        raise ValueError("Invalid endpoint proof version or identity")
    if hashlib.sha256(envelope["payload_json"].encode("utf-8")).hexdigest() != envelope["region_id"]:
        raise ValueError("Endpoint proof region identity mismatch")
    payload = parse(envelope["payload_json"])
    keys(payload, "crs rule_version region_kind eligibility closure_node_ids source_version source_batch source_sha256 source_refs grade grade_known surface_wkb_hex surface_sha256 width_base width_observations")
    if payload["crs"] != "EPSG:4326" or payload["rule_version"] != ENDPOINT_PROOF_RULE:
        raise ValueError("Unsupported endpoint proof CRS or rule")
    for key in ("source_version", "source_batch"):
        if not isinstance(payload[key], str) or not payload[key]:
            raise ValueError("Invalid endpoint proof source identity")
    if not digest(payload["source_sha256"]):
        raise ValueError("Invalid endpoint proof source digest")
    refs(payload["source_refs"])
    grade = payload["grade"]
    if not isinstance(grade, list) or len(grade) != 4 or any(item is not None and (not isinstance(item, str) or not item) for item in grade) or type(payload["grade_known"]) is not bool or payload["grade_known"] != known_plane(grade):
        raise ValueError("Invalid endpoint proof grade")
    closures = payload["closure_node_ids"]
    if not isinstance(closures, list) or any(type(item) is not int or item <= 0 for item in closures) or closures != sorted(set(closures)):
        raise ValueError("Invalid endpoint proof closure identity")
    if payload["region_kind"] not in {"effective_surface", "shared_surface_precision_connector"}:
        raise ValueError("Invalid endpoint proof region kind")
    expected_eligibility = "shared_precision_connector" if payload["region_kind"] == "shared_surface_precision_connector" else "closure_affected" if closures else "unknown_grade" if not payload["grade_known"] else "eligible"
    if payload["eligibility"] != expected_eligibility:
        raise ValueError("Invalid endpoint proof eligibility")
    geometry(payload["surface_wkb_hex"], payload["surface_sha256"])
    keys(payload["width_base"], "known width_m source_refs")
    width(payload["width_base"])
    if not isinstance(payload["width_observations"], list):
        raise ValueError("Invalid endpoint proof width observations")
    for observation in payload["width_observations"]:
        keys(observation, "geometry_wkb_hex geometry_sha256 source_refs known width_m")
        geometry(observation["geometry_wkb_hex"], observation["geometry_sha256"], polygon_only=False)
        width(observation)
    return envelope, payload


def endpoint_proof_tags(value):
    envelope, _ = decode_endpoint_proof(value)
    raw = envelope["payload_json"].encode("utf-8")
    compressed = zlib.compress(raw, level=9)
    encoded = base64.b64encode(compressed).decode("ascii")
    chunks = [encoded[start:start + ENDPOINT_PROOF_CHUNK_BYTES] for start in range(0, len(encoded), ENDPOINT_PROOF_CHUNK_BYTES)]
    supported = len(raw) <= ENDPOINT_PROOF_MAX_BYTES and len(compressed) <= ENDPOINT_PROOF_MAX_COMPRESSED_BYTES and len(chunks) <= ENDPOINT_PROOF_MAX_CHUNKS
    manifest = dict(schema_version=1, status="supported" if supported else "unsupported",
        encoding="zlib-base64", region_id=envelope["region_id"], payload_bytes=len(raw),
        compressed_bytes=len(compressed), chunk_count=len(chunks), chunk_size=ENDPOINT_PROOF_CHUNK_BYTES)
    if not supported:
        manifest["reason"] = "payload_limits"
    return {ENDPOINT_PROOF_TAG: canonical_json(manifest), **({
        f"{ENDPOINT_PROOF_TAG}:{index:06d}": chunk for index, chunk in enumerate(chunks)
    } if supported else {})}


def decode_endpoint_proof_tags(tags):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("Duplicate endpoint proof manifest field")
            result[key] = value
        return result
    manifest = json.loads(tags[ENDPOINT_PROOF_TAG], object_pairs_hook=unique)
    required = {"schema_version", "status", "encoding", "region_id", "payload_bytes", "compressed_bytes", "chunk_count", "chunk_size"}
    if not isinstance(manifest, dict) or set(manifest) != required | ({"reason"} if manifest.get("status") == "unsupported" else set()):
        raise ValueError("Invalid endpoint proof manifest fields")
    if type(manifest["schema_version"]) is not int or manifest["schema_version"] != 1 or manifest["encoding"] != "zlib-base64" or manifest["status"] not in {"supported", "unsupported"}:
        raise ValueError("Invalid endpoint proof manifest version or encoding")
    for key in ("payload_bytes", "compressed_bytes", "chunk_count", "chunk_size"):
        if type(manifest[key]) is not int or manifest[key] <= 0:
            raise ValueError("Invalid endpoint proof size")
    if manifest["chunk_size"] != ENDPOINT_PROOF_CHUNK_BYTES or not isinstance(manifest["region_id"], str) or len(manifest["region_id"]) != 64 or any(c not in "0123456789abcdef" for c in manifest["region_id"]):
        raise ValueError("Invalid endpoint proof chunk size or identity")
    over_limit = manifest["payload_bytes"] > ENDPOINT_PROOF_MAX_BYTES or manifest["compressed_bytes"] > ENDPOINT_PROOF_MAX_COMPRESSED_BYTES or manifest["chunk_count"] > ENDPOINT_PROOF_MAX_CHUNKS
    private = {key for key in tags if key.startswith(ENDPOINT_PROOF_TAG + ":")}
    if manifest["status"] == "unsupported":
        if manifest["reason"] != "payload_limits" or not over_limit or private:
            raise ValueError("Invalid unsupported endpoint proof declaration")
        return manifest, None
    if over_limit:
        raise ValueError("Endpoint proof exceeds size limits")
    expected = [f"{ENDPOINT_PROOF_TAG}:{index:06d}" for index in range(manifest["chunk_count"])]
    if private != set(expected):
        raise ValueError("Missing or extra endpoint proof chunk")
    chunks = [tags[key] for key in expected]
    for index, chunk in enumerate(chunks):
        if not isinstance(chunk, str) or not chunk.isascii() or not (0 < len(chunk) <= ENDPOINT_PROOF_CHUNK_BYTES) or (index < len(chunks) - 1 and len(chunk) != ENDPOINT_PROOF_CHUNK_BYTES):
            raise ValueError("Invalid endpoint proof chunk length")
    compressed = base64.b64decode("".join(chunks), validate=True)
    if len(compressed) != manifest["compressed_bytes"]:
        raise ValueError("Endpoint proof compressed size mismatch")
    inflater = zlib.decompressobj()
    raw = inflater.decompress(compressed, manifest["payload_bytes"] + 1)
    if len(raw) != manifest["payload_bytes"] or not inflater.eof or inflater.unused_data or inflater.unconsumed_tail:
        raise ValueError("Endpoint proof decompressed size or stream mismatch")
    value = canonical_json(dict(schema_version=1, region_id=manifest["region_id"], payload_json=raw.decode("utf-8")))
    _, payload = decode_endpoint_proof(value)
    return manifest, payload


class PrecisionError(ValueError):
    pass


class PortPrecisionErrors(PrecisionError):
    def __init__(self, failures):
        self.failures = failures
        super().__init__(f"OSM coordinate precision failed for {len(failures)} contact groups")


@dataclass(frozen=True)
class QuantizedTopology:
    paths: tuple


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


COMPILER_SOURCE_SHA256 = sha256(Path(__file__))
TOPOLOGY_SOURCE_SHA256 = sha256(Path(TOPOLOGY.__file__))
DEPENDENCY_SOURCE_SHA256 = {
    filename: sha256(Path(__file__).with_name(filename))
    for filename in (
        "build-ped-graph.py", "ped-sidewalk-network.py", "ped-osm-areas.py",
        "osm-area-polygon-features.json",
    )
}


def known_plane(plane):
    return all(value is not None and not str(value).startswith("opaque:") for value in plane)


def required_negative_area(tags):
    return BUILDER.pedestrian_access_is_denied(tags) or tags.get("natural") == "water"


def grid_candidates(coordinate):
    x, y = (round(value * 1e7) for value in coordinate)
    points = [((x + dx) / 1e7, (y + dy) / 1e7) for dx in range(-2, 3) for dy in range(-2, 3)]
    return sorted(points, key=lambda p: ((p[0] - coordinate[0]) ** 2 + (p[1] - coordinate[1]) ** 2, p))


@dataclass
class Region:
    surface: object
    geometry: object
    plane: tuple
    width_source: object
    ports: dict = field(default_factory=lambda: defaultdict(set))
    connector: tuple = ()
    source_refs: tuple = ()
    source_surfaces: tuple = ()
    width_observations: tuple = ()


@dataclass(frozen=True)
class Piece:
    id: int
    nodes: tuple[int, ...]
    tags: dict


class InputInventory(osmium.SimpleHandler):
    def __init__(self, allow_endpoint_proof=True):
        super().__init__()
        self.maximum = dict(n=0, w=0, r=0)
        self.counts = dict(n=0, w=0, r=0)
        self.phase = 0
        self.allow_endpoint_proof = allow_endpoint_proof

    def record(self, kind, ident):
        phase = "nwr".index(kind)
        if phase < self.phase or ident <= self.maximum[kind]:
            raise ValueError("Input PBF must have sorted, unique positive entity IDs")
        self.phase = phase
        self.maximum[kind] = ident
        self.counts[kind] += 1

    def node(self, item):
        self.record("n", item.id)

    def way(self, item):
        if not self.allow_endpoint_proof and any(key.startswith(ENDPOINT_PROOF_TAG) for key, _ in item.tags):
            raise ValueError(f"Original OSM way {item.id} uses the reserved endpoint proof namespace")
        self.record("w", item.id)

    def relation(self, item):
        self.record("r", item.id)


class Identifiers:
    def __init__(self, inventory):
        self.maximum = dict(inventory.maximum)
        self.coordinates = {}
        self.identities = {}

    def next(self, kind):
        self.maximum[kind] += 1
        if self.maximum[kind] >= 2**63:
            raise ValueError("OSM identifier range exhausted")
        return self.maximum[kind]

    def port(self, key, coordinate):
        if key not in self.identities:
            ident = self.next("n")
            self.identities[key] = ident
            self.coordinates[ident] = tuple(coordinate)
        return self.identities[key]


def context(pbf, snapshot, bbox):
    extent = box(*bbox) if bbox else None
    sources = [s for s in snapshot.surfaces if extent is None or s.geometry.intersects(extent)]
    excluded = []
    valid = []
    for source in sources:
        geometry = source.geometry
        if geometry.is_empty or geometry.geom_type not in {"Polygon", "MultiPolygon"} or not geometry.is_valid:
            excluded.append(dict(source_id=source.source_id, reason="invalid_source_geometry"))
            continue
        bounds = geometry.bounds
        if not (-180 <= bounds[0] <= bounds[2] <= 180 and -90 <= bounds[1] <= bounds[3] <= 90):
            excluded.append(dict(source_id=source.source_id, reason="out_of_range_source_geometry"))
            continue
        valid.append(source)
    if not valid:
        raise ValueError("No valid source surfaces in selected extent")
    bounds = (
        min(s.geometry.bounds[0] for s in valid) - 0.0005,
        min(s.geometry.bounds[1] for s in valid) - 0.0005,
        max(s.geometry.bounds[2] for s in valid) + 0.0005,
        max(s.geometry.bounds[3] for s in valid) + 0.0005,
    )
    area_api = BUILDER.load_local_module("otp_layer_areas", "ped-osm-areas.py")
    areas = area_api.collect_areas(
        pbf, bounds, required_negative_area,
        NETWORK.VEHICLE_HIGHWAYS, exclude_invalid=True,
    )
    ways, invalid_ways = BUILDER.collect_walk_ways(
        pbf, bounds, include_observations=True, include_building_outlines=False,
    )
    ways = [way for way in ways if way.osm_id not in areas.excluded_way_ids]
    node_tags = BUILDER.collect_node_tags(pbf, {node.osm_id for way in ways for node in way.nodes})
    lines = [NETWORK.way_line(way) for way in ways]
    way_tree = STRtree(lines)
    area_way_ids = {a.osm_id for a in areas.records if a.source_kind == "way"} | areas.delegated_outer_ids
    observations = []
    for way, line in zip(ways, lines, strict=True):
        observation = NETWORK.negative_observation(BUILDER, way, line, linear_only=True)
        if observation is not None and not (observation.kind == "building" and way.osm_id in area_way_ids):
            observations.append(observation)
    for area in areas.records:
        kind = (
            "building" if any(area.tags.get(k) not in (None, "no") for k in ("building", "building:part"))
            else "road" if area.tags.get("highway") in NETWORK.VEHICLE_HIGHWAYS or area.tags.get("area:highway") in NETWORK.VEHICLE_HIGHWAYS
            else "denied"
        )
        observations.append(NETWORK.NegativeObservation(
            area, area.geometry, kind, area.qualification,
            NETWORK.known_width(BUILDER.parse_measurement_m(area.tags.get("width"))), True,
        ))
    confirmed, potential = NETWORK.corridor_context(valid, ways, way_tree)
    planes = {
        surface.source_id: NETWORK.resolve_surface_grade(
            surface, [ways[int(i)] for i in way_tree.query(surface.geometry)],
            node_tags, confirmed[surface.source_id],
        ) for surface in valid
    }
    return valid, ways, node_tags, observations, confirmed, potential, planes, {
        "excluded_sources": excluded,
        "invalid_osm_way_locations": invalid_ways,
        "osm_areas": dict(areas.statistics),
    }


def make_regions(sources, observations, planes, confirmed, potential, report):
    source_tree = STRtree([s.geometry for s in sources])
    negative_tree = STRtree([o.geometry for o in observations])
    denied = [s for s in sources if BUILDER.pedestrian_access_is_denied(s.raw)]
    denied_tree = STRtree([s.geometry for s in denied])
    regions = []
    records = {}
    for surface in sources:
        plane, grade_witness = planes[surface.source_id]
        record = dict(
            source_id=surface.source_id, county=surface.county,
            source_geometry_sha256=hashlib.sha256(surface.geometry.wkb).hexdigest(),
            raw_properties=surface.raw, quality_flags=surface.quality_flags,
            width_m=surface.width_m, effective_width_m=surface.effective_width_m,
            grade=list(plane), grade_resolution=grade_witness,
            confirmed_osm_way_ids=[w.osm_id for w in confirmed[surface.source_id]],
            potential_osm_way_ids=[w.osm_id for w in potential[surface.source_id]],
            generated_way_ids=[], ports=[], status="compiled",
        )
        records[surface.source_id] = record
        if BUILDER.pedestrian_access_is_denied(surface.raw):
            record["status"] = "access_denied"
            continue
        exclusions, witnesses = NETWORK.surface_exclusions(
            surface, plane, [observations[int(i)] for i in negative_tree.query(surface.geometry)],
        )
        conflicts = [
            denied[int(i)] for i in denied_tree.query(surface.geometry)
            if NETWORK.compatible_grade(plane, planes[denied[int(i)].source_id][0])
        ]
        exclusions.extend(s.geometry for s in conflicts)
        record["negative_geometry"] = witnesses
        record["excluded_access_source_ids"] = [s.source_id for s in conflicts]
        effective = surface.geometry.difference(unary_union(exclusions)) if exclusions else surface.geometry
        width_observations = tuple(
            (geometry, governing) for geometry, governing in NETWORK.width_regions(
                BUILDER, surface, effective, plane, sources, source_tree, planes,
            ) if governing is not None
        )
        record["width_constraints"] = [dict(
            source_id=governing.source_id,
            width_m=NETWORK.surface_clearance(governing),
            geometry_sha256=hashlib.sha256(geometry.wkb).hexdigest(),
        ) for geometry, governing in width_observations]
        for polygon in NETWORK.polygon_parts(effective):
            region = Region(surface, polygon, plane, surface)
            region.width_observations = tuple((geometry, governing) for geometry, governing in width_observations if geometry.intersects(polygon))
            regions.append(region)
        if effective.is_empty or effective.area == 0:
            record["status"] = "excluded_by_observations"
    report["sources"] = records
    return regions


def safe_port_node(tags):
    return not BUILDER.pedestrian_access_is_denied(tags) and tags.get("barrier") not in {
        "wall", "fence", "retaining_wall", "city_wall", "block",
    }


def interior_contact_candidates(geometry, original):
    candidates = set(grid_candidates(original))
    for polygon in NETWORK.polygon_parts(geometry):
        anchors = [tuple(polygon.representative_point().coords[0]), *polygon.exterior.coords]
        for ring in polygon.interiors:
            anchors.extend(ring.coords)
        for anchor in anchors:
            candidates.update(grid_candidates(anchor))
    return sorted(
        (point for point in candidates if geometry.covers(Point(point))),
        key=lambda point: (math.dist(point, original), point),
    )


@lru_cache(maxsize=256)
def rational_surface_rings(surface_wkb):
    """Retain the exact binary64 coordinates, without grid snapping or repair."""
    surface = from_wkb(surface_wkb)
    return tuple(
        tuple(tuple(tuple(Fraction(value) for value in point[:2]) for point in ring.coords)
              for ring in (polygon.exterior, *polygon.interiors))
        for polygon in NETWORK.polygon_parts(surface)
    )


def exact_connector_coverage(surface, line):
    """Reject rounded-predicate false positives before selecting a connector."""
    if not surface.covers(line):
        return False
    polygons = rational_surface_rings(surface.wkb)
    points = [tuple(Fraction(value) for value in point[:2]) for point in line.coords]

    def cross(a, b):
        return a[0] * b[1] - a[1] * b[0]

    def subtract(a, b):
        return a[0] - b[0], a[1] - b[1]

    def ring_location(ring, point):
        inside = False
        for a, b in zip(ring, ring[1:]):
            if min(a[1], b[1]) <= point[1] <= max(a[1], b[1]):
                orientation = cross(subtract(b, a), subtract(point, a))
                if orientation == 0 and min(a[0], b[0]) <= point[0] <= max(a[0], b[0]):
                    return 0
                if (a[1] > point[1]) != (b[1] > point[1]) and (orientation > 0) == (b[1] > a[1]):
                    inside = not inside
        return 1 if inside else -1

    def covered(point):
        for rings in polygons:
            shell = ring_location(rings[0], point)
            if shell == 0:
                return True
            if shell < 0:
                continue
            holes = [ring_location(ring, point) for ring in rings[1:]]
            if 0 in holes or 1 not in holes:
                return True
        return False

    if not all(covered(point) for point in points):
        return False
    for a, b in zip(points, points[1:]):
        ab = subtract(b, a)
        if ab == (0, 0):
            continue
        breaks = {Fraction(0), Fraction(1)}
        for rings in polygons:
            for ring in rings:
                for c, d in zip(ring, ring[1:]):
                    if (max(a[0], b[0]) < min(c[0], d[0]) or max(c[0], d[0]) < min(a[0], b[0])
                            or max(a[1], b[1]) < min(c[1], d[1]) or max(c[1], d[1]) < min(a[1], b[1])):
                        continue
                    cd, ca = subtract(d, c), subtract(c, a)
                    denominator = cross(ab, cd)
                    if denominator:
                        t, u = cross(ca, cd) / denominator, cross(ca, ab) / denominator
                        if 0 <= t <= 1 and 0 <= u <= 1:
                            breaks.add(t)
                    elif cross(ca, ab) == 0:
                        axis = 0 if ab[0] else 1
                        t0, t1 = (c[axis] - a[axis]) / ab[axis], (d[axis] - a[axis]) / ab[axis]
                        low, high = max(Fraction(0), min(t0, t1)), min(Fraction(1), max(t0, t1))
                        if low <= high:
                            breaks.update((low, high))
        ordered = sorted(breaks)
        for low, high in zip(ordered, ordered[1:]):
            middle = (low + high) / 2
            if not covered((a[0] + ab[0] * middle, a[1] + ab[1] * middle)):
                return False
    return True


def covered_contact_paths(allowed, choices, allow_bends=False):
    rounded_false_positive = False

    def covered_candidate(primary, point):
        nonlocal rounded_false_positive
        line = LineString([primary, point])
        if not allowed.covers(line):
            return False
        if exact_connector_coverage(allowed, line):
            return True
        rounded_false_positive = True
        return False

    for primary in choices[0]:
        alternatives = [next((point for point in group if covered_candidate(primary, point)), None) for group in choices[1:]]
        if all(point is not None for point in alternatives):
            return [(primary, primary), *((primary, point) for point in alternatives)]
    # An exact rejection must try the existing visibility path before giving up
    # the represented contact. Keep the original endpoint candidate ordering.
    if (allow_bends or rounded_false_positive) and all(choices):
        primary = choices[0][0]
        paths = [visible_grid_path(allowed, primary, group[0], exact=True) for group in choices[1:]]
        if all(path is not None for path in paths):
            return [(primary, primary), *map(tuple, paths)]
    return None


def attach_ports(regions, ways, node_tags, identifiers, records):
    tree = STRtree([region.geometry for region in regions])
    cuts = defaultdict(dict)
    node_planes = defaultdict(set)
    for way in ways:
        if BUILDER.should_include_way(way.tags):
            for node in way.nodes:
                node_planes[node.osm_id].add(NETWORK.grade(way.tags))
    for way in ways:
        if not BUILDER.should_include_way(way.tags) or BUILDER.pedestrian_access_is_denied(way.tags):
            continue
        plane = NETWORK.grade(way.tags)
        if not known_plane(plane):
            continue
        pedestrian = way.tags.get("highway") not in NETWORK.VEHICLE_HIGHWAYS
        for segment_index, (left, right) in enumerate(zip(way.nodes, way.nodes[1:])):
            line = LineString([(left.lon, left.lat), (right.lon, right.lat)])
            if not line.length:
                continue
            for index in tree.query(line):
                region = regions[int(index)]
                if not known_plane(region.plane) or region.plane != plane:
                    continue
                if pedestrian:
                    points = NETWORK.intersection_points(line.intersection(region.geometry))
                else:
                    points = [
                        Point(node.lon, node.lat) for node in (left, right)
                        if (node_tags.get(node.osm_id, {}).get("highway") == "crossing"
                            or node_tags.get(node.osm_id, {}).get("entrance") not in (None, "no"))
                        and region.geometry.covers(Point(node.lon, node.lat))
                    ]
                for point in points:
                    coordinate = tuple(point.coords[0])
                    original = next((n for n in (left, right) if coordinate == (n.lon, n.lat)), None)
                    if original is not None:
                        if not safe_port_node(node_tags.get(original.osm_id, {})) or node_planes[original.osm_id] != {plane}:
                            continue
                        ident = original.osm_id
                    else:
                        position = line.project(point, normalized=True)
                        key = (segment_index, position)
                        ident = identifiers.port(("osm-cut", way.osm_id, *key), coordinate)
                        cuts[way.osm_id][key] = ident
                    region.ports[coordinate].add(ident)
                    records[region.surface.source_id]["ports"].append(dict(
                        osm_way_id=way.osm_id, node_id=ident, coordinate=coordinate,
                        region_index=int(index),
                        evidence="pedestrian_way_contact" if pedestrian else "tagged_crossing_or_entrance",
                    ))
    for index, region in enumerate(regions):
        for other_index in tree.query(region.geometry):
            other_index = int(other_index)
            if other_index <= index:
                continue
            other = regions[other_index]
            same_source = other.surface.source_id == region.surface.source_id
            if region.plane != other.plane or (not same_source and not known_plane(region.plane)):
                continue
            contact = region.geometry.intersection(other.geometry)
            if contact.is_empty:
                continue
            parts = contact.geoms if hasattr(contact, "geoms") else (contact,)
            for part_index, part in enumerate(parts):
                if part.geom_type == "Point":
                    records[region.surface.source_id].setdefault("unproven_zero_width_contacts", []).append(dict(
                        other_source_id=other.surface.source_id,
                        coordinate=tuple(part.coords[0]),
                        reason="point_only_contact_has_no_passage_width",
                    ))
                    continue
                point = part.interpolate(0.5, normalized=True) if part.geom_type in {"LineString", "LinearRing"} else part.representative_point()
                if not (region.geometry.covers(point) and other.geometry.covers(point)):
                    continue
                coordinate = tuple(point.coords[0])
                ident = identifiers.port(("source-contact", index, other_index, part_index), coordinate)
                region.ports[coordinate].add(ident)
                other.ports[coordinate].add(ident)
    return cuts


def quantize_ports(regions, identifiers, records):
    owners = defaultdict(list)
    for index, region in enumerate(regions):
        for coordinate, ids in region.ports.items():
            for ident in ids:
                owners[ident].append((index, region, coordinate))
    actual = {}
    assignments = {}
    connectors = []
    failures = []
    identity_keys = None
    def record_failure(ident, members, reason):
        nonlocal identity_keys
        if identity_keys is None:
            identity_keys = {value: key for key, value in identifiers.identities.items()}
        allowed = unary_union([region.geometry for _, region, _ in members])
        original = members[0][2]
        candidates = grid_candidates(original) if ident in identifiers.coordinates else [original]
        choices = [[point for point in candidates if region.geometry.covers(Point(point))] for _, region, _ in members]
        witnesses = []
        for group in choices[1:]:
            for first in choices[0]:
                for last in group:
                    line = LineString([first, last])
                    outside = line.difference(allowed)
                    witnesses.append(dict(coordinates=[first, last], covered=allowed.covers(line), outside_length=outside.length, outside_wkb=outside.wkb_hex))
        fragment_certificates = [certificate for _, region, _ in members if (certificate := unrepresentable_fragment(replace(region, ports={}))) is not None]
        evidence_class = (
            "derived_fragment_has_no_serializable_segment" if fragment_certificates
            else "fixed_osm_cut_has_no_covered_local_grid_point" if identity_keys.get(ident, (None,))[0] == "osm-cut"
            else "covered_connector_not_proven"
        )
        failures.append(dict(
            port_id=ident, identity=identity_keys.get(ident), reason=reason,
            decision="retain_sources_without_unproven_join",
            evidence_class=evidence_class, fragment_certificates=fragment_certificates,
            search_policy=(
                "local grid; all straight pairs of covered interior/boundary grid anchors; union visibility between nearest anchors"
                if identity_keys.get(ident, (None,))[0] == "source-contact"
                else "fixed original OSM cut; covered grid candidates within two coordinate units; original way not relocated"
            ),
            expanded_grid_choice_counts=[len(interior_contact_candidates(region.geometry, original)) for _, region, _ in members] if identity_keys.get(ident, (None,))[0] == "source-contact" else None,
            original_coordinate=original, union_wkb=allowed.wkb_hex,
            local_grid_choices=choices, coverage_witnesses=witnesses,
            contact_wkb=members[0][1].geometry.intersection(members[1][1].geometry).wkb_hex if len(members) == 2 else None,
            members=[dict(
                source_id=region.surface.source_id, county=region.surface.county,
                region_index=index, coordinate=coordinate, plane=region.plane,
                source_wkb=region.surface.geometry.wkb_hex, geometry_wkb=region.geometry.wkb_hex,
                raw=region.surface.raw, width_m=region.surface.width_m,
                effective_width_m=region.surface.effective_width_m,
                grade_resolution=records[region.surface.source_id].get("grade_resolution"),
                ports=[dict(coordinate=point, node_ids=sorted(ids)) for point, ids in region.ports.items()],
                negative_geometry=records[region.surface.source_id].get("negative_geometry", []),
            ) for index, region, coordinate in members],
        ))
    for ident, members in owners.items():
        original = members[0][2]
        candidates = grid_candidates(original) if ident in identifiers.coordinates else [original]
        selected = next((p for p in candidates if all(region.geometry.covers(Point(p)) for _, region, _ in members)), None)
        if selected is None:
            source_refs = tuple(sorted({region.surface.source_id for _, region, _ in members}))
            planes = {region.plane for _, region, _ in members}
            if len(members) < 2 or len(planes) != 1 or (len(source_refs) > 1 and not known_plane(members[0][1].plane)):
                record_failure(ident, members, "no_shared_covered_grid_point")
                continue
            allowed = unary_union([region.geometry for _, region, _ in members])
            choices = [[p for p in candidates if region.geometry.covers(Point(p))] for _, region, _ in members]
            paths = covered_contact_paths(allowed, choices)
            if paths is None:
                if identity_keys is None:
                    identity_keys = {value: key for key, value in identifiers.identities.items()}
                identity = identity_keys.get(ident, ())
                if identity and identity[0] == "source-contact":
                    choices = [interior_contact_candidates(region.geometry, original) for _, region, _ in members]
                    paths = covered_contact_paths(allowed, choices, allow_bends=True)
            if paths is None:
                record_failure(ident, members, "no_exact_covered_connector_proven")
                continue
            selected_points = [path[-1] for path in paths]
            selected = selected_points[0]
            widths = [region.width_source for _, region, _ in members]
            width_source = (
                min(widths, key=NETWORK.surface_clearance)
                if all(NETWORK.surface_clearance(source) is not None for source in widths)
                else replace(widths[0], width_m=None, effective_width_m=None)
            )
            for (index, region, _), point, path in zip(members, selected_points, paths, strict=True):
                if point == selected:
                    assignments[index, ident] = ident
                    continue
                private = identifiers.port(("precision-contact", ident, index), point)
                actual[private] = point
                assignments[index, ident] = private
                connector = Region(region.surface, allowed, region.plane, width_source)
                connector.ports[selected].add(ident)
                connector.ports[point].add(private)
                connector.connector = tuple(path)
                connector.source_refs = source_refs
                connector.source_surfaces = tuple({r.surface.source_id: r.surface for _, r, _ in members}.values())
                connector.width_observations = tuple(observation for _, r, _ in members for observation in r.width_observations)
                connectors.append(connector)
        actual[ident] = selected
        if ident in identifiers.coordinates:
            identifiers.coordinates[ident] = selected
    if failures:
        raise PortPrecisionErrors(failures)
    for index, region in enumerate(regions):
        ports = defaultdict(set)
        for ids in region.ports.values():
            for ident in ids:
                selected_id = assignments.get((index, ident), ident)
                ports[actual[selected_id]].add(selected_id)
        region.ports = ports
    for record in records.values():
        for port in record["ports"]:
            port["source_contact_coordinate"] = port["coordinate"]
            original_id = port["node_id"]
            port["node_id"] = assignments.get((port["region_index"], original_id), original_id)
            port["coordinate"] = actual[port["node_id"]]
            if port["node_id"] != original_id:
                port["osm_connection_node_id"] = original_id
                port["evidence"] += "_via_covered_precision_connector"
    return connectors


def remove_unproven_contacts(failures, regions, identifiers, records, cuts):
    failed = {failure["port_id"] for failure in failures}
    if any(not failure["identity"] or failure["identity"][0] not in {"source-contact", "osm-cut"} for failure in failures):
        raise PortPrecisionErrors(failures)
    for region in regions:
        for coordinate in list(region.ports):
            region.ports[coordinate].difference_update(failed)
            if not region.ports[coordinate]:
                del region.ports[coordinate]
    for record in records.values():
        record["ports"] = [port for port in record["ports"] if port["node_id"] not in failed]
    for failure in failures:
        for member in failure["members"]:
            records[member["source_id"]].setdefault("unproven_contact_ids", []).append(failure["port_id"])
    for way_cuts in cuts.values():
        for position in list(way_cuts):
            if way_cuts[position] in failed:
                del way_cuts[position]
    for ident in failed:
        identifiers.coordinates.pop(ident, None)
    for key in list(identifiers.identities):
        if identifiers.identities[key] in failed:
            del identifiers.identities[key]


def nonempty_quantized_paths(paths, region):
    positive = tuple(path for path in paths if len(set(path)) > 1)
    if positive:
        return QuantizedTopology(positive)
    if len(region.ports) <= 1:
        _, points = covered_lattice_points(region.geometry)
        starts = list(region.ports) if region.ports else points or []
        for left in starts:
            for right in reversed(points or []):
                if left != right and region.geometry.covers(LineString([left, right])):
                    return QuantizedTopology(((left, right),))
    raise PrecisionError(f"OSM coordinate precision collapses all paths for source {region.surface.source_id}")


def quantized_coordinates(topology, region):
    neighbours = defaultdict(set)
    for edge in topology.edges:
        for left, right in zip(edge.coordinates, edge.coordinates[1:]):
            neighbours[left].add(right)
            neighbours[right].add(left)
    chosen = {
        coordinate: coordinate if coordinate in region.ports else tuple(round(value * 1e7) / 1e7 for value in coordinate)
        for coordinate in neighbours
    }
    if all(region.geometry.covers(LineString([chosen[point] for point in edge.coordinates])) for edge in topology.edges):
        return nonempty_quantized_paths(tuple(tuple(chosen[p] for p in edge.coordinates) for edge in topology.edges), region)
    candidates = {}
    expanded = set()

    def options(coordinate, inward=False):
        if coordinate not in candidates or (inward and coordinate not in expanded):
            choices = [coordinate] if coordinate in region.ports else grid_candidates(coordinate)
            safe = [point for point in choices if region.geometry.covers(Point(point))]
            if (inward or not safe) and coordinate not in region.ports:
                expanded.add(coordinate)
                for neighbour in neighbours[coordinate]:
                    for fraction in (0.125, 0.25, 0.5, 0.75, 1):
                        internal = tuple(a + fraction * (b - a) for a, b in zip(coordinate, neighbour, strict=True))
                        safe.extend(point for point in grid_candidates(internal) if region.geometry.covers(Point(point)))
                if not safe:
                    visited = {coordinate}
                    frontier = {coordinate}
                    while frontier and not safe:
                        frontier = {n for current in frontier for n in neighbours[current]} - visited
                        visited.update(frontier)
                        for internal in frontier:
                            safe.extend(point for point in grid_candidates(internal) if region.geometry.covers(Point(point)))
                if not safe:
                    _, lattice_points = covered_lattice_points(region.geometry)
                    safe.extend(lattice_points or [])
                safe = sorted(set(safe), key=lambda p: ((p[0] - coordinate[0]) ** 2 + (p[1] - coordinate[1]) ** 2, p))
            candidates[coordinate] = safe
            if not safe:
                raise PrecisionError(f"OSM coordinate precision cannot represent source {region.surface.source_id}")
        return candidates[coordinate]

    for point in chosen:
        if not region.geometry.covers(Point(chosen[point])):
            chosen[point] = options(point)[0]
    for _ in range(4):
        invalid = [(a, b) for a, others in neighbours.items() for b in others if a < b and not region.geometry.covers(LineString([chosen[a], chosen[b]]))]
        if not invalid:
            return nonempty_quantized_paths(tuple(tuple(chosen[p] for p in edge.coordinates) for edge in topology.edges), region)
        changed = False
        for left, right in invalid:
            replacement = next((
                (a, b) for a in options(left) for b in options(right)
                if region.geometry.covers(LineString([a, b]))
                and all(region.geometry.covers(LineString([a, chosen[n]])) for n in neighbours[left] - {right})
                and all(region.geometry.covers(LineString([b, chosen[n]])) for n in neighbours[right] - {left})
            ), None)
            if replacement is None:
                replacement = next((
                    (a, b) for a in options(left, inward=True) for b in options(right, inward=True)
                    if region.geometry.covers(LineString([a, b]))
                    and all(region.geometry.covers(LineString([a, chosen[n]])) for n in neighbours[left] - {right})
                    and all(region.geometry.covers(LineString([b, chosen[n]])) for n in neighbours[right] - {left})
                ), None)
            if replacement is not None:
                chosen[left], chosen[right] = replacement
                changed = True
        if not changed:
            break
    resolved = []
    for edge in topology.edges:
        coordinates = edge.coordinates
        fixed = set(region.ports) | {p for p in (coordinates[0], coordinates[-1]) if len(neighbours[p]) > 2}
        if coordinates[0] == coordinates[-1]:
            fixed.add(coordinates[0])
        solution = None
        for inward in (False, True):
            levels = []
            for index, point in enumerate(coordinates):
                choices = [chosen[point]] if point in fixed else options(point, inward=inward)
                states = {}
                for candidate in choices:
                    cost = (candidate[0] - point[0]) ** 2 + (candidate[1] - point[1]) ** 2
                    if index == 0:
                        states[candidate] = (cost, None)
                        continue
                    eligible = [
                        (prior_cost + cost, prior)
                        for prior, (prior_cost, _) in levels[-1].items()
                        if candidate == prior or region.geometry.covers(LineString([prior, candidate]))
                    ]
                    if eligible:
                        states[candidate] = min(eligible)
                levels.append(states)
                if not states:
                    break
            if len(levels) == len(coordinates) and levels[-1]:
                current = min(levels[-1], key=lambda p: levels[-1][p][0])
                solution = []
                for level in reversed(levels):
                    solution.append(current)
                    current = level[current][1]
                solution.reverse()
                break
        if solution is None:
            solution = visible_grid_path(region.geometry, chosen[coordinates[0]], chosen[coordinates[-1]])
        if solution is None:
            raise PrecisionError(f"OSM coordinate precision cannot preserve internal path for source {region.surface.source_id}")
        resolved.append(tuple(solution))
    if all(region.geometry.covers(LineString(path)) for path in resolved):
        return nonempty_quantized_paths(tuple(resolved), region)
    raise PrecisionError(f"OSM coordinate precision cannot preserve internal path for source {region.surface.source_id}")


def visible_grid_path(geometry, start, end, *, exact=False):
    candidates = {start, end}
    for polygon in NETWORK.polygon_parts(geometry):
        for ring in (polygon.exterior, *polygon.interiors):
            for coordinate in ring.coords:
                safe = [point for point in grid_candidates(coordinate) if geometry.covers(Point(point))]
                candidates.update(safe[:3])
    distances = {start: 0.0}
    previous = {}
    queue = [(math.dist(start, end), 0.0, start)]
    while queue:
        _, distance, current = heapq.heappop(queue)
        if distance != distances[current]:
            continue
        if current == end:
            result = [end]
            while result[-1] != start:
                result.append(previous[result[-1]])
            return list(reversed(result))
        for point in sorted(candidates):
            next_distance = distance + math.dist(current, point)
            if point == current or next_distance >= distances.get(point, math.inf):
                continue
            line = LineString([current, point])
            if not (exact_connector_coverage(geometry, line) if exact else geometry.covers(line)):
                continue
            distances[point] = next_distance
            previous[point] = current
            heapq.heappush(queue, (next_distance + math.dist(point, end), next_distance, point))
    return None


def covered_lattice_points(geometry):
    west, south, east, north = geometry.bounds
    xs = range(math.ceil(west * 1e7), math.floor(east * 1e7) + 1)
    ys = range(math.ceil(south * 1e7), math.floor(north * 1e7) + 1)
    total = len(xs) * len(ys)
    if total <= 10000:
        return total, [(x / 1e7, y / 1e7) for x in xs for y in ys if geometry.covers(Point(x / 1e7, y / 1e7))]
    vertical = len(xs) < len(ys)
    rows, columns = (xs, ys) if vertical else (ys, xs)
    if len(rows) > 10000:
        return total, None
    points, visited = set(), 0
    def parts(geometry):
        if hasattr(geometry, "geoms"):
            for part in geometry.geoms:
                yield from parts(part)
        elif not geometry.is_empty:
            yield geometry
    for row in rows:
        scan = LineString([(row / 1e7, south), (row / 1e7, north)]) if vertical else LineString([(west, row / 1e7), (east, row / 1e7)])
        for part in parts(geometry.intersection(scan)):
            low, high = (part.bounds[1], part.bounds[3]) if vertical else (part.bounds[0], part.bounds[2])
            # Include the neighbouring grid units before the exact covers test;
            # this protects interval endpoints from multiplication rounding.
            candidates = range(max(columns.start, math.ceil(low * 1e7) - 1), min(columns.stop, math.floor(high * 1e7) + 2))
            visited += len(candidates)
            if visited > 10000:
                return total, None
            for column in candidates:
                point = (row / 1e7, column / 1e7) if vertical else (column / 1e7, row / 1e7)
                if geometry.covers(Point(point)):
                    points.add(point)
    return total, sorted(points)


def unrepresentable_fragment(region):
    if len(region.ports) > 1:
        return None
    total, points = covered_lattice_points(region.geometry)
    if points is None:
        return None
    if any(region.geometry.covers(LineString([left, right])) for index, left in enumerate(points) for right in points[index + 1:]):
        return None
    forward, _ = NETWORK.metric_transforms(region.geometry)
    return dict(
        reason="isolated_effective_geometry_has_no_representable_osm_segment",
        geometry_origin="original_source" if region.geometry.equals(region.surface.geometry) else "derived_fragment",
        source_id=region.surface.source_id,
        source_geometry_wkb=region.surface.geometry.wkb_hex,
        derived_geometry_wkb=region.geometry.wkb_hex,
        source_geometry_sha256=hashlib.sha256(region.surface.geometry.wkb).hexdigest(),
        derived_geometry_sha256=hashlib.sha256(region.geometry.wkb).hexdigest(),
        area_m2=NETWORK.transform(forward, region.geometry).area,
        candidate_lattice_points=total, covered_lattice_points=len(points),
        lattice_enumeration="complete_bbox" if total <= 10000 else "complete_polygon_grid_scanlines",
        authorized_ports=sum(map(len, region.ports.values())),
        retained_port_ids=sorted({ident for ids in region.ports.values() for ident in ids}),
        retained_port_coordinates=list(region.ports),
        retained_leaf_port=[dict(coordinate=coordinate, node_ids=sorted(ids)) for coordinate, ids in region.ports.items()],
    )


def finish_source_accounting(regions, report):
    effective = defaultdict(set)
    for region in regions:
        if not region.connector:
            effective[region.surface.source_id].add(hashlib.sha256(region.geometry.wkb).hexdigest())
    limited = defaultdict(set)
    for limitation in report["precision_limitations"]:
        limited[limitation["source_id"]].add(limitation["derived_geometry_sha256"])
    for source_id, record in report["sources"].items():
        record["precision_limited_effective_parts"] = len(limited[source_id])
        record["effective_parts"] = len(effective[source_id])
        if record["status"] == "compiled" and not record["generated_way_ids"]:
            if not effective[source_id] or effective[source_id] != limited[source_id]:
                raise ValueError(f"Source has no representable street path without complete evidence: {source_id}")
            record["status"] = "no_representable_effective_geometry"
        record["partially_limited"] = bool(record["generated_way_ids"] and (limited[source_id] or record.get("unproven_contact_ids")))


def denied_geometry(sources, planes, observations):
    result = [(s.geometry, planes[s.source_id][0]) for s in sources if BUILDER.pedestrian_access_is_denied(s.raw)]
    for observation in observations:
        tags = observation.way.tags
        if observation.kind == "road" and not observation.areal:
            continue
        if not (required_negative_area(tags) or observation.kind == "barrier"):
            continue
        geometry = observation.geometry
        if geometry.geom_type not in {"Polygon", "MultiPolygon"}:
            forward, reverse = NETWORK.metric_transforms(geometry)
            geometry = NETWORK.transform(reverse, NETWORK.transform(forward, geometry).buffer(0.01))
        result.append((geometry, observation.plane))
    return result


def split_ways(ways, cuts, sources, planes, confirmed, identifiers, denials):
    source_tree = STRtree([s.geometry for s in sources])
    sidewalk_observations = [
        (NETWORK.way_line(way), way.tags) for way in ways
        if way.tags.get("footway") == "sidewalk" and BUILDER.should_include_way(way.tags)
    ]
    observation_tree = STRtree([geometry for geometry, _ in sidewalk_observations])
    replacements = {}
    masked = []
    denial_tree = STRtree([geometry for geometry, _ in denials])
    for way in ways:
        full_line = NETWORK.way_line(way)
        forbidden = (
            NETWORK.road_forbidden_intervals(
                way, sources, source_tree, sidewalk_observations, observation_tree, confirmed, planes,
            ) if way.tags.get("area") != "yes" and way.tags.get("footway") != "crossing" else []
        )
        closure_intervals = []
        offset = 0.0
        for left, right in zip(way.nodes, way.nodes[1:]):
            segment = LineString([(left.lon, left.lat), (right.lon, right.lat)])
            for index in denial_tree.query(segment):
                geometry, plane = denials[int(index)]
                if not NETWORK.compatible_grade(plane, NETWORK.grade(way.tags)):
                    continue
                contact = segment.intersection(geometry)
                points = NETWORK.intersection_points(contact)
                if points:
                    distances = [offset + segment.project(point) for point in points]
                    closure_intervals.append((min(distances), max(distances)))
            offset += segment.length
        forbidden = [*forbidden, *closure_intervals]
        own_cuts = dict(cuts.get(way.osm_id, {}))
        mask_ids = set()
        offset = 0.0
        positions = [0.0]
        for segment_index, (left, right) in enumerate(zip(way.nodes, way.nodes[1:])):
            length = math.hypot(right.lon - left.lon, right.lat - left.lat)
            for low, high in forbidden:
                for distance in (low, high):
                    if length and offset < distance < offset + length:
                        fraction = (distance - offset) / length
                        key = (segment_index, fraction)
                        coordinate = (left.lon + fraction * (right.lon - left.lon), left.lat + fraction * (right.lat - left.lat))
                        if key not in own_cuts:
                            own_cuts[key] = identifiers.port(("road-mask", way.osm_id, *key), coordinate)
                            mask_ids.add(own_cuts[key])
            offset += length
            positions.append(offset)
        if not own_cuts and not forbidden and len(way.nodes) <= MAX_REFS:
            continue
        entries = []
        for segment_index, node in enumerate(way.nodes):
            entries.append((node.osm_id, positions[segment_index], True))
            if segment_index < len(way.nodes) - 1:
                length = positions[segment_index + 1] - positions[segment_index]
                for (seg, fraction), ident in sorted(own_cuts.items()):
                    if seg == segment_index:
                        entries.append((ident, positions[segment_index] + fraction * length, True))
        coordinates = {node.osm_id: (node.lon, node.lat) for node in way.nodes}
        coordinates.update({ident: tuple(round(value, 7) for value in identifiers.coordinates[ident]) for ident, _, _ in entries if ident in identifiers.coordinates})
        relevant_denials = [geometry for index in denial_tree.query(full_line) for geometry, plane in [denials[int(index)]] if NETWORK.compatible_grade(plane, NETWORK.grade(way.tags))]
        # Both boundary nodes of an allowed interval must be solved together:
        # its far endpoint may still round inside a different closure.
        allowed_segments = [
            not any(low <= (left[1] + right[1]) / 2 <= high for low, high in forbidden)
            for left, right in zip(entries, entries[1:])
        ]
        index = 0
        while index < len(allowed_segments):
            if not allowed_segments[index]:
                index += 1
                continue
            first = index
            while index < len(allowed_segments) and allowed_segments[index]:
                index += 1
            levels = []
            for position in range(first, index + 1):
                ident = entries[position][0]
                original = identifiers.coordinates.get(ident, coordinates[ident])
                choices = grid_candidates(original) if ident in mask_ids else [coordinates[ident]]
                states = {}
                for candidate in choices:
                    cost = math.dist(candidate, original) ** 2
                    if not levels:
                        states[candidate] = (cost, None)
                        continue
                    previous = [
                        (prior_cost + cost, prior) for prior, (prior_cost, _) in levels[-1].items()
                        if not any(LineString([prior, candidate]).intersection(geometry).length > 0 for geometry in relevant_denials)
                    ]
                    if previous:
                        states[candidate] = min(previous)
                if not states:
                    raise PrecisionError(f"OSM coordinate precision cannot preserve closure boundary on original way {way.osm_id}")
                levels.append(states)
            current = min(levels[-1], key=lambda point: levels[-1][point][0])
            for position, level in zip(range(index, first - 1, -1), reversed(levels), strict=True):
                coordinates[entries[position][0]] = current
                current = level[current][1]
        for ident in mask_ids:
            identifiers.coordinates[ident] = coordinates[ident]
        pieces = []
        start = 0
        for end in range(1, len(entries)):
            midpoint = (entries[end - 1][1] + entries[end][1]) / 2
            denied = any(low <= midpoint <= high for low, high in forbidden)
            next_denied = (
                any(low <= (entries[end][1] + entries[end + 1][1]) / 2 <= high for low, high in forbidden)
                if end + 1 < len(entries) else denied
            )
            is_port = entries[end][0] in own_cuts.values()
            if end + 1 < len(entries) and denied == next_denied and not is_port and end - start + 1 < MAX_REFS:
                continue
            refs = tuple(item[0] for item in entries[start:end + 1])
            if len(set(refs)) < 2:
                start = end
                continue
            tags = dict(way.tags)
            if denied:
                tags["foot"] = "no"
                tags["source:foot"] = "observed_closure_or_separate_sidewalk"
            ident = way.osm_id if not pieces else identifiers.next("w")
            pieces.append(Piece(ident, refs, tags))
            start = end
        if not pieces:
            raise ValueError(f"OSM way {way.osm_id} lost all geometry while splitting")
        replacements[way.osm_id] = pieces
        if forbidden:
            masked.append(dict(osm_way_id=way.osm_id, intervals=forbidden, pieces=[dict(id=p.id, foot=p.tags.get("foot")) for p in pieces]))
    return replacements, masked


def derived_tags(region, snapshot, coordinates):
    surface = region.surface
    line = LineString(coordinates)
    width_sources = [region.width_source]
    observations = [(geometry, source) for geometry, source in region.width_observations if line.intersection(geometry).length > 0]
    width_sources.extend(source for _, source in observations)
    known_sources = [source for source in width_sources if NETWORK.surface_clearance(source) is not None]
    governing = min(known_sources, key=NETWORK.surface_clearance) if known_sources else None
    if NETWORK.surface_clearance(region.width_source) is None:
        covered = unary_union([geometry for geometry, source in observations if NETWORK.surface_clearance(source) is not None])
        if not covered.covers(line):
            governing = None
    if region.connector and NETWORK.surface_clearance(region.width_source) is None:
        governing = None
    width = NETWORK.surface_clearance(governing) if governing is not None else None
    tags = {
        "highway": "footway", "footway": "sidewalk", "foot": "yes",
        "source": "Taiwan government sidewalk survey",
        "source:ref": surface.source_id, "source:batch": snapshot.source_batch,
        "source:version": snapshot.version_id, "source:sha256": snapshot.archive_sha256,
        "source:county": surface.county,
        "source:grade": "known" if known_plane(region.plane) else "unknown",
        "source:width": "known" if width is not None else "unknown",
    }
    name = surface.raw.get("NAME") or surface.raw.get("name")
    if isinstance(name, str) and name.strip():
        tags["name"] = name
    for key, value in zip(NETWORK.GRADE_KEYS, region.plane, strict=True):
        if value is not None and not str(value).startswith("opaque:"):
            tags[key] = str(value)
    if width is not None:
        tags["width"] = str(width)
        tags["source:width:ref"] = governing.source_id
        tags["source:width:refs"] = ";".join(sorted({s.source_id for s in known_sources}))
    if region.source_refs:
        tags["source:refs"] = ";".join(region.source_refs)
        tags["source:ref"] = tags["source:refs"]
        tags["source:county"] = ";".join(sorted({s.county for s in region.source_surfaces}))
        tags["source:geometry"] = "shared_surface_precision_connector"
    for key in ("surface", "smoothness", "wheelchair", "lit", "tactile_paving"):
        if isinstance(surface.raw.get(key), str) and all(s.raw.get(key) == surface.raw[key] for s in region.source_surfaces):
            tags[key] = surface.raw[key]
    if region.source_surfaces:
        names = {s.raw.get("NAME") or s.raw.get("name") for s in region.source_surfaces}
        if len(names) != 1:
            tags.pop("name", None)
    return tags


def relation_members(relation, replacements, original_ways):
    members = list(relation.members)
    result = []
    restriction = relation.tags.get("type") == "restriction"
    via_nodes = {member.ref for member in members if member.type == "n" and member.role == "via"}
    via_ways = [member.ref for member in members if member.type == "w" and member.role == "via"]
    attachments = {"from": via_nodes, "to": via_nodes}
    ordered_via = None
    if restriction and via_ways and any(member.type == "w" and member.ref in replacements for member in members):
        required = {member.ref for member in members if member.type == "w" and member.role in {"from", "via", "to"}}
        missing = required - original_ways.keys()
        if missing:
            raise ValueError(f"Cannot preserve turn restriction relation {relation.id}: missing original ways {sorted(missing)}")
        endpoints = {
            role: {node for member in members if member.type == "w" and member.role == role for node in original_ways[member.ref]}
            for role in ("from", "to")
        }
        candidates = []
        def visit(index, current, start, ordered):
            if index == len(via_ways):
                if current in endpoints["to"]:
                    candidates.append((start, current, ordered))
                return
            ident = via_ways[index]
            nodes = original_ways[ident]
            for reverse in (False, True):
                first, last = (nodes[-1], nodes[0]) if reverse else (nodes[0], nodes[-1])
                if (index == 0 and first in endpoints["from"]) or (index > 0 and first == current):
                    pieces = replacements.get(ident)
                    ids = [piece.id for piece in pieces] if pieces else [ident]
                    visit(index + 1, last, first if index == 0 else start, [*ordered, *(reversed(ids) if reverse else ids)])
        visit(0, None, None, [])
        if len(candidates) != 1:
            raise ValueError(f"Cannot preserve turn restriction relation {relation.id}: ambiguous via-way traversal")
        start, end, ordered_via = candidates[0]
        attachments = {"from": {start}, "to": {end}}
    emitted_via = False
    for member in members:
        if ordered_via is not None and member.type == "w" and member.role == "via":
            if not emitted_via:
                result.extend(("w", ident, "via") for ident in ordered_via)
                emitted_via = True
            continue
        pieces = replacements.get(member.ref) if member.type == "w" else None
        if pieces is None:
            result.append((member.type, member.ref, member.role))
            continue
        selected = pieces
        if restriction and member.role in {"from", "to"}:
            attachment = attachments[member.role]
            selected = [piece for piece in pieces if attachment & set(piece.nodes)]
            if len(selected) != 1:
                raise ValueError(f"Cannot preserve turn restriction relation {relation.id}: ambiguous split way {member.ref}")
        if member.role in {"backward", "reverse"}:
            selected = list(reversed(selected))
        result.extend(("w", piece.id, member.role) for piece in selected)
    return result


def original_restriction_issue(relation, original):
    roles = {
        role: [member for member in relation.members if member.role == role]
        for role in ("from", "via", "to")
    }
    if any(not roles[role] for role in roles):
        return "missing_required_role"
    if any(member.type != "w" for role in ("from", "to") for member in roles[role]):
        return "from_or_to_is_not_a_way"
    required = {member.ref for role in roles.values() for member in role if member.type == "w"}
    if required - original.keys():
        return "missing_original_member_way"
    if any(len(original[ident]) < 2 for ident in required):
        return "degenerate_original_member_way"
    via = roles["via"]
    if any(member.type == "n" for member in via):
        if len(via) != 1 or via[0].type != "n":
            return "invalid_via_node_members"
        if any(via[0].ref not in original[member.ref] for role in ("from", "to") for member in roles[role]):
            return "original_via_node_not_on_from_or_to"
        return None
    if any(member.type != "w" for member in via):
        return "invalid_via_member_type"
    positions = {node for member in roles["from"] for node in original[member.ref]}
    targets = {node for member in roles["to"] for node in original[member.ref]}
    for member in via:
        nodes = original[member.ref]
        positions = {end for start, end in ((nodes[0], nodes[-1]), (nodes[-1], nodes[0])) if start in positions}
    if not positions & targets:
        return "original_via_way_chain_disconnected"
    return None


def target_otp_inactive_reasons(relation, original):
    last = {member.role: member.ref for member in relation.members if member.role in {"from", "via", "to"}}
    if last.keys() != {"from", "via", "to"}:
        return ["native_missing_from_via_or_to"]
    reasons = []
    if relation.tags.get("restriction") not in {f"{kind}_{turn}" for kind in ("no", "only") for turn in ("left_turn", "right_turn", "straight_on", "u_turn")}:
        reasons.append("native_unknown_restriction")
    for role in ("from", "to"):
        if last["via"] not in original.get(last[role], ()):
            reasons.append(f"native_no_{role}_edge_at_numeric_via")
    return reasons


def prepare_restrictions(pbf_path, replacements, ways, audit=None):
    affected = []
    class FindRestrictions(osmium.SimpleHandler):
        def relation(self, relation):
            if relation.tags.get("type") == "restriction" and any(m.type == "w" and m.ref in replacements for m in relation.members):
                affected.append(SimpleNamespace(
                    id=relation.id, version=relation.version, tags=dict(relation.tags),
                    members=[SimpleNamespace(type=m.type, ref=m.ref, role=m.role) for m in relation.members],
                ))
    FindRestrictions().apply_file(str(pbf_path))
    original = {way.osm_id: tuple(node.osm_id for node in way.nodes) for way in ways}
    needed = {m.ref for relation in affected for m in relation.members if m.type == "w"} - original.keys()
    if needed:
        class ReadMembers(osmium.SimpleHandler):
            def way(self, way):
                if way.id in needed:
                    original[way.id] = tuple(node.ref for node in way.nodes)
        ReadMembers().apply_file(str(pbf_path))
    planned, errors = {}, []
    for relation in affected:
        original_issue = original_restriction_issue(relation, original)
        inactive = target_otp_inactive_reasons(relation, original)
        role_indexes = {role: [index for index, member in enumerate(relation.members) if member.role == role] for role in ("from", "via", "to")}
        raw = [(member.type, member.ref, member.role) for member in relation.members]
        duplicate_active = not inactive and any(len(indexes) > 1 for indexes in role_indexes.values())
        if duplicate_active:
            last = {role: relation.members[indexes[-1]] for role, indexes in role_indexes.items()}
            if last["via"].type != "n" or any(last[role].type != "w" for role in ("from", "to")):
                errors.append(f"Cannot preserve active nonstandard turn restriction relation {relation.id}")
                continue
            projected = list(raw)
            for role in ("from", "to"):
                member = last[role]
                pieces = replacements.get(member.ref)
                if pieces is None:
                    continue
                selected = [piece.id for piece in pieces if last["via"].ref in piece.nodes]
                if len(selected) != 1:
                    errors.append(f"Cannot preserve active duplicate-role restriction relation {relation.id}: ambiguous last {role}")
                    break
                projected[role_indexes[role][-1]] = ("w", selected[0], role)
            else:
                planned[relation.id] = projected
                if audit is not None:
                    audit.append(dict(
                        relation_id=relation.id, status="target_otp_last_role_projection",
                        tags=relation.tags, members=raw, projected_members=projected,
                        original_way_nodes={member.ref: original.get(member.ref) for member in relation.members if member.type == "w"},
                    ))
            continue
        try:
            if original_issue is not None:
                raise ValueError(f"Original restriction relation {relation.id}: {original_issue}")
            planned[relation.id] = relation_members(relation, replacements, original)
            continue
        except ValueError as error:
            if not inactive:
                errors.append(str(error))
                continue
        if inactive:
            planned[relation.id] = [(member.type, member.ref, member.role) for member in relation.members]
            if audit is not None:
                audit.append(dict(
                    relation_id=relation.id, osm_version=relation.version,
                    status="unsupported_by_target_otp" if original_issue is None or original_issue == "original_via_way_chain_disconnected" else "original_invalid",
                    reason=original_issue or "original_mapping_ambiguous", target_otp_inactive_reasons=inactive,
                    preservation="raw_relation_members_and_tags_unchanged",
                    tags=relation.tags, members=planned[relation.id],
                    original_way_nodes={member.ref: original.get(member.ref) for member in relation.members if member.type == "w"},
                ))
            continue
    if errors:
        raise ValueError("Restriction preflight failed: " + "; ".join(errors))
    return planned


def node_closure_groups(regions, ways, node_tags, records, endpoint_affected=None):
    """Find local derived components touched by an explicit closed OSM node."""
    owners = defaultdict(set)
    for index, region in enumerate(regions):
        for ids in region.ports.values():
            for ident in ids:
                owners[ident].add(index)
    region_tree = STRtree([region.geometry for region in regions])
    ports_by_way = defaultdict(list)
    for record in records.values():
        for port in record["ports"]:
            ports_by_way[port["osm_way_id"]].append(port)
    incident = defaultdict(list)
    for way in ways:
        if not BUILDER.should_include_way(way.tags):
            continue
        for index, node in enumerate(way.nodes):
            if not safe_port_node(node_tags.get(node.osm_id, {})):
                incident[node.osm_id].append((way, index, node))
    closures = []
    for node_id, arms in incident.items():
        point = Point(arms[0][2].lon, arms[0][2].lat)
        planes = {NETWORK.grade(way.tags) for way, _, _ in arms}
        affected = {int(index) for index in region_tree.query(point) if regions[int(index)].geometry.covers(point) and regions[int(index)].plane in planes and known_plane(regions[int(index)].plane)}
        if not affected:
            continue
        pending = list(affected)
        while pending:
            index = pending.pop()
            for ids in regions[index].ports.values():
                for ident in ids:
                    for neighbour in owners[ident] - affected:
                        affected.add(neighbour)
                        pending.append(neighbour)
        if endpoint_affected is not None:
            endpoint_affected.append(dict(node_id=node_id, region_indexes=affected.copy()))
        seeds = {}
        for way, gate_index, _ in arms:
            line = NETWORK.way_line(way)
            gate_position = sum(math.hypot(b.lon - a.lon, b.lat - a.lat) for a, b in zip(way.nodes[:gate_index], way.nodes[1:gate_index + 1]))
            for port in ports_by_way[way.osm_id]:
                if port["region_index"] not in affected:
                    continue
                position = line.project(Point(port["source_contact_coordinate"]))
                side = gate_index - 1 if position < gate_position else gate_index + 1 if position > gate_position else None
                if side is None or not 0 <= side < len(way.nodes):
                    continue
                label = way.nodes[side].osm_id
                ident = port["node_id"]
                if ident in seeds and seeds[ident] != label:
                    raise ValueError(f"Ambiguous local government contact around closed OSM node {node_id}")
                seeds[ident] = label
        if len(set(seeds.values())) > 1:
            closures.append(dict(node_id=node_id, region_indexes=affected, seeds=seeds))
    return closures


def partition_node_closures(spool_path, closures, region_starts, generated_regions, coordinates, identifiers, writer, report):
    """Cut only inferred transitions; retain geometry and original gate tags."""
    if not closures:
        return {}, 0
    affected = set().union(*(closure["region_indexes"] for closure in closures))
    rows, regions_by_way = {}, {}
    with spool_path.open() as stream:
        for line in stream:
            row = json.loads(line)
            index = bisect_right(region_starts, row["id"]) - 1
            region = generated_regions[index]
            if id(region) in affected:
                rows[row["id"]] = row
                regions_by_way[row["id"]] = region
    original_ids = set(rows)
    overrides = {}
    evidence = []
    for closure in closures:
        current_rows = {ident: row for ident, row in rows.items() if id(regions_by_way[ident]) in closure["region_indexes"]}
        adjacency = defaultdict(dict)
        for row in current_rows.values():
            for left, right in zip(row["nodes"], row["nodes"][1:]):
                distance = math.dist(coordinates[left], coordinates[right])
                adjacency[left][right] = distance
                adjacency[right][left] = distance
        distances, labels, queue = {}, {}, []
        for ident, label in closure["seeds"].items():
            if ident in adjacency:
                distances[ident], labels[ident] = 0.0, label
                heapq.heappush(queue, (0.0, label, ident))
        while queue:
            distance, label, ident = heapq.heappop(queue)
            if (distance, label) != (distances[ident], labels[ident]):
                continue
            for neighbour, weight in adjacency[ident].items():
                candidate = (distance + weight, label)
                if candidate < (distances.get(neighbour, math.inf), labels.get(neighbour, math.inf)):
                    distances[neighbour], labels[neighbour] = candidate
                    heapq.heappush(queue, (*candidate, neighbour))
        duplicates, cuts = {}, []
        def side_node(ident, owner):
            if labels.get(ident) == owner:
                return ident
            key = (ident, owner)
            if key not in duplicates:
                duplicate = identifiers.next("n")
                duplicates[key] = duplicate
                coordinates[duplicate] = coordinates[ident]
                writer.add_node(osmium.osm.mutable.Node(id=duplicate, location=coordinates[ident]))
            return duplicates[key]
        for ident, row in current_rows.items():
            runs = []
            for left, right in zip(row["nodes"], row["nodes"][1:]):
                a, b = labels.get(left), labels.get(right)
                owner = min(a, b) if a is not None and b is not None else a if a is not None else b
                pair = [side_node(left, owner), side_node(right, owner)] if owner is not None else [left, right]
                if a is not None and b is not None and a != b:
                    cuts.append(dict(way_id=ident, original_nodes=[left, right], retained_nodes=pair))
                if runs and runs[-1][-1] == pair[0]:
                    runs[-1].append(pair[1])
                else:
                    runs.append(pair)
            if len(runs) == 1 and runs[0] == row["nodes"]:
                continue
            region = regions_by_way[ident]
            tags = {**row["tags"], "source:topology": "conservative_node_closure_partition", "source:closure": f"osm:node/{closure['node_id']}"}
            emitted_ids = []
            for index, refs in enumerate(runs):
                output_id = ident if index == 0 else identifiers.next("w")
                emitted_ids.append(output_id)
                rows[output_id] = dict(id=output_id, nodes=refs, tags=tags)
                regions_by_way[output_id] = region
                if output_id != ident:
                    overrides[output_id] = region
                    for source_id in region.source_refs or (region.surface.source_id,):
                        report["sources"][source_id]["generated_way_ids"].append(output_id)
            for sample in report["county_samples"].values():
                if any(path["way_id"] == ident for path in sample["paths"]):
                    sample["paths"] = [path for path in sample["paths"] if path["way_id"] != ident]
                    sample["paths"].extend(dict(way_id=key, coordinates=[coordinates[node] for node in rows[key]["nodes"]]) for key in emitted_ids)
        evidence.append(dict(osm_node_id=closure["node_id"], strategy="conservative_topological_closure", seeds=closure["seeds"], cuts=cuts, duplicated_nodes=[dict(original=key[0], side=key[1], duplicate=value) for key, value in duplicates.items()]))
    temporary = spool_path.with_suffix(".closed.jsonl")
    with spool_path.open() as source, temporary.open("w") as destination:
        for line in source:
            row = json.loads(line)
            destination.write(json.dumps(rows.get(row["id"], row)) + "\n")
        for ident in sorted(rows.keys() - original_ids):
            destination.write(json.dumps(rows[ident]) + "\n")
    os.replace(temporary, spool_path)
    report["node_closures"] = evidence
    return overrides, len(rows.keys() - original_ids)


def compile_layer(pbf_path: Path, snapshot, output_path: Path, report_path: Path, bbox=None):
    pbf_path, output_path, report_path = map(Path, (pbf_path, output_path, report_path))
    if len({p.resolve() for p in (pbf_path, output_path, report_path)}) != 3:
        raise ValueError("Input PBF, output PBF and report must be different paths")
    if output_path.exists() or report_path.exists():
        raise FileExistsError("Output PBF and report must be new paths")
    input_hash = sha256(pbf_path)
    inventory = InputInventory(allow_endpoint_proof=False)
    inventory.apply_file(str(pbf_path))
    identifiers = Identifiers(inventory)
    sources, ways, node_tags, observations, confirmed, potential, planes, source_audit = context(pbf_path, snapshot, bbox)
    report = dict(
        schema_version=1, source_version=snapshot.version_id,
        compiler_source_sha256=COMPILER_SOURCE_SHA256,
        topology_source_sha256=TOPOLOGY_SOURCE_SHA256,
        dependency_source_sha256=DEPENDENCY_SOURCE_SHA256,
        source_batch=snapshot.source_batch, source_archive_sha256=snapshot.archive_sha256,
        input_pbf_sha256=input_hash, scope="derived OSM data; no OTP activation",
        wheelchair_width_enforcement="not_verified_by_this_compiler",
        output_coordinate_precision_degrees=1e-7,
        source_accounting=source_audit, county_samples={},
        precision_limitations=[],
    )
    regions = make_regions(sources, observations, planes, confirmed, potential, report)
    cuts = attach_ports(regions, ways, node_tags, identifiers, report["sources"])
    try:
        connectors = quantize_ports(regions, identifiers, report["sources"])
    except PortPrecisionErrors as error:
        with tempfile.NamedTemporaryFile(
            mode="w", prefix=report_path.stem + "-contact-failures-", suffix=".json",
            dir=report_path.parent, delete=False,
        ) as diagnostic:
            json.dump(dict(
                compiler_source_sha256=COMPILER_SOURCE_SHA256,
                input_pbf_sha256=input_hash, source_version=snapshot.version_id,
                source_archive_sha256=snapshot.archive_sha256,
                failures=error.failures,
            ), diagnostic, ensure_ascii=False)
        error.add_note(f"Replayable contact diagnostics: {diagnostic.name}")
        remove_unproven_contacts(error.failures, regions, identifiers, report["sources"], cuts)
        report["contact_precision_limitations"] = error.failures
        report["contact_precision_diagnostics"] = diagnostic.name
        connectors = quantize_ports(regions, identifiers, report["sources"])
    report["precision_connectors"] = [dict(source_refs=r.source_refs, coordinates=r.connector) for r in connectors]
    regions.extend(connectors)
    endpoint_affected = []
    closures = node_closure_groups(regions, ways, node_tags, report["sources"], endpoint_affected)
    for closure in closures:
        closure["region_indexes"] = {id(regions[index]) for index in closure["region_indexes"]}
    closure_regions = set().union(*(closure["region_indexes"] for closure in closures)) if closures else set()
    for closure in endpoint_affected:
        closure["region_indexes"] = {id(regions[index]) for index in closure["region_indexes"]}
    endpoint_proofs = {
        id(region): endpoint_proof_tags(endpoint_proof(region, snapshot, [closure["node_id"] for closure in endpoint_affected if id(region) in closure["region_indexes"]]))
        for region in regions
    }
    closure_coordinates = {}
    denials = denied_geometry(sources, planes, observations)
    replacements, masked = split_ways(ways, cuts, sources, planes, confirmed, identifiers, denials)
    report["masked_ordinary_roads"] = masked
    report["restriction_compatibility"] = dict(target_otp="2.9.0", source_commit="9babe45ffc9327933129f705c648137ecd96cdbe", entries=[])
    restriction_members = prepare_restrictions(pbf_path, replacements, ways, report["restriction_compatibility"]["entries"])
    owned = []
    writer = None
    with tempfile.TemporaryDirectory(prefix="otp-sidewalk-layer-", dir=output_path.parent) as work:
        temporary_pbf = Path(work) / "merged.osm.pbf"
        spool_path = Path(work) / "government-ways.jsonl"
        try:
            for path in (output_path, report_path):
                with path.open("xb"):
                    pass
                owned.append(path)
            writer = osmium.SimpleWriter(str(temporary_pbf))

            class CopyNodes(osmium.SimpleHandler):
                def node(self, node):
                    writer.add_node(node)

            CopyNodes().apply_file(str(pbf_path))
            for ident, coordinate in sorted(identifiers.coordinates.items()):
                writer.add_node(osmium.osm.mutable.Node(id=ident, location=coordinate))
            generated_way_count = 0
            region_way_starts = []
            generated_regions = []
            with spool_path.open("w") as spool:
                for region_index, region in enumerate(regions):
                    topology = (
                        TOPOLOGY.SparseTopology(
                            {1: region.connector[0], 2: region.connector[-1]},
                            (TOPOLOGY.SparsePath(1, 2, region.connector),),
                        ) if region.connector else TOPOLOGY.build_polygon_topology(
                            region.geometry, sorted(region.ports),
                            segment_key=(lambda a, b: derived_tags(region, snapshot, [a, b]))
                            if region.width_observations else None,
                        )
                    )
                    try:
                        quantized = quantized_coordinates(topology, region)
                    except PrecisionError:
                        limitation = unrepresentable_fragment(region)
                        if limitation is None:
                            raise
                        limitation["negative_geometry"] = report["sources"][region.surface.source_id].get("negative_geometry", [])
                        report["precision_limitations"].append(limitation)
                        continue
                    region_way_starts.append(identifiers.maximum["w"] + 1)
                    generated_regions.append(region)
                    local_nodes = {coordinate: min(ids) for coordinate, ids in region.ports.items()}
                    record = report["sources"][region.surface.source_id]
                    sample = report["county_samples"].setdefault(region.surface.county, dict(
                        source_id=region.surface.source_id, grade_resolution=record["grade_resolution"],
                        ports=record["ports"], paths=[],
                    ))
                    first_neighbours = {}

                    def node_for(coordinate):
                        coordinate = tuple(coordinate)
                        if coordinate not in local_nodes:
                            ident = identifiers.next("n")
                            local_nodes[coordinate] = ident
                            writer.add_node(osmium.osm.mutable.Node(id=ident, location=coordinate))
                        return local_nodes[coordinate]

                    def emit(refs, coordinates):
                        nonlocal generated_way_count
                        runs = []
                        for index in range(len(refs) - 1):
                            tags = derived_tags(region, snapshot, coordinates[index:index + 2])
                            if runs and runs[-1][2] == tags:
                                runs[-1][1] = index + 1
                            else:
                                runs.append([index, index + 1, tags])
                        for first, last, tags in runs:
                            for start in range(first, last, MAX_REFS - 1):
                                stop = min(last + 1, start + MAX_REFS)
                                segment = refs[start:stop]
                                ident = identifiers.next("w")
                                output_tags = {**tags, **endpoint_proofs[id(region)]}
                                spool.write(json.dumps(dict(id=ident, nodes=segment, tags=output_tags)) + "\n")
                                for source_id in region.source_refs or (region.surface.source_id,):
                                    report["sources"][source_id]["generated_way_ids"].append(ident)
                                generated_way_count += 1
                                if sample["source_id"] == region.surface.source_id:
                                    sample["paths"].append(dict(way_id=ident, coordinates=coordinates[start:stop]))

                    for path in quantized.paths:
                        coordinates = []
                        for actual in path:
                            if not coordinates or coordinates[-1] != actual:
                                coordinates.append(actual)
                        if len(coordinates) < 2:
                            continue
                        refs = [node_for(point) for point in coordinates]
                        emit(refs, coordinates)
                        first_neighbours.setdefault(coordinates[0], (refs[1], coordinates[1]))
                        first_neighbours.setdefault(coordinates[-1], (refs[-2], coordinates[-2]))
                    for coordinate, ports in region.ports.items():
                        if coordinate not in first_neighbours:
                            raise ValueError(f"OSM coordinate precision collapses a required port for source {region.surface.source_id}")
                        default = local_nodes[coordinate]
                        neighbour_id, neighbour_coordinate = first_neighbours[coordinate]
                        for port in sorted(ports - {default}):
                            emit([port, neighbour_id], [coordinate, neighbour_coordinate])
                    if id(region) in closure_regions:
                        closure_coordinates.update((ident, coordinate) for coordinate, ident in local_nodes.items())
                        closure_coordinates.update((ident, coordinate) for coordinate, ids in region.ports.items() for ident in ids)
                    if (region_index + 1) % 5000 == 0:
                        print(f"[otp-sidewalk-layer] compiled {region_index + 1}/{len(regions)} regions", file=sys.stderr, flush=True)
            finish_source_accounting(regions, report)
            closure_overrides, extra_closed_ways = partition_node_closures(
                spool_path, closures, region_way_starts, generated_regions,
                closure_coordinates, identifiers, writer, report,
            )
            generated_way_count += extra_closed_ways

            class CopyWays(osmium.SimpleHandler):
                def way(self, way):
                    pieces = replacements.get(way.id)
                    if pieces is None:
                        writer.add_way(way)
                    else:
                        first = pieces[0]
                        writer.add_way(osmium.osm.mutable.Way(way, nodes=first.nodes, tags=first.tags))

            CopyWays().apply_file(str(pbf_path))
            extra_pieces = sorted((piece for pieces in replacements.values() for piece in pieces[1:]), key=lambda p: p.id)
            for piece in extra_pieces:
                writer.add_way(osmium.osm.mutable.Way(id=piece.id, nodes=piece.nodes, tags=piece.tags))
            with spool_path.open() as spool:
                for line in spool:
                    writer.add_way(osmium.osm.mutable.Way(**json.loads(line)))

            class CopyRelations(osmium.SimpleHandler):
                def relation(self, relation):
                    writer.add_relation(osmium.osm.mutable.Relation(
                        relation, members=restriction_members.get(relation.id) or relation_members(relation, replacements, {}),
                    ))

            CopyRelations().apply_file(str(pbf_path))
            writer.close()
            writer = None
            output_inventory = InputInventory()
            output_inventory.apply_file(str(temporary_pbf))
            denial_tree = STRtree([geometry for geometry, _ in denials])
            restriction_audit = {entry["relation_id"]: entry for entry in report["restriction_compatibility"]["entries"]}
            audited_way_ids = {ref for entry in restriction_audit.values() for kind, ref, role in entry.get("projected_members", entry["members"]) if role in {"from", "to"}}
            serialized_way_nodes, serialized_relations = {}, {}
            proof_counts = defaultdict(int)

            class CheckSerializedGeometry(osmium.SimpleHandler):
                def way(self, way):
                    if way.id in audited_way_ids:
                        serialized_way_nodes[way.id] = tuple(node.ref for node in way.nodes)
                    if not BUILDER.should_include_way(dict(way.tags)):
                        return
                    line = LineString([(node.location.lon, node.location.lat) for node in way.nodes])
                    if way.tags.get("source:batch") == snapshot.source_batch and region_way_starts and way.id >= region_way_starts[0]:
                        region = closure_overrides.get(way.id) or generated_regions[bisect_right(region_way_starts, way.id) - 1]
                        if not (exact_connector_coverage(region.geometry, line) if region.connector else region.geometry.covers(line)):
                            raise ValueError(f"Serialized PBF leaves source surface {region.surface.source_id}: way {way.id}")
                        value = {key: value for key, value in way.tags if key == ENDPOINT_PROOF_TAG or key.startswith(ENDPOINT_PROOF_TAG + ":")}
                        if value != endpoint_proofs[id(region)]:
                            raise ValueError(f"Serialized endpoint proof changed on way {way.id}")
                        proof_counts[canonical_json(value)] += 1
                    if way.id not in replacements and way.id <= inventory.maximum["w"]:
                        return
                    for index in denial_tree.query(line):
                        geometry, plane = denials[int(index)]
                        if not NETWORK.compatible_grade(plane, NETWORK.grade(dict(way.tags))):
                            continue
                        if line.intersection(geometry).length > 0:
                            raise ValueError(f"Serialized traversable OSM way {way.id} crosses an observed closure")

                def relation(self, relation):
                    if relation.id in restriction_audit:
                        serialized_relations[relation.id] = SimpleNamespace(
                            tags=dict(relation.tags), members=[SimpleNamespace(type=member.type, ref=member.ref, role=member.role) for member in relation.members],
                        )

            BUILDER.apply_with_locations(osmium, CheckSerializedGeometry(), temporary_pbf)
            for relation_id, entry in restriction_audit.items():
                actual = serialized_relations[relation_id]
                if actual.tags != entry["tags"] or [(member.type, member.ref, member.role) for member in actual.members] != entry.get("projected_members", entry["members"]):
                    raise ValueError(f"Serialized restriction {relation_id} changed audited semantics")
                inactive = target_otp_inactive_reasons(actual, serialized_way_nodes)
                if bool(inactive) != (entry["status"] != "target_otp_last_role_projection"):
                    raise ValueError(f"Serialized restriction {relation_id} changed target OTP activation")
                entry["serialized_target_activation_verified"] = True
            if sha256(pbf_path) != input_hash:
                raise RuntimeError("Input PBF changed during compilation")
            report["counts"] = dict(
                selected_sources=len(sources), regions=len(regions),
                generated_ways=generated_way_count, generated_nodes=identifiers.maximum["n"] - inventory.maximum["n"],
                rewritten_osm_ways=len(replacements), input_entities=inventory.counts,
                output_entities=output_inventory.counts,
                preserved_original_invalid_restrictions=sum(entry["status"] == "original_invalid" for entry in report["restriction_compatibility"]["entries"]),
                preserved_target_unsupported_restrictions=sum(entry["status"] == "unsupported_by_target_otp" for entry in report["restriction_compatibility"]["entries"]),
                sources_with_osm_ports=sum(bool(record["ports"]) for record in report["sources"].values()),
                sources_with_generated_ways=sum(bool(record["generated_way_ids"]) for record in report["sources"].values()),
                sources_fully_blocked=sum(record["status"] in {"access_denied", "excluded_by_observations"} for record in report["sources"].values()),
                sources_without_representable_effective_geometry=sum(record["status"] == "no_representable_effective_geometry" for record in report["sources"].values()),
                sources_partially_limited=sum(record["partially_limited"] for record in report["sources"].values()),
                unproven_source_contacts=sum(failure["identity"][0] == "source-contact" for failure in report.get("contact_precision_limitations", [])),
                unserialized_osm_contacts=sum(failure["identity"][0] == "osm-cut" for failure in report.get("contact_precision_limitations", [])),
                contacts_with_proven_unrepresentable_fragments=sum(bool(failure["fragment_certificates"]) for failure in report.get("contact_precision_limitations", [])),
            )
            report["all_observed_contacts_serialized"] = not report.get("contact_precision_limitations")
            report["output_pbf_sha256"] = sha256(temporary_pbf)
            report["input_pbf_unchanged"] = True
            report["serialized_geometry_verified"] = True
            proof_entries = []
            unique_geometries = {}
            for value, count in proof_counts.items():
                tags = json.loads(value)
                manifest, payload = decode_endpoint_proof_tags(tags)
                if payload is not None:
                    unique_geometries[payload["surface_sha256"]] = len(payload["surface_wkb_hex"]) // 2
                    for observation in payload["width_observations"]:
                        unique_geometries[observation["geometry_sha256"]] = len(observation["geometry_wkb_hex"]) // 2
                proof_entries.append(dict(region_id=manifest["region_id"], status=manifest["status"],
                    eligibility=payload["eligibility"] if payload is not None else "unsupported_payload_limits",
                    closure_node_ids=payload["closure_node_ids"] if payload is not None else [],
                    payload_bytes=manifest["payload_bytes"], compressed_bytes=manifest["compressed_bytes"],
                    chunk_count=manifest["chunk_count"], tag_bytes=sum(len(key.encode("utf-8")) + len(value.encode("utf-8")) for key, value in tags.items()),
                    way_count=count, width_observation_count=len(payload["width_observations"]) if payload is not None else None))
            report["endpoint_proof"] = dict(
                tag=ENDPOINT_PROOF_TAG, rule_version=ENDPOINT_PROOF_RULE,
                unique_regions=len(proof_entries), tagged_ways=sum(proof_counts.values()),
                unique_payload_bytes=sum(item["payload_bytes"] for item in proof_entries),
                per_way_payload_bytes=sum(item["payload_bytes"] * item["way_count"] for item in proof_entries),
                maximum_payload_bytes=max((item["payload_bytes"] for item in proof_entries), default=0),
                unique_compressed_bytes=sum(item["compressed_bytes"] for item in proof_entries),
                per_way_tag_bytes=sum(item["tag_bytes"] * item["way_count"] for item in proof_entries),
                maximum_chunk_count=max((item["chunk_count"] for item in proof_entries), default=0),
                unsupported_regions=sum(item["status"] == "unsupported" for item in proof_entries),
                eligibility_region_counts={reason: sum(item["eligibility"] == reason for item in proof_entries) for reason in sorted({item["eligibility"] for item in proof_entries})},
                eligibility_way_counts={reason: sum(item["way_count"] for item in proof_entries if item["eligibility"] == reason) for reason in sorted({item["eligibility"] for item in proof_entries})},
                observed_closure_affected_regions=len(set().union(*(closure["region_indexes"] for closure in endpoint_affected))) if endpoint_affected else 0,
                unique_geometry_count=len(unique_geometries), unique_wkb_bytes=sum(unique_geometries.values()),
                estimates_exclude_jvm_object_overhead=True,
                pbf_cross_block_string_deduplication_assumed=False,
                regions=proof_entries,
            )
            report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
            os.replace(temporary_pbf, output_path)
            return report
        except BaseException:
            if writer is not None:
                writer.close()
            for path in owned:
                path.unlink(missing_ok=True)
            raise


def parse_bbox(value):
    try:
        parts = tuple(float(part) for part in value.split(","))
    except ValueError as error:
        raise argparse.ArgumentTypeError("bbox must be west,south,east,north") from error
    if len(parts) != 4 or not all(math.isfinite(v) for v in parts) or not (-180 <= parts[0] < parts[2] <= 180 and -90 <= parts[1] < parts[3] <= 90):
        raise argparse.ArgumentTypeError("bbox must be a valid WGS84 extent")
    return parts


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pbf", required=True, type=Path)
    parser.add_argument("--db-url-env", required=True)
    parser.add_argument("--source-version", required=True)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--report", required=True, type=Path)
    parser.add_argument("--bbox", type=parse_bbox)
    args = parser.parse_args(argv)
    db_url = os.environ.get(args.db_url_env)
    if not db_url:
        parser.error("The named database URL environment variable is unset")
    snapshot = NETWORK.load_source(db_url, args.source_version)
    report = compile_layer(args.pbf, snapshot, args.output, args.report, args.bbox)
    print(json.dumps(report["counts"], ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
