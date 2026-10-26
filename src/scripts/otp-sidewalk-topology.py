"""Compile one legal sidewalk surface into sparse street paths for OSM/OTP."""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from itertools import pairwise

from shapely import constrained_delaunay_triangles, prepare
from shapely.affinity import translate
from shapely.geometry import LineString, Point, Polygon

Coordinate = tuple[float, float]


@dataclass(frozen=True, slots=True)
class SparsePath:
    start: int
    end: int
    coordinates: tuple[Coordinate, ...]


@dataclass(frozen=True, slots=True)
class SparseTopology:
    nodes: dict[int, Coordinate]
    edges: tuple[SparsePath, ...]


def coordinate(value) -> Coordinate:
    return float(value[0]), float(value[1])


def build_polygon_topology(polygon: Polygon, ports=(), *, segment_key=None) -> SparseTopology:
    if (
        not isinstance(polygon, Polygon)
        or polygon.is_empty
        or not polygon.is_valid
        or polygon.area <= 0
    ):
        raise ValueError("Expected a valid nonempty source Polygon")
    origin_x, origin_y = polygon.bounds[:2]

    def to_local(geometry):
        return translate(geometry, -origin_x, -origin_y)

    # At WGS84 magnitudes a tiny GEOS buffer can exclude its own source polygon.
    covered = to_local(polygon).buffer(1e-13)
    prepare(covered)
    prepare(polygon)

    def covers_source(geometry) -> bool:
        return polygon.covers(geometry) or covered.covers(to_local(geometry))

    def simplify_shape(points: list[Coordinate]) -> tuple[Coordinate, ...]:
        # Triangle centers establish connectivity, but their alternating offsets
        # are not road bends. Shorten only within this legal surface, retaining
        # every decision/port endpoint and every bend needed to avoid a hole.
        result = [points[0]]
        keys = [segment_key(a, b) for a, b in pairwise(points)] if segment_key else None
        pending = [(0, len(points) - 1)]
        while pending:
            first, last = pending.pop()
            a, b = points[first], points[last]
            transition = next((index for index in range(first + 1, last)
                               if keys is not None and keys[index] != keys[first]), None)
            if transition is not None:
                pending.append((transition, last))
                pending.append((first, transition))
                continue
            same_attributes = keys is None or segment_key(a, b) == keys[first]
            if last == first + 1 or (a != b and same_attributes and covers_source(LineString([a, b]))):
                result.append(b)
                continue
            dx, dy = b[0] - a[0], b[1] - a[1]
            squared = dx * dx + dy * dy

            def distance_squared(index):
                px, py = points[index][0] - a[0], points[index][1] - a[1]
                fraction = max(0, min(1, (px * dx + py * dy) / squared)) if squared else 0
                return (px - fraction * dx) ** 2 + (py - fraction * dy) ** 2

            split = max(range(first + 1, last), key=distance_squared)
            pending.append((split, last))
            pending.append((first, split))
        return tuple(result)

    parts = list(constrained_delaunay_triangles(polygon).geoms)
    if any(not isinstance(part, Polygon) for part in parts):
        raise ValueError("Local decomposition contains a non-polygon")
    triangles = sorted(
        (part for part in parts if isinstance(part, Polygon)),
        key=lambda part: part.wkb_hex,
    )
    if not triangles or any(not covers_source(part) for part in triangles):
        raise ValueError("Local decomposition escaped source surface")
    owners = defaultdict(list)
    centers: list[Coordinate] = []
    adjacency: dict[Coordinate, set[Coordinate]] = defaultdict(set)
    for index, triangle in enumerate(triangles):
        center = coordinate(triangle.centroid.coords[0])
        centers.append(center)
        adjacency[center]
        for raw_a, raw_b in pairwise(triangle.exterior.coords):
            edge = tuple(sorted((coordinate(raw_a), coordinate(raw_b))))
            owners[edge].append(index)

    def connect(a: Coordinate, b: Coordinate) -> None:
        if a == b:
            return
        if not covers_source(LineString([a, b])):
            raise ValueError("Unproven internal sidewalk segment")
        adjacency[a].add(b)
        adjacency[b].add(a)

    boundary = defaultdict(list)
    for edge, members in sorted(owners.items()):
        a, b = edge
        middle = ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
        if len(members) == 2:
            for member in members:
                connect(centers[member], middle)
        elif len(members) == 1:
            boundary[members[0]].append(edge)
        else:
            raise ValueError("Nonmanifold local decomposition")
    for index, center in enumerate(centers):
        degree = len(adjacency[center])
        if degree <= 1:
            candidates = sorted(
                boundary[index],
                key=lambda edge: (
                    (edge[0][0] - edge[1][0]) ** 2
                    + (edge[0][1] - edge[1][1]) ** 2,
                    edge,
                ),
            )
            for a, b in candidates[: 2 if degree == 0 else 1]:
                connect(center, ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2))
    authorized: set[Coordinate] = set()
    for raw in ports:
        if len(raw) != 2:
            raise ValueError("Expected a two-dimensional port")
        port = coordinate(raw)
        port_point = Point(port)
        if not covers_source(port_point):
            raise ValueError("Port is outside source surface")
        local_port = to_local(port_point)
        matches = [
            index
            for index, triangle in enumerate(triangles)
            if triangle.covers(port_point)
            or to_local(triangle).buffer(1e-13).covers(local_port)
        ]
        if not matches:
            raise ValueError("No covered internal attachment for port")
        connect(port, centers[matches[0]])
        authorized.add(port)
    anchors = {
        point for point, neighbours in adjacency.items() if len(neighbours) != 2
    } | authorized
    seen = set()
    for origin in sorted(adjacency):
        if origin in seen:
            continue
        stack = [origin]
        component = set()
        while stack:
            current = stack.pop()
            if current in component:
                continue
            component.add(current)
            stack.extend(adjacency[current] - component)
        seen.update(component)
        if not component & anchors:
            anchors.add(min(component))
    identifiers = {point: index + 1 for index, point in enumerate(sorted(anchors))}
    traversed = set()
    paths = []
    for start in sorted(anchors):
        for neighbour in sorted(adjacency[start]):
            key = tuple(sorted((start, neighbour)))
            if key in traversed:
                continue
            traversed.add(key)
            points = [start, neighbour]
            previous, current = start, neighbour
            while current not in anchors:
                following = next(point for point in adjacency[current] if point != previous)
                traversed.add(tuple(sorted((current, following))))
                points.append(following)
                previous, current = current, following
            paths.append(
                SparsePath(identifiers[start], identifiers[current], simplify_shape(points))
            )
    if not paths:
        raise ValueError("Source surface produced no traversable street path")
    return SparseTopology({index: point for point, index in identifiers.items()}, tuple(paths))
