import importlib.util
import os
import tempfile
import unittest

SCRIPT = os.path.join(os.path.dirname(__file__), "otp-kerb-ramps.py")
SPEC = importlib.util.spec_from_file_location("otp_kerb_ramps", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)

try:
    import osmium
except ImportError:  # pragma: no cover - optional native dependency
    osmium = None

LON0, LAT0 = 121.5, 25.05


def lonlat(x, y):
    """Metres east/north of a Taipei origin → lon/lat."""
    return LON0 + x / MODULE.M_PER_DEG_LON, LAT0 + y / MODULE.M_PER_DEG_LAT


def box(x0, y0, x1, y1):
    ring = [lonlat(x0, y0), lonlat(x1, y0), lonlat(x1, y1), lonlat(x0, y1), lonlat(x0, y0)]
    return {"type": "Polygon", "coordinates": [[list(p) for p in ring]]}


def moi(x0, y0, x1, y1, ramp_count):
    return {"id": "m", "kind": "moi", "ramp_count": ramp_count, "geometry": box(x0, y0, x1, y1)}


def painted(x0, y0, x1, y1):
    return {"id": "tp-painted:1", "kind": "painted", "geometry": box(x0, y0, x1, y1)}


class ClassifyEndTests(unittest.TestCase):
    def test_ramp_point_within_tolerance_is_ramped(self):
        evidence = MODULE.Evidence([lonlat(5, 0)], [moi(-50, 0, 50, 3, 1)])
        self.assertEqual(evidence.classify_end(*lonlat(0, 0), {}), "ramped")

    def test_ramp_at_the_crosswalk_edge_15m_away_is_ramped(self):
        evidence = MODULE.Evidence([lonlat(15, 0)], [moi(-50, 0, 50, 3, 1)])
        self.assertEqual(evidence.classify_end(*lonlat(0, 0), {}), "ramped")

    def test_osm_lowered_kerb_is_ramped(self):
        evidence = MODULE.Evidence([lonlat(500, 500)], [moi(-50, 0, 50, 3, 0)])
        self.assertEqual(evidence.classify_end(*lonlat(0, 0), {"kerb": "lowered"}), "ramped")

    def test_end_on_painted_strip_is_ramped(self):
        evidence = MODULE.Evidence([lonlat(500, 500)], [painted(-20, -1, 20, 1), moi(-50, 0, 50, 3, 0)])
        self.assertEqual(evidence.classify_end(*lonlat(0, 0), {}), "ramped")

    def test_complete_inventory_without_ramp_here_is_unramped(self):
        # The polygon has 1 recorded ramp and it is surveyed, 40 m away.
        evidence = MODULE.Evidence([lonlat(40, 1)], [moi(-50, 0, 50, 3, 1)])
        self.assertEqual(evidence.classify_end(*lonlat(-30, -1), {}), "unramped")

    def test_incomplete_inventory_stays_unknown(self):
        # MOI says 2 ramps but only 1 government point exists: coverage unproven.
        evidence = MODULE.Evidence([lonlat(40, 1)], [moi(-50, 0, 50, 3, 2)])
        self.assertEqual(evidence.classify_end(*lonlat(-30, -1), {}), "unknown")

    def test_unknown_ramp_count_stays_unknown(self):
        evidence = MODULE.Evidence([lonlat(40, 1)], [moi(-50, 0, 50, 3, None)])
        self.assertEqual(evidence.classify_end(*lonlat(-30, -1), {}), "unknown")

    def test_far_from_any_surveyed_sidewalk_is_unknown(self):
        evidence = MODULE.Evidence([lonlat(40, 1)], [moi(-50, 0, 50, 3, 1)])
        self.assertEqual(evidence.classify_end(*lonlat(0, -20), {}), "unknown")

    def test_osm_raised_kerb_is_unramped_even_without_inventory(self):
        evidence = MODULE.Evidence([lonlat(500, 500)], [moi(-50, 0, 50, 3, None)])
        self.assertEqual(evidence.classify_end(*lonlat(0, 0), {"kerb": "raised"}), "unramped")


class LinedRoadTests(unittest.TestCase):
    def test_lined_road_gets_soft_wheelchair_tag(self):
        tags = MODULE.lined_road_tags({"highway": "residential", "foot": "use_sidepath"})
        self.assertEqual(tags["wheelchair"], "no")
        self.assertEqual(tags["source:wheelchair"], "taipei_sidewalk_alongside")

    def test_unlined_or_already_tagged_roads_are_left_alone(self):
        self.assertIsNone(MODULE.lined_road_tags({"highway": "residential"}))
        self.assertIsNone(
            MODULE.lined_road_tags({"highway": "residential", "foot": "use_sidepath", "wheelchair": "yes"})
        )

    def test_only_taipei_lined_roads_are_tagged(self):
        evidence = MODULE.Evidence([lonlat(500, 500)], [moi(-50, 0, 50, 3, 0)])
        lined = {
            1: ({"highway": "residential", "foot": "use_sidepath"}, lonlat(0, -8)),
            2: ({"highway": "residential", "foot": "use_sidepath"}, lonlat(0, -500)),
        }
        changes, report = MODULE.plan({}, {}, evidence, lined)
        self.assertEqual(sorted(changes), [1])
        self.assertEqual(report["lined_roads_tagged"], 1)
        self.assertEqual(report["lined_road_pieces"], 2)


