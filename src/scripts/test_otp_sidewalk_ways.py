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

    def test_bare_connectors_only_reach_each_endpoint_projection_not_nearest_junction(self):
        street = road(1, [1, 2, 3], [(0, 0), (80, 0), (100, 0)])
        edits = MODULE.plan_edits(
            [street], [MODULE.Run(1, 30, 70, 6, ["s"])], {2}, 100, 200
        )

        [sidewalk] = [
            nodes for _, nodes, tags in edits.new_ways if tags.get("footway") == "sidewalk"
        ]
        bare_connectors = [
            (nodes, tags)
            for _, nodes, tags in edits.new_ways
            if tags.get("source") == "MOI sidewalk" and "footway" not in tags
        ]
        start_projection, end_projection = 100, 101
        expected = {(sidewalk[0], start_projection), (sidewalk[-1], end_projection)}

        self.assertEqual(
            {tuple(nodes) for nodes, _ in bare_connectors},
            expected,
            "generated bare connectors must terminate at the endpoint projections",
        )
        self.assertNotIn(
            2,
            {node for nodes, _ in bare_connectors for node in nodes},
            "a run endpoint must not receive a direct nearest-junction shortcut",
        )

    def test_explicit_foot_tag_is_kept(self):
        street = road(1, [1, 2], [(0, 0), (100, 0)], foot="yes")
        edits = MODULE.plan_edits([street], [MODULE.Run(1, 0, 100, 6, ["s"])], set(), 100, 100)
        self.assertEqual(edits.road_pieces[1][1]["foot"], "yes")

    def test_same_side_sidewalks_link_across_a_junction(self):
        west = road(1, [1, 5], [(-100, 0), (0, 0)])
        east = road(2, [5, 9], [(0, 0), (100, 0)])
        runs = [MODULE.Run(1, 10, 90, 6, ["w"]), MODULE.Run(2, 10, 90, 6, ["e"])]
        edits = MODULE.plan_edits([west, east], runs, {5}, 100, 100)
        self.assertEqual(junction_links(edits), [])

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
        self.assertEqual(junction_links(edits), [])

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
    def test_raw_regeneration_keeps_full_relation_way_direction_and_access_tags(self):
        with tempfile.TemporaryDirectory() as tmp:
            source=os.path.join(tmp,"relation-in.osm.pbf")
            output=os.path.join(tmp,"relation-out.osm.pbf")
            polygons=os.path.join(tmp,"sidewalks.ndjson")
            tags={"highway":"residential","name":"關聯道路","oneway":"yes","access":"destination"}
            writer=osmium.SimpleWriter(source)
            for nid,p in {1:(0,0),2:(100,0),3:(100,100)}.items():
                writer.add_node(osmium.osm.mutable.Node(id=nid,location=lonlat(*p)))
            writer.add_way(osmium.osm.mutable.Way(id=10,nodes=[1,2],tags=tags))
            writer.add_way(osmium.osm.mutable.Way(id=11,nodes=[2,3],tags={"highway":"service"}))
            members=[("w",10,"from"),("n",2,"via"),("w",11,"to")]
            writer.add_relation(osmium.osm.mutable.Relation(id=900,members=members,tags={"type":"restriction","restriction":"no_right_turn"}))
            route_members=[("w",10,"forward"),("w",11,"backward")]
            writer.add_relation(osmium.osm.mutable.Relation(id=901,members=route_members,tags={"type":"route","route":"bicycle"}))
            writer.close()
            with open(polygons,"w") as handle:
                handle.write(json.dumps({"id":"s1","geometry":strip(20,80,4,8)})+"\n")
            MODULE.main([source,polygons,output])
            ways={};relations={};nodes={}
            class Read(osmium.SimpleHandler):
                def node(self,n):nodes[n.id]=(n.location.lon,n.location.lat)
                def way(self,w):ways[w.id]=([n.ref for n in w.nodes],dict(w.tags))
                def relation(self,r):relations[r.id]=([(m.type,m.ref,m.role) for m in r.members],dict(r.tags))
            Read().apply_file(output)
            self.assertEqual(ways[10][1],tags)
            self.assertEqual(ways[10][0][0],1)
            self.assertEqual(ways[10][0][-1],2)
            self.assertGreater(len(ways[10][0]),2)
            for nid in ways[10][0]:
                self.assertAlmostEqual(nodes[nid][1],LAT0,delta=1e-7)
            self.assertEqual(relations[900],(members,{"type":"restriction","restriction":"no_right_turn"}))
            self.assertEqual(relations[901],(route_members,{"type":"route","route":"bicycle"}))
            self.assertEqual({wid for wid,(_,t) in ways.items() if t.get("highway")in("residential","service")},{10,11})
            self.assertTrue(any(t.get("footway")=="sidewalk" for _,t in ways.values()))

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

            nodes, ways = {}, {}

            class Reader(osmium.SimpleHandler):
                def node(self, node):
                    nodes[node.id] = (node.location.lon, node.location.lat)

                def way(self, way):
                    ways[way.id] = ([n.ref for n in way.nodes], dict(way.tags))

            Reader().apply_file(output)
            for way_nodes, _ in ways.values():
                self.assertTrue(set(way_nodes) <= set(nodes))
            sidewalk = [t for _, t in ways.values() if t.get("footway") == "sidewalk"]
            self.assertEqual(len(sidewalk), 1)
            self.assertEqual(sidewalk[0]["name"], "測試路")
            lined = [t for _, t in ways.values() if t.get("foot") == "use_sidepath"]
            self.assertEqual(len(lined), 1)
            self.assertEqual(ways[11], ([2, 3], {"highway": "service"}))
            bare_connectors = [
                way_nodes
                for way_nodes, tags in ways.values()
                if tags.get("source") == "MOI sidewalk" and "footway" not in tags
            ]
            self.assertEqual(len(bare_connectors), 2)
            endpoint_x = set()
            origin_x, _ = MODULE.to_xy(LON0, LAT0)
            for connector in bare_connectors:
                self.assertEqual(len(connector), 2)
                side, anchor = sorted(
                    connector,
                    key=lambda node_id: MODULE.to_xy(*nodes[node_id])[1],
                    reverse=True,
                )
                side_x, side_y = MODULE.to_xy(*nodes[side])
                anchor_x, anchor_y = MODULE.to_xy(*nodes[anchor])
                self.assertAlmostEqual(side_x, anchor_x, delta=1e-6)
                self.assertGreater(side_y - anchor_y, 4.0)
                self.assertLess(side_y - anchor_y, 8.0)
                endpoint_x.add(round(side_x - origin_x))
            self.assertEqual(endpoint_x, {20, 80})

    def test_native_repair_pbf_preserves_existing_entities_and_adds_only_link(self):
        fixture = ExistingRepairTests().projection_native_fixture()
        with tempfile.TemporaryDirectory() as tmp:
            source = os.path.join(tmp, "repair-in.osm.pbf")
            output = os.path.join(tmp, "repair-out.osm.pbf")
            writer = osmium.SimpleWriter(source)
            xy = {node_id: point for way in fixture.values() for node_id, point in zip(way.node_ids, way.xy)}
            for node_id, point in sorted(xy.items()):
                writer.add_node(osmium.osm.mutable.Node(id=node_id, location=MODULE.to_lonlat(*point)))
            for way in sorted(fixture.values(), key=lambda item: item.way_id):
                writer.add_way(osmium.osm.mutable.Way(id=way.way_id, nodes=way.node_ids, tags=way.tags))
            relation_members = [("w", 1, "from"), ("w", 301, "to")]
            relation_tags = {"type": "route", "route": "foot"}
            writer.add_relation(
                osmium.osm.mutable.Relation(
                    id=900,
                    members=relation_members,
                    tags=relation_tags,
                )
            )
            writer.close()

            def read_entities(path):
                nodes, ways, relations = {}, {}, {}

                class Reader(osmium.SimpleHandler):
                    def node(self, node):
                        nodes[node.id] = (
                            node.location.lon,
                            node.location.lat,
                            dict(node.tags),
                        )

                    def way(self, way):
                        ways[way.id] = ([node.ref for node in way.nodes], dict(way.tags))

                    def relation(self, relation):
                        relations[relation.id] = (
                            [(member.type, member.ref, member.role) for member in relation.members],
                            dict(relation.tags),
                        )

                Reader().apply_file(path)
                return nodes, ways, relations

            before = read_entities(source)
            collected = MODULE.collect_existing(osmium, source)
            edits, proof = MODULE.plan_native_repairs(
                collected.ways,
                collected.node_tags,
                collected.relation_ways,
                collected.max_way + 1,
                [("s1", strip(-25, 1, 5, 9))],
            )
            self.assertEqual(edits.road_pieces, {})
            self.assertEqual([nodes for _, nodes, _ in edits.new_ways], [[101, 20]])
            self.assertEqual(proof[0]["connectorId"], 201)
            MODULE.write_pbf(osmium, source, output, edits)
            after = read_entities(output)

            self.assertEqual(after[0], before[0])
            self.assertEqual(after[2], before[2])
            for way_id, entity in before[1].items():
                self.assertEqual(after[1][way_id], entity)
            added = {way_id: entity for way_id, entity in after[1].items() if way_id not in before[1]}
            self.assertEqual(len(added), 1)
            self.assertEqual(next(iter(added.values()))[0], [101, 20])
            self.assertEqual(next(iter(added.values()))[1]["a11y:native_connection"], "yes")


