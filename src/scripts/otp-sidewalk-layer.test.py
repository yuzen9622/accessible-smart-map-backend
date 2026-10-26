import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

import osmium
from shapely import from_wkb
from shapely.geometry import LineString, MultiPolygon, Point, Polygon, box


SPEC = importlib.util.spec_from_file_location("otp_layer_test_api", Path(__file__).with_name("otp-sidewalk-layer.py"))
API = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = API
SPEC.loader.exec_module(API)
PLANE = dict(layer="0", level="0", bridge="no", tunnel="no")


class ReadPbf(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.nodes, self.ways, self.relations = {}, {}, {}
        self.node_tags = {}

    def node(self, item):
        self.nodes[item.id] = (item.location.lon, item.location.lat)
        self.node_tags[item.id] = dict(item.tags)

    def way(self, item):
        self.ways[item.id] = dict(nodes=[node.ref for node in item.nodes], tags=dict(item.tags))

    def relation(self, item):
        self.relations[item.id] = [(member.type, member.ref, member.role) for member in item.members]


class SidewalkLayerTests(unittest.TestCase):
    def setUp(self):
        self.work = tempfile.TemporaryDirectory()
        self.addCleanup(self.work.cleanup)
        self.root = Path(self.work.name)
        self.pbf = self.root / "source.osm.pbf"
        self.output = self.root / "merged.osm.pbf"
        self.report = self.root / "report.json"

    def source(self, geometry=None, raw=None, source_id="government-1", width=2):
        return API.NETWORK.SourceSurface(
            source_id, "台北市", geometry if geometry is not None else box(121.001, 24.99998, 121.003, 25.00002),
            width, None, {**PLANE, "NAME": "政府原始路名"} if raw is None else raw, [], None, "unknown",
        )

    def write(self, nodes=None, ways=None, relations=()):
        if nodes is None:
            nodes = [(1, 121, 25), (2, 121.001, 25), (3, 121.003, 25), (4, 121.004, 25)]
        if ways is None:
            ways = [(10, [1, 2], {"highway": "footway"}), (20, [3, 4], {"highway": "footway"})]
        writer = osmium.SimpleWriter(str(self.pbf))
        for ident, lon, lat, *tags in nodes:
            writer.add_node(osmium.osm.mutable.Node(id=ident, location=(lon, lat), tags=tags[0] if tags else {}))
        for ident, refs, tags in ways:
            writer.add_way(osmium.osm.mutable.Way(id=ident, nodes=refs, tags=tags))
        for ident, members, tags in relations:
            writer.add_relation(osmium.osm.mutable.Relation(id=ident, members=members, tags=tags))
        writer.close()

    def compile(self, surfaces=None):
        snapshot = API.NETWORK.SourceSnapshot("7", "a" * 64, tuple(surfaces or [self.source()]), "202606")
        report = API.compile_layer(self.pbf, snapshot, self.output, self.report)
        result = ReadPbf()
        result.apply_file(str(self.output))
        return report, result

    @staticmethod
    def generated(result):
        return {ident: way for ident, way in result.ways.items() if way["tags"].get("source:batch") == "202606"}

    def test_shared_original_endpoints_and_provenance_without_source_mutation(self):
        self.write()
        original = self.pbf.read_bytes()
        report, result = self.compile()
        government = self.generated(result)
        refs = {node for way in government.values() for node in way["nodes"]}
        self.assertIn(2, refs)
        self.assertIn(3, refs)
        self.assertEqual(report["counts"]["sources_with_osm_ports"], 1)
        self.assertEqual(self.pbf.read_bytes(), original)
        self.assertEqual(result.ways[10]["nodes"], [1, 2])
        for way in government.values():
            self.assertEqual(way["tags"]["name"], "政府原始路名")
            self.assertEqual(way["tags"]["source:ref"], "government-1")
            self.assertEqual(way["tags"]["width"], "2.0")
            self.assertNotIn("wheelchair", way["tags"])
        self.assertTrue(report["county_samples"]["台北市"]["paths"])

    @staticmethod
    def reachable(result, start):
        adjacency = {}
        for way in result.ways.values():
            if API.BUILDER.pedestrian_access_is_denied(way["tags"]):
                continue
            for left, right in zip(way["nodes"], way["nodes"][1:]):
                if any(not API.safe_port_node(result.node_tags[node]) for node in (left, right)):
                    continue
                adjacency.setdefault(left, set()).add(right)
                adjacency.setdefault(right, set()).add(left)
        seen, pending = {start}, [start]
        while pending:
            for neighbour in adjacency.get(pending.pop(), set()) - seen:
                seen.add(neighbour)
                pending.append(neighbour)
        return seen

    def test_closed_node_partitions_inferred_transitions_and_preserves_open_gate(self):
        for index, access in enumerate(("no", "yes")):
            self.pbf = self.root / f"gate-{index}.osm.pbf"
            self.output = self.root / f"gate-{index}-merged.osm.pbf"
            self.report = self.root / f"gate-{index}.json"
            self.write(
                nodes=[(1, 121, 25), (2, 121.001, 25), (3, 121.002, 25, {"barrier": "gate", "foot": access}), (4, 121.003, 25), (5, 121.004, 25)],
                ways=[(10, [1, 2, 3, 4, 5], {"highway": "footway"})],
            )
            report, result = self.compile()
            self.assertEqual(5 in self.reachable(result, 1), access == "yes")
            self.assertIn(2, self.reachable(result, 1))
            self.assertIn(4, self.reachable(result, 5))
            self.assertEqual(result.node_tags[3], {"barrier": "gate", "foot": access})
            if access == "no":
                self.assertTrue(report["node_closures"][0]["cuts"])
                self.assertTrue(all(way["tags"]["foot"] == "yes" for way in self.generated(result).values()))

    def test_closed_node_cannot_be_bypassed_through_precision_source_connector(self):
        self.write(
            nodes=[(1, 121, 25), (2, 121.001, 25), (3, 121.002, 25, {"barrier": "gate", "foot": "no"}), (4, 121.003, 25), (5, 121.004, 25)],
            ways=[(10, [1, 2, 3, 4, 5], {"highway": "footway"})],
        )
        elevated = self.source(box(121.001, 25.001, 121.003, 25.00102), raw={**PLANE, "layer": "1", "bridge": "yes"}, source_id="elevated")
        report, result = self.compile([
            self.source(box(121.001, 24.99998, 121.00200004, 25.00002), source_id="left"),
            self.source(box(121.00200004, 24.99998, 121.003, 25.00002), source_id="right"), elevated,
        ])
        self.assertTrue(report["precision_connectors"])
        self.assertNotIn(5, self.reachable(result, 1))
        self.assertIn(2, self.reachable(result, 1))
        self.assertIn(4, self.reachable(result, 5))
        elevated_ways = [way for way in self.generated(result).values() if way["tags"]["source:ref"] == "elevated"]
        self.assertTrue(elevated_ways)
        self.assertTrue(all("source:closure" not in way["tags"] for way in elevated_ways))

    def test_reverse_via_way_preserves_connected_restriction_member_order(self):
        self.write(
            nodes=[(1, 121.005, 25), (2, 121.004, 25), (3, 121, 25), (4, 120.999, 25)],
            ways=[(10, [1, 2], {"highway": "residential"}), (20, [3, 2], {"highway": "residential", "name": "same-road"}), (30, [3, 4], {"highway": "residential"})],
            relations=[(100, [("w", 10, "from"), ("w", 20, "via"), ("w", 30, "to")], {"type": "restriction", "restriction": "no_straight_on"})],
        )
        _, result = self.compile([self.source(box(121.001, 25.0001, 121.003, 25.00012), raw={**PLANE, "NAME": "same-road"})])
        members = [ref for kind, ref, _ in result.relations[100] if kind == "w"]
        self.assertGreater(len(members), 3)
        for left, right in zip(members, members[1:]):
            self.assertTrue(set(result.ways[left]["nodes"]) & set(result.ways[right]["nodes"]))

    def test_invalid_original_restrictions_are_retained_and_audited_separately(self):
        invalid = [
            [("w", 10, "to")],
            [("w", 10, "from"), ("n", 2, "via"), ("w", 20, "to")],
            [("w", 20, "from"), ("w", 10, "via"), ("w", 20, "to")],
        ]
        self.write(
            ways=[(10, [1, 4], {"highway": "footway"}), (20, [3, 4], {"highway": "footway"})],
            relations=[(100 + index, members, {"type": "restriction", "restriction": "no_straight_on"}) for index, members in enumerate(invalid)],
        )
        report, result = self.compile()
        self.assertEqual(report["counts"]["preserved_original_invalid_restrictions"], 2)
        self.assertEqual(report["counts"]["preserved_target_unsupported_restrictions"], 1)
        for index, members in enumerate(invalid):
            self.assertEqual(result.relations[100 + index], members)
        self.assertEqual({entry["reason"] for entry in report["restriction_compatibility"]["entries"]}, {
            "missing_required_role", "original_via_node_not_on_from_or_to", "original_via_way_chain_disconnected",
        })
        self.assertTrue(all(entry["serialized_target_activation_verified"] for entry in report["restriction_compatibility"]["entries"]))

    def test_duplicate_restriction_roles_preserve_the_last_active_otp_triple(self):
        raw = [("w", 20, "from"), ("w", 20, "to"), ("n", 1, "via"), ("w", 10, "from"), ("w", 20, "to"), ("n", 4, "via")]
        self.write(
            ways=[(10, [1, 4], {"highway": "footway", "oneway": "yes"}), (20, [4, 3], {"highway": "footway", "oneway": "yes"})],
            relations=[(100, raw, {"type": "restriction", "restriction": "no_left_turn"})],
        )
        report, result = self.compile()
        actual = result.relations[100]
        self.assertEqual(actual[:3], raw[:3])
        self.assertNotEqual(actual[3][1], 10)
        self.assertIn(4, result.ways[actual[3][1]]["nodes"])
        self.assertIn(4, result.ways[actual[4][1]]["nodes"])
        self.assertEqual(actual[5], raw[5])
        entry = report["restriction_compatibility"]["entries"][0]
        self.assertEqual(entry["status"], "target_otp_last_role_projection")
        self.assertTrue(entry["serialized_target_activation_verified"])

    def test_connected_but_ambiguous_restriction_is_not_misclassified_as_original_invalid(self):
        relation = API.SimpleNamespace(
            id=100, tags={"type": "restriction", "restriction": "no_straight_on"},
            members=[API.SimpleNamespace(type=kind, ref=ref, role=role) for kind, ref, role in [("w", 10, "from"), ("n", 2, "via"), ("w", 20, "to")]],
        )
        original = {10: (1, 2, 3), 20: (2, 4)}
        self.assertIsNone(API.original_restriction_issue(relation, original))
        with self.assertRaisesRegex(ValueError, "ambiguous split way"):
            API.relation_members(relation, {10: [API.Piece(10, (1, 2), {}), API.Piece(30, (2, 3), {})]}, original)

    def test_all_unrepresentable_contacts_are_reported_without_discarding_sources(self):
        self.write(ways=[(10, [1, 4], {"highway": "footway"})])
        surfaces = [
            self.source(MultiPolygon([box(121.00100002, 24.9999, 121.00100004, 25.0001), box(121.001, 25.001, 121.0012, 25.0011)]), source_id="thin-left"),
            self.source(MultiPolygon([box(121.00300002, 24.9999, 121.00300004, 25.0001), box(121.003, 25.001, 121.0032, 25.0011)]), source_id="thin-right"),
        ]
        report, result = self.compile(surfaces)
        self.assertEqual(report["counts"]["unserialized_osm_contacts"], 4)
        self.assertFalse(report["all_observed_contacts_serialized"])
        self.assertEqual(result.ways[10]["nodes"], [1, 4])
        files = list(self.root.glob("report-contact-failures-*.json"))
        self.assertEqual(len(files), 1)
        diagnostic = json.loads(files[0].read_text())
        self.assertEqual({member["source_id"] for failure in diagnostic["failures"] for member in failure["members"]}, {"thin-left", "thin-right"})
        self.assertTrue(all(report["sources"][source.source_id]["generated_way_ids"] for source in surfaces))
        self.assertEqual({way["tags"]["source:ref"] for way in self.generated(result).values()}, {"thin-left", "thin-right"})
        self.assertTrue(all(failure["fragment_certificates"] for failure in diagnostic["failures"]))

    def test_proven_source_contact_uses_covered_interior_anchors_beyond_local_grid(self):
        self.write(nodes=[], ways=[])
        x, y = 121.00000004, 25.00000005
        left = Polygon([(x, y - 1e-8), (x, y + 1e-8), (x - 2e-6, y + 2e-7), (x - 2e-6, y - 2e-7)])
        right = Polygon([(x, y - 1e-8), (x + 2e-6, y - 2e-7), (x + 2e-6, y + 2e-7), (x, y + 1e-8)])
        report, result = self.compile([self.source(left, source_id="left"), self.source(right, source_id="right")])
        self.assertTrue(report["precision_connectors"])
        generated = self.generated(result)
        left_node = next(way["nodes"][0] for way in generated.values() if way["tags"]["source:ref"] == "left")
        right_node = next(way["nodes"][0] for way in generated.values() if way["tags"]["source:ref"] == "right")
        self.assertIn(right_node, self.reachable(result, left_node))
        allowed = left.union(right)
        for way in generated.values():
            self.assertTrue(allowed.covers(LineString([result.nodes[node] for node in way["nodes"]])))

    def test_unserialized_osm_attachment_keeps_original_way_and_representable_fragment(self):
        fragment = Polygon([
            (120.306895324051, 22.67760790809), (120.306896953567, 22.677606846819),
            (120.306898543443, 22.677605733902), (120.30689876140059, 22.677605570007746),
            (120.30689875719045, 22.67760557282332), (120.30689470504701, 22.67760828205988),
        ])
        main = box(120.306, 22.677, 120.3061, 22.6771)
        self.write(
            nodes=[(1, 120.3068987, 22.6776055), (2, 120.3069113, 22.6776251)],
            ways=[(10, [1, 2], {"highway": "footway"})],
        )
        report, result = self.compile([self.source(MultiPolygon([fragment, main]), width=7.31)])
        self.assertEqual(report["counts"]["unserialized_osm_contacts"], 2)
        self.assertEqual(result.ways[10]["nodes"], [1, 2])
        generated = self.generated(result)
        lines = [LineString([result.nodes[node] for node in way["nodes"]]) for way in generated.values()]
        self.assertTrue(any(fragment.covers(line) for line in lines))
        self.assertTrue(any(main.covers(line) for line in lines))
        self.assertTrue(all(set(way["nodes"]).isdisjoint({1, 2}) for way in generated.values()))
        self.assertTrue(all(failure["evidence_class"] == "fixed_osm_cut_has_no_covered_local_grid_point" for failure in report["contact_precision_limitations"]))

    def test_unproven_subgrid_contact_retains_both_normal_sources_without_join(self):
        self.write(nodes=[], ways=[])
        x, y = 121.00100004, 25.00100002355
        report, result = self.compile([
            self.source(box(121, 25, x, y), source_id="left"),
            self.source(box(x - 1e-13, y - 1e-13, 121.002, 25.002), source_id="right"),
        ])
        self.assertEqual(report["counts"]["unproven_source_contacts"], 1)
        self.assertEqual(report["contact_precision_limitations"][0]["evidence_class"], "covered_connector_not_proven")
        self.assertFalse(report["all_observed_contacts_serialized"])
        government = self.generated(result)
        left_node = next(way["nodes"][0] for way in government.values() if way["tags"]["source:ref"] == "left")
        right_node = next(way["nodes"][0] for way in government.values() if way["tags"]["source:ref"] == "right")
        self.assertNotIn(right_node, self.reachable(result, left_node))
        self.assertTrue(all(record["generated_way_ids"] and record["status"] == "compiled" for record in report["sources"].values()))

    def test_thin_representable_triangle_keeps_positive_serialized_segment(self):
        self.write(nodes=[], ways=[])
        geometry = Polygon([
            (121.61825699399233, 25.041304319321846),
            (121.6182633, 25.0413115),
            (121.61825699475546, 25.041304318759654),
        ])
        report, result = self.compile([self.source(geometry)])
        self.assertEqual(report["counts"]["sources_with_generated_ways"], 1)
        self.assertEqual(report["precision_limitations"], [])
        for way in self.generated(result).values():
            line = LineString([result.nodes[node] for node in way["nodes"]])
            self.assertGreater(line.length, 0)
            self.assertTrue(geometry.covers(line))

    def test_whole_source_without_two_covered_grid_points_is_accounted_separately(self):
        self.write(nodes=[], ways=[])
        geometry = Polygon([
            (121.47233958442511, 25.014467267019043),
            (121.4723395844251, 25.014467267019054),
            (121.4724529, 25.0143967),
        ])
        report, result = self.compile([self.source(geometry)])
        self.assertEqual(self.generated(result), {})
        self.assertEqual(report["counts"]["selected_sources"], 1)
        self.assertEqual(report["counts"]["sources_with_generated_ways"], 0)
        self.assertEqual(report["counts"]["sources_without_representable_effective_geometry"], 1)
        record = report["sources"]["government-1"]
        self.assertEqual(record["status"], "no_representable_effective_geometry")
        limitation = report["precision_limitations"][0]
        self.assertEqual(limitation["source_geometry_wkb"], geometry.wkb_hex)
        self.assertEqual(limitation["geometry_origin"], "original_source")
        self.assertEqual(limitation["candidate_lattice_points"], 800604)
        self.assertEqual(limitation["covered_lattice_points"], 1)
        self.assertEqual(limitation["lattice_enumeration"], "complete_polygon_grid_scanlines")

    def test_single_point_leaf_contact_is_retained_without_fabricating_a_street(self):
        self.write(nodes=[], ways=[])
        tiny = Polygon([(121.001, 25.00000002), (121.001, 24.99999998), (121.00100004, 25)])
        report, result = self.compile([
            self.source(box(121, 24.999, 121.001, 25.001), source_id="main"),
            self.source(tiny, source_id="leaf"),
        ])
        self.assertEqual(report["counts"]["selected_sources"], 2)
        self.assertEqual(report["counts"]["sources_with_generated_ways"], 1)
        self.assertEqual(report["sources"]["leaf"]["status"], "no_representable_effective_geometry")
        limitation = report["precision_limitations"][0]
        self.assertEqual(limitation["authorized_ports"], 1)
        self.assertEqual(limitation["covered_lattice_points"], 1)
        self.assertEqual(limitation["retained_leaf_port"][0]["coordinate"], (121.001, 25))
        self.assertTrue(self.generated(result))
        self.assertTrue(all(way["tags"]["source:ref"] == "main" for way in self.generated(result).values()))

    def test_crossing_an_existing_pedestrian_way_splits_it_at_actual_contacts(self):
        self.write(ways=[(10, [1, 4], {"highway": "footway"})])
        report, result = self.compile()
        originals = [way for way in result.ways.values() if "source:batch" not in way["tags"]]
        self.assertEqual(len(originals), 3)
        government_refs = {node for way in self.generated(result).values() for node in way["nodes"]}
        self.assertEqual(len(report["sources"]["government-1"]["ports"]), 2)
        self.assertTrue(all(port["node_id"] in government_refs for port in report["sources"]["government-1"]["ports"]))
        self.assertTrue(all(port["node_id"] > 4 for port in report["sources"]["government-1"]["ports"]))
        self.assertEqual([result.nodes[originals[0]["nodes"][0]], result.nodes[originals[-1]["nodes"][-1]]], [(121, 25), (121.004, 25)])

    def test_different_or_unknown_grade_never_gets_an_osm_port(self):
        self.write()
        for index, raw in enumerate(({}, {**PLANE, "layer": "1", "bridge": "yes"})):
            self.output = self.root / f"merged-{index}.osm.pbf"
            self.report = self.root / f"report-{index}.json"
            report, result = self.compile([self.source(raw=raw)])
            refs = {node for way in self.generated(result).values() for node in way["nodes"]}
            self.assertTrue(refs.isdisjoint({1, 2, 3, 4}))
            self.assertEqual(report["counts"]["sources_with_osm_ports"], 0)

    def test_adjacent_known_sources_share_a_port_unknown_sources_remain_separate(self):
        self.write(nodes=[], ways=[])
        left = box(121, 25, 121.001, 25.00002)
        right = box(121.001, 25, 121.002, 25.00002)
        for index, raw in enumerate((PLANE, {})):
            self.output = self.root / f"merged-{index}.osm.pbf"
            self.report = self.root / f"report-{index}.json"
            _, result = self.compile([self.source(left, raw=raw, source_id="left"), self.source(right, raw=raw, source_id="right")])
            refs = {source: {node for way in self.generated(result).values() if way["tags"]["source:ref"] == source for node in way["nodes"]} for source in ("left", "right")}
            self.assertEqual(bool(refs["left"] & refs["right"]), index == 0)

    def test_point_contact_and_a_true_gap_never_create_a_shared_source_port(self):
        self.write(nodes=[], ways=[])
        left = self.source(box(121, 25, 121.001, 25.001), source_id="left")
        for index, right_geometry in enumerate((box(121.001, 25.001, 121.002, 25.002), box(121.00100001, 25, 121.002, 25.001))):
            self.output = self.root / f"point-gap-{index}.osm.pbf"
            self.report = self.root / f"point-gap-{index}.json"
            report, result = self.compile([left, self.source(right_geometry, source_id="right")])
            refs = {source: {node for way in self.generated(result).values() if way["tags"]["source:ref"] == source for node in way["nodes"]} for source in ("left", "right")}
            self.assertFalse(refs["left"] & refs["right"])
            self.assertEqual(report["precision_connectors"], [])
            if index == 0:
                self.assertEqual(len(report["sources"]["left"]["unproven_zero_width_contacts"]), 1)

    def test_hole_and_building_are_excluded_from_generated_geometry(self):
        geometry = Polygon([(121, 25), (121.004, 25), (121.004, 25.004), (121, 25.004)], holes=[[(121.001, 25.001), (121.002, 25.001), (121.002, 25.002), (121.001, 25.002)]])
        building = box(121.003, 25.003, 121.0035, 25.0035)
        coordinates = list(building.exterior.coords)[:-1]
        self.write(nodes=[(i + 1, *point) for i, point in enumerate(coordinates)], ways=[(10, [1, 2, 3, 4, 1], {"building": "yes"})])
        report, result = self.compile([self.source(geometry)])
        allowed = geometry.difference(building).buffer(1e-7)
        for way in self.generated(result).values():
            self.assertTrue(allowed.covers(LineString([result.nodes[node] for node in way["nodes"]])))
        self.assertTrue(report["sources"]["government-1"]["negative_geometry"])

    def test_road_mask_only_covers_associated_interval_and_preserves_relations(self):
        self.write(
            nodes=[(1, 121, 25), (2, 121.004, 25), (3, 121.005, 25), (4, 121.004, 25.001)],
            ways=[(10, [1, 2], {"highway": "residential", "name": "same-road"}), (20, [2, 3], {"highway": "residential"}), (30, [2, 4], {"highway": "footway"})],
            relations=[(100, [("w", 10, ""), ("w", 20, "")], {"type": "route"}), (200, [("w", 10, "from"), ("n", 2, "via"), ("w", 20, "to")], {"type": "restriction", "restriction": "no_right_turn"})],
        )
        surface = self.source(box(121.001, 25.0001, 121.003, 25.00012), raw={**PLANE, "NAME": "same-road"})
        report, result = self.compile([surface])
        road = [way for way in result.ways.values() if way["tags"].get("name") == "same-road" and way["tags"].get("highway") == "residential"]
        self.assertEqual(len(road), 3)
        self.assertEqual(sum(way["tags"].get("foot") == "no" for way in road), 1)
        self.assertEqual(len(result.relations[100]), 4)
        from_way = result.relations[200][0][1]
        self.assertIn(2, result.ways[from_way]["nodes"])
        self.assertEqual(result.ways[30]["nodes"], [2, 4])
        self.assertEqual(len(report["masked_ordinary_roads"]), 1)

    def test_access_denied_source_is_retained_in_report_and_not_emitted(self):
        self.write()
        report, result = self.compile([self.source(raw={**PLANE, "foot": "no"})])
        self.assertEqual(self.generated(result), {})
        self.assertEqual(report["sources"]["government-1"]["status"], "access_denied")

    def test_water_blocks_ground_surface_but_does_not_erase_a_confirmed_bridge(self):
        water = box(121.0018, 24.999, 121.0022, 25.001)
        coordinates = list(water.exterior.coords)[:-1]
        self.write(
            nodes=[(i + 1, *point) for i, point in enumerate(coordinates)],
            ways=[(10, [1, 2, 3, 4, 1], {"natural": "water"})],
        )
        for index, raw in enumerate((PLANE, {**PLANE, "layer": "1", "bridge": "yes"})):
            self.output = self.root / f"water-{index}.osm.pbf"
            self.report = self.root / f"water-{index}.json"
            report, result = self.compile([self.source(raw=raw)])
            crossing = [way for way in self.generated(result).values() if LineString([result.nodes[node] for node in way["nodes"]]).intersection(water).length > 0]
            self.assertEqual(bool(crossing), index == 1)
            self.assertEqual(report["counts"]["regions"], 2 if index == 0 else 1)

    def test_existing_pedestrian_way_cannot_bypass_a_government_closure(self):
        self.write(ways=[(10, [1, 4], {"highway": "footway"})])
        closed = self.source(box(121.0018, 24.999, 121.0022, 25.001), raw={**PLANE, "foot": "no"}, source_id="closed")
        report, result = self.compile([self.source(), closed])
        original_pieces = [way for way in result.ways.values() if "source:batch" not in way["tags"]]
        self.assertTrue(any(way["tags"].get("foot") == "no" for way in original_pieces))
        for way in result.ways.values():
            if way["tags"].get("foot") != "no":
                self.assertEqual(LineString([result.nodes[node] for node in way["nodes"]]).intersection(closed.geometry).length, 0)
        self.assertTrue(report["serialized_geometry_verified"])

    def test_non_grid_contact_uses_an_attributed_connector_covered_by_both_sources_union(self):
        self.write(nodes=[], ways=[])
        common = 121.00100004
        left = self.source(box(121, 25, common, 25.00002), source_id="left")
        right = self.source(box(common, 25, 121.002, 25.00002), source_id="right")
        report, result = self.compile([left, right])
        connectors = [way for way in self.generated(result).values() if way["tags"].get("source:geometry") == "shared_surface_precision_connector"]
        self.assertEqual(len(connectors), 1)
        allowed = left.geometry.union(right.geometry)
        for way in self.generated(result).values():
            geometry = LineString([result.nodes[node] for node in way["nodes"]])
            source = left if way["tags"]["source:ref"] == "left" else right
            self.assertTrue((allowed if way in connectors else source.geometry).covers(geometry))
        self.assertEqual(connectors[0]["tags"]["source:refs"], "left;right")
        self.assertTrue(report["serialized_geometry_verified"])

    def exact_connector_fixture(self):
        return json.loads((Path(__file__).resolve().parents[2] / "tests/fixtures/otp-sidewalk-connector-exact.json").read_text())

    def prepare_exact_connector_fixture(self):
        fixture = self.exact_connector_fixture()
        self.write(nodes=fixture["input_nodes"], ways=[(fixture["input_way_id"], fixture["input_way_nodes"], fixture["input_way_tags"])])
        surfaces = [self.source(from_wkb(bytes.fromhex(wkb)), source_id=ref, width=width)
                    for ref, wkb, width in zip(fixture["source_refs"], fixture["member_surface_wkb_hex"], (1.71, 2.29), strict=True)]
        return fixture, surfaces

    def test_precision_contact_uses_exact_bend_without_moving_endpoints_or_sources(self):
        fixture, surfaces = self.prepare_exact_connector_fixture()
        original_bytes = self.pbf.read_bytes()
        original_surfaces = [surface.geometry.wkb for surface in surfaces]
        allowed = from_wkb(bytes.fromhex(fixture["surface_wkb_hex"]))
        direct = LineString(fixture["original_coordinates"])
        # The version-pinned GEOS predicate rounds this tiny exterior interval away.
        self.assertFalse(API.exact_connector_coverage(allowed, direct))
        self.assertFalse(API.exact_connector_coverage(allowed, direct.reverse()))
        report, result = self.compile(surfaces)
        self.assertEqual(self.pbf.read_bytes(), original_bytes)
        self.assertEqual([surface.geometry.wkb for surface in surfaces], original_surfaces)
        self.assertEqual(report["counts"]["sources_with_generated_ways"], 2)
        self.assertEqual(report["counts"]["sources_fully_blocked"], 0)
        self.assertEqual(report["counts"]["sources_partially_limited"], 0)
        self.assertEqual(report["counts"]["unserialized_osm_contacts"], 0)
        paths = [entry["coordinates"] for entry in report["precision_connectors"]]
        expected = tuple(map(tuple, fixture["fixed_coordinates"]))
        self.assertIn(expected, paths)
        self.assertEqual(expected[0], tuple(fixture["original_coordinates"][0]))
        self.assertEqual(expected[-1], tuple(fixture["original_coordinates"][-1]))
        observed = []
        for way in self.generated(result).values():
            if way["tags"].get("source:geometry") != "shared_surface_precision_connector":
                continue
            coordinates = tuple(result.nodes[node] for node in way["nodes"])
            _, payload = API.decode_endpoint_proof_tags(way["tags"])
            self.assertEqual(payload["source_refs"], fixture["source_refs"])
            self.assertEqual(payload["surface_wkb_hex"], fixture["surface_wkb_hex"])
            self.assertTrue(API.exact_connector_coverage(allowed, LineString(coordinates)))
            self.assertTrue(API.exact_connector_coverage(allowed, LineString(coordinates).reverse()))
            observed.append(coordinates)
        self.assertIn(expected, observed)
        self.assertTrue(report["serialized_geometry_verified"])

    def test_serialized_connector_rejects_an_upstream_rounded_coverage_regression(self):
        fixture, surfaces = self.prepare_exact_connector_fixture()
        direct = tuple(map(tuple, fixture["original_coordinates"]))
        original = API.covered_contact_paths

        def inject_unsafe_path(allowed, choices, allow_bends=False):
            if allowed.wkb.hex() == fixture["surface_wkb_hex"] and direct[0] in choices[0] and direct[1] in choices[1]:
                return [(direct[0], direct[0]), direct]
            return original(allowed, choices, allow_bends)

        with patch.object(API, "covered_contact_paths", side_effect=inject_unsafe_path):
            with self.assertRaisesRegex(ValueError, "Serialized PBF leaves source surface"):
                self.compile(surfaces)
        self.assertFalse(self.output.exists())
        self.assertFalse(self.report.exists())

    def test_exact_connector_boundaries_holes_and_disconnected_parts(self):
        square = box(0, 0, 4, 4)
        hole = Polygon(square.exterior.coords, [box(1, 1, 3, 3).exterior.coords])
        separate = MultiPolygon([box(0, 0, 1, 1), box(2, 0, 3, 1)])
        cases = [
            (square, [(0, 0), (4, 0)], True),
            (square, [(0, 0), (4, 4)], True),
            (square, [(2, 2), (2, 2)], True),
            (square, [(-1, -1), (-1, -1)], False),
            (square, [(0, 0), (4, 4.000000000000001)], False),
            (hole, [(0, 2), (4, 2)], False),
            (hole, [(1, 1), (3, 1)], True),
            (hole, [(0, 2), (0, 0), (4, 0), (4, 2)], True),
            (separate, [(0.5, 0.5), (2.5, 0.5)], False),
            (separate, [(2.1, 0.5), (2.9, 0.5)], True),
        ]
        for geometry, coordinates, expected in cases:
            with self.subTest(coordinates=coordinates):
                line = LineString(coordinates)
                self.assertEqual(API.exact_connector_coverage(geometry, line), expected)
                self.assertEqual(API.exact_connector_coverage(geometry, line.reverse()), expected)
        self.assertIsNone(API.covered_contact_paths(separate, [[(0.5, 0.5)], [(2.5, 0.5)]], allow_bends=True))

    def test_both_closure_boundaries_are_quantized_jointly_without_closing_the_gap(self):
        self.write(ways=[(10, [1, 4], {"highway": "footway", "bicycle": "yes"})])
        closures = [self.source(
            box(x + 0.00000006, 24.999, x + 0.00000016, 25.001),
            raw={**PLANE, "foot": "no"}, source_id=f"closed-{index}",
        ) for index, x in enumerate((121.001, 121.002))]
        report, result = self.compile([self.source(), *closures])
        allowed = []
        for way in result.ways.values():
            if "source:batch" in way["tags"]:
                continue
            self.assertEqual(way["tags"]["bicycle"], "yes")
            if way["tags"].get("foot") != "no":
                line = LineString([result.nodes[node] for node in way["nodes"]])
                self.assertTrue(all(line.intersection(closed.geometry).length == 0 for closed in closures))
                allowed.append(line)
        self.assertTrue(any(line.bounds[0] > 121.001 and line.bounds[2] <= 121.00200006 and line.length > 0.0009 for line in allowed))
        self.assertTrue(report["serialized_geometry_verified"])

    def test_non_grid_surface_edges_are_quantized_inward_and_checked_after_pbf_write(self):
        self.write(nodes=[], ways=[])
        surface = self.source(box(121.00000004, 25.00000004, 121.00300004, 25.00002004))
        report, result = self.compile([surface])
        for way in self.generated(result).values():
            self.assertTrue(surface.geometry.covers(LineString([result.nodes[node] for node in way["nodes"]])))
        self.assertTrue(report["serialized_geometry_verified"])

    def test_width_regions_use_local_minimum(self):
        self.write(nodes=[], ways=[])
        wide = self.source(box(121, 25, 121.003, 25.00002), source_id="wide", width=2)
        narrow = self.source(box(121.001, 25, 121.002, 25.00002), source_id="narrow", width=0.4)
        _, result = self.compile([wide, narrow])
        values = {way["tags"]["width"] for way in self.generated(result).values() if way["tags"]["source:ref"] == "wide"}
        self.assertEqual(values, {"2.0", "0.4"})

    def test_width_observations_require_positive_length_and_unknown_extent_stays_unknown(self):
        base = self.source(box(121, 25, 121.003, 25.001), width=2)
        narrow = self.source(box(121.001, 25, 121.002, 25.001), source_id="narrow", width=0.4)
        region = API.Region(base, base.geometry, tuple(PLANE.values()), base)
        region.width_observations = ((narrow.geometry, narrow),)
        snapshot = API.NETWORK.SourceSnapshot("7", "a" * 64, (base, narrow), "202606")
        crossing = API.derived_tags(region, snapshot, [(121.0005, 25.0005), (121.0025, 25.0005)])
        self.assertEqual(crossing["width"], "0.4")
        self.assertEqual(crossing["source:width:ref"], "narrow")
        point_only = API.derived_tags(region, snapshot, [(121, 25.0005), (121.001, 25.0005)])
        self.assertEqual(point_only["width"], "2.0")
        self.assertNotIn("narrow", point_only["source:width:refs"])
        unknown = self.source(base.geometry, width=None)
        region.width_source = unknown
        incomplete = API.derived_tags(region, snapshot, [(121.0005, 25.0005), (121.0025, 25.0005)])
        self.assertNotIn("width", incomplete)
        self.assertEqual(incomplete["source:width"], "unknown")

    def test_large_original_ids_and_long_paths_are_valid_sorted_and_referenced(self):
        self.write(nodes=[(9999999999, 120, 24)], ways=[(99999999, [9999999999, 9999999999], {"highway": "footway"})])
        original = API.TOPOLOGY.build_polygon_topology

        def long_path(polygon, ports, **kwargs):
            result = original(polygon, ports, **kwargs)
            edge = result.edges[0]
            line = LineString(edge.coordinates)
            points = tuple(tuple(line.interpolate(i / 2100, normalized=True).coords[0]) for i in range(2101))
            return API.TOPOLOGY.SparseTopology(result.nodes, (API.TOPOLOGY.SparsePath(edge.start, edge.end, points),))

        with patch.object(API.TOPOLOGY, "build_polygon_topology", side_effect=long_path):
            _, result = self.compile()
        generated = self.generated(result)
        self.assertEqual(len(generated), 2)
        self.assertTrue(all(ident > 99999999 for ident in generated))
        self.assertTrue(all(len(way["nodes"]) <= 2000 for way in generated.values()))
        self.assertTrue(all(node in result.nodes for way in result.ways.values() for node in way["nodes"]))
        inventory = API.InputInventory()
        inventory.apply_file(str(self.output))

    def test_programming_or_io_failure_is_fatal_and_leaves_no_artifacts(self):
        self.write()
        with patch.object(API.TOPOLOGY, "build_polygon_topology", side_effect=RuntimeError("compiler defect")):
            with self.assertRaisesRegex(RuntimeError, "compiler defect"):
                self.compile()
        self.assertFalse(self.output.exists())
        self.assertFalse(self.report.exists())
        self.assertTrue(self.pbf.exists())

    def test_refuses_overwrite_and_in_place_output(self):
        self.write()
        self.output.write_bytes(b"existing")
        with self.assertRaises(FileExistsError):
            self.compile()
        self.assertEqual(self.output.read_bytes(), b"existing")
        self.output = self.pbf
        with self.assertRaises(ValueError):
            self.compile()


if __name__ == "__main__":
    unittest.main()