class CrossingTagTests(unittest.TestCase):
    def test_both_ramped_gets_provenance_only(self):
        tags = MODULE.crossing_tags({"footway": "crossing"}, ["ramped", "ramped"])
        self.assertEqual(tags["tp:kerb_ramp_ends"], "2/0/0")
        self.assertNotIn("wheelchair", tags)

    def test_one_unramped_end_tags_the_whole_way(self):
        tags = MODULE.crossing_tags({"footway": "crossing"}, ["ramped", "unramped"])
        self.assertEqual(tags["wheelchair"], "no")
        self.assertEqual(tags["source:wheelchair"], "taipei_kerb_ramp")
        self.assertEqual(tags["tp:kerb_ramp_ends"], "1/1/0")

    def test_existing_osm_wheelchair_tag_leaves_the_way_untouched(self):
        self.assertIsNone(
            MODULE.crossing_tags({"footway": "crossing", "wheelchair": "yes"}, ["unramped", "unramped"])
        )

    def test_crossings_outside_taipei_are_never_tagged(self):
        evidence = MODULE.Evidence([lonlat(5, 0)], [moi(-50, 0, 50, 3, 1)])
        far = lonlat(20000, 20000)
        crossings = {
            1: ({"footway": "crossing"}, [(10, *far), (11, far[0], far[1] + 0.0001)]),
        }
        node_tags = {10: {"barrier": "kerb", "kerb": "raised"}}
        changes, report = MODULE.plan(crossings, node_tags, evidence)
        self.assertEqual(changes, {})
        self.assertEqual(report["crossings_outside_taipei"], 1)

    def test_no_evidence_leaves_the_way_untouched(self):
        self.assertIsNone(MODULE.crossing_tags({"footway": "crossing"}, ["unknown", "unknown"]))


@unittest.skipIf(osmium is None, "pyosmium not installed")
class PbfRoundTripTests(unittest.TestCase):
    def test_only_crossing_ways_change_and_nothing_is_split(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = os.path.join(tmp, "in.osm.pbf")
            writer = osmium.SimpleWriter(source)
            points = {1: (-30, -1), 2: (-30, -15), 3: (0, 0), 4: (100, 0), 5: (0, -6), 6: (40, -6)}
            for node_id, (x, y) in points.items():
                writer.add_node(osmium.osm.mutable.Node(id=node_id, location=lonlat(x, y), tags={}))
            writer.add_way(osmium.osm.mutable.Way(id=10, nodes=[1, 2], tags={"highway": "footway", "footway": "crossing"}))
            writer.add_way(osmium.osm.mutable.Way(id=11, nodes=[3, 4], tags={"highway": "residential"}))
            writer.add_way(osmium.osm.mutable.Way(id=12, nodes=[5, 6], tags={"highway": "residential", "foot": "use_sidepath"}))
            writer.close()
            ramps = os.path.join(tmp, "ramps.ndjson")
            with open(ramps, "w", encoding="utf-8") as handle:
                handle.write('{"id": 1, "lon": %r, "lat": %r}\n' % lonlat(40, 1))
            sidewalks = os.path.join(tmp, "sidewalks.ndjson")
            with open(sidewalks, "w", encoding="utf-8") as handle:
                import json

                handle.write(json.dumps(moi(-50, 0, 50, 3, 1)) + "\n")
            output = os.path.join(tmp, "out.osm.pbf")
            report = MODULE.main([source, ramps, sidewalks, output])
            self.assertEqual(report["tagged_wheelchair_no"], 1)

            seen = {}

            class Reader(osmium.SimpleHandler):
                def way(self, way):
                    seen[way.id] = ([n.ref for n in way.nodes], {t.k: t.v for t in way.tags})

            Reader().apply_file(output)
            self.assertEqual(sorted(seen), [10, 11, 12])
            self.assertEqual(seen[12][1]["source:wheelchair"], "taipei_sidewalk_alongside")
            self.assertEqual(seen[10][0], [1, 2])
            self.assertEqual(seen[10][1]["wheelchair"], "no")
            self.assertEqual(seen[10][1]["tp:kerb_ramp_ends"], "0/1/1")
            self.assertEqual(seen[11][1], {"highway": "residential"})


if __name__ == "__main__":
    unittest.main()
