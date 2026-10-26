"""Durable native-PBF area decoder regressions (no frozen oracle dependency)."""

import importlib.util
import io
import sys
import tempfile
import unittest
from contextlib import redirect_stderr
from pathlib import Path

import osmium
from osmium.osm.mutable import Node, Relation, Way
from shapely.geometry import Point

SPEC = importlib.util.spec_from_file_location(
    "areas_builder", Path(__file__).with_name("build-ped-graph.py")
)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("Cannot load builder")
API = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = API
SPEC.loader.exec_module(API)
AREAS = API.load_local_module("area_decoder_tests", "ped-osm-areas.py")


class AreaDecoderTests(unittest.TestCase):
    def collect(
        self,
        outer=None,
        relation=None,
        inner=None,
        missing=False,
        invalid=False,
        extra=False,
        missing_inner=False,
        unordered=False,
        group_members=None,
        relation_id=20,
        relation_version=0,
    ):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "area.osm.pbf"
            writer = osmium.SimpleWriter(str(path))
            points = [
                (121.55, 25.05),
                (121.56, 25.05),
                (121.56, 25.06),
                (121.55, 25.06),
                (121.552, 25.052),
                (121.558, 25.052),
                (121.558, 25.058),
                (121.552, 25.058),
            ]
            for i, point in enumerate(points, 1):
                writer.add_node(Node(id=i, location=point))
            if unordered:
                writer.add_way(Way(id=100, nodes=[1, 2], tags={"highway": "footway"}))
            writer.add_way(
                Way(
                    id=20,
                    nodes=[1, 3, 4, 2, 1] if invalid else [1, 2, 3, 4, 1],
                    tags=outer or {},
                )
            )
            writer.add_way(Way(id=21, nodes=[5, 6, 7, 8, 5], tags=inner or {}))
            members = [
                ("w", 999 if missing else 20, "outer"),
                ("w", 999 if missing_inner else 21, "inner"),
            ]
            if extra:
                for i, point in enumerate(
                    [
                        (121.57, 25.05),
                        (121.58, 25.05),
                        (121.58, 25.06),
                        (121.57, 25.06),
                    ],
                    9,
                ):
                    writer.add_node(Node(id=i, location=point))
                writer.add_way(Way(id=22, nodes=[9, 10, 11, 12, 9], tags={}))
                members.append(("w", 22, "outer"))
            if group_members is not None:
                members = group_members
            if relation is not None:
                writer.add_relation(
                    Relation(
                        id=relation_id,
                        version=relation_version,
                        tags=relation,
                        members=members,
                    )
                )
            writer.close()
            return AREAS.collect_areas(
                path,
                API.BBOXES["taiwan"],
                API.pedestrian_access_is_denied,
                {"service", "residential"},
            )

    def test_modern_and_old_style_holes_delegate_only_equivalent_outer(self):
        for outer, relation in (
            ({}, {"type": "multipolygon", "building": "yes"}),
            ({"building": "yes"}, {"type": "multipolygon", "building": "yes"}),
            ({"building": "yes"}, {"type": "multipolygon"}),
        ):
            with self.subTest(outer=outer, relation=relation):
                result = self.collect(outer, relation)
                self.assertEqual(len(result.records), 1)
                area = result.records[0]
                self.assertEqual(area.source_ref, "osm:relation/20")
                self.assertFalse(area.geometry.covers(Point(121.555, 25.055)))
                self.assertTrue(area.geometry.covers(Point(121.551, 25.051)))
                self.assertEqual(area.raw_tags, relation)
                with self.assertRaises(TypeError):
                    area.tags["building"] = "no"

    def test_independently_tagged_inner_is_not_erased(self):
        result = self.collect(
            {"building": "yes"},
            {"type": "multipolygon", "building": "yes"},
            {"building": "yes"},
        )
        self.assertEqual(
            {r.source_ref for r in result.records}, {"osm:relation/20", "osm:way/21"}
        )
        self.assertEqual(result.delegated_outer_ids, frozenset({20}))

    def test_conflicting_outer_feature_keeps_own_namespace(self):
        result = self.collect(
            {"building": "yes", "access": "no"},
            {"type": "multipolygon", "building": "yes"},
        )
        self.assertEqual(
            {r.source_ref for r in result.records}, {"osm:relation/20", "osm:way/20"}
        )

    def test_disconnected_parts_are_native_not_a_hull(self):
        result = self.collect({}, {"type": "multipolygon", "access": "no"}, extra=True)
        self.assertEqual(len(result.records), 1)
        self.assertEqual(len(result.records[0].geometry.geoms), 2)
        self.assertFalse(result.records[0].geometry.covers(Point(121.565, 25.055)))

    def test_implicit_rules_and_explicit_priority(self):
        for tags in (
            {"building:part": "yes"},
            {"amenity": "parking", "foot": "no"},
            {"landuse": "military", "access": "no"},
            {"area": "yes", "access": "no"},
        ):
            self.assertEqual(len(self.collect(tags).records), 1)
            self.assertEqual(len(self.collect({**tags, "area": "no"}).records), 0)
        for tags in (
            {"highway": "footway", "foot": "no"},
            {"highway": "residential", "junction": "roundabout"},
        ):
            self.assertFalse(self.collect(tags).records)

    def test_missing_and_invalid_required_geometry_reject(self):
        with self.assertRaisesRegex(ValueError, "area|member"):
            self.collect({}, {"type": "multipolygon", "building": "yes"}, missing=True)
        with self.assertRaisesRegex(ValueError, "area|polygon|geometry"):
            self.collect({"building": "yes"}, invalid=True)
        with self.assertRaisesRegex(ValueError, "area|member"):
            self.collect(
                {}, {"type": "multipolygon", "building": "yes"}, missing_inner=True
            )

    def test_unordered_extract_is_sorted_without_mutating_the_input(self):
        result = self.collect(
            {"building": "yes"},
            {"type": "multipolygon", "building": "yes"},
            unordered=True,
        )
        self.assertTrue(result.statistics["osm_area_sorted_input_copy"])
        self.assertEqual(len(result.records), 1)
        self.assertFalse(result.records[0].geometry.covers(Point(121.555, 25.055)))

    def test_geometry_only_area_flag_keeps_oldstyle_theme_and_courtyard(self):
        collection = self.collect(
            {"building": "yes"}, {"type": "multipolygon", "area": "yes"}
        )
        self.assertEqual(len(collection.records), 1)
        self.assertEqual(collection.records[0].source_ref, "osm:relation/20")
        self.assertEqual(len(collection.records[0].geometry.geoms[0].interiors), 1)
        independent = self.collect(
            {"building": "yes"},
            {"type": "multipolygon", "area": "yes", "landuse": "forest"},
        )
        self.assertEqual([r.source_ref for r in independent.records], ["osm:way/20"])
        self.assertFalse(independent.records[0].geometry.geoms[0].interiors)

    def test_neutral_site_keeps_member_footprints_without_a_group_polygon(self):
        collection = self.collect(
            {"building": "yes"},
            {"type": "site", "building": "yes"},
            inner={"building": "yes"},
            group_members=[("w", 20, ""), ("w", 21, "")],
        )
        self.assertEqual(
            {r.source_ref for r in collection.records}, {"osm:way/20", "osm:way/21"}
        )
        self.assertEqual(
            collection.statistics["osm_area_non_areal_site_group_count"], 1
        )
        with self.assertRaisesRegex(ValueError, "Denied site"):
            self.collect({}, {"type": "site", "building": "yes", "access": "no"})

    def test_building_group_is_verified_through_real_outline_and_parts(self):
        collection = self.collect(
            {"building": "yes"},
            {"type": "building", "building": "yes"},
            inner={"building:part": "yes"},
            group_members=[("w", 20, "outline"), ("w", 21, "part")],
        )
        self.assertEqual(
            {r.source_ref for r in collection.records}, {"osm:way/20", "osm:way/21"}
        )
        self.assertEqual(
            collection.statistics["osm_area_verified_building_group_count"], 1
        )

    def test_non_area_groups_do_not_fill_or_require_geometry(self):
        self.assertFalse(
            self.collect(
                {}, {"type": "route", "route": "bus", "access": "no"}, missing=True
            ).records
        )
        self.assertFalse(
            self.collect(
                {},
                {"type": "multipolygon", "building": "yes", "area": "no"},
                missing=True,
            ).records
        )
        with self.assertRaisesRegex(ValueError, "Missing building area outline"):
            self.collect({}, {"type": "building", "building": "yes"})

    def test_neutral_vehicle_footprint_is_not_reduced_to_its_boundary(self):
        result = self.collect({"highway": "service", "area": "yes"})
        self.assertEqual(len(result.records), 1)
        self.assertTrue(result.records[0].geometry.covers(Point(121.555, 25.055)))
        self.assertFalse(self.collect({"highway": "service", "area": "no"}).records)

    def test_building_family_equivalence_preserves_access_and_plane_distinctions(self):
        self.assertEqual(
            AREAS.semantics({"building": "retail"}),
            AREAS.semantics({"building": "apartments"}),
        )
        self.assertEqual(
            AREAS.semantics({"building": "retail", "layer": "0"}),
            AREAS.semantics({"building": "yes"}),
        )
        for difference in ({"access": "no"}, {"layer": "1"}, {"landuse": "forest"}):
            with self.subTest(difference=difference):
                self.assertNotEqual(
                    AREAS.semantics({"building": "retail", **difference}),
                    AREAS.semantics({"building": "apartments"}),
                )
        self.assertNotEqual(
            AREAS.semantics({"building": "no"}), AREAS.semantics({"building": "yes"})
        )

    def test_only_exact_approved_malformed_relation_is_logged_and_omitted(self):
        tags = {"building": "yes", "tourism": "hotel", "type": "multipolygon"}
        output = io.StringIO()
        with redirect_stderr(output):
            result = self.collect(
                {"building": "yes", "access": "no"},
                tags,
                group_members=[("n", 9454749084, "inner")],
                relation_id=13730976,
                relation_version=1,
            )
        self.assertEqual([r.source_ref for r in result.records], ["osm:way/20"])
        self.assertTrue(result.statistics["osm_area_has_known_omissions"])
        self.assertEqual(result.statistics["osm_area_omitted_count"], 1)
        omission = result.statistics["osm_area_omissions"][0]
        self.assertEqual(omission["raw_tags"], tags)
        self.assertEqual(omission["member_refs"], [["n", 9454749084, "inner"]])
        self.assertIsNone(omission["spatial_extent"])
        self.assertIn("OSM_AREA_OMISSION", output.getvalue())
        for identifier, version in ((13730976, 2), (13730977, 1)):
            with (
                self.subTest(identifier=identifier, version=version),
                self.assertRaisesRegex(ValueError, str(identifier)),
            ):
                self.collect(
                    {},
                    tags,
                    group_members=[("n", 9454749084, "inner")],
                    relation_id=identifier,
                    relation_version=version,
                )

    def test_policy_pin_is_exposed(self):
        result = self.collect({"building": "yes"})
        self.assertEqual(result.statistics["osm_area_policy_version"], "osm-areas-v1")
        self.assertEqual(
            result.statistics["osm_area_rules_sha256"],
            "cf81018ba820557c59c2c27de7ea6b314009abed040cd11249e94ed1a3a10583",
        )


if __name__ == "__main__":
    unittest.main()
