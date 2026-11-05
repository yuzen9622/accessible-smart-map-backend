#!/usr/bin/env python3
"""Tag Taipei crossings without a curb ramp so stock OTP avoids them for wheelchairs.

Stock OTP 2.9 multiplies a wheelchair request's cost on an edge whose way is
`wheelchair=no` by `inaccessibleStreetReluctance` (router-config.json: 5); it
never forbids the edge. This step turns the government curb-ramp inventory into
that tag on crossing ways, so OTP's own search prefers ramped crossings.

Each crossing way end (first/last node) is classified:
  ramped    a government ramp point within RAMP_TOLERANCE_M, an OSM kerb tag of
            lowered/flush/no on the end node, or the end lies on a painted
            sidewalk strip (level with the road, no kerb to climb);
  unramped  not ramped, and either the end node carries OSM barrier=kerb with a
            raised kerb, or the end lies within SIDEWALK_END_TOLERANCE_M of a
            Taipei MOI sidewalk polygon whose ramp inventory is complete: the
            polygon's MOI ramp count is known and at least that many government
            ramp points lie within RAMP_TOLERANCE_M of it;
  unknown   anything else (no claim is made).

A crossing way with any unramped end, and no OSM `wheelchair` tag of its own,
gets `wheelchair=no` plus `source:wheelchair=taipei_kerb_ramp`. Ways are never
split, so a crossing stays one OSM way. Every crossing with any evidence gets
`tp:kerb_ramp_ends=<ramped>/<unramped>/<unknown>`.

Taipei road pieces that otp-sidewalk-ways.py lined with a sidewalk
(`foot=use_sidepath`) also get `wheelchair=no` plus
`source:wheelchair=taipei_sidewalk_alongside`. OTP's wheelchair cost ignores walk
safety, so without this, penalising unramped crossings pushed wheelchair routes
onto the carriageway instead (Taipei OTP comparison 2026-11-04: carriageway
share 36% → 58% on changed routes; with lined roads tagged it fell to 46% from
58% while confidently unramped crossings walked fell 19 → 4).

The CSR graph builder ignores wheelchair values with either provenance (CSR keeps
its own three-tier ramp cost and reads wheelchair=no as a block).

Usage: otp-kerb-ramps.py <input.osm.pbf> <ramps.ndjson> <sidewalks.ndjson> <output.osm.pbf> [--report <json>]
  ramps.ndjson      {"id": ..., "lon": ..., "lat": ...} per line
  sidewalks.ndjson  {"id": ..., "kind": "moi"|"painted", "ramp_count": int|null,
                     "geometry": <GeoJSON (Multi)Polygon>} per line (Taipei only)
"""

from __future__ import annotations

import json
import math
import os
import sys
from collections import Counter, defaultdict

LAT0 = 25.05
M_PER_DEG_LAT = 110_540.0
M_PER_DEG_LON = 111_320.0 * math.cos(math.radians(LAT0))

# Taipei crosswalks are 6–8 m wide and OSM draws the crossing down the middle while
# the ramp sits at the crosswalk edge: 70% of ends judged unramped at 8 m had a
# government ramp 8–20 m away (2026-11-04). 20 m keeps "unramped" to ends with no
# ramp anywhere near; its known blind spot is a ramp across the corner counting as
# this crossing's. The CSR node mapping keeps its own 8 m
# (import-taipei-ramps.ts RAMP_SNAP_TOLERANCE_M), measured for node snapping.
RAMP_TOLERANCE_M = 20.0
# Same as the CSR painted mapping (import-taipei-painted-sidewalks.ts PAINTED_NODE_TOLERANCE_M);
# also how close a crossing end must be to a surveyed MOI sidewalk to be judged by it.
SIDEWALK_END_TOLERANCE_M = 3.0
STEP_FREE_KERBS = frozenset({"lowered", "flush", "no"})
RAISED_KERBS = frozenset({"raised", "regular", "rolled"})
WHEELCHAIR_TAG_SOURCE = "taipei_kerb_ramp"
LINED_ROAD_WHEELCHAIR_SOURCE = "taipei_sidewalk_alongside"
# A use_sidepath road piece is Taipei's when its middle lies this close to a Taipei
# MOI/painted polygon: otp-sidewalk-ways.py lines a road from a polygon at most
# ROAD_MAX_OFFSET_M (30 m) away.
LINED_ROAD_SCOPE_M = 30.0
GRID_M = 50.0


