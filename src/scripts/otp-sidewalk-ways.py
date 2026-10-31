#!/usr/bin/env python3
"""Add government sidewalks to an OSM PBF as OTP-walkable footways.

Each MOI sidewalk polygon is matched to the road it runs beside. The strip
becomes a `footway=sidewalk` way offset from that road, connected to the
road's own nodes at both ends and at every junction in between. The road is
split where the sidewalk starts and ends, and only the lined piece gets
`foot=use_sidepath`, which OTP's default tag mapper turns into a 5x
walk-safety cost: walkers prefer the sidewalk, and the road stays walkable.

Usage: otp-sidewalk-ways.py <input.osm.pbf> <sidewalks.ndjson> <output.osm.pbf>
The NDJSON has one `{"id": ..., "geometry": <GeoJSON (Multi)Polygon>}` per line.
"""

from __future__ import annotations

import json
import math
import os
import sys
from collections import defaultdict
from dataclasses import dataclass, field

LAT0 = 23.7
M_PER_DEG_LAT = 110_540.0
M_PER_DEG_LON = 111_320.0 * math.cos(math.radians(LAT0))

ROAD_MAX_OFFSET_M = {
    "trunk": 30.0,
    "trunk_link": 20.0,
    "primary": 30.0,
    "primary_link": 20.0,
    "secondary": 25.0,
    "secondary_link": 20.0,
    "tertiary": 20.0,
    "tertiary_link": 15.0,
    "unclassified": 15.0,
    "residential": 15.0,
    "living_street": 12.0,
    "service": 12.0,
}
MOTOR_HIGHWAYS = {*ROAD_MAX_OFFSET_M, "motorway", "motorway_link", "road", "track", "busway", "raceway", "escape", "construction"}
DENSIFY_M = 2.0
MIN_RUN_M = 10.0
MIN_OFFSET_M = 1.5
MAX_STRIP_WIDTH_M = 12.0
SAME_SIDE_SHARE = 0.9
MERGE_GAP_M = 15.0
MERGE_OFFSET_M = 3.0
SNAP_M = 2.0
LINK_REACH_M = 30.0
LINK_MAX_M = 40.0
GRID_M = 200.0
COPIED_ROAD_TAGS = ("name", "name:en", "name:zh")


def to_xy(lon, lat):
    return lon * M_PER_DEG_LON, lat * M_PER_DEG_LAT


def to_lonlat(x, y):
    return x / M_PER_DEG_LON, y / M_PER_DEG_LAT


@dataclass(frozen=True)
class Road:
    way_id: int
    node_ids: tuple
    xy: tuple
    cum: tuple
    tags: dict

    @property
    def length(self):
        return self.cum[-1]


@dataclass
class Run:
    way_id: int
    start: float
    end: float
    offset: float
    sources: list = field(default_factory=list)

    @property
    def length(self):
        return self.end - self.start


def make_road(way_id, node_ids, lonlats, tags):
    xy = tuple(to_xy(lon, lat) for lon, lat in lonlats)
    cum = [0.0]
    for (ax, ay), (bx, by) in zip(xy, xy[1:]):
        cum.append(cum[-1] + math.hypot(bx - ax, by - ay))
    return Road(way_id, tuple(node_ids), xy, tuple(cum), dict(tags))


def eligible_road(tags, node_ids):
    if tags.get("highway") not in ROAD_MAX_OFFSET_M:
        return False
    if tags.get("area") == "yes" or tags.get("foot") == "no":
        return False
    if tags.get("bridge", "no") != "no" or tags.get("tunnel", "no") != "no":
        return False
    if tags.get("layer", "0") != "0":
        return False
    if any(
        tags.get(key) == "separate"
        for key in ("sidewalk", "sidewalk:both", "sidewalk:left", "sidewalk:right")
    ):
        return False
    return len(node_ids) >= 2 and node_ids[0] != node_ids[-1]


def project(road, x, y):
    """Return (distance along road, signed offset; + is left of travel)."""
    best = None
    for i, ((ax, ay), (bx, by)) in enumerate(zip(road.xy, road.xy[1:])):
        dx, dy = bx - ax, by - ay
        seg2 = dx * dx + dy * dy
        if seg2 == 0:
            continue
        t = max(0.0, min(1.0, ((x - ax) * dx + (y - ay) * dy) / seg2))
        px, py = ax + t * dx, ay + t * dy
        dist = math.hypot(x - px, y - py)
        if best is None or dist < best[0]:
            seg = math.sqrt(seg2)
            side = (dx * (y - ay) - dy * (x - ax)) / seg
            best = (dist, road.cum[i] + t * seg, math.copysign(dist, side))
    return best[1], best[2]


def densify(ring, step=DENSIFY_M):
    out = []
    for (ax, ay), (bx, by) in zip(ring, ring[1:]):
        n = max(1, math.ceil(math.hypot(bx - ax, by - ay) / step))
        out.extend((ax + (bx - ax) * k / n, ay + (by - ay) * k / n) for k in range(n))
    return out


def polygon_parts(geometry):
    if geometry["type"] == "Polygon":
        return [geometry["coordinates"]]
    if geometry["type"] == "MultiPolygon":
        return list(geometry["coordinates"])
    return []


