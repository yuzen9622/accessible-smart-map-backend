#!/usr/bin/env python3
"""Pure-function tests for the GTFS indoor pedestrian graph injection."""

import importlib.util
import sys
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("inject-ped-indoor-graph.py")
SPEC = importlib.util.spec_from_file_location("inject_ped_indoor_graph", SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Unable to load {SCRIPT}")
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class DictionaryTests(unittest.TestCase):
    def test_pathway_modes_use_the_shared_edge_dictionary(self):
        expected = {
            1: 20,
            2: 21,
            3: 22,
            4: 23,
            5: 24,
            6: 25,
            7: 26,
        }
        for pathway_mode, edge_type in expected.items():
            with self.subTest(pathway_mode=pathway_mode):
                self.assertEqual(
                    MODULE.pathway_mode_to_edge_type(pathway_mode), edge_type
                )
        self.assertEqual(MODULE.pathway_mode_to_edge_type(None), 255)
        self.assertEqual(MODULE.pathway_mode_to_edge_type(99), 255)

    def test_location_types_use_the_shared_node_dictionary(self):
        self.assertEqual(MODULE.location_type_to_node_type(3), 7)
        self.assertEqual(MODULE.location_type_to_node_type(1), 8)
        self.assertEqual(MODULE.location_type_to_node_type(0), 9)
        self.assertEqual(MODULE.location_type_to_node_type(4), 10)
        self.assertEqual(MODULE.location_type_to_node_type(2), 11)


class GeometryTests(unittest.TestCase):
    def test_centroid_and_radius_use_all_group_entrances(self):
        points = ((121.5000, 25.0500), (121.5010, 25.0500), (121.5005, 25.0510))
        centroid, radius_m = MODULE.centroid_and_radius(points)
        self.assertAlmostEqual(centroid[0], 121.5005)
        self.assertAlmostEqual(centroid[1], 25.05033333333333)
        self.assertAlmostEqual(
            radius_m,
            max(MODULE.haversine_m(point, centroid) for point in points),
        )
        self.assertGreater(radius_m, 50.0)

    def test_detects_zero_coordinate_placeholders(self):
        self.assertTrue(MODULE.is_placeholder_coordinate((0.0, 0.0)))
        self.assertTrue(MODULE.is_placeholder_coordinate((0.0009, -0.0009)))
        self.assertFalse(MODULE.is_placeholder_coordinate((121.5, 25.05)))

    def test_bbox_is_inclusive_at_each_boundary(self):
        bbox = MODULE.TAIPEI_BBOX
        self.assertTrue(MODULE.point_in_bbox((bbox[0], bbox[1]), bbox))
        self.assertTrue(MODULE.point_in_bbox((bbox[2], bbox[3]), bbox))
        self.assertFalse(MODULE.point_in_bbox((bbox[0] - 0.0001, bbox[1]), bbox))
        self.assertFalse(MODULE.point_in_bbox((bbox[2], bbox[3] + 0.0001), bbox))


class SelectionTests(unittest.TestCase):
    def test_excludes_cross_group_pathways_from_station_subgraphs(self):
        pathways = (
            MODULE.PathwayRecord("same", "a", "b", 1, 1, 10.0, None),
            MODULE.PathwayRecord("cross", "b", "c", 1, 1, 10.0, None),
            MODULE.PathwayRecord("boundary", "c", "outside", 1, 1, 10.0, None),
        )
        included, any_endpoint_count, boundary_count, cross_group_count = (
            MODULE.select_pathways(pathways, {"a": "one", "b": "one", "c": "two"})
        )
        self.assertEqual([pathway.pathway_id for pathway in included], ["same"])
        self.assertEqual(any_endpoint_count, 3)
        self.assertEqual(boundary_count, 1)
        self.assertEqual(cross_group_count, 1)

    def test_generated_ids_have_the_same_numeric_and_text_sort_order(self):
        identifiers = [
            MODULE.generated_identifier(1, ordinal, "node") for ordinal in range(1, 5)
        ]
        self.assertEqual(sorted(identifiers), sorted(identifiers, key=str))
        self.assertTrue(all(identifier > 0 for identifier in identifiers))


class GraphStatisticsTests(unittest.TestCase):
    @staticmethod
    def edge(edge_type, is_bidirectional):
        return MODULE.EdgeDraft(
            source_ref="ref",
            from_ref="a",
            to_ref="b",
            geometry=None,
            length_m=None,
            edge_type=edge_type,
            stair_count=None,
            traversal_time_s=None,
            is_bidirectional=is_bidirectional,
            attr_meta={},
        )

    def test_paired_edges_collapse_into_one_undirected_segment(self):
        edges = [
            self.edge(21, True),
            self.edge(21, True),
            self.edge(23, False),
        ]
        self.assertEqual(MODULE.count_undirected_segments(edges), 2)

    def test_unpaired_bidirectional_edges_are_rejected(self):
        with self.assertRaises(SystemExit):
            MODULE.count_undirected_segments([self.edge(21, True)])

    def test_generated_edge_types_are_added_to_the_outdoor_distribution(self):
        merged = MODULE.merge_edge_type_distribution(
            {"10": 5, "2": 3},
            [self.edge(21, True), self.edge(21, True), self.edge(2, True)],
        )
        self.assertEqual(merged, {"2": 4, "10": 5, "21": 2})
        self.assertEqual(list(merged), ["2", "10", "21"])

    def test_outdoor_statistics_prefer_the_snapshot_over_the_merged_totals(self):
        notes = {
            "undirected_segment_count": 226_842,
            "edge_type_distribution": {"10": 5, "21": 2},
            "outdoor_undirected_segment_count": 220_728,
            "outdoor_edge_type_distribution": {"10": 5},
        }
        self.assertEqual(
            MODULE.outdoor_graph_statistics(notes), (220_728, {"10": 5})
        )

    def test_outdoor_statistics_fall_back_to_a_freshly_built_graph(self):
        notes = {
            "undirected_segment_count": 220_728,
            "edge_type_distribution": {10: 5},
        }
        self.assertEqual(
            MODULE.outdoor_graph_statistics(notes), (220_728, {"10": 5})
        )

    def test_notes_without_outdoor_statistics_are_rejected(self):
        with self.assertRaises(SystemExit):
            MODULE.outdoor_graph_statistics({"node_count": 1})

    def test_persisted_notes_describe_the_whole_graph_not_only_the_outdoor_one(self):
        entrance = MODULE.StopRecord("e1", 2, "s1", 121.5, 25.0)
        group = MODULE.StationGroup("s1", (entrance,), (121.5, 25.0), 12.0, 1)
        indoor_edges = (
            self.edge(21, True),
            self.edge(21, True),
            self.edge(23, False),
        )
        prepared = MODULE.PreparedIndoorGraph(
            national_entrance_count=2,
            taipei_entrances=(entrance,),
            station_groups={"s1": group},
            nodes=(),
            edges=indoor_edges,
            all_pathway_count=3,
            taipei_any_endpoint_pathway_count=2,
            included_pathway_count=2,
            skipped_boundary_pathway_count=0,
            skipped_cross_group_pathway_count=0,
            parent_group_types={"station": 1, "ordinary": 0, "other": 0},
        )
        notes = MODULE.build_notes(
            prepared,
            [],
            [],
            161_368,
            441_456,
            220_728,
            {"10": 441_456},
            1,
            [self.edge(2, True), self.edge(2, True)],
        )
        self.assertEqual(notes["indoor_undirected_segment_count"], 2)
        self.assertEqual(notes["connector_undirected_segment_count"], 1)
        self.assertEqual(notes["undirected_segment_count"], 220_731)
        self.assertEqual(notes["outdoor_undirected_segment_count"], 220_728)
        self.assertEqual(
            notes["edge_type_distribution"],
            {"2": 2, "10": 441_456, "21": 2, "23": 1},
        )
        self.assertEqual(notes["outdoor_edge_type_distribution"], {"10": 441_456})
        self.assertEqual(
            sum(notes["edge_type_distribution"].values()),
            notes["directed_edge_count"],
        )


if __name__ == "__main__":
    unittest.main()
