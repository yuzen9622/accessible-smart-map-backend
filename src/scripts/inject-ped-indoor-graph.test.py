#!/usr/bin/env python3
"""Pure-function tests for the GTFS indoor pedestrian graph injection."""

import importlib.util
import json
import os
import sys
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import patch

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


class LifecycleTests(unittest.TestCase):
    def test_only_candidate_versions_may_receive_indoor_injection(self):
        MODULE.require_candidate_lifecycle_status("CANDIDATE", 7)
        for status in ("ACTIVE", "RETIRED", None):
            with self.subTest(status=status), self.assertRaises(SystemExit):
                MODULE.require_candidate_lifecycle_status(status, 7)

    def test_gtfs_xpathways_is_preserved_as_outdoor_during_cleanup(self):
        class FakeCursor:
            def __init__(self):
                self.calls = []
                self.edge_refs = [
                    "gtfs_pathways:connector-edge:generated",
                    "gtfsXpathways:connector-edge:adversarial",
                ]
                self.node_refs = [
                    "gtfs_pathways:stop:generated",
                    "gtfsXpathways:stop:adversarial",
                ]
                self.row = None

            def execute(self, query, params=None):
                if params is None:
                    raise AssertionError("query parameters are required")
                self.calls.append((query, params))
                normalized_query = " ".join(query.split())
                if "SELECT lifecycle_status, notes" in normalized_query:
                    self.row = ("CANDIDATE", "{}")
                    return
                if "SELECT count(*) FROM ped_node" in normalized_query:
                    if "NOT starts_with(COALESCE(source_ref, ''), %s)" not in query:
                        raise AssertionError("outdoor node count must use starts_with")
                    self.row = (
                        sum(
                            not source_ref.startswith(params[1])
                            for source_ref in self.node_refs
                        ),
                    )
                    return
                if "SELECT count(*) FROM ped_edge" in normalized_query:
                    if "NOT starts_with(COALESCE(source_ref, ''), %s)" not in query:
                        raise AssertionError("outdoor edge count must use starts_with")
                    self.row = (
                        sum(
                            not source_ref.startswith(params[1])
                            for source_ref in self.edge_refs
                        ),
                    )
                    return
                if "DELETE FROM ped_edge" in normalized_query:
                    if "starts_with(source_ref, %s)" not in query:
                        raise AssertionError(
                            "generated edge cleanup must use starts_with"
                        )
                    self.edge_refs = [
                        source_ref
                        for source_ref in self.edge_refs
                        if not source_ref.startswith(params[1])
                    ]
                    return
                if "DELETE FROM ped_node" in normalized_query:
                    if "starts_with(source_ref, %s)" not in query:
                        raise AssertionError(
                            "generated node cleanup must use starts_with"
                        )
                    self.node_refs = [
                        source_ref
                        for source_ref in self.node_refs
                        if not source_ref.startswith(params[1])
                    ]
                    return
                raise AssertionError(f"unexpected query: {normalized_query}")

            def fetchone(self):
                return self.row

        cursor = FakeCursor()

        self.assertEqual(
            MODULE.replace_generated_rows(cursor, 7),
            (1, 1, {}),
        )
        self.assertEqual(
            cursor.node_refs,
            ["gtfsXpathways:stop:adversarial"],
        )
        self.assertEqual(
            cursor.edge_refs,
            ["gtfsXpathways:connector-edge:adversarial"],
        )
        source_ref_queries = [
            (query, params) for query, params in cursor.calls if "source_ref" in query
        ]
        self.assertTrue(source_ref_queries)
        for query, params in source_ref_queries:
            if params is None:
                raise AssertionError("source-ref query parameters are required")
            self.assertIn("starts_with", query)
            self.assertNotIn("LIKE", query)
            self.assertEqual(params[1], MODULE.GENERATED_SOURCE_PREFIX)

    def test_active_version_is_rejected_before_generated_rows_are_deleted(self):
        class FakeCursor:
            def __init__(self):
                self.calls = []

            def execute(self, query, params=None):
                self.calls.append((query, params))

            def fetchone(self):
                return ("ACTIVE", "{}")

        cursor = FakeCursor()

        with self.assertRaises(SystemExit):
            MODULE.replace_generated_rows(cursor, 7)

        self.assertIn("FOR UPDATE", cursor.calls[0][0])
        self.assertFalse(any("DELETE FROM" in query for query, _ in cursor.calls))


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
        self.assertEqual(MODULE.outdoor_graph_statistics(notes), (220_728, {"10": 5}))

    def test_outdoor_statistics_fall_back_to_a_freshly_built_graph(self):
        notes = {
            "undirected_segment_count": 220_728,
            "edge_type_distribution": {10: 5},
        }
        self.assertEqual(MODULE.outdoor_graph_statistics(notes), (220_728, {"10": 5}))

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



