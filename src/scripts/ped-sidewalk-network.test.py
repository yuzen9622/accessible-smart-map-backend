import copy
import importlib.util
import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stderr
from pathlib import Path

from shapely.geometry import LineString, Polygon, box

SPEC = importlib.util.spec_from_file_location(
    "network_builder", Path(__file__).with_name("build-ped-graph.py")
)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("Cannot load graph builder")
BUILDER = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = BUILDER
SPEC.loader.exec_module(BUILDER)


class SurfaceNetworkTests(unittest.TestCase):
    def setUp(self):
        self.network = BUILDER.load_local_module(
            "sidewalk_network_test", "ped-sidewalk-network.py"
        )

    def test_width_regions_preserve_union_and_local_minimum_without_unknown_plane_guess(
        self,
    ):
        from dataclasses import replace

        from shapely.ops import unary_union
        from shapely.strtree import STRtree

        level = ("0", "0", "no", "no")
        wide = replace(self.surface(box(0, 0, 10, 2), source_id="wide"), width_m=2)
        narrow = replace(self.surface(box(4, 0, 6, 2), source_id="narrow"), width_m=0.4)
        middle = replace(self.surface(box(2, 0, 8, 2), source_id="middle"), width_m=1)
        sources = (wide, middle, narrow)
        tree = STRtree([s.geometry for s in sources])
        planes = {s.source_id: (level, {}) for s in sources}
        regions = list(
            self.network.width_regions(
                BUILDER, wide, wide.geometry, level, sources, tree, planes
            )
        )
        self.assertEqual(
            [s.source_id if s else None for _, s in regions], ["narrow", "middle", None]
        )
        self.assertTrue(unary_union([g for g, _ in regions]).equals(wide.geometry))
        self.assertEqual([g.area for g, _ in regions], [4, 8, 8])
        self.assertEqual(sum(g.area for g, _ in regions), wide.geometry.area)
        for other_plane in ((None, None, None, None), ("1", "1", "yes", "no")):
            different = {s.source_id: (other_plane, {}) for s in sources}
            self.assertEqual(
                list(
                    self.network.width_regions(
                        BUILDER, wide, wide.geometry, level, sources, tree, different
                    )
                ),
                [(wide.geometry, None)],
            )
        self.assertEqual(wide.width_m, 2)
        self.assertEqual(narrow.width_m, 0.4)

    def test_shared_levels_match_set_oracle_for_mixed_opaque_explicit_planes(self):
        ids = (1, 2, 3, 9454749084)
        ways = [
            BUILDER.WalkWay(
                index,
                {"highway": "footway", **tags},
                tuple(BUILDER.WayNode(i, 121.5, 25.0) for i in ids),
            )
            for index, tags in enumerate(
                (
                    {},
                    {"layer": "1", "bridge": "yes"},
                    {"level": "opaque"},
                    {"layer": "-2", "tunnel": "yes"},
                    {"layer": "0.0"},
                )
            )
        ]
        ways.append(BUILDER.WalkWay(100, {"highway": "motorway"}, ways[0].nodes))
        ways.append(
            BUILDER.WalkWay(
                101, {"highway": "footway"}, (BUILDER.WayNode(99, 121.5, 25.0),)
            )
        )
        node_tags = {
            1: {"level": "9"},
            2: {"bridge": "no"},
            3: {"layer": "not numeric"},
            99: {"layer": "5"},
        }
        original = {}
        for way in ways:
            if BUILDER.should_include_way(way.tags):
                for node in way.nodes:
                    original.setdefault(node.osm_id, set()).add(
                        self.network.grade(way.tags)
                    )
        expected = {
            i: self.network.grade(node_tags[i])
            if any(
                k in node_tags.get(i, {})
                for k in ("layer", "level", "bridge", "tunnel")
            )
            else min(planes)
            for i, planes in original.items()
            if len(planes) > 1
        }
        for ordered in (ways, list(reversed(ways))):
            self.assertEqual(
                self.network.shared_node_levels(BUILDER, ordered, node_tags), expected
            )
        self.assertNotIn(99, expected)

    def test_complete_shared_witness_is_not_mutated_by_build_or_replay(self):
        import osmium

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "empty.osm.pbf"
            osmium.SimpleWriter(str(path)).close()
            raw = {
                "layer": "0",
                "level": "0",
                "bridge": "no",
                "tunnel": "no",
                "nested_evidence": {"unknown": None, "flags": [0, False, "保留"]},
            }
            source = self.surface(box(121.55, 25.05, 121.551, 25.0501), raw)
            before = copy.deepcopy(source)
            graph = self.network.build_network(
                BUILDER,
                path,
                BUILDER.BBOXES["taiwan"],
                self.network.SourceSnapshot("7", "a" * 64, (source,)),
                stage_edges=True,
            )
            try:
                self.assertGreater(len(graph.surface_cells), 1)
                witness = graph.surface_cells[0].witness
                self.assertTrue(all(c.witness is witness for c in graph.surface_cells))
                self.assertEqual(
                    set(witness),
                    {
                        "grade_resolution",
                        "road_correspondence",
                        "negative_geometry",
                        "raw_properties",
                        "quality_flags",
                        "county",
                        "barrier_way_ids",
                        "access",
                        "excluded_access_source_ids",
                        "width_m",
                        "effective_width_m",
                        "mesh",
                    },
                )
                self.assertEqual(witness["raw_properties"], before.raw)
                snapshot = copy.deepcopy(witness)
                list(graph.edges)
                list(graph.edges)
                self.network.component_statistics(graph)
                self.assertEqual(witness, snapshot)
                self.assertEqual(source, before)
                self.assertEqual(
                    json.loads(json.dumps(witness)), json.loads(json.dumps(snapshot))
                )
            finally:
                graph.edges.close()

    def test_staged_progress_is_bounded_and_counts_completed_denied_sources(self):
        import osmium

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "empty.osm.pbf"
            osmium.SimpleWriter(str(path)).close()
            denied = box(121.55, 25.05, 121.551, 25.0501)
            sources = tuple(
                self.surface(denied, {"access": "no"}, str(i)) for i in range(1000)
            )
            sources += (self.surface(box(121.56, 25.05, 121.561, 25.0501)),)
            output = io.StringIO()
            with redirect_stderr(output):
                graph = self.network.build_network(
                    BUILDER,
                    path,
                    BUILDER.BBOXES["taiwan"],
                    self.network.SourceSnapshot("7", "a" * 64, sources),
                    stage_edges=True,
                )
            try:
                stages = [
                    line for line in output.getvalue().splitlines() if "stage=" in line
                ]
                self.assertEqual(
                    [line.split("stage=")[1].split()[0] for line in stages],
                    [
                        "areas",
                        "ways",
                        "node-tags",
                        "shared-levels",
                        "indexes",
                        "surface-mesh-progress",
                        "surface-mesh",
                        "edges-complete",
                    ],
                )
                self.assertIn(
                    "sources_completed=1000 sources_total=1001 cells=0 nodes=0 edges=0",
                    stages[5],
                )
                self.assertIn("sources_completed=1001", stages[6])
                self.assertEqual(len(graph.surface_cells), 2)
            finally:
                graph.edges.close()

    def test_osm_area_default_ground_is_not_missing_government_or_building_grade(self):
        source = BUILDER.WalkWay(201, {}, ())
        for kind in ("road", "denied"):
            with self.subTest(kind=kind):
                observation = self.network.NegativeObservation(
                    source, box(0, 0, 1, 1), kind, "native_footprint", None, True
                )
                self.assertEqual(observation.plane, self.network.grade({}))
        building = self.network.NegativeObservation(
            source, box(0, 0, 1, 1), "building", "native_footprint", None, True
        )
        self.assertEqual(building.plane, (None, None, None, None))
        self.assertEqual(self.network.observed_grade({}), (None, None, None, None))

    def test_native_relation_courtyard_and_indoor_access_reach_network(self):
        import osmium
        from osmium.osm.mutable import Node, Relation, Way

        ground = {"layer": "0", "level": "0", "bridge": "no", "tunnel": "no"}
        for old_style, hole, denied in (
            (False, True, False),
            (True, True, False),
            (False, False, False),
            (False, False, True),
        ):
            with (
                self.subTest(old_style=old_style, hole=hole, denied=denied),
                tempfile.TemporaryDirectory() as directory,
            ):
                path = Path(directory) / "courtyard.osm.pbf"
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
                    (121.553, 25.055),
                    (121.557, 25.055),
                ]
                for identifier, point in enumerate(points, 1):
                    writer.add_node(Node(id=identifier, location=point))
                writer.add_way(
                    Way(id=20, nodes=[1, 2, 3, 4, 1], tags={"building": "yes"})
                )
                writer.add_way(Way(id=21, nodes=[5, 6, 7, 8, 5], tags={}))
                writer.add_way(
                    Way(
                        id=22,
                        nodes=[9, 10],
                        tags={"highway": "footway", "indoor": "yes", **ground},
                    )
                )
                tags = {"type": "multipolygon", **ground}
                if not old_style:
                    tags["building"] = "yes"
                if denied:
                    tags["access"] = "no"
                members = [("w", 20, "outer")] + ([("w", 21, "inner")] if hole else [])
                writer.add_relation(Relation(id=20, tags=tags, members=members))
                writer.close()
                source = self.surface(box(121.553, 25.054, 121.557, 25.056), ground)
                outside = self.surface(
                    box(121.57, 25.05, 121.571, 25.051), ground, "outside"
                )
                graph = self.network.build_network(
                    BUILDER,
                    path,
                    BUILDER.BBOXES["taiwan"],
                    self.network.SourceSnapshot("7", "a" * 64, (source, outside)),
                )
                self.assertEqual(
                    any(c.source_id == "member" for c in graph.surface_cells), hole
                )
                self.assertTrue(
                    any(c.source_id == "outside" for c in graph.surface_cells)
                )
                self.assertEqual(
                    any(e.source_ref == "osm:way/22" for e in graph.edges), not denied
                )
                self.assertEqual(
                    graph.policy_statistics["osm_area_policy_version"], "osm-areas-v1"
                )

    def test_hole_mesh_is_covered_and_connected_around_hole(self):
        polygon = Polygon(
            [(0, 0), (100, 0), (100, 20), (0, 20)],
            [[(40, 4), (60, 4), (60, 16), (40, 16)]],
        )
        triangles, links = self.network.surface_mesh(polygon)
        self.assertGreater(len(triangles), 2)
        self.assertTrue(all(polygon.covers(t) for t in triangles))
        self.assertTrue(all(polygon.covers(LineString(link)) for link in links))
        self.assertAlmostEqual(sum(t.area for t in triangles), polygon.area)
        adjacency = {}
        for a, b in links:
            adjacency.setdefault(a, []).append(b)
            adjacency.setdefault(b, []).append(a)
        self.assertTrue(
            BUILDER.is_reachable(
                adjacency,
                triangles[0].centroid.coords[0],
                triangles[-1].centroid.coords[0],
            )
        )

    def test_enclosing_negative_observation_uses_the_area_not_its_outline(self):
        points = [(0, 0), (10, 0), (10, 10), (0, 10)]
        nodes = [BUILDER.WayNode(i + 1, *point) for i, point in enumerate(points)]
        nodes.append(nodes[0])
        way = BUILDER.WalkWay(9, {"building": "yes"}, tuple(nodes))
        observation = self.network.negative_observation(
            BUILDER, way, LineString(points + [points[0]])
        )
        self.assertIsNotNone(observation)
        source = self.surface(box(1, 1, 2, 2))
        exclusions, witnesses = self.network.surface_exclusions(
            source, ("0", "0", "no", "no"), [observation]
        )
        self.assertEqual(len(exclusions), 1)
        self.assertTrue(exclusions[0].covers(source.geometry))
        self.assertEqual(witnesses[0]["qualification"], "footprint")

    def test_known_negative_width_is_part_of_the_spatial_candidate_geometry(self):
        source = self.surface(box(121.5502, 25.05008, 121.5508, 25.05012))
        nodes = (
            BUILDER.WayNode(1, 121.55045, 25.05005),
            BUILDER.WayNode(2, 121.55055, 25.05005),
        )
        line = LineString([(node.lon, node.lat) for node in nodes])
        self.assertFalse(line.intersects(source.geometry))
        for width, count in (("2", 0), ("20", 1)):
            with self.subTest(width=width):
                way = BUILDER.WalkWay(
                    9, {"highway": "footway", "foot": "no", "width": width}, nodes
                )
                observation = self.network.negative_observation(BUILDER, way, line)
                self.assertIsNotNone(observation)
                tree = self.network.STRtree([observation.geometry])
                self.assertEqual(len(tree.query(source.geometry)), count)
                exclusions, _ = self.network.surface_exclusions(
                    source, ("0", "0", "no", "no"), [observation]
                )
                self.assertEqual(len(exclusions), count)

    def test_osm_way_cannot_bypass_explicit_denial_but_can_use_mapped_indoor_path(self):
        import osmium
        from osmium.osm.mutable import Node, Way

        source = self.surface(
            box(121.5502, 25.05008, 121.5508, 25.05012),
            {"layer": "0", "level": "0", "bridge": "no", "tunnel": "no"},
        )
        variants = (
            ({"area": "yes", "access": "no"}, False),
            ({"highway": "service", "area": "yes", "access": "no"}, False),
            ({"highway": "footway", "width": "20", "foot": "no"}, False),
            ({"building": "yes"}, True),
        )
        with tempfile.TemporaryDirectory() as directory:
            for index, (tags, reachable) in enumerate(variants):
                with self.subTest(tags=tags):
                    pbf = Path(directory) / f"denial-{index}.osm.pbf"
                    writer = osmium.SimpleWriter(str(pbf))
                    points = [
                        (1, 121.5503, 25.0501),
                        (2, 121.5507, 25.0501),
                        (201, 121.55045, 25.05005),
                        (202, 121.55055, 25.05005),
                    ]
                    refs = [201, 202]
                    if "width" not in tags:
                        points.extend(
                            [(203, 121.55055, 25.05015), (204, 121.55045, 25.05015)]
                        )
                        refs.extend([203, 204, 201])
                    for identifier, lon, lat in points:
                        writer.add_node(Node(id=identifier, location=(lon, lat)))
                    writer.add_way(Way(id=201, nodes=refs, tags={"layer": "0", **tags}))
                    writer.add_way(
                        Way(
                            id=103,
                            nodes=[1, 2],
                            tags={"highway": "footway", "layer": "0", "indoor": "yes"},
                        )
                    )
                    writer.close()
                    graph = self.network.build_network(
                        BUILDER,
                        pbf,
                        BUILDER.BBOXES["taiwan"],
                        self.network.SourceSnapshot("7", "a" * 64, (source,)),
                    )
                    gov = {
                        node
                        for edge in graph.edges
                        if edge.source_ref.startswith("gov_sidewalk:")
                        for node in (edge.from_osm_node, edge.to_osm_node)
                    }
                    left = {node for node in gov if graph.nodes[node].lon < 121.5504}
                    right = {node for node in gov if graph.nodes[node].lon > 121.5506}
                    self.assertTrue(left and right, "All-rejected is not compliance")
                    self.assertTrue(
                        all(
                            cell.grade == ("0", "0", "no", "no")
                            for cell in graph.surface_cells
                        )
                    )
                    adjacency = {}
                    for edge in graph.edges:
                        adjacency.setdefault(edge.from_osm_node, []).append(
                            edge.to_osm_node
                        )
                    self.assertEqual(
                        any(
                            BUILDER.is_reachable(adjacency, a, b)
                            for a in left
                            for b in right
                        ),
                        reachable,
                    )

    def test_single_triangle_still_generates_a_usable_contained_network(self):
        polygon = Polygon([(121.55, 25.05), (121.551, 25.05), (121.5505, 25.051)])
        triangles, links = self.network.surface_mesh(polygon)
        self.assertEqual(len(triangles), 1)
        self.assertEqual(len(links), 3)
        self.assertTrue(
            all(self.network.cell_covers(polygon, LineString(link)) for link in links)
        )

    def test_segmentation_does_not_duplicate_original_stair_count(self):
        pieces = [
            BUILDER.Segment(
                1,
                {"highway": "steps", "step_count": "13"},
                (
                    BUILDER.WayNode(i, 121.55 + i * 0.0001, 25.05),
                    BUILDER.WayNode(i + 1, 121.55 + (i + 1) * 0.0001, 25.05),
                ),
            )
            for i in range(3)
        ]
        result = self.network.qualify_stair_counts(pieces, [])
        self.assertTrue(all("step_count" not in piece.tags for piece in result))
        self.assertTrue(
            all(piece.tags["original_step_count"] == "13" for piece in result)
        )
        edges = BUILDER.build_directed_edges(result)
        self.assertTrue(all(edge.stair_count is None for edge in edges))
        self.assertTrue(all(edge.edge_type == 6 for edge in edges))

    def test_grade_is_not_xy_and_unknown_is_not_positive_width(self):
        self.assertEqual(self.network.grade({}), self.network.grade({"layer": "0"}))
        self.assertNotEqual(
            self.network.grade({}), self.network.grade({"bridge": "yes", "layer": "1"})
        )
        self.assertNotEqual(
            self.network.grade({"level": "1"}), self.network.grade({"level": "2"})
        )
        self.assertIsNone(self.network.known_width(0))
        self.assertIsNone(self.network.known_width(None))
        self.assertIsNone(self.network.known_width("not measured"))
        self.assertEqual(self.network.known_width(2), 2)

    def test_wall_clips_effective_surface_without_healing_gap(self):
        surface = box(0, 0, 100, 4)
        wall = LineString([(50, -1), (50, 5)])
        effective = self.network.clip_barriers(surface, [wall])
        self.assertEqual(len(list(effective.geoms)), 2)
        self.assertFalse(effective.covers(LineString([(0, 2), (100, 2)])))

    def surface(self, geometry, raw=None, source_id="member"):
        return self.network.SourceSurface(
            source_id, "county", geometry, None, None, raw or {}, [], None, "unknown"
        )

    def test_known_closed_overlap_cannot_be_reintroduced_by_another_source(self):
        import osmium

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "empty.osm.pbf"
            osmium.SimpleWriter(str(path)).close()
            open_surface = self.surface(box(121.55, 25.05, 121.551, 25.0501))
            closed = self.surface(
                box(121.55045, 25.0499, 121.55055, 25.0502),
                {"access": "no"},
                "closed-member",
            )
            snapshot = self.network.SourceSnapshot(
                "9", "b" * 64, (open_surface, closed)
            )
            graph = self.network.build_network(
                BUILDER, path, BUILDER.BBOXES["taiwan"], snapshot
            )
            self.assertGreater(len(graph.edges), 0)
            self.assertTrue(
                all(
                    cell.geometry.intersection(closed.geometry).area == 0
                    for cell in graph.surface_cells
                )
            )
            adjacency = {}
            for edge in graph.edges:
                adjacency.setdefault(edge.from_osm_node, []).append(edge.to_osm_node)
            left = next(key for key, node in graph.nodes.items() if node.lon < 121.5504)
            right = next(
                key for key, node in graph.nodes.items() if node.lon > 121.5506
            )
            self.assertFalse(BUILDER.is_reachable(adjacency, left, right))
            self.assertEqual(
                graph.policy_statistics["source_members_with_known_access_denial"], 1
            )

    def test_named_parallel_geometry_omits_interval_independent_of_side_and_direction(
        self,
    ):
        from shapely.strtree import STRtree

        surface = self.surface(
            box(121.5502, 25.05008, 121.5508, 25.05012),
            {"NAME": "路", "SW_DIRECT": "左側"},
        )
        way = BUILDER.WalkWay(
            1,
            {"highway": "residential", "name": "路"},
            (BUILDER.WayNode(1, 121.55, 25.05), BUILDER.WayNode(2, 121.551, 25.05)),
        )
        tree = STRtree([surface.geometry])
        intervals = self.network.road_forbidden_intervals(way, [surface], tree, [])
        self.assertEqual(len(intervals), 1)
        self.assertAlmostEqual(intervals[0][0], 0.0002)
        self.assertAlmostEqual(intervals[0][1], 0.0008)
        for side in (1, 2, 3, 4, 0, None, "左側", "右側"):
            other = self.surface(surface.geometry, {"NAME": "路", "SW_DIRECT": side})
            reverse = BUILDER.WalkWay(way.osm_id, way.tags, tuple(reversed(way.nodes)))
            for candidate in (way, reverse):
                associated = self.network.road_forbidden_intervals(
                    candidate, [other], tree, []
                )
                self.assertEqual(len(associated), 1)
                self.assertAlmostEqual(associated[0][0], 0.0002)
                self.assertAlmostEqual(associated[0][1], 0.0008)
                self.assertEqual(other.raw["SW_DIRECT"], side)
        unresolved_name = self.surface(surface.geometry, {"NAME": "另一條路"})
        self.assertTrue(
            self.network.road_forbidden_intervals(way, [unresolved_name], tree, [])
        )
        for evidence in ({"NAME": "路", "SW_DIRECT": "左側", "layer": "1"},):
            other = self.surface(surface.geometry, evidence)
            self.assertEqual(
                self.network.road_forbidden_intervals(way, [other], tree, []), []
            )

        for geometry in (
            box(121.55045, 25.0498, 121.55055, 25.0502),
            box(121.5502, 25.051, 121.5508, 25.05104),
            box(121.552, 25.05008, 121.5526, 25.05012),
        ):
            unrelated = self.surface(geometry, {"NAME": "路", "SW_DIRECT": 1})
            intervals = self.network.road_forbidden_intervals(
                way, [unrelated], STRtree([geometry]), []
            )
            self.assertFalse(any(high > low for low, high in intervals))

    def test_independent_osm_sidewalk_and_explicit_tags_do_not_need_gov_match(self):
        from shapely.strtree import STRtree

        way = BUILDER.WalkWay(
            1,
            {"highway": "residential", "name": "路"},
            (BUILDER.WayNode(1, 121.55, 25.05), BUILDER.WayNode(2, 121.551, 25.05)),
        )
        sidewalk = (
            LineString([(121.5502, 25.0501), (121.5508, 25.0501)]),
            {"name": "路", "footway": "sidewalk", "access": "no"},
        )
        intervals = self.network.road_forbidden_intervals(
            way, [], STRtree([]), [sidewalk]
        )
        self.assertEqual(len(intervals), 1)
        tagged = BUILDER.WalkWay(
            2, {"highway": "residential", "sidewalk": "both"}, way.nodes
        )
        self.assertEqual(
            self.network.road_forbidden_intervals(tagged, [], STRtree([]), []),
            [(0, LineString([(n.lon, n.lat) for n in way.nodes]).length)],
        )

    def build_fixture(self, surfaces, points=None, ways=()):
        import osmium
        from osmium.osm.mutable import Node, Way

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "fixture.osm.pbf"
            writer = osmium.SimpleWriter(str(path))
            for node_id, coordinate in (points or {}).items():
                writer.add_node(Node(id=node_id, location=coordinate))
            for way_id, refs, tags in ways:
                writer.add_way(Way(id=way_id, nodes=refs, tags=tags))
            writer.close()
            return self.network.build_network(
                BUILDER,
                path,
                BUILDER.BBOXES["taiwan"],
                self.network.SourceSnapshot("9", "c" * 64, tuple(surfaces)),
            )

    def test_unknown_source_members_do_not_share_a_plane_by_null_equality(self):
        a = self.surface(box(121.55, 25.05, 121.5505, 25.0501), source_id="a")
        b = self.surface(box(121.5505, 25.05, 121.551, 25.0501), source_id="b")
        graph = self.build_fixture([a, b])
        import hashlib

        self.assertEqual(
            graph.policy_statistics["source_width_policy"],
            {
                "version": "compatible-source-minimum-v1",
                "rules_sha256": hashlib.sha256(
                    Path(self.network.__file__).read_bytes()
                ).hexdigest(),
            },
        )
        adjacency = {}
        by_source = {"a": set(), "b": set()}
        for edge in graph.edges:
            adjacency.setdefault(edge.from_osm_node, []).append(edge.to_osm_node)
            by_source[edge.attr_meta["surface_witness"]["source_id"]].add(
                edge.from_osm_node
            )
        self.assertTrue(all(by_source.values()))
        self.assertTrue(
            all(
                cell.witness.get("grade_resolution", {}).get("status") == "unknown"
                for cell in graph.surface_cells
            )
        )
        self.assertFalse(
            any(
                BUILDER.is_reachable(adjacency, a, b)
                for a in by_source["a"]
                for b in by_source["b"]
            )
        )

    def test_named_corridor_inference_has_witness_not_survey_measurement(self):
        surface = self.surface(
            box(121.5502, 25.05008, 121.5508, 25.05012), {"NAME": "路"}
        )
        graph = self.build_fixture(
            [surface],
            {1: (121.55, 25.05), 2: (121.551, 25.05)},
            [(101, [1, 2], {"highway": "residential", "name": "路"})],
        )
        self.assertTrue(graph.surface_cells)
        for cell in graph.surface_cells:
            self.assertEqual(cell.grade, ("0", "0", "no", "no"))
            self.assertEqual(
                cell.witness.get("grade_resolution"),
                {"status": "inferred", "osm_way_ids": ["101"]},
            )
            self.assertNotIn("layer", cell.witness["raw_properties"])

    def test_missing_corridor_names_leave_uncertainty_not_unrestricted_road(self):
        surface = self.surface(box(121.5502, 25.05008, 121.5508, 25.05012))
        graph = self.build_fixture(
            [surface],
            {1: (121.55, 25.05), 2: (121.551, 25.05)},
            [(101, [1, 2], {"highway": "track"})],
        )
        self.assertEqual(
            graph.policy_statistics.get(
                "ordinary_ways_with_unresolved_sidewalk_association"
            ),
            1,
        )
        for cell in graph.surface_cells:
            self.assertEqual(cell.witness["road_correspondence"]["status"], "potential")
            self.assertEqual(
                cell.witness["road_correspondence"]["potential_osm_way_ids"], ["101"]
            )
        length = sum(e.length_m for e in graph.edges if e.source_ref == "osm:way/101")
        self.assertGreater(length, 0)
        self.assertLess(length, 120)

    def test_inferred_elevated_surface_does_not_restrict_ground_road(self):
        surface = self.surface(
            box(121.5502, 25.05008, 121.5508, 25.05012), {"NAME": "路"}
        )
        graph = self.build_fixture(
            [surface],
            {
                1: (121.55, 25.05),
                2: (121.551, 25.05),
                3: (121.55, 25.0501),
                4: (121.551, 25.0501),
            },
            [
                (101, [1, 2], {"highway": "residential", "layer": "0"}),
                (
                    102,
                    [3, 4],
                    {"highway": "footway", "name": "路", "layer": "1", "bridge": "yes"},
                ),
            ],
        )
        self.assertTrue(
            all(cell.grade == ("1", "0", "yes", "no") for cell in graph.surface_cells)
        )
        self.assertGreater(
            sum(e.length_m for e in graph.edges if e.source_ref == "osm:way/101"), 190
        )
        self.assertEqual(
            graph.policy_statistics.get(
                "ordinary_ways_with_unresolved_sidewalk_association"
            ),
            0,
        )

    def test_known_different_grade_carriageway_does_not_cut_surface(self):
        surface = self.surface(
            box(121.55, 25.05, 121.551, 25.0501),
            {"layer": "0", "level": "0", "bridge": "no", "tunnel": "no"},
        )
        graph = self.build_fixture(
            [surface],
            {1: (121.5505, 25.0499), 2: (121.5505, 25.0502)},
            [(101, [1, 2], {"highway": "residential", "layer": "1", "bridge": "yes"})],
        )
        self.assertAlmostEqual(
            sum(cell.geometry.area for cell in graph.surface_cells),
            surface.geometry.area,
        )
        self.assertTrue(
            all(
                not cell.witness.get("negative_geometry", [])
                for cell in graph.surface_cells
            )
        )
        adjacency = {}
        gov = set()
        for edge in graph.edges:
            adjacency.setdefault(edge.from_osm_node, []).append(edge.to_osm_node)
            if edge.source_ref.startswith("gov_sidewalk:"):
                gov.add(edge.from_osm_node)
        left = min(gov, key=lambda n: graph.nodes[n].lon)
        right = max(gov, key=lambda n: graph.nodes[n].lon)
        self.assertTrue(BUILDER.is_reachable(adjacency, left, right))
        road_seed = next(
            n for n, record in graph.nodes.items() if record.source_ref == "osm:node/1"
        )
        self.assertFalse(BUILDER.is_reachable(adjacency, road_seed, left))

    def test_unknown_government_clipping_does_not_erase_allowed_indoor_topology(self):
        surface = self.surface(
            box(121.55, 25.05, 121.551, 25.0501), {"NAME": "passage"}
        )
        points = {
            1: (121.55, 25.05005),
            2: (121.551, 25.05005),
            3: (121.55045, 25.0499),
            4: (121.55055, 25.0499),
            5: (121.55055, 25.0502),
            6: (121.55045, 25.0502),
        }
        graph = self.build_fixture(
            [surface],
            points,
            [
                (
                    101,
                    [1, 2],
                    {
                        "highway": "footway",
                        "indoor": "yes",
                        "name": "passage",
                        "tunnel": "building_passage",
                        "foot": "yes",
                    },
                ),
                (201, [3, 4, 5, 6, 3], {"building": "yes"}),
            ],
        )
        adjacency = {}
        for edge in graph.edges:
            adjacency.setdefault(edge.from_osm_node, []).append(edge.to_osm_node)
        ids = {node.source_ref: key for key, node in graph.nodes.items()}
        ids.update(
            {
                member: key
                for key, node in graph.nodes.items()
                for member in node.attr_meta.get("osm_members", {})
            }
        )
        self.assertTrue(
            BUILDER.is_reachable(adjacency, ids["osm:node/1"], ids["osm:node/2"])
        )
        blocked = box(121.55045, 25.0499, 121.55055, 25.0502)
        self.assertTrue(
            all(
                cell.geometry.intersection(blocked).area < 1e-18
                for cell in graph.surface_cells
            )
        )

    def test_real_pbf_internal_entrance_and_xy_only_ways_remain_distinct(self):
        import osmium
        from osmium.osm.mutable import Node, Way

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "test.osm.pbf"
            writer = osmium.SimpleWriter(str(path))
            points = {
                1: (121.55, 25.05),
                2: (121.5505, 25.05),
                3: (121.551, 25.05),
                4: (121.5505, 25.05),
                5: (121.5505, 25.051),
                6: (121.552, 25.05),
            }
            for node_id, coordinate in points.items():
                writer.add_node(
                    Node(
                        id=node_id,
                        location=coordinate,
                        tags={"entrance": "yes"} if node_id == 2 else {},
                    )
                )
            writer.add_way(Way(id=1, nodes=[1, 2, 3], tags={"highway": "footway"}))
            writer.add_way(Way(id=2, nodes=[4, 5], tags={"highway": "footway"}))
            writer.add_way(
                Way(
                    id=3,
                    nodes=[3, 6],
                    tags={"highway": "footway", "bridge": "yes", "layer": "1"},
                )
            )
            writer.close()
            source = self.network.SourceSnapshot(
                "7", "a" * 64, (self.surface(box(120, 24, 120.001, 24.001)),)
            )
            first = self.network.build_network(
                BUILDER, path, BUILDER.BBOXES["taiwan"], source
            )
            second = self.network.build_network(
                BUILDER, path, BUILDER.BBOXES["taiwan"], source
            )
            self.assertEqual(first, second)
            identities = {node.source_ref: node for node in first.nodes.values()}
            self.assertEqual(identities["osm:node/2"].node_type, 4)
            adjacency = {}
            for edge in first.edges:
                adjacency.setdefault(edge.from_osm_node, []).append(edge.to_osm_node)
            self.assertTrue(
                BUILDER.is_reachable(
                    adjacency,
                    identities["osm:node/1"].osm_node_id,
                    identities["osm:node/3"].osm_node_id,
                )
            )
            self.assertTrue(
                BUILDER.is_reachable(
                    adjacency,
                    identities["osm:node/1"].osm_node_id,
                    identities["osm:node/6"].osm_node_id,
                )
            )
            self.assertFalse(
                BUILDER.is_reachable(
                    adjacency,
                    identities["osm:node/1"].osm_node_id,
                    identities["osm:node/5"].osm_node_id,
                )
            )
            self.assertTrue(
                all(0 < node_id < BUILDER.NODE_ID_SCALE for node_id in first.nodes)
            )