def to_xy(lon, lat):
    return lon * M_PER_DEG_LON, lat * M_PER_DEG_LAT


class PointGrid:
    def __init__(self, size=GRID_M):
        self.size = size
        self.cells = defaultdict(list)

    def add(self, x, y):
        self.cells[(math.floor(x / self.size), math.floor(y / self.size))].append((x, y))

    def any_within(self, x, y, radius):
        return self.count_within(x, y, radius, stop_at=1) > 0

    def count_within(self, x, y, radius, stop_at=None):
        reach = math.ceil(radius / self.size)
        cx, cy = math.floor(x / self.size), math.floor(y / self.size)
        found = 0
        for i in range(cx - reach, cx + reach + 1):
            for j in range(cy - reach, cy + reach + 1):
                for px, py in self.cells.get((i, j), ()):
                    if math.hypot(px - x, py - y) <= radius:
                        found += 1
                        if stop_at is not None and found >= stop_at:
                            return found
        return found


def is_crossing(tags):
    return tags.get("footway") == "crossing" or tags.get("highway") == "crossing"


def read_ndjson(path):
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            if line.strip():
                yield json.loads(line)


def projected_polygon(geometry):
    from shapely.affinity import scale
    from shapely.geometry import shape

    return scale(shape(geometry), M_PER_DEG_LON, M_PER_DEG_LAT, origin=(0, 0)).buffer(0)


class Evidence:
    """Ramp points plus the painted and inventory-complete MOI sidewalk polygons."""

    def __init__(self, ramp_points, sidewalks):
        from shapely.strtree import STRtree

        self.ramps = PointGrid()
        for lon, lat in ramp_points:
            self.ramps.add(*to_xy(lon, lat))
        painted, complete, taipei = [], [], []
        self.moi_total = 0
        self.moi_complete = 0
        for record in sidewalks:
            polygon = projected_polygon(record["geometry"])
            if polygon.is_empty:
                continue
            taipei.append(polygon)
            if record.get("kind") == "painted":
                painted.append(polygon)
                continue
            self.moi_total += 1
            if self.inventory_complete(polygon, record.get("ramp_count")):
                self.moi_complete += 1
                complete.append(polygon)
        self.painted = painted
        self.complete = complete
        self.taipei = taipei
        self.taipei_tree = STRtree(self.taipei) if self.taipei else None
        self.painted_tree = STRtree(painted) if painted else None
        self.complete_tree = STRtree(complete) if complete else None

    def inventory_complete(self, polygon, ramp_count):
        if not isinstance(ramp_count, (int, float)) or ramp_count < 0 or math.isnan(ramp_count):
            return False
        reach = polygon.buffer(RAMP_TOLERANCE_M)
        min_x, min_y, max_x, max_y = reach.bounds
        from shapely.geometry import Point

        found = 0
        size = self.ramps.size
        for i in range(math.floor(min_x / size), math.floor(max_x / size) + 1):
            for j in range(math.floor(min_y / size), math.floor(max_y / size) + 1):
                for px, py in self.ramps.cells.get((i, j), ()):
                    if reach.contains(Point(px, py)):
                        found += 1
        return found >= ramp_count

    @staticmethod
    def _near(tree, polygons, x, y, radius):
        if tree is None:
            return False
        from shapely.geometry import Point

        point = Point(x, y)
        for hit in tree.query(point.buffer(radius)):
            # Shapely 2 returns indices; Shapely 1 returns the geometries.
            polygon = hit if hasattr(hit, "geom_type") else polygons[int(hit)]
            if polygon.distance(point) <= radius:
                return True
        return False

    def in_taipei(self, lon, lat):
        """Whether a point is inside the area these Taipei sources describe: within
        LINED_ROAD_SCOPE_M of a Taipei sidewalk polygon or RAMP_TOLERANCE_M of a
        Taipei government ramp point. Nothing outside it is tagged."""
        x, y = to_xy(lon, lat)
        return self.ramps.any_within(x, y, RAMP_TOLERANCE_M) or self._near(
            self.taipei_tree, self.taipei, x, y, LINED_ROAD_SCOPE_M
        )

    def classify_end(self, lon, lat, node_tags):
        return self.classify_end_with_reason(lon, lat, node_tags)[0]

    def classify_end_with_reason(self, lon, lat, node_tags):
        """Return (class, evidence) for one crossing end."""
        kerb = node_tags.get("kerb")
        x, y = to_xy(lon, lat)
        if kerb in STEP_FREE_KERBS:
            return "ramped", "osm_kerb"
        if self.ramps.any_within(x, y, RAMP_TOLERANCE_M):
            return "ramped", "ramp_point"
        if self._near(self.painted_tree, self.painted, x, y, SIDEWALK_END_TOLERANCE_M):
            return "ramped", "painted_sidewalk"
        if kerb in RAISED_KERBS or (node_tags.get("barrier") == "kerb" and kerb is None):
            return "unramped", "osm_kerb"
        if self._near(self.complete_tree, self.complete, x, y, SIDEWALK_END_TOLERANCE_M):
            return "unramped", "complete_inventory"
        return "unknown", "none"