def match_part(source_id, rings, candidates):
    """Turn one polygon part into runs along the roads its outline hugs."""
    points = densify([to_xy(lon, lat) for lon, lat in rings[0]])
    assigned = defaultdict(list)
    for x, y in points:
        best = None
        for road in candidates:
            along, offset = project(road, x, y)
            if abs(offset) > ROAD_MAX_OFFSET_M[road.tags["highway"]]:
                continue
            if best is None or abs(offset) < abs(best[2]):
                best = (road, along, offset)
        if best:
            assigned[best[0].way_id].append((best[1], best[2]))
    runs = []
    for way_id, samples in assigned.items():
        alongs = [a for a, _ in samples]
        offsets = sorted(o for _, o in samples)
        median = offsets[len(offsets) // 2]
        same_side = sum(1 for o in offsets if (o > 0) == (median > 0))
        if same_side < SAME_SIDE_SHARE * len(offsets):
            continue
        if abs(median) < MIN_OFFSET_M:
            continue
        if max(abs(o) for o in offsets) - min(abs(o) for o in offsets) > MAX_STRIP_WIDTH_M:
            continue
        start, end = min(alongs), max(alongs)
        if end - start < MIN_RUN_M:
            continue
        runs.append(Run(way_id, start, end, median, [source_id]))
    return runs


def merge_runs(runs):
    """Join strips on the same side of a road that touch end to end."""
    merged = []
    groups = defaultdict(list)
    for run in runs:
        groups[(run.way_id, run.offset > 0)].append(run)
    for group in groups.values():
        group.sort(key=lambda run: run.start)
        current = group[0]
        for run in group[1:]:
            if (
                run.start - current.end <= MERGE_GAP_M
                and abs(run.offset - current.offset) <= MERGE_OFFSET_M
            ):
                total = current.length + run.length
                current = Run(
                    current.way_id,
                    current.start,
                    max(current.end, run.end),
                    (current.offset * current.length + run.offset * run.length) / total,
                    current.sources + run.sources,
                )
            else:
                merged.append(current)
                current = run
        merged.append(current)
    return merged


class Grid:
    def __init__(self, size=GRID_M):
        self.size = size
        self.cells = defaultdict(list)

    def keys(self, min_x, min_y, max_x, max_y):
        s = self.size
        for i in range(math.floor(min_x / s), math.floor(max_x / s) + 1):
            for j in range(math.floor(min_y / s), math.floor(max_y / s) + 1):
                yield i, j

    def add(self, item, bounds):
        for key in self.keys(*bounds):
            self.cells[key].append(item)

    def query(self, bounds):
        seen = {}
        for key in self.keys(*bounds):
            for item in self.cells.get(key, ()):
                seen[id(item)] = item
        return list(seen.values())


def bounds_of(xy, pad=0.0):
    xs = [x for x, _ in xy]
    ys = [y for _, y in xy]
    return min(xs) - pad, min(ys) - pad, max(xs) + pad, max(ys) + pad


def match_sidewalks(polygons, roads):
    """Return merged runs for (source_id, geometry) polygons against roads."""
    grid = Grid()
    for road in roads:
        grid.add(road, bounds_of(road.xy))
    runs = []
    for source_id, geometry in polygons:
        for rings in polygon_parts(geometry):
            xy = [to_xy(lon, lat) for lon, lat in rings[0]]
            pad = max(ROAD_MAX_OFFSET_M.values())
            candidates = grid.query(bounds_of(xy, pad))
            if candidates:
                runs.extend(match_part(source_id, rings, candidates))
    return merge_runs(runs)


def point_at(road, along):
    for i in range(len(road.cum) - 1):
        if along <= road.cum[i + 1] or i == len(road.cum) - 2:
            seg = road.cum[i + 1] - road.cum[i]
            t = 0.0 if seg == 0 else (along - road.cum[i]) / seg
            (ax, ay), (bx, by) = road.xy[i], road.xy[i + 1]
            return ax + (bx - ax) * t, ay + (by - ay) * t


def left_normal(a, b):
    dx, dy = b[0] - a[0], b[1] - a[1]
    length = math.hypot(dx, dy) or 1.0
    return -dy / length, dx / length


def offset_polyline(points, offset):
    out = []
    for i, (x, y) in enumerate(points):
        normals = []
        if i > 0:
            normals.append(left_normal(points[i - 1], points[i]))
        if i < len(points) - 1:
            normals.append(left_normal(points[i], points[i + 1]))
        nx = sum(n[0] for n in normals)
        ny = sum(n[1] for n in normals)
        length = math.hypot(nx, ny) or 1.0
        nx, ny = nx / length, ny / length
        scale = 1.0 / max(0.5, nx * normals[0][0] + ny * normals[0][1])
        out.append((x + offset * scale * nx, y + offset * scale * ny))
    return out


@dataclass
class Edits:
    new_nodes: dict = field(default_factory=dict)
    road_pieces: dict = field(default_factory=dict)
    new_ways: list = field(default_factory=list)


def plan_edits(roads, runs, junctions, next_node_id, next_way_id, relation_ways=()):
    """Plan the PBF edits: inserted road nodes, sidewalks, connectors, tags."""
    by_way = defaultdict(list)
    for run in runs:
        by_way[run.way_id].append(run)
    roads_by_id = {road.way_id: road for road in roads}
    edits = Edits()
    for way_id, way_runs in by_way.items():
        road = roads_by_id[way_id]
        anchors = {}

        def anchor(along):
            nonlocal next_node_id
            for i, position in enumerate(road.cum):
                if abs(position - along) <= SNAP_M:
                    return position, road.node_ids[i]
            for position, node_id in anchors.items():
                if abs(position - along) <= SNAP_M:
                    return position, node_id
            node_id = next_node_id
            next_node_id += 1
            anchors[along] = node_id
            edits.new_nodes[node_id] = to_lonlat(*point_at(road, along))
            return along, node_id

        covered = []
        for run in way_runs:
            start, start_node = anchor(run.start)
            end, end_node = anchor(run.end)
            covered.append((start, end))
            stations = [(start, start_node, point_at(road, start), True)]
            for i, position in enumerate(road.cum):
                if start < position < end:
                    node_id = road.node_ids[i]
                    stations.append((position, node_id, road.xy[i], node_id in junctions))
            stations.append((end, end_node, point_at(road, end), True))
            side_xy = offset_polyline([xy for _, _, xy, _ in stations], run.offset)
            sidewalk_nodes = []
            for (_, road_node, _, connect), (x, y) in zip(stations, side_xy):
                side_node = next_node_id
                next_node_id += 1
                edits.new_nodes[side_node] = to_lonlat(x, y)
                sidewalk_nodes.append(side_node)
                if connect:
                    edits.new_ways.append(
                        (next_way_id, [side_node, road_node], {"highway": "footway", "source": "MOI sidewalk"})
                    )
                    next_way_id += 1
            edits.new_ways.append(
                (next_way_id, sidewalk_nodes, sidewalk_tags(road, run))
            )
            next_way_id += 1

        positions = sorted(
            list(zip(road.cum, road.node_ids)) + list(anchors.items()),
            key=lambda item: item[0],
        )
        if way_id in relation_ways:
            # Keep one complete member way, its direction and original access tags.
            # Inserting collinear anchors preserves restriction and route references.
            edits.road_pieces[way_id] = ([node_id for _,node_id in positions], road.tags)
            continue
        pieces = split_road(road, positions, covered)
        first_nodes, first_tags = pieces[0]
        edits.road_pieces[way_id] = (first_nodes, first_tags)
        for nodes, tags in pieces[1:]:
            edits.new_ways.append((next_way_id, nodes, tags))
            next_way_id += 1
    return edits


def junction_links(ends):
    """Pair sidewalk ends that face each other across one junction.

    Two ends link when they are close and the link stays on their side of
    both roads, which keeps a sidewalk continuous across a side street or
    around a block corner instead of detouring through the road centreline.
    """
    for group in ends.values():
        for i, (road_a, node_a, xy_a, toward_a) in enumerate(group):
            for road_b, node_b, xy_b, toward_b in group[i + 1 :]:
                if road_a.way_id == road_b.way_id and toward_a == toward_b:
                    continue
                if math.dist(xy_a, xy_b) > LINK_MAX_M:
                    continue
                if crosses(xy_a, xy_b, road_a) or crosses(xy_a, xy_b, road_b):
                    continue
                yield road_a, road_b, node_a, node_b


def crosses(p, q, road):
    return any(segments_intersect(p, q, a, b) for a, b in zip(road.xy, road.xy[1:]))


def segments_intersect(p, q, a, b):
    def orient(u, v, w):
        return (v[0] - u[0]) * (w[1] - u[1]) - (v[1] - u[1]) * (w[0] - u[0])

    d1, d2 = orient(a, b, p), orient(a, b, q)
    d3, d4 = orient(p, q, a), orient(p, q, b)
    return d1 * d2 < 0 and d3 * d4 <= 0


def split_road(road, positions, covered):
    """Cut the road at sidewalk ends; only sidewalk-lined pieces use the sidepath."""
    cuts = sorted({0.0, road.length, *(p for interval in covered for p in interval)})
    pieces = []
    for low, high in zip(cuts, cuts[1:]):
        middle = (low + high) / 2
        lined = any(start <= middle <= end for start, end in covered)
        nodes = [node_id for position, node_id in positions if low <= position <= high]
        tags = road.tags
        if lined and "foot" not in tags:
            tags = {**tags, "foot": "use_sidepath"}
        pieces.append((nodes, tags))
    return pieces


def sidewalk_tags(road, run):
    tags = {key: road.tags[key] for key in COPIED_ROAD_TAGS if key in road.tags}
    tags.update(highway="footway", footway="sidewalk", source="MOI sidewalk")
    tags["ref:moi_sidewalk"] = ";".join(sorted(set(run.sources)))[:255]
    return tags


def read_polygons(path):
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            if line.strip():
                record = json.loads(line)
                yield str(record["id"] if "id" in record else record["source_id"]), record["geometry"]


def collect_roads(osmium, pbf, polygons):
    """Pass 1: eligible roads near any sidewalk, plus the max OSM ids."""
    occupied = Grid()
    pad = max(ROAD_MAX_OFFSET_M.values())
    for _, geometry in polygons:
        for rings in polygon_parts(geometry):
            for key in occupied.keys(*bounds_of([to_xy(*p) for p in rings[0]], pad)):
                occupied.cells[key] = True

    class Collector(osmium.SimpleHandler):
        def __init__(self):
            super().__init__()
            self.roads = []
            self.relation_ways = set()
            self.max_node = 0
            self.max_way = 0

        def node(self, node):
            self.max_node = max(self.max_node, node.id)

        def way(self, way):
            self.max_way = max(self.max_way, way.id)
            tags = {tag.k: tag.v for tag in way.tags}
            node_ids = [n.ref for n in way.nodes]
            if not eligible_road(tags, node_ids):
                return
            try:
                lonlats = [(n.lon, n.lat) for n in way.nodes]
            except osmium.InvalidLocationError:
                return
            xy = [to_xy(*p) for p in lonlats]
            if not any(key in occupied.cells for key in occupied.keys(*bounds_of(xy))):
                return
            road = make_road(way.id, node_ids, lonlats, tags)
            if road.length >= MIN_RUN_M:
                self.roads.append(road)

        def relation(self, relation):
            self.relation_ways.update(member.ref for member in relation.members if member.type == "w")

    collector = Collector()
    collector.apply_file(pbf, locations=True)
    return collector


def count_junctions(osmium, pbf, wanted):
    """Pass 2: nodes of `wanted` used by two or more highway way slots."""
    counts = defaultdict(int)

    class Counter(osmium.SimpleHandler):
        def way(self, way):
            if "highway" not in way.tags:
                return
            for n in way.nodes:
                if n.ref in wanted:
                    counts[n.ref] += 1

    Counter().apply_file(pbf)
    return {node_id for node_id, count in counts.items() if count >= 2}


def open_writer(osmium, output_pbf):
    try:
        return osmium.SimpleWriter(osmium.io.File(output_pbf, "pbf"))
    except TypeError:
        return osmium.SimpleWriter(output_pbf)


def write_pbf(osmium, pbf, output_pbf, edits):
    """Pass 3: copy the PBF with edits; new entities follow their kind."""
    writer = open_writer(osmium, output_pbf)

    class Writer(osmium.SimpleHandler):
        def __init__(self):
            super().__init__()
            self.nodes_flushed = False
            self.ways_flushed = False

        def flush_nodes(self):
            if not self.nodes_flushed:
                self.nodes_flushed = True
                for node_id in sorted(edits.new_nodes):
                    writer.add_node(
                        osmium.osm.mutable.Node(
                            id=node_id, location=edits.new_nodes[node_id], tags={}
                        )
                    )

        def flush_ways(self):
            self.flush_nodes()
            if not self.ways_flushed:
                self.ways_flushed = True
                for way_id, node_ids, tags in edits.new_ways:
                    writer.add_way(
                        osmium.osm.mutable.Way(id=way_id, nodes=node_ids, tags=tags)
                    )

        def node(self, node):
            writer.add_node(node)

        def way(self, way):
            self.flush_nodes()
            piece = edits.road_pieces.get(way.id)
            if piece is None:
                writer.add_way(way)
            else:
                writer.add_way(way.replace(nodes=piece[0], tags=piece[1]))

        def relation(self, relation):
            self.flush_ways()
            writer.add_relation(relation)

    handler = Writer()
    try:
        handler.apply_file(pbf)
        handler.flush_ways()
    finally:
        writer.close()


def safe_walk_tags(tags, level=None, road=False):
    """Conservative evidence gate; policy wheelchair=no on a road stays soft."""
    keys = ("foot", "access") if road else ("foot", "access", "wheelchair")
    directional = ("oneway:foot", "foot:forward", "foot:backward", "wheelchair:forward", "wheelchair:backward")
    if any(k in tags for k in directional) or any(k.endswith(":conditional") for k in tags):
        return False
    for key in keys:
        allowed = {None, "yes", "designated", "permissive", "official"}
        if road and key == "foot":
            allowed.add("use_sidepath")
        if tags.get(key) not in allowed:
            return False
    if (tags.get("highway") == "steps" or tags.get("footway") == "steps"
            or tags.get("steps") == "yes" or tags.get("step_count", "0") != "0"
            or tags.get("crossing") == "no" or (not road and tags.get("oneway", "no") != "no")):
        return False
    if tags.get("barrier") not in (None, "no", "kerb"):
        return False
    if tags.get("barrier") == "kerb" and tags.get("kerb") not in ("lowered", "flush"):
        return False
    if tags.get("kerb") not in (None, "no", "lowered", "flush"):
        return False
    for key in ("layer", "level"):
        try:
            float(tags.get(key, "0"))
        except ValueError:
            return False
    grade = tuple(tags.get(k, default) for k, default in (
        ("layer", "0"), ("level", "0"), ("bridge", "no"), ("tunnel", "no")
    ))
    if grade != ("0", "0", "no", "no"):
        return False
    return level is None or grade == level


def walk_grade(tags):
    return tuple(tags.get(k, default) for k, default in (
        ("layer", "0"), ("level", "0"), ("bridge", "no"), ("tunnel", "no")
    ))


def collect_existing(osmium, pbf):
    """Read existing MOI first, then only nearby roads/native ways. No polygons reimported."""
    class Collector(osmium.SimpleHandler):
        def __init__(self):
            super().__init__()
            self.moi = []
            self.ways = {}
            self.node_tags = {}
            self.relation_ways = set()
            self.blocking_members = {}
            self.max_way = 0
            self.occupied = Grid()
            self.phase = 1

        def node(self, node):
            if node.tags:
                tags = dict(node.tags)
                guard_keys = {"barrier", "kerb", "foot", "access", "wheelchair", "layer", "level", "bridge", "tunnel", "highway", "steps", "step_count", "footway", "oneway", "crossing"}
                if any(k in guard_keys or k.endswith(":conditional") or k.split(":")[0] in ("foot", "access", "wheelchair", "oneway") for k in tags):
                    tags["_xy"] = to_xy(node.location.lon, node.location.lat)
                    self.node_tags[node.id] = tags

        def way(self, way):
            self.max_way = max(self.max_way, way.id)
            tags = dict(way.tags)
            if self.phase == 2 and way.id in self.blocking_members:
                tags = {**self.blocking_members[way.id], **tags}
            if self.phase == 1:
                if tags.get("source") != "MOI sidewalk":
                    return
            elif tags.get("source") == "MOI sidewalk" or not (
                tags.get("highway") in MOTOR_HIGHWAYS or tags.get("highway") == "footway"
                or "barrier" in tags or tags.get("building", "no") != "no"
            ):
                return
            try:
                item = make_road(way.id, [n.ref for n in way.nodes], [(n.lon, n.lat) for n in way.nodes], tags)
            except osmium.InvalidLocationError:
                return
            if len(item.node_ids) < 2:
                return
            if self.phase == 1:
                self.moi.append(item)
                for key in self.occupied.keys(*bounds_of(item.xy, LINK_MAX_M)):
                    self.occupied.cells[key] = True
            elif way.id not in self.blocking_members and not any(key in self.occupied.cells for key in self.occupied.keys(*bounds_of(item.xy))):
                return
            self.ways[item.way_id] = item

        def relation(self, relation):
            if self.phase == 1:
                self.relation_ways.update(m.ref for m in relation.members if m.type == "w")
                tags = dict(relation.tags)
                if tags.get("building", "no") != "no" or tags.get("barrier", "no") != "no":
                    for member in relation.members:
                        if member.type == "w":
                            self.blocking_members[member.ref] = {**tags, "_blocking_relation": relation.id}

    result = Collector()
    result.apply_file(pbf, locations=True)
    result.phase = 2
    result.apply_file(pbf, locations=True)
    return result


def existing_indexes(ways):
    roads = {w.way_id: w for w in ways.values() if w.tags.get("highway") in ROAD_MAX_OFFSET_M}
    mains = {w.way_id: w for w in ways.values() if w.tags.get("source") == "MOI sidewalk"
             and w.tags.get("footway") == "sidewalk" and w.tags.get("ref:moi_sidewalk")
             and w.tags.get("a11y:native_connection") != "yes"}
    road_nodes = defaultdict(set)
    side_nodes = defaultdict(set)
    for w in roads.values():
        for n in w.node_ids:
            road_nodes[n].add(w.way_id)
    for w in mains.values():
        for n in w.node_ids:
            side_nodes[n].add(w.way_id)
    connectors = []
    for w in ways.values():
        if w.tags.get("source") != "MOI sidewalk" or "footway" in w.tags or len(w.node_ids) != 2:
            continue
        a, b = w.node_ids
        if a in side_nodes and b in road_nodes:
            connectors.append((w, a, b))
        elif b in side_nodes and a in road_nodes:
            connectors.append((w, b, a))
    return roads, mains, road_nodes, side_nodes, connectors


def plan_coverage_cuts(ways, relation_ways, next_way_id):
    """Recover existing run-end cuts before the unchanged policy compiler evaluates them."""
    roads, mains, road_nodes, side_nodes, connectors = existing_indexes(ways)
    cuts = defaultdict(set)
    for _, side, anchor in connectors:
        if any(side in (mains[m].node_ids[0], mains[m].node_ids[-1]) for m in side_nodes[side]):
            for road_id in road_nodes[anchor]:
                cuts[road_id].add(anchor)
    edits, proof = Edits(), []
    for road_id, anchors in sorted(cuts.items()):
        w = roads[road_id]
        if w.tags.get("foot") != "use_sidepath" or "wheelchair" in w.tags:
            continue
        indexes = sorted({0, len(w.node_ids)-1} | {i for i,n in enumerate(w.node_ids) if n in anchors})
        if len(indexes) < 3:
            continue
        if road_id in relation_ways:
            proof.append({"roadId": road_id, "status": "skipped_relation_member"})
            continue
        pieces = [list(w.node_ids[a:b+1]) for a,b in zip(indexes,indexes[1:])]
        edits.road_pieces[road_id] = (pieces[0], w.tags)
        ids = [road_id]
        for nodes in pieces[1:]:
            edits.new_ways.append((next_way_id, nodes, w.tags))
            ids.append(next_way_id)
            next_way_id += 1
        proof.append({"roadId": road_id, "status": "split", "pieceIds": ids, "nodes": pieces})
    return edits, proof


def plan_native_repairs(ways, node_tags, relation_ways, next_way_id, corner_polygons=(), source_alignment_m=0.0):
    """Join source-covered sidewalks to existing native chains; retain road access."""
    import heapq
    from shapely.geometry import LineString, Point, Polygon

    if not math.isfinite(source_alignment_m) or not 0 <= source_alignment_m <= 2:
        raise ValueError("source_alignment_m must be between 0 and 2 metres")
    roads, mains, road_nodes, side_nodes, connectors = existing_indexes(ways)
    from shapely.geometry import shape
    from shapely.ops import transform
    source_refs = {ref for main in mains.values() for ref in main.tags["ref:moi_sidewalk"].split(";")}
    coverage = defaultdict(list)
    coverage_grid = Grid()
    for ref, geometry in corner_polygons:
        ref = str(ref)
        if ref not in source_refs:
            continue
        polygon = transform(lambda x,y,z=None:to_xy(x,y), shape(geometry))
        if polygon.is_empty or not polygon.is_valid or polygon.geom_type not in ("Polygon", "MultiPolygon"):
            continue
        coverage[ref].append(polygon)
        coverage_grid.add((ref, polygon), polygon.buffer(source_alignment_m).bounds)
    covered_refs = set(coverage)

    def covered_by(segment, refs, tolerance=0.0):
        return sorted({ref for ref in refs for polygon in coverage.get(ref, ())
                       if (polygon.buffer(tolerance) if tolerance else polygon).covers(segment)})

    def maximum_source_offset(segment, refs):
        polygons = [polygon for ref in refs for polygon in coverage[ref]]
        count = max(1, math.ceil(segment.length / 0.02))
        return round(max(min(segment.interpolate(segment.length*i/count).distance(polygon)
                             for polygon in polygons) for i in range(count+1)), 6)

    xy = {n:p for w in ways.values() for n,p in zip(w.node_ids,w.xy)}
    native = {w.way_id:w for w in ways.values() if w.tags.get("source") != "MOI sidewalk"
              and w.tags.get("highway") == "footway" and w.tags.get("footway") in ("sidewalk", "crossing")
              and safe_walk_tags(w.tags) and w.tags.get("area") != "yes"}
    native_edges = defaultdict(list)
    crossings = defaultdict(list)
    road_edges = defaultdict(list)
    grid = Grid()
    blockers = Grid()
    relation_lines = defaultdict(list)
    for w in ways.values():
        if "_blocking_relation" in w.tags:
            relation_lines[w.tags["_blocking_relation"]].append(w)
        if "barrier" in w.tags and w.tags["barrier"] != "no":
            blockers.add((w, LineString(w.xy)), bounds_of(w.xy))
        elif w.tags.get("building", "no") != "no" and len(w.xy) >= 4 and w.node_ids[0] == w.node_ids[-1]:
            polygon = Polygon(w.xy)
            if polygon.is_valid:
                blockers.add((w, polygon), bounds_of(w.xy))
    from shapely.ops import polygonize
    for members in relation_lines.values():
        for polygon in polygonize([LineString(w.xy) for w in members]):
            blockers.add((members[0], polygon), polygon.bounds)
    barrier_grid = Grid()
    for tags in node_tags.values():
        if "_xy" in tags and ("barrier" in tags or "kerb" in tags):
            barrier_grid.add(tags, bounds_of([tags["_xy"]], 0.5))
    for w in ways.values():
        if w.tags.get("highway") in MOTOR_HIGHWAYS:
            grid.add(w, bounds_of(w.xy))
    for w in roads.values():
        if safe_walk_tags(w.tags, road=True):
            for a,b,p,q in zip(w.node_ids,w.node_ids[1:],w.xy,w.xy[1:]):
                d=math.dist(p,q)
                road_edges[a].append((b,d,w.way_id)); road_edges[b].append((a,d,w.way_id))
    for w in native.values():
        grade = walk_grade(w.tags)
        if not all(safe_walk_tags(node_tags.get(n, {}), grade) for n in w.node_ids):
            continue
        for a,b,p,q in zip(w.node_ids,w.node_ids[1:],w.xy,w.xy[1:]):
            d=math.dist(p,q)
            native_edges[a].append((b,d,w.way_id)); native_edges[b].append((a,d,w.way_id))
        if w.tags.get("footway") == "crossing":
            for n in w.node_ids:
                if n in road_nodes:
                    crossings[n].append(w)

    def same_direction(a,b):
        ax,ay=a.xy[-1][0]-a.xy[0][0],a.xy[-1][1]-a.xy[0][1]
        bx,by=b.xy[-1][0]-b.xy[0][0],b.xy[-1][1]-b.xy[0][1]
        den=math.hypot(ax,ay)*math.hypot(bx,by)
        return bool(den) and abs((ax*bx+ay*by)/den)>0.85

    spine_cache = {}
    def owner_spine(basis, seeds, bounds):
        key = (basis.way_id, frozenset(seeds), bounds)
        if key not in spine_cache:
            candidates = {w.way_id for w in grid.query(bounds)
                          if w.way_id in roads and same_direction(basis,w) and safe_walk_tags(w.tags,walk_grade(basis.tags),road=True)}
            owners, todo = set(), list(seeds & candidates)
            while todo:
                rid = todo.pop()
                if rid in owners:
                    continue
                owners.add(rid)
                for n in roads[rid].node_ids:
                    todo.extend((road_nodes[n] & candidates) - owners)
            spine_cache[key] = owners
        return spine_cache[key]

    def road_path(start,end,owners,grade):
        todo=[(0,start,[])]; seen=set()
        while todo:
            distance,n,path=heapq.heappop(todo)
            if n in seen or distance>LINK_REACH_M:
                continue
            seen.add(n)
            if not safe_walk_tags(node_tags.get(n,{}),grade,road=True):
                continue
            if n==end:
                return path+[n]
            for other,d,wid in road_edges[n]:
                if wid in owners and safe_walk_tags(roads[wid].tags,grade,road=True):
                    heapq.heappush(todo,(distance+d,other,path+[n]))
        return None

    def clear_link(p,q,grade):
        line = LineString([p,q])
        def separate(tags):
            try:
                values = [float(tags.get(k,"0")) for k in ("layer","level")]
            except (ValueError, TypeError):
                return False
            if not all(math.isfinite(v) for v in values) or any(tags.get(k,"no") not in ("yes","no") for k in ("bridge","tunnel")):
                return False
            return any(value != float(target) for value,target in zip(values,grade[:2]))
        if any(line.intersects(LineString(w.xy)) for w in grid.query(bounds_of([p,q])) if not separate(w.tags)):
            return False
        if any(geometry.intersects(line) for w,geometry in blockers.query(bounds_of([p,q])) if not separate(w.tags)):
            return False
        return not any("_xy" in tags and not safe_walk_tags(tags,grade) and Point(tags["_xy"]).distance(line) < 0.5
                       for tags in barrier_grid.query(bounds_of([p,q], 0.5)) if not separate(tags))

    bindings = defaultdict(dict)
    main_connectors = defaultdict(list)
    for w,side,anchor in connectors:
        for mid in side_nodes[side]:
            main_connectors[mid].append((w,side,anchor))
    for mid, group in main_connectors.items():
        main=mains[mid]; grade=walk_grade(main.tags)
        if not (set(main.tags["ref:moi_sidewalk"].split(";")) & covered_refs):
            continue
        if not safe_walk_tags(main.tags):
            continue
        owners={rid for _,_,a in group for rid in road_nodes[a]
                if same_direction(main,roads[rid]) and safe_walk_tags(roads[rid].tags,grade,road=True)}
        if not owners:
            continue
        owners = owner_spine(main, owners, bounds_of(main.xy, LINK_REACH_M))
        forbidden={n for rid in owners for n in roads[rid].node_ids}
        basis=max((roads[r] for r in owners),key=lambda r:r.length)
        side_sign=project(basis,*main.xy[len(main.xy)//2])[1]
        if abs(side_sign)<MIN_OFFSET_M:
            continue
        anchors = {n for rid in owners for n in roads[rid].node_ids if n in crossings}
        for anchor in anchors:
            if not any(road_path(a,anchor,owners,grade) is not None for _,_,a in group):
                continue
            for crossing in crossings[anchor]:
                if not safe_walk_tags(crossing.tags,grade) or not (road_nodes[anchor]&owners):
                    continue
                ai=crossing.node_ids.index(anchor)
                for endpoint,ei in ((crossing.node_ids[0],0),(crossing.node_ids[-1],len(crossing.node_ids)-1)):
                    chain=list(crossing.node_ids[min(ai,ei):max(ai,ei)+1])
                    if ei<ai:chain.reverse()
                    if endpoint==anchor or endpoint in forbidden or not all(safe_walk_tags(node_tags.get(n,{}),grade) for n in chain):
                        continue
                    if project(basis,*xy[endpoint])[1]*side_sign<=0:
                        continue
                    todo=[(0,endpoint,[endpoint],[])]; seen=set()
                    while todo:
                        distance,n,path,pathways=heapq.heappop(todo)
                        if n in seen or n in forbidden or distance>LINK_REACH_M:
                            continue
                        seen.add(n)
                        offset=project(basis,*xy[n])[1]
                        if offset*side_sign<=0 or not safe_walk_tags(node_tags.get(n,{}),grade):
                            continue
                        if n not in road_nodes:
                            bindings[mid].setdefault(n,[]).append({"anchor":anchor,"crossing":crossing.way_id,
                                "nativeNodeChain":chain+path[1:],"nativeWayChain":[crossing.way_id]+pathways,
                                "owners":owners,"grade":grade,"basis":basis})
                        for other,d,wid in native_edges[n]:
                            if safe_walk_tags(native[wid].tags,grade):
                                heapq.heappush(todo,(distance+d,other,path+[other],pathways+[wid]))

    edits, proof = Edits(), []
    existing = {frozenset((a,b)) for w in ways.values() for a,b in zip(w.node_ids,w.node_ids[1:])}
    for connector,side,anchor in connectors:
        if connector.way_id in relation_ways or not safe_walk_tags(connector.tags):
            continue
        if any(frozenset((side,target)) in existing for mid in side_nodes[side] for target in bindings[mid]):
            continue
        choices=[]
        for mid in side_nodes[side]:
            for target,witnesses in bindings[mid].items():
                gap=math.dist(xy[side],xy[target])
                if gap>5.0 or side==target or frozenset((side,target)) in existing:
                    continue
                segment = LineString([xy[side],xy[target]])
                own_refs = mains[mid].tags["ref:moi_sidewalk"].split(";")
                refs = covered_by(segment, own_refs)
                uses_inference = not refs
                if uses_inference and source_alignment_m:
                    refs = covered_by(segment, own_refs, source_alignment_m)
                if not refs:
                    continue
                for witness in witnesses:
                    grade=witness["grade"]; basis=witness["basis"]
                    if not safe_walk_tags(connector.tags,grade) or not safe_walk_tags(node_tags.get(side,{}),grade):
                        continue
                    source_offset=project(basis,*xy[side])[1]; target_offset=project(basis,*xy[target])[1]
                    if source_offset*target_offset<=0 or abs(abs(source_offset)-abs(target_offset))>MERGE_OFFSET_M:
                        continue
                    if not clear_link(xy[side],xy[target],grade):
                        continue
                    path=road_path(witness["anchor"],anchor,witness["owners"],grade)
                    if path is not None:
                        choices.append((gap,target,witness,path,refs,uses_inference))
        if not choices:
            continue
        gap,target,witness,path,refs,uses_inference=min(choices,key=lambda c:(c[5],c[0],c[1],c[2]["crossing"]))
        tags = {"highway":"footway", "footway":"sidewalk", "source":"MOI sidewalk",
                "ref:moi_sidewalk":";".join(refs)[:255], "a11y:native_connection":"yes"}
        if uses_inference:
            tags["a11y:inferred_connection"] = "yes"
        edits.new_ways.append((next_way_id,[side,target],tags))
        existing.add(frozenset((side,target)))
        next_way_id += 1
        proof.append({"inferred": uses_inference, "sourceToleranceM": source_alignment_m if uses_inference else 0.0,
            "maximumSourceOffsetM": maximum_source_offset(LineString([xy[side],xy[target]]), refs),
            "maxOffsetSamplingErrorM": 0.01, "connectorId":connector.way_id,"sideNode":side,"oldAnchor":anchor,"nativeNode":target,
            "gapM":round(gap,6),"coverageRefs":refs,"nativeNodeChain":witness["nativeNodeChain"],"nativeWayChain":witness["nativeWayChain"],
            "crossingAnchor":witness["anchor"],"existingRoadReturnChain":path,
            "alternativeExcludesAllGeneratedConnectors":True,"preservesOriginalConnector":True})
    if corner_polygons:
        junctions={n for n,ids in road_nodes.items() if any(not same_direction(roads[a],roads[b]) for a in ids for b in ids if a!=b)}
        ends=defaultdict(list)
        corner_evidence=defaultdict(list)
        for anchor, crossing_ways in crossings.items():
            for rid in road_nodes[anchor]:
                road=roads[rid];grade=walk_grade(road.tags)
                owners=owner_spine(road,{rid},bounds_of(road.xy,LINK_REACH_M))
                owner_nodes={n for owner in owners for n in roads[owner].node_ids}
                for junction in junctions & owner_nodes:
                    road_return = road_path(anchor,junction,owners,grade)
                    if road_return is None:
                        continue
                    for crossing in crossing_ways:
                        if not safe_walk_tags(crossing.tags,grade):continue
                        for endpoint in (crossing.node_ids[0],crossing.node_ids[-1]):
                            if endpoint in road_nodes or not all(safe_walk_tags(node_tags.get(n,{}),grade) for n in crossing.node_ids):continue
                            ends[junction].append((road,endpoint,xy[endpoint],0))
                            ai = crossing.node_ids.index(anchor)
                            ei = crossing.node_ids.index(endpoint)
                            chain = list(crossing.node_ids[min(ai,ei):max(ai,ei)+1])
                            if ei < ai:
                                chain.reverse()
                            corner_evidence[(road.way_id,endpoint)].append({"junction":junction,"crossingId":crossing.way_id,
                                "crossingAnchor":anchor,"nativeNodeChain":chain,"existingRoadReturnChain":road_return})
        for road_a,road_b,a,b in junction_links(ends):
            grade=walk_grade(road_a.tags);pair=frozenset((a,b));p,q=xy[a],xy[b]
            if a==b or pair in existing or walk_grade(road_b.tags)!=grade or math.dist(p,q)>5.0 or not clear_link(p,q,grade):continue
            witnesses = [(left,right) for left in corner_evidence[(road_a.way_id,a)]
                         for right in corner_evidence[(road_b.way_id,b)] if left["junction"]==right["junction"]]
            if not witnesses:
                continue
            segment = LineString([p,q])
            local_refs={ref for ref,_ in coverage_grid.query(segment.bounds)}
            refs=covered_by(segment,local_refs)
            uses_inference = not refs
            if uses_inference and source_alignment_m:
                refs=covered_by(segment,local_refs,source_alignment_m)
            if not refs:continue
            tags={"highway":"footway","footway":"sidewalk","source":"MOI sidewalk","ref:moi_sidewalk":";".join(sorted(refs))[:255],"a11y:native_connection":"yes"}
            if uses_inference:
                tags["a11y:inferred_connection"] = "yes"
            edits.new_ways.append((next_way_id,[a,b],tags));existing.add(pair)
            proof.append({"cornerWayId":next_way_id,"nodes":[a,b],"coverageRefs":refs,"lengthM":math.dist(p,q),
                          "inferred": uses_inference, "sourceToleranceM":source_alignment_m if uses_inference else 0.0,
                          "maximumSourceOffsetM":maximum_source_offset(segment, refs), "maxOffsetSamplingErrorM":0.01,
                          "originalNativeCornerWitnesses":witnesses[0]})
            next_way_id+=1
    return edits,proof


def repair_existing_cli(argv):
    import argparse
    import hashlib
    import osmium
    operation=argv[0]
    parser=argparse.ArgumentParser(description="Incremental existing sidewalk repair")
    parser.add_argument("input");parser.add_argument("output");parser.add_argument("--proof",required=True);parser.add_argument("--corner-coverage")
    parser.add_argument("--source-alignment-m",type=float,default=0.0)
    args=parser.parse_args(argv[1:])
    if os.path.abspath(args.input)==os.path.abspath(args.output) or os.path.exists(args.output):
        raise SystemExit("Output must be a new PBF path")
    collected=collect_existing(osmium,args.input)
    if operation=="--split-coverage":
        edits,proof=plan_coverage_cuts(collected.ways,collected.relation_ways,collected.max_way+1)
    else:
        polygons=list(read_polygons(args.corner_coverage)) if args.corner_coverage else []
        edits,proof=plan_native_repairs(collected.ways,collected.node_tags,collected.relation_ways,collected.max_way+1,polygons,args.source_alignment_m)
    write_pbf(osmium,args.input,args.output,edits)
    def digest(path):
        h=hashlib.sha256()
        with open(path,'rb') as f:
            for block in iter(lambda:f.read(1024*1024),b''):h.update(block)
        return h.hexdigest()
    result={"operation":operation,"source":os.path.abspath(args.input),"sourceSha256":digest(args.input),"output":os.path.abspath(args.output),"outputSha256":digest(args.output),"changedWays":len(edits.road_pieces),"newWays":len(edits.new_ways),"records":proof}
    result["sourceAlignmentM"] = args.source_alignment_m
    if args.corner_coverage:
        result["sourcePolygons"] = {"path":os.path.abspath(args.corner_coverage), "sha256":digest(args.corner_coverage)}
    with open(args.proof,'w',encoding='utf-8') as f:json.dump(result,f,ensure_ascii=False,indent=2)
    print(json.dumps({k:v for k,v in result.items() if k!='records'},ensure_ascii=False))


def main(argv=None):
    args = sys.argv[1:] if argv is None else argv
    if args and args[0] in ("--repair-existing", "--split-coverage"):
        return repair_existing_cli(args)
    if len(args) != 3:
        raise SystemExit(
            f"Usage: {sys.argv[0]} <input.osm.pbf> <sidewalks.ndjson> <output.osm.pbf>"
        )
    input_pbf, sidewalks, output_pbf = args
    for path in (input_pbf, sidewalks):
        if not os.path.isfile(path):
            raise SystemExit(f"Input not found: {path}")
    if os.path.exists(output_pbf):
        raise SystemExit(f"Output PBF already exists: {output_pbf}")
    import osmium

    polygons = list(read_polygons(sidewalks))
    if not polygons:
        raise SystemExit("No sidewalk polygons in the export")
    collected = collect_roads(osmium, input_pbf, polygons)
    runs = match_sidewalks(polygons, collected.roads)
    if not runs:
        raise SystemExit("No sidewalk polygon matched a road")
    run_ways = {run.way_id for run in runs}
    wanted = {
        node_id
        for road in collected.roads
        if road.way_id in run_ways
        for node_id in road.node_ids
    }
    junctions = count_junctions(osmium, input_pbf, wanted)
    edits = plan_edits(
        collected.roads, runs, junctions, collected.max_node + 1, collected.max_way + 1,
        relation_ways=collected.relation_ways,
    )
    write_pbf(osmium, input_pbf, output_pbf, edits)
    matched = {source for run in runs for source in run.sources}
    added = [tags for _, _, tags in edits.new_ways if tags.get("source") == "MOI sidewalk"]
    pieces = [tags for _, tags in edits.road_pieces.values()]
    pieces += [tags for _, _, tags in edits.new_ways if tags.get("source") != "MOI sidewalk"]
    print(
        "[otp-sidewalk-ways] "
        f"polygons={len(polygons)} matched={len(matched)} "
        f"sidewalk_km={sum(run.length for run in runs) / 1000:.1f} "
        f"sidewalk_ways={sum(1 for tags in added if tags.get('footway') == 'sidewalk')} "
        f"connectors={sum(1 for tags in added if 'footway' not in tags)} "
        f"use_sidepath_pieces={sum(1 for tags in pieces if tags.get('foot') == 'use_sidepath')}"
    )


if __name__ == "__main__":
    main()