class QualifiedScopeTests(unittest.TestCase):
    def test_national_extent_selects_22_parent_groups_outside_taipei(self):
        # Representative county/island coordinates; selection, not coverage proof.
        points = [(121.56,25.03),(121.46,25.01),(121.74,25.13),(121.30,24.99),
                  (120.96,24.81),(121.01,24.84),(120.82,24.56),(120.68,24.15),
                  (120.54,24.08),(120.97,23.92),(120.53,23.71),(120.45,23.48),
                  (120.26,23.46),(120.20,22.99),(120.30,22.63),(120.49,22.67),
                  (121.15,22.75),(121.61,23.99),(121.75,24.76),(119.57,23.57),
                  (118.32,24.43),(119.95,26.16)]
        stops = []
        for i,(lon,lat) in enumerate(points):
            stops.extend([MODULE.StopRecord(f"s{i}",1,None,lon,lat),
                          MODULE.StopRecord(f"e{i}",2,f"s{i}",lon,lat)])
        graph = MODULE.prepare_indoor_graph(stops, [], MODULE.BBOXES["taiwan"], "today")
        self.assertEqual(len(graph.station_groups),22)
        self.assertEqual(graph.selected_extent,MODULE.TAIWAN_BBOX)
        self.assertEqual({n.station_id for n in graph.nodes},{f"s{i}" for i in range(22)})
        city = MODULE.prepare_indoor_graph(stops, [], MODULE.BBOXES["taipei"], "today")
        self.assertLess(len(city.station_groups),22)
        self.assertIn("s0",city.station_groups)

    def test_unqualified_scope_or_unpinned_source_cannot_be_injected(self):
        notes = dict(qualified_notes())
        MODULE.require_qualified_scope(notes,MODULE.TAIWAN_BBOX)
        for changed in ({"extent":list(MODULE.TAIPEI_BBOX)},
                        {"pedestrian_policy_version":"legacy"},
                        {"input_manifest":{}}, {"walk_surface_schema_version":2}):
            with self.subTest(changed=changed),self.assertRaises(SystemExit):
                MODULE.require_qualified_scope({**notes,**changed},MODULE.TAIWAN_BBOX)

    def test_cli_preserves_taipei_and_exposes_explicit_taiwan(self):
        for name in ("taipei","taiwan"):
            args=MODULE.parse_args(["--version-id","1","--bbox",name,
                                    "--mongo-uri","fixture","--db-url","fixture"])
            self.assertEqual(args.bbox,name)

    def test_unknown_plane_identities_are_not_merged(self):
        a = {"source_ref":"osm:way/1","attr_meta":{"osm_tags":{"level":"unknown"}}}
        b = {**a,"source_ref":"osm:way/2"}
        self.assertNotEqual(MODULE.match_plane(a),MODULE.match_plane(b))


def qualified_notes():
    return {"pedestrian_policy_version":"sidewalk-v1","walk_surface_schema_version":1,
            "extent":list(MODULE.TAIWAN_BBOX),
            "undirected_segment_count":1,"edge_type_distribution":{"2":1},
            "input_manifest":{"sidewalk_source_version_id":"99",
                              "sidewalk_archive_sha256":"a"*64,"osm_sha256":"b"*64}}


@unittest.skipUnless(os.environ.get("GTFS_CONNECTOR_ACCEPTANCE_DB_URL"),
                     "requires explicitly owned PostGIS acceptance DB")