class ExistingRepairTests(unittest.TestCase):
    def fixture(self):
        motor = road(1, [1, 2, 3], [(-40, 0), (0, 0), (40, 0)], foot="use_sidepath")
        main = road(200, [100, 101], [(-20, 8), (0, 7)], highway="footway", footway="sidewalk", source="MOI sidewalk", **{"ref:moi_sidewalk": "s1"})
        connector = road(201, [101, 2], [(0, 7), (0, 0)], highway="footway", source="MOI sidewalk")
        crossing = road(300, [10, 2, 11], [(0, 8), (0, 0), (0, -8)], highway="footway", footway="crossing")
        return {w.way_id: w for w in (motor, main, connector, crossing)}

    def projection_native_fixture(self, split_motor=False):
        motors = (
            [
                road(
                    1,
                    [1, 2, 3, 4, 5],
                    [(-40, 0), (-5, 0), (0, 0), (5, 0), (40, 0)],
                    foot="use_sidepath",
                )
            ]
            if not split_motor
            else [
                road(1, [1, 2, 3], [(-40, 0), (-5, 0), (0, 0)], foot="use_sidepath"),
                road(2, [3, 4, 5], [(0, 0), (5, 0), (40, 0)], foot="use_sidepath"),
            ]
        )
        main = road(
            200,
            [100, 101],
            [(-20, 7), (-5, 7)],
            highway="footway",
            footway="sidewalk",
            source="MOI sidewalk",
            **{"ref:moi_sidewalk": "s1"},
        )
        projection = road(
            201,
            [101, 2],
            [(-5, 7), (-5, 0)],
            highway="footway",
            source="MOI sidewalk",
        )
        native_sidewalk = road(
            300,
            [20, 10],
            [(-5, 8), (0, 8)],
            highway="footway",
            footway="sidewalk",
        )
        native_crossing = road(
            301,
            [10, 3, 11],
            [(0, 8), (0, 0), (0, -8)],
            highway="footway",
            footway="crossing",
        )
        return {w.way_id: w for w in (*motors, main, projection, native_sidewalk, native_crossing)}

    def test_native_link_follows_owner_spine_when_crossing_is_not_projection_anchor(self):
        ways = self.projection_native_fixture()
        edits, _ = MODULE.plan_native_repairs(
            ways,
            {},
            set(),
            400,
            [("s1", strip(-25, 1, 5, 9))],
        )
        self.assertEqual(edits.road_pieces, {})
        self.assertEqual(
            [nodes for _, nodes, tags in edits.new_ways if tags.get("footway") == "sidewalk"],
            [[101, 20]],
        )
        self.assertEqual(edits.new_ways[0][2]["a11y:native_connection"], "yes")

    def test_native_link_follows_split_collinear_owner_spine(self):
        ways = self.projection_native_fixture(split_motor=True)
        edits, _ = MODULE.plan_native_repairs(
            ways,
            {},
            set(),
            400,
            [("s1", strip(-25, 1, 5, 9))],
        )
        self.assertEqual(edits.road_pieces, {})
        self.assertEqual(
            [nodes for _, nodes, tags in edits.new_ways if tags.get("footway") == "sidewalk"],
            [[101, 20]],
        )
        self.assertEqual(edits.new_ways[0][2]["a11y:native_connection"], "yes")

    def test_native_binding_is_unchanged_when_entity_ids_are_renumbered(self):
        ways = self.projection_native_fixture()
        node_ids = sorted({node_id for way in ways.values() for node_id in way.node_ids})
        node_map = {old: old + 1000 for old in node_ids}
        way_map = {old: old + 10000 for old in ways}
        renumbered = {
            way_map[way_id]: MODULE.make_road(
                way_map[way_id],
                [node_map[node_id] for node_id in way.node_ids],
                [MODULE.to_lonlat(*point) for point in way.xy],
                way.tags,
            )
            for way_id, way in ways.items()
        }
        coverage = [("s1", strip(-25, 1, 5, 9))]
        original_edits, original_proof = MODULE.plan_native_repairs(
            ways, {}, set(), 400, coverage
        )
        renumbered_edits, renumbered_proof = MODULE.plan_native_repairs(
            renumbered, {}, set(), 1400, coverage
        )

        def link_geometry(items, edits):
            xy = {node_id: point for way in items.values() for node_id, point in zip(way.node_ids, way.xy)}
            return [tuple(xy[node_id] for node_id in nodes) for _, nodes, _ in edits.new_ways]

        self.assertEqual(link_geometry(ways, original_edits), link_geometry(renumbered, renumbered_edits))
        self.assertEqual(original_proof[0]["inferred"], renumbered_proof[0]["inferred"])
        self.assertEqual(original_proof[0]["gapM"], renumbered_proof[0]["gapM"])

    def plan(self, ways=None, node_tags=None, relations=None, coverage=None, source_alignment=0.0):
        polygons = [("s1", strip(-30, 30, 5, 10))] if coverage is None else coverage
        return MODULE.plan_native_repairs(
            ways or self.fixture(),
            node_tags or {},
            relations or set(),
            400,
            polygons,
            source_alignment,
        )

    def assert_no_native_edits(self, result, message=None):
        edits, _ = result
        self.assertEqual(edits.road_pieces, {}, message)
        self.assertEqual(edits.new_ways, [], message)

    def test_existing_crossing_reconnects_to_same_side_and_preserves_anchor_access(self):
        edits, proof = self.plan()
        self.assertEqual(edits.road_pieces, {})
        self.assertEqual(edits.new_ways[0][1], [101, 10])
        self.assertNotIn("a11y:inferred_connection", edits.new_ways[0][2])
        self.assertEqual(edits.new_ways[0][2]["a11y:native_connection"], "yes")
        self.assertEqual(proof[0]["nativeNodeChain"], [2, 10])
        self.assertEqual(proof[0]["existingRoadReturnChain"], [2])
        self.assertEqual(proof[0]["connectorId"], 201)
        self.assertEqual(proof[0]["nativeNode"], 10)
        self.assertEqual(proof[0]["nativeWayChain"], [300])
        self.assertFalse(proof[0]["inferred"])
        self.assertEqual(proof[0]["sourceToleranceM"], 0.0)
        self.assertTrue(proof[0]["preservesOriginalConnector"])


    def test_new_gap_requires_source_coverage_and_maximum_five_metres(self):
        self.assert_no_native_edits(self.plan(coverage=[]))
        ways = self.fixture()
        ways[200] = road(200, [100, 101], [(-30, 8), (-20, 7)], highway="footway", footway="sidewalk", source="MOI sidewalk", **{"ref:moi_sidewalk": "s1"})
        ways[201] = road(201, [101, 2], [(-20, 7), (0, 0)], highway="footway", source="MOI sidewalk")
        self.assert_no_native_edits(self.plan(ways))

    def test_ground_only_even_when_both_native_and_moi_claim_the_same_bridge(self):
        ways = {wid: MODULE.make_road(wid, w.node_ids, [MODULE.to_lonlat(*p) for p in w.xy], {**w.tags, "layer": "1", "bridge": "yes"}) for wid,w in self.fixture().items()}
        self.assert_no_native_edits(self.plan(ways))

    @unittest.skipIf(osmium is None, "pyosmium is not installed")
    def test_pbf_node_conditional_is_collected_and_blocks_repair(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "conditional.osm.pbf")
            ways = self.fixture()
            xy = {n:p for w in ways.values() for n,p in zip(w.node_ids,w.xy)}
            writer = osmium.SimpleWriter(path)
            guarded_node_tags = {
                "foot:conditional": "no @ (Mo-Su)",
                "wheelchair": "limited",
                "oneway:foot": "unknown",
                "kerb": "unknown",
            }
            for n,p in sorted(xy.items()):
                writer.add_node(
                    osmium.osm.mutable.Node(
                        id=n,
                        location=MODULE.to_lonlat(*p),
                        tags=guarded_node_tags if n == 10 else {},
                    )
                )
            for w in sorted(ways.values(), key=lambda w:w.way_id):
                writer.add_way(osmium.osm.mutable.Way(id=w.way_id, nodes=w.node_ids, tags=w.tags))
            writer.close()
            collected = MODULE.collect_existing(osmium, path)
            self.assertEqual(
                {key: collected.node_tags[10][key] for key in guarded_node_tags},
                guarded_node_tags,
            )
            self.assert_no_native_edits(self.plan(collected.ways, collected.node_tags))

    def test_explicit_local_inference_is_tagged_and_does_not_claim_wheelchair_yes(self):
        coverage = [("s1", strip(-30, 30, 5, 7.8))]
        self.assert_no_native_edits(self.plan(coverage=coverage))
        edits, proof = self.plan(coverage=coverage, source_alignment=2)
        self.assertEqual(edits.road_pieces, {})
        self.assertEqual(edits.new_ways[0][1], [101, 10])
        self.assertEqual(edits.new_ways[0][2]["a11y:inferred_connection"], "yes")
        self.assertEqual(edits.new_ways[0][2]["a11y:native_connection"], "yes")
        self.assertNotIn("wheelchair", edits.new_ways[0][2])
        self.assertEqual(proof[0]["sourceToleranceM"], 2.0)
        self.assertAlmostEqual(proof[0]["maximumSourceOffsetM"], .2, places=4)
        self.assertTrue(proof[0]["preservesOriginalConnector"])

    def test_strict_source_candidate_is_preferred_over_shorter_inferred_gap(self):
        ways = self.fixture()
        ways[301] = road(301,[10,12],[(0,8),(-2,7.5)],highway="footway",footway="sidewalk")
        edits, proof = self.plan(ways,coverage=[("s1",strip(-30,30,5,7.8))],source_alignment=2)
        self.assertEqual(edits.road_pieces, {})
        self.assertEqual(edits.new_ways[0][1], [101, 12])
        self.assertNotIn("a11y:inferred_connection", edits.new_ways[0][2])
        self.assertEqual(edits.new_ways[0][2]["a11y:native_connection"], "yes")
        self.assertFalse(proof[0]["inferred"])

    def test_source_alignment_is_bounded_and_requires_explicit_opt_in(self):
        coverage = [("s1", strip(-30, 30, 5, 7.8))]
        self.assert_no_native_edits(self.plan(coverage=coverage, source_alignment=0))
        with self.assertRaises(ValueError):
            self.plan(coverage=coverage, source_alignment=2.1)
        with self.assertRaises(ValueError):
            self.plan(coverage=coverage, source_alignment=-0.1)

    def test_inference_does_not_override_barrier_or_third_road(self):
        coverage = [("s1", strip(-30,30,5,7.8))]
        self.assert_no_native_edits(self.plan(coverage=coverage, node_tags={10:{"barrier":"gate"}}, source_alignment=2))
        ways = self.fixture()
        ways[500] = road(500,[50,51],[(-5,7.5),(5,7.5)], highway="service")
        self.assert_no_native_edits(self.plan(ways,coverage=coverage,source_alignment=2))

    def test_opposite_side_is_not_a_reconnection_candidate(self):
        ways = self.fixture()
        ways[300] = road(300, [10, 2, 11], [(0, -8), (0, 0), (0, -16)], highway="footway", footway="crossing")
        self.assert_no_native_edits(self.plan(ways))

    def test_nearby_crossing_without_shared_anchor_is_not_connected(self):
        ways = self.fixture()
        ways[300] = road(300, [10, 99, 11], [(0, 8), (0, 0), (0, -8)], highway="footway", footway="crossing")
        self.assert_no_native_edits(self.plan(ways))

    def test_complete_native_chain_rejects_access_grade_and_barrier_conflicts(self):
        for tags in (
            {"layer": "1"},
            {"level": "unknown"},
            {"bridge": "yes"},
            {"tunnel": "yes"},
            {"foot": "no"},
            {"access": "private"},
            {"wheelchair": "no"},
            {"wheelchair": "limited"},
            {"wheelchair": "unknown"},
            {"foot": "unrecognized"},
            {"access": "unrecognized"},
            {"kerb": "unknown"},
            {"crossing": "no"},
            {"oneway": "unknown"},
            {"oneway:foot": "unknown"},
            {"foot:forward": "unknown"},
            {"foot:conditional": "no @ (Mo-Su)"},
            {"wheelchair:conditional": "yes @ (Mo-Su)"},
        ):
            ways = self.fixture()
            ways[300] = road(300, [10, 2, 11], [(0, 8), (0, 0), (0, -8)], highway="footway", footway="crossing", **tags)
            self.assert_no_native_edits(self.plan(ways), tags)
        for node in (2, 10):
            for tags in (
                {"barrier": "gate"},
                {"wheelchair": "no"},
                {"wheelchair": "limited"},
                {"wheelchair": "unknown"},
                {"foot": "unrecognized"},
                {"access": "unrecognized"},
                {"kerb": "unknown"},
                {"level": "unknown"},
                {"oneway:foot": "unknown"},
                {"foot:conditional": "no @ (Mo-Su)"},
            ):
                self.assert_no_native_edits(self.plan(node_tags={node: tags}), (node, tags))


    def test_interior_native_chain_barrier_is_not_skipped(self):
        ways = self.fixture()
        ways[300] = road(300, [10, 20, 2, 11], [(0, 8), (0, 4), (0, 0), (0, -8)], highway="footway", footway="crossing")
        for tags in ({"barrier": "gate"}, {"layer": "1"}, {"wheelchair": "no"}):
            self.assert_no_native_edits(self.plan(ways, node_tags={20: tags}), tags)

    def test_new_connection_cannot_cross_a_third_road_or_barrier(self):
        for tags in (
            {"highway": "service"},
            {"highway": "service", "layer": "unknown"},
            {"highway": "service", "level": "unknown"},
            {"highway": "motorway"},
            {"highway": "motorway_link"},
            {"barrier": "fence"},
            {"barrier": "fence", "layer": "unknown"},
        ):
            ways = self.fixture()
            ways[500] = MODULE.make_road(500, [50, 51], [lonlat(-5, 7.5), lonlat(5, 7.5)], tags)
            self.assert_no_native_edits(self.plan(ways))

    def test_new_connection_cannot_cross_unknown_grade_building(self):
        ways = self.fixture()
        ways[500] = MODULE.make_road(
            500,
            [50, 51, 52, 53, 50],
            [lonlat(-1, 6.5), lonlat(1, 6.5), lonlat(1, 8.5), lonlat(-1, 8.5), lonlat(-1, 6.5)],
            {"highway": "footway", "building": "yes", "layer": "unknown"},
        )
        self.assert_no_native_edits(self.plan(ways))

    def test_new_connection_rejects_unknown_kerb_near_native_target(self):
        ways = self.fixture()
        kerb_xy = MODULE.to_xy(*lonlat(0, 7.5))
        self.assert_no_native_edits(
            self.plan(ways, node_tags={500: {"kerb": "unknown", "_xy": kerb_xy}})
        )

    def test_new_connection_skips_definitely_grade_separated_intersection(self):
        ways = self.fixture()
        ways[500] = MODULE.make_road(
            500,
            [50, 51],
            [lonlat(-5, 7.5), lonlat(5, 7.5)],
            {"highway": "service", "layer": "1"},
        )
        edits, _ = self.plan(ways)
        self.assertEqual(edits.road_pieces, {})
        self.assertIn([101, 10], [nodes for _, nodes, _ in edits.new_ways])

    def test_relation_member_connector_is_unchanged(self):
        self.assert_no_native_edits(self.plan(relations={201}))

    def test_unreachable_old_anchor_keeps_original_fallback(self):
        ways = self.fixture()
        ways[201] = road(201, [101, 3], [(0, 7), (40, 0)], highway="footway", source="MOI sidewalk")
        ways[202] = road(202, [100, 2], [(-20, 8), (0, 0)], highway="footway", source="MOI sidewalk")
        edits, _ = self.plan(ways)
        self.assertNotIn(201, edits.road_pieces)
        self.assertEqual(edits.new_ways, [])

    def test_coverage_cut_survives_identical_tags_and_relation_members_are_skipped(self):
        street = road(1, [1, 2, 3], [(0, 0), (50, 0), (100, 0)])
        pieces = MODULE.split_road(street, list(zip(street.cum, street.node_ids)), [(street.cum[0], street.cum[-1]), (street.cum[1], street.cum[-1])])
        self.assertEqual([nodes for nodes, _ in pieces], [[1, 2], [2, 3]])
        ways = self.fixture()
        ways[200] = road(200, [100, 101], [(-40, 8), (40, 8)], highway="footway", footway="sidewalk", source="MOI sidewalk", **{"ref:moi_sidewalk": "s1"})
        ways[201] = road(201, [100, 1], [(-40, 8), (-40, 0)], highway="footway", source="MOI sidewalk")
        ways[202] = road(202, [101, 3], [(40, 8), (40, 0)], highway="footway", source="MOI sidewalk")
        ways[210] = road(210, [110, 111], [(0, -8), (40, -8)], highway="footway", footway="sidewalk", source="MOI sidewalk", **{"ref:moi_sidewalk": "s2"})
        ways[211] = road(211, [110, 2], [(0, -8), (0, 0)], highway="footway", source="MOI sidewalk")
        edits, _ = MODULE.plan_coverage_cuts(ways, set(), 400)
        self.assertEqual(edits.road_pieces[1][0], [1, 2])
        self.assertEqual(edits.new_ways[0][1], [2, 3])
        self.assertEqual(MODULE.plan_coverage_cuts(ways, {1}, 400)[0].road_pieces, {})

    def test_existing_policy_tags_survive_and_repair_is_idempotent(self):
        ways = self.fixture()
        street = ways[1]
        ways[1] = MODULE.make_road(1, street.node_ids, [MODULE.to_lonlat(*p) for p in street.xy], {**street.tags, "wheelchair": "no"})
        self.assertEqual(MODULE.plan_coverage_cuts(ways, set(), 400)[0].road_pieces, {})
        edits, _ = self.plan(ways)
        self.assertEqual(edits.road_pieces, {})
        self.assertEqual(edits.new_ways[0][1], [101, 10])
        self.assertNotIn("wheelchair", edits.new_ways[0][2])
        xy = {n:p for w in ways.values() for n,p in zip(w.node_ids,w.xy)}
        for wid, nodes, tags in edits.new_ways:
            ways[wid] = MODULE.make_road(wid, nodes, [MODULE.to_lonlat(*xy[n]) for n in nodes], tags)
        for wid, (nodes, tags) in edits.road_pieces.items():
            xy = {n:p for w in ways.values() for n,p in zip(w.node_ids,w.xy)}
            ways[wid] = MODULE.make_road(wid,nodes,[MODULE.to_lonlat(*xy[n]) for n in nodes],tags)
        self.assert_no_native_edits(self.plan(ways))

    def corner_fixture(self):
        items = [
            road(1, [1, 12, 5, 3], [(-30, 0), (-5, 0), (0, 0), (30, 0)]),
            road(2, [4, 5, 22, 6], [(0, -30), (0, 0), (0, 5), (0, 30)]),
            road(300, [101, 12, 102], [(-5, 3), (-5, 0), (-5, -3)], highway="footway", footway="crossing"),
            road(301, [201, 22, 202], [(-3, 5), (0, 5), (3, 5)], highway="footway", footway="crossing"),
            road(200, [100, 101], [(-20, 3), (-5, 3)], highway="footway", footway="sidewalk", source="MOI sidewalk", **{"ref:moi_sidewalk": "s1"}),
        ]
        return {w.way_id: w for w in items}

    def test_bridge_corner_is_rejected_even_if_both_crossings_match_grade(self):
        ways = {wid: MODULE.make_road(wid, w.node_ids, [MODULE.to_lonlat(*p) for p in w.xy], {**w.tags, "layer": "1", "bridge": "yes"}) for wid,w in self.corner_fixture().items()}
        edits, _ = self.plan(ways, coverage=[("s1", strip(-6, -2, 2, 6))])
        self.assertEqual(edits.new_ways, [])

    def test_source_alignment_corner_tolerance_is_explicit_and_bounded(self):
        ways = self.corner_fixture()
        coverage = [("s1", strip(-6,-2,2,4.8))]
        self.assert_no_native_edits(self.plan(ways, coverage=coverage, source_alignment=0))
        edits, proof = self.plan(ways, coverage=coverage, source_alignment=2)
        self.assertEqual(edits.new_ways[0][1], [101,201])
        self.assertEqual(edits.new_ways[0][2]["a11y:inferred_connection"], "yes")
        self.assertEqual(edits.new_ways[0][2]["a11y:native_connection"], "yes")
        self.assertEqual(proof[0]["sourceToleranceM"], 2)
        self.assertIn("originalNativeCornerWitnesses", proof[0])
        self.assert_no_native_edits(
            self.plan(ways, coverage=[("s1",strip(-6,-2,-5,-2))], source_alignment=2)
        )

    def test_corner_requires_existing_source_coverage_and_five_metre_limit(self):
        ways = self.corner_fixture()
        self.assert_no_native_edits(self.plan(ways))
        polygon = strip(-6, -2, 2, 6)
        edits, proof = self.plan(ways, coverage=[("s1", polygon)])
        self.assertEqual([nodes for _, nodes, _ in edits.new_ways], [[101, 201]])
        self.assertEqual(edits.new_ways[0][2]["a11y:native_connection"], "yes")
        self.assertEqual(proof[0]["coverageRefs"], ["s1"])
        self.assert_no_native_edits(self.plan(ways, coverage=[("unrelated-source", polygon)]))
        ways[301] = road(301, [201, 22, 202], [(-3, 9), (0, 5), (3, 5)], highway="footway", footway="crossing")
        self.assert_no_native_edits(self.plan(ways, coverage=[("s1", strip(-20, 0, 0, 20))]))

    def test_corner_coverage_does_not_override_building_or_barrier(self):
        ways = self.corner_fixture()
        ways[500] = MODULE.make_road(500, [50, 51, 52, 53, 50], [lonlat(*p) for p in [(-6, 2), (-2, 2), (-2, 6), (-6, 6), (-6, 2)]], {"building": "yes"})
        self.assert_no_native_edits(self.plan(ways, coverage=[("s1", strip(-6, -2, 2, 6))]))





if __name__ == "__main__":
    unittest.main()
