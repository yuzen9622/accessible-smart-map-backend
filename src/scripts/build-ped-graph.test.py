#!/usr/bin/env python3
"""Pure-function tests for the pedestrian graph build pipeline."""

import importlib.util
import json
import subprocess
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPT = Path(__file__).with_name("build-ped-graph.py")
SPEC = importlib.util.spec_from_file_location("build_ped_graph", SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Unable to load {SCRIPT}")
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


def way_node(osm_id, lon, lat):
    """Create a compact WayNode fixture."""
    return MODULE.WayNode(osm_id, lon, lat)


def segment(tags=None):
    """Create one three-point segment fixture with an intentionally non-straight geometry."""
    return MODULE.Segment(
        77,
        {"highway": "footway", **(tags or {})},
        (
            way_node(10, 121.5500, 25.0500),
            way_node(11, 121.5505, 25.0504),
            way_node(12, 121.5510, 25.0500),
        ),
    )


class EligibleWayTests(unittest.TestCase):
    def test_includes_all_documented_walkable_highways(self):
        for highway in MODULE.INCLUDED_HIGHWAYS:
            with self.subTest(highway=highway):
                self.assertTrue(MODULE.should_include_way({"highway": highway}))

    def test_rejects_motorways_and_denied_access(self):
        for tags in (
            {"highway": "motorway", "foot": "yes"},
            {"highway": "primary", "foot": "no"},
            {"highway": "footway", "access": "private"},
            {"highway": "trunk", "bridge": "yes"},
        ):
            with self.subTest(tags=tags):
                self.assertFalse(MODULE.should_include_way(tags))

    def test_includes_only_explicitly_permitted_cycleways(self):
        for foot in ("yes", "designated", "permissive"):
            with self.subTest(foot=foot):
                self.assertTrue(
                    MODULE.should_include_way({"highway": "cycleway", "foot": foot})
                )
        for tags in (
            {"highway": "cycleway"},
            {"highway": "cycleway", "foot": "no"},
            {"highway": "cycleway", "foot": "private"},
            {"highway": "cycleway", "foot": "yes", "access": "no"},
            {"highway": "cycleway", "foot": "designated", "access": "private"},
            {"highway": "motorway", "foot": "yes"},
            {"highway": "motorway_link", "foot": "designated"},
        ):
            with self.subTest(tags=tags):
                self.assertFalse(MODULE.should_include_way(tags))

    def test_eligibility_uses_tags_not_way_names(self):
        self.assertTrue(
            MODULE.should_include_way({"highway": "residential", "name": "高速公路"})
        )
        self.assertFalse(
            MODULE.should_include_way({"highway": "motorway", "name": "人行道"})
        )


class AttributeExtractionTests(unittest.TestCase):
    def test_edge_type_and_dictionary_mappings(self):
        self.assertEqual(
            MODULE.edge_type_for_tags({"highway": "footway", "footway": "sidewalk"}),
            1,
        )
        self.assertEqual(
            MODULE.edge_type_for_tags({"highway": "footway", "footway": "crossing"}),
            3,
        )
        self.assertEqual(MODULE.edge_type_for_tags({"highway": "footway"}), 2)
        self.assertEqual(
            MODULE.edge_type_for_tags({"highway": "cycleway", "foot": "designated"}),
            MODULE.EDGE_TYPE_CODES["path"],
        )
        self.assertEqual(MODULE.edge_type_for_tags({"highway": "elevator"}), 19)
        self.assertEqual(MODULE.enum_code("bricks", MODULE.SURFACE_CODES), 9)
        self.assertEqual(MODULE.enum_code("unlisted", MODULE.SURFACE_CODES), 255)
        self.assertIsNone(MODULE.enum_code(None, MODULE.SURFACE_CODES))
        self.assertEqual(MODULE.enum_code("limited", MODULE.WHEELCHAIR_CODES), 3)

    def test_osm_attribute_extraction_does_not_infer_wheelchair_no(self):
        attributes = MODULE.make_edge_attributes(
            {
                "highway": "footway",
                "surface": "tiles",
                "width": "120 cm",
                "ramp:wheelchair": "designated",
            },
            "2026-07-20",
            None,
        )
        self.assertEqual(attributes["surface"], 10)
        self.assertAlmostEqual(attributes["width_m"], 1.2)
        self.assertIsNone(attributes["wheelchair"])
        self.assertTrue(attributes["has_ramp"])
        self.assertEqual(attributes["attr_meta"]["width_m"]["source"], "osm")

    def test_node_type_precedence_and_kerb_mapping(self):
        self.assertEqual(
            MODULE.node_type_for({"highway": "elevator", "entrance": "yes"}, 5, True),
            5,
        )
        self.assertEqual(MODULE.node_type_for({"entrance": "yes"}, 3, True), 4)
        self.assertEqual(MODULE.node_type_for({"crossing": "uncontrolled"}, 3, True), 3)
        self.assertEqual(MODULE.node_type_for({}, 1, True), 6)
        self.assertEqual(MODULE.node_type_for({}, 2, False), 2)
        self.assertEqual(MODULE.enum_code("flush", MODULE.KERB_CODES), 1)
        self.assertEqual(MODULE.enum_code("unlisted", MODULE.KERB_CODES), 255)


class GeometryAndDirectionTests(unittest.TestCase):
    def test_haversine_and_polyline_length_accumulate_every_vertex(self):
        start = (121.5500, 25.0500)
        middle = (121.5505, 25.0504)
        end = (121.5510, 25.0500)
        direct = MODULE.haversine_m(start, end)
        curved = MODULE.polyline_length_m((start, middle, end))
        self.assertGreater(curved, direct)
        self.assertAlmostEqual(
            MODULE.haversine_m((0.0, 0.0), (0.0, 1.0)), 111_194.9, delta=2.0
        )

    def test_splits_at_shared_nodes_and_preserves_internal_geometry(self):
        way = MODULE.WalkWay(
            100,
            {"highway": "footway"},
            (
                way_node(1, 121.5500, 25.0500),
                way_node(2, 121.5503, 25.0500),
                way_node(3, 121.5506, 25.0503),
                way_node(4, 121.5509, 25.0500),
            ),
        )
        pieces = MODULE.split_way_into_segments(way, {1: 1, 2: 2, 3: 1, 4: 1})
        self.assertEqual(
            [(piece.from_osm_node, piece.to_osm_node) for piece in pieces],
            [(1, 2), (2, 4)],
        )
        self.assertEqual(len(pieces[1].coordinates), 3)

    def test_general_walking_is_bidirectional_and_reverses_geometry(self):
        edges = MODULE.build_directed_edges([segment()])
        self.assertEqual(len(edges), 2)
        self.assertTrue(all(edge.is_bidirectional for edge in edges))
        self.assertEqual((edges[0].from_osm_node, edges[0].to_osm_node), (10, 12))
        self.assertEqual((edges[1].from_osm_node, edges[1].to_osm_node), (12, 10))
        self.assertEqual(edges[1].coordinates, tuple(reversed(edges[0].coordinates)))

    def test_explicit_pedestrian_oneway_is_single_direction_but_steps_stay_bidirectional(
        self,
    ):
        oneway_edges = MODULE.build_directed_edges([segment({"oneway:foot": "yes"})])
        self.assertEqual(len(oneway_edges), 1)
        self.assertFalse(oneway_edges[0].is_bidirectional)
        vehicle_oneway_edges = MODULE.build_directed_edges([segment({"oneway": "yes"})])
        self.assertEqual(len(vehicle_oneway_edges), 2)
        steps_edges = MODULE.build_directed_edges(
            [segment({"highway": "steps", "oneway:foot": "yes"})]
        )
        self.assertEqual(len(steps_edges), 2)
        self.assertTrue(all(edge.is_bidirectional for edge in steps_edges))


class DemAndSidewalkTests(unittest.TestCase):
    def test_dem_injection_cli_preserves_tags_and_only_enriches_supported_ground_spans(self):
        import numpy as np
        import rasterio
        import osmium
        from rasterio.transform import from_origin

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with rasterio.open(root / "terrain.tif", "w", driver="GTiff", height=10, width=20,
                               count=1, dtype="float32", crs="EPSG:4326",
                               transform=from_origin(121.55, 25.051, 0.0002, 0.00018)) as dataset:
                dataset.write(np.tile(np.arange(20, dtype="float32"), (10, 1)), 1)
            source = root / "test.osm"
            ways = [(1, 2, '<tag k="incline" v="8%"/>'),
                    (2, 3, '<tag k="bridge" v="yes"/>'), (3, 2, ''), (4, 3, '')]
            source.write_text('<osm version="0.6">' +
                '<node id="1" lat="25.05" lon="121.55005"/>' +
                '<node id="2" lat="25.05" lon="121.55015"/>' +
                '<node id="3" lat="25.05" lon="121.55105"/>' + ''.join(
                    f'<way id="{way_id}"><nd ref="1"/><nd ref="{end}"/>'
                    f'<tag k="highway" v="footway"/>{tags}</way>' for way_id, end, tags in ways) + '</osm>')
            output = root / "enriched.osm.pbf"
            run = subprocess.run([sys.executable, str(SCRIPT.with_name("inject-osm-dem-slopes.py")),
                                  str(source), str(output), str(root)], capture_output=True, text=True)
            self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
            class Capture(osmium.SimpleHandler):
                def __init__(self):
                    super().__init__()
                    self.tags = {}
                def way(self, way):
                    self.tags[way.id] = dict(way.tags)
            capture = Capture()
            capture.apply_file(str(output))
            self.assertEqual(capture.tags[1]["incline"], "8%")
            self.assertNotIn("incline", capture.tags[2])
            self.assertNotIn("incline", capture.tags[3])
            self.assertGreater(float(capture.tags[4]["incline"].strip('%')), 0)
            self.assertEqual(capture.tags[4]["source:incline"], "dem")

    def test_projected_dem_samples_in_its_crs_and_rejects_short_spans(self):
        import numpy as np
        import rasterio
        from rasterio.transform import from_origin
        from rasterio.warp import transform

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "terrain.tif"
            pixels = np.arange(16, dtype="float32").reshape((4, 4))
            pixels[0, 1] = -9999
            pixels[1, 0] = np.nan
            with rasterio.open(path, "w", driver="GTiff", height=4, width=4,
                               count=1, dtype="float32", crs="EPSG:3826",
                               transform=from_origin(300000, 2770000, 20, 20), nodata=-9999) as dataset:
                dataset.write(pixels, 1)
            reader = MODULE.DEM_HELPER.DemReader(str(path))
            try:
                xs, ys = transform("EPSG:3826", "EPSG:4326", [300010, 300030, 300010, 300070],
                                   [2769990, 2769990, 2769970, 2769990])
                points = tuple(zip(xs, ys))
                self.assertEqual(reader.get_elevation(*points[0]), 0)
                self.assertIsNone(reader.get_elevation(*points[1]))
                self.assertIsNone(reader.get_elevation(*points[2]))
                self.assertAlmostEqual(reader.minimum_slope_span_m(*points[0]), 40, delta=0.3)
                self.assertIsNone(MODULE.slope_for_coordinates(points[:2], 20, reader))
                self.assertAlmostEqual(MODULE.slope_for_coordinates((points[0], points[3]), 60, reader), 0.05)
            finally:
                reader.close()

    def test_dem_does_not_assign_ground_slope_to_bridges_or_tunnels(self):
        class Reader:
            def get_elevation(self, lon, lat):
                return 100 if lon < 121.5505 else 110
        for tags in ({"bridge": "yes"}, {"tunnel": "yes"}, {"layer": "1"}):
            edges = MODULE.build_directed_edges([segment(tags)], dem_reader=Reader(), dem_updated_at="2026-10-04")
            self.assertTrue(all(e.slope_longitudinal is None for e in edges))

    def test_numeric_osm_incline_survives_without_dem_and_reverses_direction(self):
        edges = MODULE.build_directed_edges([segment({"bridge": "yes", "incline": "8 %"})])
        self.assertEqual([e.slope_longitudinal for e in edges], [0.08, -0.08])
        self.assertTrue(all(e.attr_meta["slope_longitudinal"]["source"] == "osm" for e in edges))
        self.assertAlmostEqual(MODULE.osm_incline_ratio("45°"), 1)
        for raw in (None, "up", "down", "NaN%", "90°", "5%;20%"):
            self.assertIsNone(MODULE.osm_incline_ratio(raw))

    def test_injected_dem_maximum_is_not_treated_as_surveyed_directed_incline(self):
        edges = MODULE.build_directed_edges([
            segment({"incline": "12%", "source:incline": "dem"})
        ])
        self.assertTrue(all(e.slope_longitudinal is None for e in edges))

    def test_sidewalk_rejects_twd97_and_does_not_promote_contradictory_net_width(self):
        feature = {"type": "Feature", "properties": {"SW_WTH": 1, "SWW_WTH": 2, "SW_RAMP": "N"},
                   "geometry": {"type": "Polygon", "coordinates": [[[121.55, 25.05], [121.551, 25.05],
                                   [121.551, 25.051], [121.55, 25.05]]]}}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "sidewalk.geojson"
            path.write_text(json.dumps({"features": [feature]}))
            record = MODULE.build_sidewalk_index(path).records[0]
            self.assertEqual(record.width_m, 1)
            self.assertIsNone(record.effective_width_m)
            self.assertIsNone(record.ramp_count)
            feature["geometry"]["coordinates"] = [[[300000, 2770000], [300020, 2770000],
                                                      [300020, 2770020], [300000, 2770000]]]
            path.write_text(json.dumps({"features": [feature]}))
            with self.assertRaisesRegex(SystemExit, "WGS84"):
                MODULE.build_sidewalk_index(path)

    def test_dem_slope_is_directed_and_uses_endpoint_elevations(self):
        class FakeDemReader:
            def get_elevation(self, lon, lat):
                return 100.0 if lon < 121.5505 else 110.0

        forward = MODULE.slope_for_coordinates(
            ((121.5500, 25.0500), (121.5510, 25.0500)), 100.0, FakeDemReader()
        )
        reverse = MODULE.slope_for_coordinates(
            ((121.5510, 25.0500), (121.5500, 25.0500)), 100.0, FakeDemReader()
        )
        self.assertAlmostEqual(forward, 0.1)
        self.assertAlmostEqual(reverse, -0.1)

    def test_sidewalk_polygon_overlay_overrides_osm_width_and_keeps_provenance(self):
        feature = {
            "type": "Feature",
            "properties": {
                "SW_WTH": 1.8,
                "SWW_WTH": 1.5,
                "SW_DIRECT": "2",
                "SW_RAMP": 3,
            },
            "geometry": {
                "type": "MultiPolygon",
                "coordinates": [
                    [
                        [
                            [121.5499, 25.0499],
                            [121.5511, 25.0499],
                            [121.5511, 25.0505],
                            [121.5499, 25.0505],
                            [121.5499, 25.0499],
                        ]
                    ]
                ],
            },
        }
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "SIDEWALK_台北市_202606_WGS84.geojson"
            path.write_text(
                json.dumps({"type": "FeatureCollection", "features": [feature]}),
                encoding="utf-8",
            )
            sidewalk_index = MODULE.build_sidewalk_index(path)
            match = MODULE.match_sidewalk_to_coordinates(
                segment().coordinates, sidewalk_index
            )
        self.assertIsNotNone(match)
        self.assertEqual(match.updated_at, "202606")
        attributes = MODULE.make_edge_attributes(
            {"highway": "footway", "width": "0.8"}, "2026-07-20", match
        )
        self.assertEqual(attributes["width_m"], 1.8)
        self.assertEqual(attributes["effective_width_m"], 1.5)
        self.assertEqual(attributes["attr_meta"]["width_m"]["source"], "gov_sidewalk")
        self.assertEqual(attributes["attr_meta"]["sidewalk_direction"]["value"], "2")

    def test_nearby_or_partially_overlapping_sidewalk_does_not_claim_usable_width(self):
        for ratio in (0.0, 0.1, 0.79):
            match = MODULE.SidewalkMatch("nearby", 2.0, 1.8, "2", 3,
                                         "202606", ratio * 100, 5.0, ratio)
            attrs = MODULE.make_edge_attributes({"highway": "footway", "width": "0.8"},
                                                 "2026-10-04", match)
            self.assertEqual(attrs["width_m"], 0.8)
            self.assertIsNone(attrs["effective_width_m"])
            self.assertNotIn("sidewalk_ramp_count", attrs["attr_meta"])
            self.assertFalse(attrs["attr_meta"]["gov_sidewalk_source_id"]["attributes_applied"])

    def test_sidewalk_index_repairs_self_intersecting_government_polygons(self):
        feature = {
            "type": "Feature",
            "properties": {"SW_WTH": 1.2, "SWW_WTH": 1.0},
            "geometry": {
                "type": "MultiPolygon",
                "coordinates": [
                    [
                        [
                            [121.5500, 25.0499],
                            [121.5510, 25.0501],
                            [121.5510, 25.0499],
                            [121.5500, 25.0501],
                            [121.5500, 25.0499],
                        ]
                    ]
                ],
            },
        }
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "SIDEWALK_台北市_202606_WGS84.geojson"
            path.write_text(
                json.dumps({"type": "FeatureCollection", "features": [feature]}),
                encoding="utf-8",
            )
            sidewalk_index = MODULE.build_sidewalk_index(path)
            match = MODULE.match_sidewalk_to_coordinates(
                segment().coordinates, sidewalk_index
            )
        self.assertEqual(len(sidewalk_index.records), 1)
        self.assertIsNotNone(match)


class GraphLifecycleTests(unittest.TestCase):
    def test_write_creates_a_candidate_that_is_not_indoor_complete(self):
        class FakeCursor:
            def __init__(self):
                self.calls = []
                self.next_row = None

            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc_value, traceback):
                return False

            def execute(self, query, params=None):
                self.calls.append((query, params))
                if "to_regclass" in query:
                    self.next_row = ("ped_graph_version", "ped_node", "ped_edge")
                elif "INSERT INTO ped_graph_version" in query:
                    self.next_row = (2,)

            def fetchone(self):
                return self.next_row

        class FakeConnection:
            def __init__(self, cursor):
                self.cursor_value = cursor

            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc_value, traceback):
                return False

            def cursor(self):
                return self.cursor_value

            def close(self):
                return None

        cursor = FakeCursor()
        connection = FakeConnection(cursor)
        psycopg2 = types.SimpleNamespace(connect=lambda _db_url: connection)
        extras = types.SimpleNamespace(execute_values=lambda *_args, **_kwargs: None)
        graph = MODULE.GraphBuild({}, [], 0, 0, 0)

        with patch.dict(
            sys.modules,
            {"psycopg2": psycopg2, "psycopg2.extras": extras},
        ):
            version_id = MODULE.write_graph_to_postgis(
                graph,
                "source-hash",
                (121.43, 24.95, 121.68, 25.22),
                {},
                "postgresql://example.test/ped_graph",
            )

        version_insert = next(
            params
            for query, params in cursor.calls
            if "INSERT INTO ped_graph_version" in query
        )
        self.assertEqual(version_id, 2)
        self.assertEqual(version_insert[-2], "CANDIDATE")
        self.assertFalse(version_insert[-1])


class GraphUtilityTests(unittest.TestCase):
    def test_bbox_and_reachability_helpers(self):
        bbox = (121.43, 24.95, 121.68, 25.22)
        self.assertTrue(
            MODULE.segment_intersects_bbox((121.42, 25.0), (121.44, 25.0), bbox)
        )
        self.assertFalse(
            MODULE.segment_intersects_bbox((121.40, 24.90), (121.42, 24.92), bbox)
        )
        self.assertTrue(MODULE.is_reachable({1: [2], 2: [3]}, 1, 3))
        self.assertFalse(MODULE.is_reachable({1: [2], 2: []}, 2, 1))

    def test_version_scoped_identifiers_do_not_collide_between_graph_versions(self):
        self.assertNotEqual(
            MODULE.scoped_identifier(1, 123, MODULE.NODE_ID_SCALE, "node"),
            MODULE.scoped_identifier(2, 123, MODULE.NODE_ID_SCALE, "node"),
        )


if __name__ == "__main__":
    unittest.main()
