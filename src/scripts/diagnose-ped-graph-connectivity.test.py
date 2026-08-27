#!/usr/bin/env python3
"""Pure-function tests for the read-only pedestrian graph connectivity diagnosis."""

import hashlib
import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any

SCRIPT = Path(__file__).with_name("diagnose-ped-graph-connectivity.py")
SPEC = importlib.util.spec_from_file_location("diagnose_ped_graph_connectivity", SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Unable to load {SCRIPT}")
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


def outcome(index, status, from_point, to_point, **extra):
    """Create one comparison outcome fixture."""
    return {
        "index": index,
        "from": {"node": from_point[0], "lat": from_point[1], "lon": from_point[2]},
        "to": {"node": to_point[0], "lat": to_point[1], "lon": to_point[2]},
        "straightLineDistanceM": 1234.5,
        "ours": {"status": status},
        **extra,
    }


class SelectOnlyGuardTests(unittest.TestCase):
    def test_accepts_a_plain_select(self):
        self.assertIn("SELECT", MODULE.assert_select_only("SELECT 1 FROM ped_node"))

    def test_every_shipped_query_is_select_only(self):
        self.assertTrue(MODULE.QUERIES)
        for name, query in MODULE.QUERIES.items():
            with self.subTest(query=name):
                self.assertIs(MODULE.assert_select_only(query), query)

    def test_rejects_mutations_and_multi_statements(self):
        for sql in (
            "DELETE FROM ped_edge",
            "UPDATE ped_node SET geom = NULL",
            "SELECT 1; DROP TABLE ped_edge",
            "WITH x AS (SELECT 1) INSERT INTO ped_edge SELECT * FROM x",
        ):
            with self.subTest(sql=sql), self.assertRaises(MODULE.DiagnosisError):
                MODULE.assert_select_only(sql)


class DisconnectedCaseTests(unittest.TestCase):
    def test_keeps_only_unroutable_cases_in_recorded_order(self):
        document = {
            "outcomes": [
                outcome(0, "ok", (1, 25.0, 121.5), (2, 25.01, 121.51)),
                outcome(7, "no_route", (3, 25.02, 121.52), (4, 25.03, 121.53)),
                outcome(22, "no_route", (5, 25.04, 121.54), (6, 25.05, 121.55)),
            ]
        }
        cases = MODULE.load_disconnected_cases(document)
        self.assertEqual([case.case_id for case in cases], [7, 22])
        self.assertEqual(cases[0].endpoints[0].dense_index, 3)
        self.assertEqual(cases[0].endpoints[1].role, "to")

    def test_prefers_the_replay_source_index_over_the_positional_index(self):
        replayed = outcome(0, "no_route", (3, 25.02, 121.52), (4, 25.03, 121.53))
        replayed["sourceIndex"] = 140
        cases = MODULE.load_disconnected_cases({"outcomes": [replayed]})
        self.assertEqual([case.case_id for case in cases], [140])

    def test_fails_closed_on_a_malformed_endpoint(self):
        broken = outcome(7, "no_route", (3, 25.02, 121.52), (4, 25.03, 121.53))
        broken["to"] = {"node": 4, "lat": "north", "lon": 121.53}
        with self.assertRaises(MODULE.DiagnosisError):
            MODULE.load_disconnected_cases({"outcomes": [broken]})


NODE_IDS = (1_000_000_000_001, 1_000_000_000_002, 1_000_000_000_003)
NODE_LONS = (121.50, 121.51, 121.52)
NODE_LATS = (25.00, 25.01, 25.02)


class ResolveEndpointTests(unittest.TestCase):
    def resolve(self, endpoint):
        """Resolve against the shared three-node fixture."""
        return MODULE.resolve_endpoint(endpoint, NODE_IDS, NODE_LONS, NODE_LATS)

    def test_uses_the_dense_index_when_its_coordinate_still_agrees(self):
        resolved = self.resolve(MODULE.Endpoint("from", 1, 25.01, 121.51))
        self.assertEqual(resolved.node_id, 1_000_000_000_002)
        self.assertEqual(resolved.method, "dense_index")

    def test_falls_back_to_a_unique_coordinate_when_the_index_moved(self):
        resolved = self.resolve(MODULE.Endpoint("from", 0, 25.02, 121.52))
        self.assertEqual(resolved.node_id, 1_000_000_000_003)
        self.assertEqual(resolved.method, "coordinate")

    def test_falls_back_when_the_index_is_out_of_range(self):
        resolved = self.resolve(MODULE.Endpoint("to", 99, 25.00, 121.50))
        self.assertEqual(resolved.node_id, 1_000_000_000_001)
        self.assertEqual(resolved.method, "coordinate")

    def test_fails_closed_when_no_node_matches(self):
        with self.assertRaises(MODULE.DiagnosisError):
            self.resolve(MODULE.Endpoint("from", 0, 24.90, 121.40))

    def test_fails_closed_instead_of_snapping_to_a_near_miss(self):
        """A metre-scale miss must not resolve; that would be a silent nearest-snap."""
        with self.assertRaises(MODULE.DiagnosisError):
            self.resolve(MODULE.Endpoint("from", 7, 25.0100200, 121.5100200))

    def test_fails_closed_when_two_nodes_share_the_coordinate(self):
        duplicated_ids = [*NODE_IDS, 1_000_000_000_004]
        duplicated_lons = [*NODE_LONS, 121.51]
        duplicated_lats = [*NODE_LATS, 25.01]
        with self.assertRaises(MODULE.DiagnosisError) as raised:
            MODULE.resolve_endpoint(
                MODULE.Endpoint("from", 42, 25.01, 121.51),
                duplicated_ids,
                duplicated_lons,
                duplicated_lats,
            )
        self.assertIn("ambiguous", str(raised.exception))

    def test_a_matching_dense_index_does_not_skip_the_uniqueness_check(self):
        """The index agreeing must never shortcut past a duplicate coordinate."""
        duplicated_ids = [*NODE_IDS, 1_000_000_000_004]
        duplicated_lons = [*NODE_LONS, 121.51]
        duplicated_lats = [*NODE_LATS, 25.01]
        with self.assertRaises(MODULE.DiagnosisError) as raised:
            MODULE.resolve_endpoint(
                MODULE.Endpoint("from", 1, 25.01, 121.51),
                duplicated_ids,
                duplicated_lons,
                duplicated_lats,
            )
        self.assertIn("ambiguous", str(raised.exception))

    def test_a_duplicate_far_from_the_endpoint_still_resolves(self):
        """Uniqueness is judged inside the tolerance, not across the whole graph."""
        resolved = MODULE.resolve_endpoint(
            MODULE.Endpoint("from", 1, 25.01, 121.51),
            [*NODE_IDS, 1_000_000_000_004],
            [*NODE_LONS, 121.60],
            [*NODE_LATS, 25.10],
        )
        self.assertEqual(resolved.node_id, 1_000_000_000_002)
        self.assertEqual(resolved.method, "dense_index")


class WeakComponentTests(unittest.TestCase):
    def test_unions_arcs_regardless_of_direction(self):
        component_of = MODULE.build_weak_components(
            [10, 11, 12, 20, 21, 30], [(10, 11), (12, 11), (21, 20)]
        )
        sizes = MODULE.component_sizes(component_of)
        self.assertEqual(sizes[MODULE.largest_component(sizes)], 3)
        self.assertEqual(component_of[10], component_of[12])
        self.assertNotEqual(component_of[10], component_of[20])
        self.assertEqual(sizes[component_of[30]], 1)

    def test_representative_is_the_component_minimum_regardless_of_edge_order(self):
        forward = MODULE.build_weak_components([5, 6, 7], [(7, 6), (6, 5)])
        reverse = MODULE.build_weak_components([5, 6, 7], [(6, 5), (7, 6)])
        self.assertEqual(forward, reverse)
        self.assertEqual(set(forward.values()), {5})

    def test_rejects_an_edge_pointing_outside_the_version(self):
        with self.assertRaises(MODULE.DiagnosisError):
            MODULE.build_weak_components([1, 2], [(1, 99)])


class GeometryTests(unittest.TestCase):
    def test_point_to_segment_distance_matches_a_known_offset(self):
        distance = MODULE.point_to_segment_distance_m(
            (121.5000, 25.0010), (121.4990, 25.0000), (121.5010, 25.0000)
        )
        self.assertAlmostEqual(distance, 110.54, delta=1.0)

    def test_crossing_segments_report_an_intersection(self):
        crossing = MODULE.segment_intersection(
            (121.4990, 25.0000),
            (121.5010, 25.0000),
            (121.5000, 24.9990),
            (121.5000, 25.0010),
        )
        self.assertIsNotNone(crossing)
        self.assertAlmostEqual(crossing[0], 121.5000, places=6)
        self.assertAlmostEqual(crossing[1], 25.0000, places=6)

    def test_parallel_segments_do_not_intersect(self):
        self.assertIsNone(
            MODULE.segment_intersection(
                (121.4990, 25.0000),
                (121.5010, 25.0000),
                (121.4990, 25.0010),
                (121.5010, 25.0010),
            )
        )

    def test_parses_postgis_linestring_and_polygon_text(self):
        self.assertEqual(
            MODULE.parse_linestring_wkt("LINESTRING(121.5 25.0,121.51 25.01)"),
            [(121.5, 25.0), (121.51, 25.01)],
        )
        self.assertEqual(
            MODULE.parse_polygon_bbox(
                "POLYGON((121.43 24.95,121.68 24.95,121.68 25.22,121.43 25.22,121.43 24.95))"
            ),
            (121.43, 24.95, 121.68, 25.22),
        )

    def test_rejects_unparseable_edge_geometry(self):
        with self.assertRaises(MODULE.DiagnosisError):
            MODULE.parse_linestring_wkt("POINT(121.5 25.0)")


class GradeTests(unittest.TestCase):
    def test_untagged_ground_ways_share_a_grade(self):
        self.assertTrue(
            MODULE.is_same_grade({"highway": "footway"}, {"highway": "residential"})
        )

    def test_layer_level_bridge_and_tunnel_all_break_the_same_grade_claim(self):
        ground = {"highway": "footway"}
        for elevated in (
            {"highway": "footway", "layer": "1"},
            {"highway": "footway", "level": "1"},
            {"highway": "footway", "bridge": "yes"},
            {"highway": "footway", "tunnel": "yes"},
        ):
            with self.subTest(tags=elevated):
                self.assertFalse(MODULE.is_same_grade(ground, elevated))

    def test_two_identically_tagged_bridges_are_still_not_provably_same_grade(self):
        bridge = {"highway": "footway", "bridge": "yes", "layer": "1"}
        self.assertFalse(MODULE.is_same_grade(bridge, dict(bridge)))
        self.assertFalse(MODULE.is_grade_separated(bridge, dict(bridge)))

    def test_location_and_covered_conflicts_are_grade_separation_evidence(self):
        for first, second in (
            ({"location": "underground"}, {"location": "surface"}),
            ({"covered": "yes"}, {"covered": "no"}),
        ):
            with self.subTest(first=first, second=second):
                self.assertTrue(MODULE.is_grade_separated(first, second))


class BarrierTests(unittest.TestCase):
    def test_walls_and_fences_block(self):
        for value in ("wall", "fence", "retaining_wall"):
            with self.subTest(value=value):
                self.assertTrue(MODULE.is_blocking_barrier({"barrier": value}))

    def test_passable_barriers_do_not_block(self):
        for value in ("kerb", "bollard", "gate", "cycle_barrier"):
            with self.subTest(value=value):
                self.assertFalse(MODULE.is_blocking_barrier({"barrier": value}))

    def test_a_passable_barrier_denying_foot_blocks(self):
        self.assertTrue(MODULE.is_blocking_barrier({"barrier": "gate", "foot": "no"}))


MISSING_ELIGIBLE_CONNECTOR = {
    "osmWayId": 555,
    "tags": {"highway": "cycleway", "foot": "designated"},
    "eligibleUnderCurrentPolicy": True,
    "missingFromSelectedStoredGraph": True,
}


class PedestrianPermissionTests(unittest.TestCase):
    def test_an_explicit_foot_tag_is_permission(self):
        for value in ("yes", "designated", "permissive"):
            with self.subTest(foot=value):
                self.assertTrue(
                    MODULE.has_explicit_pedestrian_permission(
                        {"highway": "cycleway", "foot": value}
                    )
                )

    def test_an_untagged_cycleway_is_not_permission(self):
        """Being excluded is not evidence the exclusion was wrong."""
        self.assertFalse(
            MODULE.has_explicit_pedestrian_permission({"highway": "cycleway"})
        )

    def test_a_motorway_is_never_permission_even_when_foot_is_affirmative(self):
        self.assertFalse(
            MODULE.has_explicit_pedestrian_permission(
                {"highway": "motorway", "foot": "yes"}
            )
        )
        self.assertFalse(
            MODULE.has_explicit_pedestrian_permission({"highway": "motorway_link"})
        )

    def test_any_denial_beats_an_affirmative_foot_tag(self):
        for tags in (
            {"highway": "cycleway", "foot": "no"},
            {"highway": "cycleway", "foot": "private"},
            {"highway": "cycleway", "foot": "yes", "access": "no"},
            {"highway": "cycleway", "foot": "designated", "access": "private"},
        ):
            with self.subTest(tags=tags):
                self.assertFalse(MODULE.has_explicit_pedestrian_permission(tags))

    def test_eligible_missing_connector_ways_keeps_only_current_policy_matches(self):
        kept = MODULE.eligible_missing_connector_ways(
            [
                {
                    "osmWayId": 1,
                    "tags": {"highway": "cycleway"},
                    "missingFromSelectedStoredGraph": True,
                },
                {
                    "osmWayId": 2,
                    "tags": {"highway": "motorway", "foot": "yes"},
                    "missingFromSelectedStoredGraph": True,
                },
                MISSING_ELIGIBLE_CONNECTOR,
            ]
        )
        self.assertEqual([way["osmWayId"] for way in kept], [555])


class MissingEligibleConnectorEvidenceTests(unittest.TestCase):
    @staticmethod
    def _connector_way():
        return {
            "osmWayId": 229778286,
            "tags": {
                "highway": "cycleway",
                "foot": "designated",
                "segregated": "yes",
            },
            "nodeRefs": [1001, 1002, 2001],
        }

    @staticmethod
    def _collect(stored_way_ids):
        evidence = MODULE.CaseEvidence(gap_m=19.02)
        MODULE._collect_eligibility_evidence(
            island_osm_nodes={1001},
            component_of={10: 2, 20: 1},
            osm_node_of={10: 1001, 20: 2001},
            main_component=1,
            stored_way_ids=stored_way_ids,
            osm_ways=[MissingEligibleConnectorEvidenceTests._connector_way()],
            evidence=evidence,
        )
        return evidence

    def test_old_graph_classifies_a_now_eligible_missing_connector(self):
        evidence = self._collect(stored_way_ids=set())
        self.assertEqual(
            [way["osmWayId"] for way in evidence.missing_eligible_connector_ways],
            [229778286],
        )
        connector = evidence.missing_eligible_connector_ways[0]
        self.assertTrue(connector["eligibleUnderCurrentPolicy"])
        self.assertTrue(connector["missingFromSelectedStoredGraph"])
        self.assertEqual(MODULE.classify_case(evidence)[0], "ELIGIBILITY_RULE_DEFECT")

    def test_already_represented_connector_is_not_a_rule_defect(self):
        evidence = self._collect(stored_way_ids={229778286})
        self.assertFalse(evidence.missing_eligible_connector_ways)
        self.assertEqual(MODULE.classify_case(evidence)[0], "OSM_GAP_UNPROVEN")


class ClassificationTests(unittest.TestCase):
    @staticmethod
    def _crossing_evidence(
        island_tags: dict[str, str], main_tags: dict[str, str]
    ) -> Any:
        evidence = MODULE.CaseEvidence(gap_m=0.0)
        MODULE._collect_intersection_evidence(
            island_edges=[
                {
                    "edgeId": 1,
                    "fromNode": 10,
                    "toNode": 11,
                    "sourceRef": "osm:way/101",
                    "coordinates": [(121.5000, 25.0000), (121.5010, 25.0000)],
                }
            ],
            main_edges=[
                {
                    "edgeId": 2,
                    "fromNode": 20,
                    "toNode": 21,
                    "sourceRef": "osm:way/202",
                    "coordinates": [(121.5005, 24.9995), (121.5005, 25.0005)],
                }
            ],
            ways_by_id={
                101: {"tags": island_tags},
                202: {"tags": main_tags},
            },
            evidence=evidence,
        )
        return evidence

    def test_matching_bridge_or_tunnel_semantics_are_unknown_and_unproven(self):
        for island_tags, main_tags in (
            (
                {"highway": "footway", "bridge": "yes"},
                {"highway": "footway", "bridge": "yes"},
            ),
            (
                {"highway": "footway", "tunnel": "yes"},
                {"highway": "footway", "tunnel": "yes"},
            ),
            (
                {"highway": "footway", "bridge": "yes"},
                {"highway": "footway", "bridge": "viaduct"},
            ),
        ):
            with self.subTest(island_tags=island_tags, main_tags=main_tags):
                evidence = self._crossing_evidence(island_tags, main_tags)
                self.assertFalse(evidence.grade_separated_intersections)
                self.assertEqual(len(evidence.unknown_grade_intersections), 1)
                label, reasons = MODULE.classify_case(evidence)
                self.assertEqual(label, "OSM_GAP_UNPROVEN")
                self.assertTrue(
                    any(
                        "vertical semantics are inconclusive" in reason
                        for reason in reasons
                    )
                )

    def test_explicitly_conflicting_crossings_classify_as_grade_separated(self):
        for island_tags, main_tags in (
            (
                {
                    "highway": "steps",
                    "layer": "-2",
                    "level": "-2;-3",
                    "location": "underground",
                    "tunnel": "yes",
                },
                {"highway": "secondary"},
            ),
            (
                {"highway": "footway"},
                {"highway": "footway", "bridge": "yes", "layer": "3"},
            ),
        ):
            with self.subTest(island_tags=island_tags, main_tags=main_tags):
                evidence = self._crossing_evidence(island_tags, main_tags)
                self.assertEqual(len(evidence.grade_separated_intersections), 1)
                self.assertFalse(evidence.unknown_grade_intersections)
                label, reasons = MODULE.classify_case(evidence)
                self.assertEqual(label, "GRADE_SEPARATED")
                self.assertIn("explicitly conflicting", reasons[0])

    def test_a_missing_eligible_connector_outranks_every_other_finding(self):
        evidence = MODULE.CaseEvidence(
            gap_m=4.3,
            missing_eligible_connector_ways=[MISSING_ELIGIBLE_CONNECTOR],
            same_grade_intersections=[{"islandEdgeId": 1}],
        )
        label, reasons = MODULE.classify_case(evidence)
        self.assertEqual(label, "ELIGIBILITY_RULE_DEFECT")
        self.assertIn("555", reasons[0])

    def test_a_missing_policy_ineligible_connector_is_not_a_rule_defect(self):
        for tags in (
            {"highway": "motorway"},
            {"highway": "cycleway"},
            {"highway": "cycleway", "foot": "no"},
            {"highway": "service", "access": "private", "foot": "yes"},
        ):
            with self.subTest(tags=tags):
                label, reasons = MODULE.classify_case(
                    MODULE.CaseEvidence(
                        gap_m=4.3,
                        missing_eligible_connector_ways=[
                            {
                                "osmWayId": 9,
                                "tags": tags,
                                "missingFromSelectedStoredGraph": True,
                            }
                        ],
                    )
                )
                self.assertEqual(label, "OSM_GAP_UNPROVEN")
                self.assertTrue(
                    any(
                        "missing current-policy-eligible connector" in reason
                        for reason in reasons
                    )
                )

    def test_a_same_grade_crossing_is_proven(self):
        evidence = MODULE.CaseEvidence(
            gap_m=0.0, same_grade_intersections=[{"islandEdgeId": 1}]
        )
        self.assertEqual(
            MODULE.classify_case(evidence)[0], "SAME_GRADE_INTERSECTION_PROVEN"
        )

    def test_a_layer_separated_crossing_is_not_reported_as_same_grade(self):
        evidence = MODULE.CaseEvidence(
            gap_m=0.0, grade_separated_intersections=[{"islandEdgeId": 1}]
        )
        self.assertEqual(MODULE.classify_case(evidence)[0], "GRADE_SEPARATED")

    def test_a_crossing_with_unknown_tags_is_not_grade_separation(self):
        label, reasons = MODULE.classify_case(
            MODULE.CaseEvidence(
                gap_m=0.0, unknown_grade_intersections=[{"islandEdgeId": 1}]
            )
        )
        self.assertEqual(label, "OSM_GAP_UNPROVEN")
        self.assertTrue(any("could not be graded" in reason for reason in reasons))

    def test_a_barrier_meeting_the_gap_proxy_classifies_nothing(self):
        """One straight-line proxy crossing is not a separation proof."""
        label, reasons = MODULE.classify_case(
            MODULE.CaseEvidence(
                gap_m=4.33,
                barrier_observations=[
                    {"osmId": 9, "kind": "way", "tags": {"barrier": "wall"}}
                ],
            )
        )
        self.assertEqual(label, "OSM_GAP_UNPROVEN")
        self.assertNotIn("BARRIER_BLOCKED", MODULE.CLASSIFICATIONS)
        self.assertTrue(any("classifies nothing" in reason for reason in reasons))

    def test_a_barrier_never_outranks_bbox_clipping(self):
        evidence = MODULE.CaseEvidence(
            gap_m=6.0,
            barrier_observations=[
                {"osmId": 9, "kind": "way", "tags": {"barrier": "wall"}}
            ],
            bbox_clipping={"osmWayId": 3},
        )
        self.assertEqual(MODULE.classify_case(evidence)[0], "BBOX_ARTIFACT")

    def test_clipping_is_reported_when_it_is_the_only_positive_finding(self):
        evidence = MODULE.CaseEvidence(gap_m=12.0, bbox_clipping={"osmWayId": 3})
        self.assertEqual(MODULE.classify_case(evidence)[0], "BBOX_ARTIFACT")

    def test_proximity_alone_can_only_be_unproven(self):
        label, reasons = MODULE.classify_case(MODULE.CaseEvidence(gap_m=4.3))
        self.assertEqual(label, "OSM_GAP_UNPROVEN")
        self.assertIn("4.30 m", reasons[0])

    def test_the_whole_precedence_chain_holds_when_every_finding_is_present(self):
        full = {
            "gap_m": 4.3,
            "missing_eligible_connector_ways": [MISSING_ELIGIBLE_CONNECTOR],
            "same_grade_intersections": [{}],
            "grade_separated_intersections": [{}],
            "bbox_clipping": {"osmWayId": 1},
        }
        drop_order = (
            "missing_eligible_connector_ways",
            "same_grade_intersections",
            "grade_separated_intersections",
            "bbox_clipping",
        )
        for step, expected in enumerate(MODULE.CLASSIFICATION_PRECEDENCE):
            evidence = MODULE.CaseEvidence(
                **{
                    key: ([] if key != "bbox_clipping" else None)
                    if key in drop_order[:step]
                    else value
                    for key, value in full.items()
                }
            )
            with self.subTest(dropped=drop_order[:step]):
                self.assertEqual(MODULE.classify_case(evidence)[0], expected)

    def test_every_classification_is_one_of_the_declared_labels(self):
        for evidence in (
            MODULE.CaseEvidence(
                missing_eligible_connector_ways=[MISSING_ELIGIBLE_CONNECTOR]
            ),
            MODULE.CaseEvidence(same_grade_intersections=[{}]),
            MODULE.CaseEvidence(grade_separated_intersections=[{}]),
            MODULE.CaseEvidence(unknown_grade_intersections=[{}]),
            MODULE.CaseEvidence(barrier_observations=[{"osmId": 1}]),
            MODULE.CaseEvidence(bbox_clipping={"osmWayId": 1}),
            MODULE.CaseEvidence(),
        ):
            label, reasons = MODULE.classify_case(evidence)
            with self.subTest(label=label):
                self.assertIn(label, MODULE.CLASSIFICATIONS)
                self.assertTrue(reasons and reasons[0])


class SourceRefTests(unittest.TestCase):
    def test_reads_node_and_way_references(self):
        self.assertEqual(
            MODULE.osm_id_from_source_ref(
                "osm:node/12345", MODULE.SOURCE_REF_NODE_PATTERN
            ),
            12345,
        )
        self.assertEqual(
            MODULE.osm_id_from_source_ref("osm:way/678", MODULE.SOURCE_REF_WAY_PATTERN),
            678,
        )

    def test_returns_none_for_foreign_references(self):
        self.assertIsNone(
            MODULE.osm_id_from_source_ref(
                "indoor:pathway/9", MODULE.SOURCE_REF_WAY_PATTERN
            )
        )
        self.assertIsNone(
            MODULE.osm_id_from_source_ref(None, MODULE.SOURCE_REF_NODE_PATTERN)
        )


class MultipointTests(unittest.TestCase):
    def test_serialises_points_for_a_parameterised_filter(self):
        self.assertEqual(
            MODULE.multipoint_wkt([(121.5, 25.0), (121.51, 25.01)]),
            "MULTIPOINT ((121.5 25.0), (121.51 25.01))",
        )

    def test_refuses_an_empty_point_set(self):
        with self.assertRaises(MODULE.DiagnosisError):
            MODULE.multipoint_wkt([])


class SourceHashVerificationTests(unittest.TestCase):
    """Fixture-sized stand-ins for the PBF; the hash contract does not depend on size."""

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.pbf = Path(self.directory.name) / "extract.osm.pbf"
        self.pbf.write_bytes(b"\x00pretend-osm-extract\xff" * 4096)
        self.digest = hashlib.sha256(self.pbf.read_bytes()).hexdigest()

    def test_uses_the_same_algorithm_and_meaning_as_the_builder(self):
        self.assertEqual(MODULE.BUILDER.sha256_file(self.pbf), self.digest)

    def test_accepts_the_extract_the_version_was_built_from(self):
        self.assertEqual(
            MODULE.verify_pbf_source_hash(
                {"versionId": 1, "sourceHash": self.digest}, self.pbf
            ),
            self.digest,
        )

    def test_tolerates_surrounding_whitespace_in_the_recorded_hash(self):
        self.assertEqual(
            MODULE.verify_pbf_source_hash(
                {"versionId": 1, "sourceHash": f"  {self.digest}\n"}, self.pbf
            ),
            self.digest,
        )

    def test_fails_closed_on_a_different_extract(self):
        other = Path(self.directory.name) / "other.osm.pbf"
        other.write_bytes(b"a different extract")
        with self.assertRaises(MODULE.DiagnosisError) as raised:
            MODULE.verify_pbf_source_hash(
                {"versionId": 1, "sourceHash": self.digest}, other
            )
        message = str(raised.exception)
        self.assertIn("does not match graph version 1", message)
        self.assertIn(self.digest, message)

    def test_fails_closed_when_the_version_records_no_hash(self):
        for recorded in (None, "", "   ", 12345):
            with (
                self.subTest(recorded=recorded),
                self.assertRaises(MODULE.DiagnosisError) as raised,
            ):
                MODULE.verify_pbf_source_hash(
                    {"versionId": 7, "sourceHash": recorded}, self.pbf
                )
            self.assertIn("no source_hash", str(raised.exception))

    def test_both_version_queries_select_the_source_hash(self):
        for name in ("version", "latest_version"):
            with self.subTest(query=name):
                self.assertIn("source_hash", MODULE.QUERIES[name])


if __name__ == "__main__":
    unittest.main()