class AreaPlaneRegressionTests(unittest.TestCase):
    def setUp(self):
        self.network = BUILDER.load_local_module(
            "plane_tests", "ped-sidewalk-network.py"
        )

    def test_bounded_numeric_aliases_preserve_exact_distinct_planes(self):
        for value in ("0.0", "+0.00", "-0", "0"):
            self.assertEqual(
                self.network.grade({"level": value}), self.network.grade({})
            )
        self.assertEqual(self.network.scalar_plane("+01.200"), "1.2")
        self.assertNotEqual(
            self.network.grade({"level": "1"}), self.network.grade({"level": "2"})
        )
        self.assertEqual(
            self.network.scalar_plane("123456789012345678901234567890.1"),
            "123456789012345678901234567890.1",
        )
        for value in ("NaN", "Infinity", "1e999999999", "0;1", "Ground", "9" * 10000):
            self.assertIsNone(self.network.observed_grade({"level": value})[1])
            self.assertNotIn(None, self.network.grade({"level": value}))

    def test_ambiguous_linear_negative_is_not_a_different_floor(self):
        way = BUILDER.WalkWay(
            1, {"highway": "footway", "foot": "no", "level": "0;1"}, ()
        )
        observation = self.network.negative_observation(
            BUILDER, way, LineString([(0, 0), (1, 1)])
        )
        self.assertIsNone(observation.plane[1])
        self.assertTrue(
            self.network.compatible_grade(observation.plane, ("0", "0", "no", "no"))
        )


if __name__ == "__main__":
    unittest.main()
