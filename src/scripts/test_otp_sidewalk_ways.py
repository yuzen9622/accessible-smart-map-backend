import importlib.util
import json
import os
import sys
import tempfile
import unittest


SCRIPT = os.path.join(os.path.dirname(__file__), "otp-sidewalk-ways.py")
SPEC = importlib.util.spec_from_file_location("otp_sidewalk_ways", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)

try:
    import osmium
except ImportError:
    osmium = None

LON0, LAT0 = 120.64, 24.13


def lonlat(x, y):
    """Metres east/north of a fixed Taichung origin to lon/lat."""
    return LON0 + x / MODULE.M_PER_DEG_LON, LAT0 + y / MODULE.M_PER_DEG_LAT


def road(way_id, node_ids, points, **tags):
    return MODULE.make_road(
        way_id, node_ids, [lonlat(*p) for p in points], {"highway": "residential", **tags}
    )


def strip(x0, x1, y0, y1):
    ring = [lonlat(x0, y0), lonlat(x1, y0), lonlat(x1, y1), lonlat(x0, y1), lonlat(x0, y0)]
    return {"type": "Polygon", "coordinates": [ring]}


def junction_links(edits):
    return [
        nodes
        for _, nodes, tags in edits.new_ways
        if tags.get("footway") == "sidewalk" and "ref:moi_sidewalk" not in tags
    ]


class MatchTests(unittest.TestCase):
    def test_strip_beside_road_becomes_left_run_over_its_length(self):
        street = road(1, [1, 2], [(0, 0), (100, 0)])
        [run] = MODULE.match_sidewalks([("s1", strip(20, 80, 4, 8))], [street])
        self.assertEqual(run.way_id, 1)
        self.assertAlmostEqual(run.start, 20, delta=1)
        self.assertAlmostEqual(run.end, 80, delta=1)
        self.assertGreater(run.offset, 4)
        self.assertLess(run.offset, 8)

    def test_polygon_straddling_the_road_is_not_a_sidewalk(self):
        street = road(1, [1, 2], [(0, 0), (100, 0)])
        self.assertEqual(MODULE.match_sidewalks([("p", strip(20, 80, -6, 6))], [street]), [])

    def test_short_cross_strip_is_rejected(self):
        street = road(1, [1, 2], [(0, 0), (100, 0)])
        self.assertEqual(MODULE.match_sidewalks([("c", strip(50, 55, 3, 14))], [street]), [])

    def test_strip_goes_to_the_nearer_of_two_parallel_roads(self):
        near = road(1, [1, 2], [(0, 0), (100, 0)])
        far = road(2, [3, 4], [(0, 20), (100, 20)])
        runs = MODULE.match_sidewalks([("s", strip(20, 80, 3, 7))], [near, far])
        self.assertEqual([run.way_id for run in runs], [1])

    def test_strips_split_by_a_driveway_merge_into_one_run(self):
        street = road(1, [1, 2], [(0, 0), (100, 0)])
        runs = MODULE.match_sidewalks(
            [("a", strip(10, 45, 4, 8)), ("b", strip(55, 90, 4, 8))], [street]
        )
        self.assertEqual(len(runs), 1)
        self.assertEqual(sorted(runs[0].sources), ["a", "b"])


