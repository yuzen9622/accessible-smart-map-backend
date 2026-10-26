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


def plan_edits(roads, runs, junctions, next_node_id, next_way_id):
    """Plan the PBF edits: inserted road nodes, sidewalks, connectors, tags."""
    by_way = defaultdict(list)
    for run in runs:
        by_way[run.way_id].append(run)
    roads_by_id = {road.way_id: road for road in roads}
    edits = Edits()
    ends = defaultdict(list)
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
            for along, road_node, node, xy, toward in (
                (start, start_node, sidewalk_nodes[0], side_xy[0], -1),
                (end, end_node, sidewalk_nodes[-1], side_xy[-1], 1),
            ):
                junction = nearest_junction(road, along, toward, junctions)
                if junction is None:
                    continue
                ends[junction].append((road, node, xy, toward))
                if junction != road_node:
                    edits.new_ways.append(
                        (next_way_id, [node, junction], {"highway": "footway", "source": "MOI sidewalk"})
                    )
                    next_way_id += 1

        positions = sorted(
            list(zip(road.cum, road.node_ids)) + list(anchors.items()),
            key=lambda item: item[0],
        )
        pieces = split_road(road, positions, covered)
        first_nodes, first_tags = pieces[0]
        edits.road_pieces[way_id] = (first_nodes, first_tags)
        for nodes, tags in pieces[1:]:
            edits.new_ways.append((next_way_id, nodes, tags))
            next_way_id += 1
    for road_a, road_b, node_a, node_b in junction_links(ends):
        tags = {"highway": "footway", "footway": "sidewalk", "source": "MOI sidewalk"}
        edits.new_ways.append((next_way_id, [node_a, node_b], tags))
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


def nearest_junction(road, along, toward, junctions):
    """The first junction node within reach beyond a sidewalk end."""
    best = None
    for position, node_id in zip(road.cum, road.node_ids):
        reach = (position - along) * toward
        if node_id in junctions and -SNAP_M <= reach <= LINK_REACH_M:
            if best is None or reach < best[0]:
                best = (reach, node_id)
    return best and best[1]


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
        if pieces and pieces[-1][1] == tags:
            pieces[-1] = (pieces[-1][0] + nodes[1:], tags)
        else:
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
                yield str(record["id"]), record["geometry"]


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


def main(argv=None):
    args = sys.argv[1:] if argv is None else argv
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
        collected.roads, runs, junctions, collected.max_node + 1, collected.max_way + 1
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