def crossing_tags(tags, ends):
    """Return the new tag dict for a crossing way, or None to leave it untouched.
    A crossing that already carries an OSM `wheelchair` tag is left exactly as mapped."""
    if "wheelchair" in tags:
        return None
    counts = Counter(ends)
    if counts["ramped"] + counts["unramped"] == 0:
        return None
    updated = dict(tags)
    updated["tp:kerb_ramp_ends"] = f"{counts['ramped']}/{counts['unramped']}/{counts['unknown']}"
    if counts["unramped"]:
        updated["wheelchair"] = "no"
        updated["source:wheelchair"] = WHEELCHAIR_TAG_SOURCE
    return updated


def lined_road_tags(tags):
    """Return new tags for a sidewalk-lined road piece, or None to leave it.

    A junction-box piece otp-sidewalk-ways.py tagged only to bridge two lined
    pieces (`source:foot=sidewalk_junction_gap`) has no sidewalk alongside, so
    it does not get this provenance.
    """
    if tags.get("foot") != "use_sidepath" or "wheelchair" in tags:
        return None
    if tags.get("source:foot") == "sidewalk_junction_gap":
        return None
    return {**tags, "wheelchair": "no", "source:wheelchair": LINED_ROAD_WHEELCHAIR_SOURCE}


def collect_crossings(osmium, pbf):
    """Pass 1: crossing ways with end locations, lined road pieces with their
    middle location; pass 2: end-node tags."""

    class Ways(osmium.SimpleHandler):
        def __init__(self):
            super().__init__()
            self.crossings = {}
            self.lined_roads = {}

        def way(self, way):
            tags = {tag.k: tag.v for tag in way.tags}
            if tags.get("foot") == "use_sidepath" and len(way.nodes) >= 2:
                try:
                    middle = way.nodes[len(way.nodes) // 2]
                    self.lined_roads[way.id] = (tags, (middle.lon, middle.lat))
                except osmium.InvalidLocationError:
                    pass
                return
            if not is_crossing(tags) or len(way.nodes) < 2:
                return
            try:
                first, last = way.nodes[0], way.nodes[-1]
                ends = [(first.ref, first.lon, first.lat), (last.ref, last.lon, last.lat)]
            except osmium.InvalidLocationError:
                return
            self.crossings[way.id] = (tags, ends)

    ways = Ways()
    ways.apply_file(pbf, locations=True)
    wanted = {ref for _, ends in ways.crossings.values() for ref, _, _ in ends}

    class Nodes(osmium.SimpleHandler):
        def __init__(self):
            super().__init__()
            self.tags = {}

        def node(self, node):
            if node.id in wanted and len(node.tags):
                self.tags[node.id] = {tag.k: tag.v for tag in node.tags}

    nodes = Nodes()
    nodes.apply_file(pbf)
    return ways.crossings, ways.lined_roads, nodes.tags


def plan(crossings, node_tags, evidence, lined_roads=None):
    """Return ({way_id: new_tags}, report)."""
    changes = {}
    report = Counter()
    for way_id, (tags, (lon, lat)) in (lined_roads or {}).items():
        report["lined_road_pieces"] += 1
        if not evidence.in_taipei(lon, lat):
            continue
        updated = lined_road_tags(tags)
        if updated is None:
            report["lined_roads_skipped_existing_wheelchair_tag"] += 1
            continue
        report["lined_roads_tagged"] += 1
        changes[way_id] = updated
    for way_id, (tags, ends) in crossings.items():
        if not any(evidence.in_taipei(lon, lat) for _, lon, lat in ends):
            report["crossings_outside_taipei"] += 1
            continue
        if "wheelchair" in tags:
            report["skipped_existing_wheelchair_tag"] += 1
            continue
        judged = [
            evidence.classify_end_with_reason(lon, lat, node_tags.get(ref, {}))
            for ref, lon, lat in ends
        ]
        classes = [value for value, _ in judged]
        report["crossings"] += 1
        for value, reason in judged:
            report[f"ends_{value}"] += 1
            if value != "unknown":
                report[f"ends_{value}_by_{reason}"] += 1
        updated = crossing_tags(tags, classes)
        if updated is None:
            continue
        report["crossings_with_evidence"] += 1
        unramped = classes.count("unramped")
        report[f"crossings_unramped_{unramped}"] += 1
        if updated.get("source:wheelchair") == WHEELCHAIR_TAG_SOURCE:
            report["tagged_wheelchair_no"] += 1
        changes[way_id] = updated
    report["moi_polygons"] = evidence.moi_total
    report["moi_inventory_complete"] = evidence.moi_complete
    report["painted_polygons"] = len(evidence.painted)
    return changes, dict(report)


def write_pbf(osmium, pbf, output_pbf, changes):
    try:
        writer = osmium.SimpleWriter(osmium.io.File(output_pbf, "pbf"))
    except TypeError:
        writer = osmium.SimpleWriter(output_pbf)

    class Writer(osmium.SimpleHandler):
        def node(self, node):
            writer.add_node(node)

        def way(self, way):
            tags = changes.get(way.id)
            writer.add_way(way if tags is None else way.replace(tags=tags))

        def relation(self, relation):
            writer.add_relation(relation)

    try:
        Writer().apply_file(pbf)
    finally:
        writer.close()


def main(argv=None):
    args = list(sys.argv[1:] if argv is None else argv)
    report_path = None
    if "--report" in args:
        index = args.index("--report")
        report_path = args[index + 1]
        del args[index : index + 2]
    if len(args) != 4:
        raise SystemExit(
            f"Usage: {sys.argv[0]} <input.osm.pbf> <ramps.ndjson> <sidewalks.ndjson> <output.osm.pbf> [--report <json>]"
        )
    input_pbf, ramps_path, sidewalks_path, output_pbf = args
    for path in (input_pbf, ramps_path, sidewalks_path):
        if not os.path.isfile(path):
            raise SystemExit(f"Input not found: {path}")
    if os.path.exists(output_pbf):
        raise SystemExit(f"Output PBF already exists: {output_pbf}")
    import osmium

    ramps = [(float(r["lon"]), float(r["lat"])) for r in read_ndjson(ramps_path)]
    sidewalks = list(read_ndjson(sidewalks_path))
    if not ramps:
        raise SystemExit("No ramp points in the export")
    if not sidewalks:
        raise SystemExit("No Taipei sidewalk polygons in the export")
    evidence = Evidence(ramps, sidewalks)
    crossings, lined_roads, node_tags = collect_crossings(osmium, input_pbf)
    changes, report = plan(crossings, node_tags, evidence, lined_roads)
    report["ramp_points"] = len(ramps)
    write_pbf(osmium, input_pbf, output_pbf, changes)
    print("[otp-kerb-ramps] " + json.dumps(report, sort_keys=True))
    if report_path:
        with open(report_path, "w", encoding="utf-8") as handle:
            json.dump(report, handle, indent=2, sort_keys=True)
    return report


if __name__ == "__main__":
    main()