class PlanTests(unittest.TestCase):
    def test_only_the_lined_piece_of_the_road_prefers_the_sidepath(self):
        street = road(1, [1, 2], [(0, 0), (100, 0)])
        run = MODULE.Run(1, 30, 70, 6, ["s"])
        edits = MODULE.plan_edits([street], [run], set(), 100, 100)
        pieces = [edits.road_pieces[1]] + [
            (nodes, tags) for _, nodes, tags in edits.new_ways if tags.get("highway") == "residential"
        ]
        lined = [nodes for nodes, tags in pieces if tags.get("foot") == "use_sidepath"]
        plain = [nodes for nodes, tags in pieces if "foot" not in tags]
        self.assertEqual(len(lined), 1)
        self.assertEqual(len(plain), 2)
        self.assertEqual(lined[0][0], plain[0][-1])

    def test_sidewalk_is_connected_to_the_road_at_both_ends(self):
        street = road(1, [1, 2], [(0, 0), (100, 0)])
        edits = MODULE.plan_edits([street], [MODULE.Run(1, 30, 70, 6, ["s"])], set(), 100, 100)
        [sidewalk] = [nodes for _, nodes, tags in edits.new_ways if tags.get("footway") == "sidewalk"]
        road_nodes = set(edits.road_pieces[1][0]) | {
            n for _, nodes, tags in edits.new_ways if tags.get("highway") == "residential" for n in nodes
        }
        connectors = [nodes for _, nodes, tags in edits.new_ways if tags.get("source") and "footway" not in tags]
        for end in (sidewalk[0], sidewalk[-1]):
            self.assertTrue(any(end in c and (set(c) - {end}) <= road_nodes for c in connectors))

    def test_explicit_foot_tag_is_kept(self):
        street = road(1, [1, 2], [(0, 0), (100, 0)], foot="yes")
        edits = MODULE.plan_edits([street], [MODULE.Run(1, 0, 100, 6, ["s"])], set(), 100, 100)
        self.assertEqual(edits.road_pieces[1][1]["foot"], "yes")

    def test_same_side_sidewalks_link_across_a_junction(self):
        west = road(1, [1, 5], [(-100, 0), (0, 0)])
        east = road(2, [5, 9], [(0, 0), (100, 0)])
        runs = [MODULE.Run(1, 10, 90, 6, ["w"]), MODULE.Run(2, 10, 90, 6, ["e"])]
        edits = MODULE.plan_edits([west, east], runs, {5}, 100, 100)
        self.assertEqual(len(junction_links(edits)), 1)

    def test_sidewalks_on_opposite_sides_do_not_link_through_the_road(self):
        west = road(1, [1, 5], [(-100, 0), (0, 0)])
        east = road(2, [5, 9], [(0, 0), (100, 0)])
        runs = [MODULE.Run(1, 10, 90, 6, ["w"]), MODULE.Run(2, 10, 90, -6, ["e"])]
        edits = MODULE.plan_edits([west, east], runs, {5}, 100, 100)
        self.assertEqual(junction_links(edits), [])

    def test_link_that_crosses_only_the_second_road_is_rejected(self):
        west = road(1, [1, 5], [(-100, 0), (0, 0)])
        north = road(2, [5, 9], [(0, 0), (0, 100)])
        runs = [MODULE.Run(1, 10, 90, 6, ["w"]), MODULE.Run(2, 10, 90, -6, ["n"])]
        edits = MODULE.plan_edits([west, north], runs, {5}, 100, 100)
        self.assertEqual(junction_links(edits), [])

    def test_corner_sidewalks_link_around_the_block(self):
        west = road(1, [1, 5], [(-100, 0), (0, 0)])
        north = road(2, [5, 9], [(0, 0), (0, 100)])
        runs = [MODULE.Run(1, 10, 90, 6, ["w"]), MODULE.Run(2, 10, 90, 6, ["n"])]
        edits = MODULE.plan_edits([west, north], runs, {5}, 100, 100)
        self.assertEqual(len(junction_links(edits)), 1)

    def test_nodes_sharing_a_position_keep_their_order(self):
        street = road(1, [1, 9, 3, 4], [(0, 0), (50, 0), (50, 0), (100, 0)])
        edits = MODULE.plan_edits([street], [MODULE.Run(1, 20, 40, 6, ["s"])], set(), 100, 100)
        pieces = [edits.road_pieces[1][0]] + [
            nodes for _, nodes, tags in edits.new_ways if tags.get("highway") == "residential"
        ]
        original = [n for nodes in pieces for n in nodes if n in (1, 9, 3, 4)]
        self.assertEqual(list(dict.fromkeys(original)), [1, 9, 3, 4])


class EligibilityTests(unittest.TestCase):
    def test_grade_separated_roads_get_no_ground_sidewalk(self):
        for tags in ({"bridge": "yes"}, {"tunnel": "yes"}, {"layer": "1"}):
            self.assertFalse(MODULE.eligible_road({"highway": "primary", **tags}, [1, 2]))
        self.assertTrue(MODULE.eligible_road({"highway": "primary", "bridge": "no"}, [1, 2]))


@unittest.skipIf(osmium is None, "pyosmium is not installed")
class PbfTests(unittest.TestCase):
    def test_compiled_pbf_contains_connected_sidewalk_and_lined_road(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = os.path.join(tmp, "in.osm.pbf")
            output = os.path.join(tmp, "out.osm.pbf")
            sidewalks = os.path.join(tmp, "sidewalks.ndjson")
            writer = osmium.SimpleWriter(source)
            for node_id, (x, y) in {1: (0, 0), 2: (100, 0), 3: (100, 50)}.items():
                writer.add_node(osmium.osm.mutable.Node(id=node_id, location=lonlat(x, y)))
            writer.add_way(osmium.osm.mutable.Way(id=10, nodes=[1, 2], tags={"highway": "residential", "name": "測試路"}))
            writer.add_way(osmium.osm.mutable.Way(id=11, nodes=[2, 3], tags={"highway": "service"}))
            writer.add_node(osmium.osm.mutable.Node(id=4, location=lonlat(50, 10)))
            writer.add_node(osmium.osm.mutable.Node(id=5, location=lonlat(50, 10)))
            writer.add_way(osmium.osm.mutable.Way(id=12, nodes=[4, 5], tags={"highway": "residential"}))
            writer.close()
            with open(sidewalks, "w", encoding="utf-8") as handle:
                handle.write(json.dumps({"id": "s1", "geometry": strip(20, 80, 4, 8)}) + "\n")

            MODULE.main([source, sidewalks, output])

            nodes, ways = set(), {}

            class Reader(osmium.SimpleHandler):
                def node(self, node):
                    nodes.add(node.id)

                def way(self, way):
                    ways[way.id] = ([n.ref for n in way.nodes], dict(way.tags))

            Reader().apply_file(output)
            for way_nodes, _ in ways.values():
                self.assertTrue(set(way_nodes) <= nodes)
            sidewalk = [t for _, t in ways.values() if t.get("footway") == "sidewalk"]
            self.assertEqual(len(sidewalk), 1)
            self.assertEqual(sidewalk[0]["name"], "測試路")
            lined = [t for _, t in ways.values() if t.get("foot") == "use_sidepath"]
            self.assertEqual(len(lined), 1)
            self.assertEqual(ways[11], ([2, 3], {"highway": "service"}))


if __name__ == "__main__":
    unittest.main()