class QualifiedPersistenceTests(unittest.TestCase):
    """Real INSERT/cleanup/lifecycle checks; every relation is session temporary."""
    @classmethod
    def setUpClass(cls):
        import psycopg2
        cls.connection = psycopg2.connect(os.environ["GTFS_CONNECTOR_ACCEPTANCE_DB_URL"])
        cls.cursor = cls.connection.cursor()
        cls.cursor.execute("""CREATE TEMP TABLE ped_graph_version (
            id BIGINT PRIMARY KEY,notes TEXT,lifecycle_status TEXT,
            node_count BIGINT,directed_edge_count BIGINT,indoor_injection_complete BOOLEAN);
            CREATE TEMP TABLE ped_walk_surface_cell (
            version_id BIGINT,cell_id BIGINT,sidewalk_source_version_id BIGINT,
            source_id TEXT,geom geometry(Polygon,4326),grade JSONB,witness JSONB);
            CREATE TEMP TABLE ped_node (
            node_id BIGINT,version_id BIGINT,geom geometry(Point,4326),
            proxy_geom geometry(Point,4326),station_id TEXT,station_radius_m REAL,
            node_type SMALLINT,source_ref TEXT,attr_meta JSONB,PRIMARY KEY(node_id,version_id));
            CREATE TEMP TABLE ped_edge (
            edge_id BIGINT,version_id BIGINT,from_node BIGINT,to_node BIGINT,
            geom geometry(LineString,4326),length_m DOUBLE PRECISION,edge_type SMALLINT,
            slope_longitudinal REAL,slope_cross REAL,surface SMALLINT,smoothness SMALLINT,
            width_m REAL,effective_width_m REAL,wheelchair SMALLINT,stair_count INT,
            traversal_time_s REAL,has_ramp BOOLEAN,is_bidirectional BOOLEAN,
            source_ref TEXT,attr_meta JSONB)""")

    @classmethod
    def tearDownClass(cls):
        cls.connection.rollback()
        cls.cursor.close()
        cls.connection.close()

    def setUp(self):
        self.cursor.execute("TRUNCATE ped_edge,ped_node,ped_walk_surface_cell,ped_graph_version")
        for version in (1,2):
            self.cursor.execute("INSERT INTO ped_graph_version VALUES (%s,%s,'CANDIDATE',2,1,false)",
                                (version,json.dumps(qualified_notes())))
        self.add_edge()

    @staticmethod
    def point(x,y):
        return (121.53+x/101000,25.04+y/111000)

    def add_edge(self,points=((0,0),(10,10),(20,0)),edge_id=101,version=1,
                 source="osm:way/1",grade=("0","0","no","no"),witness=False):
        from psycopg2.extras import Json
        meta: dict[str, Any] = {"osm_tags":dict(zip(("layer","level","bridge","tunnel"),grade,strict=True))}
        if witness:
            meta["surface_witness"]={"cell_id":"7","source_id":"surface-a",
                                     "source_version_id":"99","grade":list(grade)}
        for node,point in ((edge_id*100+1,points[0]),(edge_id*100+2,points[-1])):
            lon,lat=self.point(*point)
            self.cursor.execute("""INSERT INTO ped_node (node_id,version_id,geom,source_ref,attr_meta)
                VALUES (%s,%s,ST_SetSRID(ST_MakePoint(%s,%s),4326),%s,%s)""",
                (node,version,lon,lat,f"osm:node/{node}",Json(meta)))
        wkt="LINESTRING ("+",".join(f"{x} {y}" for x,y in (self.point(*p) for p in points))+")"
        self.cursor.execute("""INSERT INTO ped_edge VALUES
            (%s,%s,%s,%s,ST_GeomFromText(%s,4326),ST_Length(ST_GeomFromText(%s,4326)::geography),
             2,7,3,1,2,.6,.4,2,5,60,true,false,%s,%s)""",
            (edge_id,version,edge_id*100+1,edge_id*100+2,wkt,wkt,source,Json(meta)))

    def cell(self):
        from psycopg2.extras import Json
        ring=[(-2,-2),(22,-2),(22,12),(-2,12),(-2,-2)]
        wkt="POLYGON (("+",".join(f"{x} {y}" for x,y in (self.point(*p) for p in ring))+"))"
        self.cursor.execute("INSERT INTO ped_walk_surface_cell VALUES (1,7,99,'surface-a',ST_GeomFromText(%s,4326),%s,%s)",
                            (wkt,Json(["0","0","no","no"]),
                             Json({"width_m":.8,"effective_width_m":.5,
                                   "raw_properties":{"width":.8}})))

    def stop(self,x: float=15,y: float=5,stop_id="gate"):
        return MODULE.StopRecord(stop_id,2,"station",*self.point(x,y))

    def prepared(self,stop=None):
        gate=stop or self.stop()
        missing=self.stop(40,40,"unmatched")
        return MODULE.prepare_indoor_graph(
            [MODULE.StopRecord("station",1,None,*self.point(0,0)),gate,missing],
            [MODULE.PathwayRecord("valid","gate","unmatched",1,1,30,None)],
            MODULE.TAIWAN_BBOX,"today")

    def inject(self,prepared=None):
        # The product's transaction context is real; use a savepoint so success
        # never commits anything, and an error must rollback generated deletions.
        connection=self.connection
        class OwnedSession:
            def __enter__(self):
                self.save=connection.cursor()
                self.save.execute("SAVEPOINT injector_transaction")
                return self
            def __exit__(self,kind,value,trace):
                if kind:
                    self.save.execute("ROLLBACK TO SAVEPOINT injector_transaction")
                self.save.execute("RELEASE SAVEPOINT injector_transaction")
                self.save.close()
                return False
            def cursor(self): return connection.cursor()
            def close(self): pass
        with patch("psycopg2.connect",return_value=OwnedSession()), \
             patch.object(MODULE,"nearest_outdoor_edge",side_effect=AssertionError("illegal nearest fallback")):
            return MODULE.inject_prepared_graph(prepared or self.prepared(),1,"owned-session","today")

    def snapshot(self):
        self.cursor.execute("SELECT to_jsonb(e) FROM ped_edge e WHERE source_ref !~ '^gtfs_pathways:' ORDER BY version_id,edge_id")
        edges=self.cursor.fetchall()
        self.cursor.execute("SELECT to_jsonb(n) FROM ped_node n WHERE source_ref !~ '^gtfs_pathways:' ORDER BY version_id,node_id")
        return edges,self.cursor.fetchall()

    def one(self):
        row = self.cursor.fetchone()
        if row is None:
            self.fail("expected persisted SQL row")
        return row

    def test_real_injection_preserves_curves_attributes_and_isolated_sources(self):
        self.add_edge(version=2)
        native=self.snapshot()
        notes=self.inject()
        matching=notes["entrance_matching"]
        self.assertEqual(matching["accepted_count"],1)
        self.assertEqual(matching["unmatched_count"],1)
        self.assertNotIn("primary_taipei_50m",matching)
        self.assertEqual(self.snapshot(),native)
        self.cursor.execute("""SELECT ST_NPoints(geom),length_m,slope_longitudinal,slope_cross,
            surface,smoothness,width_m,effective_width_m,wheelchair,stair_count,has_ramp,
            traversal_time_s,attr_meta FROM ped_edge WHERE source_ref LIKE %s""",
            ("%:from-to-snap",))
        row=self.one()
        self.assertEqual(row[0],3)
        self.assertEqual(row[2:6],(7,3,1,2))
        self.assertAlmostEqual(row[6],.6,places=6)
        self.assertAlmostEqual(row[7],.4,places=6)
        self.assertEqual(row[8:11],(2,5,True))
        self.assertGreater(row[11],30)
        self.assertEqual(row[12]["osm_tags"],{"layer":"0","level":"0","bridge":"no","tunnel":"no"})
        self.cursor.execute("SELECT count(*) FROM ped_edge WHERE source_ref LIKE 'gtfs_pathways:pathway:%'")
        self.assertEqual(self.one()[0],2)
        self.cursor.execute("SELECT count(*) FROM ped_node WHERE source_ref='gtfs_pathways:stop:unmatched'")
        self.assertEqual(self.one()[0],1)
        self.cursor.execute("SELECT sum(length_m) FROM ped_edge WHERE source_ref ~ ':(from-to-snap|snap-to-to)$'")
        total=self.one()[0]
        self.cursor.execute("SELECT ST_Length(geom::geography) FROM ped_edge WHERE edge_id=101 AND version_id=1")
        self.assertAlmostEqual(total,self.one()[0],delta=.001)
        self.cursor.execute("SELECT count(*) FROM ped_edge WHERE source_ref ~ ':(snap-to-from|to-to-snap)$'")
        self.assertEqual(self.one()[0],0)
        self.inject()
        self.assertEqual(self.snapshot(),native)
        self.cursor.execute("SELECT count(*) FROM ped_edge WHERE version_id=1")
        self.assertEqual(self.one()[0],7)  # native + 2 pathways + 4 connector edges

    def test_failure_rolls_back_cleanup_and_generated_writes(self):
        self.inject()
        self.cursor.execute("SELECT to_jsonb(e) FROM ped_edge e ORDER BY edge_id")
        before=self.cursor.fetchall()
        with (patch.object(MODULE,"insert_edges",side_effect=RuntimeError("injected IO failure")),
              self.assertRaisesRegex(RuntimeError,"IO failure")):
            self.inject()
        self.cursor.execute("SELECT to_jsonb(e) FROM ped_edge e ORDER BY edge_id")
        self.assertEqual(self.cursor.fetchall(),before)
        self.cursor.execute("UPDATE ped_graph_version SET lifecycle_status='ACTIVE' WHERE id=1")
        with self.assertRaises(SystemExit):
            self.inject()
        self.cursor.execute("SELECT to_jsonb(e) FROM ped_edge e ORDER BY edge_id")
        self.assertEqual(self.cursor.fetchall(),before)

    def test_no_match_is_not_invalid_source_and_prints_traceable_reason(self):
        from contextlib import redirect_stdout
        from io import StringIO
        notes=self.inject(self.prepared(self.stop(40,40)))
        self.assertEqual(notes["entrance_matching"]["accepted_count"],0)
        self.assertEqual(notes["indoor_directed_edge_count"],2)
        output=StringIO()
        with redirect_stdout(output):
            MODULE.print_report(1,notes)
        self.assertIn("unmatched_connector",output.getvalue())
        self.cursor.execute("SELECT count(*) FROM ped_node WHERE version_id=1")
        self.assertEqual(self.one()[0],5)

    def test_alternative_valid_cell_not_blocked_nearest_is_selected(self):
        self.cell()
        self.add_edge(points=((0,0),(20,0)),edge_id=102,source="gov:surface-a",witness=True)
        stop=self.stop(10,5)
        match=MODULE.qualified_outdoor_edge(self.cursor,1,stop)
        self.assertEqual(match.edge_id,102)
        group=MODULE.StationGroup("station",(stop,),self.point(10,5),10,1)
        _,edges=MODULE.build_connectors([match],{"gate":stop},{"station":group},"today")
        chord=next(e for e in edges if e.source_ref.endswith("entrance-forward"))
        self.assertIsNone(chord.stair_count)
        self.assertNotIn("wheelchair",chord.outdoor_attributes)
        self.assertNotIn("slope_longitudinal",chord.outdoor_attributes)
        self.assertAlmostEqual(chord.outdoor_attributes["effective_width_m"],.5,places=6)
        self.inject(self.prepared(stop))
        self.cursor.execute("""SELECT width_m,effective_width_m,slope_longitudinal,
            slope_cross,wheelchair,stair_count,traversal_time_s,has_ramp
            FROM ped_edge WHERE source_ref='gtfs_pathways:connector-edge:gate:entrance-forward'""")
        persisted=self.one()
        self.assertAlmostEqual(persisted[0],.8,places=6)
        self.assertAlmostEqual(persisted[1],.5,places=6)
        self.assertEqual(persisted[2:],(None,None,None,None,None,None))

    def test_version_source_grade_and_generated_rows_cannot_authorize_chord(self):
        self.cell()
        self.add_edge(points=((0,0),(20,0)),edge_id=102,source="gov:surface-a",witness=True)
        for change in ("source_version", "source_id", "grade", "generated"):
            self.cursor.execute("SAVEPOINT negative")
            if change == "source_version":
                self.cursor.execute("UPDATE ped_walk_surface_cell SET sidewalk_source_version_id=100")
            elif change == "source_id":
                self.cursor.execute("UPDATE ped_walk_surface_cell SET source_id='foreign'")
            elif change == "grade":
                self.cursor.execute("UPDATE ped_walk_surface_cell SET grade='[null,null,null,null]'::jsonb")
            else:
                self.cursor.execute("UPDATE ped_edge SET source_ref='gtfs_pathways:fake' WHERE edge_id=102")
            self.assertIsNone(MODULE.qualified_outdoor_edge(self.cursor,1,self.stop(10,5)))
            self.cursor.execute("ROLLBACK TO SAVEPOINT negative")
            self.cursor.execute("RELEASE SAVEPOINT negative")

    def test_bidirectional_partial_geometry_and_directional_attributes(self):
        self.cursor.execute("UPDATE ped_edge SET is_bidirectional=true")
        stop=self.stop()
        match=MODULE.qualified_outdoor_edge(self.cursor,1,stop)
        group=MODULE.StationGroup("station",(stop,),self.point(15,5),10,1)
        nodes,edges=MODULE.build_connectors([match],{"gate":stop},{"station":group},"today")
        forward=next(e for e in edges if e.source_ref.endswith(":from-to-snap"))
        reverse=next(e for e in edges if e.source_ref.endswith(":snap-to-from"))
        self.assertEqual(reverse.geometry,tuple(reversed(forward.geometry)))
        self.assertEqual(reverse.outdoor_attributes["slope_longitudinal"],-7)
        ids={MODULE.stop_key("gate"):999, nodes[0].key:998}
        MODULE.insert_edges(self.cursor,1,edges,ids)
        self.cursor.execute("""SELECT slope_longitudinal,ST_NPoints(geom),width_m FROM ped_edge
            WHERE source_ref='gtfs_pathways:connector-edge:gate:snap-to-from'""")
        slope,points,width=self.one()
        self.assertEqual((slope,points),(-7,3))
        self.assertAlmostEqual(width,.6,places=6)

    def test_unknown_surface_grade_remains_source_specific_not_shared_ground(self):
        from psycopg2.extras import Json
        self.cell()
        self.add_edge(points=((0,0),(20,0)),edge_id=102,source="gov:surface-a",witness=True)
        grade=[None,None,None,None]
        self.cursor.execute("UPDATE ped_walk_surface_cell SET grade=%s",(Json(grade),))
        self.cursor.execute("""UPDATE ped_edge SET attr_meta=jsonb_set(attr_meta,
            '{surface_witness,grade}',%s) WHERE edge_id=102""",(Json(grade),))
        stop=self.stop(10,5)
        match=MODULE.qualified_outdoor_edge(self.cursor,1,stop)
        self.assertEqual(match.edge_id,102)
        self.cursor.execute("""INSERT INTO ped_walk_surface_cell
            SELECT version_id,8,sidewalk_source_version_id,'independent',geom,grade,witness
            FROM ped_walk_surface_cell WHERE cell_id=7""")
        self.add_edge(points=((0,0),(20,0)),edge_id=103,source="gov:independent",witness=True)
        self.cursor.execute("""UPDATE ped_edge SET attr_meta=jsonb_set(attr_meta,'{surface_witness}',%s)
            WHERE edge_id=103""",(Json({"cell_id":"8","source_version_id":"99",
                                     "source_id":"independent","grade":grade}),))
        reasons=[]
        self.assertIsNone(MODULE.qualified_outdoor_edge(self.cursor,1,stop,reasons))
        self.assertEqual(reasons[0]["reason"],"ambiguous_grade_or_independent_unknown_source_planes")

    def test_unknown_grade_sources_at_same_xy_remain_ambiguous(self):
        from psycopg2.extras import Json
        self.add_edge(edge_id=102,source="osm:way/2")
        self.cursor.execute("UPDATE ped_edge SET attr_meta=%s",
                            (Json({"osm_tags":{"level":"unknown"}}),))
        self.assertIsNone(MODULE.qualified_outdoor_edge(self.cursor,1,self.stop()))

    def test_endpoint_geometry_and_coincidence_tolerance(self):
        for point,expected in (((0,0),True),((10,10.1),True),((10,11),False)):
            match=MODULE.qualified_outdoor_edge(self.cursor,1,self.stop(*point))
            self.assertEqual(match is not None,expected)
            if point==(0,0):
                self.assertEqual(match.from_distance_m,0)
                self.assertEqual(len(match.from_geometry),2)
        self.cursor.execute("UPDATE ped_node SET geom=ST_Translate(geom,.1,0)")
        self.assertIsNone(MODULE.qualified_outdoor_edge(self.cursor,1,self.stop()))


if __name__ == "__main__":
    unittest.main()
