#!/usr/bin/env python3
"""Pure-function tests for the pedestrian graph build pipeline."""

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

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
                            [121.5511, 25.0501],
                            [121.5499, 25.0501],
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
